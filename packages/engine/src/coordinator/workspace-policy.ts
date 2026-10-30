// 一个 Run 用哪个工作区（2026-10-19 用户决定，偏离 workspace 编排设计 §4 第 1 行）。
//
// 设计原来规定：编码工单直接用项目当前的 checkout，隔离要 Lead 在派发前显式申请。实际上 Lead 从来没有申请过，
// 52 个 workspace 全是 shared。child 在用户的工作副本里 fetch、checkout PR 分支，在线上部署目录里改代码。
// 现在由系统按可观察的事实判定，不靠 Lead：
//   · 编码工单：工作目录在 git 仓库里，并且这次 Run 会写文件（执行者的 execution、integration、conversation）。
//     它在自己的 git worktree 里跑（provisionWorkspace 的 isolated 分支），工单结束后走 pending_integration 的合并步骤。
//   · Lead 要用共享的 checkout（例如必须基于用户没提交的改动），只能用 requestSharedWorkspace 显式申请，写明理由。
//     理由记在工单上。daemon 自己的仓库（线上部署目录）一律不许共享。
//   · PR 评审：Lead 用 setPullRequestReviewTarget 记下 PR。每个 Run 在临时的 detached worktree 里检出 PR head，
//     不在用户的仓库里建分支，Run 结束就删掉 worktree 和临时引用（manager.ts 的 runItem，以及 sweepWorkspaces 兜底）。
//   · 不是 git 仓库的目录照旧共享（设计 D6：不复制整个目录）。核查者和只读的 Run 不改变工作区。
// 每次判定的结果和依据记成工单上的一条活动（decision: workspace_policy）。
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "@pi-lead-child/store";
import {
  addActivity, attachWorkspaceToRun, createWorkspace, getItem, getWorkspace, listWorkspaces, resolveWorkspace,
  transitionWorkspace,
} from "@pi-lead-child/store";
import { projectRoot } from "@pi-lead-child/core";
import type { Actor, Item, RunPurpose, Workspace } from "@pi-lead-child/core";
import {
  disposeCheckout, isDisposableCheckout, provisionWorkspace, removeCheckoutFiles, workspaceRootFor,
} from "./workspace.js";

const execFileAsync = promisify(execFile);

/** 执行者的这几种 Run 会写文件。outcome_repair 只补交成果，learning 只读记录。 */
export const WRITING_PURPOSES: readonly RunPurpose[] = ["execution", "integration", "conversation"];

export const WORKSPACE_POLICY_DECISION = "workspace_policy";
export const SHARED_WORKSPACE_REQUESTED = "workspace_shared_requested";
export const PULL_REQUEST_TARGET_SET = "workspace_pull_request_target";

export interface PullRequestTarget {
  number: number;
  remote: string;
}

export interface RunWorkspaceFacts {
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  writes: boolean;
  workdir: string | null;
  // 工作目录所在的 git 仓库（顶层目录的真实路径）。不是 git 仓库时为 null。
  gitRepository: string | null;
  // 这个仓库就是 daemon 自己的部署目录所在的仓库。
  deploymentRepository: boolean;
}

// unavailable：这次 Run 没有合适的工作区，派发被拒绝，原因在 refusal 里。
export type RunWorkspaceMode = "isolated" | "shared" | "pull_request" | "none" | "unavailable";

export interface RunWorkspacePlan {
  coding: boolean;
  mode: RunWorkspaceMode;
  facts: RunWorkspaceFacts;
  // 这次 Run 可以直接用的工作区。ready 为 false 时，要先准备一个新的（prepareRunWorkspace）。
  workspace: Workspace | null;
  ready: boolean;
  sharedReason?: string;
  pullRequest?: PullRequestTarget;
  refusal?: string;
}

// 还不存在的路径按它最近的已存在的上级目录解析（真实路径），再接上剩下的部分。
// workdir 可以是 child 要新建的目录：它也在那个仓库里，不能因为目录还不在就当成不是 git 仓库、在用户的 checkout 里建出来。
function realpathLoose(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    rest.unshift(existing.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    existing = parent;
  }
  return join(realpathOr(existing), ...rest);
}

function gitTop(path: string | null): string | null {
  if (!path) return null;
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const root = execFileSync("git", ["-C", existing, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

function gitCommonDir(path: string): string | null {
  try {
    const common = execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return common ? realpathSync(common) : null;
  } catch {
    return null;
  }
}

// daemon 跑在哪个 checkout 上（projectRoot：dist 和源码都在主 checkout 里）。按 git 的公共目录比较：
// 这个仓库的任何 worktree 都算同一个仓库。
let deploymentOverride: string[] | null = null;
let deploymentCommonDirs: string[] | null = null;

/** 测试用：把这些仓库当成 daemon 的部署仓库。传 null 恢复缺省（projectRoot）。 */
export function setDeploymentRepositoriesForTesting(paths: string[] | null): void {
  deploymentOverride = paths;
  deploymentCommonDirs = null;
}

function deploymentRepositoryDirs(): string[] {
  if (deploymentCommonDirs) return deploymentCommonDirs;
  const roots = deploymentOverride ?? [projectRoot()];
  deploymentCommonDirs = roots.map(gitCommonDir).filter((dir): dir is string => dir !== null);
  return deploymentCommonDirs;
}

export function isDeploymentRepository(path: string): boolean {
  const common = gitCommonDir(path);
  return common !== null && deploymentRepositoryDirs().includes(common);
}

function latestDecision(db: Db, itemId: number, decision: string): Record<string, unknown> | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, decision) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Record<string, unknown> : null;
}

/** Lead 为这个共享工作区写下的理由。没有申请过时为 null。 */
export function sharedWorkspaceReason(db: Db, workspace: Workspace): string | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.reason') AS reason FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
       AND json_extract(payload, '$.workspaceId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(workspace.owner_item_id, SHARED_WORKSPACE_REQUESTED, workspace.id) as { reason: string | null } | undefined;
  return row?.reason ?? null;
}

export function pullRequestReviewTarget(db: Db, itemId: number): PullRequestTarget | null {
  const payload = latestDecision(db, itemId, PULL_REQUEST_TARGET_SET);
  if (!payload || typeof payload.number !== "number" || typeof payload.remote !== "string") return null;
  return { number: payload.number, remote: payload.remote };
}

/** 判定这次 Run 用哪个工作区。只读：不建工作区，不写库。派发认领时用它决定把 Run 绑到哪个工作区上。 */
export function planRunWorkspace(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): RunWorkspacePlan {
  const resolved = resolveWorkspace(db, item.id)?.workspace ?? null;
  const writes = input.role === "executor" && WRITING_PURPOSES.includes(input.purpose);
  const workdir = resolved?.path ?? item.workdir ?? null;
  const gitRepository = resolved?.repo_root ? realpathOr(resolved.repo_root) : gitTop(workdir);
  const facts: RunWorkspaceFacts = {
    role: input.role, purpose: input.purpose, writes, workdir, gitRepository,
    deploymentRepository: gitRepository !== null && isDeploymentRepository(gitRepository),
  };
  const pullRequest = gitRepository ? pullRequestReviewTarget(db, item.id) : null;
  // PR 工单的核查者也看 PR head：给它一个同样的临时检出，不让它对着用户的 checkout 下结论（审查 2026-10-19 第 6 条）。
  if (pullRequest && input.role === "reviewer" && input.purpose === "review") {
    return { coding: false, mode: "pull_request", facts, workspace: null, ready: false, pullRequest };
  }
  if (!writes) {
    return { coding: false, mode: resolved ? resolved.mode : "none", facts, workspace: resolved, ready: true };
  }
  if (!gitRepository) {
    return { coding: false, mode: workdir ? "shared" : "none", facts, workspace: resolved, ready: true };
  }
  if (pullRequest) {
    // 每个 Run 用自己的临时检出：上一个 Run 留下的（还没清理掉的）不再用。
    return { coding: true, mode: "pull_request", facts, workspace: null, ready: false, pullRequest };
  }
  if (resolved && resolved.mode === "isolated" && !isDisposableCheckout(resolved)) {
    // 没建成的 worktree（failed，磁盘上什么都没留下）要重新准备，不能让工单卡在它上面。
    const ready = !(resolved.state === "failed" && discardableFailedWorktree(resolved));
    return { coding: true, mode: "isolated", facts, workspace: ready ? resolved : null, ready };
  }
  const sharedReason = resolved && resolved.mode === "shared" && !facts.deploymentRepository
    ? sharedWorkspaceReason(db, resolved)
    : null;
  if (resolved && sharedReason) {
    return { coding: true, mode: "shared", facts, workspace: resolved, ready: true, sharedReason };
  }
  if (workdirOutsideHead(gitRepository, workdir)) {
    return {
      coding: true, mode: "unavailable", facts, workspace: null, ready: false,
      refusal: `workdir ${workdir} is inside the git repository ${gitRepository} but is not in its HEAD `
        + "(untracked or ignored), so an isolated worktree would not contain its files. Commit the files the ticket needs, "
        + "or move the workdir outside the repository"
        + (facts.deploymentRepository ? "." : ", or ask for the shared checkout with provision_workspace(mode='shared', reason)."),
    };
  }
  return { coding: true, mode: "isolated", facts, workspace: null, ready: false };
}

// 隔离 worktree 只有 HEAD 里的内容。工单的 workdir 是仓库里一个没有跟踪、又已经有文件的目录（例如 .scratch/ 下放了材料）时，
// worktree 里只会建出一个空目录：child 看不到材料，产出也留在 worktree 里。还不存在的目录照常隔离，child 会在 worktree 里新建它。
function workdirOutsideHead(repository: string, workdir: string | null): boolean {
  if (!workdir || !existsSync(workdir)) return false;
  const subdirectory = relative(repository, realpathOr(workdir));
  if (!subdirectory || subdirectory.startsWith("..") || isAbsolute(subdirectory)) return false;
  try {
    execFileSync("git", ["-C", repository, "cat-file", "-e", `HEAD:${subdirectory}`], { stdio: "ignore", timeout: 3_000 });
    return false;
  } catch {
    try { return readdirSync(workdir).length > 0; } catch { return false; }
  }
}

/** 派发前的检查（spawn_child 用）：这次 Run 没有合适的工作区时，返回原因。只读。 */
export function runWorkspaceRefusal(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): string | null {
  const plan = planRunWorkspace(db, item, input);
  return plan.mode === "unavailable" ? plan.refusal ?? "no workspace is available for this run" : null;
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

// 建 worktree 失败时留下的行，作废它不会丢任何东西的情况：分支不在或者还停在起点（git 先建分支、再建目录），并且
//   · 目录不在；或者
//   · 目录是 git 登记过的 worktree，干净，HEAD 还在起点；或者
//   · 目录在 <repo>.plc-workspaces 里、git 没有登记，里面最多只有一个 .git 文件（git 建到一半）。
function discardableFailedWorktree(workspace: Workspace): boolean {
  if (!workspace.repo_root) return false;
  const repo = workspace.repo_root;
  const quiet = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], timeout: 5_000 };
  if (workspace.branch) {
    try {
      const head = execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`], quiet).trim();
      if (head !== workspace.base_ref) return false;
    } catch { /* 分支不在 */ }
  }
  if (!existsSync(workspace.path)) return true;
  const path = realpathOr(workspace.path);
  let registered = false;
  try {
    registered = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], quiet).split("\n")
      .some((line) => line.startsWith("worktree ") && realpathOr(line.slice("worktree ".length)) === path);
  } catch { return false; }
  if (registered) {
    try {
      const dirty = execFileSync("git", ["-C", path, "status", "--porcelain", "--untracked-files=normal"], quiet).trim();
      const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], quiet).trim();
      return dirty === "" && head === workspace.base_ref;
    } catch { return false; }
  }
  if (dirname(path) !== realpathOr(workspaceRootFor(repo))) return false;
  try { return readdirSync(path).every((name) => name === ".git"); } catch { return false; }
}

function removeFailedWorktree(workspace: Workspace): void {
  const repo = workspace.repo_root!;
  if (existsSync(workspace.path)) {
    try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", workspace.path], { stdio: "ignore", timeout: 30_000 }); } catch { /* 没有登记 */ }
    if (existsSync(workspace.path) && dirname(realpathOr(workspace.path)) === realpathOr(workspaceRootFor(repo))) {
      rmSync(workspace.path, { recursive: true, force: true });
    }
  } else {
    try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", workspace.path], { stdio: "ignore", timeout: 30_000 }); } catch { /* 没有登记 */ }
  }
  if (workspace.branch?.startsWith("plc/")) {
    try { execFileSync("git", ["-C", repo, "branch", "-D", workspace.branch], { stdio: "ignore", timeout: 10_000 }); } catch { /* 保留 */ }
  }
}

/** workdir 和这张工单相同的最近的祖先（没有时是它自己）。只继承父工单路径的子工单不另立工作区。 */
export function sameWorkdirOwner(db: Db, item: Item): Item {
  let owner = item;
  let cursor = item;
  while (cursor.parent_item_id !== null) {
    const parent = getItem(db, cursor.parent_item_id);
    if (!parent || parent.workdir !== item.workdir) break;
    owner = parent;
    cursor = parent;
  }
  return owner;
}

function recordDecision(
  db: Db, item: Item, plan: RunWorkspacePlan, workspace: Workspace | null, runId?: number,
): void {
  if (!plan.facts.writes && plan.mode !== "pull_request") return;
  const payload = {
    decision: WORKSPACE_POLICY_DECISION,
    coding: plan.coding,
    mode: plan.mode,
    workspaceId: workspace?.id ?? null,
    facts: plan.facts,
    ...(plan.sharedReason ? { sharedReason: plan.sharedReason } : {}),
    ...(plan.pullRequest ? { pullRequest: plan.pullRequest } : {}),
    ...(plan.refusal ? { refusal: plan.refusal } : {}),
  };
  // 同一张工单上判定没有变时不重复记：每个 Run 都记一条，账本里就全是同样的话。
  const last = latestDecision(db, item.id, WORKSPACE_POLICY_DECISION);
  if (last && last.mode === payload.mode && last.workspaceId === payload.workspaceId && last.coding === payload.coding) return;
  addActivity(db, { itemId: item.id, ...(runId ? { runId } : {}), actor: "system", kind: "decision", payload });
}

function markCoding(db: Db, item: Item): void {
  if (item.workflow_kind === "coding") return;
  db.prepare("UPDATE items SET workflow_kind='coding', updated_at=datetime('now') WHERE id=?").run(item.id);
}

export interface RunWorkspacePreparation {
  // 这次 Run 用的工作区。null 且没有 checkout：这张工单没有工作区，由调用方照旧处理。
  workspace: Workspace | null;
  // PR 评审：临时检出要 fetch，是异步的。调用方建好 Run 以后再等它，再把 Run 绑上去。
  checkout?: (runId: number) => Promise<Workspace>;
}

/**
 * 判定并准备这次 Run 的工作区。runItem 在建 Run、改 stage 之前调用。除了 PR 的临时检出都是同步的：
 * 调用方（例如 daemon 重启后的自动重派）依赖 runItem 同步建出 Run。
 */
export function prepareRunWorkspace(
  db: Db, itemId: number, input: { role: "executor" | "reviewer"; purpose: RunPurpose; runId?: number },
): RunWorkspacePreparation {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  const plan = planRunWorkspace(db, item, input);
  if (plan.coding) markCoding(db, item);
  if (plan.mode === "unavailable") {
    recordDecision(db, item, plan, null, input.runId);
    throw new Error(plan.refusal);
  }
  if (plan.mode === "pull_request") {
    return {
      workspace: null,
      checkout: async (runId) => {
        const workspace = await createPullRequestCheckout(db, item, plan.facts.gitRepository!, plan.pullRequest!, runId);
        recordDecision(db, item, plan, workspace, input.runId);
        return workspace;
      },
    };
  }
  let workspace = plan.workspace;
  if (!plan.ready) {
    // 隔离 worktree 从用户 checkout 的当前 commit 切出，归来源工作区的主人所有：子工单和父工单用同一个（设计 §4 第 2 行）。
    // 还没有来源工作区时，先把用户的 checkout 登记成来源（不动任何文件），主人是 workdir 相同的最近的祖先。
    let resolved = resolveWorkspace(db, itemId);
    if (resolved?.workspace.mode === "isolated" && resolved.workspace.state === "failed") {
      const failed = resolved.workspace;
      // discardableFailedWorktree 已经确认分支还停在起点，-D 只删一个没有任何 commit 的分支。
      removeFailedWorktree(failed);
      transitionWorkspace(db, failed.id, "cleaning");
      transitionWorkspace(db, failed.id, "cleaned");
      transitionWorkspace(db, failed.id, "archived");
      addActivity(db, {
        itemId: failed.owner_item_id, actor: "system", kind: "decision",
        payload: { decision: "workspace_failed_discarded", workspaceId: failed.id, path: failed.path },
      });
      resolved = resolveWorkspace(db, itemId);
    }
    let ownerId = resolved?.ownerItemId ?? sameWorkdirOwner(db, item).id;
    let source = resolved?.workspace ?? provisionWorkspace(db, { itemId: ownerId, mode: "shared" });
    if (source.mode === "shared" && (source.state === "failed" || source.state === "blocked")) {
      source = provisionWorkspace(db, { itemId: source.owner_item_id, mode: "shared" });
      ownerId = source.owner_item_id;
    }
    workspace = provisionWorkspace(db, {
      itemId: ownerId, mode: "isolated", sourceWorkspaceId: source.id, ...(input.runId ? { sourceRunId: input.runId } : {}),
    });
  } else if (workspace?.state === "pending_integration") {
    // 工单结束了、正在等合并决定的 worktree，又来了一个 Run（例如工单对话）：先回到 idle 让它用，
    // Run 结束后清理扫描重新判断要不要合并。
    workspace = transitionWorkspace(db, workspace.id, "idle");
  }
  recordDecision(db, item, plan, workspace, input.runId);
  return { workspace };
}

/**
 * Lead 申请用共享的 checkout。理由必填，记在工单上；daemon 自己的仓库不许共享。
 * 工单已经有隔离 worktree 时拒绝：resolveWorkspace 总是先选 worktree，申请不会生效。
 */
export function requestSharedWorkspace(
  db: Db, input: { itemId: number; reason: string; path?: string; actor: Extract<Actor, "lead" | "user"> },
): Workspace {
  const reason = input.reason.trim();
  if (!reason) throw new Error("a shared workspace needs a reason (why this ticket cannot use an isolated worktree)");
  if (reason.length > 1_000) throw new Error("the shared workspace reason is longer than 1000 characters");
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  const path = input.path ?? item.workdir;
  if (!path) throw new Error(`item #${input.itemId} has no workdir; pass path`);
  const repository = gitTop(path);
  if (repository && isDeploymentRepository(repository)) {
    throw new Error(
      `${repository} is the repository the daemon is deployed from; its tickets always run in an isolated worktree. `
      + "Commit the change the ticket needs first, then the worktree starts from it.",
    );
  }
  const isolated = listWorkspaces(db, { ownerItemId: input.itemId })
    .find((workspace) => workspace.mode === "isolated" && !["cleaned", "archived"].includes(workspace.state));
  if (isolated) {
    throw new Error(`item #${input.itemId} already has isolated workspace #${isolated.id}; release it before asking for the shared checkout`);
  }
  const workspace = provisionWorkspace(db, { itemId: input.itemId, mode: "shared", path });
  addActivity(db, {
    itemId: input.itemId, actor: input.actor, kind: "decision",
    payload: { decision: SHARED_WORKSPACE_REQUESTED, workspaceId: workspace.id, path: workspace.path, reason },
  });
  return workspace;
}

const REMOTE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** 记下这张工单要评审的 PR。之后它的每个 Run 都在这个 PR head 的临时检出里跑。 */
export function setPullRequestReviewTarget(
  db: Db, input: { itemId: number; number: number; remote?: string; actor: Extract<Actor, "lead" | "user"> },
): PullRequestTarget {
  if (!Number.isSafeInteger(input.number) || input.number <= 0) throw new Error("pull request number must be a positive integer");
  const remote = input.remote?.trim() || "origin";
  if (!REMOTE_NAME.test(remote) || remote.startsWith("-")) throw new Error("remote must be a git remote name, for example origin");
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  if (!gitTop(item.workdir)) throw new Error(`item #${input.itemId} workdir is not a git repository; set workdir to the repository of the pull request`);
  const target = { number: input.number, remote };
  addActivity(db, {
    itemId: input.itemId, actor: input.actor, kind: "decision",
    payload: { decision: PULL_REQUEST_TARGET_SET, ...target },
  });
  return target;
}

async function gitAsync(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8", timeout: timeoutMs });
  return stdout.trim();
}

const PULL_REQUEST_FETCH_TIMEOUT_MS = 120_000;

/**
 * PR head 的临时检出：fetch 到 refs/plc/review/ 下的临时引用（不是分支），再在 <repo>.plc-workspaces 下建
 * detached worktree。用户的工作副本、当前分支和未提交的改动都不动。Run 结束后 disposeCheckout 删掉 worktree 和引用。
 */
async function createPullRequestCheckout(
  db: Db, item: Item, repository: string, target: PullRequestTarget, runId: number,
): Promise<Workspace> {
  // 上一个 Run 留下的检出（daemon 在它结束前停了）先清掉：同一张工单同一种工作区只能有一个。
  for (const leftover of listWorkspaces(db, { ownerItemId: item.id })) {
    if (isDisposableCheckout(leftover) && !["cleaned", "archived"].includes(leftover.state)) {
      disposeCheckout(db, leftover.id, "replaced by the checkout of a new run");
    }
  }
  const token = randomUUID().slice(0, 8);
  const ref = `refs/plc/review/item-${item.id}-${token}`;
  const path = join(workspaceRootFor(repository), `pr-${target.number}-item-${item.id}-${token}`);
  // 先建行、马上绑定这个 Run，再 fetch：清理扫描只删没有在跑的 Run 的检出（审查 2026-10-19 第 3 条：
  // 以前检出完成后才绑定，这段时间里扫描会把它删掉）。临时引用也总有一行对应，扫描据此回收孤儿引用。
  let workspace = createWorkspace(db, {
    ownerItemId: item.id, mode: "isolated", kind: "experiment", projectId: item.project_id,
    repoRoot: repository, path, branch: ref, gitWorktree: true, state: "requested",
  });
  attachWorkspaceToRun(db, { runId, workspaceId: workspace.id });
  workspace = transitionWorkspace(db, workspace.id, "provisioning");
  try {
    await gitAsync([
      "-C", repository, "fetch", "--no-tags", "--no-write-fetch-head", target.remote,
      `+refs/pull/${target.number}/head:${ref}`,
    ], PULL_REQUEST_FETCH_TIMEOUT_MS);
    const head = await gitAsync(["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], 10_000);
    db.prepare("UPDATE workspaces SET base_ref=? WHERE id=?").run(head, workspace.id);
    await gitAsync(["-C", repository, "worktree", "add", "--detach", path, head], 120_000);
    return transitionWorkspace(db, workspace.id, "active");
  } catch (error) {
    // 这个 Run 会按宿主出错收尾，runItem 随后删掉这一行（disposeEndedRunCheckout）。这里先把磁盘上的东西清掉。
    try { removeCheckoutFiles(getWorkspace(db, workspace.id)!); } catch { /* 清理扫描会再试 */ }
    const current = getWorkspace(db, workspace.id);
    if (current?.state === "provisioning") transitionWorkspace(db, workspace.id, "failed");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pull request #${target.number} checkout failed for item #${item.id}: ${message}`);
  }
}

/**
 * Run 的工作目录。隔离 worktree 是整个仓库的检出；工单的 workdir 是仓库里的子目录时，
 * Run 在 worktree 里对应的子目录开始，和在用户的 checkout 里一样。
 */
export function runDirectory(db: Db, workspace: Workspace): string {
  if (workspace.mode !== "isolated" || !workspace.repo_root || !workspace.reused_from_workspace_id) return workspace.path;
  const source = getWorkspace(db, workspace.reused_from_workspace_id);
  if (!source) return workspace.path;
  const subdirectory = relative(realpathOr(workspace.repo_root), realpathLoose(source.path));
  if (!subdirectory || subdirectory.startsWith("..") || isAbsolute(subdirectory)) return workspace.path;
  return join(workspace.path, subdirectory);
}

/** 派发认领时绑定的工作区：只有可以直接用的才绑。要新建的（隔离 worktree、PR 检出）留给 runItem 准备。 */
export function dispatchWorkspaceId(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): number | undefined {
  const plan = planRunWorkspace(db, item, input);
  if (!plan.ready) return undefined;
  if (plan.workspace?.state === "pending_integration") return undefined;
  return plan.workspace?.id;
}

/** 一个已结束的 Run 的临时检出：删掉。Run 还会继续（暂停）时保留。不抛错：清不掉的由 sweepWorkspaces 再试。 */
export function disposeEndedRunCheckout(db: Db, runId: number): void {
  try {
    const run = db.prepare("SELECT workspace_id, state FROM runs WHERE id=?").get(runId) as
      { workspace_id: number | null; state: string } | undefined;
    if (!run?.workspace_id || ["starting", "running", "paused"].includes(run.state)) return;
    const workspace = getWorkspace(db, run.workspace_id);
    if (!workspace || !isDisposableCheckout(workspace) || ["cleaned", "archived"].includes(workspace.state)) return;
    disposeCheckout(db, workspace.id, `run #${runId} ${run.state}`);
  } catch {
    // sweepWorkspaces 会再清一次。
  }
}


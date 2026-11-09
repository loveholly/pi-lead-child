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
import { projectRoot, removeTree } from "@pi-lead-child/core";
import type { Actor, Item, RunPurpose, Workspace } from "@pi-lead-child/core";
import {
  disposeCheckout, isDisposableCheckout, provisionWorkspace, provisionWorkspaceAsync, removeCheckoutFiles, workspaceRootFor,
  type ProvisionWorkspaceInput,
} from "./workspace.js";

import {
  cloneTicketRepository, parseRepositorySpec, ticketRepository, ticketRepositoryToClone, type RepositorySpec,
} from "./repository-checkout.js";
import { normalizeRemoteUrl } from "./project-resolver.js";
import { forgetGitFacts, gitFacts, gitFactsReady, warmGitFacts, type GitFactSource } from "./git-facts.js";

const execFileAsync = promisify(execFile);

/** 执行者的这几种 Run 会写文件。outcome_repair 只补交成果，learning 只读记录。 */
export const WRITING_PURPOSES: readonly RunPurpose[] = ["execution", "integration", "conversation"];

export const WORKSPACE_POLICY_DECISION = "workspace_policy";
export const SHARED_WORKSPACE_REQUESTED = "workspace_shared_requested";
export const PULL_REQUEST_TARGET_SET = "workspace_pull_request_target";

export interface PullRequestTarget {
  number: number;
  // 建单时指定的远端（create_task 的 pull_request_remote）。没指定时为 undefined：检出时按仓库的地址找远端。
  remote?: string;
  // PR 所在的仓库（规范化的 host/owner/name）。没记下时检出时再从工单的记录里找。
  repository?: string;
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
  // 工单写明的仓库本机还没有（在后台 clone，或者那次 clone 丢了）：准备工作区时先等它 clone 完。
  repository?: RepositorySpec;
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

// git 的事实从 facts 来（git-facts.ts）：缺省是缓存优先、缺了同步查；派发和 Lead 的预检先异步预热，这里只读缓存。
function gitTop(path: string | null, facts: GitFactSource = gitFacts): string | null {
  if (!path) return null;
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  const root = facts.get({ kind: "top", dir: existing });
  return root ? realpathOr(root) : null;
}

function gitCommonDir(path: string, facts: GitFactSource = gitFacts): string | null {
  const common = facts.get({ kind: "commonDir", dir: path });
  return common ? realpathOr(common) : null;
}

// daemon 跑在哪个 checkout 上（projectRoot：dist 和源码都在主 checkout 里）。按 git 的公共目录比较：
// 这个仓库的任何 worktree 都算同一个仓库。
let deploymentOverride: string[] | null = null;

/** 测试用：把这些仓库当成 daemon 的部署仓库。传 null 恢复缺省（projectRoot）。 */
export function setDeploymentRepositoriesForTesting(paths: string[] | null): void {
  deploymentOverride = paths;
  forgetGitFacts();
}

function deploymentRepositoryDirs(facts: GitFactSource): string[] {
  const roots = deploymentOverride ?? [projectRoot()];
  return roots.map((root) => gitCommonDir(root, facts)).filter((dir): dir is string => dir !== null);
}

export function isDeploymentRepository(path: string, facts: GitFactSource = gitFacts): boolean {
  const common = gitCommonDir(path, facts);
  return common !== null && deploymentRepositoryDirs(facts).includes(common);
}

/** 异步备好一个 workdir 的仓库事实（根目录、是不是部署仓库）：建 PR 工单、申请共享工作区之前用。 */
export function warmWorkdirFacts(workdir: string | null | undefined): Promise<void> {
  return warmGitFacts((facts) => {
    const top = gitTop(workdir ?? null, facts);
    if (top) isDeploymentRepository(top, facts);
  });
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
  if (!payload || typeof payload.number !== "number") return null;
  return {
    number: payload.number,
    ...(typeof payload.remote === "string" ? { remote: payload.remote } : {}),
    ...(typeof payload.repository === "string" ? { repository: payload.repository } : {}),
  };
}

/** 判定这次 Run 用哪个工作区。只读：不建工作区，不写库。派发认领时用它决定把 Run 绑到哪个工作区上。 */
export function planRunWorkspace(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose }, facts: GitFactSource = gitFacts,
): RunWorkspacePlan {
  const resolved = resolveWorkspace(db, item.id)?.workspace ?? null;
  const writes = input.role === "executor" && WRITING_PURPOSES.includes(input.purpose);
  const workdir = resolved?.path ?? item.workdir ?? null;
  const repository = !resolved && writes ? ticketRepositoryToClone(db, item) : null;
  if (repository) {
    const cloneFacts: RunWorkspaceFacts = { role: input.role, purpose: input.purpose, writes, workdir, gitRepository: null, deploymentRepository: false };
    return { coding: true, mode: "isolated", facts: cloneFacts, workspace: null, ready: false, repository };
  }
  const gitRepository = resolved?.repo_root ? realpathOr(resolved.repo_root) : gitTop(workdir, facts);
  const runFacts: RunWorkspaceFacts = {
    role: input.role, purpose: input.purpose, writes, workdir, gitRepository,
    deploymentRepository: gitRepository !== null && isDeploymentRepository(gitRepository, facts),
  };
  const pullRequest = gitRepository ? pullRequestReviewTarget(db, item.id) : null;
  // PR 工单的核查者也看 PR head：给它一个同样的临时检出，不让它对着用户的 checkout 下结论（审查 2026-10-19 第 6 条）。
  if (pullRequest && input.role === "reviewer" && input.purpose === "review") {
    return { coding: false, mode: "pull_request", facts: runFacts, workspace: null, ready: false, pullRequest };
  }
  if (!writes) {
    return { coding: false, mode: resolved ? resolved.mode : "none", facts: runFacts, workspace: resolved, ready: true };
  }
  if (!gitRepository) {
    return { coding: false, mode: workdir ? "shared" : "none", facts: runFacts, workspace: resolved, ready: true };
  }
  if (pullRequest) {
    // 每个 Run 用自己的临时检出：上一个 Run 留下的（还没清理掉的）不再用。
    return { coding: true, mode: "pull_request", facts: runFacts, workspace: null, ready: false, pullRequest };
  }
  if (resolved && resolved.mode === "isolated" && !isDisposableCheckout(resolved)) {
    // 没建成的 worktree（failed，磁盘上什么都没留下）要重新准备，不能让工单卡在它上面。
    const ready = !(resolved.state === "failed" && discardableFailedWorktree(resolved, facts));
    return { coding: true, mode: "isolated", facts: runFacts, workspace: ready ? resolved : null, ready };
  }
  const sharedReason = resolved && resolved.mode === "shared" && !runFacts.deploymentRepository
    ? sharedWorkspaceReason(db, resolved)
    : null;
  if (resolved && sharedReason) {
    return { coding: true, mode: "shared", facts: runFacts, workspace: resolved, ready: true, sharedReason };
  }
  if (workdirOutsideHead(gitRepository, workdir, facts)) {
    return {
      coding: true, mode: "unavailable", facts: runFacts, workspace: null, ready: false,
      refusal: `workdir ${workdir} is inside the git repository ${gitRepository} but is not in its HEAD `
        + "(untracked or ignored), so an isolated worktree would not contain its files. Commit the files the ticket needs, "
        + "or move the workdir outside the repository"
        + (runFacts.deploymentRepository ? "." : ", or ask for the shared checkout with provision_workspace(mode='shared', reason)."),
    };
  }
  return { coding: true, mode: "isolated", facts: runFacts, workspace: null, ready: false };
}

// 隔离 worktree 只有 HEAD 里的内容。工单的 workdir 是仓库里一个没有跟踪、又已经有文件的目录（例如 .scratch/ 下放了材料）时，
// worktree 里只会建出一个空目录：child 看不到材料，产出也留在 worktree 里。还不存在的目录照常隔离，child 会在 worktree 里新建它。
function workdirOutsideHead(repository: string, workdir: string | null, facts: GitFactSource): boolean {
  if (!workdir || !existsSync(workdir)) return false;
  const subdirectory = relative(repository, realpathOr(workdir));
  if (!subdirectory || subdirectory.startsWith("..") || isAbsolute(subdirectory)) return false;
  if (facts.get({ kind: "headHas", repository, path: subdirectory })) return false;
  try { return readdirSync(workdir).length > 0; } catch { return false; }
}

/** 派发前的检查（spawn_child 用）：这次 Run 没有合适的工作区时，返回原因。只读。 */
export function runWorkspaceRefusal(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): string | null {
  const plan = planRunWorkspace(db, item, input);
  return plan.mode === "unavailable" ? plan.refusal ?? "no workspace is available for this run" : null;
}

/** 派发的门槛：这次判定要的 git 事实都在缓存里时为 true；缺的在后台异步去查，这一拍先跳过（不在事务里跑 git）。 */
export function runWorkspaceFactsReady(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): boolean {
  return gitFactsReady((facts) => planRunWorkspace(db, item, input, facts));
}

/** 异步备好这次判定要的 git 事实（Lead 的 spawn_child 预检之前）。之后的 planRunWorkspace 只读缓存。 */
export function warmRunWorkspaceFacts(
  db: Db, item: Item, input: { role: "executor" | "reviewer"; purpose: RunPurpose },
): Promise<void> {
  return warmGitFacts((facts) => planRunWorkspace(db, item, input, facts));
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

// 建 worktree 失败时留下的行，作废它不会丢任何东西的情况：分支不在或者还停在起点（git 先建分支、再建目录），并且
//   · 目录不在；或者
//   · 目录是 git 登记过的 worktree，干净，HEAD 还在起点；或者
//   · 目录在 <repo>.plc-workspaces 里、git 没有登记，里面最多只有一个 .git 文件（git 建到一半）。
function discardableFailedWorktree(workspace: Workspace, facts: GitFactSource): boolean {
  if (!workspace.repo_root) return false;
  return facts.get({ kind: "discardable", workspace, worktreeRoot: workspaceRootFor(workspace.repo_root) });
}

async function removeFailedWorktree(workspace: Workspace): Promise<void> {
  const repo = workspace.repo_root!;
  try { await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", workspace.path], { timeout: 30_000 }); } catch { /* 没有登记 */ }
  // 在子进程里删（core 的 removeTree），不在 daemon 的线程池里删整个目录（lead-scheduler spec P0）。
  if (existsSync(workspace.path) && dirname(realpathOr(workspace.path)) === realpathOr(workspaceRootFor(repo))) {
    await removeTree(workspace.path, { kind: "worktree-delete", label: `failed workspace #${workspace.id}`, priority: "utility" });
  }
  if (workspace.branch?.startsWith("plc/")) {
    try { await execFileAsync("git", ["-C", repo, "branch", "-D", workspace.branch], { timeout: 10_000 }); } catch { /* 保留 */ }
  }
}

// 同上，同步做（prepareRunWorkspaceNowForTesting 用）。
function removeFailedWorktreeNow(workspace: Workspace): void {
  const repo = workspace.repo_root!;
  try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", workspace.path], { stdio: "ignore", timeout: 30_000 }); } catch { /* 没有登记 */ }
  if (existsSync(workspace.path) && dirname(realpathOr(workspace.path)) === realpathOr(workspaceRootFor(repo))) {
    rmSync(workspace.path, { recursive: true, force: true });
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
  // 要碰磁盘的检出（PR 评审的临时检出要 fetch，新的隔离 worktree 要 git worktree add），是异步的。
  // 调用方建好 Run 以后再等它，再把 Run 绑上去。
  checkout?: (runId: number) => Promise<Workspace>;
}

/**
 * 判定并准备这次 Run 的工作区。runItem 在建 Run、改 stage 之前调用。判定和库里的事是同步的：
 * 调用方（例如 daemon 重启后的自动重派）依赖 runItem 同步建出 Run。要碰磁盘的检出（PR 的临时检出、新的隔离 worktree）
 * 放进 checkout，Run 建好以后再等它（2026-11-03：大仓库的 git worktree add 同步跑了约 19 秒，daemon 停住）。
 */
export function prepareRunWorkspace(
  db: Db, itemId: number, input: { role: "executor" | "reviewer"; purpose: RunPurpose; runId?: number },
): RunWorkspacePreparation {
  return prepareRunWorkspaceWith(db, itemId, input, "deferred");
}

/** 测试用：新的隔离 worktree 当场同步检出，返回的 workspace 就是它（2026-11-03 以前的做法）。daemon 不用它。 */
export function prepareRunWorkspaceNowForTesting(
  db: Db, itemId: number, input: { role: "executor" | "reviewer"; purpose: RunPurpose; runId?: number },
): RunWorkspacePreparation {
  return prepareRunWorkspaceWith(db, itemId, input, "now");
}

function prepareRunWorkspaceWith(
  db: Db, itemId: number, input: { role: "executor" | "reviewer"; purpose: RunPurpose; runId?: number },
  worktree: "deferred" | "now",
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
        const { workspace, remote } = await createPullRequestCheckout(db, item, plan.facts.gitRepository!, plan.pullRequest!, runId);
        recordDecision(db, item, { ...plan, pullRequest: { ...plan.pullRequest!, remote } }, workspace, input.runId);
        return workspace;
      },
    };
  }
  let workspace = plan.workspace;
  if (!plan.ready && worktree === "deferred") {
    return {
      workspace: null,
      checkout: async () => {
        let ticket = item;
        let decided = plan;
        if (plan.repository) {
          ticket = await cloneTicketRepository(db, item, plan.repository);
          // clone 以前查过的「这里不是仓库」还在缓存里：忘掉，异步重新查好再判定。
          forgetGitFacts();
          await warmRunWorkspaceFacts(db, ticket, input);
          decided = planRunWorkspace(db, ticket, input);
          if (decided.mode !== "isolated" || decided.ready || decided.repository) {
            recordDecision(db, ticket, decided, null, input.runId);
            throw new Error(decided.refusal ?? `${plan.repository.owner}/${plan.repository.name} 已经 clone 好，但工作区的判定是 ${decided.mode}，不是新的隔离 worktree`);
          }
        }
        const failed = failedIsolatedWorkspace(db, ticket.id);
        if (failed) {
          await removeFailedWorktree(failed);
          archiveFailedWorktree(db, failed);
        }
        const isolated = await provisionWorkspaceAsync(db, isolatedWorkspaceInput(db, ticket, input.runId));
        recordDecision(db, ticket, decided, isolated, input.runId);
        return isolated;
      },
    };
  } else if (!plan.ready) {
    const failed = failedIsolatedWorkspace(db, item.id);
    if (failed) {
      removeFailedWorktreeNow(failed);
      archiveFailedWorktree(db, failed);
    }
    workspace = provisionWorkspace(db, isolatedWorkspaceInput(db, item, input.runId));
  } else if (workspace?.state === "pending_integration") {
    // 工单结束了、正在等合并决定的 worktree，又来了一个 Run（例如工单对话）：先回到 idle 让它用，
    // Run 结束后清理扫描重新判断要不要合并。
    workspace = transitionWorkspace(db, workspace.id, "idle");
  }
  recordDecision(db, item, plan, workspace, input.runId);
  return { workspace };
}

// 上一次没建成、可以作废的隔离 worktree（planRunWorkspace 已经用 discardableFailedWorktree 确认过：
// 分支还停在起点，删分支只删一个没有任何 commit 的分支）。
function failedIsolatedWorkspace(db: Db, itemId: number): Workspace | null {
  const resolved = resolveWorkspace(db, itemId)?.workspace;
  return resolved?.mode === "isolated" && resolved.state === "failed" ? resolved : null;
}

function archiveFailedWorktree(db: Db, failed: Workspace): void {
  // 同时开跑的另一个 Run 可能已经作废了它。
  if (getWorkspace(db, failed.id)?.state !== "failed") return;
  transitionWorkspace(db, failed.id, "cleaning");
  transitionWorkspace(db, failed.id, "cleaned");
  transitionWorkspace(db, failed.id, "archived");
  addActivity(db, {
    itemId: failed.owner_item_id, actor: "system", kind: "decision",
    payload: { decision: "workspace_failed_discarded", workspaceId: failed.id, path: failed.path },
  });
}

// 隔离 worktree 从用户 checkout 的当前 commit 切出，归来源工作区的主人所有：子工单和父工单用同一个（设计 §4 第 2 行）。
// 还没有来源工作区时，先把用户的 checkout 登记成来源（不动任何文件），主人是 workdir 相同的最近的祖先。
function isolatedWorkspaceInput(db: Db, item: Item, sourceRunId: number | undefined): ProvisionWorkspaceInput {
  const resolved = resolveWorkspace(db, item.id);
  let ownerId = resolved?.ownerItemId ?? sameWorkdirOwner(db, item).id;
  let source = resolved?.workspace ?? provisionWorkspace(db, { itemId: ownerId, mode: "shared" });
  if (source.mode === "shared" && (source.state === "failed" || source.state === "blocked")) {
    source = provisionWorkspace(db, { itemId: source.owner_item_id, mode: "shared" });
    ownerId = source.owner_item_id;
  }
  return { itemId: ownerId, mode: "isolated", sourceWorkspaceId: source.id, ...(sourceRunId ? { sourceRunId } : {}) };
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
  db: Db,
  input: { itemId: number; number: number; remote?: string; repository?: string; actor: Extract<Actor, "lead" | "user"> },
): PullRequestTarget {
  if (!Number.isSafeInteger(input.number) || input.number <= 0) throw new Error("pull request number must be a positive integer");
  const remote = input.remote?.trim() || undefined;
  if (remote !== undefined && (!REMOTE_NAME.test(remote) || remote.startsWith("-"))) {
    throw new Error("remote must be a git remote name, for example origin");
  }
  const repository = input.repository ? parseRepositorySpec(input.repository) : null;
  if (input.repository && !repository) throw new Error(`repository must be owner/name, for example acme/x; got ${input.repository.slice(0, 80)}`);
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  if (!gitTop(item.workdir)) throw new Error(`item #${input.itemId} workdir is not a git repository; set workdir to the repository of the pull request`);
  const target: PullRequestTarget = {
    number: input.number, ...(remote ? { remote } : {}), ...(repository ? { repository: repository.key } : {}),
  };
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
 * 准备工作区时碰到的、用户自己能修的问题，例如本地仓库没有 PR 所在的远端。runItem 把它记成这次 Run 的失败，
 * 写明缺什么、怎么修，不记成宿主代码的未捕获异常（工单 #212：fetch 写死了 origin，三张 PR 评审单一开跑就记成了宿主异常）。
 */
export class RunWorkspaceSetupError extends Error {
  constructor(readonly title: string, message: string, readonly nextStep: string) {
    super(message);
    this.name = "RunWorkspaceSetupError";
  }
}

interface GitRemote {
  name: string;
  // 规范化的地址（host/owner/name，小写），和 RepositorySpec.key 一样。
  repository: string;
}

// 读配置里的原样地址：remote get-url 会套用 insteadOf 改写，认不出本来是哪个仓库（repository-checkout.ts 的 originOf 也这样读）。
async function gitRemotes(repository: string): Promise<GitRemote[]> {
  let listed: string;
  try {
    listed = await gitAsync(["-C", repository, "config", "--get-regexp", "^remote\\..*\\.url$"], 10_000);
  } catch {
    return []; // 一个远端都没有时 git config 以 1 退出
  }
  return listed.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    return match ? [{ name: match[1]!, repository: normalizeRemoteUrl(match[2]!).toLowerCase() }] : [];
  });
}

// PR 所在的仓库：建单时记下的，否则是工单写明要改的仓库，再否则是 PR 评审模板记下的 PR（owner/repo#N，在 GitHub 上）。
function pullRequestRepository(db: Db, itemId: number, target: PullRequestTarget): string | null {
  if (target.repository) return target.repository;
  const recorded = ticketRepository(db, itemId);
  if (recorded) return recorded;
  const template = latestDecision(db, itemId, "ticket_template");
  const match = typeof template?.pr === "string" ? /^([\w.-]+)\/([\w.-]+)#\d+$/.exec(template.pr) : null;
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
}

function describeRemotes(remotes: GitRemote[]): string {
  if (!remotes.length) return "这个仓库一个 git 远端都没有。";
  return `现有的远端：${remotes.map((remote) => `${remote.name}（${remote.repository}）`).join("、")}。`;
}

/**
 * 从哪个远端取 PR head。建单时指定了远端（pull_request_remote）就用它；没指定时，用地址指向 PR 所在仓库的那个远端，
 * 有几个时优先 origin；不知道 PR 在哪个仓库时，用 origin，没有 origin 就用唯一的那个远端。
 * 找不到时抛 RunWorkspaceSetupError，写明缺哪个远端、怎么配。
 */
async function pullRequestRemote(db: Db, item: Item, repository: string, target: PullRequestTarget): Promise<string> {
  const remotes = await gitRemotes(repository);
  const names = [...new Set(remotes.map((remote) => remote.name))];
  const retry = "然后重试这张工单。";
  // 指定的 origin 不在时照常按地址找：工单 #212 以前，没指定远端时也记成 origin。
  if (target.remote && (names.includes(target.remote) || target.remote !== "origin")) {
    if (names.includes(target.remote)) return target.remote;
    throw new RunWorkspaceSetupError(
      `PR #${target.number} 检出失败：没有远端 ${target.remote}`,
      `本地仓库 ${repository} 没有名为 ${target.remote} 的 git 远端（建单时 pull_request_remote 指定的），取不到 PR #${target.number} 的代码。`
        + describeRemotes(remotes),
      `在 ${repository} 里加上这个远端：git -C ${repository} remote add ${target.remote} <PR 所在仓库的地址>。`
        + `或者建单时把 pull_request_remote 改成上面列出的一个远端名。${retry}`,
    );
  }
  const expected = pullRequestRepository(db, item.id, target);
  if (expected) {
    const matching = [...new Set(remotes.filter((remote) => remote.repository === expected).map((remote) => remote.name))];
    if (matching.length) return matching.includes("origin") ? "origin" : matching[0]!;
    throw new RunWorkspaceSetupError(
      `PR #${target.number} 检出失败：没有指向 ${expected} 的远端`,
      `本地仓库 ${repository} 没有指向 ${expected} 的 git 远端，取不到 PR #${target.number} 的代码。${describeRemotes(remotes)}`,
      `在 ${repository} 里加一个指向它的远端：git -C ${repository} remote add <远端名> https://${expected}.git。`
        + `已经有这个仓库的远端、只是地址的写法不同时，建单时用 pull_request_remote 写明远端名。${retry}`,
    );
  }
  if (names.includes("origin")) return "origin";
  if (names.length === 1) return names[0]!;
  throw new RunWorkspaceSetupError(
    `PR #${target.number} 检出失败：不知道用哪个远端`,
    names.length
      ? `本地仓库 ${repository} 没有 origin，有 ${names.length} 个别的远端，系统不知道 PR #${target.number} 在哪一个上。${describeRemotes(remotes)}`
      : `本地仓库 ${repository} 一个 git 远端都没有，取不到 PR #${target.number} 的代码。`,
    `建单时用 pull_request_remote 写明 PR 所在的远端名，或者用 repository 写明 PR 所在的仓库（owner/name）。`
      + `没有远端时先加一个：git -C ${repository} remote add <远端名> <仓库地址>。${retry}`,
  );
}

/**
 * PR head 的临时检出：fetch 到 refs/plc/review/ 下的临时引用（不是分支），再在 <repo>.plc-workspaces 下建
 * detached worktree。用户的工作副本、当前分支和未提交的改动都不动。Run 结束后 disposeCheckout 删掉 worktree 和引用。
 */
async function createPullRequestCheckout(
  db: Db, item: Item, repository: string, target: PullRequestTarget, runId: number,
): Promise<{ workspace: Workspace; remote: string }> {
  // 上一个 Run 留下的检出（daemon 在它结束前停了）先清掉：同一张工单同一种工作区只能有一个。
  for (const leftover of listWorkspaces(db, { ownerItemId: item.id })) {
    if (isDisposableCheckout(leftover) && !["cleaned", "archived"].includes(leftover.state)) {
      await disposeCheckout(db, leftover.id, "replaced by the checkout of a new run");
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
    const remote = await pullRequestRemote(db, item, repository, target);
    try {
      await gitAsync([
        "-C", repository, "fetch", "--no-tags", "--no-write-fetch-head", remote,
        `+refs/pull/${target.number}/head:${ref}`,
      ], PULL_REQUEST_FETCH_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RunWorkspaceSetupError(
        `PR #${target.number} 检出失败：从远端 ${remote} 取不到`,
        `从远端 ${remote} 取 PR #${target.number} 的代码失败：${lastLine(message)}`,
        `确认 PR #${target.number} 在远端 ${remote} 的仓库里，并且本机连得上、有读这个仓库的权限。`
          + "PR 在别的远端上时，建单时用 pull_request_remote 写明远端名。然后重试这张工单。",
      );
    }
    const head = await gitAsync(["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], 10_000);
    db.prepare("UPDATE workspaces SET base_ref=? WHERE id=?").run(head, workspace.id);
    await gitAsync(["-C", repository, "worktree", "add", "--detach", path, head], 120_000);
    return { workspace: transitionWorkspace(db, workspace.id, "active"), remote };
  } catch (error) {
    // 这个 Run 会记成失败，runItem 随后删掉这一行（disposeEndedRunCheckout）。这里先把磁盘上的东西清掉。
    try { await removeCheckoutFiles(getWorkspace(db, workspace.id)!); } catch { /* 清理扫描会再试 */ }
    const current = getWorkspace(db, workspace.id);
    if (current?.state === "provisioning") transitionWorkspace(db, workspace.id, "failed");
    if (error instanceof RunWorkspaceSetupError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pull request #${target.number} checkout failed for item #${item.id}: ${message}`);
  }
}

// git 报错的最后一行（fatal: …）。前面是 "Command failed: git …" 这类命令行。
function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 500) ?? "";
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

/**
 * 一个已结束的 Run 的临时检出：删掉。Run 还会继续（暂停）时保留。不抛错：清不掉的由 sweepWorkspaces 再试。
 * 删目录在子进程和 fs.promises 里做，调用方不用等它（2026-11-03：以前同步删，一个检出要几秒，daemon 停住）。
 */
export async function disposeEndedRunCheckout(db: Db, runId: number): Promise<void> {
  try {
    const run = db.prepare("SELECT workspace_id, state FROM runs WHERE id=?").get(runId) as
      { workspace_id: number | null; state: string } | undefined;
    if (!run?.workspace_id || ["starting", "running", "paused"].includes(run.state)) return;
    const workspace = getWorkspace(db, run.workspace_id);
    if (!workspace || !isDisposableCheckout(workspace) || ["cleaned", "archived"].includes(workspace.state)) return;
    await disposeCheckout(db, workspace.id, `run #${runId} ${run.state}`);
  } catch {
    // sweepWorkspaces 会再清一次。
  }
}


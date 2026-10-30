// 仓库的远端：daemon 在沙箱外替 Run 取最新的 origin，新的隔离 worktree 从 origin 的默认分支切（2026-10-29）。
//
// 起因：执行者和核查员在沙箱里跑，读不到钥匙串，git 没有凭证，fetch 不了。#159 返工要 rebase 到最新 master，
// 本地的 origin/master 还是几天前的，卡成阻塞，只能请用户自己在终端里 fetch。另外，worktree 以前从用户 checkout
// 当前的 HEAD 切：#158、#159 切的时候用户正停在不相干的功能分支上，PR 的 base 和基线都错了。
// daemon 不在沙箱里，用的是用户自己的 git 凭证（推送和开 PR 也是它做的，delivery.ts）。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Db } from "@pi-lead-child/store";
import { addActivity, getWorkspace } from "@pi-lead-child/store";
import type { Workspace } from "@pi-lead-child/core";
import { gitRun, NETWORK_TIMEOUT_MS } from "./delivery-source.js";

// 同一个仓库两次 fetch 至少隔这么久：一张工单的执行、核查、返工接连启动时，不用每次都连远端。
const FETCH_INTERVAL_MS = 60_000;
const lastFetch = new Map<string, number>();

function syncGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface FetchOutcome {
  fetched: boolean;
  repoRoot: string | null;
  // 没有 fetch 的原因：不是 git 仓库、没有 origin、刚 fetch 过、或者 git 的报错（第一行）。
  reason?: string;
}

/**
 * 在 dir 所在仓库里 fetch origin（git 的凭证是用户的，不经过沙箱）。失败不抛错：Run 照样启动，原因写进结果。
 * 同一个仓库 60 秒内只 fetch 一次。worktree 和用户的 checkout 共用一个 .git，fetch 一次两边都看得到。
 */
export async function fetchOrigin(dir: string | null | undefined, options: { now?: number; force?: boolean } = {}): Promise<FetchOutcome> {
  if (!dir || !isAbsolute(dir) || !existsSync(dir)) return { fetched: false, repoRoot: null, reason: "没有工作目录" };
  const top = await gitRun(["rev-parse", "--show-toplevel"], dir);
  if (!top.ok) return { fetched: false, repoRoot: null, reason: "不是 git 仓库" };
  const common = await gitRun(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  const key = common.ok ? common.stdout.trim() : top.stdout.trim();
  const repoRoot = top.stdout.trim();
  const remote = await gitRun(["remote", "get-url", "origin"], dir);
  if (!remote.ok) return { fetched: false, repoRoot, reason: "没有 origin" };
  const now = options.now ?? Date.now();
  if (!options.force && now - (lastFetch.get(key) ?? 0) < FETCH_INTERVAL_MS) return { fetched: false, repoRoot, reason: "刚 fetch 过" };
  const result = await gitRun(["fetch", "--prune", "--quiet", "origin"], dir, {
    timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!result.ok) return { fetched: false, repoRoot, reason: result.stderr.trim().split("\n")[0] || "fetch 失败" };
  lastFetch.set(key, now);
  return { fetched: true, repoRoot };
}

/** 测试用：忘掉上一次 fetch 的时间。 */
export function resetFetchThrottleForTests(): void {
  lastFetch.clear();
}

/** origin 的默认分支名（origin/HEAD 指向的；没有设时看 main、master 有没有）。没有 origin 时为 null。 */
export function originDefaultBranch(repoRoot: string): string | null {
  if (syncGit(["remote", "get-url", "origin"], repoRoot) === null) return null;
  const head = syncGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (syncGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], repoRoot)) return name;
  }
  return null;
}

export interface WorktreeBase {
  ref: string;
  // 基于哪个分支（PR 的 base 用它）。没有 origin 时为 null：按用户 checkout 当前的 HEAD 切。
  branch: string | null;
}

/**
 * 新的隔离 worktree 从哪个提交切：
 *   - 仓库有 origin：origin 的默认分支。本地的同名分支领先 origin（有没推的提交、并且包含 origin 的）时用本地的，
 *     否则用 origin 的。用户 checkout 当前停在哪个分支不算数：它常常是不相干的功能分支。
 *   - 没有 origin（例如 pi-lead-child 自己的仓库）：用户 checkout 当前的 HEAD，和以前一样。
 */
export function chooseWorktreeBase(repoRoot: string, sourceDir: string): WorktreeBase {
  const branch = originDefaultBranch(repoRoot);
  const remoteRef = branch ? syncGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoRoot) : null;
  if (!branch || !remoteRef) {
    const head = syncGit(["rev-parse", "HEAD"], sourceDir);
    if (!head) throw new Error(`cannot resolve HEAD in ${sourceDir}`);
    return { ref: head, branch: null };
  }
  const localRef = syncGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
  if (localRef && localRef !== remoteRef && syncGit(["merge-base", "--is-ancestor", remoteRef, localRef], repoRoot) !== null) {
    return { ref: localRef, branch };
  }
  return { ref: remoteRef, branch };
}

/** 记下 worktree 基于哪个分支：PR 的 base 用它（delivery.ts 的 pullRequestBase）。 */
export function recordWorktreeBase(db: Db, workspace: Pick<Workspace, "id" | "owner_item_id">, base: WorktreeBase): void {
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: "system", kind: "decision",
    payload: { decision: "workspace_base_selected", workspaceId: workspace.id, branch: base.branch, ref: base.ref },
  });
}

/** worktree 基于的分支（recordWorktreeBase 记的）。没有记过时为 null。 */
export function worktreeBaseBranch(db: Db, workspace: Pick<Workspace, "id" | "owner_item_id">): string | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.branch') AS branch FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='workspace_base_selected'
       AND json_extract(payload, '$.workspaceId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(workspace.owner_item_id, workspace.id) as { branch: string | null } | undefined;
  return row?.branch ?? null;
}

/**
 * 新切的 worktree 还没有自己的提交、也没有改动时，快进到 fetch 之后的 origin/<基线分支>，基线跟着改（delivery 的文件列表按它算）。
 * worktree 是在建 Run 时同步切的，用的是上一次 fetch 的 origin；fetch 在建 Run 之后（children/manager.ts），所以这里补一步。
 * 有提交、有改动、基线分支没记、或者 origin 不是基线的后代时不动。返回更新后的工作区；没动时为 null。
 */
export function refreshFreshWorktree(db: Db, workspace: Workspace): Workspace | null {
  if (!workspace.git_worktree || workspace.mode !== "isolated" || !workspace.base_ref || !existsSync(workspace.path)) return null;
  const branch = worktreeBaseBranch(db, workspace);
  if (!branch) return null;
  const remoteRef = syncGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], workspace.path);
  if (!remoteRef || remoteRef === workspace.base_ref) return null;
  if (syncGit(["rev-list", "--count", `${workspace.base_ref}..HEAD`], workspace.path) !== "0") return null;
  if (syncGit(["status", "--porcelain"], workspace.path) !== "") return null;
  if (syncGit(["merge-base", "--is-ancestor", workspace.base_ref, remoteRef], workspace.path) === null) return null;
  if (syncGit(["merge", "--ff-only", "--quiet", remoteRef], workspace.path) === null) return null;
  db.prepare("UPDATE workspaces SET base_ref=? WHERE id=?").run(remoteRef, workspace.id);
  recordWorktreeBase(db, workspace, { ref: remoteRef, branch });
  return getWorkspace(db, workspace.id) ?? null;
}

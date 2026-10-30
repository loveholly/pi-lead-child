import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@pi-lead-child/store";
import { addActivity, addInbox, getItem } from "@pi-lead-child/store";
import type { Actor, Workspace, WorkspaceKind, WorkspaceMode, WorkspaceState } from "@pi-lead-child/core";
import {
  createWorkspace, getWorkspace, listWorkspaces, resolveWorkspace, transitionWorkspace,
} from "@pi-lead-child/store";
import { repositoryIdentity } from "./project-resolver.js";
import { chooseWorktreeBase, recordWorktreeBase } from "./workspace-remote.js";
import { workspaceContentHash } from "./workspace-integrity.js";
import { startWorktreeDependencies } from "./worktree-dependencies.js";
import { createCheckpointDomainService } from "./checkpoints.js";
import { openArtifactContent, stageArtifact } from "@pi-lead-child/store";

export interface ProvisionWorkspaceInput {
  itemId: number;
  mode: WorkspaceMode;
  kind?: WorkspaceKind;
  sourceWorkspaceId?: number;
  sourceRunId?: number;
  path?: string;
  branchHint?: string;
}

export interface WorkspaceReconcileResult {
  checked: number;
  recovered: number;
  failed: number;
}

export interface WorkspaceCleanupChecks {
  ownerTerminal: boolean; noActiveRuns: boolean; snapshotPersisted: boolean;
  contentMatchesSnapshot: boolean; commitsCovered: boolean; retentionElapsed: boolean;
}

export interface WorkspaceSweepResult {
  checked: number;
  released: number;
  /** Workspaces the sweep could not release. They keep their state; the next sweep tries again. */
  failed: Array<{ workspaceId: number; error: string }>;
}

// Cleanup deletes only git worktrees that plc created (cleanupWorkspace). Any other workspace is
// the user's own directory, often the main checkout with node_modules. The content hash of such a
// directory protects nothing, and computing it read the whole tree on the daemon main thread.
// Its release snapshot records this marker, and cleanup does not compare its content.
const CONTENT_NOT_HASHED = "not-hashed:not-a-plc-worktree";

function hashesContent(workspace: Workspace): boolean {
  return Boolean(workspace.git_worktree && workspace.repo_root);
}

function databaseDataDir(db: Db): string | null {
  return db.name === ":memory:" ? null : dirname(db.name);
}

function buildWorkspaceSnapshot(db: Db, workspace: Workspace, contentHash: string): Buffer {
  if (!workspace.git_worktree || !workspace.repo_root || !workspace.base_ref) {
    return Buffer.from(JSON.stringify({ version: 1, workspaceId: workspace.id, contentHash }), "utf8");
  }
  const bundleDir = mkdtempSync(join(tmpdir(), "plc-workspace-bundle-"));
  const bundlePath = join(bundleDir, "workspace.bundle");
  try {
    // A standalone bundle must carry its own prerequisite history. Using HEAD
    // (instead of HEAD ^base_ref) also handles a workspace with no new commit.
    git(["bundle", "create", bundlePath, "HEAD"], workspace.path);
    return Buffer.from(JSON.stringify({
      version: 1,
      workspaceId: workspace.id,
      contentHash,
      head: git(["rev-parse", "HEAD"], workspace.path),
      baseRef: workspace.base_ref,
      branch: workspace.branch,
      bundle: readFileSync(bundlePath).toString("base64"),
    }), "utf8");
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

function persistWorkspaceSnapshot(db: Db, workspace: Workspace, contentHash: string, dataDir: string | null): number | null {
  if (!dataDir) return null;
  const item = getItem(db, workspace.owner_item_id);
  if (!item?.workdir || !existsSync(item.workdir)) return null;
  const relativePath = `.plc-workspace-snapshot-${workspace.id}-${randomUUID()}.json`;
  const temporaryPath = join(item.workdir, relativePath);
  const content = buildWorkspaceSnapshot(db, workspace, contentHash);
  writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
  let staged;
  try {
    staged = stageArtifact(db, {
      dataDir, itemId: workspace.owner_item_id, runId: null,
      ref: `workspace-snapshot:${workspace.id}`,
      name: `workspace-${workspace.id}-snapshot.json`, kind: "workspace_snapshot",
      mediaType: "application/json", description: "Immutable workspace cleanup snapshot",
      relativePath,
    });
    const result = createCheckpointDomainService({ db }).recordSystemCheckpoint({
      itemId: workspace.owner_item_id, kind: "milestone", title: "Workspace snapshot persisted",
      summary: `Workspace #${workspace.id} cleanup snapshot persisted as an immutable artifact.`,
      artifactRefs: [staged.ref], idempotencyKey: `workspace-snapshot:${workspace.id}:${contentHash}`,
      stagedArtifacts: [staged],
    });
    return (db.prepare("SELECT id FROM artifacts WHERE checkpoint_id=? AND ref=?")
      .get(result.checkpoint.id, staged.ref) as { id: number }).id;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** plc 为一个仓库建的 worktree 都放在仓库旁边的这个目录里。清理扫描在这里找没有登记的孤儿目录。 */
export function workspaceRootFor(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}.plc-workspaces`);
}

/** PR 评审的临时检出（workspace-policy.ts）：kind=experiment 的 plc worktree。它只属于一个 Run，Run 结束就删。 */
export function isDisposableCheckout(workspace: Pick<Workspace, "kind" | "git_worktree">): boolean {
  return workspace.kind === "experiment" && Boolean(workspace.git_worktree);
}

function insideWorkspaceRoot(workspace: Workspace): boolean {
  if (!workspace.repo_root) return false;
  const root = resolve(workspaceRootFor(workspace.repo_root));
  return resolve(workspace.path).startsWith(`${root}${sep}`);
}

function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

function safeBranchHint(value: string): string {
  const branch = value.trim();
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("workspace branch hint is invalid");
  }
  return branch;
}

function assertAbsolutePath(value: string, field: string): string {
  const path = resolve(value.trim());
  if (!value.trim() || !isAbsolute(value.trim())) throw new Error(`${field} must be absolute`);
  return path;
}

function sourceWorkspace(db: Db, input: ProvisionWorkspaceInput): Workspace {
  const source = input.sourceWorkspaceId !== undefined
    ? getWorkspace(db, input.sourceWorkspaceId)
    : resolveWorkspace(db, input.itemId)?.workspace;
  if (!source) throw new Error(`no source workspace for item #${input.itemId}`);
  if (["released", "cleaning", "cleaned", "archived", "failed", "blocked"].includes(source.state)) {
    throw new Error(`source workspace #${source.id} is unavailable in state ${source.state}`);
  }
  return source;
}

function existingWorkspaceForOwner(db: Db, ownerItemId: number, kind: WorkspaceKind): Workspace | undefined {
  return listWorkspaces(db, { ownerItemId }).find((workspace) =>
    workspace.kind === kind && !["cleaned", "archived"].includes(workspace.state));
}

function markWorkspacePath(db: Db, workspace: Workspace): void {
  db.prepare("UPDATE items SET workdir=?, updated_at=datetime('now') WHERE id=?")
    .run(workspace.path, workspace.owner_item_id);
}

export function provisionWorkspace(db: Db, input: ProvisionWorkspaceInput): Workspace {
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  const kind = input.kind ?? (input.mode === "isolated" ? "isolated_child" : "primary");

  if (input.mode === "shared") {
    const existing = existingWorkspaceForOwner(db, input.itemId, kind);
    // 共享工作区就是用户自己的目录，准备它不需要做任何事。所以 failed 或 blocked 的共享工作区
    // 重新准备时直接回到 active，和 isolated 工作区的重新准备一样。旧版本在 Run 启动失败时
    // 会把它标成 failed（工单 79），preflight 的 blocker 要人重建工作区，靠的就是这一步。
    if (existing && (existing.state === "failed" || existing.state === "blocked")) {
      transitionWorkspace(db, existing.id, "provisioning");
      return transitionWorkspace(db, existing.id, "active");
    }
    if (existing) return existing;
    const path = input.path ?? item.workdir;
    if (!path) throw new Error(`shared workspace for item #${input.itemId} requires an explicit path`);
    const workspace = createWorkspace(db, {
      ownerItemId: input.itemId, mode: "shared", kind, path: assertAbsolutePath(path, "workspace path"),
      projectId: item.project_id, state: "active", sourceItemId: input.itemId, sourceRunId: input.sourceRunId,
    });
    markWorkspacePath(db, workspace);
    return workspace;
  }

  const source = sourceWorkspace(db, input);
  // 来源路径可以是 child 要新建的目录（还不存在）：按它最近的已存在的上级目录找仓库。
  const sourceDir = existingAncestor(source.path);
  const identity = source.repo_root
    ? { root: source.repo_root }
    : repositoryIdentity(sourceDir);
  if (!identity) throw new Error(`isolated workspace requires a git repository at ${source.path}`);
  const repoRoot = identity.root;
  const existing = existingWorkspaceForOwner(db, input.itemId, kind);
  // 新切的 worktree 基于 origin 的默认分支（workspace-remote.ts，2026-10-29），不是用户 checkout 当前停的分支。
  // 已经有的 worktree 沿用它原来的基线：只在来源明确写了基线、又和它不一样时才算不对。
  const chosenBase = existing ? null : source.base_ref ? { ref: source.base_ref, branch: null } : chooseWorktreeBase(repoRoot, sourceDir);
  const baseRef = chosenBase?.ref ?? existing!.base_ref;
  let workspace: Workspace;
  if (existing) {
    workspace = existing;
    if (workspace.repo_root !== repoRoot || (source.base_ref && workspace.base_ref !== source.base_ref)) {
      throw new Error(`workspace #${workspace.id} has incompatible git provenance`);
    }
    if (workspace.state === "active" || workspace.state === "idle" || workspace.state === "review_hold") {
      // 以前建的 worktree 可能还没有依赖：补上（已经有时什么也不做）。
      prepareDependencies(db, workspace, repoRoot);
      return workspace;
    }
    if (workspace.state === "failed" || workspace.state === "blocked") {
      workspace = transitionWorkspace(db, workspace.id, "provisioning");
    } else if (workspace.state === "requested") {
      workspace = transitionWorkspace(db, workspace.id, "provisioning");
    }
  } else {
    const branch = input.branchHint
      ? safeBranchHint(input.branchHint)
      : `plc/item-${input.itemId}-${randomUUID().slice(0, 8)}`;
    const workspaceRoot = workspaceRootFor(repoRoot);
    mkdirSync(workspaceRoot, { recursive: true });
    const path = input.path
      ? assertAbsolutePath(input.path, "workspace path")
      : join(workspaceRoot, `item-${input.itemId}-${randomUUID().slice(0, 8)}`);
    workspace = createWorkspace(db, {
      ownerItemId: input.itemId, mode: "isolated", kind, path, repoRoot, branch, baseRef,
      gitWorktree: true, sourceItemId: input.itemId, sourceRunId: input.sourceRunId,
      reusedFromWorkspaceId: input.sourceWorkspaceId ?? source.id, state: "requested", mergeStatus: "pending",
    });
    if (chosenBase) recordWorktreeBase(db, workspace, chosenBase);
    workspace = transitionWorkspace(db, workspace.id, "provisioning");
  }

  try {
    if (existsSync(workspace.path)) throw new Error(`workspace path already exists: ${workspace.path}`);
    mkdirSync(dirname(workspace.path), { recursive: true });
    // 大仓库的检出要几十秒：默认的 10 秒会让它中途失败，留下半个目录（审查 2026-10-19 第 7 条）。
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", workspace.branch!, workspace.path, workspace.base_ref!], {
      encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
    });
    workspace = transitionWorkspace(db, workspace.id, "active");
    markWorkspacePath(db, workspace);
    prepareDependencies(db, workspace, repoRoot);
    return workspace;
  } catch (error) {
    const current = getWorkspace(db, workspace.id);
    if (current && (current.state === "provisioning" || current.state === "requested")) {
      workspace = transitionWorkspace(db, current.id, "failed");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workspace provisioning failed for item #${input.itemId}: ${message}`);
  }
}

// 在后台把用户 checkout 的依赖克隆进 worktree（worktree-dependencies.ts）。执行者启动前会等它（children/manager.ts）。
// 做完记一条活动：克隆了哪些、没做的原因或者出错的原因。
function prepareDependencies(db: Db, workspace: Workspace, source: string): void {
  if (!existsSync(workspace.path)) return;
  void startWorktreeDependencies(source, workspace.path, (result) => {
    if (!result.cloned.length && !result.error) return;
    addActivity(db, {
      itemId: workspace.owner_item_id, actor: "system", kind: "decision",
      payload: {
        decision: "workspace_dependencies", workspaceId: workspace.id, cloned: result.cloned, error: result.error,
        ...(result.installedWith ? { installedWith: result.installedWith } : {}),
      },
    });
  });
}

function activeRunCount(db: Db, workspaceId: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND state IN ('starting','running','paused')",
  ).get(workspaceId) as { n: number }).n;
}

export function releaseWorkspace(db: Db, id: number, options: { mergeStatus?: "merged" | "abandoned"; dataDir?: string } = {}): Workspace {
  const workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  if (activeRunCount(db, id) !== 0) throw new Error(`workspace #${id} still has active runs`);
  const owner = getItem(db, workspace.owner_item_id);
  if (!owner || !["done", "cancelled"].includes(owner.stage)) {
    throw new Error(`workspace #${id} owner item must be terminal (done or cancelled)`);
  }
  if (["released", "cleaning", "cleaned", "archived"].includes(workspace.state)) return workspace;
  // blocked：合并冲突以后，用户解决了冲突（或者决定放弃），这里收尾。
  if (!["active", "idle", "review_hold", "pending_integration", "blocked"].includes(workspace.state)) {
    throw new Error(`workspace #${id} cannot be released from state ${workspace.state}`);
  }
  if (workspace.mode === "isolated" && !["merged", "abandoned"].includes(options.mergeStatus ?? workspace.merge_status)) {
    if (workspace.state !== "pending_integration") {
      db.prepare("UPDATE workspaces SET merge_status='pending' WHERE id=?").run(id);
      return transitionWorkspace(db, id, "pending_integration");
    }
    throw new Error(`isolated workspace #${id} requires an explicit merge decision`);
  }
  if (workspace.mode === "isolated" && options.mergeStatus) {
    if (options.mergeStatus === "merged" && workspace.merge_status !== "merged") {
      throw new Error(`isolated workspace #${id} is not merged; use integrateWorkspace first`);
    }
    db.prepare("UPDATE workspaces SET merge_status=? WHERE id=?").run(options.mergeStatus, id);
  }
  const current = getWorkspace(db, id)!;
  const contentHash = hashesContent(current) ? workspaceContentHash(current) : CONTENT_NOT_HASHED;
  const artifactId = persistWorkspaceSnapshot(db, workspace, contentHash, options.dataDir ?? databaseDataDir(db));
  db.prepare(`INSERT INTO workspace_cleanup_snapshots (workspace_id, content_hash, artifact_id) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET content_hash=excluded.content_hash, artifact_id=excluded.artifact_id, captured_at=datetime('now')`)
    .run(id, contentHash, artifactId);
  return transitionWorkspace(db, id, "released");
}

export function workspaceCleanupChecks(db: Db, id: number, now = new Date()): WorkspaceCleanupChecks {
  const workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  const owner = getItem(db, workspace.owner_item_id);
  const snapshot = db.prepare("SELECT content_hash, artifact_id FROM workspace_cleanup_snapshots WHERE workspace_id=?")
    .get(id) as { content_hash: string; artifact_id: number | null } | undefined;
  let artifactAvailable = snapshot?.artifact_id === null || snapshot?.artifact_id === undefined;
  if (snapshot?.artifact_id) {
    try {
      const content = openArtifactContent(db, databaseDataDir(db) ?? "", workspace.owner_item_id, snapshot.artifact_id);
      content.stream.destroy();
      artifactAvailable = true;
    } catch {
      artifactAvailable = false;
    }
  }
  let matches = false;
  if (snapshot && !hashesContent(workspace)) {
    matches = true;
  } else if (snapshot && existsSync(workspace.path)) {
    try { matches = workspaceContentHash(workspace) === snapshot.content_hash; } catch { matches = false; }
  }
  return {
    ownerTerminal: Boolean(owner && ["done", "cancelled"].includes(owner.stage)),
    noActiveRuns: activeRunCount(db, id) === 0,
    snapshotPersisted: snapshot !== undefined && artifactAvailable,
    contentMatchesSnapshot: matches,
    commitsCovered: matches && artifactAvailable,
    retentionElapsed: workspace.released_at !== null && (!workspace.retained_until || new Date(workspace.retained_until).getTime() <= now.getTime()),
  };
}

export function cleanupWorkspace(db: Db, id: number): Workspace {
  let workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  if (activeRunCount(db, id) !== 0) throw new Error(`workspace #${id} still has active runs`);
  if (!["released", "failed"].includes(workspace.state)) {
    throw new Error(`workspace #${id} cannot be cleaned from state ${workspace.state}`);
  }
  workspace = transitionWorkspace(db, id, "cleaning");
  try {
    const checks = workspaceCleanupChecks(db, id);
    if (!checks.ownerTerminal || !checks.noActiveRuns || !checks.snapshotPersisted ||
        !checks.contentMatchesSnapshot || !checks.commitsCovered || !checks.retentionElapsed) {
      if (!checks.contentMatchesSnapshot) throw new Error("workspace has unrecorded changes; snapshot or merge before cleanup");
      throw new Error(`workspace cleanup preconditions failed: ${JSON.stringify(checks)}`);
    }
    if (workspace.git_worktree) {
      const dirty = git(["-C", workspace.path, "status", "--porcelain"]);
      if (dirty) throw new Error("workspace has unrecorded changes; snapshot or merge before cleanup");
      git(["worktree", "remove", workspace.path], workspace.repo_root ?? undefined);
    }
    workspace = transitionWorkspace(db, id, "cleaned");
    return transitionWorkspace(db, id, "archived");
  } catch (error) {
    const current = getWorkspace(db, id);
    if (current?.state === "cleaning") {
      workspace = transitionWorkspace(db, id, "failed");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workspace cleanup failed for #${id}: ${message}`);
  }
}

export function reconcileWorkspaces(db: Db): WorkspaceReconcileResult {
  const candidates = listWorkspaces(db).filter((workspace) =>
    ["provisioning", "active", "cleaning"].includes(workspace.state),
  );
  let recovered = 0;
  let failed = 0;
  for (const workspace of candidates) {
    const present = existsSync(workspace.path);
    if (workspace.state === "provisioning" && present) {
      transitionWorkspace(db, workspace.id, "active");
      recovered++;
    } else if (workspace.state === "cleaning" && !present) {
      transitionWorkspace(db, workspace.id, "cleaned");
      transitionWorkspace(db, workspace.id, "archived");
      recovered++;
    } else if ((workspace.state === "provisioning" || workspace.state === "active" || workspace.state === "cleaning") && !present) {
      transitionWorkspace(db, workspace.id, "failed");
      failed++;
    }
  }
  return { checked: candidates.length, recovered, failed };
}

export function integrateWorkspace(db: Db, id: number, targetBranch?: string): Workspace {
  const workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  if (workspace.mode !== "isolated" || !workspace.repo_root || !workspace.branch) {
    throw new Error(`workspace #${id} is not an isolated git workspace`);
  }
  const target = targetBranch ?? git(["branch", "--show-current"], workspace.repo_root);
  const currentBranch = git(["branch", "--show-current"], workspace.repo_root);
  if (!target || target !== currentBranch) {
    throw new Error(`workspace integration target ${target || "(detached)"} is not the current branch ${currentBranch || "(detached)"}`);
  }
  try {
    git(["merge", "--no-edit", workspace.branch], workspace.repo_root);
    db.prepare("UPDATE workspaces SET merge_status='merged' WHERE id=?").run(id);
    return releaseWorkspace(db, id, { mergeStatus: "merged", dataDir: databaseDataDir(db) ?? undefined });
  } catch (error) {
    try { git(["merge", "--abort"], workspace.repo_root); } catch { /* best effort */ }
    db.prepare("UPDATE workspaces SET merge_status='conflict' WHERE id=?").run(id);
    const current = getWorkspace(db, id)!;
    if (current.state === "pending_integration") transitionWorkspace(db, id, "blocked");
    throw new Error(`workspace integration conflict for #${id} into ${target}: ${String(error)}`);
  }
}


// ── PR 评审的临时检出 ─────────────────────────────────────────────────────────────

/** 删掉临时检出在磁盘和 git 里的东西：worktree、它的登记、临时引用。数据库的行不动。 */
export function removeCheckoutFiles(workspace: Workspace): void {
  const repoRoot = workspace.repo_root!;
  // 目录已经不在时，git worktree remove --force 也删掉 git 里登记的这一条。
  try { git(["worktree", "remove", "--force", workspace.path], repoRoot); } catch { /* 下面再看目录还在不在 */ }
  if (existsSync(workspace.path) && insideWorkspaceRoot(workspace)) rmSync(workspace.path, { recursive: true, force: true });
  if (existsSync(workspace.path)) throw new Error(`checkout ${workspace.path} could not be removed`);
  if (workspace.branch?.startsWith("refs/plc/")) {
    try { git(["update-ref", "-d", workspace.branch], repoRoot); } catch { /* 引用已经不在 */ }
  }
}

/** 删掉一个临时检出：worktree、它在 git 里的登记和临时引用。数据库里的行走到 archived，不删。 */
export function disposeCheckout(db: Db, id: number, reason: string): Workspace {
  let workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  if (!isDisposableCheckout(workspace)) throw new Error(`workspace #${id} is not a disposable checkout`);
  if (workspace.state === "cleaned" || workspace.state === "archived") return workspace;
  if (activeRunCount(db, id) !== 0) throw new Error(`workspace #${id} still has active runs`);
  removeCheckoutFiles(workspace);
  if (workspace.state === "requested" || workspace.state === "provisioning") workspace = transitionWorkspace(db, id, "failed");
  if (workspace.state === "review_hold") workspace = transitionWorkspace(db, id, "idle");
  if (workspace.state !== "released" && workspace.state !== "cleaning") workspace = transitionWorkspace(db, id, "released");
  if (workspace.state === "released") workspace = transitionWorkspace(db, id, "cleaning");
  transitionWorkspace(db, id, "cleaned");
  workspace = transitionWorkspace(db, id, "archived");
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: "system", kind: "decision",
    payload: { decision: "workspace_checkout_removed", workspaceId: id, path: workspace.path, ref: workspace.branch, reason },
  });
  return workspace;
}

// ── 隔离 worktree 的收尾 ──────────────────────────────────────────────────────────
// 合并或放弃以后马上删 worktree。有没合并改动的 worktree 不悄悄删，先问用户。
// 「没合并的改动」：worktree 里有没提交的文件，或者分支上有用户仓库当前 HEAD 没有的 commit。
// 判断出错时按「有改动」处理：出错永远不会导致删除。

export interface WorktreeChanges {
  head: string | null;
  // git status --porcelain 的前 20 行。被忽略的文件（例如 node_modules）不算。
  dirtyFiles: string[];
  // 分支上有、用户仓库当前 HEAD 没有的 commit 数。
  unmergedCommits: number;
}

export function worktreeChanges(workspace: Workspace): WorktreeChanges {
  if (!workspace.git_worktree || !workspace.repo_root) throw new Error(`workspace #${workspace.id} is not a plc git worktree`);
  const present = existsSync(workspace.path);
  const head = present
    ? git(["rev-parse", "HEAD"], workspace.path)
    : workspace.branch && !workspace.branch.startsWith("refs/")
      ? git(["rev-parse", "--verify", `refs/heads/${workspace.branch}^{commit}`], workspace.repo_root)
      : null;
  const dirtyFiles = present
    ? git(["status", "--porcelain", "--untracked-files=normal"], workspace.path).split("\n").filter(Boolean).slice(0, 20)
    : [];
  const unmergedCommits = head ? Number(git(["rev-list", "--count", `HEAD..${head}`], workspace.repo_root)) : 0;
  return { head, dirtyFiles, unmergedCommits };
}

function hasUnmergedChanges(changes: WorktreeChanges): boolean {
  return changes.dirtyFiles.length > 0 || changes.unmergedCommits > 0;
}

function assertOwnedWorktree(db: Db, id: number): Workspace {
  const workspace = getWorkspace(db, id);
  if (!workspace) throw new Error(`workspace ${id} not found`);
  if (workspace.mode !== "isolated" || workspace.kind !== "isolated_child" || !workspace.git_worktree) {
    throw new Error(`workspace #${id} is not an isolated plc worktree`);
  }
  const owner = getItem(db, workspace.owner_item_id);
  if (!owner || !["done", "cancelled"].includes(owner.stage)) {
    throw new Error(`workspace #${id} owner item #${workspace.owner_item_id} must be done or cancelled first`);
  }
  if (activeRunCount(db, id) !== 0) throw new Error(`workspace #${id} still has active runs`);
  return workspace;
}

// 工单的 workdir 以前被写成 worktree 的路径（markWorkspacePath）。worktree 删了以后改回用户的 checkout。
function restoreItemWorkdir(db: Db, workspace: Workspace): void {
  const source = workspace.reused_from_workspace_id ? getWorkspace(db, workspace.reused_from_workspace_id) : undefined;
  if (!source) return;
  db.prepare("UPDATE items SET workdir=?, updated_at=datetime('now') WHERE id=? AND workdir=?")
    .run(source.path, workspace.owner_item_id, workspace.path);
}

// plc 自己建的分支（plc/…）已经全部合并进用户仓库的当前分支时删掉。git branch -d 自己会拒绝删没合并的分支。
function deleteMergedBranch(workspace: Workspace): boolean {
  if (!workspace.repo_root || !workspace.branch?.startsWith("plc/")) return false;
  try {
    git(["branch", "-d", workspace.branch], workspace.repo_root);
    return true;
  } catch {
    return false;
  }
}

function removeReleasedWorktree(db: Db, id: number): { workspace: Workspace; branchDeleted: boolean } {
  const archived = cleanupWorkspace(db, id);
  const branchDeleted = deleteMergedBranch(archived);
  restoreItemWorkdir(db, archived);
  return { workspace: archived, branchDeleted };
}

// 目录已经不在的 worktree：没有文件可以快照或删除。收拾 git 的登记和已合并的分支，行走到 archived。
function archiveMissingWorktree(
  db: Db, workspace: Workspace, mergeStatus: "merged" | "abandoned", now = new Date(),
): { workspace: Workspace; branchDeleted: boolean } {
  try { git(["worktree", "remove", "--force", workspace.path], workspace.repo_root!); } catch { /* 没有登记 */ }
  const branchDeleted = deleteMergedBranch(workspace);
  db.prepare("UPDATE workspaces SET merge_status=? WHERE id=?").run(mergeStatus, workspace.id);
  let current = getWorkspace(db, workspace.id)!;
  if (current.state === "review_hold") current = transitionWorkspace(db, current.id, "idle", now);
  if (current.state !== "failed" && current.state !== "released") current = transitionWorkspace(db, current.id, "released", now);
  current = transitionWorkspace(db, current.id, "cleaning", now);
  transitionWorkspace(db, current.id, "cleaned", now);
  const archived = transitionWorkspace(db, current.id, "archived", now);
  restoreItemWorkdir(db, archived);
  return { workspace: archived, branchDeleted };
}

export interface WorktreeDecisionResult {
  workspace: Workspace;
  branch: string | null;
  branchDeleted: boolean;
  changes: WorktreeChanges;
}

/**
 * 把隔离 worktree 的分支合并进用户仓库的当前分支，然后删掉 worktree 和已合并的分支。
 * worktree 里有没提交的文件、或者用户的 checkout 有没提交的改动时拒绝：合并不能把它们混在一起。
 */
// onBehalfOf：Lead 在你这一轮里代你做（工单操作层的 merge、abandon）。记进那一行，和 transition 的写法一样。
type WorktreeDecisionBehalf = { onBehalfOf?: { actor: "user"; sourceTurnId: string } };

function behalfPayload(input: WorktreeDecisionBehalf): Record<string, unknown> {
  return input.onBehalfOf ? { onBehalfOf: input.onBehalfOf.actor, sourceTurnId: input.onBehalfOf.sourceTurnId } : {};
}

export function integrateIsolatedWorkspace(
  db: Db, id: number, input: { actor: Extract<Actor, "lead" | "user">; reason: string } & WorktreeDecisionBehalf,
): WorktreeDecisionResult {
  const workspace = assertOwnedWorktree(db, id);
  const changes = worktreeChanges(workspace);
  if (changes.dirtyFiles.length) {
    throw new Error(`worktree #${id} has uncommitted changes (${changes.dirtyFiles.join(", ")}); `
      + "ask the ticket agent to commit them, or abandon the worktree");
  }
  const userChanges = git(["status", "--porcelain", "--untracked-files=no"], workspace.repo_root!);
  if (userChanges) {
    throw new Error(`the checkout ${workspace.repo_root} has uncommitted changes; merging now would mix them with the user's work. `
      + "Ask the user to commit or stash them first");
  }
  const target = git(["branch", "--show-current"], workspace.repo_root!);
  let outcome: { workspace: Workspace; branchDeleted: boolean };
  if (existsSync(workspace.path)) {
    integrateWorkspace(db, id);
    outcome = removeReleasedWorktree(db, id);
  } else {
    // 目录不在了，分支还在：直接在用户的仓库里合并分支。
    try {
      git(["merge", "--no-edit", workspace.branch!], workspace.repo_root!);
    } catch (error) {
      try { git(["merge", "--abort"], workspace.repo_root!); } catch { /* best effort */ }
      db.prepare("UPDATE workspaces SET merge_status='conflict' WHERE id=?").run(id);
      throw new Error(`workspace integration conflict for #${id} into ${target}: ${String(error)}`);
    }
    outcome = archiveMissingWorktree(db, workspace, "merged");
  }
  const { workspace: archived, branchDeleted } = outcome;
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: input.actor, kind: "decision",
    payload: {
      decision: "workspace_integrated", workspaceId: id, branch: workspace.branch, target, head: changes.head,
      unmergedCommits: changes.unmergedCommits, branchDeleted, reason: input.reason, ...behalfPayload(input),
    },
  });
  return { workspace: archived, branch: workspace.branch, branchDeleted, changes };
}

/**
 * 放弃隔离 worktree，删掉它。有没合并的改动时必须带上用户的同意（userConfirmation，写用户的原话）：
 * 没提交的文件先提交到 worktree 的分支上，分支保留，改动在用户仓库里还能找回。
 */
export function abandonIsolatedWorkspace(
  db: Db, id: number,
  input: { actor: Extract<Actor, "lead" | "user" | "system">; reason: string; userConfirmation?: string } & WorktreeDecisionBehalf,
): WorktreeDecisionResult {
  const workspace = assertOwnedWorktree(db, id);
  const changes = worktreeChanges(workspace);
  const confirmation = input.userConfirmation?.trim() ?? "";
  if (hasUnmergedChanges(changes) && !confirmation) {
    throw new Error(`worktree #${id} has unmerged changes (${changes.unmergedCommits} commit(s), `
      + `${changes.dirtyFiles.length} uncommitted file(s)). It is not deleted without the user's consent: `
      + "ask the user, then pass user_confirmation with the user's words");
  }
  if (changes.dirtyFiles.length && existsSync(workspace.path)) {
    git(["add", "-A"], workspace.path);
    git(["-c", "user.name=plc", "-c", "user.email=plc@localhost", "commit", "-q", "--no-verify",
      "-m", `plc: uncommitted changes when workspace #${id} was abandoned`], workspace.path);
  }
  const { workspace: archived, branchDeleted } = existsSync(workspace.path)
    ? (releaseWorkspace(db, id, { mergeStatus: "abandoned" }), removeReleasedWorktree(db, id))
    : archiveMissingWorktree(db, workspace, "abandoned");
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: input.actor, kind: "decision",
    payload: {
      decision: "workspace_abandoned", workspaceId: id, branch: workspace.branch, branchKept: !branchDeleted,
      unmergedCommits: changes.unmergedCommits, dirtyFiles: changes.dirtyFiles, reason: input.reason,
      ...(confirmation ? { userConfirmation: confirmation } : {}), ...behalfPayload(input),
    },
  });
  return { workspace: archived, branch: workspace.branch, branchDeleted, changes };
}

// ── 定期清理扫描 ─────────────────────────────────────────────────────────────────

export interface WorkspaceSweepResult {
  checked: number;
  // 共享工作区按 TTL 释放的个数（不删文件，那是用户自己的目录）。
  released: number;
  // 从磁盘上删掉的 worktree 和临时检出（含孤儿目录）。
  cleaned: number;
  // 有没合并的改动、在等合并决定的 worktree 和孤儿目录。
  awaitingDecision: number;
  /** Workspaces the sweep could not release. They keep their state; the next sweep tries again. */
  failed: Array<{ workspaceId: number; error: string }>;
}

export interface WorkspaceSweepOptions {
  // 隔离 worktree 闲置多久后清理（没改动的），以及等合并决定时多久再问一次。设计 D3：7 天。
  isolatedTtlMs?: number;
  // 共享工作区在工单结束后多久释放。设计 D3：14 天。
  sharedTtlMs?: number;
  // <repo>.plc-workspaces 下没有登记的目录多久没动以后处理。
  orphanTtlMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;
export const MERGE_DECISION_REQUESTED = "workspace_merge_requested";

// 清理要让 Lead 看得见：写一条 inbox。只是告知的进摘要（当前局面里「上一轮以后的变化」）；
// 要用户决定的叫醒 Lead，并且单独一行，不和别的合并。
function tellLead(
  db: Db, input: { itemId?: number; scope?: string; summary: string; payload: Record<string, unknown>; needsUser: boolean },
): void {
  addInbox(db, {
    ...(input.itemId !== undefined ? { itemId: input.itemId } : { dedupScope: input.scope ?? "workspace-sweep" }),
    severity: "attention", source: "structural", summary: input.summary,
    payload: { ...input.payload, wakeLead: input.needsUser, needsUser: input.needsUser },
    ...(input.needsUser ? { lossless: true } : {}),
  });
}

function lastMergeRequestAt(db: Db, workspace: Workspace): number | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.askedAt') AS asked_at FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
       AND json_extract(payload, '$.workspaceId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(workspace.owner_item_id, MERGE_DECISION_REQUESTED, workspace.id) as { asked_at: string | null } | undefined;
  return row?.asked_at ? Date.parse(row.asked_at) : null;
}

function askForMergeDecision(db: Db, workspace: Workspace, changes: WorktreeChanges, now: Date, ttlMs: number): void {
  const last = lastMergeRequestAt(db, workspace);
  if (last !== null && now.getTime() - last < ttlMs) return;
  const parts = [
    changes.unmergedCommits ? `${changes.unmergedCommits} 个没合并的 commit` : "",
    changes.dirtyFiles.length ? `${changes.dirtyFiles.length} 个没提交的文件` : "",
  ].filter(Boolean).join("、");
  const conflict = workspace.state === "blocked" || workspace.merge_status === "conflict";
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: "system", kind: "decision",
    payload: {
      decision: MERGE_DECISION_REQUESTED, workspaceId: workspace.id, branch: workspace.branch,
      unmergedCommits: changes.unmergedCommits, dirtyFiles: changes.dirtyFiles, askedAt: now.toISOString(),
    },
  });
  tellLead(db, {
    itemId: workspace.owner_item_id,
    summary: conflict
      ? `工单 #${workspace.owner_item_id} 的隔离 worktree #${workspace.id}（分支 ${workspace.branch}）合并时冲突，还有${parts}没进用户的仓库，等用户处理`
      : `工单 #${workspace.owner_item_id} 已结束，它的隔离 worktree #${workspace.id}（分支 ${workspace.branch}）有${parts}，等合并决定`,
    payload: {
      inboxKind: "workspace_merge_decision", workspaceId: workspace.id, branch: workspace.branch, path: workspace.path,
      unmergedCommits: changes.unmergedCommits, dirtyFiles: changes.dirtyFiles, conflict,
      nextStep: conflict
        ? `告诉用户分支 ${workspace.branch} 和他的 checkout 冲突：用户自己合并并解决冲突后，系统会清理这个 worktree；或者用户在对话里要求放弃时，在那一轮调 ticket_action 的 abandon（不可逆，只认用户这一轮）。`
        : "问用户：合并（integrate_workspace）还是放弃。用户在对话里要求放弃时，在那一轮调 ticket_action 的 abandon（不可逆，只认用户这一轮）。没有用户同意不删。",
    },
    needsUser: true,
  });
}

function idleFor(workspace: Workspace, now: Date): number {
  const last = workspace.last_used_at ?? workspace.created_at;
  const at = Date.parse(last.includes("T") ? last : `${last.replace(" ", "T")}Z`);
  return now.getTime() - at;
}

function sweepIsolatedWorktree(
  db: Db, workspace: Workspace, now: Date, ttlMs: number,
): "cleaned" | "awaiting" | null {
  const owner = getItem(db, workspace.owner_item_id);
  if (!owner || !["done", "cancelled"].includes(owner.stage) || activeRunCount(db, workspace.id) !== 0) return null;
  if (workspace.state === "released") {
    removeReleasedWorktree(db, workspace.id);
    return "cleaned";
  }
  if (!["active", "idle", "pending_integration", "blocked", "failed"].includes(workspace.state)) return null;
  const changes = worktreeChanges(workspace);
  // 目录已经不在了（有人手动删了它，或者 daemon 重启时把它标成了 failed）：没有没合并的 commit 时，只收拾 git 的登记和分支。
  if (!existsSync(workspace.path)) {
    if (hasUnmergedChanges(changes)) {
      askForMergeDecision(db, workspace, changes, now, ttlMs);
      return "awaiting";
    }
    const merged = changes.head !== null && changes.head !== workspace.base_ref;
    const { branchDeleted } = archiveMissingWorktree(db, workspace, merged ? "merged" : "abandoned", now);
    addActivity(db, {
      itemId: workspace.owner_item_id, actor: "system", kind: "decision",
      payload: { decision: "workspace_cleaned", workspaceId: workspace.id, branch: workspace.branch, directoryMissing: true, branchDeleted },
    });
    return "cleaned";
  }
  if (workspace.state === "failed") return null;
  if (hasUnmergedChanges(changes)) {
    // 合并冲突（blocked）的留在 blocked，照样按 TTL 再问（审查 2026-10-19 第 2 条：以前扫描不看 blocked，再也没有提醒）。
    if (workspace.state !== "pending_integration" && workspace.state !== "blocked") {
      db.prepare("UPDATE workspaces SET merge_status='pending' WHERE id=?").run(workspace.id);
      transitionWorkspace(db, workspace.id, "pending_integration", now);
    }
    askForMergeDecision(db, workspace, changes, now, ttlMs);
    return "awaiting";
  }
  // 没有要合并的东西：等合并决定的、合并冲突的（用户自己合并了）马上清理，其余闲置满 TTL 再清理，期间工单对话还能用它。
  if (!["pending_integration", "blocked"].includes(workspace.state) && idleFor(workspace, now) < ttlMs) return null;
  const merged = changes.head !== null && changes.head !== workspace.base_ref;
  if (merged) db.prepare("UPDATE workspaces SET merge_status='merged' WHERE id=?").run(workspace.id);
  releaseWorkspace(db, workspace.id, { mergeStatus: merged ? "merged" : "abandoned" });
  const { branchDeleted } = removeReleasedWorktree(db, workspace.id);
  addActivity(db, {
    itemId: workspace.owner_item_id, actor: "system", kind: "decision",
    payload: { decision: "workspace_cleaned", workspaceId: workspace.id, branch: workspace.branch, merged, branchDeleted },
  });
  tellLead(db, {
    itemId: workspace.owner_item_id,
    summary: `工单 #${workspace.owner_item_id} 的隔离 worktree #${workspace.id} 已清理（${merged ? "改动已经在用户仓库里" : "没有改动"}）`,
    payload: { inboxKind: "workspace_cleaned", workspaceId: workspace.id, branch: workspace.branch, merged, branchDeleted },
    needsUser: false,
  });
  return "cleaned";
}

interface ListedWorktree { path: string; head: string | null; branch: string | null }

function listWorktrees(repoRoot: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of git(["worktree", "list", "--porcelain"], repoRoot).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null };
      listed.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return listed;
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// <repo>.plc-workspaces 下、数据库里没有登记（或者登记已经结束）的目录。闲置满 TTL 以后：
// 干净、没有没合并 commit 的 worktree 删掉；空目录删掉；其余的问用户一次，不删。
function sweepOrphans(
  db: Db, now: Date, ttlMs: number, failed: WorkspaceSweepResult["failed"],
): { cleaned: number; awaiting: number } {
  const roots = new Set<string>();
  for (const row of db.prepare(
    `SELECT repo_root FROM workspaces WHERE git_worktree=1 AND repo_root IS NOT NULL
     UNION SELECT repo_root FROM project_repositories WHERE repo_root IS NOT NULL`,
  ).all() as Array<{ repo_root: string }>) roots.add(realpathOr(row.repo_root));
  const live = db.prepare(
    "SELECT path, branch FROM workspaces WHERE state NOT IN ('cleaned','archived')",
  ).all() as Array<{ path: string; branch: string | null }>;
  const registered = new Set(live.map((row) => realpathOr(row.path)));
  const liveRefs = new Set(live.map((row) => row.branch).filter((branch): branch is string => Boolean(branch)));
  let cleaned = 0;
  let awaiting = 0;
  for (const repoRoot of roots) {
    if (!existsSync(repoRoot)) continue;
    // PR 检出的临时引用：fetch 以后 daemon 停了，引用就没人管了。行在 fetch 之前就建好，所以没有活着的行的引用都是孤儿。
    try {
      const orphanRefs = git(["for-each-ref", "--format=%(refname)", "refs/plc/review/"], repoRoot)
        .split("\n").filter((ref) => ref && !liveRefs.has(ref));
      for (const ref of orphanRefs) git(["update-ref", "-d", ref], repoRoot);
      if (orphanRefs.length) {
        tellLead(db, {
          summary: `清理扫描删掉了 ${repoRoot} 里 ${orphanRefs.length} 个没有登记的 PR 临时引用`,
          payload: { inboxKind: "workspace_orphan_refs_removed", repoRoot, refs: orphanRefs.slice(0, 20) }, needsUser: false,
        });
      }
    } catch (error) {
      failed.push({ workspaceId: 0, error: `${repoRoot}: ${error instanceof Error ? error.message : String(error)}` });
    }
    const container = workspaceRootFor(repoRoot);
    if (!existsSync(container)) continue;
    const containerPath = realpathOr(container);
    let worktrees: Map<string, ListedWorktree>;
    try {
      worktrees = new Map(listWorktrees(repoRoot).map((entry) => [realpathOr(entry.path), entry]));
    } catch {
      continue;
    }
    for (const name of readdirSync(container)) {
      // 不跟随符号链接：链接指向的可能是容器外面用户自己的 worktree（审查 2026-10-19 第 8 条）。plc 只在这里建真目录。
      const path = join(containerPath, name);
      if (registered.has(path)) continue;
      try {
        const entry = lstatSync(path);
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        if (now.getTime() - entry.mtimeMs < ttlMs) continue;
        const worktree = worktrees.get(path);
        let removable = false;
        let detail: Record<string, unknown> = {};
        if (worktree) {
          const dirtyFiles = git(["status", "--porcelain", "--untracked-files=normal"], path).split("\n").filter(Boolean).slice(0, 20);
          const unmergedCommits = worktree.head ? Number(git(["rev-list", "--count", `HEAD..${worktree.head}`], repoRoot)) : 0;
          removable = dirtyFiles.length === 0 && unmergedCommits === 0;
          detail = { branch: worktree.branch, dirtyFiles, unmergedCommits };
          if (removable) {
            git(["worktree", "remove", path], repoRoot);
            const branch = worktree.branch?.replace(/^refs\/heads\//, "");
            if (branch?.startsWith("plc/")) { try { git(["branch", "-d", branch], repoRoot); } catch { /* 保留 */ } }
          }
        } else if (readdirSync(path).length === 0) {
          removable = true;
          rmdirSync(path);
        }
        const scope = `workspace-orphan:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
        if (removable) {
          cleaned += 1;
          tellLead(db, {
            summary: `清理扫描删掉了没有登记的 worktree 目录 ${path}（没有改动）`,
            payload: { inboxKind: "workspace_orphan_removed", path, ...detail }, needsUser: false,
          });
          continue;
        }
        awaiting += 1;
        const asked = db.prepare(
          "SELECT 1 FROM inbox WHERE dedup_scope=? AND created_at > datetime('now', ?) LIMIT 1",
        ).get(scope, `-${Math.floor(ttlMs / 1000)} seconds`);
        if (asked) continue;
        tellLead(db, {
          scope,
          summary: `${path} 不属于任何工单，${worktree ? "里面有没合并的改动" : "不是 git worktree，里面还有文件"}；没有删，等用户决定`,
          payload: {
            inboxKind: "workspace_orphan_decision", path, repoRoot, ...detail,
            nextStep: "告诉用户这个目录在哪、里面有什么；要不要删由用户决定，用户自己删。",
          },
          needsUser: true,
        });
      } catch (error) {
        failed.push({ workspaceId: 0, error: `${path}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  return { cleaned, awaiting };
}

/**
 * 清理扫描。daemon 在 notice 轮询里按间隔调用。一个工作区出错不影响别的：出错的记进 failed，下次再试。
 *   · PR 评审的临时检出：没有在跑的 Run 就删。
 *   · 结束了的工单的隔离 worktree：有没合并的改动时进 pending_integration，问用户（满 TTL 再问一次），不删；
 *     没有改动的闲置满 TTL 后删掉；用户自己合并了的马上删。
 *   · 共享工作区：工单结束满 TTL 后释放。不删文件。
 *   · <repo>.plc-workspaces 下没有登记的孤儿目录（sweepOrphans）。
 */
export function sweepWorkspaces(db: Db, now = new Date(), options: WorkspaceSweepOptions = {}): WorkspaceSweepResult {
  const isolatedTtlMs = options.isolatedTtlMs ?? 7 * DAY_MS;
  const sharedTtlMs = options.sharedTtlMs ?? 14 * DAY_MS;
  const orphanTtlMs = options.orphanTtlMs ?? 7 * DAY_MS;
  const result: WorkspaceSweepResult = { checked: 0, released: 0, cleaned: 0, awaitingDecision: 0, failed: [] };
  const workspaces = listWorkspaces(db);
  result.checked = workspaces.length;
  for (const workspace of workspaces) {
    if (workspace.state === "cleaned" || workspace.state === "archived") continue;
    try {
      if (isDisposableCheckout(workspace)) {
        // 还在准备中的检出属于一个刚开始的 Run（runItem 建行时就绑定了它）。daemon 重启时 reconcileWorkspaces 会把
        // 停在 provisioning 的行改成 active 或 failed，所以这里跳过它们不会留下永远不清理的行。
        if (activeRunCount(db, workspace.id) !== 0 || ["requested", "provisioning"].includes(workspace.state)) continue;
        disposeCheckout(db, workspace.id, "its runs have ended");
        result.cleaned += 1;
        tellLead(db, {
          itemId: workspace.owner_item_id,
          summary: `工单 #${workspace.owner_item_id} 的 PR 临时检出 #${workspace.id} 已删除（Run 已结束）`,
          payload: { inboxKind: "workspace_checkout_removed", workspaceId: workspace.id, path: workspace.path },
          needsUser: false,
        });
        continue;
      }
      if (workspace.git_worktree && workspace.kind === "isolated_child") {
        const outcome = sweepIsolatedWorktree(db, workspace, now, isolatedTtlMs);
        if (outcome === "cleaned") result.cleaned += 1;
        if (outcome === "awaiting") result.awaitingDecision += 1;
        continue;
      }
      if (workspace.mode !== "shared" || !["active", "idle"].includes(workspace.state)) continue;
      const owner = getItem(db, workspace.owner_item_id);
      if (!owner || !["done", "cancelled"].includes(owner.stage) || activeRunCount(db, workspace.id) !== 0) continue;
      if (idleFor(workspace, now) < sharedTtlMs) continue;
      releaseWorkspace(db, workspace.id);
      result.released += 1;
    } catch (error) {
      result.failed.push({ workspaceId: workspace.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const orphans = sweepOrphans(db, now, orphanTtlMs, result.failed);
  result.cleaned += orphans.cleaned;
  result.awaitingDecision += orphans.awaiting;
  return result;
}

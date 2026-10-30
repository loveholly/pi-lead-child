import { isAbsolute, resolve } from "node:path";
import type { Db } from "./db.js";
import { updateRun } from "./runs.js";
import type {
  Workspace, WorkspaceKind, WorkspaceMergeStatus, WorkspaceMode, WorkspaceState,
} from "@pi-lead-child/core";

const TERMINAL_WORKSPACE_STATES: readonly WorkspaceState[] = ["cleaned", "archived"];
const ATTACHABLE_WORKSPACE_STATES: readonly WorkspaceState[] = [
  "requested", "provisioning", "active", "idle", "review_hold",
];
// 不能在上面启动 Run 的状态。runItem 和 createRun 在这些状态上抛错，preflight（工单 05）在 claim 之前拦下。
export const UNLAUNCHABLE_WORKSPACE_STATES: readonly WorkspaceState[] = [
  "released", "cleaning", "cleaned", "archived", "failed", "blocked",
];

const WORKSPACE_TRANSITIONS: Record<WorkspaceState, readonly WorkspaceState[]> = {
  requested: ["provisioning", "failed", "blocked"],
  provisioning: ["active", "failed", "blocked"],
  active: ["idle", "review_hold", "pending_integration", "released", "failed", "blocked"],
  idle: ["active", "review_hold", "pending_integration", "released", "failed", "blocked"],
  review_hold: ["idle", "active", "failed", "blocked"],
  // 回到 idle：工单结束了、在等合并决定的 worktree 又来了一个 Run（例如工单对话，engine 的 workspace-policy.ts）。
  pending_integration: ["idle", "released", "blocked"],
  released: ["cleaning", "failed"],
  cleaning: ["cleaned", "failed"],
  cleaned: ["archived"],
  archived: [],
  failed: ["requested", "provisioning", "released", "cleaning", "blocked"],
  blocked: ["requested", "provisioning", "released", "cleaning"],
};

export interface CreateWorkspaceInput {
  ownerItemId: number;
  mode: WorkspaceMode;
  kind: WorkspaceKind;
  projectId?: number | null;
  repoRoot?: string | null;
  path: string;
  branch?: string | null;
  baseRef?: string | null;
  gitWorktree?: boolean;
  sourceItemId?: number | null;
  sourceRunId?: number | null;
  reusedFromWorkspaceId?: number | null;
  state?: WorkspaceState;
  mergeStatus?: WorkspaceMergeStatus;
}

export interface WorkspaceView {
  workspace: Workspace;
  resolvedFromItemId: number;
  ownerItemId: number;
  inherited: boolean;
}

function assertPositiveId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function normalizePath(value: string): string {
  const path = value.trim();
  if (!path) throw new Error("workspace path must not be blank");
  if (!isAbsolute(path)) throw new Error("workspace path must be absolute");
  return resolve(path);
}

function isTerminal(state: WorkspaceState): boolean {
  return TERMINAL_WORKSPACE_STATES.includes(state);
}

function getWorkspaceByOwner(db: Db, ownerItemId: number): Workspace | undefined {
  return db.prepare(
    `SELECT * FROM workspaces
     WHERE owner_item_id = ? AND kind <> 'reviewer' AND state NOT IN ('cleaned','archived')
     ORDER BY CASE kind WHEN 'isolated_child' THEN 0 WHEN 'reviewer' THEN 1 ELSE 2 END, id DESC
     LIMIT 1`,
  ).get(ownerItemId) as Workspace | undefined;
}

export function getWorkspace(db: Db, id: number): Workspace | undefined {
  assertPositiveId(id, "workspace id");
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Workspace | undefined;
}

export function listWorkspaces(
  db: Db,
  filter: { ownerItemId?: number; projectId?: number; state?: WorkspaceState } = {},
): Workspace[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.ownerItemId !== undefined) {
    assertPositiveId(filter.ownerItemId, "owner item id");
    where.push("owner_item_id = ?"); values.push(filter.ownerItemId);
  }
  if (filter.projectId !== undefined) {
    assertPositiveId(filter.projectId, "project id");
    where.push("project_id = ?"); values.push(filter.projectId);
  }
  if (filter.state !== undefined) { where.push("state = ?"); values.push(filter.state); }
  const sql = `SELECT * FROM workspaces${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return db.prepare(sql).all(...values) as Workspace[];
}

export function getOwnerWorkspace(db: Db, ownerItemId: number): Workspace | undefined {
  assertPositiveId(ownerItemId, "owner item id");
  return getWorkspaceByOwner(db, ownerItemId);
}

export function createWorkspace(db: Db, input: CreateWorkspaceInput): Workspace {
  assertPositiveId(input.ownerItemId, "owner item id");
  const path = normalizePath(input.path);
  if (input.projectId !== undefined && input.projectId !== null) assertPositiveId(input.projectId, "project id");
  if (input.sourceItemId !== undefined && input.sourceItemId !== null) assertPositiveId(input.sourceItemId, "source item id");
  if (input.sourceRunId !== undefined && input.sourceRunId !== null) assertPositiveId(input.sourceRunId, "source run id");
  if (input.reusedFromWorkspaceId !== undefined && input.reusedFromWorkspaceId !== null) {
    assertPositiveId(input.reusedFromWorkspaceId, "reused workspace id");
  }
  if (input.gitWorktree && !input.repoRoot) throw new Error("git worktree requires repoRoot");
  if (input.mode === "shared" && input.mergeStatus !== undefined && input.mergeStatus !== "n/a") {
    throw new Error("shared workspace must use mergeStatus n/a");
  }
  const state = input.state ?? "requested";
  const mergeStatus = input.mergeStatus ?? "n/a";
  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM workspaces
       WHERE owner_item_id = ? AND kind = ? AND state NOT IN ('cleaned','archived')
       ORDER BY id LIMIT 1`,
    ).get(input.ownerItemId, input.kind) as Workspace | undefined;
    if (existing) {
      const same = existing.mode === input.mode
        && existing.path === path
        && existing.project_id === (input.projectId ?? null)
        && existing.repo_root === (input.repoRoot ?? null)
        && existing.branch === (input.branch ?? null)
        && existing.base_ref === (input.baseRef ?? null)
        && existing.git_worktree === (input.gitWorktree ? 1 : 0)
        && existing.source_item_id === (input.sourceItemId ?? input.ownerItemId)
        && existing.source_run_id === (input.sourceRunId ?? null)
        && existing.reused_from_workspace_id === (input.reusedFromWorkspaceId ?? null);
      if (!same) throw new Error(`workspace owner #${input.ownerItemId} already has an incompatible ${input.kind} workspace`);
      return existing;
    }
    const result = db.prepare(
      `INSERT INTO workspaces (
        owner_item_id, mode, kind, project_id, repo_root, path, branch, base_ref, git_worktree,
        source_item_id, source_run_id, reused_from_workspace_id, state, merge_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.ownerItemId, input.mode, input.kind, input.projectId ?? null, input.repoRoot ?? null, path,
      input.branch ?? null, input.baseRef ?? null, input.gitWorktree ? 1 : 0,
      input.sourceItemId ?? input.ownerItemId, input.sourceRunId ?? null, input.reusedFromWorkspaceId ?? null,
      state, mergeStatus,
    );
    return getWorkspace(db, Number(result.lastInsertRowid))!;
  }).immediate();
}

function runItemId(db: Db, runId: number): number {
  const row = db.prepare("SELECT item_id FROM runs WHERE id=?").get(runId) as { item_id: number } | undefined;
  if (!row) throw new Error(`run ${runId} not found`);
  return row.item_id;
}

export function attachWorkspaceToRun(
  db: Db,
  input: { runId: number; workspaceId: number },
): Workspace {
  assertPositiveId(input.runId, "run id");
  assertPositiveId(input.workspaceId, "workspace id");
  return db.transaction(() => {
    const run = db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(input.runId) as
      { workspace_id: number | null } | undefined;
    if (!run) throw new Error(`run ${input.runId} not found`);
    if (run.workspace_id !== null && run.workspace_id !== input.workspaceId) {
      throw new Error(`run #${input.runId} is already attached to workspace #${run.workspace_id}`);
    }
    const workspace = getWorkspace(db, input.workspaceId);
    if (!workspace) throw new Error(`workspace ${input.workspaceId} not found`);
    const resolved = resolveWorkspace(db, runItemId(db, input.runId));
    if (workspace.kind !== "reviewer" && (!resolved || resolved.workspace.id !== workspace.id)) {
      throw new Error(`workspace #${workspace.id} is not the resolved workspace for run #${input.runId}`);
    }
    if (!ATTACHABLE_WORKSPACE_STATES.includes(workspace.state)) {
      throw new Error(`workspace #${workspace.id} is not attachable in state ${workspace.state}`);
    }
    if (run.workspace_id === null) {
      updateRun(db, input.runId, { workspaceId: input.workspaceId });
    }
    db.prepare("UPDATE workspaces SET last_used_at = datetime('now') WHERE id = ?")
      .run(workspace.id);
    return getWorkspace(db, workspace.id)!;
  }).immediate();
}

export function transitionWorkspace(db: Db, id: number, to: WorkspaceState, now = new Date()): Workspace {
  assertPositiveId(id, "workspace id");
  return db.transaction(() => {
    const current = getWorkspace(db, id);
    if (!current) throw new Error(`workspace ${id} not found`);
    if (!WORKSPACE_TRANSITIONS[current.state].includes(to)) {
      throw new Error(`illegal workspace transition ${current.state} -> ${to} (#${id})`);
    }
    const at = now.toISOString();
    const releasedAt = to === "released"
      ? at
      : (["requested", "provisioning", "active", "idle", "review_hold"].includes(to)
        ? null : current.released_at);
    const cleanedAt = to === "cleaned" || to === "archived"
      ? at
      : (["requested", "provisioning", "active", "idle", "review_hold"].includes(to)
        ? null : current.cleaned_at);
    db.prepare(
      `UPDATE workspaces
       SET state = ?, released_at = ?, cleaned_at = ?, last_used_at = ?
       WHERE id = ?`,
    ).run(to, releasedAt, cleanedAt, at, id);
    return getWorkspace(db, id)!;
  }).immediate();
}

export function resolveWorkspace(db: Db, itemId: number): WorkspaceView | null {
  assertPositiveId(itemId, "item id");
  const seen = new Set<number>();
  let currentId: number | null = itemId;
  let first = true;
  while (currentId !== null) {
    if (seen.has(currentId)) throw new Error(`item parent cycle while resolving workspace at #${currentId}`);
    seen.add(currentId);
    const workspace = getWorkspaceByOwner(db, currentId);
    if (workspace) {
      return {
        workspace,
        resolvedFromItemId: itemId,
        ownerItemId: currentId,
        inherited: !first,
      };
    }
    const item = db.prepare("SELECT parent_item_id FROM items WHERE id = ?").get(currentId) as
      { parent_item_id: number | null } | undefined;
    if (!item) throw new Error(`item ${currentId} not found while resolving workspace`);
    currentId = item.parent_item_id;
    first = false;
  }
  return null;
}

export function isTerminalWorkspaceState(state: WorkspaceState): boolean {
  return isTerminal(state);
}

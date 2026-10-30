// 工作区的释放和清理。页面（POST /v1/workspaces/:id/release|cleanup）、Lead（release_workspace、cleanup_workspace、
// perform_action）都经过操作层的 workspace 目标（ui-actions/catalog.ts）走到 performWorkspaceAction；「现在能不能做」是
// workspaceActionBlocker，工单详情的按钮（controlForItem 的 availableActions）也读它（ui-action-parity plan.md P04）。
import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import type { Workspace } from "@pi-lead-child/core";
import { getWorkspace, listWorkspaces, resolveWorkspace } from "@pi-lead-child/store";
import { BY_USER, behalfCursor, behalfFields, type ActionAttribution } from "../ticket-actions/attribution.js";
import { cleanupWorkspace, releaseWorkspace } from "./workspace.js";

export type WorkspaceActionId = "release" | "cleanup";

// 工单详情读的工作区一栏。释放、清理本身只经过操作层（以前这里还有一个 execute，带着自己的一套规则，已经删掉）。
export interface WorkspaceActionService {
  controlForItem(itemId: number): WorkspaceControl | null;
}

export interface WorkspaceActionResult {
  action: WorkspaceActionId;
  itemId: number;
  status: "released" | "pending_integration" | "already_released" | "cleaned" | "already_cleaned";
  workspace: Workspace;
}

export interface WorkspaceControl {
  id: number;
  ownerTicketId: number;
  mode: Workspace["mode"];
  kind: Workspace["kind"];
  state: Workspace["state"];
  mergeStatus: Workspace["merge_status"];
  retainedUntil: string | null;
  inherited: boolean;
  availableActions: WorkspaceActionId[];
}

const RELEASABLE_STATES = ["active", "idle", "review_hold"];
const CLEANABLE_STATES = ["released", "failed"];
const STATE_WORDS: Record<string, string> = {
  provisioning: "准备中", active: "使用中", idle: "空闲", review_hold: "等验收", pending_integration: "等合并", blocked: "受阻",
  released: "已释放", cleaning: "清理中", cleaned: "已清理", archived: "已归档", failed: "清理失败",
};

function activeRunsOn(db: Db, workspaceId: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND state IN ('starting','running','paused')",
  ).get(workspaceId) as { n: number }).n;
}

/**
 * 现在能不能释放或清理这个工作区：能时返回 null，不能时返回用户能看懂的一句话。工单详情的按钮、操作层的「能不能做」
 * 都读它。已经释放、已经清理过的也算不能（再做一次什么都不改：操作层另外放行这种重复，见 workspaceActionDone）。
 */
export function workspaceActionBlocker(db: Db, workspace: Workspace, action: WorkspaceActionId): string | null {
  const owner = getItem(db, workspace.owner_item_id);
  if (!owner || !["done", "cancelled"].includes(owner.stage)) {
    return `工作区 #${workspace.id} 的工单还没结束（已完成或已取消以后才能${action === "release" ? "释放" : "清理"}）。`;
  }
  if (activeRunsOn(db, workspace.id) > 0) return `工作区 #${workspace.id} 上还有没结束的 Run。`;
  const state = STATE_WORDS[workspace.state] ?? workspace.state;
  if (action === "release") {
    // 隔离 worktree 有自己的收尾：合并（integrate）或放弃改动（工单操作 abandon），不在这里释放。
    if (workspace.mode === "isolated") return `工作区 #${workspace.id} 是隔离 worktree：用工单的「合并」或「放弃改动」收尾。`;
    return RELEASABLE_STATES.includes(workspace.state) ? null : `工作区 #${workspace.id} 现在是「${state}」，不能释放。`;
  }
  return CLEANABLE_STATES.includes(workspace.state) ? null : `工作区 #${workspace.id} 现在是「${state}」，要先释放才能清理。`;
}

/** 这个动作已经做过了（释放过、清理过）：再做一次什么都不改，回 already_released、already_cleaned。 */
export function workspaceActionDone(workspace: Workspace, action: WorkspaceActionId): boolean {
  return action === "release"
    ? workspace.mode !== "isolated" && ["released", "cleaning", "cleaned", "archived"].includes(workspace.state)
    : ["cleaned", "archived"].includes(workspace.state);
}

/**
 * 释放或清理一个工作区，按「谁做的」记一条活动（Lead 代你做时带 onBehalfOf 和那一轮）。谁能做由调用方（操作层）先查：
 * 这里只做状态的检查（releaseWorkspace、cleanupWorkspace 自己的）。
 */
export function performWorkspaceAction(
  db: Db,
  request: {
    action: WorkspaceActionId; workspaceId: number; by?: ActionAttribution; reason?: string;
    mergeStatus?: "merged" | "abandoned";
  },
): WorkspaceActionResult {
  const before = getWorkspace(db, request.workspaceId);
  if (!before) throw new Error(`workspace ${request.workspaceId} not found`);
  const by = request.by ?? BY_USER;
  const itemId = before.owner_item_id;
  const record = (decision: string, workspace: Workspace) => addActivity(db, {
    itemId, actor: by.actor, kind: "decision", ...behalfCursor(by),
    payload: { decision, workspaceId: workspace.id, status: workspace.state, reason: request.reason ?? null, ...behalfFields(by) },
  });
  if (request.action === "release") {
    const result = releaseWorkspace(db, before.id, { mergeStatus: request.mergeStatus });
    const status: WorkspaceActionResult["status"] = result.state === "pending_integration"
      ? "pending_integration"
      : ["released", "cleaned", "archived"].includes(before.state)
        ? "already_released"
        : "released";
    if (status !== "already_released") record("workspace_release", result);
    return { action: request.action, itemId, status, workspace: result };
  }
  if (["cleaned", "archived"].includes(before.state)) {
    return { action: request.action, itemId, status: "already_cleaned", workspace: before };
  }
  const result = cleanupWorkspace(db, before.id);
  record("workspace_cleanup", result);
  return { action: request.action, itemId, status: "cleaned", workspace: result };
}

/** 一张工单现在的工作区（Lead 的 release_workspace、cleanup_workspace 按工单编号找）：沿父链解析出的，没有时是它最近的一个。 */
export function workspaceOfItem(db: Db, itemId: number): Workspace {
  if (!getItem(db, itemId)) throw new Error(`item ${itemId} not found`);
  const resolved = resolveWorkspace(db, itemId);
  if (resolved) return resolved.workspace;
  const historical = listWorkspaces(db, { ownerItemId: itemId })
    .filter((workspace) => workspace.kind !== "reviewer")
    .sort((left, right) => right.id - left.id)[0];
  if (historical) return historical;
  throw new Error(`item #${itemId} has no workspace`);
}


export function createWorkspaceActionService(db: Db): WorkspaceActionService {
  return {
    controlForItem(itemId: number): WorkspaceControl | null {
      const item = getItem(db, itemId);
      if (!item) return null;
      const resolved = resolveWorkspace(db, itemId);
      if (!resolved) return null;
      const workspace = resolved.workspace;
      // 和操作层同一个判断（workspaceActionBlocker）。继承来的工作区属于父工单，在父工单上操作。
      const availableActions = resolved.inherited
        ? []
        : (["release", "cleanup"] as const).filter((action) => workspaceActionBlocker(db, workspace, action) === null);
      return {
        id: workspace.id, ownerTicketId: resolved.ownerItemId, mode: workspace.mode, kind: workspace.kind,
        state: workspace.state, mergeStatus: workspace.merge_status, retainedUntil: workspace.retained_until,
        inherited: resolved.inherited, availableActions,
      };
    },
  };
}

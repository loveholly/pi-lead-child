// 高风险的主人操作在网关这一层（工单 15 第一步）。清单和规则在 protocol 的 owner-actions.ts，写库在 store 的 owner-actions.ts。
//
// 这里做三件事：
//   - 每条路由在操作成功以后，用这里的构造函数说清做了什么、对象是谁、撤销要的操作前的状态，交给 paired-server 记下来；
//   - revertOwnerAction：用户点「不是我」时撤销这次操作。能撤销的撤销，不能撤销的说明原因；
//   - disownOwnerAction：撤销，再作废发出这次操作的凭证，最后记下结果。
//
// 「不是我」只作废发出那次操作的凭证（payload.credential.bindingId），不碰调用方指定的别的凭证：
// 冒用者拿网页会话点「不是我」，也作废不了手机或者别人的凭证。来自扫码配对的手机的操作只记录，不能点「不是我」。
// 撤回授权、拒绝审批这类更保守的结果不自动改回去：「不是我」只撤销放开了什么的那一类。
import {
  bindingOriginOf, canDisownOwnerAction, connectionSettingsLoosened, DEFAULT_CONNECTION_SETTINGS,
  describeConnectionSettings, describeConnectionSettingsChange, isOnBehalfOwnerActionSource, ITEM_ACTION_RISK, normalizeConnectionSettings,
  DEFAULT_LEAD_NAME, DESIGN_PREFERENCES_RESOURCE, LEAD_PROFILE_RESOURCE, REPLY_STYLE_RESOURCE, onBehalfUndoCredentialNote, ownerActionDefinition, ownerActionText,
  sameConnectionSettings, stricterConnectionSettings, withoutGrantRules,
  type ConnectionDto, type ConnectionSettings, type DesignPreferencesFields, type LeadProfileFields, type OwnerActionDto, type OwnerActionId, type OwnerActionRevertStatus,
  type UserItemActionId,
} from "@pi-lead-child/protocol";
import {
  activeDelegationPolicy, activeLeadGrant, applyRunGrantChange, clearApprovalSessionExemption, getApproval, getBinding, getItem,
  getCoreMemoryChange, getOwnerAction, getRunGrant, getRunGrantChange, grantChangeRevertedBy, leadDisplayName,
  getRun, getStandingOrder, isTerminalRunState, itemLabel, itemTarget, itemUpdatedEvent, ownerActionView,
  recordOwnerActionDisowned, revokeBinding, revokeDelegationPolicy, rollbackStandingOrderByUser, transition, withdrawApproval,
  type Approval, type Binding, type Db, type EventRecord, type LeadCapability, type LeadGrantChannel,
  type OwnerActionInput, type PublishGatewayEventInput,
} from "@pi-lead-child/store";
import type { DecisionRequest, Item, Run } from "@pi-lead-child/core";
import {
  CoreMemoryError, revertDesignPreferences, revertLeadProfile, revertReplyStyle, undoCoreMemoryChange, type NotesMemory,
} from "@pi-lead-child/engine";
import type { UserActionService } from "./user-actions.js";
import type { ConnectionsService } from "./connections-routes.js";
import type { ChannelSettingsService } from "./channel-settings-routes.js";

// 撤销要的状态（OwnerActionUndo）和工单、Run、审批、决定请求的构造函数在 store 的 owner-actions.ts：engine 的操作层
// （Lead 代你做）也要用同一份。这里转出去，网关的老调用方不用改。
export {
  approvalConsumerLive, approvalOwnerAction, decisionOwnerAction, delegationOwnerAction,
  itemLabel, itemOwnerAction, itemTarget, runOwnerAction, workspaceOwnerAction, type OwnerActionInput, type OwnerActionUndo,
} from "@pi-lead-child/store";

// ── 路由用的构造函数 ──────────────────────────────────────────────────────────────

// leadName 是 Lead 的名字（设置 → 身份与风格）。
export function leadTrustOwnerAction(
  capability: string, change: { granted: true; grantId: number; changed: boolean } | { granted: false; revoked: number },
  leadName: string = DEFAULT_LEAD_NAME,
): OwnerActionInput {
  const target = { key: `lead_trust:${capability}`, label: `${leadName} 的授权（${capability}）`, ticketId: null };
  if (!change.granted) {
    return {
      action: "lead.trust", target, summary: `撤回了给 ${leadName} 的授权：${capability}`,
      detail: { capability, granted: false, revoked: change.revoked },
      undo: { kind: "lead_trust", capability, granted: false, grantId: null, changed: true },
    };
  }
  return {
    action: "lead.trust", target,
    summary: change.changed
      ? `给 ${leadName} 授权：${capability}（${leadName} 可以代你确认工单）`
      : `重新确认了给 ${leadName} 的授权：${capability}`,
    detail: { capability, granted: true, grantId: change.grantId },
    undo: { kind: "lead_trust", capability, granted: true, grantId: change.grantId, changed: change.changed },
  };
}

const settingsOf = (connection: Pick<ConnectionDto, "roles" | "writePolicy"> | null | undefined): ConnectionSettings =>
  normalizeConnectionSettings(connection ?? DEFAULT_CONNECTION_SETTINGS);

/** 设置页改了一个连接的权限设置。before 是改之前的连接（读不到时按缺省设置）。 */
export function connectionSettingsOwnerAction(
  before: Pick<ConnectionDto, "roles" | "writePolicy"> | null | undefined, after: ConnectionDto,
): OwnerActionInput {
  const from = settingsOf(before);
  const to = settingsOf(after);
  const loosened = connectionSettingsLoosened(from, to);
  const change = describeConnectionSettingsChange(from, to);
  return {
    action: "connection.settings",
    target: { key: `connection:${after.key}`, label: `${after.label} 的权限设置`, ticketId: null },
    // 只写变了的那一项（2026-10-28）：改之前和改之后的完整设置在 detail 里。
    summary: change === null || sameConnectionSettings(from, to)
      ? `重新保存了 ${after.label} 的权限设置（没有变化）：${describeConnectionSettings(to)}`
      : `把 ${after.label} 的${change}`,
    detail: { before: from, after: to, loosened },
    undo: { kind: "connection_settings", key: after.key, before: from, after: to, loosened },
  };
}

/** 设置页保存或者删除了一个外部通道的凭据。names 是密钥名（没有值）。 */
export function channelCredentialsOwnerAction(change:
  | { op: "save"; source: string; label: string; names: readonly string[]; revision: string }
  | { op: "delete"; source: string; label: string; names: readonly string[] },
): OwnerActionInput {
  const target = { key: `channel_settings:${change.source}`, label: `${change.label} 通道的凭据`, ticketId: null };
  const names = change.names.join("、");
  if (change.op === "delete") {
    return {
      action: "channel.credentials", target,
      summary: `删除了 ${change.label} 通道在设置页保存的凭据（${names}）`,
      detail: { op: "delete", source: change.source, names: [...change.names] },
      undo: { kind: "channel_credentials", op: "delete", source: change.source, label: change.label },
    };
  }
  return {
    action: "channel.credentials", target,
    summary: `在设置页保存了 ${change.label} 通道的凭据（${names}），并用它重新连接`,
    detail: { op: "save", source: change.source, names: [...change.names] },
    undo: { kind: "channel_credentials", op: "save", source: change.source, label: change.label, revision: change.revision },
  };
}

// ── 撤销 ──────────────────────────────────────────────────────────────────────────

export interface OwnerActionDeps {
  db: Db;
  userActions?: UserActionService;
  leadTrust?: { revoke(capability: LeadCapability, via: LeadGrantChannel): number };
  connections?: Pick<ConnectionsService, "list" | "updateSettings">;
  channelSettings?: Pick<ChannelSettingsService, "revertSave">;
  // 常驻偏好的「不是我」：按改动编号恢复，并经它把笔记同步到记忆服务（daemon 的 NotesMemory）。
  notesMemory?: NotesMemory;
  publish(event: PublishGatewayEventInput): void;
  log(line: string): void;
  now?: () => Date;
}

export interface RevertResult {
  status: OwnerActionRevertStatus;
  message: string;
}

const reverted = (message: string): RevertResult => ({ status: "reverted", message });
const notRevertible = (message: string): RevertResult => ({ status: "not_revertible", message });
const unchanged = (message: string): RevertResult => ({ status: "unchanged", message });
const executed = (message: string): RevertResult => ({ status: "executed", message });

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const STAGE_WORDS: Record<string, string> = {
  draft: "草稿", ready: "待开始", active: "执行中", blocked: "受阻", review: "待验收", done: "已完成", cancelled: "已取消",
  scheduled: "待提醒", fired: "已提醒", acked: "已确认",
};
const stageWord = (stage: string) => STAGE_WORDS[stage] ?? stage;

// 工单完成以后可能已经开始的下游：依赖它的工单、父工单的集成。撤回验收不会把它们停下。
function downstreamNote(db: Db, itemId: number): string {
  const dependents = (db.prepare(
    `SELECT COUNT(*) AS n FROM ticket_relations
     WHERE target_item_id = ? AND relation_type = 'depends_on' AND revoked_at IS NULL`,
  ).get(itemId) as { n: number }).n;
  const parent = getItem(db, itemId)?.parent_item_id ?? null;
  if (!dependents && parent === null) return "";
  return "依赖它的工单或父工单的集成如果已经开始，不会自动停下。";
}

async function revertItem(deps: OwnerActionDeps, action: string, undo: Record<string, unknown>, by: string): Promise<RevertResult> {
  const { db } = deps;
  const itemId = num(undo.itemId);
  const item = itemId === null ? undefined : getItem(db, itemId);
  if (!item) return notRevertible(`找不到工单 #${itemId ?? "?"}，没有撤销。`);
  const label = itemLabel(item);
  const now = `现在是「${stageWord(item.stage)}」`;
  if (action === "ticket.stop") return notRevertible(ownerActionDefinition(action)!.undoNote);
  const actions = deps.userActions;
  if (action === "ticket.complete") {
    if (item.stage !== "done") return notRevertible(`${label}${now}，不是验收后的「已完成」，没有改回。`);
    transition(db, { itemId: item.id, to: "review", actor: "system", reason: `用户否认了这次验收（不是我，${by}）` });
    deps.publish(itemUpdatedEvent(item.id));
    return reverted(`${label}回到待验收（review）。${downstreamNote(db, item.id)}`.trim());
  }
  if (!actions) return notRevertible("用户控制面不可用，没有撤销。");
  if (action === "ticket.confirm") {
    if (item.stage === "ready") {
      actions.unconfirmItem(item.id);
      return reverted(`${label}回到草稿。`);
    }
    if (item.stage === "active" || item.stage === "blocked") {
      await actions.stopItem(item.id);
      actions.unconfirmItem(item.id);
      return reverted(`停止了已经开始的执行，${label}回到草稿。`);
    }
    return notRevertible(`${label}${now}，没有改回草稿。`);
  }
  if (action === "ticket.cancel") {
    if (item.stage !== "cancelled") return notRevertible(`${label}${now}，没有恢复。`);
    await actions.restoreItem(item.id, { mode: "root_only", requestedBy: `user via 不是我（${by}）` });
    const after = getItem(db, item.id);
    return reverted(`${label}恢复到「${stageWord(after?.stage ?? "draft")}」，要你重新确认。被停止的执行不会自动重启。`);
  }
  return notRevertible(`${label}：不认识的工单动作 ${action}，没有撤销。`);
}

function revertApproval(deps: OwnerActionDeps, undo: Record<string, unknown>, by: string): RevertResult {
  const { db } = deps;
  const approvalId = num(undo.approvalId);
  const approval = approvalId === null ? undefined : getApproval(db, approvalId);
  if (!approval) return notRevertible(`找不到审批 #${approvalId ?? "?"}，没有撤销。`);
  if (str(undo.decision) === "reject") return unchanged("拒绝是更保守的结果，不自动改成批准。");
  if (approval.status !== "approved") return notRevertible(`审批 #${approval.id} 现在是 ${approval.status}，没有改。`);
  const publish = () => deps.publish({
    type: "approval.resolved", requiredScope: "approvals:respond",
    ...(approval.item_id === null ? {} : { itemId: approval.item_id }),
    payload: { approvalId: approval.id, status: getApproval(db, approval.id)?.status ?? approval.status, snapshotRequired: true },
  });
  if (undo.consumerLive !== false) {
    const exemption = clearApprovalSessionExemption(db, approval.id);
    if (exemption) publish();
    return executed(
      `发起审批 #${approval.id} 的执行在批准时还在等结果，它已经读到批准并继续执行，被批准的动作无法撤回。`
      + (exemption ? "这条审批给的会话豁免已经取消：同一工单里的同类动作会重新要审批。" : ""),
    );
  }
  if (!withdrawApproval(db, approval.id, `user via 不是我（${by}）`)) {
    return notRevertible(`审批 #${approval.id} 的状态刚刚变了，没有改。`);
  }
  publish();
  return reverted(`审批 #${approval.id} 改为拒绝。发起它的执行在批准前已经结束，被批准的动作没有执行。`);
}

function revertStandingOrderProposal(deps: OwnerActionDeps, undo: Record<string, unknown>, by: string): RevertResult {
  if (undo.approve !== true) return unchanged(`拒绝提议是更保守的结果，不自动改成批准。${leadDisplayName(deps.db)} 可以重新提议。`);
  const orderId = str(undo.orderId);
  const baseVersion = num(undo.baseVersion);
  const appliedVersion = num(undo.appliedVersion);
  if (baseVersion === null) return notRevertible(`${orderId} 是新建的指令，没有更早的版本可以回滚。需要时在设置 → 常设指令里停用它。`);
  return rollbackOrder(deps, orderId, appliedVersion, baseVersion, by);
}

function revertStandingOrderRollback(deps: OwnerActionDeps, undo: Record<string, unknown>, by: string): RevertResult {
  const orderId = str(undo.orderId);
  return rollbackOrder(deps, orderId, num(undo.writtenVersion), num(undo.fromVersion), by);
}

function rollbackOrder(deps: OwnerActionDeps, orderId: string, expected: number | null, to: number | null, by: string): RevertResult {
  const current = getStandingOrder(deps.db, orderId);
  if (!current || expected === null || to === null) return notRevertible(`找不到常设指令 ${orderId} 的版本，没有回滚。`);
  if (current.version !== expected) {
    return notRevertible(`常设指令 ${orderId} 在这之后又改过（现在是 v${current.version}），没有自动回滚。`);
  }
  try {
    const written = rollbackStandingOrderByUser(deps.db, {
      id: orderId, toVersion: to, resolvedBy: `user via 不是我（${by}）`, ...(deps.now ? { now: deps.now() } : {}),
    });
    return reverted(`常设指令 ${orderId} 回到 v${to} 的内容（新版本 v${written.order.version}）。`);
  } catch (error) {
    return notRevertible(`常设指令 ${orderId} 没有回滚：${error instanceof Error ? error.message : String(error)}`);
  }
}

function revertLeadTrust(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  if (undo.granted !== true) return unchanged("撤回授权是更保守的结果，不自动恢复。需要时重新授权。");
  if (undo.changed !== true) return unchanged("授权在这次操作之前已经生效，这次操作没有改变它。");
  const capability = str(undo.capability) as LeadCapability;
  const active = activeLeadGrant(deps.db, capability);
  if (!active || active.id !== num(undo.grantId)) return notRevertible("这份授权已经被撤回或者换过了，没有改。");
  if (!deps.leadTrust) return notRevertible("授权服务不可用，没有撤回。");
  deps.leadTrust.revoke(capability, "control-plane");
  return reverted(`撤回了给 ${leadDisplayName(deps.db)} 的授权（${capability}）。`);
}

function revertLeadDelegation(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  if (undo.granted !== true) return unchanged("撤回委托是更保守的结果，不自动恢复。需要时重新委托。");
  const policyId = num(undo.policyId);
  const ticketId = num(undo.ticketId);
  if (policyId === null || ticketId === null) return notRevertible("找不到这份委托，没有撤回。");
  const active = activeDelegationPolicy(deps.db, ticketId);
  const revoked = revokeDelegationPolicy(deps.db, { policyId, via: "control-plane", reason: "用户否认了这次委托（不是我）" });
  if (!revoked) return notRevertible(`委托 #${policyId} 已经撤回或者过期了，没有改。`);
  deps.publish(itemUpdatedEvent(ticketId));
  const rework = undo.reworkStarted === true ? "授权时顺带开始的返工不会自动停止。" : "";
  return reverted(`撤回了工单 #${ticketId} 的委托验收（#${policyId}${active && active.id !== policyId ? "，另一份更早的委托仍然有效" : ""}）。${rework}`);
}

// 只撤销这次放开的部分：新加的角色去掉，直接写入改回先问我。这次收紧的部分保持收紧。
// 之后又改过的不自动恢复（和常设指令的回滚一样）。
function revertConnectionSettings(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  if (undo.loosened !== true) return unchanged("这次改动没有放开任何权限，收紧是更保守的结果，不自动恢复。");
  if (!deps.connections) return notRevertible("连接服务不可用，没有恢复。");
  const key = str(undo.key);
  const read = (value: unknown) => normalizeConnectionSettings(
    (value && typeof value === "object" ? value : DEFAULT_CONNECTION_SETTINGS) as { roles: unknown[]; writePolicy: unknown },
  );
  const before = read(undo.before);
  const after = read(undo.after);
  const current = deps.connections.list().items.find((item) => item.key === key);
  if (!current) return notRevertible(`找不到连接 ${key}，没有恢复。`);
  const now = settingsOf(current);
  if (!sameConnectionSettings(now, after)) {
    return notRevertible(`${current.label} 的权限设置在这之后又改过（现在是「${describeConnectionSettings(now)}」），没有自动恢复。`);
  }
  const target = stricterConnectionSettings(before, after);
  deps.connections.updateSettings(key, { roles: target.roles, writePolicy: target.writePolicy });
  return reverted(`${current.label} 的权限设置恢复为「${describeConnectionSettings(target)}」。之前已经执行的写入无法撤回。`);
}

// 保存的凭据：保险库里这个来源的密钥还是这次保存的那一版时，全部删掉并重连（Keychain 或环境变量里还有时用它们）。
// 之后又改过的不自动删。删除凭据本来就更保守，不自动恢复（也没有留下删掉的值）。
async function revertChannelCredentials(deps: OwnerActionDeps, undo: Record<string, unknown>): Promise<RevertResult> {
  const source = str(undo.source);
  const label = str(undo.label) || source;
  if (undo.op !== "save") return unchanged("删除凭据是更保守的结果，不自动恢复。需要时在设置页重新保存。");
  if (!deps.channelSettings) return notRevertible("消息通道不可用，没有删除这次保存的凭据。");
  const result = await deps.channelSettings.revertSave(source, str(undo.revision));
  if (result.status === "unknown") return notRevertible(`找不到通道 ${source}，没有删除。`);
  if (result.status === "changed") {
    return notRevertible(`${label} 通道的凭据在这之后又改过，没有自动删除。需要时在设置页删除。`);
  }
  const fallback = result.source?.secrets.some((secret) => secret.present)
    ? "Keychain 或环境变量里还有凭据，用它们重新连接。"
    : "已经断开。";
  return reverted(`删除了 ${label} 通道在设置页保存的凭据。${fallback}`);
}

// 名字、人格和互动风格：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不自动恢复。
function revertLeadProfileChange(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  const fields = (value: unknown): LeadProfileFields | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    return typeof record.name === "string" && typeof record.persona === "string" && typeof record.interactionStyle === "string"
      ? { name: record.name, persona: record.persona, interactionStyle: record.interactionStyle }
      : null;
  };
  const before = fields(undo.before);
  const after = fields(undo.after);
  if (!before || !after) return notRevertible("这次修改没有记下改之前的样子，没有恢复。");
  const result = revertLeadProfile(deps.db, { before, after }, deps.now ? { now: deps.now() } : {});
  if (result === "changed_since") return notRevertible("名字、人格和互动风格在这之后又改过，没有自动恢复。需要时在设置 → 身份与风格里改。");
  if (result === "unchanged") return unchanged("名字、人格和互动风格已经是改之前的样子。");
  deps.publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: LEAD_PROFILE_RESOURCE } });
  return reverted(`名字、人格和互动风格恢复成改之前的样子（名字是「${before.name}」）。`);
}

// 代回复风格：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不自动恢复。
function revertReplyStyleChange(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  if (typeof undo.before !== "string" || typeof undo.after !== "string") return notRevertible("这次修改没有记下改之前的样子，没有恢复。");
  const result = revertReplyStyle(deps.db, { before: undo.before, after: undo.after }, deps.now ? { now: deps.now() } : {});
  if (result === "changed_since") return notRevertible("代回复风格在这之后又改过，没有自动恢复。需要时在设置 → 消息通道里改。");
  if (result === "unchanged") return unchanged("代回复风格已经是改之前的样子。");
  deps.publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: REPLY_STYLE_RESOURCE } });
  return reverted(undo.before ? "代回复风格恢复成改之前的样子。" : "代回复风格恢复成空的。");
}

// 常驻偏好（2026-10-29）：按这次的改动编号撤销（core_memory_changes）。之后又改过、或者已经撤销过的不自动恢复。
function revertCoreMemoryChange(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  const changeId = num(undo.changeId);
  if (changeId === null) return notRevertible("这次修改没有记下改动编号，没有恢复。");
  if (!deps.notesMemory) return notRevertible("记忆模块还没有启动，没有恢复。需要时在设置 → 记忆 → 常驻偏好里改。");
  if (getCoreMemoryChange(deps.db, changeId)?.undoneAt) return unchanged("这次改动已经撤销过了。");
  try {
    undoCoreMemoryChange(deps.db, deps.notesMemory, changeId, {
      actor: "user", reason: "「不是我」撤销了这次改动", ...(deps.now ? { now: deps.now() } : {}),
    });
  } catch (error) {
    if (!(error instanceof CoreMemoryError)) throw error;
    return notRevertible(`${error.message}，没有自动恢复。需要时在设置 → 记忆 → 常驻偏好里改。`);
  }
  return reverted("常驻偏好恢复成改之前的样子。");
}

// 外观偏好：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不自动恢复。
function revertDesignPreferencesChange(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  const fields = (value: unknown): DesignPreferencesFields | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    return record.density && typeof record.density === "object" && typeof record.radius === "string" && typeof record.lineHeight === "string"
      && typeof record.textScale === "string" && record.colors && typeof record.colors === "object" && typeof record.notes === "string"
      ? record as unknown as DesignPreferencesFields
      : null;
  };
  const before = fields(undo.before);
  const after = fields(undo.after);
  if (!before || !after) return notRevertible("这次修改没有记下改之前的样子，没有恢复。");
  const result = revertDesignPreferences(deps.db, { before, after }, deps.now ? { now: deps.now() } : {});
  if (result === "changed_since") return notRevertible("外观在这之后又改过，没有自动恢复。需要时在设置 → 外观里改。");
  if (result === "unchanged") return unchanged("外观已经是改之前的样子。");
  deps.publish({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: DESIGN_PREFERENCES_RESOURCE } });
  return reverted("外观恢复成改之前的样子。");
}

async function revertRun(deps: OwnerActionDeps, action: string, undo: Record<string, unknown>): Promise<RevertResult> {
  if (action === "run.stop") return notRevertible(ownerActionDefinition(action)!.undoNote);
  const runId = num(undo.runId);
  const run = runId === null ? undefined : getRun(deps.db, runId);
  if (!run) return notRevertible(`找不到 Run #${runId ?? "?"}，没有恢复。`);
  if (run.state !== "paused") return notRevertible(`Run #${run.id} 现在是 ${run.state}，不在暂停，没有恢复。`);
  if (!deps.userActions) return notRevertible("用户控制面不可用，没有恢复。");
  try {
    await deps.userActions.resumeRun(run.id);
    return reverted(`恢复了 Run #${run.id}。`);
  } catch (error) {
    return notRevertible(`Run #${run.id} 没有恢复：${error instanceof Error ? error.message : String(error)}`);
  }
}

// 放宽权限清单：删掉这一次加上的规则（和只给这次加上的本地仓库）。之后又放宽的规则不动。
// 撤销记成账本里的一条 reverted。用新权限已经做了的写操作不会撤回（它们各自是一条 connection.agent_write）。
function revertRunGrant(deps: OwnerActionDeps, undo: Record<string, unknown>): RevertResult {
  const runId = num(undo.runId);
  const changeId = num(undo.changeId);
  const change = changeId === null ? null : getRunGrantChange(deps.db, changeId);
  if (runId === null || !change || change.runId !== runId || change.change !== "widened") {
    return notRevertible("找不到这次放宽的记录，没有撤销。");
  }
  if (grantChangeRevertedBy(deps.db, change.id)) return unchanged("这次放宽已经撤销过了。");
  return deps.db.transaction((): RevertResult => {
    const record = getRunGrant(deps.db, runId);
    if (!record) return notRevertible(`Run #${runId} 没有权限清单，没有撤销。`);
    const grant = withoutGrantRules(record.grant, change.rules.map((rule) => rule.id), change.localRepos.map((entry) => entry.name));
    applyRunGrantChange(deps.db, {
      runId, expectedRevision: record.revision, grant, change: "reverted", rules: change.rules, localRepos: change.localRepos,
      actor: "user", reason: "用户撤销了这次放宽", revertsChangeId: change.id,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    const labels = change.rules.map((rule) => rule.label).join("；");
    return reverted(`从 Run #${runId} 的清单里删掉了：${labels}。用新权限已经做了的写操作不会撤回。`);
  }).immediate();
}

// 子 agent 经连接中心的写操作（landing.md C3）。记成主人操作的都是别人看得到的写操作（提交了的 review、发出的评论），
// 已经发到外部服务。连接（GitHub 的远程 MCP）没有删掉提交了的 review 或评论的工具，所以系统撤不回：给出链接，请你在那边改或删。
function revertAgentWrite(undo: Record<string, unknown>): RevertResult {
  const url = str(undo.url);
  const where = str(undo.connection) || "外部服务";
  return executed(url ? `这次写入已经发到 ${where}，系统撤不回。请到这里改或删：${url}` : `这次写入已经发到 ${where}，系统撤不回，请在那边改或删。`);
}

/** 撤销一次主人操作。按事件的 action 和 undo 来，不会抛错：出了问题就返回 not_revertible 和原因。 */
export async function revertOwnerAction(deps: OwnerActionDeps, performed: EventRecord, by: string): Promise<RevertResult> {
  const action = str(performed.payload.action);
  const undo = (performed.payload.undo ?? {}) as Record<string, unknown>;
  const definition = ownerActionDefinition(action);
  if (!definition) return notRevertible(`不认识的操作 ${action}，没有撤销。`);
  try {
    switch (definition.id) {
      case "ticket.confirm": case "ticket.complete": case "ticket.stop": case "ticket.cancel":
        return await revertItem(deps, definition.id, undo, by);
      case "approval.resolve":
        return revertApproval(deps, undo, by);
      case "decision.resolve":
      case "memory.switch_confirm":
      case "workspace.release":
      case "workspace.cleanup":
        return notRevertible(ownerActionText(definition.undoNote, leadDisplayName(deps.db)));
      case "connection.confirm":
        if (undo.approve !== true) return unchanged("不允许写入是更保守的结果，不自动改成允许。");
        if (str(undo.state) === "failed") return unchanged("这次写入没有成功，外部服务里没有留下东西。");
        return executed(definition.undoNote);
      case "standing_order.proposal_decide":
        return revertStandingOrderProposal(deps, undo, by);
      case "standing_order.rollback":
        return revertStandingOrderRollback(deps, undo, by);
      case "lead.trust":
        return revertLeadTrust(deps, undo);
      case "lead.delegation":
        return revertLeadDelegation(deps, undo);
      case "connection.settings":
        return revertConnectionSettings(deps, undo);
      case "channel.credentials":
        return await revertChannelCredentials(deps, undo);
      case "run.pause": case "run.stop":
        return await revertRun(deps, definition.id, undo);
      case "run.grant":
        return revertRunGrant(deps, undo);
      case "connection.agent_write":
        return revertAgentWrite(undo);
      case "lead.profile":
        return revertLeadProfileChange(deps, undo);
      case "ui.design":
        return revertDesignPreferencesChange(deps, undo);
      case "channel.reply_style":
        return revertReplyStyleChange(deps, undo);
      case "memory.preferences":
        return revertCoreMemoryChange(deps, undo);
    }
  } catch (error) {
    deps.log(`[owner-action] revert ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
    return notRevertible(`撤销没有完成：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 作废凭证和「不是我」 ──────────────────────────────────────────────────────────

/** 作废发出这次操作的凭证。只看事件里记的 bindingId。 */
export function revokeOwnerActionCredential(db: Db, credential: Record<string, unknown>): {
  bindingId: number; revoked: boolean; message: string;
} {
  const bindingId = num(credential.bindingId) ?? 0;
  if (bindingId < 1) {
    return { bindingId, revoked: false, message: "这次操作用的是临时 admin token：它只在内存里，几分钟后自动作废。" };
  }
  const binding = getBinding(db, bindingId);
  if (!binding) return { bindingId, revoked: false, message: `找不到凭证 #${bindingId}。` };
  const name = `${binding.display_name}（#${binding.id}）`;
  if (binding.status !== "active") return { bindingId, revoked: true, message: `凭证 ${name} 之前已经作废。` };
  revokeBinding(db, binding.id);
  const again = binding.kind === "cli" ? "要继续用 plc，运行 plc auth login 重新签发。" : "那台设备要重新配对。";
  return { bindingId, revoked: true, message: `作废了凭证 ${name}，用它的请求都会被拒绝。${again}` };
}

export class OwnerActionError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "conflict", message: string) {
    super(message);
  }
}

const inFlight = new WeakMap<Db, Set<string>>();

/**
 * 用户点了「不是我」。调用方只能是扫码配对的手机或者网页会话（protocol 的 canDisownOwnerAction）。
 * 先撤销，再作废发出那次操作的凭证，最后记下结果。同一次操作点两次，第二次直接回第一次的结果。
 */
export async function disownOwnerAction(deps: OwnerActionDeps, eventId: string, caller: Binding): Promise<OwnerActionDto> {
  const { db } = deps;
  if (!canDisownOwnerAction({ kind: caller.kind, origin: bindingOriginOf(caller) })) {
    throw new OwnerActionError("forbidden", "「不是我」只能从扫码配对的手机或者网页上点");
  }
  const found = getOwnerAction(db, eventId);
  if (!found) throw new OwnerActionError("not_found", `没有这次主人操作：${eventId}`);
  if (found.disowned) return ownerActionView(db, eventId)!;
  if (found.performed.payload.delivery !== "push") {
    throw new OwnerActionError("conflict", "这次操作来自扫码配对的手机，只记录，不能点「不是我」");
  }
  const running = inFlight.get(db) ?? new Set<string>();
  inFlight.set(db, running);
  if (running.has(eventId)) throw new OwnerActionError("conflict", "这次操作的「不是我」正在处理");
  running.add(eventId);
  try {
    const by = `${caller.display_name}，binding ${caller.id}`;
    const revert = await revertOwnerAction(deps, found.performed, by);
    // Lead 在对话里代你做的（审查 M5）：只撤销，不作废那一轮来自的凭证——多半是 Lead 理解错了，你的设备还要用。
    const performedCredential = (found.performed.payload.credential ?? {}) as Record<string, unknown>;
    const credential = isOnBehalfOwnerActionSource((found.performed.payload.source ?? { client: "" }) as { client: string })
      ? { bindingId: num(performedCredential.bindingId) ?? 0, revoked: false, message: onBehalfUndoCredentialNote(leadDisplayName(db)) }
      : revokeOwnerActionCredential(db, performedCredential);
    recordOwnerActionDisowned(db, {
      performed: found.performed, by: caller, revert, credential, ...(deps.now ? { now: deps.now() } : {}),
    });
    deps.publish({
      type: "snapshot.required", requiredScope: "notices",
      payload: { resource: "notifications" },
    });
    deps.log(`[owner-action] ${str(found.performed.payload.action)} disowned by binding #${caller.id}: `
      + `${revert.status}; binding #${credential.bindingId} ${credential.revoked ? "revoked" : "not revoked"}`);
    return ownerActionView(db, eventId)!;
  } finally {
    running.delete(eventId);
  }
}

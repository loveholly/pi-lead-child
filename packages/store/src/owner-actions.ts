// 高风险的主人操作：事件、推送用的通知、「不是我」的记录（工单 15 第一步）。
// 清单和判断规则（只记录还是推送、谁能点「不是我」）在 protocol 的 owner-actions.ts；撤销在网关的 owner-actions.ts。
// 这里只写库：
//   - recordOwnerAction：一次操作一条 owner_action.performed 事件。要推送时，同一个事务里先写一条通知
//     （kind owner_action，immediate，不挂工单），事件的 correlation_id 指向它：daemon 推送以后通知记成已送达，
//     事件的处置随之记成 told_user（notifications.ts 的 markNotificationDelivered）。
//   - recordOwnerActionDisowned：用户点了「不是我」以后的结果。同一次操作只记一条（source_ref 去重），原事件记成 handled，
//     通知记成已确认。
//   - ownerActionView：线上的 OwnerActionDto。
import {
  bindingOriginOf, isOnBehalfOwnerActionSource, ITEM_ACTION_RISK, OWNER_ACTION_DISOWNED_KIND, OWNER_ACTION_NOTIFICATION_KIND,
  OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND, OWNER_ACTION_PERFORMED_KIND,
  ownerActionAlertText, ownerActionDefinition, ownerActionDelivery, ownerActionLevel, ownerActionNotificationDedupKey, ownerActionText,
  type ConnectionSettings, type DesignPreferencesFields, type LeadProfileFields, type OwnerActionDelivery, type OwnerActionDto, type OwnerActionId, type OwnerActionRevertStatus,
  type OwnerActionSource, type UserItemActionId,
} from "@pi-lead-child/protocol";
import type { Approval, DecisionRequest, Item, Run } from "@pi-lead-child/core";
import type { Db } from "./db.js";
import {
  appendEvent, clipEventText, getEvent, itemEntityKey, listEvents, newEventId, setEventDisposition, type EventRecord,
} from "./events.js";
import { getItem } from "./items.js";
import { getRun, isTerminalRunState } from "./runs.js";
import { getBinding, type Binding } from "./gateway.js";
import { ackNotification, addNotification } from "./notifications.js";
import { leadDisplayName } from "./lead-profile.js";

export interface OwnerActionTarget {
  // 对象键，例如 ticket:5、approval:3、run:9、standing_order:inbox.wake_lead。
  key: string;
  // 给人看的名字，例如「工单 #5「登录页」」。
  label: string;
  ticketId?: number | null;
}

export interface RecordOwnerActionInput {
  action: OwnerActionId;
  target: OwnerActionTarget;
  // 一句话：做了什么，例如「验收了工单 #5「登录页」」。推送的标题就是它。
  summary: string;
  detail?: Record<string, unknown>;
  // 「不是我」撤销要的、操作之前的状态。
  undo?: Record<string, unknown>;
  // 推送的正文里多给的一行（例如子 agent 写入的链接）。
  alertNote?: string | null;
  credential: Pick<Binding, "id" | "kind" | "display_name" | "origin">;
  source: OwnerActionSource;
  now?: Date;
}

export interface RecordedOwnerAction {
  event: EventRecord;
  delivery: OwnerActionDelivery;
  notificationId: number | null;
}

// ── 撤销要的、操作之前的状态（写进事件的 payload.undo），和工单、Run 的构造函数 ──────────────────────
// 网关的路由和 engine 的工单操作层（spec 5.11，Lead 代你做）都用它们：两个入口记下的主人操作长得一样，
// 「不是我」按同一份 undo 撤销（网关的 owner-actions.ts）。

export type OwnerActionUndo =
  | { kind: "item"; itemId: number; from: string; to: string }
  // consumerLive：批准的时候，发起审批的那个 Run 还活着（child 每 250 毫秒查一次审批，马上就会读到结果）。
  | { kind: "approval"; approvalId: number; decision: string; consumerLive: boolean }
  | { kind: "decision"; requestId: number; decision: string }
  // state：确认以后这次写入的状态（done、running、failed……）。
  | { kind: "connection_confirmation"; confirmationId: string; approve: boolean; state: string }
  | { kind: "memory_switch"; switchId: string; approve: boolean }
  | {
      kind: "standing_order_proposal"; approvalId: number; approve: boolean; orderId: string;
      baseVersion: number | null; appliedVersion: number | null;
    }
  | { kind: "standing_order_rollback"; orderId: string; fromVersion: number; writtenVersion: number }
  | { kind: "lead_trust"; capability: string; granted: boolean; grantId: number | null; changed: boolean }
  | { kind: "lead_delegation"; ticketId: number; granted: boolean; policyId: number | null; reworkStarted: boolean }
  // loosened：这次改动放开了什么（新加的角色，或者改成直接写入）。只有放开的才撤销。
  | { kind: "connection_settings"; key: string; before: ConnectionSettings; after: ConnectionSettings; loosened: boolean }
  // 外部通道的凭据（slack-settings 工单 S1）。save 时记下保存以后保险库里这个来源的版本（不是密钥）；delete 不能撤销。
  | { kind: "channel_credentials"; op: "save"; source: string; label: string; revision: string }
  | { kind: "channel_credentials"; op: "delete"; source: string; label: string }
  | { kind: "run"; runId: number; action: "pause" | "stop"; from: string }
  // 放宽权限清单（landing.md 第 5 节）：撤销时删掉这一次（run_grant_changes 的 changeId）加上的规则。
  | { kind: "run_grant"; runId: number; changeId: number }
  // 子 agent 经连接中心的一次写操作（landing.md C3）：run_tool_calls 的 callId，和外部服务里能看到它的地址。
  | { kind: "connection_write"; runId: number; callId: number; connection: string; tool: string; url: string | null }
  | { kind: "workspace"; workspaceId: number; action: "release" | "cleanup"; status: string }
  | { kind: "lead_profile"; before: LeadProfileFields; after: LeadProfileFields }
  | { kind: "design_preferences"; before: DesignPreferencesFields; after: DesignPreferencesFields }
  // 代回复风格（2026-10-28）：改之前和改之后的整段。
  | { kind: "reply_style"; before: string; after: string }
  // 常驻偏好（2026-10-29）：这次记下的改动编号（core_memory_changes）。撤销按这一行恢复。
  | { kind: "core_memory"; changeId: number };

export interface OwnerActionInput {
  action: OwnerActionId;
  target: OwnerActionTarget;
  summary: string;
  detail?: Record<string, unknown>;
  undo: OwnerActionUndo;
}

const ITEM_VERBS: Partial<Record<OwnerActionId, string>> = {
  "ticket.confirm": "确认了", "ticket.complete": "验收了", "ticket.stop": "停止了", "ticket.cancel": "取消了",
};

export function itemLabel(item: Pick<Item, "id" | "kind" | "title" | "display_title">): string {
  const noun = item.kind === "reminder" ? "提醒" : "工单";
  return `${noun} #${item.id}「${item.display_title ?? item.title}」`;
}

export function itemTarget(db: Db, item: Pick<Item, "id" | "kind" | "title" | "display_title">): OwnerActionTarget {
  return { key: itemEntityKey(db, item.id), label: itemLabel(item), ticketId: item.id };
}

/** 一个工单动作算不算主人操作（protocol 的 ITEM_ACTION_RISK）。不算时返回 null。item 是操作之前的工单。 */
export function itemOwnerAction(db: Db, action: UserItemActionId, item: Item, from: string): OwnerActionInput | null {
  const ownerAction = ITEM_ACTION_RISK[action].ownerAction;
  if (!ownerAction) return null;
  const after = getItem(db, item.id) ?? item;
  return {
    action: ownerAction,
    target: itemTarget(db, item),
    summary: `${ITEM_VERBS[ownerAction] ?? `${action} `}${itemLabel(item)}`,
    detail: { from, to: after.stage },
    undo: { kind: "item", itemId: item.id, from, to: after.stage },
  };
}


// 授权托管、撤回托管（工单 11 搬到这里：engine 的工单操作层 delegate 也要用同一份；网关照旧转出）。
export function delegationOwnerAction(
  db: Db, itemId: number, change: { granted: true; policyId: number; reworkStarted: boolean } | { granted: false; revoked: number },
): OwnerActionInput {
  const item = getItem(db, itemId);
  const label = item ? itemLabel(item) : `工单 #${itemId}`;
  const target = item ? itemTarget(db, item) : { key: `ticket:${itemId}`, label, ticketId: itemId };
  if (!change.granted) {
    return {
      action: "lead.delegation", target, summary: `撤回了${label}的委托验收`,
      detail: { granted: false, revoked: change.revoked },
      undo: { kind: "lead_delegation", ticketId: itemId, granted: false, policyId: null, reworkStarted: false },
    };
  }
  return {
    action: "lead.delegation", target,
    summary: `把${label}委托给 ${leadDisplayName(db)} 验收${change.reworkStarted ? "，并开始返工" : ""}`,
    detail: { granted: true, policyId: change.policyId, reworkStarted: change.reworkStarted },
    undo: { kind: "lead_delegation", ticketId: itemId, granted: true, policyId: change.policyId, reworkStarted: change.reworkStarted },
  };
}

// 释放、清理工作区（搬到这里：engine 的操作层 workspace 的 release、cleanup 也要用同一份；网关照旧转出）。
export function workspaceOwnerAction(
  db: Db, workspaceId: number, action: "release" | "cleanup", result: { itemId: number; status: string },
): OwnerActionInput {
  const owner = getItem(db, result.itemId);
  const of = owner ? itemLabel(owner) : `工单 #${result.itemId}`;
  return {
    action: action === "release" ? "workspace.release" : "workspace.cleanup",
    target: { key: `workspace:${workspaceId}`, label: `工作区 #${workspaceId}（${of}）`, ticketId: result.itemId },
    summary: `${action === "release" ? "释放" : "清理"}了工作区 #${workspaceId}（${of}）`,
    detail: { status: result.status },
    undo: { kind: "workspace", workspaceId, action, status: result.status },
  };
}

export function runOwnerAction(db: Db, run: Run, action: "pause" | "stop", to: string): OwnerActionInput {
  const item = getItem(db, run.item_id);
  const of = item ? itemLabel(item) : `工单 #${run.item_id}`;
  return {
    action: action === "pause" ? "run.pause" : "run.stop",
    target: { key: `run:${run.id}`, label: `Run #${run.id}（${of}）`, ticketId: run.item_id },
    summary: `${action === "pause" ? "暂停" : "停止"}了 Run #${run.id}（${of}）`,
    detail: { from: run.state, to },
    undo: { kind: "run", runId: run.id, action, from: run.state },
  };
}

// 审批和决定请求的主人操作。页面的路由和 Lead 代你做（engine 的 ui-actions/ 的 approval、decision 的 resolve）用同一份。
// approval 是处理之前的审批。

export function approvalOwnerAction(db: Db, approval: Approval, decision: string, consumerLive: boolean): OwnerActionInput {
  const item = approval.item_id === null ? null : getItem(db, approval.item_id);
  const verb = decision === "reject" ? "拒绝了" : decision === "approve_session" ? "批准了（本工单内免批）" : "批准了";
  return {
    action: "approval.resolve",
    target: { key: `approval:${approval.id}`, label: `审批 #${approval.id}（${approval.tool}）`, ticketId: approval.item_id },
    summary: `${verb}审批 #${approval.id}：${approval.action}${item ? `（${itemLabel(item)}）` : ""}`,
    detail: { decision, tool: approval.tool },
    undo: { kind: "approval", approvalId: approval.id, decision, consumerLive },
  };
}

export function decisionOwnerAction(db: Db, request: DecisionRequest, decision: string): OwnerActionInput {
  const item = getItem(db, request.itemId);
  const prompt = request.prompt.length > 120 ? `${request.prompt.slice(0, 120)}…` : request.prompt;
  return {
    action: "decision.resolve",
    target: { key: `decision:${request.id}`, label: `决定请求 #${request.id}`, ticketId: request.itemId },
    summary: `${decision === "dismiss" ? "驳回了" : "回答了"}决定请求 #${request.id}：${prompt}${item ? `（${itemLabel(item)}）` : ""}`,
    detail: { decision },
    undo: { kind: "decision", requestId: request.id, decision },
  };
}

/** 发起审批的 Run 现在还活着吗（没有 Run 的审批按活着算：不知道谁在等它）。 */
export function approvalConsumerLive(db: Db, approval: Approval): boolean {
  if (approval.run_id === null) return true;
  const run = getRun(db, approval.run_id);
  return Boolean(run) && !isTerminalRunState(run!.state);
}

/** 记一次主人操作。来自扫码配对的手机时只记录（record 级）；其余推送：写一条通知，事件是 interrupt 级。 */
export function recordOwnerAction(db: Db, input: RecordOwnerActionInput): RecordedOwnerAction {
  const definition = ownerActionDefinition(input.action);
  if (!definition) throw new Error(`unknown owner action ${input.action}`);
  const origin = bindingOriginOf(input.credential);
  const delivery = ownerActionDelivery(origin, input.source);
  const at = (input.now ?? new Date()).toISOString();
  const credential = {
    bindingId: input.credential.id, kind: input.credential.kind, name: input.credential.display_name, origin,
  };
  const summary = clipEventText(input.summary, 300);
  const leadName = leadDisplayName(db);
  return db.transaction((): RecordedOwnerAction => {
    const eventId = newEventId();
    let notificationId: number | null = null;
    if (delivery === "push") {
      const text = ownerActionAlertText({ summary, credential, source: input.source, note: input.alertNote ?? null, leadName });
      notificationId = addNotification(db, {
        kind: isOnBehalfOwnerActionSource(input.source) ? OWNER_ACTION_ON_BEHALF_NOTIFICATION_KIND : OWNER_ACTION_NOTIFICATION_KIND,
        urgency: "immediate", title: text.title, body: text.body, createdAt: at,
        dedupKey: ownerActionNotificationDedupKey(eventId, credential.bindingId),
      });
    }
    const { event } = appendEvent(db, {
      eventId,
      source: "system",
      kind: OWNER_ACTION_PERFORMED_KIND,
      entityKey: input.target.key,
      occurredAt: at,
      correlationId: notificationId === null ? null : `notification:${notificationId}`,
      level: ownerActionLevel(delivery),
      payload: {
        action: input.action,
        label: ownerActionText(definition.label, leadName),
        summary,
        target: { key: input.target.key, label: input.target.label, ticketId: input.target.ticketId ?? null },
        detail: input.detail ?? {},
        credential,
        source: { ...input.source },
        delivery,
        notificationId,
        undo: input.undo ?? {},
      },
    });
    return { event, delivery, notificationId };
  }).immediate();
}

/**
 * 只记录的主人操作（delivery 是 record），seq 大于 sinceSeq 的，从旧到新。daemon 据此在会话里贴一行记录；
 * 调用方从 daemon 启动时的最大 seq 开始读，所以历史上的记录不会一下子贴进会话。
 */
export function listRecordedOwnerActions(db: Db, query: { sinceSeq: number; limit?: number }): EventRecord[] {
  return listEvents(db, { kind: OWNER_ACTION_PERFORMED_KIND, level: "record", sinceSeq: query.sinceSeq, limit: query.limit ?? 100 });
}

export interface OwnerActionRecord {
  performed: EventRecord;
  disowned: EventRecord | null;
}

const disownRef = (eventId: string) => `owner_action:disowned:${eventId}`;

function eventAt(db: Db, row: { seq: number } | undefined): EventRecord | null {
  return row ? getEvent(db, row.seq) ?? null : null;
}

/** 一次主人操作和它的「不是我」记录。编号不是主人操作的事件时返回 null。 */
export function getOwnerAction(db: Db, eventId: string): OwnerActionRecord | null {
  const performed = eventAt(db, db.prepare("SELECT seq FROM events WHERE event_id = ? AND kind = ?")
    .get(eventId, OWNER_ACTION_PERFORMED_KIND) as { seq: number } | undefined);
  if (!performed) return null;
  const disowned = eventAt(db, db.prepare("SELECT seq FROM events WHERE source = 'system' AND source_ref = ?")
    .get(disownRef(eventId)) as { seq: number } | undefined);
  return { performed, disowned };
}

export interface OwnerActionDisownInput {
  performed: EventRecord;
  by: Pick<Binding, "id" | "kind" | "display_name" | "origin">;
  revert: { status: OwnerActionRevertStatus; message: string };
  credential: { bindingId: number; revoked: boolean; message: string };
  now?: Date;
}

/**
 * 记下「不是我」的结果。同一次操作只记一条：已经记过时返回已有的那一条（inserted 为 false）。
 * 原事件的处置改成 handled（用户处理了），推送的通知记成已确认。
 */
export function recordOwnerActionDisowned(db: Db, input: OwnerActionDisownInput): { event: EventRecord; inserted: boolean } {
  const now = input.now ?? new Date();
  return db.transaction(() => {
    const payload = input.performed.payload as { action?: unknown; summary?: unknown; notificationId?: unknown };
    const result = appendEvent(db, {
      source: "system",
      sourceRef: disownRef(input.performed.eventId),
      kind: OWNER_ACTION_DISOWNED_KIND,
      entityKey: input.performed.entityKey,
      occurredAt: now.toISOString(),
      causationId: input.performed.eventId,
      level: "record",
      payload: {
        performedSeq: input.performed.seq,
        performedEventId: input.performed.eventId,
        action: String(payload.action ?? "unknown"),
        summary: typeof payload.summary === "string" ? payload.summary : "",
        by: { bindingId: input.by.id, kind: input.by.kind, name: input.by.display_name, origin: bindingOriginOf(input.by) },
        revert: { status: input.revert.status, message: clipEventText(input.revert.message, 1_000) },
        credential: { ...input.credential, message: clipEventText(input.credential.message, 500) },
      },
    }, { receivedAt: now });
    if (!result.inserted) return result;
    setEventDisposition(db, input.performed.seq, "handled", {
      by: "user", disowned: true, revert: input.revert.status, credentialRevoked: input.credential.revoked,
    }, now);
    if (typeof payload.notificationId === "number") ackNotification(db, payload.notificationId, now);
    return result;
  }).immediate();
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const REVERT_STATUSES: ReadonlySet<string> = new Set(["reverted", "executed", "not_revertible", "unchanged"]);

/** 线上的 OwnerActionDto。编号不是主人操作的事件时返回 null。 */
export function ownerActionView(db: Db, eventId: string): OwnerActionDto | null {
  const found = getOwnerAction(db, eventId);
  if (!found) return null;
  const payload = found.performed.payload;
  const definition = ownerActionDefinition(text(payload.action));
  const target = record(payload.target);
  const credential = record(payload.credential);
  const source = record(payload.source);
  const bindingId = typeof credential.bindingId === "number" ? credential.bindingId : 0;
  const binding = bindingId > 0 ? getBinding(db, bindingId) : null;
  const delivery = payload.delivery === "record" ? "record" : "push";
  let disowned: OwnerActionDto["disowned"] = null;
  if (found.disowned) {
    const detail = found.disowned.payload;
    const revert = record(detail.revert);
    const revoked = record(detail.credential);
    const status = text(revert.status);
    disowned = {
      at: found.disowned.occurredAt,
      byName: text(record(detail.by).name),
      revert: {
        status: (REVERT_STATUSES.has(status) ? status : "not_revertible") as OwnerActionRevertStatus,
        message: text(revert.message),
      },
      credential: {
        bindingId: typeof revoked.bindingId === "number" ? revoked.bindingId : bindingId,
        revoked: revoked.revoked === true,
        message: text(revoked.message),
      },
    };
  }
  return {
    eventId: found.performed.eventId,
    action: text(payload.action, "unknown"),
    label: text(payload.label, definition?.label ?? ""),
    summary: text(payload.summary),
    target: {
      key: text(target.key, found.performed.entityKey),
      label: text(target.label),
      ticketId: typeof target.ticketId === "number" ? target.ticketId : null,
    },
    credential: {
      bindingId, kind: text(credential.kind), name: text(credential.name), origin: text(credential.origin, "unknown"),
      active: binding?.status === "active",
    },
    source: {
      client: text(source.client, "unknown"),
      deviceName: text(source.deviceName),
      loopback: source.loopback === true,
      fromThisMachine: source.fromThisMachine === true,
    },
    delivery,
    performedAt: found.performed.occurredAt,
    undo: { possible: definition?.undo ?? "none", note: definition ? ownerActionText(definition.undoNote, leadDisplayName(db)) : "" },
    disownable: delivery === "push" && disowned === null,
    disowned,
  };
}

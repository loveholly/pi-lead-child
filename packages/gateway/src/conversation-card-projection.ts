import { createHash } from "node:crypto";
import { CONVERSATION_CARD_LIMITS } from "@pi-lead-child/protocol";
import {
  getConversationCardByKey,
  itemIdOfCardOperation,
  upsertItemExecutionCard,
} from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { publishGatewayEvent } from "@pi-lead-child/store";
import type { GatewayEvent } from "@pi-lead-child/protocol";
import type {
  ConversationCard,
  ItemOperationProjection,
  ItemOperationState,
} from "@pi-lead-child/core";

export interface LeadToolCardEvent {
  type: "lead.tool.started" | "lead.tool.updated" | "lead.tool.completed" | "lead.tool.failed";
  turnId: string;
  itemId?: number | null;
  occurredAt?: string;
  payload: Record<string, unknown>;
}

export type LiveItemExecutionCard = Omit<
  Extract<ConversationCard, { kind: "ticket_execution" }>,
  "id"
> & { id: null };

export type ReconciledConversationCard = ConversationCard | LiveItemExecutionCard;
export type ItemExecutionProjectionCard = Extract<
  ReconciledConversationCard,
  { kind: "ticket_execution" }
>;

interface LeadToolOperationProjection {
  itemId: number;
  operation: ItemOperationProjection;
  occurredAt: string;
}

const TOOL_LABELS: Record<string, string> = {
  create_task: "Create task",
  create_reminder: "Create reminder",
  spawn_child: "Spawn child",
  recover_ticket_run: "Recover run",
};

const ITEM_TARGETED_TOOLS = new Set([
  "get_ticket_tree",
  "spawn_child",
  // Lead 重新派活的另一条路（2026-10-17）：目标工单只在入参里，Lead 的会话回合不挂工单。
  "recover_ticket_run",
  // Lead 换核查员（2026-10-20）：同上，目标工单只在入参里。2026-10-21 起换核查员是 ticket_action 的一个操作，
  // 旧名留着，历史会话里的调用照样认得出工单。
  "change_reviewer",
  // 工单操作（spec 5.11）：页面上能点的每个操作，Lead 都经它去做。目标工单只在入参里。
  "ticket_action",
  "steer_child",
  // stop_child、cancel_item 在 2026-10-28 删掉了（现在是 ticket_action 的 stop、cancel）。旧名留着，历史会话里的调用照样认得出工单。
  "stop_child",
  "update_item",
  "reschedule_reminder",
  "defer_item",
  "cancel_item",
  "ack_reminder",
  "add_comment",
  "record_decision",
]);

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return undefined;
}

function textValues(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.slice(0, 20).flatMap((item) => textValues(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>)
    .slice(0, 20)
    .flatMap((item) => textValues(item, depth + 1));
}

function itemIdFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // 这里解析的是 lead 工具的入参与返回值，而工具签名是**冻结契约**（对 agent 而言，
  // 改了会让历史会话里的调用失效），所以键名仍是 ticket_id / ticketId，不随内部改名走。
  // 内部形态也认，因为部分工具返回的是内部 DTO。
  return positiveInteger(record.ticketId) ?? positiveInteger(record.ticket_id)
    ?? positiveInteger(record.itemId) ?? positiveInteger(record.item_id);
}

function itemIdFromResult(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  const direct = itemIdFromRecord(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const nested = itemIdFromResult(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>).slice(0, 20)) {
      const nested = itemIdFromResult(item, depth + 1);
      if (nested) return nested;
    }
  }
  for (const text of textValues(value, depth)) {
    // task / reminder 也要认：工具拆分后（spec §8）建单工具回的是 "created task #N" /
    // "created reminder #N"，只认 "item #N" 会让新建的事项projection 不出 itemId。
    const match = /\b(?:ticket|item|task|reminder)\s*#([1-9][0-9]*)\b/i.exec(text);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function itemIdFromEvent(
  event: LeadToolCardEvent,
  toolName: string,
  state: ItemOperationState,
): number | undefined {
  // 建单类工具在调用时还没有 item id，只能从结果文本里回捞（spec §8 拆分后有两个入口）。
  if (toolName === "create_task" || toolName === "create_reminder") {
    return state === "completed"
      ? itemIdFromResult(event.payload.result)
      : undefined;
  }
  if (ITEM_TARGETED_TOOLS.has(toolName)) {
    const targetItemId = itemIdFromRecord(event.payload.args);
    if (targetItemId) return targetItemId;
  }
  return positiveInteger(event.payload.itemId)
    ?? positiveInteger(event.payload.item_id)
    ?? positiveInteger(event.itemId);
}

function clipped(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${chars.slice(0, Math.max(1, limit - hash.length - 1)).join("")}~${hash}`;
}

function stateFor(type: LeadToolCardEvent["type"]): ItemOperationState {
  if (type === "lead.tool.started") return "started";
  if (type === "lead.tool.updated") return "running";
  if (type === "lead.tool.failed") return "failed";
  return "completed";
}

function operationDetail(name: string, state: ItemOperationState, itemId: number): string | null {
  if (state === "started" || state === "running") return null;
  if (state === "failed") return "Operation failed";
  if (name === "create_task") return `Created task #${itemId}`;
  if (name === "create_reminder") return `Created reminder #${itemId}`;
  if (name === "spawn_child") return `Child started for item #${itemId}`;
  if (name === "recover_ticket_run") return `Run recovered for item #${itemId}`;
  return "Operation completed";
}

export function operationIdOf(event: LeadToolCardEvent): string {
  const callId = String(event.payload.toolCallId ?? event.payload.callId ?? "unknown");
  return clipped(`${event.turnId}:${callId}`, CONVERSATION_CARD_LIMITS.operationId);
}

// resolveKnownItemId：把一条 operation id 映射回它开跑时就已经落定的 item。
//
// **为什么终局事件不再自己推导 item id。** SDK 的 tool_execution_end 不携带 args
// （event-projection.ts 只在 args !== undefined 时才把它放进 payload），而 spawn_child /
// cancel_item / add_comment 这类工具的目标**只**存在于入参里。于是终局事件上
// itemIdFromEvent 恒为 undefined，整条投影在下面那行被丢掉——卡片停在 started，界面上
// 转圈永远不停，哪怕事项其实早就 cancelled 了。create_task 侥幸没事，只因为它的分支是从
// 结果文本里回捞 id 的。
//
// 修法不是"想办法让终局也带上 args"（那要指望 SDK 的 payload 形状，改天换个 runtime 就又断），
// 而是根本不在终局重新推导：start 那一刻已经写下了一条 id 为 `${turnId}:${callId}` 的
// operation，终局只要认领它、原地改状态。查得到就用查到的，查不到才回落到推导——
// create_task 走的正是回落那一支（它 start 时还没有 id，卡片是终局才建的）。
export function projectLeadToolOperation(
  event: LeadToolCardEvent,
  resolveKnownItemId?: (operationId: string) => number | undefined,
): LeadToolOperationProjection | null {
  const name = clipped(
    String(event.payload.toolName ?? event.payload.name ?? "unknown"),
    CONVERSATION_CARD_LIMITS.operationName,
  );
  const state = stateFor(event.type);
  const operationId = operationIdOf(event);
  const itemId = (event.turnId ? resolveKnownItemId?.(operationId) : undefined)
    ?? itemIdFromEvent(event, name, state);
  if (!itemId || !event.turnId) return null;
  const labelBase = TOOL_LABELS[name] ?? name.replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase());
  return {
    itemId,
    operation: {
      id: operationId,
      name,
      state,
      label: clipped(`${labelBase} #${itemId}`, CONVERSATION_CARD_LIMITS.operationLabel),
      detail: operationDetail(name, state, itemId),
    },
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
}

function durableItemIdResolver(db: Db, event: LeadToolCardEvent) {
  return (operationId: string) => itemIdOfCardOperation(db, event.turnId, operationId);
}

export function persistLeadToolConversationCard(
  db: Db,
  event: LeadToolCardEvent,
): Extract<ConversationCard, { kind: "ticket_execution" }> | null {
  return db.transaction(() => persistLeadToolConversationCardInTransaction(db, event)).immediate();
}

function persistLeadToolConversationCardInTransaction(
  db: Db,
  event: LeadToolCardEvent,
  projection = projectLeadToolOperation(event, durableItemIdResolver(db, event)),
): Extract<ConversationCard, { kind: "ticket_execution" }> | null {
    if (!projection) return null;
    const key = `turn:${event.turnId}:ticket:${projection.itemId}`;
    const existing = getConversationCardByKey(db, key);
    const card = upsertItemExecutionCard(db, {
      turnId: event.turnId,
      itemId: projection.itemId,
      operation: projection.operation,
      now: new Date(projection.occurredAt),
    });
    const terminal = projection.operation.state === "completed"
      || projection.operation.state === "failed";
    if (!existing || terminal) {
      const eventId = `conversation-card:${createHash("sha256").update([
        key, projection.operation.id, projection.operation.state,
      ].join("\0")).digest("hex")}`;
      const alreadyPublished = db.prepare("SELECT 1 FROM gateway_events WHERE event_id = ?")
        .get(eventId);
      if (!alreadyPublished) {
        publishGatewayEvent(db, {
          eventId,
          type: "ticket.updated",
          requiredScope: "tickets:view",
          itemId: projection.itemId,
          payload: { ticketId: projection.itemId, snapshotRequired: true },
          now: new Date(projection.occurredAt),
        });
      }
    }
    return card;
}

export function persistLeadToolConversationEvent(
  db: Db,
  event: LeadToolCardEvent & { audienceBindingId?: number | null },
): {
  event: GatewayEvent;
  card: Extract<ConversationCard, { kind: "ticket_execution" }> | null;
} {
  return db.transaction(() => {
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
    const normalizedEvent = { ...event, occurredAt: occurredAt.toISOString() };
    const projection = projectLeadToolOperation(
      normalizedEvent, durableItemIdResolver(db, normalizedEvent),
    );
    const durableEvent = publishGatewayEvent(db, {
      type: event.type,
      requiredScope: "chat",
      audienceBindingId: event.audienceBindingId ?? undefined,
      turnId: event.turnId,
      itemId: projection?.itemId ?? event.itemId ?? undefined,
      payload: event.payload,
      now: occurredAt,
    });
    const card = persistLeadToolConversationCardInTransaction(db, normalizedEvent, projection);
    return { event: durableEvent, card };
  }).immediate();
}

// ——— 历史行修复 ———
//
// 上面的修法只让**今后**的终局事件落到卡片上；库里已经卡住的那些 operation 还停在
// started（真实库里 #38 已 cancelled，卡片仍在转圈）。这里把它们结算掉。
//
// **规则（不猜）**：一条仍是 started/running 的 operation，当且仅当账本里已经存在它自己那条
// 终局事件——同 turn_id、同 toolCallId 的 lead.tool.completed / lead.tool.failed——才被结算，
// 且结算成那条事件说的结果。终局事件本来就一直写着（丢掉的只是卡片投影这一层），所以这是
// 重放而不是推测。推论：
//   · 真正还在跑的调用没有终局事件，一律不动；不需要年龄阈值，也就不会误伤长任务。
//   · 只更新已有卡片，不新建、不删除。
//   · 结算完 operation 已是终态，下一次跑选不中它——幂等、可反复运行，因此挂在 daemon 启动上。
export function repairStuckLeadToolOperations(
  db: Db,
  opts: { now?: Date } = {},
): { operations: number; cards: number } {
  const stuck = db.prepare(
    `SELECT id, turn_id, item_id, payload FROM conversation_cards
     WHERE kind = 'ticket_execution' AND turn_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM json_each(payload, '$.operations')
         WHERE json_extract(value, '$.state') IN ('started', 'running')
       )
     ORDER BY id`,
  ).all() as Array<{ id: number; turn_id: string; item_id: number; payload: string }>;

  const terminalEvent = db.prepare(
    `SELECT event_type FROM gateway_events
     WHERE event_type IN ('lead.tool.completed', 'lead.tool.failed')
       AND turn_id = ? AND json_extract(payload, '$.toolCallId') = ?
     ORDER BY seq DESC LIMIT 1`,
  );

  let operations = 0;
  let cards = 0;
  for (const row of stuck) {
    const repaired = db.transaction(() => {
      const payload = JSON.parse(row.payload) as {
        operations: ItemOperationProjection[]; operationsTruncated: boolean;
      };
      let changed = 0;
      const next = payload.operations.map((operation) => {
        if (operation.state !== "started" && operation.state !== "running") return operation;
        const callId = callIdOfOperation(row.turn_id, operation.id);
        if (callId === undefined) return operation;
        const event = terminalEvent.get(row.turn_id, callId) as
          { event_type: string } | undefined;
        if (!event) return operation;
        const state: ItemOperationState = event.event_type === "lead.tool.failed"
          ? "failed"
          : "completed";
        changed++;
        return {
          ...operation,
          state,
          detail: operationDetail(operation.name, state, row.item_id),
        };
      });
      if (!changed) return 0;
      const now = (opts.now ?? new Date()).toISOString();
      db.prepare("UPDATE conversation_cards SET payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...payload, operations: next }), now, row.id);
      publishCardInvalidation(db, {
        key: `turn:${row.turn_id}:ticket:${row.item_id}`,
        itemId: row.item_id,
        operations: next,
        now: new Date(now),
      });
      return changed;
    }).immediate();
    if (repaired) {
      operations += repaired;
      cards++;
    }
  }
  return { operations, cards };
}

// operation id 是 clipped(`${turnId}:${callId}`)。截断过的 id 拿不回原始 callId，
// 所以只在"拼回去与原 id 逐字相等"时才认——认不出的一律不动，宁可少修不可修错。
function callIdOfOperation(turnId: string, operationId: string): string | undefined {
  const prefix = `${turnId}:`;
  if (!operationId.startsWith(prefix)) return undefined;
  const callId = operationId.slice(prefix.length);
  return clipped(`${turnId}:${callId}`, CONVERSATION_CARD_LIMITS.operationId) === operationId
    ? callId
    : undefined;
}

function publishCardInvalidation(
  db: Db,
  input: { key: string; itemId: number; operations: ItemOperationProjection[]; now: Date },
): void {
  for (const operation of input.operations) {
    if (operation.state !== "completed" && operation.state !== "failed") continue;
    const eventId = `conversation-card:${createHash("sha256").update([
      input.key, operation.id, operation.state,
    ].join("\0")).digest("hex")}`;
    if (db.prepare("SELECT 1 FROM gateway_events WHERE event_id = ?").get(eventId)) continue;
    publishGatewayEvent(db, {
      eventId,
      type: "ticket.updated",
      requiredScope: "tickets:view",
      itemId: input.itemId,
      payload: { ticketId: input.itemId, snapshotRequired: true },
      now: input.now,
    });
  }
}

function updateOperations(
  operations: ItemOperationProjection[],
  operation: ItemOperationProjection,
): { operations: ItemOperationProjection[]; truncated: boolean } {
  const next = [...operations];
  const index = next.findIndex((item) => item.id === operation.id);
  if (index >= 0) next[index] = operation;
  else next.push(operation);
  if (next.length <= CONVERSATION_CARD_LIMITS.maxOperations) {
    return { operations: next, truncated: false };
  }
  next.splice(1, next.length - CONVERSATION_CARD_LIMITS.maxOperations);
  return { operations: next, truncated: true };
}

export function applyLiveLeadToolEvent(
  cards: ItemExecutionProjectionCard[],
  event: LeadToolCardEvent,
): ItemExecutionProjectionCard[] {
  // 在途卡片里也要认领同一条 operation，理由与 durableItemIdResolver 一字不差：
  // 终局事件没有 args，重新推导会把这条投影整个丢掉。
  const projection = projectLeadToolOperation(event, (operationId) => cards.find(
    (card) => card.turnId === event.turnId
      && card.operations.some((operation) => operation.id === operationId),
  )?.itemId);
  if (!projection) return cards;
  const key = `turn:${event.turnId}:ticket:${projection.itemId}`;
  const index = cards.findIndex((card) => card.key === key);
  const existing = index >= 0 && cards[index]?.kind === "ticket_execution"
    ? cards[index]
    : undefined;
  const bounded = updateOperations(existing?.operations ?? [], projection.operation);
  const card: LiveItemExecutionCard = {
    id: null,
    key,
    kind: "ticket_execution",
    turnId: event.turnId,
    itemId: projection.itemId,
    operations: bounded.operations,
    operationsTruncated: (existing?.operationsTruncated ?? false) || bounded.truncated,
    createdAt: existing?.createdAt ?? projection.occurredAt,
    updatedAt: projection.occurredAt,
  };
  if (index < 0) return [...cards, card];
  const next = [...cards];
  next[index] = card;
  return next;
}

export function reconcileConversationCards(
  current: ReconciledConversationCard[],
  durableCards: ConversationCard[],
): ReconciledConversationCard[] {
  const result: ReconciledConversationCard[] = [];
  for (const card of current) {
    const duplicate = result.findIndex((item) => item.key === card.key
      || (card.id !== null && item.id === card.id));
    if (duplicate < 0) result.push(card);
    else if (card.id !== null) result[duplicate] = card;
  }

  const seenKeys = new Set<string>();
  const seenIds = new Set<number>();
  for (const durable of durableCards) {
    if (seenKeys.has(durable.key) || seenIds.has(durable.id)) continue;
    seenKeys.add(durable.key);
    seenIds.add(durable.id);
    const index = result.findIndex((card) => card.key === durable.key
      || (card.id !== null && card.id === durable.id));
    if (index >= 0) result[index] = durable;
    else result.push(durable);
  }
  return result;
}

export function conversationCardRenderId(card: ReconciledConversationCard): string {
  return `conversation-card:${card.key}`;
}

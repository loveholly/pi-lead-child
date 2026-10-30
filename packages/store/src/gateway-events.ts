// ── 投影边界 ───────────────────────────────────────────────────────────────────
// 本文件产出的是**线上**事件：字段名、事件名与 scope 名都由 packages/protocol 冻结，
// companion 正在消费，test/kernel-protocol-contract.test.ts 按字节守着。
// 内部 v16 起讲 item/run，线上仍讲 ticket/attempt——下面每一处 ticketId/ticket.*/tickets:*
// 都是**有意的映射**，不是漏改。改动任一侧都必须同时改这里。
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type GatewayEvent,
  type GatewayEventType,
  type Scope,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

interface GatewayEventRow {
  seq: number;
  event_id: string;
  event_type: GatewayEventType;
  required_scope: Scope;
  audience_binding_id: number | null;
  turn_id: string | null;
  item_id: number | null;
  payload: string;
  occurred_at: string;
}

function toEvent(row: GatewayEventRow): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: row.event_id,
    seq: row.seq,
    type: row.event_type,
    occurredAt: row.occurred_at,
    requiredScope: row.required_scope,
    audienceBindingId: row.audience_binding_id,
    turnId: row.turn_id,
    ticketId: row.item_id,   // DB item_id → 线上 ticketId

    payload: JSON.parse(row.payload || "{}"),
  };
}

export function publishGatewayEvent(
  db: Db,
  args: {
    eventId?: string;
    type: GatewayEventType;
    requiredScope: Scope;
    audienceBindingId?: number;
    turnId?: string;
    itemId?: number;
    payload: Record<string, unknown>;
    now?: Date;
  },
): GatewayEvent {
  const eventId = args.eventId ?? `evt_${randomUUID()}`;
  const occurredAt = (args.now ?? new Date()).toISOString();
  const result = db.prepare(
    `INSERT INTO gateway_events
      (event_id, event_type, required_scope, audience_binding_id, turn_id, item_id, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId, args.type, args.requiredScope, args.audienceBindingId ?? null,
    args.turnId ?? null, args.itemId ?? null, JSON.stringify(args.payload), occurredAt,
  );
  const row = db.prepare("SELECT * FROM gateway_events WHERE seq = ?")
    .get(Number(result.lastInsertRowid)) as GatewayEventRow;
  return toEvent(row);
}

export type PublishGatewayEventInput = Parameters<typeof publishGatewayEvent>[1];

export function publishGatewayEvents(
  db: Db,
  events: PublishGatewayEventInput[],
): GatewayEvent[] {
  return events.map((event) => publishGatewayEvent(db, event));
}

export function publishLeadToolCardEvents(
  db: Db,
  args: {
    type: Extract<GatewayEventType,
      "lead.tool.started" | "lead.tool.updated" | "lead.tool.completed" | "lead.tool.failed">;
    audienceBindingId: number;
    turnId: string;
    itemId?: number;
    payload: Record<string, unknown>;
    now?: Date;
  },
): GatewayEvent[] {
  return db.transaction(() => publishGatewayEvents(db, [
    {
      type: args.type,
      requiredScope: "chat",
      audienceBindingId: args.audienceBindingId,
      turnId: args.turnId,
      itemId: args.itemId,
      payload: args.payload,
      now: args.now,
    },
    ...(args.itemId === undefined ? [] : [{
      // 线上事件名与 scope 名同属冻结契约，内部改名不跟。
      type: "ticket.updated" as const,
      requiredScope: "tickets:view" as const,
      itemId: args.itemId,
      payload: { ticketId: args.itemId, snapshotRequired: true },
      now: args.now,
    }]),
  ]))();
}

// 内部只知道 itemId / runId，线上事件却必须讲 ticketId / attemptId。与其让十几个
// coordinator 调用点各写一遍这层映射（写错一处就是一条 companion 收不到的事件），
// 不如把信封收敛到这里：所有"某事项/某次运行变了，去重拉快照"的事件都从这两个函数出。
// 线上名由 protocol 冻结，改动任一侧都要同时改这里。
export function itemUpdatedEvent(itemId: number, now?: Date): PublishGatewayEventInput {
  return {
    type: "ticket.updated",
    requiredScope: "tickets:view",
    itemId,
    payload: { ticketId: itemId, snapshotRequired: true },
    now,
  };
}

export function runStartedEvent(itemId: number, runId: number, now?: Date): PublishGatewayEventInput {
  return {
    type: "attempt.started",
    requiredScope: "tickets:view",
    itemId,
    payload: { attemptId: runId, ticketId: itemId, snapshotRequired: true },
    now,
  };
}

export function runUpdatedEvent(itemId: number, runId: number, now?: Date): PublishGatewayEventInput {
  return {
    type: "attempt.updated",
    requiredScope: "tickets:view",
    itemId,
    payload: { attemptId: runId, ticketId: itemId, snapshotRequired: true },
    now,
  };
}

export function latestGatewaySeq(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM gateway_events").get() as { seq: number }).seq;
}

export function listGatewayEvents(
  db: Db,
  args: {
    afterSeq: number;
    throughSeq?: number;
    bindingId: number;
    scopes: Scope[];
    limit?: number;
  },
): GatewayEvent[] {
  if (!args.scopes.length) return [];
  const scopeParams = args.scopes.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM gateway_events
     WHERE seq > ?
       AND seq <= ?
       AND required_scope IN (${scopeParams})
       AND (audience_binding_id IS NULL OR audience_binding_id = ?)
     ORDER BY seq
     LIMIT ?`,
  ).all(
    args.afterSeq,
    args.throughSeq ?? Number.MAX_SAFE_INTEGER,
    ...args.scopes,
    args.bindingId,
    args.limit ?? 500,
  ) as GatewayEventRow[];
  return rows.map(toEvent);
}

export function listGatewayEventBatch(
  db: Db,
  args: { afterSeq: number; limit?: number },
): GatewayEvent[] {
  const rows = db.prepare(
    `SELECT * FROM gateway_events
     WHERE seq > ?
     ORDER BY seq
     LIMIT ?`,
  ).all(args.afterSeq, args.limit ?? 500) as GatewayEventRow[];
  return rows.map(toEvent);
}

// 一轮在账本里的一条事件，会话快照用它还原这一轮的工具调用（packages/protocol 的 foldTurnToolCalls）。
export interface TurnToolEventRow {
  seq: number;
  type: GatewayEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}

// 折叠一定要读的事件：工具的开始和结束，以及 lead.turn.started（daemon 重开一轮时从头算）。
// 进度事件（*.tool.updated）不读：任务卡不显示进度，读它只会让快照变慢。
const TURN_TOOL_EVENT_TYPES = [
  "lead.turn.started",
  "lead.tool.started", "lead.tool.completed", "lead.tool.failed",
  "child.tool.started", "child.tool.completed", "child.tool.failed",
] as const;

const TURN_ID_CHUNK = 400;

// 每一轮最后一条 lead.turn.started 的 payload，按轮次 id（工单 06）。daemon 用这条事件说用户的消息现在怎么放的
// （payload.placement），它已经落在账本里；会话快照读它，「下一轮回答」刷新以后和实时看到的一样，不另外存一份。
// 走 gateway_events_turn_type 索引。只给要的轮次（快照里还停在 steered 的几轮）。
export function latestTurnStartedPayloads(db: Db, turnIds: readonly string[]): Map<string, Record<string, unknown>> {
  const ids = [...new Set(turnIds)];
  const byTurn = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < ids.length; start += TURN_ID_CHUNK) {
    const chunk = ids.slice(start, start + TURN_ID_CHUNK);
    const rows = db.prepare(
      `SELECT g.turn_id, g.payload FROM gateway_events g
       JOIN (
         SELECT turn_id, MAX(seq) AS seq FROM gateway_events
         WHERE turn_id IN (${chunk.map(() => "?").join(",")}) AND event_type = 'lead.turn.started'
         GROUP BY turn_id
       ) latest ON latest.seq = g.seq`,
    ).all(...chunk) as Array<{ turn_id: string; payload: string }>;
    for (const row of rows) {
      try {
        const payload: unknown = JSON.parse(row.payload || "{}");
        if (payload && typeof payload === "object" && !Array.isArray(payload)) byTurn.set(row.turn_id, payload as Record<string, unknown>);
      } catch {
        // 读不懂的当作没有。
      }
    }
  }
  return byTurn;
}

// 每一轮里带 surface 的 Lead 工具事件（render_ui 生成的富交互卡片，protocol 的 ui-surfaces.ts），按 seq 排。
// 也带 render_ui 失败的事件：失败的调用流式中途留下的版本不显示（foldTurnSurfaces）。
// 只给读者看它有 scope 的事件，和 listTurnToolEvents 一样。
export function listTurnSurfaceEvents(
  db: Db,
  turnIds: readonly string[],
  opts: { scopes: readonly Scope[] },
): Map<string, TurnToolEventRow[]> {
  const ids = [...new Set(turnIds)];
  const byTurn = new Map<string, TurnToolEventRow[]>();
  if (!opts.scopes.length) return byTurn;
  const scopeParams = opts.scopes.map(() => "?").join(",");
  for (let start = 0; start < ids.length; start += TURN_ID_CHUNK) {
    const chunk = ids.slice(start, start + TURN_ID_CHUNK);
    const rows = db.prepare(
      `SELECT seq, event_type, turn_id, payload, occurred_at FROM gateway_events
       WHERE turn_id IN (${chunk.map(() => "?").join(",")})
         AND required_scope IN (${scopeParams}) AND json_valid(payload)
         AND ((event_type = 'lead.tool.updated' AND json_type(payload, '$.surface') = 'object')
           OR (event_type = 'lead.tool.failed' AND json_extract(payload, '$.toolName') = 'render_ui'))
       ORDER BY seq`,
    ).all(...chunk, ...opts.scopes) as Array<Pick<GatewayEventRow, "seq" | "event_type" | "turn_id" | "payload" | "occurred_at">>;
    for (const row of rows) {
      const events = byTurn.get(row.turn_id!) ?? [];
      events.push({
        seq: row.seq,
        type: row.event_type as GatewayEventType,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload || "{}") as Record<string, unknown>,
      });
      byTurn.set(row.turn_id!, events);
    }
  }
  return byTurn;
}

// 每一轮的事件，按 seq 排。
// 只给读者看它有 scope 的事件，和实时事件流（listGatewayEvents）一样：executor 的工具事件要 tickets:view。
// audience 不在这里过滤：会话快照给所有 chat binding 看全部轮次，工具调用跟着轮次走。
// 旧的工具事件没有 textOffset（上线之前写的）。只给这样的轮次再读 lead.message.delta，
// 折叠时用之前流出的文字长度算出调用在回复里的位置。
export function listTurnToolEvents(
  db: Db,
  turnIds: readonly string[],
  opts: { scopes: readonly Scope[] },
): Map<string, TurnToolEventRow[]> {
  const ids = [...new Set(turnIds)];
  const byTurn = new Map<string, TurnToolEventRow[]>();
  if (!opts.scopes.length) return byTurn;
  const legacyTurnIds = new Set<string>();
  const typeParams = TURN_TOOL_EVENT_TYPES.map(() => "?").join(",");
  const scopeParams = opts.scopes.map(() => "?").join(",");
  for (let start = 0; start < ids.length; start += TURN_ID_CHUNK) {
    const chunk = ids.slice(start, start + TURN_ID_CHUNK);
    const rows = db.prepare(
      `SELECT seq, event_type, turn_id, payload, occurred_at FROM gateway_events
       WHERE turn_id IN (${chunk.map(() => "?").join(",")}) AND event_type IN (${typeParams})
         AND required_scope IN (${scopeParams})
       ORDER BY seq`,
    ).all(...chunk, ...TURN_TOOL_EVENT_TYPES, ...opts.scopes) as Array<Pick<GatewayEventRow, "seq" | "event_type" | "turn_id" | "payload" | "occurred_at">>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload || "{}") as Record<string, unknown>;
      const turnId = row.turn_id!;
      if (row.event_type !== "lead.turn.started" && typeof payload.textOffset !== "number") legacyTurnIds.add(turnId);
      const events = byTurn.get(turnId) ?? [];
      events.push({ seq: row.seq, type: row.event_type, occurredAt: row.occurred_at, payload });
      byTurn.set(turnId, events);
    }
  }
  const legacy = [...legacyTurnIds];
  for (let start = 0; start < legacy.length; start += TURN_ID_CHUNK) {
    const chunk = legacy.slice(start, start + TURN_ID_CHUNK);
    const deltas = db.prepare(
      `SELECT seq, turn_id, occurred_at, json_extract(payload, '$.delta') AS delta FROM gateway_events
       WHERE turn_id IN (${chunk.map(() => "?").join(",")}) AND event_type = 'lead.message.delta'
         AND required_scope IN (${scopeParams})
       ORDER BY seq`,
    ).all(...chunk, ...opts.scopes) as Array<{ seq: number; turn_id: string; occurred_at: string; delta: unknown }>;
    for (const row of deltas) {
      if (typeof row.delta !== "string") continue;
      byTurn.get(row.turn_id)!.push({
        seq: row.seq, type: "lead.message.delta", occurredAt: row.occurred_at, payload: { delta: row.delta },
      });
    }
  }
  for (const turnId of legacy) byTurn.get(turnId)!.sort((left, right) => left.seq - right.seq);
  return byTurn;
}

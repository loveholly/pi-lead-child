// Lead 的等待（2026-10-19）：读写 lead_waits 表（schema.ts，v49），规则和事件在 protocol 的 lead-waits.ts。
//
//   · registerLeadWait：登记一条等待。同一个对象同时只有一条在等的：再登记时合并进那一条
//     （备注换成新的，超时取更晚的，结构化数据和 mustTell 只增不减）。
//   · settleLeadWaits：events.ts 每写入一条事件都调用它（同一个事务里）。事件是某个对象上用户的操作或状态变化时，
//     挂在这个对象上的等待了结，写一条 lead.wait_satisfied（tell 级）交给 Lead。
//   · expireLeadWaits：daemon 每一拍调用。到了超时的等待记成 expired，写一条 lead.wait_expired（tell 级）交给 Lead。
//   · purgeLeadWaits：了结超过 7 天的行删掉，表不会一直涨。
import {
  LEAD_WAIT_EXPIRED_KIND, LEAD_WAIT_LIMITS, LEAD_WAIT_SATISFIED_KIND, USER_REQUEST_EXPIRED_KIND,
  eventEndsLeadWait, isUserActionRequest, leadWaitKeysOf, type LeadWaitState, type UserActionRequest,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, appendEventGuarded, clipEventText, type EventRecord } from "./events.js";

interface LeadWaitRow {
  id: number;
  entity_key: string;
  note: string;
  origin: string;
  user_action: string | null;
  must_tell: number;
  state: LeadWaitState;
  expires_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_seq: number | null;
  resolution: string | null;
}

export interface LeadWait {
  id: number;
  entityKey: string;
  note: string;
  origin: string;
  userAction: UserActionRequest | null;
  mustTell: boolean;
  state: LeadWaitState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBySeq: number | null;
  resolution: Record<string, unknown> | null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toWait(row: LeadWaitRow): LeadWait {
  const action = parseJson(row.user_action);
  const resolution = parseJson(row.resolution);
  return {
    id: row.id,
    entityKey: row.entity_key,
    note: row.note,
    origin: row.origin,
    userAction: isUserActionRequest(action) ? action : null,
    mustTell: row.must_tell === 1,
    state: row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedBySeq: row.resolved_by_seq,
    resolution: resolution && typeof resolution === "object" && !Array.isArray(resolution)
      ? resolution as Record<string, unknown> : null,
  };
}

export function getLeadWait(db: Db, id: number): LeadWait | undefined {
  const row = db.prepare("SELECT * FROM lead_waits WHERE id = ?").get(id) as LeadWaitRow | undefined;
  return row ? toWait(row) : undefined;
}

/** 在等的等待，先登记的在前。 */
export function listOpenLeadWaits(db: Db, options: { limit?: number } = {}): LeadWait[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
  return (db.prepare("SELECT * FROM lead_waits WHERE state = 'waiting' ORDER BY id LIMIT ?").all(limit) as LeadWaitRow[])
    .map(toWait);
}

export interface RegisterLeadWaitInput {
  entityKey: string;
  note: string;
  // lead、tool:<工具名>、system:<原因>（protocol 的 lead-waits.ts）。
  origin: string;
  userAction?: UserActionRequest | null;
  mustTell?: boolean;
  // 等多久（毫秒）。缺省 LEAD_WAIT_LIMITS.defaultMs，限在 minMs 和 maxMs 之间。
  timeoutMs?: number;
  now?: Date;
}

export interface RegisteredLeadWait {
  wait: LeadWait;
  // false：这个对象上已经有一条在等的，这次合并进了那一条。
  created: boolean;
}

function boundedTimeout(ms: number | undefined): number {
  const value = ms === undefined || !Number.isFinite(ms) ? LEAD_WAIT_LIMITS.defaultMs : Math.trunc(ms);
  return Math.min(Math.max(value, LEAD_WAIT_LIMITS.minMs), LEAD_WAIT_LIMITS.maxMs);
}

/** 登记一条等待（protocol 的 lead-waits.ts）。对象键的写法由调用方检查（leadWaitKeyProblem）。 */
export function registerLeadWait(db: Db, input: RegisterLeadWaitInput): RegisteredLeadWait {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + boundedTimeout(input.timeoutMs)).toISOString();
  const note = clipEventText(input.note.trim() || "等用户的下一步", LEAD_WAIT_LIMITS.noteMaxChars);
  const action = input.userAction && isUserActionRequest(input.userAction) ? JSON.stringify(input.userAction) : null;
  return db.transaction((): RegisteredLeadWait => {
    const open = db.prepare("SELECT * FROM lead_waits WHERE entity_key = ? AND state = 'waiting'")
      .get(input.entityKey) as LeadWaitRow | undefined;
    if (open) {
      db.prepare(
        `UPDATE lead_waits SET note = ?, origin = ?, user_action = COALESCE(?, user_action),
           must_tell = MAX(must_tell, ?), expires_at = MAX(expires_at, ?), updated_at = ?
         WHERE id = ?`,
      ).run(note, input.origin, action, input.mustTell ? 1 : 0, expiresAt, at, open.id);
      return { wait: getLeadWait(db, open.id)!, created: false };
    }
    const id = Number(db.prepare(
      `INSERT INTO lead_waits (entity_key, note, origin, user_action, must_tell, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.entityKey, note, input.origin, action, input.mustTell ? 1 : 0, expiresAt, at, at).lastInsertRowid);
    return { wait: getLeadWait(db, id)!, created: true };
  }).immediate();
}

/** Lead 取消一条等待（不再等了）。不在等的返回 false。 */
export function cancelLeadWait(db: Db, id: number, args: { reason: string; now?: Date }): boolean {
  const at = (args.now ?? new Date()).toISOString();
  return db.prepare(
    `UPDATE lead_waits SET state = 'cancelled', resolved_at = ?, updated_at = ?, resolution = ?
     WHERE id = ? AND state = 'waiting'`,
  ).run(at, at, JSON.stringify({ reason: clipEventText(args.reason, 300) }), id).changes > 0;
}

/** 一条事件的一句话说明（了结等待时告诉 Lead 发生了什么）。 */
export function leadWaitTriggerSummary(event: Pick<EventRecord, "kind" | "payload">): string {
  const payload = event.payload;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  if (event.kind === "stage.changed") {
    return `stage ${String(payload.from)} → ${String(payload.to)}（${String(payload.actor ?? "")}${text(payload.reason) ? `：${text(payload.reason)}` : ""}）`;
  }
  if (event.kind === "user.message") return `用户发来一条消息：${clipEventText(String(payload.text ?? ""), 160)}`;
  if (event.kind === "event.acknowledged") return `用户确认了事件 #${String(payload.acknowledgedSeq)}（${String(payload.acknowledgedKind)}）`;
  return clipEventText(text(payload.summary) ?? text(payload.title) ?? text(payload.note) ?? event.kind, 300);
}

function waitPayload(wait: LeadWait): Record<string, unknown> {
  return {
    waitId: wait.id,
    waitedKey: wait.entityKey,
    note: wait.note,
    origin: wait.origin,
    mustTell: wait.mustTell,
    waitingSince: wait.createdAt,
    userAction: wait.userAction,
  };
}

/**
 * 一条事件刚写进日志（events.ts 的 insertPrepared 调用，在写入方的事务里）：它是某个对象上用户的操作或状态变化时，
 * 挂在这些对象上的等待了结，各写一条 lead.wait_satisfied。返回了结了几条。
 * 了结的事件自己不再了结别的等待（它的类型没有 waitSignal），所以不会递归。
 */
export function settleLeadWaits(db: Db, event: EventRecord): number {
  if (!eventEndsLeadWait(event)) return 0;
  const keys = leadWaitKeysOf(event);
  const rows = db.prepare(
    `SELECT * FROM lead_waits WHERE state = 'waiting' AND entity_key IN (${keys.map(() => "?").join(", ")}) ORDER BY id`,
  ).all(...keys) as LeadWaitRow[];
  if (!rows.length) return 0;
  const summary = leadWaitTriggerSummary(event);
  for (const row of rows) {
    const wait = toWait(row);
    const covered = wait.mustTell ? undefined : coveringEvent(db, wait, event);
    db.prepare(
      `UPDATE lead_waits SET state = 'satisfied', resolved_at = ?, resolved_by_seq = ?, updated_at = ?, resolution = ?
       WHERE id = ? AND state = 'waiting'`,
    ).run(event.receivedAt, event.seq, event.receivedAt, JSON.stringify({ kind: event.kind, summary }), wait.id);
    appendEvent(db, {
      source: "system",
      sourceRef: `lead_wait:${wait.id}:satisfied`,
      kind: LEAD_WAIT_SATISFIED_KIND,
      entityKey: wait.entityKey,
      causationId: event.eventId,
      // 已经有一条要交给 Lead 的事件在说这件事（例如写入确认的结果）：等待照样了结，但只记一笔，不再叫醒一次。
      level: covered ? "record" : "tell",
      payload: {
        ...waitPayload(wait),
        trigger: { seq: event.seq, kind: event.kind, entityKey: event.entityKey, summary },
        coveredBySeq: covered ?? null,
      },
    });
  }
  return rows.length;
}

// 系统自己的通路刚为同一件事写了一条会交给 Lead 的说明（例如写入确认有了结果，daemon 写一条带结果的 inbox）：
// 挂在等待的对象上、是 inbox 的事件（系统专门叫醒 Lead 的通路都写 inbox）、tell 或 interrupt 级、Lead 还没处理（没有处置）、
// 在了结之前 COVER_WINDOW_MS 以内、并且在 Lead 最近一次说「我在等」之后写的。返回那一条的序号；没有时返回 undefined。
// 别的事件不算：主人操作也是 interrupt 级，但 Lead 收不到它（lead-input.ts 对它是 skip）；Lead 处理过的说的是别的事。
//
// 「之后」的界线是等待最近一次登记的时间（updated_at：登记或合并，在等的行只有这两处改它），不是第一次登记的时间。
// 登记以前写的说明讲的是 Lead 说在等时的局面，常常就是引起等待的那一条（授权失效、要用户确认）：它说的是出了问题，
// 不是用户做完了，不能代替了结（2026-10-20：connection-attention 先写说明再登记等待，两次写入落在同一毫秒时，
// 以前的 >= 把这条说明算了进去，用户重新授权只记一笔，Lead 没醒）。
// 时间只精确到毫秒：和登记落在同一毫秒的说明算作登记以前。分不清时宁可多叫醒 Lead 一次，也不漏掉。
const COVER_WINDOW_MS = 10 * 60_000;
const COVERING_KINDS = ["inbox.attention", "inbox.blocker"] as const;

function coveringEvent(db: Db, wait: LeadWait, trigger: EventRecord): number | undefined {
  const windowStart = new Date(Date.parse(trigger.receivedAt) - COVER_WINDOW_MS).toISOString();
  const row = db.prepare(
    `SELECT seq FROM events
     WHERE entity_key = ? AND kind IN (?, ?) AND level IN ('tell', 'interrupt') AND disposition IS NULL
       AND received_at > ? AND received_at >= ? AND seq <> ?
     ORDER BY seq DESC LIMIT 1`,
  ).get(wait.entityKey, ...COVERING_KINDS, wait.updatedAt, windowStart, trigger.seq) as { seq: number } | undefined;
  return row?.seq;
}

/** 到了超时还在等的：记成 expired，各写一条 lead.wait_expired 交给 Lead。返回超时了几条。 */
export function expireLeadWaits(db: Db, now: Date = new Date()): number {
  const at = now.toISOString();
  const due = db.prepare("SELECT * FROM lead_waits WHERE state = 'waiting' AND expires_at <= ? ORDER BY id")
    .all(at) as LeadWaitRow[];
  for (const row of due) {
    const wait = toWait(row);
    db.transaction(() => {
      const changed = db.prepare(
        `UPDATE lead_waits SET state = 'expired', resolved_at = ?, updated_at = ?, resolution = ?
         WHERE id = ? AND state = 'waiting'`,
      ).run(at, at, JSON.stringify({ reason: "timeout" }), wait.id).changes;
      if (!changed) return;
      appendEvent(db, {
        source: "timer",
        sourceRef: `lead_wait:${wait.id}:expired`,
        kind: LEAD_WAIT_EXPIRED_KIND,
        entityKey: wait.entityKey,
        occurredAt: wait.expiresAt,
        level: "tell",
        payload: { ...waitPayload(wait), expiresAt: wait.expiresAt },
      });
    }).immediate();
  }
  return due.length;
}

/** 删掉了结超过 keepMs 的行。返回删了几行。 */
export function purgeLeadWaits(db: Db, now: Date = new Date(), keepMs: number = LEAD_WAIT_LIMITS.keepResolvedMs): number {
  const cutoff = new Date(now.getTime() - keepMs).toISOString();
  return db.prepare("DELETE FROM lead_waits WHERE state <> 'waiting' AND resolved_at IS NOT NULL AND resolved_at < ?")
    .run(cutoff).changes;
}

/**
 * 一个等用户回答的请求过期了（决定请求、连接的写入确认）：记一条 user_request.expired（record 级）。
 * 没人在等时只是日志；Lead 在等这个对象（或者它挂的工单）时，等待了结，Lead 被叫醒。
 * 双写的调用点（决定请求过期在 engine 的事务里）用 guarded：事件本身出错不回滚原来的写入。
 */
export function recordUserRequestExpired(db: Db, input: {
  entityKey: string; requestKind: "decision" | "connection_confirmation"; requestId: string; summary: string; itemId?: number | null;
  at?: Date;
}): void {
  db.transaction(() => appendEventGuarded(db, () => ({
    source: "system",
    sourceRef: `user_request:${input.entityKey}:expired`,
    kind: USER_REQUEST_EXPIRED_KIND,
    entityKey: input.entityKey,
    ...(input.at ? { occurredAt: input.at.toISOString() } : {}),
    level: "record",
    payload: {
      requestKind: input.requestKind, requestId: input.requestId, summary: clipEventText(input.summary, 500),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    },
  })))();
}

// 事件日志（Lead 事件主干 spec D1、D2、D5，工单 01）。表在 schema.ts 的 EVENTS_SCHEMA。
//
// 所有输入都是事件，写进 events 这条只追加的日志，再经过分诊得到级别，最后要有处置。
// 第 1 期只接内部来源，用「双写」：原来的写入点不变，同时在同一个事务里写一条事件。写入点在 store 层的
// 写入函数里（inbox.ts、notifications.ts、checkpoints.ts、items.ts 的 transition、runs.ts 的 updateRun、
// conversations.ts），定时器到点在 reminders.ts 的 fireReminder 和 inbox.ts 的 recordDueLeadFollowUps。
//
// 规则：
//   - appendEvent 只能在调用方的事务里调用：事件和它引起的状态变化一起提交，一起回滚。
//   - 去重只认「同一次投递」：同一个 (source, source_ref) 只记一条，重复时返回已有的那一行。
//   - 未注册的 kind 报错；失败事件没有 root_cause 报错（packages/protocol 的 events.ts）。
//   - 级别由分诊定：event-triage.ts 按常设指令定级别，依据写进 triage 列（工单 05）。setEventTriage 可以换掉它（测试用）。
//     规则直接处理掉的事件（按根因合并）在写入时就带上处置和依据。
//   - 双写的调用点用 appendEventGuarded：双写阶段（spec D15）事件日志还不是事实来源，事件本身的问题
//     （构造信封出错、类型没注册、校验不过、分诊出错）不能让原来的写入回滚。它改记一条 system.event_rejected。
//     SQL 的错误照常抛出，和原写入一起回滚。appendEvent 本身仍是严格模式。
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  ENTITY_KEY_PATTERN, EVENT_DISPOSITIONS, EVENT_LEVELS, eventKindDefinition, eventRequiresRootCause,
  SECURITY_ALERT_EVENT_KINDS, validateEventEnvelope,
  type EventDisposition, type EventEnvelope, type EventLevel, type EventSource, type RootCause, type TriageBasis,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { triageEvent, type EventTriage, type TriageDecision } from "./event-triage.js";
import { noteEventAppended } from "./event-notify.js";
import { settleLeadWaits } from "./lead-waits.js";

export interface EventRecord {
  seq: number;
  eventId: string;
  source: EventSource;
  sourceRef: string | null;
  kind: string;
  entityKey: string;
  entityVersion: number | null;
  occurredAt: string;
  receivedAt: string;
  causationId: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
  rootCause: RootCause | null;
  level: EventLevel | null;
  disposition: EventDisposition | null;
  dispositionDetail: Record<string, unknown> | null;
  disposedAt: string | null;
  // 级别的依据：哪条常设指令的哪一版（工单 05）。写入方自己给了级别、或者 v44 之前写的事件，是 null。
  triage: TriageBasis | null;
}

export interface AppendEventResult {
  event: EventRecord;
  // false：同一个 (source, source_ref) 已经记过，返回的是已有的那一行。
  inserted: boolean;
}

export interface ListEventsQuery {
  // 只要 seq 大于它的事件（游标）。
  sinceSeq?: number;
  // 只要 seq 小于它的事件（从新到旧往前翻页，Lead 的 query_events 用）。
  beforeSeq?: number;
  entityKey?: string;
  kind?: string | readonly string[];
  // 类型的前缀，例如 run. 匹配 run.started、run.failed……（Lead 的 query_events 写 run.*）。
  kindPrefix?: string;
  // 跳过这些序号区间（[起, 止]，两头都含）。Lead 的事件游标跳过已经处理完的区间（工单 14）。
  excludeRanges?: ReadonlyArray<readonly [number, number]>;
  level?: EventLevel | readonly EventLevel[];
  // 缺省 100，最多 1000。
  limit?: number;
  // 缺省 asc（从旧到新，游标读取用）；desc 从新到旧（按需查看用）。
  order?: "asc" | "desc";
}

// 没有处置的事件的时限（spec D3：digest 最长 30 分钟处理一次）。不变量测试和 05 的升级按它判断超时。
export const UNDISPOSED_EVENT_DEADLINE_MS = 30 * 60_000;

interface EventRow {
  seq: number; event_id: string; source: string; source_ref: string | null; kind: string;
  entity_key: string; entity_version: number | null; occurred_at: string; received_at: string;
  causation_id: string | null; correlation_id: string | null; payload: string; root_cause: string | null;
  level: string | null; disposition: string | null; disposition_detail: string | null; disposed_at: string | null;
  triage: string | null;
}

function parseObject(serialized: string | null): Record<string, unknown> | null {
  if (serialized === null) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseEvent(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    eventId: row.event_id,
    source: row.source as EventSource,
    sourceRef: row.source_ref,
    kind: row.kind,
    entityKey: row.entity_key,
    entityVersion: row.entity_version,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    payload: parseObject(row.payload) ?? {},
    rootCause: parseObject(row.root_cause) as RootCause | null,
    level: row.level as EventLevel | null,
    disposition: row.disposition as EventDisposition | null,
    dispositionDetail: parseObject(row.disposition_detail),
    disposedAt: row.disposed_at,
    triage: parseObject(row.triage) as TriageBasis | null,
  };
}

// UUIDv7（RFC 9562）：前 48 位是毫秒时间戳，接着 12 位是同一毫秒内的计数，所以同一个进程里生成的编号按时间递增。
let lastMs = 0;
let counter = 0;
function uuidv7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = 0;
  } else if (++counter > 0xfff) {
    lastMs += 1;
    counter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 预先取一个事件编号（UUIDv7）：调用方要在写事件之前用到它（例如主人操作的通知要带上它，工单 15）。 */
export function newEventId(): string {
  return uuidv7();
}

// 每个库用哪个分诊。没装时按常设指令分诊（event-triage.ts 的 triageEvent）。测试可以换成别的。
const triages = new WeakMap<Db, EventTriage>();

export function setEventTriage(db: Db, triage: EventTriage | null): void {
  if (triage) triages.set(db, triage);
  else triages.delete(db);
}

// 写入分两步。第一步准备：去重查询、补时间、分诊、校验，可能抛错，但不写库。第二步插入：只执行 INSERT。
// appendEventGuarded 只接第一步的错误，第二步（SQL）的错误照常抛出。
type PreparedEvent =
  | { existing: EventRecord }
  | { existing?: undefined; envelope: EventEnvelope; occurredAt: string; receivedAt: string;
      payload: Record<string, unknown>; decision: TriageDecision };

/** appendEvent 的选项。只给系统自己生成的事件用（例如 05 的升级）。 */
export interface AppendEventOptions {
  // 写入方给了级别时，它的依据（哪条常设指令）。
  basis?: TriageBasis | null;
  // 收到的时间。缺省是现在；按注入的时钟运行的规则（升级）用它们自己的时间。
  receivedAt?: Date;
}

function assertInTransaction(db: Db, kind: string): void {
  if (!db.inTransaction) {
    throw new Error(`appendEvent(${kind}) must run inside the caller's transaction, with the write it records`);
  }
}

function asDecision(result: EventLevel | TriageDecision): TriageDecision {
  return typeof result === "string" ? { level: result, basis: null } : result;
}

function prepareEvent(db: Db, envelope: EventEnvelope, options: AppendEventOptions = {}): PreparedEvent {
  if (!eventKindDefinition(envelope.kind)) throw new Error(`appendEvent: event kind ${envelope.kind} 没有注册`);
  if (envelope.sourceRef) {
    const existing = db.prepare("SELECT * FROM events WHERE source = ? AND source_ref = ?")
      .get(envelope.source, envelope.sourceRef) as EventRow | undefined;
    if (existing) return { existing: parseEvent(existing) };
  }
  const receivedAt = (options.receivedAt ?? new Date()).toISOString();
  // 时间统一存成 ISO。解析不了的原样留着，下面的校验会报错。
  const occurredAt = envelope.occurredAt === undefined ? receivedAt
    : Number.isNaN(Date.parse(envelope.occurredAt)) ? envelope.occurredAt
    : new Date(envelope.occurredAt).toISOString();
  const triageInput = { ...envelope, occurredAt, payload: envelope.payload ?? {} };
  // 用户自己发给 Lead 的消息不经过分诊（spec D3）。写入方给了级别时用它的。
  const override = triages.get(db);
  const decision: TriageDecision = envelope.source === "user"
    ? { level: "conversation", basis: null }
    : envelope.level ? { level: envelope.level, basis: options.basis ?? null }
    : asDecision(override ? override(triageInput) : triageEvent(db, triageInput));
  const errors = validateEventEnvelope(triageInput, decision.level);
  if (errors.length) throw new Error(`appendEvent(${envelope.kind}): ${errors.join("；")}`);
  if (decision.disposition !== undefined && !(EVENT_DISPOSITIONS as readonly string[]).includes(decision.disposition)) {
    throw new Error(`appendEvent(${envelope.kind}): 分诊给的处置 ${decision.disposition} 不是已知的处置`);
  }
  return { envelope, occurredAt, receivedAt, payload: triageInput.payload, decision };
}

function insertPrepared(db: Db, prepared: PreparedEvent): AppendEventResult {
  if (prepared.existing) return { event: prepared.existing, inserted: false };
  const { envelope, decision } = prepared;
  // 规则直接处理掉的事件（按根因合并）写入时就有处置，处置的时间就是收到的时间。
  const disposed = decision.disposition !== undefined;
  const result = db.prepare(
    `INSERT INTO events (
       event_id, source, source_ref, kind, entity_key, entity_version, occurred_at, received_at,
       causation_id, correlation_id, payload, root_cause, level, triage, disposition, disposition_detail, disposed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    envelope.eventId ?? uuidv7(), envelope.source, envelope.sourceRef ?? null, envelope.kind, envelope.entityKey,
    envelope.entityVersion ?? null, prepared.occurredAt, prepared.receivedAt, envelope.causationId ?? null,
    envelope.correlationId ?? null, JSON.stringify(prepared.payload),
    envelope.rootCause ? JSON.stringify(envelope.rootCause) : null, decision.level,
    decision.basis ? JSON.stringify(decision.basis) : null,
    disposed ? decision.disposition : null,
    disposed && decision.dispositionDetail ? JSON.stringify(decision.dispositionDetail) : null,
    disposed ? prepared.receivedAt : null,
  );
  // 进程内的订阅方（daemon 的 Lead 输入，工单 04）在事务提交以后才读到它（event-notify.ts）。
  noteEventAppended(db);
  const event = getEvent(db, Number(result.lastInsertRowid))!;
  settleWaitsFor(db, event);
  return { event, inserted: true };
}

// 这条事件了结了 Lead 的等待时，在同一个事务里写 lead.wait_satisfied（lead-waits.ts）：和引起它的写入一起提交、一起回滚。
// 了结的过程出了 SQL 以外的错（例如构造的事件校验不过），只回滚这一步（保存点），原来的写入照常提交，
// 错误写进日志：等待还在，到了超时照样交给 Lead，不会悄悄丢掉。SQL 的错误照常抛出。
function settleWaitsFor(db: Db, event: EventRecord): void {
  try {
    db.transaction(() => settleLeadWaits(db, event))();
  } catch (error) {
    // v49 之前的库还没有 lead_waits（openDb 的迁移在建表之前写事件时）：没有等待可了结。
    if (error instanceof Database.SqliteError && /no such table: lead_waits/u.test(error.message)) return;
    if (error instanceof Database.SqliteError) throw error;
    console.error(`[events] settling Lead's waits for event #${event.seq} (${event.kind}) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 严格模式：任何错误都抛出，调用方的事务随之回滚。04、05 和测试用它。 */
export function appendEvent(db: Db, envelope: EventEnvelope, options: AppendEventOptions = {}): AppendEventResult {
  assertInTransaction(db, envelope.kind);
  return insertPrepared(db, prepareEvent(db, envelope, options));
}

export const EVENT_REJECTED_KIND = "system.event_rejected";
const REJECTED_ENTITY_KEY = "system:event-rejected";

// 被拒的事件改记成这一条：级别 digest，所以它会出现在「没有处置的事件」里，不会悄悄丢掉。
// 原事件有投递编号时，同一次投递被拒也只记一条（例如每一拍都重试的跟进到点）。
function rejectedEnvelope(original: EventEnvelope | undefined, error: unknown): EventEnvelope {
  const entityKey = typeof original?.entityKey === "string" && ENTITY_KEY_PATTERN.test(original.entityKey)
    ? original.entityKey : REJECTED_ENTITY_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return {
    source: "system",
    sourceRef: original?.sourceRef && typeof original.source === "string"
      ? `rejected:${original.source}:${original.sourceRef}` : null,
    kind: EVENT_REJECTED_KIND,
    entityKey,
    level: "digest",
    payload: {
      rejectedKind: typeof original?.kind === "string" ? original.kind : null,
      rejectedSource: typeof original?.source === "string" ? original.source : null,
      rejectedSourceRef: typeof original?.sourceRef === "string" ? original.sourceRef : null,
      entityKey: typeof original?.entityKey === "string" ? original.entityKey : null,
      error: clipEventText(message),
    },
  };
}

/**
 * 双写的调用点用这个（spec D15 的双写阶段）。build 构造信封；构造、注册、校验、分诊里的错误都接住，
 * 改记一条 system.event_rejected，原来的写入照常提交。SQL 的错误（包括 build 里读库出错）照常抛出，和原写入一起回滚。
 */
export function appendEventGuarded(db: Db, build: () => EventEnvelope, options: AppendEventOptions = {}): AppendEventResult {
  assertInTransaction(db, "guarded");
  let envelope: EventEnvelope | undefined;
  let prepared: PreparedEvent;
  try {
    envelope = build();
    prepared = prepareEvent(db, envelope, options);
  } catch (error) {
    if (error instanceof Database.SqliteError) throw error;
    prepared = prepareEvent(db, rejectedEnvelope(envelope, error));
  }
  return insertPrepared(db, prepared);
}

export function getEvent(db: Db, seq: number): EventRecord | undefined {
  const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as EventRow | undefined;
  return row ? parseEvent(row) : undefined;
}

function eventsWhere(query: Omit<ListEventsQuery, "limit" | "order">): { sql: string; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  if (query.sinceSeq !== undefined) { where.push("seq > ?"); values.push(query.sinceSeq); }
  if (query.beforeSeq !== undefined) { where.push("seq < ?"); values.push(query.beforeSeq); }
  if (query.entityKey !== undefined) { where.push("entity_key = ?"); values.push(query.entityKey); }
  // 前缀按区间比较（kind >= p AND kind < p 加最大字符），用得上 events_kind 索引，也不用转义 LIKE 的通配符。
  if (query.kindPrefix !== undefined) {
    where.push("kind >= ? AND kind < ?");
    values.push(query.kindPrefix, `${query.kindPrefix}\uffff`);
  }
  const inList = (column: string, value: string | readonly string[]) => {
    const list = typeof value === "string" ? [value] : [...value];
    if (!list.length) { where.push("0"); return; }
    where.push(`${column} IN (${list.map(() => "?").join(", ")})`);
    values.push(...list);
  };
  if (query.kind !== undefined) inList("kind", query.kind);
  if (query.level !== undefined) inList("level", query.level);
  for (const [from, to] of query.excludeRanges ?? []) {
    where.push("seq NOT BETWEEN ? AND ?");
    values.push(from, to);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", values };
}

export function listEvents(db: Db, query: ListEventsQuery = {}): EventRecord[] {
  const { sql, values } = eventsWhere(query);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000);
  const order = query.order === "desc" ? "DESC" : "ASC";
  return (db.prepare(`SELECT * FROM events${sql} ORDER BY seq ${order} LIMIT ?`).all(...values, limit) as EventRow[]).map(parseEvent);
}

/** 符合条件的事件有几条（条件同 listEvents，不分页）。 */
export function countEvents(db: Db, query: Omit<ListEventsQuery, "limit" | "order"> = {}): number {
  const { sql, values } = eventsWhere(query);
  return (db.prepare(`SELECT COUNT(*) AS n FROM events${sql}`).get(...values) as { n: number }).n;
}

/** 事件日志现在的最大 seq（没有事件时是 0）。 */
export function maxEventSeq(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
}

/**
 * 「Lead 动态」显示的事件（spec D10，工单 06）：digest、auto 级的事件，和常设指令的修改（standing_order.changed）。
 * 级别写入时就定了，所以一条事件在不在里面不会变。只看 seq 大于 afterSeq 的（调用方用它限定扫描的范围），
 * 取最新的 limit 条，从旧到新返回。record 级只进时间轴和工单详情，interrupt 级在横幅上，都不在这里。
 * 外部来源的消息（工单 11）带着通道定的投递方式（payload.channelDelivery）：摘要投递的在这里显示；
 * 会话卡、推送加会话卡的有自己的通道卡，只记录的不显示，这里都不放，免得同一条消息说两遍。
 */
// 提醒推满了次数还没确认（reminder.unacknowledged，digest 级，工单 07）不在这里：会话里那张提醒卡已经写着它，
// 再列一张「摘要」卡就说了两遍。它照样进 Lead 的摘要（回来简报）。
export function listLeadActivityEvents(db: Db, query: { afterSeq: number; limit: number }): EventRecord[] {
  return (db.prepare(
    `SELECT * FROM events
     WHERE seq > ? AND (level IN ('digest', 'auto') OR kind = 'standing_order.changed')
       AND COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.channelDelivery') END, 'digest') = 'digest'
       AND kind <> 'reminder.unacknowledged'
     ORDER BY seq DESC LIMIT ?`,
  ).all(query.afterSeq, Math.max(1, Math.trunc(query.limit))) as EventRow[]).map(parseEvent).reverse();
}

/** 同一件事（correlation_id）最新的一条事件。走 events_correlation 索引。 */
export function latestCorrelatedEvent(db: Db, correlationId: string): EventRecord | undefined {
  const row = db.prepare("SELECT * FROM events WHERE correlation_id = ? ORDER BY seq DESC LIMIT 1")
    .get(correlationId) as EventRow | undefined;
  return row ? parseEvent(row) : undefined;
}

/** 一个对象上某一类事件里最新的一条（例如这个写入确认上的 owner_action.performed）。 */
export function latestEntityEvent(db: Db, entityKey: string, kind: string): EventRecord | undefined {
  const row = db.prepare("SELECT * FROM events WHERE entity_key = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
    .get(entityKey, kind) as EventRow | undefined;
  return row ? parseEvent(row) : undefined;
}

/** interrupt 级的事件（工单 06 的横幅）：seq 大于 afterSeq 的最新 limit 条，从旧到新。 */
// 主人操作的提醒（工单 15，owner_action.*）也是 interrupt 级，但它有自己的会话卡和「不是我」，
// 并且发起操作的那个客户端只显示一行记录。这里不放它们，免得横幅把同一件事再说一遍。
// 安全报警（2026-10-19 审查，security-alerts.ts）同理：daemon 直接贴会话卡、推送，收件箱里有通知，横幅不再说一遍。
export function listInterruptEvents(db: Db, query: { afterSeq: number; limit: number }): EventRecord[] {
  const securityKinds = SECURITY_ALERT_EVENT_KINDS.map((definition) => definition.kind);
  return (db.prepare(
    `SELECT * FROM events WHERE seq > ? AND level = 'interrupt' AND kind NOT LIKE 'owner\\_action.%' ESCAPE '\\'
       AND kind NOT IN (${securityKinds.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT ?`,
  ).all(query.afterSeq, ...securityKinds, Math.max(1, Math.trunc(query.limit))) as EventRow[]).map(parseEvent).reverse();
}

/**
 * 没有处置的事件（spec D5 的不变量）：级别不是 record、没有处置、并且在 olderThan 之前收到。
 * 正常运行时，olderThan 取「现在减去时限」，结果必须为空。
 */
export function listUndisposedEvents(db: Db, query: { olderThan: Date | string; limit?: number }): EventRecord[] {
  const cutoff = typeof query.olderThan === "string" ? new Date(query.olderThan).toISOString() : query.olderThan.toISOString();
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 1000), 1), 10_000);
  return (db.prepare(
    `SELECT * FROM events
     WHERE disposition IS NULL AND level IS NOT NULL AND level <> 'record' AND received_at < ?
     ORDER BY seq LIMIT ?`,
  ).all(cutoff, limit) as EventRow[]).map(parseEvent);
}

function assertDisposition(disposition: string): asserts disposition is EventDisposition {
  if (!(EVENT_DISPOSITIONS as readonly string[]).includes(disposition)) {
    throw new Error(`unknown event disposition ${disposition}（可用：${EVENT_DISPOSITIONS.join("、")}）`);
  }
}

/** 记一个事件的处置。已有处置时覆盖（Lead 可以改口）。返回有没有这一行。 */
export function setEventDisposition(
  db: Db, seq: number, disposition: EventDisposition, detail: Record<string, unknown> | null = null, at: Date = new Date(),
): boolean {
  assertDisposition(disposition);
  return db.prepare(
    "UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ? WHERE seq = ?",
  ).run(disposition, detail ? JSON.stringify(detail) : null, at.toISOString(), seq).changes > 0;
}

/** 改一个事件的级别（05 的分诊和超时升级用）。异常升到 tell、interrupt 时必须已有根因。返回有没有这一行。 */
export function setEventLevel(db: Db, seq: number, level: EventLevel): boolean {
  if (!(EVENT_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`unknown event level ${level}（可用：${EVENT_LEVELS.join("、")}）`);
  }
  const row = db.prepare("SELECT kind, root_cause FROM events WHERE seq = ?").get(seq) as
    { kind: string; root_cause: string | null } | undefined;
  if (!row) return false;
  if (eventRequiresRootCause(row.kind, level) && !row.root_cause) {
    throw new Error(`event #${seq}（${row.kind}）没有 root_cause，不能升到 ${level}`);
  }
  return db.prepare("UPDATE events SET level = ? WHERE seq = ?").run(level, seq).changes > 0;
}

/**
 * 给同一件事的所有事件记处置：correlation_id 指向承载这件事的那一行（inbox:<id>、notification:<id>）。
 * onlyUndisposed（缺省 true）时只改还没有处置的。返回改了几条。
 */
export function disposeCorrelatedEvents(
  db: Db, correlationId: string, disposition: EventDisposition,
  detail: Record<string, unknown> | null = null, options: { onlyUndisposed?: boolean; at?: Date } = {},
): number {
  assertDisposition(disposition);
  const onlyUndisposed = options.onlyUndisposed ?? true;
  return db.prepare(
    `UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ?
     WHERE correlation_id = ?${onlyUndisposed ? " AND disposition IS NULL" : ""}`,
  ).run(disposition, detail ? JSON.stringify(detail) : null, (options.at ?? new Date()).toISOString(), correlationId).changes;
}

/** 一个 item 的对象键：提醒是 reminder:<id>，工单是 ticket:<id>。 */
export function itemEntityKey(db: Db, itemId: number): string {
  const row = db.prepare("SELECT kind FROM items WHERE id = ?").get(itemId) as { kind: string } | undefined;
  return `${row?.kind === "reminder" ? "reminder" : "ticket"}:${itemId}`;
}

/** 这个对象下一个版本号：比日志里已有的最大版本大 1。调用方已经在写事务里，读到的就是最新的。 */
export function nextEntityVersion(db: Db, entityKey: string): number {
  const row = db.prepare("SELECT MAX(entity_version) AS v FROM events WHERE entity_key = ?").get(entityKey) as { v: number | null };
  return (row.v ?? 0) + 1;
}

/** 截断给事件用的长文本（证据、错误原文），注明截掉了多少。 */
export function clipEventText(text: string, max = 2_000): string {
  return text.length > max ? `${text.slice(0, max)}…（截断了 ${text.length - max} 字）` : text;
}

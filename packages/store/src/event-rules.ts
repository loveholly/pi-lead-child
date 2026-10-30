// 和时间有关的事件规则（Lead 事件主干 spec D3、D5，工单 05）：到时限升级、摘要按批。
//
//   - escalateOverdueEvents：到时限（UNDISPOSED_EVENT_DEADLINE_MS）还没有处置的事件升一级（常设指令 events.escalate_overdue）。
//     原事件记成 superseded，另写一条 event.escalated，带着更高的级别：按游标读日志的人（工单 04）读得到新的那一条，
//     「没有处置的事件」这个不变量也不再算原事件。升到哪一级先看给原事件定级别的那条指令的 escalateTo，
//     没有依据时按 ladder；不超过来源的打断阈值（source.*）。scheduler 每一拍调用。
//   - dueDigestBatch：现在该不该为摘要叫醒 Lead、有哪些事件（常设指令 events.digest_batch）。只读，不写库。
//     真正叫醒 Lead、把内容交给 Lead 的是工单 04；这一批的回合成功以后，04 调 markEventsDigested 记处置。
import {
  capTriageLevel, isTriageLevel, triageLevelRank,
  type EventLevel, type StandingOrderRef, type TriageLevel,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import {
  appendEvent, clipEventText, getEvent, setEventDisposition, UNDISPOSED_EVENT_DEADLINE_MS, type EventRecord,
} from "./events.js";
import { isInternalEventSource } from "./event-triage.js";
import { activeStandingOrders, ruleStandingOrder, sourceThreshold, standingOrderRef } from "./standing-orders.js";

export const EVENT_ESCALATED_KIND = "event.escalated";

interface EventRow { seq: number }

const eventsBySeq = (db: Db, seqs: readonly number[]): EventRecord[] =>
  seqs.map((seq) => getEvent(db, seq)).filter((event): event is EventRecord => event !== undefined);

/** 按根因合并进这一条的事件（它们的 triage.mergedInto 是这一条的 seq），从旧到新。 */
export function listRootCauseMerged(db: Db, seq: number): EventRecord[] {
  const rows = db.prepare(
    `SELECT seq FROM events WHERE json_valid(triage) AND json_extract(triage, '$.mergedInto') = ? ORDER BY seq`,
  ).all(seq) as EventRow[];
  return eventsBySeq(db, rows.map((row) => row.seq));
}

// 一句话说明这个事件是什么：给升级的事件用，Lead 不用再查原事件也知道是哪件事。
function eventSummary(event: EventRecord): string {
  const payload = event.payload;
  for (const key of ["summary", "title", "note", "text", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return clipEventText(value.trim(), 300);
  }
  return `${event.kind} ${event.entityKey}`;
}

// ── 到时限升级 ──────────────────────────────────────────────────────────────────────

export interface EventEscalation {
  seq: number;
  escalatedSeq: number;
  from: EventLevel;
  to: TriageLevel;
}

// 升到哪一级：给它定级别的那条指令（现在的版本）的 escalateTo；没写，或者没有依据（写入方给的级别、v44 之前的事件）时
// 按 ladder。不超过来源的打断阈值；外部来源最高 tell（硬性安全规则）。
function escalationTarget(db: Db, event: EventRecord, ladder: Record<string, unknown>): TriageLevel | null {
  if (!isTriageLevel(event.level)) return null;
  const source = event.kind === EVENT_ESCALATED_KIND && typeof event.payload.escalatedSource === "string"
    ? event.payload.escalatedSource : event.source;
  const basisId = event.triage?.order?.id;
  const basisOrder = basisId ? activeStandingOrders(db).find((order) => order.id === basisId) : undefined;
  const target: unknown = basisOrder?.escalateTo ?? ladder[event.level];
  if (!isTriageLevel(target)) return null;
  let capped = capTriageLevel(target, sourceThreshold(db, source).maxLevel);
  if (!isInternalEventSource(source)) capped = capTriageLevel(capped, "tell");
  return triageLevelRank(capped) > triageLevelRank(event.level) ? capped : null;
}

/**
 * 到时限还没有处置的事件升一级。返回这一次升了哪些。每一条在自己的事务里：一条出错只跳过这一条（交给 onError），
 * 不挡住后面的。升不了的（已经到了来源的打断阈值、依据的指令不升）留在原地：「没有处置的事件」这个不变量会报告它们。
 */
export function escalateOverdueEvents(
  db: Db, now: Date = new Date(), options: { onError?: (seq: number, error: unknown) => void } = {},
): EventEscalation[] {
  const order = ruleStandingOrder(db, "events.escalate_overdue");
  const params = order.action.type === "rule" ? order.action.params as { ladder: Record<string, unknown> } : { ladder: {} };
  const perPass = order.limits?.count ?? 100;
  // 时限不能比不变量的时限长：不变量按 UNDISPOSED_EVENT_DEADLINE_MS 判断。
  const deadlineMs = Math.min(order.limits?.windowMs ?? UNDISPOSED_EVENT_DEADLINE_MS, UNDISPOSED_EVENT_DEADLINE_MS);
  const cutoff = new Date(now.getTime() - deadlineMs).toISOString();
  // 只看能升的级别。用户的消息（conversation）不分诊，也不升级。
  // tell 排在后面：内部来源的 tell 已经到顶，升不了，攒多了也不能挡住后面的 digest。
  const candidates = db.prepare(
    `SELECT seq FROM events
     WHERE disposition IS NULL AND level IS NOT NULL AND level <> 'record' AND received_at < ?
       AND level IN ('digest', 'auto', 'tell')
     ORDER BY CASE level WHEN 'tell' THEN 1 ELSE 0 END, seq LIMIT 1000`,
  ).all(cutoff) as EventRow[];
  const escalated: EventEscalation[] = [];
  for (const { seq } of candidates) {
    if (escalated.length >= perPass) break;
    let done: EventEscalation | null;
    try {
      done = db.transaction((): EventEscalation | null => {
        const event = getEvent(db, seq);
        if (!event || event.disposition !== null) return null;
        const target = escalationTarget(db, event, params.ladder);
        if (!target) return null;
        const merged = listRootCauseMerged(db, event.seq);
        const { event: next } = appendEvent(db, {
          source: "system",
          sourceRef: `escalated:${event.seq}`,
          kind: EVENT_ESCALATED_KIND,
          entityKey: event.entityKey,
          causationId: event.eventId,
          // 照抄原事件的 correlation_id：承载这件事的那一行（inbox:<id>、notification:<id>）被处置时，升级的这条一起处置。
          correlationId: event.correlationId ?? `event:${event.seq}`,
          occurredAt: now.toISOString(),
          rootCause: event.rootCause,
          level: target,
          payload: {
            escalatedSeq: event.seq,
            escalatedEventId: event.eventId,
            escalatedKind: event.kind,
            escalatedSource: event.kind === EVENT_ESCALATED_KIND && typeof event.payload.escalatedSource === "string"
              ? event.payload.escalatedSource : event.source,
            fromLevel: event.level!,
            toLevel: target,
            waitedMs: Math.max(0, now.getTime() - Date.parse(event.receivedAt)),
            summary: eventSummary(event),
            mergedSeqs: merged.map((candidate) => candidate.seq),
          },
        }, {
          basis: {
            order: standingOrderRef(order),
            ...(event.triage?.order ? { applied: [{ ...event.triage.order, effect: `escalate_to_${target}` }] } : {}),
          },
          receivedAt: now,
        });
        setEventDisposition(db, event.seq, "superseded", {
          reason: "escalated",
          escalatedTo: next.seq,
          fromLevel: event.level,
          toLevel: target,
          standingOrder: standingOrderRef(order),
        }, now);
        return { seq: event.seq, escalatedSeq: next.seq, from: event.level!, to: target };
      }).immediate();
    } catch (error) {
      options.onError?.(seq, error);
      continue;
    }
    if (done) escalated.push(done);
  }
  return escalated;
}

// ── 摘要按批 ────────────────────────────────────────────────────────────────────────

export interface DigestEntry {
  // 按对象合并（spec D7）：同一个对象的摘要事件放在一起，从旧到新。
  entityKey: string;
  events: EventRecord[];
  // 按根因合并进这些事件的事件（已经记成 superseded），Lead 说一次时要提到它们。
  merged: EventRecord[];
}

export interface DigestBatch {
  // 现在该不该为摘要叫醒 Lead。
  due: boolean;
  // max_wait：最早的一条等满了；user_returned：用户回来了。不该叫醒时是 null。
  reason: "max_wait" | "user_returned" | null;
  // 还没有处置的 digest 事件，从旧到新。
  events: EventRecord[];
  // 同样的事件按对象分组（组按第一条事件的先后排）。
  entries: DigestEntry[];
  // 最早一条的收到时间，和按等待时间应该叫醒的时间。没有事件时都是 null。
  oldestReceivedAt: string | null;
  dueAt: string | null;
  // sinceSeq 之后自动处理掉的事件（auto 级，spec D3：做完进摘要）。它们自己不触发叫醒。
  autoHandled: EventRecord[];
  // 依据。
  order: StandingOrderRef;
}

/**
 * 现在该不该为摘要叫醒 Lead、有哪些事件（常设指令 events.digest_batch）。只读。
 * 有还没有处置的 digest 事件，并且最早的一条等满了 maxWaitMs，或者用户回来了（userReturned），就该叫醒。
 * sinceSeq 是上一批摘要看到的最后一个 seq：这之后自动处理掉的事件一起放进这一批。
 */
export function dueDigestBatch(
  db: Db, now: Date = new Date(), options: { userReturned?: boolean; sinceSeq?: number; limit?: number } = {},
): DigestBatch {
  const order = ruleStandingOrder(db, "events.digest_batch");
  const params = (order.action.type === "rule" ? order.action.params : {}) as { maxWaitMs: number; onUserReturn: boolean };
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1000);
  const rows = db.prepare(
    `SELECT seq FROM events
     WHERE disposition IS NULL AND level IS NOT NULL AND level <> 'record' AND level = 'digest'
     ORDER BY seq LIMIT ?`,
  ).all(limit) as EventRow[];
  const events = eventsBySeq(db, rows.map((row) => row.seq));
  const groups = new Map<string, DigestEntry>();
  for (const event of events) {
    const entry = groups.get(event.entityKey) ?? { entityKey: event.entityKey, events: [], merged: [] };
    entry.events.push(event);
    entry.merged.push(...listRootCauseMerged(db, event.seq));
    groups.set(event.entityKey, entry);
  }
  const autoRows = db.prepare(
    "SELECT seq FROM events WHERE level = 'auto' AND seq > ? ORDER BY seq LIMIT ?",
  ).all(options.sinceSeq ?? 0, limit) as EventRow[];
  const oldest = events[0]?.receivedAt ?? null;
  const dueAt = oldest ? new Date(Date.parse(oldest) + params.maxWaitMs).toISOString() : null;
  const reason = !events.length ? null
    : options.userReturned && params.onUserReturn ? "user_returned"
    : now.getTime() >= Date.parse(dueAt!) ? "max_wait"
    : null;
  return {
    due: reason !== null,
    reason,
    events,
    entries: [...groups.values()],
    oldestReceivedAt: oldest,
    dueAt,
    autoHandled: eventsBySeq(db, autoRows.map((row) => row.seq)),
    order: standingOrderRef(order),
  };
}

/**
 * 这一批摘要交给 Lead 了（它的回合成功了）：这些事件记成 digested（spec D5，带摘要编号和依据）。
 * 已经有处置的不改（例如 Lead 在这一轮里自己记了处置）。返回记了几条。
 */
export function markEventsDigested(
  db: Db, seqs: readonly number[], options: { digestId: string; at?: Date },
): number {
  const order = standingOrderRef(ruleStandingOrder(db, "events.digest_batch"));
  return db.transaction((): number => {
    let marked = 0;
    for (const seq of seqs) {
      const event = getEvent(db, seq);
      if (!event || event.disposition !== null) continue;
      setEventDisposition(db, seq, "digested", { digestId: options.digestId, standingOrder: order }, options.at);
      marked++;
    }
    return marked;
  })();
}

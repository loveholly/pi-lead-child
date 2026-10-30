// 用户确认 interrupt 级的事件（Lead 事件主干 spec D10，工单 06）。
//
// interrupt 级的事件在输入框上方显示横幅，用户点「知道了」之前一直在。确认是用户的动作，写两件事，在同一个事务里：
//   1. 一条 event.acknowledged 事件（record 级，source_ref 是 ack:<event_id>，同一条只记一次）。横幅按它判断「确认过了」：
//      它只追加、不会被改写。处置会被改写（Lead 用 record_disposition 改口时覆盖），所以横幅不靠处置判断。
//   2. 被确认的事件写回处置 interrupted_user，说明里带确认的时间、哪个客户端、原来的处置（如果有）。
import { EVENT_ACKNOWLEDGED_KIND } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, getEvent, setEventDisposition, type EventRecord } from "./events.js";

export class InterruptAckError extends Error {
  constructor(readonly code: "not_found" | "not_interrupt", message: string) {
    super(message);
    this.name = "InterruptAckError";
  }
}

/** 确认事件的投递编号：一条 interrupt 事件只确认一次。 */
export function interruptAckRef(eventId: string): string {
  return `ack:${eventId}`;
}

/** 这条事件的确认（event.acknowledged）。没确认过时是 undefined。按 (source, source_ref) 的唯一索引查。 */
export function findInterruptAck(db: Db, eventId: string): EventRecord | undefined {
  const row = db.prepare("SELECT seq FROM events WHERE source = 'system' AND source_ref = ?")
    .get(interruptAckRef(eventId)) as { seq: number } | undefined;
  return row ? getEvent(db, row.seq) : undefined;
}

export interface InterruptAckResult {
  // 被确认的事件（处置已经写回）。
  event: EventRecord;
  ack: EventRecord;
  // false：以前已经确认过，这一次什么都没改。
  inserted: boolean;
}

/**
 * 用户确认一条 interrupt 级的事件。重复确认是幂等的：返回第一次的确认，不改处置。
 * 事件不存在、或者不是 interrupt 级时抛 InterruptAckError。
 */
export function acknowledgeInterruptEvent(
  db: Db, seq: number,
  // by：谁确认的。缺省是用户（横幅上的「知道了」）。提醒的到点事件也会因为提醒本身结束了（确认、改期、取消）而记一次，
  // 那时是做这件事的人（工单 07，reminder-occurrence.ts）；reason 写为什么。
  options: { bindingId?: number | null; at?: Date; by?: "user" | "lead" | "system"; reason?: string } = {},
): InterruptAckResult {
  return db.transaction((): InterruptAckResult => {
    const event = getEvent(db, seq);
    if (!event) throw new InterruptAckError("not_found", `event #${seq} not found`);
    if (event.level !== "interrupt") {
      throw new InterruptAckError("not_interrupt", `event #${seq} is ${event.level ?? "untriaged"}, only interrupt events can be acknowledged`);
    }
    const at = options.at ?? new Date();
    const bindingId = options.bindingId ?? null;
    const { event: ack, inserted } = appendEvent(db, {
      source: "system",
      sourceRef: interruptAckRef(event.eventId),
      kind: EVENT_ACKNOWLEDGED_KIND,
      entityKey: event.entityKey,
      causationId: event.eventId,
      occurredAt: at.toISOString(),
      level: "record",
      payload: {
        acknowledgedSeq: event.seq, acknowledgedEventId: event.eventId, acknowledgedKind: event.kind, bindingId,
        ...(options.by && options.by !== "user" ? { by: options.by } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    }, { receivedAt: at });
    if (inserted) {
      const previous = event.disposition ? { disposition: event.disposition, detail: event.dispositionDetail } : null;
      setEventDisposition(db, event.seq, "interrupted_user", {
        acknowledgedAt: at.toISOString(), acknowledgedBy: options.by ?? "user", bindingId, ackSeq: ack.seq,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(previous ? { previous } : {}),
      }, at);
    }
    return { event: getEvent(db, seq)!, ack, inserted };
  }).immediate();
}

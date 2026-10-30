// 一次到点的提醒（工单 07）：到点事件、它的推送、它怎样结束。
//
// 「一次到点」从 scheduled → fired 开始（scheduler 写的 timer.fired），到提醒离开 fired 结束：用户或 Lead 确认（acked）、
// 取消（cancelled）、改到别的时间（scheduled，「10 分钟后再提醒」「改时间」）。结束时在同一个事务里收尾
// （closeReminderOccurrence，items.ts 的 transition 调用）：
//   · 这次到点是 interrupt 级的：记一次确认（event.acknowledged），输入框上方的横幅收起。横幅只看确认，不看处置
//     （Lead 改口会覆盖处置），所以这里也用确认；
//   · 这次到点的通知记成已确认，「待你」托盘里那一行收起；
//   · 推到上限时记的「还没确认」（reminder.unacknowledged）还没有交给 Lead 的，记成 superseded：用户已经处理了，
//     回来简报里不再说它。
// 这个文件不依赖 items.ts（items.ts 的 transition 调用它）。
import {
  LEAD_TURN_RESPONDING_KIND, REMINDER_PUSHED_KIND, REMINDER_UNACKNOWLEDGED_KIND,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { getEvent, listEvents, setEventDisposition, type EventRecord } from "./events.js";
import { acknowledgeInterruptEvent, findInterruptAck } from "./interrupt-acks.js";
import { ackNotification } from "./notifications.js";

export function reminderEntityKey(itemId: number): string {
  return `reminder:${itemId}`;
}

/** 提醒最近一次到点的事件（timer.fired，timer=reminder）。没响过时是 undefined。走 events_entity 索引。 */
export function latestReminderFire(db: Db, itemId: number): EventRecord | undefined {
  return listEvents(db, { entityKey: reminderEntityKey(itemId), kind: "timer.fired", order: "desc", limit: 20 })
    .find((event) => event.payload.timer === "reminder");
}

/** 这一次到点以后的推送（reminder.pushed），从旧到新。提前的那一次在到点之前，不在这里。 */
export function reminderPushesSince(db: Db, itemId: number, fireSeq: number): EventRecord[] {
  return listEvents(db, { entityKey: reminderEntityKey(itemId), kind: REMINDER_PUSHED_KIND, sinceSeq: fireSeq, limit: 100 })
    .filter((event) => event.payload.occasion !== "early");
}

/** 这一次到点之后、对这条提醒记下的事件（推送、stage 变化、Lead 回应的那一轮……），从旧到新。 */
export function reminderEventsSince(db: Db, itemId: number, fireSeq: number, limit = 200): EventRecord[] {
  return listEvents(db, { entityKey: reminderEntityKey(itemId), sinceSeq: fireSeq, limit });
}

/** Lead 回应这次到点的那一轮（lead.turn_responding）。没有时是 null。 */
export function reminderRespondingTurn(events: readonly EventRecord[], fireSeq: number): string | null {
  const found = events.find((event) => event.kind === LEAD_TURN_RESPONDING_KIND
    && Array.isArray(event.payload.seqs) && (event.payload.seqs as unknown[]).includes(fireSeq));
  return found && typeof found.payload.turnId === "string" ? found.payload.turnId : null;
}

/**
 * 提醒离开 fired 时收尾（见文件头）。在调用方的事务里（transition）。from 不是 fired 时调用方不调它。
 * to：acked、cancelled，或者 scheduled（改了时间）。
 */
export function closeReminderOccurrence(
  db: Db, itemId: number,
  args: { to: string; actor: "user" | "lead" | "system" | "child"; reason: string; at: Date },
): void {
  const fire = latestReminderFire(db, itemId);
  const reason = args.to === "acked" ? "reminder acknowledged"
    : args.to === "cancelled" ? "reminder cancelled" : "reminder moved to a new time";
  if (fire && fire.level === "interrupt" && !findInterruptAck(db, fire.eventId)) {
    // 改期的人是 system（rescheduleReminder 代用户或 Lead 走那条边），说明写在 reason 里。
    const by = args.actor === "user" || args.actor === "lead" ? args.actor : "system";
    acknowledgeInterruptEvent(db, fire.seq, { at: args.at, by, reason: `${reason}: ${args.reason}` });
  }
  const notifications = db.prepare(
    "SELECT id FROM notifications WHERE item_id = ? AND kind = 'reminder' AND state <> 'acked'",
  ).all(itemId) as Array<{ id: number }>;
  for (const { id } of notifications) ackNotification(db, id, args.at);
  // 到点事件还没有处置（没接推送通道时）：卡片就在会话里，用户自己处理了，算告诉了用户。Lead 后来写的话覆盖它。
  if (fire && fire.disposition === null) {
    setEventDisposition(db, fire.seq, "told_user", { via: "reminder_card", closedBy: args.actor, reason }, args.at);
  }
  if (fire) {
    for (const event of listEvents(db, { entityKey: reminderEntityKey(itemId), kind: REMINDER_UNACKNOWLEDGED_KIND, sinceSeq: fire.seq })) {
      if (event.disposition !== null) continue;
      setEventDisposition(db, event.seq, "superseded", { reason, closedBy: args.actor }, args.at);
    }
  }
}

/** 这一次到点结束了没有：提醒还停在 fired、并且没有更新的到点，就没有结束。 */
export function reminderFireIsCurrent(db: Db, itemId: number, fireSeq: number): boolean {
  const latest = latestReminderFire(db, itemId);
  if (!latest || latest.seq !== fireSeq) return false;
  const row = db.prepare("SELECT stage FROM items WHERE id = ?").get(itemId) as { stage: string } | undefined;
  return row?.stage === "fired";
}

/** 一条到点事件对应的提醒编号（不是提醒的到点事件时返回 null）。 */
export function reminderIdOfFire(event: Pick<EventRecord, "kind" | "entityKey" | "payload">): number | null {
  if (event.kind !== "timer.fired" || event.payload.timer !== "reminder") return null;
  const match = /^reminder:(\d+)$/u.exec(event.entityKey);
  return match ? Number(match[1]) : null;
}

export function getReminderFire(db: Db, seq: number): EventRecord | undefined {
  const event = getEvent(db, seq);
  return event && reminderIdOfFire(event) !== null ? event : undefined;
}

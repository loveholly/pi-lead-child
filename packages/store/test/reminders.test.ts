// 提醒到点、推送、重复、改时间、一次到点怎样结束（工单 07，spec D11）。落库的事实：items、notifications、events、gateway_events。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { ReminderPolicy } from "@pi-lead-child/protocol";
import {
  createItem, findInterruptAck, fireReminder, getEvent, getItem, latestReminderFire, listEvents, listNotifications, openDb,
  pushReminderEarly, reminderFireState, remindersAwaitingRepeat, remindersDueEarly, rescheduleReminder, repeatReminderPush,
  transition, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-reminders-"), "plc.db")); });

const REMIND_AT = "2026-10-18T01:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(REMIND_AT) + offsetMs);
const MINUTE = 60_000;

function reminder(policy: Partial<ReminderPolicy> = {}, title = "抢票"): number {
  return createItem(db, {
    kind: "reminder", title, brief: "", createdBy: "lead", remindAt: REMIND_AT,
    reminderPolicy: { level: "interrupt", earlyMs: null, repeat: null, ticketId: null, check: null, ...policy },
  });
}

const gatewayUpdates = (itemId: number) => db.prepare(
  "SELECT COUNT(*) AS n FROM gateway_events WHERE event_type = 'ticket.updated' AND item_id = ?",
).get(itemId) as { n: number };

describe("a reminder firing", () => {
  it("fires at its level with the standing order as basis, pushes once, and tells the app right away", () => {
    const id = reminder();
    const { fire, push, notificationId } = fireReminder(db, getItem(db, id)!, at(1_000), { push: true });
    expect(getItem(db, id)!.stage).toBe("fired");
    // 到点事件：提醒自己的级别，依据是常设指令 reminder.fire。系统推过了，算告诉了用户。
    expect(fire).toMatchObject({
      kind: "timer.fired", source: "timer", entityKey: `reminder:${id}`, level: "interrupt",
      payload: { timer: "reminder", itemId: id, title: "抢票", remindAt: REMIND_AT, level: "interrupt", planned: 1 },
      triage: { order: { id: "reminder.fire", version: 1 } },
    });
    expect(getEvent(db, fire.seq)!.disposition).toBe("interrupted_user");
    // 一条推送，记在日志里，依据同一条指令。
    expect(push).toMatchObject({ reminderId: id, occasion: "due", attempt: 1, planned: 1, level: "interrupt" });
    expect(push!.text).toContain("抢票");
    expect(listEvents(db, { kind: "reminder.pushed" })).toEqual([
      expect.objectContaining({ level: "record", triage: { order: { id: "reminder.fire", version: 1 } }, payload: expect.objectContaining({ occasion: "due" }) }),
    ]);
    // 通知已经由系统送达：「待你」托盘里有它，Lead 的播报流程不再请 Lead 说一遍。
    expect(listNotifications(db).find((row) => row.id === notificationId)).toMatchObject({ state: "delivered", delivered_via: "fallback", kind: "reminder" });
    // 到点时就有 ticket.updated：界面马上重取这条提醒，不等 70 秒。
    expect(gatewayUpdates(id).n).toBe(1);
  });

  it("without a push channel fires as before: the notification stays pending and nothing is recorded as pushed", () => {
    const id = reminder({ level: "tell" });
    const { fire, push } = fireReminder(db, getItem(db, id)!, at(0), { push: false });
    expect(push).toBeNull();
    expect(fire.level).toBe("tell");
    expect(fire.disposition).toBeNull();
    expect(listNotifications(db, { state: ["pending"] })).toHaveLength(1);
    expect(listEvents(db, { kind: "reminder.pushed" })).toEqual([]);
  });

  it("treats a reminder created before v48 (no settings) as tell, pushed once", () => {
    const id = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "lead", remindAt: REMIND_AT });
    const { fire, push } = fireReminder(db, getItem(db, id)!, at(0), { push: true });
    expect(fire.level).toBe("tell");
    expect(getEvent(db, fire.seq)!.disposition).toBe("told_user");
    expect(push).toMatchObject({ occasion: "due", planned: 1, level: "tell" });
  });
});

describe("pushing again until the user confirms", () => {
  it("repeats every interval up to the limit, records 'not confirmed' once, and stops when the user confirms", () => {
    const id = reminder({ repeat: { everyMs: 2 * MINUTE, max: 2 } });
    fireReminder(db, getItem(db, id)!, at(0), { push: true });
    expect(remindersAwaitingRepeat(db).map((item) => item.id)).toEqual([id]);
    // 不到间隔不推。
    expect(repeatReminderPush(db, getItem(db, id)!, at(MINUTE)).push).toBeNull();
    const second = repeatReminderPush(db, getItem(db, id)!, at(2 * MINUTE)).push;
    expect(second).toMatchObject({ occasion: "repeat", attempt: 2, planned: 3 });
    expect(second!.text).toContain("还没确认");
    // 同一拍再走一遍不会推第二次。
    expect(repeatReminderPush(db, getItem(db, id)!, at(2 * MINUTE)).push).toBeNull();
    expect(repeatReminderPush(db, getItem(db, id)!, at(4 * MINUTE)).push).toMatchObject({ attempt: 3 });
    // 推满了：再过一个间隔记一次「还没确认」（digest），只记一次，不再推。
    expect(repeatReminderPush(db, getItem(db, id)!, at(5 * MINUTE))).toEqual({ push: null, unacknowledged: null });
    const exhausted = repeatReminderPush(db, getItem(db, id)!, at(6 * MINUTE));
    expect(exhausted.push).toBeNull();
    expect(exhausted.unacknowledged).toMatchObject({ kind: "reminder.unacknowledged", level: "digest", payload: { pushes: 3 } });
    expect(repeatReminderPush(db, getItem(db, id)!, at(8 * MINUTE))).toEqual({ push: null, unacknowledged: null });
    expect(listEvents(db, { kind: "reminder.pushed" }).map((event) => event.payload.attempt)).toEqual([1, 2, 3]);
    const fire = latestReminderFire(db, id)!;
    expect(reminderFireState(db, fire).pushes).toMatchObject({ count: 3, planned: 3, nextAt: null, exhausted: true });

    // 用户确认：横幅收起（确认事件），托盘里的通知确认掉，「还没确认」不再交给 Lead，之后不再推。
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user", now: at(9 * MINUTE) });
    expect(findInterruptAck(db, fire.eventId)).toBeDefined();
    expect(listNotifications(db, { state: ["acked"] })).toHaveLength(1);
    expect(getEvent(db, exhausted.unacknowledged!.seq)!.disposition).toBe("superseded");
    expect(remindersAwaitingRepeat(db)).toEqual([]);
    expect(reminderFireState(db, fire)).toMatchObject({ state: "acked", closedBy: "user", pushes: { exhausted: false } });
  });

  it("stops pushing as soon as the user confirms within the interval", () => {
    const id = reminder({ repeat: { everyMs: 2 * MINUTE, max: 5 } });
    fireReminder(db, getItem(db, id)!, at(0), { push: true });
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user", now: at(MINUTE) });
    expect(repeatReminderPush(db, getItem(db, id)!, at(2 * MINUTE))).toEqual({ push: null, unacknowledged: null });
    expect(listEvents(db, { kind: "reminder.pushed" })).toHaveLength(1);
  });

  it("pushes early once when the reminder sets an early lead time", () => {
    const id = reminder({ earlyMs: 5 * MINUTE });
    expect(remindersDueEarly(db, at(-6 * MINUTE))).toEqual([]);
    expect(remindersDueEarly(db, at(-5 * MINUTE)).map((item) => item.id)).toEqual([id]);
    const early = pushReminderEarly(db, getItem(db, id)!, at(-5 * MINUTE));
    expect(early).toMatchObject({ occasion: "early", attempt: 0 });
    expect(early!.text).toMatch(/^5 分钟后：抢票/);
    expect(remindersDueEarly(db, at(-4 * MINUTE))).toEqual([]);
    expect(pushReminderEarly(db, getItem(db, id)!, at(-4 * MINUTE))).toBeNull();
    const { fire } = fireReminder(db, getItem(db, id)!, at(0), { push: true });
    expect(reminderFireState(db, fire).pushes).toMatchObject({ count: 1, earlyAt: at(-5 * MINUTE).toISOString() });
  });
});

describe("moving a reminder to a new time", () => {
  it("re-arms a fired reminder (snooze), closes this firing, and leaves the terminal states alone", () => {
    const id = reminder();
    const { fire } = fireReminder(db, getItem(db, id)!, at(0), { push: true });
    const later = at(10 * MINUTE);
    rescheduleReminder(db, id, later, { by: "user", now: at(MINUTE) });
    expect(getItem(db, id)).toMatchObject({ stage: "scheduled", remind_at: later.toISOString() });
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${id}`, order: "desc", limit: 1 })[0]!.payload)
      .toMatchObject({ from: "fired", to: "scheduled", actor: "system", requestedBy: "user" });
    // 横幅收起，通知确认掉；这一次到点的卡说「改到了 09:10」。
    expect(findInterruptAck(db, fire.eventId)).toBeDefined();
    expect(reminderFireState(db, fire)).toMatchObject({ state: "snoozed", closedBy: "user", nextAt: later.toISOString() });
    // 到新的时间再响，是新的一次到点。
    const again = fireReminder(db, getItem(db, id)!, later, { push: true });
    expect(again.fire.seq).toBeGreaterThan(fire.seq);
    expect(reminderFireState(db, fire)).toMatchObject({ state: "snoozed", nextAt: later.toISOString() });
    expect(reminderFireState(db, again.fire)).toMatchObject({ state: "fired" });

    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked", now: at(11 * MINUTE) });
    expect(() => rescheduleReminder(db, id, at(20 * MINUTE), { by: "user", now: at(12 * MINUTE) })).toThrow(/acked/);
    expect(getItem(db, id)!.stage).toBe("acked");
  });

  it("only moves the time of a waiting reminder, and refuses a time in the past or a task", () => {
    const id = reminder();
    rescheduleReminder(db, id, at(30 * MINUTE), { by: "lead", now: at(-60 * MINUTE) });
    expect(getItem(db, id)).toMatchObject({ stage: "scheduled", remind_at: at(30 * MINUTE).toISOString() });
    expect(() => rescheduleReminder(db, id, at(-10 * MINUTE), { by: "user", now: at(0) })).toThrow(/in the past/);
    const task = createItem(db, { title: "任务", brief: "b", createdBy: "user" });
    expect(() => rescheduleReminder(db, task, at(0), { by: "user", now: at(0) })).toThrow(/only a reminder/);
    expect(gatewayUpdates(id).n).toBe(1);
  });
});

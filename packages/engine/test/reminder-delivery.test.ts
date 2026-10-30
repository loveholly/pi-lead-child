// 提醒准时送达（工单 07，spec D11）：scheduler 那一拍直接推送（常设指令 reminder.fire），不等 Lead；
// 到点时发 gateway 事件，界面马上更新；没确认时按次数重复推送，确认以后停。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, getItem, listEvents, listNotifications, openDb, transition, type Db, type ReminderPush,
} from "@pi-lead-child/store";
import { createScheduler } from "../src/pipeline/scheduler.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-reminder-delivery-"), "plc.db")); });

const REMIND_AT = "2026-10-18T01:00:00.000Z";
const MINUTE = 60_000;
const clockAt = (start: string) => {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
};

describe("a reminder at its time", () => {
  // 回归（spec D11 的最后一条）：以前提醒到点不发界面事件，会话里的提醒卡要等到点 70 秒以后自己重取，才从「已排期」变成「已提醒」。
  // 旧代码在这里一条 ticket.updated 都没有。
  it("tells the app at once with a ticket.updated for the reminder", () => {
    const id = createItem(db, { kind: "reminder", title: "交房租", brief: "b", createdBy: "user", remindAt: REMIND_AT });
    createScheduler(db, { now: () => new Date(Date.parse(REMIND_AT) + 1_000) }).tick();
    expect(getItem(db, id)!.stage).toBe("fired");
    const updates = db.prepare(
      "SELECT payload FROM gateway_events WHERE event_type = 'ticket.updated' AND item_id = ?",
    ).all(id) as Array<{ payload: string }>;
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!.payload)).toMatchObject({ ticketId: id, snapshotRequired: true });
  });

  it("pushes on time through the channel, after the push is recorded, without waiting for Lead", () => {
    const id = createItem(db, {
      kind: "reminder", title: "抢票", brief: "", createdBy: "lead", remindAt: REMIND_AT,
      reminderPolicy: { level: "interrupt", earlyMs: 5 * MINUTE, repeat: { everyMs: 2 * MINUTE, max: 2 }, ticketId: null, check: null },
    });
    const clock = clockAt("2026-10-18T00:54:00.000Z");
    const pushes: Array<ReminderPush & { recorded: number }> = [];
    const scheduler = createScheduler(db, {
      now: clock.now,
      // 推的时候这一次已经记下了（先记再推）。
      onReminderPush: (push) => pushes.push({ ...push, recorded: listEvents(db, { kind: "reminder.pushed" }).length }),
    });
    scheduler.tickReminders();
    expect(pushes).toEqual([]);
    clock.advance(MINUTE); // 08:55 提前一次
    scheduler.tickReminders();
    expect(pushes.map((push) => push.occasion)).toEqual(["early"]);
    clock.advance(5 * MINUTE); // 09:00 准时
    scheduler.tickReminders();
    expect(pushes.map((push) => [push.occasion, push.attempt])).toEqual([["early", 0], ["due", 1]]);
    expect(pushes.every((push, index) => push.recorded === index + 1)).toBe(true);
    expect(getItem(db, id)!.stage).toBe("fired");
    expect(listNotifications(db)[0]).toMatchObject({ state: "delivered", delivered_via: "fallback" });
    // 没确认：每 2 分钟再推，最多 2 次。
    clock.advance(MINUTE);
    scheduler.tickReminders();
    expect(pushes).toHaveLength(2);
    clock.advance(MINUTE);
    scheduler.tickReminders();
    clock.advance(2 * MINUTE);
    scheduler.tickReminders();
    expect(pushes.map((push) => [push.occasion, push.attempt])).toEqual([["early", 0], ["due", 1], ["repeat", 2], ["repeat", 3]]);
    // 推满了，不再推；再过一个间隔记一次「还没确认」。
    clock.advance(2 * MINUTE);
    scheduler.tickReminders();
    clock.advance(10 * MINUTE);
    scheduler.tickReminders();
    expect(pushes).toHaveLength(4);
    expect(listEvents(db, { kind: "reminder.unacknowledged" })).toHaveLength(1);
  });

  it("stops repeating once the user confirms", () => {
    const id = createItem(db, {
      kind: "reminder", title: "抢票", brief: "", createdBy: "lead", remindAt: REMIND_AT,
      reminderPolicy: { level: "tell", earlyMs: null, repeat: { everyMs: 2 * MINUTE, max: 5 }, ticketId: null, check: null },
    });
    const clock = clockAt(REMIND_AT);
    const pushes: ReminderPush[] = [];
    const scheduler = createScheduler(db, { now: clock.now, onReminderPush: (push) => pushes.push(push) });
    scheduler.tickReminders();
    clock.advance(2 * MINUTE);
    scheduler.tickReminders();
    expect(pushes).toHaveLength(2);
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user", now: clock.now() });
    for (let tick = 0; tick < 10; tick += 1) {
      clock.advance(2 * MINUTE);
      scheduler.tickReminders();
    }
    expect(pushes).toHaveLength(2);
  });

  it("keeps the tick going when the push channel throws, and does not push the same time twice", () => {
    createItem(db, { kind: "reminder", title: "a", brief: "", createdBy: "lead", remindAt: REMIND_AT });
    createItem(db, { kind: "reminder", title: "b", brief: "", createdBy: "lead", remindAt: REMIND_AT });
    const errors: string[] = [];
    const pushed: string[] = [];
    const scheduler = createScheduler(db, {
      now: () => new Date(REMIND_AT),
      onReminderPush: (push) => {
        pushed.push(push.title);
        if (push.title === "a") throw new Error("Slack is down");
      },
      onError: (step) => errors.push(step),
    });
    scheduler.tickReminders();
    scheduler.tickReminders();
    expect(pushed).toEqual(["a", "b"]);
    expect(errors).toEqual(["reminder-push"]);
  });
});

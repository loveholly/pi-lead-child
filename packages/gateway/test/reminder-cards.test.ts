// 会话里的提醒卡和「改时间」（工单 07，spec D10、D11）。完整的落库流程：
//   提醒到点（store 的 fireReminder）→ 「Lead 动态」的投影推出一张提醒卡（resource=lead-activity，带 entityKey、entityVersion）
//   → 快照（include=events,reminders）里有它 → 用户点「10 分钟后再提醒」（POST /v1/reminders/:id/reschedule）
//   → 提醒回到等待，卡收成「改到了 …」，横幅收起 → 已确认的提醒不能再改时间。
import { join } from "node:path";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LEAD_ACTIVITY_RESOURCE, LeadActivityViewSchema, ReminderCardSchema, TicketDetailSchema, type ReminderCard,
} from "@pi-lead-child/protocol";
import {
  createItem, createPairing, findInterruptAck, fireReminder, getItem, latestReminderFire, openDb, recordLeadTurnResponding,
  repeatReminderPush, setEventDisposition, transition, type Db, type PublishGatewayEventInput,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { buildLeadActivityView, createLeadActivityPublisher, isLeadActivityEvent, reminderCardsOf } from "../src/lead-activity.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-reminder-cards-"), "plc.db")); });

const MINUTE = 60_000;

function dueReminder(title = "抢票", level: "interrupt" | "tell" = "interrupt"): number {
  return createItem(db, {
    kind: "reminder", title, brief: "", createdBy: "lead", remindAt: new Date(Date.now() - 1_000).toISOString(),
    reminderPolicy: { level, earlyMs: null, repeat: { everyMs: 2 * MINUTE, max: 3 }, ticketId: null, check: null },
  });
}

describe("the reminder card in the conversation", () => {
  it("is pushed the moment the reminder fires, and updated in place as it is pushed, answered and confirmed", () => {
    const publisher = createLeadActivityPublisher(db);
    const pushed: PublishGatewayEventInput[] = [];
    publisher.sync((event) => { pushed.push(event); });
    const id = dueReminder();
    const { fire } = fireReminder(db, getItem(db, id)!, new Date(), { push: true });
    expect(isLeadActivityEvent(fire)).toBe(true);
    publisher.sync((event) => { pushed.push(event); });
    const cardPush = pushed.find((event) => event.payload.reminder);
    expect(cardPush).toMatchObject({
      type: "snapshot.required", requiredScope: "chat",
      payload: { resource: LEAD_ACTIVITY_RESOURCE, entityKey: `reminder:${id}` },
    });
    expect(cardPush!.itemId).toBeUndefined();
    const card = cardPush!.payload.reminder as ReminderCard;
    expect(Value.Check(ReminderCardSchema, card)).toBe(true);
    expect(card).toMatchObject({
      key: `reminder:${id}@${fire.seq}`, seq: fire.seq, reminderId: id, title: "抢票", level: "interrupt", state: "fired",
      pushes: { count: 1, planned: 4, exhausted: false }, leadTurnId: null, lead: null,
    });
    expect(card.pushes.nextAt).not.toBeNull();

    // Lead 为它单独回了一轮：这一轮挂在卡下面。
    recordLeadTurnResponding(db, { turnId: "turn_reminder_1", events: [fire] });
    pushed.length = 0;
    publisher.sync((event) => { pushed.push(event); });
    const answered = pushed.at(-1)!.payload.reminder as ReminderCard;
    expect(answered.leadTurnId).toBe("turn_reminder_1");
    expect(answered.entityVersion).toBeGreaterThan(card.entityVersion);

    // Lead 插在别的回合里时把话写到卡上（record_disposition 的理由）。
    setEventDisposition(db, fire.seq, "handled", { reason: "12306 9:00 开售，候补入口在「我的」里" });
    pushed.length = 0;
    publisher.sync((event) => { pushed.push(event); });
    const noted = pushed.at(-1)!.payload.reminder as ReminderCard;
    expect(noted.lead).toMatchObject({ disposition: "handled", reason: "12306 9:00 开售，候补入口在「我的」里" });
    expect(noted.entityVersion).toBeGreaterThan(answered.entityVersion);

    // 用户确认：收成一行，推送停了。
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user" });
    pushed.length = 0;
    publisher.sync((event) => { pushed.push(event); });
    const confirmed = pushed.map((event) => event.payload.reminder as ReminderCard | undefined).find(Boolean)!;
    expect(confirmed).toMatchObject({ state: "acked", closedBy: "user", pushes: { nextAt: null } });
    expect(confirmed.closedAt).not.toBeNull();
    // 横幅也收起了。
    expect(pushed.some((event) => (event.payload.interrupt as { acknowledgedAt?: string } | undefined)?.acknowledgedAt)).toBe(true);
    // 没变就不推。
    expect(publisher.sync(() => {})).toBe(0);
  });
});

describe("a reminder nobody confirmed", () => {
  it("says so on its own card, and does not show a second 'digest' card in Lead activity", () => {
    const id = createItem(db, {
      kind: "reminder", title: "抢票", brief: "", createdBy: "lead", remindAt: new Date(Date.now() - 10 * MINUTE).toISOString(),
      reminderPolicy: { level: "interrupt", earlyMs: null, repeat: { everyMs: MINUTE, max: 1 }, ticketId: null, check: null },
    });
    const start = Date.now() - 10 * MINUTE;
    fireReminder(db, getItem(db, id)!, new Date(start), { push: true });
    expect(repeatReminderPush(db, getItem(db, id)!, new Date(start + MINUTE)).push).not.toBeNull();
    expect(repeatReminderPush(db, getItem(db, id)!, new Date(start + 2 * MINUTE)).unacknowledged).not.toBeNull();
    const view = buildLeadActivityView(db, { reminders: true });
    expect(view.cards.filter((card) => card.entityKey === `reminder:${id}`)).toEqual([]);
    expect(view.reminders!.find((card) => card.reminderId === id)).toMatchObject({ state: "fired", pushes: { count: 2, exhausted: true } });
  });
});

describe("HTTP", () => {
  async function start() {
    const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null });
    const controlPlane = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane, userActions: createUserActionService({ db }),
      hello: () => runtime(), chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    return { ...server, base: `http://127.0.0.1:${server.port}` };
  }

  async function redeem(base: string, scopes: string[]) {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
    const response = await fetch(`${base}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
    });
    return (await response.json() as { access_token: string });
  }

  it("serves the cards when asked, shows the settings on the ticket, and moves a fired reminder to a new time", async () => {
    const id = dueReminder();
    const { fire } = fireReminder(db, getItem(db, id)!, new Date(), { push: true });
    const server = await start();
    try {
      const user = await redeem(server.base, ["chat", "tickets:view", "tickets:create", "notices"]);
      const headers = { authorization: `Bearer ${user.access_token}` };
      const json = { ...headers, "content-type": "application/json" };

      // 旧的 include=events 没有 reminders（旧客户端按 StrictObject 校验）；要了才有。
      const plain = await (await fetch(`${server.base}/v1/lead/activity?include=events`, { headers })).json();
      expect(plain.reminders).toBeUndefined();
      const view = await (await fetch(`${server.base}/v1/lead/activity?include=events,reminders`, { headers })).json();
      expect(Value.Check(LeadActivityViewSchema, view)).toBe(true);
      expect(view.reminders.map((card: ReminderCard) => [card.reminderId, card.state])).toEqual([[id, "fired"]]);
      expect(view.interrupts.map((item: { seq: number }) => item.seq)).toEqual([fire.seq]);

      // 工单详情带提醒的设置（「重要」从这里来）。
      const detail = await (await fetch(`${server.base}/v1/tickets/${id}`, { headers })).json();
      expect(Value.Check(TicketDetailSchema, detail)).toBe(true);
      expect(detail.reminder).toMatchObject({ level: "interrupt", repeat: { everyMs: 2 * MINUTE, max: 3 } });

      // 改时间要 tickets:create，和确认提醒一样。
      const reader = await redeem(server.base, ["chat", "tickets:view"]);
      const denied = await fetch(`${server.base}/v1/reminders/${id}/reschedule`, {
        method: "POST", headers: { authorization: `Bearer ${reader.access_token}`, "content-type": "application/json" }, body: "{}",
      });
      expect(denied.status).toBe(403);
      expect((await fetch(`${server.base}/v1/reminders/${id}/reschedule`, {
        method: "POST", headers: json, body: JSON.stringify({ snoozeMinutes: 0 }),
      })).status).toBe(400);
      expect((await fetch(`${server.base}/v1/reminders/${id}/reschedule`, {
        method: "POST", headers: json, body: JSON.stringify({ actor: "lead" }),
      })).status).toBe(403);

      // 「10 分钟后再提醒」。
      const before = Date.now();
      const snoozed = await fetch(`${server.base}/v1/reminders/${id}/reschedule`, { method: "POST", headers: json, body: "{}" });
      expect(snoozed.status).toBe(200);
      const body = await snoozed.json() as { remindAt: string; ticket: { stage: string } };
      expect(body.ticket.stage).toBe("scheduled");
      expect(Date.parse(body.remindAt) - before).toBeGreaterThanOrEqual(10 * MINUTE - 1_000);
      expect(Date.parse(body.remindAt) - before).toBeLessThanOrEqual(10 * MINUTE + 5_000);
      expect(getItem(db, id)).toMatchObject({ stage: "scheduled", remind_at: body.remindAt });
      expect(findInterruptAck(db, fire.eventId)).toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM gateway_events WHERE event_type = 'ticket.updated' AND item_id = ?").get(id))
        .toMatchObject({ n: expect.any(Number) });
      const card = reminderCardsOf(db, 0).find((candidate) => candidate.seq === fire.seq)!;
      expect(card).toMatchObject({ state: "snoozed", nextAt: body.remindAt, closedBy: "user" });
      const after = await (await fetch(`${server.base}/v1/lead/activity?include=events,reminders`, { headers })).json();
      expect(after.interrupts).toEqual([]);

      // 「改时间」到一个具体的时刻。
      const at = new Date(Date.now() + 60 * MINUTE).toISOString();
      const moved = await fetch(`${server.base}/v1/reminders/${id}/reschedule`, { method: "POST", headers: json, body: JSON.stringify({ remindAt: at }) });
      expect(moved.status).toBe(200);
      expect(getItem(db, id)!.remind_at).toBe(at);

      // 已确认的提醒不能再改（不改生命周期的终态）。
      fireReminder(db, getItem(db, id)!, new Date(), { push: true });
      transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user" });
      const closed = await fetch(`${server.base}/v1/reminders/${id}/reschedule`, { method: "POST", headers: json, body: "{}" });
      expect(closed.status).toBe(409);
      expect(getItem(db, id)!.stage).toBe("acked");
      expect(latestReminderFire(db, id)!.seq).toBeGreaterThan(fire.seq);
      expect((await fetch(`${server.base}/v1/reminders/999999/reschedule`, { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

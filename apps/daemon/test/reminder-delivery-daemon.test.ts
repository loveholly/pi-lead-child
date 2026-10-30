// 提醒准时送达（工单 07，spec D11 和 Testing Decisions 的场景 7），走完整的落库路径：daemon、网关、store 都是真的，
// Lead 的会话是假的 pi 会话（fake-pi-session.ts，输入的放置和 pi 一样），只记下它收到的输入。
//   · 场景 7：重要提醒到点时 Lead 正忙。推送准时（桌面通知在 Lead 答完之前就到了）；会话里马上出现到点卡
//     （声明了 include=lead_activity 的客户端收到提醒卡，和 ticket.updated）；提醒插进当前回合（steer），不另开一轮。
//   · 用户在 Lead 处理它之前已经确认：Lead 不为它开一轮，它的输出里没有提醒的原文。
//   · 没确认、Lead 空着：Lead 为它单独回一轮，这一轮挂在提醒卡下面（lead.turn_responding）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createItem, createPairing, getEvent, getItem, latestReminderFire, listEvents, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { SYSTEM_TURN_ORIGINS, type ReminderPolicy } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-reminder-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_ACTIVITY_SYNC_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function start(lead: ReturnType<typeof fakePiLead>, desktop: string[]) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: (text) => { desktop.push(text); },
  });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create", "notices"],
  }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1&include=lead_activity`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id).data as { turnId: string };
  };
  const http = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
    ...init, headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { events, send, http };
}

function reminderAt(at: Date, policy: Partial<ReminderPolicy> = {}, title = "抢票"): number {
  return createItem(db, {
    kind: "reminder", title, brief: "", createdBy: "lead", remindAt: at.toISOString(),
    reminderPolicy: { level: "interrupt", earlyMs: null, repeat: null, ticketId: null, check: null, ...policy },
  });
}

const reminderCardPushes = (events: any[], id: number) => events.filter((event) => event.type === "snapshot.required"
  && event.payload.resource === "lead-activity" && event.payload.reminder?.reminderId === id);
const turnTexts = () => (db.prepare("SELECT origin_kind, assistant_text FROM channel_turns ORDER BY created_at, rowid").all() as
  Array<{ origin_kind: string; assistant_text: string }>);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("scenario 7: an important reminder fires while Lead is busy", () => {
  it("pushes on time, shows the card at once, and steers the reminder into the running turn", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) return { say: ["我先看一下。", holdA.promise, "A 的第一部分。"] };
      if (input.includes("到点")) return { say: "A 的其余部分。" };
      return { say: "不该走到这里。" };
    });
    const desktop: string[] = [];
    const { events, send } = await start(lead, desktop);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    // Lead 正在答 A。9:00 的重要提醒到点了。
    const remindAt = new Date(Date.now() + 300);
    const id = reminderAt(remindAt);

    // 1. 准时推送：不等 Lead（A 还没答完）。interrupt 级的有人在看也弹桌面通知。
    await vi.waitFor(() => expect(desktop.some((text) => text.includes("抢票"))).toBe(true), { timeout: 5_000, interval: 20 });
    const pushedAt = Date.now();
    expect(pushedAt - remindAt.getTime()).toBeLessThan(2_000);
    expect(getItem(db, id)!.stage).toBe("fired");
    const fire = latestReminderFire(db, id)!;
    expect(fire).toMatchObject({ level: "interrupt", triage: { order: { id: "reminder.fire" } } });
    expect(listEvents(db, { kind: "reminder.pushed", entityKey: `reminder:${id}` })).toHaveLength(1);

    // 2. 会话里马上出现到点卡（只显示的写入），界面收到 ticket.updated：都在 A 答完之前。
    await vi.waitFor(() => expect(reminderCardPushes(events, id).length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
    expect(reminderCardPushes(events, id)[0].payload.reminder).toMatchObject({
      reminderId: id, title: "抢票", level: "interrupt", state: "fired", pushes: { count: 1 },
    });
    expect(events.some((event) => event.type === "ticket.updated" && event.payload?.ticketId === id)).toBe(true);
    expect(events.some((event) => event.type === "snapshot.required" && event.payload.interrupt?.seq === fire.seq)).toBe(true);

    // 3. 提醒插进当前回合：在 pi 的插话队列里，写明卡片的状态和怎样处理。
    await vi.waitFor(() => expect(lead.queued().steering.some((text) => text.includes(`提醒 #${id}「抢票」到点`))).toBe(true));
    const steered = lead.queued().steering.find((text) => text.includes(`提醒 #${id}「抢票」到点`))!;
    expect(steered).toContain("系统已经推了 1 次");
    expect(steered).toContain("用户还没确认");
    expect(steered).toContain("插进了你正在做的那一轮");
    expect(steered).toContain("不要重复提醒的内容");
    expect(lead.calls).toHaveLength(1);
    expect(Date.now() - pushedAt).toBeLessThan(5_000);

    holdA.resolve();
    await vi.waitFor(() => expect(lead.calls).toHaveLength(2));
    expect(lead.calls[1]!.inputs.join("\n")).toContain(`提醒 #${id}「抢票」到点`);
    // 一次运行：没有为提醒另开一轮，会话里没有另起的气泡。
    await vi.waitFor(() => expect(turnTexts().map((turn) => turn.assistant_text)).toEqual(["我先看一下。A 的第一部分。A 的其余部分。"]));
    expect(lead.prompts).toHaveLength(1);
    expect(turnTexts().some((turn) => turn.origin_kind === SYSTEM_TURN_ORIGINS.reminder)).toBe(false);
  });
});

describe("a reminder Lead gets to after the user", () => {
  it("does not get a Lead turn when the user already confirmed it, so Lead never repeats it", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) return { say: ["我先看一下。", holdA.promise, "A 的回答。"] };
      // 假 Lead 照着收到的事说话：交给它的提醒它会原样说出来。断言它根本没收到。
      return { say: `收到：${input.slice(-200)}` };
    });
    const desktop: string[] = [];
    const { send, http } = await start(lead, desktop);
    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    // 普通的提醒（tell）：Lead 正忙，它排在这一轮后面。
    const id = reminderAt(new Date(Date.now() + 200), { level: "tell" }, "交周报给张三");
    await vi.waitFor(() => expect(getItem(db, id)!.stage).toBe("fired"), { timeout: 5_000, interval: 20 });
    // 准时推了（Slack；有人在看会话、又是 tell 级的，不弹桌面通知），不插进 Lead 正在做的这一轮。
    expect(listEvents(db, { kind: "reminder.pushed", entityKey: `reminder:${id}` })).toHaveLength(1);
    expect(desktop).toEqual([]);
    await pause(100);
    expect(lead.queued().steering).toEqual([]);
    // 用户在会话的到点卡上点了「知道了」。
    const acked = await http(`/v1/tickets/${id}/ack`, { method: "POST", body: "{}" });
    expect(acked.status).toBe(200);
    holdA.resolve();
    await vi.waitFor(() => expect(turnTexts().map((turn) => turn.assistant_text)).toEqual(["我先看一下。A 的回答。"]));
    await pause(300);
    // Lead 没有为它开一轮：没有输出，更没有提醒的原文。
    expect(lead.prompts).toHaveLength(1);
    expect(lead.calls.some((call) => call.inputs.some((input) => input.includes("交周报给张三")))).toBe(false);
    expect(turnTexts().every((turn) => !turn.assistant_text.includes("交周报给张三"))).toBe(true);
    // 它有处置（系统推过了，用户自己处理了），不会留在「没有处置的事件」里。
    expect(getEvent(db, latestReminderFire(db, id)!.seq)!.disposition).toBe("told_user");
  });

  it("gives an unconfirmed reminder a turn of its own when Lead is free, and hangs that turn under the card", async () => {
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("到点")) return { say: "我查了：PR86 还没合并，卡在 CI。" };
      return { say: "收到。" };
    });
    const desktop: string[] = [];
    const { http } = await start(lead, desktop);
    const task = createItem(db, { title: "aish PR86", brief: "b", createdBy: "user" });
    const id = reminderAt(new Date(Date.now() + 200), { level: "tell", ticketId: task, check: "PR86 合并了没有" }, "关注 PR86");
    await vi.waitFor(() => expect(turnTexts().some((turn) => turn.origin_kind === SYSTEM_TURN_ORIGINS.reminder)).toBe(true), { timeout: 5_000, interval: 20 });
    const input = lead.calls[0]!.inputs.join("\n");
    expect(input).toContain(`提醒 #${id}「关注 PR86」到点`);
    expect(input).toContain("用户还没确认");
    expect(input).toContain(`关联的工单：#${task}「aish PR86」`);
    expect(input).toContain("到点要先查：PR86 合并了没有");
    expect(input).toContain("你说的话会显示在这张提醒卡下面");
    const turn = db.prepare("SELECT id, assistant_text FROM channel_turns WHERE origin_kind = ?").get(SYSTEM_TURN_ORIGINS.reminder) as
      { id: string; assistant_text: string };
    expect(turn.assistant_text).toBe("我查了：PR86 还没合并，卡在 CI。");
    const fire = latestReminderFire(db, id)!;
    expect(listEvents(db, { kind: "lead.turn_responding" })).toEqual([
      expect.objectContaining({ entityKey: `reminder:${id}`, payload: { turnId: turn.id, seqs: [fire.seq], entityKeys: [`reminder:${id}`] } }),
    ]);
    const view = await (await http("/v1/lead/activity?include=events,reminders")).json() as { reminders: Array<{ reminderId: number; leadTurnId: string | null }> };
    expect(view.reminders.find((card) => card.reminderId === id)).toMatchObject({ leadTurnId: turn.id });
  });
});

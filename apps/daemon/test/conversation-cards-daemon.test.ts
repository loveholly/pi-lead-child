// 工单 06（Lead 事件主干 spec D10、D16）：会话里的卡片和状态，走完整的落库路径。
//   · 只显示的写入：一条 digest 级的事件写进库，daemon 马上把「Lead 动态」的卡推给声明了 include=lead_activity 的客户端，
//     推送带 entityKey 和 entityVersion；它不叫醒 Lead（不进 Lead 的模型）。没有声明的旧客户端收不到这条推送。
//   · interrupt 级的事件：推送一条横幅；用户在网关上确认（POST /v1/lead/interrupts/:seq/ack），处置写回事件，
//     确认事件落库，别的客户端收到横幅结束的推送，版本更大。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  addInbox, appendEvent, createItem, createPairing, findInterruptAck, getEvent, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-conversation-cards-");
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

async function connect(token: string, include: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${token}&protocol=2&after_seq=-1${include}`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  return events;
}

const leadActivityPushes = (events: any[]) => events.filter((event) => event.type === "snapshot.required"
  && event.payload.resource === "lead-activity");

describe("conversation cards through the daemon", () => {
  it("pushes a digest card at once without waking Lead, and lets the user acknowledge an interrupt banner", async () => {
    const lead = fakePiLead(async () => ({ say: "收到。" }));
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"] }).code);
    const fresh = await connect(issued.accessToken, "&include=lead_health,ui_surfaces,lead_activity");
    const old = await connect(issued.accessToken, "&include=lead_health,ui_surfaces");

    const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} 的子任务完成了` });
    await vi.waitFor(() => expect(leadActivityPushes(fresh).some((event) => event.payload.card?.entityKey === `ticket:${itemId}`)).toBe(true));
    const digest = leadActivityPushes(fresh).find((event) => event.payload.card?.entityKey === `ticket:${itemId}`)!;
    expect(digest.payload).toMatchObject({
      entityKey: `ticket:${itemId}`,
      card: { kind: "digest", summary: `工单 #${itemId} 的子任务完成了`, basis: [{ kind: "order", id: "inbox.no_wake", version: 1 }] },
    });
    expect(digest.payload.entityVersion).toBe(digest.payload.card.entityVersion);
    // 只显示：不叫醒 Lead。
    expect(lead.calls).toHaveLength(0);

    const alarm = db.transaction(() => appendEvent(db, {
      source: "timer", kind: "timer.fired", entityKey: `reminder:${itemId}`, level: "interrupt",
      payload: { timer: "reminder", scheduledAt: new Date().toISOString(), itemId, title: "部署窗口快关了", wakeLead: true },
    }).event)();
    await vi.waitFor(() => expect(leadActivityPushes(fresh).some((event) => event.payload.interrupt?.seq === alarm.seq)).toBe(true));
    const shown = leadActivityPushes(fresh).find((event) => event.payload.interrupt?.seq === alarm.seq)!;
    expect(shown.payload.interrupt).toMatchObject({ summary: "提醒「部署窗口快关了」到点", acknowledgedAt: null });

    const response = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/lead/interrupts/${alarm.seq}/ack`, {
      method: "POST", headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(leadActivityPushes(fresh).some((event) => event.payload.interrupt?.seq === alarm.seq
      && event.payload.interrupt.acknowledgedAt !== null)).toBe(true));
    const closed = leadActivityPushes(fresh).find((event) => event.payload.interrupt?.seq === alarm.seq && event.payload.interrupt.acknowledgedAt)!;
    expect(closed.payload.entityVersion).toBeGreaterThan(shown.payload.entityVersion);
    expect(getEvent(db, alarm.seq)!.dispositionDetail).toMatchObject({ acknowledgedBy: "user" });
    expect(findInterruptAck(db, alarm.eventId)).toMatchObject({ kind: "event.acknowledged", level: "record" });
    // 后来 Lead 处理这件事（interrupt 叫醒了它）也不会让横幅回来：确认事件只追加。
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThan(0));
    const reread = await (await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/lead/activity?include=events`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    })).json() as { interrupts: unknown[]; cards: Array<{ entityKey: string }> };
    expect(reread.interrupts).toEqual([]);
    expect(reread.cards.map((card) => card.entityKey)).toContain(`ticket:${itemId}`);

    // 旧客户端没有声明 include=lead_activity，收不到这些推送（它把不认识的 resource 当成全部重取）。
    expect(leadActivityPushes(old)).toEqual([]);
  });
});

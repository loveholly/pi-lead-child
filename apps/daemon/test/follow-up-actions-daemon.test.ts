// Lead 忙时用户排着的追问，状态栏每一行的「Steer」和「×」（用户 2026-10-28，protocol 的 lead-follow-ups.ts）。走完整的落库路径：
// 用户的消息经网关进来，daemon 交给假的 pi 会话（fake-pi-session.ts，队列和 pi 一样，clearQueue 只还回文字），页面经
// POST /v1/lead/follow-ups/steer、/cancel 操作（engine 的 ui-actions 的 follow_up）。断言 pi 队列里的样子、Lead 实际收到的输入
// 和先后、每一轮的结局、用户看到的放置（事件和会话快照）。
//   · steer：排着的第二条按插话送进这一轮，第一条仍按排队排着，先后不变；
//   · cancel：这一条从 pi 的队列里没了，placement 是 cancelled，Lead 不回答它，另一条照常回答；没有失败卡；
//   · 带图片的追问放回 pi 的队列时图片还在；
//   · 这一轮读过外部内容、要单独开一轮的追问插不进这一轮，但可以取消。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, situationIn, type FakeCall, type FakeImage } from "./fake-pi-session.js";

// 1×1 的透明 PNG。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// JPEG 的文件头加几个字节：daemon 只核对文件头，不解码。
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");
const png: FakeImage = { type: "image", mimeType: "image/png", data: PNG };
const jpeg: FakeImage = { type: "image", mimeType: "image/jpeg", data: JPEG };

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-follow-ups-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function start(lead: ReturnType<typeof fakePiLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  let sent = 0;
  const send = async (message: string, options: { mode?: "steer" | "followUp"; images?: FakeImage[] } = {}) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({
      type: "chat.send", id, protocolVersion: 2, message,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.images?.length ? { images: options.images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
    }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const act = (action: "steer" | "cancel", turnId: string) => http("POST", `/v1/lead/follow-ups/${action}`, { turnId });
  return { events, send, http, act, hello: events.find((event) => event.type === "hello.v2") };
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };
const userMessageOutcome = (turnId: string) => listEvents(db, { kind: "user.message" })
  .find((event) => event.payload.turnId === turnId)?.dispositionDetail;
const callWith = (calls: FakeCall[], text: string) => calls.findIndex((call) => call.inputs.some((input) => input.includes(text)));
const placements = (events: any[], turnId: string) => events
  .filter((event) => event.type === "lead.turn.started" && event.turnId === turnId).map((event) => event.payload.placement);

describe("steering a queued follow-up into the running round", () => {
  it("sends the second one in as a steer, keeps the first queued as a follow-up, and keeps the order", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { say: "我先查一下。", tools: ["query_tickets"] }; }
      if (input.includes("追问 C")) return { say: "C 的回答。" };
      if (input.includes("追问 B")) return { say: "B 的回答。" };
      return { say: "收到。" };
    });
    const { events, send, act, hello } = await start(lead);
    expect(hello.capabilities).toContain(CHAT_FOLLOW_UP_ACTIONS_CAPABILITY);

    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("追问 B", { mode: "followUp" });
    const c = await send("追问 C", { mode: "followUp" });
    await vi.waitFor(() => expect(lead.queued().followUp).toHaveLength(2));

    const steered = await act("steer", c.turnId);
    expect(steered).toEqual({ status: 200, body: { turnId: c.turnId, placement: "steered" } });
    // pi 的队列：C 按插话排着（不带当前局面：这一轮开头已经有了），B 仍按排队排着，原文不变（开头带着当前局面）。
    const queued = lead.queued();
    expect(queued.steering).toHaveLength(1);
    expect(queued.steering[0]).toContain("追问 C");
    expect(situationIn(queued.steering[0]!)).toBeNull();
    expect(queued.followUp).toHaveLength(1);
    expect(queued.followUp[0]).toContain("追问 B");
    expect(situationIn(queued.followUp[0]!)).not.toBeNull();
    // 和用户发送时选「插话」的结果一样。
    expect(placements(events, c.turnId)).toEqual(["queued", "steered"]);

    holdA.resolve();
    await vi.waitFor(() => expect(turn(b.turnId)).toMatchObject({ state: "completed", assistant_text: "B 的回答。" }));
    // 先后：A → C（插进这一轮，在工具调用之后）→ B（这一轮最后的回答之后）。
    expect(callWith(lead.calls, "问题 A")).toBe(0);
    expect(callWith(lead.calls, "追问 C")).toBe(1);
    expect(callWith(lead.calls, "追问 B")).toBe(2);
    expect(lead.calls.map((call) => call.inputs.length)).toEqual([1, 1, 1]);
    expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "我先查一下。" });
    expect(turn(c.turnId)).toMatchObject({ state: "completed", assistant_text: "C 的回答。" });
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND }).map((event) => event.payload)).toEqual([
      expect.objectContaining({ target: { type: "follow_up", id: c.turnId }, action: "steer", actor: "user" }),
    ]);
  });
});

describe("cancelling a queued follow-up", () => {
  it("takes it out of pi's queue; Lead never answers it, the other one is answered, and no failure card shows", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { say: "A 的回答。" }; }
      if (input.includes("追问 B")) return { say: "不该回答 B。" };
      if (input.includes("追问 C")) return { say: "C 的回答。" };
      return { say: "收到。" };
    });
    const { events, send, act, http } = await start(lead);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("追问 B", { mode: "followUp" });
    const c = await send("追问 C", { mode: "followUp" });
    await vi.waitFor(() => expect(lead.queued().followUp).toHaveLength(2));

    const cancelled = await act("cancel", b.turnId);
    expect(cancelled).toEqual({ status: 200, body: { turnId: b.turnId, placement: "cancelled" } });
    const queued = lead.queued();
    expect(queued.steering).toEqual([]);
    expect(queued.followUp).toHaveLength(1);
    expect(queued.followUp[0]).toContain("追问 C");
    // B 是这一批的第一条，开头带着当前局面：挪到了 C 的开头。
    expect(situationIn(queued.followUp[0]!)).not.toBeNull();
    // 用户的话留在会话里，这一轮停在 steered（不是失败，也不再等），结局是取消。
    expect(turn(b.turnId)).toMatchObject({ state: "steered", error: null, assistant_text: "" });
    expect(userMessageOutcome(b.turnId)).toMatchObject({ outcome: "cancelled", by: expect.stringContaining("user via app") });
    expect(placements(events, b.turnId)).toEqual(["queued", "cancelled"]);

    holdA.resolve();
    await vi.waitFor(() => expect(turn(c.turnId)).toMatchObject({ state: "completed", assistant_text: "C 的回答。" }));
    expect(callWith(lead.calls, "追问 B")).toBe(-1);
    expect(callWith(lead.calls, "追问 C")).toBe(1);
    expect(lead.calls).toHaveLength(2);
    expect(turn(b.turnId)).toMatchObject({ state: "steered", error: null, assistant_text: "" });
    expect(events.some((event) => event.type === "notice.created" && event.turnId === b.turnId)).toBe(false);
    // 会话快照（刷新以后）也说它取消了，用户的话原样在。
    const { body } = await http("GET", "/v1/conversation/turns?include=placement");
    expect(body.items.find((item: any) => item.id === b.turnId)).toMatchObject({ userText: "追问 B", placement: "cancelled" });
    // 已经取消的不能再取消，也不能插进来。
    expect((await act("cancel", b.turnId)).status).toBe(404);
    expect((await act("steer", b.turnId)).status).toBe(404);
  });
});

describe("images of a queued follow-up", () => {
  it("go back into pi's queue with the message, for the steered one and for the one still queued", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { tools: ["query_tickets"] }; }
      if (input.includes("追问 C")) return { say: "C 的图看到了。" };
      if (input.includes("追问 B")) return { say: "B 的图看到了。" };
      return { say: "收到。" };
    });
    const { send, act } = await start(lead);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("追问 B", { mode: "followUp", images: [png] });
    const c = await send("追问 C", { mode: "followUp", images: [jpeg] });
    await vi.waitFor(() => expect(lead.queued().followUp).toHaveLength(2));
    expect((await act("steer", c.turnId)).status).toBe(200);

    holdA.resolve();
    await vi.waitFor(() => expect(turn(b.turnId)).toMatchObject({ state: "completed", assistant_text: "B 的图看到了。" }));
    expect(lead.calls[callWith(lead.calls, "追问 C")]!.images).toEqual([jpeg]);
    expect(lead.calls[callWith(lead.calls, "追问 B")]!.images).toEqual([png]);
    expect(turn(c.turnId)).toMatchObject({ state: "completed", assistant_text: "C 的图看到了。" });
  });
});

describe("a follow-up held for a turn of its own", () => {
  it("cannot be steered into a round that read external content, and can still be cancelled", async () => {
    const holdA = deferred();
    let read = false;
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      // 第一次调模型读了一个外部对话：这一轮算读过外部内容。
      if (input.includes("问题 A")) { read = true; return { tools: ["read_channel_conversation"] }; }
      if (read && call.index === 1) { await holdA.promise; return { say: "A 的回答。" }; }
      if (input.includes("追问 B")) return { say: "不该回答 B。" };
      if (input.includes("追问 D")) return { say: "D 的回答。" };
      return { say: "收到。" };
    });
    const { send, act, http } = await start(lead);

    await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(2));
    const b = await send("追问 B", { mode: "followUp" });
    const d = await send("追问 D", { mode: "followUp" });
    // 两条都等这一轮结束后单独开一轮，不在 pi 的队列里。
    expect(b.mode).toBe("queued");
    expect(lead.queued()).toEqual({ steering: [], followUp: [] });

    // 「现在能不能做」：通用的页面入口和执行前的检查是同一个判断。
    const listed = await http("GET", `/v1/actions/follow_up/${b.turnId}`);
    expect(listed.body.actions.map((action: any) => [action.id, action.available])).toEqual([["steer", false], ["cancel", true]]);
    expect(listed.body.actions[0].reason).toBe("这一轮读过外部内容，这条要单独开一轮。");
    const steer = await act("steer", b.turnId);
    expect(steer.status).toBe(409);
    expect(steer.body.error).toMatchObject({ code: "conflict", message: expect.stringContaining("这一轮读过外部内容"), details: { reason: "unavailable" } });

    expect(await act("cancel", b.turnId)).toEqual({ status: 200, body: { turnId: b.turnId, placement: "cancelled" } });
    holdA.resolve();
    await vi.waitFor(() => expect(turn(d.turnId)).toMatchObject({ state: "completed", assistant_text: "D 的回答。" }));
    expect(callWith(lead.calls, "追问 B")).toBe(-1);
    expect(turn(b.turnId)).toMatchObject({ state: "steered", error: null, assistant_text: "" });
    expect(userMessageOutcome(b.turnId)).toMatchObject({ outcome: "cancelled" });
  });
});

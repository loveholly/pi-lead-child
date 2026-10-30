// 用户发给 Lead 的图片（protocol 的 chat-images.ts）：走完整的路径。App 的 chat.send 带着图片经网关进来，daemon 和这一轮
// 一起存下，交给 Lead 的会话（pi 的 prompt、steer、followUp 都带图片）；消息的信封写着几张图片；会话快照列出图片，按 id 取得到。
// 自动重试时图片从库里取，和第一次一样交给 Lead。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, type FakeImage } from "./fake-pi-session.js";

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
  dir = tempDir("plc-chat-images-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
  vi.stubEnv("PLC_USER_TURN_RETRY_MS", "80");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function start(factory: unknown, extra: Record<string, unknown> = {}) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: factory as never, log: () => {}, notifyDesktop: () => {}, ...extra,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string, images: FakeImage[], mode?: "steer" | "followUp") => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({
      type: "chat.send", id, protocolVersion: 2, message,
      ...(images.length ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
      ...(mode ? { mode } : {}),
    }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  return { events, send, get };
}

const turnState = (id: string) => db.prepare("SELECT state, user_text, assistant_text FROM channel_turns WHERE id = ?").get(id) as
  { state: string; user_text: string; assistant_text: string };

describe("images the user sends to Lead", () => {
  it("reach Lead's model with the message, and come back in the conversation snapshot", async () => {
    const lead = fakePiLead(() => ({ say: "看到了两张图。" }));
    const { send, get } = await start(lead.factory);

    const sent = await send("这两张截图哪里不对", [png, jpeg]);
    await vi.waitFor(() => expect(turnState(sent.turnId)).toMatchObject({ state: "completed", assistant_text: "看到了两张图。" }));

    expect(lead.calls).toHaveLength(1);
    expect(lead.calls[0]!.images).toEqual([png, jpeg]);
    // 信封写着这条消息带了几张图片，用户的话原样在里面。
    expect(lead.prompts[0]).toMatch(/<user_message[^>]* images="2">\n这两张截图哪里不对\n<\/user_message>/u);

    const { items } = await get("/v1/conversation/turns?include=images");
    const listed = items.find((item: any) => item.id === sent.turnId);
    expect(listed.images.map((image: any) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(await get(`/v1/chat/images/${listed.images[0].id}`)).toEqual({ id: listed.images[0].id, mimeType: "image/png", data: PNG });
  });

  it("answers a message that has only an image", async () => {
    const lead = fakePiLead(() => ({ say: "这是一张透明的图。" }));
    const { send, get } = await start(lead.factory);

    const sent = await send("", [png]);
    await vi.waitFor(() => expect(turnState(sent.turnId)).toMatchObject({ state: "completed", user_text: "" }));
    expect(lead.calls[0]!.images).toEqual([png]);
    expect(lead.prompts[0]).toMatch(/<user_message[^>]* images="1">\n\n<\/user_message>/u);
    const { items } = await get("/v1/conversation/turns?include=images");
    expect(items.find((item: any) => item.id === sent.turnId).images).toHaveLength(1);
  });

  it("go with a steer and a queued message while Lead is busy", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { tools: ["query_tickets"] }; }
      if (input.includes("插话 B")) return { say: "B 的图看到了。" };
      if (input.includes("排队 C")) return { say: "C 的图看到了。" };
      return { say: "收到。" };
    });
    const { send } = await start(lead.factory);

    await send("问题 A", []);
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("插话 B", [png], "steer");
    const c = await send("排队 C", [jpeg], "followUp");
    expect([b.mode, c.mode]).toEqual(["steered", "queued"]);
    expect(lead.queued().steering).toHaveLength(1);
    holdA.resolve();

    await vi.waitFor(() => expect(turnState(c.turnId)).toMatchObject({ state: "completed", assistant_text: "C 的图看到了。" }));
    const withB = lead.calls.find((call) => call.inputs.some((input) => input.includes("插话 B")));
    const withC = lead.calls.find((call) => call.inputs.some((input) => input.includes("排队 C")));
    expect(withB?.images).toEqual([png]);
    expect(withC?.images).toEqual([jpeg]);
    expect(lead.calls[0]!.images).toEqual([]);
  });

  it("are handed to Lead again when the turn is retried after a network failure", async () => {
    let down: string | null = null;
    const listeners: Array<(event: any) => void> = [];
    const prompts: Array<{ text: string; images: FakeImage[] }> = [];
    const failures = ['500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}'];
    const factory = async () => ({
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt(text: string, options?: { images?: FakeImage[] }) {
          prompts.push({ text, images: options?.images ?? [] });
          const failure = failures.shift();
          if (failure) down = "getaddrinfo ENOTFOUND api.anthropic.com";
          for (const listener of listeners) {
            if (failure) {
              listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: failure, content: [] } });
            } else {
              listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
              listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
            }
          }
        },
        async steer() {},
        async followUp() {},
        dispose() {},
      },
    });
    const { send } = await start(factory, { networkProbe: async () => down });

    const sent = await send("看这张图", [png]);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await vi.waitFor(() => expect(turnState(sent.turnId).state).toBe("queued"));
    down = null;
    await vi.waitFor(() => expect(turnState(sent.turnId)).toMatchObject({ state: "completed", assistant_text: "收到。" }), { timeout: 10_000 });
    expect(prompts.map((prompt) => prompt.images)).toEqual([[png], [png]]);
  });
});

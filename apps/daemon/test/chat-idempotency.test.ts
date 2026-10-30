// 用户发的消息重试时不能变成第二轮（2026-10-16：用户的 3 条消息从来没到 daemon）。
// 客户端先把消息写进本地发件箱，带一个稳定的 clientMessageId，连不上、超时、换 HTTP 兜底时都用同一个 id 重发。
// 网关按 binding + clientMessageId 去重：第二次收到同一条消息，回答第一次的那一轮，不再开一轮。
// 旧客户端不带这个字段，照旧每条命令一轮。新客户端看到 hello.v2 的 capability 才带它（旧 daemon 严格校验命令）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CHAT_CLIENT_MESSAGE_ID_CAPABILITY, ChatSendCommandSchema } from "@pi-lead-child/protocol";
import { Value } from "typebox/value";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-chat-idempotency-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
});

// 回答一句话就结束的 Lead。
function answeringLead() {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

async function client(name: string) {
  const issued = redeemPairing(db, createPairing(db, { name, kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
  );
  sockets.push(socket);
  const messages: any[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  const send = async (id: string, message: string, clientMessageId?: string) => {
    socket.send(JSON.stringify({
      type: "chat.send", id, protocolVersion: 2, message, ...(clientMessageId ? { clientMessageId } : {}),
    }));
    await vi.waitFor(() => expect(messages.some((entry) => entry.type === "command.result" && entry.id === id)).toBe(true));
    return messages.find((entry) => entry.type === "command.result" && entry.id === id);
  };
  const post = async (id: string, message: string, clientMessageId?: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message, ...(clientMessageId ? { clientMessageId } : {}) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { messages, send, post, bindingId: issued.binding.id };
}

const userTurns = () => db.prepare(
  "SELECT id, user_text FROM channel_turns WHERE origin_kind NOT LIKE 'system:%' ORDER BY created_at",
).all() as Array<{ id: string; user_text: string }>;

describe("chat.send with a client message id", () => {
  it("is advertised in hello.v2, and the shared schema accepts it", async () => {
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: answeringLead().factory as never, log: () => {} });
    const app = await client("app");
    const hello = app.messages.find((message) => message.type === "hello.v2");
    expect(hello.capabilities).toContain(CHAT_CLIENT_MESSAGE_ID_CAPABILITY);
    expect(Value.Check(ChatSendCommandSchema, {
      type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "hi", clientMessageId: "msg_1",
    })).toBe(true);
    // 旧客户端的命令照样合格。
    expect(Value.Check(ChatSendCommandSchema, { type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "hi" })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, {
      type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "hi", clientMessageId: "",
    })).toBe(false);
  });

  it("answers a retry with the first turn instead of starting a second one", async () => {
    const lead = answeringLead();
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {} });
    const app = await client("app");

    const first = await app.send("cmd-1", "帮我看看 #12", "msg_abc");
    // 第一次的回答丢了（连接断了），客户端用新的命令 id、同一个 clientMessageId 重发。
    const retry = await app.send("cmd-2", "帮我看看 #12", "msg_abc");
    expect(first.success).toBe(true);
    expect(retry).toMatchObject({ success: true, data: { turnId: first.data.turnId, duplicate: true } });
    // HTTP 兜底也认得它。
    const posted = await app.post("cmd-3", "帮我看看 #12", "msg_abc");
    expect(posted).toMatchObject({ status: 200, body: { turnId: first.data.turnId, duplicate: true } });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(userTurns()).toEqual([{ id: first.data.turnId, user_text: "帮我看看 #12" }]);
    expect(lead.prompts.filter((prompt) => prompt.includes("帮我看看 #12"))).toHaveLength(1);
  });

  it("keeps different messages, other clients and old clients apart", async () => {
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: answeringLead().factory as never, log: () => {} });
    const app = await client("app");
    const phone = await client("phone");

    const a = await app.send("cmd-a", "第一条", "msg_1");
    const b = await app.send("cmd-b", "第二条", "msg_2");
    // 另一台设备碰巧用了同一个 id：它是另一个 binding，不算重发。
    const other = await phone.send("cmd-c", "手机上的一条", "msg_1");
    // 旧客户端不带 clientMessageId：每条命令一轮。
    const oldA = await app.send("cmd-d", "旧客户端一", undefined);
    const oldB = await app.send("cmd-e", "旧客户端二", undefined);

    const ids = [a, b, other, oldA, oldB].map((result) => result.data.turnId);
    expect(new Set(ids).size).toBe(5);
    expect([a, b, other, oldA, oldB].every((result) => result.data.duplicate !== true)).toBe(true);
  });

  it("rejects an empty or oversized client message id over HTTP", async () => {
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: answeringLead().factory as never, log: () => {} });
    const app = await client("app");
    expect((await app.post("cmd-1", "hi", "x".repeat(200))).status).toBe(400);
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${redeemPairing(db, createPairing(db, { name: "x", kind: "companion", scopes: ["chat"] }).code).accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "cmd-2", message: "hi", clientMessageId: "" }),
    });
    expect(response.status).toBe(400);
  });
});

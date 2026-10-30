// 发给 Lead 的图片（protocol 的 chat-images.ts）：网关宣布能力、校验并解码图片、交给 chatV2；按 id 取图；会话快照列出图片。
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  CHAT_IMAGES_CAPABILITY, ChatImageSchema, ConversationTurnSchema, HelloV2Schema,
} from "@pi-lead-child/protocol";
import {
  createPairing, createTurn, insertChatImages, openDb, redeemPairing, type ChatImageData, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

// 1×1 的透明 PNG。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// JPEG 的文件头加几个字节：网关只核对文件头。
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

function issue() {
  const { code } = createPairing(db, { name: "web", kind: "companion", scopes: ["chat", "tickets:view"] });
  return redeemPairing(db, code);
}

type Chat = { message: string; itemId?: number; images?: ChatImageData[] };

async function start(options: { chatV2?: boolean } = {}) {
  const chats: Chat[] = [];
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
    ...(options.chatV2 === false ? {} : {
      chatV2: (command: Chat) => { chats.push(command); return { mode: "started" as const, turnId: `turn-${chats.length}` }; },
    }),
    ticketMessageV2: () => ({ mode: "started", turnId: "ticket-turn" }),
  }, { port: 0 });
  return { server, chats };
}

async function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/paired/events?token=${token}&protocol=2`);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  const send = async (command: Record<string, unknown>) => {
    ws.send(JSON.stringify({ type: "chat.send", protocolVersion: 2, ...command }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "command.result" && message.id === command.id))
      .toBe(true), { timeout: 10_000 });
    return messages.find((message) => message.type === "command.result" && message.id === command.id);
  };
  return { ws, messages, send };
}

function post(port: number, token: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("chat images over the paired gateway", () => {
  it("announces the capability only when Lead's chat handler exists", async () => {
    const issued = issue();
    for (const chatV2 of [true, false]) {
      const { server } = await start({ chatV2 });
      const client = await connect(server.port, issued.accessToken);
      try {
        const hello = client.messages.find((message) => message.type === "hello.v2");
        expect(Value.Check(HelloV2Schema, hello)).toBe(true);
        expect(hello.capabilities.includes(CHAT_IMAGES_CAPABILITY)).toBe(chatV2);
      } finally {
        client.ws.close();
        await server.close();
      }
    }
  });

  it("decodes the images of a WebSocket chat.send and hands them to Lead in order", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      const result = await client.send({
        id: "cmd-1", message: "看看这两张图",
        images: [{ mimeType: "image/png", data: PNG }, { mimeType: "image/jpeg", data: JPEG }],
      });
      expect(result).toMatchObject({ success: true, data: { mode: "started", turnId: "turn-1" } });
      expect(chats).toHaveLength(1);
      expect(chats[0]!.message).toBe("看看这两张图");
      expect(chats[0]!.images?.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
      expect(chats[0]!.images?.[0]!.data.equals(Buffer.from(PNG, "base64"))).toBe(true);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("accepts a message with only images and refuses one with neither text nor images", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      expect(await client.send({ id: "cmd-image-only", message: "", images: [{ mimeType: "image/png", data: PNG }] }))
        .toMatchObject({ success: true });
      expect(await client.send({ id: "cmd-empty", message: "  " }))
        .toMatchObject({ success: false, error: { code: "invalid_request", message: "message is required" } });
      expect(chats.map((chat) => chat.message)).toEqual([""]);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("refuses images whose content is not the declared format, bad base64, and images for a ticket", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      expect(await client.send({ id: "cmd-mismatch", message: "x", images: [{ mimeType: "image/webp", data: PNG }] }))
        .toMatchObject({ success: false, error: { code: "invalid_request", message: "image 1 is not a image/webp image" } });
      expect(await client.send({ id: "cmd-base64", message: "x", images: [{ mimeType: "image/png", data: "not base64!" }] }))
        .toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(await client.send({ id: "cmd-svg", message: "x", images: [{ mimeType: "image/svg+xml", data: PNG }] }))
        .toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(await client.send({
        id: "cmd-ticket", message: "x", context: { ticketId: 7 }, images: [{ mimeType: "image/png", data: PNG }],
      })).toMatchObject({ success: false, error: { message: "images are only accepted in the Lead conversation" } });
      expect(await client.send({
        id: "cmd-many", message: "x", images: Array.from({ length: 9 }, () => ({ mimeType: "image/png", data: PNG })),
      })).toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(chats).toEqual([]);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("takes a chat.send larger than the 1 MB body limit when it carries images, over WebSocket and HTTP", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    // 3 MB 的「PNG」：文件头对，后面是填充。
    const bytes = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(3 * 1024 * 1024, 7)]);
    const big = bytes.toString("base64");
    try {
      expect(await client.send({ id: "cmd-big", message: "大图", images: [{ mimeType: "image/png", data: big }] }))
        .toMatchObject({ success: true });
      const response = await post(server.port, issued.accessToken, {
        id: "cmd-big-http", message: "大图", images: [{ mimeType: "image/png", data: big }],
      });
      expect(response.status).toBe(200);
      expect(chats.map((chat) => chat.images?.[0]?.data.equals(bytes))).toEqual([true, true]);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("answers a refused HTTP chat send with 400, so the client's outbox does not retry it forever", async () => {
    const issued = issue();
    const { server, chats } = await start();
    try {
      const mismatch = await post(server.port, issued.accessToken, {
        id: "cmd-http", message: "x", images: [{ mimeType: "image/gif", data: PNG }],
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toMatchObject({ error: { code: "invalid_request" } });
      const imageOnly = await post(server.port, issued.accessToken, {
        id: "cmd-http-image", message: "", images: [{ mimeType: "image/png", data: PNG }],
      });
      expect(imageOnly.status).toBe(200);
      expect((await post(server.port, issued.accessToken, { id: "cmd-http-empty", message: "" })).status).toBe(400);
      expect(chats.map((chat) => chat.images?.length)).toEqual([1]);
    } finally {
      await server.close();
    }
  });

  it("serves a stored image by id to a chat binding and lists a turn's images when asked", async () => {
    const issued = issue();
    const turn = createTurn(db, { originKind: "paired:companion", userText: "图在这里", state: "completed" });
    const plain = createTurn(db, { originKind: "paired:companion", userText: "没有图", state: "completed" });
    const [ref] = insertChatImages(db, turn.id, [{ mimeType: "image/png", data: Buffer.from(PNG, "base64") }]);
    const { server } = await start();
    const get = (path: string, token = issued.accessToken) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    try {
      const image = await get(`/v1/chat/images/${ref!.id}`);
      expect(image.status).toBe(200);
      const body = await image.json();
      expect(Value.Check(ChatImageSchema, body)).toBe(true);
      expect(body).toEqual({ id: ref!.id, mimeType: "image/png", data: PNG });
      expect((await get("/v1/chat/images/img_missing")).status).toBe(404);
      expect((await get("/v1/chat/images/..%2Fplc.db")).status).toBe(404);
      expect((await get(`/v1/chat/images/${ref!.id}`, "wrong-token")).status).toBe(401);

      const withImages = await (await get("/v1/conversation/turns?include=tool_calls,images")).json();
      for (const item of withImages.items) expect(Value.Check(ConversationTurnSchema, item)).toBe(true);
      expect(withImages.items.find((item: any) => item.id === turn.id).images).toEqual([{ id: ref!.id, mimeType: "image/png" }]);
      expect(withImages.items.find((item: any) => item.id === plain.id).images).toBeUndefined();
      // 不要 images 的旧客户端拿到的记录和以前一样。
      const without = await (await get("/v1/conversation/turns?include=tool_calls")).json();
      expect(without.items.every((item: any) => !("images" in item))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// 用户同时开着几台已配对的设备（桌面 App、手机、plc）。一台设备发的消息和 Lead 的回答，
// 别的设备也要实时看到，不用重新加载（2026-11-10）。以前一轮的事件只发给发起它的 binding：
// 别的设备没有那句提问。现在 lead.turn.started 带着用户的话，事件发给所有带 chat scope 的 binding。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, writeBusyPlacement, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-multi-device-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 不调用模型的 Lead：每次 prompt 说一句话。hang：第一次 prompt 等到 release() 才结束。
function stubLead(options: { hang?: boolean } = {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  let release: (() => void) | null = null;
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        if (options.hang && prompts.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我看过了，" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已经处理。" } });
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts, release: () => release?.() };
}

async function start(lead = stubLead()) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  return lead;
}

// 一台用 v2 协议连着的设备。afterSeq=-1：只收连上之后的新事件；0：从头补发。
async function device(
  name: string,
  options: { scopes?: string[]; afterSeq?: number } = {},
) {
  const pairing = createPairing(db, { name, kind: "companion", scopes: options.scopes ?? ["chat", "tickets:view"] });
  const issued = redeemPairing(db, pairing.code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=${options.afterSeq ?? -1}`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const chat = (message: string): string => {
    const id = `cmd-${name}-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    return id;
  };
  const turnOf = async (commandId: string): Promise<string> => {
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === commandId)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === commandId).data.turnId as string;
  };
  return { bindingId: issued.binding.id, events, chat, turnOf };
}

function turnEvents(events: any[], turnId: string): any[] {
  return events.filter((event) => event.eventId && event.turnId === turnId);
}

function text(events: any[], turnId: string): string {
  return turnEvents(events, turnId).filter((event) => event.type === "lead.message.delta").map((event) => event.payload.delta).join("");
}

describe("a user turn sent from one paired device", () => {
  it("streams live to the user's other paired devices, with the question", async () => {
    await start();
    const phone = await device("phone");
    const desktop = await device("desktop");

    const turnId = await phone.turnOf(phone.chat("今天有什么要处理的？"));

    for (const client of [desktop, phone]) {
      await vi.waitFor(() => expect(turnEvents(client.events, turnId).some((event) => event.type === "lead.message.completed")).toBe(true));
      const started = turnEvents(client.events, turnId).find((event) => event.type === "lead.turn.started");
      expect(started?.payload).toMatchObject({ mode: "started", originKind: "paired:companion", userText: "今天有什么要处理的？" });
      expect(text(client.events, turnId)).toBe("我看过了，已经处理。");
      expect(turnEvents(client.events, turnId).every((event) => event.audienceBindingId === null)).toBe(true);
    }
    // 回执只给发命令的那台设备：它是对这条命令的回答，不是一轮的事件。
    expect(desktop.events.some((event) => event.type === "command.result")).toBe(false);
  }, 15_000);

  it("shows a message queued behind a running turn on the device that did not send it", async () => {
    // 「Lead 忙时你发的消息」选排队（followUp）：这条消息排在正在跑的一轮后面。
    writeBusyPlacement(db, "followUp");
    const lead = await start(stubLead({ hang: true }));
    const phone = await device("phone");
    const desktop = await device("desktop");

    const first = await phone.turnOf(phone.chat("先查一下日程"));
    await vi.waitFor(() => expect(lead.prompts).toHaveLength(1));
    const queued = await desktop.turnOf(desktop.chat("再看看邮件"));

    await vi.waitFor(() => expect(turnEvents(phone.events, queued).find((event) => event.type === "lead.turn.started")?.payload)
      .toMatchObject({ mode: "queued", userText: "再看看邮件" }));
    lead.release();
    for (const turnId of [first, queued]) {
      await vi.waitFor(() => expect(turnEvents(phone.events, turnId).some((event) => event.type === "lead.message.completed")).toBe(true));
      await vi.waitFor(() => expect(turnEvents(desktop.events, turnId).some((event) => event.type === "lead.message.completed")).toBe(true));
    }
  }, 15_000);

  it("replays the turn to a device that connects later", async () => {
    await start();
    const phone = await device("phone");
    const turnId = await phone.turnOf(phone.chat("提醒我明天交周报"));
    await vi.waitFor(() => expect(turnEvents(phone.events, turnId).some((event) => event.type === "lead.message.completed")).toBe(true));

    const desktop = await device("desktop", { afterSeq: 0 });
    await vi.waitFor(() => expect(turnEvents(desktop.events, turnId).map((event) => event.type))
      .toEqual(expect.arrayContaining(["lead.turn.started", "lead.message.delta", "lead.message.completed"])));
    expect(text(desktop.events, turnId)).toBe("我看过了，已经处理。");
  }, 15_000);

  it("does not reach a binding without the chat scope", async () => {
    await start();
    const phone = await device("phone");
    const viewer = await device("viewer", { scopes: ["tickets:view"] });
    const turnId = await phone.turnOf(phone.chat("今天有什么要处理的？"));
    await vi.waitFor(() => expect(turnEvents(phone.events, turnId).some((event) => event.type === "lead.message.completed")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewer.events.filter((event) => event.type?.startsWith("lead."))).toEqual([]);
  }, 15_000);
});

// 「只这一条」（模型配置方案 C 的 D8）：网关宣布 chat.turn-model.v1、把 chat.send 的单轮模型交给 chatV2；
// 会话里换模型的浮层带 live=1 时，模型目录多给 inSession。
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { CHAT_TURN_MODEL_CAPABILITY, HelloV2Schema, LeadModelCatalogSchema, type LeadModelCatalog } from "@pi-lead-child/protocol";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

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

type Chat = { message: string; itemId?: number; turnModel?: string };

const catalog: LeadModelCatalog = {
  current: { model: "openai-codex/gpt-5.5", effort: null },
  selected: { model: "openai-codex/gpt-5.5", effort: null },
  models: [],
};

async function start(options: { turnModel?: boolean; inSession?: boolean; models?: LeadModelCatalog["models"] } = {}) {
  const chats: Chat[] = [];
  const tickets: Chat[] = [];
  const leadModels = {
    state: () => ({ current: catalog.current, selected: catalog.selected }),
    catalog: async () => ({ ...catalog, models: options.models ?? catalog.models }),
    switch: async () => { throw new Error("not used"); },
    ...(options.inSession === false ? {} : { inSession: () => "openai-codex-2/gpt-5.5" }),
  };
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
    chatV2: (command: Chat) => { chats.push(command); return { mode: "started" as const, turnId: `turn-${chats.length}` }; },
    ...(options.turnModel === false ? {} : { chatTurnModel: true }),
    ticketMessageV2: (command: Chat) => { tickets.push(command); return { mode: "started", turnId: "ticket-turn" }; },
    uiActionServices: { leadModels },
  } as Parameters<typeof startPairedServer>[0], { port: 0 });
  return { server, chats, tickets };
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

describe("the one-message model over the paired gateway", () => {
  it("announces the capability in the existing capabilities list only when the daemon takes it", async () => {
    const issued = issue();
    for (const turnModel of [true, false]) {
      const { server } = await start({ turnModel });
      const client = await connect(server.port, issued.accessToken);
      try {
        const hello = client.messages.find((message) => message.type === "hello.v2");
        // hello.v2 是严格的契约：能力只进 capabilities，不加字段。
        expect(Value.Check(HelloV2Schema, hello)).toBe(true);
        expect(hello.capabilities.includes(CHAT_TURN_MODEL_CAPABILITY)).toBe(turnModel);
      } finally {
        client.ws.close();
        await server.close();
      }
    }
  });

  it("hands the model and the effort to Lead as one spec, over WebSocket and HTTP", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      const result = await client.send({ id: "cmd-1", message: "Think harder", turnModel: { model: "vibeproxy/claude-opus-5-5", effort: "high" } });
      expect(result).toMatchObject({ success: true, data: { mode: "started", turnId: "turn-1" } });
      expect(chats[0]).toMatchObject({ message: "Think harder", turnModel: "vibeproxy/claude-opus-5-5(high)" });
      const response = await post(server.port, issued.accessToken, {
        id: "cmd-2", message: "Again", turnModel: { model: "openai-codex-2/gpt-5.5", effort: null },
      });
      expect(response.status).toBe(200);
      expect(chats[1]).toMatchObject({ message: "Again", turnModel: "openai-codex-2/gpt-5.5" });
      // 不带的照旧。
      await client.send({ id: "cmd-3", message: "Plain" });
      expect(chats[2]!.turnModel).toBeUndefined();
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("refuses a one-message model in a ticket chat, from an old daemon, and in a bad shape", async () => {
    const issued = issue();
    const { server, chats, tickets } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      const ticket = await client.send({ id: "cmd-t", message: "hi", context: { ticketId: 7 }, turnModel: { model: "vibeproxy/claude", effort: null } });
      expect(ticket).toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(tickets).toHaveLength(0);
      const bad = await post(server.port, issued.accessToken, { id: "cmd-b", message: "hi", turnModel: { model: "vibeproxy/claude" } });
      expect(bad.status).toBe(400);
      expect(chats).toHaveLength(0);
    } finally {
      client.ws.close();
      await server.close();
    }
    const old = await start({ turnModel: false });
    try {
      const response = await post(old.server.port, issued.accessToken, { id: "cmd-o", message: "hi", turnModel: { model: "vibeproxy/claude", effort: null } });
      expect(response.status).toBe(400);
      expect(old.chats).toHaveLength(0);
    } finally {
      await old.server.close();
    }
  });

  it("gives the model in the session only to a client that asks with live=1", async () => {
    const issued = issue();
    const { server } = await start();
    try {
      const plain = await (await fetch(`http://127.0.0.1:${server.port}/v1/lead/models`, { headers: { authorization: `Bearer ${issued.accessToken}` } })).json();
      expect(plain).not.toHaveProperty("inSession");
      const live = await (await fetch(`http://127.0.0.1:${server.port}/v1/lead/models?live=1`, { headers: { authorization: `Bearer ${issued.accessToken}` } })).json();
      expect(live.inSession).toBe("openai-codex-2/gpt-5.5");
      expect(Value.Check(LeadModelCatalogSchema, live)).toBe(true);
    } finally {
      await server.close();
    }
  });

  // A magpie model's route (its channel: routing group, Claude Code, Codex) tells apart two models with the same name.
  // Like inSession, only a client that asks with live=1 gets it: an older Companion's strict schema rejects the field.
  it("gives the route of a magpie model only to a client that asks with live=1", async () => {
    const issued = issue();
    const fable = (id: string, route: string) => ({
      model: `magpie/${id}`, provider: "magpie", id, prefix: null, source: "claude", name: "Claude Fable 5.2", image: true,
      efforts: [], defaultEffort: null, blockedUntil: null, route,
    });
    const { server } = await start({ models: [fable("auto/claude-fable-5-2", "routing group"), fable("claude/claude-fable-5-2", "Claude Code")] });
    try {
      const headers = { authorization: `Bearer ${issued.accessToken}` };
      const plain = await (await fetch(`http://127.0.0.1:${server.port}/v1/lead/models`, { headers })).json();
      expect(plain.models.map((model: Record<string, unknown>) => Object.hasOwn(model, "route"))).toEqual([false, false]);
      expect(plain.models.map((model: { id: string }) => model.id)).toEqual(["auto/claude-fable-5-2", "claude/claude-fable-5-2"]);
      const live = await (await fetch(`http://127.0.0.1:${server.port}/v1/lead/models?live=1`, { headers })).json();
      expect(live.models.map((model: { route: string }) => model.route)).toEqual(["routing group", "Claude Code"]);
      expect(Value.Check(LeadModelCatalogSchema, live)).toBe(true);
    } finally {
      await server.close();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  CHAT_PLACEMENT_CAPABILITY,
  TICKET_CHAT_ANSWERER_CAPABILITY,
  ApprovalSchema,
  ChatSendCommandSchema,
  GatewayEventSchema,
  HelloV2Schema,
  StatusGetCommandSchema,
  SyncResumeCommandSchema,
  TicketDetailSchema,
  TicketSummarySchema,
} from "@pi-lead-child/protocol";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, redeemPairing, revokeBinding } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { publishGatewayEvent } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

function runtime() {
  return {
    model: "stub/model", sessionId: "stub-session", busy: false,
    runningItemIds: [], aish: null,
  };
}

function issue(name: string, scopes: string[]) {
  const { code } = createPairing(db, { name, kind: "companion", scopes });
  return redeemPairing(db, code);
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  return { ws, messages };
}

describe("paired WebSocket protocol v2", () => {
  it("keeps additive checkpoint resources outside frozen v2 summaries and events", () => {
    const summary = {
      id: 42,
      title: "协议审计",
      summary: "保持 paired v2 冻结",
      kind: "task",
      stage: "active",
      status: "active",
      hasRun: true,
      priority: "high",
      project: "pi-lead-child",
      dueAt: null,
      deferUntil: null,
      updatedAt: "2026-07-24T04:00:00.000Z",
      runtime: { state: "running", lastActivityAt: null, activeAttemptId: 73 },
      attention: { pendingApprovalCount: 1, blockerCount: 0 },
    };
    expect(Value.Check(TicketSummarySchema, summary)).toBe(true);
    for (const field of [
      "progress", "checkpoint", "timing", "intervention", "proofItems", "pow", "artifacts",
    ] as const) {
      expect(Value.Check(TicketSummarySchema, { ...summary, [field]: {} })).toBe(false);
    }

    const event = {
      protocolVersion: 2,
      eventId: "evt-1",
      seq: 1,
      type: "ticket.updated",
      occurredAt: "2026-07-24T04:00:00.000Z",
      requiredScope: "tickets:view",
      audienceBindingId: null,
      turnId: null,
      ticketId: 42,
      payload: { snapshotRequired: true },
    };
    expect(Value.Check(GatewayEventSchema, event)).toBe(true);
    for (const field of ["checkpoint", "progress", "proofItems", "pow", "artifact"] as const) {
      expect(Value.Check(GatewayEventSchema, { ...event, [field]: {} })).toBe(false);
    }
    for (const type of [
      "intervention.required", "checkpoint.created", "proof.updated", "artifact.created", "workbench.updated",
    ]) {
      expect(Value.Check(GatewayEventSchema, { ...event, type })).toBe(false);
    }

    const detail = {
      ticket: summary,
      brief: "冻结详情契约",
      body: "",
      workdir: null,
      createdAt: "2026-07-24T04:00:00.000Z",
      totalTokens: 0,
      totalCostUsd: 0,
      remindAt: null,
    };
    expect(Value.Check(TicketDetailSchema, detail)).toBe(true);
    for (const field of ["timing", "progress", "proofItems", "pow", "artifacts"] as const) {
      expect(Value.Check(TicketDetailSchema, { ...detail, [field]: {} })).toBe(false);
    }

    const approval = {
      id: 18,
      ticketId: 42,
      requestedBy: "child",
      tool: "paired_api",
      action: "授权操作",
      payload: {},
      status: "pending",
      expiresAt: "2026-07-24T04:30:00.000Z",
      createdAt: "2026-07-24T04:00:00.000Z",
    };
    expect(Value.Check(ApprovalSchema, approval)).toBe(true);
    expect(Value.Check(ApprovalSchema, { ...approval, checkpointId: 12 })).toBe(false);

    expect(Value.Check(ChatSendCommandSchema, {
      type: "chat.send", id: "cmd-chat", protocolVersion: 2, message: "继续",
    })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, {
      type: "chat.send", id: "cmd-chat", protocolVersion: 2, message: "继续", checkpoint: {},
    })).toBe(false);
    expect(Value.Check(StatusGetCommandSchema, {
      type: "status.get", id: "cmd-status", protocolVersion: 2,
    })).toBe(true);
    expect(Value.Check(SyncResumeCommandSchema, {
      type: "sync.resume", id: "cmd-sync", protocolVersion: 2, afterSeq: 0,
    })).toBe(true);
  });

  it("negotiates hello.v2 and correlates chat/status commands", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const chats: any[] = [];
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
      chatV2: (command) => { chats.push(command); return { mode: "started", turnId: "turn-1" }; },
    }, { port: 0 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      const hello = client.messages.find((message) => message.type === "hello.v2");
      expect(Value.Check(HelloV2Schema, hello)).toBe(true);
      expect(hello).toMatchObject({
        protocolVersion: 2,
        binding: { id: issued.binding.id, scopes: ["chat", "tickets:view"] },
        daemon: { model: "stub/model", sessionId: "stub-session", busy: false },
        latestSeq: 0,
      });

      client.ws.send(JSON.stringify({
        type: "chat.send", id: "cmd-chat", protocolVersion: 2,
        message: "继续", context: { ticketId: 42 },
      }));
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.type === "command.result" && message.id === "cmd-chat" && message.success)).toBe(true));
      expect(chats).toEqual([expect.objectContaining({
        message: "继续", bindingId: issued.binding.id, itemId: 42,
      })]);
      expect(client.messages.find((message) => message.id === "cmd-chat").data)
        .toEqual({ mode: "started", turnId: "turn-1" });

      client.ws.send(JSON.stringify({ type: "status.get", id: "cmd-status", protocolVersion: 2 }));
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.id === "cmd-status" && message.data?.model === "stub/model")).toBe(true));
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("routes ticket-scoped chat commands to the ticket message handler before Lead", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const leadChats: any[] = [];
    const ticketMessages: any[] = [];
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db,
      controlPlane: service,
      hello: runtime,
      chat: () => "started",
      addClient: () => () => {},
      log: () => {},
      chatV2: (command) => {
        leadChats.push(command);
        return { mode: "started", turnId: "lead-turn" };
      },
      ticketMessageV2: (command) => {
        ticketMessages.push(command);
        return { mode: "started", turnId: "ticket-turn" };
      },
    }, { port: 0 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      client.ws.send(JSON.stringify({
        type: "chat.send", id: "cmd-ticket", protocolVersion: 2,
        message: "这个单需要我干什么", context: { ticketId: 49 },
      }));
      client.ws.send(JSON.stringify({
        type: "chat.send", id: "cmd-lead", protocolVersion: 2,
        message: "全局问题",
      }));

      await vi.waitFor(() => expect(client.messages.filter((message) =>
        message.type === "command.result" && message.success)).toHaveLength(2));
      expect(ticketMessages).toEqual([expect.objectContaining({
        message: "这个单需要我干什么",
        itemId: 49,
        commandId: "cmd-ticket",
      })]);
      expect(leadChats).toEqual([expect.objectContaining({
        message: "全局问题",
        itemId: undefined,
        commandId: "cmd-lead",
      })]);
      expect(client.messages.find((message) => message.id === "cmd-ticket").data)
        .toEqual({ mode: "started", turnId: "ticket-turn" });
      expect(client.messages.find((message) => message.id === "cmd-lead").data)
        .toEqual({ mode: "started", turnId: "lead-turn" });
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("routes HTTP chat sends through the same ticket-scoped handler", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const leadChats: any[] = [];
    const ticketMessages: any[] = [];
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db,
      controlPlane: service,
      hello: runtime,
      chat: () => "started",
      addClient: () => () => {},
      log: () => {},
      chatV2: (command) => {
        leadChats.push(command);
        return { mode: "started", turnId: "lead-turn" };
      },
      ticketMessageV2: (command) => {
        ticketMessages.push(command);
        return { mode: "started", turnId: "ticket-http-turn" };
      },
    }, { port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "cmd-ticket-http",
          message: "这个单需要我干什么",
          context: { ticketId: 49 },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ mode: "started", turnId: "ticket-http-turn" });
      expect(ticketMessages).toEqual([expect.objectContaining({
        message: "这个单需要我干什么",
        itemId: 49,
        commandId: "cmd-ticket-http",
      })]);
      expect(leadChats).toEqual([]);
    } finally {
      await server.close();
    }
  });

  // 工单 04（spec D6）：Lead 正忙时插话还是排队。daemon 宣布能力；WebSocket 和 HTTP 都把 mode 交给 Lead 的处理函数，
  // 排队的消息回 queued；不认识的取值拒掉。旧客户端不带 mode，照旧是插话。
  it("passes the placement the user chose to Lead's handler, over WebSocket and HTTP", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const chats: any[] = [];
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
      chatV2: (command) => {
        chats.push(command);
        return command.mode === "followUp" ? { mode: "queued", turnId: `turn-${chats.length}` } : { mode: "steered", turnId: `turn-${chats.length}` };
      },
    }, { port: 0 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      expect(client.messages.find((message) => message.type === "hello.v2").capabilities).toContain(CHAT_PLACEMENT_CAPABILITY);
      client.ws.send(JSON.stringify({ type: "chat.send", id: "cmd-queue", protocolVersion: 2, message: "排队", mode: "followUp" }));
      client.ws.send(JSON.stringify({ type: "chat.send", id: "cmd-old", protocolVersion: 2, message: "旧客户端" }));
      client.ws.send(JSON.stringify({ type: "chat.send", id: "cmd-bad", protocolVersion: 2, message: "坏的", mode: "later" }));
      await vi.waitFor(() => expect(client.messages.filter((message) => message.type === "command.result")).toHaveLength(3));
      expect(client.messages.find((message) => message.id === "cmd-queue").data).toEqual({ mode: "queued", turnId: "turn-1" });
      expect(client.messages.find((message) => message.id === "cmd-old").data).toEqual({ mode: "steered", turnId: "turn-2" });
      expect(client.messages.find((message) => message.id === "cmd-bad")).toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(chats.map((command) => command.mode)).toEqual(["followUp", undefined]);

      const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.port}/v1/chat/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const queued = await post({ id: "http-queue", message: "排队", mode: "followUp" });
      await expect(queued.json()).resolves.toEqual({ mode: "queued", turnId: "turn-3" });
      expect((await post({ id: "http-bad", message: "坏的", mode: "later" })).status).toBe(400);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  // 工单 08 第一版的 context.answerer（chat.ticket-answerer.v1）是已发布的线上字段。2026-10-19 起工单对话一律交给
  // 工单的 agent：网关不再宣布这个能力，旧客户端带了照样收下（形状照旧校验），但不交给工单消息的处理函数。
  it("accepts an old client's answerer over WebSocket and HTTP without passing it on", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const ticketMessages: any[] = [];
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
      ticketMessageV2: (command) => {
        ticketMessages.push(command);
        return { mode: "started", turnId: `turn-${ticketMessages.length}` };
      },
    }, { port: 0 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      expect(client.messages.find((message) => message.type === "hello.v2").capabilities).not.toContain(TICKET_CHAT_ANSWERER_CAPABILITY);
      const send = (id: string, context: Record<string, unknown>) => client.ws.send(JSON.stringify({
        type: "chat.send", id, protocolVersion: 2, message: "进展？", context,
      }));
      send("cmd-lead", { ticketId: 77, answerer: "lead" });
      send("cmd-plain", { ticketId: 77 });
      send("cmd-bad", { ticketId: 77, answerer: "child" });
      await vi.waitFor(() => expect(client.messages.filter((message) => message.type === "command.result")).toHaveLength(3));
      expect(client.messages.find((message) => message.id === "cmd-lead").data).toEqual({ mode: "started", turnId: "turn-1" });
      expect(client.messages.find((message) => message.id === "cmd-bad")).toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(ticketMessages).toHaveLength(2);
      for (const command of ticketMessages) expect("answerer" in command).toBe(false);

      const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.port}/v1/chat/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const agent = await post({ id: "http-agent", message: "把 README 改一下", context: { ticketId: 77, answerer: "agent" } });
      await expect(agent.json()).resolves.toEqual({ mode: "started", turnId: "turn-3" });
      expect(ticketMessages[2]).toMatchObject({ itemId: 77, message: "把 README 改一下" });
      expect("answerer" in ticketMessages[2]).toBe(false);
      expect((await post({ id: "http-bad", message: "x", context: { ticketId: 77, answerer: "child" } })).status).toBe(400);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("rejects commands outside the binding scope with a stable error", async () => {
    const issued = issue("read-only", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      client.ws.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "hi" }));
      await vi.waitFor(() => expect(client.messages.some((message) => message.id === "cmd-1")).toBe(true));
      expect(client.messages.find((message) => message.id === "cmd-1")).toEqual({
        type: "command.result", id: "cmd-1", success: false,
        error: { code: "forbidden", message: "missing scope: chat" },
      });
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("delivers private events only to the audience binding and filters broadcast scopes", async () => {
    const first = issue("first", ["chat", "tickets:view"]);
    const second = issue("second", ["chat"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    const one = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${first.accessToken}&protocol=2`);
    const two = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${second.accessToken}&protocol=2`);
    try {
      const privateEvent = server.publish({
        eventId: "evt-private", type: "lead.message.delta", requiredScope: "chat",
        audienceBindingId: first.binding.id, turnId: "turn-1", payload: { delta: "private" },
      });
      const ticketEvent = server.publish({
        eventId: "evt-ticket", type: "ticket.updated", requiredScope: "tickets:view",
        payload: { ticketId: 42 },
      });
      expect(ticketEvent.seq).toBe(privateEvent.seq + 1);

      await vi.waitFor(() => expect(one.messages.some((message) => message.eventId === "evt-ticket")).toBe(true));
      expect(one.messages.some((message) => message.eventId === "evt-private")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(two.messages.some((message) => message.eventId === "evt-private")).toBe(false);
      expect(two.messages.some((message) => message.eventId === "evt-ticket")).toBe(false);
    } finally {
      one.ws.close(); two.ws.close();
      await server.close();
    }
  });

  it("delivers durable outbox rows written outside server.publish to connected clients", async () => {
    const issued = issue("external-writer", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 5 });
    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    try {
      publishGatewayEvent(db, {
        eventId: "evt-external-writer",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 42,
        payload: { ticketId: 42, snapshotRequired: true },
      });

      await vi.waitFor(() => expect(client.messages.filter((message) =>
        message.eventId === "evt-external-writer")).toHaveLength(1));
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("does not redeliver a replayed durable row when the live outbox flusher catches up", async () => {
    const issued = issue("replay-catchup", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 60_000 });
    publishGatewayEvent(db, {
      eventId: "evt-before-replay",
      type: "ticket.updated",
      requiredScope: "tickets:view",
      itemId: 41,
      payload: { ticketId: 41, snapshotRequired: true },
    });
    const client = await connect(
      `ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=0`,
    );
    try {
      await vi.waitFor(() => expect(client.messages.filter((message) =>
        message.eventId === "evt-before-replay")).toHaveLength(1));
      server.publish({
        eventId: "evt-live-trigger",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 42,
        payload: { ticketId: 42, snapshotRequired: true },
      });
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.eventId === "evt-live-trigger")).toBe(true));
      expect(client.messages.filter((message) => message.eventId === "evt-before-replay"))
        .toHaveLength(1);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("replays all 501 connection backlog rows before delivering the next live event", async () => {
    const issued = issue("large-connect-replay", ["tickets:view"]);
    for (let index = 1; index <= 501; index++) {
      publishGatewayEvent(db, {
        eventId: `evt-connect-${index}`,
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: index,
        payload: { ticketId: index, snapshotRequired: true },
      });
    }
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 60_000 });
    const client = await connect(
      `ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=0`,
    );
    try {
      await vi.waitFor(() => expect(client.messages.filter((message) => message.eventId))
        .toHaveLength(501), { timeout: 5_000 });

      server.publish({
        eventId: "evt-connect-live",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 502,
        payload: { ticketId: 502, snapshotRequired: true },
      });
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.eventId === "evt-connect-live")).toBe(true));

      const eventIds = client.messages
        .filter((message) => message.eventId)
        .map((message) => message.eventId);
      expect(eventIds).toEqual([
        ...Array.from({ length: 501 }, (_, index) => `evt-connect-${index + 1}`),
        "evt-connect-live",
      ]);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("advances the live cursor after an explicit sync.resume replay", async () => {
    const issued = issue("resume-catchup", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 60_000 });
    const client = await connect(
      `ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2`,
    );
    try {
      publishGatewayEvent(db, {
        eventId: "evt-resumed",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 41,
        payload: { ticketId: 41, snapshotRequired: true },
      });
      client.ws.send(JSON.stringify({
        type: "sync.resume", id: "cmd-resume", protocolVersion: 2, afterSeq: 0,
      }));
      await vi.waitFor(() => expect(client.messages.filter((message) =>
        message.eventId === "evt-resumed")).toHaveLength(1));

      server.publish({
        eventId: "evt-after-resume",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 42,
        payload: { ticketId: 42, snapshotRequired: true },
      });
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.eventId === "evt-after-resume")).toBe(true));
      expect(client.messages.filter((message) => message.eventId === "evt-resumed"))
        .toHaveLength(1);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("does not redeliver live-delivered events when sync.resume rewinds below the live watermark", async () => {
    const issued = issue("resume-no-redup", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 60_000 });
    const client = await connect(
      `ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=0`,
    );
    try {
      for (let index = 1; index <= 3; index++) {
        server.publish({
          eventId: `evt-live-${index}`,
          type: "ticket.updated",
          requiredScope: "tickets:view",
          itemId: index,
          payload: { ticketId: index, snapshotRequired: true },
        });
      }
      await vi.waitFor(() => expect(client.messages.filter((message) => message.eventId))
        .toHaveLength(3));

      client.ws.send(JSON.stringify({
        type: "sync.resume", id: "cmd-rewind", protocolVersion: 2, afterSeq: 0,
      }));
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.type === "command.result" && message.id === "cmd-rewind")).toBe(true));
      expect(client.messages.find((message) => message.id === "cmd-rewind")?.data)
        .toMatchObject({ replayed: 0, latestSeq: 3 });

      server.publish({
        eventId: "evt-live-4",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 4,
        payload: { ticketId: 4, snapshotRequired: true },
      });
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.eventId === "evt-live-4")).toBe(true));

      const eventIds = client.messages
        .filter((message) => message.eventId)
        .map((message) => message.eventId);
      expect(eventIds).toEqual(["evt-live-1", "evt-live-2", "evt-live-3", "evt-live-4"]);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("replays all 1200 sync.resume rows before live delivery without duplicates", async () => {
    const issued = issue("large-resume-replay", ["tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0, outboxPollMs: 60_000 });
    const client = await connect(
      `ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=0`,
    );
    try {
      for (let index = 1; index <= 1_200; index++) {
        publishGatewayEvent(db, {
          eventId: `evt-resume-${index}`,
          type: "ticket.updated",
          requiredScope: "tickets:view",
          itemId: index,
          payload: { ticketId: index, snapshotRequired: true },
        });
      }
      client.ws.send(JSON.stringify({
        type: "sync.resume", id: "cmd-large-resume", protocolVersion: 2, afterSeq: 0,
      }));

      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.type === "command.result" && message.id === "cmd-large-resume")).toBe(true),
      { timeout: 5_000 });
      expect(client.messages.find((message) => message.id === "cmd-large-resume")?.data)
        .toMatchObject({ replayed: 1_200, latestSeq: 1_200 });

      server.publish({
        eventId: "evt-resume-live",
        type: "ticket.updated",
        requiredScope: "tickets:view",
        itemId: 1_201,
        payload: { ticketId: 1_201, snapshotRequired: true },
      });
      await vi.waitFor(() => expect(client.messages.some((message) =>
        message.eventId === "evt-resume-live")).toBe(true));

      const eventIds = client.messages
        .filter((message) => message.eventId)
        .map((message) => message.eventId);
      expect(eventIds).toEqual([
        ...Array.from({ length: 1_200 }, (_, index) => `evt-resume-${index + 1}`),
        "evt-resume-live",
      ]);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("replays ordered visible events from after_seq and refuses revoked bindings", async () => {
    const issued = issue("phone", ["chat", "tickets:view"]);
    const service = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane: service, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    server.publish({ eventId: "evt-1", type: "ticket.updated", requiredScope: "tickets:view", payload: { ticketId: 1 } });
    server.publish({ eventId: "evt-2", type: "lead.message.delta", requiredScope: "chat", audienceBindingId: issued.binding.id, payload: { delta: "x" } });

    const client = await connect(`ws://127.0.0.1:${server.port}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=0`);
    try {
      await vi.waitFor(() => expect(client.messages.filter((message) => message.eventId).length).toBe(2));
      expect(client.messages.filter((message) => message.eventId).map((message) => message.eventId)).toEqual(["evt-1", "evt-2"]);

      revokeBinding(db, issued.binding.id);
      client.ws.send(JSON.stringify({ type: "status.get", id: "after-revoke", protocolVersion: 2 }));
      await new Promise<void>((resolve) => client.ws.once("close", () => resolve()));
      expect(client.ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.close();
      await server.close();
    }
  });
});

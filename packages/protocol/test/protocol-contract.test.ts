import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgendaItemSchema,
  CommandResultSchema,
  GatewayEventSchema,
  HelloV2Schema,
  HttpErrorResponseSchema,
  PairingRedeemResponseSchema,
  PROTOCOL_VERSION,
  ScopeSchema,
  TicketDetailSchema,
  TicketSummarySchema,
  WsTicketResponseSchema,
  WsCommandSchema,
} from "../src/index.js";

describe("control-plane protocol contract", () => {
  it("freezes protocol version and recognized scopes", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    for (const scope of ["chat", "tickets:view", "tickets:create", "approvals:respond", "notices"]) {
      expect(Value.Check(ScopeSchema, scope)).toBe(true);
    }
    expect(Value.Check(ScopeSchema, "admin:everything")).toBe(false);
  });

  it("validates ticket summaries without a fabricated progress percentage", () => {
    const ticket = {
      id: 42,
      title: "协议缺口审计",
      summary: "核对 paired control-plane",
      kind: "task",
      stage: "active",
      status: "active",
      hasRun: true,
      priority: "high",
      project: "pi-lead-child",
      dueAt: null,
      deferUntil: null,
      updatedAt: "2026-07-23T05:00:00.000Z",
      runtime: {
        state: "running",
        lastActivityAt: "2026-07-23T05:01:00.000Z",
        activeAttemptId: 73,
      },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    };
    expect(Value.Check(TicketSummarySchema, ticket)).toBe(true);
    expect(Value.Check(TicketSummarySchema, {
      ...ticket,
      parentTicketId: null,
      rootTicketId: 42,
      worklistVisibility: "background",
    })).toBe(true);
    expect(Value.Check(TicketSummarySchema, { ...ticket, worklistVisibility: "hidden" })).toBe(false);
    expect(Value.Check(TicketSummarySchema, { ...ticket, progress: 62 })).toBe(false);
    expect(Value.Check(TicketSummarySchema, {
      ...ticket,
      parentTicketId: null,
      rootTicketId: 42,
      orchestrationState: "waiting",
    })).toBe(false);
  });

  it("validates a ticket detail with activities and attempts", () => {
    const detail = {
      ticket: {
        id: 42,
        title: "协议缺口审计",
        summary: "核对 paired control-plane",
        kind: "task",
        stage: "review",
        status: "review",
        hasRun: true,
        priority: "high",
        project: null,
        dueAt: null,
        deferUntil: null,
        updatedAt: "2026-07-23T05:00:00.000Z",
        runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
        attention: { pendingApprovalCount: 1, blockerCount: 0 },
      },
      brief: "输出协议实施方案",
      body: "第一阶段完成",
      workdir: "/tmp/work",
      createdAt: "2026-07-23T04:00:00.000Z",
      totalTokens: 1200,
      totalCostUsd: 0.03,
      remindAt: null,
    };
    expect(Value.Check(TicketDetailSchema, detail)).toBe(true);
  });

  it("validates the v2 handshake and commands", () => {
    const hello = {
      type: "hello.v2",
      protocolVersion: 2,
      serverTime: "2026-07-23T05:00:00.000Z",
      timezone: "Asia/Shanghai",
      latestSeq: 12,
      capabilities: ["snapshots", "event-replay", "ticket-context-chat"],
      binding: { id: 7, kind: "companion", name: "iPhone", scopes: ["chat", "tickets:view"] },
      daemon: { model: "openai/gpt-5.6-sol", sessionId: "lead-1", busy: false },
    };
    expect(Value.Check(HelloV2Schema, hello)).toBe(true);

    expect(Value.Check(WsCommandSchema, {
      type: "chat.send",
      id: "cmd-1",
      protocolVersion: 2,
      message: "继续审计",
      context: { ticketId: 42 },
    })).toBe(true);
    expect(Value.Check(WsCommandSchema, {
      type: "sync.resume", id: "cmd-2", protocolVersion: 2, afterSeq: 11,
    })).toBe(true);
  });

  it("validates pairing, WS ticket, and HTTP error envelopes", () => {
    const binding = { id: 7, kind: "companion", name: "iPhone", scopes: ["chat", "tickets:view"] };
    expect(Value.Check(PairingRedeemResponseSchema, { binding, access_token: "secret" })).toBe(true);
    expect(Value.Check(WsTicketResponseSchema, {
      ws_ticket: "wst_once", expires_at: "2026-07-23T05:00:30.000Z",
    })).toBe(true);
    expect(Value.Check(HttpErrorResponseSchema, {
      error: { code: "forbidden", message: "missing scope: tickets:view" },
    })).toBe(true);
  });

  it("correlates command results and ordered events", () => {
    expect(Value.Check(CommandResultSchema, {
      type: "command.result",
      id: "cmd-1",
      success: true,
      data: { turnId: "turn-1", mode: "started" },
    })).toBe(true);

    expect(Value.Check(GatewayEventSchema, {
      protocolVersion: 2,
      eventId: "evt-13",
      seq: 13,
      type: "lead.message.delta",
      occurredAt: "2026-07-23T05:00:01.000Z",
      requiredScope: "chat",
      audienceBindingId: 7,
      turnId: "turn-1",
      ticketId: 42,
      payload: { messageId: "msg-1", delta: "正在" },
    })).toBe(true);
    expect(Value.Check(GatewayEventSchema, {
      protocolVersion: 2,
      eventId: "evt-kernel",
      seq: 14,
      type: "kernel.ticket.updated",
      occurredAt: "2026-07-23T05:00:02.000Z",
      requiredScope: "tickets:view",
      audienceBindingId: null,
      turnId: null,
      ticketId: 42,
      payload: {},
    })).toBe(false);
  });

  it("validates operational agenda items only", () => {
    expect(Value.Check(AgendaItemSchema, {
      id: "ticket:42:due",
      kind: "ticket_due",
      startsAt: "2026-07-24T08:00:00.000Z",
      title: "协议审计截止",
      description: "与 #42 关联",
      ticketId: 42,
      scheduleId: null,
      status: "active",
      project: "pi-lead-child",
    })).toBe(true);
    expect(Value.Check(AgendaItemSchema, {
      id: "meeting:1",
      kind: "external_meeting",
      startsAt: "2026-07-24T08:00:00.000Z",
      title: "会议",
    })).toBe(false);
  });
});

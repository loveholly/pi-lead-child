// 工单对话的线上契约（工单 08，spec D13）。2026-10-19 起工单对话里的消息一律交给这张工单的 agent：
// protocol 里不再有猜消息意图的正则（以前的 ticketChatRoute），只剩线上的字段。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  ConversationTurnSchema, gatewayEventOptIn, TicketDetailSchema, WsCommandSchema,
} from "../src/index.js";
import * as ticketChat from "../src/ticket-chat.js";
import {
  isTicketReplyActionId, TICKET_REPLY_ACTION_IDS, TICKET_REPLY_ACTIONS_OPT_IN, TICKET_REPLY_ACTIONS_RESOURCE,
  TicketReplyActionIdSchema,
} from "../src/ticket-chat.js";

describe("no intent matching in the protocol", () => {
  // 用户 2026-10-19：自然语言不用正则匹配；工单对话就是工单的 agent 来回。
  it("exports no message router", () => {
    expect(Object.keys(ticketChat)).not.toContain("ticketChatRoute");
    expect(Object.keys(ticketChat)).not.toContain("ticketMessageSignals");
  });
});

describe("the ticket chat wire", () => {
  // answerer 是已发布的线上字段：daemon 不再宣布能力、也忽略它，但旧客户端带了不能报错。
  it("still accepts an answerer from an old client in the chat context and rejects anything else", () => {
    const command = { type: "chat.send", id: "c", protocolVersion: 2, message: "进展？" };
    expect(Value.Check(WsCommandSchema, { ...command, context: { ticketId: 77, answerer: "lead" } })).toBe(true);
    expect(Value.Check(WsCommandSchema, { ...command, context: { ticketId: 77, answerer: "agent" } })).toBe(true);
    expect(Value.Check(WsCommandSchema, { ...command, context: { ticketId: 77, answerer: "child" } })).toBe(false);
  });

  it("carries the session a message to the agent would resume", () => {
    const detail = {
      ticket: {
        id: 77, title: "t", summary: "s", kind: "task", stage: "done", status: "done", hasRun: true, priority: "normal",
        project: null, dueAt: null, deferUntil: null, updatedAt: "2026-10-16T10:00:00.000Z",
        runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
        attention: { pendingApprovalCount: 0, blockerCount: 0 },
      },
      brief: "b", body: "", workdir: null, createdAt: "2026-10-16T09:00:00.000Z", totalTokens: 0, totalCostUsd: 0, remindAt: null,
    };
    expect(Value.Check(TicketDetailSchema, {
      ...detail, chatResume: { attemptId: 90, role: "reviewer", runtime: "codex", lastTokens: 456_000 },
    })).toBe(true);
    expect(Value.Check(TicketDetailSchema, {
      ...detail, chatResume: { attemptId: 90, role: "reviewer", runtime: "codex", lastTokens: null },
    })).toBe(true);
    expect(Value.Check(TicketDetailSchema, { ...detail, chatResume: null })).toBe(true);
  });

  it("lists the same reply actions in the id list and the schema", () => {
    for (const id of TICKET_REPLY_ACTION_IDS) {
      expect(Value.Check(TicketReplyActionIdSchema, id)).toBe(true);
      expect(isTicketReplyActionId(id)).toBe(true);
    }
    expect(Value.Check(TicketReplyActionIdSchema, "confirm")).toBe(false);
    expect(isTicketReplyActionId("release")).toBe(false);
  });

  it("carries the reply actions on a conversation turn only as an optional field", () => {
    const turn = {
      id: "turn_1", originBindingId: 7, originKind: "paired:companion:ticket-agent", ticketId: 77, state: "completed",
      userText: "进展？", assistantText: "要我派发核查吗？", error: null,
      createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:05.000Z",
    };
    expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
    expect(Value.Check(ConversationTurnSchema, { ...turn, replyActions: ["request_review"] })).toBe(true);
    expect(Value.Check(ConversationTurnSchema, { ...turn, replyActions: [] })).toBe(true);
    expect(Value.Check(ConversationTurnSchema, { ...turn, replyActions: ["release"] })).toBe(false);
  });

  // 旧客户端不认识这个 resource，会当成「全部重取」：只发给声明了 include=reply_actions 的连接。
  it("sends the reply actions push only to connections that opted in", () => {
    expect(gatewayEventOptIn({
      type: "snapshot.required", payload: { resource: TICKET_REPLY_ACTIONS_RESOURCE, ticketId: 77, turnId: "turn_1" },
    })).toBe(TICKET_REPLY_ACTIONS_OPT_IN);
    expect(gatewayEventOptIn({ type: "snapshot.required", payload: { resource: "connections" } })).toBeNull();
  });
});

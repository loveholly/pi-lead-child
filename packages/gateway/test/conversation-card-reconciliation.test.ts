import { describe, expect, it } from "vitest";
import {
  applyLiveLeadToolEvent,
  conversationCardRenderId,
  reconcileConversationCards,
  type LeadToolCardEvent,
} from "../src/conversation-card-projection.js";
import type { ConversationCard } from "@pi-lead-child/core";

const baseEvent = {
  turnId: "turn-7",
  itemId: 42,
  occurredAt: "2026-07-24T04:00:00.000Z",
  payload: {
    toolCallId: "call-9",
    toolName: "spawn_child",
    // 工具入参键名是线上契约，内部改名不跟。
    args: { ticket_id: 42 },
  },
} as const;

function event(type: LeadToolCardEvent["type"], payload: Record<string, unknown> = {}): LeadToolCardEvent {
  return { ...baseEvent, type, payload: { ...baseEvent.payload, ...payload } };
}

describe("live and durable conversation-card reconciliation", () => {
  it("updates one live card across started, running, completed, and failed states", () => {
    let cards = applyLiveLeadToolEvent([], event("lead.tool.started"));
    const key = "turn:turn-7:ticket:42";
    expect(cards).toMatchObject([{ id: null, key, operations: [{ state: "started" }] }]);

    cards = applyLiveLeadToolEvent(cards, event("lead.tool.updated"));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.operations[0]?.state).toBe("running");

    cards = applyLiveLeadToolEvent(cards, event("lead.tool.completed", {
      result: { content: [{ type: "text", text: "child spawned for ticket #42" }] },
    }));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.operations[0]?.state).toBe("completed");

    cards = applyLiveLeadToolEvent(cards, event("lead.tool.failed"));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.operations[0]?.state).toBe("failed");
  });

  it("replaces a live card by stable key with its durable ID without duplication or reordering", () => {
    let cards = applyLiveLeadToolEvent([], event("lead.tool.started"));
    cards = applyLiveLeadToolEvent(cards, {
      ...event("lead.tool.started"),
      itemId: 84,
      payload: { ...baseEvent.payload, args: { ticket_id: 84 }, toolCallId: "call-10" },
    });
    const beforeKeys = cards.map((card) => card.key);
    const beforeRenderId = conversationCardRenderId(cards[0]!);
    const durable: ConversationCard = {
      id: 15,
      key: "turn:turn-7:ticket:42",
      kind: "ticket_execution",
      turnId: "turn-7",
      itemId: 42,
      operations: [{
        id: "turn-7:call-9",
        name: "spawn_child",
        state: "completed",
        label: "Spawn child #42",
        detail: "Child started for item #42",
      }],
      operationsTruncated: false,
      createdAt: "2026-07-24T04:00:00.000Z",
      updatedAt: "2026-07-24T04:01:00.000Z",
    };

    const reconciled = reconcileConversationCards(cards, [durable, durable]);
    expect(reconciled).toHaveLength(2);
    expect(reconciled.map((card) => card.key)).toEqual(beforeKeys);
    expect(reconciled[0]).toEqual(durable);
    expect(conversationCardRenderId(reconciled[0]!)).toBe(beforeRenderId);
  });
});

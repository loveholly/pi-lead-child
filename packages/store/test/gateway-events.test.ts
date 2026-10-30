import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import {
  latestGatewaySeq,
  listGatewayEvents,
  publishGatewayEvent,
} from "../src/gateway-events.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("gateway event log", () => {
  it("assigns monotonic sequences and preserves structured identity", () => {
    const first = publishGatewayEvent(db, {
      eventId: "evt-1",
      type: "lead.turn.started",
      requiredScope: "chat",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId: 42,
      payload: { messageId: "msg-1" },
      now: new Date("2026-07-23T05:00:00.000Z"),
    });
    const second = publishGatewayEvent(db, {
      eventId: "evt-2",
      type: "lead.message.delta",
      requiredScope: "chat",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId: 42,
      payload: { delta: "hello" },
      now: new Date("2026-07-23T05:00:01.000Z"),
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(latestGatewaySeq(db)).toBe(2);
    expect(second).toMatchObject({
      protocolVersion: 2,
      eventId: "evt-2",
      occurredAt: "2026-07-23T05:00:01.000Z",
      audienceBindingId: 7,
      turnId: "turn-1",
      ticketId: 42,
    });
  });

  it("replays only events visible to the binding scopes and audience", () => {
    publishGatewayEvent(db, {
      eventId: "broadcast-ticket", type: "ticket.updated", requiredScope: "tickets:view",
      payload: { ticketId: 1 },
    });
    publishGatewayEvent(db, {
      eventId: "private-seven", type: "lead.message.delta", requiredScope: "chat",
      audienceBindingId: 7, payload: { delta: "seven" },
    });
    publishGatewayEvent(db, {
      eventId: "private-eight", type: "lead.message.delta", requiredScope: "chat",
      audienceBindingId: 8, payload: { delta: "eight" },
    });
    publishGatewayEvent(db, {
      eventId: "approval", type: "approval.required", requiredScope: "approvals:respond",
      payload: { approvalId: 9 },
    });

    expect(listGatewayEvents(db, {
      afterSeq: 0, bindingId: 7, scopes: ["chat", "tickets:view"],
    }).map((event) => event.eventId)).toEqual(["broadcast-ticket", "private-seven"]);
    expect(listGatewayEvents(db, {
      afterSeq: 1, bindingId: 8, scopes: ["chat", "approvals:respond"],
    }).map((event) => event.eventId)).toEqual(["private-eight", "approval"]);
  });
});

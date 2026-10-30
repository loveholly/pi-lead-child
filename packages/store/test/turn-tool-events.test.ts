// 会话快照还原每一轮的工具调用：从账本里按轮次读事件。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { listTurnToolEvents, publishGatewayEvent } from "../src/gateway-events.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

const BOTH = ["chat", "tickets:view"] as const;

function publish(type: Parameters<typeof publishGatewayEvent>[1]["type"], turnId: string, payload: Record<string, unknown>) {
  const requiredScope = type.startsWith("child.") ? "tickets:view" : "chat";
  return publishGatewayEvent(db, { type, requiredScope, turnId, payload });
}

describe("listTurnToolEvents", () => {
  it("returns the start and end of each tool call and the turn starts, per turn and in order", () => {
    publish("lead.turn.started", "turn-a", { mode: "started" });
    publish("lead.message.delta", "turn-a", { delta: "我先查一下。" });
    publish("lead.tool.started", "turn-a", { toolCallId: "1", toolName: "query_tickets", textOffset: 6 });
    publish("lead.tool.updated", "turn-a", { toolCallId: "1", toolName: "query_tickets", partialResult: "…" });
    publish("lead.tool.completed", "turn-a", { toolCallId: "1", toolName: "query_tickets", result: "[]", textOffset: 6 });
    publish("child.tool.started", "turn-b", { attemptId: 3, toolCallId: "2", toolName: "Bash", textOffset: 0 });
    publish("lead.tool.started", "turn-other", { toolCallId: "3", toolName: "list_items", textOffset: 0 });
    publishGatewayEvent(db, { type: "ticket.updated", requiredScope: "tickets:view", payload: {} });

    const events = listTurnToolEvents(db, ["turn-a", "turn-b", "turn-a"], { scopes: [...BOTH] });

    expect([...events.keys()].sort()).toEqual(["turn-a", "turn-b"]);
    expect(events.get("turn-a")!.map((event) => event.type)).toEqual([
      "lead.turn.started", "lead.tool.started", "lead.tool.completed",
    ]);
    expect(events.get("turn-b")![0]).toMatchObject({ type: "child.tool.started", payload: { toolName: "Bash" } });
  });

  it("adds the streamed text only for turns whose tool events predate textOffset", () => {
    publish("lead.turn.started", "legacy", { mode: "started" });
    publish("lead.message.delta", "legacy", { delta: "先看看。" });
    publish("lead.tool.started", "legacy", { toolCallId: "1", toolName: "list_items" });
    publish("lead.message.delta", "legacy", { delta: "好了。" });

    expect(listTurnToolEvents(db, ["legacy"], { scopes: [...BOTH] }).get("legacy")!.map((event) => [event.type, event.payload.delta ?? null]))
      .toEqual([
        ["lead.turn.started", null],
        ["lead.message.delta", "先看看。"],
        ["lead.tool.started", null],
        ["lead.message.delta", "好了。"],
      ]);
  });

  // 和实时事件流一样：binding 没有某个事件要的 scope，就读不到它。executor 的工具事件要 tickets:view。
  it("leaves out events whose required scope the reader does not have", () => {
    publish("lead.turn.started", "turn-a", { mode: "started" });
    publish("lead.tool.started", "turn-a", { toolCallId: "1", toolName: "query_tickets", textOffset: 0 });
    publish("child.tool.started", "turn-a", { attemptId: 3, toolCallId: "2", toolName: "Bash", textOffset: 0 });

    expect(listTurnToolEvents(db, ["turn-a"], { scopes: ["chat"] }).get("turn-a")!.map((event) => event.type))
      .toEqual(["lead.turn.started", "lead.tool.started"]);
    expect(listTurnToolEvents(db, ["turn-a"], { scopes: [] }).size).toBe(0);
  });

  it("reads through the turn index, for tool events and for the streamed text", () => {
    for (const types of ["'lead.tool.started', 'child.tool.started'", "'lead.message.delta'"]) {
      const plan = db.prepare(
        `EXPLAIN QUERY PLAN SELECT seq FROM gateway_events
         WHERE turn_id IN (?, ?) AND event_type IN (${types}) AND required_scope IN ('chat') ORDER BY seq`,
      ).all("a", "b") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join("\n")).toContain("gateway_events_turn_type");
    }
  });
});

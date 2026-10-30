import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { publishLeadToolCardEvents } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-outbox-order-"), "plc.db"));
});

function eventTypes(): string[] {
  return (db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all() as Array<{
    event_type: string;
  }>).map((row) => row.event_type);
}

describe("frozen-v2 checkpoint outbox order", () => {
  it("keeps authority events before item invalidation and decisions on ticket.updated only", () => {
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({
      title: "order", brief: "frozen v2", createdBy: "system",
    });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running" });

    coordinator.submitCheckpoint({
      itemId, runId, kind: "progress", title: "Progress", summary: "First checkpoint",
    });
    const approval = coordinator.requestApproval({
      itemId,
      runId,
      requestedBy: "child",
      tool: "send",
      action: "Send result",
      checkpoint: { title: "Approval", summary: "Need approval", nextStep: "Wait" },
    });
    if (approval.status !== "pending") throw new Error("expected pending approval");
    coordinator.resolveApproval({
      approvalId: approval.approvalId,
      decision: "approve",
      actor: { kind: "user", resolvedBy: "user via cli" },
    });
    const decision = coordinator.requestDecision({
      itemId,
      runId,
      kind: "decision",
      audience: "lead",
      prompt: "Choose",
      options: [{ id: "a", label: "A" }],
      checkpoint: { title: "Decision", summary: "Need a choice" },
    });
    coordinator.resolveDecision({
      requestId: decision.requestId,
      decision: "select",
      optionId: "a",
      actor: { kind: "lead", resolvedBy: "lead" },
    });

    expect(eventTypes()).toEqual([
      "ticket.updated",
      "approval.required", "ticket.updated",
      "approval.resolved", "ticket.updated",
      "ticket.updated",
      "ticket.updated",
    ]);
  });

  it("emits lead.tool.* alone for card-only updates and before ticket.updated when an item is known", () => {
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({
      title: "lead card", brief: "projection", createdBy: "system",
    });
    publishLeadToolCardEvents(db, {
      type: "lead.tool.completed",
      audienceBindingId: 7,
      turnId: "turn-1",
      payload: { toolCallId: "call-1", toolName: "query_tickets" },
    });
    publishLeadToolCardEvents(db, {
      type: "lead.tool.completed",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId,
      payload: { toolCallId: "call-2", toolName: "create_ticket" },
    });

    expect(eventTypes()).toEqual([
      "lead.tool.completed",
      "lead.tool.completed", "ticket.updated",
    ]);
  });
});

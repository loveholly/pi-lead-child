import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getConversationCardDisplayProjection,
  projectCheckpointConversationCard,
  projectInterventionConversationCard,
} from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  applyLiveLeadToolEvent,
  persistLeadToolConversationCard,
  persistLeadToolConversationEvent,
  repairStuckLeadToolOperations,
} from "../src/conversation-card-projection.js";
import { projectToolEvent } from "../src/event-projection.js";
import { createApproval } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";
import { insertCheckpoint } from "@pi-lead-child/store";
import { getConversationCardByKey } from "@pi-lead-child/store";
import { createTurn } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { publishGatewayEvent } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import type { ConversationCard } from "@pi-lead-child/core";

let db: Db;
let dbPath: string;
let itemId: number;

beforeEach(() => {
  dbPath = join(tempDir("plc-card-projection-"), "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "projection", brief: "card", createdBy: "system" });
  createTurn(db, {
    id: "turn-1",
    originKind: "companion",
    itemId,
    userText: "create and run",
    now: new Date("2026-07-24T03:00:00.000Z"),
  });
});

function leadEvent(
  type: "lead.tool.started" | "lead.tool.updated" | "lead.tool.completed" | "lead.tool.failed",
  callId: string,
  overrides: Record<string, unknown> = {},
) {
  const runtimeType = type === "lead.tool.started"
    ? "tool_execution_start"
    : type === "lead.tool.updated"
      ? "tool_execution_update"
      : "tool_execution_end";
  return {
    type,
    turnId: "turn-1",
    itemId,
    occurredAt: "2026-07-24T03:01:00.000Z",
    payload: projectToolEvent({
      type: runtimeType,
      toolCallId: callId,
      toolName: "spawn_child",
      // 工具入参键名是线上契约（lead tools 收的是 ticket_id），内部改名不跟。
      args: { ticket_id: itemId, token: "raw-secret-token" },
      partialResult: { path: "/Users/private/.ssh/id_ed25519", password: "partial-secret" },
      result: {
        content: [{ type: "text", text: `child spawned for ticket #${itemId}` }],
        details: { apiKey: "result-secret", bytes: Buffer.alloc(128, 7) },
      },
      isError: type === "lead.tool.failed",
      ...overrides,
    }),
  } as const;
}

describe("durable Lead conversation-card projection", () => {
  // 2026-10-17：会话里的工单卡只在派活时出现（合一卡片），recover_ticket_run 是 Lead 重新派活的另一条路。
  // 它的目标工单只在入参里；Lead 自己的会话回合不挂工单，事件上没有 itemId。以前它从来不出卡片。
  it("makes a card when Lead re-dispatches a ticket with recover_ticket_run", () => {
    const recover = (type: "lead.tool.started" | "lead.tool.completed") => ({
      ...leadEvent(type, "call-recover", {
        toolName: "recover_ticket_run",
        args: { ticket_id: itemId, run_id: 5, action: "next_model" },
        result: { content: [{ type: "text", text: `recovery dispatched for ticket #${itemId}` }] },
      }),
      itemId: undefined,
    });
    persistLeadToolConversationCard(db, recover("lead.tool.started"));
    const completed = persistLeadToolConversationCard(db, recover("lead.tool.completed"));
    expect(completed).toMatchObject({
      key: `turn:turn-1:ticket:${itemId}`,
      kind: "ticket_execution",
      operations: [{ id: "turn-1:call-recover", name: "recover_ticket_run", state: "completed", label: `Recover run #${itemId}` }],
    });
  });

  it("upserts one safe item execution card through the tool lifecycle", () => {
    const started = persistLeadToolConversationCard(db, leadEvent("lead.tool.started", "call-1"));
    const running = persistLeadToolConversationCard(db, leadEvent("lead.tool.updated", "call-1"));
    const completed = persistLeadToolConversationCard(db, leadEvent("lead.tool.completed", "call-1"));

    expect(started?.id).toBe(running?.id);
    expect(running?.id).toBe(completed?.id);
    expect(completed).toMatchObject({
      key: `turn:turn-1:ticket:${itemId}`,
      kind: "ticket_execution",
      turnId: "turn-1",
      itemId,
      operations: [{
        id: "turn-1:call-1",
        name: "spawn_child",
        state: "completed",
        label: `Spawn child #${itemId}`,
        detail: `Child started for item #${itemId}`,
      }],
    });

    const stored = db.prepare("SELECT payload FROM conversation_cards WHERE id = ?")
      .get(completed!.id) as { payload: string };
    expect(Buffer.byteLength(stored.payload, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(stored.payload).not.toContain("raw-secret-token");
    expect(stored.payload).not.toContain("partial-secret");
    expect(stored.payload).not.toContain("result-secret");
    expect(stored.payload).not.toContain("id_ed25519");
    expect(stored.payload).not.toContain("070707");
  });

  it("resolves a new item from create_task completion without persisting raw results", () => {
    const card = persistLeadToolConversationCard(db, {
      type: "lead.tool.completed",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:02:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "create-1",
        toolName: "create_task",
        args: { title: "secret project", credential: "do-not-store" },
        result: { content: [{ type: "text", text: `created task #${itemId}` }] },
        isError: false,
      }),
    });

    expect(card).toMatchObject({
      key: `turn:turn-1:ticket:${itemId}`,
      operations: [{
        id: "turn-1:create-1",
        name: "create_task",
        state: "completed",
        label: `Create task #${itemId}`,
        detail: `Created task #${itemId}`,
      }],
    });
    const payload = (db.prepare("SELECT payload FROM conversation_cards WHERE id = ?")
      .get(card!.id) as { payload: string }).payload;
    expect(payload).not.toContain("secret project");
    expect(payload).not.toContain("do-not-store");
  });

  it("uses the create_task completion result for both the live event and durable card", () => {
    const createdItemId = createItem(db, {
      title: "created by tool",
      brief: "authoritative result target",
      createdBy: "system",
    });
    const projected = persistLeadToolConversationEvent(db, {
      type: "lead.tool.completed",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId,
      occurredAt: "2026-07-24T03:03:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "create-authoritative",
        toolName: "create_task",
        args: { title: "created by tool" },
        result: { ticket_id: createdItemId, status: "backlog" },
        isError: false,
      }),
    });

    expect(projected.event.ticketId).toBe(createdItemId);
    expect(projected.card).toMatchObject({
      key: `turn:turn-1:ticket:${createdItemId}`,
      itemId: createdItemId,
      operations: [{
        id: "turn-1:create-authoritative",
        name: "create_task",
        state: "completed",
        label: `Create task #${createdItemId}`,
      }],
    });
    expect(db.prepare(
      "SELECT item_id FROM gateway_events WHERE event_type='lead.tool.completed'",
    ).get()).toEqual({ item_id: createdItemId });

    const live = applyLiveLeadToolEvent([], {
      type: "lead.tool.completed",
      turnId: "turn-1",
      itemId,
      occurredAt: "2026-07-24T03:03:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "create-authoritative",
        toolName: "create_task",
        args: { title: "created by tool" },
        result: { ticket_id: createdItemId, status: "backlog" },
        isError: false,
      }),
    });
    expect(live[0]).toMatchObject({
      key: `turn:turn-1:ticket:${createdItemId}`,
      itemId: createdItemId,
    });
  });

  it("waits for the authoritative create_task result before projecting an item card", () => {
    const createdItemId = createItem(db, {
      title: "created after start",
      brief: "no turn-context ghost card",
      createdBy: "system",
    });
    const started = persistLeadToolConversationEvent(db, {
      type: "lead.tool.started",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId,
      occurredAt: "2026-07-24T03:03:30.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "create-lifecycle",
        toolName: "create_task",
        args: { title: "created after start" },
      }),
    });

    expect(started.card).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_cards").get())
      .toEqual({ count: 0 });

    const completed = persistLeadToolConversationEvent(db, {
      type: "lead.tool.completed",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId,
      occurredAt: "2026-07-24T03:03:31.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "create-lifecycle",
        toolName: "create_task",
        args: { title: "created after start" },
        result: { ticket_id: createdItemId, status: "backlog" },
        isError: false,
      }),
    });

    expect(completed.card).toMatchObject({
      key: `turn:turn-1:ticket:${createdItemId}`,
      itemId: createdItemId,
    });
    expect(db.prepare("SELECT item_id FROM conversation_cards").all())
      .toEqual([{ item_id: createdItemId }]);
  });

  it("prefers targeted tool args over result text and turn context", () => {
    const targetItemId = createItem(db, {
      title: "spawn target",
      brief: "authoritative args target",
      createdBy: "system",
    });
    const projected = persistLeadToolConversationEvent(db, {
      type: "lead.tool.completed",
      audienceBindingId: 7,
      turnId: "turn-1",
      itemId,
      occurredAt: "2026-07-24T03:04:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "spawn-authoritative",
        toolName: "spawn_child",
        args: { ticket_id: targetItemId },
        result: { content: [{ type: "text", text: `turn ticket #${itemId} remains active` }] },
        isError: false,
      }),
    });

    expect(projected.event.ticketId).toBe(targetItemId);
    expect(projected.card).toMatchObject({
      key: `turn:turn-1:ticket:${targetItemId}`,
      itemId: targetItemId,
      operations: [{
        id: "turn-1:spawn-authoritative",
        name: "spawn_child",
        label: `Spawn child #${targetItemId}`,
      }],
    });
  });

  // 终局事件（tool_execution_end）不带 args——SDK 只在 start 上给。终局若还去重新推导
  // item id，spawn_child / cancel_item / add_comment 这类"只能从入参认出目标"的工具就会
  // 在终局算不出 itemId，整条投影被丢弃，卡片上的转圈永远停不下来（真实库里 #38 已 cancelled，
  // 卡片却还在转）。所以终局必须回到 start 那一刻已经落库的那条 operation 上。
  it("settles a targeted operation whose end event carries no args", () => {
    const started = persistLeadToolConversationEvent(db, {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:05:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "cancel-no-args",
        toolName: "cancel_item",
        args: { ticket_id: itemId, reason: "user asked to stop" },
      }),
    });
    expect(started.card?.operations).toEqual([{
      id: "turn-1:cancel-no-args",
      name: "cancel_item",
      state: "started",
      label: `Cancel item #${itemId}`,
      detail: null,
    }]);

    const completed = persistLeadToolConversationEvent(db, {
      type: "lead.tool.completed",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:05:01.000Z",
      // 关键：终局事件**没有** args，与 SDK 的 tool_execution_end 一致。
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "cancel-no-args",
        toolName: "cancel_item",
        result: { content: [{ type: "text", text: "事项已取消" }] },
        isError: false,
      }),
    });

    expect(completed.card?.id).toBe(started.card?.id);
    expect(completed.card?.operations).toEqual([{
      id: "turn-1:cancel-no-args",
      name: "cancel_item",
      state: "completed",
      label: `Cancel item #${itemId}`,
      detail: "Operation completed",
    }]);
    expect(completed.event.ticketId).toBe(itemId);
  });

  it("fails a targeted operation whose error event carries no args", () => {
    persistLeadToolConversationCard(db, {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:06:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "spawn-no-args",
        toolName: "spawn_child",
        args: { ticket_id: itemId },
      }),
    });
    const failed = persistLeadToolConversationCard(db, {
      type: "lead.tool.failed",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:06:01.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "spawn-no-args",
        toolName: "spawn_child",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      }),
    });
    expect(failed?.operations).toEqual([{
      id: "turn-1:spawn-no-args",
      name: "spawn_child",
      state: "failed",
      label: `Spawn child #${itemId}`,
      detail: "Operation failed",
    }]);
  });

  it("keeps a live card settling when the end event carries no args", () => {
    let cards = applyLiveLeadToolEvent([], {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:07:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "live-no-args",
        toolName: "add_comment",
        args: { ticket_id: itemId, content: "note" },
      }),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.operations[0]?.state).toBe("started");

    cards = applyLiveLeadToolEvent(cards, {
      type: "lead.tool.completed",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:07:01.000Z",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "live-no-args",
        toolName: "add_comment",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      }),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.key).toBe(`turn:turn-1:ticket:${itemId}`);
    expect(cards[0]?.operations).toHaveLength(1);
    expect(cards[0]?.operations[0]?.state).toBe("completed");
  });

  it("retains the first and newest fifteen operation rows through the projection boundary", () => {
    for (let index = 0; index < 17; index++) {
      persistLeadToolConversationCard(db, leadEvent("lead.tool.started", `call-${index}`));
    }
    const card = persistLeadToolConversationCard(db, leadEvent("lead.tool.completed", "call-16"));
    expect(card?.operations).toHaveLength(16);
    expect(card?.operations.map((operation) => operation.id)).toEqual([
      "turn-1:call-0",
      ...Array.from({ length: 15 }, (_, offset) => `turn-1:call-${offset + 2}`),
    ]);
    expect(card?.operationsTruncated).toBe(true);
  });

  it("writes idempotent item invalidations atomically for card creation and terminal updates", () => {
    persistLeadToolConversationCard(db, leadEvent("lead.tool.started", "call-outbox"));
    persistLeadToolConversationCard(db, leadEvent("lead.tool.updated", "call-outbox"));
    persistLeadToolConversationCard(db, leadEvent("lead.tool.completed", "call-outbox"));
    persistLeadToolConversationCard(db, leadEvent("lead.tool.completed", "call-outbox"));

    expect(db.prepare(
      "SELECT event_type, item_id, payload FROM gateway_events ORDER BY seq",
    ).all()).toEqual([
      {
        event_type: "ticket.updated",
        item_id: itemId,
        payload: JSON.stringify({ ticketId: itemId, snapshotRequired: true }),
      },
      {
        event_type: "ticket.updated",
        item_id: itemId,
        payload: JSON.stringify({ ticketId: itemId, snapshotRequired: true }),
      },
    ]);

    const otherItem = createItem(db, { title: "rollback", brief: "outbox", createdBy: "system" });
    createTurn(db, {
      id: "turn-rollback",
      originKind: "companion",
      itemId: otherItem,
      userText: "rollback",
    });
    db.exec(`
      CREATE TRIGGER reject_card_item_update
      BEFORE INSERT ON gateway_events
      WHEN NEW.event_type = 'ticket.updated' AND NEW.item_id = ${otherItem}
      BEGIN
        SELECT RAISE(ABORT, 'reject card invalidation');
      END;
    `);
    expect(() => persistLeadToolConversationCard(db, {
      ...leadEvent("lead.tool.started", "call-rollback"),
      turnId: "turn-rollback",
      itemId: otherItem,
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "call-rollback",
        toolName: "spawn_child",
        args: { ticket_id: otherItem },
      }),
    })).toThrow(/reject card invalidation/i);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM conversation_cards WHERE item_id = ?",
    ).get(otherItem)).toEqual({ count: 0 });
  });

  it("persists checkpoint and intervention cards with safe source and authority references", () => {
    const runId = createRun(db, { itemId, runtime: "codex" });
    const completed = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "completed",
      title: "Implementation complete",
      summary: "Targeted tests pass.",
    }, { now: new Date("2026-07-24T03:15:00.000Z") });
    const checkpointCard = projectCheckpointConversationCard(db, { checkpointId: completed.id });
    const checkpointProjection = getConversationCardDisplayProjection(db, checkpointCard.key);

    expect(checkpointProjection).toMatchObject({
      card: { id: checkpointCard.id, key: `checkpoint:${completed.id}` },
      checkpoint: { id: completed.id, itemId, runId },
      source: {
        sourceLine: `来自 child #${runId} 的消息 · 03:15`,
        itemId,
        runId,
        agent: { kind: "executor", runtime: "codex", label: `child #${runId}` },
      },
      interventionRef: null,
    });

    const approvalId = createApproval(db, {
      itemId,
      runId,
      requestedBy: "child",
      tool: "bash",
      action: "upload /Users/private/key.pem",
      payload: { authorization: "Bearer privileged-secret" },
      now: new Date("2026-07-24T03:16:00.000Z"),
    });
    const blocked = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "blocked",
      title: "Approval required",
      summary: "A protected operation needs authorization.",
      actionRef: { type: "approval", id: approvalId },
    }, { now: new Date("2026-07-24T03:16:00.000Z") });
    const interventionCard = projectInterventionConversationCard(db, { checkpointId: blocked.id });
    const interventionProjection = getConversationCardDisplayProjection(db, interventionCard.key);

    expect(interventionProjection).toMatchObject({
      card: {
        id: interventionCard.id,
        key: `intervention:approval:${approvalId}`,
        checkpointId: blocked.id,
      },
      checkpoint: { id: blocked.id, itemId, runId },
      interventionRef: {
        id: `approval:${approvalId}`,
        // KernelInterventionRef 是线上 DTO，键名仍是 ticketId。
        ticketId: itemId,
        kind: "approval",
        state: "pending",
        requiresAction: true,
      },
    });
    const serialized = JSON.stringify(interventionProjection);
    expect(serialized).not.toContain("privileged-secret");
    expect(serialized).not.toContain("key.pem");
    expect(serialized).not.toContain("upload");

    const resolutionCard = projectCheckpointConversationCard(db, { checkpointId: blocked.id });
    expect(resolutionCard).toMatchObject({
      key: `checkpoint:${blocked.id}`,
      checkpointId: blocked.id,
      itemId,
    });
  });

  it("uses the executing run identity in child source labels", () => {
    db.prepare(
      `INSERT INTO items (id, title, brief, created_by, root_item_id)
       VALUES (42, 'identity', 'source', 'lead', 42)`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, item_id, role, runtime, purpose)
       VALUES (73, 42, 'executor', 'codex', 'execution')`,
    ).run();
    const checkpoint = insertCheckpoint(db, {
      itemId: 42,
      runId: 73,
      source: "agent_reported",
      kind: "completed",
      title: "Run complete",
      summary: "The executing child completed its work.",
    }, { now: new Date("2026-07-24T06:30:00.000Z") });
    const card = projectCheckpointConversationCard(db, { checkpointId: checkpoint.id });

    expect(getConversationCardDisplayProjection(db, card.key)?.source).toEqual({
      sourceLine: "来自 child #73 的消息 · 06:30",
      itemId: 42,
      runId: 73,
      agent: { kind: "executor", runtime: "codex", label: "child #73" },
    });
  });

  it("keeps system checkpoint sources separate from child runs", () => {
    const checkpoint = insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "completed",
      title: "Recovery complete",
      summary: "The daemon restored execution state.",
      idempotencyKey: "system-source-test",
    }, { now: new Date("2026-07-24T06:31:00.000Z") });
    const card = projectCheckpointConversationCard(db, { checkpointId: checkpoint.id });

    expect(getConversationCardDisplayProjection(db, card.key)?.source).toEqual({
      sourceLine: "来自 system 的消息 · 06:31",
      itemId,
      runId: null,
      agent: { kind: "system", runtime: null, label: "system" },
    });
  });

  // 历史行修复（defect 1 的第二半）。规则只有一条，不猜：一条仍停在 started/running 的
  // operation，当且仅当账本里已经有它自己那条终局 lead.tool.completed / lead.tool.failed
  // 事件（同 turn + 同 toolCallId）时才被结算，结算成那条事件说的结果。真在跑的调用没有
  // 终局事件，一律不动；卡片只更新、不新建、不删除；结算后 operation 已是终态，重跑是空操作。
  it("settles historical operations from their own terminal gateway event, once", () => {
    persistLeadToolConversationEvent(db, {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:20:00.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "stuck-done",
        toolName: "cancel_item",
        args: { ticket_id: itemId },
      }),
    });
    const otherItem = createItem(db, { title: "stuck-fail", brief: "b", createdBy: "system" });
    persistLeadToolConversationEvent(db, {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:20:01.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "stuck-fail",
        toolName: "spawn_child",
        args: { ticket_id: otherItem },
      }),
    });
    const liveItem = createItem(db, { title: "still running", brief: "b", createdBy: "system" });
    persistLeadToolConversationEvent(db, {
      type: "lead.tool.started",
      turnId: "turn-1",
      itemId: null,
      occurredAt: "2026-07-24T03:20:02.000Z",
      payload: projectToolEvent({
        type: "tool_execution_start",
        toolCallId: "genuinely-live",
        toolName: "spawn_child",
        args: { ticket_id: liveItem },
      }),
    });

    // 这两条终局事件在真实库里是存在的——被丢掉的只是卡片投影，不是事件本身。
    publishGatewayEvent(db, {
      type: "lead.tool.completed",
      requiredScope: "chat",
      turnId: "turn-1",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "stuck-done",
        toolName: "cancel_item",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
    });
    publishGatewayEvent(db, {
      type: "lead.tool.failed",
      requiredScope: "chat",
      turnId: "turn-1",
      payload: projectToolEvent({
        type: "tool_execution_end",
        toolCallId: "stuck-fail",
        toolName: "spawn_child",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      }),
    });

    expect(repairStuckLeadToolOperations(db)).toEqual({ operations: 2, cards: 2 });

    const operationsOf = (id: number) => (getConversationCardByKey(
      db, `turn:turn-1:ticket:${id}`,
    ) as Extract<ConversationCard, { kind: "ticket_execution" }>).operations;
    expect(operationsOf(itemId)).toEqual([{
      id: "turn-1:stuck-done",
      name: "cancel_item",
      state: "completed",
      label: `Cancel item #${itemId}`,
      detail: "Operation completed",
    }]);
    expect(operationsOf(otherItem)).toEqual([{
      id: "turn-1:stuck-fail",
      name: "spawn_child",
      state: "failed",
      label: `Spawn child #${otherItem}`,
      detail: "Operation failed",
    }]);
    // 没有终局事件的调用不动：它可能真的还在跑。
    expect(operationsOf(liveItem)[0]?.state).toBe("started");

    // 幂等、可重复运行。
    expect(repairStuckLeadToolOperations(db)).toEqual({ operations: 0, cards: 0 });
    expect(operationsOf(itemId)[0]?.state).toBe("completed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_cards").get())
      .toEqual({ count: 3 });
  });

  it("loads persisted cards after reopening the database", () => {
    const card = persistLeadToolConversationCard(db, leadEvent("lead.tool.completed", "call-1"));
    db.close();

    const reopened = openDb(dbPath);
    try {
      expect(getConversationCardDisplayProjection(reopened, card!.key)).toMatchObject({
        card: { id: card!.id, key: card!.key, kind: "ticket_execution" },
        source: { itemId, runId: null },
      });
    } finally {
      reopened.close();
    }
  });
});

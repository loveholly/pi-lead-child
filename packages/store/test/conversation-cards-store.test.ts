import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { KernelConversationCardListResponseSchema } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  ensureCheckpointCard,
  getConversationCardByKey,
  listConversationCardPage,
  upsertItemExecutionCard,
} from "../src/conversation-cards.js";
import { insertCheckpoint } from "../src/checkpoints.js";
import { createRun } from "../src/runs.js";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import type { ConversationCard } from "@pi-lead-child/core";

let db: Db;
let itemId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-cards-"), "plc.db"));
  itemId = createItem(db, { title: "card", brief: "store", createdBy: "system" });
  db.prepare(
    `INSERT INTO channel_turns
      (id, origin_kind, item_id, state, user_text, created_at, updated_at)
     VALUES ('turn-1', 'cli', ?, 'completed', 'create it', ?, ?)`,
  ).run(itemId, "2026-07-24T03:00:00.000Z", "2026-07-24T03:00:00.000Z");
});

function operation(index: number, detail: string | null = null) {
  return {
    id: `turn-1:call-${index}`,
    name: index === 0 ? "create_task" : "spawn_child",
    state: "running" as const,
    label: `operation-${index}`,
    detail,
  };
}

// 内部卡片讲 itemId，线上 DTO 讲 ticketId（control-plane 的 kernelConversationCard 做同样的
// 投影）。这里在断言前手动过一遍映射，好让存储层的分页元数据继续对着冻结的线上契约校验。
function toWireCards(cards: ConversationCard[]) {
  return cards.map(({ itemId: cardItemId, ...card }) => ({ ...card, ticketId: cardItemId }));
}

describe("conversation card store", () => {
  it("upserts an item execution card by stable key and updates operations in place", () => {
    const created = upsertItemExecutionCard(db, {
      turnId: "turn-1", itemId, operation: operation(0),
      now: new Date("2026-07-24T03:01:00.000Z"),
    });
    const updated = upsertItemExecutionCard(db, {
      turnId: "turn-1", itemId,
      operation: { ...operation(0), state: "completed", detail: "item #42" },
      now: new Date("2026-07-24T03:02:00.000Z"),
    });
    expect(updated.id).toBe(created.id);
    expect(updated.key).toBe(`turn:turn-1:ticket:${itemId}`);
    expect(updated.operations).toEqual([{
      ...operation(0), state: "completed", detail: "item #42",
    }]);
    expect(updated.updatedAt).toBe("2026-07-24T03:02:00.000Z");
  });

  it("retains the first and newest fifteen operations after the seventeenth unique row", () => {
    for (let index = 0; index < 17; index++) {
      upsertItemExecutionCard(db, { turnId: "turn-1", itemId, operation: operation(index) });
    }
    const card = getConversationCardByKey(db, `turn:turn-1:ticket:${itemId}`);
    expect(card?.kind).toBe("ticket_execution");
    if (!card || card.kind !== "ticket_execution") throw new Error("missing execution card");
    expect(card.operations).toHaveLength(16);
    expect(card.operations.map((item) => item.id)).toEqual([
      operation(0).id,
      ...Array.from({ length: 15 }, (_, offset) => operation(offset + 2).id),
    ]);
    expect(card.operationsTruncated).toBe(true);
  });

  it("rejects field and UTF-8 serialized payload overflow without corrupting the stored card", () => {
    expect(() => upsertItemExecutionCard(db, {
      turnId: "turn-1", itemId, operation: { ...operation(0), detail: "x".repeat(501) },
    })).toThrow(/detail/i);

    let rejected = false;
    for (let index = 0; index < 16; index++) {
      try {
        upsertItemExecutionCard(db, {
          turnId: "turn-1", itemId,
          operation: {
            id: `turn-1:${"i".repeat(220)}-${index}`,
            name: "n".repeat(120),
            state: "running",
            label: "l".repeat(160),
            detail: "界".repeat(500),
          },
        });
      } catch (error) {
        expect(String(error)).toMatch(/16 KiB/i);
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    const row = db.prepare("SELECT payload FROM conversation_cards").get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    expect(Buffer.byteLength(row!.payload, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("rejects invalid operation states and unknown display fields before persistence", () => {
    expect(() => upsertItemExecutionCard(db, {
      turnId: "turn-1", itemId,
      operation: { ...operation(0), state: "secret" as any },
    })).toThrow(/state/i);
    expect(() => upsertItemExecutionCard(db, {
      turnId: "turn-1", itemId,
      operation: { ...operation(0), rawArgs: { token: "secret" } } as any,
    })).toThrow(/unknown/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_cards").get())
      .toEqual({ count: 0 });
  });

  it("prevents checkpoint cards from crossing item boundaries", () => {
    const runId = createRun(db, { itemId });
    const checkpoint = insertCheckpoint(db, {
      itemId,
      runId,
      source: "agent_reported",
      kind: "progress",
      title: "item A",
      summary: "belongs to item A",
    });
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    expect(() => ensureCheckpointCard(db, {
      itemId: otherItem, checkpointId: checkpoint.id,
    })).toThrow(/item|checkpoint/i);
  });

  it("returns canonical card pages with forward and historical metadata", () => {
    const ids = Array.from({ length: 4 }, (_, index) => upsertItemExecutionCard(db, {
      turnId: "turn-1",
      itemId,
      operation: operation(index),
    }).id);
    expect(new Set(ids).size).toBe(1);

    for (let index = 2; index <= 4; index++) {
      const turnId = `turn-${index}`;
      db.prepare(
        `INSERT INTO channel_turns
          (id, origin_kind, item_id, state, user_text, created_at, updated_at)
         VALUES (?, 'cli', ?, 'completed', 'create it', ?, ?)`,
      ).run(turnId, itemId, "2026-07-24T03:00:00.000Z", "2026-07-24T03:00:00.000Z");
      upsertItemExecutionCard(db, { turnId, itemId, operation: operation(index) });
    }

    const latest = listConversationCardPage(db, { limit: 2 });
    expect(latest.items.map((item) => item.id)).toEqual([3, 4]);
    expect(latest).toMatchObject({ hasMore: true, nextBeforeId: 3 });
    const incremental = listConversationCardPage(db, { afterId: 1, limit: 2 });
    expect(incremental.items.map((item) => item.id)).toEqual([2, 3]);
    expect(incremental.hasMore).toBe(true);
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      ...incremental,
      items: toWireCards(incremental.items),
      checkpoints: [],
      interventionRefs: [],
    })).toBe(true);
    const initialIncremental = listConversationCardPage(db, { afterId: 0, limit: 2 });
    expect(Value.Check(KernelConversationCardListResponseSchema, {
      ...initialIncremental,
      items: toWireCards(initialIncremental.items),
      checkpoints: [],
      interventionRefs: [],
    })).toBe(true);
  });
});

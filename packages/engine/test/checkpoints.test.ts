import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { KernelCheckpointV2ListResponseSchema } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { createApproval, findPendingApprovalProjectionGaps } from "@pi-lead-child/store";
import {
  getCheckpoint, insertCheckpoint, insertCheckpointWithResult, listCheckpoints,
} from "@pi-lead-child/store";
import { ensureInterventionCard } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";

let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-checkpoints-"), "plc.db"));
  itemId = createItem(db, { title: "checkpoint", brief: "store", createdBy: "system" });
  runId = createRun(db, { itemId, role: "executor", runtime: "codex" });
});

function progress(summary: string) {
  return {
    itemId,
    runId,
    source: "agent_reported" as const,
    kind: "progress" as const,
    stage: "implementation",
    title: "实现进展",
    summary,
    keyFacts: [{ label: "tests", value: "passing" }],
    artifactRefs: [],
    relatedItemIds: [],
    nextStep: "继续实现",
    actionRef: null,
  };
}

// listCheckpoints 现在返回内部词汇（itemId/runId/relatedItemIds），而 protocol 的
// KernelCheckpointV2* 仍是冻结的线上词汇。要验的仍然是"这一页满足协议的分页契约"，
// 所以经 coordinator 的线上投影再校验，而不是把内部页直接喂给线上 schema。
function wirePage(query: { itemId: number; beforeId?: number; afterId?: number; limit?: number }) {
  return createCoordinator({ db }).listTicketCheckpointsV2(query.itemId, {
    ...(query.beforeId === undefined ? {} : { beforeId: query.beforeId }),
    ...(query.afterId === undefined ? {} : { afterId: query.afterId }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
}

describe("checkpoint store", () => {
  it("normalizes and persists structured progress and proof while materializing current proof state", () => {
    const checkpoint = insertCheckpoint(db, {
      ...progress("structured progress"),
      progress: { current: 3, total: 5, label: "  Protocol coverage  " },
      proofItems: [
        { id: "auth", label: "  Auth boundary  ", state: "passed", evidence: "  tests pass  " },
        { id: "docs", label: "Docs", state: "pending", evidence: "" },
      ],
    });

    expect(checkpoint.progress).toEqual({ current: 3, total: 5, label: "Protocol coverage" });
    expect(checkpoint.proofItems).toEqual([
      { id: "auth", label: "Auth boundary", state: "passed", evidence: "tests pass" },
      { id: "docs", label: "Docs", state: "pending", evidence: null },
    ]);
    expect(db.prepare(
      `SELECT proof_key, label, state, evidence, checkpoint_id
       FROM item_proof_items WHERE item_id=? ORDER BY proof_key`,
    ).all(itemId)).toEqual([
      { proof_key: "auth", label: "Auth boundary", state: "passed", evidence: "tests pass", checkpoint_id: checkpoint.id },
      { proof_key: "docs", label: "Docs", state: "pending", evidence: null, checkpoint_id: checkpoint.id },
    ]);
  });

  it("updates and retires stable proof ids in checkpoint order without mutating history", () => {
    const first = insertCheckpoint(db, {
      ...progress("first proof"),
      proofItems: [
        { id: "auth", label: "Auth", state: "pending", evidence: null },
        { id: "old", label: "Old proof", state: "pending", evidence: null },
      ],
    }, { dedupeWindowMs: 0, now: new Date("2026-07-25T02:00:00.000Z") });
    const second = insertCheckpoint(db, {
      ...progress("second proof"),
      proofItems: [
        { id: "auth", label: "Auth", state: "passed", evidence: "verified" },
        { id: "old", label: "Old proof", state: "retired", evidence: null },
      ],
    }, { dedupeWindowMs: 0, now: new Date("2026-07-25T02:01:00.000Z") });

    expect(getCheckpoint(db, first.id)?.proofItems).toEqual([
      { id: "auth", label: "Auth", state: "pending", evidence: null },
      { id: "old", label: "Old proof", state: "pending", evidence: null },
    ]);
    expect(getCheckpoint(db, second.id)?.proofItems[1]).toMatchObject({ id: "old", state: "retired" });
    expect(db.prepare(
      "SELECT proof_key, state, checkpoint_id FROM item_proof_items WHERE item_id=?",
    ).all(itemId)).toEqual([{ proof_key: "auth", state: "passed", checkpoint_id: second.id }]);
  });

  it("rejects invalid progress, duplicate proof ids, proof overflow, and invalid retirement before writing", () => {
    expect(() => insertCheckpoint(db, {
      ...progress("bad progress"), progress: { current: 6, total: 5, label: null },
    })).toThrow(/progress/i);
    expect(() => insertCheckpoint(db, {
      ...progress("duplicate proof"),
      proofItems: [
        { id: "same", label: "One", state: "pending", evidence: null },
        { id: "same", label: "Two", state: "passed", evidence: null },
      ],
    })).toThrow(/duplicate|unique/i);
    expect(() => insertCheckpoint(db, {
      ...progress("too many proof items"),
      proofItems: Array.from({ length: 21 }, (_, index) => ({
        id: `proof-${index}`, label: `Proof ${index}`, state: "pending" as const, evidence: null,
      })),
    })).toThrow(/20|proof/i);
    expect(() => insertCheckpoint(db, {
      ...progress("invalid retirement"),
      proofItems: [{ id: "missing", label: "Missing", state: "retired", evidence: null }],
    })).toThrow(/retire|missing|current/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
  });

  it("enforces the 200-current-proof quota transactionally", () => {
    const anchor = insertCheckpoint(db, {
      itemId,
      runId: null,
      source: "system_derived",
      kind: "milestone",
      title: "Anchor",
      summary: "Quota anchor",
      idempotencyKey: `proof-anchor:${itemId}`,
    });
    const insert = db.prepare(
      `INSERT INTO item_proof_items
       (item_id, proof_key, label, state, checkpoint_id, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    );
    for (let index = 0; index < 200; index++) {
      insert.run(itemId, `existing-${index}`, `Existing ${index}`, anchor.id, anchor.createdAt);
    }

    expect(() => insertCheckpoint(db, {
      ...progress("quota overflow"),
      proofItems: [{ id: "overflow", label: "Overflow", state: "pending", evidence: null }],
    })).toThrow(/200|quota/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_proof_items WHERE item_id=?")
      .get(itemId)).toEqual({ n: 200 });
  });

  it("includes progress and proof in idempotency and dedupe identity", () => {
    const input = {
      ...progress("idempotent structured content"),
      progress: { current: 1, total: 2, label: "Build" },
      proofItems: [{ id: "build", label: "Build", state: "passed" as const, evidence: null }],
      idempotencyKey: `structured:${itemId}`,
    };
    const first = insertCheckpointWithResult(db, input);
    expect(insertCheckpointWithResult(db, input)).toMatchObject({
      deduplicated: true, checkpoint: { id: first.checkpoint.id },
    });
    expect(() => insertCheckpoint(db, {
      ...input, progress: { current: 2, total: 2, label: "Build" },
    })).toThrow(/idempotency key/i);
    expect(() => insertCheckpoint(db, {
      ...input,
      proofItems: [{ id: "build", label: "Build", state: "failed", evidence: "changed" }],
    })).toThrow(/idempotency key/i);
  });

  it("preserves legacy idempotency hashes when progress and proof are absent", () => {
    const input = {
      itemId,
      runId: null,
      source: "system_derived" as const,
      kind: "milestone" as const,
      stage: null,
      title: "Legacy hash",
      summary: "Legacy hash summary",
      keyFacts: [],
      artifactRefs: [],
      relatedItemIds: [],
      nextStep: null,
      actionRef: null,
      idempotencyKey: `legacy-hash:${itemId}`,
    };
    const legacyHash = createHash("sha256").update(JSON.stringify({
      runId: input.runId,
      kind: input.kind,
      stage: input.stage,
      title: input.title,
      summary: input.summary,
      keyFacts: input.keyFacts,
      artifactRefs: input.artifactRefs,
      relatedItemIds: input.relatedItemIds,
      nextStep: input.nextStep,
      actionRef: input.actionRef,
    })).digest("hex");
    const id = Number(db.prepare(
      `INSERT INTO checkpoints (
         item_id, run_id, source, kind, stage, title, summary, key_facts, artifact_refs,
         related_item_ids, next_step, action_type, action_id, idempotency_key, content_hash
       ) VALUES (?, NULL, 'system_derived', 'milestone', NULL, ?, ?, '[]', '[]', '[]',
                 NULL, NULL, NULL, ?, ?)`,
    ).run(itemId, input.title, input.summary, input.idempotencyKey, legacyHash).lastInsertRowid);

    expect(insertCheckpointWithResult(db, input)).toMatchObject({
      deduplicated: true,
      checkpoint: { id },
    });
  });

  it("rolls the checkpoint row back when proof materialization fails", () => {
    db.exec(`
      CREATE TRIGGER fail_proof_materialization
      BEFORE INSERT ON item_proof_items
      BEGIN
        SELECT RAISE(FAIL, 'proof materialization unavailable');
      END;
    `);
    expect(() => insertCheckpoint(db, {
      ...progress("atomic proof"),
      proofItems: [{ id: "atomic", label: "Atomic", state: "pending", evidence: null }],
    })).toThrow(/proof materialization unavailable/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
  });

  it("stores immutable typed checkpoints and derives executor attribution", () => {
    const checkpoint = insertCheckpoint(db, progress("第一版完成"), {
      now: new Date("2026-07-24T01:00:00.000Z"),
    });
    expect(checkpoint).toMatchObject({
      itemId,
      runId,
      author: { kind: "executor", runtime: "codex" },
      source: "agent_reported",
      kind: "progress",
      createdAt: "2026-07-24T01:00:00.000Z",
    });

    const correction = insertCheckpoint(db, progress("更正后的说明"), {
      now: new Date("2026-07-24T01:02:00.000Z"),
    });
    expect(correction.id).toBeGreaterThan(checkpoint.id);
    expect(getCheckpoint(db, checkpoint.id)?.summary).toBe("第一版完成");
  });

  it("deduplicates exact agent content inside the window and system keys exactly once", () => {
    const firstResult = insertCheckpointWithResult(db, progress("同一内容"), {
      now: new Date("2026-07-24T01:00:00.000Z"), dedupeWindowMs: 60_000,
    });
    const duplicateResult = insertCheckpointWithResult(db, progress("同一内容"), {
      now: new Date("2026-07-24T01:00:30.000Z"), dedupeWindowMs: 60_000,
    });
    expect(firstResult.deduplicated).toBe(false);
    expect(duplicateResult).toMatchObject({
      deduplicated: true,
      checkpoint: { id: firstResult.checkpoint.id },
    });

    const systemInput = {
      itemId,
      runId: null,
      source: "system_derived" as const,
      kind: "milestone" as const,
      stage: null,
      title: "计划已封存",
      summary: "revision 1",
      keyFacts: [],
      artifactRefs: [],
      relatedItemIds: [],
      nextStep: null,
      actionRef: null,
      idempotencyKey: `plan-sealed:${itemId}:1`,
    };
    const system = insertCheckpoint(db, systemInput);
    expect(insertCheckpoint(db, systemInput).id).toBe(system.id);
    expect(() => insertCheckpoint(db, { ...systemInput, summary: "different" }))
      .toThrow(/idempotency key/i);
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    expect(() => insertCheckpoint(db, { ...systemInput, itemId: otherItem }))
      .toThrow(/idempotency key/i);
  });

  it("returns default, before, and after pages in canonical ascending ID order", () => {
    const ids = Array.from({ length: 6 }, (_, index) => insertCheckpoint(
      db,
      progress(`checkpoint-${index}`),
      { now: new Date(`2026-07-24T01:0${index}:00.000Z`), dedupeWindowMs: 0 },
    ).id);

    expect(listCheckpoints(db, { itemId, limit: 3 }).items.map((item) => item.id))
      .toEqual(ids.slice(3));
    expect(listCheckpoints(db, { itemId, beforeId: ids[4], limit: 2 }).items.map((item) => item.id))
      .toEqual(ids.slice(2, 4));
    expect(listCheckpoints(db, { itemId, afterId: ids[1], limit: 2 }).items.map((item) => item.id))
      .toEqual(ids.slice(2, 4));
    expect(Value.Check(
      KernelCheckpointV2ListResponseSchema,
      wirePage({ itemId, limit: 2 }),
    )).toBe(true);
    expect(Value.Check(
      KernelCheckpointV2ListResponseSchema,
      wirePage({ itemId, limit: 10 }),
    )).toBe(true);
    expect(() => listCheckpoints(db, { itemId, beforeId: ids[4], afterId: ids[1] }))
      .toThrow(/mutually exclusive/i);
  });

  it("rejects invalid ownership, kind requirements, and bounded fields before writing", () => {
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    expect(() => insertCheckpoint(db, { ...progress("wrong item"), itemId: otherItem }))
      .toThrow(/run.*item/i);
    expect(() => insertCheckpoint(db, {
      ...progress("delegation"), kind: "delegation", relatedItemIds: [],
    })).toThrow(/related item/i);
    expect(() => insertCheckpoint(db, {
      ...progress("blocked"), kind: "blocked", nextStep: null, actionRef: null,
    })).toThrow(/blocked/i);
    expect(() => insertCheckpoint(db, { ...progress("large"), title: "x".repeat(161) }))
      .toThrow(/title/i);
    expect(() => insertCheckpoint(db, {
      ...progress("unknown nested field"),
      keyFacts: [{ label: "safe", value: "value", rawArgs: "secret" } as any],
    })).toThrow(/unknown.*keyFacts/i);
    expect(() => insertCheckpoint(db, {
      ...progress("bad artifact"), artifactRefs: [42 as any],
    })).toThrow(/artifactRefs/i);
    expect(() => insertCheckpoint(db, {
      ...progress("bad related item"), relatedItemIds: [0],
    })).toThrow(/relatedItemIds/i);
    expect((db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get() as { count: number }).count)
      .toBe(0);
  });

  it("rejects agent reports from runs that no longer actively own the item", () => {
    updateRun(db, runId, { state: "finished", endedAt: true });
    expect(() => insertCheckpoint(db, progress("late report"))).toThrow(/current|active|run/i);
  });

  it("rejects a superseded active run when a newer run owns the same role", () => {
    const currentRunId = createRun(db, { itemId, role: "executor", runtime: "pi" });
    expect(() => insertCheckpoint(db, progress("superseded report")))
      .toThrow(/current|superseded|run/i);
    expect(insertCheckpoint(db, {
      ...progress("current report"), runId: currentRunId,
    }).runId).toBe(currentRunId);
  });

  it("attributes approvals to runs and returns one idempotent repair gap per authority", () => {
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    const otherRun = createRun(db, { itemId: otherItem });
    expect(() => createApproval(db, {
      itemId, runId: otherRun, requestedBy: "child", tool: "sudo", action: "wrong",
    })).toThrow(/run.*item/i);
    const approvalId = createApproval(db, {
      itemId, runId, requestedBy: "child", tool: "sudo", action: "install service",
    });
    expect(db.prepare("SELECT run_id FROM approvals WHERE id = ?").get(approvalId))
      .toEqual({ run_id: runId });
    const base = {
      itemId,
      runId: null,
      source: "system_derived" as const,
      kind: "blocked" as const,
      stage: null,
      title: "等待授权",
      summary: "需要 sudo",
      keyFacts: [],
      artifactRefs: [],
      relatedItemIds: [],
      nextStep: null,
      actionRef: { type: "approval" as const, id: approvalId },
    };
    insertCheckpoint(db, { ...base, idempotencyKey: `approval-created:${approvalId}` });
    const latest = insertCheckpoint(db, { ...base, summary: "仍在等待", idempotencyKey: `approval-wait:${approvalId}` });
    expect(findPendingApprovalProjectionGaps(db)).toEqual([{
      authority: expect.objectContaining({ id: approvalId, run_id: runId }),
      checkpointId: latest.id,
      cardId: null,
    }]);
    ensureInterventionCard(db, {
      itemId, checkpointId: latest.id, actionType: "approval", actionId: approvalId,
    });
    expect(findPendingApprovalProjectionGaps(db)).toEqual([]);
  });

  it("ignores itemless pending approvals because they cannot own checkpoint projections", () => {
    createApproval(db, { requestedBy: "lead", tool: "global", action: "global approval" });
    expect(findPendingApprovalProjectionGaps(db)).toEqual([]);
  });

  it("does not return cross-item checkpoint or card ids from approval repair queries", () => {
    const approvalId = createApproval(db, {
      itemId, runId, requestedBy: "child", tool: "sudo", action: "install",
    });
    const otherItem = createItem(db, { title: "other", brief: "other", createdBy: "system" });
    const checkpointId = Number(db.prepare(
      `INSERT INTO checkpoints
        (item_id, source, kind, title, summary, action_type, action_id, idempotency_key, content_hash)
       VALUES (?, 'system_derived', 'blocked', 'wrong', 'wrong item', 'approval', ?, ?, 'hash')`,
    ).run(otherItem, approvalId, `wrong:${approvalId}`).lastInsertRowid);
    db.prepare(
      `INSERT INTO conversation_cards
        (item_id, kind, checkpoint_id, action_type, action_id, idempotency_key)
       VALUES (?, 'intervention', ?, 'approval', ?, ?)`,
    ).run(otherItem, checkpointId, approvalId, `wrong-card:${approvalId}`);

    expect(findPendingApprovalProjectionGaps(db)).toEqual([{
      authority: expect.objectContaining({ id: approvalId }),
      checkpointId: null,
      cardId: null,
    }]);
  });
});

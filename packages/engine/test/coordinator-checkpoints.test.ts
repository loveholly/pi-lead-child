import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createRun, updateRun } from "@pi-lead-child/store";
import { stageArtifact } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { transition } from "@pi-lead-child/store";

let db: Db;
let dataDir: string;
let workdir: string;

beforeEach(() => {
  dataDir = tempDir("plc-coordinator-checkpoints-");
  workdir = join(dataDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  db = openDb(join(dataDir, "plc.db"));
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function activeItem() {
  const coordinator = createCoordinator({
    db,
    now: () => new Date("2026-07-24T08:00:00.000Z"),
  });
  const itemId = coordinator.createRootItem({
    title: "checkpoint", brief: "transaction", createdBy: "system", workdir,
  });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  return { coordinator, itemId, runId };
}

function stagedReport(itemId: number, runId: number, content = "atomic report\n") {
  writeFileSync(join(workdir, "report.md"), content);
  return stageArtifact(db, {
    dataDir,
    itemId,
    runId,
    ref: "report",
    name: "report.md",
    kind: "report",
    mediaType: "text/markdown",
    description: "Atomic checkpoint report",
    relativePath: "report.md",
  });
}

describe("coordinator checkpoint service", () => {
  it("commits checkpoint, activity, item touch, and outbox once, then suppresses duplicate effects", () => {
    const { coordinator, itemId, runId } = activeItem();
    const input = {
      itemId,
      runId,
      kind: "milestone" as const,
      stage: "implementation",
      title: "Transaction boundary implemented",
      summary: "The coordinator now owns the complete checkpoint write path.",
      keyFacts: [{ label: "tests", value: "red" }],
      artifactRefs: [],
      relatedItemIds: [],
      nextStep: "Exercise rollback",
    };

    const created = coordinator.submitCheckpoint(input);
    const duplicate = coordinator.submitCheckpoint(input);

    expect(created).toMatchObject({ deduplicated: false, checkpoint: { itemId, runId } });
    expect(duplicate).toMatchObject({
      deduplicated: true,
      checkpoint: { id: created.checkpoint.id },
    });
    expect(count("checkpoints")).toBe(1);
    expect(count("activities")).toBe(1);
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([{ event_type: "ticket.updated" }]);
    expect(db.prepare("SELECT last_activity_at FROM items WHERE id=?").get(itemId))
      .toEqual({ last_activity_at: "2026-07-24T08:00:00.000Z" });
  });

  it("rolls back checkpoint, activity, item touch, and outbox when the final outbox insert fails", () => {
    const { coordinator, itemId, runId } = activeItem();
    db.exec(`
      CREATE TRIGGER fail_checkpoint_outbox
      BEFORE INSERT ON gateway_events
      BEGIN
        SELECT RAISE(FAIL, 'outbox unavailable');
      END;
    `);

    expect(() => coordinator.submitCheckpoint({
      itemId,
      runId,
      kind: "progress",
      title: "Will roll back",
      summary: "No partial checkpoint state may survive.",
    })).toThrow(/outbox unavailable/i);

    expect(count("checkpoints")).toBe(0);
    expect(count("activities")).toBe(0);
    expect(count("gateway_events")).toBe(0);
    expect(db.prepare("SELECT last_activity_at FROM items WHERE id=?").get(itemId))
      .toEqual({ last_activity_at: null });
  });

  it("commits checkpoint, proof, artifact, activity, card, touch, and final outbox together", () => {
    const { coordinator, itemId, runId } = activeItem();
    const staged = stagedReport(itemId, runId);

    const result = coordinator.submitCheckpoint({
      itemId,
      runId,
      kind: "completed",
      title: "Atomic checkpoint committed",
      summary: "The complete durable checkpoint projection was committed together.",
      progress: { current: 5, total: 5, label: "Verification" },
      proofItems: [{
        id: "tests",
        label: "Regression suite",
        state: "passed",
        evidence: "focused tests pass",
      }],
      artifactRefs: ["report"],
      stagedArtifacts: [staged],
      nextStep: "Independent review",
    });

    expect(result.deduplicated).toBe(false);
    expect(count("checkpoints")).toBe(1);
    expect(count("item_proof_items")).toBe(1);
    expect(count("artifacts")).toBe(1);
    expect(count("activities")).toBe(1);
    expect(count("conversation_cards")).toBe(1);
    expect(db.prepare(
      "SELECT progress_current, progress_total, progress_label, proof_items FROM checkpoints",
    ).get()).toEqual({
      progress_current: 5,
      progress_total: 5,
      progress_label: "Verification",
      proof_items: JSON.stringify([{
        id: "tests",
        label: "Regression suite",
        state: "passed",
        evidence: "focused tests pass",
      }]),
    });
    expect(db.prepare("SELECT ref, sha256, byte_length FROM artifacts").get()).toEqual({
      ref: "report",
      sha256: staged.sha256,
      byte_length: staged.byteLength,
    });
    expect(db.prepare("SELECT last_activity_at FROM items WHERE id=?").get(itemId))
      .toEqual({ last_activity_at: "2026-07-24T08:00:00.000Z" });
    expect(db.prepare("SELECT event_type FROM gateway_events ORDER BY seq").all())
      .toEqual([{ event_type: "ticket.updated" }]);
  });

  it.each([
    ["checkpoint", "checkpoints", "BEFORE INSERT ON checkpoints"],
    ["proof", "item_proof_items", "BEFORE INSERT ON item_proof_items"],
    ["artifact", "artifacts", "BEFORE INSERT ON artifacts"],
    [
      "activity",
      "activities",
      "BEFORE INSERT ON activities WHEN json_extract(NEW.payload, '$.checkpointId') IS NOT NULL",
    ],
    ["card", "conversation_cards", "BEFORE INSERT ON conversation_cards"],
    [
      "item touch",
      "items",
      "BEFORE UPDATE ON items WHEN NEW.last_activity_at IS NOT OLD.last_activity_at",
    ],
    ["outbox", "gateway_events", "BEFORE INSERT ON gateway_events"],
  ] as const)("rolls back every domain write when %s persistence fails", (_label, table, clause) => {
    const { coordinator, itemId, runId } = activeItem();
    const staged = stagedReport(itemId, runId, `failure at ${table}\n`);
    db.exec(`
      CREATE TRIGGER fail_${table}_atomicity
      ${clause}
      BEGIN
        SELECT RAISE(FAIL, '${table} unavailable');
      END;
    `);

    expect(() => coordinator.submitCheckpoint({
      itemId,
      runId,
      kind: "completed",
      title: "Atomic rollback",
      summary: "No checkpoint domain write may survive a partial failure.",
      progress: { current: 1, total: 1, label: "Atomicity" },
      proofItems: [{
        id: "atomicity",
        label: "Atomicity",
        state: "passed",
        evidence: "rollback verified",
      }],
      artifactRefs: ["report"],
      stagedArtifacts: [staged],
      nextStep: "Retry after persistence recovers",
    })).toThrow(new RegExp(`${table} unavailable`, "i"));

    for (const domainTable of [
      "checkpoints",
      "item_proof_items",
      "artifacts",
      "activities",
      "conversation_cards",
      "gateway_events",
    ]) {
      expect(count(domainTable)).toBe(0);
    }
    expect(db.prepare("SELECT last_activity_at FROM items WHERE id=?").get(itemId))
      .toEqual({ last_activity_at: null });
  });
});

describe("planning and delegation lifecycle checkpoints", () => {
  it("writes deterministic parent checkpoints and suppresses replay side effects", () => {
    const { coordinator, itemId: parentId, runId: parentRunId } = activeItem();
    const revision = coordinator.beginPlanning({ itemId: parentId, runId: parentRunId });
    const childId = coordinator.createSubitem(
      { itemId: parentId, runId: parentRunId, revision },
      { title: "child", brief: "implement child" },
    );
    coordinator.finishPlanning({ itemId: parentId, runId: parentRunId, revision });
    coordinator.finishPlanning({ itemId: parentId, runId: parentRunId, revision });

    const childRunId = createRun(db, { itemId: childId, runtime: "pi" });
    updateRun(db, childRunId, { state: "finished", endedAt: true });
    transition(db, { itemId: childId, to: "active", actor: "system", reason: "started" });
    transition(db, { itemId: childId, to: "review", actor: "child", reason: "ready" });
    transition(db, { itemId: childId, to: "done", actor: "system", reason: "review passed" });
    coordinator.recordSubitemCompleted({
      parentItemId: parentId,
      childItemId: childId,
      runId: childRunId,
    });
    coordinator.recordSubitemCompleted({
      parentItemId: parentId,
      childItemId: childId,
      runId: childRunId,
    });

    const checkpoints = db.prepare(
      "SELECT kind, related_item_ids, idempotency_key FROM checkpoints WHERE item_id=? ORDER BY id",
    ).all(parentId);
    expect(checkpoints).toEqual([
      {
        kind: "delegation",
        related_item_ids: JSON.stringify([childId]),
        idempotency_key: `subitem-created:${parentId}:${childId}`,
      },
      {
        kind: "milestone",
        related_item_ids: "[]",
        idempotency_key: `plan-sealed:${parentId}:${revision}`,
      },
      {
        kind: "milestone",
        related_item_ids: JSON.stringify([childId]),
        idempotency_key: `subitem-completed:${parentId}:${childId}:${childRunId}`,
      },
    ]);
    expect(db.prepare("SELECT event_type, item_id FROM gateway_events ORDER BY seq").all())
      .toEqual([
        { event_type: "ticket.created", item_id: childId },
        { event_type: "ticket.updated", item_id: parentId },
        { event_type: "ticket.updated", item_id: parentId },
        { event_type: "attempt.updated", item_id: childId },
        { event_type: "ticket.updated", item_id: parentId },
      ]);
  });

  it("rejects completion checkpoints until both the child item and executor run completed", () => {
    const { coordinator, itemId: parentId, runId: parentRunId } = activeItem();
    const revision = coordinator.beginPlanning({ itemId: parentId, runId: parentRunId });
    const childId = coordinator.createSubitem(
      { itemId: parentId, runId: parentRunId, revision },
      { title: "child", brief: "implement child" },
    );
    const childRunId = createRun(db, { itemId: childId, runtime: "pi" });

    expect(() => coordinator.recordSubitemCompleted({
      parentItemId: parentId,
      childItemId: childId,
      runId: childRunId,
    })).toThrow(/run.*settled/i);

    updateRun(db, childRunId, { state: "finished", endedAt: true });
    expect(() => coordinator.recordSubitemCompleted({
      parentItemId: parentId,
      childItemId: childId,
      runId: childRunId,
    })).toThrow(/item.*done/i);

    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key LIKE 'subitem-completed:%'",
    ).get()).toEqual({ n: 0 });
  });
});

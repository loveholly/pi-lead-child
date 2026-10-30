// 决策边界（工单 07，spec D3）：什么时候记下登记待处理，以及它会不会改动工单的 stage。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { recordRegistrationPending } from "../src/pipeline/run-registration.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import type { RunPurpose } from "@pi-lead-child/core";

let db: Db;
let itemId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-run-registration-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
});

function run(options: { role?: "executor" | "reviewer"; purpose?: RunPurpose; state?: "finished" | "failed" | "running" } = {}) {
  // reviewer 只能在 review 阶段创建。这里只测角色这一条判断，所以建完 Run 再把 stage 改回 active。
  if (options.role === "reviewer") db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  const runId = createRun(db, { itemId, runtime: "codex", role: options.role, purpose: options.purpose });
  if (options.role === "reviewer") db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
  updateRun(db, runId, { state: options.state ?? "finished", endedAt: true, exitCode: 0 });
  return runId;
}

function pendingDecisions(runId: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM activities
     WHERE run_id=? AND json_extract(payload, '$.decision')='registration_pending'`,
  ).get(runId) as { n: number }).n;
}

describe("registration pending", () => {
  it("records a finished run once, however often a step reports it", () => {
    const runId = run();
    const error = new Error("ingest exploded");

    expect(recordRegistrationPending(db, { itemId, runId, step: "ingest", error })).toBe(true);
    expect(recordRegistrationPending(db, { itemId, runId, step: "outcome_recovery", error })).toBe(true);

    expect(JSON.parse(getRun(db, runId)!.metadata).registration).toMatchObject({ state: "pending", step: "ingest" });
    expect(pendingDecisions(runId)).toBe(1);
    expect(listInbox(db, { severity: "blocker" })).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?")
      .get(`registration-pending:${runId}`)).toEqual({ n: 1 });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
  });

  it("keeps a credential in the step error out of the blocker, the activity and the diagnostic", () => {
    const runId = run();
    const error = new Error("webhook refused: Authorization: Bearer abcdefghijkl1234567890");

    expect(recordRegistrationPending(db, { itemId, runId, step: "handoff_check", error })).toBe(true);
    const written = JSON.stringify([
      listInbox(db, { severity: "blocker" }).map((row) => row.payload),
      db.prepare("SELECT payload FROM activities WHERE run_id=?").all(runId),
      getRun(db, runId)!.metadata,
    ]);
    expect(written).toContain("[redacted]");
    expect(written).not.toContain("abcdefghijkl1234567890");
  });

  it.each(["failed", "running"] as const)("does not record a %s run", (state) => {
    const runId = run({ state });

    expect(recordRegistrationPending(db, { itemId, runId, step: "handoff_check", error: new Error("x") })).toBe(false);
    expect(JSON.parse(getRun(db, runId)!.metadata)).not.toHaveProperty("registration");
    expect(pendingDecisions(runId)).toBe(0);
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(getItem(db, itemId)?.stage).toBe("active");
  });

  it("does not move an item that a step already moved out of active", () => {
    const runId = run();
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff", runId });

    expect(recordRegistrationPending(db, { itemId, runId, step: "handoff_check", error: new Error("x") })).toBe(true);
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it.each([
    ["a conversation run", { purpose: "conversation" as const }],
    ["a reviewer run", { role: "reviewer" as const, purpose: "review" as const }],
  ])("does not change the item stage for %s", (_label, options) => {
    const runId = run(options);

    expect(recordRegistrationPending(db, { itemId, runId, step: "ingest", error: new Error("x") })).toBe(true);
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(listInbox(db, { severity: "blocker" })).toHaveLength(1);
  });
});

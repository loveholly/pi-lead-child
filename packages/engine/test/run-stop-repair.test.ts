import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { repairStoppedRunCrashCheckpoints } from "../src/pipeline/run-stop-repair.js";
import { openDb } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";

describe("stopped run crash projection repair", () => {
  it("replaces a false crash checkpoint with a stopped lifecycle record", () => {
    const db = openDb(join(tempDir("plc-stop-repair-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, {
      state: "stopped",
      endedAt: true,
      errorCode: "interrupted",
      errorMessage: "stopped by user",
    });
    const checkpoint = createCoordinator({ db }).recordSystemCheckpoint({
      itemId,
      runId,
      kind: "blocked",
      title: "Run crashed",
      summary: `Run #${runId} crashed (interrupted): stopped by user`,
      nextStep: "Inspect and retry.",
      idempotencyKey: `run-crash:${runId}`,
      leadVisible: true,
    }).checkpoint;

    expect(repairStoppedRunCrashCheckpoints(db)).toBe(1);
    expect(getRun(db, runId)).toMatchObject({
      state: "stopped",
      error_code: null,
      error_message: null,
    });
    expect(db.prepare("SELECT 1 FROM checkpoints WHERE id=?").get(checkpoint.id)).toBeUndefined();
    expect(db.prepare(
      "SELECT kind, title FROM checkpoints WHERE idempotency_key=?",
    ).get(`run-stopped:${runId}`)).toEqual({ kind: "decision", title: "Run stopped" });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM conversation_cards WHERE checkpoint_id=?",
    ).get(checkpoint.id)).toEqual({ n: 0 });
    expect(repairStoppedRunCrashCheckpoints(db)).toBe(0);
  });
});


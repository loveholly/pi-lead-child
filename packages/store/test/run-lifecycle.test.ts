import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import {
  createRun, getRun, markRunFailed, markRunFinished, markRunRunning, markRunStopped,
  pauseRun, resumeRun, transitionRunState,
} from "../src/runs.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-run-lifecycle-"), "plc.db"));
});

function task(): number {
  return createItem(db, { title: "run", brief: "lifecycle", createdBy: "system" });
}

describe("semantic run lifecycle", () => {
  it("allows the normal starting → running → finished path", () => {
    const runId = createRun(db, { itemId: task() });
    markRunRunning(db, runId);
    markRunFinished(db, runId, { exitCode: 0 });
    expect(getRun(db, runId)).toMatchObject({ state: "finished", exit_code: 0 });
  });

  it("rejects terminal-state rewrites and paused → finished shortcuts", () => {
    const first = createRun(db, { itemId: task() });
    markRunRunning(db, first);
    markRunFinished(db, first);
    expect(() => markRunFailed(db, first, { errorCode: "late" })).toThrow(/illegal run transition/);

    const second = createRun(db, { itemId: task() });
    markRunRunning(db, second);
    pauseRun(db, second, new Date("2026-09-04T00:00:00.000Z"));
    expect(() => markRunFinished(db, second)).toThrow(/illegal run transition paused -> finished/);
    resumeRun(db, second, new Date("2026-09-04T00:01:00.000Z"));
    markRunFinished(db, second);
    expect(getRun(db, second)?.state).toBe("finished");
  });

  it("records stop and failure through explicit semantic writers", () => {
    const stopped = createRun(db, { itemId: task() });
    markRunStopped(db, stopped);
    expect(getRun(db, stopped)).toMatchObject({ state: "stopped" });

    const failed = createRun(db, { itemId: task() });
    markRunFailed(db, failed, { errorCode: "provider_error", errorMessage: "provider failed" });
    expect(getRun(db, failed)).toMatchObject({ state: "failed", error_code: "provider_error" });
  });

  it("keeps same-state technical updates idempotent without opening a new edge", () => {
    const runId = createRun(db, { itemId: task() });
    markRunRunning(db, runId);
    transitionRunState(db, runId, "running", { model: "gpt-test" });
    expect(getRun(db, runId)).toMatchObject({ state: "running", model: "gpt-test" });
  });
});

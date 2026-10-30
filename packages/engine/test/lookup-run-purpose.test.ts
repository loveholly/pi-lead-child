// purpose=lookup 的 Run（slack-takeover spec D5）在内核里的决策边界：不改工单的生命周期，不升 blocker，
// 不进瞬时重试，不记健康账本，不叫醒 Lead。用回放 runtime 给出各种结局，看 runItem 落了什么。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { kernelRetriesTransient, typedFailure } from "@pi-lead-child/runtime";
import { createItem, createRun, getItem, getRun, isDeliveryRun, openDb, transition } from "@pi-lead-child/store";
import { runItem } from "../src/children/manager.js";

function lookupFixture(prefix: string) {
  const dir = tempDir(prefix);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: "代查", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  transition(db, { itemId, to: "active", actor: "system", reason: "lookup started", runId });
  return { dir, dbPath, db, itemId, runId };
}

async function replay(fixture: ReturnType<typeof lookupFixture>, events: RecordedEvent[]) {
  await runItem(fixture.db, fixture.itemId, {
    dbPath: fixture.dbPath, dataDir: fixture.dir, sessionDir: join(fixture.dir, "sessions", `item-${fixture.itemId}`),
    prompt: "lookup", purpose: "lookup", role: "executor", runId: fixture.runId, lingerMs: 0,
    runtime: new ReplayRuntime({ runtime: "pi", events }),
  });
}

function sideEffects(fixture: ReturnType<typeof lookupFixture>) {
  const count = (sql: string) => (fixture.db.prepare(sql).get(fixture.itemId) as { n: number }).n;
  return {
    stage: getItem(fixture.db, fixture.itemId)!.stage,
    inbox: count("SELECT COUNT(*) AS n FROM inbox WHERE item_id=?"),
    blockedCheckpoints: count("SELECT COUNT(*) AS n FROM checkpoints WHERE item_id=? AND kind='blocked'"),
    dispatch: count("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?"),
    incidents: (fixture.db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get() as { n: number }).n,
  };
}

const quiet = { stage: "active", inbox: 0, blockedCheckpoints: 0, dispatch: 0, incidents: 0 };

describe("lookup run purpose in the kernel", () => {
  it("is not a delivery and is never retried by the kernel", () => {
    expect(isDeliveryRun({ role: "executor", purpose: "lookup" })).toBe(false);
    expect(kernelRetriesTransient(typedFailure("provider_overloaded", { errorCode: null, message: "overloaded" }), "lookup")).toBe(false);
    expect(kernelRetriesTransient(typedFailure("provider_overloaded", { errorCode: null, message: "overloaded" }), "execution")).toBe(true);
  });

  it("finishes without moving the ticket or asking for a handoff", async () => {
    const fixture = lookupFixture("plc-lookup-purpose-done-");
    await replay(fixture, [
      { type: "run.started", runtime: "pi", model: null },
      { type: "message.completed", messageId: "m1", role: "assistant", text: "交了结果", stopReason: "stop" },
      { type: "run.completed", exitCode: 0 },
    ]);
    expect(getRun(fixture.db, fixture.runId)?.state).toBe("finished");
    expect(sideEffects(fixture)).toEqual(quiet);
  });

  it("fails on a transient provider error without a retry, a blocker or a blocked ticket", async () => {
    const fixture = lookupFixture("plc-lookup-purpose-transient-");
    await replay(fixture, [
      { type: "run.started", runtime: "pi", model: null },
      { type: "run.failed", exitCode: null, errorCode: "llm_error", error: "529 overloaded_error: Overloaded" },
    ]);
    expect(getRun(fixture.db, fixture.runId)?.state).toBe("failed");
    expect(sideEffects(fixture)).toEqual(quiet);
  });

  it("keeps an account failure off the health ledger and out of Lead's inbox", async () => {
    const fixture = lookupFixture("plc-lookup-purpose-auth-");
    await replay(fixture, [
      { type: "run.started", runtime: "pi", model: null },
      { type: "run.failed", exitCode: null, errorCode: "llm_error", error: "No API key found for anthropic." },
    ]);
    expect(getRun(fixture.db, fixture.runId)).toMatchObject({ state: "failed", failure_scope: "account" });
    expect(sideEffects(fixture)).toEqual(quiet);
  });

  it("does not raise an LLM-error blocker when the turn ends with an error message", async () => {
    const fixture = lookupFixture("plc-lookup-purpose-llm-");
    await replay(fixture, [
      { type: "run.started", runtime: "pi", model: null },
      { type: "message.completed", messageId: "m1", role: "assistant", text: "", stopReason: "error" },
      { type: "run.completed", exitCode: 0 },
    ]);
    expect(sideEffects(fixture)).toEqual(quiet);
  });
});

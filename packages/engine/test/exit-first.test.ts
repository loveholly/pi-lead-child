// 工单 07（spec D3）：先提交进程退出，再做登记。
// Seam 1：runItem 加回放型 runtime，跑在真实 SQLite 上。录制是构造的 fixture。
// 登记的某一步抛错，用 SQLite 触发器制造。触发器只拦截那一步要写的行，其余代码照常运行。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { provisionWorkspace } from "../src/coordinator/workspace.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { getWorkspace } from "@pi-lead-child/store";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { assertRunAllowed, executorRetryBudget } from "@pi-lead-child/store";
import { registerOutcomeForRun } from "../src/pipeline/outcome-recovery.js";

const LAST_MESSAGE = "All done. The work is committed on the branch.";

function claudeRun(events: RecordedEvent[]): ReplayRuntime {
  return new ReplayRuntime({ runtime: "claude", events });
}

function completedRun(extra: RecordedEvent[] = []): RecordedEvent[] {
  return [
    { type: "session.updated", externalSessionId: "session-1", runtimeVersion: "test" },
    { type: "run.started", runtime: "claude", model: null },
    ...extra,
    { type: "message.completed", messageId: "m-last", role: "assistant", text: LAST_MESSAGE, stopReason: "stop" },
    { type: "run.completed", exitCode: 0 },
  ];
}

// agent 试过调用 ticket_update，但回执丢了。活跃路径因此可以采用文本里的成果信封。
function ticketUpdateAttempt(): RecordedEvent[] {
  return [
    { type: "tool.started", callId: "tu-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "tu-1", name: "mcp__plc__ticket_update", error: "lost receipt" },
  ];
}

function envelope(validationOutcome: string): string {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary: "Implemented the change",
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm test", outcome: validationOutcome, exitCode: 0, summary: "suite ran", evidenceRef: null,
    }],
  })}`;
}

function setup(prefix: string): { db: Db; dir: string; dbPath: string; itemId: number } {
  const dir = tempDir(prefix);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  return { db, dir, dbPath, itemId };
}

async function settle(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "resolved", (error: unknown) => `rejected: ${String(error)}`);
}

function latestRun(db: Db, itemId: number) {
  return db.prepare("SELECT * FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(itemId) as {
    id: number; state: string; exit_code: number | null; error_code: string | null;
    error_message: string | null; failure_scope: string | null; metadata: string;
  };
}

describe("exit-first run completion (spec D3)", () => {
  it("keeps the run finished with a pending registration when the handoff check throws", async () => {
    const { db, dir, dbPath, itemId } = setup("plc-exit-first-handoff-");
    db.exec(`
      CREATE TRIGGER fail_handoff_check
      BEFORE INSERT ON checkpoints
      WHEN NEW.idempotency_key LIKE 'run-handoff-failed:%'
      BEGIN
        SELECT RAISE(FAIL, 'handoff check exploded');
      END;
    `);

    const settled = await settle(runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it", lingerMs: 0, runtime: claudeRun(completedRun()),
    }));

    // 旧代码把整段收尾放在一笔事务里：交接检查一抛错，退出事实也跟着回滚，
    // Run 被兜底记成 unhandled_run_exception 并判为 failed。
    const run = latestRun(db, itemId);
    expect(run).toMatchObject({
      state: "finished", exit_code: 0, error_code: null, error_message: null, failure_scope: null,
    });
    expect(settled).toBe("resolved");

    // 退出事实已经落库：终止事件和最后一条助手消息的原文。
    const events = db.prepare(
      "SELECT event_type, json_extract(payload, '$.text') AS text FROM runtime_events WHERE run_id=? ORDER BY seq",
    ).all(run.id) as Array<{ event_type: string; text: string | null }>;
    expect(events.at(-1)).toEqual({ event_type: "run.completed", text: null });
    expect(events).toContainEqual({ event_type: "message.completed", text: LAST_MESSAGE });

    // 登记待处理，诊断的作用域是 host。
    expect(JSON.parse(run.metadata).registration).toMatchObject({
      state: "pending",
      step: "handoff_check",
      failure: {
        scope: "host", retry: "never", needs: "code_fix", code: "host_registration_failed",
        evidence: expect.stringContaining("handoff check exploded"),
      },
    });
    const blockers = listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload));
    expect(blockers).toEqual([expect.objectContaining({
      kind: "registration_pending", blockerCode: "registration_pending", runId: run.id, intervention: "propose",
    })]);
    expect(blockers[0].summary).not.toMatch(/\s+at\s+/);

    // 宿主故障不扣工单额度。工单停在 blocked，同一缺陷不能再派发。
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .toThrow(/同一宿主缺陷/);
    expect(getRun(db, run.id)?.state).toBe("finished");
  });

  it("stops at the failed outcome step and lets a later registration retract the blocker", async () => {
    const { db, dir, dbPath, itemId } = setup("plc-exit-first-outcome-");
    db.exec(`
      CREATE TRIGGER fail_outcome_store
      BEFORE INSERT ON outcome_snapshots
      BEGIN
        SELECT RAISE(FAIL, 'outcome store exploded');
      END;
    `);

    const settled = await settle(runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it", lingerMs: 0,
      runtime: claudeRun(completedRun([
        ...ticketUpdateAttempt(),
        { type: "message.completed", messageId: "m-env", role: "assistant", text: envelope("passed"), stopReason: "stop" },
      ])),
    }));

    const run = latestRun(db, itemId);
    expect(settled).toBe("resolved");
    expect(run).toMatchObject({ state: "finished", exit_code: 0, error_code: null });
    expect(JSON.parse(run.metadata).registration).toMatchObject({
      state: "pending", step: "outcome_recovery", failure: { scope: "host" },
    });
    // 成果恢复出错以后，交接检查不再执行，所以没有「交接失败」。
    expect(db.prepare(
      "SELECT idempotency_key FROM checkpoints WHERE run_id=? AND kind='blocked' ORDER BY id",
    ).all(run.id)).toEqual([{ idempotency_key: `registration-pending:${run.id}` }]);
    expect(getItem(db, itemId)?.stage).toBe("blocked");

    // 宿主修好以后，登记可以重做，不必重跑 agent。登记成功就撤回 blocker，闸门放行。
    db.exec("DROP TRIGGER fail_outcome_store");
    expect(registerOutcomeForRun(db, { itemId, runId: run.id, authorityRef: "host fixed" })).toMatchObject({
      status: "registered", clearedRegistrationBlocker: true,
    });
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" })).not.toThrow();
    // 登记待处理的标记随之结束，但保留出错的步骤，作为历史事实。
    expect(JSON.parse(getRun(db, run.id)!.metadata).registration).toMatchObject({
      state: "registered", step: "outcome_recovery", failure: { scope: "host" },
    });
  });

  it("registers an outcome with a skipped validation and records the diagnostic", async () => {
    const { db, dir, dbPath, itemId } = setup("plc-exit-first-skipped-");

    const settled = await settle(runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", "item-1"),
      prompt: "do it", lingerMs: 0,
      runtime: claudeRun(completedRun([
        ...ticketUpdateAttempt(),
        { type: "message.completed", messageId: "m-env", role: "assistant", text: envelope("skipped"), stopReason: "stop" },
      ])),
    }));

    const run = latestRun(db, itemId);
    expect(settled).toBe("resolved");
    expect(run).toMatchObject({ state: "finished", exit_code: 0, error_code: null });
    expect(JSON.parse(run.metadata)).not.toHaveProperty("registration");
    const snapshot = db.prepare(
      "SELECT id, validations_json, completeness FROM outcome_snapshots WHERE executor_run_id=?",
    ).get(run.id) as { id: number; validations_json: string; completeness: string };
    expect(JSON.parse(snapshot.validations_json)).toEqual([
      { command: "npm test", outcome: "not_run", exitCode: 0, summary: "suite ran", evidenceRef: null },
    ]);
    expect(snapshot.completeness).toBe("complete");
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);

    const diagnostics = db.prepare(
      `SELECT json_extract(payload, '$.snapshotId') AS snapshotId, json_extract(payload, '$.diagnostics') AS diagnostics
       FROM activities
       WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='outcome_normalized'`,
    ).all(run.id) as Array<{ snapshotId: number; diagnostics: string }>;
    expect(diagnostics.map((row) => ({ ...row, diagnostics: JSON.parse(row.diagnostics) }))).toEqual([{
      snapshotId: snapshot.id,
      diagnostics: [{
        field: "outcome.validations[0].outcome", code: "synonym_mapped",
        received: "skipped", normalized: "not_run", reason: null,
      }],
    }]);
  });

  // AGENTS.md：生命周期改动要有覆盖完整落库流程的集成测试。这里走 dispatcher 的 claim 和结算。
  it("settles the dispatch request and dispatches nothing more while the registration is pending", async () => {
    const { db, dir, dbPath, itemId } = setup("plc-exit-first-dispatch-");
    db.exec(`
      CREATE TRIGGER fail_outcome_store
      BEFORE INSERT ON outcome_snapshots
      BEGIN
        SELECT RAISE(FAIL, 'outcome store exploded');
      END;
    `);
    const recording = completedRun([
      ...ticketUpdateAttempt(),
      { type: "message.completed", messageId: "m-env", role: "assistant", text: envelope("pass"), stopReason: "stop" },
    ]);
    const childErrors: unknown[] = [];
    const orchestrator = createOrchestrator(db, {
      dataDir: dir,
      maxDispatchPerTick: 1,
      onDispatch: async (claim) => {
        await runItem(db, claim.itemId, {
          dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`), prompt: "do it",
          role: claim.role, purpose: claim.purpose, runId: claim.runId, lingerMs: 0,
          runtime: claudeRun(recording), runtimeId: claim.runtime,
        }).catch((error: unknown) => { childErrors.push(error); });
      },
    });

    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "claude",
      trigger: "test", idempotencyKey: "exit-first:dispatch",
    });
    await orchestrator.tick();
    await orchestrator.tick();

    const run = latestRun(db, itemId);
    expect(childErrors).toEqual([]);
    expect(run).toMatchObject({ state: "finished", exit_code: 0, error_code: null, failure_scope: null });
    expect(JSON.parse(run.metadata).registration).toMatchObject({ state: "pending", step: "outcome_recovery" });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=? ORDER BY id").all(itemId))
      .toEqual([{ state: "completed" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 1 });
    expect(getItem(db, itemId)).toMatchObject({ stage: "blocked", plan_state: "none" });
    expect(() => assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" }))
      .toThrow(/同一宿主缺陷/);

    // 宿主修好以后重新登记：快照写入，blocker 撤回，执行结果没有丢。
    db.exec("DROP TRIGGER fail_outcome_store");
    expect(registerOutcomeForRun(db, { itemId, runId: run.id, authorityRef: "host fixed" }).status).toBe("registered");
    expect(JSON.parse((db.prepare("SELECT validations_json FROM outcome_snapshots WHERE executor_run_id=?")
      .get(run.id) as { validations_json: string }).validations_json)[0].outcome).toBe("passed");
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
  });

  it("keeps a reviewer run finished when review automation throws", async () => {
    const dir = tempDir("plc-exit-first-review-");
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "source.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "code", brief: "code", createdBy: "user", workflowKind: "coding", workdir: repo });
    const workspace = provisionWorkspace(db, { itemId, mode: "shared" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    db.exec(`
      CREATE TRIGGER fail_review_automation
      BEFORE INSERT ON review_verdicts
      BEGIN
        SELECT RAISE(FAIL, 'review automation exploded');
      END;
    `);
    const reviewer = claudeRun(completedRun());
    const start = reviewer.start.bind(reviewer);
    reviewer.start = async (request) => {
      createDispatcher(db).submitReviewVerdict({ runId: request.runId, verdict: "pass", evidence: "independent checks" });
      return start(request);
    };

    const settled = await settle(runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "review", role: "reviewer",
      lingerMs: 0, runtime: reviewer,
    }));

    const run = latestRun(db, itemId);
    expect(settled).toBe("resolved");
    expect(run).toMatchObject({ state: "finished", exit_code: 0, error_code: null });
    expect(JSON.parse(run.metadata).registration).toMatchObject({
      state: "pending", step: "review_automation",
      failure: { scope: "host", evidence: expect.stringContaining("review automation exploded") },
    });
    // reviewer 不改变工单的 stage。工作区照常释放，不会一直停在 review_hold。
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(getWorkspace(db, workspace.id)?.state).toBe("idle");
    expect(listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload).blockerCode))
      .toEqual(["registration_pending"]);
  });
});

// 工单 08（spec D3）：daemon 启动时，用当前代码重新登记"已 finished、但登记没有完成"的执行 Run。
// Seam 3：真实 daemon 重启，跑在真实 SQLite 上。宿主缺陷用 SQLite 触发器制造，先例见 exit-first.test.ts。
// 删掉触发器，就是"宿主代码修好了"。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runItem } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { repairDaemonStartupState, startDaemon } from "../src/server.js";
import { recoverOutcomeSnapshot } from "@pi-lead-child/engine";
import { reregisterFinishedRuns } from "@pi-lead-child/engine";
import { recordRegistrationPending, type RegistrationStep } from "@pi-lead-child/engine";
import { addActivity } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import { hostOutcomeRegistrationHalt } from "@pi-lead-child/store";
import type { RunPurpose } from "@pi-lead-child/core";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";

function envelope(options: { partial?: boolean } = {}): string {
  const validations: Array<Record<string, unknown>> = [{
    command: "npm test", outcome: "passed", exitCode: 0, summary: "suite ran", evidenceRef: null,
  }];
  // 一条失败的验证缺了 command，规范化会丢掉它，成果因此是 partial。
  if (options.partial) validations.push({ outcome: "failed", exitCode: 1, summary: "3 tests failed", evidenceRef: null });
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary: "Implemented the change",
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Changed" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations,
  })}`;
}

// agent 试过调用 ticket_update，但回执丢了。活跃路径因此采用文本里的成果信封。
function completedRunWithEnvelope(): RecordedEvent[] {
  return [
    { type: "session.updated", externalSessionId: "session-1", runtimeVersion: "test" },
    { type: "run.started", runtime: "claude", model: null },
    { type: "tool.started", callId: "tu-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "tu-1", name: "mcp__plc__ticket_update", error: "lost receipt" },
    { type: "message.completed", messageId: "m-env", role: "assistant", text: envelope(), stopReason: "stop" },
    { type: "run.completed", exitCode: 0 },
  ];
}

const HOST_DEFECT = `
  CREATE TRIGGER host_defect
  BEFORE INSERT ON outcome_snapshots
  BEGIN
    SELECT RAISE(FAIL, 'outcome store exploded');
  END;
`;

interface Fixture {
  dir: string;
  dbPath: string;
  itemId: number;
  runId: number;
}

// 一次真实的执行：进程正常退出，登记的成果恢复这一步碰上宿主缺陷。
async function runWithFailedRegistration(prefix: string): Promise<Fixture> {
  const dir = tempDir(prefix);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  db.exec(HOST_DEFECT);
  const { runId } = await runItem(db, itemId, {
    dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`), prompt: "do it", lingerMs: 0,
    runtime: new ReplayRuntime({ runtime: "claude", events: completedRunWithEnvelope() }),
  });
  expect(JSON.parse(getRun(db, runId)!.metadata).registration).toMatchObject({
    state: "pending", step: "outcome_recovery",
  });
  expect(getItem(db, itemId)?.stage).toBe("blocked");
  db.close();
  return { dir, dbPath, itemId, runId };
}

function leadSession() {
  return async () => ({
    modelName: "stub/reregistration",
    session: {
      sessionId: "startup-reregistration",
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      dispose: () => {},
    },
  });
}

async function withDaemon<T>(fixture: Fixture, use: (base: string) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({
    dataDir: fixture.dir, dbPath: fixture.dbPath, sessionFactory: leadSession() as any, gatewayPort: 0, log: () => {},
  });
  try {
    return await use(`http://127.0.0.1:${daemon.pairedPort}`);
  } finally {
    await daemon.close();
  }
}

function withDb<T>(fixture: Fixture, use: (db: Db) => T): T {
  const db = openDb(fixture.dbPath);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

async function redeem(base: string, code: string): Promise<string> {
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { access_token: string }).access_token;
}

// 用户实际看到的那一跳：工单摘要和通知列表都从 gateway 的 HTTP 接口读。
async function userView(base: string, token: string, itemId: number) {
  const headers = { authorization: `Bearer ${token}` };
  const tickets = await fetch(`${base}/v1/tickets`, { headers });
  expect(tickets.status).toBe(200);
  const ticket = (await tickets.json() as {
    items: Array<{ id: number; status: string; attention: { blockerCount: number } }>;
  }).items.find((row) => row.id === itemId)!;
  const notices = await fetch(`${base}/v1/notifications`, { headers });
  expect(notices.status).toBe(200);
  const { items } = await notices.json() as { items: Array<{ ticketId: number | null; kind: string }> };
  return {
    status: ticket.status,
    blockerCount: ticket.attention.blockerCount,
    notices: items.filter((notice) => notice.ticketId === itemId).map((notice) => notice.kind),
  };
}

// 幂等的判据：用户或 lead 能看到的事实，第二次启动后一条都不多。
function ledgerCounts(db: Db) {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    snapshots: count("SELECT COUNT(*) AS n FROM outcome_snapshots"),
    checkpoints: count("SELECT COUNT(*) AS n FROM checkpoints"),
    inbox: count("SELECT COUNT(*) AS n FROM inbox"),
    notifications: count("SELECT COUNT(*) AS n FROM notifications"),
    activities: count("SELECT COUNT(*) AS n FROM activities"),
    gatewayEvents: count("SELECT COUNT(*) AS n FROM gateway_events"),
  };
}

describe("startup re-registration (spec D3, Seam 3)", () => {
  it("registers the outcome after the host is fixed and the daemon restarts, and does it only once", async () => {
    const fixture = await runWithFailedRegistration("plc-reregister-flow-");
    const { itemId, runId } = fixture;
    const pairing = withDb(fixture, (db) => {
      db.exec("DROP TRIGGER host_defect");
      return createPairing(db, { name: "viewer", kind: "companion", scopes: ["tickets:view", "notices"] });
    });

    // 旧代码在启动时只补上快照，并撤回 blocker。工单却一直停在 blocked。
    // 随后，启动时的 blocker 补发又把同一张检查点升成一条新的 blocker。
    const token = await withDaemon(fixture, async (base) => {
      const token = await redeem(base, pairing.code);
      expect(await userView(base, token, itemId)).toEqual({ status: "review", blockerCount: 0, notices: [] });
      return token;
    });

    const afterFirstStart = withDb(fixture, (db) => {
      expect(db.prepare(
        "SELECT source, summary, completeness FROM outcome_snapshots WHERE executor_run_id=?",
      ).get(runId)).toEqual({ source: "system_recovered", summary: "Implemented the change", completeness: "complete" });
      expect(JSON.parse(getRun(db, runId)!.metadata).registration).toMatchObject({
        state: "registered", step: "outcome_recovery", failure: { scope: "host" },
      });
      expect(hostOutcomeRegistrationHalt(db, itemId)).toBeNull();
      // 登记待处理的检查点是历史事实，保留下来。
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
      ).get(`registration-pending:${runId}`)).toEqual({ n: 1 });
      // stage 只按现有规则推进：先撤销登记待处理造成的 blocked，再按成果把 active 推进到 review。
      expect(db.prepare(
        `SELECT json_extract(payload, '$.from') AS "from", json_extract(payload, '$.to') AS "to"
         FROM activities WHERE item_id=? AND kind='transition' ORDER BY id`,
      ).all(itemId)).toEqual([
        { from: "ready", to: "active" },
        { from: "active", to: "blocked" },
        { from: "blocked", to: "active" },
        { from: "active", to: "review" },
      ]);
      return ledgerCounts(db);
    });

    await withDaemon(fixture, async (base) => {
      expect(await userView(base, token, itemId)).toEqual({ status: "review", blockerCount: 0, notices: [] });
    });
    withDb(fixture, (db) => {
      expect(ledgerCounts(db)).toEqual(afterFirstStart);
      expect(getItem(db, itemId)?.stage).toBe("review");
    });
  }, 30_000);

  it("keeps the run pending across a restart while the host is still broken, then registers it", async () => {
    const fixture = await runWithFailedRegistration("plc-reregister-broken-");
    const { itemId, runId } = fixture;
    const pairing = withDb(fixture, (db) =>
      createPairing(db, { name: "viewer", kind: "companion", scopes: ["tickets:view", "notices"] }));
    const logs: string[] = [];

    // 宿主还没修好：重新登记失败，但 daemon 照常启动，Run 原样保留。
    const daemon = await startDaemon({
      dataDir: fixture.dir, dbPath: fixture.dbPath, sessionFactory: leadSession() as any, gatewayPort: 0,
      log: (line) => { logs.push(line); },
    });
    const token = await redeem(`http://127.0.0.1:${daemon.pairedPort}`, pairing.code);
    await daemon.close();
    expect(logs.join("\n")).toContain("reregistrationErrors=1");
    withDb(fixture, (db) => {
      expect(JSON.parse(getRun(db, runId)!.metadata).registration).toMatchObject({ state: "pending" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots").get()).toEqual({ n: 0 });
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      db.exec("DROP TRIGGER host_defect");
    });

    // 修好以后再启动：成果登记，这个 Run 的登记 blocker 全部撤回，包括上次启动补发的那一条。
    await withDaemon(fixture, async (base) => {
      expect(await userView(base, token, itemId)).toEqual({ status: "review", blockerCount: 0, notices: [] });
    });
  }, 30_000);
});

// ——— 决策边界：哪些 Run 是候选，以及重新登记什么时候推进 stage ———
// 落库状态用 07 的 recordRegistrationPending 构造。Run 的事件直接写进 runtime_events。

describe("startup re-registration decision boundaries", () => {
  let db: Db;
  const at = new Date("2026-10-10T12:00:00.000Z");

  beforeEach(() => {
    db = openDb(join(tempDir("plc-reregister-unit-"), "plc.db"));
  });

  function event(runId: number, type: string, fields: Record<string, unknown>) {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runtime_events WHERE run_id=?")
      .get(runId) as { seq: number }).seq;
    db.prepare(
      "INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, seq, type, JSON.stringify({ type, runId, seq, occurredAt: at.toISOString(), ...fields }), at.toISOString());
  }

  interface RunShape {
    purpose?: RunPurpose;
    ticketUpdate?: boolean;
    outcome?: "complete" | "partial" | null;
    llmError?: boolean;
  }

  // 一个刚结束的执行 Run。缺省：试过 ticket_update，文本里有完整的成果信封。
  function finishedRun(shape: RunShape = {}): { itemId: number; runId: number } {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const runId = createRun(db, { itemId, runtime: "claude", purpose: shape.purpose });
    if (shape.ticketUpdate ?? true) {
      event(runId, "tool.started", { callId: "tu", name: "mcp__plc__ticket_update", args: {} });
      event(runId, "tool.failed", { callId: "tu", name: "mcp__plc__ticket_update", error: "lost receipt" });
    }
    if (shape.llmError) {
      event(runId, "message.completed", { messageId: "m-err", role: "assistant", text: "", stopReason: "error" });
    }
    const outcome = shape.outcome === undefined ? "complete" : shape.outcome;
    if (outcome) {
      event(runId, "message.completed", {
        messageId: "m-env", role: "assistant", text: envelope({ partial: outcome === "partial" }), stopReason: "stop",
      });
    }
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    return { itemId, runId };
  }

  function pending(run: { itemId: number; runId: number }, step: RegistrationStep = "outcome_recovery") {
    expect(recordRegistrationPending(db, { ...run, step, error: new Error("host defect"), at })).toBe(true);
    return run;
  }

  function registration(runId: number) {
    return JSON.parse(getRun(db, runId)!.metadata).registration as { state: string } | undefined;
  }

  function blockers(itemId: number): string[] {
    return (db.prepare(
      "SELECT payload FROM inbox WHERE item_id=? AND severity='blocker' ORDER BY id",
    ).all(itemId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload).blockerCode as string);
  }

  function userFacing() {
    return {
      inbox: db.prepare("SELECT id FROM inbox WHERE severity='blocker' ORDER BY id").all(),
      notifications: db.prepare("SELECT id FROM notifications ORDER BY id").all(),
    };
  }

  function snapshots(runId: number): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM outcome_snapshots WHERE executor_run_id=?").get(runId) as { n: number }).n;
  }

  describe("stage advance", () => {
    it("lifts a blocked stage that this registration set, then moves the item to review", () => {
      const { itemId, runId } = pending(finishedRun());

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([
        { status: "registered", runId, fromStep: "outcome_recovery" },
      ]);
      expect(getItem(db, itemId)?.stage).toBe("review");
      expect(registration(runId)).toMatchObject({ state: "registered" });
      expect(blockers(itemId)).toEqual([]);
      expect(snapshots(runId)).toBe(1);
    });

    it("keeps the registration pending when the outcome is partial", () => {
      const { itemId, runId } = pending(finishedRun({ outcome: "partial" }));
      const before = userFacing();

      // 现有规则：partial 成果不进 review，交接检查会升起「交接失败」。重新登记不新增 blocker。
      expect(reregisterFinishedRuns(db, { at }).results).toEqual([
        { status: "kept", runId, reason: "needs_new_blocker" },
      ]);
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      expect(registration(runId)).toMatchObject({ state: "pending" });
      expect(snapshots(runId)).toBe(0);
      expect(userFacing()).toEqual(before);
      expect(blockers(itemId)).toEqual(["registration_pending"]);
    });

    it("keeps the registration pending when the run ended with an LLM error", () => {
      const { itemId, runId } = pending(finishedRun({ llmError: true }), "ingest");

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([{ status: "kept", runId, reason: "llm_error" }]);
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      expect(registration(runId)).toMatchObject({ state: "pending" });
    });

    it("does not lift a blocked stage that a later transition set", () => {
      const { itemId, runId } = pending(finishedRun());
      transition(db, { itemId, to: "active", actor: "user", reason: "user unblocked" });
      transition(db, { itemId, to: "blocked", actor: "system", reason: "another reason" });

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([{ status: "kept", runId, reason: "still_blocked" }]);
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      expect(registration(runId)).toMatchObject({ state: "pending" });
      expect(snapshots(runId)).toBe(0);
    });

    // 旧代码里这个 Run 一直卡着：它已经有快照，启动时的成果修复不看它，blocker 一直不撤回。
    it("finishes the registration of a run that already reached review", () => {
      const run = finishedRun();
      expect(recoverOutcomeSnapshot(db, { ...run, at }).transitionedToReview).toBe(true);
      const { itemId, runId } = pending(run, "ingest");
      expect(blockers(itemId)).toEqual(["registration_pending"]);

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([{ status: "registered", runId, fromStep: "ingest" }]);
      expect(getItem(db, itemId)?.stage).toBe("review");
      expect(registration(runId)).toMatchObject({ state: "registered" });
      expect(blockers(itemId)).toEqual([]);
      expect(hostOutcomeRegistrationHalt(db, itemId)).toBeNull();
    });

    // 活跃路径只采用"试过 ticket_update"的文本信封。启动时的成果修复对所有 Run 都采用文本信封。
    // 它不能绕过重新登记，把成果补上却把工单留在 blocked。
    it("keeps the registration blocker when the existing rules cannot register the run", () => {
      const { itemId, runId } = pending(finishedRun({ ticketUpdate: false }));

      expect(repairDaemonStartupState(db, at)).toMatchObject({ reregistered: 0, outcomes: 0, handoffs: 0 });
      expect(getItem(db, itemId)?.stage).toBe("blocked");
      expect(registration(runId)).toMatchObject({ state: "pending" });
      expect(snapshots(runId)).toBe(0);
      expect(blockers(itemId)).toEqual(["registration_pending"]);
    });
  });

  describe("candidates", () => {
    it("registers a run the daemon crashed on before registration, once", () => {
      // 退出事务已提交，登记没有开始：Run 是 finished，没有标记，工单还在 active。
      const { itemId, runId } = finishedRun();

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([{ status: "registered", runId, fromStep: "ingest" }]);
      expect(getItem(db, itemId)?.stage).toBe("review");
      expect(JSON.parse(getRun(db, runId)!.metadata).reregistration).toMatchObject({ state: "registered", fromStep: "ingest" });
      expect(reregisterFinishedRuns(db, { at }).results).toEqual([]);
    });

    // child manager 在登记的各步之后写 attempt_end。用户后来把工单拉回 active，这个 Run 也不是崩溃留下的。
    it("does not take a registered run for a crash when the user moves its item back to active", () => {
      const { itemId, runId } = finishedRun({ outcome: null });
      transition(db, { itemId, to: "blocked", actor: "system", reason: "run ended without terminal handoff", runId });
      addActivity(db, { itemId, runId, actor: "system", kind: "attempt_end", payload: { finalItemStage: "blocked" } });
      transition(db, { itemId, to: "active", actor: "user", reason: "user unblocked" });

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([]);
      expect(getItem(db, itemId)?.stage).toBe("active");
      expect(JSON.parse(getRun(db, runId)!.metadata)).not.toHaveProperty("reregistration");
    });

    it("does not let the runs it keeps take every slot under the limit", () => {
      const first = pending(finishedRun({ outcome: "partial" }));
      const second = pending(finishedRun({ outcome: "partial" }));
      const registrable = pending(finishedRun());

      expect(reregisterFinishedRuns(db, { at, limit: 1 }).results)
        .toEqual([{ status: "kept", runId: first.runId, reason: "needs_new_blocker" }]);
      expect(reregisterFinishedRuns(db, { at: new Date(at.getTime() + 1_000), limit: 1 }).results)
        .toEqual([{ status: "kept", runId: second.runId, reason: "needs_new_blocker" }]);
      expect(reregisterFinishedRuns(db, { at: new Date(at.getTime() + 2_000), limit: 1 }).results)
        .toEqual([{ status: "registered", runId: registrable.runId, fromStep: "outcome_recovery" }]);
      expect(reregisterFinishedRuns(db, { at: new Date(at.getTime() + 3_000), limit: 1 }).results)
        .toEqual([{ status: "kept", runId: first.runId, reason: "needs_new_blocker" }]);
    });

    it("leaves pre-rollout, superseded, terminal and conversation runs alone", () => {
      const preRollout = pending(finishedRun());
      db.prepare("UPDATE runs SET ended_at='2026-01-01 00:00:00' WHERE id=?").run(preRollout.runId);
      const superseded = finishedRun();
      createRun(db, { itemId: superseded.itemId, runtime: "claude" });
      pending(superseded);
      const done = pending(finishedRun());
      db.prepare("UPDATE items SET stage='done' WHERE id=?").run(done.itemId);
      const cancelled = pending(finishedRun());
      db.prepare("UPDATE items SET stage='cancelled' WHERE id=?").run(cancelled.itemId);
      const conversation = pending(finishedRun({ purpose: "conversation" }));
      const before = db.prepare("SELECT id, stage, stage_changed_at FROM items ORDER BY id").all();
      const facts = userFacing();

      expect(reregisterFinishedRuns(db, { at }).results).toEqual([]);
      expect(db.prepare("SELECT id, stage, stage_changed_at FROM items ORDER BY id").all()).toEqual(before);
      expect(userFacing()).toEqual(facts);
      for (const run of [preRollout, superseded, done, cancelled, conversation]) {
        expect(registration(run.runId)).toMatchObject({ state: "pending" });
        expect(snapshots(run.runId)).toBe(0);
      }
    });

    it("handles at most the limit per start and the rest on the next start", () => {
      const runs = [pending(finishedRun()), pending(finishedRun()), pending(finishedRun())];

      expect(reregisterFinishedRuns(db, { at, limit: 2 }).results.map((result) => result.runId))
        .toEqual([runs[0]!.runId, runs[1]!.runId]);
      expect(registration(runs[2]!.runId)).toMatchObject({ state: "pending" });
      expect(reregisterFinishedRuns(db, { at, limit: 2 }).results).toEqual([
        { status: "registered", runId: runs[2]!.runId, fromStep: "outcome_recovery" },
      ]);
    });

    it("keeps a host error inside its own run", () => {
      const broken = pending(finishedRun());
      const fine = pending(finishedRun());
      db.exec(`
        CREATE TRIGGER host_defect_for_one_run
        BEFORE INSERT ON outcome_snapshots
        WHEN NEW.executor_run_id = ${broken.runId}
        BEGIN
          SELECT RAISE(FAIL, 'outcome store exploded');
        END;
      `);

      const summary = reregisterFinishedRuns(db, { at });
      expect(summary).toMatchObject({ registered: 1, kept: 0, errors: 1 });
      expect(summary.results[0]).toMatchObject({ status: "error", runId: broken.runId, error: "outcome store exploded" });
      expect(getItem(db, broken.itemId)?.stage).toBe("blocked");
      expect(registration(broken.runId)).toMatchObject({ state: "pending" });
      expect(getItem(db, fine.itemId)?.stage).toBe("review");
    });

    it("never raises a blocker or a notification, whatever the runs look like", () => {
      pending(finishedRun({ outcome: "partial" }));
      pending(finishedRun({ outcome: null }));
      pending(finishedRun({ llmError: true }), "ingest");
      finishedRun({ outcome: null });
      finishedRun({ ticketUpdate: false });
      const facts = userFacing();

      const first = reregisterFinishedRuns(db, { at });
      expect(first).toMatchObject({ registered: 0, kept: 5, errors: 0 });
      expect(userFacing()).toEqual(facts);
      expect(reregisterFinishedRuns(db, { at }).results).toEqual(first.results);
      expect(userFacing()).toEqual(facts);
    });
  });
});

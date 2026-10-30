import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { createRun, markRunStopped, transition, updateRun } from "@pi-lead-child/store";
import { executorRetryBudget, getItem } from "@pi-lead-child/store";
import { CodexRuntime } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { liveChildren, runItem } from "../src/children/manager.js";
import { createWatchdog } from "../src/pipeline/watchdog.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-dispatch-"), "plc.db"));
});

function sealedPlan(maxConcurrency = 4) {
  const coordinator = createCoordinator({ db });
  const root = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system" });
  db.prepare("UPDATE items SET max_concurrency=? WHERE id=?").run(maxConcurrency, root);
  const run = createRun(db, { itemId: root });
  updateRun(db, run, { state: "running" });
  const revision = coordinator.beginPlanning({ itemId: root, runId: run });
  const plan = coordinator.createWorkPlan({ itemId: root, runId: run, revision }, {
    items: [
      { key: "a", title: "A", brief: "b" },
      { key: "b", title: "B", brief: "b" },
      { key: "c", title: "C", brief: "b", dependsOn: ["a", "b"] },
    ],
  });
  coordinator.finishPlanning({ itemId: root, runId: run, revision });
  return { root, byKey: plan.byKey };
}

describe("durable dispatch claims", () => {
  // 2026-10-15：不再把 gpt-5.6-sol 改写成 gpt-5.5（账号已经不支持 gpt-5.5）。只去掉 provider 前缀。
  it("stores Codex models in their runtime-native form", () => {
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({ title: "task", brief: "b", createdBy: "system" });
    const dispatcher = createDispatcher(db);

    const requestId = dispatcher.request({
      itemId,
      role: "executor",
      purpose: "execution",
      runtime: "codex",
      model: "openai/gpt-5.6-sol",
      trigger: "test",
      idempotencyKey: "native-codex-model",
    });

    expect(db.prepare("SELECT runtime, model FROM dispatch_requests WHERE id=?").get(requestId))
      .toEqual({ runtime: "codex", model: "gpt-5.6-sol" });
  });

  it("claims parallel leaves once and waits for serial dependencies", () => {
    const ids = sealedPlan();
    const dispatcher = createDispatcher(db, { leaseMs: 60_000, now: () => new Date("2026-07-23T12:00:00Z") });
    const first = dispatcher.claimNext();
    const second = dispatcher.claimNext();
    expect(new Set([first?.itemId, second?.itemId])).toEqual(new Set([ids.byKey.a, ids.byKey.b]));
    expect(dispatcher.claimNext()).toBeNull();

    for (const claim of [first!, second!]) {
      updateRun(db, claim.runId, { state: "finished", endedAt: true });
      db.prepare("UPDATE items SET stage='done' WHERE id=?").run(claim.itemId);
      dispatcher.completeRun(claim.runId);
    }
    expect(dispatcher.claimNext()?.itemId).toBe(ids.byKey.c);
  });

  it("keeps a started run running after its startup lease expires", () => {
    sealedPlan(1);
    let now = new Date("2026-07-23T12:00:00Z");
    const dispatcher = createDispatcher(db, { leaseMs: 1000, now: () => now });
    const claim = dispatcher.claimNext()!;

    dispatcher.markStarted(claim);
    updateRun(db, claim.runId, { state: "running" });
    now = new Date("2026-07-23T12:00:02Z");

    expect(dispatcher.reclaimExpired()).toBe(0);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(claim.runId)).toEqual({ state: "running" });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(claim.requestId)).toEqual({ state: "started" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_claims WHERE run_id=?").get(claim.runId)).toEqual({ n: 1 });
    expect(dispatcher.claimNext()).toBeNull();

    updateRun(db, claim.runId, { state: "finished", endedAt: true });
    dispatcher.completeRun(claim.runId);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(claim.requestId)).toEqual({ state: "completed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_claims WHERE run_id=?").get(claim.runId)).toEqual({ n: 0 });
  });

  it("reclaims an expired starting claim that was never marked started", () => {
    sealedPlan(1);
    let now = new Date("2026-07-23T12:00:00Z");
    const dispatcher = createDispatcher(db, { leaseMs: 1000, now: () => now });
    const claim = dispatcher.claimNext()!;
    expect(dispatcher.claimNext()).toBeNull();
    const beforeReclaimSeq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM gateway_events")
      .get() as { seq: number }).seq;
    now = new Date("2026-07-23T12:00:02Z");
    dispatcher.reclaimExpired();
    const retry = dispatcher.claimNext();
    expect(retry?.itemId).toBe(claim.itemId);
    expect(retry?.runId).not.toBe(claim.runId);
    expect(db.prepare(
      "SELECT kind, idempotency_key FROM checkpoints WHERE run_id IN (?, ?) ORDER BY id",
    ).all(claim.runId, retry!.runId)).toEqual([
      { kind: "blocked", idempotency_key: `run-crash:${claim.runId}` },
      { kind: "progress", idempotency_key: `run-recovered:${claim.runId}:${retry!.runId}` },
    ]);
    expect(db.prepare(
      "SELECT kind FROM activities WHERE run_id=? ORDER BY id",
    ).all(claim.runId)).toEqual([
      { kind: "crash" },
      { kind: "notification" },
    ]);
    expect(db.prepare(
      "SELECT event_type FROM gateway_events WHERE item_id=? AND seq>? ORDER BY seq",
    ).all(claim.itemId, beforeReclaimSeq)).toEqual([
      { event_type: "attempt.updated" },
      { event_type: "ticket.updated" },
      { event_type: "ticket.updated" },
    ]);
  });

  it("rejects a stale lease owner after an expired claim is replaced", () => {
    sealedPlan(1);
    let now = new Date("2026-07-23T12:00:00Z");
    const dispatcher = createDispatcher(db, { leaseMs: 1000, now: () => now });
    const stale = dispatcher.claimNext()!;

    now = new Date("2026-07-23T12:00:02Z");
    expect(dispatcher.reclaimExpired()).toBe(1);
    const replacement = dispatcher.claimNext()!;

    expect(replacement.requestId).toBe(stale.requestId);
    expect(replacement.runId).not.toBe(stale.runId);
    // 租约过期是宿主中断了这次尝试（spec D1：attempt），请求已经交回队列，不扣工单的重试额度。
    expect(db.prepare("SELECT failure_scope, failure_retry, failure_code FROM runs WHERE id=?").get(stale.runId))
      .toEqual({ failure_scope: "attempt", failure_retry: "resume", failure_code: "run_interrupted" });
    expect(replacement.leaseToken).not.toBe(stale.leaseToken);
    expect(() => dispatcher.markStarted(stale)).toThrow("stale or expired dispatch claim");
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(replacement.requestId)).toEqual({ state: "claimed" });

    dispatcher.markStarted(replacement);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(replacement.requestId)).toEqual({ state: "started" });
  });
});

// 一条被 run gate 拒绝的请求不能停住整个派发循环。tick() 只 catch 了 onDispatch，
// claimNext 里的 createRun 一旦抛错，排在后面的工单就都派不出去。
// 工单 07 让"登记待处理"也触发宿主缺陷闸门，所以这种情况更常见了。
describe("dispatch past a refused request", () => {
  it("keeps the refused request pending with a reason and dispatches the next item", async () => {
    const halted = createItem(db, { title: "halted", brief: "b", createdBy: "system" });
    const failedRun = createRun(db, { itemId: halted, runtime: "claude" });
    updateRun(db, failedRun, {
      state: "failed", endedAt: true, errorCode: "unhandled_run_exception",
      errorMessage: "Error: outcome.validations[3].outcome is invalid\n    at normalizeValidations (src/store/outcomes.ts:211:48)",
    });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(halted);
    const healthy = createItem(db, { title: "healthy", brief: "b", createdBy: "system" });
    const dispatched: number[] = [];
    const orchestrator = createOrchestrator(db, {
      maxDispatchPerTick: 4,
      onDispatch: (claim) => { dispatched.push(claim.itemId); },
    });
    for (const itemId of [halted, healthy]) {
      orchestrator.dispatcher.request({
        itemId, role: "executor", purpose: "execution", runtime: "codex",
        trigger: "test", idempotencyKey: `request:${itemId}`,
      });
    }

    await expect(orchestrator.tick()).resolves.toEqual({ dispatched: 1 });
    expect(dispatched).toEqual([healthy]);
    expect(db.prepare("SELECT state, suspended_reason FROM dispatch_requests WHERE item_id=?").get(halted))
      .toEqual({ state: "pending", suspended_reason: expect.stringContaining("成果登记失败") });
    // 原因只在变化时写一次：再 tick 一次不会重复记活动。
    await orchestrator.tick();
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='dispatch_refused_by_run_gate'`,
    ).get(halted)).toEqual({ n: 1 });
  });
});

// 发布评审 run-resume F1：认领的 Run 在启动时被 runItem 拒绝（例如同一张工单上还有一个 Run 在收尾），
// manager 把它记成 stopped（run_start_refused）。以前编排器把这条请求当成跑完了：记成 failed，这件事就丢了；
// reviewer 的请求还把这次没启动的 Run 算进重试次数。现在请求退避一段时间后回到队列，不算失败。
describe("a claimed run whose start was refused", () => {
  const refuse = (claim: { runId: number }) => {
    markRunStopped(db, claim.runId, { errorCode: "run_start_refused", errorMessage: "item already has a live runtime" });
  };

  it("puts an executor request back in the queue after a backoff instead of losing it", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    let now = new Date("2026-10-16T10:00:00.000Z");
    const orchestrator = createOrchestrator(db, { now: () => now, onDispatch: refuse });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "refused-exec",
    });

    await orchestrator.tick();
    await orchestrator.tick();
    const row = db.prepare("SELECT state, not_before FROM dispatch_requests WHERE id=?").get(requestId) as
      { state: string; not_before: string | null };
    expect(row.state).toBe("pending");
    expect(Date.parse(row.not_before!)).toBeGreaterThan(now.getTime());
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_claims").get()).toEqual({ n: 0 });

    // 退避期间不再认领；过了退避时间再派一次。
    const runsBefore = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId) as { n: number }).n;
    await orchestrator.tick();
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId) as { n: number }).n).toBe(runsBefore);
    now = new Date(Date.parse(row.not_before!) + 1_000);
    await orchestrator.tick();
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId) as { n: number }).n).toBe(runsBefore + 1);
  });

  it("does not count a refused reviewer start against the reviewer retry limit", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const delivery = createRun(db, { itemId });
    updateRun(db, delivery, { state: "finished", endedAt: true });
    transition(db, { itemId, to: "review", actor: "child", reason: "" });
    db.prepare("UPDATE items SET retry_limit=0 WHERE id=?").run(itemId);
    const orchestrator = createOrchestrator(db, { onDispatch: refuse });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger: "test", idempotencyKey: "refused-review",
    });

    await orchestrator.tick();
    await orchestrator.tick();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE summary LIKE '%reviewer 重试已耗尽%'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE trigger='reviewer-retry'").get()).toEqual({ n: 0 });
  });

  // 发布评审 reliability-backlog：没启动成的 Run 不是一次新的尝试。以前它被当成「之后又跑过的 Run」，
  // 把自己的健康重试作废；修复回合被拒一次就算用掉了额度，下一拍请求被当成过时取消。
  const runsOf = (itemId: number) =>
    (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId) as { n: number }).n;

  it("keeps a runtime-health retry whose own start was refused, and dispatches it after the backoff", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const failed = createRun(db, { itemId });
    updateRun(db, failed, { state: "failed", endedAt: true });
    let now = new Date("2026-10-16T10:00:00.000Z");
    const orchestrator = createOrchestrator(db, { now: () => now, onDispatch: refuse });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", retryOfRunId: failed,
      trigger: "runtime-health-retry", idempotencyKey: "refused-health-retry",
    });

    await orchestrator.tick();
    await orchestrator.tick();
    const row = db.prepare("SELECT state, not_before FROM dispatch_requests WHERE id=?").get(requestId) as
      { state: string; not_before: string };
    expect(row.state).toBe("pending");
    const runsBefore = runsOf(itemId);
    now = new Date(Date.parse(row.not_before) + 1_000);
    await orchestrator.tick();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "started" });
    expect(runsOf(itemId)).toBe(runsBefore + 1);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE json_extract(payload, '$.decision')='runtime_health_retry_superseded'",
    ).get()).toEqual({ n: 0 });
  });

  it("does not spend the outcome repair budget on a repair run whose start was refused", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    transition(db, { itemId, to: "active", actor: "system", reason: "" });
    const source = createRun(db, { itemId });
    updateRun(db, source, { state: "finished", endedAt: true });
    let now = new Date("2026-10-16T10:00:00.000Z");
    const orchestrator = createOrchestrator(db, { now: () => now, onDispatch: refuse });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "outcome_repair", runtime: "codex", resumeFromRunId: source,
      trigger: "outcome-repair", idempotencyKey: "refused-repair",
    });

    await orchestrator.tick();
    await orchestrator.tick();
    const row = db.prepare("SELECT state, not_before FROM dispatch_requests WHERE id=?").get(requestId) as
      { state: string; not_before: string };
    expect(row.state).toBe("pending");
    const runsBefore = runsOf(itemId);
    now = new Date(Date.parse(row.not_before) + 1_000);
    await orchestrator.tick();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "started" });
    expect(runsOf(itemId)).toBe(runsBefore + 1);
  });

  it("stops requeueing after repeated refusals and raises a blocker for Lead", async () => {
    vi.stubEnv("PLC_DISPATCH_REFUSED_START_LIMIT", "3");
    try {
      const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
      let now = new Date("2026-10-16T10:00:00.000Z");
      const orchestrator = createOrchestrator(db, { now: () => now, onDispatch: refuse });
      const requestId = orchestrator.dispatcher.request({
        itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "refused-forever",
      });

      for (let i = 0; i < 6; i += 1) {
        await orchestrator.tick();
        now = new Date(now.getTime() + 60 * 60_000);
      }
      expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "failed" });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE item_id=? AND error_code='run_start_refused'",
      ).get(itemId)).toEqual({ n: 3 });
      const blockers = db.prepare(
        `SELECT summary, json_extract(payload, '$.blockerCode') AS code, json_extract(payload, '$.dispatchRequestId') AS requestId,
                json_extract(payload, '$.needsUser') AS needsUser
         FROM inbox WHERE item_id=? AND severity='blocker'`,
      ).all(itemId);
      expect(blockers).toEqual([
        { summary: expect.stringContaining("连续 3 次没有启动"), code: "dispatch_start_refused", requestId, needsUser: 0 },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// 认领不看 live 表：同一张工单上一个 Run 在收尾（库里已经 finished，进程还在退出）时，派发器照样认领、建 Run，
// 启动时撞上，被当成一次派发失败或者拒绝启动。现在工单还被占着时不认领，等它空出来。
describe("claiming while the ticket is still busy", () => {
  it("does not claim a request while a run of the ticket is still live, and claims it once it is free", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    const finishing = createRun(db, { itemId });
    updateRun(db, finishing, { state: "finished", endedAt: true });
    let busy = true;
    const dispatched: number[] = [];
    const orchestrator = createOrchestrator(db, {
      itemBusy: (id: number) => busy && id === itemId,
      onDispatch: (claim) => { dispatched.push(claim.runId); },
    });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "busy-item",
    });

    await orchestrator.tick();
    expect(dispatched).toEqual([]);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 1 });

    busy = false;
    await orchestrator.tick();
    expect(dispatched).toHaveLength(1);
  });

  // 发布评审 reliability-backlog：跳过不写库，也不记日志，看不出请求为什么一直不派。现在记一行，每张工单一分钟最多一行。
  it("logs that it skipped a busy ticket, at most once a minute per ticket", async () => {
    const itemId = createItem(db, { title: "task", brief: "b", createdBy: "system" });
    const other = createItem(db, { title: "other", brief: "b", createdBy: "system" });
    let now = new Date("2026-10-16T10:00:00.000Z");
    const logs: string[] = [];
    const orchestrator = createOrchestrator(db, {
      now: () => now, itemBusy: () => true, onDispatch: () => {}, log: (line: string) => { logs.push(line); },
    });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "busy-log",
    });
    orchestrator.dispatcher.request({
      itemId: other, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "busy-log-other",
    });

    await orchestrator.tick();
    await orchestrator.tick();
    expect(logs.filter((line) => line.includes(`ticket #${itemId} `))).toEqual([
      `[dispatch] ticket #${itemId} still has a live run; request #${requestId} waits`,
    ]);
    expect(logs.filter((line) => line.includes(`ticket #${other} `))).toHaveLength(1);

    now = new Date(now.getTime() + 61_000);
    await orchestrator.tick();
    expect(logs.filter((line) => line.includes(`ticket #${itemId} `))).toHaveLength(2);
  });
});


// 2026-10-29：Run #185 停在 starting、一条事件都没有，12 分钟没人处理（Lead 手动停掉重跑才好）。
// 完整的落库流程：编排器派发、runItem 启动一个不出声的 runtime、启动看门狗停掉它，原来的请求回到队列，
// 编排器再派一次；又卡住时不再派，交给 Lead。
describe("a run that hangs at start", () => {
  // 启动成功，但进程一直不出声：没有 run.started，也没有别的事件。被中断时才退出。
  class SilentRuntime implements AgentRuntime {
    readonly id = "codex" as const;
    readonly capabilities: RuntimeCapabilities = { ...new CodexRuntime().capabilities };
    readonly interrupted: number[] = [];

    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => { exit = resolve; });
      const interrupted = this.interrupted;
      return {
        pid: null,
        events: (async function* () { await exited; })(),
        interrupt: async () => { interrupted.push(request.runId); exit(); },
        wait: async () => {
          await exited;
          return { ok: false, exitCode: null, signal: "SIGTERM", externalSessionId: null, errorCode: null, errorMessage: null };
        },
      };
    }
  }

  it("is stopped and dispatched again once, and goes to Lead when the second start hangs too", async () => {
    const dir = tempDir("plc-start-stall-");
    const dbPath = join(dir, "plc.db");
    const store = openDb(dbPath);
    vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
    const runtime = new SilentRuntime();
    const running: Array<Promise<unknown>> = [];
    const orchestrator = createOrchestrator(store, {
      dataDir: dir,
      onDispatch: (claim) => {
        // 和 daemon 一样不等 runItem 收尾（server.ts 的 spawnClaimedItem）。
        running.push(runItem(store, claim.itemId, {
          dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`), prompt: "do it",
          role: claim.role, purpose: claim.purpose, runId: claim.runId, runtime, model: claim.model ?? undefined, lingerMs: 0,
        }).catch(() => null));
      },
    });
    const itemId = createItem(store, { title: "卡在启动", brief: "b", createdBy: "lead" });
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5", trigger: "test", idempotencyKey: "start-stall",
    });
    // 6 分钟以后的看门狗：超过 5 分钟的阈值。
    const watchdog = createWatchdog(store, { startStallMs: 5 * 60_000, now: () => new Date(Date.now() + 6 * 60_000) });
    const runsOf = () => store.prepare(
      "SELECT state, error_code AS error, failure_code AS code FROM runs WHERE item_id=? ORDER BY id",
    ).all(itemId);
    const stallOnce = async (): Promise<number> => {
      await orchestrator.tick();
      const runId = (store.prepare("SELECT MAX(id) AS id FROM runs WHERE item_id=?").get(itemId) as { id: number }).id;
      await vi.waitFor(() => expect(liveChildren().get(itemId)?.runId).toBe(runId));
      watchdog.check();
      await Promise.all(running.splice(0));
      return runId;
    };

    const first = await stallOnce();
    expect(runtime.interrupted).toEqual([first]);
    expect(runsOf()).toEqual([{ state: "failed", error: "start_stalled", code: "run_interrupted" }]);
    // 原来的请求回到队列，下一轮派发再派它。
    expect(store.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    expect(store.prepare("SELECT COUNT(*) AS n FROM dispatch_claims").get()).toEqual({ n: 0 });
    expect(executorRetryBudget(store, itemId).failures).toBe(0);

    const second = await stallOnce();
    expect(runtime.interrupted).toEqual([first, second]);
    expect(runsOf()).toEqual([
      { state: "failed", error: "start_stalled", code: "run_interrupted" },
      { state: "failed", error: "start_stalled", code: "run_interrupted" },
    ]);
    // 连续两次：不再派，交给 Lead。
    expect(store.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "failed" });
    await orchestrator.tick();
    expect(runsOf()).toHaveLength(2);
    const blockers = store.prepare("SELECT payload FROM inbox WHERE item_id=? AND severity='blocker'").all(itemId)
      .map((row) => JSON.parse((row as { payload: string }).payload) as { needsUser: boolean; runId: number });
    expect(blockers).toEqual([expect.objectContaining({ needsUser: false, runId: second })]);
    expect(getItem(store, itemId)!.stage).toBe("blocked");
    vi.unstubAllEnvs();
    store.close();
  });
});

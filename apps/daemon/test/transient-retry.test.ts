// 工单 06（spec D5）：瞬时失败由内核退避，然后 resume 同一个外部 session。
// 基线（提交 1b33184）：断网失败落成 attempt / backoff，不扣额度，但升起一条 blocker，工单进入 blocked。
// 没有任何东西自动重试，要等用户稍后重试这张工单。历史上 run 64 干了 28 分钟后断网，整个 Run 就停在这里。
// Seam 1：orchestrator 的派发加 runItem，跑在真实 SQLite 上。派发走 daemon 的真实入口 spawnClaimedItem，
// 所以 resume 的外部 session 是生产代码从派发请求里读出来的。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { recoverOrphans } from "../src/server.js";
import { spawnClaimedItem, runningChildren, type LeadDeps } from "@pi-lead-child/lead";
import { createOrchestrator } from "@pi-lead-child/engine";
import { transientRetryConfig, transientRetryDelayMs } from "@pi-lead-child/engine";
import { CodexRuntime } from "@pi-lead-child/runtime";
import {
  failureNextStep, kernelRetriesTransient, typedFailure, type FailureCode,
} from "@pi-lead-child/runtime";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { listInbox, markInbox } from "@pi-lead-child/store";
import { repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { createRun, markRunFailed, updateRun } from "@pi-lead-child/store";
import { listUnhealthyRuntimeTargets } from "@pi-lead-child/store";
import type { RunPurpose } from "@pi-lead-child/core";
import { localIso } from "@pi-lead-child/core";
import { readGatewayNotifications, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedEvent, type RecordedRun } from "@pi-lead-child/runtime/testing";

interface FixtureRun extends RecordedRun {
  historicalRunId: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  model: string | null;
}

const fixture = JSON.parse(
  readFileSync(RUNTIME_FAILURES_FIXTURE, "utf8"),
) as { runs: FixtureRun[] };

const recording = (runId: number): FixtureRun => {
  const found = fixture.runs.find((run) => run.historicalRunId === runId);
  if (!found) throw new Error(`fixture has no run ${runId}`);
  return found;
};

// run 64 的外部 session。它干了 28 分钟后断网。
const SESSION_64 = "01a11b33-cb4e-77e3-a94e-2efdf972d1ab";

// resume 之后正常结束的一轮：agent 接着原来的 session 做完，调用 ticket_update，并留下成果信封。
function resumedAndFinished(session: string): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "session.updated", externalSessionId: session },
    { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
    { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
    {
      type: "message.completed", messageId: "m-done", role: "assistant",
      text: `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Installed the skills", changes: [], deliverables: [], validations: [] })}`,
    },
    { type: "run.completed", exitCode: 0 },
  ];
}

// 每次启动按顺序回放一份录制，并记下启动请求和启动时刻。
class ScriptedCodex implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities: RuntimeCapabilities = { ...new CodexRuntime().capabilities };
  readonly requests: RuntimeStartRequest[] = [];

  constructor(private readonly recordings: RecordedEvent[][]) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "codex", events }).start(request);
  }
}

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-transient-retry-");
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

// 派发环境。时钟可以拨快，用来越过退避时间，而不用真的等。
// reviewer：工单走自动评审，测试派的是一个 reviewer Run，而不是执行 Run。
function harness(recordings: RecordedEvent[][], options: { reviewer?: boolean } = {}) {
  const runtime = new ScriptedCodex(recordings);
  const deps: LeadDeps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir,
    runtimeRegistry: new RuntimeRegistry([runtime]),
  };
  let offsetMs = 0;
  const now = (): Date => new Date(Date.now() + offsetMs);
  const orchestrator = createOrchestrator(db, {
    dataDir: dir,
    now,
    onDispatch: (claim) => { spawnClaimedItem(deps, claim); },
  });
  const itemId = createItem(db, {
    title: "historical item 77", brief: "install the skills", createdBy: "user", runtime: "codex",
    ...(options.reviewer ? { verificationPolicy: "independent_reviewer" as const } : {}),
  });
  if (options.reviewer) {
    transition(db, { itemId, to: "active", actor: "system", reason: "test setup" });
    transition(db, { itemId, to: "review", actor: "child", reason: "test setup" });
  }
  orchestrator.dispatcher.request({
    itemId, role: options.reviewer ? "reviewer" : "executor", purpose: options.reviewer ? "review" : "execution",
    runtime: "codex", model: "gpt-5.5",
    trigger: "test", idempotencyKey: `test-dispatch:${itemId}`,
  });
  // 一轮派发，然后等派出去的 child 全部结束。
  const tick = async (): Promise<void> => {
    await orchestrator.tick();
    await vi.waitFor(() => expect(runningChildren().size).toBe(0));
  };
  const advance = (ms: number): void => { offsetMs += ms; };
  return { runtime, itemId, tick, advance, now };
}

const runsOf = (itemId: number) => db.prepare(
  "SELECT id, state, failure_scope AS scope, failure_code AS code, resumed_from_run_id AS resumedFrom FROM runs WHERE item_id=? ORDER BY id",
).all(itemId) as Array<{ id: number; state: string; scope: string | null; code: string | null; resumedFrom: number | null }>;

// 内核自己排的请求。测试发的那个执行请求不算。
const kernelRequests = (itemId: number) => db.prepare(
  `SELECT id, trigger, state, resume_from_run_id AS resumeFrom FROM dispatch_requests
   WHERE item_id=? AND trigger <> 'test' AND state IN ('pending','claimed','started') ORDER BY id`,
).all(itemId) as Array<{ id: number; trigger: string; state: string; resumeFrom: number | null }>;

describe("a transient failure (regression: run 64 lost 28 minutes of work to a network drop)", () => {
  it("resumes the same external session after the backoff, without the lead and without the retry budget", async () => {
    const { runtime, itemId, tick, advance } = harness([recording(64).events, resumedAndFinished(SESSION_64)]);

    await tick();
    const [failed] = runsOf(itemId);
    expect(failed).toMatchObject({ state: "failed", scope: "attempt", code: "network_error" });
    // 旧代码到这里就停了：一条 blocker，工单进入 blocked，没有任何自动重试的请求。
    expect(kernelRequests(itemId)).toEqual([
      { id: expect.any(Number), trigger: "transient-retry", state: "pending", resumeFrom: failed!.id },
    ]);

    // 越过退避时间。内核自己派出重试，lead 和用户都不需要做任何事。
    advance(60 * 60_000);
    await tick();

    expect(runsOf(itemId)).toEqual([
      expect.objectContaining({ id: failed!.id, state: "failed" }),
      expect.objectContaining({ state: "finished", resumedFrom: failed!.id }),
    ]);
    // 重试 resume 的是 run 64 原来的外部 session，并且在同一个 runtime 和模型上。
    expect(runtime.requests.map((request) => request.resumeSessionId)).toEqual([undefined, SESSION_64]);
    expect(runtime.requests[1]).toMatchObject({ purpose: "execution", role: "executor", model: "gpt-5.5" });
    // 不扣工单的重试额度。没有 blocker，用户没有收到通知。
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    // lead 收到一条说明，不需要做任何操作。
    const notes = listInbox(db, { severity: "attention" })
      .map((row) => JSON.parse(row.payload) as { kind?: string; nextStep?: string });
    expect(notes.filter((note) => note.kind === "transient_retry")).toEqual([
      expect.objectContaining({ nextStep: expect.stringContaining("不需要任何操作") }),
    ]);
    // 工单从没进过 blocked。恢复的 Run 交接了成果，工单进入 review。
    const stages = db.prepare(
      "SELECT json_extract(payload, '$.to') AS stage FROM activities WHERE item_id=? AND kind='transition' ORDER BY id",
    ).all(itemId).map((row) => (row as { stage: string }).stage);
    expect(stages).not.toContain("blocked");
    expect(getItem(db, itemId)!.stage).toBe("review");
    // 下一轮派发结算重试请求，之后不再有内核的请求。
    await tick();
    expect(kernelRequests(itemId)).toEqual([]);
  });
});

// 工单 #66：重试、恢复和重派都 resume 来源 Run 的会话。退避期间（或挂起很久之后），Codex 可能已经
// 按保留期删掉了这个会话的记录。这时重试的 Run 在同一个 Run 里开新会话，按原来的任务接着做。
describe("a retry whose source session has expired", () => {
  it("continues the retry in a fresh session with the ticket context", async () => {
    const expired = `Error: thread/resume: thread/resume failed: no rollout found for thread id ${SESSION_64} (code -32600)`;
    const { runtime, itemId, tick, advance } = harness([
      recording(64).events,
      [
        { type: "run.started", runtime: "codex", model: "gpt-5.5" },
        { type: "runtime.stderr", text: `${expired}\n` },
        { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: expired },
      ],
      resumedAndFinished("fresh-thread"),
    ]);

    await tick();
    advance(60 * 60_000);
    await tick();

    const [failed, retry] = runsOf(itemId);
    expect(retry).toMatchObject({ state: "finished", code: null, resumedFrom: failed!.id });
    expect(runtime.requests.map((request) => request.resumeSessionId)).toEqual([undefined, SESSION_64, undefined]);
    expect(runtime.requests[2]!.prompt).toContain("install the skills");
    expect(runtime.requests[2]!.prompt).toContain("原来的会话已经不存在");
    expect(db.prepare(
      `SELECT json_extract(payload, '$.expiredSessionId') AS expired FROM activities
       WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='runtime_session_expired'`,
    ).all(retry!.id)).toEqual([{ expired: SESSION_64 }]);
    expect(db.prepare("SELECT external_session_id AS session FROM runs WHERE id=?").get(retry!.id))
      .toEqual({ session: "fresh-thread" });
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("review");
  });
});

describe("the not-before time of a transient retry", () => {
  it("keeps the retry pending until its absolute not-before time, and shows the wait to the user", async () => {
    vi.stubEnv("PLC_TRANSIENT_RETRY_BASE_MS", "300000");
    const { runtime, itemId, tick, advance } = harness([recording(64).events, resumedAndFinished(SESSION_64)]);

    const before = Date.now();
    await tick();
    const after = Date.now();
    const [retry] = db.prepare(
      "SELECT not_before, backoff_attempt FROM dispatch_requests WHERE trigger='transient-retry' AND item_id=?",
    ).all(itemId) as Array<{ not_before: string; backoff_attempt: number }>;
    // 第一次重试等一个基数：不早于失败时间加 5 分钟。时间以绝对值存在请求上。
    expect(retry!.backoff_attempt).toBe(1);
    expect(Date.parse(retry!.not_before)).toBeGreaterThanOrEqual(before + 300_000);
    expect(Date.parse(retry!.not_before)).toBeLessThanOrEqual(after + 300_000);

    // 用户看到的：工单仍在 active，正在等一次自动重试，原因写着重试的时间。
    const [ticket] = await readGatewayTickets(db);
    expect(ticket).toMatchObject({
      stage: "active",
      executionState: {
        kind: "recovery", state: "waiting_dispatch", label: "瞬时失败 · 等待自动重试",
        reason: expect.stringContaining(localIso(new Date(retry!.not_before))),
      },
    });

    // 还差 10 秒：再跑几轮也不 claim。
    advance(290_000);
    await tick();
    await tick();
    expect(runtime.requests).toHaveLength(1);
    expect(kernelRequests(itemId)).toEqual([expect.objectContaining({ trigger: "transient-retry", state: "pending" })]);

    // 越过不早于时间，下一轮就 claim。
    advance(20_000 + (Date.now() - before));
    await tick();
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]!.resumeSessionId).toBe(SESSION_64);
  });
});

// 一次 resume 刚开始就断网：它没来得及拿到 session。
const resumedButOfflineAtOnce: RecordedEvent[] = [
  { type: "run.started", runtime: "codex", model: "gpt-5.5" },
  {
    type: "run.failed", exitCode: null, errorCode: "codex_error",
    error: "stream disconnected before completion: error sending request",
  },
];

// 又一次 resume，接上原来的 session 以后再次断网。
const resumedThenOfflineAgain: RecordedEvent[] = [
  { type: "run.started", runtime: "codex", model: "gpt-5.5" },
  { type: "session.updated", externalSessionId: SESSION_64 },
  {
    type: "run.failed", exitCode: null, errorCode: "codex_error",
    error: "Reconnecting... waiting for network (Connection failed: error sending request)",
  },
];

describe("the transient retry limit", () => {
  it("doubles the backoff, then raises exactly one blocker and marks the profile degraded at the limit", async () => {
    vi.stubEnv("PLC_TRANSIENT_RETRY_BASE_MS", "1000");
    vi.stubEnv("PLC_TRANSIENT_RETRY_LIMIT", "2");
    const { runtime, itemId, tick, advance } = harness([
      recording(64).events, resumedButOfflineAtOnce, resumedThenOfflineAgain,
    ]);
    const delays: number[] = [];
    // 一次失败，并量出它的重试要等多久。精确到秒，因为失败时间在 tick 里面。
    const failAndMeasure = async (): Promise<void> => {
      const before = Date.now();
      await tick();
      const latest = db.prepare(
        "SELECT not_before FROM dispatch_requests WHERE trigger='transient-retry' AND item_id=? ORDER BY id DESC LIMIT 1",
      ).get(itemId) as { not_before: string };
      delays.push(Math.floor((Date.parse(latest.not_before) - before) / 1_000) * 1_000);
    };

    const leadNotes = () => listInbox(db, { severity: "attention" })
      .filter((row) => (JSON.parse(row.payload) as { kind?: string }).kind === "transient_retry");
    await failAndMeasure();
    // lead 读过了第一次失败的说明。
    markInbox(db, leadNotes().map((row) => row.id), "consumed");
    advance(60_000);
    await failAndMeasure();
    // 上限之前：整条重试链只给 lead 一条说明，没有 blocker，工单没有进 blocked。
    expect(leadNotes()).toHaveLength(1);
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("active");
    advance(60_000);
    await tick();
    await tick();

    // 第一次等 1 秒，第二次加倍等 2 秒。第三次失败超过上限 2，不再重试。
    expect(delays).toEqual([1_000, 2_000]);
    expect(db.prepare(
      "SELECT backoff_attempt FROM dispatch_requests WHERE trigger='transient-retry' AND item_id=? ORDER BY id",
    ).all(itemId)).toEqual([{ backoff_attempt: 1 }, { backoff_attempt: 2 }]);
    const runs = runsOf(itemId);
    expect(runs.map((run) => [run.state, run.code, run.resumedFrom])).toEqual([
      ["failed", "network_error", null],
      ["failed", "network_error", runs[0]!.id],
      // 第二次 resume 没拿到 session，所以第三次仍然 resume 第一个 Run 的 session，进展不丢。
      ["failed", "network_error", runs[0]!.id],
    ]);
    expect(runtime.requests.map((request) => request.resumeSessionId)).toEqual([undefined, SESSION_64, SESSION_64]);
    expect(kernelRequests(itemId)).toEqual([]);

    // 恰好一个 blocker，先交给 Lead（2026-10-15 起）：用户不收通知，Lead 换模型或换 runtime。工单进入 blocked。
    const blockers = listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload) as {
      blockerCode: string; runId: number; nextStep: string;
    });
    expect(blockers).toEqual([expect.objectContaining({ blockerCode: "transient_retry_exhausted", runId: runs[2]!.id })]);
    expect(blockers[0]!.nextStep).toContain("自动重试 2 次");
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(JSON.parse(listInbox(db, { severity: "blocker" })[0]!.payload).needsUser).toBe(false);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    // profile 标成 degraded，带一个绝对的恢复时间。它不挂起派发，所以没有开启故障。
    expect(listUnhealthyRuntimeTargets(db)).toEqual([expect.objectContaining({
      runtime: "codex", level: "profile", status: "degraded", incident_id: null,
      recover_at: expect.any(String),
    })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_incidents").get()).toEqual({ n: 0 });
    // 整条重试链都不扣工单的重试额度。
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
  });

  it("raises the blocker at the first transient failure when automatic retries are turned off", async () => {
    vi.stubEnv("PLC_TRANSIENT_RETRY_LIMIT", "0");
    const { runtime, itemId, tick } = harness([recording(64).events]);

    await tick();
    await tick();

    expect(runtime.requests).toHaveLength(1);
    expect(kernelRequests(itemId)).toEqual([]);
    const blockers = listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload) as {
      blockerCode: string; nextStep: string;
    });
    expect(blockers).toEqual([expect.objectContaining({ blockerCode: "transient_retry_exhausted" })]);
    expect(blockers[0]!.nextStep).toContain("自动重试已经关闭");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(listUnhealthyRuntimeTargets(db)).toEqual([expect.objectContaining({ runtime: "codex", status: "degraded" })]);
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    // daemon 重启时，启动修复给 blocked 的工单补发 blocker。它认得这一条，不会再发第二条。
    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(listInbox(db, { severity: "blocker" })).toHaveLength(1);
    expect(await readGatewayNotifications(db)).toEqual([]);
  });
});

describe("a transient reviewer failure", () => {
  it("is retried by the kernel backoff only, not also by the immediate reviewer retry", async () => {
    const { itemId, tick } = harness([recording(64).events], { reviewer: true });

    await tick();
    await tick();

    expect(runsOf(itemId)).toEqual([expect.objectContaining({ state: "failed", code: "network_error" })]);
    expect(kernelRequests(itemId)).toEqual([expect.objectContaining({ trigger: "transient-retry", state: "pending" })]);
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
  });
});

// 内核的两种重试都带 retry_of_run_id：退避重试（工单 06）和健康账本的挂起重试（工单 03）。
describe("a kernel retry interrupted by a daemon restart", () => {
  it.each([
    ["transient-retry", { notBefore: new Date(Date.now() - 1_000).toISOString(), backoffAttempt: 1 }],
    ["runtime-health-retry", {}],
  ] as const)("%s goes back to the queue, and its own interrupted run does not cancel it as superseded", (trigger, extra) => {
    const dispatcher = createDispatcher(db);
    const itemId = createItem(db, { title: "historical item 77", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test setup" });
    const failed = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5" });
    markRunFailed(db, failed, {
      errorCode: "codex_error", errorMessage: "waiting for network",
      failure: typedFailure("network_error", { errorCode: "codex_error", message: "waiting for network" }),
    });
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      retryOfRunId: failed, ...extra, trigger, idempotencyKey: `${trigger}:${failed}`,
    });
    const claim = dispatcher.claimNext()!;
    dispatcher.markStarted(claim);
    updateRun(db, claim.runId, { state: "running" });

    // daemon 重启：正在跑的重试被回收，原来的请求回到队列。
    recoverOrphans(db);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });

    // 下一次 claim 接着派这个请求。被回收的 Run 是它自己派出的，不算"之后又跑过的 Run"。
    expect(dispatcher.claimNext()).toMatchObject({ requestId, trigger });
  });
});

// ── 决策边界 ───────────────────────────────────────────────────────────────────
describe("which failures the kernel retries with backoff", () => {
  it.each([
    ["provider_overloaded", "execution", true],
    ["network_error", "execution", true],
    ["provider_unavailable", "review", true],
    ["network_error", "integration", true],
    // provider 的内容过滤拦下了这次回答（Run #183）：常常是误判，再来一次往往就过。
    ["content_filtered", "review", true],
    ["content_filtered", "execution", true],
    // 工单对话过时就没有用了。修复回合有自己的额度（工单 09）。
    ["network_error", "conversation", false],
    ["content_filtered", "conversation", false],
    ["network_error", "outcome_repair", false],
    // daemon 重启和租约过期已经把原来的请求交回队列。
    ["run_interrupted", "execution", false],
    ["out_of_credits", "execution", false],
    ["model_unsupported", "execution", false],
    ["host_exception", "execution", false],
    ["task_failed", "execution", false],
    ["unknown", "execution", false],
  ] as Array<[FailureCode, RunPurpose, boolean]>)("%s on a %s run → %s", (code, purpose, expected) => {
    expect(kernelRetriesTransient(typedFailure(code, { errorCode: code, message: code }), purpose)).toBe(expected);
  });
});

describe("the transient retry backoff", () => {
  it("defaults to 30 s, doubling up to 10 minutes, for at most 5 retries", () => {
    const config = transientRetryConfig({});
    expect(config).toEqual({ baseMs: 30_000, maxMs: 600_000, limit: 5 });
    expect([1, 2, 3, 4, 5, 6, 40].map((attempt) => transientRetryDelayMs(attempt, config)))
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it("reads the environment, allows 0 retries, and ignores invalid values", () => {
    expect(transientRetryConfig({
      PLC_TRANSIENT_RETRY_BASE_MS: "1000", PLC_TRANSIENT_RETRY_MAX_MS: "5000", PLC_TRANSIENT_RETRY_LIMIT: "0",
    })).toEqual({ baseMs: 1_000, maxMs: 5_000, limit: 0 });
    expect(transientRetryConfig({
      PLC_TRANSIENT_RETRY_BASE_MS: "-1", PLC_TRANSIENT_RETRY_MAX_MS: "soon", PLC_TRANSIENT_RETRY_LIMIT: "2.5",
    })).toEqual({ baseMs: 30_000, maxMs: 600_000, limit: 5 });
    // 上限最大 20 次，配置写错也不会一直重试。
    expect(transientRetryConfig({ PLC_TRANSIENT_RETRY_LIMIT: "1000" }).limit).toBe(20);
  });
});

describe("the dispatch claim and a not-before time", () => {
  it("skips the request before the time and claims it at the time", () => {
    let clock = new Date("2026-10-10T08:00:00.000Z");
    const dispatcher = createDispatcher(db, { now: () => clock });
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
      notBefore: "2026-10-10T08:00:30.000Z", backoffAttempt: 1,
      trigger: "transient-retry", idempotencyKey: "not-before",
    });

    clock = new Date("2026-10-10T08:00:29.999Z");
    expect(dispatcher.claimNext()).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    clock = new Date("2026-10-10T08:00:30.000Z");
    expect(dispatcher.claimNext()).toMatchObject({ itemId, trigger: "transient-retry", runtime: "codex" });
  });
});

describe("what a transient failure tells the user and the lead", () => {
  const failure = typedFailure("network_error", { errorCode: "codex_error", message: "waiting for network" });

  it("names the retry time and asks for no action while the kernel retries", () => {
    const text = failureNextStep("codex", failure, {
      kind: "retry", attempt: 2, limit: 5, notBefore: "2026-10-10T08:00:30.000Z", resume: true,
    });
    expect(text).toContain(localIso(new Date("2026-10-10T08:00:30.000Z")));
    expect(text).toContain("第 2/5 次");
    expect(text).toContain("接着原来的 session 继续");
    expect(text).toContain("不需要任何操作");
    expect(text).not.toContain("还不会自动重试");
    expect(text).not.toMatch(/recover_ticket_run|retry/i);
  });

  it("asks the user to retry once the limit is reached", () => {
    const text = failureNextStep("codex", failure, { kind: "exhausted", limit: 5 });
    expect(text).toContain("自动重试 5 次");
    expect(text).toContain("degraded");
    expect(text).toContain("需要用户稍后重试这张工单");
    expect(text).not.toMatch(/recover_ticket_run|retry/i);
  });
});

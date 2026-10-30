// 工单 04 的测试：健康恢复（spec D2）。
// 在基线（提交 3342495）里，profile 进入 unavailable 之后再也不会恢复。
// 只有测试调用 resolveRuntimeIncident，所以挂起的请求永远等下去。
// 2026-10-20 起探针通过就关闭故障，挂起的请求一起放行（以前先放一个金丝雀，它成功了才放其余的）。
// 放出去的请求又同样失败时，账本并回那次故障，不再通知。
// 这些测试经过 Seam 1：编排器 tick、dispatcher claim、runItem，真实 SQLite。
// 探针由注入的 adapter 给出，时钟由测试控制。通知从 gateway 的 HTTP 接口读回来。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runItem } from "@pi-lead-child/engine";
import { createOrchestrator } from "@pi-lead-child/engine";
import { createHealthRecovery, parseRecheckRuntime } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import type { DispatchClaim } from "@pi-lead-child/engine";
import { createItem } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { probeBackoffMs } from "@pi-lead-child/store";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { typedFailure } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeProbeRequest, RuntimeProbeResult } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { readGatewayNotifications } from "../testing/gateway-reader.js";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedRun } from "@pi-lead-child/runtime/testing";

interface FixtureRun extends RecordedRun {
  historicalRunId: number;
}

const fixture = JSON.parse(
  readFileSync(RUNTIME_FAILURES_FIXTURE, "utf8"),
) as { runs: FixtureRun[] };

const recording = (runId: number): FixtureRun => {
  const found = fixture.runs.find((run) => run.historicalRunId === runId);
  if (!found) throw new Error(`fixture has no run ${runId}`);
  return found;
};

// 一个正常结束的 Codex Run，表示"账号又能用了"。
// 它调用了 ticket_update，并留下成果信封，所以交接完成。
// 没有交接的 Run 会让内核排一个修复回合（工单 09），那个请求会占掉这里要数的 claim。
const completed: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "session.updated", externalSessionId: "thread-recovered" },
    { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
    { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
    {
      type: "message.completed", messageId: "m-1", role: "assistant",
      text: `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Done", changes: [], deliverables: [], validations: [] })}`,
    },
    { type: "run.completed", exitCode: 0 },
  ],
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// 只有探针的 Codex adapter。它没有声明 profile，所以用默认的 Codex profile，
// 和回放 Run 记账用的 profile 相同。
function probingCodex(results: RuntimeProbeResult[]) {
  const calls: RuntimeProbeRequest[] = [];
  const adapter: AgentRuntime = {
    id: "codex",
    capabilities: new CodexRuntime().capabilities,
    start: async () => { throw new Error("the probing adapter never starts a run"); },
    probe: async (request) => {
      calls.push(request);
      return results[Math.min(calls.length, results.length) - 1]!;
    },
  };
  return { adapter, calls };
}

const PASS: RuntimeProbeResult = { ok: true, checks: ["codex --version", "codex login status"] };
const LOGGED_OUT: RuntimeProbeResult = {
  ok: false,
  checks: ["codex --version", "codex login status"],
  failure: typedFailure("auth_required", { errorCode: "probe_failed", message: "codex login status exited with code 1" }),
};

// 一个真实的派发环境：每次 claim 恰好消费一份录制。没有录制的 claim 会被记下来。
function harness() {
  const dir = tempDir("plc-health-recovery-");
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  let pending: RecordedRun | null = null;
  const unexpectedClaims: number[] = [];
  const claims: DispatchClaim[] = [];
  const orchestrator = createOrchestrator(db, {
    dataDir: dir,
    maxDispatchPerTick: 1,
    onDispatch: async (claim) => {
      claims.push(claim);
      const sample = pending;
      pending = null;
      if (!sample) {
        unexpectedClaims.push(claim.runId);
        return;
      }
      await runItem(db, claim.itemId, {
        dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`),
        prompt: "replay", role: claim.role, purpose: claim.purpose, runId: claim.runId,
        runtime: new ReplayRuntime(sample), runtimeId: claim.runtime,
        model: claim.model ?? undefined, lingerMs: 0,
      });
    },
  });
  // 两轮 tick，最多 claim 两次。只有第一次 claim 拿得到录制。
  const tickWith = async (sample: RecordedRun): Promise<void> => {
    pending = sample;
    await orchestrator.tick();
    await orchestrator.tick();
    pending = null;
  };
  const dispatch = async (itemId: number, sample: RecordedRun, key: string, model = "gpt-5.5"): Promise<number> => {
    pending = sample;
    const requestId = orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", model,
      trigger: "test", idempotencyKey: key,
    });
    await orchestrator.tick();
    await orchestrator.tick();
    pending = null;
    return requestId;
  };
  // 一轮 tick，最多 claim 一次。两个请求同时可派时，用它逐个派。
  const tickOnceWith = async (sample: RecordedRun): Promise<void> => {
    pending = sample;
    await orchestrator.tick();
    pending = null;
  };
  return { db, orchestrator, dispatch, tickWith, tickOnceWith, claims, unexpectedClaims };
}

const requestState = (db: Db, id: number) => db.prepare(
  "SELECT state, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests WHERE id=?",
).get(id) as { state: string; suspended: number };

const kernelRetry = (db: Db, itemId: number): number => (db.prepare(
  "SELECT id FROM dispatch_requests WHERE item_id=? AND trigger='runtime-health-retry' ORDER BY id DESC LIMIT 1",
).get(itemId) as { id: number }).id;

const openIncidents = (db: Db) => db.prepare(
  "SELECT id FROM runtime_incidents WHERE closed_at IS NULL",
).all() as Array<{ id: number }>;

// 历史上的 Codex 余额用完（runs 35、36）：两张工单撞上同一次故障。第一张工单的 Run 失败，
// 内核为它排了一个挂起的重试；第二张工单的请求直接挂起。
async function codexCreditOutage() {
  const env = harness();
  const first = createItem(env.db, { title: "historical item 49", brief: "b", createdBy: "user" });
  const second = createItem(env.db, { title: "historical item 51", brief: "b", createdBy: "user" });
  await env.dispatch(first, recording(35), "replay:35");
  const secondRequest = await env.dispatch(second, recording(36), "replay:36");
  const firstRetry = kernelRetry(env.db, first);
  expect(requestState(env.db, firstRetry)).toEqual({ state: "pending", suspended: 1 });
  expect(requestState(env.db, secondRequest)).toEqual({ state: "pending", suspended: 1 });
  expect(openIncidents(env.db)).toHaveLength(1);
  return { ...env, first, second, firstRetry, secondRequest };
}

// 决策边界：plc recheck 经 socket 送来的 runtime 参数是外部输入。
describe("the recheck runtime argument", () => {
  it.each(["codex", "claude", "pi", undefined, null])("accepts %s", (value) => {
    expect(parseRecheckRuntime(value)).toBe(value ?? undefined);
  });
  it.each(["gemini", "--credentials", 1, ""])("refuses %s", (value) => {
    expect(() => parseRecheckRuntime(value)).toThrow(/codex \| claude \| pi/);
  });
});

// 决策边界：探针的退避。第 n 次失败之后，下一次探针等 base·2ⁿ，最多等一小时。
describe("the probe backoff", () => {
  it.each([
    [0, MINUTE],
    [1, 2 * MINUTE],
    [3, 8 * MINUTE],
    [6, HOUR],
    [40, HOUR],
  ])("waits %i failures → %i ms", (failures, delay) => {
    expect(probeBackoffMs(failures)).toBe(delay);
  });
});

describe("recovery of an unavailable profile", () => {
  it("closes the incident when the probe passes and releases every suspended request", async () => {
    const { db, tickOnceWith, claims, unexpectedClaims, firstRetry, secondRequest } = await codexCreditOutage();
    const { adapter, calls } = probingCodex([PASS]);
    let now = new Date();
    const recovery = createHealthRecovery(db, { runtime: () => adapter, now: () => now });

    // 退避的截止时间还没到：不跑探针，也不放行。
    await recovery.tick();
    expect(calls).toHaveLength(0);

    now = new Date(Date.now() + 2 * HOUR);
    const { closed } = await recovery.tick();
    expect(calls).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(openIncidents(db)).toEqual([]);
    const claimed = claims.length;
    await tickOnceWith(completed);
    await tickOnceWith(completed);
    expect(claims.slice(claimed).map((claim) => claim.requestId)).toEqual([firstRetry, secondRequest]);
    expect(unexpectedClaims).toEqual([]);

    // 用户仍然只收到一条通知。它说明系统会自动重检，也告诉用户修好后怎样立即重检。
    const notices = (await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("系统会定期重检");
    expect(notices[0]!.body).toContain("plc recheck codex");
    expect(notices[0]!.body).not.toContain("金丝雀");
    // lead 收到一条说明：故障已经恢复。
    const notes = listInbox(db, { severity: "attention" }).map((row) => JSON.parse(row.payload) as { kind?: string });
    expect(notes.filter((note) => note.kind === "runtime_incident_closed")).toHaveLength(1);
    db.close();
  });

  // 探针看不到余额：通过、关闭，放出去的请求又撞上同一个故障。账本并回那次故障，不再通知用户。
  it("reopens the same incident without a second notification when a released request fails the same way", async () => {
    const { db, first, tickWith, claims, unexpectedClaims, firstRetry, secondRequest } = await codexCreditOutage();
    const { adapter, calls } = probingCodex([PASS]);
    const recovery = createHealthRecovery(db, { runtime: () => adapter, now: () => new Date(Date.now() + 2 * HOUR) });
    const [incident] = openIncidents(db);

    await recovery.tick();
    expect(calls).toHaveLength(1);
    expect(openIncidents(db)).toEqual([]);
    await tickWith(recording(36));
    expect(claims.at(-1)?.requestId).toBe(firstRetry);
    expect(db.prepare("SELECT state, failure_code FROM runs WHERE item_id=? ORDER BY id").all(first)).toEqual([
      { state: "failed", failure_code: "out_of_credits" },
      { state: "failed", failure_code: "out_of_credits" },
    ]);

    // 同一次故障重新开启，失败次数加一。第二张工单和新的重试都挂起，不再创建 Run。
    expect(openIncidents(db)).toEqual([incident]);
    expect(db.prepare("SELECT probe_failures FROM runtime_incidents WHERE id=?").get(incident!.id)).toEqual({ probe_failures: 1 });
    const claimed = claims.length;
    await tickWith(completed);
    expect(claims.length).toBe(claimed);
    expect(unexpectedClaims).toEqual([]);
    expect(requestState(db, secondRequest)).toEqual({ state: "pending", suspended: 1 });
    expect(requestState(db, kernelRetry(db, first))).toEqual({ state: "pending", suspended: 1 });
    const notices = (await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident");
    expect(notices).toHaveLength(1);
    db.close();
  });

  it("releases a request only when every incident on its target is closed", async () => {
    const { db, dispatch, tickWith, claims, unexpectedClaims } = harness();
    const proxyTicket = createItem(db, { title: "historical item 76", brief: "b", createdBy: "user" });
    const creditTicket = createItem(db, { title: "historical item 51", brief: "b", createdBy: "user" });
    // run 62：代理不认识 gpt-5.4-mini（模型级）。run 35：Codex 余额用完（profile 级）。
    await dispatch(proxyTicket, recording(62), "replay:62", "gpt-5.4-mini");
    await dispatch(creditTicket, recording(35), "replay:35");
    const proxyRetry = kernelRetry(db, proxyTicket);
    const creditRetry = kernelRetry(db, creditTicket);
    expect(openIncidents(db)).toHaveLength(2);
    // 余额的探针通过了，代理的探针还没通过。gpt-5.4-mini 的请求还撞着模型级的故障，所以它不放行。
    const { adapter } = probingCodex([PASS]);
    const proxyStillBroken: AgentRuntime = {
      ...adapter,
      probe: async (request) => (request.model === "gpt-5.4-mini" ? LOGGED_OUT : PASS),
    };
    const recovery = createHealthRecovery(db, {
      runtime: () => proxyStillBroken, now: () => new Date(Date.now() + 2 * HOUR),
    });
    await recovery.tick();
    expect(openIncidents(db)).toHaveLength(1);

    const claimed = claims.length;
    await tickWith(completed);
    expect(proxyRetry).toBeLessThan(creditRetry);
    expect(claims.slice(claimed).map((claim) => claim.requestId)).toEqual([creditRetry]);
    expect(requestState(db, proxyRetry)).toEqual({ state: "pending", suspended: 1 });
    expect(unexpectedClaims).toEqual([]);
    db.close();
  });

  it("does not probe an incident whose profile the daemon no longer uses", async () => {
    const { db } = await codexCreditOutage();
    const { adapter, calls } = probingCodex([PASS]);
    // 用户换了 Codex 的配置目录：这是另一个 profile，它的健康状态从 healthy 开始。
    const moved: AgentRuntime = {
      ...adapter, profile: {
        runtime: "codex", executable: "/opt/other/codex", configDir: "/tmp/other-codex-home",
        interpreter: null, extensions: [], models: { defaultModel: null, providers: ["openai"] },
        environment: { path: "/usr/bin:/bin", inherit: "all", adapterVariables: [] }, allowedTools: [],
      },
    };
    const recovery = createHealthRecovery(db, { runtime: () => moved, now: () => new Date(Date.now() + 2 * HOUR) });

    const results = await recovery.recheck({ runtime: "codex" });
    expect(results).toEqual([expect.objectContaining({ outcome: "profile_changed" })]);
    expect(results[0]!.summary).toContain("只挂起用那个配置的派发");
    await recovery.tick();
    expect(calls).toHaveLength(0);
    expect(openIncidents(db)).toHaveLength(1);
    db.close();
  });

  it("releases nothing while the probe fails, and waits longer before each new probe", async () => {
    const { db, tickWith, claims, unexpectedClaims, secondRequest } = await codexCreditOutage();
    const { adapter, calls } = probingCodex([LOGGED_OUT]);
    const start = Date.now() + 2 * HOUR;
    let now = new Date(start);
    const recovery = createHealthRecovery(db, { runtime: () => adapter, now: () => now });

    await recovery.tick();
    expect(calls).toHaveLength(1);
    const claimed = claims.length;
    await tickWith(completed);
    expect(claims.length).toBe(claimed);
    expect(unexpectedClaims).toEqual([]);
    expect(requestState(db, secondRequest)).toEqual({ state: "pending", suspended: 1 });

    now = new Date(start + 2 * MINUTE - 1_000);
    await recovery.tick();
    expect(calls).toHaveLength(1);
    now = new Date(start + 2 * MINUTE + 1_000);
    await recovery.tick();
    expect(calls).toHaveLength(2);
    // 第二次失败之后，再等四倍。
    now = new Date(start + 6 * MINUTE);
    await recovery.tick();
    expect(calls).toHaveLength(2);
    now = new Date(start + 7 * MINUTE);
    await recovery.tick();
    expect(calls).toHaveLength(3);
    expect(openIncidents(db)).toHaveLength(1);
    db.close();
  });
});

// 工单 #93 的审查：Codex 账号所在的工作区被停用。工单 #98 在 08:59–09:10Z 拉起了 4 个 reviewer（Run #113–#116）。
// Run #113 开启了故障。之后每一轮自动探针都通过（codex --version、codex login status 看不出停用），
// 放出注定失败的 Run。账号停用不会自己恢复，所以只有用户的 plc recheck 能关闭这次故障。
// 原文取自 Run #113。停用时，模型目录的刷新也在 stderr 里报 402。
const DEACTIVATED_WORKSPACE = "Reconnecting... 2/5 (unexpected status 402 Payment Required: Payment Required, "
  + "url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: a4ce9692089f3e2b-SIN, auth error: 402, "
  + "auth error code: deactivated_workspace)";
const deactivatedWorkspace: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "session.updated", externalSessionId: "thread-deactivated" },
    {
      type: "runtime.stderr",
      text: "ERROR codex_models_manager::manager: failed to refresh available models: "
        + "unexpected status 402 Payment Required: Payment Required\n",
    },
    { type: "run.failed", exitCode: null, errorCode: "codex_error", error: DEACTIVATED_WORKSPACE },
  ],
};

// 一次 pi 的交付：留下成果信封后正常结束。
const piDelivery: RecordedRun = {
  runtime: "pi",
  events: completed.events.map((event) => (event.type === "run.started" ? { ...event, runtime: "pi" } : event)),
};

describe("recovery of a deactivated account", () => {
  async function deactivatedOutage() {
    const env = harness();
    const first = createItem(env.db, { title: "historical item 98", brief: "b", createdBy: "user" });
    const second = createItem(env.db, { title: "another codex ticket", brief: "b", createdBy: "user" });
    await env.dispatch(first, deactivatedWorkspace, "replay:113");
    const secondRequest = await env.dispatch(second, deactivatedWorkspace, "replay:second");
    const firstRetry = kernelRetry(env.db, first);
    expect(requestState(env.db, firstRetry)).toEqual({ state: "pending", suspended: 1 });
    expect(requestState(env.db, secondRequest)).toEqual({ state: "pending", suspended: 1 });
    expect(env.db.prepare("SELECT level, scope, code FROM runtime_incidents").all())
      .toEqual([{ level: "profile", scope: "account", code: "account_deactivated" }]);
    return { ...env, first, second, firstRetry, secondRequest };
  }

  it("does not probe on its own, sends automatic reviews to another reviewer, and recovers after plc recheck", async () => {
    const env = await deactivatedOutage();
    const { db, orchestrator, tickWith, tickOnceWith, claims, unexpectedClaims, firstRetry, secondRequest } = env;
    const { adapter, calls } = probingCodex([PASS]);
    const start = Date.now();
    let now = new Date(start);
    const recovery = createHealthRecovery(db, { runtime: () => adapter, now: () => now });

    // 一张要求独立核查的工单在故障期间交付。自动核查不等 codex：选下一个能用的核查员（2026-10-20），马上派出。
    const reviewed = createItem(db, {
      title: "needs an independent review", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer",
    });
    orchestrator.dispatcher.request({
      itemId: reviewed, role: "executor", purpose: "execution", runtime: "pi",
      trigger: "test", idempotencyKey: "deliver:reviewed",
    });
    await tickOnceWith(piDelivery);
    expect(db.prepare("SELECT stage FROM items WHERE id=?").get(reviewed)).toEqual({ stage: "review" });
    await tickOnceWith(completed);
    const review = db.prepare(
      "SELECT id, runtime, state FROM dispatch_requests WHERE item_id=? AND trigger='automatic-review'",
    ).get(reviewed) as { id: number; runtime: string; state: string } | undefined;
    expect(review).toMatchObject({ runtime: "claude", state: "started" });
    expect(claims.at(-1)).toMatchObject({ requestId: review!.id, runtime: "claude" });

    // 退避过了好几轮：探针不跑，codex 上挂起的执行请求不放行，没有新的 Run。
    const claimed = claims.length;
    for (const hours of [1, 3, 8]) {
      now = new Date(start + hours * HOUR);
      await recovery.tick();
      await tickWith(completed);
    }
    expect(calls).toHaveLength(0);
    expect(claims.length).toBe(claimed);
    expect(unexpectedClaims).toEqual([]);

    // 通知告诉用户：系统不会自动重检，换好账号后运行 plc recheck codex。
    const notices = (await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain("Codex 账号已停用");
    expect(notices[0]!.body).toContain("不会自动重检");
    expect(notices[0]!.body).toContain("plc recheck codex");

    // 用户换好账号，运行 plc recheck codex：探针通过，故障关闭，挂起的请求一起放行。
    const results = await recovery.recheck({ runtime: "codex" });
    expect(results.map((result) => result.outcome)).toEqual(["recovered"]);
    expect(calls).toHaveLength(1);
    expect(openIncidents(db)).toEqual([]);
    await tickOnceWith(completed);
    await tickOnceWith(completed);
    expect(claims.slice(claimed).map((claim) => claim.requestId)).toEqual([firstRetry, secondRequest]);
    expect(unexpectedClaims).toEqual([]);
    db.close();
  });

  it("goes back to waiting for the user when the first request after a recheck hits the same deactivation", async () => {
    const { db, first, tickWith, claims, unexpectedClaims, firstRetry, secondRequest } = await deactivatedOutage();
    const { adapter, calls } = probingCodex([PASS]);
    const start = Date.now();
    let now = new Date(start);
    const recovery = createHealthRecovery(db, { runtime: () => adapter, now: () => now });
    const [incident] = openIncidents(db);

    // 用户以为修好了，其实账号仍然停用：放出去的第一个请求又撞上同一项故障，那次故障重新开启。
    await recovery.recheck({ runtime: "codex" });
    await tickWith(deactivatedWorkspace);
    expect(claims.at(-1)?.requestId).toBe(firstRetry);
    expect(db.prepare("SELECT failure_code FROM runs WHERE item_id=? ORDER BY id").all(first)).toEqual([
      { failure_code: "account_deactivated" },
      { failure_code: "account_deactivated" },
    ]);
    expect(openIncidents(db)).toEqual([incident]);

    // 之后系统仍然不自己探针，也不放行。
    const claimed = claims.length;
    for (const hours of [1, 3, 8]) {
      now = new Date(start + hours * HOUR);
      await recovery.tick();
      await tickWith(completed);
    }
    expect(calls).toHaveLength(1);
    expect(claims.length).toBe(claimed);
    expect(unexpectedClaims).toEqual([]);
    expect(requestState(db, secondRequest)).toEqual({ state: "pending", suspended: 1 });
    expect(requestState(db, kernelRetry(db, first))).toEqual({ state: "pending", suspended: 1 });
    db.close();
  });
});

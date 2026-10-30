// 工单 03 的回归测试：健康账本（spec D2）。
// 在基线（提交 572ff79）里，每张工单都要各撞一次同一个账号故障。
// 每张工单都创建一个失败的 Run，每个 Run 都给用户发一条通知。
// 例如，历史上 run 34、35、36 是同一次 Codex 余额用完。
// 这些测试经过 Seam 1 回放历史证据：编排器 tick、dispatcher claim、runItem，真实 SQLite。
// 通知从 gateway 的 HTTP 接口读回来。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthRecovery, recoverTicketRun, runItem } from "@pi-lead-child/engine";
import { createLeadTools, routeTicketMessageToAgentRun, spawnItemChild } from "@pi-lead-child/lead";
import { createOrchestrator } from "@pi-lead-child/engine";
import { openDb, type Db } from "@pi-lead-child/store";
import type { DispatchClaim } from "@pi-lead-child/engine";
import { listInbox } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { resolveRuntimeIncident } from "@pi-lead-child/store";
import { ClaudeRuntime, healthLevel, typedFailure, type AgentRuntime, type FailureCode } from "@pi-lead-child/runtime";
import type { RunPurpose, RuntimeId } from "@pi-lead-child/core";
import { readGatewayNotifications, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedRun } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";

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

interface DispatchInput {
  itemId: number;
  sample: RecordedRun;
  runtime: RuntimeId;
  model?: string;
  key: string;
  role?: "executor" | "reviewer";
}

// 一个真实的派发环境：每次 claim 恰好消费一份录制。没有录制的 claim 会被记下来，测试再断言它不存在。
function harness() {
  const dir = tempDir("plc-runtime-health-");
  const leadTool = (name: string) => {
    const supervisor = { status: async () => ({ schemaVersion: 27 }), request: async () => ({}) };
    const found = createLeadTools({ db, dbPath, dataDir: dir, supervisor } as never)
      .find((tool: { name: string }) => tool.name === name) as
      { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    if (!found) throw new Error(`lead tool ${name} not found`);
    return async (params: unknown): Promise<string> => (await found.execute("test", params)).content[0]!.text;
  };
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
  // 不新建请求，只让编排器跑一轮，看已有的请求会不会被 claim。
  const tickWith = async (sample: RecordedRun): Promise<void> => {
    pending = sample;
    await orchestrator.tick();
    await orchestrator.tick();
    pending = null;
  };
  const dispatch = async (input: DispatchInput): Promise<number> => {
    pending = input.sample;
    const requestId = orchestrator.dispatcher.request({
      itemId: input.itemId, role: input.role ?? "executor", purpose: input.role === "reviewer" ? "review" : "execution",
      runtime: input.runtime, model: input.model,
      trigger: "test", idempotencyKey: input.key,
    });
    await orchestrator.tick();
    await orchestrator.tick();
    pending = null;
    return requestId;
  };
  return { db, dbPath, dir, orchestrator, dispatch, tickWith, claims, unexpectedClaims, leadTool };
}

const runsOf = (db: Db, itemId: number) => db.prepare(
  "SELECT state, failure_scope AS scope, failure_code AS code FROM runs WHERE item_id=? ORDER BY id",
).all(itemId);

// 决策边界：哪些失败记在健康账本上，记在哪一级。期望值取自 spec D1 的映射表和 D2 的模型级规则。
describe("which failures the health ledger records", () => {
  it.each([
    ["out_of_credits", "profile"],
    ["auth_required", "profile"],
    ["account_deactivated", "profile"],
    ["executable_missing", "profile"],
    ["runtime_start_failed", "profile"],
    ["extension_missing", "profile"],
    ["interpreter_mismatch", "profile"],
    ["model_unsupported", "model"],
    ["provider_overloaded", null],
    ["network_error", null],
    ["run_interrupted", null],
    ["host_exception", null],
    ["task_failed", null],
    ["unknown", null],
  ] as Array<[FailureCode, string | null]>)("%s is recorded at the %s level", (code, level) => {
    expect(healthLevel(typedFailure(code, { errorCode: code, message: code }))).toBe(level);
  });
});

describe("one account outage across tickets", () => {
  it("creates only the first failed Run and notifies the user once", async () => {
    const { db, dispatch, unexpectedClaims } = harness();
    const first = createItem(db, { title: "historical item 49", brief: "b", createdBy: "user" });
    const second = createItem(db, { title: "historical item 51", brief: "b", createdBy: "user" });

    await dispatch({ itemId: first, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });
    const suspended = await dispatch({
      itemId: second, sample: recording(36), runtime: "codex", model: "gpt-5.5", key: "replay:36",
    });

    expect(runsOf(db, first)).toEqual([{ state: "failed", scope: "account", code: "out_of_credits" }]);
    // 第二张工单不再撞同一个故障：没有 Run，请求挂起，并带着看得见的原因。
    expect(runsOf(db, second)).toEqual([]);
    const request = db.prepare(
      "SELECT state, runtime, suspended_reason, suspended_incident_id FROM dispatch_requests WHERE id=?",
    ).get(suspended) as { state: string; suspended_reason: string | null; suspended_incident_id: number | null };
    // 固定了 runtime 的请求挂起，不切换到别的 runtime。
    expect(request).toMatchObject({ state: "pending", runtime: "codex", suspended_incident_id: expect.any(Number) });
    expect(request.suspended_reason).toContain("余额");
    expect(unexpectedClaims).toEqual([]);

    const notifications = await readGatewayNotifications(db);
    expect(notifications).toEqual([expect.objectContaining({
      kind: "runtime_incident",
      dedupKey: `runtime-incident:${request.suspended_incident_id}`,
      urgency: "immediate",
    })]);
    db.close();
  });
});

describe("a model-level failure", () => {
  it("suspends only that model, and the same profile still dispatches other models", async () => {
    const { db, dispatch, unexpectedClaims } = harness();
    const first = createItem(db, { title: "first ticket", brief: "b", createdBy: "user" });
    const sameModel = createItem(db, { title: "same model", brief: "b", createdBy: "user" });
    const otherModel = createItem(db, { title: "other model", brief: "b", createdBy: "user" });

    // run 62：代理不认识 gpt-5.4-mini。这是模型级故障。
    await dispatch({ itemId: first, sample: recording(62), runtime: "codex", model: "gpt-5.4-mini", key: "replay:62" });
    const suspended = await dispatch({
      itemId: sameModel, sample: recording(62), runtime: "codex", model: "gpt-5.4-mini", key: "same-model",
    });
    // run 64：同一个 Codex profile 上的 gpt-5.5 照常派发。它后来因为断网失败，那是另一类故障。
    await dispatch({ itemId: otherModel, sample: recording(64), runtime: "codex", model: "gpt-5.5", key: "replay:64" });

    expect(runsOf(db, first)).toEqual([{ state: "failed", scope: "runtime", code: "model_unsupported" }]);
    expect(runsOf(db, sameModel)).toEqual([]);
    expect(db.prepare("SELECT state, runtime, model, suspended_reason FROM dispatch_requests WHERE id=?").get(suspended))
      .toEqual({
        state: "pending", runtime: "codex", model: "gpt-5.4-mini",
        suspended_reason: expect.stringContaining("gpt-5.4-mini"),
      });
    expect(runsOf(db, otherModel)).toEqual([{ state: "failed", scope: "attempt", code: "network_error" }]);
    expect(unexpectedClaims).toEqual([]);

    // 2026-10-15 起模型被拒先交给 Lead：用户不收通知，Lead 收到一条故障说明。
    expect((await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident")).toEqual([]);
    const incidents = listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "runtime_incident");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.summary).toContain("gpt-5.4-mini");
    db.close();
  });
});

// 一个正常结束的 Codex Run，用来观察恢复后被放行的请求。
// 它调用了 ticket_update，并留下成果信封，所以交接完成。
// 没有交接的 Run 会让内核排一个修复回合（工单 09），那就不是这里要观察的请求了。
const completed: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "session.updated", externalSessionId: "thread-resumed" },
    { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
    { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
    {
      type: "message.completed", messageId: "m-1", role: "assistant",
      text: `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Done", changes: [], deliverables: [], validations: [] })}`,
    },
    { type: "run.completed", exitCode: 0 },
  ],
};

describe("the kernel retry of a failed Run", () => {
  it("waits suspended, then resumes the same session on the same runtime after the incident closes", async () => {
    const { db, dispatch, tickWith, claims, unexpectedClaims } = harness();
    const itemId = createItem(db, { title: "historical item 51", brief: "b", createdBy: "user" });
    await dispatch({ itemId, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });

    const failed = db.prepare("SELECT id, external_session_id FROM runs WHERE item_id=?").get(itemId) as {
      id: number; external_session_id: string | null;
    };
    expect(failed.external_session_id).not.toBeNull();
    // 账号故障不是工单的事：工单不进 blocked，也不升起这张工单自己的 blocker。
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    // lead 收到一条说明：故障的那条 inbox 说明。Run 的检查点留在工单时间线上，不再另给 lead 一张卡片。
    const notes = listInbox(db, { severity: "attention" }).map((row) => JSON.parse(row.payload) as { kind?: string });
    expect(notes.filter((note) => note.kind === "runtime_incident")).toHaveLength(1);
    expect(db.prepare("SELECT kind FROM checkpoints WHERE run_id=?").all(failed.id)).toEqual([
      { kind: "progress" }, { kind: "blocked" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_cards WHERE item_id=?").get(itemId)).toEqual({ n: 0 });

    const retry = db.prepare(
      `SELECT id, state, runtime, model, resume_from_run_id, suspended_incident_id FROM dispatch_requests
       WHERE trigger='runtime-health-retry' AND item_id=?`,
    ).get(itemId) as {
      id: number; state: string; runtime: string; model: string;
      resume_from_run_id: number | null; suspended_incident_id: number | null;
    };
    expect(retry).toMatchObject({
      state: "pending", runtime: "codex", model: "gpt-5.5", resume_from_run_id: failed.id,
      suspended_incident_id: expect.any(Number),
    });

    // 故障没修好之前，再跑几轮也不会 claim 它。
    await tickWith(completed);
    expect(claims.map((claim) => claim.requestId)).not.toContain(retry.id);

    expect(resolveRuntimeIncident(db, retry.suspended_incident_id!, { reason: "user refilled the account" })).toBe(true);
    await tickWith(completed);
    expect(claims.at(-1)).toMatchObject({
      requestId: retry.id, runtime: "codex", model: "gpt-5.5", resumeFromRunId: failed.id,
      trigger: "runtime-health-retry",
    });
    expect(db.prepare("SELECT suspended_reason, suspended_incident_id FROM dispatch_requests WHERE id=?").get(retry.id))
      .toEqual({ suspended_reason: null, suspended_incident_id: null });
    expect(unexpectedClaims).toEqual([]);
    db.close();
  });

  it("survives a ticket conversation that ran while the incident was open", async () => {
    const { db, dbPath, dir, dispatch, tickWith, claims } = harness();
    const itemId = createItem(db, { title: "chatty ticket", brief: "b", createdBy: "user" });
    await dispatch({ itemId, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });
    const retryId = (db.prepare("SELECT id FROM dispatch_requests WHERE trigger='runtime-health-retry'").get() as {
      id: number;
    }).id;
    // 故障期间，用户在 Claude 上和工单 agent 聊了一句。对话不是执行，不能让内核的执行重试作废。
    await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
      prompt: "进展如何？", role: "executor", purpose: "conversation", lingerMs: 0,
      runtime: new ReplayRuntime({
        runtime: "claude",
        events: [{ type: "run.started", runtime: "claude", model: null }, { type: "run.completed", exitCode: 0 }],
      }),
    });
    const incidentId = (db.prepare("SELECT id FROM runtime_incidents").get() as { id: number }).id;
    resolveRuntimeIncident(db, incidentId, { reason: "user refilled the account" });
    await tickWith(completed);
    expect(claims.at(-1)).toMatchObject({ requestId: retryId, purpose: "execution", trigger: "runtime-health-retry" });
    db.close();
  });

  it("is dropped when the ticket ran again on another path before the incident closed", async () => {
    const { db, dispatch, tickWith, claims } = harness();
    const itemId = createItem(db, { title: "switched runtime", brief: "b", createdBy: "user" });
    await dispatch({ itemId, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });
    const retryId = (db.prepare("SELECT id FROM dispatch_requests WHERE trigger='runtime-health-retry'").get() as {
      id: number;
    }).id;
    // 用户或 lead 换到 Claude 接着做。这次 Run 正常结束。
    await dispatch({
      itemId, runtime: "claude", key: "lead-switch",
      sample: { runtime: "claude", events: [{ type: "run.started", runtime: "claude", model: null }, { type: "run.completed", exitCode: 0 }] },
    });
    const incidentId = (db.prepare("SELECT id FROM runtime_incidents").get() as { id: number }).id;
    resolveRuntimeIncident(db, incidentId, { reason: "user refilled the account" });
    await tickWith(completed);
    expect(claims.map((claim) => claim.requestId)).not.toContain(retryId);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(retryId)).toEqual({ state: "cancelled" });
    db.close();
  });
});

// 工单 #117 的 Run 151–155（2026-10-29）：Claude Code 的周额度用完，报错只写了「resets Oct 26 at 4pm」，系统认不出这个时间。
// 内核在同一个用完的模型上排了重试；探针看不到额度，60 秒后就通过，故障关闭，重试被放出去，又同样失败，连着五次。
// 现在：认不出重置时间时不在这个模型上重试，探针通过也不关闭故障；工单交给 Lead，Lead 用 recover_ticket_run 换 runtime。
// 认得出重置时间时，重试等到那个时间以后。
describe("a usage limit on one model (regression: #117 failed five times on an exhausted model)", () => {
  const limited = (message: string): RecordedRun => ({
    runtime: "claude",
    events: [
      { type: "run.started", runtime: "claude", model: "opus" },
      { type: "session.updated", externalSessionId: "claude-session-117" },
      { type: "run.failed", exitCode: 1, errorCode: "claude_result_error", error: message },
    ],
  });
  // 只有探针的 Claude Code adapter：没有声明 profile，所以用默认的 profile，和回放 Run 记账用的相同。探针总是通过。
  const probes: unknown[] = [];
  const passingClaude: AgentRuntime = {
    id: "claude",
    capabilities: new ClaudeRuntime().capabilities,
    start: async () => { throw new Error("the probing adapter never starts a run"); },
    probe: async (request) => { probes.push(request); return { ok: true, checks: ["claude --version", "claude auth status"] }; },
  };

  it("does not retry on the same model without a reset time, and hands the ticket to Lead", async () => {
    probes.length = 0;
    const { db, dispatch, tickWith, claims, unexpectedClaims } = harness();
    const itemId = createItem(db, { title: "historical item 117", brief: "b", createdBy: "user" });
    const started = Date.now();
    await dispatch({
      itemId, sample: limited("You've hit your weekly limit · resets Oct 26 at 4pm"), runtime: "claude", model: "opus", key: "run-151",
    });
    const failed = db.prepare("SELECT id, failure_code FROM runs WHERE item_id=?").get(itemId) as { id: number; failure_code: string };
    expect(failed.failure_code).toBe("usage_limited");
    // 旧代码在这里排了一条 runtime-health-retry，等故障关闭就放回同一个用完的模型。
    expect(db.prepare("SELECT trigger FROM dispatch_requests WHERE item_id=? AND trigger <> 'test'").all(itemId)).toEqual([]);
    // 工单交给 Lead：一条只给 Lead 的 blocker，写着用 recover_ticket_run 换 runtime。用户不收通知。
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    const blockers = listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload) as {
      needsUser: boolean; leadNextStep?: string; runId: number;
    });
    expect(blockers).toEqual([expect.objectContaining({ needsUser: false, runId: failed.id })]);
    expect(blockers[0]!.leadNextStep).toContain(`recover_ticket_run（ticket_id=${itemId}，run_id=${failed.id}，action=auto）`);
    const incidentNote = listInbox(db, { severity: "attention" })
      .map((row) => JSON.parse(row.payload) as { kind?: string; leadNextStep?: string })
      .find((note) => note.kind === "runtime_incident")!;
    expect(incidentNote.leadNextStep).toContain("action=auto");
    expect((await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident")).toEqual([]);

    // 探针看不到额度：到了以前的退避时间（60 秒），探针也不跑，故障不关闭。
    const recovery = createHealthRecovery(db, { runtime: () => passingClaude, now: () => new Date(started + 2 * 60 * 60_000) });
    expect(await recovery.tick()).toEqual({ closed: [] });
    expect(probes).toEqual([]);
    expect(db.prepare("SELECT closed_at FROM runtime_incidents").all()).toEqual([{ closed_at: null }]);
    await tickWith(limited("You've hit your weekly limit · resets Oct 26 at 4pm"));
    expect(claims).toHaveLength(1);
    expect(unexpectedClaims).toEqual([]);

    // Lead 按说明换 runtime：工单在 blocked，恢复照常排上别的 runtime。
    const recovered = recoverTicketRun(db, { itemId, failedRunId: failed.id, action: "auto", authorityRef: "lead:usage-limit" });
    expect(recovered).toMatchObject({ status: "queued" });
    expect(recovered.status === "queued" ? recovered.runtime : null).not.toBe("claude");
    db.close();
  });

  it("retries on the same model only after the reset time that the evidence names", async () => {
    const { db, dispatch } = harness();
    const itemId = createItem(db, { title: "limited with a reset time", brief: "b", createdBy: "user" });
    const before = Date.now();
    await dispatch({
      itemId, sample: limited("You've hit your limit. Usage limit reached, resets in 2h"), runtime: "claude", model: "opus", key: "reset",
    });
    const after = Date.now();
    const retry = db.prepare(
      "SELECT runtime, model, not_before, state FROM dispatch_requests WHERE item_id=? AND trigger='runtime-health-retry'",
    ).get(itemId) as { runtime: string; model: string; not_before: string; state: string };
    expect(retry).toMatchObject({ runtime: "claude", model: "opus", state: "pending" });
    expect(Date.parse(retry.not_before)).toBeGreaterThanOrEqual(before + 2 * 60 * 60_000);
    expect(Date.parse(retry.not_before)).toBeLessThanOrEqual(after + 2 * 60 * 60_000);
    // 工单在等额度重置，不需要 Lead 做决定。
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    db.close();
  });
});

describe("a request that does not pin a runtime", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("selects a runtime whose profile is healthy", async () => {
    // 让三个 runtime 在这台机器上都"可用"，选择结果只取决于健康账本。
    for (const name of ["PLC_CODEX_BIN", "PLC_CLAUDE_BIN", "PLC_PI_BIN"]) vi.stubEnv(name, process.execPath);
    vi.stubEnv("PLC_CHILD_RUNTIME", "");
    const { db, dispatch, orchestrator } = harness();
    const pinned = createItem(db, { title: "pinned to codex", brief: "b", createdBy: "user" });
    await dispatch({ itemId: pinned, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });

    const unpinned = createItem(db, { title: "no runtime", brief: "b", createdBy: "user" });
    const requestId = orchestrator.dispatcher.request({
      itemId: unpinned, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: "unpinned",
    });
    expect(db.prepare("SELECT runtime FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ runtime: "claude" });
    expect(getItem(db, unpinned)!.requested_runtime).toBe("claude");
    db.close();
  });
});

describe("a reviewer that hits an account outage", () => {
  // 2026-10-20：以前内核的重试点名 codex，挂起等 codex 恢复。现在下一次认领把它换给下一个能用的核查员（Claude Code）。
  it("moves the kernel retry to the next reviewer instead of waiting for codex", async () => {
    const { db, dispatch, claims, unexpectedClaims } = harness();
    // 历史工单 49：自动评审的 reviewer 撞上 Codex 余额用完（run 34）。
    const itemId = createItem(db, { title: "historical item 49", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer" });
    transition(db, { itemId, to: "active", actor: "system", reason: "test setup" });
    transition(db, { itemId, to: "review", actor: "child", reason: "test setup" });
    await dispatch({ itemId, sample: recording(34), runtime: "codex", model: "gpt-5.5", key: "replay:34", role: "reviewer" });

    // dispatch 的第二轮 tick 认领了换过去的重试。这里没有给它录制，所以它只被认领、没有跑。
    expect(db.prepare(
      "SELECT trigger, role, runtime, model, state, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests WHERE item_id=? ORDER BY id",
    ).all(itemId)).toEqual([
      { trigger: "test", role: "reviewer", runtime: "codex", model: "gpt-5.5", state: "failed", suspended: 0 },
      { trigger: "runtime-health-retry", role: "reviewer", runtime: "claude", model: null, state: "started", suspended: 0 },
    ]);
    expect(claims.map((claim) => claim.runtime)).toEqual(["codex", "claude"]);
    expect(unexpectedClaims).toHaveLength(1);
    expect(getItem(db, itemId)!.stage).toBe("review");
    db.close();
  });
});

describe("what the lead reads about a suspended request", () => {
  it("shows the suspension reason on the ticket and the incident in runtime health", async () => {
    const { db, dispatch, leadTool } = harness();
    const first = createItem(db, { title: "first ticket", brief: "b", createdBy: "user" });
    const second = createItem(db, { title: "second ticket", brief: "b", createdBy: "user" });
    await dispatch({ itemId: first, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });
    const requestId = await dispatch({
      itemId: second, sample: recording(36), runtime: "codex", model: "gpt-5.5", key: "replay:36",
    });
    const incidentId = (db.prepare("SELECT id FROM runtime_incidents").get() as { id: number }).id;

    // lead 回答进展问题时，不能把挂起说成"还在跑"（spec 用户故事 26）。
    const ticket = await leadTool("get_ticket")({ id: second });
    expect(ticket).toContain(`派发请求 #${requestId}`);
    expect(ticket).toContain("已挂起，没有 Run 在跑");
    expect(ticket).toContain(`Codex 账号余额不足（故障 #${incidentId}）`);

    const health = JSON.parse(await leadTool("get_runtime_health")({})) as { runtimeHealth: unknown[] };
    expect(health.runtimeHealth).toEqual([expect.objectContaining({
      runtime: "codex", level: "profile", status: "unavailable", incidentId, needs: "refill",
      reason: expect.stringContaining("需要给 Codex 的账号充值"),
    })]);

    // 用户界面读同一个事实：工单投影说派发已挂起，并给出同一句原因，而不是"等待 agent 派发"。
    const tickets = await readGatewayTickets(db);
    for (const itemId of [first, second]) {
      expect(tickets.find((ticket) => ticket.id === itemId)?.executionState).toMatchObject({
        state: "blocked",
        label: "派发已挂起",
        reason: expect.stringContaining(`Codex 账号余额不足（故障 #${incidentId}）`),
      });
    }
    db.close();
  });
});

// lead 的 spawn_child、用户的"开始"、trigger 和孤儿重派都直接启动 child，不经过派发队列。
// 它们也不能在不可用的 profile 上创建 Run。
describe("starting a child outside the dispatch queue", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("queues a suspended request, and a ticket conversation is refused, while the profile is unavailable", async () => {
    vi.stubEnv("PLC_CODEX_BIN", process.execPath);
    const { db, dbPath, dir, dispatch, orchestrator } = harness();
    const first = createItem(db, { title: "first ticket", brief: "b", createdBy: "user" });
    await dispatch({ itemId: first, sample: recording(35), runtime: "codex", model: "gpt-5.5", key: "replay:35" });
    const second = createItem(db, {
      title: "second ticket", brief: "b", createdBy: "user", runtime: "codex", model: "gpt-5.5",
    });
    const deps = { db, dbPath, dataDir: dir };

    const message = spawnItemChild(deps, second, {});
    expect(message).toContain("没有 Run 在跑");
    expect(message).toContain("Codex 账号余额不足");
    expect(runsOf(db, second)).toEqual([]);
    await orchestrator.tick();
    expect(db.prepare(
      "SELECT trigger, state, runtime, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests WHERE item_id=?",
    ).all(second)).toEqual([{ trigger: "spawn-suspended", state: "pending", runtime: "codex", suspended: 1 }]);

    expect(() => routeTicketMessageToAgentRun(deps, { itemId: second, message: "进展如何？" }))
      .toThrow(/Codex 账号余额不足/);
    expect(runsOf(db, second)).toEqual([]);
    expect((await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident")).toHaveLength(1);
    db.close();
  });
});

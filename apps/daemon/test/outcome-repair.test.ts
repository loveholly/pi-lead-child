// 工单 09（spec D4）：成果修复回合 outcome_repair。
// Seam 1：orchestrator 的派发加 runItem，跑在真实 SQLite 上。派发走 daemon 的真实入口 spawnClaimedItem。
// runtime 是脚本化的回放 runtime：每次启动按顺序回放一份构造的录制，并记下启动请求。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentToolHandlers } from "@pi-lead-child/engine";
import { runItem } from "@pi-lead-child/engine";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { recoverOrphans } from "../src/server.js";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { spawnClaimedItem, runningChildren, type LeadDeps } from "@pi-lead-child/lead";
import { createOrchestrator, type Orchestrator } from "@pi-lead-child/engine";
import { registerOutcomeForRun, repairOutcomeSnapshots } from "@pi-lead-child/engine";
import { planOutcomeRepair, requestOutcomeRepair } from "@pi-lead-child/engine";
import { reregisterFinishedRuns } from "@pi-lead-child/engine";
import { recordRegistrationPending } from "@pi-lead-child/engine";
import { recordTerminalHandoffFailure, repairTerminalHandoffFailures } from "@pi-lead-child/engine";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeEvent, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { getOutcomeSnapshotForRun } from "@pi-lead-child/store";
import { executorRetryBudget, hostOutcomeRegistrationHalt, outcomeRepairLimit } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import { readGatewayNotifications, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";

const SESSION = "claude-session-1";

// 成果信封。summary 必填；列表都给全，所以规范化后是完整的成果。
function envelope(summary: string): string {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary,
    changes: [{ kind: "file", ref: "src/feature.ts", summary: "Implemented the feature" }],
    deliverables: [{ kind: "path", ref: "src/feature.ts", label: "feature" }],
    validations: [{ command: "npm test", outcome: "passed", exitCode: 0, summary: "suite passes", evidenceRef: null }],
  })}`;
}

// 历史上 runs 53、54 的样子：agent 干完了，最后一条消息里有成果信封，但没有调用 ticket_update。
function finishedWithoutHandoff(): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    {
      type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn",
      text: `All three fixes are implemented and verified.\n\n${envelope("Implemented the feature")}`,
    },
    { type: "run.completed", exitCode: 0 },
  ];
}

// 修复回合的录制：agent resume 原来的 session，只补交成果。
function repairTurn(text: string): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "message.completed", messageId: "m-r", role: "assistant", stopReason: "end_turn", text },
    { type: "run.completed", exitCode: 0 },
  ];
}

interface HarnessOptions {
  resume?: boolean;
  // 在 runtime 启动时运行，用来观察或操作正在进行的 Run。
  onStart?: (request: RuntimeStartRequest) => Promise<void>;
}

class ScriptedRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities: RuntimeCapabilities;
  readonly requests: RuntimeStartRequest[] = [];
  readonly stageAtStart: string[] = [];

  constructor(
    private readonly db: Db,
    private readonly recordings: RecordedEvent[][],
    private readonly options: HarnessOptions = {},
  ) {
    this.capabilities = { ...new ClaudeRuntime().capabilities, resume: options.resume ?? true };
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    this.stageAtStart.push(getItem(this.db, request.itemId)!.stage);
    await this.options.onStart?.(request);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events }).start(request);
  }
}

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-outcome-repair-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
  delete process.env.PLC_OUTCOME_REPAIR_LIMIT;
});

function harness(recordings: RecordedEvent[][], options: HarnessOptions = {}) {
  const runtime = new ScriptedRuntime(db, recordings, options);
  const deps: LeadDeps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir,
    runtimeRegistry: new RuntimeRegistry([runtime]),
  };
  const orchestrator: Orchestrator = createOrchestrator(db, {
    dataDir: dir,
    onDispatch: (claim) => { spawnClaimedItem(deps, claim); },
  });
  const itemId = createItem(db, { title: "repair me", brief: "implement the feature", createdBy: "system", runtime: "claude" });
  orchestrator.dispatcher.request({
    itemId, role: "executor", purpose: "execution", runtime: "claude",
    trigger: "test", idempotencyKey: `test-execution:${itemId}`,
  });
  // 一轮派发，然后等派出去的 child 全部结束。
  const tick = async (): Promise<void> => {
    await orchestrator.tick();
    await vi.waitFor(() => expect(runningChildren().size).toBe(0));
  };
  return { runtime, itemId, tick };
}

function runsOf(itemId: number) {
  return db.prepare(
    "SELECT id, purpose, state, resumed_from_run_id, metadata FROM runs WHERE item_id=? ORDER BY id",
  ).all(itemId) as Array<{ id: number; purpose: string; state: string; resumed_from_run_id: number | null; metadata: string }>;
}

function blockerCodes(): string[] {
  return listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload).blockerCode as string);
}

describe("outcome repair turn (spec D4)", () => {
  it("resumes the session after a missed handoff, registers the outcome and retracts the blocker", async () => {
    const statusChange: string[] = [];
    const { runtime, itemId, tick } = harness([
      finishedWithoutHandoff(),
      repairTurn(`Here is the outcome of the work I already did.\n${envelope("Implemented the feature (repaired)")}`),
    ], {
      // 修复回合里，agent 想通过 ticket_update 自己把工单拉回 active。修复回合不能改变 stage。
      onStart: async (request) => {
        if (request.purpose !== "outcome_repair") return;
        const tools = createAgentToolHandlers({ db, itemId: request.itemId, runId: request.runId });
        await tools.call("ticket_update", { status: "active", reason: "resume" })
          .then(() => statusChange.push("accepted"), (error: unknown) => statusChange.push(String(error)));
        // 用户在界面上看到的：工单仍是 blocked，正在进行的是一次恢复，不是新的执行。
        const [ticket] = await readGatewayTickets(db);
        statusChange.push(ticket!.stage, `${ticket!.executionState?.kind}: ${ticket!.executionState?.label}`);
      },
    });

    await tick();
    // 旧代码到这里就停了：工单停在 blocked，带着「运行结束，交接失败」，没有任何自动补救。
    const [source] = runsOf(itemId);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);

    await tick();

    const runs = runsOf(itemId);
    expect(runs.map((run) => [run.purpose, run.state, run.resumed_from_run_id])).toEqual([
      ["execution", "finished", null],
      ["outcome_repair", "finished", source!.id],
    ]);
    // 修复回合 resume 原来的外部 session，提示里有诊断和成果 schema。
    const repairStart = runtime.requests[1]!;
    expect(repairStart).toMatchObject({ purpose: "outcome_repair", role: "executor", resumeSessionId: SESSION });
    expect(repairStart.prompt).toContain("运行结束，交接失败");
    expect(repairStart.prompt).toContain("PLC_OUTCOME_V1");
    expect(repairStart.prompt).toContain("\"validations\"");
    // 修复回合开始时，工单还在 blocked。修复回合里 agent 也不能改变 stage。
    expect(runtime.stageAtStart).toEqual(["active", "blocked"]);
    expect(statusChange).toEqual([expect.stringMatching(/outcome repair run/), "blocked", "recovery: 成果修复 · 启动中"]);

    // 成果登记在来源 Run 上，blocker 撤回，stage 按现有规则推进到 review。
    expect(getOutcomeSnapshotForRun(db, source!.id)).toMatchObject({
      summary: "Implemented the feature (repaired)", completeness: "complete", source: "system_recovered",
    });
    expect(blockerCodes()).toEqual([]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    // 线上契约没有 outcome_repair。修复回合按它延续的执行投影成 execution。
    const control = createControlPlaneService(db, { runtime: () => ({
      model: "stub/model", sessionId: "stub", busy: false, runningItemIds: [], aish: null,
    }) });
    expect(control.listRuns(itemId).map((run) => run.purpose)).toEqual(["execution", "execution"]);
  });

  it("keeps the original blocker and stage when the repair turn returns no outcome, and repairs only once", async () => {
    const { runtime, itemId, tick } = harness([
      finishedWithoutHandoff(),
      repairTurn("I could not find anything to report."),
    ]);

    await tick();
    await tick();
    await tick();

    const runs = runsOf(itemId);
    expect(runs.map((run) => [run.purpose, run.state])).toEqual([
      ["execution", "finished"],
      ["outcome_repair", "finished"],
    ]);
    expect(JSON.parse(runs[1]!.metadata).outcomeRepair).toMatchObject({
      state: "failed", sourceRunId: runs[0]!.id, reason: "no_envelope",
    });
    // 修复失败：原来的 blocker 保留，没有新的 blocker，stage 不变，成果没有登记。
    // 交接失败先交给 Lead（2026-10-15 起），用户不收通知。
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(getOutcomeSnapshotForRun(db, runs[0]!.id)).toBeUndefined();
    // 修复额度默认每个执行 Run 一次。用完以后，不再新建修复 Run，也不再排修复请求。
    expect(runtime.requests).toHaveLength(2);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM dispatch_requests WHERE state IN ('pending','claimed','started')",
    ).get()).toEqual({ n: 0 });
  });

  it("lets a configured repair limit allow a second repair turn after a failed one", async () => {
    process.env.PLC_OUTCOME_REPAIR_LIMIT = "2";
    try {
      const { runtime, itemId, tick } = harness([
        finishedWithoutHandoff(),
        repairTurn("Not sure what to report."),
        repairTurn(envelope("Implemented the feature")),
      ]);

      for (let round = 0; round < 4; round++) await tick();

      const runs = runsOf(itemId);
      expect(runs.map((run) => [run.purpose, run.resumed_from_run_id])).toEqual([
        ["execution", null],
        ["outcome_repair", runs[0]!.id],
        ["outcome_repair", runs[0]!.id],
      ]);
      // 每个修复回合都 resume 来源 Run 的 session。
      expect(runtime.requests.slice(1).map((request) => request.resumeSessionId)).toEqual([SESSION, SESSION]);
      expect(getItem(db, itemId)!.stage).toBe("review");
      expect(blockerCodes()).toEqual([]);
    } finally {
      delete process.env.PLC_OUTCOME_REPAIR_LIMIT;
    }
  });

  it("does not charge the execution retry budget or raise a new blocker when the repair run crashes", async () => {
    const { itemId, tick } = harness([
      finishedWithoutHandoff(),
      [
        { type: "run.started", runtime: "claude", model: null },
        { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
        { type: "run.failed", exitCode: 1, errorCode: "error_max_turns", error: "Reached maximum number of turns" },
      ],
    ]);

    await tick();
    await tick();
    await tick();

    const runs = runsOf(itemId);
    expect(runs.map((run) => [run.purpose, run.state])).toEqual([
      ["execution", "finished"],
      ["outcome_repair", "failed"],
    ]);
    expect(JSON.parse(runs[1]!.metadata).outcomeRepair).toMatchObject({ state: "failed", reason: "run_failed" });
    // 修复回合的失败是 task 作用域，但修复额度和执行重试额度分开计算。
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);
    expect(await readGatewayNotifications(db)).toEqual([]);
  });

  // 工单 #66：resume 的会话可能已经被 CLI 按保留期删掉。修复回合只能在来源 Run 的会话里补交成果，
  // 新会话不知道来源 Run 做了什么，所以内核不为它开新会话。修复额度还有剩余时，也不再排下一个修复回合：
  // 它 resume 的还是那个不存在的会话。原来的 blocker 保留，失败的原因写清楚。
  it("does not open a fresh session or queue another repair when the source session has expired", async () => {
    process.env.PLC_OUTCOME_REPAIR_LIMIT = "2";
    const { runtime, itemId, tick } = harness([
      finishedWithoutHandoff(),
      [
        { type: "run.started", runtime: "claude", model: null },
        {
          type: "run.failed", exitCode: 1, errorCode: "claude_error_during_execution",
          error: `No conversation found with session ID: ${SESSION}`,
        },
      ],
    ]);

    for (let round = 0; round < 4; round++) await tick();

    const runs = runsOf(itemId);
    expect(runs.map((run) => [run.purpose, run.state])).toEqual([
      ["execution", "finished"],
      ["outcome_repair", "failed"],
    ]);
    expect(runtime.requests.map((request) => request.resumeSessionId ?? null)).toEqual([null, SESSION]);
    expect(JSON.parse(runs[1]!.metadata).outcomeRepair).toMatchObject({ state: "failed", reason: "session_expired" });
    expect(getRun(db, runs[1]!.id)).toMatchObject({ failure_code: "session_not_found" });
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);
  });

  it("never triggers a repair turn on a runtime without resume", async () => {
    const { runtime, itemId, tick } = harness([finishedWithoutHandoff()], { resume: false });

    await tick();
    await tick();

    expect(runsOf(itemId).map((run) => run.purpose)).toEqual(["execution"]);
    expect(runtime.requests).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE purpose='outcome_repair'").get())
      .toEqual({ n: 0 });
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);
  });

  it("repairs an invalid outcome envelope even though the host-defect gate halts re-execution", async () => {
    const { itemId, tick } = harness([
      [
        { type: "run.started", runtime: "claude", model: null },
        { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
        { type: "tool.started", callId: "tu-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
        { type: "tool.failed", callId: "tu-1", name: "mcp__plc__ticket_update", error: "lost receipt" },
        { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: envelope("") },
        { type: "run.completed", exitCode: 0 },
      ],
      repairTurn(envelope("Implemented the feature")),
    ]);

    await tick();
    const [source] = runsOf(itemId);
    expect(blockerCodes()).toEqual(["invalid_outcome_envelope"]);
    expect(hostOutcomeRegistrationHalt(db, itemId)).toEqual({ runId: source!.id });

    await tick();

    expect(runsOf(itemId).map((run) => run.purpose)).toEqual(["execution", "outcome_repair"]);
    expect(getOutcomeSnapshotForRun(db, source!.id)).toMatchObject({ summary: "Implemented the feature" });
    expect(blockerCodes()).toEqual([]);
    expect(hostOutcomeRegistrationHalt(db, itemId)).toBeNull();
    expect(getItem(db, itemId)!.stage).toBe("review");
  });

  // 「Outcome registration missing」的样本（工单 #66）：工单到了 review，但成果没有登记。
  // 今天 ticket_update 把快照和 review 一起写，所以活跃路径上很难再出现。这里在 Run 进行中直接把 stage 推到 review，
  // 重现当时的状态：Run 结束时，自我恢复失败，工单从 review 退回 blocked。
  it("repairs an outcome that went missing after the item reached review", async () => {
    const { itemId, tick } = harness([
      [
        { type: "run.started", runtime: "claude", model: null },
        { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
        { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: "Done." },
        { type: "run.completed", exitCode: 0 },
      ],
      repairTurn(envelope("Implemented the feature")),
    ], {
      onStart: async (request) => {
        if (request.purpose === "execution") {
          transition(db, { itemId: request.itemId, to: "review", actor: "child", reason: "legacy handoff without outcome" });
        }
      },
    });

    await tick();
    const [source] = runsOf(itemId);
    expect(blockerCodes()).toEqual(["outcome_registration_missing"]);
    expect(getItem(db, itemId)!.stage).toBe("blocked");

    await tick();

    expect(runsOf(itemId).map((run) => run.purpose)).toEqual(["execution", "outcome_repair"]);
    expect(getOutcomeSnapshotForRun(db, source!.id)).toMatchObject({ summary: "Implemented the feature" });
    expect(blockerCodes()).toEqual([]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("review");
  });

  // 新的 purpose 值不需要迁移：runs 和 dispatch_requests 的 purpose 列上没有 CHECK。
  // 旧库的这两列由 addColumn 以同样的定义补上，所以旧库也一样。
  it("stores the new purpose without a migration", () => {
    for (const table of ["runs", "dispatch_requests"]) {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
      expect(sql).toMatch(/\bpurpose\s+TEXT NOT NULL[^,]*,/);
      expect(sql).not.toMatch(/CHECK\s*\([^)]*\bpurpose\b/);
    }
  });

  it("cancels a queued repair once the outcome is registered another way", async () => {
    const { runtime, itemId, tick } = harness([finishedWithoutHandoff()]);

    await tick();
    const [source] = runsOf(itemId);
    // lead 先按 register_run_outcome 登记了成果。排着的修复回合因此过时。
    expect(registerOutcomeForRun(db, { itemId, runId: source!.id, authorityRef: "lead" }).status).toBe("registered");
    await tick();

    expect(runsOf(itemId).map((run) => run.purpose)).toEqual(["execution"]);
    expect(runtime.requests).toHaveLength(1);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE purpose='outcome_repair'").all())
      .toEqual([{ state: "cancelled" }]);
    // 取消的修复请求不再出现在工单的执行状态里。
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.executionState).toBeUndefined();
  });
});

// 直接在库里搭出来的状态：一个已经结束的执行 Run。
// stage 为 blocked 时，它的交接检查失败了：工单停在 blocked，挂着「运行结束，交接失败」。
function finishedSourceRun(options: { stage?: "blocked" | "active"; session?: string | null } = {}) {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system", runtime: "claude" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const sourceRunId = createRun(db, { itemId, runtime: "claude" });
  const session = options.session === undefined ? SESSION : options.session;
  updateRun(db, sourceRunId, {
    state: "finished", endedAt: true, exitCode: 0, ...(session ? { externalSessionId: session } : {}),
  });
  if ((options.stage ?? "blocked") === "blocked") recordTerminalHandoffFailure(db, { itemId, runId: sourceRunId });
  return { itemId, sourceRunId };
}

function repairRun(itemId: number, sourceRunId: number, state: "starting" | "finished" = "finished"): number {
  const runId = createRun(db, { itemId, runtime: "claude", purpose: "outcome_repair", resumedFromRunId: sourceRunId });
  if (state === "finished") {
    updateRun(db, runId, {
      state: "finished", endedAt: true, exitCode: 0,
      metadata: { outcomeRepair: { state: "failed", reason: "no_envelope" } },
    });
  }
  return runId;
}

// 决策边界：什么时候排修复回合。闸门之外的条件在这里：触发的 blocker、resume、session、额度、已有请求。
describe("planOutcomeRepair", () => {
  afterEach(() => { delete process.env.PLC_OUTCOME_REPAIR_LIMIT; });

  it("plans one repair for a finished run whose handoff failed", () => {
    const { sourceRunId } = finishedSourceRun();
    expect(planOutcomeRepair(db, { sourceRunId, resume: true })).toMatchObject({
      eligible: true, sourceRunId, attempt: 1, limit: 1, diagnosis: expect.stringContaining("运行结束，交接失败"),
    });
  });

  it("does not plan a repair on a runtime without resume or without an external session", () => {
    expect(planOutcomeRepair(db, { sourceRunId: finishedSourceRun().sourceRunId, resume: false }))
      .toEqual({ eligible: false, reason: "resume_unsupported" });
    expect(planOutcomeRepair(db, { sourceRunId: finishedSourceRun({ session: null }).sourceRunId, resume: true }))
      .toEqual({ eligible: false, reason: "no_session" });
  });

  it("does not plan a repair for a host defect alone", () => {
    const { itemId, sourceRunId } = finishedSourceRun({ stage: "active" });
    recordRegistrationPending(db, { itemId, runId: sourceRunId, step: "handoff_check", error: new Error("exploded") });
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(planOutcomeRepair(db, { sourceRunId, resume: true })).toEqual({ eligible: false, reason: "no_outcome_failure" });
  });

  it("does not plan a repair once a newer execution run exists", () => {
    const { itemId, sourceRunId } = finishedSourceRun();
    createRun(db, { itemId, runtime: "claude" });
    expect(planOutcomeRepair(db, { sourceRunId, resume: true })).toMatchObject({
      eligible: false, reason: "not_repairable", detail: expect.stringMatching(/not the latest execution run/),
    });
  });

  it("does not plan a second repair while one is queued, or after the budget is used", () => {
    const { sourceRunId } = finishedSourceRun();
    expect(requestOutcomeRepair(db, { sourceRunId, resume: true })).toEqual(expect.any(Number));
    expect(planOutcomeRepair(db, { sourceRunId, resume: true })).toEqual({ eligible: false, reason: "already_requested" });

    const other = finishedSourceRun();
    repairRun(other.itemId, other.sourceRunId);
    expect(planOutcomeRepair(db, { sourceRunId: other.sourceRunId, resume: true }))
      .toEqual({ eligible: false, reason: "budget_exhausted" });
  });

  it("reads the repair limit from PLC_OUTCOME_REPAIR_LIMIT and turns repairs off at 0", () => {
    expect(outcomeRepairLimit({})).toBe(1);
    expect(outcomeRepairLimit({ PLC_OUTCOME_REPAIR_LIMIT: "0" })).toBe(0);
    expect(outcomeRepairLimit({ PLC_OUTCOME_REPAIR_LIMIT: "3" })).toBe(3);
    expect(outcomeRepairLimit({ PLC_OUTCOME_REPAIR_LIMIT: "9" })).toBe(5);
    expect(outcomeRepairLimit({ PLC_OUTCOME_REPAIR_LIMIT: "-1" })).toBe(1);
    expect(outcomeRepairLimit({ PLC_OUTCOME_REPAIR_LIMIT: "two" })).toBe(1);
    process.env.PLC_OUTCOME_REPAIR_LIMIT = "0";
    expect(planOutcomeRepair(db, { sourceRunId: finishedSourceRun().sourceRunId, resume: true }))
      .toEqual({ eligible: false, reason: "budget_exhausted" });
  });
});

// 修复回合和重启、启动修复的交界。生命周期改动要覆盖完整的落库流程（AGENTS.md）。
describe("outcome repair across restarts and startup repairs", () => {
  it("keeps the stage and starts no second repair after a daemon restart interrupts one", () => {
    const { itemId, sourceRunId } = finishedSourceRun({ stage: "active" });
    const dispatcher = createDispatcher(db);
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "outcome_repair", runtime: "claude", resumeFromRunId: sourceRunId,
      trigger: "outcome-repair", idempotencyKey: `outcome-repair:${sourceRunId}:1`,
    });
    const claim = dispatcher.claimNext()!;
    dispatcher.markStarted(claim);
    expect(claim).toMatchObject({ requestId, purpose: "outcome_repair", resumeFromRunId: sourceRunId });

    recoverOrphans(db);

    // 回收修复回合不改变工单的 stage。
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(getRun(db, claim.runId)!.state).toBe("failed");
    // 请求交回了队列，但修复额度已经用掉。闸门拒绝它，请求被取消，不再新建修复 Run。
    expect(dispatcher.claimNext()).toBeNull();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "cancelled" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE purpose='outcome_repair'").get()).toEqual({ n: 1 });
  });

  it("keeps the stage when a repair run hits an unhandled exception", async () => {
    const { itemId, sourceRunId } = finishedSourceRun({ stage: "active" });
    const runId = repairRun(itemId, sourceRunId, "starting");
    // 事件属于另一个 Run：runItem 在运行边界抛出未捕获的异常。
    const broken: AgentRuntime = {
      id: "claude",
      capabilities: new ClaudeRuntime().capabilities,
      async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
        const stray: RuntimeEvent = {
          type: "run.started", runtime: "claude", model: null,
          runId: request.runId + 1_000, seq: 1, occurredAt: new Date().toISOString(),
        };
        return {
          pid: null,
          events: (async function* () { yield stray; })(),
          interrupt: async () => {},
          wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
        };
      },
    };

    await expect(runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
      prompt: "repair", role: "executor", purpose: "outcome_repair", runId, runtime: broken, lingerMs: 0,
    })).rejects.toThrow(/belongs to run/);

    expect(getRun(db, runId)!.state).toBe("failed");
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("re-registers a repair whose registration hit a host error once the host is fixed", async () => {
    // 额度允许第二个修复回合。宿主缺陷照样不排：重跑 agent 修不好宿主。
    process.env.PLC_OUTCOME_REPAIR_LIMIT = "2";
    db.exec(`
      CREATE TRIGGER fail_outcome_store BEFORE INSERT ON outcome_snapshots
      BEGIN SELECT RAISE(FAIL, 'outcome store exploded'); END;
    `);
    const { runtime, itemId, tick } = harness([finishedWithoutHandoff(), repairTurn(envelope("Implemented the feature"))]);
    await tick();
    await tick();
    await tick();

    const [source, repair] = runsOf(itemId);
    expect(JSON.parse(repair!.metadata).outcomeRepair).toMatchObject({ state: "failed", reason: "host_error" });
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(blockerCodes()).toEqual(["terminal_handoff_failed"]);
    // 宿主缺陷不再排新的修复回合。
    expect(runtime.requests).toHaveLength(2);

    // 宿主修好以后，启动时的重新登记用修复回合留下的信封登记，不重跑 agent（spec D3）。
    db.exec("DROP TRIGGER fail_outcome_store");
    expect(reregisterFinishedRuns(db).outcomeRepairs).toEqual([
      expect.objectContaining({ status: "repaired", repairRunId: repair!.id, sourceRunId: source!.id }),
    ]);
    expect(getOutcomeSnapshotForRun(db, source!.id)).toMatchObject({ summary: "Implemented the feature" });
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(blockerCodes()).toEqual([]);
    expect(reregisterFinishedRuns(db).outcomeRepairs).toEqual([]);
    expect(runtime.requests).toHaveLength(2);
    delete process.env.PLC_OUTCOME_REPAIR_LIMIT;
  });

  it("keeps the source run, not the repair run, in scope of the startup re-registration", () => {
    const { itemId, sourceRunId } = finishedSourceRun({ stage: "active" });
    recordRegistrationPending(db, { itemId, runId: sourceRunId, step: "handoff_check", error: new Error("exploded") });
    repairRun(itemId, sourceRunId);

    expect(reregisterFinishedRuns(db).results.map((result) => result.runId)).toEqual([sourceRunId]);
  });

  it("does not let the startup outcome repair register a failed repair run's own envelope", async () => {
    const { itemId, tick } = harness([
      [
        { type: "run.started", runtime: "claude", model: null },
        { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
        { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: "Done." },
        { type: "run.completed", exitCode: 0 },
      ],
      repairTurn(`PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Only a summary" })}`),
    ]);
    await tick();
    await tick();

    const [, repair] = runsOf(itemId);
    expect(JSON.parse(repair!.metadata).outcomeRepair).toMatchObject({ state: "failed", reason: "partial_outcome" });
    expect(repairOutcomeSnapshots(db)).toBe(0);
    expect(getOutcomeSnapshotForRun(db, repair!.id)).toBeUndefined();
    expect(getItem(db, itemId)!.stage).toBe("blocked");
  });

  it("backfills a missing handoff failure on the source run, not on the repair run", () => {
    const { itemId, sourceRunId } = finishedSourceRun({ stage: "active" });
    repairRun(itemId, sourceRunId);

    expect(repairTerminalHandoffFailures(db)).toBe(1);
    expect(listInbox(db, { severity: "blocker" }).map((row) => JSON.parse(row.payload))).toEqual([
      expect.objectContaining({ blockerCode: "terminal_handoff_failed", runId: sourceRunId }),
    ]);
  });
});

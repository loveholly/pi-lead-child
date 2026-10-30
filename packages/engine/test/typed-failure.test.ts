// 工单 02 的回归测试：类型化失败。
// 基线（提交 268fcd0 的验收回放）里，旧分类器把下面这些历史失败判成 task_failure 或
// 不可恢复，并扣了工单的重试额度。实际上没有一次是 agent 没完成任务。
// 期望值取自 spec D1 的映射表，逐条对照每次失败的原始证据。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { isLeadInternalNextStep } from "@pi-lead-child/store";
import { listCheckpoints } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { assertRunAllowed, executorRetryBudget, repairNonBudgetRetryExhaustion } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import type { RunPurpose } from "@pi-lead-child/core";
import { classifyFailure } from "@pi-lead-child/runtime";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedRun } from "@pi-lead-child/runtime/testing";

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

type Expected = [scope: string, retry: string, needs: string, code: string, evidence: string];
const modelUnsupported: Expected = ["runtime", "other_runtime", "config", "model_unsupported", "not supported"];
const extensionMissing: Expected = ["runtime", "never", "config", "extension_missing", "Extension path does not exist"];
const outOfCredits: Expected = ["account", "never", "refill", "out_of_credits", "out of credits"];
const oauthExpired: Expected = ["account", "never", "login", "auth_required", "OAuth session expired"];
const nodeTooOld: Expected = ["runtime", "never", "config", "interpreter_mismatch", "createZstdDecompress"];
const capacity: Expected = ["attempt", "backoff", "none", "provider_overloaded", "at capacity"];

const HISTORICAL: Array<[runId: number, expected: Expected]> = [
  [12, modelUnsupported], // Codex：ChatGPT 账号不支持该模型
  [13, modelUnsupported],
  [14, extensionMissing], // pi：扩展文件不存在
  [15, extensionMissing],
  [16, modelUnsupported],
  [23, extensionMissing],
  [34, outOfCredits], // reviewer：账号余额用完
  [35, outOfCredits],
  [36, outOfCredits],
  [39, ["runtime", "never", "config", "executable_missing", "ENOENT"]], // 找不到 codex 可执行文件
  [44, capacity],
  [46, oauthExpired], // Claude OAuth 过期
  [47, oauthExpired],
  [52, nodeTooOld], // pi 跑在过旧的 Node 上
  [55, capacity], // stderr 里的 refresh token 报错是噪声，终止错误才是原因
  [59, nodeTooOld],
  [62, ["runtime", "other_runtime", "config", "model_unsupported", "unknown provider for model"]], // 代理不认识该模型
  [63, oauthExpired],
  [64, ["attempt", "backoff", "none", "network_error", "waiting for network"]], // 断网
];

async function replayOnFreshDb(sample: FixtureRun): Promise<{ db: Db; itemId: number; runId: number }> {
  const dir = tempDir("plc-typed-failure-");
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: `replay ${sample.historicalRunId}`, brief: "b", createdBy: "user" });
  if (sample.role === "reviewer") {
    transition(db, { itemId, to: "active", actor: "system", reason: "replay setup" });
    transition(db, { itemId, to: "review", actor: "child", reason: "replay setup" });
  }
  const result = await runItem(db, itemId, {
    dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
    prompt: "historical failure replay", role: sample.role, purpose: sample.purpose,
    runtime: new ReplayRuntime(sample), model: sample.model ?? undefined, lingerMs: 0,
  });
  return { db, itemId, runId: result.runId };
}

describe("typed failure on historical samples", () => {
  it.each(HISTORICAL)("run %i keeps its typed failure and charges no retry budget", async (runId, expected) => {
    const { db, itemId, runId: replayedRunId } = await replayOnFreshDb(recording(runId));

    const [scope, retry, needs, code, evidence] = expected;
    const run = getRun(db, replayedRunId)!;
    expect(run.state).toBe("failed");
    expect({
      scope: run.failure_scope, retry: run.failure_retry, needs: run.failure_needs, code: run.failure_code,
    }).toEqual({ scope, retry, needs, code });
    expect(run.failure_evidence).toContain(evidence);
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    db.close();
  });
});

// 一次没有任何可识别证据的失败。它落在 unknown：照旧扣额度，并请 lead 判断。
const unrecognized: FixtureRun = {
  historicalRunId: 0, role: "executor", purpose: "execution", model: "gpt-5.5", runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: "Codex exited with code 1" },
  ],
};

describe("who the failure checkpoint asks to act", () => {
  // 期望的说明来自 spec D1 的 needs 列：登录、换模型、等瞬时故障过去。
  it.each([
    ["account", 46, "重新登录 Claude Code"],
    ["runtime", 12, "不支持这个模型"],
    ["attempt", 64, "瞬时失败"],
  ] as const)("a %s failure only explains what happens next", async (_scope, runId, explanation) => {
    const { db, itemId, runId: failedRunId } = await replayOnFreshDb(recording(runId));
    // 这次失败的检查点。瞬时失败从工单 06 起由内核退避重试，工单没有受阻，所以检查点是 progress。
    const checkpoint = listCheckpoints(db, { itemId }).items
      .find((item) => item.kind === "blocked" || (item.kind === "progress" && item.title !== "Run started"))!;
    // lead 收到的说明。账号和配置故障从工单 03 起记在健康账本上，lead 按故障收到一条 attention 说明。
    // 瞬时失败从工单 06 起由内核退避重试，lead 收到一条 attention 说明。两者都不再按 Run 收到 blocker。
    const note = listInbox(db)
      .map((row) => JSON.parse(row.payload) as { blocker?: boolean; kind?: string; nextStep?: string })
      .find((payload) => payload.blocker || payload.kind === "runtime_incident" || payload.kind === "transient_retry")!;

    expect(checkpoint.nextStep).toContain("不扣工单的重试额度");
    for (const nextStep of [checkpoint.nextStep!, note.nextStep!]) {
      expect(nextStep).toContain(explanation);
      expect(nextStep).not.toMatch(/recover_ticket_run|retry/i);
      expect(isLeadInternalNextStep(nextStep)).toBe(false);
    }
    expect(checkpoint.runId).toBe(failedRunId);
    db.close();
  });

  it("an unknown failure still asks Lead to decide and charges the retry budget", async () => {
    const { db, itemId } = await replayOnFreshDb(unrecognized);
    const checkpoint = listCheckpoints(db, { itemId }).items.find((item) => item.kind === "blocked")!;
    const blocker = JSON.parse(listInbox(db, { severity: "blocker" })[0]!.payload) as { nextStep: string };

    expect(checkpoint.nextStep).toMatch(/retry/i);
    expect(isLeadInternalNextStep(blocker.nextStep)).toBe(true);
    expect(executorRetryBudget(db, itemId).failures).toBe(1);
    db.close();
  });
});

// Seam 1 的完整落库流程：编排器派发、dispatcher claim、runItem 运行，真实 SQLite。
// 历史工单 51：两次账号余额用完，然后找不到 codex。旧代码扣光了额度，第三个请求被取消。
// 工单 03 起，第一次余额故障让 Codex profile 进入 unavailable：后两个请求挂起，不再创建 Run。
describe("dispatching through account and configuration failures", () => {
  it("creates only the first run and leaves the retry budget untouched", async () => {
    const dir = tempDir("plc-typed-failure-dispatch-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "item 51", brief: "b", createdBy: "user" });
    let pending: FixtureRun | null = null;
    const orchestrator = createOrchestrator(db, {
      dataDir: dir,
      maxDispatchPerTick: 1,
      onDispatch: async (claim) => {
        const sample = pending!;
        pending = null;
        await runItem(db, claim.itemId, {
          dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`),
          prompt: "replay", role: claim.role, purpose: claim.purpose, runId: claim.runId,
          runtime: new ReplayRuntime(sample), model: claim.model ?? undefined, lingerMs: 0,
        });
      },
    });

    for (const runId of [35, 36, 39]) {
      pending = recording(runId);
      orchestrator.dispatcher.request({
        itemId, role: "executor", purpose: "execution", runtime: "codex", model: "gpt-5.5",
        trigger: "test", idempotencyKey: `replay:${runId}`,
      });
      await orchestrator.tick();
      await orchestrator.tick();
    }

    const runs = db.prepare(
      "SELECT state, failure_scope AS scope, failure_code AS code FROM runs WHERE item_id=? ORDER BY id",
    ).all(itemId);
    expect(runs).toEqual([
      { state: "failed", scope: "account", code: "out_of_credits" },
    ]);
    expect(db.prepare(
      "SELECT trigger, state, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests WHERE item_id=? ORDER BY id",
    ).all(itemId)).toEqual([
      { trigger: "test", state: "failed", suspended: 0 },
      { trigger: "runtime-health-retry", state: "pending", suspended: 1 },
      { trigger: "test", state: "pending", suspended: 1 },
      { trigger: "test", state: "pending", suspended: 1 },
    ]);
    expect(executorRetryBudget(db, itemId)).toMatchObject({ failures: 0, exhausted: false });
    expect(getItem(db, itemId)).toMatchObject({ stage: "active", plan_state: "none" });
    db.close();
  });
});

// Run #183（2026-10-29）：pi 核查员的回答被 provider 的内容过滤拦下（pi-ai 写成 "Provider finish_reason: content_filter"）。
// 以前落进 unknown：不自动重试，还扣工单的重试额度。内容过滤常常是误判，再来一次往往就过：它是这一次尝试的失败，
// 内核退避后自动重试。完整的落库流程：runItem 记下失败，排一条退避重试。
describe("an answer blocked by the provider's content filter", () => {
  const RUN_183: FixtureRun = {
    historicalRunId: 183, role: "reviewer", purpose: "review", model: "vibeproxy/gemini-3-pro", runtime: "pi",
    events: [
      { type: "run.started", runtime: "pi", model: "vibeproxy/gemini-3-pro" },
      { type: "run.failed", exitCode: null, errorCode: "llm_error", error: "Provider finish_reason: content_filter" },
    ],
  };

  it("is an attempt failure that the kernel retries with backoff, without the retry budget", async () => {
    const { db, itemId, runId } = await replayOnFreshDb(RUN_183);
    const run = getRun(db, runId)!;
    expect({ scope: run.failure_scope, retry: run.failure_retry, needs: run.failure_needs, code: run.failure_code })
      .toEqual({ scope: "attempt", retry: "backoff", needs: "none", code: "content_filtered" });
    expect(executorRetryBudget(db, itemId).failures).toBe(0);
    expect(db.prepare("SELECT role, purpose, trigger, state FROM dispatch_requests WHERE item_id=?").all(itemId))
      .toEqual([{ role: "reviewer", purpose: "review", trigger: "transient-retry", state: "pending" }]);
    expect(listInbox(db, { severity: "blocker" })).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("review");
    db.close();
  });
});

// Run #164（2026-10-29）：Claude Code 版本太旧，不认这个模型。以前落进 unknown：不进健康账本，还扣工单的重试额度。
// 它和「账号不支持这个模型」一样是 model_unsupported：换 runtime 或升级 CLI 才能好。
describe("a Claude Code too old for the model", () => {
  const RUN_164 = "API Error: 400 Claude Code 2.1.258 does not support this model; version 2.1.280 or newer is required.";

  it.each(["claude_result_error", "claude_exit"])("is model_unsupported when the adapter reports %s", (errorCode) => {
    expect(classifyFailure("claude", { errorCode, message: RUN_164 }))
      .toMatchObject({ code: "model_unsupported", scope: "runtime", retry: "other_runtime", needs: "config" });
  });
});

// 证据会落库，也会出现在诊断里。组织的安全规范不允许凭据进日志，所以证据里的凭据要脱敏。
describe("failure evidence", () => {
  it("redacts credentials before the evidence is stored", () => {
    const failure = classifyFailure("codex", {
      errorCode: "codex_error",
      message: "401 Unauthorized: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      stderr: 'api_key=sk-live-0123456789abcdefghij {"refresh_token": "rt-0123456789abcdef"}',
    });
    expect(failure.evidence).not.toMatch(/eyJhbGciOiJIUzI1NiJ9|sk-live-0123456789|rt-0123456789/);
    expect(failure.evidence).toContain("[redacted]");
    expect(failure.evidence).toContain("401 Unauthorized");
  });
});

// 启动修复的完整落库流程：v26 之前的库里，旧代码按旧规则扣光了额度，工单被停下。
// 升级后，daemon 启动时按 scope 规则重新判断。只解除确实不该停的工单，并且只修一次。
describe("startup repair of legacy retry exhaustion", () => {
  it("resumes a ticket that legacy account failures halted and keeps a real exhaustion halted", () => {
    const path = join(tempDir("plc-typed-failure-repair-"), "plc.db");
    const legacy = openDb(path);
    const halt = (title: string, message: string): number => {
      const itemId = createItem(legacy, { title, brief: "b", createdBy: "user", retryLimit: 1 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const runId = createRun(legacy, { itemId, runtime: "codex" });
        updateRun(legacy, runId, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: message });
      }
      legacy.prepare("UPDATE items SET stage='blocked', plan_state='failed' WHERE id=?").run(itemId);
      return itemId;
    };
    // 历史工单 51 的形状：两次账号余额用完，旧代码扣光额度。
    const credits = halt("item 51", "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.");
    const opaque = halt("opaque", "Codex exited with code 1");
    for (const column of ["failure_scope", "failure_retry", "failure_needs", "failure_code", "failure_evidence"]) {
      legacy.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    }
    legacy.prepare("DELETE FROM schema_migrations WHERE version=26").run();
    legacy.close();

    const db = openDb(path);
    expect(repairNonBudgetRetryExhaustion(db)).toBe(1);
    expect(getItem(db, credits)).toMatchObject({ stage: "blocked", plan_state: "none" });
    expect(() => assertRunAllowed(db, { itemId: credits, role: "executor", purpose: "execution" })).not.toThrow();
    expect(getItem(db, opaque)).toMatchObject({ stage: "blocked", plan_state: "failed" });
    expect(() => assertRunAllowed(db, { itemId: opaque, role: "executor", purpose: "execution" }))
      .toThrow(/重试已耗尽/);
    expect(repairNonBudgetRetryExhaustion(db)).toBe(0);
    db.close();
  });
});

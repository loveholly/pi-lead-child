// 换模型和推理强度、换执行 agent（工单 08，spec 5.3）。工单操作层的 set_run_profile 和 change_executor_runtime。
// 验收标准里的四条：
//   - 假的 Pi runtime：发出了 set_model 和 set_thinking_level，Run 没有中断（这里）。
//   - 假的 Claude 和 Codex runtime：新进程用同一个会话 id 和新的模型参数，新 Run 的 resumed_from_run_id 指向旧 Run
//     （packages/lead/test/run-profile-restart.test.ts，要经过 Lead 的 spawnClaimedItem）。
//   - 没有 Run 在跑时，下一次 Run 用新设置（这里）。
//   - 模型目录里没有的模型被拒绝（这里）。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ClaudeRuntime, type RuntimeHandle } from "@pi-lead-child/runtime";
import {
  addActivity, createItem, createRun, getItem, getReviewerSetting, getRun, listRuns, openDb, setReviewerSetting, transition,
  updateRun, type Db,
} from "@pi-lead-child/store";
import { liveChildren, runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { setModelCatalogForTesting, type ModelCatalog } from "../src/model-catalog.js";
import {
  reworkItem, runTicketAction, TICKET_ACTIONS, TicketActionError, type TicketActionCaller,
} from "../src/ticket-actions/index.js";

const FAKE_PI = resolve("node_modules/.bin/tsx");
const FAKE_PI_ARGS = [resolve("packages/runtime/testing/fake-pi.ts")];
const FAKE_CLAUDE = resolve("packages/runtime/testing/fake-claude.ts");
const USER: TicketActionCaller = { kind: "user" };

const CATALOG: ModelCatalog = {
  refreshedAt: "2026-10-22T02:00:00.000Z",
  runtimes: [
    {
      runtime: "claude", state: "known", source: "claude --help", account: null, freeformModelPattern: null,
      refreshedAt: "2026-10-22T02:00:00.000Z", error: null, cliDefaultModel: null, efforts: ["low", "medium", "high", "xhigh", "max"],
      models: [
        { id: "opus", label: "opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, note: null },
        { id: "sonnet", label: "sonnet", efforts: ["low", "medium", "high"], defaultEffort: null, note: null },
        { id: "haiku", label: "haiku", efforts: [], defaultEffort: null, note: "不支持 effort" },
      ],
    },
    {
      runtime: "codex", state: "known", source: "codex debug models", account: null, freeformModelPattern: null,
      refreshedAt: "2026-10-22T02:00:00.000Z", error: null, cliDefaultModel: "gpt-5.6", efforts: ["low", "medium", "high"],
      models: [{ id: "gpt-5.6", label: "gpt-5.6", efforts: ["low", "medium", "high"], defaultEffort: "medium", note: null }],
    },
    {
      runtime: "pi", state: "known", source: "pi --list-models", account: null, freeformModelPattern: null,
      refreshedAt: "2026-10-22T02:00:00.000Z", error: null, cliDefaultModel: null, efforts: ["off", "low", "medium", "high"],
      models: [
        { id: "openai/gpt-5.6", label: "openai/gpt-5.6", efforts: ["off", "low", "medium", "high"], defaultEffort: null, note: null },
        { id: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5", efforts: ["off", "low", "medium", "high"], defaultEffort: null, note: null },
      ],
    },
  ],
};

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-run-profile-");
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
  setModelCatalogForTesting(CATALOG);
});
afterEach(() => {
  setModelCatalogForTesting(null);
  liveChildren().clear();
  vi.unstubAllEnvs();
  db.close();
});

function ticket(runtime: "claude" | "codex" | "pi" = "claude", model: string | null = "opus"): number {
  const itemId = createItem(db, { title: "修复登录", brief: "修好登录。", createdBy: "lead" });
  db.prepare("UPDATE items SET requested_runtime=?, requested_model=? WHERE id=?").run(runtime, model, itemId);
  return itemId;
}

function act(itemId: number, action: string, input: Record<string, unknown>, reason?: string) {
  return runTicketAction(db, { itemId, action, input, caller: USER, ...(reason ? { reason } : {}) });
}

async function refusal(promise: Promise<unknown>): Promise<TicketActionError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TicketActionError);
  return error as TicketActionError;
}

function decisions(itemId: number, decision: string): Array<Record<string, unknown> & { actor: string }> {
  return (db.prepare(
    `SELECT actor, payload FROM activities WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=? ORDER BY id`,
  ).all(itemId, decision) as Array<{ actor: string; payload: string }>)
    .map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) as Record<string, unknown> }));
}

function request(id: number) {
  return db.prepare("SELECT runtime, model, effort, resume_from_run_id FROM dispatch_requests WHERE id=?").get(id);
}

describe("choosing a model and effort from the catalog", () => {
  it("refuses a model the catalog does not list, and changes nothing", async () => {
    const itemId = ticket();
    const error = await refusal(act(itemId, "set_run_profile", { role: "executor", model: "gpt-9" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("claude 的模型目录（claude --help）里没有 gpt-9");
    expect(getItem(db, itemId)!.requested_model).toBe("opus");
    expect(decisions(itemId, "run_profile_changed")).toEqual([]);
    expect(decisions(itemId, "execution_profile_selected")).toEqual([]);
  });

  it("refuses an effort the model does not take", async () => {
    const itemId = ticket();
    const error = await refusal(act(itemId, "set_run_profile", { role: "executor", model: "sonnet", effort: "max" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("sonnet 不认 effort=max。可选：low、medium、high");
  });

  it("drops the old effort to the CLI's default when only the model changes and the new model does not take it", async () => {
    const itemId = ticket();
    await act(itemId, "set_run_profile", { role: "executor", effort: "max" });
    const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "haiku" });
    expect(result).toMatchObject({
      from: { model: "opus", effort: "max" }, to: { model: "haiku", effort: null }, applied: "next_run",
      notes: ["haiku 不认原来的强度 max，强度改回 CLI 的默认。"],
    });
  });

  it("asks for at least one of model and effort", async () => {
    const error = await refusal(act(ticket(), "set_run_profile", { role: "executor" }));
    expect(error.code).toBe("invalid_input");
  });

  it("asks to choose the executor's agent first when the ticket has none yet", async () => {
    const itemId = createItem(db, { title: "没定 runtime", brief: "b", createdBy: "lead" });
    const error = await refusal(act(itemId, "set_run_profile", { role: "executor", model: "opus" }));
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(error.message).toContain("先选执行 agent（change_executor_runtime）");
  });

  it("waits for a starting run to start", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const run = createRun(db, { itemId, runtime: "claude" });
    for (const action of ["set_run_profile", "change_executor_runtime"]) {
      const input = action === "set_run_profile" ? { role: "executor", model: "sonnet" } : { runtime: "codex" };
      const error = await refusal(act(itemId, action, input));
      expect(error).toMatchObject({ code: "unavailable", message: `Run #${run} 正在启动，等它开始以后再换。` });
    }
  });

  // 2026-10-29：用户在执行 Run 启动时要换核查员的模型，以前也被拒。核查员的设置只影响以后的核查，不用等。
  it("does not make the reviewer's model wait for a starting run", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    createRun(db, { itemId, runtime: "claude" });
    setReviewerSetting(db, itemId, { runtime: "codex", chosenBy: "lead" });
    const { result } = await act(itemId, "set_run_profile", { role: "reviewer", model: "gpt-5.6", effort: "high" });
    expect(result).toMatchObject({ role: "reviewer", runtime: "codex", applied: "next_run", runId: null });
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "codex", model: "gpt-5.6", effort: "high" });
  });
});

describe("with no run in flight", () => {
  it("gives the next run the new model and effort, even when it resumes an older session", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const first = createRun(db, { itemId, runtime: "claude", model: "opus", effort: "xhigh" });
    updateRun(db, first, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare("UPDATE runs SET external_session_id='claude-session-1' WHERE id=?").run(first);
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });

    const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "sonnet", effort: "low" }, "这一步不需要 opus");
    expect(result).toMatchObject({
      role: "executor", runtime: "claude", from: { model: "opus", effort: "xhigh" }, to: { model: "sonnet", effort: "low" },
      changed: true, applied: "next_run", runId: null, dispatchRequestId: null,
    });
    expect(getItem(db, itemId)).toMatchObject({ requested_runtime: "claude", requested_model: "sonnet" });
    expect(decisions(itemId, "run_profile_changed")).toEqual([expect.objectContaining({
      actor: "user", role: "executor", from: { model: "opus", effort: "xhigh" }, to: { model: "sonnet", effort: "low" },
      applied: "next_run", reason: "这一步不需要 opus",
    })]);

    // 返工续接上一次交付的会话。以前它沿用那个会话原来的模型和强度（opus、xhigh）。
    reworkItem(db, itemId, "再改一下", { actor: "user" });
    const rework = db.prepare("SELECT id FROM dispatch_requests WHERE item_id=? AND trigger='user-rework'").get(itemId) as { id: number };
    expect(request(rework.id)).toEqual({ runtime: "claude", model: "sonnet", effort: "low", resume_from_run_id: first });
    const claim = createDispatcher(db).claimNext()!;
    expect(getRun(db, claim.runId)).toMatchObject({ model: "sonnet", effort: "low", resumed_from_run_id: first });
  });

  // 2026-10-29：pi 的目录里是 provider/名字，Lead 常只写名字。目录里恰好一个时按它解析，设置和排着的请求都写全名。
  it("resolves a pi model given without its provider to the catalog's full name", async () => {
    const itemId = ticket("pi", "openai/gpt-5.6");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const queued = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "pi", model: "openai/gpt-5.6",
      trigger: "test", idempotencyKey: "queued-pi",
    });
    const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "claude-sonnet-5-5" });
    expect(result).toMatchObject({ to: { model: "anthropic/claude-sonnet-5-5" }, retargetedDispatchRequestIds: [queued] });
    expect(getItem(db, itemId)!.requested_model).toBe("anthropic/claude-sonnet-5-5");
    expect(request(queued)).toMatchObject({ runtime: "pi", model: "anthropic/claude-sonnet-5-5" });
  });

  it("changes a queued run of the same role too", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const queued = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "claude", model: "opus", effort: "high",
      trigger: "test", idempotencyKey: "queued",
    });
    const { result } = await act(itemId, "set_run_profile", { role: "executor", effort: "low" });
    expect(result).toMatchObject({ retargetedDispatchRequestIds: [queued] });
    expect(request(queued)).toEqual({ runtime: "claude", model: "opus", effort: "low", resume_from_run_id: null });
  });

  it("writes the reviewer's setting and the queued review request", async () => {
    const itemId = ticket("claude");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const run = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, run, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    setReviewerSetting(db, itemId, { runtime: "codex", chosenBy: "lead" });
    const review = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger: "test", idempotencyKey: "review",
    });
    const { result } = await act(itemId, "set_run_profile", { role: "reviewer", model: "gpt-5.6", effort: "high" });
    expect(result).toMatchObject({ role: "reviewer", runtime: "codex", applied: "next_run", retargetedDispatchRequestIds: [review] });
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "codex", model: "gpt-5.6", effort: "high", chosenBy: "user" });
    expect(request(review)).toEqual({ runtime: "codex", model: "gpt-5.6", effort: "high", resume_from_run_id: null });
  });
});

describe("with a paused run", () => {
  it("changes the paused run, so it continues with the new model", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const run = createRun(db, { itemId, runtime: "claude", model: "opus", effort: "high" });
    updateRun(db, run, { state: "paused", sessionId: "s" });
    const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "sonnet" });
    expect(result).toMatchObject({ applied: "on_resume", runId: run, to: { model: "sonnet", effort: "high" } });
    expect(getRun(db, run)).toMatchObject({ state: "paused", model: "sonnet", effort: "high" });
    expect(listRuns(db, itemId)).toHaveLength(1);
  });
});

describe("changing the executor's runtime", () => {
  it("gives the next run the new runtime and its own model", async () => {
    const itemId = ticket("claude", "opus");
    const { result } = await act(itemId, "change_executor_runtime", { runtime: "codex", effort: "high" });
    expect(result).toMatchObject({
      from: { runtime: "claude", model: "opus" }, to: { runtime: "codex", model: null, effort: "high" }, applied: "next_run",
    });
    expect(getItem(db, itemId)).toMatchObject({ requested_runtime: "codex", requested_model: null });
    const next = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: "next",
    });
    // 没给模型：不带 claude 的 opus，由 Codex 自己的配置决定（model 为 null）。
    expect(request(next)).toEqual({ runtime: "codex", model: null, effort: "high", resume_from_run_id: null });
  });

  it("refuses the runtime it already has, a disabled runtime, and a model the new runtime does not offer", async () => {
    const itemId = ticket("claude");
    expect((await refusal(act(itemId, "change_executor_runtime", { runtime: "claude" }))).code).toBe("invalid_input");
    expect((await refusal(act(itemId, "change_executor_runtime", { runtime: "codex", model: "opus" }))).message)
      .toContain("codex 的模型目录（codex debug models）里没有 opus");
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const disabled = await refusal(act(itemId, "change_executor_runtime", { runtime: "codex" }));
    expect(disabled).toMatchObject({ code: "unavailable" });
    expect(disabled.message).toContain("用户在设置里停用了");
    expect(getItem(db, itemId)!.requested_runtime).toBe("claude");
  });

  it("is not available while the executor's run is paused", async () => {
    const itemId = ticket("claude");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const run = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, run, { state: "paused", sessionId: "s" });
    const error = await refusal(act(itemId, "change_executor_runtime", { runtime: "codex" }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain(`Run #${run} 暂停着`);
  });
});

describe("a pi run switches in place", () => {
  it("sends set_model and set_thinking_level and keeps the same run going", async () => {
    vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
    const itemId = ticket("pi", "anthropic/claude-sonnet-5-5");
    const commands = join(dir, "pi-commands.jsonl");
    const done = runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "do it", sessionDir: join(dir, "sessions"),
      effort: "low",
      env: { FAKE_SCENARIO: "hold_for_profile", FAKE_PI_COMMAND_LOG: commands },
    });
    // 第一次调用模型的用量落库以后再换：活动里要记下换的时候用了多少。
    await vi.waitFor(() => {
      const run = db.prepare("SELECT id FROM runs WHERE item_id=?").get(itemId) as { id: number } | undefined;
      expect(run).toBeDefined();
      expect(liveChildren().get(itemId)?.handle?.setProfile).toBeTypeOf("function");
      expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=? AND event_type='usage.updated'").get(run!.id))
        .toEqual({ n: 1 });
    }, { timeout: 15_000 });
    const runId = liveChildren().get(itemId)!.runId;

    const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "openai/gpt-5.6", effort: "high" });
    expect(result).toMatchObject({
      runtime: "pi", from: { model: "anthropic/claude-sonnet-5-5", effort: "low" }, to: { model: "openai/gpt-5.6", effort: "high" },
      applied: "in_run", runId, dispatchRequestId: null,
    });
    await done;

    const sent = readFileSync(commands, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sent).toContainEqual({ type: "set_model", message: null, provider: "openai", modelId: "gpt-5.6" });
    expect(sent).toContainEqual({ type: "set_thinking_level", message: null, level: "high" });
    // 同一个 Run 跑完了，没有被停下，也没有第二个 Run。下一次调用模型用的是新的模型和强度。
    expect(listRuns(db, itemId).map((run) => run.id)).toEqual([runId]);
    expect(getRun(db, runId)).toMatchObject({ state: "finished", exit_code: 0, model: "openai/gpt-5.6", effort: "high" });
    const answers = db.prepare(
      "SELECT json_extract(payload, '$.text') AS text FROM runtime_events WHERE run_id=? AND event_type='message.completed' ORDER BY seq",
    ).all(runId);
    expect(answers.at(-1)).toEqual({ text: "finished with openai/gpt-5.6 at high" });
    const [changed] = decisions(itemId, "run_profile_changed");
    expect(changed).toMatchObject({ applied: "in_run", runId, usageTokens: 150 });
    expect(changed!.atSeq).toBeGreaterThan(0);
    expect(existsSync(commands)).toBe(true);
  }, 30_000);

  // 回归：换过以后新的模型出了账号故障。故障要记在新的模型上，内核排的重试也用新的模型和强度，
  // 不能回到启动时的模型（manager.ts 以前用启动时记下的那一份）。
  it("records a failure after the switch against the new model, and retries with it", async () => {
    vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
    const itemId = ticket("pi", "anthropic/claude-sonnet-5-5");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const done = runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "do it", sessionDir: join(dir, "sessions"),
      effort: "low",
      env: { FAKE_SCENARIO: "hold_for_profile_then_fail" },
    });
    await vi.waitFor(() => {
      expect(liveChildren().get(itemId)?.handle?.setProfile).toBeTypeOf("function");
      expect(db.prepare("SELECT state FROM runs WHERE item_id=?").get(itemId)).toEqual({ state: "running" });
    }, { timeout: 15_000 });
    await act(itemId, "set_run_profile", { role: "executor", model: "openai/gpt-5.6", effort: "high" });
    const { runId } = await done;

    expect(getRun(db, runId)!.state).toBe("failed");
    expect(db.prepare("SELECT level, model FROM runtime_incidents").all()).toEqual([{ level: "model", model: "openai/gpt-5.6" }]);
    expect(db.prepare("SELECT model, effort FROM dispatch_requests WHERE trigger='runtime-health-retry'").all())
      .toEqual([{ model: "openai/gpt-5.6", effort: "high" }]);
  }, 30_000);
});

// ── 08 审查的修复 ─────────────────────────────────────────────────────────────────

// 一个在跑的 Run：库里是 running，有会话 id，live 表里是它的进程（假的）。interrupt 时记下当时排着的派发请求有几条。
function liveRun(itemId: number, runtime: "claude" | "codex", profile: { model: string; effort?: string }, interrupt?: () => Promise<void>) {
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId, runtime, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}) });
  updateRun(db, runId, { state: "running", sessionId: `${runtime}-session` });
  db.prepare("UPDATE runs SET external_session_id=? WHERE id=?").run(`${runtime}-session`, runId);
  const queuedAtInterrupt: number[] = [];
  const handle: RuntimeHandle = {
    pid: null,
    events: (async function* () {})(),
    interrupt: async () => {
      queuedAtInterrupt.push((db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId) as { n: number }).n);
      await interrupt?.();
    },
    wait: async () => ({ ok: false, exitCode: null, signal: "SIGTERM", externalSessionId: null, errorCode: null, errorMessage: null }),
  };
  liveChildren().set(itemId, { runId, handle, streaming: true });
  return { runId, queuedAtInterrupt };
}

describe("fixes from the review of ticket 08", () => {
  // 审查 1：被停下的 Claude Code 也报 run.failed（claude_interrupted）。以前它进了失败经验，换两次模型就建出一张
  // 「沉淀失败经验」工单。真的 lifecycle（runItem）加假的 Claude（linger：一直跑到收到信号）。
  it("does not learn from runs stopped for a model switch", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
    for (const n of [1, 2]) {
      const itemId = ticket("claude", "opus");
      transition(db, { itemId, to: "active", actor: "system", reason: "start" });
      const runtime = new ClaudeRuntime({ bin: FAKE_PI, prefixArgs: [FAKE_CLAUDE], env: { FAKE_CLAUDE_SCENARIO: "linger" } });
      const done = runItem(db, itemId, {
        dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, `sessions-${n}`), prompt: "do it",
        runtime, runtimeId: "claude", model: "opus", lingerMs: 0,
      });
      await vi.waitFor(() => {
        expect(db.prepare("SELECT state, external_session_id FROM runs WHERE item_id=?").get(itemId))
          .toEqual({ state: "running", external_session_id: "claude-session-1" });
      }, { timeout: 15_000 });
      const { result } = await act(itemId, "set_run_profile", { role: "executor", model: "sonnet" });
      expect(result).toMatchObject({ applied: "restarted" });
      const { runId } = await done;
      expect(getRun(db, runId)!.state).toBe("stopped");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM learning_candidates").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE title LIKE '沉淀失败经验%'").get()).toEqual({ n: 0 });
  }, 60_000);

  // 审查 2：成果修复回合续接来源 Run 的会话，只能在原来的 runtime 上跑。换执行 agent 不能把它改到新 runtime。
  it("leaves a queued outcome repair on its runtime when the executor's runtime changes", async () => {
    const itemId = ticket("claude", "opus");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const source = createRun(db, { itemId, runtime: "claude", model: "opus" });
    updateRun(db, source, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare("UPDATE runs SET external_session_id='claude-session' WHERE id=?").run(source);
    const dispatcher = createDispatcher(db);
    const repair = dispatcher.request({
      itemId, role: "executor", purpose: "outcome_repair", runtime: "claude", resumeFromRunId: source,
      trigger: "outcome-repair", idempotencyKey: "repair",
    });
    const execution = dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "claude", trigger: "test", idempotencyKey: "execution",
    });
    const { result } = await act(itemId, "change_executor_runtime", { runtime: "codex" });
    expect(result).toMatchObject({ retargetedDispatchRequestIds: [execution] });
    expect(request(repair)).toEqual({ runtime: "claude", model: "opus", effort: null, resume_from_run_id: source });
    expect(request(execution)).toMatchObject({ runtime: "codex" });
  });

  // 审查 3：停下旧 Run 和排续接的请求在一笔事务里，提交以后才停进程。以前先等进程退出再排请求：进程停不掉（或者等的时候
  // daemon 退出）时，Run 已经 stopped，续接的请求却没有排上，工单停在 active，没有 Run 接手。
  for (const action of ["set_run_profile", "change_executor_runtime"] as const) {
    it(`${action}: queues the follow-up run before stopping the process, and keeps it when the process does not stop`, async () => {
      const itemId = ticket("claude", "opus");
      const { runId, queuedAtInterrupt } = liveRun(itemId, "claude", { model: "opus" }, async () => { throw new Error("kill failed"); });
      const input = action === "set_run_profile" ? { role: "executor", model: "sonnet" } : { runtime: "codex" };
      const { result } = await act(itemId, action, input);
      const { dispatchRequestId, notes } = result as { dispatchRequestId: number; notes: string[] };
      expect(queuedAtInterrupt).toEqual([1]);
      expect(getRun(db, runId)!.state).toBe("stopped");
      expect(db.prepare("SELECT state, resume_from_run_id FROM dispatch_requests WHERE id=?").get(dispatchRequestId))
        .toEqual({ state: "pending", resume_from_run_id: runId });
      expect(notes).toContainEqual(expect.stringContaining(`Run #${runId} 的进程没有正常停下（kill failed）`));
    });
  }

  // 审查 4：模型目录未知时 validateModelChoice 不核对。CLI 不收的写法要在停下旧 Run 之前拒绝，否则新 Run 到认领时才报错。
  it("refuses what the CLI cannot take before it stops the run, even with an unknown catalog", async () => {
    setModelCatalogForTesting(null);
    const itemId = ticket("codex", "gpt-5.5");
    const interrupted: number[] = [];
    const { runId } = liveRun(itemId, "codex", { model: "gpt-5.5" }, async () => { interrupted.push(1); });
    const model = await refusal(act(itemId, "set_run_profile", { role: "executor", model: "anthropic/claude-x" }));
    expect(model).toMatchObject({ code: "invalid_input" });
    expect(model.message).toContain("runtime 'codex' cannot use model 'anthropic/claude-x'");
    const effort = await refusal(act(itemId, "set_run_profile", { role: "executor", effort: "Very High" }));
    expect(effort).toMatchObject({ code: "invalid_input", message: "invalid effort 'Very High'" });
    expect(getRun(db, runId)!.state).toBe("running");
    expect(interrupted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
  });

  // 审查 5：核查 Run 的 runtime 是认领时替补上来的时，换模型只换这个 Run，不把替补写成用户的选择。
  it("keeps the chosen reviewer when the review in flight runs on a stand-in", async () => {
    const itemId = ticket("claude");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const delivery = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    setReviewerSetting(db, itemId, { runtime: "codex", model: "gpt-5.6", effort: "high", chosenBy: "lead", reason: "brief 要求 Codex 核查" });
    // Codex 当时不能用，认领时换成了 Claude Code。核查暂停着。
    const review = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude", model: "opus" });
    updateRun(db, review, { state: "paused", sessionId: "s" });
    const { result } = await act(itemId, "set_run_profile", { role: "reviewer", model: "sonnet" });
    expect(result).toMatchObject({ runtime: "claude", applied: "on_resume", notes: [expect.stringContaining("核查员设置里选的是 Codex")] });
    expect(getRun(db, review)).toMatchObject({ model: "sonnet" });
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "codex", model: "gpt-5.6", effort: "high", chosenBy: "lead" });
  });

  // 审查 6：暂停时换过的模型，失败时也要算上。pi 在跑时 A→B，暂停后 B→C，继续后失败：故障记在 C 上，重试也用 C。
  it("records a failure after a switch made while paused against that model", async () => {
    vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
    const itemId = ticket("pi", "anthropic/claude-sonnet-5-5");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "pi", model: "openai/gpt-5.6", effort: "low" });
    updateRun(db, runId, { state: "running" });
    const switched = (applied: string, model: string, effort: string) => addActivity(db, {
      itemId, runId, actor: "user", kind: "decision",
      payload: { decision: "run_profile_changed", role: "executor", runtime: "pi", applied, to: { model, effort } },
    });
    switched("in_run", "anthropic/claude-opus-5-5", "high");
    switched("on_resume", "openai/gpt-5.6", "low");
    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "do it", sessionDir: join(dir, "sessions"),
      runId, model: "openai/gpt-5.6", effort: "low", env: { FAKE_SCENARIO: "llm_model_unsupported" },
    });
    expect(db.prepare("SELECT level, model FROM runtime_incidents").all()).toEqual([{ level: "model", model: "openai/gpt-5.6" }]);
    expect(db.prepare("SELECT model, effort FROM dispatch_requests WHERE trigger='runtime-health-retry'").all())
      .toEqual([{ model: "openai/gpt-5.6", effort: "low" }]);
  }, 30_000);

  // 审查 7：给 Lead 的说明按 adapter 的能力写，不写具体的 agent。
  it("describes the switch by what the agent can do, not by its name", () => {
    expect(TICKET_ACTIONS.set_run_profile.hint).not.toMatch(/\bpi\b|Claude|Codex/);
  });
});

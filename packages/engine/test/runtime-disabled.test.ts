// 用户在设置里停用一个 runtime（2026-10-19）。「不用 codex」以前只记在 Lead 的笔记里（note #33），系统不读笔记：
// 10:57 的 suggest_route 照样推荐了 codex，自动核查照样派给 codex。停用以后：
//   - 选 runtime、选核查员、选型建议都跳过它；
//   - 点名它的执行请求不派发，挂起并叫醒 Lead 改派（不替用户换执行者）；
//   - 点名它的核查请求在认领时换成下一个能用的核查员（2026-10-20，reviewer-fallback.test.ts）；
//   - 工单上存着的（上一次选出来的）runtime 被停用时，下一次派发重新选。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import type { RuntimeCapabilities } from "@pi-lead-child/runtime";
import { defaultReviewRuntime, disabledRuntimes } from "@pi-lead-child/runtime";
import { openDb, createItem, getItem, grantDelegationPolicy, listInbox, transition, updateRun } from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { pickReviewRuntime } from "../src/coordinator/reviewer-choice.js";
import { routeCandidates, type ModelCatalog } from "../src/index.js";
import { probeChildRuntimeCatalog, selectChildRuntime, type RuntimeCatalog } from "../src/runtime-catalog.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const caps = (review: boolean): RuntimeCapabilities => ({
  streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: review,
});

function catalog(): RuntimeCatalog {
  const entry = (id: RuntimeId, review: boolean, models: string[]) => ({
    id, available: true, executable: `/bin/${id}`, defaultModel: models[0] ?? null, models,
    capabilities: caps(review), reason: null,
  });
  return { entries: [entry("codex", true, ["gpt-5.5"]), entry("claude", false, []), entry("pi", false, ["vibeproxy/opus", "vibeproxy/gemini"])] };
}

const NO_MODELS: ModelCatalog = { refreshedAt: "2026-10-19T00:00:00.000Z", runtimes: [] };

describe("the disabled-runtime list", () => {
  it("reads the env list, drops unknown ids and duplicates", () => {
    expect(disabledRuntimes({ PLC_DISABLED_RUNTIMES: " codex, nope ,codex,claude" })).toEqual(["codex", "claude"]);
    expect(disabledRuntimes({})).toEqual([]);
  });

  // 2026-10-20：任何 runtime 都能当核查员。codex 停用后核查员换成下一个（claude），不再挂起等用户重新启用。
  // （2026-10-19 那次 claude 被认领后在启动时被拒，是因为 Lead 的工具把 claude 当成不能核查；那道闸已经去掉。）
  it("moves the reviewer past a disabled runtime instead of waiting for it", () => {
    expect(defaultReviewRuntime({})).toBe("codex");
    expect(defaultReviewRuntime({ PLC_DISABLED_RUNTIMES: "codex" })).toBe("claude");
    expect(defaultReviewRuntime({ PLC_DISABLED_RUNTIMES: "codex,claude,pi" })).toBe("codex");
    vi.stubEnv("PLC_REVIEW_RUNTIME", "claude");
    expect(pickReviewRuntime(null)).toBe("claude");
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
    expect(pickReviewRuntime(null)).toBe("codex");
  });

  // 2026-10-20：点名一个不能跑命令的核查员不再报错。
  it("accepts any enabled runtime as a named reviewer, and puts the one that can run commands first", () => {
    expect(selectChildRuntime({ env: { PLC_DISABLED_RUNTIMES: "codex" }, catalog: catalog(), requested: "claude", role: "reviewer" }))
      .toMatchObject({ runtime: "claude", fallbackFrom: null });
    expect(selectChildRuntime({ env: {}, catalog: catalog(), role: "reviewer" }).runtime).toBe("codex");
    expect(selectChildRuntime({ env: { PLC_DISABLED_RUNTIMES: "codex" }, catalog: catalog(), role: "reviewer" }).runtime)
      .toBe("claude");
  });

  // 2026-10-19 发布评审：plc 的执行器在本仓库跑测试时继承了用户的开关，设了 codex 以后这个文件有两条失败。
  // vitest.setup.ts 删掉它。验证方法：PLC_DISABLED_RUNTIMES=codex npx vitest run 这个文件。
  it("does not inherit the user's switch from the environment the tests run in", () => {
    expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();
  });
});

describe("runtime selection with a disabled runtime", () => {
  it("marks disabled runtimes in the probed catalog", () => {
    const probed = probeChildRuntimeCatalog({ findExecutable: (id) => `/bin/${id}`, env: { PLC_DISABLED_RUNTIMES: "codex" } });
    expect(probed.entries.map((entry) => [entry.id, entry.disabled])).toEqual([["codex", true], ["claude", false], ["pi", false]]);
  });

  it("skips a disabled runtime when the runtime is omitted or only an env default", () => {
    const env = { PLC_DISABLED_RUNTIMES: "codex" };
    expect(selectChildRuntime({ env, catalog: catalog() }).runtime).toBe("claude");
    expect(selectChildRuntime({ env: { ...env, PLC_CHILD_RUNTIME: "codex" }, catalog: catalog() }))
      .toMatchObject({ runtime: "claude", fallbackFrom: "codex" });
  });

  it("refuses a disabled runtime that the caller names, instead of switching for the user", () => {
    expect(() => selectChildRuntime({ env: { PLC_DISABLED_RUNTIMES: "codex" }, catalog: catalog(), requested: "codex" }))
      .toThrow(/disabled/);
  });
});

describe("suggest_route's hard rules", () => {
  it("excludes a disabled runtime, a cooling runtime and a quota-limited model, each with its reason", () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const { candidates, excluded } = routeCandidates({
      role: "executor",
      catalog: catalog(),
      modelCatalog: NO_MODELS,
      runtimeUnavailable: (runtime) => (runtime === "claude" ? "正在冷却，到 18:00" : null),
      modelUnavailable: (runtime, model) => (runtime === "pi" && model === "vibeproxy/opus" ? "用量额度用完（故障 #9）" : false),
    });
    expect(candidates).toEqual([{ runtime: "pi", models: ["vibeproxy/gemini"] }]);
    expect(excluded).toEqual([
      { runtime: "codex", reason: expect.stringContaining("停用") },
      { runtime: "claude", reason: "正在冷却，到 18:00" },
      { runtime: "pi", model: "vibeproxy/opus", reason: "用量额度用完（故障 #9）" },
    ]);
  });

  it("keeps the generic reason when the ledger only says true", () => {
    const { excluded } = routeCandidates({
      role: "executor", catalog: catalog(), modelCatalog: NO_MODELS, runtimeUnavailable: (runtime) => runtime === "codex",
    });
    expect(excluded).toEqual([{ runtime: "codex", reason: "unavailable in the runtime health ledger" }]);
  });
});

describe("dispatch with a disabled runtime", () => {
  // 2026-10-20：以前这条核查写着 codex，挂起等用户重新启用（这里的旧用例）。现在自动核查直接选下一个核查员，马上派出。
  // 工单 09（D3）：下一个核查员避开执行者的 runtime（claude），所以是 pi。
  it("sends the automatic review of a delivery made while codex is disabled to the next reviewer at once", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const dir = tempDir("plc-disabled-review-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "claude",
    });
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: `delivery:${itemId}`,
    });
    const delivery = orchestrator.dispatcher.claimNext()!;
    expect(delivery.runtime).toBe("claude");
    updateRun(db, delivery.runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery.runId });
    await orchestrator.tick();

    const review = db.prepare(
      "SELECT id, runtime, state, suspended_reason FROM dispatch_requests WHERE item_id=? AND role='reviewer'",
    ).get(itemId) as { id: number; runtime: string; state: string; suspended_reason: string | null };
    expect(review).toMatchObject({ runtime: "pi", state: "started", suspended_reason: null });
    expect(db.prepare("SELECT runtime, state FROM runs WHERE item_id=? AND role='reviewer'").all(itemId))
      .toEqual([{ runtime: "pi", state: "starting" }]);
    expect(listInbox(db).filter((row) => row.summary.includes(`#${review.id}`))).toEqual([]);
  });

  // 2026-10-19 复审：换 runtime 时工单上的模型（codex 的 gpt-5.2-codex）没有清掉。第一次返工得到 claude/null，
  // 第二次返工把 gpt-5.2-codex 用在了 claude 上。
  it("drops the old runtime's model when it re-selects the runtime, so a second rework does not reuse it", () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const db = openDb(join(tempDir("plc-disabled-model-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", runtime: "codex", model: "gpt-5.2-codex" });
    const dispatcher = createDispatcher(db);
    const rework = (n: number) => {
      const id = dispatcher.request({ itemId, role: "executor", purpose: "execution", trigger: "user-rework", idempotencyKey: `rework:${n}` });
      return db.prepare("SELECT runtime, model FROM dispatch_requests WHERE id=?").get(id) as { runtime: string; model: string | null };
    };
    const first = rework(1);
    expect(first.runtime).not.toBe("codex");
    expect(first.model).not.toBe("gpt-5.2-codex");
    expect(getItem(db, itemId)).toMatchObject({ requested_runtime: first.runtime, requested_model: null });
    const selected = db.prepare(
      "SELECT payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='runtime_selected'",
    ).get(itemId) as { payload: string };
    expect(JSON.parse(selected.payload)).toMatchObject({ fallbackFrom: "codex", clearedModel: "gpt-5.2-codex" });
    const second = rework(2);
    expect(second).toEqual({ runtime: first.runtime, model: first.model });
  });

  // 2026-10-19 发布评审：委托返工显式传了 item.requested_runtime，绕过了「重新选」，请求被挂起，没有工具能改派。
  it("sends a delegated rework to a runtime that is still enabled", () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const db = openDb(join(tempDir("plc-disabled-rework-"), "plc.db"));
    const itemId = createItem(db, { title: "leaf", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "codex" });
    grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 2 });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "");
    dispatcher.request({ itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger: "automatic-review", idempotencyKey: `r:${itemId}` });
    const claim = dispatcher.claimNext()!;
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    dispatcher.submitReviewVerdict({ runId: claim.runId, verdict: "fail", evidence: "tests fail" });
    const rework = db.prepare(
      "SELECT runtime FROM dispatch_requests WHERE item_id=? AND trigger='delegated-review-rework'",
    ).get(itemId) as { runtime: string } | undefined;
    expect(rework).toBeDefined();
    expect(rework!.runtime).not.toBe("codex");
    expect(dispatcher.claimNext()).toMatchObject({ role: "executor", runtime: rework!.runtime });
  });

  it("re-selects when the ticket's stored runtime is disabled, and records why", () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    const db = openDb(join(tempDir("plc-disabled-reselect-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", runtime: "codex" });
    const dispatcher = createDispatcher(db);
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: `t:${itemId}`,
    });
    const row = db.prepare("SELECT runtime FROM dispatch_requests WHERE id=?").get(requestId) as { runtime: string };
    expect(row.runtime).not.toBe("codex");
    expect(getItem(db, itemId)?.requested_runtime).toBe(row.runtime);
    const selected = db.prepare(
      "SELECT payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='runtime_selected'",
    ).get(itemId) as { payload: string };
    expect(JSON.parse(selected.payload)).toMatchObject({ fallbackFrom: "codex", reason: expect.stringContaining("停用") });
  });

  // 执行请求的挂起不变：换哪个执行者是 Lead 的事。核查请求在认领时换核查员（reviewer-fallback.test.ts）。
  it("holds a queued executor request that names a disabled runtime, wakes Lead once, and releases it when re-enabled", () => {
    const db = openDb(join(tempDir("plc-disabled-hold-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    const dispatcher = createDispatcher(db);
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "user-retry", idempotencyKey: `r:${itemId}`,
    });

    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    expect(dispatcher.claimNext()).toBeNull();
    expect(dispatcher.claimNext()).toBeNull();
    const held = db.prepare("SELECT state, suspended_reason FROM dispatch_requests WHERE id=?").get(requestId) as {
      state: string; suspended_reason: string;
    };
    expect(held.state).toBe("pending");
    expect(held.suspended_reason).toContain("停用");
    const notes = listInbox(db).filter((row) => row.summary.includes(`#${requestId}`));
    expect(notes).toHaveLength(1);
    expect(JSON.parse(notes[0]!.payload ?? "{}")).toMatchObject({ kind: "dispatch_runtime_disabled", wakeLead: true });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE json_extract(payload, '$.decision')='dispatch_suspended_runtime_disabled'",
    ).get()).toEqual({ n: 1 });

    vi.stubEnv("PLC_DISABLED_RUNTIMES", "");
    expect(dispatcher.claimNext()).toMatchObject({ requestId, runtime: "codex" });
  });
});

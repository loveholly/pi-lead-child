// 决策边界（2026-10-20）：选核查员，和换核查员。
// 选：PLC_REVIEW_RUNTIME → 能做可执行只读核查的 → 其余（registry 的顺序 codex、claude、pi），
// 跳过用户停用的和 profile 上有没关闭故障的；都不能用时返回第一个没停用的，都停用了返回第一个。
// 换：有排着或挂起的核查就改它；没有就新排；核查在跑、runtime 停用或有故障时拒绝。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { buildReviewerPrompt } from "@pi-lead-child/core";
import { defaultRuntimeProfile, reviewRuntimeOrder, typedFailure } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import {
  createItem, createRun, getItem, getReviewerSetting, openDb, recordRuntimeHealthFailure, setReviewerSetting, transition, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { itemReviewer, pickReviewRuntime, reviewerOptions } from "../src/coordinator/reviewer-choice.js";
import { changeReviewer, ReviewerChangeError, reviewerInfo, suspendedReviewRuntime } from "../src/coordinator/change-reviewer.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { runTicketAction } from "../src/ticket-actions/index.js";
import {
  automaticReviewDue, automaticReviewRuntime, requiresIndependentReview, reviewerAvailability,
} from "../src/pipeline/automatic-review.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const freshDb = () => openDb(join(tempDir("plc-reviewer-choice-"), "plc.db"));

function accountDown(db: Db, runtime: RuntimeId): number {
  const itemId = createItem(db, { title: `${runtime} down`, brief: "b", createdBy: "user" });
  const runId = createRun(db, { itemId, runtime });
  updateRun(db, runId, { state: "failed", endedAt: true, exitCode: 1 });
  return recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile(runtime), model: null, itemId, runId,
    failure: typedFailure("auth_required", { errorCode: "test", message: "not logged in" }),
  })!.incident.id;
}

// 一个模型用量到顶（模型级故障，2026-10-22 审查 H1）：只有这个模型不能用，同一个 runtime 的默认模型还能用。
function modelDown(db: Db, runtime: RuntimeId, model: string): number {
  const itemId = createItem(db, { title: `${runtime}/${model} down`, brief: "b", createdBy: "user" });
  const runId = createRun(db, { itemId, runtime });
  updateRun(db, runId, { state: "failed", endedAt: true, exitCode: 1 });
  const recorded = recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile(runtime), model, itemId, runId,
    failure: typedFailure("usage_limited", { errorCode: "test", message: "You've hit your limit" }),
  })!;
  expect(recorded.incident).toMatchObject({ level: "model", model });
  return recorded.incident.id;
}

describe("the reviewer order", () => {
  it("puts the configured reviewer first, then runtimes that can run commands, then the rest", () => {
    expect(reviewRuntimeOrder({})).toEqual(["codex", "claude", "pi"]);
    expect(reviewRuntimeOrder({ PLC_REVIEW_RUNTIME: "pi" })).toEqual(["pi", "codex", "claude"]);
    expect(reviewRuntimeOrder({ PLC_REVIEW_RUNTIME: "nope" })).toEqual(["codex", "claude", "pi"]);
  });
});

describe("picking a reviewer", () => {
  it.each([
    ["nothing disabled or broken", {}, [], "codex"],
    ["codex disabled", { PLC_DISABLED_RUNTIMES: "codex" }, [], "claude"],
    ["codex broken", {}, ["codex"], "claude"],
    ["codex and claude disabled", { PLC_DISABLED_RUNTIMES: "codex,claude" }, [], "pi"],
    ["codex disabled, claude broken", { PLC_DISABLED_RUNTIMES: "codex" }, ["claude"], "pi"],
    ["the configured reviewer", { PLC_REVIEW_RUNTIME: "pi" }, [], "pi"],
    ["the configured reviewer disabled", { PLC_REVIEW_RUNTIME: "pi", PLC_DISABLED_RUNTIMES: "pi" }, [], "codex"],
    ["the configured reviewer broken", { PLC_REVIEW_RUNTIME: "pi" }, ["pi"], "codex"],
    // 都不能用：第一个没停用的，请求由派发 gate 挂起并写明原因。
    ["every runtime broken", {}, ["codex", "claude", "pi"], "codex"],
    ["codex disabled, the others broken", { PLC_DISABLED_RUNTIMES: "codex" }, ["claude", "pi"], "claude"],
    // 都停用了：第一个，请求挂起等用户启用一个。
    ["every runtime disabled", { PLC_DISABLED_RUNTIMES: "codex,claude,pi" }, [], "codex"],
  ] as const)("with %s", (_name, env, broken, expected) => {
    const db = freshDb();
    for (const runtime of broken) accountDown(db, runtime);
    expect(pickReviewRuntime(db, { env })).toBe(expected);
    db.close();
  });

  it("says why each runtime cannot review", () => {
    const db = freshDb();
    const incident = accountDown(db, "codex");
    expect(reviewerOptions(db, { env: { PLC_DISABLED_RUNTIMES: "pi" } })).toEqual([
      { runtime: "codex", displayName: "Codex", available: false, reason: `Codex 认证失败（故障 #${incident}）` },
      { runtime: "claude", displayName: "Claude Code", available: true },
      { runtime: "pi", displayName: "Pi agent", available: false, reason: expect.stringContaining("停用") },
    ]);
    db.close();
  });

  it("uses an explicit override as it is, and otherwise picks from the ledger", () => {
    const db = freshDb();
    accountDown(db, "codex");
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(automaticReviewRuntime(db, itemId)).toBe("claude");
    expect(automaticReviewRuntime(db, itemId, "pi")).toBe("pi");
    expect(reviewerAvailability(db)).toEqual({ available: true, runtime: "claude" });
    db.close();
  });

  it("reports no reviewer only when every runtime is unusable, naming each reason", () => {
    const db = freshDb();
    for (const runtime of ["codex", "claude", "pi"] as const) accountDown(db, runtime);
    const availability = reviewerAvailability(db);
    expect(availability).toMatchObject({ available: false, runtime: "codex" });
    expect(availability.available ? "" : availability.reason).toMatch(/没有能用的核查员.*Codex.*Claude Code.*Pi agent/);
    db.close();
  });
});

describe("the reviewer prompt", () => {
  const item = { id: 7, title: "t", brief: "b", body: "" };
  it("tells a reviewer that cannot run commands to judge from reading and to say so", () => {
    const readOnly = buildReviewerPrompt(item, { canRunCommands: false });
    expect(readOnly).toContain("这次核查不能运行命令");
    expect(readOnly).toContain("没有实际运行");
    expect(readOnly.startsWith(buildReviewerPrompt(item))).toBe(true);
    expect(buildReviewerPrompt(item, { canRunCommands: true })).not.toContain("这次核查不能运行命令");
  });
});

// 一张要求独立核查的工单：交付 Run 结束，进了 review。
function delivered(db: Db): { itemId: number; deliveryRunId: number } {
  const itemId = createItem(db, {
    title: "delivered", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer", runtime: "pi",
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "test" });
  const deliveryRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
  updateRun(db, deliveryRunId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: deliveryRunId });
  return { itemId, deliveryRunId };
}

const queueReview = (db: Db, itemId: number, runtime: RuntimeId) => createDispatcher(db).request({
  itemId, role: "reviewer", purpose: "review", runtime, model: runtime === "codex" ? "gpt-5.5" : undefined,
  trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:${runtime}`,
});

const errorCode = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ReviewerChangeError ? error.code : `unexpected: ${String(error)}`;
  }
};

describe("changing the reviewer", () => {
  it("moves a queued review to the chosen runtime, drops the old runtime's model and records who did it", () => {
    const db = freshDb();
    const { itemId, deliveryRunId } = delivered(db);
    const requestId = queueReview(db, itemId, "codex");
    const result = changeReviewer(db, itemId, "claude", { actor: "lead", reason: "用户说 codex 停用了" });
    expect(result).toEqual({ dispatchRequestId: requestId, deliveryRunId, from: "codex", to: "claude", created: false });
    expect(db.prepare("SELECT runtime, model, suspended_reason FROM dispatch_requests WHERE id=?").get(requestId))
      .toEqual({ runtime: "claude", model: null, suspended_reason: null });
    const activity = db.prepare(
      "SELECT actor, payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'",
    ).get(itemId) as { actor: string; payload: string };
    expect(activity.actor).toBe("lead");
    expect(JSON.parse(activity.payload).message).toBe("核查员从 Codex 换成 Claude Code：用户说 codex 停用了");
    db.close();
  });

  it("queues a review on the chosen runtime when the latest delivery has none", () => {
    const db = freshDb();
    const { itemId, deliveryRunId } = delivered(db);
    const result = changeReviewer(db, itemId, "pi", { actor: "user" });
    expect(result).toMatchObject({ deliveryRunId, from: null, to: "pi", created: true });
    expect(db.prepare("SELECT role, runtime, trigger, state FROM dispatch_requests WHERE id=?").get(result.dispatchRequestId))
      .toEqual({ role: "reviewer", runtime: "pi", trigger: "user-review", state: "pending" });
    db.close();
  });

  it("refuses while the review runs, for a disabled or broken runtime, and without anything to review", () => {
    const db = freshDb();
    const { itemId } = delivered(db);
    queueReview(db, itemId, "codex");
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "pi");
    expect(errorCode(() => changeReviewer(db, itemId, "pi", { actor: "user" }))).toBe("runtime_disabled");
    accountDown(db, "claude");
    expect(errorCode(() => changeReviewer(db, itemId, "claude", { actor: "user" }))).toBe("runtime_unavailable");
    // 回归（2026-10-21）：这句话显示在界面上，不能让用户去跑命令行。
    expect(() => changeReviewer(db, itemId, "claude", { actor: "user" })).toThrow(/请换一个能用的核查员。$/);
    expect(() => changeReviewer(db, itemId, "claude", { actor: "user" })).not.toThrow(/plc recheck/);
    expect(errorCode(() => changeReviewer(db, itemId, "gemini", { actor: "user" }))).toBe("unknown_runtime");
    expect(errorCode(() => changeReviewer(db, 9_999, "codex", { actor: "user" }))).toBe("not_found");

    const claim = createDispatcher(db).claimNext()!;
    expect(claim).toMatchObject({ role: "reviewer", runtime: "codex" });
    updateRun(db, claim.runId, { state: "running" });
    expect(errorCode(() => changeReviewer(db, itemId, "codex", { actor: "user" }))).toBe("review_running");

    const idle = createItem(db, { title: "idle", brief: "b", createdBy: "user" });
    expect(errorCode(() => changeReviewer(db, idle, "codex", { actor: "user" }))).toBe("no_delivery");
    db.close();
  });

  // 2026-10-29 10:01：用户说「核查员不要 Gemini，要 opus 5.5 high」，工单还在执行。以前没有排上核查就拒绝（no_delivery），
  // Lead 只好设了 4 个跟进来记这件事。工单操作 change_reviewer 现在直接记下设置，下一次核查用它。
  it("records the reviewer for the next review when nothing is queued to change yet", () => {
    const db = freshDb();
    const itemId = createItem(db, {
      title: "执行中", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "pi",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const run = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
    updateRun(db, run, { state: "running" });
    setReviewerSetting(db, itemId, { runtime: "pi", model: "vibeproxy/gemini-3-pro", chosenBy: "lead" });

    const result = changeReviewer(db, itemId, "claude", {
      actor: "lead", reason: "用户说核查员不要 Gemini", whenNothingToReview: "remember",
    });
    expect(result).toMatchObject({
      dispatchRequestId: null, deliveryRunId: null, from: "pi", to: "claude", created: false, appliesTo: "next_review",
    });
    expect(result.note).toContain("下一次核查用");
    expect(getReviewerSetting(db, itemId)).toMatchObject({
      runtime: "claude", model: null, effort: null, chosenBy: "lead", reason: "用户说核查员不要 Gemini",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    db.close();
  });

  it("describes the reviewer, the options and whether they can be changed", () => {
    const db = freshDb();
    const { itemId } = delivered(db);
    accountDown(db, "codex");
    // 没有核查在路上：下一次会用的核查员（跳过有故障的 codex），可以换。
    expect(reviewerInfo(db, itemId)).toMatchObject({
      reviewer: { runtime: "claude", displayName: "Claude Code" },
      canChange: true,
      progress: null,
      options: [
        expect.objectContaining({ runtime: "codex", available: false }),
        expect.objectContaining({ runtime: "claude", available: true }),
        expect.objectContaining({ runtime: "pi", available: true }),
      ],
    });
    // 排着的核查：它的核查员。
    queueReview(db, itemId, "pi");
    expect(reviewerInfo(db, itemId)).toMatchObject({ reviewer: { runtime: "pi" }, canChange: true, progress: "queued" });
    // 在跑：不能换。
    const claim = createDispatcher(db).claimNext()!;
    updateRun(db, claim.runId, { state: "running" });
    expect(reviewerInfo(db, itemId)).toMatchObject({ reviewer: { runtime: "pi" }, canChange: false, progress: "running" });
    db.close();
  });
});

// 工单 09（spec 5.6、D3）：核查员和执行者一起选。Lead 建单时可以选核查员（存在 item_reviewer_settings）；没选时系统选，
// 优先选和执行者不同的 runtime；只剩和执行者同一种时用它，并标明。选中的不能用时，派发认领时自动换人并记一条活动（01）。
describe("the ticket's reviewer", () => {
  // 一张要求独立核查的工单，执行者是 executor：派发、认领、交付，进 review。返回编排器，tick 一次就排自动核查。
  async function deliverOn(executor: RuntimeId, setup?: (db: Db, itemId: number) => void) {
    const dir = tempDir("plc-item-reviewer-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, {
      title: "delivered", brief: "严禁调用 codex", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: executor,
    });
    setup?.(db, itemId);
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: executor, trigger: "test", idempotencyKey: `delivery:${itemId}`,
    });
    const delivery = orchestrator.dispatcher.claimNext()!;
    updateRun(db, delivery.runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery.runId });
    return { db, itemId, orchestrator, deliveryRunId: delivery.runId };
  }

  const reviewerRuns = (db: Db, itemId: number) =>
    db.prepare("SELECT runtime, model, effort FROM runs WHERE item_id=? AND role='reviewer' ORDER BY id").all(itemId);
  const reviewerRequests = (db: Db, itemId: number) =>
    db.prepare("SELECT runtime, model, effort, trigger FROM dispatch_requests WHERE item_id=? AND role='reviewer' ORDER BY id")
      .all(itemId) as { runtime: string; model: string | null; effort: string | null; trigger: string }[];

  // 2026-10-29 10:01：用户要换核查员时，工单还在执行，执行 Run 正在启动。以前 change_reviewer 要求已经排上核查，
  // set_run_profile 在有 Run 启动时也拒绝。现在两个都能做：设置记下，交付以后的自动核查按它派。完整的落库流程：
  // 两个工单操作、派发、交付、编排器排核查。
  it("dispatches the next review with a reviewer chosen while the ticket still executes", async () => {
    const dir = tempDir("plc-item-reviewer-early-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, {
      title: "执行中", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "pi",
    });
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "pi", trigger: "test", idempotencyKey: `delivery:${itemId}`,
    });
    const delivery = orchestrator.dispatcher.claimNext()!;
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(delivery.runId)).toEqual({ state: "starting" });

    const user = { kind: "user" } as const;
    const changed = await runTicketAction(db, { itemId, action: "change_reviewer", input: { runtime: "claude" }, caller: user });
    expect(changed.result).toMatchObject({ to: "claude", dispatchRequestId: null, appliesTo: "next_review" });
    const profiled = await runTicketAction(db, {
      itemId, action: "set_run_profile", input: { role: "reviewer", model: "claude-opus-5-5", effort: "high" }, caller: user,
    });
    expect(profiled.result).toMatchObject({ role: "reviewer", runtime: "claude", applied: "next_run" });

    updateRun(db, delivery.runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery.runId });
    await orchestrator.tick();
    expect(reviewerRequests(db, itemId)).toEqual([
      { runtime: "claude", model: "claude-opus-5-5", effort: "high", trigger: "automatic-review" },
    ]);
    db.close();
  });

  // 审查 M3：Lead 选一个系统不会选的核查员（执行者是 codex 时系统选 claude），才能看出 Lead 的选择生效了。
  it("dispatches the reviewer Lead chose, with its model and effort", async () => {
    const { db, itemId, orchestrator } = await deliverOn("codex", (db, itemId) => {
      setReviewerSetting(db, itemId, {
        runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high", chosenBy: "lead", reason: "brief 里写着严禁调用 codex",
      });
    });
    expect(itemReviewer(db, itemId)).toMatchObject({
      runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high", chosenBy: "lead", executorRuntime: "codex",
      sameAsExecutor: false, replaced: null,
    });
    await orchestrator.tick();
    expect(reviewerRequests(db, itemId)).toEqual([
      { runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high", trigger: "automatic-review" },
    ]);
    expect(reviewerRuns(db, itemId)).toEqual([{ runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high" }]);
    db.close();
  });

  // 审查 M3：换过的核查员（change_reviewer 写进设置），返工以后新交付的自动核查还用它，不回到系统的选择。
  it("keeps the changed reviewer through a rework: the next delivery's automatic review names it", async () => {
    const dir = tempDir("plc-item-reviewer-rework-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, {
      title: "delivered", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer", runtime: "codex",
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "test" });
    const first = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, first, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: first });
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });
    // 系统会选 claude；用户换成 pi。
    expect(itemReviewer(db, itemId).runtime).toBe("claude");
    changeReviewer(db, itemId, "pi", { actor: "user", reason: "这次让 pi 看" });
    const review = orchestrator.dispatcher.claimNext()!;
    expect(review).toMatchObject({ role: "reviewer", runtime: "pi" });
    orchestrator.dispatcher.submitReviewVerdict({ runId: review.runId, verdict: "fail", evidence: "登录页报错" });
    updateRun(db, review.runId, { state: "finished", endedAt: true, exitCode: 0 });
    await orchestrator.tick();
    // 返工：回到执行中，执行者交第 2 次。
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: `delivery-2:${itemId}`,
    });
    const second = orchestrator.dispatcher.claimNext()!;
    expect(second).toMatchObject({ role: "executor", runtime: "codex" });
    updateRun(db, second.runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done again", runId: second.runId });
    await orchestrator.tick();
    expect(reviewerRequests(db, itemId).filter((request) => request.trigger === "automatic-review"))
      .toEqual([expect.objectContaining({ runtime: "pi" })]);
    expect(reviewerRuns(db, itemId).map((run) => (run as { runtime: string }).runtime)).toEqual(["pi", "pi"]);
    db.close();
  });

  it("without a choice, prefers a runtime other than the executor's", async () => {
    // codex 排在核查员顺序的第一位，但它是执行者。
    const { db, itemId, orchestrator } = await deliverOn("codex");
    expect(automaticReviewRuntime(db, itemId)).toBe("claude");
    expect(itemReviewer(db, itemId)).toMatchObject({ runtime: "claude", chosenBy: "system", executorRuntime: "codex", sameAsExecutor: false });
    expect(reviewerInfo(db, itemId)?.reviewer).toEqual({
      runtime: "claude", displayName: "Claude Code", model: null, effort: null, chosenBy: "system", sameAsExecutor: false,
    });
    await orchestrator.tick();
    expect(reviewerRuns(db, itemId)).toMatchObject([{ runtime: "claude" }]);
    db.close();
  });

  it("keeps the reviewer named in the configuration even when it is the executor's runtime, and says so", async () => {
    vi.stubEnv("PLC_REVIEW_RUNTIME", "codex");
    const { db, itemId } = await deliverOn("codex");
    expect(itemReviewer(db, itemId)).toMatchObject({ runtime: "codex", chosenBy: "system", sameAsExecutor: true });
    // 配置的核查员不能用时，回到「避开执行者」。
    accountDown(db, "codex");
    expect(itemReviewer(db, itemId)).toMatchObject({ runtime: "claude", sameAsExecutor: false });
    db.close();
  });

  it("uses the executor's runtime when nothing else can review, and says so", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude,pi");
    const { db, itemId, orchestrator } = await deliverOn("codex");
    expect(itemReviewer(db, itemId)).toMatchObject({ runtime: "codex", chosenBy: "system", sameAsExecutor: true });
    expect(reviewerInfo(db, itemId)?.reviewer).toMatchObject({ runtime: "codex", sameAsExecutor: true });
    await orchestrator.tick();
    expect(reviewerRuns(db, itemId)).toMatchObject([{ runtime: "codex" }]);
    db.close();
  });

  it("switches an unusable chosen reviewer at dispatch, preferring another runtime than the executor's, and records it", async () => {
    const { db, itemId, orchestrator } = await deliverOn("pi", (db, itemId) => {
      setReviewerSetting(db, itemId, { runtime: "codex", model: "gpt-5.5", chosenBy: "lead" });
    });
    const incident = accountDown(db, "codex");
    expect(itemReviewer(db, itemId)).toMatchObject({
      runtime: "claude", chosenBy: "system", sameAsExecutor: false,
      replaced: { runtime: "codex", reason: `Codex 认证失败（故障 #${incident}）` },
    });
    await orchestrator.tick();
    expect(reviewerRuns(db, itemId)).toEqual([{ runtime: "claude", model: null, effort: null }]);
    const switched = db.prepare(
      "SELECT actor, payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'",
    ).all(itemId) as { actor: string; payload: string }[];
    expect(switched).toHaveLength(1);
    expect(switched[0]!.actor).toBe("system");
    expect(JSON.parse(switched[0]!.payload)).toMatchObject({ from: "codex", to: "claude", reason: `Codex 认证失败（故障 #${incident}）` });
    // 选择本身不变：故障恢复以后，下一次核查还用 Lead 选的。
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "codex", chosenBy: "lead" });
    db.close();
  });

  // 2026-10-22 审查 H1：以前只按 runtime 判断，选好的模型（opus）有故障时 itemReviewer 照样返回 claude/opus，核查一直挂起。
  it("falls back to the chosen runtime's default model when only the chosen model is broken, and records the switch", async () => {
    const { db, itemId, orchestrator } = await deliverOn("codex", (db, itemId) => {
      setReviewerSetting(db, itemId, { runtime: "claude", model: "opus", effort: "high", chosenBy: "lead" });
    });
    const incident = modelDown(db, "claude", "opus");
    expect(itemReviewer(db, itemId)).toMatchObject({
      runtime: "claude", model: null, effort: null, chosenBy: "lead",
      replaced: { runtime: "claude", model: "opus", reason: expect.stringContaining(`故障 #${incident}`) },
    });
    await orchestrator.tick();
    expect(reviewerRuns(db, itemId)).toEqual([{ runtime: "claude", model: null, effort: null }]);
    const switched = db.prepare(
      "SELECT payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'",
    ).all(itemId) as { payload: string }[];
    expect(switched.map((row) => JSON.parse(row.payload))).toEqual([expect.objectContaining({
      from: "claude", to: "claude", fromModel: "opus", toModel: null,
      message: `核查员从 Claude Code（opus） 换成 Claude Code（默认模型）：Claude Code 用量额度用完，在等重置（opus）（故障 #${incident}）`,
    })]);
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "claude", model: "opus", effort: "high" });
    db.close();
  });

  it("drops the chosen runtime when its default model is broken too, and picks another runtime than the executor's", async () => {
    const { db, itemId, orchestrator } = await deliverOn("codex", (db, itemId) => {
      setReviewerSetting(db, itemId, { runtime: "claude", model: "opus", chosenBy: "lead" });
    });
    modelDown(db, "claude", "opus");
    accountDown(db, "claude");
    expect(itemReviewer(db, itemId)).toMatchObject({
      runtime: "pi", model: null, chosenBy: "system", replaced: { runtime: "claude", model: "opus" },
    });
    await orchestrator.tick();
    expect(reviewerRuns(db, itemId)).toMatchObject([{ runtime: "pi" }]);
    db.close();
  });

  it("re-queues a suspended review whose model is broken on the default model, not on the same broken model", () => {
    const db = freshDb();
    const { itemId } = delivered(db);
    const requestId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude", model: "opus", effort: "high",
      trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:opus`,
    });
    const incident = modelDown(db, "claude", "opus");
    db.prepare("UPDATE dispatch_requests SET suspended_reason='opus 用量到顶', suspended_incident_id=? WHERE id=?").run(incident, requestId);
    // 「重新排核查」：没有点名核查员时，系统选的核查员要带上请求上的模型判断。
    expect(suspendedReviewRuntime(db, itemId)).toBe("claude");
    changeReviewer(db, itemId, "claude", { actor: "user", remember: false });
    expect(db.prepare("SELECT runtime, model, effort, suspended_reason FROM dispatch_requests WHERE id=?").get(requestId))
      .toEqual({ runtime: "claude", model: null, effort: null, suspended_reason: null });
    expect(JSON.parse((db.prepare(
      "SELECT payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'",
    ).get(itemId) as { payload: string }).payload)).toMatchObject({ from: "claude", to: "claude", fromModel: "opus", toModel: null });
    db.close();
  });

  it("keeps a reviewer changed by the user or Lead for the next review", () => {
    const db = freshDb();
    const { itemId } = delivered(db);
    changeReviewer(db, itemId, "claude", { actor: "user", reason: "我想让 Claude Code 看" });
    expect(getReviewerSetting(db, itemId)).toMatchObject({ runtime: "claude", model: null, effort: null, chosenBy: "user", reason: "我想让 Claude Code 看" });
    expect(itemReviewer(db, itemId)).toMatchObject({ runtime: "claude", chosenBy: "user" });
    expect(reviewerInfo(db, itemId)?.reviewer).toMatchObject({ runtime: "claude", chosenBy: "user", sameAsExecutor: false });
    db.close();
  });

  it("no longer reads review_policy: only verification_policy asks for an independent reviewer", () => {
    const db = freshDb();
    const itemId = createItem(db, { title: "legacy", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET review_policy='automatic', verification_policy='lead_static', stage='review' WHERE id=?").run(itemId);
    const item = getItem(db, itemId)!;
    expect(requiresIndependentReview(item)).toBe(false);
    expect(automaticReviewDue(item, { role: "executor", purpose: "execution", state: "finished" })).toBe(false);
    db.prepare("UPDATE items SET verification_policy='independent_reviewer' WHERE id=?").run(itemId);
    expect(requiresIndependentReview(getItem(db, itemId)!)).toBe(true);
    db.close();
  });
});

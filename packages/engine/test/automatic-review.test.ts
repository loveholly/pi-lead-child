import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { openDb } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("automatic review dispatch", () => {
  // release review 7：同一次交付只排一条核查。manager 收尾时先关工具桥，这时工单已经不在 live 表里；
  // 用户在这一小段时间里点了"派发独立核查"，之后自动核查又排一条，两个 reviewer 核查同一份成果。
  it("does not queue an automatic review for a delivery the user already sent to a reviewer", async () => {
    const dir = tempDir("plc-review-dedupe-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer",
    });
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex",
      trigger: "test", idempotencyKey: `delivery:${itemId}`,
    });
    const delivery = orchestrator.dispatcher.claimNext()!;
    updateRun(db, delivery.runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery.runId });
    orchestrator.dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "user-review", idempotencyKey: `user-review:${itemId}:delivery-run:${delivery.runId}:1`,
    });

    // 这一轮 tick 收尾执行的认领：以前它在这里再排一条 automatic-review。
    await orchestrator.tick();

    expect(db.prepare("SELECT trigger FROM dispatch_requests WHERE item_id=? AND role='reviewer' ORDER BY id").all(itemId))
      .toEqual([{ trigger: "user-review" }]);
  });

  it("claims a reviewer on automatic review and applies an idempotent pass verdict", () => {
    const db = openDb(join(tempDir("plc-review-dispatch-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer",
    });
    grantDelegationPolicy(db, { itemId, createdVia: "test" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:0`,
    });
    const claim = dispatcher.claimNext()!;
    expect(claim).toMatchObject({ itemId, role: "reviewer", purpose: "review", runtime: "codex" });

    dispatcher.submitReviewVerdict({ runId: claim.runId, verdict: "pass", evidence: "tests passed" });
    dispatcher.submitReviewVerdict({ runId: claim.runId, verdict: "pass", evidence: "tests passed" });
    expect(getItem(db, itemId)?.stage).toBe("done");
    expect((db.prepare("SELECT COUNT(*) AS n FROM review_verdicts").get() as any).n).toBe(1);
  });

  it("rejects a late reviewer verdict after the reviewer run has failed", () => {
    const db = openDb(join(tempDir("plc-review-late-"), "plc.db"));
    const itemId = createItem(db, { title: "late reviewer", brief: "b", createdBy: "child" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "lead", idempotencyKey: `late-review:${itemId}`,
    });
    const reviewer = dispatcher.claimNext()!;
    updateRun(db, reviewer.runId, { state: "failed", endedAt: true, errorCode: "process_exit" });

    expect(() => dispatcher.submitReviewVerdict({
      runId: reviewer.runId,
      verdict: "pass",
      evidence: "late pass must not alter the ledger",
    })).toThrow(/active|failed|stale|late/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_verdicts WHERE run_id=?").get(reviewer.runId))
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(reviewer.runId))
      .toEqual({ state: "failed" });
  });

  it("allows explicit Lead reviewer requests on manual review without auto-closing", () => {
    const db = openDb(join(tempDir("plc-lead-review-"), "plc.db"));
    const itemId = createItem(db, { title: "root", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "lead", idempotencyKey: `lead-review:${itemId}:0`,
    });
    expect(dispatcher.claimNext()).toMatchObject({ itemId, role: "reviewer" });
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("turns a failed verdict into an idempotent executor rework request", () => {
    const db = openDb(join(tempDir("plc-review-rework-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer",
    });
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:0`,
    });
    const reviewer = dispatcher.claimNext()!;
    dispatcher.submitReviewVerdict({ runId: reviewer.runId, verdict: "fail", evidence: "test failed" });
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare(
      "SELECT role, purpose, trigger FROM dispatch_requests WHERE item_id=? AND state='pending'",
    ).get(itemId)).toEqual({ role: "executor", purpose: "execution", trigger: "delegated-review-rework" });
    expect(db.prepare(
      "SELECT idempotency_key FROM dispatch_requests WHERE item_id=? AND state='pending'",
    ).get(itemId)).toEqual({
      idempotency_key: `delegated-review-rework:${itemId}:policy:${policy.id}:reviewer-run:${reviewer.runId}`,
    });
  });

  it("keeps an automatic review failure user-controlled without delegated rework authority", () => {
    const db = openDb(join(tempDir("plc-review-default-rework-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer",
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:0`,
    });

    const reviewer = dispatcher.claimNext()!;
    dispatcher.submitReviewVerdict({ runId: reviewer.runId, verdict: "fail", evidence: "basic acceptance failed" });

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare(
      "SELECT role, purpose, trigger FROM dispatch_requests WHERE item_id=? AND state='pending'",
    ).get(itemId)).toBeUndefined();
    expect(db.prepare(
      "SELECT json_extract(payload, '$.decision') AS decision FROM activities WHERE item_id=? AND kind='decision'",
    ).all(itemId)).toContainEqual({ decision: "review_verdict_waiting_user" });
  });

  it("escalates a delegated review failure after the configured rework cycle is exhausted", () => {
    const db = openDb(join(tempDir("plc-review-rework-exhausted-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer",
    });
    grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 1 });
    const dispatcher = createDispatcher(db);
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:0`,
    });
    dispatcher.submitReviewVerdict({
      runId: dispatcher.claimNext()!.runId,
      verdict: "fail",
      evidence: "first basic acceptance failure",
    });

    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const secondReviewerRunId = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    updateRun(db, secondReviewerRunId, { state: "running" });
    dispatcher.submitReviewVerdict({
      runId: secondReviewerRunId,
      verdict: "fail",
      evidence: "second basic acceptance failure",
    });

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare(
      "SELECT json_extract(payload, '$.decision') AS decision FROM activities WHERE item_id=? AND kind='decision'",
    ).all(itemId)).toContainEqual({ decision: "delegated_review_escalate" });
    expect(listInbox(db, { severity: "blocker" }).some((row) => row.summary.includes("review rework cycles exhausted")))
      .toBe(true);
  });

  it("retries reviewer crashes within the item limit and preserves review on exhaustion", async () => {
    const db = openDb(join(tempDir("plc-review-retry-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer", retryLimit: 1,
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatched: any[] = [];
    const orchestrator = createOrchestrator(db, { onDispatch: (claim) => { dispatched.push(claim); } });
    orchestrator.dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:0`,
    });
    await orchestrator.tick();
    const first = dispatched.pop();
    updateRun(db, first.runId, { state: "failed", endedAt: true });
    await orchestrator.tick();
    const retry = dispatched.pop();
    expect(retry).toMatchObject({ itemId, role: "reviewer", purpose: "review" });
    updateRun(db, retry.runId, { state: "failed", endedAt: true });
    await orchestrator.tick();
    expect(dispatched).toEqual([]);
    expect(getItem(db, itemId)).toMatchObject({ stage: "review", plan_state: "failed" });
    expect(listInbox(db, { severity: "blocker" }).some((row) => row.summary.includes("reviewer 重试已耗尽"))).toBe(true);
  });

  // 回归（2026-10-21 审查 M5）：重试每次重新选核查员。用户换成 Claude Code 以后核查崩溃（不是账本上的故障），
  // 重试又换回排序第一的 Codex。指定的核查员还能用就沿用它和它的模型；不能用了才重新选。
  it.each([
    ["keeps the chosen reviewer and its model while it is usable", {}, { runtime: "claude", model: "opus" }],
    ["picks again once the chosen reviewer is disabled", { PLC_DISABLED_RUNTIMES: "claude" }, { runtime: "codex", model: null }],
  ] as const)("on a reviewer retry %s", async (_name, env, expected) => {
    const db = openDb(join(tempDir("plc-review-retry-runtime-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer", retryLimit: 1,
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const dispatched: any[] = [];
    const orchestrator = createOrchestrator(db, { onDispatch: (claim) => { dispatched.push(claim); } });
    orchestrator.dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude", model: "opus",
      trigger: "user-review", idempotencyKey: `user-review:${itemId}:1`,
    });
    await orchestrator.tick();
    const first = dispatched.pop();
    expect(first).toMatchObject({ runtime: "claude" });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    updateRun(db, first.runId, { state: "failed", endedAt: true });
    await orchestrator.tick();
    expect(db.prepare("SELECT runtime, model FROM dispatch_requests WHERE trigger='reviewer-retry'").get()).toEqual(expected);
  });

  // 发布评审：reviewer 的 retry_limit 按这张工单一辈子的失败计数。上一份交付的核查已经失败过、用掉了额度，
  // 新的交付第一次核查失败就直接「重试已耗尽」。额度只该算这份交付之后的失败。
  it("counts reviewer failures only since the latest delivery", async () => {
    const db = openDb(join(tempDir("plc-review-retry-delivery-"), "plc.db"));
    const itemId = createItem(db, {
      title: "leaf", brief: "b", createdBy: "child", verificationPolicy: "independent_reviewer", retryLimit: 1,
    });
    const oldDelivery = createRun(db, { itemId });
    updateRun(db, oldDelivery, { state: "finished", endedAt: true });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    for (let index = 0; index < 2; index += 1) {
      const failed = createRun(db, { itemId, role: "reviewer", purpose: "review" });
      updateRun(db, failed, { state: "failed", endedAt: true });
    }
    // 返工以后的新交付回到 review。
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    const newDelivery = createRun(db, { itemId });
    updateRun(db, newDelivery, { state: "finished", endedAt: true });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);

    const dispatched: any[] = [];
    const orchestrator = createOrchestrator(db, { onDispatch: (claim) => { dispatched.push(claim); } });
    orchestrator.dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `review:${itemId}:${newDelivery}`,
    });
    await orchestrator.tick();
    const first = dispatched.pop();
    updateRun(db, first.runId, { state: "failed", endedAt: true });
    await orchestrator.tick();
    expect(dispatched.pop()).toMatchObject({ itemId, role: "reviewer", purpose: "review" });
    expect(listInbox(db, { severity: "blocker" }).some((row) => row.summary.includes("reviewer 重试已耗尽"))).toBe(false);
  });
});


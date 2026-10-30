// 工单 #66 复盘的回归套件。
//
// #66 在生产库里的最终形态是：stage='review'、delegation policy max_rework_cycles=1 且额度
// 已经花在了用户授权的那一次返工上、reviewer Run #43 的 FAIL 早已被之后的执行作废、
// 最后一次交付 Run #49 靠自我恢复登记了成果快照并进了 review，之后的 Run #50/#51 是用户在
// 工单里提的两个问题（purpose=conversation）。
//
// 更正（2026-10-13）：这份套件原先把 #50/#51 当作"恢复失败的执行"，断言 #66 是卡死态。
// 那是误诊。对话 Run 不是交付（engine/pipeline/delivery-run.ts）；#66 真正的状态是
// "最新交付从未被核查，自动化也不会再派"。"交付交不出成果就打回 blocked"这条规则保留，
// 只是只对真正的交付 Run 生效，下面单独构造了那种情形。
//
// 三组断言分别对应工单 #72 的三条要求：投影分流、恢复失败回退、返工耗尽的显式通知。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { createUserActionService } from "../src/user-actions.js";
import {
  recordOutcomeRegistrationMissing,
  recoverOutcomeSnapshot,
} from "@pi-lead-child/engine";
import { addActivity } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import type { TicketSummary } from "@pi-lead-child/protocol";

let db: Db;
let workdir: string;
const at = new Date("2026-08-21T10:57:31.000Z");

beforeEach(() => {
  const dir = tempDir("plc-review-deadlock-");
  workdir = join(dir, "workdir");
  db = openDb(join(dir, "plc.db"));
});

function controlPlane(runningItemIds: number[] = []) {
  return createControlPlaneService(db, {
    runtime: () => ({ model: "m", sessionId: "s", busy: false, runningItemIds, aish: null }),
  });
}

function reviewStateOf(itemId: number): NonNullable<TicketSummary["reviewState"]> {
  const summary = controlPlane().listItems().find((ticket) => ticket.id === itemId);
  expect(summary, `ticket #${itemId} missing from the control plane`).toBeDefined();
  expect(summary!.reviewState, `ticket #${itemId} has no reviewState`).toBeDefined();
  return summary!.reviewState!;
}

function outcomeEnvelope(runId: number, seq: number, summary: string): void {
  const line = `PLC_OUTCOME_V1 ${JSON.stringify({
    summary,
    changes: [{ kind: "file", ref: "src/store/outcomes.ts", summary: "Added ledger" }],
    deliverables: [{ kind: "path", ref: "src/store/outcomes.ts", label: "Outcome store" }],
    validations: [{
      command: "npm run typecheck",
      outcome: "passed",
      exitCode: 0,
      summary: "typecheck passed",
      evidenceRef: null,
    }],
  })}`;
  db.prepare(
    `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
     VALUES (?, ?, 'message.completed', ?, ?)`,
  ).run(runId, seq, JSON.stringify({
    type: "message.completed",
    runId,
    seq,
    occurredAt: at.toISOString(),
    messageId: `m-${seq}`,
    role: "assistant",
    text: line,
    stopReason: "stop",
  }), at.toISOString());
}

function finishedExecutorRun(
  itemId: number,
  purpose: "execution" | "conversation" = "execution",
): number {
  const runId = createRun(db, { itemId, role: "executor", purpose, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  return runId;
}

/** 一张执行已结束、停在 review 的工单；grant=true 时同时带上 Lead 无人值守授权。 */
function delegatedReviewItem(options: { maxReworkCycles?: number; grant?: boolean } = {}) {
  const itemId = createItem(db, {
    title: "[E2E] outcome snapshot and registry mechanism",
    brief: "implement the outcome snapshot protocol",
    createdBy: "system",
    workdir,
    verificationPolicy: "independent_reviewer",
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
  const executorRunId = finishedExecutorRun(itemId);
  transition(db, {
    itemId,
    to: "review",
    actor: "child",
    reason: "Implementation complete; independent review requested",
    runId: executorRunId,
  });
  const policy = options.grant === false ? null : grantDelegationPolicy(db, {
    itemId,
    createdVia: "test",
    maxReworkCycles: options.maxReworkCycles ?? 1,
  });
  return { itemId, executorRunId, policy };
}

function reviewerVerdict(itemId: number, verdict: "pass" | "fail", evidence: string): number {
  const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
  updateRun(db, runId, { state: "running" });
  createDispatcher(db).submitReviewVerdict({ runId, verdict, evidence });
  return runId;
}

/**
 * #66 的完整历史：核查 FAIL → 用户授权 Lead 并同时启动那一次返工 → 返工链路反复崩溃 →
 * 最后一次交付靠 runtime 自我恢复进了 review → 用户在工单里问了两句（对话 Run）。
 */
function ticket66Fixture() {
  // 核查发生时还没有任何授权，所以自动化停在"等用户拍板"——#66 真实如此。
  const { itemId, executorRunId } = delegatedReviewItem({ grant: false });
  const reviewerRunId = reviewerVerdict(
    itemId,
    "fail",
    "独立核查 FAIL。关键证据：npm test 全量根测试 exit 1，checkpoint-control-plane-e2e.test.ts:783 多出 checkpoint card #5。",
  );
  // 用户在授权面板里点的"授权并返工"：授权与第一次返工是同一个动作，账上必须算数。
  const policy = grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 1 });
  transition(db, {
    itemId,
    to: "active",
    actor: "user",
    reason: "用户授权 Lead 自动返工并启动本次修复",
  });
  addActivity(db, {
    itemId,
    actor: "user",
    kind: "decision",
    payload: {
      decision: "rework_dispatch_requested",
      dispatchRequestId: 1,
      reason: "用户授权 Lead 自动返工并启动本次修复",
      reviewerRunId,
      reviewerVerdict: "fail",
      reviewerReport: "独立核查 FAIL：全量 npm test 稳定失败，且 outcome_snapshots 为空。",
      // 迁移 v35 之后 #66 的这一行带着授权编号：它属于那份授权，计入 1/1。
      delegationPolicyId: policy.id,
    },
  });

  // 返工链路：Run #49 成功并靠自我恢复把工单推到 review。
  const recoveredRunId = finishedExecutorRun(itemId);
  outcomeEnvelope(recoveredRunId, 1, "Closed the outcome-registry gap");
  const recovery = recoverOutcomeSnapshot(db, { itemId, runId: recoveredRunId, at });
  expect(recovery.transitionedToReview).toBe(true);

  // Run #50/#51：用户问"这个工单是在干什么来着""你跑吧，顺便告诉我我该怎么验收呢"。
  // 它们是回答，不是交付，没有成果快照是常态。
  const conversationRunIds = [finishedExecutorRun(itemId, "conversation"), finishedExecutorRun(itemId, "conversation")];
  return { itemId, executorRunId, reviewerRunId, recoveredRunId, conversationRunIds, policy };
}

/**
 * 真正交不出成果的那种情形：#66 的历史之后又有一次交付 Run 结束了，却没有任何成果可登记。
 * "成果未登记"和"打回 blocked"都只该在这里出现。
 */
function unregisteredDeliveryFixture() {
  const fixture = ticket66Fixture();
  transition(db, { itemId: fixture.itemId, to: "active", actor: "user", reason: "one more rework" });
  const strandedRunId = finishedExecutorRun(fixture.itemId, "execution");
  transition(db, {
    itemId: fixture.itemId, to: "review", actor: "child", reason: "rework delivered", runId: strandedRunId,
  });
  return { ...fixture, strandedRunId };
}

describe("review projection splits stage=review into its real semantics", () => {
  it("projects an unverified execution cycle as independent review, not acceptance", () => {
    const { itemId, executorRunId } = delegatedReviewItem();

    // 交付结束了，没有 reviewer 在路上，也不会有：照实说"未派发"，并允许用户手动派发。
    expect(reviewStateOf(itemId)).toMatchObject({
      state: "independent_review",
      label: "独立核查未派发",
      verdict: null,
      reworkCyclesUsed: 0,
      maxReworkCycles: 1,
      deliveryRunId: executorRunId,
      canRequestReview: true,
    });
  });

  it("keeps saying a review is coming while the delivering child is still finishing", () => {
    const { itemId } = delegatedReviewItem();

    // child 还在收尾（daemon 的 running 表里有它）：manager 收尾时会请求核查，不算"未派发"。
    const summary = controlPlane([itemId]).listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.reviewState).toMatchObject({
      state: "independent_review",
      label: "等待独立核查",
      canRequestReview: false,
    });
  });

  it("projects a reviewer PASS as delivery-pending, carrying the rework budget", () => {
    const { itemId } = delegatedReviewItem();
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    reviewerVerdict(itemId, "pass", "full regression green");

    expect(reviewStateOf(itemId)).toMatchObject({
      state: "review_passed",
      verdict: "pass",
      reworkCyclesUsed: 0,
      maxReworkCycles: 1,
    });
  });

  it("projects a reviewer FAIL with budget left as rework-pending, not deadlocked", () => {
    const { itemId } = delegatedReviewItem({ maxReworkCycles: 2 });
    db.prepare("UPDATE items SET rework_policy='ask_user' WHERE id=?").run(itemId);
    reviewerVerdict(itemId, "fail", "regression in the original acceptance scope");

    expect(reviewStateOf(itemId)).toMatchObject({
      state: "review_failed",
      label: "核查不通过，等你决定",
      verdict: "fail",
    });
  });

  it("does not promise delivery for a PASS that the automation already declined", () => {
    // PASS 发生在授权之前：自动化在出结论的那一刻就停手了（等用户验收）。之后补的授权不会再回头结单。
    const { itemId } = delegatedReviewItem({ grant: false });
    reviewerVerdict(itemId, "pass", "full regression green");
    grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 1 });
    db.prepare("UPDATE items SET acceptance_policy='delegated_to_lead' WHERE id=?").run(itemId);

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(reviewStateOf(itemId)).toMatchObject({ state: "review_passed", label: "核查通过，等待验收" });
  });

  it("does not call a spent budget a deadlock while a reviewer is still queued", () => {
    const { itemId } = delegatedReviewItem({ maxReworkCycles: 1 });
    // 真实自动化跑掉唯一一次额度：工单被打回 active 并派发返工。
    reviewerVerdict(itemId, "fail", "first cycle failed");
    expect(getItem(db, itemId)?.stage).toBe("active");
    const reworkRunId = finishedExecutorRun(itemId);
    outcomeEnvelope(reworkRunId, 1, "fixed the regression");
    recoverOutcomeSnapshot(db, { itemId, runId: reworkRunId, at });
    createDispatcher(db).request({
      itemId,
      role: "reviewer",
      purpose: "review",
      runtime: "codex",
      trigger: "automatic-review",
      idempotencyKey: `automatic-review:${itemId}:executor-run:${reworkRunId}`,
    });

    // 额度确实是 1/1，但下一轮核查已经排上队——这不是卡死，是正常流程。
    // 排队和正在跑是两种状态：请求还是 pending，没有 reviewer Run 在跑。
    expect(reviewStateOf(itemId)).toMatchObject({
      state: "independent_review",
      label: "独立核查排队中",
      reviewProgress: "queued",
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
    });
  });

  // 2026-10-20：挂起的核查不再让「派发独立核查」变灰（canRequestReview=true）：再点一次按现在能用的核查员重新选。
  it("says a queued review is paused when the dispatcher suspended it, and why", () => {
    const { itemId, executorRunId } = delegatedReviewItem();
    const requestId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:executor-run:${executorRunId}`,
    });
    db.prepare("UPDATE dispatch_requests SET suspended_reason=? WHERE id=?")
      .run("Codex 账号余额不足，修好之前不派发。", requestId);

    expect(reviewStateOf(itemId)).toMatchObject({
      state: "independent_review",
      label: "独立核查已暂停",
      reviewProgress: "suspended",
      reason: "Codex 账号余额不足，修好之前不派发。",
      canRequestReview: true,
    });
  });

  it("calls a review running only when a reviewer run is actually running", () => {
    const { itemId } = delegatedReviewItem();
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });

    expect(reviewStateOf(itemId)).toMatchObject({
      state: "independent_review", label: "独立核查中", reviewProgress: "running",
    });
  });

  it("does not count a chat with the reviewer agent as a running review", () => {
    const { itemId } = delegatedReviewItem();
    const chat = createRun(db, { itemId, role: "reviewer", purpose: "conversation", runtime: "codex" });
    updateRun(db, chat, { state: "running" });

    expect(reviewStateOf(itemId)).toMatchObject({ label: "独立核查未派发", reviewProgress: null });
  });

  it("lets a user-accepted ticket ask for an independent review, and shows it once queued", () => {
    const { itemId, executorRunId } = delegatedReviewItem({ grant: false });
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);

    // 用户自己验收的工单：照常"等你验收"，但可以先派一个独立核查。它不算卡住。
    expect(reviewStateOf(itemId)).toMatchObject({
      state: "waiting_user", canRequestReview: true, deliveryRunId: executorRunId,
    });
    createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "user-review", idempotencyKey: `user-review:${itemId}:delivery-run:${executorRunId}:1`,
    });
    expect(reviewStateOf(itemId)).toMatchObject({
      state: "independent_review", label: "独立核查排队中", reviewProgress: "queued", canRequestReview: false,
    });
  });

  it("projects the #66 history as an unreviewed delivery, not as a deadlock", () => {
    const { itemId, executorRunId, reviewerRunId, recoveredRunId, conversationRunIds } = ticket66Fixture();

    // 对话 Run 结束时，成果恢复不碰它们：没有"成果缺失"的 checkpoint，也没有 blocker。
    for (const runId of conversationRunIds) {
      expect(recordOutcomeRegistrationMissing(db, { itemId, runId, at })).toBe(false);
    }
    const summary = controlPlane().listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.stage).toBe("review");
    expect(summary.attention.blockerCount).toBe(0);
    expect(summary.reviewState).toMatchObject({
      state: "independent_review",
      label: "独立核查未派发",
      // 用户授权的那一次返工算数：额度是 1/1，不是 0/1。
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      // reviewer 的 FAIL 已被之后的交付作废，当前验证状态是"未知"而不是 FAIL。
      verdict: null,
      // 这张卡片说的是 Run #49 那次交付，不是最后一个对话 Run。
      deliveryRunId: recoveredRunId,
      canRequestReview: true,
      // F9：没有当前有效的核查。作废的那次单独说清楚：它核查的是哪次交付、被哪次交付作废。
      reviewerAttemptId: null,
      supersededReview: {
        reviewerAttemptId: reviewerRunId,
        verdict: "fail",
        reviewedRunId: executorRunId,
        supersededByRunId: recoveredRunId,
      },
    });
    expect(summary.reviewState!.outcomeRecoveryFailed).toBeUndefined();
    expect(summary.reviewState!.reason).toContain(`Run #${recoveredRunId}`);
  });

  it("projects a delivery that registered no outcome as a deadlock instead of a plain acceptance card", () => {
    const { itemId, reviewerRunId, strandedRunId } = unregisteredDeliveryFixture();

    // 先确认修复前的现实：Lead 已经把 inbox 消费掉了，attention 计数是 0，
    // 所以"有 blocker 所以会变红"这条路根本不成立。
    expect(recordOutcomeRegistrationMissing(db, { itemId, runId: strandedRunId, at })).toBe(true);
    db.prepare("UPDATE inbox SET state='consumed' WHERE item_id=?").run(itemId);
    const summary = controlPlane().listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.stage).toBe("review");
    expect(summary.attention.blockerCount).toBe(0);

    expect(summary.reviewState).toMatchObject({
      state: "rework_exhausted",
      label: "返工已用尽且成果未登记，需要你决定",
      // 用户授权的那一次返工算数：额度是 1/1，不是 0/1。
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      // reviewer 的 FAIL 已被之后的执行作废，当前验证状态是"未知"而不是 FAIL。
      verdict: null,
      // 当前没有有效核查；Run #43 那次只作为"已作废"的核查出现，哈希也不再当作当前事实。
      reviewerAttemptId: null,
      supersededReview: expect.objectContaining({ reviewerAttemptId: reviewerRunId, verdict: "fail" }),
      reviewerHashState: "unknown",
      outcomeRecoveryFailed: true,
      // 交付没有成果可核查：这时派一个 reviewer 也无事可做，不提供手动派发。
      canRequestReview: false,
    });
    expect(summary.reviewState!.reason).toContain(`Run #${strandedRunId} 结束后没有可登记的成果快照`);
    expect(summary.reviewState!.reason).toContain("当前验证状态未知");
  });
});

describe("manual rework does not spend Lead's budget", () => {
  it("counts the rework started with the grant, but not a later manual rework", () => {
    // #66：授权时顺带启动的那一次返工已经记在 1/1 里（旧数据没有授权编号，按发生在授权那一刻认）。
    const { itemId } = ticket66Fixture();
    expect(reviewStateOf(itemId)).toMatchObject({ reworkCyclesUsed: 1, maxReworkCycles: 1 });

    // 用户自己点"手动返工"：这是用户的决定，不是 Lead 在授权范围内的自动返工。
    createUserActionService({ db }).reworkItem(itemId, "补跑 typecheck 和 build");
    const delivery = finishedExecutorRun(itemId);
    transition(db, { itemId, to: "review", actor: "child", reason: "manual rework delivered", runId: delivery });

    expect(reviewStateOf(itemId)).toMatchObject({ reworkCyclesUsed: 1, maxReworkCycles: 1 });
  });
});

// release review 3：用户派发的核查要么走完，要么在它要核查的交付过时以后作废。
describe("user-requested reviews", () => {
  function userAcceptedDelivery() {
    const { itemId, executorRunId } = delegatedReviewItem({ grant: false });
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);
    return { itemId, executorRunId };
  }

  it("keeps a user-requested review going through a transient reviewer failure", () => {
    const { itemId } = userAcceptedDelivery();
    createUserActionService({ db, reviewerRuntime: "codex" }).requestReview(itemId);
    const dispatcher = createDispatcher(db);
    const claim = dispatcher.claimNext()!;
    expect(claim).toMatchObject({ role: "reviewer", trigger: "user-review" });
    updateRun(db, claim.runId, { state: "failed", endedAt: true, exitCode: 1 });
    dispatcher.completeRun(claim.runId);
    // 内核为瞬时失败排的退避重试（transient-retry.ts 的 scheduleRetry）。
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", retryOfRunId: claim.runId,
      trigger: "transient-retry", idempotencyKey: `transient-retry:${claim.runId}`,
    });

    expect(reviewStateOf(itemId)).toMatchObject({ label: "独立核查排队中", reviewProgress: "queued" });
    expect(dispatcher.claimNext()).toMatchObject({ itemId, role: "reviewer", trigger: "transient-retry" });
  });

  // 第二轮 release review N5：卡片说"排队中"的核查，dispatcher 必须真的会认领。
  it.each(["spawn-suspended", "ticket-agent-continuation", "lead"])(
    "claims a queued %s review that the card shows on a user-accepted ticket",
    (trigger) => {
      const { itemId } = userAcceptedDelivery();
      createDispatcher(db).request({
        itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger, idempotencyKey: `${trigger}:${itemId}`,
      });

      expect(reviewStateOf(itemId)).toMatchObject({ label: "独立核查排队中", reviewProgress: "queued" });
      expect(createDispatcher(db).claimNext()).toMatchObject({ itemId, role: "reviewer", trigger });
    },
  );

  it("does not carry a user-requested review over to the next delivery", () => {
    const { itemId } = userAcceptedDelivery();
    const actions = createUserActionService({ db, reviewerRuntime: "codex" });
    const { dispatchRequestId } = actions.requestReview(itemId);
    actions.reworkItem(itemId, "先补一个测试");
    // 用户点"开始执行"直接启动了返工，交付以后工单回到 review。
    const next = finishedExecutorRun(itemId);
    transition(db, { itemId, to: "review", actor: "child", reason: "rework delivered", runId: next });

    expect(reviewStateOf(itemId)).toMatchObject({
      state: "waiting_user", reviewProgress: null, canRequestReview: true, deliveryRunId: next,
    });
    expect(createDispatcher(db).claimNext()?.role).not.toBe("reviewer");
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(dispatchRequestId))
      .toEqual({ state: "cancelled" });
  });
});

describe("failed self-recovery rolls the stage back instead of parking it in review", () => {
  it("moves the ticket to blocked and raises the blocker on the live execution path", () => {
    const { itemId, strandedRunId } = unregisteredDeliveryFixture();
    expect(getItem(db, itemId)?.stage).toBe("review");

    expect(recordOutcomeRegistrationMissing(db, {
      itemId,
      runId: strandedRunId,
      at,
      demoteUnrecoveredReview: true,
    })).toBe(true);

    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(db.prepare(
      `SELECT json_extract(payload, '$.reason') AS reason FROM activities
       WHERE item_id=? AND kind='transition'
       ORDER BY id DESC LIMIT 1`,
    ).get(itemId)).toEqual({
      reason: `outcome self-recovery failed: run #${strandedRunId} ended without a registrable outcome`,
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE item_id=? AND json_extract(payload, '$.blockerCode')='outcome_registration_missing'`,
    ).get(itemId)).toEqual({ n: 1 });
    // 打回 blocked 之后，界面上再也没有 review 卡片可以渲染成"待验收"。
    const summary = controlPlane().listItems().find((ticket) => ticket.id === itemId)!;
    expect(summary.stage).toBe("blocked");
    expect(summary.reviewState).toBeUndefined();
  });

  it("leaves a conversation run alone: asking a question does not demote a ticket in review", () => {
    const { itemId, conversationRunIds } = ticket66Fixture();

    expect(recordOutcomeRegistrationMissing(db, {
      itemId,
      runId: conversationRunIds.at(-1)!,
      at,
      demoteUnrecoveredReview: true,
    })).toBe(false);

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual({ n: 0 });
  });

  it("leaves historical reconstruction alone: startup repair never rewrites the stage", () => {
    const { itemId, strandedRunId } = unregisteredDeliveryFixture();

    expect(recordOutcomeRegistrationMissing(db, { itemId, runId: strandedRunId, at })).toBe(true);

    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("writes no missing-outcome record for a delivery that a newer delivery already replaced", () => {
    // #66 的 #95：启动修复翻出 Run #48（没有成果），而 Run #49 早已交付。那条记录说明不了现在。
    const { itemId, executorRunId } = ticket66Fixture();

    expect(recordOutcomeRegistrationMissing(db, { itemId, runId: executorRunId, at })).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?")
      .get(`outcome-registration-missing:${executorRunId}`)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId))
      .toEqual({ n: 0 });
  });

  it("refuses to demote on a stale run that is no longer the ticket's latest attempt", () => {
    const { itemId, recoveredRunId } = ticket66Fixture();

    // recoveredRunId 有快照，用它构造不出 registration-missing；换一个更早的无快照 Run。
    expect(recordOutcomeRegistrationMissing(db, {
      itemId,
      runId: recoveredRunId,
      at,
      demoteUnrecoveredReview: true,
    })).toBe(false);
    expect(getItem(db, itemId)?.stage).toBe("review");
  });
});

describe("rework exhaustion notifies the user explicitly", () => {
  it("carries used cycles, per-cycle failure reasons and the real verification status", () => {
    const { itemId, policy } = delegatedReviewItem({ maxReworkCycles: 1 });
    // 第一轮：自动返工用掉唯一一次额度。
    const firstReviewer = reviewerVerdict(itemId, "fail", "cycle one: unit suite red");
    expect(getItem(db, itemId)?.stage).toBe("active");
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')='delegated_review_rework'`,
    ).get(itemId)).toEqual({ n: 1 });

    // 返工完成，再次进入 review，第二轮核查仍然 FAIL —— 额度已经没了。
    const reworkRunId = finishedExecutorRun(itemId);
    transition(db, { itemId, to: "review", actor: "child", reason: "rework complete", runId: reworkRunId });
    const secondReviewer = reviewerVerdict(itemId, "fail", "cycle two: the same regression is still red");

    expect(getItem(db, itemId)?.stage).toBe("review");
    const notice = db.prepare(
      "SELECT kind, urgency, state, title, body, dedup_key FROM notifications WHERE item_id=? AND kind='rework_exhausted'",
    ).get(itemId) as {
      kind: string; urgency: string; state: string;
      title: string; body: string; dedup_key: string;
    };

    expect(notice).toMatchObject({
      kind: "rework_exhausted",
      urgency: "immediate",
      state: "pending",
      title: `工单 #${itemId} 返工次数已用尽（1/1），自动化已停止`,
      dedup_key: `rework-exhausted:item:${itemId}:reviewer-run:${secondReviewer}`,
    });
    expect(notice.body).toContain("已用返工次数：1/1");
    expect(notice.body).toContain(`当前验证状态：FAIL（reviewer Run #${secondReviewer}）`);
    expect(notice.body).toContain("各轮失败原因：");
    expect(notice.body).toContain("[自动返工");
    expect(notice.body).toContain("cycle one: unit suite red");
    expect(notice.body).toContain("cycle two: the same regression is still red");
    expect(notice.body).toContain("自动派发已停止");
    expect(firstReviewer).toBeLessThan(secondReviewer);

    // 停手不是悄悄停：既有一条 blocker，也不再派发返工。
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=? AND trigger='delegated-review-rework'",
    ).get(itemId)).toEqual({ n: 1 });
    expect(reviewStateOf(itemId)).toMatchObject({
      state: "rework_exhausted",
      label: "返工已用尽，自动化已停止",
      verdict: "fail",
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
    });
    expect(policy?.max_rework_cycles).toBe(1);
  });

  // 发布评审：reviewDeadlock 读的是历史。返工用尽、自动化停手以后，用户手动返工，新的交付回到 review。
  // 那次停手说的是上一份交付；卡片却还按它报「返工已用尽，自动化已停止」，新的交付等核查这件事反而看不见。
  it("does not call a fresh delivery deadlocked because an earlier delivery exhausted the rework budget", () => {
    const { itemId } = delegatedReviewItem({ maxReworkCycles: 1 });
    reviewerVerdict(itemId, "fail", "cycle one: unit suite red");
    const reworkRunId = finishedExecutorRun(itemId);
    transition(db, { itemId, to: "review", actor: "child", reason: "rework complete", runId: reworkRunId });
    reviewerVerdict(itemId, "fail", "cycle two: still red");
    expect(reviewStateOf(itemId).state).toBe("rework_exhausted");

    // 用户自己返工一次，新的交付回到 review，还没有核查。
    transition(db, { itemId, to: "active", actor: "user", reason: "manual rework" });
    const manualRunId = finishedExecutorRun(itemId);
    transition(db, { itemId, to: "review", actor: "child", reason: "manual rework delivered", runId: manualRunId });

    expect(reviewStateOf(itemId).state).not.toBe("rework_exhausted");
  });

  it("says so plainly when the grant allowed no rework at all", () => {
    const { itemId } = delegatedReviewItem({ maxReworkCycles: 0 });
    const reviewerRunId = reviewerVerdict(itemId, "fail", "no budget at all");

    const body = (db.prepare(
      "SELECT body FROM notifications WHERE item_id=? AND kind='rework_exhausted'",
    ).get(itemId) as { body: string }).body;
    expect(body).toContain("已用返工次数：0/0");
    expect(body).toContain(`当前验证状态：FAIL（reviewer Run #${reviewerRunId}）`);
    expect(body).toContain("（本次授权下没有已完成的返工轮次）");
  });
});

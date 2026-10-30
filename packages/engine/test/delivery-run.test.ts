// 决策边界：哪个 executor Run 算交付（delivery-run.ts），以及交付结束后要不要请求自动核查
// （automatic-review.ts）。工单 #66 的误诊就出在这两条边界上。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunPurpose } from "@pi-lead-child/core";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { getItemTiming } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  automaticReviewDue,
  createCoordinator,
  createDispatcher,
  deliveryRunBefore,
  projectItemPow,
  isDeliveryRun,
  latestDeliveryRunId,
  unreviewedDelivery,
  reviewerProgress,
  verificationState,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-delivery-run-"), "plc.db"));
});

function reviewItem(): number {
  const itemId = createItem(db, {
    title: "deliver", brief: "b", createdBy: "system", verificationPolicy: "independent_reviewer",
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
  return itemId;
}

function finishedRun(itemId: number, purpose: RunPurpose, role: "executor" | "reviewer" = "executor"): number {
  const runId = createRun(db, { itemId, role, purpose, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  return runId;
}

describe("delivery runs", () => {
  it.each([
    ["execution", true],
    ["integration", true],
    ["learning", true],
    ["conversation", false],
    ["outcome_repair", false],
  ] as const)("treats an executor %s run as a delivery: %s", (purpose, delivery) => {
    expect(isDeliveryRun({ role: "executor", purpose })).toBe(delivery);
  });

  it("never treats a reviewer run as a delivery", () => {
    expect(isDeliveryRun({ role: "reviewer", purpose: "review" })).toBe(false);
  });

  it("skips conversation runs when it finds the latest delivery", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    finishedRun(itemId, "conversation");
    finishedRun(itemId, "conversation");

    expect(latestDeliveryRunId(db, itemId)).toBe(delivery);
  });

  // release review 6：和 reviewer agent 的对话（purpose=conversation）不是核查，它不能写下核查结论。
  // 以前只看 role：对话 Run 也是 reviewer，于是一句"看起来没问题"就成了 PASS，还会触发核查自动化。
  it("rejects a verdict from a chat with the reviewer agent", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    const chat = createRun(db, { itemId, role: "reviewer", purpose: "conversation", runtime: "codex" });
    updateRun(db, chat, { state: "running" });

    expect(() => createDispatcher(db).submitReviewVerdict({ runId: chat, verdict: "pass", evidence: "looks fine" }))
      .toThrow(`review verdict requires a review run (run #${chat} is a conversation run)`);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", latest: null });
    expect(getItem(db, itemId)?.stage).toBe("review");
  });

  it("keeps a reviewer verdict current when the user only asks the ticket a question", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "pass", evidence: "green" });

    finishedRun(itemId, "conversation");

    expect(verificationState(db, itemId)).toMatchObject({ status: "pass", supersededByRunId: null });
  });

  it("lets a new delivery supersede the verdict", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    db.prepare("UPDATE items SET rework_policy='ask_user' WHERE id=?").run(itemId);
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "fail", evidence: "red" });
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const rework = finishedRun(itemId, "execution");

    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", supersededByRunId: rework });
  });

  // 发布评审 reliability-backlog 复核：没启动成的 Run（run_start_refused）没有交出任何东西。以前它被当成最新的交付：
  // 交付 Run 还在收尾时又认领了一次执行、启动被拒，之后的核查就被记成核查了这个空的 Run，不是真正的交付。
  it("does not treat a run whose start was refused as a delivery", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    const refused = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, refused, { state: "stopped", endedAt: true, errorCode: "run_start_refused", errorMessage: "live runtime" });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });

    expect(isDeliveryRun({ role: "executor", purpose: "execution", error_code: "run_start_refused" })).toBe(false);
    expect(latestDeliveryRunId(db, itemId)).toBe(delivery);
    expect(deliveryRunBefore(db, itemId, reviewer)).toBe(delivery);
  });
});

describe("automatic review after a run ends", () => {
  const reviewing = { stage: "review" as const, verification_policy: "independent_reviewer" as const };

  it.each([
    ["execution", true],
    ["learning", true],
    ["outcome_repair", true],
    ["integration", false],
    ["conversation", false],
  ] as const)("requests a review after an executor %s run: %s", (purpose, due) => {
    expect(automaticReviewDue(reviewing, { role: "executor", purpose, state: "finished" })).toBe(due);
  });

  it("does not request a review for an unfinished run, a reviewer run, or a ticket that needs none", () => {
    expect(automaticReviewDue(reviewing, { role: "executor", purpose: "execution", state: "failed" })).toBe(false);
    expect(automaticReviewDue(reviewing, { role: "reviewer", purpose: "review", state: "finished" })).toBe(false);
    expect(automaticReviewDue(
      { ...reviewing, verification_policy: "user" },
      { role: "executor", purpose: "execution", state: "finished" },
    )).toBe(false);
    expect(automaticReviewDue(
      { ...reviewing, stage: "active" },
      { role: "executor", purpose: "execution", state: "finished" },
    )).toBe(false);
  });
});

describe("unreviewed delivery", () => {
  function strandedItem(): { itemId: number; delivery: number } {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "system", reason: "recovered", runId: delivery });
    return { itemId, delivery };
  }

  it("names the latest delivery when nothing will review it", () => {
    const { itemId, delivery } = strandedItem();
    finishedRun(itemId, "conversation");

    expect(unreviewedDelivery(db, getItem(db, itemId)!)).toEqual({ deliveryRunId: delivery });
  });

  it("is not a gap while a reviewer is queued or the delivering child is still finishing", () => {
    const { itemId, delivery } = strandedItem();
    expect(unreviewedDelivery(db, getItem(db, itemId)!, { liveItemIds: [itemId] })).toBeNull();

    createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:executor-run:${delivery}`,
    });
    expect(unreviewedDelivery(db, getItem(db, itemId)!)).toBeNull();
  });

  it("lets a user-accepted ticket ask for a review, and the dispatcher claims that request", () => {
    const { itemId, delivery } = strandedItem();
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);

    expect(unreviewedDelivery(db, getItem(db, itemId)!)).toEqual({ deliveryRunId: delivery });
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "user-review", idempotencyKey: `user-review:${itemId}:delivery-run:${delivery}:1`,
    });
    // 以前 purposeReady 只放行要求独立核查的工单，这条请求会永远排在队里。
    expect(dispatcher.claimNext()).toMatchObject({ itemId, role: "reviewer", trigger: "user-review" });
  });
});

// release review 3：用户派发的核查授权的是"核查这一次交付"，不是那一条请求。
describe("user-requested review lifecycle", () => {
  function userAcceptedDelivery(): { itemId: number; delivery: number } {
    const itemId = createItem(db, { title: "deliver", brief: "b", createdBy: "system" });
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
    return { itemId, delivery };
  }

  function requestUserReview(itemId: number, delivery: number): number {
    return createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "user-review", idempotencyKey: `user-review:${itemId}:delivery-run:${delivery}:1`,
    });
  }

  function requestState(requestId: number): string {
    return (db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId) as { state: string }).state;
  }

  function redeliver(itemId: number): number {
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "system", reason: "redelivered", runId: delivery });
    return delivery;
  }

  // 第二轮 release review N5：Lead 在 runtime 不可用时排的 reviewer 请求（spawn-suspended）和工单 agent
  // 在对话里排的核查（activate_ticket_run mode=review）都是在 review 里、为这次交付建的。以前只放行
  // user-review，它们和它们的重试在用户验收的工单上一直"排队中"，用户也没法再派核查。
  it.each(["spawn-suspended", "ticket-agent-continuation"])(
    "claims a %s reviewer request and its retry on a user-accepted ticket",
    (trigger) => {
      const { itemId } = userAcceptedDelivery();
      const dispatcher = createDispatcher(db);
      dispatcher.request({
        itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger, idempotencyKey: `${trigger}:${itemId}`,
      });
      expect(reviewerProgress(db, itemId)).toEqual({ state: "queued" });
      const claim = dispatcher.claimNext();
      expect(claim).toMatchObject({ itemId, role: "reviewer", trigger });
      updateRun(db, claim!.runId, { state: "failed", endedAt: true, exitCode: 1 });
      dispatcher.completeRun(claim!.runId);
      dispatcher.request({
        itemId, role: "reviewer", purpose: "review", runtime: "codex", retryOfRunId: claim!.runId,
        trigger: "transient-retry", idempotencyKey: `transient-retry:${claim!.runId}`,
      });

      expect(dispatcher.claimNext()).toMatchObject({ itemId, role: "reviewer", trigger: "transient-retry" });
    },
  );

  // 第三轮 release review F3：Lead 的 spawn-suspended、工单 agent 的 ticket-agent-continuation 的幂等键里
  // 没有交付。以前只靠"新交付开始时作废"兜住，而那只在 manager 启动交付时才发生；别的路径建出来的交付
  // 绕过它，旧请求就会核查一份没人要求核查的成果。现在建请求时就记下它为哪次交付而建。
  it.each(["spawn-suspended", "ticket-agent-continuation"])(
    "does not let a %s reviewer request made before a later delivery review it",
    (trigger) => {
      const { itemId } = userAcceptedDelivery();
      const requestId = createDispatcher(db).request({
        itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger, idempotencyKey: `${trigger}:${itemId}`,
      });
      redeliver(itemId);

      expect(reviewerProgress(db, itemId)).toBeNull();
      expect(createDispatcher(db).claimNext()).toBeNull();
      expect(requestState(requestId)).toBe("cancelled");
    },
  );

  it("does not let an automatic review of an older delivery review the next one", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
    const requestId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:executor-run:${delivery}`,
    });
    redeliver(itemId);

    expect(reviewerProgress(db, itemId)).toBeNull();
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(requestState(requestId)).toBe("cancelled");
  });

  it("claims the retry of a user-requested review that failed transiently", () => {
    const { itemId, delivery } = userAcceptedDelivery();
    requestUserReview(itemId, delivery);
    const dispatcher = createDispatcher(db);
    const claim = dispatcher.claimNext()!;
    updateRun(db, claim.runId, { state: "failed", endedAt: true, exitCode: 1 });
    dispatcher.completeRun(claim.runId);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", retryOfRunId: claim.runId,
      trigger: "transient-retry", idempotencyKey: `transient-retry:${claim.runId}`,
    });

    // 以前重试的 trigger 不是 user-review，用户验收的工单上它永远排在队里，卡片一直写"排队中"。
    expect(dispatcher.claimNext()).toMatchObject({ itemId, role: "reviewer", trigger: "transient-retry" });
  });

  it("expires a user-requested review once the ticket leaves review", () => {
    const { itemId, delivery } = userAcceptedDelivery();
    const requestId = requestUserReview(itemId, delivery);
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });

    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(requestState(requestId)).toBe("cancelled");
  });

  it("does not let a user-requested review of an older delivery review the next one", () => {
    const { itemId, delivery } = userAcceptedDelivery();
    const requestId = requestUserReview(itemId, delivery);
    // 下一次交付由"开始执行"直接启动，中间 dispatcher 一次也没看到工单离开 review。
    const next = redeliver(itemId);

    expect(reviewerProgress(db, itemId)).toBeNull();
    expect(unreviewedDelivery(db, getItem(db, itemId)!)).toEqual({ deliveryRunId: next });
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(requestState(requestId)).toBe("cancelled");
  });

  it("does not let a reviewer retry for an older delivery review the next one", () => {
    const itemId = reviewItem();
    const delivery = finishedRun(itemId, "execution");
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
    const failedReviewer = finishedRun(itemId, "review", "reviewer");
    updateRun(db, failedReviewer, { state: "failed" });
    const retryId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", retryOfRunId: failedReviewer,
      trigger: "transient-retry", idempotencyKey: `transient-retry:${failedReviewer}`,
    });
    redeliver(itemId);

    expect(reviewerProgress(db, itemId)).toBeNull();
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(requestState(retryId)).toBe("cancelled");
  });
});

describe("proof of work run attribution", () => {
  it("names the run behind every proof item and the latest delivery", () => {
    const itemId = reviewItem();
    const coordinator = createCoordinator({ db });
    const first = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, first, { state: "running" });
    coordinator.submitCheckpoint({
      itemId, runId: first, kind: "milestone", title: "first", summary: "first delivery",
      proofItems: [{ id: "listener", label: "Listener suite", state: "failed", evidence: "EPERM" }],
    });
    updateRun(db, first, { state: "finished", endedAt: true, exitCode: 0 });
    const second = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, second, { state: "running" });
    coordinator.submitCheckpoint({
      itemId, runId: second, kind: "milestone", title: "second", summary: "rework",
      proofItems: [{ id: "suite", label: "Full suite", state: "passed", evidence: "green" }],
    });
    updateRun(db, second, { state: "finished", endedAt: true, exitCode: 0 });
    finishedRun(itemId, "conversation");

    const pow = projectItemPow(db, getItem(db, itemId)!, getItemTiming(db, itemId, new Date()), [], new Date());

    // item_proof_items 是 checkpoint 的物化表：Run 来自 checkpoint，不需要再存一份。
    expect(pow.items.map((item) => [item.id, item.attemptId])).toEqual([["listener", first], ["suite", second]]);
    expect(pow.deliveryAttemptId).toBe(second);
  });

  // release review 4：reviewer 和对话 Run 报的条目说的是它们之前那次交付，不是一次更早的交付。
  // 以前它们的 attemptId 不等于最新交付，companion 把它们放进"历史证据"，
  // 于是 PASS 之后对话 Run 报的一条失败项从当前证据里消失，卡片却仍然是 attention。
  it("attributes reviewer and conversation items to the delivery before them", () => {
    const itemId = reviewItem();
    const coordinator = createCoordinator({ db });
    const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, delivery, { state: "running" });
    coordinator.submitCheckpoint({
      itemId, runId: delivery, kind: "milestone", title: "delivered", summary: "delivery",
      proofItems: [{ id: "suite", label: "Full suite", state: "passed", evidence: "green" }],
    });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    coordinator.submitCheckpoint({
      itemId, runId: reviewer, kind: "milestone", title: "reviewed", summary: "independent review",
      proofItems: [{ id: "regression", label: "Regression replay", state: "passed", evidence: "replayed" }],
    });
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "pass", evidence: "green" });
    const chat = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "codex" });
    updateRun(db, chat, { state: "running" });
    coordinator.submitCheckpoint({
      itemId, runId: chat, kind: "milestone", title: "checked again", summary: "user asked",
      proofItems: [{ id: "manual", label: "Manual check", state: "failed", evidence: "button missing" }],
    });
    updateRun(db, chat, { state: "finished", endedAt: true, exitCode: 0 });

    const pow = projectItemPow(db, getItem(db, itemId)!, getItemTiming(db, itemId, new Date()), [], new Date());

    expect(pow.items.map((item) => [item.id, item.attemptId, item.deliveryAttemptId])).toEqual([
      ["suite", delivery, delivery],
      ["regression", reviewer, delivery],
      ["manual", chat, delivery],
    ]);
    expect(pow.deliveryAttemptId).toBe(delivery);
    expect(pow.verdict).toBe("attention");
  });
});


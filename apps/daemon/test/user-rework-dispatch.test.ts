import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { createUserActionService } from "@pi-lead-child/gateway";
import { spawnItemChild, type LeadDeps } from "@pi-lead-child/lead";
import { createOrchestrator } from "@pi-lead-child/engine";
import { addActivity, listActivities } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { linkTickets } from "@pi-lead-child/store";
import { createRun, listRuns, updateRun, writeReviewVerdictDetails } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;
let dataDir: string;

beforeEach(() => {
  dataDir = tempDir("plc-user-rework-");
  db = openDb(join(dataDir, "plc.db"));
});

function runtime() {
  return {
    model: "stub/model",
    sessionId: "stub-session",
    busy: false,
    runningItemIds: [],
    aish: null,
  };
}

function reviewItem(options: {
  retryLimit?: number;
  runtime?: "pi" | "codex" | "claude";
  costBudgetUsd?: number;
  failedExecutor?: boolean;
  verdict?: "pass" | "fail";
  evidence?: string;
  // 核查员在 review_verdict 里声明的 escalate（工单 10）。
  escalate?: { reason: "evidence_conflict" | "requirement_change"; note: string };
} = {}) {
  const itemId = createItem(db, {
    title: "reviewed",
    brief: "ship the fix",
    createdBy: "system",
    retryLimit: options.retryLimit,
    runtime: options.runtime,
    costBudgetUsd: options.costBudgetUsd,
  });
  const executorRunId = createRun(db, { itemId, runtime: options.runtime ?? "pi" });
  transition(db, { itemId, to: "active", actor: "system", reason: "started" });
  updateRun(db, executorRunId, {
    state: options.failedExecutor ? "failed" : "finished",
    endedAt: true,
    ...(options.failedExecutor ? { errorCode: "process_exit", errorMessage: "previous run failed" } : {}),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "ready for review", runId: executorRunId });
  const reviewerRunId = createRun(db, { itemId, role: "reviewer", runtime: "codex", purpose: "review" });
  updateRun(db, reviewerRunId, { state: "finished", endedAt: true });
  if (options.escalate) {
    writeReviewVerdictDetails(db, { runId: reviewerRunId, itemId, executorRunId, escalate: options.escalate, criteria: [] });
  }
  db.prepare(
    "INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, ?, ?)",
  ).run(
    reviewerRunId,
    itemId,
    options.verdict ?? "fail",
    options.evidence ?? "tests failed: regression still reproduces",
  );
  return { itemId, executorRunId, reviewerRunId };
}

describe("user-requested rework dispatch", () => {
  it("records reviewer evidence, moves the original item active, and queues one rework run", () => {
    const { itemId, reviewerRunId } = reviewItem();
    addActivity(db, {
      itemId,
      actor: "lead",
      kind: "comment",
      payload: { content: "返工要求：补上失败用例并重新验证。" },
    });

    createUserActionService({ db }).reworkItem(itemId, "用户点击打回返工");

    expect(getItem(db, itemId)).toMatchObject({ stage: "active" });
    expect(getItem(db, itemId)!.body).toContain("【用户返工请求】");
    expect(getItem(db, itemId)!.body).toContain(`reviewer_run: #${reviewerRunId}`);
    expect(getItem(db, itemId)!.body).toContain("tests failed: regression still reproduces");
    expect(getItem(db, itemId)!.body).toContain("返工要求：补上失败用例并重新验证。");
    expect(getItem(db, itemId)!.last_activity_at).not.toBeNull();
    expect(db.prepare(
      "SELECT role, purpose, trigger, state FROM dispatch_requests WHERE item_id=?",
    ).get(itemId)).toEqual({
      role: "executor",
      purpose: "execution",
      trigger: "user-rework",
      state: "pending",
    });
    expect(listRuns(db, itemId)).toHaveLength(2);
    expect(listActivities(db, itemId, 1000).map((activity) => JSON.parse(activity.payload).decision).filter(Boolean))
      .toEqual(expect.arrayContaining(["dispatch_requested", "rework_dispatch_requested"]));

    const claim = createDispatcher(db).claimNext();
    expect(claim).toMatchObject({ itemId, role: "executor", purpose: "execution", trigger: "user-rework" });
    expect(listRuns(db, itemId)).toHaveLength(3);
  });

  it("treats duplicate clicks as the same active rework request", () => {
    const { itemId } = reviewItem();
    const service = createUserActionService({ db });

    service.reworkItem(itemId, "first click");
    service.reworkItem(itemId, "second click");

    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ n: 1 });
    expect((getItem(db, itemId)!.body.match(/【用户返工请求】/g) ?? [])).toHaveLength(1);
    expect(listActivities(db, itemId, 1000).some((activity) =>
      JSON.parse(activity.payload).decision === "rework_request_replayed")).toBe(true);
  });

  it("keeps dependency-blocked rework queued without creating a run", () => {
    const { itemId } = reviewItem();
    const blockerId = createItem(db, { title: "blocking dependency", brief: "b", createdBy: "system" });
    linkTickets(db, {
      sourceTicketId: itemId,
      targetTicketId: blockerId,
      relationType: "depends_on",
      reason: "rework depends on this unfinished item",
      actor: "lead",
    });

    createUserActionService({ db }).reworkItem(itemId, "needs dependency first");

    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ state: "pending" });
    expect(listRuns(db, itemId)).toHaveLength(2);
    expect(listActivities(db, itemId, 1000).some((activity) =>
      JSON.parse(activity.payload).decision === "dispatch_blocked_by_ticket_relation")).toBe(true);
    expect(createControlPlaneService(db, { runtime }).getItem(itemId)?.ticket.executionState)
      .toMatchObject({ kind: "rework", state: "blocked", label: "返工派发受阻" });
  });

  it("surfaces dispatch startup failure as a blocked item with a failed request", async () => {
    const { itemId } = reviewItem({ runtime: "pi" });
    createUserActionService({ db }).reworkItem(itemId, "start and fail visibly");
    const orchestrator = createOrchestrator(db, {
      onDispatch: () => { throw new Error("runtime missing"); },
    });

    await orchestrator.tick();

    expect(getItem(db, itemId)).toMatchObject({ stage: "blocked" });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ state: "failed" });
    expect(db.prepare(
      "SELECT state, error_code FROM runs WHERE item_id=? AND role='executor' ORDER BY id DESC LIMIT 1",
    ).get(itemId)).toEqual({ state: "failed", error_code: "dispatch_start_failed" });
    expect(createControlPlaneService(db, { runtime }).getItem(itemId)?.ticket.executionState)
      .toMatchObject({ kind: "rework", state: "failed", label: "返工启动失败" });

    expect(createControlPlaneService(db, { runtime }).getItem(itemId)?.ticket.executionState?.reason)
      .toMatch(/Pi agent .*Run #.*runtime missing.*runtime_unavailable/);
  });

  it("records retry exhaustion and budget blockers instead of silently staying active", () => {
    const retry = reviewItem({ retryLimit: 0, failedExecutor: true });
    createUserActionService({ db }).reworkItem(retry.itemId, "retry budget is gone");

    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(getItem(db, retry.itemId)).toMatchObject({ stage: "blocked" });
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE item_id=?").get(retry.itemId))
      .toEqual({ state: "cancelled" });
    expect(listActivities(db, retry.itemId, 1000).some((activity) =>
      JSON.parse(activity.payload).decision === "dispatch_blocked_retry_exhausted")).toBe(true);

    const budget = reviewItem({ runtime: "codex", costBudgetUsd: 1 });
    createUserActionService({ db }).reworkItem(budget.itemId, "cost budget requires estimator");
    expect(createDispatcher(db, { hasCostEstimator: () => false }).claimNext()).toBeNull();
    expect(getItem(db, budget.itemId)).toMatchObject({ stage: "blocked" });
    expect(listActivities(db, budget.itemId, 1000).some((activity) =>
      JSON.parse(activity.payload).decision === "dispatch_blocked_by_budget")).toBe(true);
  });

  it("prevents Lead manual spawn from racing a queued rework dispatch into a second run", () => {
    const { itemId } = reviewItem();
    createUserActionService({ db }).reworkItem(itemId, "queued by user");
    const deps: LeadDeps = {
      db,
      dbPath: join(dataDir, "plc.db"),
      dataDir,
    };

    expect(() => spawnItemChild(deps, itemId, {})).toThrow(/已有派发请求/);
    expect(listRuns(db, itemId)).toHaveLength(2);
  });

  it("projects review states from reviewer verdicts instead of stage alone", () => {
    const noVerdict = createItem(db, {
      title: "await reviewer",
      brief: "b",
      createdBy: "system",
      verificationPolicy: "independent_reviewer",
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(noVerdict);
    // 证据冲突只看核查员声明的 escalate（工单 10）：证据文本里写着 EVIDENCE_CONFLICT 不算。
    const conflict = reviewItem({
      evidence: "reviewer disagrees with artifact",
      escalate: { reason: "evidence_conflict", note: "测试结果和自述对不上" },
    });
    const keyword = reviewItem({ evidence: "EVIDENCE_CONFLICT reviewer disagrees with artifact" });
    const requirement = reviewItem({ evidence: "做的不是任务说明里的事", escalate: { reason: "requirement_change", note: "像是需求变了" } });
    const passed = reviewItem({ verdict: "pass", evidence: "tests passed" });
    const service = createControlPlaneService(db, { runtime });

    expect(service.getItem(noVerdict)?.ticket.reviewState)
      .toMatchObject({ state: "independent_review", label: "等待独立核查" });
    expect(service.getItem(conflict.itemId)?.ticket.reviewState)
      .toMatchObject({ state: "evidence_conflict", label: "证据冲突，等待用户决策" });
    expect(service.getItem(keyword.itemId)?.ticket.reviewState)
      .toMatchObject({ state: "review_failed", label: "核查不通过，等你决定" });
    expect(service.getItem(requirement.itemId)?.ticket.reviewState)
      .toMatchObject({ state: "review_failed", label: "核查不通过，核查员要你决定：需求变了" });
    expect(service.getItem(passed.itemId)?.ticket.reviewState)
      .toMatchObject({ state: "review_passed", label: "核查通过，等待验收" });
  });
});

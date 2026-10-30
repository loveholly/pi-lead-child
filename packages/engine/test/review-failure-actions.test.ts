// 核查没做成时的处理，托管规则补齐（工单 11，spec 5.8、D11）：
//   - retry_review、change_reviewer、accept_without_review 是工单操作。「没做成」不算返工次数。
//   - D11：授权托管时预先勾选「核查做不成时由 Lead 凭证据验收」。勾了，并且所有核查员都不能用：Lead 按证据验收，账本标明没有独立核查。
//     没勾：等你验收，只通知一次。
//   - 不要求独立核查的工单不能授权托管：预检直接给出原因，GET .../actions 里「授权托管」不可用并带上原因。
//   - 授权托管是 user_direct：Lead 调用总是被拒，拒绝里写明去哪里点。
//   - 终态不被派生状态改写：验收以后，跑着的核查交来的结论不再算数。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { defaultRuntimeProfile, runtimeIds, typedFailure } from "@pi-lead-child/runtime";
import {
  activeDelegationPolicy, createItem, createLoopbackBinding, createRun, createTurn, delegationPreflight, getItem, getRun,
  grantDelegationPolicy, listActivities, openDb, recordDeliverySnapshot, recordRuntimeHealthFailure, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { reworkExhaustion } from "../src/coordinator/review-authority.js";
import { ticketReviews } from "../src/coordinator/review-verdict.js";
import { automaticReviewRequest, reviewerAvailability } from "../src/pipeline/automatic-review.js";
import {
  listLeadTicketActions, listTicketActions, runTicketAction, TicketActionError, type TicketActionCaller,
} from "../src/ticket-actions/index.js";

let db: Db;
const configuredReviewer = process.env.PLC_REVIEW_RUNTIME;
beforeEach(() => {
  db = openDb(join(tempDir("plc-review-failure-"), "plc.db"));
  delete process.env.PLC_REVIEW_RUNTIME;
});
afterEach(() => {
  db.close();
  if (configuredReviewer === undefined) delete process.env.PLC_REVIEW_RUNTIME;
  else process.env.PLC_REVIEW_RUNTIME = configuredReviewer;
});

const USER: TicketActionCaller = { kind: "user" };
const LEAD: TicketActionCaller = { kind: "lead", turnId: null };

function delivered(options: { verification?: "independent_reviewer" | "lead_static"; snapshot?: boolean } = {}) {
  const itemId = createItem(db, {
    title: "修复空输入", brief: "b", createdBy: "lead", verificationPolicy: options.verification ?? "independent_reviewer",
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const executorRunId = createRun(db, { itemId, runtime: "pi" });
  updateRun(db, executorRunId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered", runId: executorRunId });
  if (options.snapshot !== false) {
    recordDeliverySnapshot(db, {
      itemId, executorRunId, reason: "delivered", source: "agent", baseSha: null, headSha: null,
      commits: [], commitCount: 0, files: [], totals: null, truncated: false, uncommittedFiles: null,
    });
  }
  return { itemId, executorRunId };
}

// 核查 Run 跑了但没做成：失败了，没交结论。
function failedReview(itemId: number, runtime: "claude" | "codex" = "claude"): number {
  const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime, model: "sonnet" });
  updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "runtime_exit", errorMessage: "timeout after 30m" });
  return runId;
}

// 每一个 runtime 的账号都坏了：一个能用的核查员都没有。
function noReviewerCanRun(itemId: number, runId: number): void {
  for (const runtime of runtimeIds()) {
    recordRuntimeHealthFailure(db, {
      profile: defaultRuntimeProfile(runtime), model: null, itemId, runId,
      failure: typedFailure("auth_required", { errorCode: `${runtime}_error`, message: "402 deactivated_workspace" }),
    });
  }
}

const action = async (itemId: number, id: string) => (await listTicketActions(db, itemId)).find((entry) => entry.id === id)!;
const decisions = (itemId: number) => listActivities(db, itemId)
  .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
  .filter((payload) => typeof payload.decision === "string");
const blockedNotes = (itemId: number) => db.prepare(
  "SELECT summary, payload FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='delegated_review_blocked'",
).all(itemId) as Array<{ summary: string; payload: string }>;

describe("D11: a delegated ticket whose review cannot run", () => {
  it("lets Lead accept on evidence when the user pre-checked it, and the ledger says there was no independent review", async () => {
    const { itemId, executorRunId } = delivered();
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true });
    expect(policy.accept_without_review).toBe(1);
    noReviewerCanRun(itemId, executorRunId);
    const dispatcher = createDispatcher(db);
    dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));
    expect(dispatcher.claimNext()).toBeNull();
    expect(dispatcher.claimNext()).toBeNull();

    // 叫醒 Lead 一次，告诉它可以凭证据验收；你不用做什么。
    const notes = blockedNotes(itemId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toContain("凭证据验收");
    expect(JSON.parse(notes[0]!.payload)).toMatchObject({ wakeLead: true, needsUser: false, leadMayAcceptWithoutReview: true });

    const listed = (await listLeadTicketActions(db, itemId, { turnId: null })).find((entry) => entry.id === "accept_without_review");
    expect(listed).toMatchObject({ available: true, lead: "delegated", leadReady: true });
    const outcome = await runTicketAction(db, {
      itemId, action: "accept_without_review", caller: LEAD,
      reason: "读了交付快照和成果说明：两个文件都改了，npm test 的输出贴在成果里",
    });
    expect(outcome.authority).toBe("delegated");
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      decision: "accepted_without_review", independentReview: false, authority: "delegated", deliveryRunId: executorRunId,
      delegationPolicyId: policy.id, reviewProblem: expect.stringContaining("核查挂起了"),
    }));
    const transitionReason = db.prepare(
      "SELECT json_extract(payload, '$.reason') FROM activities WHERE item_id=? AND kind='transition' ORDER BY id DESC LIMIT 1",
    ).pluck().get(itemId) as string;
    expect(transitionReason).toContain("没有独立核查");
    expect(transitionReason).toContain("代为验收");
    expect(db.prepare("SELECT kind, urgency, title FROM notifications WHERE item_id=? AND kind='accepted_without_review'").all(itemId))
      .toEqual([{ kind: "accepted_without_review", urgency: "immediate", title: expect.stringContaining("没有独立核查") }]);
    // 界面和 Lead 读到的核查一节写明没有独立核查。
    expect(ticketReviews(db, itemId)!.acceptedWithoutReview).toEqual({
      by: "lead", onBehalfOf: null, authority: "delegated", reason: expect.stringContaining("读了交付快照"),
      reviewProblem: expect.stringContaining("核查挂起了"), at: expect.any(String),
    });
  });

  // 2026-10-28（用户：「工单操作让 Lead 自己判断」）：托管范围外，凭证据验收是 Lead 自己的判断，账本写 Lead 做的（不是凭托管）。
  it("tells the user once when the option was not checked, and leaves the call to Lead", async () => {
    const { itemId, executorRunId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test" });
    noReviewerCanRun(itemId, executorRunId);
    const dispatcher = createDispatcher(db);
    dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));
    for (let tick = 0; tick < 3; tick++) expect(dispatcher.claimNext()).toBeNull();

    const notes = blockedNotes(itemId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toContain("亲自验收");
    expect(JSON.parse(notes[0]!.payload)).toMatchObject({ wakeLead: true, needsUser: true, leadMayAcceptWithoutReview: false });

    const listed = (await listLeadTicketActions(db, itemId, { turnId: null })).find((entry) => entry.id === "accept_without_review");
    expect(listed).toMatchObject({ available: true, lead: "own", leadReady: true });
    expect(await runTicketAction(db, { itemId, action: "accept_without_review", caller: LEAD, reason: "读了交付和测试输出，符合验收标准" }))
      .toMatchObject({ authority: "lead" });
    expect(getItem(db, itemId)!.stage).toBe("done");
  });

  // 审查 2026-10-22 第 1 条：Lead 停用全部执行器就能造出 D11 的前提。Lead 停用的执行器按能用算；用户停用的、有故障的才算不能用。
  it("does not count runtimes Lead disabled itself toward the delegation's scope", async () => {
    const { itemId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true });
    vi.stubEnv("PLC_DISABLED_RUNTIMES", runtimeIds().join(","));
    try {
      const at = "2026-10-22T00:00:00.000Z";
      const byLead = { runtimeDisabledBy: () => ({ by: "lead" as const, reason: "先停一下", at }) };
      const lead = async (host: object) =>
        (await listLeadTicketActions(db, itemId, { turnId: null, host })).find((entry) => entry.id === "accept_without_review");
      // 不在托管范围里：是 Lead 自己的判断（账本不写凭托管）。
      expect(await lead(byLead)).toMatchObject({ lead: "own", leadReady: true });
      // 不知道是谁停用的（宿主没有给）：也不算不能用。
      expect(await lead({})).toMatchObject({ lead: "own" });
      // 用户停用的：算不能用，在托管范围内。
      expect(await lead({ runtimeDisabledBy: () => ({ by: "user" as const, reason: null, at }) })).toMatchObject({ lead: "delegated" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 审查 2026-10-22 第 2 条：D11 这条路不查托管的用量上限。核查 PASS 在同样的情况下会升级给用户。
  it("takes the delegation out of scope once its usage budget is spent", async () => {
    const { itemId, executorRunId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true, budgetLimitTokens: 1_000_000 });
    db.prepare("UPDATE items SET total_tokens=2000000 WHERE id=?").run(itemId);
    noReviewerCanRun(itemId, executorRunId);
    const listed = (await listLeadTicketActions(db, itemId, { turnId: null })).find((entry) => entry.id === "accept_without_review");
    expect(listed).toMatchObject({ lead: "own", leadReady: true });
  });

  // 复核 2026-10-23 第 2 条：核查挂起的通知以前只看勾选和额度。一部分执行器是 Lead 停的、其余有故障时，通知说「Lead 会凭证据验收」，
  // 实际上 Lead 不在托管范围里。通知和托管范围用同一个判断。
  it("tells the user to decide when Lead disabled some runtimes and the rest are down", async () => {
    const { itemId, executorRunId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true });
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");
    try {
      for (const runtime of runtimeIds().filter((id) => id !== "codex")) {
        recordRuntimeHealthFailure(db, {
          profile: defaultRuntimeProfile(runtime), model: null, itemId, runId: executorRunId,
          failure: typedFailure("auth_required", { errorCode: `${runtime}_error`, message: "402 deactivated_workspace" }),
        });
      }
      const runtimeDisabledBy = () => ({ by: "lead" as const, reason: "先停一下", at: "2026-10-23T00:00:00.000Z" });
      const dispatcher = createDispatcher(db, { runtimeDisabledBy });
      dispatcher.request(automaticReviewRequest(itemId, executorRunId, "claude"));
      expect(dispatcher.claimNext()).toBeNull();
      const notes = blockedNotes(itemId);
      expect(notes).toHaveLength(1);
      expect(JSON.parse(notes[0]!.payload)).toMatchObject({ needsUser: true, leadMayAcceptWithoutReview: false });
      expect(notes[0]!.summary).toContain("亲自验收");
      // 和 Lead 看到的托管范围一致。
      const listed = (await listLeadTicketActions(db, itemId, { turnId: null, host: { runtimeDisabledBy } }))
        .find((entry) => entry.id === "accept_without_review");
      expect(listed).toMatchObject({ lead: "own" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the delegation out of scope while some reviewer can still run", async () => {
    const { itemId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true });
    const listed = (await listLeadTicketActions(db, itemId, { turnId: null })).find((entry) => entry.id === "accept_without_review");
    expect(listed).toMatchObject({ lead: "own", leadReady: true });
  });
});

describe("accept_without_review", () => {
  it("leaves a record that the delivery had no independent review", async () => {
    const { itemId, executorRunId } = delivered();
    const reviewer = failedReview(itemId);
    const outcome = await runTicketAction(db, { itemId, action: "accept_without_review", caller: USER });
    expect(outcome.result).toMatchObject({ stage: "done", independentReview: false });
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      decision: "accepted_without_review", independentReview: false, authority: "user", deliveryRunId: executorRunId,
      reviewProblem: `核查 Run #${reviewer} 没做成（failed：timeout after 30m）`,
    }));
    const record = listActivities(db, itemId).find((activity) => JSON.parse(activity.payload).decision === "accepted_without_review")!;
    expect(record.actor).toBe("user");
  });

  // 审查 2026-10-22 第 5 条：交付快照没存成时，核查一节整个是空的，页面和 Lead 都看不到「没有独立核查」。
  it("shows the record even when the delivery has no snapshot", async () => {
    const { itemId, executorRunId } = delivered({ snapshot: false });
    await runTicketAction(db, { itemId, action: "accept_without_review", caller: USER });
    const view = ticketReviews(db, itemId)!;
    expect(view.delivery).toEqual({ sequence: null, attemptId: executorRunId, latest: true });
    expect(view.acceptedWithoutReview).toMatchObject({ by: "user", authority: "user" });
  });

  it("is not offered once the latest delivery has a verdict", async () => {
    const { itemId } = delivered();
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "fail", evidence: "没做到" });
    expect(await action(itemId, "accept_without_review")).toMatchObject({ available: false, reason: expect.stringContaining("用「验收」") });
  });

  it("stops a running review, and that review's late verdict cannot reopen the done ticket", async () => {
    const { itemId } = delivered();
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    updateRun(db, reviewer, { state: "running" });
    await runTicketAction(db, { itemId, action: "accept_without_review", caller: USER });
    expect(getRun(db, reviewer)!.state).toBe("stopped");
    expect(() => createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "fail", evidence: "晚到的结论" })).toThrow();
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(db.prepare("SELECT COUNT(*) FROM review_verdicts WHERE item_id=?").pluck().get(itemId)).toBe(0);
  });
});

describe("retry_review", () => {
  it("re-dispatches the same reviewer and does not count as a rework cycle", async () => {
    const { itemId } = delivered();
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
    const failed = failedReview(itemId, "claude");
    expect(await action(itemId, "retry_review")).toMatchObject({ available: true, permission: "lead_allowed" });

    const outcome = await runTicketAction(db, { itemId, action: "retry_review", caller: LEAD, reason: "核查超时了，再试一次" });
    expect(outcome.result).toMatchObject({ retryOfRunId: failed, runtime: "claude", model: "sonnet" });
    expect(db.prepare(
      "SELECT role, purpose, runtime, model, retry_of_run_id, trigger, state FROM dispatch_requests WHERE item_id=?",
    ).all(itemId)).toEqual([{
      role: "reviewer", purpose: "review", runtime: "claude", model: "sonnet", retry_of_run_id: failed, trigger: "lead-review-retry", state: "pending",
    }]);
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({ decision: "review_retry_requested", failedRunId: failed }));
    // 「没做成」不算返工次数。
    expect(reworkExhaustion(db, getItem(db, itemId)!, activeDelegationPolicy(db, itemId)!)).toMatchObject({ cyclesUsed: 0, exhausted: false });
    expect(policy.max_rework_cycles).toBe(1);
    // 核查已经排上了：不能再重试。
    expect(await action(itemId, "retry_review")).toMatchObject({ available: false, reason: "核查已经在路上，不用重试。" });
  });

  it("is not offered when nothing failed, and points to another reviewer when the last one cannot run", async () => {
    const { itemId, executorRunId } = delivered();
    expect(await action(itemId, "retry_review")).toMatchObject({ available: false, reason: expect.stringContaining("没有没做成的核查") });
    failedReview(itemId, "codex");
    recordRuntimeHealthFailure(db, {
      profile: defaultRuntimeProfile("codex"), model: null, itemId, runId: executorRunId,
      failure: typedFailure("auth_required", { errorCode: "codex_error", message: "402 deactivated_workspace" }),
    });
    const listed = await action(itemId, "retry_review");
    expect(listed).toMatchObject({ available: false, reason: expect.stringContaining("请换一个核查员") });
    // 换核查员在这时可以做（工单 09 的 change_reviewer 接在同一个操作层）。
    expect(await action(itemId, "change_reviewer")).toMatchObject({ available: true });
  });
});

describe("delegation needs an independent review", () => {
  it("fails the preflight with the reason, and shows 授权托管 unavailable with that reason", async () => {
    const { itemId } = delivered({ verification: "lead_static" });
    const preflight = delegationPreflight(db, { itemId, createdVia: "test", reviewer: reviewerAvailability(db) });
    expect(preflight.canAccept).toBe(false);
    const check = preflight.checks.find((entry) => entry.id === "verification_authority")!;
    expect(check).toMatchObject({ state: "failed", evidence: expect.stringContaining("这张工单不要求独立核查（verification_policy=lead_static）") });
    expect(await action(itemId, "delegate")).toEqual(expect.objectContaining({
      available: false, permission: "user_direct", reason: check.evidence,
    }));
    await expect(runTicketAction(db, { itemId, action: "delegate", caller: USER }))
      .rejects.toMatchObject({ code: "unavailable", message: check.evidence });
    expect(activeDelegationPolicy(db, itemId)).toBeNull();
    // 以前授权时会把工单改成独立核查。现在不授权，也不改。
    expect(getItem(db, itemId)!.verification_policy).toBe("lead_static");
  });

  it("grants with the D11 option from the page, refuses Lead with where to click", async () => {
    const { itemId, executorRunId } = delivered();
    // 所有核查员都不能用：没勾时托管不生效，勾了照样生效。
    noReviewerCanRun(itemId, executorRunId);
    await expect(runTicketAction(db, { itemId, action: "delegate", caller: USER }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("勾选「核查做不成时由 Lead 凭证据验收」") });
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "turn-delegate", originBindingId: binding.id, originKind: "paired:companion", userText: "托管吧", state: "streaming" });
    // 用户这一轮里 Lead 也不能代做：给 Lead 授权的操作只有用户本人能做。
    const refused = await runTicketAction(db, {
      itemId, action: "delegate", input: { acceptWithoutReview: true }, caller: { kind: "lead", turnId: turn.id }, reason: "用户说托管吧",
    }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(TicketActionError);
    expect(refused).toMatchObject({ code: "user_direct", message: expect.stringContaining("工单详情的「授权托管」") });
    expect((await listLeadTicketActions(db, itemId, { turnId: turn.id })).find((entry) => entry.id === "delegate"))
      .toMatchObject({ lead: "user_direct", leadReady: false });

    const outcome = await runTicketAction(db, { itemId, action: "delegate", input: { acceptWithoutReview: true }, caller: USER });
    expect(outcome.result).toMatchObject({ granted: true, policy: { accept_without_review: 1 }, reworkStarted: false });
    expect((outcome.result as { preflight: { checks: Array<{ id: string; state: string }> } }).preflight.checks
      .find((entry) => entry.id === "reviewer_runtime")).toMatchObject({ state: "warning" });
    expect(getItem(db, itemId)!.acceptance_policy).toBe("delegated_to_lead");
  });
});

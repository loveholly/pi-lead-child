import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDispatcher, type DispatchRequestInput } from "@pi-lead-child/engine";
import { processContinuations } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  delegationPreflight,
  grantDelegationPolicy,
  recordDelegationPreflight,
  revokeDelegationPolicy,
} from "@pi-lead-child/store";
import { createContinuation, enqueueContinuationEvent } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { markCapabilityDeployed } from "@pi-lead-child/store";
import { markNotificationDelivered, ackNotification } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";
import { linkTickets } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-delegated-workflow-"), "plc.db"));
});

function reviewItem(options: { delegated?: boolean; maxReworkCycles?: number } = {}) {
  const itemId = createItem(db, {
    title: "delegated review",
    brief: "must pass tests",
    createdBy: "system",
    verificationPolicy: "independent_reviewer",
  });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const executorRunId = createRun(db, { itemId, role: "executor", purpose: "execution" });
  transition(db, { itemId, to: "review", actor: "child", reason: "done" });
  const policy = options.delegated
    ? grantDelegationPolicy(db, {
        itemId,
        createdVia: "test",
        maxReworkCycles: options.maxReworkCycles,
      })
    : null;
  const reviewerRunId = createRun(db, { itemId, role: "reviewer", purpose: "review" });
  return { itemId, executorRunId, reviewerRunId, policy };
}

function notificationKinds(itemId: number) {
  return db.prepare("SELECT kind, state, dedup_key FROM notifications WHERE item_id=? ORDER BY id")
    .all(itemId) as Array<{ kind: string; state: string; dedup_key: string | null }>;
}

describe("delegated review automation", () => {
  it("keeps legacy automatic review user-only without a delegation policy", () => {
    const { itemId, reviewerRunId } = reviewItem();
    createDispatcher(db).submitReviewVerdict({
      runId: reviewerRunId,
      verdict: "pass",
      evidence: "tests passed",
    });

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(notificationKinds(itemId)).toEqual([
      expect.objectContaining({ kind: "review_passed", state: "pending" }),
    ]);
    expect(db.prepare(
      "SELECT json_extract(payload, '$.decision') AS decision FROM activities WHERE item_id=? AND kind='decision'",
    ).all(itemId)).toContainEqual({ decision: "review_verdict_waiting_user" });
  });

  it("accepts reviewer PASS under delegated_to_lead and records authority", () => {
    const { itemId, reviewerRunId, policy } = reviewItem({ delegated: true });
    createDispatcher(db).submitReviewVerdict({
      runId: reviewerRunId,
      verdict: "pass",
      evidence: "tests passed",
    });

    expect(getItem(db, itemId)?.stage).toBe("done");
    expect(notificationKinds(itemId)).toEqual([
      expect.objectContaining({ kind: "review_passed", state: "pending" }),
    ]);
    expect(db.prepare(
      `SELECT json_extract(payload, '$.decision') AS decision,
              json_extract(payload, '$.delegationPolicyId') AS policyId,
              json_extract(payload, '$.reviewerRunId') AS reviewerRunId
       FROM activities WHERE item_id=? AND kind='decision'`,
    ).all(itemId)).toContainEqual({
      decision: "delegated_review_accept",
      policyId: policy!.id,
      reviewerRunId,
    });
    expect(db.prepare("SELECT event_type, item_id FROM continuation_events").all())
      .toEqual([{ event_type: "review_passed", item_id: itemId }]);
  });

  it("requests automatic rework on the original item, without creating a duplicate task", () => {
    const { itemId, executorRunId, reviewerRunId, policy } = reviewItem({ delegated: true, maxReworkCycles: 2 });
    createDispatcher(db).submitReviewVerdict({
      runId: reviewerRunId,
      verdict: "fail",
      evidence: "test regression in original acceptance scope",
    });

    expect(getItem(db, itemId)?.stage).toBe("active");
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(1);
    expect(db.prepare(
      `SELECT item_id, trigger, idempotency_key, resume_from_run_id, instruction
       FROM dispatch_requests ORDER BY id`,
    ).all()).toEqual([
      {
        item_id: itemId,
        trigger: "delegated-review-rework",
        idempotency_key: `delegated-review-rework:${itemId}:policy:${policy!.id}:reviewer-run:${reviewerRunId}`,
        resume_from_run_id: executorRunId,
        instruction: `根据 reviewer Run #${reviewerRunId} 的失败证据修复当前工单：test regression in original acceptance scope`,
      },
    ]);
    expect(notificationKinds(itemId)).toEqual([
      expect.objectContaining({ kind: "review_failed", state: "pending" }),
    ]);
  });

  it("keeps a review failure awaiting user action when automatic rework was not authorized", () => {
    const { itemId, reviewerRunId } = reviewItem();
    createDispatcher(db).submitReviewVerdict({
      runId: reviewerRunId,
      verdict: "fail",
      evidence: "test failure needs a rework decision",
    });

    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ n: 0 });
    expect(notificationKinds(itemId)).toEqual([
      expect.objectContaining({ kind: "review_failed", state: "pending" }),
    ]);
  });

  it("stops automation after revocation, rework exhaustion, or a declared evidence conflict", () => {
    const revoked = reviewItem({ delegated: true });
    revokeDelegationPolicy(db, { itemId: revoked.itemId, via: "test", reason: "user changed mind" });
    createDispatcher(db).submitReviewVerdict({
      runId: revoked.reviewerRunId,
      verdict: "pass",
      evidence: "tests passed",
    });
    expect(getItem(db, revoked.itemId)?.stage).toBe("review");

    const exhausted = reviewItem({ delegated: true, maxReworkCycles: 0 });
    createDispatcher(db).submitReviewVerdict({
      runId: exhausted.reviewerRunId,
      verdict: "fail",
      evidence: "tests failed",
    });
    expect(getItem(db, exhausted.itemId)?.stage).toBe("review");
    expect(notificationKinds(exhausted.itemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "rework_exhausted" }),
    ]));

    // 升级给用户只看核查员声明的 escalate（工单 10，spec 5.9）。
    const conflict = reviewItem({ delegated: true });
    createDispatcher(db).submitReviewVerdict({
      runId: conflict.reviewerRunId,
      verdict: "fail",
      evidence: "reviewer report disagrees with artifact",
      criteria: [],
      escalate: { reason: "evidence_conflict", note: "测试结果和执行 agent 的自述对不上" },
    });
    expect(getItem(db, conflict.itemId)?.stage).toBe("review");
    expect(notificationKinds(conflict.itemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "automation_blocked" }),
    ]));
  });

  it("does not escalate because the evidence text mentions evidence_conflict", () => {
    // 回归测试（工单 10）：以前 evidenceEscalation 在证据文本里找这个词，托管的 FAIL 因此升级，不自动返工。
    const keyword = reviewItem({ delegated: true });
    createDispatcher(db).submitReviewVerdict({
      runId: keyword.reviewerRunId,
      verdict: "fail",
      evidence: "EVIDENCE_CONFLICT reviewer report disagrees with artifact",
    });
    expect(getItem(db, keyword.itemId)?.stage).toBe("active");
    expect(notificationKinds(keyword.itemId).map((row) => row.kind)).not.toContain("automation_blocked");
    expect(db.prepare("SELECT trigger FROM dispatch_requests WHERE item_id=?").pluck().all(keyword.itemId))
      .toEqual(["delegated-review-rework"]);
  });
});

describe("continuations and reliable notifications", () => {
  it("preflights unattended delegation before accepting it", () => {
    // 要求独立核查：不要求的工单托管预检直接失败（工单 11，见 review-failure-actions.test.ts）。
    const itemId = createItem(db, { title: "offline handoff", brief: "b", createdBy: "system", verificationPolicy: "independent_reviewer" });
    const blocked = delegationPreflight(db, {
      itemId,
      createdVia: "test",
      requireContinuation: true,
      maxReworkCycles: 0,
      budgetLimitTokens: 0,
      now: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(blocked.canAccept).toBe(false);
    expect(blocked.status).toBe("blocked");
    expect(blocked.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rework_authority", state: "failed" }),
      expect.objectContaining({ id: "budget_boundary", state: "failed" }),
      expect.objectContaining({ id: "continuation_chain", state: "failed" }),
    ]));
    recordDelegationPreflight(db, {
      itemId,
      preflight: blocked,
      actor: "lead",
      channel: "lead_tool",
      accepted: false,
    });
    expect(db.prepare(
      `SELECT actor, json_extract(payload, '$.decision') AS decision,
              json_extract(payload, '$.preflight.status') AS status
       FROM activities WHERE item_id=? AND kind='decision'`,
    ).get(itemId)).toEqual({
      actor: "lead",
      decision: "delegation_preflight_blocked",
      status: "blocked",
    });

    createContinuation(db, {
      itemId,
      triggerEvent: "review_passed",
      idempotencyKey: "offline-handoff",
      actions: [{ type: "request_dispatch", ticketId: itemId }],
    });
    const capabilityId = Number(db.prepare(
      `INSERT INTO capabilities (
         scope_key, type, slug, name, version, scope, status, summary,
         implementation_status, deployment_status, lead_tool_status
       ) VALUES ('global', 'skill', 'ready-guard', 'Ready Guard', 1, 'global', 'active', 's',
                 'implementation_verified', 'deployed', 'loaded')`,
    ).run().lastInsertRowid);
    const ready = delegationPreflight(db, {
      itemId,
      createdVia: "test",
      requireContinuation: true,
      requiredCapabilityId: capabilityId,
      maxReworkCycles: 1,
      budgetLimitTokens: 10_000,
      effectiveUntil: "2099-01-01T00:00:00.000Z",
      now: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(ready).toMatchObject({
      status: "ready",
      canAccept: true,
      blockers: [],
      warnings: [],
    });
  });

  it("does not execute a pending continuation until its trigger event arrives", () => {
    const itemId = createItem(db, { title: "event gated", brief: "b", createdBy: "system" });
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
    createContinuation(db, {
      itemId,
      delegationPolicyId: policy.id,
      triggerEvent: "review_passed",
      idempotencyKey: "event-gated-follow-up",
      actions: [{
        type: "create_task",
        key: "follow",
        title: "Follow-up",
        brief: "must not exist before review_passed",
      }],
    });

    expect(processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } }).processed)
      .toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Follow-up'").get() as { n: number }).n)
      .toBe(0);

    enqueueContinuationEvent(db, {
      itemId,
      eventType: "review_passed",
      payload: { reviewerRunId: 99, policyId: policy.id },
      idempotencyKey: "review-passed:event-gated",
    });
    expect(processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } }).processed)
      .toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Follow-up'").get() as { n: number }).n)
      .toBe(1);
    expect(db.prepare("SELECT state FROM continuation_events WHERE idempotency_key='review-passed:event-gated'").get())
      .toEqual({ state: "processed" });
  });

  it("blocks an existing continuation when the persisted delegation policy is revoked", () => {
    const itemId = createItem(db, { title: "revoked continuation", brief: "b", createdBy: "system" });
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
    const continuationId = createContinuation(db, {
      itemId,
      delegationPolicyId: policy.id,
      triggerEvent: "review_passed",
      idempotencyKey: "revoked-follow-up",
      actions: [{
        type: "create_task",
        key: "follow",
        title: "Should Not Run",
        brief: "revoked delegation blocks this",
      }],
    });
    revokeDelegationPolicy(db, { itemId, via: "test", reason: "user revoked unattended delegation" });
    enqueueContinuationEvent(db, {
      itemId,
      eventType: "review_passed",
      payload: { reviewerRunId: 100, policyId: policy.id },
      idempotencyKey: "review-passed:revoked-follow-up",
    });

    const result = processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
    expect(result.processed).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Should Not Run'").get() as { n: number }).n)
      .toBe(0);
    expect(db.prepare("SELECT state, last_error FROM continuations WHERE id=?").get(continuationId))
      .toEqual({
        state: "waiting_user",
        last_error: expect.stringContaining("revoked"),
      });
    expect(notificationKinds(itemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "automation_blocked", state: "pending" }),
    ]));
  });

  it("creates dependency-blocked tasks once, waits, then resumes after the dependency is done", () => {
    const source = createItem(db, { title: "design", brief: "b", createdBy: "system" });
    const target = createItem(db, { title: "follow-up", brief: "b", createdBy: "system" });
    const policy = grantDelegationPolicy(db, { itemId: target, createdVia: "test" });
    const continuationId = createContinuation(db, {
      itemId: target,
      delegationPolicyId: policy.id,
      triggerEvent: "review_passed",
      idempotencyKey: "follow-up-after-review",
      actions: [{
        type: "create_task",
        key: "impl",
        title: "Implement follow-up",
        brief: "wait for design first",
        requestDispatch: true,
        relations: [
          { targetTicketId: source, relationType: "depends_on", reason: "design must land first" },
          { targetTicketId: target, relationType: "implements", reason: "implements delivered review follow-up" },
        ],
      }],
    });
    const dispatches: DispatchRequestInput[] = [];

    let result = processContinuations(db, { requestDispatch: (input) => { dispatches.push(input); } });
    expect(result.processed).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Implement follow-up'").get() as { n: number }).n)
      .toBe(0);
    enqueueContinuationEvent(db, {
      itemId: target,
      eventType: "review_passed",
      payload: { policyId: policy.id },
      idempotencyKey: "review-passed:follow-up-after-review",
    });

    result = processContinuations(db, { requestDispatch: (input) => { dispatches.push(input); } });
    expect(result.waitingDependency).toBe(1);
    expect(dispatches).toEqual([]);
    const created = (db.prepare("SELECT id FROM items WHERE title='Implement follow-up'").get() as { id: number }).id;
    expect(db.prepare("SELECT state, current_step FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "waiting_dependency", current_step: 0 });

    result = processContinuations(db, { requestDispatch: (input) => { dispatches.push(input); } });
    expect(result.waitingDependency).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Implement follow-up'").get() as { n: number }).n)
      .toBe(1);

    transition(db, { itemId: source, to: "active", actor: "system", reason: "start design" });
    transition(db, { itemId: source, to: "review", actor: "child", reason: "design complete" });
    transition(db, { itemId: source, to: "done", actor: "system", reason: "review passed" });
    result = processContinuations(db, { requestDispatch: (input) => { dispatches.push(input); } });
    expect(result.processed).toBe(1);
    expect(dispatches).toEqual([expect.objectContaining({ itemId: created, trigger: "continuation" })]);
    expect(db.prepare("SELECT state, current_step FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "succeeded", current_step: 1 });
  });

  it("pauses on capability readiness until implementation, deployment, and Lead tool load are all true", () => {
    const itemId = createItem(db, { title: "capability consumer", brief: "b", createdBy: "system" });
    const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
    const capabilityId = Number(db.prepare(
      `INSERT INTO capabilities (
         scope_key, type, slug, name, version, scope, status, summary,
         implementation_status, deployment_status, lead_tool_status
       ) VALUES ('global', 'skill', 'guard', 'Guard', 1, 'global', 'active', 's',
                 'implementation_verified', 'not_deployed', 'not_loaded')`,
    ).run().lastInsertRowid);
    const continuationId = createContinuation(db, {
      itemId,
      delegationPolicyId: policy.id,
      triggerEvent: "review_passed",
      idempotencyKey: "wait-capability",
      actions: [
        { type: "wait_for_capability", capabilityId },
        { type: "create_task", key: "consumer", title: "Use ready capability", brief: "ready now" },
      ],
    });

    processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
    expect(db.prepare("SELECT state FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "pending" });
    enqueueContinuationEvent(db, {
      itemId,
      eventType: "review_passed",
      payload: { policyId: policy.id },
      idempotencyKey: "review-passed:wait-capability",
    });
    processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
    expect(db.prepare("SELECT state FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "waiting_capability" });
    expect(notificationKinds(itemId)).toEqual([
      expect.objectContaining({ kind: "automation_blocked", state: "pending" }),
    ]);
    processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE item_id=?").get(itemId) as { n: number }).n)
      .toBe(1);

    markCapabilityDeployed(db, capabilityId, { deployed: true });
    processContinuations(db, { requestDispatch: () => { throw new Error("still not loaded"); } });
    expect(db.prepare("SELECT state FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "waiting_capability" });

    markCapabilityDeployed(db, capabilityId, { leadToolLoaded: true });
    processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
    expect(db.prepare("SELECT state, current_step FROM continuations WHERE id=?").get(continuationId))
      .toEqual({ state: "succeeded", current_step: 2 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE title='Use ready capability'").get() as { n: number }).n)
      .toBe(1);
  });

  it("keeps notifications pending, delivered, and acked as durable outbox states", () => {
    const { itemId, reviewerRunId } = reviewItem({ delegated: true });
    const service = createControlPlaneService(db, {
      runtime: () => ({ model: "m", sessionId: "s", busy: false, runningItemIds: [], aish: null }),
    });
    createDispatcher(db).submitReviewVerdict({
      runId: reviewerRunId,
      verdict: "pass",
      evidence: "tests passed",
    });
    const notification = db.prepare("SELECT id, state FROM notifications WHERE item_id=?").get(itemId) as
      { id: number; state: string };
    expect(notification.state).toBe("pending");
    expect(service.overview().counts.unreadNotices).toBe(1);
    markNotificationDelivered(db, notification.id, "lead", new Date("2026-08-14T01:00:00.000Z"));
    expect(db.prepare("SELECT state, delivered_via FROM notifications WHERE id=?").get(notification.id))
      .toEqual({ state: "delivered", delivered_via: "lead" });
    expect(service.overview().counts.unreadNotices).toBe(1);
    ackNotification(db, notification.id, new Date("2026-08-14T01:01:00.000Z"));
    expect(db.prepare("SELECT state, acked_at FROM notifications WHERE id=?").get(notification.id))
      .toEqual({ state: "acked", acked_at: "2026-08-14T01:01:00.000Z" });
    expect(service.overview().counts.unreadNotices).toBe(0);
  });

  it("projects waiting_dependency in the control plane while implements does not block", () => {
    const implementation = createItem(db, { title: "implementation", brief: "b", createdBy: "system" });
    const design = createItem(db, { title: "design", brief: "b", createdBy: "system" });
    const spec = createItem(db, { title: "spec", brief: "b", createdBy: "system" });
    linkTickets(db, {
      sourceTicketId: implementation,
      targetTicketId: spec,
      relationType: "implements",
      reason: "implements spec",
      actor: "system",
    });
    linkTickets(db, {
      sourceTicketId: implementation,
      targetTicketId: design,
      relationType: "depends_on",
      reason: "wait for design",
      actor: "system",
    });
    const service = createControlPlaneService(db, {
      runtime: () => ({ model: "m", sessionId: "s", busy: false, runningItemIds: [], aish: null }),
    });

    expect(service.listItems().find((item) => item.id === implementation)?.workflowState)
      .toBe("waiting_dependency");
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(design);
    expect(service.listItems().find((item) => item.id === implementation)?.workflowState)
      .toBe("idle");
  });
});

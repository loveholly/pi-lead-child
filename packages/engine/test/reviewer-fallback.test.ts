// 回归测试（2026-10-20）：核查员不能用时，派发换一个能用的核查员，不再挂起等着。
// 用户的原话：「我跟 agent 说了 codex 已经停用了，现在系统在派 reviewer 的时候还要去拉 codex……
// codex 标记不可用了你就换就行了」。以前核查请求入队时写死了 codex，codex 停用或者账号故障时，
// claimNext 把请求挂起（dispatch.ts 的 disabledHold、healthReady），Lead 和用户都换不了。
// 这些测试只用改之前就有的接口，所以能在旧代码上跑：旧代码上它们失败（claimNext 返回 null）。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { defaultRuntimeProfile, typedFailure } from "@pi-lead-child/runtime";
import {
  createItem, createRun, openDb, recordRuntimeHealthFailure, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// 一张要求独立核查的工单：交付 Run（pi）结束，进了 review。
function deliveredTicket(db: Db) {
  const itemId = createItem(db, {
    title: "delivered", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer", runtime: "pi",
  });
  const dispatcher = createDispatcher(db);
  dispatcher.request({ itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: `deliver:${itemId}` });
  const delivery = dispatcher.claimNext()!;
  expect(delivery).toMatchObject({ role: "executor", runtime: "pi" });
  updateRun(db, delivery.runId, { state: "finished", endedAt: true, exitCode: 0 });
  dispatcher.completeRun(delivery.runId);
  transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery.runId });
  return { itemId, dispatcher, deliveryRunId: delivery.runId };
}

// 核查请求入队时 runtime 写死成 codex（自动核查当时选的是 codex）。
function queueCodexReview(db: Db, itemId: number): number {
  return createDispatcher(db).request({
    itemId, role: "reviewer", purpose: "review", runtime: "codex",
    trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:test`,
  });
}

function codexAccountDeactivated(db: Db, itemId: number, runId: number): number {
  const recorded = recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile("codex"), model: null, itemId, runId,
    failure: typedFailure("account_deactivated", {
      errorCode: "codex_error", message: "auth error: 402, auth error code: deactivated_workspace",
    }),
  });
  return recorded!.incident.id;
}

const requestRow = (db: Db, id: number) => db.prepare(
  "SELECT runtime, state, suspended_reason, suspended_incident_id FROM dispatch_requests WHERE id=?",
).get(id) as { runtime: string; state: string; suspended_reason: string | null; suspended_incident_id: number | null };

const switches = (db: Db, itemId: number) => (db.prepare(
  `SELECT actor, payload FROM activities
   WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='reviewer_runtime_switched'`,
).all(itemId) as Array<{ actor: string; payload: string }>).map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) }));

describe("a queued review whose reviewer cannot run", () => {
  it("moves off a codex with an open incident to claude at the next claim, and is claimed", () => {
    const db = openDb(join(tempDir("plc-reviewer-fallback-"), "plc.db"));
    const { itemId, dispatcher, deliveryRunId } = deliveredTicket(db);
    const requestId = queueCodexReview(db, itemId);
    const incidentId = codexAccountDeactivated(db, itemId, deliveryRunId);

    const claim = dispatcher.claimNext();
    expect(claim).toMatchObject({ requestId, role: "reviewer", runtime: "claude" });
    expect(requestRow(db, requestId)).toMatchObject({
      runtime: "claude", state: "claimed", suspended_reason: null, suspended_incident_id: null,
    });
    expect(db.prepare("SELECT runtime FROM runs WHERE id=?").get(claim!.runId)).toEqual({ runtime: "claude" });
    expect(switches(db, itemId)).toEqual([expect.objectContaining({
      actor: "system", from: "codex", to: "claude", dispatchRequestId: requestId,
      message: `核查员从 Codex 换成 Claude Code：Codex 账号已停用（故障 #${incidentId}）`,
    })]);
    db.close();
  });

  it("moves off a codex the user disabled to claude at the next claim, and is claimed", () => {
    const db = openDb(join(tempDir("plc-reviewer-fallback-"), "plc.db"));
    const { itemId, dispatcher } = deliveredTicket(db);
    const requestId = queueCodexReview(db, itemId);
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "codex");

    expect(dispatcher.claimNext()).toMatchObject({ requestId, role: "reviewer", runtime: "claude" });
    expect(requestRow(db, requestId)).toMatchObject({ runtime: "claude", state: "claimed" });
    expect(switches(db, itemId)).toEqual([expect.objectContaining({
      from: "codex", to: "claude", message: expect.stringContaining("核查员从 Codex 换成 Claude Code：用户在设置里停用了 Codex"),
    })]);
    db.close();
  });

  // 执行请求的挂起行为不变：换哪个执行者是 Lead 的事。
  it("still holds an executor request on a codex with an open incident", () => {
    const db = openDb(join(tempDir("plc-reviewer-fallback-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user", runtime: "codex" });
    const dispatcher = createDispatcher(db);
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: `x:${itemId}`,
    });
    const failedRun = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, failedRun, { state: "failed", endedAt: true, exitCode: 1 });
    const incidentId = codexAccountDeactivated(db, itemId, failedRun);

    expect(dispatcher.claimNext()).toBeNull();
    expect(requestRow(db, requestId)).toMatchObject({ runtime: "codex", state: "pending", suspended_incident_id: incidentId });
    db.close();
  });
});

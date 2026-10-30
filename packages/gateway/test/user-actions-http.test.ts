// 用户控制面的 HTTP 面（spec §8）。这些路由是"用户自己在点"的那条通路，
// actor 一律 user，且不接受调用方自称别的身份——否则 §6.4 的矩阵就能被一个
// JSON 字段绕过去。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, getRun, updateRun } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import { createDispatcher, liveChildren } from "@pi-lead-child/engine";
import { recordRuntimeHealthFailure } from "@pi-lead-child/store";
import { defaultRuntimeProfile, typedFailure } from "@pi-lead-child/runtime";
import { listActivities } from "@pi-lead-child/store";
import { getTicketRelations } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-user-actions-http-"), "plc.db"));
  liveChildren().clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function runtime() {
  return {
    model: "stub/model", sessionId: "stub-session", busy: false,
    runningItemIds: [], aish: null,
  };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime, now: () => new Date() }),
    userActions: createUserActionService({ db, resumeRun: () => {} }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "actions-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

describe("user control-plane actions over HTTP", () => {
  it("confirms a draft as the user and makes it runnable", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      // hold 出来的 draft 才有"确认"这件事可做（缺省生于 ready）。
      const id = createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
      const res = await fetch(`${server.base}/v1/tickets/${id}/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(getItem(db, id)!.stage).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("grants unattended authority and immediately dispatches rework on the reviewed ticket", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const itemId = createItem(db, {
        title: "review failure",
        brief: "resume the executor on reviewer failure",
        createdBy: "lead",
        verificationPolicy: "independent_reviewer",
      });
      transition(db, { itemId, to: "active", actor: "system", reason: "start" });
      const executorRunId = createRun(db, { itemId, role: "executor", purpose: "execution" });
      transition(db, { itemId, to: "review", actor: "child", reason: "reviewer failed" });

      const response = await fetch(`${server.base}/v1/lead/delegation`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          ticket_id: itemId,
          granted: true,
          start_rework: true,
          max_rework_cycles: 1,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ticketId: itemId,
        granted: true,
        reworkStarted: true,
      });
      expect(getItem(db, itemId)?.stage).toBe("active");
      expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(1);
      expect(db.prepare(
        `SELECT item_id, trigger, resume_from_run_id
         FROM dispatch_requests WHERE item_id=?`,
      ).get(itemId)).toEqual({
        item_id: itemId,
        trigger: "user-rework",
        resume_from_run_id: executorRunId,
      });
      // 授权时顺带启动的这一次返工属于这份授权：记下授权编号，额度按它算。
      const policyId = (db.prepare("SELECT id FROM delegation_policies WHERE item_id=?").get(itemId) as { id: number }).id;
      expect(db.prepare(
        `SELECT json_extract(payload, '$.delegationPolicyId') AS policy FROM activities
         WHERE item_id=? AND json_extract(payload, '$.decision')='rework_dispatch_requested'`,
      ).get(itemId)).toEqual({ policy: policyId });
    } finally {
      await server.close();
    }
  });

  it("restores a reviewed task tree without starting execution", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const rootId = createItem(db, { title: "Root", brief: "b", createdBy: "lead" });
      const originalId = createItem(db, {
        title: "Phase -1", brief: "b", createdBy: "lead", parentItemId: rootId, rootItemId: rootId,
      });
      const duplicateId = createItem(db, {
        title: "Phase -1", brief: "b", createdBy: "lead", parentItemId: rootId, rootItemId: rootId,
      });
      for (const itemId of [originalId, duplicateId, rootId]) {
        transition(db, { itemId, to: "cancelled", actor: "lead", reason: "stop" });
      }

      const res = await fetch(`${server.base}/v1/tickets/${rootId}/restore`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "review_tree" }),
      });

      expect(res.status).toBe(200);
      expect(getItem(db, rootId)!.stage).toBe("ready");
      expect(getItem(db, originalId)!.stage).toBe("ready");
      expect(getItem(db, duplicateId)!.stage).toBe("cancelled");
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    } finally {
      await server.close();
    }
  });

  it("creates and revokes structured ticket relations as the user with visible impact", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const duplicateId = createItem(db, { title: "Duplicate", brief: "b", createdBy: "lead" });
      const canonicalId = createItem(db, { title: "Canonical", brief: "b", createdBy: "lead" });
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

      const linked = await fetch(`${server.base}/v1/tickets/${duplicateId}/relations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetTicketId: canonicalId,
          relationType: "duplicates",
          reason: "same work; canonical chosen by user",
        }),
      });

      expect(linked.status).toBe(201);
      const linkedBody = await linked.json() as {
        relationId: number; risks: string[]; canonicalImpact: string | null; requestedRelationType: string;
      };
      expect(linkedBody.requestedRelationType).toBe("duplicates");
      expect(linkedBody.canonicalImpact).toContain(`#${canonicalId} is canonical`);
      expect(linkedBody.risks.join("\n")).toContain("canonical");
      expect(JSON.parse(listActivities(db, duplicateId).find((activity) => activity.kind === "decision")!.payload))
        .toMatchObject({ decision: "link_ticket_relation", itemPerspective: "source" });

      const revoked = await fetch(`${server.base}/v1/tickets/${duplicateId}/relations/${linkedBody.relationId}/revoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "not actually duplicate" }),
      });

      expect(revoked.status).toBe(200);
      expect((await revoked.json() as { status: string; active: boolean })).toMatchObject({
        status: "revoked",
        active: false,
      });
      expect(getTicketRelations(db, duplicateId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relationId: linkedBody.relationId,
          relationType: "duplicates",
          active: false,
          revokedBy: "user",
          revokeReason: "not actually duplicate",
        }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("continues review_tree after the root was first restored on its own", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const rootId = createItem(db, { title: "Root", brief: "b", createdBy: "lead" });
      const childId = createItem(db, {
        title: "Child", brief: "b", createdBy: "lead", parentItemId: rootId, rootItemId: rootId,
      });
      for (const itemId of [childId, rootId]) {
        transition(db, { itemId, to: "cancelled", actor: "lead", reason: "stop" });
      }
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

      const rootOnly = await fetch(`${server.base}/v1/tickets/${rootId}/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "root_only" }),
      });
      expect(rootOnly.status).toBe(200);
      expect(getItem(db, rootId)!.stage).toBe("draft");

      const reviewed = await fetch(`${server.base}/v1/tickets/${rootId}/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "review_tree" }),
      });
      expect(reviewed.status).toBe(200);
      expect(getItem(db, rootId)!.stage).toBe("ready");
      expect(getItem(db, childId)!.stage).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("maps an invalid restore stage to 409 instead of an internal error", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const itemId = createItem(db, { title: "Ready", brief: "b", createdBy: "lead" });
      const res = await fetch(`${server.base}/v1/tickets/${itemId}/restore`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "review_tree" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "conflict", message: "工单现在是「待开始」，没有取消，不用恢复。" },
      });
    } finally {
      await server.close();
    }
  });

  it("refuses to act on behalf of the lead", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const id = createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
      const res = await fetch(`${server.base}/v1/tickets/${id}/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ actor: "lead" }),
      });
      expect(res.status).toBe(403);
      expect(getItem(db, id)!.stage).toBe("draft");
    } finally {
      await server.close();
    }
  });

  it("rejects an unknown action instead of guessing", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
      const res = await fetch(`${server.base}/v1/tickets/${id}/promote`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("pauses and resumes a running run while the item stays active", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
      transition(db, { itemId, to: "active", actor: "system", reason: "" });
      const runId = createRun(db, { itemId });
      updateRun(db, runId, { state: "running", sessionId: "sess-1" });
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

      const paused = await fetch(`${server.base}/v1/runs/${runId}/pause`, { method: "POST", headers });
      expect(paused.status).toBe(200);
      expect(getRun(db, runId)!.state).toBe("paused");
      expect(getItem(db, itemId)!.stage).toBe("active");

      const resumed = await fetch(`${server.base}/v1/runs/${runId}/resume`, { method: "POST", headers });
      expect(resumed.status).toBe(200);
      expect(getRun(db, runId)!.state).toBe("running");
      expect(getRun(db, runId)!.session_id).toBe("sess-1");
    } finally {
      await server.close();
    }
  });

  // user-actions 服务自己发事件。路由再发一次，companion 就会为同一次点击重拉两遍。
  it("publishes exactly one event per item or run action", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const eventTypes = (itemId: number) => db.prepare(
        "SELECT event_type FROM gateway_events WHERE item_id=? ORDER BY seq",
      ).all(itemId);

      const reviewed = createItem(db, { title: "t", brief: "b", createdBy: "system" });
      transition(db, { itemId: reviewed, to: "active", actor: "system", reason: "" });
      transition(db, { itemId: reviewed, to: "review", actor: "child", reason: "" });
      const completed = await fetch(`${server.base}/v1/tickets/${reviewed}/complete`, {
        method: "POST", headers, body: "{}",
      });
      expect(completed.status).toBe(200);
      expect(eventTypes(reviewed)).toEqual([{ event_type: "ticket.updated" }]);

      const running = createItem(db, { title: "t", brief: "b", createdBy: "system" });
      transition(db, { itemId: running, to: "active", actor: "system", reason: "" });
      const runId = createRun(db, { itemId: running });
      updateRun(db, runId, { state: "running" });
      const paused = await fetch(`${server.base}/v1/runs/${runId}/pause`, { method: "POST", headers });
      expect(paused.status).toBe(200);
      expect(eventTypes(running)).toEqual([{ event_type: "attempt.updated" }]);
    } finally {
      await server.close();
    }
  });

  it("maps an illegal transition to 409 rather than 500", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const id = createItem(db, { title: "t", brief: "b", createdBy: "system" }); // 生于 ready
      const res = await fetch(`${server.base}/v1/tickets/${id}/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("requires a write scope, not just tickets:view", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view"]);
      const id = createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
      const res = await fetch(`${server.base}/v1/tickets/${id}/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(getItem(db, id)!.stage).toBe("draft");
    } finally {
      await server.close();
    }
  });

  it("sends an unreviewed delivery to an independent reviewer, and refuses a second request", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      // 工单 #66 的样子：交付 Run 结束、进了 review，没有任何 reviewer 请求。
      const itemId = createItem(db, {
        title: "stranded", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer",
      });
      transition(db, { itemId, to: "active", actor: "system", reason: "retry run" });
      const deliveryRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
      updateRun(db, deliveryRunId, { state: "finished", endedAt: true, exitCode: 0 });
      transition(db, { itemId, to: "review", actor: "system", reason: "recovered", runId: deliveryRunId });

      const request = () => fetch(`${server.base}/v1/tickets/${itemId}/request-review`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      });
      const first = await request();
      expect(first.status).toBe(200);
      const body = await first.json() as {
        ticketId: number; dispatchRequestId: number; deliveryRunId: number;
        ticket: { reviewState?: { label: string; canRequestReview?: boolean } } | null;
      };
      expect(body).toMatchObject({ ticketId: itemId, deliveryRunId });
      expect(body.ticket?.reviewState).toMatchObject({ label: "独立核查排队中", reviewProgress: "queued", canRequestReview: false });
      expect(db.prepare("SELECT role, trigger, state FROM dispatch_requests WHERE id=?").get(body.dispatchRequestId))
        .toEqual({ role: "reviewer", trigger: "user-review", state: "pending" });

      // 核查已经在路上：不是 stage 冲突，而是没有可派的缺口。
      const second = await request();
      expect(second.status).toBe(409);
      expect(getItem(db, itemId)!.stage).toBe("review");
    } finally {
      await server.close();
    }
  });
  // 2026-10-20：挂起的核查不再挡住用户。没有能用的核查员时请求挂起；用户重新启用 Claude Code 以后，
  // 在工单里选它当核查员（request-review 带 runtime），挂起的请求换过去、马上能被认领。
  it("lets the user move a suspended review to another reviewer, and shows the reviewer and the options", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const itemId = createItem(db, {
        title: "stuck review", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer",
      });
      transition(db, { itemId, to: "active", actor: "system", reason: "retry run" });
      const deliveryRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
      updateRun(db, deliveryRunId, { state: "finished", endedAt: true, exitCode: 0 });
      transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: deliveryRunId });
      // Codex 账号停用，Claude Code 和 pi 被用户停用：一个能用的核查员都没有。
      const incidentId = recordRuntimeHealthFailure(db, {
        profile: defaultRuntimeProfile("codex"), model: null, itemId, runId: deliveryRunId,
        failure: typedFailure("account_deactivated", { errorCode: "codex_error", message: "auth error code: deactivated_workspace" }),
      })!.incident.id;
      vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude,pi");

      const requestReview = (body: unknown) => fetch(`${server.base}/v1/tickets/${itemId}/request-review`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const reviewer = async () => {
        const response = await fetch(`${server.base}/v1/tickets/${itemId}/reviewer`, { headers });
        expect(response.status).toBe(200);
        return response.json() as Promise<Record<string, unknown>>;
      };
      const first = await requestReview({});
      expect(first.status).toBe(200);
      const { dispatchRequestId } = await first.json() as { dispatchRequestId: number };
      expect(createDispatcher(db).claimNext()).toBeNull();
      expect(db.prepare("SELECT runtime, suspended_incident_id FROM dispatch_requests WHERE id=?").get(dispatchRequestId))
        .toEqual({ runtime: "codex", suspended_incident_id: incidentId });

      expect(await reviewer()).toEqual({
        reviewer: {
          runtime: "codex", displayName: "Codex", model: null, effort: null, chosenBy: "system", sameAsExecutor: false,
        },
        options: [
          { runtime: "codex", displayName: "Codex", available: false, reason: `Codex 账号已停用（故障 #${incidentId}）` },
          { runtime: "claude", displayName: "Claude Code", available: false, reason: expect.stringContaining("停用") },
          { runtime: "pi", displayName: "Pi agent", available: false, reason: expect.stringContaining("停用") },
        ],
        canChange: true,
        progress: "suspended",
      });
      const reviewState = async () => (await (await fetch(`${server.base}/v1/tickets/${itemId}`, { headers })).json() as {
        ticket: { reviewState: { canRequestReview?: boolean; reviewProgress?: string } };
      }).ticket.reviewState;
      // 回归（2026-10-21 审查 M4）：一个能用的核查员都没有时，「重新排核查」点了必定 409，界面上又没有选核查员的入口。
      // 现在这时不给这个按钮；直接请求时说清楚没有能用的核查员，请求保持原样。
      expect(await reviewState()).toMatchObject({ canRequestReview: false, reviewProgress: "suspended" });
      const none = await requestReview({});
      expect(none.status).toBe(409);
      expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(/^没有能用的核查员/);
      expect(db.prepare("SELECT runtime, suspended_incident_id FROM dispatch_requests WHERE id=?").get(dispatchRequestId))
        .toEqual({ runtime: "codex", suspended_incident_id: incidentId });

      // 停用的、不认识的 runtime 不能选。
      expect((await requestReview({ runtime: "pi" })).status).toBe(409);
      expect((await requestReview({ runtime: "gemini" })).status).toBe(400);

      vi.stubEnv("PLC_DISABLED_RUNTIMES", "pi");
      // 有一个能用了：挂起的核查又能重新排。
      expect(await reviewState()).toMatchObject({ canRequestReview: true, reviewProgress: "suspended" });
      const moved = await requestReview({ runtime: "claude" });
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({ ticketId: itemId, dispatchRequestId, deliveryRunId });
      expect(db.prepare("SELECT runtime, suspended_reason, suspended_incident_id FROM dispatch_requests WHERE id=?").get(dispatchRequestId))
        .toEqual({ runtime: "claude", suspended_reason: null, suspended_incident_id: null });
      const switched = listActivities(db, itemId)
        .filter((activity) => JSON.parse(activity.payload).decision === "reviewer_runtime_switched");
      expect(switched.map((activity) => [activity.actor, JSON.parse(activity.payload).message]))
        .toEqual([["user", "核查员从 Codex 换成 Claude Code：用户换了核查员"]]);
      expect(await reviewer()).toMatchObject({ reviewer: { runtime: "claude" }, progress: "queued", canChange: true });
      expect(createDispatcher(db).claimNext()).toMatchObject({ requestId: dispatchRequestId, role: "reviewer", runtime: "claude" });
    } finally {
      await server.close();
    }
  });

  // 回归（2026-10-21 审查 M4）：「重新排核查」不点名核查员时，以前总是换成排序第一的那个，活动里还记成「用户换了核查员」。
  // 挂起的原因不是核查员的故障、请求上的核查员还能用时，留着它，只清掉挂起。原来的不能用时才换第一个能用的。
  it("keeps the reviewer of a suspended review when it is still usable, and otherwise moves it to the first usable one", async () => {
    const server = await start();
    try {
      const accessToken = await token(server.base, ["tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const itemId = createItem(db, {
        title: "paused review", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer",
      });
      transition(db, { itemId, to: "active", actor: "system", reason: "retry run" });
      const deliveryRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
      updateRun(db, deliveryRunId, { state: "finished", endedAt: true, exitCode: 0 });
      transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: deliveryRunId });
      const requestId = createDispatcher(db).request({
        itemId, role: "reviewer", purpose: "review", runtime: "claude",
        trigger: "user-review", idempotencyKey: `user-review:${itemId}:delivery-run:${deliveryRunId}:1`,
      });
      const suspend = () => db.prepare("UPDATE dispatch_requests SET suspended_reason=? WHERE id=?").run("运行闸门拒绝", requestId);
      const retry = () => fetch(`${server.base}/v1/tickets/${itemId}/request-review`, { method: "POST", headers, body: "{}" });
      const switches = () => listActivities(db, itemId)
        .filter((activity) => JSON.parse(activity.payload).decision === "reviewer_runtime_switched").length;

      suspend();
      expect((await retry()).status).toBe(200);
      expect(db.prepare("SELECT runtime, suspended_reason FROM dispatch_requests WHERE id=?").get(requestId))
        .toEqual({ runtime: "claude", suspended_reason: null });
      expect(switches()).toBe(0);

      suspend();
      vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
      expect((await retry()).status).toBe(200);
      expect(db.prepare("SELECT runtime, suspended_reason FROM dispatch_requests WHERE id=?").get(requestId))
        .toEqual({ runtime: "codex", suspended_reason: null });
      expect(switches()).toBe(1);
    } finally {
      await server.close();
    }
  });
});

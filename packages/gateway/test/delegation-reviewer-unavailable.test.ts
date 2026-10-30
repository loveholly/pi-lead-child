// 「委托给 Lead 验收」在没有可用核查员时卡死（2026-10-19 用户审查，工单 #88、#89、#92、#93、#98）。
//
// 委托把工单的 verification_policy 改成 independent_reviewer。reviewer 默认用第一个能强制只读核查的 runtime，
// 现在只有 Codex，而 Codex 账号停用了（402）。Lead 的 accept_review 要 reviewer 的 PASS 结论，结论永远不会来：
// Lead 关不掉这张工单，用户也不知道，最后只能自己点通过。
//
// 现在两处说清楚：
// - 委托的那一刻：核查派不出去时，委托不生效，返回的说明写明原因和用户可以怎样做。界面直接显示这段说明。
// - 已经委托的工单：核查请求因为 runtime 故障挂起时，叫醒 Lead，并标成需要用户决定（dispatch.ts）。
// 2026-10-20 起任何 runtime 都能当核查员，Codex 坏了就换下一个（reviewer-choice.ts）。所以"没有可用核查员"
// 只在 Codex、Claude Code、pi 全都不能用时出现；只有 Codex 坏了时，委托照常生效。
import { join } from "node:path";
import type { RuntimeId } from "@pi-lead-child/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, automaticReviewRequest } from "@pi-lead-child/engine";
import { defaultRuntimeProfile, typedFailure } from "@pi-lead-child/runtime";
import {
  createItem, createPairing, createRun, getItem, grantDelegationPolicy, listActivities, openDb, recordRuntimeHealthFailure,
  transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
// 测试按缺省的 reviewer（Codex）判断：去掉开发者环境里可能配置的 PLC_REVIEW_RUNTIME。
const configuredReviewer = process.env.PLC_REVIEW_RUNTIME;

beforeEach(() => {
  db = openDb(join(tempDir("plc-delegation-reviewer-"), "plc.db"));
  delete process.env.PLC_REVIEW_RUNTIME;
});

afterEach(() => {
  db.close();
  if (configuredReviewer === undefined) delete process.env.PLC_REVIEW_RUNTIME;
  else process.env.PLC_REVIEW_RUNTIME = configuredReviewer;
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
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

async function token(base: string): Promise<string> {
  const { code } = createPairing(db, { name: "delegation-client", kind: "companion", scopes: ["tickets:view", "tickets:create"] });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

// 一张交付完、等验收的工单。
function deliveredTicket(): { itemId: number; executorRunId: number } {
  // 要求独立核查（工单 11：不要求独立核查的工单不能托管）。
  const itemId = createItem(db, { title: "修复 Reviewer 调度死锁", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const executorRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "pi" });
  updateRun(db, executorRunId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "handoff", runId: executorRunId });
  return { itemId, executorRunId };
}

// 账号停用：健康账本上一条 profile 级的故障。
function accountDown(runtime: RuntimeId, itemId: number, runId: number): void {
  recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile(runtime), model: null, itemId, runId,
    failure: typedFailure("auth_required", { errorCode: `${runtime}_error`, message: "402 deactivated_workspace" }),
  });
}

// 三个 runtime 的账号都坏了：一个能用的核查员都没有。
function noReviewerCanRun(itemId: number, runId: number): void {
  for (const runtime of ["codex", "claude", "pi"] as const) accountDown(runtime, itemId, runId);
}

describe("delegating acceptance to Lead while no reviewer can run", () => {
  it("refuses the delegation and tells the user why and what they can do", async () => {
    const { itemId, executorRunId } = deliveredTicket();
    noReviewerCanRun(itemId, executorRunId);
    const server = await start();
    try {
      const response = await fetch(`${server.base}/v1/lead/delegation`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token(server.base)}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket_id: itemId, granted: true, max_rework_cycles: 1 }),
      });

      expect(response.status).toBe(409);
      const body = await response.json() as {
        error: { code: string; message: string };
        preflight: { checks: Array<{ id: string; state: string; evidence: string }> };
      };
      expect(body.error.code).toBe("delegation_preflight_failed");
      // 界面显示的就是这段说明（「操作未完成：…」）：原因和用户能做的事都在里面。
      expect(body.error.message).toContain("没有能用的核查员");
      expect(body.error.message).toContain("Codex");
      expect(body.error.message).toContain("Claude Code");
      expect(body.error.message).toContain("故障 #");
      expect(body.error.message).toContain("亲自验收");
      // 工单 11（D11）：还可以勾选「核查做不成时由 Lead 凭证据验收」。
      expect(body.error.message).toContain("核查做不成时由 Lead 凭证据验收");
      expect(body.preflight.checks.find((check) => check.id === "reviewer_runtime")).toMatchObject({ state: "failed" });
      // 委托没有生效：没有授权，工单仍由用户验收，留下一条前置检查没过的记录。
      expect(db.prepare("SELECT COUNT(*) AS n FROM delegation_policies").get()).toEqual({ n: 0 });
      expect(getItem(db, itemId)!.acceptance_policy).not.toBe("delegated_to_lead");
      expect(listActivities(db, itemId).map((activity) => JSON.parse(activity.payload).decision))
        .toContain("delegation_preflight_blocked");
    } finally {
      await server.close();
    }
  });

  // 2026-10-20：只有 Codex 坏了时，核查交给 Claude Code，委托照常生效。
  it("still delegates when only codex is down, because the review goes to the next reviewer", async () => {
    const { itemId, executorRunId } = deliveredTicket();
    accountDown("codex", itemId, executorRunId);
    const server = await start();
    try {
      const response = await fetch(`${server.base}/v1/lead/delegation`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token(server.base)}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket_id: itemId, granted: true, max_rework_cycles: 1 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { preflight: { checks: Array<{ id: string; state: string }> } };
      expect(body.preflight.checks.find((check) => check.id === "reviewer_runtime")).toMatchObject({ state: "passed" });
    } finally {
      await server.close();
    }
  });

  it("still delegates when the reviewer runtime is healthy", async () => {
    const { itemId } = deliveredTicket();
    const server = await start();
    try {
      const response = await fetch(`${server.base}/v1/lead/delegation`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token(server.base)}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket_id: itemId, granted: true, max_rework_cycles: 1 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { preflight: { checks: Array<{ id: string; state: string }> } };
      expect(body.preflight.checks.find((check) => check.id === "reviewer_runtime")).toMatchObject({ state: "passed" });
    } finally {
      await server.close();
    }
  });
});

describe("a delegated ticket whose review cannot be dispatched", () => {
  function reviewBlockedNotes(itemId: number): Array<{ summary: string; payload: string }> {
    return db.prepare(
      "SELECT summary, payload FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='delegated_review_blocked'",
    ).all(itemId) as Array<{ summary: string; payload: string }>;
  }

  it("wakes Lead once, as something the user must decide, instead of waiting silently", () => {
    const { itemId, executorRunId } = deliveredTicket();
    grantDelegationPolicy(db, { itemId, createdVia: "test" });
    noReviewerCanRun(itemId, executorRunId);
    const dispatcher = createDispatcher(db);
    dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));

    // 派发器每个 tick 都看一遍：请求挂起，不建 Run。
    expect(dispatcher.claimNext()).toBeNull();
    expect(dispatcher.claimNext()).toBeNull();

    const notes = reviewBlockedNotes(itemId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toContain(`工单 #${itemId}`);
    expect(notes[0]!.summary).toContain("Codex");
    expect(notes[0]!.summary).toContain("亲自验收");
    expect(JSON.parse(notes[0]!.payload)).toMatchObject({ wakeLead: true, needsUser: true });
  });

  it("says nothing extra for a ticket the user accepts anyway", () => {
    const { itemId, executorRunId } = deliveredTicket();
    noReviewerCanRun(itemId, executorRunId);
    const dispatcher = createDispatcher(db);
    dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));
    expect(dispatcher.claimNext()).toBeNull();
    expect(reviewBlockedNotes(itemId)).toEqual([]);
  });
});

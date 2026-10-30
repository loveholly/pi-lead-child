// 核查做不成时的托管（工单 11，spec 5.8、D11）：经过真的网关和 Lead 的工具，最后关掉库、重新打开，读回整条账。
//   1. 你在页面上授权托管，勾选「核查做不成时由 Lead 凭证据验收」。这时所有核查员都不能用，托管照样生效（预检只提醒一句）。
//   2. 自动核查排上了，派发 gate 把它挂起：叫醒 Lead 一次，告诉它可以凭证据验收；同一次故障不重复说。
//   3. Lead 被事件叫醒（没有你这一轮），用 ticket_action 的 accept_without_review 凭它读过的证据验收。
//   4. 账本标明没有独立核查；页面的核查一节和 Lead 的 get_ticket 都写着；只通知你一次。
// 另外两条：没勾时 Lead 做不了、只通知你一次；不要求独立核查的工单不能授权托管，原因写明。
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { automaticReviewRequest, createDispatcher, listLeadTicketActions, liveChildren, runTicketAction } from "@pi-lead-child/engine";
import { createControlPlaneService, createUserActionService, startPairedServer } from "@pi-lead-child/gateway";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { defaultRuntimeProfile, runtimeIds, typedFailure } from "@pi-lead-child/runtime";
import {
  createItem, createPairing, createRun, getItem, grantDelegationPolicy, insertOutcomeSnapshot, normalizeOutcomePayload, openDb,
  recordRuntimeHealthFailure, redeemPairing, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { RuntimeSettings } from "../src/runtime-settings.js";

let dir: string;
let dbPath: string;
let db: Db;
const configuredReviewer = process.env.PLC_REVIEW_RUNTIME;

beforeEach(() => {
  dir = tempDir("plc-review-failure-delegation-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  delete process.env.PLC_REVIEW_RUNTIME;
});

afterEach(() => {
  if (db.open) db.close();
  liveChildren().clear();
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
  const token = redeemPairing(db, createPairing(db, { name: "web", kind: "companion", scopes: ["tickets:view", "tickets:create"] }).code).accessToken;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${server.port}`;
  return {
    close: () => server.close(),
    post: async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    get: async (path: string) => {
      const response = await fetch(`${base}${path}`, { headers });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
  };
}

// 一张交付完、等验收的工单。verification：要不要独立核查。
function delivered(verification: "independent_reviewer" | "lead_static" = "independent_reviewer") {
  const itemId = createItem(db, { title: "修复空输入", brief: "空输入返回 400", createdBy: "lead", verificationPolicy: verification });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const executorRunId = createRun(db, { itemId, runtime: "pi" });
  updateRun(db, executorRunId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId, source: "system_recovered", sourceEventSeq: executorRunId, sourceOutputSha256: "d".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "加了空输入的校验", changes: [], deliverables: [],
      validations: [{ command: "npm test", outcome: "passed", summary: "42 passed" }],
    }, {}),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered", runId: executorRunId });
  return { itemId, executorRunId };
}

function noReviewerCanRun(itemId: number, runId: number): void {
  for (const id of runtimeIds()) {
    recordRuntimeHealthFailure(db, {
      profile: defaultRuntimeProfile(id), model: null, itemId, runId,
      failure: typedFailure("auth_required", { errorCode: `${id}_error`, message: "402 deactivated_workspace" }),
    });
  }
}

// Lead 被事件叫醒的一轮：没有你这一轮（currentTurnId 是 null）。
function leadTool(name: string) {
  const deps: LeadDeps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    currentTurnId: () => null,
    // 和派发 gate 按同一个 profile 查核查员能不能用（daemon 里两边都是 childRuntimeProfile）。
    ticketActionHost: { runtimeProfile: defaultRuntimeProfile },
  };
  const tool = createLeadTools(deps).find((candidate) => candidate.name === name)!;
  return async (params: Record<string, unknown>) => {
    const result = await tool.execute("call", params as never, undefined, undefined, undefined as never);
    return (result.content[0] as { text: string }).text;
  };
}

const blockedNotes = (itemId: number) => db.prepare(
  "SELECT payload FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='delegated_review_blocked'",
).all(itemId) as Array<{ payload: string }>;

describe("a delegated ticket whose review cannot run (D11)", () => {
  it("lets Lead accept on evidence when the user pre-checked it, and the persisted ledger says there was no independent review", async () => {
    const { itemId, executorRunId } = delivered();
    noReviewerCanRun(itemId, executorRunId);
    const server = await start();
    try {
      // 1. 页面上授权托管，勾了「核查做不成时由 Lead 凭证据验收」。
      const granted = await server.post("/v1/lead/delegation", {
        ticket_id: itemId, granted: true, max_rework_cycles: 1, accept_without_review: true,
      });
      expect(granted.status).toBe(200);
      expect(granted.body).toMatchObject({ granted: true, policy: { accept_without_review: 1 }, reworkStarted: false });
      expect(granted.body.preflight.checks.find((check: { id: string }) => check.id === "reviewer_runtime")).toMatchObject({ state: "warning" });

      // 2. 自动核查排上了，被挂起：只说一次。
      const dispatcher = createDispatcher(db);
      dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));
      for (let tick = 0; tick < 3; tick++) expect(dispatcher.claimNext()).toBeNull();
      expect(blockedNotes(itemId).map((row) => JSON.parse(row.payload))).toEqual([
        expect.objectContaining({ wakeLead: true, needsUser: false, leadMayAcceptWithoutReview: true }),
      ]);

      // 3. Lead 被叫醒，看到自己能凭托管做，然后凭证据验收。
      const listed = JSON.parse(await leadTool("list_ticket_actions")({ ticket_id: itemId })) as {
        actions: Array<{ id: string; lead: string; leadReady: boolean }>;
      };
      expect(listed.actions.find((entry) => entry.id === "accept_without_review")).toMatchObject({ lead: "delegated", leadReady: true });
      const accepted = JSON.parse(await leadTool("ticket_action")({
        ticket_id: itemId, action: "accept_without_review",
        reason: "读了交付快照和成果说明：npm test 42 passed，改动只在 src/api.ts",
      }));
      expect(accepted).toMatchObject({ action: "accept_without_review", authority: "delegated", result: { stage: "done", independentReview: false } });

      // 4. 页面读到的核查一节写明没有独立核查。
      const reviews = await server.get(`/v1/tickets/${itemId}/reviews`);
      expect(reviews.body.reviews.acceptedWithoutReview).toMatchObject({ by: "lead", authority: "delegated", onBehalfOf: null });
      // 授权托管只有用户本人能做：Lead 调用被拒，拒绝里写明去哪里点。
      const refused = JSON.parse(await leadTool("ticket_action")({ ticket_id: itemId, action: "delegate", reason: "再托管一次" }));
      expect(refused).toMatchObject({ refused: true, refusal: { permission: "user_direct", where: "工单详情的「授权托管」" } });
    } finally {
      await server.close();
    }
    db.close();

    // 关掉、重新打开：整条账还在。
    db = openDb(dbPath);
    expect(getItem(db, itemId)).toMatchObject({ stage: "done", closed_at: expect.any(String), acceptance_policy: "delegated_to_lead" });
    const ledger = (db.prepare(
      "SELECT actor, kind, payload FROM activities WHERE item_id=? ORDER BY id",
    ).all(itemId) as Array<{ actor: string; kind: string; payload: string }>).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    expect(ledger).toContainEqual(expect.objectContaining({
      actor: "lead", kind: "decision",
      payload: expect.objectContaining({ decision: "accepted_without_review", independentReview: false, authority: "delegated", deliveryRunId: executorRunId }),
    }));
    expect(ledger.filter((row) => row.kind === "transition").at(-1)).toMatchObject({
      actor: "system", payload: expect.objectContaining({ to: "done", reason: expect.stringContaining("没有独立核查") }),
    });
    expect(db.prepare("SELECT COUNT(*) FROM notifications WHERE item_id=? AND kind='accepted_without_review'").pluck().get(itemId)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='delegated_review_blocked'").pluck().get(itemId)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM review_verdicts WHERE item_id=?").pluck().get(itemId)).toBe(0);
    // Lead 的 get_ticket 读到的是同一份。
    const ticket = await leadTool("get_ticket")({ id: itemId });
    expect(ticket).toContain("没有独立核查就验收了（你按托管授权");
  });

  it("waits for the user when the option was not checked: Lead cannot accept, the user is told once", async () => {
    const { itemId, executorRunId } = delivered();
    const server = await start();
    try {
      expect((await server.post("/v1/lead/delegation", { ticket_id: itemId, granted: true, max_rework_cycles: 1 })).status).toBe(200);
      noReviewerCanRun(itemId, executorRunId);
      const dispatcher = createDispatcher(db);
      dispatcher.request(automaticReviewRequest(itemId, executorRunId, "codex"));
      for (let tick = 0; tick < 3; tick++) expect(dispatcher.claimNext()).toBeNull();
      expect(blockedNotes(itemId).map((row) => JSON.parse(row.payload))).toEqual([
        expect.objectContaining({ wakeLead: true, needsUser: true, leadMayAcceptWithoutReview: false }),
      ]);
      // 2026-10-28（用户：「工单操作让 Lead 自己判断」）：托管范围外，凭证据验收是 Lead 自己的判断。账本照样记下没有独立核查，
      // 写明是 Lead 做的（不是凭托管）。
      await leadTool("ticket_action")({ ticket_id: itemId, action: "accept_without_review", reason: "读了交付和测试输出，符合验收标准" });
      expect(getItem(db, itemId)!.stage).toBe("done");
      expect((await server.get(`/v1/tickets/${itemId}/reviews`)).body.reviews.acceptedWithoutReview).toMatchObject({ by: "lead", authority: "lead" });
    } finally {
      await server.close();
    }
  });

  // 复核 2026-10-23 第 1 条：config.json 读不出来时，谁停用的不知道。以前按用户停用的算，D11 因此放行 Lead 代验收。
  // 现在 daemon 交给工单操作的宿主按 Lead 停用的算（不让 Lead 代验收）。设置页「Lead 能不能重新启用」的判断照旧按用户停用的算。
  it("does not let Lead accept on evidence when config.json cannot be read", async () => {
    const { itemId } = delivered();
    grantDelegationPolicy(db, { itemId, createdVia: "test", acceptWithoutReview: true });
    const disabled = runtimeIds().join(",");
    vi.stubEnv("PLC_DISABLED_RUNTIMES", disabled);
    try {
      const settings = new RuntimeSettings({ dataDir: dir, env: { PLC_DISABLED_RUNTIMES: disabled } });
      // daemon 注入的同一个函数（server.ts 的 userActions.host）。
      const host = { runtimeDisabledBy: (id: Parameters<typeof settings.disabledByForDelegation>[0]) => settings.disabledByForDelegation(id) };
      const leadMode = async () => (await listLeadTicketActions(db, itemId, { turnId: null, host }))
        .find((entry) => entry.id === "accept_without_review")?.lead;
      // 对照：用户在设置页停用了全部执行器，config.json 读得出来，D11 生效。
      writeFileSync(join(dir, "config.json"), JSON.stringify({ runtimes: {
        disabled: runtimeIds(),
        disabledBy: Object.fromEntries(runtimeIds().map((id) => [id, { by: "user", reason: null, at: "2026-10-23T00:00:00.000Z" }])),
      } }));
      expect(await leadMode()).toBe("delegated");
      // config.json 坏了：读不出谁停用的。
      writeFileSync(join(dir, "config.json"), "{ not json");
      // 不在托管范围里：是 Lead 自己的判断（2026-10-28），账本不写凭托管。
      expect(await leadMode()).toBe("own");
      // 设置页的判断不变：读不出时按用户停用的算，Lead 不能重新启用。
      expect(settings.disabledBy(runtimeIds()[0]!)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to delegate a ticket that does not require an independent review, with the reason", async () => {
    const { itemId } = delivered("lead_static");
    const server = await start();
    try {
      const refused = await server.post("/v1/lead/delegation", { ticket_id: itemId, granted: true, max_rework_cycles: 1 });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: "delegation_preflight_failed", message: expect.stringContaining("不要求独立核查") });
      const actions = await server.get(`/v1/tickets/${itemId}/actions`);
      expect(actions.body.actions.find((entry: { id: string }) => entry.id === "delegate")).toMatchObject({
        available: false, permission: "user_direct", reason: expect.stringContaining("这张工单不要求独立核查（verification_policy=lead_static）"),
      });
      expect(getItem(db, itemId)).toMatchObject({ acceptance_policy: "user_only", verification_policy: "lead_static" });
    } finally {
      await server.close();
    }
  });
});

// 结构化验收标准的读取接口（工单详情与验收 spec 4.3、5.1、D5，工单 05）。单独的资源，不放进 TicketSummary：
// 客户端严格校验工单列表。GET /v1/tickets/:id/acceptance-criteria?delivery=N 用 tickets:view；
// 编辑和确认是工单操作（POST /v1/tickets/:id/actions/:action），这里从页面入口做一遍，读回来核对。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { HttpErrorResponseSchema, TicketAcceptanceCriteriaResponseSchema, TicketActionsResponseSchema } from "@pi-lead-child/protocol";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import {
  addAcceptanceCriteria, createItem, createPairing, createRun, insertOutcomeSnapshot, normalizeOutcomePayload, openDb,
  transition, updateRun, type Db,
} from "@pi-lead-child/store";

let db: Db;

beforeEach(() => { db = openDb(join(tempDir("plc-criteria-http-"), "plc.db")); });
afterEach(() => db.close());

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

async function token(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "criteria-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

// 一次交付（不是隔离分支的工单）。快照由读取接口补存，和交付视图一样。
function deliver(itemId: number): number {
  const stage = db.prepare("SELECT stage FROM items WHERE id=?").pluck().get(itemId);
  if (stage !== "active") transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: runId, sourceOutputSha256: "e".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return runId;
}

describe("GET /v1/tickets/:id/acceptance-criteria", () => {
  it("returns the criteria, and the user's confirmations per delivery", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}` };
      const itemId = createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
      const [first, second] = addAcceptanceCriteria(db, {
        itemId, texts: ["空输入返回 400", "错误信息写明字段名"], by: "lead", now: new Date("2026-10-21T00:00:00.000Z"),
      });
      const read = async (query = "") => {
        const response = await fetch(`${server.base}/v1/tickets/${itemId}/acceptance-criteria${query}`, { headers: auth });
        const body = await response.json();
        return { status: response.status, body };
      };
      const act = (action: string, input: Record<string, unknown>) => fetch(`${server.base}/v1/tickets/${itemId}/actions/${action}`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ input }),
      });

      const before = await read();
      expect(before.status).toBe(200);
      expect(Value.Check(TicketAcceptanceCriteriaResponseSchema, before.body)).toBe(true);
      expect(before.body).toEqual({
        acceptanceCriteria: {
          ticketId: itemId, delivery: null, deliveryPending: null, confirmed: 0,
          criteria: [
            {
              id: first!.id, number: 1, text: "空输入返回 400", revision: 1, writtenBy: "lead", writtenAt: "2026-10-21T00:00:00.000Z",
              editedBy: null, editedAt: null, changedAfterDelivery: null, deleted: false, confirmation: null, verdict: null,
            },
            expect.objectContaining({ id: second!.id, number: 2 }),
          ],
        },
      });

      const firstRun = deliver(itemId);
      // 读的时候补存交付快照（04），之后就能确认。
      expect((await read()).body.acceptanceCriteria.delivery).toMatchObject({ sequence: 1, attemptId: firstRun, latest: true });
      const actions = await (await fetch(`${server.base}/v1/tickets/${itemId}/actions`, { headers: auth })).json();
      expect(Value.Check(TicketActionsResponseSchema, actions)).toBe(true);
      expect(actions.actions.find((action: { id: string }) => action.id === "confirm_criterion")).toMatchObject({ available: true, permission: "user_only" });

      expect((await act("confirm_criterion", { criterionId: first!.id, deliverySequence: 1 })).status).toBe(200);
      const confirmed = await read();
      expect(Value.Check(TicketAcceptanceCriteriaResponseSchema, confirmed.body)).toBe(true);
      expect(confirmed.body.acceptanceCriteria.confirmed).toBe(1);
      expect(confirmed.body.acceptanceCriteria.criteria[0].confirmation).toMatchObject({ state: "confirmed", by: "user", onBehalfOf: null, voidedAt: null });

      // 交付以后改了第一条：确认作废，页面看得出来。
      expect((await act("edit_acceptance_criteria", { update: [{ id: first!.id, text: "空输入返回 400 和错误码" }] })).status).toBe(200);
      const voided = (await read()).body.acceptanceCriteria;
      expect(voided.criteria[0]).toMatchObject({ text: "空输入返回 400 和错误码", revision: 2, editedBy: "user", changedAfterDelivery: "edited" });
      expect(voided.criteria[0].confirmation).toMatchObject({ state: "voided", voidedAt: expect.any(String) });
      expect(voided.confirmed).toBe(0);

      // 两个页面同时改：带着旧版本的那一个被拒，409，details.reason 是 stale（审查 M3）。
      const staleEdit = await act("edit_acceptance_criteria", { update: [{ id: first!.id, text: "旧页面的版本", revision: 1 }] });
      expect(staleEdit.status).toBe(409);
      expect(await staleEdit.json()).toMatchObject({ error: { details: { reason: "stale" } } });

      // 页面上的输入不对、标准不在这张工单上：400、404。
      expect((await act("edit_acceptance_criteria", { add: ["两行\n不行"] })).status).toBe(400);
      expect((await act("confirm_criterion", { criterionId: 999_999 })).status).toBe(404);

      // 第 2 次交付从头开始；第 1 次交付还能读到。
      expect((await act("rework", {})).status).toBe(200);
      deliver(itemId);
      expect((await read()).body.acceptanceCriteria).toMatchObject({ delivery: { sequence: 2, latest: true }, confirmed: 0 });
      expect((await read("?delivery=1")).body.acceptanceCriteria).toMatchObject({ delivery: { sequence: 1, latest: false } });
      // 页面还停在第 1 次交付时确认：409，不记到第 2 次上。
      const stale = await act("confirm_criterion", { criterionId: second!.id, deliverySequence: 1 });
      expect(stale.status).toBe(409);
      // 页面过时了是 stale，和「快照还没存好」（unavailable）分得开（审查 L6）。
      expect(await stale.json()).toMatchObject({ error: { details: { reason: "stale" } } });
      expect((await read()).body.acceptanceCriteria.confirmed).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("needs tickets:view, an existing ticket and an existing delivery", async () => {
    const server = await start();
    try {
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
      const path = `${server.base}/v1/tickets/${itemId}/acceptance-criteria`;
      expect((await fetch(path)).status).toBe(401);
      const chatOnly = { authorization: `Bearer ${await token(server.base, ["chat"])}` };
      expect((await fetch(path, { headers: chatOnly })).status).toBe(403);

      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const missing = await fetch(`${server.base}/v1/tickets/9999/acceptance-criteria`, { headers: auth });
      expect(missing.status).toBe(404);
      expect(Value.Check(HttpErrorResponseSchema, await missing.json())).toBe(true);
      expect((await fetch(`${path}?delivery=3`, { headers: auth })).status).toBe(404);
      const invalid = await fetch(`${path}?delivery=0`, { headers: auth });
      expect(invalid.status).toBe(400);
      expect(Value.Check(HttpErrorResponseSchema, await invalid.json())).toBe(true);
      // 只读：别的方法不是这条路由。
      expect((await fetch(path, { method: "POST", headers: auth })).status).not.toBe(200);
    } finally {
      await server.close();
    }
  });
});

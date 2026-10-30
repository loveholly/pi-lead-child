// 执行计划的读取接口（工单详情与验收 spec 4.4、5.2，工单 06）。单独的资源，不放进 TicketSummary：
// 客户端严格校验工单列表。GET /v1/tickets/:id/plan 用 tickets:view。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { HttpErrorResponseSchema, TicketExecutionPlanResponseSchema } from "@pi-lead-child/protocol";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import { createItem, createPairing, createRun, openDb, recordExecutionPlan, transition, type Db } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => { db = openDb(join(tempDir("plc-plan-http-"), "plc.db")); });
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
  const { code } = createPairing(db, { name: "plan-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

describe("GET /v1/tickets/:id/plan", () => {
  it("returns null before the agent submits a plan, then the latest plan", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const itemId = createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
      transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });

      const empty = await fetch(`${server.base}/v1/tickets/${itemId}/plan`, { headers: auth });
      expect(empty.status).toBe(200);
      const emptyBody = await empty.json();
      expect(Value.Check(TicketExecutionPlanResponseSchema, emptyBody)).toBe(true);
      expect(emptyBody).toEqual({ plan: null });

      const runId = createRun(db, { itemId, runtime: "pi" });
      recordExecutionPlan(db, {
        itemId, runId, now: new Date("2026-10-21T10:00:00.000Z"),
        steps: [{ id: "read", title: "读现有的解析器", status: "in_progress" }],
      });
      recordExecutionPlan(db, {
        itemId, runId, now: new Date("2026-10-21T10:05:00.000Z"),
        steps: [
          { id: "read", title: "读现有的解析器", status: "done" },
          { id: "fix", title: "修复空输入", status: "blocked", note: "等 Lead 定方案" },
        ],
      });
      const response = await fetch(`${server.base}/v1/tickets/${itemId}/plan`, { headers: auth });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Value.Check(TicketExecutionPlanResponseSchema, body)).toBe(true);
      expect(body).toEqual({
        plan: {
          ticketId: itemId,
          revision: 2,
          attemptId: runId,
          createdAt: "2026-10-21T10:00:00.000Z",
          updatedAt: "2026-10-21T10:05:00.000Z",
          steps: [
            { id: "read", title: "读现有的解析器", status: "done", note: null },
            { id: "fix", title: "修复空输入", status: "blocked", note: "等 Lead 定方案" },
          ],
        },
      });
    } finally {
      await server.close();
    }
  });

  it("needs tickets:view and an existing ticket", async () => {
    const server = await start();
    try {
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
      const unauthenticated = await fetch(`${server.base}/v1/tickets/${itemId}/plan`);
      expect(unauthenticated.status).toBe(401);
      const chatOnly = { authorization: `Bearer ${await token(server.base, ["chat"])}` };
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/plan`, { headers: chatOnly })).status).toBe(403);

      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const missing = await fetch(`${server.base}/v1/tickets/9999/plan`, { headers: auth });
      expect(missing.status).toBe(404);
      const error = await missing.json();
      expect(Value.Check(HttpErrorResponseSchema, error)).toBe(true);
      expect(error).toMatchObject({ error: { code: "not_found" } });
      // 只读：别的方法不是这条路由。
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/plan`, { method: "POST", headers: auth })).status)
        .not.toBe(200);
    } finally {
      await server.close();
    }
  });
});

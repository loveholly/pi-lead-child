// 一次交付的核查（工单详情与验收 spec 4.5、5.7、D8，工单 10）：GET /v1/tickets/:id/reviews?delivery=N，用 tickets:view。
// 单独的资源，不放进 TicketSummary。核查员看到了什么（核查包和摘要）、逐条结论；验收标准的读取接口上每一条带着结论。
// 从核查员的工具（review_verdict）交结论，从页面读回来核对，经过真的网关。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { HttpErrorResponseSchema, TicketAcceptanceCriteriaResponseSchema, TicketReviewsResponseSchema } from "@pi-lead-child/protocol";
import { createAgentToolHandlers, prepareReviewPacket } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";
import {
  addAcceptanceCriteria, createItem, createPairing, createRun, insertOutcomeSnapshot, normalizeOutcomePayload, openDb,
  transition, updateRun, type Db,
} from "@pi-lead-child/store";

let db: Db;

beforeEach(() => { db = openDb(join(tempDir("plc-reviews-http-"), "plc.db")); });
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
  const { code } = createPairing(db, { name: "reviews-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

// 一次交付（不是隔离分支的工单）。快照由读取接口补存，和交付视图一样。
function deliver(itemId: number): number {
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: runId, sourceOutputSha256: "e".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "做完了", changes: [], deliverables: [],
      validations: [{ command: "npm test", outcome: "passed", summary: "通过" }],
    }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
  return runId;
}

describe("GET /v1/tickets/:id/reviews", () => {
  it("shows what the reviewer saw and its per-criterion verdict, next to each criterion", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const itemId = createItem(db, { title: "修复空输入", brief: "空输入返回 400", createdBy: "lead" });
      const [first, second] = addAcceptanceCriteria(db, { itemId, texts: ["空输入返回 400", "错误信息写明字段名"], by: "lead" });
      const read = async (path: string) => {
        const response = await fetch(`${server.base}/v1/tickets/${itemId}/${path}`, { headers: auth });
        return { status: response.status, body: await response.json() };
      };

      expect((await read("reviews")).body).toEqual({ reviews: { ticketId: itemId, delivery: null, attempts: [], acceptedWithoutReview: null } });
      const delivery = deliver(itemId);
      const empty = await read("reviews");
      expect(Value.Check(TicketReviewsResponseSchema, empty.body)).toBe(true);
      expect(empty.body.reviews).toEqual({ ticketId: itemId, delivery: { sequence: 1, attemptId: delivery, latest: true }, attempts: [], acceptedWithoutReview: null });

      const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review" });
      await prepareReviewPacket(db, { itemId, reviewerRunId: reviewer });
      await createAgentToolHandlers({ db, itemId, runId: reviewer }).call("review_verdict", {
        verdict: "fail",
        evidence: "第 2 条没做到",
        criteria: [
          { id: first!.id, result: "pass", evidence: "curl 空输入返回 400" },
          { id: second!.id, result: "fail", evidence: "错误信息里没有字段名" },
        ],
      });

      const reviews = await read("reviews");
      expect(reviews.status).toBe(200);
      expect(Value.Check(TicketReviewsResponseSchema, reviews.body)).toBe(true);
      expect(reviews.body.reviews.attempts).toEqual([expect.objectContaining({
        attemptId: reviewer,
        packetSummary: { criteria: 2, files: 0, additions: 0, deletions: 0, commits: 0, validations: 1, recheck: null },
        packet: expect.objectContaining({ brief: "空输入返回 400", delivery: { attemptId: delivery, sequence: 1 } }),
        verdict: expect.objectContaining({
          verdict: "fail", evidence: "第 2 条没做到", escalate: null, current: true, criteriaChangedSince: [],
          criteria: [
            { criterionId: first!.id, number: 1, revision: 1, result: "pass", evidence: "curl 空输入返回 400" },
            { criterionId: second!.id, number: 2, revision: 1, result: "fail", evidence: "错误信息里没有字段名" },
          ],
        }),
      })]);

      // 结论直接写在验收标准每一条的旁边（spec 5.7「结论的位置」）。
      const criteria = await read("acceptance-criteria");
      expect(Value.Check(TicketAcceptanceCriteriaResponseSchema, criteria.body)).toBe(true);
      expect(criteria.body.acceptanceCriteria.criteria.map((criterion: { verdict: unknown }) => criterion.verdict)).toEqual([
        { result: "pass", evidence: "curl 空输入返回 400", attemptId: reviewer, revision: 1, current: true },
        { result: "fail", evidence: "错误信息里没有字段名", attemptId: reviewer, revision: 1, current: true },
      ]);
    } finally {
      await server.close();
    }
  });

  it("needs tickets:view, an existing ticket and an existing delivery", async () => {
    const server = await start();
    try {
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
      const path = `${server.base}/v1/tickets/${itemId}/reviews`;
      expect((await fetch(path)).status).toBe(401);
      const chatOnly = { authorization: `Bearer ${await token(server.base, ["chat"])}` };
      expect((await fetch(path, { headers: chatOnly })).status).toBe(403);
      const auth = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const missing = await fetch(`${server.base}/v1/tickets/9999/reviews`, { headers: auth });
      expect(missing.status).toBe(404);
      expect(Value.Check(HttpErrorResponseSchema, await missing.json())).toBe(true);
      expect((await fetch(`${path}?delivery=2`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${path}?delivery=x`, { headers: auth })).status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

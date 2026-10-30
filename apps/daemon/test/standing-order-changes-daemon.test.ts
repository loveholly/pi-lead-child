// Lead 改常设指令走完每一跳（工单 10）：Lead 的工具提出更放开的修改 → 审批在 approvals 里等着、指令没变 →
// 用户在网关上批准（approvals:respond）→ 新版本生效、事件按新版本分诊、设置页读到版本历史和执行记录 →
// 用户在设置页回滚（tickets:create）→ 又一个新版本。daemon、网关、store 都是真的；Lead 的会话是替身。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  HttpErrorResponseSchema, StandingOrderDetailResponseSchema, StandingOrderListResponseSchema, StandingOrderProposalResponseSchema,
} from "@pi-lead-child/protocol";
import {
  addInbox, createLoopbackBinding, getStandingOrder, listEvents, listGatewayEvents, openDb, type Db,
} from "@pi-lead-child/store";
import { createLeadTools } from "@pi-lead-child/lead";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-standing-order-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

function sessionFactory() {
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

async function boot() {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: sessionFactory() as any, gatewayPort: 0, log: () => {} });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  // 能看、能改设置，但不能批审批。
  const editor = createLoopbackBinding(db, { name: "test-editor", scopes: ["tickets:view", "tickets:create"] });
  const viewer = createLoopbackBinding(db, { name: "test-viewer", scopes: ["tickets:view"] });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, owner, editor, viewer };
}

async function leadProposes(params: Record<string, unknown>): Promise<any> {
  const tool = createLeadTools({ db, dbPath, dataDir: dir }).find((candidate: any) => candidate.name === "propose_standing_order_change") as any;
  const result = await tool.execute("call", params);
  return JSON.parse(result.content[0].text);
}

function blockerLevel(scope: string): string | null {
  addInbox(db, { dedupScope: scope, severity: "blocker", source: "structural", summary: `blocker ${scope}`, lossless: true, payload: { kind: "test" } });
  return listEvents(db, { kind: "inbox.blocker", order: "desc", limit: 1 })[0]!.level;
}

describe("standing order changes through the daemon", () => {
  it("waits for the user's approval on the gateway, then the new version triages events; the user can roll it back", async () => {
    const { call, owner, editor, viewer } = await boot();
    const wake = getStandingOrder(db, "inbox.wake_lead")!;

    // Lead 提出更放开的修改：blocker 只进摘要。
    const proposed = await leadProposes({
      op: "update", id: "inbox.wake_lead", reason: "blocker 太多，先进摘要",
      action: { ...wake.action, level: "digest" },
    });
    expect(proposed.result).toBe("pending_approval");
    const approvalId = proposed.approval_id as number;
    expect(blockerLevel("before")).toBe("tell");

    // 设置页的清单里能看到等你批准的提议；会话里的卡读得到它。
    const list = await call("GET", "/v1/standing-orders", undefined, viewer.accessToken);
    expect(list.status).toBe(200);
    expect(Value.Check(StandingOrderListResponseSchema, list.body)).toBe(true);
    expect(list.body.proposals.map((proposal: any) => proposal.approvalId)).toEqual([approvalId]);
    expect(list.body.items.find((item: any) => item.id === "inbox.wake_lead")).toMatchObject({ version: 1, level: "tell", rule: "inbox.wake_lead" });
    const card = await call("GET", `/v1/standing-order-proposals/${approvalId}`, undefined, viewer.accessToken);
    expect(Value.Check(StandingOrderProposalResponseSchema, card.body)).toBe(true);
    expect(card.body.proposal).toMatchObject({ state: "pending", orderId: "inbox.wake_lead", baseVersion: 1 });

    // 没有 approvals:respond 的设备批不了；Lead 也走不到这条路由（它的工具里没有）。
    const forbidden = await call("POST", `/v1/standing-order-proposals/${approvalId}/decision`, { approve: true }, editor.accessToken);
    expect(forbidden.status).toBe(403);
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);
    // 通用的审批路由也不接这类审批。
    const generic = await call("POST", `/v1/approvals/${approvalId}/resolve`, { decision: "approve" });
    expect(generic.status).toBe(409);
    expect(getStandingOrder(db, "inbox.wake_lead")?.version).toBe(1);

    const approved = await call("POST", `/v1/standing-order-proposals/${approvalId}/decision`, { approve: true });
    expect(approved.status).toBe(200);
    expect(Value.Check(StandingOrderProposalResponseSchema, approved.body)).toBe(true);
    expect(approved.body.proposal).toMatchObject({ state: "approved", appliedVersion: 2 });
    expect(approved.body.proposal.resolvedBy).toMatch(/^user via test-web（binding \d+）$/);
    expect(approved.body.order).toMatchObject({ version: 2, author: "lead", level: "digest" });
    expect(listGatewayEvents(db, { afterSeq: -1, bindingId: owner.binding.id, scopes: ["approvals:respond"], limit: 1000 })
      .some((event) => event.type === "approval.resolved" && event.payload.approvalId === approvalId)).toBe(true);
    expect(blockerLevel("after")).toBe("digest");

    // 详情：版本历史和最近的执行记录（分诊依据指向这条指令的事件），线上用 ticketId、attemptId。
    const detail = await call("GET", "/v1/standing-orders/inbox.wake_lead", undefined, viewer.accessToken);
    expect(detail.status).toBe(200);
    expect(Value.Check(StandingOrderDetailResponseSchema, detail.body)).toBe(true);
    expect(detail.body.versions.map((version: any) => [version.version, version.author])).toEqual([[1, "system"], [2, "lead"]]);
    expect(detail.body.executions.slice(0, 2).map((execution: any) => [execution.summary, execution.version, execution.level]))
      .toEqual([["blocker after", 2, "digest"], ["blocker before", 1, "tell"]]);
    expect(detail.body.proposals[0]).toMatchObject({ approvalId, state: "approved" });

    // 用户在设置页回滚：只看的设备不行，能改设置的设备可以，直接生效。
    expect((await call("POST", "/v1/standing-orders/inbox.wake_lead/rollback", { version: 1 }, viewer.accessToken)).status).toBe(403);
    const rolledBack = await call("POST", "/v1/standing-orders/inbox.wake_lead/rollback", { version: 1 }, editor.accessToken);
    expect(rolledBack.status).toBe(200);
    expect(Value.Check(StandingOrderDetailResponseSchema, rolledBack.body)).toBe(true);
    expect(rolledBack.body.order).toMatchObject({ version: 3, author: "user", level: "tell" });
    expect(rolledBack.body.order.approvedBy).toMatch(/^user via test-editor/);
    expect(blockerLevel("rolled-back")).toBe("tell");
    expect(listEvents(db, { kind: "standing_order.changed" }).map((event) => [event.source, event.payload.author, event.payload.version]))
      .toEqual([["lead", "lead", 2], ["system", "user", 3]]);
  });

  it("answers malformed and unknown requests with the strict error shape", async () => {
    const { call } = await boot();
    const cases = [
      [await call("GET", "/v1/standing-orders/Bad%20Id"), 400],
      [await call("GET", "/v1/standing-orders/inbox.nothing"), 404],
      [await call("POST", "/v1/standing-orders/inbox.wake_lead/rollback", { version: "1" }), 400],
      [await call("POST", "/v1/standing-orders/inbox.wake_lead/rollback", { version: 1 }), 400],
      [await call("GET", "/v1/standing-order-proposals/999"), 404],
      [await call("POST", "/v1/standing-order-proposals/999/decision", { approve: "yes" }), 400],
      [await call("POST", "/v1/standing-order-proposals/999/decision", { approve: true }), 404],
    ] as const;
    for (const [response, status] of cases) {
      expect(response.status).toBe(status);
      expect(Value.Check(HttpErrorResponseSchema, response.body)).toBe(true);
    }
    expect((await call("GET", "/v1/standing-orders", undefined, null)).status).toBe(401);
  });
});

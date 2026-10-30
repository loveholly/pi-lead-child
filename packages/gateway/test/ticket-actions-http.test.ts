// 工单操作的页面入口（工单详情 spec 5.11，实现工单 03）：GET /v1/tickets/:id/actions 和 POST /v1/tickets/:id/actions/:action。
// 页面按清单决定按钮能不能点；点下去和旧的路由（/confirm……）走同一份实现，记同样的账本和主人操作。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { TicketActionsResponseSchema, TicketActionRunResponseSchema } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createPairing, createTurn, getBinding, getItem, listActivities, openDb, transition, type Db,
} from "@pi-lead-child/store";
import { liveChildren, runTicketAction } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ticket-actions-http-"), "plc.db"));
  liveChildren().clear();
});
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
  const { code } = createPairing(db, { name: "actions-client", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

const ownerActions = () => (db.prepare("SELECT payload FROM events WHERE kind='owner_action.performed' ORDER BY seq").all() as
  Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as { action: string; target: { ticketId: number } });

// 账本里和这张工单有关的行：kind、actor 和 payload 里描述效果的字段。
const ledger = (itemId: number) => listActivities(db, itemId).map((activity) => {
  const payload = JSON.parse(activity.payload) as Record<string, unknown>;
  return { kind: activity.kind, actor: activity.actor, from: payload.from, to: payload.to, decision: payload.decision };
});

describe("the ticket action routes", () => {
  it("lists what can be done now, with the reason when not, for anyone who can view tickets", async () => {
    const server = await start();
    try {
      const viewer = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}` };
      const itemId = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
      const response = await fetch(`${server.base}/v1/tickets/${itemId}/actions`, { headers: viewer });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Value.Check(TicketActionsResponseSchema, body)).toBe(true);
      const actions = (body as { actions: Array<{ id: string; available: boolean; reason: string | null; permission: string }> }).actions;
      // 确认开跑是 delegated：用户给过 plc trust 的长期授权时 Lead 自己确认（ui-action-parity P03）。
      expect(actions.find((action) => action.id === "confirm")).toMatchObject({ available: true, reason: null, permission: "delegated" });
      expect(actions.find((action) => action.id === "complete")).toMatchObject({
        available: false, reason: "工单现在是「草稿」，不能验收。",
      });
      expect(actions.find((action) => action.id === "open_pr")).toMatchObject({ available: false, external: true });

      const missing = await fetch(`${server.base}/v1/tickets/999/actions`, { headers: viewer });
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("runs an action as the user, with the action's own scope, and records the owner action", async () => {
    const server = await start();
    try {
      const viewer = { authorization: `Bearer ${await token(server.base, ["tickets:view"])}`, "content-type": "application/json" };
      const writer = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const itemId = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });

      const readOnly = await fetch(`${server.base}/v1/tickets/${itemId}/actions/confirm`, { method: "POST", headers: viewer, body: "{}" });
      expect(readOnly.status).toBe(403);
      expect(getItem(db, itemId)!.stage).toBe("draft");

      const confirmed = await fetch(`${server.base}/v1/tickets/${itemId}/actions/confirm`, { method: "POST", headers: writer, body: "{}" });
      expect(confirmed.status).toBe(200);
      const body = await confirmed.json();
      expect(Value.Check(TicketActionRunResponseSchema, body)).toBe(true);
      expect(body).toMatchObject({ ticketId: itemId, action: "confirm", result: { stage: "ready" }, ticket: { id: itemId, status: "ready" } });
      expect(ledger(itemId)).toEqual([{ kind: "transition", actor: "user", from: "draft", to: "ready", decision: undefined }]);
      expect(ownerActions()).toMatchObject([{ action: "ticket.confirm", target: { ticketId: itemId } }]);

      const priority = await fetch(`${server.base}/v1/tickets/${itemId}/actions/set_priority`, {
        method: "POST", headers: writer, body: JSON.stringify({ input: { priority: "urgent" }, reason: "老板在催" }),
      });
      expect(priority.status).toBe(200);
      expect(getItem(db, itemId)!.priority).toBe("urgent");
    } finally {
      await server.close();
    }
  });

  it("refuses unknown actions, malformed input and actions that cannot be done now", async () => {
    const server = await start();
    try {
      const writer = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const itemId = createItem(db, { title: "待开始", brief: "b", createdBy: "lead" });
      const post = (action: string, body: unknown) => fetch(`${server.base}/v1/tickets/${itemId}/actions/${action}`, {
        method: "POST", headers: writer, body: JSON.stringify(body),
      });

      expect((await post("teleport", {})).status).toBe(404);
      const typo = await post("set_priority", { input: { priority: "asap" } });
      expect(typo.status).toBe(400);
      expect(await typo.json()).toMatchObject({ error: { code: "invalid_request", details: { reason: "invalid_input" } } });
      // 页面入口没有「谁做的」：自称 Lead 的请求体不合格式。
      expect((await post("confirm", { actor: "lead" })).status).toBe(400);

      const listed = (await (await fetch(`${server.base}/v1/tickets/${itemId}/actions`, { headers: writer })).json() as {
        actions: Array<{ id: string; reason: string | null }>;
      }).actions.find((action) => action.id === "confirm")!;
      const refused = await post("confirm", {});
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: { code: "conflict", message: listed.reason, details: { reason: "unavailable" } } });
      expect(getItem(db, itemId)!.stage).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("makes the old routes call the same action, so they leave the same ledger and one owner action", async () => {
    const server = await start();
    try {
      const writer = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const viaOld = createItem(db, { title: "旧路由", brief: "b", createdBy: "lead" });
      const viaNew = createItem(db, { title: "新路由", brief: "b", createdBy: "lead" });
      for (const itemId of [viaOld, viaNew]) {
        transition(db, { itemId, to: "active", actor: "system", reason: "start" });
        transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
      }
      const old = await fetch(`${server.base}/v1/tickets/${viaOld}/complete`, { method: "POST", headers: writer, body: "{}" });
      expect(old.status).toBe(200);
      expect(await old.json()).toMatchObject({ ticketId: viaOld, action: "complete", ticket: { status: "done" } });
      const fresh = await fetch(`${server.base}/v1/tickets/${viaNew}/actions/complete`, { method: "POST", headers: writer, body: "{}" });
      expect(fresh.status).toBe(200);

      expect(ledger(viaOld)).toEqual(ledger(viaNew));
      expect(ledger(viaOld).at(-1)).toEqual({ kind: "transition", actor: "user", from: "review", to: "done", decision: undefined });
      expect(ownerActions().map((action) => [action.action, action.target.ticketId])).toEqual([
        ["ticket.complete", viaOld], ["ticket.complete", viaNew],
      ]);
    } finally {
      await server.close();
    }
  });

  // 「谁验收的」（工作台的 outcomeSnapshot.facts.acceptance）：Lead 在你这一轮里代你验收，决定仍是你的，不是「没有验收」。
  it("projects an acceptance Lead made on the user's behalf as the user's", async () => {
    const itemId = createItem(db, { title: "待验收", brief: "b", createdBy: "lead" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "accept-turn", originBindingId: binding.id, originKind: "paired:companion", userText: "验收吧", state: "streaming" });
    await runTicketAction(db, { itemId, action: "complete", caller: { kind: "lead", turnId: turn.id }, reason: "用户说验收" });
    const service = createControlPlaneService(db, { runtime, now: () => new Date() });
    expect(service.getKernelTicketWorkbenchV2(itemId)?.outcomeSnapshot?.facts.acceptance).toBe("user");
  });

  // spec 5.11 规则 4：Lead 代你做的操作和你点的一样能撤销。审查 M5：代做时点「撤销」，最常见的原因是 Lead 理解错了，
  // 不是凭证被盗。所以代做的操作只撤销、不作废凭证（你的设备照常能用），提醒正文告诉你：那句话不是你说的，就去
  // 「设置 → 已配对设备」撤销那台设备。你自己的凭证做的操作，「不是我」照旧撤销并作废凭证（owner-actions-http.test.ts）。
  it("undoes an action Lead misunderstood without revoking the user's own device", async () => {
    const server = await start();
    try {
      const itemId = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
      // Lead 代做的权限不能大过这一轮的凭证（.scratch/child-self-approve/options.md）：只读设备的一轮不能让 Lead 代确认工单。
      const viewer = createLoopbackBinding(db, { name: "只读网页", scopes: ["tickets:view", "approvals:respond", "notices"] });
      createTurn(db, {
        id: "viewer-turn", originBindingId: viewer.binding.id, originKind: "paired:companion", userText: "开工吧", state: "streaming",
      });
      await expect(runTicketAction(db, { itemId, action: "confirm", caller: { kind: "lead", turnId: "viewer-turn" }, reason: "用户说开工" }))
        .rejects.toMatchObject({ code: "needs_user_turn", message: expect.stringContaining("没有 tickets:create") });
      expect(getItem(db, itemId)!.stage).toBe("draft");

      // 你在这台设备的网页上跟 Lead 说话；同一台设备点「撤销」。
      const device = createLoopbackBinding(db, { name: "本机网页" });
      const turn = createTurn(db, {
        id: "misread-turn", originBindingId: device.binding.id, originKind: "paired:companion", userText: "先看看再说", state: "streaming",
      });
      const outcome = await runTicketAction(db, { itemId, action: "confirm", caller: { kind: "lead", turnId: turn.id }, reason: "我以为用户要开工" });
      expect(getItem(db, itemId)!.stage).toBe("ready");
      const notice = db.prepare("SELECT kind, body FROM notifications ORDER BY id DESC LIMIT 1").get() as { kind: string; body: string };
      expect(notice.kind).toBe("owner_action_on_behalf");
      expect(notice.body).toMatch(/Paimon 在对话里代你做的[\s\S]*「撤销」[\s\S]*已配对设备/);

      const undone = await fetch(`${server.base}/v1/owner-actions/${outcome.ownerActionEventId}/disown`, {
        method: "POST", headers: { authorization: `Bearer ${device.accessToken}`, "content-type": "application/json" }, body: "{}",
      });
      expect(undone.status).toBe(200);
      expect(await undone.json()).toMatchObject({
        ownerAction: {
          action: "ticket.confirm",
          source: { client: "lead" },
          disowned: {
            revert: { status: "reverted" },
            credential: { bindingId: device.binding.id, revoked: false, message: expect.stringContaining("已配对设备") },
          },
        },
      });
      expect(getItem(db, itemId)!.stage).toBe("draft");
      expect(getBinding(db, device.binding.id)!.status).toBe("active");
      // 设备照常能用。
      expect((await fetch(`${server.base}/v1/tickets/${itemId}/actions`, { headers: { authorization: `Bearer ${device.accessToken}` } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  // 审查 M3：撤销关联是幂等的。第二次撤销同一条关系回 200 和 already_revoked（protocol 的 TicketRelationMutationResultSchema），
  // 不回 409。旧路由和新路由都一样。
  it("revokes the same relation twice without an error", async () => {
    const server = await start();
    try {
      const writer = { authorization: `Bearer ${await token(server.base, ["tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const source = createItem(db, { title: "源", brief: "b", createdBy: "lead" });
      const target = createItem(db, { title: "目标", brief: "b", createdBy: "lead" });
      const linked = await fetch(`${server.base}/v1/tickets/${source}/relations`, {
        method: "POST", headers: writer, body: JSON.stringify({ targetTicketId: target, relationType: "relates_to", reason: "有关" }),
      });
      const { relationId } = await linked.json() as { relationId: number };
      const revoke = () => fetch(`${server.base}/v1/tickets/${source}/relations/${relationId}/revoke`, {
        method: "POST", headers: writer, body: JSON.stringify({ reason: "不相关" }),
      });
      expect(await (await revoke()).json()).toMatchObject({ status: "revoked", active: false });
      const again = await revoke();
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ status: "already_revoked", relationId, active: false });
      const viaAction = await fetch(`${server.base}/v1/tickets/${source}/actions/unlink`, {
        method: "POST", headers: writer, body: JSON.stringify({ input: { relationId }, reason: "不相关" }),
      });
      expect(viaAction.status).toBe(200);
      expect(await viaAction.json()).toMatchObject({ result: { status: "already_revoked" } });
    } finally {
      await server.close();
    }
  });
});

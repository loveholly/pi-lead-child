// genui 卡片上的按钮（v3 积木 5，2026-10-27）走的通用页面入口：GET /v1/actions/:type/:id 列出这个对象现在能做的操作，
// POST /v1/actions/:type/:id/:action 以你本人的身份做。和 Lead 的 list_actions、perform_action 是同一个函数（engine 的 ui-actions）：
// 能不能做的判断、权限（每个操作登记的 scope）和账本都一样。
import { join } from "node:path";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import { UI_ACTION_PERFORMED_KIND, UiActionsResponseSchema } from "@pi-lead-child/protocol";
import { createItem, createPairing, getItem, listEvents, openDb, transition, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-ui-action-routes-"), "plc.db")); });

async function start() {
  const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null });
  const controlPlane = createControlPlaneService(db, { runtime });
  const server = await startPairedServer({
    db, controlPlane, userActions: createUserActionService({ db }),
    hello: () => runtime(), chat: () => "started", addClient: () => () => {}, log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function redeem(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

describe("the generic page entry of an operation", () => {
  it("lists what a reminder can do now, and moves it to a new time as the user", async () => {
    const id = createItem(db, { kind: "reminder", title: "彪哥 last day", brief: "", createdBy: "user", remindAt: "2099-10-29T06:00:00.000Z" });
    const server = await start();
    try {
      const token = await redeem(server.base, ["chat", "tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const listed = await (await fetch(`${server.base}/v1/actions/reminder/${id}`, { headers })).json();
      expect(Value.Check(UiActionsResponseSchema, listed)).toBe(true);
      expect(listed.actions.map((action: { id: string; available: boolean }) => [action.id, action.available])).toEqual([["ack", false], ["reschedule", true]]);

      const at = "2099-10-30T06:00:00.000Z";
      const moved = await fetch(`${server.base}/v1/actions/reminder/${id}/reschedule`, { method: "POST", headers, body: JSON.stringify({ input: { remindAt: at } }) });
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({ target: { type: "reminder", id: String(id) }, action: "reschedule" });
      expect(getItem(db, id)!.remind_at).toBe(at);
      expect(listEvents(db).find((event) => event.kind === UI_ACTION_PERFORMED_KIND)?.payload).toMatchObject({ actor: "user", authority: "user" });
    } finally {
      await server.close();
    }
  });

  it("refuses what the operation itself refuses, and a credential without the operation's scope", async () => {
    const id = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2099-10-29T06:00:00.000Z" });
    transition(db, { itemId: id, to: "cancelled", actor: "user", reason: "x" });
    const server = await start();
    try {
      const writer = await redeem(server.base, ["chat", "tickets:create"]);
      const reader = await redeem(server.base, ["chat"]);
      const post = (token: string, body: unknown) => fetch(`${server.base}/v1/actions/reminder/${id}/reschedule`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await post(writer, { input: { remindAt: "2099-10-30T06:00:00.000Z" } })).status).toBe(409);
      expect((await post(reader, { input: { remindAt: "2099-10-30T06:00:00.000Z" } })).status).toBe(403);
      expect((await post(writer, { actor: "lead" })).status).toBe(403);
      expect((await fetch(`${server.base}/v1/actions/reminder/999`, { headers: { authorization: `Bearer ${writer}` } })).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

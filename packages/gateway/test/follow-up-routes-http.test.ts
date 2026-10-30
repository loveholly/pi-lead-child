// 排着的追问的两个页面入口（用户 2026-10-28，protocol 的 lead-follow-ups.ts）：POST /v1/lead/follow-ups/steer、/cancel。
// 和 Lead 的 perform_action 是同一个操作（engine 的 ui-actions 的 follow_up）。排队在 daemon 里，这里用一个替身服务：
// 成功时回答这一条现在的放置；这一条不在了是 404；Lead 已经不忙了（这一条转为下一轮单独回答）时插不进是 409，还能取消。
import { join } from "node:path";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  CHAT_FOLLOW_UP_ACTIONS_CAPABILITY, FollowUpActionResultSchema, UI_ACTION_PERFORMED_KIND,
} from "@pi-lead-child/protocol";
import { createPairing, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { UiActionError, type FollowUpEntry, type FollowUpQueueService } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-follow-up-routes-"), "plc.db")); });

// 替身：daemon 的排队。busy 为 false 时（Lead 答完了这一轮）排着的都转为下一轮单独回答（heldForOwnTurn），和 daemon 一样。
function fakeFollowUps(turnIds: string[]) {
  const state = { busy: true, turnIds: [...turnIds] };
  const calls: string[] = [];
  const entry = (turnId: string): FollowUpEntry => ({
    turnId, text: `追问 ${turnId}`, at: "2026-10-28T01:00:00.000Z", heldForOwnTurn: !state.busy,
    ...(state.busy ? {} : { heldReason: "这条排在下一轮单独回答，插不进正在跑的这一轮" }),
  });
  const take = (turnId: string) => { state.turnIds = state.turnIds.filter((id) => id !== turnId); };
  const service: FollowUpQueueService = {
    snapshot: () => state.turnIds.map(entry),
    steer: async (turnId) => {
      if (!state.busy) throw new UiActionError("unavailable", "Lead 已经答完这一轮了");
      calls.push(`steer ${turnId}`);
      take(turnId);
      return { turnId, placement: "steered" };
    },
    cancel: async (turnId, by) => {
      calls.push(`cancel ${turnId} by ${by}`);
      take(turnId);
      return { turnId, placement: "cancelled" };
    },
  };
  return { service, state, calls };
}

async function start(followUps?: FollowUpQueueService) {
  const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: true, runningItemIds: [], aish: null });
  const controlPlane = createControlPlaneService(db, { runtime });
  const server = await startPairedServer({
    db, controlPlane, userActions: createUserActionService({ db }),
    ...(followUps ? { uiActionServices: { followUps } } : {}),
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

function post(base: string, token: string, action: string, body: unknown) {
  return fetch(`${base}/v1/lead/follow-ups/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function capabilities(port: number, token: string): Promise<string[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/paired/events?token=${token}&protocol=2`);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  try {
    await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
    return messages.find((message) => message.type === "hello.v2").capabilities;
  } finally {
    ws.close();
  }
}

describe("the page entries of a queued follow-up", () => {
  it("steers one and cancels another as the user, and answers with the placement", async () => {
    const { service, calls } = fakeFollowUps(["turn_b", "turn_c"]);
    const server = await start(service);
    try {
      const token = await redeem(server.base, ["chat"]);
      expect(await capabilities(server.port, token)).toContain(CHAT_FOLLOW_UP_ACTIONS_CAPABILITY);

      const steered = await post(server.base, token, "steer", { turnId: "turn_c" });
      expect(steered.status).toBe(200);
      const steeredBody = await steered.json();
      expect(Value.Check(FollowUpActionResultSchema, steeredBody)).toBe(true);
      expect(steeredBody).toEqual({ turnId: "turn_c", placement: "steered" });

      const cancelled = await post(server.base, token, "cancel", { turnId: "turn_b" });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ turnId: "turn_b", placement: "cancelled" });

      expect(calls).toEqual(["steer turn_c", expect.stringMatching(/^cancel turn_b by user via phone（binding \d+）$/)]);
      expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND }).map((event) => [event.payload.action, event.payload.actor])).toEqual([
        ["steer", "user"], ["cancel", "user"],
      ]);
    } finally {
      await server.close();
    }
  });

  it("says 404 for a turn id that is not queued, and refuses a bad body and a credential without chat", async () => {
    const { service, calls } = fakeFollowUps(["turn_b"]);
    const server = await start(service);
    try {
      const token = await redeem(server.base, ["chat"]);
      const viewer = await redeem(server.base, ["tickets:view"]);
      const missing = await post(server.base, token, "steer", { turnId: "turn_gone" });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatchObject({ code: "not_found", details: { reason: "not_found" } });
      expect((await post(server.base, token, "cancel", { turnId: "turn_gone" })).status).toBe(404);
      expect((await post(server.base, token, "steer", { turnId: "" })).status).toBe(400);
      expect((await post(server.base, token, "steer", { turnId: "turn_b", extra: 1 })).status).toBe(400);
      expect((await post(server.base, viewer, "steer", { turnId: "turn_b" })).status).toBe(403);
      expect((await post(server.base, token, "remove", { turnId: "turn_b" })).status).toBe(404);
      expect(calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses a steer once Lead is no longer busy, with the reason, and still cancels", async () => {
    const { service, state, calls } = fakeFollowUps(["turn_b"]);
    const server = await start(service);
    try {
      const token = await redeem(server.base, ["chat"]);
      state.busy = false;
      const steer = await post(server.base, token, "steer", { turnId: "turn_b" });
      expect(steer.status).toBe(409);
      expect((await steer.json()).error).toMatchObject({
        code: "conflict", message: "这条排在下一轮单独回答，插不进正在跑的这一轮。", details: { reason: "unavailable" },
      });
      expect((await post(server.base, token, "cancel", { turnId: "turn_b" })).status).toBe(200);
      expect(calls).toEqual([expect.stringMatching(/^cancel turn_b by /)]);
    } finally {
      await server.close();
    }
  });

  it("does not announce the capability without a follow-up service from the daemon, and says the session has not started", async () => {
    const server = await start();
    try {
      const token = await redeem(server.base, ["chat"]);
      expect(await capabilities(server.port, token)).not.toContain(CHAT_FOLLOW_UP_ACTIONS_CAPABILITY);
      const response = await post(server.base, token, "steer", { turnId: "turn_b" });
      expect(response.status).toBe(409);
      expect((await response.json()).error.message).toContain("还没有启动");
    } finally {
      await server.close();
    }
  });
});

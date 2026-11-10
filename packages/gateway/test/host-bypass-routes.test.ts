// /v1/lead/host-bypass 的路由（设置 → 免沙箱，工单 #246 实施单 A）。网关、store、操作层是真的。这里核对：
//   - 读：tickets:view；开、关：tickets:create，只读的设备点不了；
//   - 打开和关闭的请求体都是 {}：打开不带时长（用户 2026-11-10 去掉了时限），带了回 400；
//   - 打开、关闭都以你本人的名义记一条 ui_action.performed，回的是新的状态。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-host-bypass-routes-"), "plc.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, {
      runtime: () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null }),
      now: () => new Date(),
    }),
    hello: () => ({}),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  servers.push(server);
  const owner = createLoopbackBinding(db, { name: "本机网页" });
  const reader = createLoopbackBinding(db, { name: "只读", scopes: ["tickets:view"] });
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token = owner.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, owner, reader };
}

function ledger() {
  return db.prepare("SELECT payload FROM events WHERE kind=? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND).map((row: any) => JSON.parse(row.payload));
}

describe("the host-bypass routes", () => {
  it("reads with tickets:view, and turns on and off with tickets:create as you", async () => {
    const { call, reader, owner } = await start();
    expect(await call("GET", "/v1/lead/host-bypass", undefined, reader.accessToken)).toMatchObject({
      status: 200, body: { hostBypass: { enabled: false, enabledAt: null, bindingId: null, reason: null } },
    });
    expect((await call("POST", "/v1/lead/host-bypass/enable", {}, reader.accessToken)).status).toBe(403);

    const on = await call("POST", "/v1/lead/host-bypass/enable", {});
    expect(on).toEqual({
      status: 200,
      body: { hostBypass: { enabled: true, enabledAt: expect.any(String), bindingId: owner.binding.id, reason: expect.any(String) } },
    });
    expect((await call("GET", "/v1/lead/host-bypass")).body.hostBypass.enabled).toBe(true);

    const off = await call("POST", "/v1/lead/host-bypass/disable", {});
    expect(off).toMatchObject({ status: 200, body: { hostBypass: { enabled: false, enabledAt: null } } });
    expect(ledger()).toEqual([
      expect.objectContaining({ target: { type: "host_bypass", id: "lead" }, action: "enable", actor: "user" }),
      expect.objectContaining({ target: { type: "host_bypass", id: "lead" }, action: "disable", actor: "user" }),
    ]);
  });

  it("takes no duration", async () => {
    const { call } = await start();
    for (const body of [{ minutes: 30 }, { minutes: 15 }, { until: "2026-11-10T12:00:00.000Z" }, null, "on"]) {
      expect((await call("POST", "/v1/lead/host-bypass/enable", body)).status).toBe(400);
    }
    expect((await call("POST", "/v1/lead/host-bypass/disable", { minutes: 30 })).status).toBe(400);
    expect((await call("GET", "/v1/lead/host-bypass")).body.hostBypass.enabled).toBe(false);
    expect(ledger()).toEqual([]);
  });
});

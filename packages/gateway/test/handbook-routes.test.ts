// /v1/channels/handbook 的路由（设置 → 消息通道 → 自动代你处理，交接说明，issue 07）。网关、store、操作层是真的。这里核对：
//   - 读：tickets:view，回现在生效的、最新版本里写的、缺省的，和存在哪一版；
//   - 改（PUT）：tickets:create；请求体是改完以后的一整份，坏的回 400；改成写一个作者是你的新版本；
//   - 预演：tickets:view 就够；没接任何来源时回 409，不写任何版本；
//   - 整理成一句：tickets:create；请求体坏的回 400；没有文字模型时回 409；有时回整理结果，不写任何版本；
//   - 页边批注：看建议 tickets:view；接受、不用 tickets:create；没有这条建议时接受回 409，不用照样记下。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_HANDBOOK_DEFAULTS } from "@pi-lead-child/protocol";
import type { UiActionServices } from "@pi-lead-child/engine";
import { createLoopbackBinding, listStandingOrderVersions, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-handbook-routes-"), "plc.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

async function start(uiActionServices?: UiActionServices) {
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
    ...(uiActionServices ? { uiActionServices } : {}),
  }, { port: 0 });
  servers.push(server);
  const owner = createLoopbackBinding(db, { name: "本机网页" });
  const reader = createLoopbackBinding(db, { name: "只读", scopes: ["tickets:view"] });
  const call = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown, token = owner.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, owner, reader };
}

describe("the handbook routes", () => {
  it("reads the handbook with tickets:view", async () => {
    const { call, reader } = await start();
    const read = await call("GET", "/v1/channels/handbook", undefined, reader.accessToken);
    expect(read.status).toBe(200);
    expect(read.body.handbook).toMatchObject({
      handbook: CHANNEL_HANDBOOK_DEFAULTS, requested: CHANNEL_HANDBOOK_DEFAULTS, order: { id: "channel.handbook", version: 1, author: "system" },
    });
  });

  it("saves the whole handbook as your own version, and refuses a broken one or a reader", async () => {
    const { call, reader } = await start();
    const next = { ...CHANNEL_HANDBOOK_DEFAULTS, caps: { ...CHANNEL_HANDBOOK_DEFAULTS.caps, external: "hand" } };
    const saved = await call("PUT", "/v1/channels/handbook", next);
    expect(saved.status).toBe(200);
    expect(saved.body.handbook).toMatchObject({ handbook: { caps: { external: "hand" } }, order: { version: 2, author: "user" } });
    expect((await call("PUT", "/v1/channels/handbook", next, reader.accessToken)).status).toBe(403);
    const customer = await call("PUT", "/v1/channels/handbook", { ...next, caps: { ...next.caps, customer: "auto" } });
    expect(customer).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("客户的上限") } } });
    expect((await call("PUT", "/v1/channels/handbook", { autoReply: true })).status).toBe(400);
    expect(listStandingOrderVersions(db, "channel.handbook")).toHaveLength(2);
  });

  it("rehearses with tickets:view, and says no source is connected yet", async () => {
    const { call, reader } = await start();
    const rehearsed = await call("POST", "/v1/channels/handbook/rehearse", { text: "帮我处理一下 PROJ-6651", sender: "colleague" }, reader.accessToken);
    expect(rehearsed.status).toBe(409);
    expect((await call("POST", "/v1/channels/handbook/rehearse", { text: "", sender: "colleague" })).status).toBe(400);
    expect(listStandingOrderVersions(db, "channel.handbook")).toHaveLength(1);
  });

  it("tidies a loose sentence with tickets:create, and writes nothing", async () => {
    const reply = JSON.stringify({ text: "有人请我看线上日志", mode: "auto", does: "读日志", abilities: ["read_connections"], same: null, unclear: null });
    const bare = await start();
    expect((await bare.call("POST", "/v1/channels/handbook/propose", { text: "看日志的活你直接做" })).status).toBe(409);
    const { call, reader } = await start({ textModel: () => async () => reply });
    const proposed = await call("POST", "/v1/channels/handbook/propose", { text: "看日志的活你直接做" });
    expect(proposed).toMatchObject({ status: 200, body: { result: { status: "ok", situation: { text: "有人请我看线上日志", mode: "auto" } } } });
    expect((await call("POST", "/v1/channels/handbook/propose", { text: "x".repeat(501) })).status).toBe(400);
    expect((await call("POST", "/v1/channels/handbook/propose", { text: "看日志" }, reader.accessToken)).status).toBe(403);
    expect(listStandingOrderVersions(db, "channel.handbook")).toHaveLength(1);
  });

  it("reads suggestions with tickets:view, and accepts or dismisses one with tickets:create", async () => {
    const { call, reader } = await start();
    const read = await call("GET", "/v1/channels/handbook/suggestions", undefined, reader.accessToken);
    expect(read).toMatchObject({
      status: 200, body: { suggestions: { suggestions: [], floors: { borrowed_permission: 0, irreversible: null, secrets: 0, rule_change: 0 }, clusteredAt: null } },
    });
    expect((await call("POST", "/v1/channels/handbook/suggestions/dismiss", { key: "loosen:x" }, reader.accessToken)).status).toBe(403);
    expect(await call("POST", "/v1/channels/handbook/suggestions/dismiss", { key: "loosen:x" })).toMatchObject({ status: 200, body: { suggestions: { suggestions: [] } } });
    expect((await call("POST", "/v1/channels/handbook/suggestions/accept", { key: "loosen:x" })).status).toBe(409);
    expect((await call("POST", "/v1/channels/handbook/suggestions/accept", {})).status).toBe(400);
    expect(listStandingOrderVersions(db, "channel.handbook")).toHaveLength(1);
  });
});

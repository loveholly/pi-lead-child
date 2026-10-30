// /v1/channels/policy 的路由（设置 → 消息通道 → 自动代你处理，2026-10-23）。网关、store、操作层是真的。这里核对：
//   - 读：tickets:view，回现在生效的、最新版本里写的、缺省；
//   - 改（PUT）：tickets:create；请求体是改完以后的一整份，坏的回 400；改成写一个作者是你的新版本，记一条 ui_action.performed；
//   - 测一条消息、评估过去 24 小时的消息：tickets:view 就够，不写任何版本，不记账本。一条消息和过去的消息要调模型，
//     交给通道 hub：没接任何来源时回 409；上一次的分数换参数再算不调模型，没接来源也能算。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_POLICY_DEFAULTS, type ChannelPolicyScoredCase } from "@pi-lead-child/protocol";
import { createLoopbackBinding, listEvents, listStandingOrderVersions, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-policy-routes-"), "plc.db"));
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

// 用例集里的 S07：800 人的频道问上线，信心 91%。
const LAUNCH: ChannelPolicyScoredCase = {
  text: "这个服务今晚会下线吗？", draftText: "会，今晚 10 点下线维护，预计 1 小时。", intent: { kind: "progress", closing: null }, found: "yes",
  scores: {
    needsReply: 0.95, askConfidence: 0.9, fulfills: 0.95, grounded: 0.92, draftCommits: 0.2, draftOvershares: 0.05,
    topics: { money: 0.02, personnel: 0.03, legal: 0.02, emotional: 0.04 },
    sensitiveQueries: { query_personal_info: 0.04, query_credentials: 0.03, query_private_messages: 0.05, query_hr_compensation: 0.02, query_customer_pii: 0.03, query_owner_private: 0.03 },
  },
  facts: { audience: "public_channel", members: 800, externalShared: false, senderTrust: "colleague", sources: { total: 1, verified: 1 } },
  scoredBy: "jev",
};

describe("the auto-handling routes", () => {
  it("reads the policy with tickets:view", async () => {
    const { call, reader } = await start();
    const read = await call("GET", "/v1/channels/policy/slack", undefined, reader.accessToken);
    expect(read.status).toBe(200);
    expect(read.body.policy).toMatchObject({ source: "slack", params: CHANNEL_POLICY_DEFAULTS, order: { id: "channel.authority", scope: "*" } });
  });

  it("changes it with tickets:create as you: a new version by you and one ledger entry", async () => {
    const { call, reader } = await start();
    const next = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false, confidence: { ...CHANNEL_POLICY_DEFAULTS.confidence, tiers: [0.6, 0.75, 0.9, 0.9] } };
    expect((await call("PUT", "/v1/channels/policy/slack", next, reader.accessToken)).status).toBe(403);
    expect((await call("PUT", "/v1/channels/policy/slack", { autoReply: false })).status).toBe(400);
    const saved = await call("PUT", "/v1/channels/policy/slack", next);
    expect(saved.status).toBe(200);
    expect(saved.body.policy).toMatchObject({ params: { autoReply: false, confidence: { tiers: [0.6, 0.75, 0.9, 0.9] } }, order: { version: 2, author: "user" } });
    expect(listStandingOrderVersions(db, "channel.authority").map((version) => version.author)).toEqual(["system", "user"]);
    expect(listEvents(db, { kind: "ui_action.performed" })).toMatchObject([{
      source: "user", payload: { target: { type: "channel_policy", id: "slack" }, action: "update", actor: "user" },
    }]);
  });

  it("re-computes a scored message with tickets:view, and needs a connected source to ask the model", async () => {
    const { call, reader } = await start();
    const tested = await call("POST", "/v1/channels/policy/slack/test", {
      params: { ...CHANNEL_POLICY_DEFAULTS, confidence: { ...CHANNEL_POLICY_DEFAULTS.confidence, tiers: [0.6, 0.75, 0.9, 0.9] } },
      case: { kind: "scored", scored: LAUNCH },
    }, reader.accessToken);
    expect(tested.status).toBe(200);
    expect(tested.body.result).toMatchObject({ decision: "auto_send", reply: { ok: true }, threshold: 0.9, calls: [] });
    expect((await call("POST", "/v1/channels/policy/slack/test", { case: { kind: "example", id: "launch" } }, reader.accessToken)).status).toBe(400);
    expect((await call("POST", "/v1/channels/policy/slack/test", { case: { kind: "message", text: "在吗" } }, reader.accessToken)).status).toBe(400);
    const message = { kind: "message", text: "在吗", audience: "dm", sender: "colleague", assumeFound: false };
    expect((await call("POST", "/v1/channels/policy/slack/test", { case: message }, reader.accessToken)).status).toBe(409);
    expect((await call("POST", "/v1/channels/policy/slack/replay", { params: CHANNEL_POLICY_DEFAULTS }, reader.accessToken)).status).toBe(409);
    expect(listStandingOrderVersions(db, "channel.authority")).toHaveLength(1);
    // 只读：不记账本。
    expect(listEvents(db, { kind: "ui_action.performed" })).toEqual([]);
  });
});

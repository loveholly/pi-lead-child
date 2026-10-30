// /v1/channels/reply-style 的路由（设置 → 消息通道 → 代回复风格，2026-10-28）。网关、store、操作层是真的。这里核对：
//   - 读：tickets:view；改：tickets:create，请求体坏的回 400，超过上限回 400 并说超了多少；
//   - 改记一条 ui_action.performed，作者是你；
//   - 提炼：tickets:create，只读，不写风格、不记账本；没有模型时回 409，用便宜模型时结果是预览。
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { REPLY_STYLE_TEXT_MAX_LENGTH, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import type { UiActionServices } from "@pi-lead-child/engine";
import { createLoopbackBinding, getReplyStyle, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-reply-style-routes-"), "plc.db"));
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

function seedOwnMessages(count: number) {
  for (let index = 0; index < count; index += 1) {
    const at = new Date(Date.now() - (index + 1) * 60_000).toISOString();
    const payload = { role: "self_reply", text: `好，我看一下 ${index}`, laneLabel: "@Oliver", summary: "好", sender: { id: "U1", name: "Leo", trust: "internal" }, urgent: false, audience: "direct" };
    db.prepare(
      `INSERT INTO events (event_id, source, source_ref, kind, entity_key, occurred_at, received_at, payload, level)
       VALUES (?, 'slack', ?, 'slack.self.reply', 'slack:D1:main', ?, ?, ?, 'record')`,
    ).run(randomUUID(), `ref-${index}`, at, at, JSON.stringify(payload));
  }
}

describe("the reply-style routes", () => {
  it("reads with tickets:view and saves with tickets:create as you", async () => {
    const { call, reader } = await start();
    const read = await call("GET", "/v1/channels/reply-style", undefined, reader.accessToken);
    expect(read).toMatchObject({ status: 200, body: { replyStyle: { text: "", updatedAt: null, updatedBy: null } } });
    expect((await call("POST", "/v1/channels/reply-style", { mode: "replace", text: "- 短" }, reader.accessToken)).status).toBe(403);
    expect((await call("POST", "/v1/channels/reply-style", { text: "- 短" })).status).toBe(400);
    const saved = await call("POST", "/v1/channels/reply-style", { mode: "replace", text: "- 极其精简" });
    expect(saved).toMatchObject({ status: 200, body: { replyStyle: { text: "- 极其精简", updatedBy: "user" } } });
    expect(ledger()).toEqual([expect.objectContaining({ target: { type: "reply_style", id: "user" }, action: "update", actor: "user" })]);
  });

  it("refuses an append that goes over the limit and keeps what was there", async () => {
    const { call } = await start();
    await call("POST", "/v1/channels/reply-style", { mode: "replace", text: "甲".repeat(REPLY_STYLE_TEXT_MAX_LENGTH) });
    const refused = await call("POST", "/v1/channels/reply-style", { mode: "append", text: "乙" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("超了");
    expect([...getReplyStyle(db).text]).toHaveLength(REPLY_STYLE_TEXT_MAX_LENGTH);
  });

  it("extracts a preview without writing anything, and says when the model is not there", async () => {
    seedOwnMessages(12);
    const missing = await start();
    expect((await missing.call("POST", "/v1/channels/reply-style/extract", { days: 15 })).status).toBe(409);
    const prompts: string[] = [];
    const { call, reader } = await start({ textModel: () => async (prompt) => { prompts.push(prompt); return '{"style": ["确认只说「好」"], "conflicts": []}'; } });
    expect((await call("POST", "/v1/channels/reply-style/extract", { days: 31 })).status).toBe(400);
    expect((await call("POST", "/v1/channels/reply-style/extract", {}, reader.accessToken)).status).toBe(403);
    const extracted = await call("POST", "/v1/channels/reply-style/extract", { days: 15 });
    expect(extracted).toMatchObject({
      status: 200,
      body: { result: { status: "ok", proposal: "- 确认只说「好」", basis: { days: 15, messages: 12, conversations: 1 }, label: "从 Slack 提炼：最近 15 天，12 条" } },
    });
    expect(prompts).toHaveLength(1);
    expect(getReplyStyle(db).text).toBe("");
    expect(ledger()).toEqual([]);
  });
});

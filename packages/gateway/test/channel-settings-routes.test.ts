// /v1/channels/settings 的路由（设置页「消息通道」，slack-settings 工单 S1）。网关、store 是真的；daemon 的通道设置是替身
// （真的那一份和假的 Slack 一起在 apps/daemon/test/channel-settings-daemon.test.ts 里走完每一跳）。这里核对网关的那几道关：
//   - 读：tickets:view；editable 只给本机网页。没有通道服务回 503。
//   - 改（test、PUT、DELETE）：tickets:create，并且只接受本机网页（回环 socket + 允许的回环 Origin），否则 403；
//     只有 tickets:view 的凭证不能改；未知来源 404；没声明的密钥名、坏的请求体 400；
//   - PUT 没过回 400，error.details 是检查结果，什么都不存；「测试」没过回 200 和 ok=false；
//   - 密钥的值不出现在任何响应、日志、事件里。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  ChannelSecretsTestResultSchema, ChannelSettingsResponseSchema, ChannelSourceSettingsResponseSchema, HttpErrorResponseSchema,
  type ChannelSecretsTestResult,
} from "@pi-lead-child/protocol";
import { createCliBinding, createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import type { ChannelSettingsService, ChannelSourceSettingsView } from "../src/channel-settings-routes.js";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

const LOCAL_PAGE = "http://localhost:8081";
const GOOD = "one-good-sentinel-value-41f0";
const BAD = "one-bad-sentinel-value-93c2";
const OTHER = "two-sentinel-value-5d18";

let db: Db;
let logs: string[];
let saved: Record<string, string>;
let calls: string[];
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-settings-routes-"), "plc.db"));
  logs = [];
  saved = {};
  calls = [];
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

const view = (): ChannelSourceSettingsView => ({
  source: "chat", label: "Chat", status: saved.PLC_CHAT_ONE ? "connected" : "not_configured",
  account: saved.PLC_CHAT_ONE ? { userId: "U1", userName: "我", teamId: "T1", teamName: "Home" } : null,
  missingScopes: [], lastError: null, lastConnectedAt: null, manifest: "name: chat\n", setupUrl: "https://chat.example/apps",
  secrets: ["PLC_CHAT_ONE", "PLC_CHAT_TWO"].map((name) => ({
    name, label: name, prefix: "", hint: "", present: Boolean(saved[name]), origin: saved[name] ? "vault" as const : null,
  })),
});

// 检查：PLC_CHAT_ONE 要是 GOOD。没给的用保存过的（替身里只看请求）。
function checked(secrets: Readonly<Record<string, string>>): ChannelSecretsTestResult {
  const pass = (secrets.PLC_CHAT_ONE ?? saved.PLC_CHAT_ONE) === GOOD;
  return {
    ok: pass, account: pass ? { userId: "U1", userName: "我", teamId: "T1", teamName: "Home" } : null,
    missingScopes: pass ? [] : ["chat:write"],
    checks: [{ id: "one", label: "第一个密钥", pass, detail: pass ? "认得" : "这是 bot token，要的是你本人的 user token。缺 chat:write" }],
  };
}

const service: ChannelSettingsService = {
  list: () => [view()],
  test: async (source, secrets) => {
    calls.push(`test ${source} ${Object.keys(secrets).join(",")}`);
    return checked(secrets);
  },
  save: async (source, secrets) => {
    calls.push(`save ${source} ${Object.keys(secrets).join(",")}`);
    const result = checked(secrets);
    if (!result.ok) return { ok: false, result };
    Object.assign(saved, secrets);
    return { ok: true, saved: { source: view(), names: Object.keys(secrets), revision: "rev-1" } };
  },
  remove: async (source) => {
    calls.push(`remove ${source}`);
    const removed = Object.keys(saved);
    saved = {};
    return { source: view(), removed };
  },
  revertSave: async () => ({ status: "unknown", source: null }),
};

async function start(options: { service?: ChannelSettingsService | null; allowLoopbackAutoPair?: boolean } = {}) {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, {
      runtime: () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null }),
      now: () => new Date(),
    }),
    ...(options.service === null ? {} : { channelSettings: options.service ?? service }),
    hello: () => ({}),
    chat: () => "started",
    addClient: () => () => {},
    log: (line) => logs.push(line),
  }, { port: 0, allowLoopbackAutoPair: options.allowLoopbackAutoPair ?? true, loopbackAutoPairOrigins: [LOCAL_PAGE] });
  servers.push(server);
  const owner = createLoopbackBinding(db, { name: "本机网页" });
  const reader = createLoopbackBinding(db, { name: "只读", scopes: ["tickets:view"] });
  const responses: string[] = [];
  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE", path: string,
    init: { body?: unknown; raw?: string; origin?: string | null; token?: string } = {},
  ) => {
    const origin = init.origin === undefined ? LOCAL_PAGE : init.origin;
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${init.token ?? owner.accessToken}`,
        ...(origin ? { origin } : {}),
        ...(init.body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: JSON.parse(text) as any, headers: response.headers };
  };
  return { server, call, owner, reader, responses };
}

const everything = (responses: string[]) => [
  ...responses, ...logs, JSON.stringify(db.prepare("SELECT * FROM events").all()),
  JSON.stringify(db.prepare("SELECT * FROM notifications").all()),
].join("\n");

describe("the channel settings routes", () => {
  it("lists the sources for tickets:view, editable only for the local page", async () => {
    const { call, reader } = await start();
    const local = await call("GET", "/v1/channels/settings");
    expect(local.status).toBe(200);
    expect(Value.Check(ChannelSettingsResponseSchema, local.body)).toBe(true);
    expect(local.body.sources).toEqual([{ ...view(), editable: true }]);
    // 只读的凭证照样能看；没有 Origin（不是网页，例如手机 App 或者 plc）时不能改。
    const phone = await call("GET", "/v1/channels/settings", { origin: null, token: reader.accessToken });
    expect(phone.status).toBe(200);
    expect(phone.body.sources[0].editable).toBe(false);
    expect((await call("GET", "/v1/channels/settings", { origin: "http://192.168.1.20:47130" })).body.sources[0].editable).toBe(false);
  });

  it("lets the local page edit even though a same-origin GET carries no Origin", async () => {
    // 回归（验收时发现）：浏览器同源的 GET 不带 Origin，本机网页上的设置页被画成只读。
    const { call, owner, server } = await start();
    const page = await call("GET", "/v1/channels/settings", { origin: null, token: owner.accessToken });
    expect(page.body.sources[0].editable).toBe(true);
    // 不是本机网页配对来的（plc 的 cli binding）：照样只读。
    const cli = createCliBinding(db, { name: "plc" });
    expect((await call("GET", "/v1/channels/settings", { origin: null, token: cli.accessToken })).body.sources[0].editable).toBe(false);
    // 10-17 以前配对的本机网页：binding 没有记来处。浏览器同源的 GET 带 Sec-Fetch-Site: same-origin，照样可编辑。
    const legacy = createLoopbackBinding(db, { name: "localhost-web" });
    db.prepare("UPDATE bindings SET origin = NULL WHERE id = ?").run(legacy.binding.id);
    expect((await call("GET", "/v1/channels/settings", { origin: null, token: legacy.accessToken })).body.sources[0].editable).toBe(false);
    const sameOrigin = await fetch(`http://127.0.0.1:${server.port}/v1/channels/settings`, {
      headers: { authorization: `Bearer ${legacy.accessToken}`, "sec-fetch-site": "same-origin" },
    });
    expect(((await sameOrigin.json()) as any).sources[0].editable).toBe(true);
    // 改的请求照样要 Origin：没有 Origin 的 PUT 是 403。
    expect((await call("PUT", "/v1/channels/settings/chat", { origin: null, body: { secrets: { PLC_CHAT_ONE: GOOD } } })).status).toBe(403);
  });

  it("refuses a change from anything but the local page, and from a view-only credential", async () => {
    const { call, reader } = await start();
    const body = { secrets: { PLC_CHAT_ONE: GOOD } };
    for (const origin of [null, "http://192.168.1.20:47130", "http://localhost:9999"]) {
      for (const [method, path] of [["PUT", "/v1/channels/settings/chat"], ["POST", "/v1/channels/settings/chat/test"],
        ["DELETE", "/v1/channels/settings/chat"]] as const) {
        const refused = await call(method, path, { origin, ...(method === "DELETE" ? {} : { body }) });
        expect(refused.status, `${method} ${path} from ${origin}`).toBe(403);
        expect(Value.Check(HttpErrorResponseSchema, refused.body)).toBe(true);
        expect(refused.body.error.details).toEqual({ reason: "not_local_page" });
      }
    }
    for (const method of ["PUT", "DELETE"] as const) {
      const scoped = await call(method, "/v1/channels/settings/chat", { token: reader.accessToken, ...(method === "PUT" ? { body } : {}) });
      expect(scoped.status).toBe(403);
      expect(scoped.body.error.message).toContain("tickets:create");
    }
    expect(calls).toEqual([]);
    expect(saved).toEqual({});
  });

  it("refuses every change when loopback pages are not trusted, and says nothing is editable", async () => {
    const { call } = await start({ allowLoopbackAutoPair: false });
    expect((await call("GET", "/v1/channels/settings")).body.sources[0].editable).toBe(false);
    expect((await call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_ONE: GOOD } } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("answers 404 for an unknown source, 400 for an undeclared secret or a bad body, and 503 without the service", async () => {
    const { call } = await start();
    expect((await call("PUT", "/v1/channels/settings/mail", { body: { secrets: { PLC_CHAT_ONE: GOOD } } })).status).toBe(404);
    expect((await call("DELETE", "/v1/channels/settings/%E0%A4%A")).status).toBe(404);
    const undeclared = await call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_ONE: GOOD, PLC_OTHER: OTHER } } });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body.error).toMatchObject({ details: { reason: "unknown_secret" }, message: expect.stringContaining("PLC_OTHER") });
    for (const body of [{}, { secrets: { PLC_CHAT_ONE: "" } }, { secrets: { PLC_CHAT_ONE: 7 } }, { secrets: {}, extra: true }]) {
      expect((await call("POST", "/v1/channels/settings/chat/test", { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("PUT", "/v1/channels/settings/chat", { raw: "{not json" })).status).toBe(400);
    // 别的方法不是这条路由。
    expect((await call("POST", "/v1/channels/settings/chat", { body: { secrets: {} } })).status).toBe(404);
    expect(calls).toEqual([]);

    const bare = await start({ service: null });
    expect((await bare.call("GET", "/v1/channels/settings")).status).toBe(503);
    expect((await bare.call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_ONE: GOOD } } })).status).toBe(503);
  });

  it("tests without saving, refuses a PUT whose checks fail, saves one that passes, and deletes", async () => {
    const { call, responses } = await start();
    // 测试没过：200，ok=false，带原因。
    const tested = await call("POST", "/v1/channels/settings/chat/test", { body: { secrets: { PLC_CHAT_ONE: BAD } } });
    expect(tested.status).toBe(200);
    expect(Value.Check(ChannelSecretsTestResultSchema, tested.body)).toBe(true);
    expect(tested.body).toMatchObject({ ok: false, missingScopes: ["chat:write"] });
    expect(saved).toEqual({});

    // PUT 没过：400，details 就是检查结果（bot token 的原因、缺的权限），什么都不存，不记主人操作。
    const refused = await call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_ONE: BAD, PLC_CHAT_TWO: OTHER } } });
    expect(refused.status).toBe(400);
    expect(Value.Check(HttpErrorResponseSchema, refused.body)).toBe(true);
    expect(Value.Check(ChannelSecretsTestResultSchema, refused.body.error.details)).toBe(true);
    expect(refused.body.error.details).toMatchObject({
      ok: false, missingScopes: ["chat:write"], checks: [{ pass: false, detail: expect.stringContaining("这是 bot token") }],
    });
    expect(saved).toEqual({});
    expect(listEvents(db, { kind: "owner_action.performed" })).toEqual([]);

    // PUT 过了：200，新的 DTO（本机网页能改），记一次主人操作（只有名字）。
    const ok = await call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_ONE: GOOD } } });
    expect(ok.status).toBe(200);
    expect(Value.Check(ChannelSourceSettingsResponseSchema, ok.body)).toBe(true);
    expect(ok.body.source).toMatchObject({ status: "connected", editable: true, secrets: [{ present: true, origin: "vault" }, { present: false }] });
    expect(saved).toEqual({ PLC_CHAT_ONE: GOOD });
    expect(listEvents(db, { kind: "owner_action.performed" }).map((event) => event.payload.detail)).toEqual([
      { op: "save", source: "chat", names: ["PLC_CHAT_ONE"] },
    ]);

    // 只换另一个（第一个用保存过的补上）。
    expect((await call("PUT", "/v1/channels/settings/chat", { body: { secrets: { PLC_CHAT_TWO: OTHER } } })).status).toBe(200);
    expect(saved).toEqual({ PLC_CHAT_ONE: GOOD, PLC_CHAT_TWO: OTHER });

    const removed = await call("DELETE", "/v1/channels/settings/chat");
    expect(removed.status).toBe(200);
    expect(Value.Check(ChannelSourceSettingsResponseSchema, removed.body)).toBe(true);
    expect(removed.body.source.status).toBe("not_configured");
    expect(listEvents(db, { kind: "owner_action.performed" }).map((event) => event.payload.detail)).toEqual([
      { op: "save", source: "chat", names: ["PLC_CHAT_ONE"] },
      { op: "save", source: "chat", names: ["PLC_CHAT_TWO"] },
      { op: "delete", source: "chat", names: ["PLC_CHAT_ONE", "PLC_CHAT_TWO"] },
    ]);
    expect(calls).toEqual([
      "test chat PLC_CHAT_ONE", "save chat PLC_CHAT_ONE,PLC_CHAT_TWO", "save chat PLC_CHAT_ONE", "save chat PLC_CHAT_TWO", "remove chat",
    ]);
    for (const value of [GOOD, BAD, OTHER]) expect(everything(responses)).not.toContain(value);
  });

  it("lets the dev web page send PUT and DELETE across origins", async () => {
    const { server } = await start();
    const preflight = await fetch(`http://127.0.0.1:${server.port}/v1/channels/settings/chat`, {
      method: "OPTIONS", headers: { origin: LOCAL_PAGE, "access-control-request-method": "PUT" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});

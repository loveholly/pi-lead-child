// 连接走完用户真正经过的每一跳：companion 调 /v1/connections，浏览器回到网关的 /oauth/callback，
// 账本落下密文，网关推 snapshot.required 让界面重取。厂商是假的（@pi-lead-child/connections/testing），
// 授权页那一步由 vendor.approve 代替用户点「允许」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { openDb, createLoopbackBinding, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeVendor } from "@pi-lead-child/connections/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-connections-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  delete process.env.PLC_SLACK_CLIENT_SECRET;
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

async function boot(vendor: FakeVendor) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: sessionFactory() as any, gatewayPort: 0, log: () => {},
    connections: { fetch: vendor.fetch, tickMs: 3_600_000 },
  });
  const { accessToken } = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { base, call };
}

describe("connecting through the daemon", () => {
  it("lists the catalog, runs the browser flow through /oauth/callback, and tells clients to refetch", async () => {
    const vendor = new FakeVendor(() => Date.now());
    const { base, call } = await boot(vendor);

    const listed = await call("GET", "/v1/connections");
    expect(listed.status).toBe(200);
    const states = Object.fromEntries(listed.body.items.map((item: any) => [item.key, item.state]));
    expect(states).toMatchObject({ atlassian: "not_connected", notion: "not_connected", slack: "needs_setup", google: "unavailable" });
    expect(listed.body.attention).toBe(0);
    expect((await call("GET", "/v1/connections", undefined, null)).status).toBe(401);

    const started = await call("POST", "/v1/connections/custom", { serverUrl: vendor.mcpUrl });
    expect(started.status).toBe(200);
    expect(started.body.flow).toBe("browser");
    expect(new URL(started.body.authorizeUrl).searchParams.get("redirect_uri")).toBe(`${base}/oauth/callback`);

    // 浏览器那一步：用户点「允许」，授权服务器把浏览器送回网关。
    const callback = vendor.approve(started.body.authorizeUrl);
    const page = await fetch(`${base}/oauth/callback?${new URLSearchParams(callback)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("已连接");

    const after = await call("GET", "/v1/connections");
    const custom = after.body.items.find((item: any) => item.provider === "custom");
    expect(custom).toMatchObject({ state: "connected", account: "you@acme.test", tools: { total: 3, readOnly: 2, write: 1 } });
    expect((await call("GET", `/v1/connections/flows/${started.body.flowId}`)).body).toMatchObject({ state: "connected" });

    const events = db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all() as { payload: string }[];
    expect(events.some((event) => JSON.parse(event.payload).resource === "connections")).toBe(true);

    // 同一个回调再来一次：state 已经用过了。
    const replay = await fetch(`${base}/oauth/callback?${new URLSearchParams(callback)}`);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("授权没有完成");

    const tools = await call("GET", `/v1/connections/${custom.key}/tools`);
    expect(tools.body.items.map((tool: any) => tool.name)).toEqual(["search_pages", "update_page", "get_self"]);

    const settings = await call("POST", `/v1/connections/${custom.key}/settings`, { writePolicy: "direct" });
    expect(settings.body.connection.writePolicy).toBe("direct");
    const disconnected = await call("POST", `/v1/connections/${custom.key}/disconnect`, {});
    expect(disconnected.body.connection.state).toBe("not_connected");
  }, 20_000);

  it("answers with the reason when a provider needs setup first", async () => {
    const { call } = await boot(new FakeVendor(() => Date.now()));
    const slack = await call("POST", "/v1/connections/slack/start", {});
    expect(slack.status).toBe(409);
    expect(slack.body.error).toMatchObject({ code: "conflict", details: { reason: "needs_setup" } });
    const bad = await call("POST", "/v1/connections/custom", { serverUrl: "http://plain.example.test/mcp" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("invalid_request");
    expect((await call("GET", "/v1/connections/confirmations/not-an-id")).status).toBe(400);
    const unknown = await call("POST", "/v1/connections/confirmations/cfm_0000000000000000/resolve", { approve: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details.reason).toBe("not_found");
  });

  it("takes daemon-only secrets out of its own environment", async () => {
    process.env.PLC_SLACK_CLIENT_SECRET = "s3cret-for-the-daemon-only";
    await boot(new FakeVendor(() => Date.now()));
    expect(process.env.PLC_SLACK_CLIENT_SECRET).toBeUndefined();
  });
});

// 2026-10-19 审查：一个 child 用 sqlite3 把 GitHub 的写入策略改成了 direct，没有任何记录，用户也不知道。
// 现在：经设置页改是一次主人操作（推送，带「不是我」）；绕过设置页直接改库会被发现、恢复，并直接推给用户。
describe("connection settings are audited", () => {
  async function connected(vendor: FakeVendor, call: Awaited<ReturnType<typeof boot>>["call"], base: string) {
    const started = await call("POST", "/v1/connections/custom", { serverUrl: vendor.mcpUrl });
    const callback = vendor.approve(started.body.authorizeUrl);
    expect((await fetch(`${base}/oauth/callback?${new URLSearchParams(callback)}`)).status).toBe(200);
    const listed = await call("GET", "/v1/connections");
    return listed.body.items.find((item: any) => item.provider === "custom") as { key: string };
  }

  it("records a settings change as an owner action, and restores and pushes a change made outside the settings page", async () => {
    const vendor = new FakeVendor(() => Date.now());
    const { base, call } = await boot(vendor);
    const custom = await connected(vendor, call, base);
    const id = Number(custom.key.slice("custom-".length));

    expect((await call("POST", `/v1/connections/${custom.key}/settings`, { writePolicy: "direct" })).status).toBe(200);
    const performed = db.prepare("SELECT payload, level FROM events WHERE kind = 'owner_action.performed'").all() as Array<{ payload: string; level: string }>;
    expect(performed.map((row) => JSON.parse(row.payload).action)).toEqual(["connection.settings"]);
    expect(performed[0]!.level).toBe("interrupt");
    expect((await call("POST", `/v1/connections/${custom.key}/settings`, { writePolicy: "confirm" })).status).toBe(200);

    // 绕过设置页：这个测试的连接带着写入函数，代表一个已经绕过写入守卫的进程。
    db.prepare("UPDATE connections SET write_policy = 'direct' WHERE id = ?").run(id);
    const listed = await call("GET", "/v1/connections");
    expect(listed.body.items.find((item: any) => item.key === custom.key)).toMatchObject({ writePolicy: "confirm" });
    expect((db.prepare("SELECT write_policy FROM connections WHERE id = ?").get(id) as { write_policy: string }).write_policy).toBe("confirm");

    const tampered = db.prepare("SELECT seq, level, correlation_id, root_cause FROM events WHERE kind = 'connection.settings_tampered'").all() as
      Array<{ seq: number; level: string; correlation_id: string; root_cause: string }>;
    expect(tampered).toHaveLength(1);
    expect(tampered[0]).toMatchObject({ level: "interrupt" });
    expect(JSON.parse(tampered[0]!.root_cause)).toMatchObject({ code: "connection_settings_tampered" });
    const notificationId = Number(tampered[0]!.correlation_id.replace("notification:", ""));

    // daemon 直接推：通知记成已送达，事件记成告诉了用户，会话里有一张安全报警卡。
    await vi.waitFor(() => {
      const row = db.prepare("SELECT state FROM notifications WHERE id = ?").get(notificationId) as { state: string };
      expect(row.state).toBe("delivered");
    }, { timeout: 15_000, interval: 100 });
    expect((db.prepare("SELECT disposition FROM events WHERE seq = ?").get(tampered[0]!.seq) as { disposition: string }).disposition).toBe("told_user");
    expect(db.prepare("SELECT 1 FROM channel_turns WHERE origin_kind = 'system:security-alert'").get()).toBeTruthy();

    // 再列一次：已经恢复，不再报警。
    await call("GET", "/v1/connections");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'connection.settings_tampered'").get()).toEqual({ n: 1 });
  }, 30_000);
});

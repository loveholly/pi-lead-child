// ConnectionHub 的完整流程：一键连接、调用、到期续期、重开账本后续期、暂时失败、撤销后重新授权。
// 假厂商在 fake-vendor.ts，照着调研到的规则做（刷新令牌轮换，复用旧的会吊销整个授权）。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getConnection, getConnectionByServer, listConnectionEvents, openDb, type Db } from "@pi-lead-child/store";
import { ConnectionError, ConnectionHub, KEEP_ALIVE_MS, type ConnectionAttention, type ConnectionHubOptions } from "../src/hub.js";
import { Vault } from "../src/vault.js";
import { FakeVendor, combinedFetch, owns } from "../testing/fake-vendor.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const REDIRECT = "http://127.0.0.1:47130/oauth/callback";

let clock: number;
let dbPath: string;
let db: Db;
let key: Buffer;
let vendor: FakeVendor;
let attention: ConnectionAttention[];
let changes: string[];

beforeEach(() => {
  clock = Date.parse("2026-10-16T08:00:00.000Z");
  dbPath = join(tempDir("plc-hub-"), "plc.db");
  db = openDb(dbPath);
  key = randomBytes(32);
  vendor = new FakeVendor(() => clock);
  attention = [];
  changes = [];
});

function hub(overrides: Partial<ConnectionHubOptions> = {}): ConnectionHub {
  return new ConnectionHub({
    db, vault: new Vault(key), config: { clients: {} }, redirectUri: () => REDIRECT,
    fetch: vendor.fetch, now: () => clock, gh: { token: async () => null }, ghInstalled: () => false,
    onAttention: (event) => attention.push(event), onChange: (k) => changes.push(k),
    ...overrides,
  });
}

async function connectCustom(h: ConnectionHub): Promise<string> {
  const started = await h.addCustom(vendor.mcpUrl);
  expect(started.flow).toBe("browser");
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  const callback = vendor.approve(started.authorizeUrl);
  await h.completeCallback({ ...callback, error: null, errorDescription: null });
  const row = getConnectionByServer(db, vendor.mcpUrl)!;
  return `custom-${row.id}`;
}

describe("connecting with one click", () => {
  it("registers a client, finishes the browser step, and stores only ciphertext", async () => {
    const h = hub();
    const k = await connectCustom(h);
    const row = getConnection(db, Number(k.slice(7)))!;
    expect(row).toMatchObject({ status: "connected", token_source: "oauth", issuer: vendor.issuer, account_label: "you@acme.test" });
    expect(vendor.registrations).toBe(1);
    // 账本里没有明文令牌。
    const [access] = [...vendor.access.keys()];
    expect(row.secret_cipher!.includes(Buffer.from(access!))).toBe(false);
    expect(h.get(k)).toMatchObject({ state: "connected", tools: { total: 3, readOnly: 2, write: 1 }, problem: null });
    expect(changes).toContain(k);
  });

  it("reuses the registered client for the same issuer and redirect URI", async () => {
    const h = hub();
    const k = await connectCustom(h);
    await h.disconnect(k);
    await connectCustom(h);
    expect(vendor.registrations).toBe(1);
  });

  it("accepts each state once, rejects an expired one, and rejects a response from another issuer", async () => {
    const h = hub();
    const started = await h.addCustom(vendor.mcpUrl);
    if (started.flow !== "browser") throw new Error("expected a browser flow");
    const callback = vendor.approve(started.authorizeUrl);
    await expect(h.completeCallback({ ...callback, iss: "https://evil.test", error: null, errorDescription: null }))
      .rejects.toMatchObject({ code: "authorization_failed" });
    // 同一个 state 第二次用：已经失效。
    await expect(h.completeCallback({ ...callback, error: null, errorDescription: null })).rejects.toMatchObject({ code: "flow_not_found" });

    const late = await h.addCustom(vendor.mcpUrl);
    if (late.flow !== "browser") throw new Error("expected a browser flow");
    const lateCallback = vendor.approve(late.authorizeUrl);
    clock += 11 * MINUTE;
    await expect(h.completeCallback({ ...lateCallback, error: null, errorDescription: null })).rejects.toMatchObject({ code: "flow_not_found" });
    expect(h.flowStatus(late.flowId).state).toBe("expired");
  });

  it("reports a denied consent on the flow", async () => {
    const h = hub();
    const started = await h.addCustom(vendor.mcpUrl);
    if (started.flow !== "browser") throw new Error("expected a browser flow");
    const { state } = vendor.approve(started.authorizeUrl);
    await expect(h.completeCallback({ state, code: null, iss: null, error: "access_denied", errorDescription: null })).rejects.toBeInstanceOf(ConnectionError);
    expect(h.flowStatus(started.flowId)).toMatchObject({ state: "failed", message: "你在授权页上拒绝了授权" });
  });

  it("asks for a pre-registered client when the provider requires one", async () => {
    const h = hub();
    expect(h.get("slack")).toMatchObject({ state: "needs_setup" });
    await expect(h.start("slack")).rejects.toMatchObject({ code: "needs_setup" });
  });

  it("lists Google as coming soon", () => {
    expect(hub().get("google")).toMatchObject({ state: "unavailable", setupHint: expect.stringContaining("预览") });
  });
});

describe("refreshing without dropping the connection", () => {
  it("refreshes once for ten concurrent calls near expiry, and stores the rotated refresh token", async () => {
    const h = hub();
    const k = await connectCustom(h);
    clock += 58 * MINUTE; // 只剩 2 分钟，进入续期窗口
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      h.callTool(k, "search_pages", { query: `q${i}` }, { role: "lead" })));
    expect(results.every((result) => result.text.startsWith("called search_pages"))).toBe(true);
    expect(vendor.refreshCount).toBe(1);
    expect(getConnection(db, Number(k.slice(7)))!.secret_version).toBe(2);
  });

  it("keeps working after the database is reopened, using the persisted refresh token", async () => {
    const first = hub();
    const k = await connectCustom(first);
    await first.close();
    db.close();
    db = openDb(dbPath);
    clock += 59 * MINUTE;
    const second = hub();
    await expect(second.callTool(k, "search_pages", {}, { role: "lead" })).resolves.toMatchObject({ isError: false });
    expect(vendor.refreshCount).toBe(1);
  });

  it("refreshes and retries once when the server rejects a token that has not expired yet", async () => {
    const h = hub();
    const k = await connectCustom(h);
    vendor.expireAccessTokens();
    await expect(h.callTool(k, "search_pages", {}, { role: "lead" })).resolves.toMatchObject({ isError: false });
    expect(vendor.refreshCount).toBe(1);
    expect(h.get(k).state).toBe("connected");
  });

  it("treats network and server errors as temporary: degraded, old token still used, retried with backoff", async () => {
    const h = hub();
    const k = await connectCustom(h);
    clock += 56 * MINUTE;
    vendor.failNextRefresh.push("network");
    await h.tick();
    const row = getConnection(db, Number(k.slice(7)))!;
    expect(row).toMatchObject({ status: "degraded", failure_kind: "transient", failure_count: 1 });
    expect(Date.parse(row.next_attempt_at!) - clock).toBe(15_000);
    // 访问令牌还没过期，照常能用，不算失效。
    vendor.failNextRefresh.push("server");
    await expect(h.callTool(k, "search_pages", {}, { role: "lead" })).resolves.toMatchObject({ isError: false });
    expect(attention).toEqual([]);
    expect(h.get(k)).toMatchObject({ state: "degraded", problem: { kind: "transient" } });
    clock += 31_000;
    await h.tick();
    expect(h.get(k)).toMatchObject({ state: "connected", problem: null });
    expect(attention).toEqual([]);
  });

  it("asks for re-authorization once when the grant is revoked, and keeps the settings on re-auth", async () => {
    const h = hub();
    const k = await connectCustom(h);
    h.updateSettings(k, { roles: ["lead"], writePolicy: "direct" });
    vendor.revokeAll();
    clock += 59 * MINUTE;
    await h.tick();
    await h.tick();
    expect(h.get(k)).toMatchObject({ state: "needs_reauth", problem: { kind: "invalid_grant" } });
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ kind: "needs_reauth", key: k });
    await expect(h.callTool(k, "search_pages", {}, { role: "lead" })).rejects.toMatchObject({ code: "needs_reauth" });

    const again = await connectCustom(h);
    expect(again).toBe(k);
    expect(h.get(k)).toMatchObject({ state: "connected", roles: ["lead"], writePolicy: "direct" });
  });

  it("does not count invalid_grant as a failure when another path rotated the token meanwhile", async () => {
    const h = hub();
    const k = await connectCustom(h);
    const id = Number(k.slice(7));
    clock += 59 * MINUTE;
    vendor.onRefresh = () => {
      vendor.onRefresh = null;
      // 另一条路径刚写了新版本的密文。
      db.prepare("UPDATE connections SET secret_cipher = secret_cipher WHERE id = ?").run(id);
      const row = getConnection(db, id)!;
      const plain = new Vault(key).open<{ accessToken: string; refreshToken: string }>(row.secret_cipher!, `connection:${id}:v${row.secret_version}`);
      db.prepare("UPDATE connections SET secret_cipher = ?, secret_version = secret_version + 1 WHERE id = ?")
        .run(new Vault(key).seal(plain, `connection:${id}:v${row.secret_version + 1}`), id);
    };
    vendor.failNextRefresh.push("invalid_grant");
    await h.tick();
    expect(h.get(k).state).toBe("connected");
    expect(attention).toEqual([]);
  });

  it("refreshes an idle connection every seven days so idle expiry never hits", async () => {
    const h = hub();
    const k = await connectCustom(h);
    vendor.accessTtlSec = 30 * 24 * 3600;
    // 换一个长效的访问令牌，免得「快到期」先触发。
    clock += 59 * MINUTE;
    await h.tick();
    const before = vendor.refreshCount;
    clock += KEEP_ALIVE_MS - MINUTE;
    await h.tick();
    expect(vendor.refreshCount).toBe(before);
    clock += 2 * MINUTE;
    await h.tick();
    expect(vendor.refreshCount).toBe(before + 1);
    expect(listConnectionEvents(db, Number(k.slice(7)))[0]).toMatchObject({ kind: "refreshed", detail: "keep_alive" });
  });
});

describe("a grant with a fixed lifetime", () => {
  it("warns seven days and one day before Notion's 180-day limit, once each", async () => {
    vendor = new FakeVendor(() => clock, { mcpUrl: "https://mcp.notion.com/mcp", issuer: "https://mcp.notion.com" });
    const h = hub();
    const started = await h.start("notion");
    if (started.flow !== "browser") throw new Error("expected a browser flow");
    await h.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
    expect(h.get("notion").grantExpiresAt).toBe(new Date(clock + 180 * DAY).toISOString());
    vendor.accessTtlSec = 400 * 24 * 3600;
    clock += 174 * DAY;
    await h.tick();
    await h.tick();
    expect(attention.map((event) => event.kind)).toEqual(["expiring"]);
    expect(h.get("notion").problem).toMatchObject({ kind: "expiring", message: expect.stringContaining("6 天后到期") });
    expect(h.attentionCount()).toBe(1);
    clock += 5.5 * DAY;
    await h.tick();
    expect(attention.map((event) => event.kind)).toEqual(["expiring", "expiring"]);
  });
});

describe("who may use which tool", () => {
  it("gives the reviewer read-only tools, and the executor write tools only under the direct policy", async () => {
    const h = hub();
    const k = await connectCustom(h);
    const names = async (role: "lead" | "executor" | "reviewer") => (await h.searchTools(role, { connection: k })).map((tool) => tool.name).sort();
    expect(await names("reviewer")).toEqual(["get_self", "search_pages"]);
    expect(await names("executor")).toEqual(["get_self", "search_pages"]);
    expect(await names("lead")).toEqual(["get_self", "search_pages", "update_page"]);
    await expect(h.callTool(k, "update_page", { id: "1" }, { role: "reviewer" })).rejects.toMatchObject({ code: "forbidden" });
    h.updateSettings(k, { writePolicy: "direct" });
    expect(await names("executor")).toEqual(["get_self", "search_pages", "update_page"]);
    expect(await names("reviewer")).toEqual(["get_self", "search_pages"]);
  });

  it("asks Lead for the user's confirmation before a write under the confirm policy", async () => {
    const h = hub();
    const k = await connectCustom(h);
    expect(h.needsConfirmation(k, "update_page")).toBe(true);
    await expect(h.callTool(k, "update_page", { id: "1" }, { role: "lead" })).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(h.callTool(k, "update_page", { id: "1" }, { role: "lead", confirmed: true })).resolves.toMatchObject({ isError: false });
  });

  it("refuses a role the settings turned off, and an unknown tool", async () => {
    const h = hub();
    const k = await connectCustom(h);
    h.updateSettings(k, { roles: ["lead"] });
    await expect(h.searchTools("executor", { connection: k })).rejects.toMatchObject({ code: "forbidden" });
    expect(h.available("executor")).toEqual([]);
    await expect(h.callTool(k, "drop_database", {}, { role: "lead" })).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("says the account is not connected when Lead calls a provider without a connection", async () => {
    await expect(hub().callTool("notion", "search", {}, { role: "lead" })).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("disconnecting", () => {
  it("revokes at the vendor, deletes the ciphertext, and keeps the row for a later reconnect", async () => {
    const h = hub();
    const k = await connectCustom(h);
    await h.disconnect(k);
    const row = getConnection(db, Number(k.slice(7)))!;
    expect(row).toMatchObject({ status: "disconnected", secret_cipher: null, tools_json: null });
    expect(vendor.revoked).toHaveLength(2);
    expect(h.list().some((item) => item.key === k)).toBe(false);
  });
});

describe("GitHub", () => {
  it("reuses the gh login and stores no token", async () => {
    const github = new FakeVendor(() => clock, { mcpUrl: "https://api.githubcopilot.com/mcp/", issuer: "https://github.com/login/oauth" });
    const ghToken = "gho_" + "a".repeat(36);
    // gh 的令牌直接当 Bearer 用：在假厂商里登记一个不过期的访问令牌。
    github.access.set(ghToken, { expiresAt: Number.MAX_SAFE_INTEGER, grant: { id: "gh", clientId: "gh", revoked: false } });
    const apiGithub = {
      owns: (url: URL) => url.host === "api.github.com",
      fetch: async () => new Response(JSON.stringify({ login: "octo-dev" }), { status: 200, headers: { "content-type": "application/json" } }),
    };
    const h = hub({ fetch: combinedFetch({ owns: owns(github), fetch: github.fetch }, apiGithub), gh: { token: async () => ghToken }, ghInstalled: () => true });
    expect(h.get("github")).toMatchObject({ state: "not_connected", setupHint: "会使用这台 Mac 上 gh 的登录" });
    const started = await h.start("github");
    expect(started).toMatchObject({ flow: "connected", connection: { state: "connected", account: "@octo-dev", tokenSource: "gh_cli" } });
    expect(getConnectionByServer(db, "https://api.githubcopilot.com/mcp/")!.secret_cipher).toBeNull();
    await expect(h.callTool("github", "search_pages", {}, { role: "lead" })).resolves.toMatchObject({ isError: false });
  });

  it("asks for gh or a token when neither gh nor a device-flow client is set up", async () => {
    const h = hub();
    expect(h.get("github")).toMatchObject({ state: "needs_setup" });
    await expect(h.start("github")).rejects.toMatchObject({ code: "needs_setup" });
  });
});

describe("an address that is not an MCP server", () => {
  it("is not treated as a server that needs no authorization", async () => {
    await expect(hub().addCustom("https://example.test/not-mcp")).rejects.toMatchObject({ code: "authorization_failed" });
    expect(getConnectionByServer(db, "https://example.test/not-mcp")).toBeNull();
  });
});

describe("a write that needs the user's confirmation", () => {
  it("runs the stored call unchanged after approval, once, and reports the result", async () => {
    const outcomes: Array<{ state: string; resultText: string | null }> = [];
    const h = hub({ onConfirmation: ({ confirmation, resultText }) => outcomes.push({ state: confirmation.state, resultText }) });
    const k = await connectCustom(h);
    const pending = h.requestWrite(k, "update_page", { id: "42" }, "把第 42 页的标题改成「周报」");
    expect(pending).toMatchObject({ state: "pending", tool: "update_page", argumentsPreview: '{"id":"42"}' });
    const done = await h.resolveConfirmation(pending.id, true, "user via test-web");
    expect(done).toMatchObject({ state: "done", resolvedBy: "user via test-web" });
    expect(outcomes).toEqual([{ state: "done", resultText: 'called update_page with {"id":"42"}' }]);
    // 再按一次不会再执行。
    await h.resolveConfirmation(pending.id, true, "user via test-web");
    expect(vendor.calls.filter((call) => call.tool === "update_page")).toHaveLength(1);
  });

  it("does nothing on rejection, and expires after 30 minutes", async () => {
    const outcomes: string[] = [];
    const h = hub({ onConfirmation: ({ confirmation }) => outcomes.push(`${confirmation.id}:${confirmation.state}`) });
    const k = await connectCustom(h);
    const rejected = h.requestWrite(k, "update_page", { id: "1" }, "改标题");
    expect(await h.resolveConfirmation(rejected.id, false, "user")).toMatchObject({ state: "rejected" });
    const late = h.requestWrite(k, "update_page", { id: "2" }, "改标题");
    clock += 31 * MINUTE;
    // 过期也报告给 daemon（2026-10-19），只报告一次：daemon 记 user_request.expired，在等它的 Lead 被叫醒。
    await h.tick();
    expect(outcomes).toEqual([`${rejected.id}:rejected`, `${late.id}:expired`]);
    expect(await h.resolveConfirmation(late.id, true, "user")).toMatchObject({ state: "expired" });
    expect(outcomes).toHaveLength(2);
    expect(vendor.calls.some((call) => call.tool === "update_page")).toBe(false);
  });

  it("is not needed for a read-only tool or under the direct policy", async () => {
    const h = hub();
    const k = await connectCustom(h);
    expect(() => h.requestWrite(k, "search_pages", {}, "x")).toThrow(ConnectionError);
    h.updateSettings(k, { writePolicy: "direct" });
    expect(h.needsConfirmation(k, "update_page")).toBe(false);
  });
});

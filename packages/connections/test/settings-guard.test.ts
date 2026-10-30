// 连接的权限设置的核对（2026-10-19 审查）。
// 事故：一个 child 用 sqlite3 执行了 UPDATE connections SET write_policy = 'direct'，之后 child 不经确认就能写 GitHub，
// 也没有任何记录。现在 hub 用保险库给设置加封印（绑定连接 id 和版本，版本记在加密的清单里）：绕过设置页的改动在下一次
// 用到连接时、启动时、每一拍都会被发现，恢复成更严的值，并报警一次。改动记录（connection_events）不采信。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addConnectionEvent, getConnection, getConnectionByServer, getConnectionSettingsManifest, getConnectionSettingsSeal,
  insertConnection, listConnectionEvents, openDb, saveConnectionSettingsSeal, type Db,
} from "@pi-lead-child/store";
import { ConnectionHub, type ConnectionHubOptions, type ConnectionSettingsAlert } from "../src/hub.js";
import { Vault, type SecretVault } from "../src/vault.js";
import { combinedFetch, FakeVendor, owns } from "../testing/fake-vendor.js";

const REDIRECT = "http://127.0.0.1:47130/oauth/callback";
const ALL = ["lead", "executor", "reviewer"];

let clock: number;
let db: Db;
let key: Buffer;
let vendor: FakeVendor;
let alerts: ConnectionSettingsAlert[];

beforeEach(() => {
  clock = Date.parse("2026-10-19T08:00:00.000Z");
  db = openDb(join(tempDir("plc-settings-guard-"), "plc.db"));
  key = randomBytes(32);
  vendor = new FakeVendor(() => clock);
  alerts = [];
});

function hub(overrides: Partial<ConnectionHubOptions> = {}): ConnectionHub {
  return new ConnectionHub({
    db, vault: new Vault(key), config: { clients: {} }, redirectUri: () => REDIRECT,
    fetch: vendor.fetch, now: () => clock, gh: { token: async () => null }, ghInstalled: () => false,
    onSettingsAlert: (alert) => alerts.push(alert),
    ...overrides,
  });
}

async function connectCustom(h: ConnectionHub, through: FakeVendor = vendor): Promise<{ key: string; id: number }> {
  const started = await h.addCustom(through.mcpUrl);
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  const callback = through.approve(started.authorizeUrl);
  await h.completeCallback({ ...callback, error: null, errorDescription: null });
  const row = getConnectionByServer(db, through.mcpUrl)!;
  return { key: `custom-${row.id}`, id: row.id };
}

// 绕过设置页直接改库。openDb 的连接带着写入函数，代表一个已经绕过写入守卫的进程（守卫本身见 store 的 ledger-guard 测试）。
function tamper(id: number, column: "write_policy" | "roles", value: string): void {
  db.prepare(`UPDATE connections SET ${column} = ? WHERE id = ?`).run(value, id);
}

function deleteKv(key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

const executorTools = async (h: ConnectionHub, k: string) =>
  (await h.searchTools("executor", { connection: k })).map((tool) => tool.name).sort();

const brokenVault: SecretVault = { seal: () => { throw new Error("keychain locked"); }, open: () => { throw new Error("keychain locked"); } };

describe("a write policy changed outside the settings page", () => {
  it("does not let the executor write: the next use restores confirm and raises one alert", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages"]);

    // 10-19 的那条命令。
    tamper(id, "write_policy", "direct");

    // 改动之后的第一次使用：child 仍然看不到写入工具，也调不了它。
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages"]);
    await expect(h.callTool(k, "update_page", { id: "1" }, { role: "executor" })).rejects.toMatchObject({ code: "forbidden" });
    expect(h.needsConfirmation(k, "update_page")).toBe(true);
    expect(getConnection(db, id)!.write_policy).toBe("confirm");
    expect(alerts).toEqual([{
      connectionId: id, key: k, label: expect.any(String), seal: "valid",
      expected: { roles: ALL, writePolicy: "confirm" },
      found: { roles: ALL, writePolicy: "direct" },
      restored: { roles: ALL, writePolicy: "confirm" },
    }]);
    expect(listConnectionEvents(db, id)[0]).toMatchObject({ kind: "settings_restored" });

    // 恢复以后再核对：没有新的报警。
    h.auditSettings();
    await h.tick();
    expect(h.get(k)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts).toHaveLength(1);
  });

  it("is found by the periodic audit even when nobody uses the connection", async () => {
    const h = hub();
    const { id } = await connectCustom(h);
    tamper(id, "write_policy", "direct");
    tamper(id, "roles", JSON.stringify(["lead", "executor"]));
    await h.tick();
    expect(alerts).toHaveLength(1);
    expect(getConnection(db, id)).toMatchObject({ write_policy: "confirm", roles: JSON.stringify(["lead", "executor"]) });
  });

  it("keeps a role taken away outside the settings page taken away, and restores an added one", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { roles: ["lead"] });
    tamper(id, "roles", JSON.stringify(["lead", "executor"]));
    await expect(h.searchTools("executor", { connection: k })).rejects.toMatchObject({ code: "forbidden" });
    expect(alerts.at(-1)).toMatchObject({ restored: { roles: ["lead"] } });
  });
});

describe("forging the seal or the change history", () => {
  it("does not believe a forged settings_changed row after the seal was deleted (review finding 2)", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    deleteKv(`connection.settings_seal:${id}`);
    addConnectionEvent(db, id, "settings_changed", JSON.stringify({ writePolicy: "direct" }));
    tamper(id, "write_policy", "direct");
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages"]);
    expect(alerts).toEqual([expect.objectContaining({ seal: "missing", restored: { roles: ALL, writePolicy: "confirm" } })]);
  });

  it("alerts when a sealed row loses its seal, even if nothing looser is left", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { writePolicy: "direct" });
    deleteKv(`connection.settings_seal:${id}`);
    expect(h.get(k)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts).toEqual([expect.objectContaining({ seal: "missing", found: { roles: ALL, writePolicy: "direct" } })]);
  });

  it("rejects an older seal copied back over the current one", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { writePolicy: "direct" });
    const directSeal = getConnectionSettingsSeal(db, id)!;
    h.updateSettings(k, { writePolicy: "confirm" });
    // 存下的 direct 时的封印放回去，再把策略改成 direct。
    saveConnectionSettingsSeal(db, id, directSeal);
    tamper(id, "write_policy", "direct");
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages"]);
    expect(alerts).toEqual([expect.objectContaining({ seal: "invalid", restored: expect.objectContaining({ writePolicy: "confirm" }) })]);
  });

  it("rejects an older manifest and seal copied back together while the daemon runs", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { writePolicy: "direct" });
    const oldSeal = getConnectionSettingsSeal(db, id)!;
    const oldManifest = getConnectionSettingsManifest(db)!;
    h.updateSettings(k, { writePolicy: "confirm" });
    saveConnectionSettingsSeal(db, id, oldSeal);
    db.prepare("UPDATE kv SET value = ? WHERE key = 'connection.settings_manifest'").run(oldManifest.toString("base64"));
    tamper(id, "write_policy", "direct");
    expect(h.get(k)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts).toEqual([expect.objectContaining({ seal: "invalid" })]);
  });

  it("treats garbage in place of the seal as tampering", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { writePolicy: "direct" });
    saveConnectionSettingsSeal(db, id, randomBytes(64));
    expect(h.get(k)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts).toEqual([expect.objectContaining({ seal: "invalid" })]);
  });
});

describe("the settings page", () => {
  it("changes the settings without an alert, and the seal follows", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { writePolicy: "direct" });
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages", "update_page"]);
    expect(getConnectionSettingsSeal(db, id)).not.toBeNull();
    await h.tick();
    // 另一个 hub（daemon 重启以后）也认得这份封印。
    expect(hub().get(k)).toMatchObject({ writePolicy: "direct" });
    expect(alerts).toEqual([]);
  });

  it("refuses to save when the vault is unavailable", async () => {
    const { key: k } = await connectCustom(hub());
    expect(() => hub({ vault: brokenVault }).updateSettings(k, { writePolicy: "direct" })).toThrow(/保险库暂时不可用/);
  });
});

describe("a missing or broken manifest (review round 3, finding 1)", () => {
  // 上线前的库：没有清单，没有封印。
  function legacy(id: number): void {
    deleteKv(`connection.settings_seal:${id}`);
    deleteKv("connection.settings_manifest");
  }

  it("alerts once per row when the manifest is missing, even when nothing changes (the first check after rollout)", async () => {
    const { key: k, id } = await connectCustom(hub());
    legacy(id);
    tamper(id, "roles", JSON.stringify(["lead"]));
    const h = hub();
    expect(h.get(k)).toMatchObject({ roles: ["lead"], writePolicy: "confirm" });
    expect(alerts).toEqual([expect.objectContaining({ connectionId: id, seal: "missing", restored: { roles: ["lead"], writePolicy: "confirm" } })]);
    expect(getConnectionSettingsSeal(db, id)).not.toBeNull();
    expect(getConnectionSettingsManifest(db)).not.toBeNull();
    await h.tick();
    expect(alerts).toHaveLength(1);
  });

  it("restores an unsealed direct policy and alerts once (the 10-19 ledger)", async () => {
    const { key: k, id } = await connectCustom(hub());
    legacy(id);
    tamper(id, "write_policy", "direct");
    const h = hub();
    expect(await executorTools(h, k)).toEqual(["get_self", "search_pages"]);
    expect(alerts).toEqual([expect.objectContaining({ seal: "missing", found: expect.objectContaining({ writePolicy: "direct" }) })]);
    expect(getConnection(db, id)!.write_policy).toBe("confirm");
    await h.tick();
    expect(alerts).toHaveLength(1);
  });

  it("keeps a role the user took away taken away when only the manifest is deleted", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    h.updateSettings(k, { roles: ["lead"] });
    deleteKv("connection.settings_manifest");
    tamper(id, "roles", JSON.stringify(["lead", "executor"]));
    await expect(h.searchTools("executor", { connection: k })).rejects.toMatchObject({ code: "forbidden" });
    expect(getConnection(db, id)!.roles).toBe(JSON.stringify(["lead"]));
    expect(alerts).toEqual([expect.objectContaining({ connectionId: id, seal: "missing", restored: { roles: ["lead"], writePolicy: "confirm" } })]);
    // 同一个进程里，下一个 hub（daemon 重启以后）也认得新清单。
    expect(hub().get(k)).toMatchObject({ roles: ["lead"] });
    expect(alerts).toHaveLength(1);
  });

  it("checks every row when the manifest is garbage, so the first row's rebuild vouches for nobody", async () => {
    const second = new FakeVendor(() => clock, { mcpUrl: "https://mcp2.fake.test/mcp", issuer: "https://auth2.fake.test" });
    const h = hub({ fetch: combinedFetch({ owns: owns(vendor), fetch: vendor.fetch }, { owns: owns(second), fetch: second.fetch }) });
    const a = await connectCustom(h);
    const b = await connectCustom(h, second);
    h.updateSettings(b.key, { roles: ["lead"] });
    db.prepare("UPDATE kv SET value = ? WHERE key = 'connection.settings_manifest'").run(randomBytes(48).toString("base64"));
    tamper(b.id, "roles", JSON.stringify(["lead", "executor", "reviewer"]));
    // 先用到的是第一行。
    expect(h.get(a.key)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts.map((alert) => alert.connectionId).sort()).toEqual([a.id, b.id].sort());
    expect(alerts.every((alert) => alert.seal === "invalid")).toBe(true);
    expect(getConnection(db, b.id)!.roles).toBe(JSON.stringify(["lead"]));
    await expect(h.searchTools("executor", { connection: b.key })).rejects.toMatchObject({ code: "forbidden" });
    expect(alerts).toHaveLength(2);
  });

  it("alerts for a row a direct INSERT added while the manifest is fine", async () => {
    const h = hub();
    await connectCustom(h);
    const row = insertConnection(db, { provider: "custom", label: "planted", serverUrl: "https://planted.test/mcp", tokenSource: "oauth", writePolicy: "direct" });
    expect(h.get(`custom-${row.id}`)).toMatchObject({ writePolicy: "confirm" });
    expect(alerts).toEqual([expect.objectContaining({ connectionId: row.id, seal: "missing" })]);
  });

  it("uses the stricter settings without writing or alerting when the vault is unavailable", async () => {
    const { key: k, id } = await connectCustom(hub());
    tamper(id, "write_policy", "direct");
    const h = hub({ vault: brokenVault });
    expect(h.get(k)).toMatchObject({ writePolicy: "confirm" });
    expect(getConnection(db, id)!.write_policy).toBe("direct");
    expect(alerts).toEqual([]);
  });
});

// 用户 2026-10-28：「连提交 comments 都需要我审批，而且是逐条审批，这简直是灾难性的」。已有的「先问我」一次性改成「直接写」，
// 走设置页同一条路（重新封印），所以核对不报警；只做一次，用户以后改回「先问我」不会再被改掉。新连接由 daemon 指定缺省。
describe("switching to direct writes", () => {
  it("re-seals confirm connections as direct once, records why, and raises no alert", async () => {
    const h = hub();
    const { key: k, id } = await connectCustom(h);
    expect(h.needsConfirmation(k, "update_page")).toBe(true);

    expect(h.relaxWritePolicyOnce()).toEqual([k]);
    expect(getConnection(db, id)!.write_policy).toBe("direct");
    expect(h.needsConfirmation(k, "update_page")).toBe(false);
    h.auditSettings();
    expect(alerts).toEqual([]);
    expect(listConnectionEvents(db, id).map((event) => event.kind)).toEqual(expect.arrayContaining(["write_policy_relaxed", "settings_changed"]));

    h.updateSettings(k, { writePolicy: "confirm" });
    expect(h.relaxWritePolicyOnce()).toEqual([]);
    expect(getConnection(db, id)!.write_policy).toBe("confirm");
  });

  it("does not mark the switch done while the vault is unavailable", async () => {
    const h = hub();
    const { key: k } = await connectCustom(h);
    expect(hub({ vault: brokenVault }).relaxWritePolicyOnce()).toEqual([]);
    expect(h.relaxWritePolicyOnce()).toEqual([k]);
  });

  it("creates new connections as direct when the daemon asks for it, sealed so the audit stays quiet", async () => {
    const h = hub({ newConnectionWritePolicy: "direct" });
    const { key: k, id } = await connectCustom(h);
    expect(getConnection(db, id)!.write_policy).toBe("direct");
    expect(h.needsConfirmation(k, "update_page")).toBe(false);
    h.auditSettings();
    expect(alerts).toEqual([]);
  });
});

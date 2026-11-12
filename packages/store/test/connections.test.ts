// 连接（v42）：三张新表，不改已有的表。DAO 只存取行：密文按版本号比较后才写，续期租约跨进程也只有一个持有者。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { LATEST_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import {
  addConnectionEvent,
  connectionRoles,
  getConnection,
  getConnectionByServer,
  getOAuthClient,
  hasConnectionEventSince,
  insertConnection,
  listConnections,
  releaseConnectionLease,
  saveConnectionSecret,
  saveOAuthClient,
  takeConnectionLease,
  updateConnection,
} from "../src/connections.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-connections-"), "plc.db")); });

const notion = () => insertConnection(db, {
  provider: "notion", label: "Notion", serverUrl: "https://mcp.notion.com/mcp", tokenSource: "oauth",
}, "2026-10-16T08:00:00.000Z");

describe("a connection row", () => {
  it("starts disconnected, with the default roles and the confirm write policy", () => {
    const row = notion();
    expect(row).toMatchObject({ status: "disconnected", write_policy: "confirm", secret_cipher: null, secret_version: 0 });
    expect(connectionRoles(row)).toEqual(["lead", "executor", "reviewer"]);
    expect(getConnectionByServer(db, "https://mcp.notion.com/mcp")?.id).toBe(row.id);
    expect(listConnections(db)).toHaveLength(1);
  });

  it("has one row per MCP server", () => {
    notion();
    expect(() => notion()).toThrow(/UNIQUE/);
  });

  it("only patches the columns a patch may change", () => {
    const row = notion();
    updateConnection(db, row.id, { status: "connected", account_label: "Acme 工作区" });
    expect(getConnection(db, row.id)).toMatchObject({ status: "connected", account_label: "Acme 工作区" });
    expect(() => updateConnection(db, row.id, { secret_version: 9 } as never)).toThrow(/cannot be patched/);
  });

  it("writes the secret only when the caller read the current version", () => {
    const row = notion();
    expect(saveConnectionSecret(db, row.id, Buffer.from("first"), 0)).toBe(true);
    // 另一条路径拿着旧版本号来写：不覆盖。
    expect(saveConnectionSecret(db, row.id, Buffer.from("stale"), 0)).toBe(false);
    const after = getConnection(db, row.id)!;
    expect(after.secret_version).toBe(1);
    expect(after.secret_cipher?.toString()).toBe("first");
  });

  it("gives the refresh lease to one owner until it expires or is released", () => {
    const row = notion();
    const now = "2026-10-16T08:00:00.000Z";
    const until = "2026-10-16T08:00:30.000Z";
    expect(takeConnectionLease(db, row.id, "pid-1", until, now)).toBe(true);
    expect(takeConnectionLease(db, row.id, "pid-2", until, now)).toBe(false);
    // 持有者可以续租。
    expect(takeConnectionLease(db, row.id, "pid-1", "2026-10-16T08:01:00.000Z", now)).toBe(true);
    // 过期以后别人能拿到。
    expect(takeConnectionLease(db, row.id, "pid-2", "2026-10-16T08:02:30.000Z", "2026-10-16T08:02:00.000Z")).toBe(true);
    releaseConnectionLease(db, row.id, "pid-1");
    expect(getConnection(db, row.id)?.lease_owner).toBe("pid-2");
    releaseConnectionLease(db, row.id, "pid-2");
    expect(getConnection(db, row.id)).toMatchObject({ lease_owner: null, lease_until: null });
  });

  it("remembers whether an event was recorded since a time", () => {
    const row = notion();
    addConnectionEvent(db, row.id, "expiry_warning", "7d", "2026-10-16T08:00:00.000Z");
    expect(hasConnectionEventSince(db, row.id, "expiry_warning", "7d", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(hasConnectionEventSince(db, row.id, "expiry_warning", "1d", "2026-10-01T00:00:00.000Z")).toBe(false);
    expect(hasConnectionEventSince(db, row.id, "expiry_warning", "7d", "2026-10-17T00:00:00.000Z")).toBe(false);
  });

  it("returns the newest registered client for the issuer and redirect URI", () => {
    const base = { issuer: "https://auth.example", redirect_uri: "http://127.0.0.1:47130/oauth/callback", method: "dcr" as const, secret_cipher: null, scope: "read" };
    saveOAuthClient(db, { ...base, client_id: "first", registered_at: "2026-10-16T08:00:00.000Z" });
    saveOAuthClient(db, { ...base, client_id: "second", registered_at: "2026-10-16T09:00:00.000Z" });
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "read")?.client_id).toBe("second");
    expect(getOAuthClient(db, base.issuer, "http://127.0.0.1:1/oauth/callback", "read")).toBeNull();
    // The older client stays: a connection that uses it still needs it to refresh.
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()).toEqual({ n: 2 });
  });

  it("returns only a client registered with every requested scope", () => {
    const base = { issuer: "https://auth.example", redirect_uri: "http://127.0.0.1:47130/oauth/callback", method: "dcr" as const, secret_cipher: null };
    saveOAuthClient(db, { ...base, client_id: "ask", scope: "ask:use offline_access", registered_at: "2026-10-16T08:00:00.000Z" });
    saveOAuthClient(db, { ...base, client_id: "legacy", scope: null, registered_at: "2026-10-16T09:00:00.000Z" });
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "ask:use offline_access")?.client_id).toBe("ask");
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "offline_access  ask:use")?.client_id).toBe("ask");
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "ask:use")?.client_id).toBe("ask");
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "warehouse:use offline_access")).toBeNull();
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "ask:use warehouse:use")).toBeNull();
    // An unknown scope (a row from before v67) serves only a request without scopes.
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, null)?.client_id).toBe("legacy");
    expect(getOAuthClient(db, base.issuer, base.redirect_uri, "")?.client_id).toBe("legacy");
  });
});

describe("the v42 migration", () => {
  const tables = (handle: Db) => (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((table) => table.name);

  it("adds the three tables to a v41 database and changes no existing table", () => {
    const path = join(tempDir("plc-connections-legacy-"), "plc.db");
    const legacy = openDb(path);
    createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    // 退回 v41 的样子：没有连接的表，也没有 v42 的记录。
    legacy.exec("DROP TABLE connection_events; DROP TABLE connections; DROP TABLE oauth_clients");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 42").run();
    const tablesBefore = tables(legacy);
    const itemsBefore = legacy.prepare("SELECT * FROM items ORDER BY id").all();
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "connection_events", "connections", "oauth_clients"].sort());
    expect(migrated.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 42").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
  });

  it("creates the tables in a new database", () => {
    const fresh = openDb(join(tempDir("plc-connections-fresh-"), "plc.db"));
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
  });
});

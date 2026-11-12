// v67: oauth_clients gets a scope column and the primary key (issuer, redirect_uri, client_id), so one issuer can
// hold one registered client per scope set. Three paths: a new database, a v66 database upgrade, and a reopen.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, getOAuthClient, LATEST_SCHEMA_VERSION, openDb, saveOAuthClient, SCHEMA_MIGRATION_VERSIONS, transition, type Db,
} from "../src/index.js";

const columns = (db: Db) => (db.pragma("table_info(oauth_clients)") as Array<{ name: string; pk: number }>);
const primaryKey = (db: Db) => columns(db).filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
const REDIRECT = "http://127.0.0.1:47130/oauth/callback";

// The oauth_clients table as v42 to v66 created it.
const V66_TABLE = `
CREATE TABLE oauth_clients (
  issuer         TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('dcr','cimd')),
  secret_cipher  BLOB,
  registered_at  TEXT NOT NULL,
  PRIMARY KEY (issuer, redirect_uri)
);`;

describe("the v67 oauth client scope migration", () => {
  it("has the column and the new key in a new database, and records the version", () => {
    const db = openDb(join(tempDir("plc-v67-fresh-"), "plc.db"));
    expect(columns(db).map((column) => column.name)).toContain("scope");
    expect(primaryKey(db)).toEqual(["issuer", "redirect_uri", "client_id"]);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 67").get()).toEqual({ name: "oauth-client-scope-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(67);
    db.close();
  });

  it("upgrades a v66 database, keeps every client row and every item, then reopens unchanged", () => {
    const path = join(tempDir("plc-v67-legacy-"), "plc.db");
    const legacy = openDb(path);
    const itemId = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    // Back to the v66 shape: the old table and no v67 record.
    legacy.exec(`DROP TABLE oauth_clients; ${V66_TABLE}`);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 67").run();
    const insert = legacy.prepare("INSERT INTO oauth_clients (issuer, redirect_uri, client_id, method, secret_cipher, registered_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("https://auth.example.test", REDIRECT, "client-a", "dcr", Buffer.from([1, 2, 3]), "2026-10-16T08:00:00.000Z");
    insert.run("https://other.example.test", REDIRECT, "client-b", "dcr", null, "2026-10-17T08:00:00.000Z");
    const clientsBefore = legacy.prepare("SELECT * FROM oauth_clients ORDER BY client_id").all();
    const itemsBefore = legacy.prepare("SELECT * FROM items ORDER BY id").all();
    legacy.close();

    const upgraded = openDb(path);
    expect(primaryKey(upgraded)).toEqual(["issuer", "redirect_uri", "client_id"]);
    expect(upgraded.prepare("SELECT * FROM oauth_clients ORDER BY client_id").all())
      .toEqual(clientsBefore.map((row) => ({ ...(row as object), scope: null })));
    expect(upgraded.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 67").get()).toEqual({ name: "oauth-client-scope-v1" });
    // A row from before v67 does not cover a scope, so the hub registers a client for it.
    expect(getOAuthClient(upgraded, "https://auth.example.test", REDIRECT, "read")).toBeNull();
    expect(getOAuthClient(upgraded, "https://auth.example.test", REDIRECT, null)?.client_id).toBe("client-a");
    saveOAuthClient(upgraded, {
      issuer: "https://auth.example.test", redirect_uri: REDIRECT, client_id: "client-c", method: "dcr",
      secret_cipher: null, registered_at: "2026-11-12T08:00:00.000Z", scope: "read",
    });
    const clientsAfter = upgraded.prepare("SELECT * FROM oauth_clients ORDER BY client_id").all();
    upgraded.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 67").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT * FROM oauth_clients ORDER BY client_id").all()).toEqual(clientsAfter);
    expect(reopened.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(itemsBefore);
    reopened.close();
  });
});

// v47：凭证的来历（工单 15）。bindings 和 pairings 各加一列 origin，只加列，不回填，不碰 items。
// 三条路径：新库、老库（v45）升级、重新打开。item 的生命周期字段、已有的 binding 和配对、事件都不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { bindingOriginOf } from "@pi-lead-child/protocol";
import {
  createCliBinding, createItem, createLoopbackBinding, createPairing, getBinding, LATEST_SCHEMA_VERSION, openDb, redeemPairing,
  SCHEMA_MIGRATION_VERSIONS, transition, type Db,
} from "../src/index.js";

const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

describe("the v47 binding origin migration", () => {
  it("adds the origin columns in a new database", () => {
    const db = openDb(join(tempDir("plc-v47-fresh-"), "plc.db"));
    expect(columns(db, "bindings")).toContain("origin");
    expect(columns(db, "pairings")).toContain("origin");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 47").get()).toEqual({ name: "binding-origin-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(47);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(47);
    db.close();
  });

  it("upgrades a v45 database without changing any binding, pairing, event or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v47-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    const cli = createCliBinding(legacy, { name: "plc" }).binding;
    const web = createLoopbackBinding(legacy, { name: "本机网页" }).binding;
    const phone = redeemPairing(legacy, createPairing(legacy, { name: "旧手机", kind: "companion" }).code).binding;
    createPairing(legacy, { name: "还没兑换", kind: "companion" });
    // 退回 v45 的样子：没有 origin 两列，也没有 v47 的记录。
    legacy.exec("ALTER TABLE bindings DROP COLUMN origin; ALTER TABLE pairings DROP COLUMN origin;");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 47").run();
    expect(columns(legacy, "bindings")).not.toContain("origin");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      bindings: db.prepare("SELECT id, kind, display_name, token_hash, scopes, status, created_at FROM bindings ORDER BY id").all(),
      pairings: db.prepare("SELECT id, code_hash, socket_secret_hash, kind, name, scopes, status, expires_at FROM pairings ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 46 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(columns(migrated, "bindings")).toContain("origin");
    expect(columns(migrated, "pairings")).toContain("origin");
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：已有的行是 NULL，按 kind 推断。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM bindings WHERE origin IS NOT NULL").get()).toEqual({ n: 0 });
    expect(bindingOriginOf(getBinding(migrated, cli.id)!)).toBe("cli");
    expect(bindingOriginOf(getBinding(migrated, web.id)!)).toBe("unknown");
    expect(bindingOriginOf(getBinding(migrated, phone.id)!)).toBe("unknown");
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    // 升级以后新建的凭证记下来历。
    expect(createLoopbackBinding(migrated, { name: "新网页" }).binding.origin).toBe("loopback_web");
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 47").get()).toEqual({ n: 1 });
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(snapshot(reopened).items).toEqual(before.items);
    expect(snapshot(reopened).events).toEqual(before.events);
    reopened.close();
  });
});

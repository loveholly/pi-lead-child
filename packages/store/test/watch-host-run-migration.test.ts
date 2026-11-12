// v65：后台检查加一列 host_run（用户 2026-11-11：用户交代的事带出来的命令检查，免沙箱开着时在沙箱外跑）。
// watches 只加一列，不重建表。三条路径：新库、老库（v64）升级、重新打开。已有的检查一列都不变，host_run 是 0（照旧在沙箱里跑）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createWatch, getItem, getWatch, LATEST_SCHEMA_VERSION, openDb, SCHEMA_MIGRATION_VERSIONS, transition, type Db } from "../src/index.js";

const columns = (db: Db) => (db.pragma("table_info(watches)") as Array<{ name: string }>).map((column) => column.name);
const command = (text: string) => ({ kind: "command" as const, command: text });

describe("the v65 watch host_run migration", () => {
  it("has the column in a new database, records the version, and stores what the setter decided", () => {
    const db = openDb(join(tempDir("plc-v65-fresh-"), "plc.db"));
    expect(columns(db)).toContain("host_run");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 65").get()).toEqual({ name: "watch-host-run-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(65);
    const plain = createWatch(db, { label: "a", check: command("true"), mode: "repeat", everySeconds: 60, origin: { kind: "system" } });
    const host = createWatch(db, { label: "b", check: command("true"), mode: "repeat", everySeconds: 60, origin: { kind: "system" }, hostRun: true });
    expect(getWatch(db, plain)!.host_run).toBe(0);
    expect(getWatch(db, host)!.host_run).toBe(1);
    // 外部来源的检查、子代理检查不在沙箱外跑，不管调用方怎么说。
    const external = createWatch(db, {
      label: "c", check: command("true"), mode: "repeat", everySeconds: 60, hostRun: true,
      origin: { kind: "external", source: "slack", sender: null, messageEvent: null } as never,
    });
    const agent = createWatch(db, {
      label: "d", check: { kind: "agent", brief: "看一下" }, mode: "repeat", everySeconds: 3600, origin: { kind: "system" }, hostRun: true,
    });
    expect(getWatch(db, external)!.host_run).toBe(0);
    expect(getWatch(db, agent)!.host_run).toBe(0);
    db.close();
  });

  it("upgrades a v64 database without touching watches, items or activities, then reopens", () => {
    const path = join(tempDir("plc-v65-legacy-"), "plc.db");
    const legacy = openDb(path);
    const itemId = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    const watchId = createWatch(legacy, {
      label: "等登录", check: command("true"), mode: "repeat", everySeconds: 60, origin: { kind: "system" }, itemId, hostRun: true,
    });
    // 退回 v64 的样子：没有这一列，也没有 v65 的记录。
    legacy.exec("ALTER TABLE watches DROP COLUMN host_run");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 65").run();
    const snapshot = (db: Db) => ({
      watches: (db.prepare("SELECT * FROM watches ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "host_run"))),
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    expect(columns(legacy)).not.toContain("host_run");
    legacy.close();

    const upgraded = openDb(path);
    expect(columns(upgraded).at(-1)).toBe("host_run");
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 65").get()).toEqual({ name: "watch-host-run-v1" });
    expect(snapshot(upgraded)).toEqual(before);
    // 以前设的检查照旧在沙箱里跑；工单的生命周期字段不动。
    expect(getWatch(upgraded, watchId)!.host_run).toBe(0);
    expect(getItem(upgraded, itemId)!.stage).toBe("done");
    upgraded.prepare("UPDATE watches SET host_run = 1 WHERE id = ?").run(watchId);
    upgraded.close();

    const reopened = openDb(path);
    expect(snapshot(reopened)).toEqual(before);
    expect(getWatch(reopened, watchId)!.host_run).toBe(1);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 65").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

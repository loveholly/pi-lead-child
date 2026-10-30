// v61：自定义控件（.scratch/custom-views/spec.md D1）。只加 widgets 一张表，不改任何已有的表和行，也不回填。
// 三条路径：新库、老库（v60）升级、重新打开。工单的生命周期字段和活动都不变，已有的控件重开以后还在。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_CATALOG_VERSION, type UiSurface } from "@pi-lead-child/protocol";
import {
  createItem, createWidget, getWidgetSource, LATEST_SCHEMA_VERSION, listWidgets, openDb, SCHEMA_MIGRATION_VERSIONS, setWidgetSource, transition,
  type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const surface = (id: number): UiSurface => ({
  id: `widget_${id}`, catalogVersion: UI_CATALOG_VERSION, root: "t", fallbackText: "纳斯达克 18,532",
  nodes: [{ id: "t", type: "Text", props: { text: "纳斯达克 18,532" } }],
});

describe("the v61 widgets migration", () => {
  it("creates the widgets table, with a default view, in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v61-fresh-"), "plc.db"));
    expect(tables(db)).toContain("widgets");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 61").get()).toEqual({ name: "widgets-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(61);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(61);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    const insert = "INSERT INTO widgets (title, view, surface, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 'user', 'a', 'a')";
    expect(() => db.prepare(insert).run("", "default", "{}")).toThrow(/CHECK/);
    expect(() => db.prepare(insert).run("x", "default", "not json")).toThrow(/CHECK/);
    expect(() => db.prepare(insert).run("x", "", "{}")).toThrow(/CHECK/);
    db.prepare("INSERT INTO widgets (title, surface, position, created_by, created_at, updated_at) VALUES ('x', '{}', 0, 'user', 'a', 'a')").run();
    expect(db.prepare("SELECT view FROM widgets").get()).toEqual({ view: "default" });
    db.close();
  });

  it("upgrades a v60 database without touching items or activities, then reopens with the widgets kept", () => {
    const path = join(tempDir("plc-v61-legacy-"), "plc.db");
    const legacy = openDb(path);
    const itemId = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    // 退回 v60 的样子：没有 widgets 表，也没有 v61 的记录。
    legacy.exec("DROP TABLE widgets");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 61").run();
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    legacy.close();

    const upgraded = openDb(path);
    expect(tables(upgraded)).toContain("widgets");
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 61").get()).toEqual({ name: "widgets-v1" });
    expect(snapshot(upgraded)).toEqual(before);
    expect(listWidgets(upgraded)).toEqual([]);
    const widget = createWidget(upgraded, { title: "指数", view: "投资", createdBy: "lead" }, surface);
    upgraded.close();

    const reopened = openDb(path);
    expect(snapshot(reopened)).toEqual(before);
    expect(listWidgets(reopened)).toEqual([expect.objectContaining({ id: widget.id, title: "指数", view: "投资", createdBy: "lead", surface: surface(widget.id) })]);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 61").get() as { n: number }).n).toBe(1);
    reopened.close();
  });
});

// v62：控件的数据源（spec D3，第二期）。只加 widget_sources 一张表，不改 widgets 和已有的行：已有的控件照旧是快照。
describe("the v62 widget sources migration", () => {
  it("upgrades a v61 database with a widget: the widget stays a snapshot, then a source can be set and survives a reopen", () => {
    const path = join(tempDir("plc-v62-legacy-"), "plc.db");
    const legacy = openDb(path);
    const widget = createWidget(legacy, { title: "指数", createdBy: "lead" }, surface);
    const items = createItem(legacy, { title: "t", brief: "b", createdBy: "user" });
    // 退回 v61 的样子：没有 widget_sources 表，也没有 v62 的记录。
    legacy.exec("DROP TABLE widget_sources");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 62").run();
    const before = { widgets: legacy.prepare("SELECT * FROM widgets").all(), items: legacy.prepare("SELECT * FROM items ORDER BY id").all() };
    legacy.close();

    const upgraded = openDb(path);
    expect(tables(upgraded)).toContain("widget_sources");
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 62").get()).toEqual({ name: "widget-sources-v1" });
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(62);
    expect({ widgets: upgraded.prepare("SELECT * FROM widgets").all(), items: upgraded.prepare("SELECT * FROM items ORDER BY id").all() }).toEqual(before);
    expect(listWidgets(upgraded)).toEqual([expect.objectContaining({ id: widget.id, source: null })]);
    const template = { root: "t", nodes: [{ id: "t", type: "Text", props: { text: "{{price}}" } }], fallback_text: "{{price}}" };
    setWidgetSource(upgraded, widget.id, { template, command: "nasdaq.sh", everySeconds: 900, now: new Date("2026-10-30T08:00:00.000Z") });
    expect(() => upgraded.prepare("UPDATE widget_sources SET every_seconds = 10").run()).toThrow(/CHECK/);
    upgraded.close();

    const reopened = openDb(path);
    expect(getWidgetSource(reopened, widget.id)).toMatchObject({ command: "nasdaq.sh", everySeconds: 900, template, paused: false });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
    expect(items).toBeGreaterThan(0);
    reopened.close();
  });
});

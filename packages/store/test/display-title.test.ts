// 工单的短标题（左栏改版阶段 2，决定 5）：E2E 脚本生成的标题不可读（#66：「[E2E #51 T48-E2E-51-20260817061106]
// FINAL #45 implementation - …」），Lead 可以给它写一个显示用的短标题，原标题保留。
// v39 只加一列，不重建 items：老库、新库、重开三条路径上，其他列和行都原样保留。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { LATEST_SCHEMA_VERSION, openDb } from "../src/db.js";
import { createItem, getItem, setItemDisplayTitle } from "../src/items.js";

const E2E_TITLE = "[E2E #51 T48-E2E-51-20260817061106] FINAL #45 implementation - outcome snapshot and registry mechanism";

function columns(db: ReturnType<typeof openDb>): string[] {
  return (db.pragma("table_info(items)") as { name: string }[]).map((column) => column.name);
}

describe("a short display title", () => {
  it("is stored next to the original title, which stays as it was", () => {
    const db = openDb(join(tempDir("plc-display-title-"), "plc.db"));
    const id = createItem(db, { title: E2E_TITLE, brief: "b", createdBy: "user" });
    setItemDisplayTitle(db, id, "成果快照与登记机制");
    expect(getItem(db, id)).toMatchObject({ title: E2E_TITLE, display_title: "成果快照与登记机制" });
    setItemDisplayTitle(db, id, null);
    expect(getItem(db, id)?.display_title).toBeNull();
  });

  it("refuses an empty or overlong title", () => {
    const db = openDb(join(tempDir("plc-display-title-"), "plc.db"));
    const id = createItem(db, { title: E2E_TITLE, brief: "b", createdBy: "user" });
    expect(() => setItemDisplayTitle(db, id, "   ")).toThrow();
    expect(() => setItemDisplayTitle(db, id, "长".repeat(61))).toThrow();
  });
});

describe("the v39 migration", () => {
  it("adds the column to an old database and keeps every row and column", () => {
    const path = join(tempDir("plc-display-title-legacy-"), "plc.db");
    const fresh = openDb(path);
    const id = createItem(fresh, { title: E2E_TITLE, brief: "brief", createdBy: "user", priority: "high", project: "pi-lead-child" });
    // 退回 v38 的样子：没有这一列，也没有 v39 的记录。
    fresh.exec("ALTER TABLE items DROP COLUMN display_title");
    fresh.prepare("DELETE FROM schema_migrations WHERE version = 39").run();
    const before = fresh.prepare("SELECT * FROM items WHERE id = ?").get(id) as Record<string, unknown>;
    fresh.close();

    const migrated = openDb(path);
    const after = migrated.prepare("SELECT * FROM items WHERE id = ?").get(id) as Record<string, unknown>;
    expect(columns(migrated)).toContain("display_title");
    expect(after).toEqual({ ...before, display_title: null });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    migrated.close();

    // 重开不再动它。
    const reopened = openDb(path);
    expect(reopened.prepare("SELECT * FROM items WHERE id = ?").get(id)).toEqual(after);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 39").get()).toEqual({ n: 1 });
  });

  it("creates the column in a new database", () => {
    const db = openDb(join(tempDir("plc-display-title-fresh-"), "plc.db"));
    expect(columns(db)).toContain("display_title");
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });
});

// v60：启用 Hindsight 时以它为主（.scratch/hindsight-primary-memory/spec.md D3、D5）。加 memory_sync、memory_invalidations 两张表，
// 和常驻偏好的改动记录 core_memory_changes（D15，只追加），删掉 kv 里旧的同步游标和「跳过的笔记」。
// notes、待忘掉的清单和工单的生命周期字段都不动。
// 三条路径：新库、老库（v59）升级、重新打开。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, getCoreMemoryChange, getItem, getNote, LATEST_SCHEMA_VERSION, markCoreMemoryChangeUndone, noteSnapshot, noteSyncCounts, openDb,
  listInvalidatedFacts, queueMemorySync, recordCoreMemoryChange, recordMemoryInvalidation, saveNote, SCHEMA_MIGRATION_VERSIONS,
  setMemorySyncState, transition, type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'memory_%' OR name = 'core_memory_changes') ORDER BY name",
).all() as { name: string }[]).map((row) => row.name);
const V60_TABLES = ["core_memory_changes", "memory_invalidations", "memory_sync"];
const kv = (db: Db) => db.prepare("SELECT key, value FROM kv WHERE key LIKE 'memory.%' ORDER BY key").all();

describe("the v60 memory sync migration", () => {
  it("creates the tables in a new database, and tracks one note per bank", () => {
    const db = openDb(join(tempDir("plc-v60-fresh-"), "plc.db"));
    expect(tables(db)).toEqual(V60_TABLES);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 60").get()).toEqual({ name: "memory-sync-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(60);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(60);
    const id = saveNote(db, { title: "a", content: "1", tags: [] });
    saveNote(db, { title: "b", content: "2", tags: [] });
    queueMemorySync(db, { bankIndex: "hindsight.x", documentId: `note-${id}`, fingerprint: "f", operationId: "op-1" });
    expect(setMemorySyncState(db, { bankIndex: "hindsight.x", documentId: `note-${id}`, operationId: "op-other" }, { state: "completed" })).toBe(false);
    expect(setMemorySyncState(db, { bankIndex: "hindsight.x", documentId: `note-${id}`, operationId: "op-1" }, { state: "completed" })).toBe(true);
    expect(noteSyncCounts(db, "hindsight.x")).toEqual({ notes: 2, completed: 1, pending: 1, failed: 0, lastError: null });
    expect(() => db.prepare("UPDATE memory_sync SET state = 'done'").run()).toThrow(/CHECK/);
    // 失效记录带事实的原文和来源（2026-10-29），设置页列出现在失效着的。
    const record = recordMemoryInvalidation(db, {
      bankIndex: "hindsight.x", memoryId: "m-1", documentId: `note-${id}`, action: "invalidated", reason: "r", actor: "lead",
      text: "用户在杭州", origin: "external",
    });
    expect(record).toMatchObject({ memoryId: "m-1", text: "用户在杭州", origin: "external", createdAt: expect.stringMatching(/Z$/) });
    expect(listInvalidatedFacts(db)).toEqual([record]);
    expect(() => db.prepare("UPDATE memory_invalidations SET origin = 'other'").run()).toThrow(/CHECK/);
    db.close();
  });

  it("keeps core memory changes append-only: one undo per row, no edits, no deletes", () => {
    const db = openDb(join(tempDir("plc-v60-core-"), "plc.db"));
    const id = saveNote(db, { title: "沟通偏好", content: "先给结论", tags: [], kind: "preference" });
    const change = recordCoreMemoryChange(db, {
      noteId: id, action: "create", before: null, after: noteSnapshot(getNote(db, id)!), actor: "lead", reason: "用户说的",
    });
    expect(change).toMatchObject({ action: "create", before: null, after: { title: "沟通偏好", kind: "preference", tags: [] }, undoneAt: null });
    expect(() => db.prepare("UPDATE core_memory_changes SET reason = 'x' WHERE id = ?").run(change.id)).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM core_memory_changes WHERE id = ?").run(change.id)).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE core_memory_changes SET undone_at = 'x' WHERE id = ?").run(change.id)).toThrow(/CHECK/);
    expect(() => recordCoreMemoryChange(db, { noteId: id, action: "create", before: noteSnapshot(getNote(db, id)!), after: null, actor: "lead", reason: "" }))
      .toThrow(/CHECK/);
    expect(markCoreMemoryChangeUndone(db, change.id, { actor: "user" })).toBe(true);
    expect(markCoreMemoryChangeUndone(db, change.id, { actor: "user" })).toBe(false);
    expect(getCoreMemoryChange(db, change.id)).toMatchObject({ undoneBy: "user", undoneAt: expect.any(String) });
    expect(() => db.prepare("UPDATE core_memory_changes SET undone_by = 'lead' WHERE id = ?").run(change.id)).toThrow(/append-only/);
    db.close();
  });

  it("upgrades a v59 database: drops the old cursor and skipped list, keeps notes, the forget list and tickets, then reopens", () => {
    const path = join(tempDir("plc-v60-legacy-"), "plc.db");
    const legacy = openDb(path);
    const noteId = saveNote(legacy, { title: "偏好", content: "回复用中文", tags: [], kind: "preference" });
    const itemId = createItem(legacy, { title: "t", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    // 退回 v59 的样子：没有两张新表，也没有 v60 的记录；kv 里有旧的游标、跳过的笔记和待忘掉的清单。
    legacy.exec("DROP TABLE memory_sync; DROP TABLE memory_invalidations; DROP TABLE core_memory_changes;");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 60").run();
    const put = legacy.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    put.run("memory.hindsight.ab12cd34.synced_through", JSON.stringify({ updatedAt: "2026-10-26 10:00:00", pushed: {} }));
    put.run("memory.hindsight.ab12cd34.skipped", JSON.stringify([{ noteId, fingerprint: "x", error: "HTTP 422", at: "t" }]));
    put.run("memory.pending_forget", JSON.stringify(["note-99"]));
    const snapshot = (db: Db) => ({
      notes: db.prepare("SELECT * FROM notes ORDER BY id").all(),
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version <> 60 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual(V60_TABLES);
    expect(snapshot(migrated)).toEqual(before);
    expect(kv(migrated)).toEqual([{ key: "memory.pending_forget", value: JSON.stringify(["note-99"]) }]);
    expect(getItem(migrated, itemId)).toMatchObject({ stage: "done", closed_at: expect.any(String) });
    // 新表是空的：第一次同步把全部笔记按新的方式再写一遍；以前的常驻偏好没有改动记录。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM core_memory_changes").get()).toEqual({ n: 0 });
    expect(noteSyncCounts(migrated, "hindsight.ab12cd34")).toEqual({ notes: 1, completed: 0, pending: 1, failed: 0, lastError: null });
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    migrated.close();

    const reopened = openDb(path);
    expect(snapshot(reopened)).toEqual(before);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 60").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

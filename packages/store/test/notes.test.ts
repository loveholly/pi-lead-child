import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { deleteNote, getNote, notesWithTag, saveNote, searchNotes, updateNote } from "../src/notes.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("notes DAO", () => {
  it("saves and searches by title/content/tags", () => {
    saveNote(db, { title: "技术决策：用 SQLite", content: "账本层选 SQLite，理由是单机单文件", tags: ["决策", "存储"] });
    saveNote(db, { title: "用户偏好", content: "回复用中文，简洁直接", tags: ["偏好"] });
    expect(searchNotes(db, "SQLite").length).toBe(1);
    expect(searchNotes(db, "中文").length).toBe(1);
    expect(searchNotes(db, "决策").length).toBe(1); // tags 命中
    expect(searchNotes(db, "不存在的词").length).toBe(0);
  });

  it("updates note content in place", () => {
    const id = saveNote(db, { title: "t", content: "旧内容", tags: [] });
    updateNote(db, id, { content: "新内容" });
    expect(searchNotes(db, "新内容").length).toBe(1);
    expect(searchNotes(db, "旧内容").length).toBe(0);
  });
});

describe("notes kind", () => {
  it("保存时可指定 kind，缺省 note", () => {
    const id1 = saveNote(db, { title: "画像", content: "后端工程师", tags: [], kind: "profile" });
    const id2 = saveNote(db, { title: "结论", content: "选 SQLite", tags: [] });
    expect(searchNotes(db, "后端工程师")[0].kind).toBe("profile");
    expect(searchNotes(db, "SQLite")[0].kind).toBe("note");
    expect(id2).toBeGreaterThan(id1);
  });
  it("searchNotes 可按 kind 过滤", () => {
    saveNote(db, { title: "偏好", content: "回复用中文", tags: [], kind: "preference" });
    saveNote(db, { title: "杂记", content: "回复格式讨论", tags: [] });
    expect(searchNotes(db, "回复", { kind: "preference" }).length).toBe(1);
  });
  it("updateNote 可改 kind", () => {
    const id = saveNote(db, { title: "t", content: "内容甲", tags: [] });
    updateNote(db, id, { kind: "fact" });
    expect(searchNotes(db, "内容甲")[0].kind).toBe("fact");
  });
  it("老库就地迁移：缺 kind 列的库打开后自动补列，存量行 kind=note", () => {
    const dir = tempDir("plc-");
    const p = join(dir, "old.db");
    const raw = new Database(p);
    raw.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.prepare("INSERT INTO notes (title, content) VALUES ('旧', '旧数据')").run();
    raw.close();
    const migrated = openDb(p);
    expect(searchNotes(migrated, "旧数据")[0].kind).toBe("note");
  });
});

// slack-takeover 工单 07：线程删空了，它的事实笔记跟着删；同一个线程的笔记按标签找。
describe("deleteNote and notesWithTag", () => {
  it("deletes a note and its full-text entry, and reports when there was nothing to delete", () => {
    const id = saveNote(db, { title: "Slack #proj-x：发布", content: "周五发布 v2", tags: ["slack"], kind: "fact" });
    expect(searchNotes(db, "周五发布").map((note) => note.id)).toEqual([id]);
    expect(deleteNote(db, id)).toBe(true);
    expect(getNote(db, id)).toBeNull();
    expect(searchNotes(db, "周五发布")).toEqual([]);
    expect(deleteNote(db, id)).toBe(false);
  });

  it("finds notes by an exact tag, not by a tag that only contains it", () => {
    const thread = saveNote(db, { title: "a", content: "1", tags: ["slack", "slack:C0PROJ:1760000000.000100"], kind: "fact" });
    saveNote(db, { title: "b", content: "2", tags: ["slack", "slack:C0PROJ:1760000000.000100x"], kind: "fact" });
    saveNote(db, { title: "c", content: "3", tags: ["other"] });
    expect(notesWithTag(db, "slack:C0PROJ:1760000000.000100").map((note) => note.id)).toEqual([thread]);
    expect(notesWithTag(db, "slack")).toHaveLength(2);
    expect(notesWithTag(db, "slack:C0PROJ")).toEqual([]);
  });
});

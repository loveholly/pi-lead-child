import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, ftsEnabled, type Db } from "../src/db.js";
import { saveNote, searchNotes, updateNote } from "../src/notes.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("notes FTS5 trigram", () => {
  it("FTS5 在本环境可用", () => {
    expect(ftsEnabled(db)).toBe(true);
  });
  it("中文子串命中（≥3 字符走 FTS）", () => {
    saveNote(db, { title: "部署决策", content: "凭证持久化用配置文件优先于环境变量", tags: [] });
    expect(searchNotes(db, "配置文件优先").length).toBe(1);
    expect(searchNotes(db, "持久化用配").length).toBe(1); // 任意子串
  });
  it("<3 字符降级 LIKE 仍可命中（中文双字词）", () => {
    saveNote(db, { title: "偏好", content: "简洁直接", tags: [] });
    expect(searchNotes(db, "偏好").length).toBe(1);
  });
  it("bm25 排序：标题+内容多处命中的排前", () => {
    saveNote(db, { title: "无关", content: "只提了一次 esbuild", tags: [] });
    saveNote(db, { title: "esbuild 构建", content: "esbuild 打包 esbuild external", tags: ["esbuild"] });
    const rows = searchNotes(db, "esbuild");
    expect(rows[0].title).toBe("esbuild 构建");
  });
  it("update/delete 经触发器同步索引", () => {
    const id = saveNote(db, { title: "t", content: "旧索引内容", tags: [] });
    updateNote(db, id, { content: "新索引内容" });
    expect(searchNotes(db, "旧索引内容").length).toBe(0);
    expect(searchNotes(db, "新索引内容").length).toBe(1);
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    expect(searchNotes(db, "新索引内容").length).toBe(0);
  });
  it("含引号的 query 不炸 FTS 语法", () => {
    saveNote(db, { title: "q", content: '他说 "hello world" 然后离开', tags: [] });
    expect(() => searchNotes(db, '"hello world"')).not.toThrow();
  });

  it("token-AND：多词非相邻也能命中（不再要求整句严格相邻）", () => {
    saveNote(db, { title: "构建工具", content: "esbuild 用于打包依赖", tags: [] });
    expect(searchNotes(db, "esbuild 打包").length).toBe(1);
  });

  it("全部 token 都 <3 字符时整体降级 LIKE（避免 trigram 空 token 退化成匹配全表）", () => {
    saveNote(db, { title: "t", content: "他的偏好 好复杂，一时说不清", tags: [] });
    saveNote(db, { title: "无关笔记", content: "跟这次查询完全没有关系的内容", tags: [] });
    // "偏好"(2字) 和 "好"(1字) 都 <3 字符：FTS trigram 对短 token 无索引、会退化成匹配一切，
    // 若不整体降级 LIKE，两个 no-op token AND 起来 = 全表命中，"无关笔记" 也会被命中。
    const rows = searchNotes(db, "偏好 好");
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("t");
  });

  it("事务语义：FTS5 虚表创建可回滚（证明 setupFts 的事务包裹在真实失败时能防止半成品残留）", () => {
    // 复现思路（评审建议的退而求其次测法）：直接验证 FTS5 虚表创建是事务性 DDL——
    // BEGIN 里建虚表再 ROLLBACK，虚表必须彻底消失，不留半成品。这证明 setupFts 里
    // db.transaction(...) 包裹 create+triggers+rebuild 一旦中途抛错，回滚是有效的、
    // 不会出现"虚表存在但触发器/回填缺失"的半成品态。
    // 局限（如实说明）：这只证明"新产生"的半成品会被事务防住；无法证明能自愈数据库里
    // "已经存在"的半成品（老版本代码或手工破坏产生的），因为 setupFts 的 exists 守卫
    // 一旦看到 notes_fts 表名存在就会短路直接置 ftsReady=true，这是本次修复未覆盖、
    // 也不打算覆盖的边界。
    const rawPath = join(tempDir("plc-"), "raw.db");
    const raw = new Database(rawPath);
    raw.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, content TEXT, tags TEXT)`);
    const txn = raw.transaction(() => {
      raw.exec(`CREATE VIRTUAL TABLE notes_fts USING fts5(
        title, content, tags, content='notes', content_rowid='id', tokenize='trigram'
      )`);
      throw new Error("模拟建触发器/rebuild 阶段失败");
    });
    expect(() => txn()).toThrow();
    const exists = raw.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
    ).get();
    expect(exists).toBeUndefined(); // 回滚后虚表必须不存在，证明 DDL 可回滚
    raw.close();

    // 正常路径依旧全部就位：虚表 + 3 个触发器
    const p = join(tempDir("plc-"), "plc.db");
    const normal = openDb(p);
    expect(ftsEnabled(normal)).toBe(true);
    const triggerCount = (normal.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'notes_fts_%'",
    ).get() as { c: number }).c;
    expect(triggerCount).toBe(3);
  });
});

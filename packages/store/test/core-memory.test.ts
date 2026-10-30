import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { saveNote, updateNote, renderCoreMemory, coreMemoryRefreshPrefix, CORE_MEMORY_CAP_DEFAULT } from "../src/notes.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });
afterEach(() => { delete process.env.PLC_CORE_MEMORY_CAP; });

describe("core memory", () => {
  it("renderCoreMemory 只含 profile+preference，无内容时返回 null", () => {
    expect(renderCoreMemory(db)).toBeNull();
    saveNote(db, { title: "画像", content: "后端工程师，偏 TS", tags: [], kind: "profile" });
    saveNote(db, { title: "偏好", content: "回复中文", tags: [], kind: "preference" });
    saveNote(db, { title: "工作沉淀", content: "不应出现", tags: [], kind: "note" });
    const block = renderCoreMemory(db)!;
    expect(block).toContain("后端工程师");
    expect(block).toContain("回复中文");
    expect(block).not.toContain("不应出现");
    expect(block).toContain("关于用户");
  });
  it("超过 PLC_CORE_MEMORY_CAP 时 saveNote 报错逼精炼（Hermes：错误而非静默截断）", () => {
    process.env.PLC_CORE_MEMORY_CAP = "50";
    saveNote(db, { title: "画像", content: "x".repeat(30), tags: [], kind: "profile" });
    expect(() =>
      saveNote(db, { title: "偏好", content: "y".repeat(30), tags: [], kind: "preference" }),
    ).toThrow(/核心记忆已满/);
  });
  it("updateNote 把普通 note 改成核心 kind 时同样受容量约束", () => {
    process.env.PLC_CORE_MEMORY_CAP = "50";
    saveNote(db, { title: "画像", content: "x".repeat(40), tags: [], kind: "profile" });
    const id = saveNote(db, { title: "长笔记", content: "z".repeat(40), tags: [] });
    expect(() => updateNote(db, id, { kind: "preference" })).toThrow(/核心记忆已满/);
  });
  it("普通 note 不受容量限制", () => {
    process.env.PLC_CORE_MEMORY_CAP = "10";
    expect(() => saveNote(db, { title: "长", content: "z".repeat(100), tags: [] })).not.toThrow();
    expect(CORE_MEMORY_CAP_DEFAULT).toBe(4000);
  });
  it("核心 note 缩小编辑不误报超限（excludeId 语义：不把自身旧文案计入）", () => {
    process.env.PLC_CORE_MEMORY_CAP = "50";
    const id = saveNote(db, { title: "", content: "x".repeat(45), tags: [], kind: "profile" });
    expect(() => updateNote(db, id, { content: "y".repeat(30) })).not.toThrow();
  });
  it("renderCoreMemory 只有 profile 时无'偏好'标题；只有 preference 时无'画像'标题", () => {
    saveNote(db, { title: "画像", content: "后端工程师", tags: [], kind: "profile" });
    const onlyProfile = renderCoreMemory(db)!;
    expect(onlyProfile).toContain("画像");
    expect(onlyProfile).not.toContain("偏好");
    const db2 = openDb(join(tempDir("plc-"), "plc.db"));
    saveNote(db2, { title: "偏好", content: "回复中文", tags: [], kind: "preference" });
    const onlyPref = renderCoreMemory(db2)!;
    expect(onlyPref).toContain("偏好");
    expect(onlyPref).not.toContain("画像");
  });
  it("垃圾 PLC_CORE_MEMORY_CAP 回落默认 4000，闸仍生效（Number.isFinite 禁 NaN 静默失闸）", () => {
    process.env.PLC_CORE_MEMORY_CAP = "abc";
    expect(() => saveNote(db, { title: "", content: "x".repeat(100), tags: [], kind: "profile" })).not.toThrow();
    expect(() =>
      saveNote(db, { title: "", content: "y".repeat(4001), tags: [], kind: "preference" }),
    ).toThrow(/核心记忆已满/);
  });
  it("coreMemoryRefreshPrefix 无核心记忆时返回空串、有则带刷新说明前缀（compaction 后前缀注入）", () => {
    expect(coreMemoryRefreshPrefix(db)).toBe("");
    saveNote(db, { title: "画像", content: "后端工程师", tags: [], kind: "profile" });
    const prefix = coreMemoryRefreshPrefix(db);
    expect(prefix).toContain("长期记忆刷新");
    expect(prefix).toContain("后端工程师");
  });
});

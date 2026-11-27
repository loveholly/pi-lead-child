// shadow 按对话复用会话的账本（工单 #588，shadow-conversations.ts）和 v68 的迁移。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  appendShadowWork, createItem, getItem, getShadowConversation, LATEST_SCHEMA_VERSION, listShadowWork, markShadowWorkSeen, openDb,
  resetShadowWorkCursors, saveShadowConversation, SCHEMA_MIGRATION_VERSIONS, SHADOW_WORK_TEXT_MAX,
} from "../src/index.js";

describe("shadow conversations and their work records", () => {
  it("keeps one row per conversation and changes only the given fields", () => {
    const db = openDb(join(tempDir("plc-shadow-conv-"), "plc.db"));
    expect(getShadowConversation(db, "slack:D0ALICE")).toBeNull();
    saveShadowConversation(db, "slack:D0ALICE", { sessionFile: "/x/a.jsonl", configVersion: "v1", openedAt: "2026-11-27T10:00:00.000Z" });
    saveShadowConversation(db, "slack:D0ALICE", { lastMessageAt: "2026-11-27T10:05:00.000Z" });
    expect(getShadowConversation(db, "slack:D0ALICE")).toMatchObject({
      sessionFile: "/x/a.jsonl", configVersion: "v1", openedAt: "2026-11-27T10:00:00.000Z", lastMessageAt: "2026-11-27T10:05:00.000Z", leadSeenEntry: 0,
    });
    saveShadowConversation(db, "slack:D0ALICE", { sessionFile: null });
    expect(getShadowConversation(db, "slack:D0ALICE")!.sessionFile).toBeNull();
    db.close();
  });

  it("only adds entries, clips long ones, and keeps the main session's cursor until a compaction resets it", () => {
    const db = openDb(join(tempDir("plc-shadow-work-"), "plc.db"));
    const added = appendShadowWork(db, "slack:D0ALICE", [
      { kind: "attachment", ref: "slack:F1", text: "截图：账号被冻结" },
      { kind: "decision", text: "  " },
      { kind: "open", text: "x".repeat(SHADOW_WORK_TEXT_MAX + 50) },
    ]);
    expect(added).toHaveLength(2);
    expect(added[1]!.text).toHaveLength(SHADOW_WORK_TEXT_MAX);
    appendShadowWork(db, "slack:D0BOB", [{ kind: "decision", text: "别的对话" }]);
    expect(listShadowWork(db, "slack:D0ALICE").map((entry) => entry.kind)).toEqual(["attachment", "open"]);
    expect(listShadowWork(db, "slack:D0ALICE", added[0]!.id).map((entry) => entry.id)).toEqual([added[1]!.id]);
    markShadowWorkSeen(db, "slack:D0ALICE", added[1]!.id);
    markShadowWorkSeen(db, "slack:D0ALICE", added[0]!.id);
    expect(getShadowConversation(db, "slack:D0ALICE")!.leadSeenEntry).toBe(added[1]!.id);
    expect(resetShadowWorkCursors(db)).toBe(1);
    expect(getShadowConversation(db, "slack:D0ALICE")!.leadSeenEntry).toBe(0);
    // 读过不删：记录还在。
    expect(listShadowWork(db, "slack:D0ALICE")).toHaveLength(2);
    db.close();
  });
});

describe("the v68 shadow conversations migration", () => {
  it("has the tables and the version in a new database", () => {
    const db = openDb(join(tempDir("plc-v68-fresh-"), "plc.db"));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 68").get()).toEqual({ name: "shadow-conversations-v1" });
    expect(LATEST_SCHEMA_VERSION).toBe(68);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(68);
    for (const table of ["shadow_conversations", "shadow_work_entries"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
    }
    db.close();
  });

  it("upgrades a v67 database without touching items, then reopens", () => {
    const path = join(tempDir("plc-v68-legacy-"), "plc.db");
    const legacy = openDb(path);
    const item = createItem(legacy, { title: "t", brief: "b", createdBy: "user" });
    legacy.exec("DROP TABLE shadow_work_entries");
    legacy.exec("DROP TABLE shadow_conversations");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 68").run();
    const before = legacy.prepare("SELECT * FROM items ORDER BY id").all();
    const stage = getItem(legacy, item)!.stage;
    legacy.close();

    const upgraded = openDb(path);
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 68").get()).toEqual({ name: "shadow-conversations-v1" });
    expect(upgraded.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(before);
    appendShadowWork(upgraded, "slack:D0ALICE", [{ kind: "decision", text: "记下了" }]);
    upgraded.close();

    const reopened = openDb(path);
    expect(listShadowWork(reopened, "slack:D0ALICE").map((entry) => entry.text)).toEqual(["记下了"]);
    expect(getItem(reopened, item)!.stage).toBe(stage);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 68").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

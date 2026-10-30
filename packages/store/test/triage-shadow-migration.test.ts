// v45：Jev 分诊的影子判断（Lead 事件主干 spec D12，工单 09）。只加 event_triage_shadow 表（由 SCHEMA 建），
// 不改任何已有的表和行，不回填。三条路径：新库、老库（v44）升级、重新打开。item 的生命周期字段不变，事件不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, createItem, createRun, getTriageShadowJudgment, LATEST_SCHEMA_VERSION, openDb, recordTriageShadowJudgment,
  SCHEMA_MIGRATION_VERSIONS, transition, updateRun, type Db, type TriageShadowJudgmentInput,
} from "../src/index.js";

const SHADOW_COLUMNS = [
  "id", "seq", "event_id", "judged_at", "mode", "question_version", "backend", "model", "latency_ms", "level",
  "level_confidence", "needs_lead", "auto_action", "auto_action_confidence", "risk", "risk_score", "action_options",
  "answers", "error",
];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit FROM items ORDER BY id",
).all();

function judgment(seq: number, eventId: string): TriageShadowJudgmentInput {
  return {
    seq, eventId, questionVersion: 1, backend: "jev", model: "jev-latest", latencyMs: 120, level: "record",
    levelConfidence: 0.8, needsLead: 0.1, autoAction: null, autoActionConfidence: 0.7, risk: "low", riskScore: 0.2,
    actionOptions: [{ id: "run.transient_retry", version: 1 }], answers: { importance: { choice: "record" } }, error: null,
  };
}

describe("the v45 triage shadow migration", () => {
  it("creates the shadow table in a new database", () => {
    const db = openDb(join(tempDir("plc-v45-fresh-"), "plc.db"));
    expect(columns(db, "event_triage_shadow")).toEqual(SHADOW_COLUMNS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 45").get()).toEqual({ name: "event-triage-shadow-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(45);
    db.close();
  });

  it("upgrades a v44 database without changing any other table, row, event or lifecycle field, then reopens", () => {
    const path = join(tempDir("plc-v45-legacy-"), "plc.db");
    const legacy = openDb(path);
    const taskId = createItem(legacy, { title: "已有的工单", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: taskId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(legacy, { itemId: taskId });
    updateRun(legacy, runId, { state: "running" });
    transition(legacy, { itemId: taskId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: taskId, to: "done", actor: "user", reason: "accepted" });
    createItem(legacy, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    addInbox(legacy, { itemId: taskId, severity: "blocker", source: "structural", summary: "旧的 blocker" });
    // 退回 v44 的样子：没有影子表和它的触发器，也没有 v45 的记录。
    legacy.exec(`
      DROP TRIGGER event_triage_shadow_append_only_update;
      DROP TRIGGER event_triage_shadow_append_only_delete;
      DROP TABLE event_triage_shadow;
    `);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 45").run();
    const tablesBefore = tables(legacy);
    expect(tablesBefore).not.toContain("event_triage_shadow");
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      inbox: db.prepare("SELECT * FROM inbox ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      orders: db.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all(),
      kv: db.prepare("SELECT key, value FROM kv ORDER BY key").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version < 45 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    expect(before.events.length).toBeGreaterThan(0);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, "event_triage_shadow"].sort());
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    // 不回填：已有的事件没有影子判断。
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM event_triage_shadow").get()).toEqual({ n: 0 });
    expect(migrated.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: LATEST_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    const first = migrated.prepare("SELECT seq, event_id FROM events ORDER BY seq LIMIT 1").get() as { seq: number; event_id: string };
    expect(recordTriageShadowJudgment(migrated, judgment(first.seq, first.event_id))).toBe(true);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 45").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    expect(getTriageShadowJudgment(reopened, first.seq)).toMatchObject({ seq: first.seq, level: "record", mode: "shadow" });
    reopened.close();
  });

  it("keeps the judgments append-only: one per event, no updates, no deletes", () => {
    const db = openDb(join(tempDir("plc-v45-append-only-"), "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const event = db.prepare("SELECT seq, event_id FROM events ORDER BY seq LIMIT 1").get() as { seq: number; event_id: string };
    expect(recordTriageShadowJudgment(db, judgment(event.seq, event.event_id))).toBe(true);
    // 同一个事件第二次不写，第一次的判断不变。
    expect(recordTriageShadowJudgment(db, { ...judgment(event.seq, event.event_id), level: "tell" })).toBe(false);
    expect(getTriageShadowJudgment(db, event.seq)?.level).toBe("record");
    expect(() => db.prepare("UPDATE event_triage_shadow SET level = 'tell'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM event_triage_shadow").run()).toThrow(/append-only/);
    db.close();
  });
});

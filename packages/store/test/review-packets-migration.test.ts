// v57：核查包和逐条结论（工单详情与验收 spec 5.7、5.9、D8，工单 10；v55 留给 claude/agent-grants-8e481a，v56 是工单 09）。
// - 三张新表（由 SCHEMA 建）：review_packets（一个核查 Run 一份核查包）、review_verdict_details（escalate）、
//   review_criterion_verdicts（逐条结论）。
// - 不改任何已有的表和行，也不回填：以前的核查没有核查包，结论只有总结论和证据。
// - 结论在 review_verdicts 落定以后，结构化的部分不能再改（触发器）；核查包存下以后也不改。
// 三条路径：新库、老库升级、重新打开。工单的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addAcceptanceCriteria, createItem, createRun, getItem, getReviewPacket, getReviewVerdictDetails, LATEST_SCHEMA_VERSION, openDb,
  recordReviewPacket, SCHEMA_MIGRATION_VERSIONS, transition, updateRun, writeReviewVerdictDetails, type Db,
} from "../src/index.js";

const NEW_TABLES = ["review_criterion_verdicts", "review_packets", "review_verdict_details"];

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((row) => row.name);
const lifecycle = (db: Db) => db.prepare(
  "SELECT id, kind, stage, stage_changed_at, closed_at, plan_state, retry_limit, verification_policy, updated_at FROM items ORDER BY id",
).all();

const PACKET = {
  version: 1 as const, ticketId: 1, attemptId: 1, builtAt: "2026-10-22T00:00:00.000Z", delivery: null, criteria: [],
  brief: "b", snapshot: null, snapshotMissing: "这张工单还没有交付。", selfReport: null, recheck: null,
};
const SUMMARY = { criteria: 0, files: 0, additions: 0, deletions: 0, commits: 0, validations: 0, recheck: null };

// 一张交付了、有一次核查的工单。
function reviewed(db: Db) {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", verificationPolicy: "independent_reviewer" });
  const [criterion] = addAcceptanceCriteria(db, { itemId, texts: ["空输入返回 400"], by: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const executorRunId = createRun(db, { itemId });
  updateRun(db, executorRunId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered", runId: executorRunId });
  const reviewerRunId = createRun(db, { itemId, role: "reviewer", purpose: "review" });
  return { itemId, criterionId: criterion!.id, executorRunId, reviewerRunId };
}

describe("the v57 review packets migration", () => {
  it("creates the tables in a new database", () => {
    const db = openDb(join(tempDir("plc-v57-fresh-"), "plc.db"));
    for (const table of NEW_TABLES) expect(tables(db)).toContain(table);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 57").get()).toEqual({ name: "review-packets-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(57);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    expect(new Set(SCHEMA_MIGRATION_VERSIONS).size).toBe(SCHEMA_MIGRATION_VERSIONS.length);
    db.close();
  });

  it("keeps a packet and a settled verdict immutable, and lets a staged verdict be replaced", () => {
    const db = openDb(join(tempDir("plc-v57-immutable-"), "plc.db"));
    const { itemId, criterionId, executorRunId, reviewerRunId } = reviewed(db);
    const stored = recordReviewPacket(db, {
      runId: reviewerRunId, itemId, executorRunId, deliverySequence: null, deliverySnapshotId: null, previousRunId: null,
      packet: { ...PACKET, ticketId: itemId, attemptId: reviewerRunId }, summary: SUMMARY,
    });
    // 再存一次给的是已有的那一份。
    expect(recordReviewPacket(db, {
      runId: reviewerRunId, itemId, executorRunId, deliverySequence: null, deliverySnapshotId: null, previousRunId: null,
      packet: { ...PACKET, brief: "改过的", ticketId: itemId, attemptId: reviewerRunId }, summary: SUMMARY,
    })).toEqual(stored);
    expect(() => db.prepare("UPDATE review_packets SET packet_json='{}' WHERE run_id=?").run(reviewerRunId)).toThrow(/immutable/);

    const criteria = (result: "pass" | "fail") =>
      [{ criterionId, number: 1, revision: 1, result, evidence: "核对过" }];
    // 结论还没落定（有工作区的核查要等 Run 结束）时，核查员重交整行换掉。
    writeReviewVerdictDetails(db, { runId: reviewerRunId, itemId, executorRunId, escalate: null, criteria: criteria("fail") });
    writeReviewVerdictDetails(db, {
      runId: reviewerRunId, itemId, executorRunId, escalate: { reason: "external_approval", note: "要法务批准" }, criteria: criteria("pass"),
    });
    expect(getReviewVerdictDetails(db, reviewerRunId)).toMatchObject({
      escalate: { reason: "external_approval", note: "要法务批准" }, criteria: criteria("pass"),
    });
    db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'pass', 'ok')").run(reviewerRunId, itemId);
    expect(() => writeReviewVerdictDetails(db, { runId: reviewerRunId, itemId, executorRunId, escalate: null, criteria: criteria("fail") }))
      .toThrow(/immutable/);
    expect(() => db.prepare("UPDATE review_criterion_verdicts SET result='fail' WHERE run_id=?").run(reviewerRunId)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE review_verdict_details SET escalate_reason=NULL, escalate_note=NULL WHERE run_id=?").run(reviewerRunId))
      .toThrow(/immutable/);
    expect(() => writeReviewVerdictDetails(db, {
      runId: reviewerRunId, itemId, executorRunId, escalate: { reason: "other" as never, note: "x" }, criteria: [],
    })).toThrow();
    db.close();
  });

  it("upgrades an older database without touching existing rows, and reopens idempotently", () => {
    const path = join(tempDir("plc-v57-legacy-"), "plc.db");
    const legacy = openDb(path);
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    const { itemId, reviewerRunId } = reviewed(legacy);
    // v57 以前的核查：只有总结论和证据。
    legacy.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'fail', '没做')").run(reviewerRunId, itemId);
    // 退回 v57 以前的样子：没有三张表，也没有 v57 的记录。
    for (const table of NEW_TABLES) legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 57").run();
    const tablesBefore = tables(legacy);
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      verdicts: db.prepare("SELECT * FROM review_verdicts ORDER BY run_id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version <> 57 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    const lifecycleBefore = lifecycle(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(tables(migrated)).toEqual([...tablesBefore, ...NEW_TABLES].sort());
    expect(snapshot(migrated)).toEqual(before);
    expect(lifecycle(migrated)).toEqual(lifecycleBefore);
    expect(getItem(migrated, done)).toMatchObject({ stage: "done", closed_at: expect.any(String) });
    expect(getItem(migrated, itemId)?.stage).toBe("review");
    // 不回填：以前的核查没有核查包，也没有逐条结论。
    expect(getReviewPacket(migrated, reviewerRunId)).toBeUndefined();
    expect(getReviewVerdictDetails(migrated, reviewerRunId)).toBeUndefined();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 57").get()).toEqual({ version: 57 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 57").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(lifecycle(reopened)).toEqual(lifecycleBefore);
    reopened.close();
  });
});

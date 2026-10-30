import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { getItemTiming, markItemExecutionStarted } from "../src/timing.js";
import { appendBody, createItem, getItem, transition } from "../src/items.js";

let db: Db;
let itemId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-timing-"), "plc.db"));
  itemId = createItem(db, { title: "timing", brief: "store", createdBy: "lead" });
});

describe("item timing", () => {
  it("sets first execution once and excludes reviewer runs from active execution", () => {
    markItemExecutionStarted(db, itemId, new Date("2026-07-24T04:00:00.000Z"));
    markItemExecutionStarted(db, itemId, new Date("2026-07-24T04:10:00.000Z"));
    db.prepare(
      `INSERT INTO runs (item_id, role, runtime, purpose, state, started_at, ended_at)
       VALUES (?, 'executor', 'pi', 'execution', 'finished', ?, ?)`,
    ).run(itemId, "2026-07-24T04:00:00.000Z", "2026-07-24T04:05:00.000Z");
    db.prepare(
      `INSERT INTO runs (item_id, role, runtime, purpose, state, started_at, ended_at)
       VALUES (?, 'reviewer', 'codex', 'review', 'finished', ?, ?)`,
    ).run(itemId, "2026-07-24T04:02:00.000Z", "2026-07-24T04:09:00.000Z");
    db.prepare(
      `INSERT INTO runs (item_id, role, runtime, purpose, state, started_at)
       VALUES (?, 'executor', 'claude', 'integration', 'running', ?)`,
    ).run(itemId, "2026-07-24T04:08:00.000Z");

    expect(getItemTiming(db, itemId, new Date("2026-07-24T04:12:00.000Z"))).toMatchObject({
      firstStartedAt: "2026-07-24T04:00:00.000Z",
      completedAt: null,
      elapsedMs: 12 * 60_000,
      activeExecutionMs: 9 * 60_000,
    });
  });

  it("updates stage timing only on transitions, sets completion, and clears it on reopen", () => {
    const initial = getItem(db, itemId)!;
    appendBody(db, itemId, "ordinary update");
    expect(getItem(db, itemId)?.stage_changed_at).toBe(initial.stage_changed_at);

    // item 生于 ready（不 hold），确认那一步在这里已无对象；本用例测的是 stage 计时。
    transition(db, {
      itemId, to: "active", actor: "system", reason: "start",
      now: new Date("2026-07-24T05:01:00.000Z"),
    });
    transition(db, {
      itemId, to: "review", actor: "child", reason: "complete",
      now: new Date("2026-07-24T05:10:00.000Z"),
    });
    transition(db, {
      itemId, to: "done", actor: "system", reason: "accepted",
      now: new Date("2026-07-24T05:12:00.000Z"),
    });
    expect(getItem(db, itemId)).toMatchObject({
      stage: "done",
      closed_at: "2026-07-24T05:12:00.000Z",
      stage_changed_at: "2026-07-24T05:12:00.000Z",
    });

    // 重开（done -> active）只有 user 有资格（spec §6.4）；lead 不再能替用户重开。
    transition(db, {
      itemId, to: "active", actor: "user", reason: "reopen",
      now: new Date("2026-07-24T05:20:00.000Z"),
    });
    expect(getItem(db, itemId)).toMatchObject({
      stage: "active", closed_at: null, stage_changed_at: "2026-07-24T05:20:00.000Z",
    });
  });

  it("interprets SQLite datetime values as UTC instead of host local time", () => {
    db.prepare(
      "UPDATE items SET first_run_at = '2026-07-24 04:00:00', stage_changed_at = '2026-07-24 04:00:00' WHERE id = ?",
    ).run(itemId);
    db.prepare(
      `INSERT INTO runs (item_id, role, runtime, purpose, state, started_at)
       VALUES (?, 'executor', 'pi', 'execution', 'running', '2026-07-24 04:00:00')`,
    ).run(itemId);

    expect(getItemTiming(db, itemId, new Date("2026-07-24T04:01:00.000Z"))).toMatchObject({
      elapsedMs: 60_000,
      activeExecutionMs: 60_000,
      statusDurationMs: 60_000,
    });
  });
});

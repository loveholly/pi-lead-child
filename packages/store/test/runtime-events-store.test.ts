import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";
import { createItem, transition } from "../src/items.js";
import { createRun, getRun } from "../src/runs.js";
import {
  countDistinctToolStartedForItem,
  createRuntimeEventStore,
  runTokenUsage,
} from "../src/runtime-events.js";
import type { RuntimeEvent } from "@pi-lead-child/runtime";

function event(runId: number, seq: number): RuntimeEvent {
  return {
    type: seq === 1 ? "run.started" : "run.completed",
    runId,
    seq,
    occurredAt: `2026-07-23T12:00:0${seq}.000Z`,
    ...(seq === 1 ? { runtime: "pi" as const, model: null } : { exitCode: 0 }),
  } as RuntimeEvent;
}

describe("runtime event persistence", () => {
  it("commits SQLite first, appends normalized JSONL, and clears dirty state", () => {
    const dir = tempDir("plc-runtime-events-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    const store = createRuntimeEventStore(db, { dataDir: dir });

    expect(store.persist(event(runId, 1))).toEqual({ synced: true });
    const run = getRun(db, runId)!;
    expect(run.event_cursor).toBe("1");
    expect(run.event_log_dirty).toBe(0);
    expect(run.session_path && existsSync(run.session_path)).toBe(true);
    expect(JSON.parse(readFileSync(run.session_path!, "utf8").trim())).toMatchObject({
      runId, seq: 1, type: "run.started",
    });
  });

  it("repairs a dirty derived log from authoritative SQLite after append failure", () => {
    const dir = tempDir("plc-runtime-repair-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    const broken = createRuntimeEventStore(db, {
      dataDir: dir,
      append: () => { throw new Error("disk full"); },
    });

    expect(broken.persist(event(runId, 1))).toEqual({ synced: false });
    expect(getRun(db, runId)?.event_log_dirty).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=?").get(runId) as any).n)
      .toBe(1);

    const healthy = createRuntimeEventStore(db, { dataDir: dir });
    const rows = healthy.readAuditLog(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId, seq: 1 });
    expect(getRun(db, runId)?.event_log_dirty).toBe(0);
  });

  it("counts distinct tool starts by run and call id across executor and reviewer runs", () => {
    const dir = tempDir("plc-runtime-tool-count-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const otherItemId = createItem(db, { title: "other", brief: "b", createdBy: "system" });
    const executorId = createRun(db, { itemId, role: "executor" });
    // reviewer 的 Run 只在 review 这个 stage 上开得出来（spec §6.5）。
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "system", reason: "await review" });
    const reviewerId = createRun(db, { itemId, role: "reviewer" });
    const otherRunId = createRun(db, { itemId: otherItemId });
    const insert = db.prepare(
      `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
       VALUES (?, ?, ?, ?, '2026-07-25T08:00:00.000Z')`,
    );
    for (const [runId, seq, eventType, callId] of [
      [executorId, 1, "tool.started", "same"],
      [executorId, 2, "tool.started", "same"],
      [executorId, 3, "tool.started", "other"],
      [reviewerId, 1, "tool.started", "same"],
      [reviewerId, 2, "tool.completed", "ignored"],
      [otherRunId, 1, "tool.started", "outside"],
    ] as const) {
      insert.run(runId, seq, eventType, JSON.stringify({ callId }));
    }

    expect(countDistinctToolStartedForItem(db, itemId)).toBe(3);
  });
});

// 工单 08：工单对话的输入框按「这个会话上次用了多少 token」估算续接的成本。
describe("a run's token usage", () => {
  const usage = (runId: number, seq: number, mode: "delta" | "cumulative", totalTokens: number) => ({
    type: "usage.updated", runId, seq, occurredAt: `2026-10-16T10:00:0${seq}.000Z`,
    mode, inputTokens: totalTokens, outputTokens: 0, totalTokens, costUsd: null,
  }) as RuntimeEvent;

  it("adds delta reports, takes the largest cumulative one, and says null when nothing was reported", () => {
    const dir = tempDir("plc-run-usage-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const store = createRuntimeEventStore(db, { dataDir: dir });

    const cumulative = createRun(db, { itemId, runtime: "codex" });
    store.persist(usage(cumulative, 1, "cumulative", 120_000));
    store.persist(usage(cumulative, 2, "cumulative", 456_000));
    expect(runTokenUsage(db, cumulative)).toBe(456_000);

    const delta = createRun(db, { itemId, runtime: "pi" });
    store.persist(usage(delta, 1, "delta", 1_000));
    store.persist(usage(delta, 2, "delta", 2_500));
    expect(runTokenUsage(db, delta)).toBe(3_500);

    const silent = createRun(db, { itemId });
    store.persist(event(silent, 1));
    expect(runTokenUsage(db, silent)).toBeNull();
  });

  // 工单 #102：旧代码把 delta 的和与最大的 cumulative 相加。cumulative 是这个进程到目前的总量，它替换之前的 delta。
  // 过期会话在同一个 Run 里开新进程（新的 run.started），新进程从 0 重新累计。
  it("lets a cumulative report replace the deltas before it and adds up the processes of one run", () => {
    const dir = tempDir("plc-run-usage-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const store = createRuntimeEventStore(db, { dataDir: dir });

    const mixed = createRun(db, { itemId, runtime: "claude" });
    store.persist(usage(mixed, 1, "delta", 20));
    store.persist(usage(mixed, 2, "cumulative", 33));
    expect(runTokenUsage(db, mixed)).toBe(33);

    const restarted = createRun(db, { itemId, runtime: "claude" });
    store.persist(event(restarted, 1));
    store.persist(usage(restarted, 2, "cumulative", 100));
    store.persist({ ...event(restarted, 1), seq: 3 });
    store.persist(usage(restarted, 4, "cumulative", 30));
    expect(runTokenUsage(db, restarted)).toBe(130);
  });
});

// v51（2026-10-21）：按新口径重算修复以前写下的 token 用量（docs/adr/0001-token-usage.md，用户决定重算）。
// 三条路径：v50 的老库升级（旧格式的事件和旧 ingest 记下的数）、新库、重新打开。
// 只改旧格式的 Claude 和 pi Run；Codex 和新格式的 Claude Run 不动；事件日志之前的用量保留；工单的生命周期字段不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createRun, LATEST_SCHEMA_VERSION, migrateTokenUsageRecompute, openDb, runTokenUsage, SCHEMA_MIGRATION_VERSIONS,
  TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION, transition, type Db,
} from "../src/index.js";

type Usage = { mode: "delta" | "cumulative"; input: number; output: number; cost?: number };
type Step = "start" | Usage;

const AT = "2026-10-20T07:03:00.000Z";

function recordEvents(db: Db, runId: number, steps: Step[]): void {
  const insert = db.prepare(
    "INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)",
  );
  steps.forEach((step, index) => {
    const seq = index + 1;
    if (step === "start") {
      insert.run(runId, seq, "run.started", JSON.stringify({ type: "run.started", runId, seq, occurredAt: AT }), AT);
      return;
    }
    insert.run(runId, seq, "usage.updated", JSON.stringify({
      type: "usage.updated", mode: step.mode, inputTokens: step.input, outputTokens: step.output,
      totalTokens: step.input + step.output, costUsd: step.cost ?? null, runId, seq, occurredAt: AT,
    }), AT);
  });
}

const delta = (input: number, output: number): Usage => ({ mode: "delta", input, output });
const result = (input: number, output: number, cost: number): Usage => ({ mode: "cumulative", input, output, cost });
const call = (input: number, output: number, cost: number): Usage => ({ mode: "cumulative", input, output, cost });

// 一个 v50 的库：五张工单，每张一个 Run，事件和 items 的合计都是修复以前的代码写下的样子。
function legacyDb(): { db: Db; path: string; ids: Record<string, { item: number; run: number }> } {
  const path = join(tempDir("plc-token-recompute-"), "plc.db");
  const db = openDb(path);
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION);
  const ticket = (title: string, runtime: "claude" | "pi" | "codex", steps: Step[], totals: { tokens: number; cost: number }) => {
    const item = createItem(db, { title, brief: "b", createdBy: "user" });
    transition(db, { itemId: item, to: "active", actor: "system", reason: "test" });
    const run = createRun(db, { itemId: item, runtime });
    recordEvents(db, run, steps);
    db.prepare("UPDATE items SET total_tokens = ?, total_cost_usd = ? WHERE id = ?").run(totals.tokens, totals.cost, item);
    return { item, run };
  };
  return {
    db, path,
    ids: {
      // 旧 Claude：一次响应拆成几行，每行同样的用量；子 agent 的响应夹在主线程的两行之间；两个回合。
      // 旧 ingest：delta 合计 303 + 404 + 51 + 808 = 1566，cumulative 300 再加 110 = 1976；成本 0.5 + 0.4 = 0.9。
      // 另外 1000 是事件日志之前的用量，要保留。
      claude: ticket("claude", "claude", [
        "start",
        delta(100, 1), delta(100, 1), delta(100, 1),
        delta(200, 2), delta(50, 1), delta(200, 2),
        result(290, 10, 0.5),
        delta(400, 4), delta(400, 4),
        result(400, 10, 0.9),
      ], { tokens: 2976, cost: 0.9 }),
      // 旧 pi：每条是一次调用，标成 cumulative；旧 ingest 只记下了最大的一次（59152）。
      pi: ticket("pi", "pi", ["start", call(59_000, 152, 0.004), call(100, 50, 0.003)], { tokens: 59_152, cost: 0.004 }),
      // Codex：线程的累计，口径没变。
      codex: ticket("codex", "codex", ["start", { mode: "cumulative", input: 4900, output: 100 }], { tokens: 5000, cost: 0 }),
      // 新 adapter 写的 Claude：只有 cumulative（modelUsage），已经是对的。
      fresh: ticket("fresh claude", "claude", ["start", result(5900, 100, 1.2)], { tokens: 6000, cost: 1.2 }),
      // 旧 Claude，同一个 Run 里过期会话开了新会话（两段）。第二段的去重估计 500 比回合的 220 大。
      // 旧 ingest：delta 100 + 200 + 200 + 300 = 800，cumulative 120 再加 100 = 1020；成本 0.1 再加 0.1 = 0.2。
      restarted: ticket("restarted", "claude", [
        "start", delta(100, 0), result(110, 10, 0.1),
        "start", delta(200, 0), delta(200, 0), delta(300, 0), result(200, 20, 0.2),
      ], { tokens: 1020, cost: 0.2 }),
    },
  };
}

const totals = (db: Db, item: number) => db.prepare("SELECT total_tokens AS tokens, total_cost_usd AS cost FROM items WHERE id = ?")
  .get(item) as { tokens: number; cost: number };
const lifecycle = (db: Db) => db.prepare("SELECT id, stage, stage_changed_at, closed_at, plan_state FROM items ORDER BY id").all();
const eventCount = (db: Db) => (db.prepare("SELECT COUNT(*) AS n FROM runtime_events").get() as { n: number }).n;
const recomputed = (db: Db) => (db.prepare(
  `SELECT item_id, payload FROM activities WHERE kind = 'decision'
   AND json_extract(payload, '$.decision') = 'token_usage_recomputed' ORDER BY item_id`,
).all() as Array<{ item_id: number; payload: string }>).map((row) => ({ itemId: row.item_id, ...JSON.parse(row.payload) }));

describe("the token usage recompute (v51)", () => {
  it("recomputes old Claude and pi runs, on the ticket and in the run's event log, and leaves the rest alone", () => {
    const { db, ids } = legacyDb();
    const before = lifecycle(db);
    // 修复以前的账：runTokenUsage 按新账本读旧事件，Claude 只剩最后一个回合，pi 只剩最后一次调用。
    expect(runTokenUsage(db, ids.claude!.run)).toBe(410);
    expect(runTokenUsage(db, ids.pi!.run)).toBe(150);

    migrateTokenUsageRecompute(db);

    // Claude：去重后的估计 101 + 202 + 51 + 404 = 758，比回合之和 710 大；成本是最后一条 result 的 0.9。
    expect(totals(db, ids.claude!.item)).toEqual({ tokens: 2976 - 1976 + 758, cost: 0.9 });
    expect(runTokenUsage(db, ids.claude!.run)).toBe(758);
    // pi：两次调用加起来。
    expect(totals(db, ids.pi!.item)).toEqual({ tokens: 59_302, cost: 0.007 });
    expect(runTokenUsage(db, ids.pi!.run)).toBe(59_302);
    // 两段的 Claude：第一段 max(100, 120) = 120，第二段 max(500, 220) = 500；成本两段相加。
    expect(totals(db, ids.restarted!.item)).toEqual({ tokens: 620, cost: 0.3 });
    expect(runTokenUsage(db, ids.restarted!.run)).toBe(620);
    // 没动的。
    expect(totals(db, ids.codex!.item)).toEqual({ tokens: 5000, cost: 0 });
    expect(totals(db, ids.fresh!.item)).toEqual({ tokens: 6000, cost: 1.2 });
    expect(runTokenUsage(db, ids.fresh!.run)).toBe(6000);

    expect(recomputed(db).map((row) => [row.itemId, row.before.totalTokens, row.after.totalTokens])).toEqual([
      [ids.claude!.item, 2976, 1758],
      [ids.pi!.item, 59_152, 59_302],
      [ids.restarted!.item, 1020, 620],
    ]);
    expect(recomputed(db)[0]!.runs).toEqual([
      { runId: ids.claude!.run, runtime: "claude", before: 1976, after: 758, costBefore: 0.9, costAfter: 0.9 },
    ]);
    expect(lifecycle(db)).toEqual(before);
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION))
      .toBeTruthy();
    db.close();
  });

  it("runs once: reopening the database changes nothing", () => {
    const { db, path, ids } = legacyDb();
    db.close();
    const first = openDb(path);
    const after = { claude: totals(first, ids.claude!.item), pi: totals(first, ids.pi!.item), events: eventCount(first) };
    expect(after.claude.tokens).toBe(1758);
    first.close();
    const again = openDb(path);
    expect({ claude: totals(again, ids.claude!.item), pi: totals(again, ids.pi!.item), events: eventCount(again) }).toEqual(after);
    expect(recomputed(again)).toHaveLength(3);
    again.close();
  });

  it("is recorded on a fresh database without touching anything", () => {
    const db = openDb(join(tempDir("plc-token-recompute-fresh-"), "plc.db"));
    // 准确的最新版本只在 engine 的 kernel-schema-migration.test.ts 里写死（v52 起不再是 51）。
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION);
    expect(db.prepare("SELECT 1 AS recorded FROM schema_migrations WHERE version=?").get(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION))
      .toEqual({ recorded: 1 });
    expect(recomputed(db)).toEqual([]);
    db.close();
  });
});

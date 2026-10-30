// ── v51：按新口径重算修复以前写下的 token 用量（2026-10-21）────────────────────────
//
// 口径见 docs/adr/0001-token-usage.md：一个 Run 的 token 数是输入（含缓存读写）加输出。修复（aefa7716）以前：
//   - Claude adapter 每行 assistant 报一条 delta（同一次响应按内容块拆成几行，每行都算），result.usage 当成
//     cumulative 报（它只算一个回合的主线程）。ingest 把 delta 加起来，又把 cumulative 加上去。所以 Claude 偏高。
//   - pi adapter 把每次调用的用量当 cumulative 报，ingest 只记下最大的一次。所以 pi 偏低。
// 用户 2026-10-21 决定按新口径重算。这条迁移只碰这两种旧格式的 Run，Codex 和新格式的 Run 不动。
//
// 每个旧格式的 Run（按 run.started 分段，每段是一个进程）：
//   - Claude（事件里有 delta）：旧事件没有响应的 id，不能精确去重。按新 adapter 对旧版本的兜底规则：每段取
//     「去重后的估计」和「各回合 result 之和」里较大的那个。去重按输入 token 数：同一次响应拆出的几行输入相同，
//     不同的响应输入几乎不会相同（上下文一直在变）。成本取这段最后一条 cumulative（total_cost_usd 是进程的累计）。
//     用还留着原始输出的 4 个 Run 核对过：两个完全一致，两个偏低 0.7% 和 0.9%（估计里的输出是流开始时的值）。
//   - pi：每条用量事件是一次调用，全部加起来。
//
// 写入：
//   - 每个 Run 的事件末尾追加一条普通的 usage.updated（mode=cumulative），让 runTokenUsage 按新的账本规则得到重算的数。
//     cumulative 只替换最后一段，所以它的值是「重算的总数减去前面各段按账本算出的数」。不加新的事件类型：客户端严格校验。
//   - items.total_tokens、total_cost_usd 加上「重算的数减去旧 ingest 当时记下的数」。事件日志之前的用量（#1–#12 的早期 Run
//     没有事件）原样保留。
//   - 每张改了的工单留一条 decision 活动（token_usage_recomputed），写明前后的数和每个 Run 的变化。
// 不改 items 的生命周期字段。和 v35–v37 一样，按版本号只跑一次（schema_migrations 的 v51）。
import type { Db } from "./db.js";
import { createRunUsageLedger } from "./runtime-events.js";

export const TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION = 51;

export interface UsageEventRow {
  type: string;
  mode?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  costUsd?: unknown;
}

export interface RecomputedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

const amount = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const costOf = (event: UsageEventRow): number | null => (typeof event.costUsd === "number" ? amount(event.costUsd) : null);
const zero = (): RecomputedUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
const add = (left: RecomputedUsage, right: RecomputedUsage): RecomputedUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  totalTokens: left.totalTokens + right.totalTokens,
  costUsd: left.costUsd + right.costUsd,
});

/** 修复以前的 ingest 为这个 Run 记进 items 的数：delta 相加，cumulative 加上超过本 Run 见过的最大值的部分。 */
export function legacyIngestUsage(events: readonly UsageEventRow[]): { totalTokens: number; costUsd: number } {
  let tokens = 0;
  let cost = 0;
  let maxTokens = 0;
  let maxCost = 0;
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    const eventTokens = amount(event.totalTokens);
    const eventCost = costOf(event) ?? 0;
    if (event.mode === "cumulative") {
      tokens += Math.max(0, eventTokens - maxTokens);
      cost += Math.max(0, eventCost - maxCost);
      maxTokens = Math.max(maxTokens, eventTokens);
      maxCost = Math.max(maxCost, eventCost);
    } else {
      tokens += eventTokens;
      cost += eventCost;
    }
  }
  return { totalTokens: tokens, costUsd: cost };
}

// 按 run.started 分段：每段是一个 runtime 进程。第一段从 Run 的开头算起。
function segments(events: readonly UsageEventRow[]): UsageEventRow[][] {
  const result: UsageEventRow[][] = [[]];
  for (const event of events) {
    if (event.type === "run.started") result.push([]);
    else if (event.type === "usage.updated") result.at(-1)!.push(event);
  }
  return result;
}

function usageOf(event: UsageEventRow): RecomputedUsage {
  return {
    inputTokens: amount(event.inputTokens),
    outputTokens: amount(event.outputTokens),
    totalTokens: amount(event.totalTokens),
    costUsd: costOf(event) ?? 0,
  };
}

// 一段旧 Claude 事件的用量：去重后的估计和各回合 result 之和，取 token 数较大的那个；成本取最后一条 cumulative。
function legacyClaudeSegment(events: readonly UsageEventRow[]): RecomputedUsage {
  const seen = new Set<number>();
  let estimate = zero();
  let turns = zero();
  let cost = 0;
  for (const event of events) {
    if (event.mode === "delta") {
      const input = amount(event.inputTokens);
      if (seen.has(input)) continue;
      seen.add(input);
      estimate = add(estimate, { ...usageOf(event), costUsd: 0 });
    } else {
      turns = add(turns, { ...usageOf(event), costUsd: 0 });
      const eventCost = costOf(event);
      if (eventCost !== null) cost = eventCost;
    }
  }
  const larger = estimate.totalTokens >= turns.totalTokens ? estimate : turns;
  return { ...larger, costUsd: cost };
}

/**
 * 一个 Run 按新口径应该是多少。不是旧格式（Codex，新 adapter 写的 Claude）时为 null：它的事件按现在的账本规则已经对了。
 * Claude 的旧格式认 delta 事件：新 adapter 只写 cumulative。pi 的每条事件都是一次调用，新旧都按次相加。
 */
export function recomputedRunUsage(runtime: string, events: readonly UsageEventRow[]): RecomputedUsage | null {
  const usage = events.filter((event) => event.type === "usage.updated");
  if (!usage.length) return null;
  if (runtime === "claude") {
    if (!usage.some((event) => event.mode === "delta")) return null;
    return segments(events).map(legacyClaudeSegment).reduce(add, zero());
  }
  if (runtime === "pi") return usage.map(usageOf).reduce(add, zero());
  return null;
}

// 账本在最后一个 run.started 之前算出的数：追加的 cumulative 只替换最后一段，前面各段按账本保留。
// 规则和 createRunUsageLedger 相同（delta 加上，cumulative 替换这一段，run.started 开新的一段），
// 多算输入和输出两项，让追加的事件里三个数对得上。
function ledgerBeforeLastProcess(events: readonly UsageEventRow[]): RecomputedUsage {
  const last = events.map((event) => event.type).lastIndexOf("run.started");
  let earlier = zero();
  let current = zero();
  for (const event of last === -1 ? [] : events.slice(0, last + 1)) {
    if (event.type === "run.started") {
      earlier = add(earlier, current);
      current = zero();
    } else if (event.type === "usage.updated") {
      const usage = usageOf(event);
      if (event.mode === "delta") current = add(current, usage);
      else current = { ...usage, costUsd: costOf(event) ?? current.costUsd };
    }
  }
  return add(earlier, current);
}

function ledgerTotal(events: readonly UsageEventRow[]): { totalTokens: number; costUsd: number } {
  const ledger = createRunUsageLedger();
  for (const event of events) ledger.apply(event);
  const total = ledger.total();
  return { totalTokens: total.tokens, costUsd: total.costUsd };
}

const round = (value: number) => Math.round(value);
const roundCost = (value: number) => Math.round(value * 1e9) / 1e9;

interface RunChange {
  runId: number;
  runtime: string;
  before: number;
  after: number;
  costBefore: number;
  costAfter: number;
}

export function migrateTokenUsageRecompute(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const runs = db.prepare(
      `SELECT r.id, r.item_id, r.runtime FROM runs r
       WHERE r.runtime IN ('claude', 'pi')
         AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.run_id = r.id AND e.event_type = 'usage.updated')
       ORDER BY r.id`,
    ).all() as Array<{ id: number; item_id: number; runtime: string }>;
    const eventsOf = db.prepare(
      `SELECT seq, event_type, payload, occurred_at FROM runtime_events
       WHERE run_id = ? AND event_type IN ('run.started', 'usage.updated') AND json_valid(payload)
       ORDER BY seq`,
    );
    const lastEvent = db.prepare("SELECT MAX(seq) AS seq, MAX(occurred_at) AS at FROM runtime_events WHERE run_id = ?");
    const appendEvent = db.prepare(
      "INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, 'usage.updated', ?, ?)",
    );
    const changes = new Map<number, RunChange[]>();
    for (const run of runs) {
      const events = (eventsOf.all(run.id) as Array<{ event_type: string; payload: string }>)
        .map((row) => ({ ...(JSON.parse(row.payload) as UsageEventRow), type: row.event_type }));
      const target = recomputedRunUsage(run.runtime, events);
      if (!target) continue;
      const legacy = legacyIngestUsage(events);
      const ledger = ledgerTotal(events);
      const sameAsLegacy = round(target.totalTokens) === round(legacy.totalTokens)
        && roundCost(target.costUsd) === roundCost(legacy.costUsd);
      const sameAsLedger = round(target.totalTokens) === round(ledger.totalTokens)
        && roundCost(target.costUsd) === roundCost(ledger.costUsd);
      if (sameAsLegacy && sameAsLedger) continue;
      if (!sameAsLedger) {
        const earlier = ledgerBeforeLastProcess(events);
        const last = lastEvent.get(run.id) as { seq: number; at: string };
        const seq = last.seq + 1;
        appendEvent.run(run.id, seq, JSON.stringify({
          type: "usage.updated",
          mode: "cumulative",
          inputTokens: round(Math.max(0, target.inputTokens - earlier.inputTokens)),
          outputTokens: round(Math.max(0, target.outputTokens - earlier.outputTokens)),
          totalTokens: round(Math.max(0, target.totalTokens - earlier.totalTokens)),
          costUsd: roundCost(Math.max(0, target.costUsd - earlier.costUsd)),
          runId: run.id,
          seq,
          occurredAt: last.at,
        }), last.at);
      }
      const list = changes.get(run.item_id) ?? [];
      list.push({
        runId: run.id, runtime: run.runtime,
        before: round(legacy.totalTokens), after: round(target.totalTokens),
        costBefore: roundCost(legacy.costUsd), costAfter: roundCost(target.costUsd),
      });
      changes.set(run.item_id, list);
    }
    const itemTotals = db.prepare("SELECT total_tokens, total_cost_usd FROM items WHERE id = ?");
    const setTotals = db.prepare("UPDATE items SET total_tokens = ?, total_cost_usd = ? WHERE id = ?");
    const audit = db.prepare("INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'system', 'decision', ?)");
    for (const [itemId, list] of changes) {
      const before = itemTotals.get(itemId) as { total_tokens: number; total_cost_usd: number } | undefined;
      if (!before) continue;
      const tokens = Math.max(0, before.total_tokens + list.reduce((sum, change) => sum + change.after - change.before, 0));
      const cost = Math.max(0, roundCost(
        before.total_cost_usd + list.reduce((sum, change) => sum + change.costAfter - change.costBefore, 0),
      ));
      setTotals.run(tokens, cost, itemId);
      audit.run(itemId, JSON.stringify({
        decision: "token_usage_recomputed",
        before: { totalTokens: before.total_tokens, totalCostUsd: before.total_cost_usd },
        after: { totalTokens: tokens, totalCostUsd: cost },
        runs: list,
        reason: "按 docs/adr/0001-token-usage.md 的口径重算：输入（含缓存读写）加输出，每次响应只算一次。",
      }));
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION, "token-usage-recompute-v1");
  })();
}

import type { Db } from "./db.js";
import type { ItemTiming } from "@pi-lead-child/core";

export function timestampEpoch(value: string | null): number | null {
  if (value === null) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function markItemExecutionStarted(db: Db, itemId: number, at = new Date()): void {
  const result = db.prepare(
    `UPDATE items SET first_run_at = COALESCE(first_run_at, ?)
     WHERE id = ?`,
  ).run(at.toISOString(), itemId);
  if (result.changes === 0) throw new Error(`item ${itemId} not found`);
}

export function getItemTiming(db: Db, itemId: number, now = new Date()): ItemTiming {
  const item = db.prepare(
    "SELECT first_run_at, closed_at, stage_changed_at FROM items WHERE id = ?",
  ).get(itemId) as {
    first_run_at: string | null;
    closed_at: string | null;
    stage_changed_at: string | null;
  } | undefined;
  if (!item) throw new Error(`item ${itemId} not found`);
  const computedAt = now.toISOString();
  const computedMs = now.getTime();
  const firstStartedMs = timestampEpoch(item.first_run_at);
  const completedMs = timestampEpoch(item.closed_at);
  const statusChangedMs = timestampEpoch(item.stage_changed_at);
  const runs = db.prepare(
    `SELECT started_at, ended_at, paused_at, paused_ms FROM runs
     WHERE item_id = ? AND role = 'executor'`,
  ).all(itemId) as Array<{
    started_at: string; ended_at: string | null;
    paused_at: string | null; paused_ms: number;
  }>;
  // 暂停是用户主动行为，不是执行（spec §5.2）：墙钟里要扣掉历次累计的 paused_ms，
  // 外加当前这次还没结算进 paused_ms 的在飞暂停——只看 paused_ms 的话，正暂停着的 Run
  // 每过一秒 activeExecutionMs 就涨一秒，暂停等于没暂停。
  const activeExecutionMs = runs.reduce((total, run) => {
    const started = timestampEpoch(run.started_at);
    if (started === null) return total;
    const ended = timestampEpoch(run.ended_at) ?? computedMs;
    const pausedSince = timestampEpoch(run.paused_at);
    // 在飞暂停的终点取 ended 而非 now：Run 若已收工，多出来的墙钟不属于任何一段暂停，
    // 拿 now 去减会让耗时随时间倒着走。
    const pausedNow = pausedSince === null ? 0 : Math.max(0, ended - pausedSince);
    const paused = (run.paused_ms ?? 0) + pausedNow;
    return total + Math.max(0, ended - started - paused);
  }, 0);
  return {
    firstStartedAt: item.first_run_at,
    completedAt: item.closed_at,
    statusChangedAt: item.stage_changed_at,
    computedAt,
    elapsedMs: firstStartedMs === null ? null : Math.max(0, (completedMs ?? computedMs) - firstStartedMs),
    activeExecutionMs,
    statusDurationMs: statusChangedMs === null ? null : Math.max(0, computedMs - statusChangedMs),
  };
}

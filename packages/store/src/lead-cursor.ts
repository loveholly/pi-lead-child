// Lead 的事件游标（Lead 事件主干 spec D6，工单 04）：daemon 替 Lead 记它已经看过的最后一个事件序号，存在 kv 里。
// seq 之前（含）的事件都处理完了。settled 是 seq 后面已经处理完、但前面还有没处理完的事件挡着的序号：
// 例如一条 tell 级的事还在排队等它自己的一轮，它后面的摘要已经在别的一轮的当前局面里给过 Lead 了。
// ranges 是 settled 收紧以后的样子（工单 14）：seq 后面已经处理完的连续一段，[起, 止]，两头都含。一件事长时间挡着游标时，
// settled 会一条一条地加；daemon 把处理完的连续序号并成区间，记住的条目数只和挡着的事件数有关（lead-input.ts 的 foldSettled）。
// 游标只在 Lead 的一轮成功以后前进（daemon 的 lead-input.ts）。daemon 重启后从这里接着读，用序号去重，
// 所以没处理完的事件不丢，处理完的不重复。
import type { Db } from "./db.js";

export const LEAD_EVENT_CURSOR_KEY = "lead.event_cursor";

export type SeqRange = [from: number, to: number];

export interface LeadEventCursor {
  seq: number;
  settled: number[];
  // 工单 14 以前存的值没有这一项，读出来是空的。
  ranges: SeqRange[];
}

function isRange(value: unknown): value is SeqRange {
  return Array.isArray(value) && value.length === 2 && Number.isInteger(value[0]) && Number.isInteger(value[1])
    && (value[0] as number) <= (value[1] as number);
}

function isCursor(value: unknown): value is Omit<LeadEventCursor, "ranges"> & { ranges?: unknown } {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<LeadEventCursor>;
  return Number.isInteger(cursor.seq) && Array.isArray(cursor.settled) && cursor.settled.every(Number.isInteger)
    && (cursor.ranges === undefined || (Array.isArray(cursor.ranges) && cursor.ranges.every(isRange)));
}

/** 整理区间：只留游标后面的部分，按起点排，重叠或相接的并成一段。 */
export function normalizeSeqRanges(ranges: readonly SeqRange[], after: number): SeqRange[] {
  const clipped = ranges
    .filter(([, to]) => to > after)
    .map(([from, to]): SeqRange => [Math.max(from, after + 1), to])
    .sort((left, right) => left[0] - right[0]);
  const merged: SeqRange[] = [];
  for (const range of clipped) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function normalize(cursor: { seq: number; settled: readonly number[]; ranges?: readonly SeqRange[] }): LeadEventCursor {
  const ranges = normalizeSeqRanges(cursor.ranges ?? [], cursor.seq);
  const inRange = (seq: number) => ranges.some(([from, to]) => seq >= from && seq <= to);
  return {
    seq: cursor.seq,
    settled: [...new Set(cursor.settled)].filter((seq) => seq > cursor.seq && !inRange(seq)).sort((a, b) => a - b),
    ranges,
  };
}

/** 读游标。还没有（新库，或者工单 04 之前的库）时返回 null；存的值读不懂时也返回 null。 */
export function loadLeadEventCursor(db: Db): LeadEventCursor | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_EVENT_CURSOR_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value);
    return isCursor(value) ? normalize({ seq: value.seq, settled: value.settled, ranges: value.ranges as SeqRange[] | undefined }) : null;
  } catch {
    return null;
  }
}

export function saveLeadEventCursor(db: Db, cursor: { seq: number; settled: readonly number[]; ranges?: readonly SeqRange[] }): void {
  const value = normalize(cursor);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LEAD_EVENT_CURSOR_KEY, JSON.stringify(value));
}

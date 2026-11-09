// Lead 调度器的记录（lead-scheduler spec D12）：scheduler.* 事件。事件类型在 protocol 的 lead-scheduler.ts。
//
// 写入点（daemon 的调度器运行层）不在数据库事务里，所以这里用一个短事务包住两步：写一条 record 级的事件，再记处置
// handled_by_rule（只留档，不需要谁处理）。字符串值先截断再脱敏，不写消息原文。
import {
  redactAndCap, SCHEDULER_VALUE_MAX, schedulerEntityKey, schedulerEventKind, type SchedulerRecordEventKind,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, listEvents, setEventDisposition, type EventRecord } from "./events.js";

export type SchedulerRecordPayload = Record<string, string | number | boolean | null> & { unitId: string };

function safeValue(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return value;
  const capped = redactAndCap(value, SCHEDULER_VALUE_MAX - 1);
  return capped.truncated ? `${capped.text}…` : capped.text;
}

/** 记一条调度记录。返回事件的 seq。 */
export function recordSchedulerEvent(db: Db, kind: SchedulerRecordEventKind, payload: SchedulerRecordPayload): number {
  const clean = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, safeValue(value)]));
  return db.transaction(() => {
    const { event } = appendEvent(db, {
      source: "system",
      kind: schedulerEventKind(kind),
      entityKey: schedulerEntityKey(payload.unitId),
      level: "record",
      payload: clean,
    });
    setEventDisposition(db, event.seq, "handled_by_rule", { rule: "scheduler_telemetry" });
    return event.seq;
  })();
}

/** 一个单元的全部调度记录，按先后（plc sched trace 用）。 */
export function schedulerEventsOfUnit(db: Db, unitId: string): EventRecord[] {
  return listEvents(db, { entityKey: schedulerEntityKey(unitId), limit: 1000 });
}

/** 关联到这个 turn 的单元编号，按先后（plc sched trace 按 turn id 查时用）。 */
export function schedulerUnitsOfTurn(db: Db, turnId: string): string[] {
  const rows = db.prepare(
    `SELECT json_extract(payload, '$.unitId') AS unit, MIN(seq) AS first FROM events
     WHERE kind LIKE 'scheduler.%' AND json_valid(payload) AND json_extract(payload, '$.turnId') = ?
     GROUP BY unit ORDER BY first`,
  ).all(turnId) as Array<{ unit: unknown }>;
  return rows.flatMap((row) => (typeof row.unit === "string" ? [row.unit] : []));
}

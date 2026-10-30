import type { Db } from "./db.js";
import type { Activity, ActivityKind, Actor } from "@pi-lead-child/core";

export function addActivity(
  db: Db,
  args: {
    itemId: number; runId?: number; actor: Actor; kind: ActivityKind;
    payload: unknown; sessionCursor?: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO activities (item_id, run_id, actor, kind, payload, session_cursor)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.itemId, args.runId ?? null, args.actor, args.kind,
      JSON.stringify(args.payload), args.sessionCursor ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function listActivities(db: Db, itemId: number, limit = 100): Activity[] {
  return db
    .prepare("SELECT * FROM activities WHERE item_id = ? ORDER BY id LIMIT ?")
    .all(itemId, limit) as Activity[];
}

// 一张工单最近的 limit 条活动，按时间从旧到新排（工单 03）。Lead 的 get_ticket 用它：
// 以前取的是最早 1000 条里的最后 20 条，活动多的工单显示的是旧记录。
// skipDecisions：不算进来的 decision（例如每次打开文件都写的 delivery_file_opened，工单 07）。在 SQL 里过滤，
// 所以它们再多也挤不掉别的活动。不是 JSON 的历史记录照常算进来。
export function listRecentActivities(
  db: Db, itemId: number, limit = 20, options: { skipDecisions?: readonly string[] } = {},
): Activity[] {
  const skip = options.skipDecisions ?? [];
  const skipClause = skip.length
    ? ` AND NOT (kind = 'decision' AND COALESCE(`
      + `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.decision') END IN (${skip.map(() => "?").join(", ")}), 0))`
    : "";
  return db.prepare(
    `SELECT * FROM (
       SELECT * FROM activities WHERE item_id = ?${skipClause} ORDER BY id DESC LIMIT ?
     ) ORDER BY id`,
  ).all(itemId, ...skip, limit) as Activity[];
}

export function listActivitiesAfter(
  db: Db,
  itemId: number,
  opts?: { afterId?: number; limit?: number },
): Activity[] {
  return db.prepare(
    `SELECT * FROM activities
     WHERE item_id = ? AND id > ?
     ORDER BY id LIMIT ?`,
  ).all(itemId, opts?.afterId ?? 0, opts?.limit ?? 100) as Activity[];
}
// 账本纪律：本模块永不提供 UPDATE/DELETE。

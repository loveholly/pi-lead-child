// 最近一次心跳巡检完成的时间。存在 kv 里，daemon 重启以后顶栏照样写得出"最近巡检 HH:MM"。
import type { Db } from "./db.js";

const LAST_PATROL_KEY = "lead_last_patrol_at";

export function saveLastPatrolAt(db: Db, at: Date): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_PATROL_KEY, at.toISOString());
}

export function loadLastPatrolAt(db: Db): Date | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LAST_PATROL_KEY) as { value: string } | undefined;
  if (!row) return null;
  const at = new Date(row.value);
  return Number.isNaN(at.getTime()) ? null : at;
}

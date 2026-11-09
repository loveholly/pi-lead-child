// 「Lead 忙时你发的消息」怎么放（protocol 的 busy-placement.ts）。存在 kv 的 lead.busy-placement，一行 JSON：{ placement }。
// 所有设备共用这一份。不放 config.json：改它要走操作层记账。
// 这里只读写库：权限和通知在 engine 的 ui-actions/busy-placement.ts。
// 没有这一行、或者读到的值坏了（手改、截断、不认识的值）时不抛错，按缺省的排队算。
import { DEFAULT_BUSY_PLACEMENT, isBusyPlacement, type BusyPlacement, type BusyPlacementDto } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const BUSY_PLACEMENT_KEY = "lead.busy-placement";

/** 现在的设置。没存过或者坏了时是缺省的 followUp。 */
export function getBusyPlacement(db: Db): BusyPlacementDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(BUSY_PLACEMENT_KEY) as { value: string } | undefined;
  if (!row) return { placement: DEFAULT_BUSY_PLACEMENT };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    const placement = parsed !== null && typeof parsed === "object" ? (parsed as { placement?: unknown }).placement : undefined;
    return { placement: isBusyPlacement(placement) ? placement : DEFAULT_BUSY_PLACEMENT };
  } catch {
    return { placement: DEFAULT_BUSY_PLACEMENT };
  }
}

/** 写入设置（engine 的 busy_placement.set 调它）。 */
export function writeBusyPlacement(db: Db, placement: BusyPlacement): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(BUSY_PLACEMENT_KEY, JSON.stringify({ placement }));
}

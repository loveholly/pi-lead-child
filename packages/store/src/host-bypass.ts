// 「用户本人发话时免沙箱」开关（protocol 的 host-bypass.ts）。存在 kv 的 lead.host-bypass，一行 JSON：
// { enabled, bindingId, enabledAt, reason }。不放 config.json：Lead 本来就写不了它，而且 kv 的改动能走操作层记账。
// 这里只读写库：权限、事件和通知在 engine 的 host-bypass.ts。
// 开关没有时限：打开以后一直开着，直到用户或 Lead 关掉（用户 2026-11-10）。
// 旧行：2026-11-05 到 11-10 的版本还存一个 until（打开时选的时长到点的时间）。读这种行时：过了 until 的按关算；
// 没过的照旧开到 until 为止（用户当时只同意了那么久），不会因为去掉时限而变成一直开着。新写的行不带 until。
// 读到的值坏了（手改、截断）时不抛错，按关算。
import { DEFAULT_HOST_BYPASS, type HostBypassDto } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const HOST_BYPASS_KEY = "lead.host-bypass";

// kv 里存的那一份。enabled 是写入时的值。
export interface StoredHostBypass {
  enabled: boolean;
  bindingId: number | null;
  enabledAt: string | null;
  reason: string | null;
  // 只有旧版本写的行有：到点的时间。新写的行为 null。旧行里写了 until 但不是合法时间的，按已经过了算。
  until: string | null;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/** kv 里存的原样（整理过）。没有这一行、或者坏了时是关。 */
export function readStoredHostBypass(db: Db): StoredHostBypass {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(HOST_BYPASS_KEY) as { value: string } | undefined;
  let stored: Record<string, unknown> = {};
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  // 旧行里有 until 这个键但值坏了：取一个早就过了的时间，读出来是关。
  const until = "until" in stored && stored.until !== null ? (isoOrNull(stored.until) ?? new Date(0).toISOString()) : null;
  return {
    enabled: stored.enabled === true,
    bindingId: typeof stored.bindingId === "number" && Number.isSafeInteger(stored.bindingId) ? stored.bindingId : null,
    enabledAt: isoOrNull(stored.enabledAt),
    reason: typeof stored.reason === "string" ? stored.reason : null,
    until,
  };
}

/** 现在开没开：kv 里是开的，而且不是过了 until 的旧行。 */
export function hostBypassOn(stored: StoredHostBypass, now: Date): boolean {
  return stored.enabled && (stored.until === null || Date.parse(stored.until) > now.getTime());
}

/** 现在的开关。关着时只留最近一次的原因。 */
export function getHostBypass(db: Db, now: Date): HostBypassDto {
  const stored = readStoredHostBypass(db);
  if (!hostBypassOn(stored, now)) return { ...DEFAULT_HOST_BYPASS, reason: stored.reason };
  return { enabled: true, enabledAt: stored.enabledAt, bindingId: stored.bindingId, reason: stored.reason };
}

/** 写入开关（engine 的 enableHostBypass、disableHostBypass 调它）。不写 until。 */
export function writeHostBypass(db: Db, state: Omit<StoredHostBypass, "until">): void {
  const value = { enabled: state.enabled, bindingId: state.bindingId, enabledAt: state.enabledAt, reason: state.reason };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(HOST_BYPASS_KEY, JSON.stringify(value));
}

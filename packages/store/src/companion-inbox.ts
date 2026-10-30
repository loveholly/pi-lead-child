// 收件箱（companion）的两件服务端事实：你上次看收件箱是什么时候，和 Lead 自己处理掉的事。
// 「Lead 已处理」来自 Jarvis 模式的 record_disposition：Lead 处理完一件或几件事，记一次处置。
// 收件箱按一次处置合成一条：#66 的核查失败了 9 次，Lead 一次处理掉，就是一条，不是 9 条。
import { presentUserFacingCheckpoint } from "./attention.js";
import type { Db } from "./db.js";

const INBOX_SEEN_KEY = "companion_inbox_seen_at";

/** 你上次看收件箱的时间（ISO）。没看过时为 null。 */
export function inboxSeenAt(db: Db): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(INBOX_SEEN_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function markInboxSeen(db: Db, at: Date = new Date()): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(INBOX_SEEN_KEY, at.toISOString());
}

export interface LeadHandledEntry {
  /** 这次处置包含的事件（inbox 行 id），按 id 排。 */
  eventIds: number[];
  itemId: number | null;
  /** 出了什么事：最早那条事件的摘要。 */
  problem: string;
  /** Lead 写的处置理由。 */
  reason: string;
  /** Lead 写的根因、做了什么、以后会怎样。Lead 只写了理由时都是 null。 */
  cause: string | null;
  action: string | null;
  followUp: string | null;
  handledAt: string;
}

type DispositionPayload = {
  disposition?: { kind?: string; reason?: string; at?: string; cause?: string; action?: string; followUp?: string };
};

/** since 之后 Lead 记为「自己处理了」（handled）的事，按处置合并，新的在前。 */
export function listLeadHandled(db: Db, args: { since: string; limit?: number }): LeadHandledEntry[] {
  const rows = db.prepare(
    `SELECT id, item_id, summary, payload FROM inbox
     WHERE json_extract(payload, '$.disposition.kind') = 'handled'
       AND json_extract(payload, '$.disposition.at') >= ?
     ORDER BY id`,
  ).all(args.since) as { id: number; item_id: number | null; summary: string; payload: string }[];
  const entries = new Map<string, LeadHandledEntry>();
  for (const row of rows) {
    const disposition = (JSON.parse(row.payload || "{}") as DispositionPayload).disposition ?? {};
    const at = disposition.at ?? "";
    const reason = disposition.reason ?? "";
    // 一次 record_disposition 调用写下同一个时间和同一段理由。
    const key = `${row.item_id ?? ""}|${at}|${reason}`;
    const existing = entries.get(key);
    if (existing) {
      existing.eventIds.push(row.id);
      continue;
    }
    entries.set(key, {
      eventIds: [row.id],
      itemId: row.item_id,
      problem: row.summary,
      reason,
      cause: disposition.cause ?? null,
      action: disposition.action ?? null,
      followUp: disposition.followUp ?? null,
      handledAt: at,
    });
  }
  return [...entries.values()]
    .sort((left, right) => right.handledAt.localeCompare(left.handledAt) || right.eventIds[0]! - left.eventIds[0]!)
    .slice(0, args.limit ?? 20);
}

/** 阻塞的工单为什么在等你：最新那条阻塞记录的说明（去掉调用栈）。没有记录时为 null。 */
export function latestBlockedReason(db: Db, itemId: number): string | null {
  const row = db.prepare(
    "SELECT kind, title, summary, next_step FROM checkpoints WHERE item_id = ? AND kind = 'blocked' ORDER BY id DESC LIMIT 1",
  ).get(itemId) as { kind: string; title: string; summary: string; next_step: string | null } | undefined;
  if (!row) return null;
  const presented = presentUserFacingCheckpoint({ kind: row.kind, title: row.title, summary: row.summary, nextStep: row.next_step });
  return presented.summary || presented.title || null;
}

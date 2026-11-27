// shadow 按对话复用的会话和工作记录（工单 #588，schema.ts 的 SHADOW_CONVERSATIONS_SCHEMA）。
// 这里只读写两张表；什么时候复用、什么时候重开、记录怎么排版，在 daemon 和 lead 的 shadow/。
//   - 会话行：一段对话（会话分组键）一行。session_file 是 pi 的会话文件；config_version 是建会话时的配置版本
//     （系统提示词、常设指令、核心记忆、交接说明、shadow 的模型和工具）；last_message_at 是这段对话最近一条交给 shadow 的消息的时刻。
//   - 工作记录：只加不删。open 是没处理完的事，resolved 的 ref 写它处理完的那条 open 的编号。
//   - 主会话的游标（lead_seen_entry）：主会话已经看到这段对话的第几条记录。主会话压缩以后清零（resetShadowWorkCursors）。
import type { Db } from "./db.js";

export const SHADOW_WORK_KINDS = ["attachment", "decision", "reply", "open", "resolved"] as const;
export type ShadowWorkKind = typeof SHADOW_WORK_KINDS[number];

/** 一条记录的文字最多多少字（表的 CHECK 是 8000）。超过的截断，结尾写「…」。 */
export const SHADOW_WORK_TEXT_MAX = 4_000;

export interface ShadowConversationRow {
  sessionKey: string;
  sessionFile: string | null;
  configVersion: string | null;
  openedAt: string | null;
  lastMessageAt: string | null;
  leadSeenEntry: number;
  updatedAt: string;
}

export interface ShadowWorkEntry {
  id: number;
  sessionKey: string;
  kind: ShadowWorkKind;
  ref: string | null;
  text: string;
  eventSeq: number | null;
  createdAt: string;
}

interface ConversationDbRow {
  session_key: string; session_file: string | null; config_version: string | null; opened_at: string | null;
  last_message_at: string | null; lead_seen_entry: number; updated_at: string;
}

interface EntryDbRow { id: number; session_key: string; kind: string; ref: string | null; text: string; event_seq: number | null; created_at: string }

const conversationOf = (row: ConversationDbRow): ShadowConversationRow => ({
  sessionKey: row.session_key, sessionFile: row.session_file, configVersion: row.config_version, openedAt: row.opened_at,
  lastMessageAt: row.last_message_at, leadSeenEntry: row.lead_seen_entry, updatedAt: row.updated_at,
});

const entryOf = (row: EntryDbRow): ShadowWorkEntry => ({
  id: row.id, sessionKey: row.session_key, kind: row.kind as ShadowWorkKind, ref: row.ref, text: row.text,
  eventSeq: row.event_seq, createdAt: row.created_at,
});

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function getShadowConversation(db: Db, sessionKey: string): ShadowConversationRow | null {
  const row = db.prepare("SELECT * FROM shadow_conversations WHERE session_key = ?").get(sessionKey) as ConversationDbRow | undefined;
  return row ? conversationOf(row) : null;
}

/** 记下这段对话的会话：新开（opened 给了时）或者接着用。只改给了的字段。 */
export function saveShadowConversation(db: Db, sessionKey: string, change: {
  sessionFile?: string | null; configVersion?: string | null; openedAt?: string | null; lastMessageAt?: string | null;
}, at: Date = new Date()): ShadowConversationRow {
  const now = at.toISOString();
  db.prepare("INSERT INTO shadow_conversations (session_key, updated_at) VALUES (?, ?) ON CONFLICT(session_key) DO NOTHING").run(sessionKey, now);
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  const column = { sessionFile: "session_file", configVersion: "config_version", openedAt: "opened_at", lastMessageAt: "last_message_at" } as const;
  for (const [field, name] of Object.entries(column) as Array<[keyof typeof column, string]>) {
    if (change[field] === undefined) continue;
    sets.push(`${name} = ?`);
    params.push(change[field]);
  }
  db.prepare(`UPDATE shadow_conversations SET ${sets.join(", ")} WHERE session_key = ?`).run(...params, sessionKey);
  return getShadowConversation(db, sessionKey)!;
}

/** 加几条工作记录。text 是空的跳过；太长的截断。返回加上的几条。 */
export function appendShadowWork(db: Db, sessionKey: string, entries: ReadonlyArray<{
  kind: ShadowWorkKind; ref?: string | null; text: string; eventSeq?: number | null;
}>, at: Date = new Date()): ShadowWorkEntry[] {
  const insert = db.prepare(
    "INSERT INTO shadow_work_entries (session_key, kind, ref, text, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const added: ShadowWorkEntry[] = [];
  db.transaction(() => {
    for (const entry of entries) {
      const text = entry.text.trim();
      if (!text || !(SHADOW_WORK_KINDS as readonly string[]).includes(entry.kind)) continue;
      const ref = entry.ref ? clip(entry.ref, 300) : null;
      const result = insert.run(sessionKey, entry.kind, ref, clip(text, SHADOW_WORK_TEXT_MAX), entry.eventSeq ?? null, at.toISOString());
      added.push({
        id: Number(result.lastInsertRowid), sessionKey, kind: entry.kind, ref, text: clip(text, SHADOW_WORK_TEXT_MAX),
        eventSeq: entry.eventSeq ?? null, createdAt: at.toISOString(),
      });
    }
  })();
  return added;
}

/** 这段对话的工作记录，按先后。afterId 给了时只要它后面的。 */
export function listShadowWork(db: Db, sessionKey: string, afterId = 0): ShadowWorkEntry[] {
  return (db.prepare("SELECT * FROM shadow_work_entries WHERE session_key = ? AND id > ? ORDER BY id").all(sessionKey, afterId) as EntryDbRow[])
    .map(entryOf);
}

/** 主会话已经看到这段对话的第几条记录。 */
export function markShadowWorkSeen(db: Db, sessionKey: string, entryId: number, at: Date = new Date()): void {
  db.prepare("INSERT INTO shadow_conversations (session_key, updated_at) VALUES (?, ?) ON CONFLICT(session_key) DO NOTHING")
    .run(sessionKey, at.toISOString());
  db.prepare("UPDATE shadow_conversations SET lead_seen_entry = MAX(lead_seen_entry, ?) WHERE session_key = ?").run(entryId, sessionKey);
}

/** 主会话的上下文压缩了：它不一定还记得看过的工作记录，下次碰到每段对话时带完整记录。返回清了几行。 */
export function resetShadowWorkCursors(db: Db): number {
  return db.prepare("UPDATE shadow_conversations SET lead_seen_entry = 0 WHERE lead_seen_entry > 0").run().changes;
}

// 代回复风格（protocol 的 reply-style.ts）。存在 kv 的 channel.reply_style，一行 JSON。
// 这里只读写库：校验、授权和主人操作在 engine 的 reply-style.ts。
// 读到的值坏了（手改、截断）时不抛错：按没写算，Lead 照常用缺省的写法。
// 另外是提炼要读的数据：一个来源里最近 N 天用户本人说的话（events 表里 role=self_reply 的入站事件）。
import {
  DEFAULT_REPLY_STYLE, REPLY_STYLE_TEXT_MAX_LENGTH, normalizeReplyStyleText, replyStyleLength,
  type ReplyStyleAuthor, type ReplyStyleDto,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const REPLY_STYLE_KEY = "channel.reply_style";

/** 现在的代回复风格。从没写过时是空的。 */
export function getReplyStyle(db: Db): ReplyStyleDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(REPLY_STYLE_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_REPLY_STYLE };
  let stored: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    stored = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    stored = {};
  }
  const text = typeof stored.text === "string" ? normalizeReplyStyleText(stored.text) : "";
  return {
    text: replyStyleLength(text) <= REPLY_STYLE_TEXT_MAX_LENGTH ? text : "",
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
  };
}

/** 写的人和 Lead 的提示词用的文字。读不到（还没有 kv 表的库、库出错）时是空的。 */
export function replyStyleText(db: Db): string {
  try {
    return getReplyStyle(db).text;
  } catch {
    return "";
  }
}

/** 写入整理好、校验过的值（engine 的 updateReplyStyle 调它）。返回写入以后的值。 */
export function writeReplyStyle(db: Db, text: string, meta: { by: ReplyStyleAuthor; at: Date }): ReplyStyleDto {
  const style: ReplyStyleDto = { text, updatedAt: meta.at.toISOString(), updatedBy: meta.by };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(REPLY_STYLE_KEY, JSON.stringify(style));
  return style;
}

/** 用户本人在来源里说的一句话。 */
export interface OwnChannelMessage {
  seq: number;
  at: string;
  // 对话的对象键，例如 slack:D123:main。
  conversation: string;
  // 对话的名字，例如 @Oliver、#proj-x。没有时为 null。
  conversationLabel: string | null;
  audience: "direct" | "group" | "channel" | null;
  inThread: boolean;
  text: string;
}

/**
 * 一个来源里 since 以后用户本人说的话，新的在前，最多 limit 条。只取 role=self_reply：
 * 系统替用户发出去、又被来源推回来的（echo）不算，否则提炼会学到助手自己写的话。
 */
export function ownChannelMessages(db: Db, input: { source: string; since: Date; limit: number }): OwnChannelMessage[] {
  const rows = db.prepare(
    `SELECT seq, occurred_at, entity_key, payload FROM events
      WHERE source = ? AND occurred_at >= ? AND entity_key IS NOT NULL AND json_valid(payload)
        AND json_extract(payload, '$.role') = 'self_reply'
      ORDER BY occurred_at DESC, seq DESC LIMIT ?`,
  ).all(input.source, input.since.toISOString(), Math.max(0, Math.trunc(input.limit))) as Array<{
    seq: number; occurred_at: string; entity_key: string; payload: string;
  }>;
  const messages: OwnChannelMessage[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) continue;
    const audience = payload.audience === "direct" || payload.audience === "group" || payload.audience === "channel" ? payload.audience : null;
    messages.push({
      seq: row.seq,
      at: row.occurred_at,
      conversation: row.entity_key,
      conversationLabel: typeof payload.laneLabel === "string" && payload.laneLabel.trim() ? payload.laneLabel.trim() : null,
      audience,
      inThread: typeof payload.threadTs === "string" && payload.threadTs.length > 0,
      text,
    });
  }
  return messages;
}

/**
 * 这些对话里 since 以后别人的名字（发信人的显示名）。只用来从提炼结果里去掉人名，不交给模型。
 */
export function channelParticipantNames(db: Db, input: { source: string; conversations: readonly string[]; since: Date }): string[] {
  if (!input.conversations.length) return [];
  const names = new Set<string>();
  const select = db.prepare(
    `SELECT DISTINCT json_extract(payload, '$.sender.name') AS name FROM events
      WHERE source = ? AND entity_key = ? AND occurred_at >= ? AND json_valid(payload)`,
  );
  for (const conversation of new Set(input.conversations)) {
    for (const row of select.all(input.source, conversation, input.since.toISOString()) as Array<{ name: unknown }>) {
      if (typeof row.name === "string" && row.name.trim()) names.add(row.name.trim());
    }
  }
  return [...names];
}

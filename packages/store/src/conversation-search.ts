import {
  CONVERSATION_SEARCH_COUNT_CAP, findInText, snippetAround, type ConversationSearchHit, type ConversationSearchMode,
  type ConversationSearchResult,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

// 会话记录搜索（工单 #339）。只读：只有 SELECT，不碰账本的写入路径。
//
// 在 daemon 的库里一行一行读（better-sqlite3 的 iterate，内存里同一时间只有一行），只留命中的一小份。
// 精确模式先让 SQLite 用 instr 筛掉不含搜索词的行，模糊模式要读每一行再匹配。
// 一次最多数 CONVERSATION_SEARCH_COUNT_CAP 条命中；客户端按 offset、limit 一页一页取。

// 一条消息只看开头这么多字：模糊匹配的代价和长度成正比，超长的工具输出不值得为它拖慢一次搜索。
const SEARCHABLE_CHARS = 20_000;

export interface ConversationSearchQuery {
  query: string;
  mode: ConversationSearchMode;
  wholeWord?: boolean;
  /** 不给时搜 Lead 的会话（不属于任何工单的轮次）；给了就搜这张工单的对话。 */
  itemId?: number;
  offset?: number;
  limit?: number;
  /** 命中片段前后各留多少字。缺省是 CONVERSATION_SNIPPET_RADIUS。 */
  snippetRadius?: number;
}

interface TurnTextRow {
  id: string;
  origin_kind: string;
  created_at: string;
  user_text: string;
  assistant_text: string;
}

const SIDES = [
  { role: "user", column: "user_text" },
  { role: "assistant", column: "assistant_text" },
] as const;

export function searchConversation(db: Db, input: ConversationSearchQuery): ConversationSearchResult {
  const query = input.query.trim();
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  if (!query) return { hits: [], total: 0, totalCapped: false, offset };

  const params: unknown[] = [];
  const conditions = [input.itemId === undefined ? "item_id IS NULL" : "item_id = ?"];
  if (input.itemId !== undefined) params.push(input.itemId);
  const text = (column: string) => `(${column} <> '')`;
  if (input.mode === "exact") {
    // instr 区分大小写，和精确模式一致。搜索词当参数传，不拼进 SQL。
    conditions.push("(instr(user_text, ?) > 0 OR instr(assistant_text, ?) > 0)");
    params.push(query, query);
  } else {
    conditions.push(`(${text("user_text")} OR ${text("assistant_text")})`);
  }
  const rows = db.prepare(
    `SELECT id, origin_kind, created_at, user_text, assistant_text FROM channel_turns
     WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC`,
  ).iterate(...params) as Iterable<TurnTextRow>;

  const hits: ConversationSearchHit[] = [];
  let total = 0;
  let capped = false;
  for (const row of rows) {
    for (const side of SIDES) {
      const full = row[side.column];
      if (!full) continue;
      const body = full.length > SEARCHABLE_CHARS ? full.slice(0, SEARCHABLE_CHARS) : full;
      const match = findInText(body, query, { mode: input.mode, ...(input.wholeWord ? { wholeWord: true } : {}) });
      if (!match) continue;
      total += 1;
      hits.push({
        turnId: row.id, role: side.role, originKind: row.origin_kind, createdAt: row.created_at,
        ...snippetAround(body, match, input.snippetRadius), score: match.score,
      });
    }
    if (total >= CONVERSATION_SEARCH_COUNT_CAP) {
      capped = true;
      break;
    }
  }
  // 精确模式按时间从新到旧（读出来已经是这个顺序）；模糊模式相关度高的在前，同分的新的在前（sort 是稳定的）。
  if (input.mode === "fuzzy") hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(offset, offset + limit), total, totalCapped: capped, offset };
}

export interface ConversationCandidate {
  turnId: string;
  role: "user" | "assistant";
  originKind: string;
  createdAt: string;
  excerpt: string;
}

const EXCERPT_CHARS = 200;
const flat = (value: string) => value.replace(/\s+/g, " ").trim();

/** 最近的 limit 条消息（你发的和回答的），从新到旧；每条只留开头一段。 */
export function recentConversationMessages(db: Db, input: { itemId?: number; limit: number }): ConversationCandidate[] {
  const where = input.itemId === undefined ? "item_id IS NULL" : "item_id = ?";
  const rows = db.prepare(
    `SELECT id, origin_kind, created_at, substr(user_text, 1, ${EXCERPT_CHARS * 2}) AS user_text,
            substr(assistant_text, 1, ${EXCERPT_CHARS * 2}) AS assistant_text
     FROM channel_turns WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...(input.itemId === undefined ? [] : [input.itemId]), Math.ceil(input.limit / 2)) as TurnTextRow[];
  const out: ConversationCandidate[] = [];
  for (const row of rows) {
    for (const side of [...SIDES].reverse()) {
      const text = flat(row[side.column]);
      if (text) {
        out.push({
          turnId: row.id, role: side.role, originKind: row.origin_kind, createdAt: row.created_at,
          excerpt: text.slice(0, EXCERPT_CHARS),
        });
      }
    }
  }
  return out.slice(0, input.limit);
}

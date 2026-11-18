import { Type, type Static, type TProperties } from "typebox";

// 会话记录搜索（工单 #339）。只读：只从已有的轮次里找文字，不写任何东西。
//
// daemon 在自己的库里逐行读轮次、逐条匹配，只把命中的一小页交给客户端（GET /v1/conversation/search）。
// 客户端不用把全部消息取下来。这个文件放两边共用的东西：回答的形状，和匹配文字的纯函数。

export const CONVERSATION_SEARCH_MODES = ["exact", "fuzzy"] as const;
export type ConversationSearchMode = (typeof CONVERSATION_SEARCH_MODES)[number];

/** 搜索词最长这么多字：再长的当作写错了。 */
export const CONVERSATION_SEARCH_QUERY_MAX = 200;
/** 「让 agent 找」的描述最长这么多字。 */
export const CONVERSATION_AGENT_QUERY_MAX = 300;
/** 一次最多回这么多条命中。 */
export const CONVERSATION_SEARCH_LIMIT_MAX = 100;
/** 数命中条数时最多数到这里；到了就说「还有更多」。 */
export const CONVERSATION_SEARCH_COUNT_CAP = 2_000;
/** 命中片段里，命中的文字前后各留这么多字。 */
export const CONVERSATION_SNIPPET_RADIUS = 30;
/** 「让 agent 找」最多回这么多条候选。 */
export const CONVERSATION_AGENT_RESULT_MAX = 10;

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ConversationSearchHitSchema = StrictObject({
  /** 命中的那一轮。客户端用它找到消息。 */
  turnId: Type.String(),
  /** 命中的是你发的话（user），还是回答（assistant）。 */
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  /** 这一轮的来源（paired:…、slack:… 之类），客户端用它写发送者。 */
  originKind: Type.String(),
  createdAt: Type.String(),
  /** 命中片段：命中的文字前后各约 30 字。 */
  before: Type.String(),
  matched: Type.String(),
  after: Type.String(),
  /** 相关度，0 到 1。精确模式都是 1。 */
  score: Type.Number(),
});
export type ConversationSearchHit = Static<typeof ConversationSearchHitSchema>;

export const ConversationSearchResultSchema = StrictObject({
  hits: Type.Array(ConversationSearchHitSchema),
  /** 命中的消息一共多少条（数到 CONVERSATION_SEARCH_COUNT_CAP 为止）。 */
  total: Type.Integer({ minimum: 0 }),
  /** total 数到上限就停了：实际还有更多。 */
  totalCapped: Type.Boolean(),
  offset: Type.Integer({ minimum: 0 }),
});
export type ConversationSearchResult = Static<typeof ConversationSearchResultSchema>;

export const ConversationAgentCandidateSchema = StrictObject({
  turnId: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  originKind: Type.String(),
  createdAt: Type.String(),
  /** 这条消息开头的一段，给人认出来。 */
  excerpt: Type.String(),
  /** 一句理由：为什么它像要找的那条。回退到关键词时是空串。 */
  reason: Type.String(),
});
export type ConversationAgentCandidate = Static<typeof ConversationAgentCandidateSchema>;

export const ConversationAgentSearchResultSchema = StrictObject({
  candidates: Type.Array(ConversationAgentCandidateSchema),
  /** model：模型挑的。keywords：模型不能用或超时，用关键词结果代替（界面要说明）。 */
  source: Type.Union([Type.Literal("model"), Type.Literal("keywords")]),
});
export type ConversationAgentSearchResult = Static<typeof ConversationAgentSearchResultSchema>;

export interface TextMatchOptions {
  mode: ConversationSearchMode;
  /** 精确模式：只认整个词（前后不能紧挨着字母、数字或下划线）。 */
  wholeWord?: boolean;
}

/** 在原文里的位置：start 含，end 不含。 */
export interface TextMatch {
  start: number;
  end: number;
  score: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

// 模糊模式里，几个词按顺序出现、中间最多隔这么多字（中间夹了代码块、空行也算）。
const TOKEN_GAP_MAX = 400;
// 容错：搜索词至少这么长才允许错字；每 3 个字允许错 1 个（两个字换了位置算错 2 个），最多 2 个。
const APPROX_MIN_LENGTH = 4;
const APPROX_MAX_ERRORS = 2;

/**
 * 把原文整理成模糊搜索用的样子：小写、连续的空白（含换行）合成一个空格。
 * map[i] 是整理后第 i 个字在原文里的位置，所以命中可以画回原文。
 */
export function normalizeForFuzzy(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  // 一串空白里第一个空白的位置；-1 是前面没有待写的空白。
  let spaceAt = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (/\s/u.test(char)) {
      if (out.length > 0 && spaceAt < 0) spaceAt = i;
      continue;
    }
    if (spaceAt >= 0) {
      out += " ";
      map.push(spaceAt);
      spaceAt = -1;
    }
    const lower = char.toLowerCase();
    out += lower.length === 1 ? lower : char;
    map.push(i);
  }
  return { text: out, map };
}

function exactMatch(text: string, query: string, wholeWord: boolean): TextMatch | null {
  let from = 0;
  for (;;) {
    const at = text.indexOf(query, from);
    if (at < 0) return null;
    const end = at + query.length;
    if (!wholeWord || (!isWordChar(text[at - 1]) && !isWordChar(text[end]))) return { start: at, end, score: 1 };
    from = at + 1;
  }
}

// 近似子串：在 text 里找和 query 最像的一段，编辑距离（错字、少字、多字）不超过 maxErrors。Sellers 算法。
function approximateMatch(text: string, query: string, maxErrors: number): { start: number; end: number; errors: number } | null {
  const m = query.length;
  // 用两列滚动：prev[j] 是 query 前 j 个字对到 text 当前位置的最小代价，starts 记这一段从哪里开始。
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let prevStart = new Array<number>(m + 1).fill(0);
  let best: { start: number; end: number; errors: number } | null = null;
  for (let i = 1; i <= text.length; i += 1) {
    const cur = new Array<number>(m + 1);
    const curStart = new Array<number>(m + 1);
    cur[0] = 0;
    curStart[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = text[i - 1] === query[j - 1] ? 0 : 1;
      let value = prev[j - 1]! + cost;
      let start = prevStart[j - 1]!;
      if (prev[j]! + 1 < value) { value = prev[j]! + 1; start = prevStart[j]!; }
      if (cur[j - 1]! + 1 < value) { value = cur[j - 1]! + 1; start = curStart[j - 1]!; }
      cur[j] = value;
      curStart[j] = start;
    }
    if (cur[m]! <= maxErrors && (best === null || cur[m]! < best.errors)) {
      best = { start: curStart[m]!, end: i, errors: cur[m]! };
      if (best.errors === 0) break;
    }
    prev = cur;
    prevStart = curStart;
  }
  return best;
}

// 搜索词的二字组有三分之二以上不在文字里，就不可能只错一两个字：不用跑慢的近似匹配。
function sharesEnoughBigrams(text: string, query: string): boolean {
  if (query.length < 2) return true;
  const seen = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) seen.add(text.slice(i, i + 2));
  let shared = 0;
  const total = query.length - 1;
  for (let i = 0; i < total; i += 1) if (seen.has(query.slice(i, i + 2))) shared += 1;
  return shared * 3 >= total;
}

function fuzzyMatch(text: string, rawQuery: string): TextMatch | null {
  const query = normalizeForFuzzy(rawQuery).text;
  if (!query) return null;
  const haystack = normalizeForFuzzy(text);
  const toOriginal = (start: number, end: number, score: number): TextMatch => ({
    start: haystack.map[start] ?? 0,
    end: (haystack.map[end - 1] ?? text.length - 1) + 1,
    score,
  });

  // 1. 忽略大小写和多余空白的子串。
  const direct = haystack.text.indexOf(query);
  if (direct >= 0) return toOriginal(direct, direct + query.length, 1);

  // 2. 几个词按顺序出现，中间可以隔着别的话、代码块、空行。
  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length > 1) {
    const first = haystack.text.indexOf(tokens[0]!);
    if (first >= 0) {
      let cursor = first + tokens[0]!.length;
      let gap = 0;
      let ok = true;
      for (const token of tokens.slice(1)) {
        const at = haystack.text.indexOf(token, cursor);
        if (at < 0 || at - cursor > TOKEN_GAP_MAX) { ok = false; break; }
        gap += at - cursor;
        cursor = at + token.length;
      }
      if (ok) return toOriginal(first, cursor, Math.max(0.5, 0.8 - gap / (TOKEN_GAP_MAX * tokens.length * 2)));
    }
  }

  // 3. 错字、少字、多字：近似子串。
  if (query.length >= APPROX_MIN_LENGTH) {
    const errors = Math.min(APPROX_MAX_ERRORS, Math.floor(query.length / 3) || 1);
    if (sharesEnoughBigrams(haystack.text, query)) {
      const found = approximateMatch(haystack.text, query, errors);
      if (found && found.end > found.start) return toOriginal(found.start, found.end, Math.max(0.3, 0.7 - 0.15 * found.errors));
    }
  }
  return null;
}

/**
 * 在一段文字里找搜索词。没找到是 null。
 * 精确：区分大小写和空格，可以只认整个词。模糊：忽略大小写和多余空白，容忍错字、断行、中间夹了别的内容。
 * 返回的位置都在原文里，所以两种模式用同一套高亮和跳转。
 */
export function findInText(text: string, query: string, options: TextMatchOptions): TextMatch | null {
  if (!query || !text) return null;
  return options.mode === "exact" ? exactMatch(text, query, options.wholeWord === true) : fuzzyMatch(text, query);
}

/** 命中的文字和它前后各 radius 个字（折行换成空格，片段只占一行）。 */
export function snippetAround(
  text: string,
  match: Pick<TextMatch, "start" | "end">,
  radius = CONVERSATION_SNIPPET_RADIUS,
): { before: string; matched: string; after: string } {
  const flat = (value: string) => value.replace(/\s+/g, " ");
  const from = Math.max(0, match.start - radius);
  const to = Math.min(text.length, match.end + radius);
  // 命中的文字很长时只留开头一段，片段不会比一行长很多。
  const matchedEnd = Math.min(match.end, match.start + radius * 3);
  return {
    before: (from > 0 ? "…" : "") + flat(text.slice(from, match.start)).trimStart(),
    matched: flat(text.slice(match.start, matchedEnd)),
    after: flat(text.slice(matchedEnd, matchedEnd === match.end ? to : matchedEnd + radius)).trimEnd() + (to < text.length ? "…" : ""),
  };
}

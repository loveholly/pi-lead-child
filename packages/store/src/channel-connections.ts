// 外部来源的连接设置（设置 → 消息通道，2026-11-02）：用哪种连接方式，以及要单独打开的「代你往来源里写」开关。
// 一个来源一行 kv（channel.connection.<来源>，JSON）。来源自己定义有哪些方式（例如一种用应用的令牌，一种用浏览器会话）；
// 这里只存选了哪一种，不认识具体的来源。没有存过时：方式由配置或来源的缺省决定，开关是关的。
// 同一行还存用户固定订阅的对话（2026-11-25）：来源自己决定怎么认这些条目（例如 Slack 的频道编号或频道名）。
import type { Db } from "./db.js";

export interface ChannelConnectionSettings {
  // 选的连接方式。没有选过时是 null。
  mode: string | null;
  // 「代你往来源里写」开关（只有要单独打开它的方式才看）。缺省关。
  writes: boolean;
  // 固定订阅的对话（用户在设置页或者让 Lead 加的）：不管最近有没有对话都算订阅。条目是来源认的写法，原样存。缺省空。
  pinned: string[];
}

// 固定订阅最多存这么多条，每条最多这么长。
export const CHANNEL_PINNED_MAX = 200;
export const CHANNEL_PINNED_ENTRY_MAX = 100;

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// 比较两条固定订阅是不是同一个：去掉开头的 # 以后不分大小写。
const pinKey = (entry: string) => entry.trim().replace(/^#/, "").toLowerCase();

/** 整理固定订阅的名单：去掉首尾空白、空的、太长的、重复的（按 pinKey），最多 CHANNEL_PINNED_MAX 条。 */
export function normalizePinnedEntries(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > CHANNEL_PINNED_ENTRY_MAX || CONTROL.test(trimmed)) continue;
    const key = pinKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= CHANNEL_PINNED_MAX) break;
  }
  return result;
}

/** 两条固定订阅是不是同一个（去掉开头的 # 以后不分大小写）。 */
export function samePinnedEntry(a: string, b: string): boolean {
  return pinKey(a) === pinKey(b);
}

const keyOf = (source: string) => `channel.connection.${source}`;
const MODE = /^[a-z][a-z0-9_-]{0,31}$/;

export function getChannelConnection(db: Db, source: string): ChannelConnectionSettings {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(keyOf(source)) as { value: string } | undefined;
  let stored: Record<string, unknown> = {};
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  return {
    mode: typeof stored.mode === "string" && MODE.test(stored.mode) ? stored.mode : null,
    writes: stored.writes === true,
    pinned: Array.isArray(stored.pinned) ? normalizePinnedEntries(stored.pinned) : [],
  };
}

function write(db: Db, source: string, settings: ChannelConnectionSettings): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(keyOf(source), JSON.stringify(settings));
}

/** 记下选的连接方式。方式名不对时抛错。 */
export function setChannelConnectionMode(db: Db, source: string, mode: string): ChannelConnectionSettings {
  if (!MODE.test(mode)) throw new Error(`not a connection mode name: ${mode.slice(0, 40)}`);
  const next = { ...getChannelConnection(db, source), mode };
  write(db, source, next);
  return next;
}

/** 打开、关掉「代你往来源里写」开关。 */
export function setChannelWrites(db: Db, source: string, writes: boolean): ChannelConnectionSettings {
  const next = { ...getChannelConnection(db, source), writes };
  write(db, source, next);
  return next;
}

/** 换掉固定订阅的名单（先整理，见 normalizePinnedEntries）。 */
export function setChannelPinned(db: Db, source: string, pinned: readonly string[]): ChannelConnectionSettings {
  const next = { ...getChannelConnection(db, source), pinned: normalizePinnedEntries(pinned) };
  write(db, source, next);
  return next;
}

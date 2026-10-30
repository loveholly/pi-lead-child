// lead 的语义记忆层（DESIGN 结论 E）：允许有损、允许改写——与账本的一致性要求刻意不同。
import { ftsEnabled, type Db } from "./db.js";

export const NOTE_KINDS = ["profile", "preference", "fact", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: number; title: string; content: string; tags: string; kind: NoteKind;
  created_at: string; updated_at: string;
}

// 常驻核心记忆（spec §A2，Hermes 映射）：profile+preference 有界常驻注入，超限报错逼 lead 精炼。
export const CORE_KINDS: NoteKind[] = ["profile", "preference"];
export const CORE_MEMORY_CAP_DEFAULT = 4000;

function coreMemoryCap(): number {
  // 非数字/垃圾 env（如 "abc"）→ NaN，total > NaN 恒 false 会静默禁用容量闸，故回落默认值
  const n = Number(process.env.PLC_CORE_MEMORY_CAP ?? CORE_MEMORY_CAP_DEFAULT);
  return Number.isFinite(n) ? n : CORE_MEMORY_CAP_DEFAULT;
}

export function coreNotes(db: Db): Note[] {
  return db.prepare(
    "SELECT * FROM notes WHERE kind IN ('profile','preference') ORDER BY kind, id",
  ).all() as Note[];
}

function coreSize(db: Db, excludeId?: number): number {
  return coreNotes(db)
    .filter((n) => n.id !== excludeId)
    .reduce((s, n) => s + n.title.length + n.content.length, 0);
}

/** 常驻核心记忆现在用了多少字符（标题加正文）、上限多少。设置页的常驻偏好列表显示它。 */
export function coreMemoryUsage(db: Db): { used: number; cap: number } {
  return { used: coreSize(db), cap: coreMemoryCap() };
}

// 核心记忆写满了：total 是这次写完以后的字符数，cap 是上限。消息是写给 Lead 的；设置页按 total 和 cap 另写一句。
export class CoreMemoryFullError extends Error {
  constructor(readonly total: number, readonly cap: number) {
    super(
      `核心记忆已满（${total}/${cap} 字符）。请先 search_notes 查看 profile/preference 条目，` +
      `用 update_note 精炼合并后再保存；不属于长期画像/偏好的内容请用 kind='note' 或 'fact'。`,
    );
    this.name = "CoreMemoryFullError";
  }
}

// saveNote/updateNote 目标为核心 kind 时的容量闸（唯一写入口在 lead 工具，DAO 层做闸最稳）
function assertCoreCapacity(db: Db, incoming: { title: string; content: string }, excludeId?: number): void {
  const cap = coreMemoryCap();
  const total = coreSize(db, excludeId) + incoming.title.length + incoming.content.length;
  if (total > cap) throw new CoreMemoryFullError(total, cap);
}

export function renderCoreMemory(db: Db): string | null {
  const rows = coreNotes(db);
  if (!rows.length) return null;
  const fmt = (k: NoteKind) => rows.filter((n) => n.kind === k)
    .map((n) => `- ${n.title}: ${n.content}`).join("\n");
  const profile = fmt("profile"), pref = fmt("preference");
  return [
    "## 关于用户（长期记忆，来自 notes 的 profile/preference）",
    profile ? `### 画像\n${profile}` : "",
    pref ? `### 偏好\n${pref}` : "",
  ].filter(Boolean).join("\n\n");
}

// 压缩后核心记忆的前缀刷新块（spec §A2 既定偏差：改前缀注入，无额外 LLM 回合、无 busy 竞态）。
// 抽成纯函数便于单测：无核心记忆时返回空串（被 daemon 的 filter(Boolean) 剔除）。
export function coreMemoryRefreshPrefix(db: Db): string {
  const cm = renderCoreMemory(db);
  return cm ? `（长期记忆刷新——上下文压缩后重新注入）\n${cm}` : "";
}

export function saveNote(
  db: Db,
  args: { title: string; content: string; tags: string[]; kind?: NoteKind },
): number {
  if (CORE_KINDS.includes(args.kind ?? "note")) assertCoreCapacity(db, args);
  const r = db.prepare("INSERT INTO notes (title, content, tags, kind) VALUES (?, ?, ?, ?)")
    .run(args.title, args.content, JSON.stringify(args.tags), args.kind ?? "note");
  return Number(r.lastInsertRowid);
}

export function searchNotes(
  db: Db, query: string, opts?: { limit?: number; kind?: NoteKind },
): Note[] {
  // 按空白分词，每个 token 各自加引号（token-AND 语义）：整句当一个短语要求严格相邻，
  // 会漏掉"esbuild 用于打包依赖"这种词序不相邻但语义相关的命中；拆 token 后 FTS5 MATCH
  // 的隐式 AND 只要求每个 token 都出现，不要求相邻。引号包裹 + 内部引号加倍转义同时防止
  // 用户输入被解释成 FTS5 查询语法（列过滤器、NEAR、通配符等）。
  // trigram 对 <3 字符的 token 不建索引、退化为匹配一切（无害 no-op，由其余 token 约束结果）；
  // 但若全部 token 都 <3 字符，整条查询会退化成"匹配一切 AND 匹配一切"= 全表命中，此时必须
  // 整体降级 LIKE（LIKE 版本本来就是把 query 当一个子串，不会有这个退化问题）。
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => t.length >= 3) && ftsEnabled(db)) {
    try {
      const match = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
      const kindSql = opts?.kind ? " AND n.kind = ?" : "";
      const params: unknown[] = [match, ...(opts?.kind ? [opts.kind] : []), opts?.limit ?? 20];
      return db.prepare(
        `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ?${kindSql} ORDER BY rank LIMIT ?`,
      ).all(...params) as Note[];
    } catch { /* FTS 查询异常，落 LIKE */ }
  }
  return searchNotesLike(db, query, opts);
}

function searchNotesLike(
  db: Db, query: string, opts?: { limit?: number; kind?: NoteKind },
): Note[] {
  const q = `%${query}%`;
  const kindSql = opts?.kind ? " AND kind = ?" : "";
  const params: unknown[] = [q, q, q, ...(opts?.kind ? [opts.kind] : []), opts?.limit ?? 20];
  return db.prepare(
    `SELECT * FROM notes WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)${kindSql}
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(...params) as Note[];
}

export function updateNote(
  db: Db,
  id: number,
  patch: { title?: string; content?: string; tags?: string[]; kind?: NoteKind },
): void {
  const cur = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined;
  if (!cur) return;
  const targetKind = patch.kind ?? cur.kind;
  if (CORE_KINDS.includes(targetKind)) {
    assertCoreCapacity(db, { title: patch.title ?? cur.title, content: patch.content ?? cur.content }, id);
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title) { sets.push("title = ?"); vals.push(patch.title); }
  if (patch.content) { sets.push("content = ?"); vals.push(patch.content); }
  if (patch.tags) { sets.push("tags = ?"); vals.push(JSON.stringify(patch.tags)); }
  if (patch.kind) { sets.push("kind = ?"); vals.push(patch.kind); }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function getNote(db: Db, id: number): Note | null {
  return (db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined) ?? null;
}

/**
 * 删掉一条笔记（slack-takeover 工单 07：Slack 里的线程删空了，它的事实笔记跟着删）。返回删没删掉（没有这条时是 false）。
 * 全文索引由 notes_fts_ad 触发器同步。外部召回索引里的那一份由 engine 的 NotesMemory.delete 负责忘掉。
 */
export function deleteNote(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
}

/** 带某个标签的笔记（标签完全相同才算），按 id 从小到大。tags 是 JSON 数组。 */
export function notesWithTag(db: Db, tag: string): Note[] {
  return db.prepare(
    `SELECT * FROM notes
     WHERE json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)
     ORDER BY id`,
  ).all(tag) as Note[];
}

// 外部召回索引（engine 的 memory）的增量同步：updated_at 不早于 since 的笔记，按 (updated_at, id) 排序。
// 包含 since 那一秒：updated_at 只精确到秒，同一秒里的更新要靠调用方比较内容来发现。
export function notesChangedSince(db: Db, since: string | null): Note[] {
  if (since === null) return db.prepare("SELECT * FROM notes ORDER BY updated_at, id").all() as Note[];
  return db.prepare("SELECT * FROM notes WHERE updated_at >= ? ORDER BY updated_at, id").all(since) as Note[];
}

/** 标题完全是 title 的笔记里最新改过的一条（例如代查用的「业务地图」，kind=fact）。没有时是 null。 */
export function findNoteByTitle(db: Db, title: string, kind?: NoteKind): Note | null {
  const row = kind === undefined
    ? db.prepare("SELECT * FROM notes WHERE title = ? ORDER BY updated_at DESC, id DESC LIMIT 1").get(title)
    : db.prepare("SELECT * FROM notes WHERE title = ? AND kind = ? ORDER BY updated_at DESC, id DESC LIMIT 1").get(title, kind);
  return (row as Note | undefined) ?? null;
}

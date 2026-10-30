// 常驻偏好（profile、preference 笔记，renderCoreMemory 写进 Lead 的系统提示词）的改动记录（用户 2026-10-29）。
//
// 每一次写入，只要改前或改后的 kind 是 profile 或 preference，就记一行：新加（create）、修改（update）、删除（delete）。
// 把一条偏好改成别的 kind 也是 update：它从常驻里拿掉了。撤销是一次新的写入，也记一行（undoes 指向被撤销的那一行），
// 同时在被撤销的那一行写上 undone_at、undone_by。表只追加：不能删行，一行只能写一次「撤销」（schema.ts 的触发器）。
// 写笔记、记改动在 engine 的 core-memory.ts 里，在同一个事务里做。
import type { Db } from "./db.js";
import { CORE_KINDS, type Note, type NoteKind } from "./notes.js";

export const CORE_MEMORY_CHANGE_ACTIONS = ["create", "update", "delete"] as const;
export type CoreMemoryChangeAction = (typeof CORE_MEMORY_CHANGE_ACTIONS)[number];
export type CoreMemoryActor = "user" | "lead";

// 一条笔记在某一时刻的样子。tags 跟着存：撤销删除时按原样重建。
export interface CoreMemorySnapshot {
  title: string;
  content: string;
  kind: NoteKind;
  tags: string[];
}

export interface CoreMemoryChange {
  id: number;
  noteId: number;
  action: CoreMemoryChangeAction;
  before: CoreMemorySnapshot | null;
  after: CoreMemorySnapshot | null;
  actor: CoreMemoryActor;
  reason: string;
  // 这一行是一次撤销时，被撤销的那一行的编号。
  undoes: number | null;
  createdAt: string;
  undoneAt: string | null;
  undoneBy: CoreMemoryActor | null;
}

interface RawChange {
  id: number; note_id: number; action: CoreMemoryChangeAction; before: string | null; after: string | null;
  actor: CoreMemoryActor; reason: string; undoes: number | null; created_at: string; undone_at: string | null;
  undone_by: CoreMemoryActor | null;
}

// 依据最多存这么长。
const REASON_MAX = 1_000;

function tagsOf(raw: string): string[] {
  try {
    const tags = JSON.parse(raw) as unknown;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export function noteSnapshot(note: Note): CoreMemorySnapshot {
  return { title: note.title, content: note.content, kind: note.kind, tags: tagsOf(note.tags) };
}

export function isCoreKind(kind: NoteKind | null | undefined): boolean {
  return kind !== null && kind !== undefined && CORE_KINDS.includes(kind);
}

/** 两个样子是不是一样（标题、正文、kind、tags）。 */
export function sameSnapshot(left: CoreMemorySnapshot | null, right: CoreMemorySnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return left.title === right.title && left.content === right.content && left.kind === right.kind
    && JSON.stringify(left.tags) === JSON.stringify(right.tags);
}

function snapshotOf(raw: string | null): CoreMemorySnapshot | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<CoreMemorySnapshot>;
  return {
    title: String(value.title ?? ""), content: String(value.content ?? ""), kind: (value.kind ?? "note") as NoteKind,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

const toChange = (raw: RawChange): CoreMemoryChange => ({
  id: raw.id, noteId: raw.note_id, action: raw.action, before: snapshotOf(raw.before), after: snapshotOf(raw.after),
  actor: raw.actor, reason: raw.reason, undoes: raw.undoes, createdAt: raw.created_at, undoneAt: raw.undone_at,
  undoneBy: raw.undone_by,
});

/** 记一行改动。调用方在写笔记的同一个事务里调它。 */
export function recordCoreMemoryChange(db: Db, entry: {
  noteId: number; action: CoreMemoryChangeAction; before: CoreMemorySnapshot | null; after: CoreMemorySnapshot | null;
  actor: CoreMemoryActor; reason: string; undoes?: number | null; now?: Date;
}): CoreMemoryChange {
  const result = db.prepare(
    `INSERT INTO core_memory_changes (note_id, action, before, after, actor, reason, undoes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.noteId, entry.action, entry.before ? JSON.stringify(entry.before) : null, entry.after ? JSON.stringify(entry.after) : null,
    entry.actor, entry.reason.slice(0, REASON_MAX), entry.undoes ?? null, (entry.now ?? new Date()).toISOString(),
  );
  return getCoreMemoryChange(db, Number(result.lastInsertRowid))!;
}

export function getCoreMemoryChange(db: Db, id: number): CoreMemoryChange | null {
  const raw = db.prepare("SELECT * FROM core_memory_changes WHERE id = ?").get(id) as RawChange | undefined;
  return raw ? toChange(raw) : null;
}

/** 每条笔记最近一次改动（笔记编号 → 改动）。 */
export function latestCoreMemoryChanges(db: Db, noteIds: readonly number[]): Map<number, CoreMemoryChange> {
  const latest = new Map<number, CoreMemoryChange>();
  if (!noteIds.length) return latest;
  const rows = db.prepare(
    `SELECT * FROM core_memory_changes c
     WHERE note_id IN (${noteIds.map(() => "?").join(", ")})
       AND id = (SELECT MAX(id) FROM core_memory_changes WHERE note_id = c.note_id)`,
  ).all(...noteIds) as RawChange[];
  for (const raw of rows) latest.set(raw.note_id, toChange(raw));
  return latest;
}

export function latestCoreMemoryChange(db: Db, noteId: number): CoreMemoryChange | null {
  return latestCoreMemoryChanges(db, [noteId]).get(noteId) ?? null;
}

/** 在被撤销的那一行写上撤销的时间和人。已经撤销过时返回 false（不改）。 */
export function markCoreMemoryChangeUndone(db: Db, id: number, by: { actor: CoreMemoryActor; now?: Date }): boolean {
  return db.prepare("UPDATE core_memory_changes SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL")
    .run((by.now ?? new Date()).toISOString(), by.actor, id).changes > 0;
}

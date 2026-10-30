// 笔记写进 Hindsight 的任务，和 Lead 让 Hindsight 的事实失效的记录（.scratch/hindsight-primary-memory/spec.md D3、D5）。
//
// memory_sync：每个记忆库（bank_index）里每个文档（note-<编号>）一行。它代替以前的同步游标：
// - fingerprint 是交给 Hindsight 的内容的指纹。笔记的指纹和这一行不同，就要再写一次。
// - operation_id 是我们生成的编号，交给 retain。HTTP 请求失败时用同一个编号重发，Hindsight 不会重复做。
// - state：queued（还没交出去，或者交的时候 HTTP 失败了）、submitted（Hindsight 收下了，在它的后台处理）、
//   completed（处理完了）、failed（重试到上限还是失败，等用户修好原因后重试）。
// memory_invalidations：只追加。一条事实失效或者恢复时记一行（谁、依据、事实的原文和来源），用于审计、设置页的列表，
// 也用于 SQLite 兜底时说明。
import type { Db } from "./db.js";

export const MEMORY_SYNC_STATES = ["queued", "submitted", "completed", "failed"] as const;
export type MemorySyncState = (typeof MEMORY_SYNC_STATES)[number];

export interface MemorySyncRow {
  bankIndex: string;
  documentId: string;
  fingerprint: string;
  operationId: string;
  state: MemorySyncState;
  attempts: number;
  error: string | null;
  updatedAt: string;
}

interface RawRow {
  bank_index: string; document_id: string; fingerprint: string; operation_id: string;
  state: MemorySyncState; attempts: number; error: string | null; updated_at: string;
}

const toRow = (raw: RawRow): MemorySyncRow => ({
  bankIndex: raw.bank_index, documentId: raw.document_id, fingerprint: raw.fingerprint, operationId: raw.operation_id,
  state: raw.state, attempts: raw.attempts, error: raw.error, updatedAt: raw.updated_at,
});

// 失败原因最多存这么长。调用方先脱敏。
const ERROR_MAX = 300;

export function listMemorySync(db: Db, bankIndex: string, states?: readonly MemorySyncState[]): MemorySyncRow[] {
  const filter = states?.length ? ` AND state IN (${states.map(() => "?").join(", ")})` : "";
  return (db.prepare(`SELECT * FROM memory_sync WHERE bank_index = ?${filter} ORDER BY updated_at, document_id`)
    .all(bankIndex, ...(states ?? [])) as RawRow[]).map(toRow);
}

export function getMemorySync(db: Db, bankIndex: string, documentId: string): MemorySyncRow | null {
  const raw = db.prepare("SELECT * FROM memory_sync WHERE bank_index = ? AND document_id = ?").get(bankIndex, documentId) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

/** 新写一次：替换这个文档原来的行（原来的任务不再跟踪）。 */
export function queueMemorySync(db: Db, row: { bankIndex: string; documentId: string; fingerprint: string; operationId: string }): void {
  db.prepare(
    `INSERT INTO memory_sync (bank_index, document_id, fingerprint, operation_id, state, attempts, error, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, NULL, datetime('now'))
     ON CONFLICT(bank_index, document_id) DO UPDATE SET
       fingerprint = excluded.fingerprint, operation_id = excluded.operation_id, state = 'queued',
       attempts = 0, error = NULL, updated_at = excluded.updated_at`,
  ).run(row.bankIndex, row.documentId, row.fingerprint, row.operationId);
}

/**
 * 改一行的状态。只改 operation_id 还是这一个的行：等 Hindsight 回话的时候，笔记可能又改了、换了新任务。
 * 返回改没改。
 */
export function setMemorySyncState(
  db: Db, key: { bankIndex: string; documentId: string; operationId: string },
  patch: { state: MemorySyncState; attempts?: number; error?: string | null },
): boolean {
  const result = db.prepare(
    `UPDATE memory_sync SET state = ?, attempts = COALESCE(?, attempts), error = ?, updated_at = datetime('now')
     WHERE bank_index = ? AND document_id = ? AND operation_id = ?`,
  ).run(patch.state, patch.attempts ?? null, patch.error ? patch.error.slice(0, ERROR_MAX) : null,
    key.bankIndex, key.documentId, key.operationId);
  return result.changes > 0;
}

export function deleteMemorySync(db: Db, bankIndex: string, documentIds: readonly string[]): void {
  const remove = db.prepare("DELETE FROM memory_sync WHERE bank_index = ? AND document_id = ?");
  db.transaction(() => {
    for (const id of documentIds) remove.run(bankIndex, id);
  })();
}

export interface MemorySyncCounts {
  completed: number;
  // 还没写完的：queued、submitted，加上还没有行的（刚存、还没同步到的）。
  pending: number;
  failed: number;
  // 最近一次失败的原因。没有失败时是 null。
  lastError: string | null;
}

/** 笔记在这个记忆库里的写入情况。只数还在的笔记：删掉的笔记的行等它在后端忘掉以后才删。 */
export function noteSyncCounts(db: Db, bankIndex: string): MemorySyncCounts & { notes: number } {
  const notes = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  const rows = db.prepare(
    `SELECT ms.state AS state, COUNT(*) AS n FROM memory_sync ms JOIN notes n ON ms.document_id = 'note-' || n.id
     WHERE ms.bank_index = ? GROUP BY ms.state`,
  ).all(bankIndex) as Array<{ state: MemorySyncState; n: number }>;
  const count = (state: MemorySyncState) => rows.find((row) => row.state === state)?.n ?? 0;
  const last = db.prepare(
    "SELECT error FROM memory_sync WHERE bank_index = ? AND state = 'failed' AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
  ).get(bankIndex) as { error: string } | undefined;
  const completed = count("completed");
  const failed = count("failed");
  return { notes, completed, pending: Math.max(0, notes - completed - failed), failed, lastError: failed ? last?.error ?? null : null };
}

/** 失败的行删掉，下一次同步把这些笔记当作没写过，用新的任务编号重新写。返回删了几行。 */
export function resetFailedMemorySync(db: Db, bankIndex: string): number {
  return db.prepare("DELETE FROM memory_sync WHERE bank_index = ? AND state = 'failed'").run(bankIndex).changes;
}

export type MemoryInvalidationAction = "invalidated" | "restored";
// 事实的来源：用户本人（user），或者外部对话里别人说的话（external）。不知道时按用户本人记。
export type MemoryFactOrigin = "user" | "external";

export interface MemoryInvalidation {
  id: number;
  bankIndex: string;
  memoryId: string;
  documentId: string | null;
  action: MemoryInvalidationAction;
  reason: string;
  // user 或 lead。
  actor: string;
  // 事实的原文（改之前从 Hindsight 读到的，或者召回时看到的）。不知道时为 null。
  text: string | null;
  origin: MemoryFactOrigin | null;
  createdAt: string;
}

interface RawInvalidation {
  id: number; bank_index: string; memory_id: string; document_id: string | null; action: MemoryInvalidationAction;
  reason: string; actor: string; text: string | null; origin: MemoryFactOrigin | null; created_at: string;
}

const toInvalidation = (raw: RawInvalidation): MemoryInvalidation => ({
  id: raw.id, bankIndex: raw.bank_index, memoryId: raw.memory_id, documentId: raw.document_id, action: raw.action,
  reason: raw.reason, actor: raw.actor, text: raw.text, origin: raw.origin, createdAt: raw.created_at,
});

// 原文最多存这么长。
const FACT_TEXT_MAX = 2_000;

export function recordMemoryInvalidation(db: Db, entry: {
  bankIndex: string; memoryId: string; documentId: string | null; action: MemoryInvalidationAction; reason: string; actor: string;
  text?: string | null; origin?: MemoryFactOrigin | null; now?: Date;
}): MemoryInvalidation {
  const result = db.prepare(
    `INSERT INTO memory_invalidations (bank_index, memory_id, document_id, action, reason, actor, text, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.bankIndex, entry.memoryId, entry.documentId, entry.action, entry.reason.slice(0, 500), entry.actor.slice(0, 80),
    entry.text?.slice(0, FACT_TEXT_MAX) ?? null, entry.origin ?? null, (entry.now ?? new Date()).toISOString(),
  );
  return getMemoryInvalidation(db, Number(result.lastInsertRowid))!;
}

export function getMemoryInvalidation(db: Db, id: number): MemoryInvalidation | null {
  const raw = db.prepare("SELECT * FROM memory_invalidations WHERE id = ?").get(id) as RawInvalidation | undefined;
  return raw ? toInvalidation(raw) : null;
}

/** 这条事实最近一次失效或恢复的记录。没有时为 null。 */
export function latestMemoryInvalidation(db: Db, memoryId: string): MemoryInvalidation | null {
  const raw = db.prepare("SELECT * FROM memory_invalidations WHERE memory_id = ? ORDER BY id DESC LIMIT 1").get(memoryId) as RawInvalidation | undefined;
  return raw ? toInvalidation(raw) : null;
}

/** 现在还是失效的事实（每条事实看最近一次记录），最近失效的在前。 */
export function listInvalidatedFacts(db: Db, limit = 20): MemoryInvalidation[] {
  return (db.prepare(
    `SELECT * FROM memory_invalidations m
     WHERE action = 'invalidated' AND id = (SELECT MAX(id) FROM memory_invalidations WHERE memory_id = m.memory_id)
     ORDER BY id DESC LIMIT ?`,
  ).all(Math.max(1, Math.trunc(limit))) as RawInvalidation[]).map(toInvalidation);
}

/** 现在还是失效的事实（每条事实看最近一次记录），按来源文档数。 */
export function invalidatedFactsByDocument(db: Db, documentIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!documentIds.length) return counts;
  const rows = db.prepare(
    `SELECT document_id, action FROM memory_invalidations m
     WHERE document_id IN (${documentIds.map(() => "?").join(", ")})
       AND id = (SELECT MAX(id) FROM memory_invalidations WHERE bank_index = m.bank_index AND memory_id = m.memory_id)`,
  ).all(...documentIds) as Array<{ document_id: string; action: MemoryInvalidationAction }>;
  for (const row of rows) {
    if (row.action === "invalidated") counts.set(row.document_id, (counts.get(row.document_id) ?? 0) + 1);
  }
  return counts;
}

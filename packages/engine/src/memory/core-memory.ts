// 常驻偏好（用户 2026-10-29，.scratch/hindsight-primary-memory/spec.md D15）：profile、preference 笔记，
// renderCoreMemory 把它们整段写进 Lead 的系统提示词。这里是改它们的唯一一组函数：
//   - 设置页（操作层的 core_memory、core_memory_change）和 Lead（save_note、update_note、perform_action）都调这里。
//   - 每次写入经过 NotesMemory（写 notes，再交给 Hindsight）。改前或改后是常驻偏好的写入，在同一个事务里记一行改动
//     （store 的 core_memory_changes）。
//   - Lead 的改动、和撤销 Lead 的改动，写一条 core_memory.changed（digest 级）：「Lead 动态」里出现一张卡，带「撤销」。
//     用户自己在设置页的改动不写这条事件。
//   - 撤销按改动那一行恢复：修改恢复成改前的样子，新加的删掉，删掉的按原样重建一条（编号是新的）。
//     这条在这次改动之后又改过、已经撤销过、或者这次改动本身是撤销时不能撤销（coreMemoryUndoBlocker，页面和卡上的按钮也用它）。
//   - 每次改动以后网关发 snapshot.required（{resource: "memory"}），页面重新读常驻偏好。
// 只改 tags 的写入照样记一行，但不进 Lead 动态：系统提示词里没有 tags。
import {
  CORE_MEMORY_CHANGED_KIND, coreMemoryEntityKey, redactSecretText,
  type CoreMemoryChangeDto, type CoreMemoryChangedPayload, type CoreMemoryEntryDto, type MemoryPreferencesDto,
} from "@pi-lead-child/protocol";
import {
  appendEvent, CoreMemoryFullError, coreMemoryUsage, coreNotes, getCoreMemoryChange, getNote, isCoreKind, latestCoreMemoryChanges,
  leadDisplayName, markCoreMemoryChangeUndone, noteSnapshot, publishGatewayEvent, recordCoreMemoryChange, sameSnapshot,
  setEventDisposition,
  type CoreMemoryActor, type CoreMemoryChange, type CoreMemorySnapshot, type Db, type NoteKind,
} from "@pi-lead-child/store";
import type { NotesMemory } from "./notes-memory.js";

// 事件的分诊依据：硬性规则，常设指令改不了它（和 standing_order_change_reported 一样）。
export const CORE_MEMORY_CHANGE_REPORTED = "core_memory_change_reported";

export type CoreMemoryErrorCode = "not_found" | "invalid_input" | "conflict";

export class CoreMemoryError extends Error {
  constructor(readonly code: CoreMemoryErrorCode, message: string) {
    super(message);
    this.name = "CoreMemoryError";
  }
}

export interface CoreMemoryWriteMeta {
  actor: CoreMemoryActor;
  // 依据：Lead 写的理由，或者设置页的默认说法。
  reason: string;
  now?: Date;
}

// SQLite 的时间（UTC，"YYYY-MM-DD HH:MM:SS"）转成 ISO 8601。
function isoTime(sqliteTime: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqliteTime) ? `${sqliteTime.replace(" ", "T")}Z` : sqliteTime;
}

const touchesCore = (before: CoreMemorySnapshot | null, after: CoreMemorySnapshot | null) =>
  isCoreKind(before?.kind) || isCoreKind(after?.kind);

// ── 能不能撤销 ─────────────────────────────────────────────────────────────────────

/**
 * 这次改动现在为什么不能撤销（用户能看懂的一句话，不带句号）。能撤销时为 null。
 * 页面的「撤销」、Lead 动态卡上的按钮和操作层的 available 都用它。
 */
export function coreMemoryUndoBlocker(db: Db, change: CoreMemoryChange): string | null {
  if (change.undoneAt) return "这次改动已经撤销过了";
  if (change.undoes !== null) return "这次改动本身是一次撤销，不能再撤销；要改回去，直接改这条常驻偏好";
  const later = db.prepare("SELECT 1 FROM core_memory_changes WHERE note_id = ? AND id > ? LIMIT 1").get(change.noteId, change.id);
  if (later) return "这条常驻偏好在这次改动之后又改过，不能撤销这次的；要改回去，直接改它";
  if (change.after === null) return null;
  const note = getNote(db, change.noteId);
  if (!note) return "这条常驻偏好已经删掉了，不能撤销这次改动";
  // 没经过这里的写入（例如拿出常驻以后又改了它）没有记录：按现在的样子核对。
  if (!sameSnapshot(noteSnapshot(note), change.after)) return "这条常驻偏好在这次改动之后又改过，不能撤销这次的；要改回去，直接改它";
  return null;
}

// ── 列表（GET /v1/memory/preferences）──────────────────────────────────────────────

export function coreMemoryChangeDto(db: Db, change: CoreMemoryChange): CoreMemoryChangeDto {
  const blocked = coreMemoryUndoBlocker(db, change);
  return {
    changeId: change.id, action: change.action, actor: change.actor, reason: change.reason, at: change.createdAt,
    undoOf: change.undoes, canUndo: blocked === null, undoBlocked: blocked,
  };
}

/** 设置页的常驻偏好：每一条和它最近一次改动，加上总字数和上限。顺序和系统提示词里一样。 */
export function memoryPreferences(db: Db): MemoryPreferencesDto {
  const notes = coreNotes(db);
  const latest = latestCoreMemoryChanges(db, notes.map((note) => note.id));
  const entries: CoreMemoryEntryDto[] = notes.map((note) => {
    const change = latest.get(note.id);
    return {
      id: note.id, kind: note.kind as CoreMemoryEntryDto["kind"], title: note.title, content: note.content,
      updatedAt: isoTime(note.updated_at), lastChange: change ? coreMemoryChangeDto(db, change) : null,
    };
  });
  return { entries, ...coreMemoryUsage(db) };
}

// ── Lead 动态 ──────────────────────────────────────────────────────────────────────

const KIND_WORDS: Partial<Record<NoteKind, string>> = { profile: "画像", preference: "偏好" };

function quote(text: string, max = 60): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `「${flat.length > max ? `${flat.slice(0, max)}…` : flat}」`;
}

function basisText(reason: string): string {
  const flat = reason.replace(/\s+/gu, " ").trim().replace(/[。.]+$/u, "");
  if (!flat) return "";
  return `依据：${flat.length > 200 ? `${flat.slice(0, 200)}…` : flat}。`;
}

// 系统提示词里看得到的变化：标题、正文，或者进出常驻、在画像和偏好之间挪动。只改 tags 看不到。
function visibleChange(change: CoreMemoryChange): boolean {
  const { before, after } = change;
  if (!before || !after) return true;
  return before.title !== after.title || before.content !== after.content || before.kind !== after.kind;
}

/** 一次改动对用户说的那句话。who 是做这件事的人：Lead 的名字，或者「你」。 */
export function coreMemoryChangeSummary(change: CoreMemoryChange, undone: CoreMemoryChange | null, leadName: string): string {
  const who = change.actor === "lead" ? `${leadName} ` : "你";
  if (undone) {
    const owner = undone.actor === change.actor ? "自己" : undone.actor === "lead" ? ` ${leadName} ` : "你";
    const title = (undone.before ?? undone.after)!.title;
    const verb = undone.action === "create" ? "新加" : undone.action === "delete" ? "删除" : "修改";
    const result = undone.action === "create" ? "这条已经删掉"
      : undone.action === "delete" ? "已经按原样恢复"
      : `恢复成${quote(change.after!.content)}`;
    return `${who}撤销了${owner}对常驻偏好「${title}」的${verb}：${result}。${change.actor === "lead" ? basisText(change.reason) : ""}`;
  }
  const { before, after } = change;
  let head: string;
  if (!before) head = `${who}新加了常驻偏好「${after!.title}」：${quote(after!.content)}。`;
  else if (!after) head = `${who}删掉了常驻偏好「${before.title}」（原来${quote(before.content)}）。`;
  else if (!isCoreKind(after.kind)) head = `${who}把「${before.title}」从常驻偏好里拿掉了（原来${quote(before.content)}）。`;
  else if (!isCoreKind(before.kind)) head = `${who}把「${after.title}」放进了常驻偏好：${quote(after.content)}。`;
  else {
    const parts = [`${who}改了常驻偏好「${before.title}」`];
    if (before.title !== after.title) parts.push(`，标题改成「${after.title}」`);
    if (before.kind !== after.kind) parts.push(`，从${KIND_WORDS[before.kind]}挪到${KIND_WORDS[after.kind]}`);
    if (before.content !== after.content) parts.push(`：原来${quote(before.content)}，现在${quote(after.content)}`);
    head = `${parts.join("")}。`;
  }
  return `${head}${basisText(change.reason)}`;
}

/**
 * Lead 的改动、和撤销 Lead 的改动写一条 core_memory.changed（调用方在写事务里）。别的（用户自己的改动）不写，返回 null。
 * entityNoteId 是卡的对象：撤销删除时重建的那一条编号不同，事件仍然记在原来那一条上，卡原地更新。
 */
function reportChange(
  db: Db, change: CoreMemoryChange, undone: CoreMemoryChange | null, entityNoteId: number, now: Date,
): number | null {
  if (change.actor !== "lead" && undone?.actor !== "lead") return null;
  if (!undone && !visibleChange(change)) return null;
  const subject = (undone ? undone.before ?? undone.after : change.before ?? change.after)!;
  const payload: CoreMemoryChangedPayload = {
    noteId: entityNoteId, changeId: change.id, action: change.action, actor: change.actor, undoOf: undone?.id ?? null,
    title: subject.title, reason: redactSecretText(change.reason),
    summary: redactSecretText(coreMemoryChangeSummary(change, undone, leadDisplayName(db))),
  };
  const { event } = appendEvent(db, {
    source: change.actor === "lead" ? "lead" : "system",
    sourceRef: `core_memory_change:${change.id}`,
    kind: CORE_MEMORY_CHANGED_KIND,
    entityKey: coreMemoryEntityKey(entityNoteId),
    occurredAt: now.toISOString(),
    level: "digest",
    payload,
  }, { basis: { order: null, hardRules: [CORE_MEMORY_CHANGE_REPORTED] }, receivedAt: now });
  // Lead 自己做的事不用在下一份当前局面里再告诉它（daemon 的 leadEventRoute 跳过它），写下时就记成看过了。
  // 用户撤销 Lead 的改动留给 Lead 看：它知道用户不要这样改。
  if (change.actor === "lead") setEventDisposition(db, event.seq, "seen", null, now);
  return event.seq;
}

function publishMemory(db: Db, now: Date): void {
  publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: "memory" }, now });
}

// 写满了：给设置页的话（Lead 的工具照旧拿 store 的那一句）。
function fullError(error: CoreMemoryFullError): CoreMemoryError {
  return new CoreMemoryError(
    "invalid_input",
    `常驻偏好一共最多 ${error.cap} 字，这样改完是 ${error.total} 字。先删掉或缩短别的几条，再改这一条。`,
  );
}

// ── 写 ─────────────────────────────────────────────────────────────────────────────

export interface CoreMemoryWriteOutcome {
  // 笔记的编号（新加时是新的编号）。
  id: number;
  // 记下的改动。没碰常驻偏好、或者什么都没变时为 null。
  change: CoreMemoryChange | null;
  // 写的 core_memory.changed 的 seq。没写时为 null。
  eventSeq: number | null;
}

/** 存一条笔记（Lead 的 save_note）。存的是常驻偏好时记一行改动；Lead 存的写进 Lead 动态。 */
export function saveNoteRecorded(
  db: Db, notes: NotesMemory, args: { title: string; content: string; tags: string[]; kind?: NoteKind }, meta: CoreMemoryWriteMeta,
): CoreMemoryWriteOutcome {
  const now = meta.now ?? new Date();
  return db.transaction((): CoreMemoryWriteOutcome => {
    const id = notes.save(args);
    const note = getNote(db, id)!;
    if (!isCoreKind(note.kind)) return { id, change: null, eventSeq: null };
    const change = recordCoreMemoryChange(db, {
      noteId: id, action: "create", before: null, after: noteSnapshot(note), actor: meta.actor, reason: meta.reason, now,
    });
    const eventSeq = reportChange(db, change, null, id, now);
    publishMemory(db, now);
    return { id, change, eventSeq };
  })();
}

/**
 * 改一条笔记（Lead 的 update_note，设置页的 core_memory.update）。改前或改后是常驻偏好、而且确实变了时记一行改动。
 * 没有这条笔记时什么都不做（和 NotesMemory.update 一样）。
 */
export function updateNoteRecorded(
  db: Db, notes: NotesMemory, id: number,
  patch: { title?: string; content?: string; tags?: string[]; kind?: NoteKind }, meta: CoreMemoryWriteMeta,
): CoreMemoryWriteOutcome {
  const now = meta.now ?? new Date();
  return db.transaction((): CoreMemoryWriteOutcome => {
    const current = getNote(db, id);
    notes.update(id, patch);
    const updated = getNote(db, id);
    if (!current || !updated) return { id, change: null, eventSeq: null };
    const before = noteSnapshot(current);
    const after = noteSnapshot(updated);
    if (!touchesCore(before, after) || sameSnapshot(before, after)) return { id, change: null, eventSeq: null };
    const change = recordCoreMemoryChange(db, { noteId: id, action: "update", before, after, actor: meta.actor, reason: meta.reason, now });
    const eventSeq = reportChange(db, change, null, id, now);
    publishMemory(db, now);
    return { id, change, eventSeq };
  })();
}

/** 删一条笔记（设置页和 Lead 的 core_memory.delete）。删的是常驻偏好时记一行改动。没有这条时返回 null。 */
export function deleteNoteRecorded(db: Db, notes: NotesMemory, id: number, meta: CoreMemoryWriteMeta): CoreMemoryWriteOutcome | null {
  const now = meta.now ?? new Date();
  return db.transaction((): CoreMemoryWriteOutcome | null => {
    const current = getNote(db, id);
    if (!current || !notes.delete(id)) return null;
    if (!isCoreKind(current.kind)) return { id, change: null, eventSeq: null };
    const change = recordCoreMemoryChange(db, {
      noteId: id, action: "delete", before: noteSnapshot(current), after: null, actor: meta.actor, reason: meta.reason, now,
    });
    const eventSeq = reportChange(db, change, null, id, now);
    publishMemory(db, now);
    return { id, change, eventSeq };
  })();
}

/** 设置页和 Lead 改一条常驻偏好的标题、正文。不是常驻偏好、或者写满了时抛 CoreMemoryError。 */
export function updateCoreMemory(
  db: Db, notes: NotesMemory, id: number, patch: { title?: string; content?: string }, meta: CoreMemoryWriteMeta,
): CoreMemoryWriteOutcome {
  const title = patch.title?.trim();
  const content = patch.content?.trim();
  if (title === "" || content === "") throw new CoreMemoryError("invalid_input", "标题和正文不能是空的");
  if (title === undefined && content === undefined) throw new CoreMemoryError("invalid_input", "要改标题或者正文");
  const current = getNote(db, id);
  if (!current || !isCoreKind(current.kind)) throw new CoreMemoryError("not_found", `常驻偏好 ${id} 不存在`);
  try {
    return updateNoteRecorded(db, notes, id, { ...(title !== undefined ? { title } : {}), ...(content !== undefined ? { content } : {}) }, meta);
  } catch (error) {
    if (error instanceof CoreMemoryFullError) throw fullError(error);
    throw error;
  }
}

/** 设置页和 Lead 删一条常驻偏好。不是常驻偏好时抛 CoreMemoryError。 */
export function deleteCoreMemory(db: Db, notes: NotesMemory, id: number, meta: CoreMemoryWriteMeta): CoreMemoryWriteOutcome {
  const current = getNote(db, id);
  if (!current || !isCoreKind(current.kind)) throw new CoreMemoryError("not_found", `常驻偏好 ${id} 不存在`);
  const outcome = deleteNoteRecorded(db, notes, id, meta);
  if (!outcome) throw new CoreMemoryError("not_found", `常驻偏好 ${id} 不存在`);
  return outcome;
}

export interface CoreMemoryUndoOutcome extends CoreMemoryWriteOutcome {
  // 被撤销的那一行（已经写上撤销的时间和人）。
  undone: CoreMemoryChange;
}

/**
 * 撤销一次改动：修改恢复成改前的样子，新加的删掉，删掉的按原样重建一条（编号是新的，outcome.id）。
 * 不能撤销时抛 CoreMemoryError（conflict，原因同 coreMemoryUndoBlocker）。
 */
export function undoCoreMemoryChange(db: Db, notes: NotesMemory, changeId: number, meta: CoreMemoryWriteMeta): CoreMemoryUndoOutcome {
  const now = meta.now ?? new Date();
  try {
    return db.transaction((): CoreMemoryUndoOutcome => {
      const original = getCoreMemoryChange(db, changeId);
      if (!original) throw new CoreMemoryError("not_found", `常驻偏好的改动 ${changeId} 不存在`);
      const blocked = coreMemoryUndoBlocker(db, original);
      if (blocked) throw new CoreMemoryError("conflict", blocked);
      const common = { actor: meta.actor, reason: meta.reason, undoes: original.id, now };
      let change: CoreMemoryChange;
      if (original.action === "delete") {
        const restored = original.before!;
        const id = notes.save({ title: restored.title, content: restored.content, tags: restored.tags, kind: restored.kind });
        change = recordCoreMemoryChange(db, { ...common, noteId: id, action: "create", before: null, after: noteSnapshot(getNote(db, id)!) });
      } else if (original.action === "create") {
        const current = noteSnapshot(getNote(db, original.noteId)!);
        notes.delete(original.noteId);
        change = recordCoreMemoryChange(db, { ...common, noteId: original.noteId, action: "delete", before: current, after: null });
      } else {
        const restored = original.before!;
        const current = noteSnapshot(getNote(db, original.noteId)!);
        notes.update(original.noteId, { title: restored.title, content: restored.content, tags: restored.tags, kind: restored.kind });
        change = recordCoreMemoryChange(db, {
          ...common, noteId: original.noteId, action: "update", before: current, after: noteSnapshot(getNote(db, original.noteId)!),
        });
      }
      markCoreMemoryChangeUndone(db, original.id, { actor: meta.actor, now });
      const undone = getCoreMemoryChange(db, original.id)!;
      const eventSeq = reportChange(db, change, undone, original.noteId, now);
      publishMemory(db, now);
      return { id: change.noteId, change, eventSeq, undone };
    })();
  } catch (error) {
    if (error instanceof CoreMemoryFullError) throw fullError(error);
    throw error;
  }
}

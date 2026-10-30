// Hindsight 里一条事实的失效和恢复（用户 2026-10-29：「hindsight 的 invalidate 机制要有啊」，
// .scratch/hindsight-primary-memory/spec.md D5）。设置页和 Lead（invalidate_memory、perform_action）都经过操作层的
// memory_fact，操作调这里：
//   - NotesMemory.invalidate 改 Hindsight（PATCH state），在一个事务里记一行（memory_invalidations：谁、依据、原文、来源）。
//   - Lead 的失效和恢复、和撤销 Lead 的失效（不管谁撤销），在同一个事务里写一条 memory_fact.changed（digest 级）：
//     「Lead 动态」里出现一张卡，带「撤销」（恢复）。用户自己在设置页做的不写这条事件。
//   - 每次以后网关发 snapshot.required（{resource: "memory"}），设置页重新读失效的列表。
import {
  MEMORY_FACT_CHANGED_KIND, memoryFactEntityKey, redactSecretText,
  type MemoryFactChangedPayload, type MemoryInvalidatedFactDto,
} from "@pi-lead-child/protocol";
import {
  appendEvent, getNote, latestMemoryInvalidation, leadDisplayName, listInvalidatedFacts, publishGatewayEvent, setEventDisposition,
  type Db, type MemoryInvalidation,
} from "@pi-lead-child/store";
import { noteIdFromSourceKey } from "./backend.js";
import type { InvalidatedFact, NotesMemory } from "./notes-memory.js";

// 事件的分诊依据：硬性规则，常设指令改不了它。
export const MEMORY_FACT_CHANGE_REPORTED = "memory_fact_change_reported";

export interface MemoryFactChangeOutcome {
  fact: InvalidatedFact;
  record: MemoryInvalidation;
  // 这次恢复撤销的是哪一次 Lead 的失效（记录编号）。
  undoOf: number | null;
  // 写的 memory_fact.changed 的 seq。没写时为 null。
  eventSeq: number | null;
}

function quote(text: string | null, max = 80): string {
  if (text === null) return "（原文没读到）";
  const flat = text.replace(/\s+/gu, " ").trim();
  return `「${flat.length > max ? `${flat.slice(0, max)}…` : flat}」`;
}

function basisText(reason: string): string {
  const flat = reason.replace(/\s+/gu, " ").trim().replace(/[。.]+$/u, "");
  if (!flat) return "";
  return `依据：${flat.length > 200 ? `${flat.slice(0, 200)}…` : flat}。`;
}

function sourceText(fact: InvalidatedFact): string {
  const external = fact.origin === "external" ? "外部对话整理的" : "";
  if (fact.note) return `（来自「${fact.note.title}」${external ? `，${external}` : ""}）`;
  return external ? `（${external}）` : "";
}

/** 一次失效或恢复对用户说的那句话。 */
export function memoryFactChangeSummary(
  record: MemoryInvalidation, fact: InvalidatedFact, undone: MemoryInvalidation | null, leadName: string,
): string {
  const who = record.actor === "lead" ? `${leadName} ` : "你";
  if (record.action === "invalidated") {
    return `${who}让一条记忆失效：${quote(fact.text)}${sourceText(fact)}。以后召回不到它。${basisText(record.reason)}`;
  }
  if (undone) {
    const owner = undone.actor === record.actor ? "自己" : undone.actor === "lead" ? ` ${leadName} ` : "你";
    return `${who}恢复了${owner}让它失效的记忆：${quote(fact.text)}${sourceText(fact)}。${record.actor === "lead" ? basisText(record.reason) : ""}`;
  }
  return `${who}恢复了一条记忆：${quote(fact.text)}${sourceText(fact)}。${basisText(record.reason)}`;
}

// Lead 做的、和撤销 Lead 的失效写一条 memory_fact.changed（调用方在写事务里）。别的不写，返回 null。
function reportFactChange(
  db: Db, record: MemoryInvalidation, fact: InvalidatedFact, undone: MemoryInvalidation | null, now: Date,
): number | null {
  if (record.actor !== "lead" && undone?.actor !== "lead") return null;
  const payload: MemoryFactChangedPayload = {
    memoryId: record.memoryId, invalidationId: record.id, action: record.action, actor: record.actor === "lead" ? "lead" : "user",
    undoOf: undone?.id ?? null, text: fact.text === null ? null : redactSecretText(fact.text),
    noteId: fact.note?.id ?? noteIdFromSourceKey(fact.sourceKey), noteTitle: fact.note?.title ?? null,
    external: fact.origin === "external", reason: redactSecretText(record.reason),
    summary: redactSecretText(memoryFactChangeSummary(record, fact, undone, leadDisplayName(db))),
  };
  const { event } = appendEvent(db, {
    source: record.actor === "lead" ? "lead" : "system",
    sourceRef: `memory_invalidation:${record.id}`,
    kind: MEMORY_FACT_CHANGED_KIND,
    entityKey: memoryFactEntityKey(record.memoryId),
    occurredAt: now.toISOString(),
    level: "digest",
    payload,
  }, { basis: { order: null, hardRules: [MEMORY_FACT_CHANGE_REPORTED] }, receivedAt: now });
  // Lead 自己做的事不用在下一份当前局面里再告诉它（daemon 的 leadEventRoute 跳过它），写下时就记成看过了。
  if (record.actor === "lead") setEventDisposition(db, event.seq, "seen", null, now);
  return event.seq;
}

/**
 * 让一条事实失效（restore 时恢复）。guard 在 Hindsight 改之前拿到这条事实（来源笔记、原文、来源），抛错时什么也不改。
 * Hindsight 不能用、没有这条、或者它是观察时抛错（NotesMemory.invalidate）。
 */
export async function changeMemoryFact(db: Db, notes: NotesMemory, memoryId: string, opts: {
  restore: boolean; actor: "user" | "lead"; reason: string; now?: Date; guard?: (fact: InvalidatedFact) => void;
}): Promise<MemoryFactChangeOutcome> {
  const now = opts.now ?? new Date();
  const previous = latestMemoryInvalidation(db, memoryId);
  let undoOf: number | null = null;
  let eventSeq: number | null = null;
  const result = await notes.invalidate(memoryId, {
    reason: opts.reason, actor: opts.actor, now, ...(opts.restore ? { restore: true } : {}), ...(opts.guard ? { guard: opts.guard } : {}),
    recorded: (record, fact) => {
      const undone = opts.restore && previous?.action === "invalidated" && previous.actor === "lead" ? previous : null;
      undoOf = undone?.id ?? null;
      eventSeq = reportFactChange(db, record, fact, undone, now);
      publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: "memory" }, now });
    },
  });
  const { record, ...fact } = result;
  return { fact, record, undoOf, eventSeq };
}

/** 设置页的失效列表：现在失效着的事实，最近失效的在前。 */
export function invalidatedMemoryFacts(db: Db, limit = 20): MemoryInvalidatedFactDto[] {
  return listInvalidatedFacts(db, limit).map((record) => {
    const noteId = noteIdFromSourceKey(record.documentId);
    const note = noteId === null ? null : getNote(db, noteId);
    return {
      memoryId: record.memoryId, text: record.text, note: note ? { id: note.id, title: note.title } : null,
      external: record.origin === "external", reason: record.reason, actor: record.actor === "user" ? "user" : "lead",
      at: record.createdAt,
    };
  });
}

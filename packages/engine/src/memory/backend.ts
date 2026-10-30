// Lead 记忆的外部后端（.scratch/hindsight-primary-memory/spec.md）。用户在 PLC_MEMORY_BACKEND 里选后端，第一个实现是 Hindsight。
// 选了 Hindsight 时它是主后端：写入、更新、失效、召回都用它自己的机制。SQLite 的 notes 是镜像：两边都写，
// Hindsight 不可用时召回才改用 SQLite 的全文检索；换了 embedding（新的记忆库）时从 notes 重放。
import type { NoteKind } from "@pi-lead-child/store";

// 写进后端的一条记忆。sourceKey 是它在后端的文档编号：同一个 sourceKey 再写一次就替换旧的内容。
export interface MemoryItem {
  sourceKey: string;
  content: string;
  kind: NoteKind;
  // 记忆发生或者最近一次更新的时间（ISO 8601）。
  occurredAt: string;
  context: string;
  // 来源：用户本人和 Lead（user），或者外部通道里别人说的话（external）。两种来源的观察分开整理（spec D14）。
  origin: "user" | "external";
}

// Hindsight 的记忆类型：world、experience 是从文档里提取的事实，observation 是它整理多条事实得出的观察。
export type MemoryHitType = "world" | "experience" | "observation";

// 一条召回结果。
export interface MemoryHit {
  // 后端里这条记忆的编号（失效用）。没有时是 null。
  id: string | null;
  type: MemoryHitType | null;
  text: string;
  // 这条记忆来自哪些文档：事实是它自己的文档；观察是它整理的那些事实的文档。
  sourceKeys: string[];
  // 记忆发生的时间（ISO 8601）。不知道时是 null。
  occurredAt: string | null;
  // 来自外部来源（带 origin:external 标签）：记的是别人说的话。
  external: boolean;
  // 只在同一个后端的结果之间可比。
  score: number | null;
}

// 后端里一个异步任务的状态。gone：任务过了保留期、查不到了（Hindsight 只清理结束了的任务）。
export type MemoryOperationState = "pending" | "completed" | "failed" | "gone";

export interface MemoryOperationStatus {
  state: MemoryOperationState;
  error: string | null;
}

// 记忆库的统计（Hindsight 的 /stats）。
export interface MemoryStats {
  documents: number;
  facts: number;
  observations: number;
  // 还没整理进观察的事实条数。
  pendingConsolidation: number;
}

// 后端拒收这条内容（例如 Hindsight 回 400、413、415、422）。再写一次结果一样，所以 NotesMemory 记下次数，
// 多次之后标为失败。后端挂了（网络、5xx、408、429）不是拒收：下次用同一个任务编号再发。
export class MemoryRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 这条记忆在后端里没有（例如已经删了），或者它不能这样改（例如观察不能失效）。
export class MemoryNotFoundError extends Error {}

// 要失效或恢复的那一条事实（改之前从后端读到的）。
export interface MemoryFactInfo {
  // 它的文档编号（note-<编号>）。不知道时为 null。
  sourceKey: string | null;
  // 事实的原文。读不到时为 null。
  text: string | null;
  // 带 origin:external 标签：记的是别人说的话。后端没给标签时为 null。
  external: boolean | null;
}

export interface MemoryBackend {
  readonly name: string;
  // 记忆库的身份。它变了（例如 Hindsight 换了 embedding 模型、换到一个新库），NotesMemory 就把 notes 重放进新库。
  readonly index?: string;
  // 交给后端异步处理。operationId 由调用方生成：同一个编号重发时后端不重复做。
  remember(item: MemoryItem, opts: { operationId: string; signal?: AbortSignal }): Promise<void>;
  operation(operationId: string, signal?: AbortSignal): Promise<MemoryOperationStatus>;
  // 让一个失败的任务再跑一次。
  retryOperation(operationId: string, signal?: AbortSignal): Promise<void>;
  recall(query: string, opts: { limit: number; kind?: NoteKind; signal?: AbortSignal }): Promise<MemoryHit[]>;
  // 删掉这些文档，以及由它们推出的事实和观察。
  forget(sourceKeys: string[], signal?: AbortSignal): Promise<void>;
  // 让一条事实失效（restore 时恢复）。返回这条事实（文档编号、原文、来源标签）。guard 在改之前拿到它，抛错时什么也不改。
  invalidate(memoryId: string, opts: {
    reason: string; restore?: boolean; signal?: AbortSignal; guard?: (fact: MemoryFactInfo) => void;
  }): Promise<MemoryFactInfo>;
  stats(signal?: AbortSignal): Promise<MemoryStats | null>;
  // 后端能不能用。
  healthy(signal?: AbortSignal): Promise<boolean>;
}

// 用户选的后端（PLC_MEMORY_BACKEND）。缺省是 hindsight（2026-10-16 用户决定）；sqlite 表示不用外部后端，
// 只用 notes 的全文检索。以后加 OpenViking 时在这里加一个名字。
export const MEMORY_BACKENDS = ["hindsight", "sqlite"] as const;
export type MemoryBackendName = (typeof MEMORY_BACKENDS)[number];

export function memoryBackendSetting(env: Record<string, string | undefined> = process.env): MemoryBackendName {
  const raw = env.PLC_MEMORY_BACKEND?.trim() || "hindsight";
  if (!(MEMORY_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(`PLC_MEMORY_BACKEND=${raw}: use one of ${MEMORY_BACKENDS.join(", ")}`);
  }
  return raw as MemoryBackendName;
}

// 笔记在后端的身份。
export function noteSourceKey(noteId: number): string {
  return `note-${noteId}`;
}

export function noteIdFromSourceKey(sourceKey: string | null): number | null {
  const match = sourceKey ? /^note-([1-9]\d{0,15})$/.exec(sourceKey) : null;
  return match ? Number(match[1]) : null;
}

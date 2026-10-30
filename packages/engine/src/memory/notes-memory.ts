// Lead 的笔记记忆（.scratch/hindsight-primary-memory/spec.md）。选了 Hindsight 时它是主后端，SQLite 的 notes 是镜像。
// - 写：先写 notes，Lead 马上能读到；然后在后台交给 Hindsight（每条笔记一个异步任务，编号由我们生成）。
// - 跟踪（D3）：memory_sync 表记下每个记忆库里每条笔记的任务。同步时查任务状态：完成了标完成；失败了让 Hindsight
//   重试，到上限后标失败、告诉 daemon（设置页显示条数和原因）。HTTP 请求失败时行留在 queued，下次用同一个编号重发，
//   Hindsight 不会重复做。笔记改了（指纹变了）就用新编号再写一次。换了记忆库（新的 embedding）时新库没有行，
//   等于把 notes 重放进去。
// - 读（D6）：召回只走一个后端。Hindsight 可用时只问它（事实和观察），不跑 SQLite 全文检索；下面几种情况改用
//   SQLite 全文检索，并在结果里写明原因：服务没在运行（down）、这次召回报错（error）、超时（timeout）、
//   当前记忆库里一条完成的笔记都没有（not_ready）。没有选 Hindsight 时就是 SQLite，不算兜底。
// - 删（slack-takeover 工单 07）：先删 notes 里的那一行，同时把它在后端的身份（note-<id>）记进「待忘掉」的清单（kv）；
//   每次同步先让后端忘掉清单里的，忘掉了才从清单里拿掉。Hindsight 删文档时连带删掉由它推出的事实和观察。
// - 失效（D5）：让 Hindsight 里的一条事实失效或者恢复（操作层的 memory_fact，memory-facts.ts）。memory_invalidations 记一行
//   （谁、依据、原文、来源）。最近召回到的记忆留一份缓存：操作层先按它判断一条记忆的来源（用户本人还是外部对话）。
import { createHash, randomUUID } from "node:crypto";
import { redactSecretText } from "@pi-lead-child/protocol";
import {
  deleteMemorySync, deleteNote, getNote, invalidatedFactsByDocument, listMemorySync, noteSyncCounts, notesChangedSince,
  queueMemorySync, recordMemoryInvalidation, recordMemoryRecall, resetFailedMemorySync, saveNote, searchNotes,
  setMemorySyncState, updateNote,
  type Db, type MemoryFactOrigin, type MemoryInvalidation, type MemorySyncRow, type Note, type NoteKind,
} from "@pi-lead-child/store";
import {
  MemoryRejectedError, noteIdFromSourceKey, noteSourceKey,
  type MemoryBackend, type MemoryFactInfo, type MemoryHitType, type MemoryItem, type MemoryStats,
} from "./backend.js";
import { isChannelMemoryNote } from "../channels/memory.js";

// 一条笔记被后端拒收（400、422……）这么多次，或者它的任务在 Hindsight 里失败这么多次，就标为失败。
const ATTEMPT_LIMIT = 3;
const RECALL_LIMIT = 10;
const RECALL_TIMEOUT_MS = 5_000;
// 最近召回到的记忆最多记这么多条（操作层按它判断一条记忆的来源）。
const RECALLED_CACHE = 500;
// 待忘掉的清单（后端身份）。不分记忆库。最多留这么多条：没有外部后端时清单一直不会清空，不能无限长。
const FORGET_KEY = "memory.pending_forget";
const MAX_PENDING_FORGET = 1_000;

function fingerprint(note: Note): string {
  return createHash("sha256").update(JSON.stringify([note.title, note.content, note.kind, note.tags])).digest("hex").slice(0, 16);
}

// 改用 SQLite 的原因（D6）。
export type RecallFallbackReason = "down" | "error" | "timeout" | "not_ready";

// Hindsight 召回到的一条记忆。
export interface RecalledMemory {
  // Hindsight 里的编号。invalidate_memory 用它。
  id: string | null;
  type: MemoryHitType | null;
  text: string;
  occurredAt: string | null;
  // 来自外部来源：记的是别人说的话（Hindsight 的 origin:external 标签，或者来源笔记是外部对话整理的）。
  external: boolean;
  // 它来自哪些笔记（还在的）。external：这条笔记是从外部通道的对话整理来的，记的是别人说的话。
  notes: Array<{ id: number; title: string; kind: NoteKind; external: boolean }>;
}

export interface NoteSearchResult {
  // 回答这次召回的后端。
  backend: "hindsight" | "sqlite";
  // 主后端是 Hindsight、这次改用了 SQLite 时的原因。没有改用时是 null。
  fallback: RecallFallbackReason | null;
  // 原因的说明（脱敏过）。
  detail: string | null;
  // backend 是 hindsight 时：召回到的记忆。
  memories: RecalledMemory[];
  // backend 是 sqlite 时：全文检索到的笔记。
  notes: Note[];
  // 改用 SQLite 时：每条笔记有几条事实在 Hindsight 里被标为失效（笔记编号 → 条数）。
  invalidatedFacts: Record<number, number>;
  // backend 是 hindsight 时：当前记忆库里还在处理、写入失败的笔记条数。这些笔记这次召回不到。
  writes: { pending: number; failed: number } | null;
}

// 要失效或恢复的那一条事实：来源笔记（还在时）、原文、来源（外部对话整理的是 external，不知道时按用户本人算）。
export interface InvalidatedFact {
  note: Note | null;
  sourceKey: string | null;
  text: string | null;
  origin: MemoryFactOrigin;
}

export interface NoteWriteStatus {
  notes: number;
  completed: number;
  pending: number;
  failed: number;
  lastError: string | null;
}

export interface NotesMemoryOptions {
  log?: (line: string) => void;
  recallTimeoutMs?: number;
  // 有笔记的写入任务刚标为失败时调用（每次同步最多一次）：daemon 告诉 Lead，设置页显示。
  onWriteFailed?: (status: NoteWriteStatus) => void;
}

// SQLite 的时间（UTC，"YYYY-MM-DD HH:MM:SS"）转成 ISO 8601。
function isoTime(sqliteTime: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqliteTime) ? `${sqliteTime.replace(" ", "T")}Z` : sqliteTime;
}

export function noteMemoryItem(note: Note): MemoryItem {
  const external = isChannelMemoryNote(note);
  return {
    sourceKey: noteSourceKey(note.id),
    content: `${note.title}\n${note.content}`,
    kind: note.kind,
    occurredAt: isoTime(note.updated_at),
    context: external
      ? "Facts a personal assistant distilled from a conversation among other people in a team chat. They record what others said, not the user's own wishes."
      : `A long-term note that a personal assistant saved about its user and their work (kind: ${note.kind}).`,
    origin: external ? "external" : "user",
  };
}

const errorText = (error: unknown) => redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 300);

export class NotesMemory {
  private syncing: Promise<number> | null = null;
  private syncAgain = false;
  private failing = false;
  // daemon 关机：正在跑的同步停下，不等写完全部笔记。
  private stopped = false;
  private abort: AbortController | null = null;
  // 主后端是 Hindsight 但它现在不能用（正在启动、停了、没起来）时的说明。null：能用，或者没选 Hindsight。
  private unavailable: string | null = null;
  // 最近召回到的记忆（编号 → 召回时的样子），旧的在前。daemon 重启后是空的。
  private readonly recalled = new Map<string, RecalledMemory>();

  constructor(
    private readonly db: Db,
    private backend: MemoryBackend | null,
    private readonly options: NotesMemoryOptions = {},
  ) {}

  // 换后端（热重载：用户换了 embedding，Hindsight 换到新库）。新库没有任务记录，下一次同步把 notes 全部写过去。
  setBackend(backend: MemoryBackend | null): void {
    this.backend = backend;
    this.failing = false;
    if (backend) void this.sync();
  }

  // daemon 的健康检查告诉这里：选了 Hindsight，但它现在不能用（说明原因）。null 表示能用，或者没选 Hindsight。
  // 不能用时召回改用 SQLite，原因是 down。
  setUnavailable(reason: string | null): void {
    this.unavailable = reason;
  }

  // daemon 关机时调用：停掉正在跑的同步，之后不再同步。
  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  get backendName(): string | null {
    return this.backend?.name ?? null;
  }

  private bankIndex(backend: MemoryBackend): string {
    return `${backend.name}${backend.index ? `.${backend.index}` : ""}`;
  }

  private noteCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  }

  // 当前记忆库里笔记的写入情况。设置页和 Lead 的环境说明显示它。没有后端时全是 0。
  writeStatus(): NoteWriteStatus {
    if (!this.backend) return { notes: this.noteCount(), completed: 0, pending: 0, failed: 0, lastError: null };
    return noteSyncCounts(this.db, this.bankIndex(this.backend));
  }

  // 旧的「已索引 N/M」（设置页的 DTO 还有这个字段）：indexed 是写完的条数。
  progress(): { notes: number; indexed: number } {
    const status = this.writeStatus();
    return { notes: status.notes, indexed: Math.min(status.completed, status.notes) };
  }

  // 失败的写入重新排队（用户修好原因以后，设置页的「重试失败的」）。返回重新排队的条数。
  retryFailed(): number {
    if (!this.backend) return 0;
    const count = resetFailedMemorySync(this.db, this.bankIndex(this.backend));
    if (count) void this.sync();
    return count;
  }

  // Hindsight 记忆库的统计。没有后端或者查不到时是 null。
  async stats(signal?: AbortSignal): Promise<MemoryStats | null> {
    const backend = this.backend;
    if (!backend || this.unavailable) return null;
    try {
      return await backend.stats(signal);
    } catch {
      return null;
    }
  }

  save(args: { title: string; content: string; tags: string[]; kind?: NoteKind }): number {
    const id = saveNote(this.db, args);
    this.scheduleSync();
    return id;
  }

  update(id: number, patch: { title?: string; content?: string; tags?: string[]; kind?: NoteKind }): void {
    updateNote(this.db, id, patch);
    this.scheduleSync();
  }

  /**
   * 删掉一条笔记，并让后端忘掉它。删行和记进待忘掉的清单在同一个事务里：进程在这之后崩溃，下次同步照样补做。
   * 返回删没删掉（没有这条笔记时是 false，也不用忘掉什么）。
   */
  delete(id: number): boolean {
    const removed = this.db.transaction(() => {
      if (!deleteNote(this.db, id)) return false;
      this.writePendingForget([...this.pendingForget().filter((key) => key !== noteSourceKey(id)), noteSourceKey(id)]);
      return true;
    })();
    if (removed) this.scheduleSync();
    return removed;
  }

  // 现在为什么不能让 Hindsight 的事实失效或者恢复（一句话，不带句号）。能时为 null。
  invalidationBlocker(): string | null {
    if (!this.backend) return "记忆后端不是 Hindsight：只有 Hindsight 的事实能失效。笔记整条过时时用 update_note 改它";
    if (this.unavailable) return `Hindsight 现在不能用：${this.unavailable}`;
    return null;
  }

  /** 最近召回到的这条记忆（召回时的样子）。没有召回过、或者已经挤出缓存时为 null。 */
  recalledMemory(memoryId: string): RecalledMemory | null {
    return this.recalled.get(memoryId) ?? null;
  }

  private rememberRecalled(memories: readonly RecalledMemory[]): void {
    for (const memory of memories) {
      if (!memory.id) continue;
      this.recalled.delete(memory.id);
      this.recalled.set(memory.id, memory);
    }
    while (this.recalled.size > RECALLED_CACHE) this.recalled.delete(this.recalled.keys().next().value!);
  }

  // 这条事实是谁说的：带 origin:external 标签，或者来源笔记是外部对话整理的，就是外部来源；
  // 后端没给标签、也找不到来源笔记时，看召回时的样子；都不知道时按用户本人算。
  private factSubject(memoryId: string, info: MemoryFactInfo): InvalidatedFact {
    const id = noteIdFromSourceKey(info.sourceKey);
    const note = id === null ? null : getNote(this.db, id);
    const cached = this.recalled.get(memoryId) ?? null;
    const external = info.external === true || (note !== null && isChannelMemoryNote(note))
      || (info.external === null && note === null && cached?.external === true);
    return { note, text: info.text ?? cached?.text ?? null, origin: external ? "external" : "user", sourceKey: info.sourceKey };
  }

  /**
   * 让 Hindsight 里的一条事实失效（restore 时恢复），并记一行（memory_invalidations：谁、依据、原文、来源）。
   * guard 在改之前拿到这条事实（来源笔记、原文、来源）：它抛错时什么也不改。recorded 在记这一行的同一个事务里调用。
   * 没有选 Hindsight、或者它现在不能用时抛错。
   */
  async invalidate(memoryId: string, opts: {
    reason: string; restore?: boolean; actor: string; now?: Date;
    guard?: (fact: InvalidatedFact) => void;
    recorded?: (record: MemoryInvalidation, fact: InvalidatedFact) => void;
  }): Promise<InvalidatedFact & { record: MemoryInvalidation }> {
    const backend = this.backend;
    const blocked = this.invalidationBlocker();
    if (!backend || blocked) throw new Error(blocked ?? "记忆后端不是 Hindsight");
    let subject: InvalidatedFact | null = null;
    const info = await backend.invalidate(memoryId, {
      reason: opts.reason,
      ...(opts.restore ? { restore: true } : {}),
      signal: AbortSignal.timeout(this.options.recallTimeoutMs ?? RECALL_TIMEOUT_MS),
      guard: (fact) => {
        subject = this.factSubject(memoryId, fact);
        opts.guard?.(subject);
      },
    });
    const fact: InvalidatedFact = subject ?? this.factSubject(memoryId, info);
    const record = this.db.transaction((): MemoryInvalidation => {
      const written = recordMemoryInvalidation(this.db, {
        bankIndex: this.bankIndex(backend), memoryId, documentId: info.sourceKey,
        action: opts.restore ? "restored" : "invalidated", reason: redactSecretText(opts.reason), actor: opts.actor,
        text: fact.text === null ? null : redactSecretText(fact.text), origin: fact.origin, ...(opts.now ? { now: opts.now } : {}),
      });
      opts.recorded?.(written, fact);
      return written;
    })();
    return { ...fact, record };
  }

  // 还没让后端忘掉的笔记身份（note-<id>），先删的在前。
  pendingForget(): string[] {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(FORGET_KEY) as { value: string } | undefined;
    if (!row) return [];
    try {
      const keys = JSON.parse(row.value) as unknown;
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
    } catch {
      return [];
    }
  }

  private writePendingForget(keys: string[]): void {
    if (!keys.length) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(FORGET_KEY);
      return;
    }
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(FORGET_KEY, JSON.stringify(keys.slice(-MAX_PENDING_FORGET)));
  }

  // 让后端忘掉清单里的身份。忘掉了的从清单里拿掉（读的是最新的清单：等后端的时候可能又删了别的），
  // 也从这个记忆库的任务记录里删掉。后端拒收某一个身份时只记一行日志并拿掉它；后端挂了时抛错，清单留着。
  private async forgetPending(backend: MemoryBackend, signal: AbortSignal): Promise<void> {
    const keys = this.pendingForget();
    if (!keys.length) return;
    const done: string[] = [];
    for (const key of keys) {
      if (this.stopped) break;
      try {
        await backend.forget([key], signal);
      } catch (error) {
        if (!(error instanceof MemoryRejectedError)) throw error;
        this.options.log?.(`[memory] ${backend.name} refused to forget ${key}: ${errorText(error).slice(0, 200)}`);
      }
      done.push(key);
    }
    const forgotten = new Set(done);
    this.writePendingForget(this.pendingForget().filter((key) => !forgotten.has(key)));
    deleteMemorySync(this.db, this.bankIndex(backend), done);
  }

  // 召回（D6）。Hindsight 可用时只问它；不能用时改用 SQLite 全文检索，并写明原因。
  async search(query: string, opts: { kind?: NoteKind; limit?: number } = {}): Promise<NoteSearchResult> {
    const backend = this.backend;
    if (!backend) {
      return this.unavailable ? this.fallback(query, opts, "down", `Hindsight 没在运行：${this.unavailable}`, null) : this.fullText(query, opts, null, null);
    }
    if (this.unavailable) return this.fallback(query, opts, "down", `Hindsight 没在运行：${this.unavailable}`, backend);
    const status = this.writeStatus();
    if (status.notes > 0 && status.completed === 0) {
      const detail = status.failed > 0
        ? `当前记忆库里没有一条笔记写完，${status.failed} 条写入失败（${status.lastError ?? "原因不明"}）`
        : `当前记忆库里还没有一条笔记写完（${status.pending} 条在处理），索引还没好`;
      return this.fallback(query, opts, "not_ready", detail, backend);
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.options.recallTimeoutMs ?? RECALL_TIMEOUT_MS);
    try {
      const hits = await backend.recall(query, { limit: opts.limit ?? RECALL_LIMIT, ...(opts.kind ? { kind: opts.kind } : {}), signal: timeout });
      const memories: RecalledMemory[] = [];
      for (const hit of hits) {
        const notes = hit.sourceKeys.flatMap((key) => {
          const id = noteIdFromSourceKey(key);
          const note = id === null ? null : getNote(this.db, id);
          return note ? [{ id: note.id, title: note.title, kind: note.kind, external: isChannelMemoryNote(note) }] : [];
        });
        // 只来自已经删掉的笔记：Hindsight 还没删完，不给。
        if (hit.sourceKeys.length && !notes.length && hit.sourceKeys.every((key) => noteIdFromSourceKey(key) !== null)) continue;
        memories.push({
          id: hit.id, type: hit.type, text: hit.text, occurredAt: hit.occurredAt,
          external: hit.external || notes.some((note) => note.external), notes,
        });
      }
      this.rememberRecalled(memories);
      this.recordRecall(backend.name, started, { ok: true, error: null, hits: memories.length, fallback: null });
      return {
        backend: "hindsight", fallback: null, detail: null, memories, notes: [], invalidatedFacts: {},
        writes: { pending: status.pending, failed: status.failed },
      };
    } catch (error) {
      const reason: RecallFallbackReason = timeout.aborted ? "timeout" : "error";
      const limit = this.options.recallTimeoutMs ?? RECALL_TIMEOUT_MS;
      const detail = reason === "timeout"
        ? `Hindsight 召回超时（${limit >= 1000 ? `${Math.round(limit / 1000)} 秒` : `${limit} 毫秒`}）`
        : `Hindsight 召回出错：${errorText(error)}`;
      return this.fallback(query, opts, reason, detail, backend, started);
    }
  }

  private fullText(query: string, opts: { kind?: NoteKind; limit?: number }, reason: RecallFallbackReason | null, detail: string | null): NoteSearchResult {
    const notes = searchNotes(this.db, query, { ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.limit ? { limit: opts.limit } : {}) });
    const counts = reason ? invalidatedFactsByDocument(this.db, notes.map((note) => noteSourceKey(note.id))) : new Map<string, number>();
    const invalidatedFacts: Record<number, number> = {};
    for (const [key, count] of counts) {
      const id = noteIdFromSourceKey(key);
      if (id !== null) invalidatedFacts[id] = count;
    }
    return { backend: "sqlite", fallback: reason, detail, memories: [], notes, invalidatedFacts, writes: null };
  }

  private fallback(
    query: string, opts: { kind?: NoteKind; limit?: number }, reason: RecallFallbackReason, detail: string,
    backend: MemoryBackend | null, started = Date.now(),
  ): NoteSearchResult {
    const result = this.fullText(query, opts, reason, detail);
    this.recordRecall(backend?.name ?? "hindsight", started, { ok: false, error: detail, hits: 0, fallback: reason });
    return result;
  }

  // 每次选了 Hindsight 的召回写一条 memory.recalled 事件（工单 13，spec D17）：get_system_usage 从事件日志汇总。
  // 改用 SQLite 时 ok 是 false，写明原因。只记后端、耗时、成败和条数，不记查询原文。写不进去时只记一行日志。
  private recordRecall(backend: string, started: number, result: {
    ok: boolean; error: string | null; hits: number; fallback: RecallFallbackReason | null;
  }): void {
    try {
      recordMemoryRecall(this.db, { backend, latencyMs: Date.now() - started, ...result });
    } catch (error) {
      this.options.log?.(`[memory] recall event not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 同步：忘掉删了的笔记，交出新的和改了的笔记，查交出去的任务。同一时刻只跑一个；跑的过程中又有写入时，跑完再跑一次。
  sync(): Promise<number> {
    if (!this.backend || this.stopped) return Promise.resolve(0);
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = this.syncOnce().finally(() => {
      this.syncing = null;
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.sync();
      }
    });
    return this.syncing;
  }

  // 返回这次交出去的笔记条数。
  private async syncOnce(): Promise<number> {
    const backend = this.backend!;
    const index = this.bankIndex(backend);
    const abort = new AbortController();
    this.abort = abort;
    let submitted = 0;
    let newlyFailed = 0;
    try {
      // 先忘掉删了的笔记：同步是一个接一个跑的，删之前已经交出去的旧内容，总在这之前交完。
      await this.forgetPending(backend, abort.signal);
      const rows = new Map(listMemorySync(this.db, index).map((row) => [row.documentId, row]));
      for (const note of notesChangedSince(this.db, null)) {
        if (this.stopped) break;
        const result = await this.submit(backend, index, note, rows.get(noteSourceKey(note.id)) ?? null, abort.signal);
        if (result === "submitted") submitted += 1;
        if (result === "failed") newlyFailed += 1;
      }
      for (const row of listMemorySync(this.db, index, ["submitted"])) {
        if (this.stopped) break;
        if (await this.check(backend, row, abort.signal) === "failed") newlyFailed += 1;
      }
      if (this.failing) this.options.log?.(`[memory] ${backend.name} sync recovered`);
      this.failing = false;
    } catch (error) {
      // 后端挂着的时候每次同步都会失败。只在开始失败时记一行，不刷屏。
      if (!this.failing) this.options.log?.(`[memory] ${backend.name} sync failed, will retry: ${errorText(error)}`);
      this.failing = true;
    }
    if (newlyFailed) this.options.onWriteFailed?.(this.writeStatus());
    return submitted;
  }

  // 交出一条笔记。已经交过同样内容的不再交；还在 queued 的（上次 HTTP 失败）用同一个任务编号重发。
  // 后端拒收时记次数，到上限标失败。后端挂了时抛错：这次同步停下，下次接着来。
  private async submit(
    backend: MemoryBackend, index: string, note: Note, row: MemorySyncRow | null, signal: AbortSignal,
  ): Promise<"skipped" | "submitted" | "failed" | "rejected"> {
    const documentId = noteSourceKey(note.id);
    const print = fingerprint(note);
    if (row && row.fingerprint === print && row.state !== "queued") return "skipped";
    let operationId: string;
    let attempts = 0;
    if (row && row.fingerprint === print) {
      operationId = row.operationId;
      attempts = row.attempts;
    } else {
      operationId = randomUUID();
      queueMemorySync(this.db, { bankIndex: index, documentId, fingerprint: print, operationId });
    }
    const key = { bankIndex: index, documentId, operationId };
    try {
      await backend.remember(noteMemoryItem(note), { operationId, signal });
    } catch (error) {
      if (!(error instanceof MemoryRejectedError)) throw error;
      attempts += 1;
      const failed = attempts >= ATTEMPT_LIMIT;
      setMemorySyncState(this.db, key, { state: failed ? "failed" : "queued", attempts, error: errorText(error) });
      if (failed) this.options.log?.(`[memory] ${backend.name} rejected note #${note.id} ${ATTEMPT_LIMIT} times: ${errorText(error).slice(0, 200)}`);
      return failed ? "failed" : "rejected";
    }
    setMemorySyncState(this.db, key, { state: "submitted", attempts, error: null });
    return "submitted";
  }

  // 查一个交出去的任务。失败时让 Hindsight 重试，到上限标失败。
  private async check(backend: MemoryBackend, row: MemorySyncRow, signal: AbortSignal): Promise<"pending" | "completed" | "failed"> {
    const key = { bankIndex: row.bankIndex, documentId: row.documentId, operationId: row.operationId };
    const status = await backend.operation(row.operationId, signal);
    if (status.state === "pending") return "pending";
    if (status.state === "completed" || status.state === "gone") {
      setMemorySyncState(this.db, key, { state: "completed", error: null });
      return "completed";
    }
    const attempts = row.attempts + 1;
    const error = redactSecretText(status.error ?? "failed").slice(0, 300);
    if (attempts >= ATTEMPT_LIMIT) {
      setMemorySyncState(this.db, key, { state: "failed", attempts, error });
      this.options.log?.(`[memory] ${backend.name} could not write ${row.documentId} after ${ATTEMPT_LIMIT} attempts: ${error.slice(0, 200)}`);
      return "failed";
    }
    await backend.retryOperation(row.operationId, signal);
    setMemorySyncState(this.db, key, { state: "submitted", attempts, error });
    return "pending";
  }

  private scheduleSync(): void {
    void this.sync();
  }

  // 等正在跑的同步结束。daemon 关库之前调它。
  async idle(): Promise<void> {
    while (this.syncing) await this.syncing;
  }

  // 定时同步：补上后端挂着时没交出去的笔记，查交出去的任务。返回停止函数。
  startPeriodicSync(intervalMs = 60_000): () => void {
    void this.sync();
    const timer = setInterval(() => void this.sync(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

// shadow 按对话复用会话（工单 #588）。外部消息按会话分组键（通道适配器给的，例如一个 Slack 私信）进同一个会话：
//   - 会话存成文件（pi 的 SessionManager.create / open），会话行和工作记录在账本里（store 的 shadow-conversations.ts）。
//   - 同一组同时只跑一批，排队；不同组可以并行，总数有上限（ShadowConversationPool）。
//   - 闲置 idleMs（缺省 5 分钟）卸载：释放内存，文件留着。还有一批在跑或者在排队时不卸载。
//   - 重开（不复用文件，用工作记录起一个新会话）只在两种情况（planShadowConversation）：配置版本变了（系统提示词、常设指令、
//     核心记忆、交接说明、shadow 的模型和工具）；超过 reopenAfterMs（缺省 24 小时）没有新消息。会话变长靠 pi 的自动压缩。
// 这个文件不碰账本、不调模型：daemon 给 open（建或者打开会话）和 job（跑一批）。
import { existsSync } from "node:fs";
import type { ShadowSession } from "./session.js";

/** 闲置多久卸载（用户和 Lead 定的方案：5 分钟）。 */
export const SHADOW_CONVERSATION_IDLE_MS = 5 * 60_000;
/** 多久没有新消息就重开（不复用旧的会话文件）。 */
export const SHADOW_CONVERSATION_REOPEN_MS = 24 * 3_600_000;

export type ShadowConversationPlan =
  | { kind: "reuse"; file: string }
  | { kind: "new"; reason: "first" | "config" | "stale" | "no_file" };

/**
 * 这一批用哪个会话（决策边界，纯函数）。row 是账本里这段对话的会话行（没有时是 null）。
 * 复用：有会话文件、文件还在、配置版本一样、最近一条消息在 reopenAfterMs 以内。别的都新开（从工作记录接着做）。
 */
export function planShadowConversation(input: {
  row: { sessionFile: string | null; configVersion: string | null; lastMessageAt: string | null } | null;
  configVersion: string;
  now: number;
  reopenAfterMs?: number;
  fileExists?: (path: string) => boolean;
}): ShadowConversationPlan {
  const row = input.row;
  if (!row || (!row.sessionFile && !row.configVersion)) return { kind: "new", reason: "first" };
  if (row.configVersion !== input.configVersion) return { kind: "new", reason: "config" };
  const last = row.lastMessageAt ? Date.parse(row.lastMessageAt) : Number.NaN;
  if (!Number.isFinite(last) || input.now - last > (input.reopenAfterMs ?? SHADOW_CONVERSATION_REOPEN_MS)) return { kind: "new", reason: "stale" };
  if (!row.sessionFile || !(input.fileExists ?? existsSync)(row.sessionFile)) return { kind: "new", reason: "no_file" };
  return { kind: "reuse", file: row.sessionFile };
}

/** 内存里的一个会话：建它时的配置版本和模型，会话文件。 */
export interface LoadedShadowConversation {
  session: ShadowSession;
  configVersion: string;
  model: string;
  modelNote: string | null;
  file: string | null;
}

interface Slot {
  loaded: LoadedShadowConversation | null;
  // 在跑的和排着的批数。
  pending: number;
  tail: Promise<void>;
  idle: ReturnType<typeof setTimeout> | null;
}

/**
 * 按组排队、并行有上限、闲置卸载。run(key, job)：同一个 key 的 job 一个接一个跑；job 拿到内存里的会话（没有时是 null），
 * 返回要留在内存里的会话（null：关掉它，例如出错了）。不同 key 的 job 同时最多 maxRuns 个。
 */
export class ShadowConversationPool {
  private readonly slots = new Map<string, Slot>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly idleMs: number;
  private readonly maxRuns: number;
  private readonly log: (line: string) => void;

  constructor(options: { idleMs?: number; maxRuns?: number; log?: (line: string) => void } = {}) {
    this.idleMs = options.idleMs ?? SHADOW_CONVERSATION_IDLE_MS;
    this.maxRuns = Math.max(1, options.maxRuns ?? 3);
    this.log = options.log ?? (() => {});
  }

  /** 这一组有批在跑或者在排队。 */
  busy(key: string): boolean {
    return (this.slots.get(key)?.pending ?? 0) > 0;
  }

  /** 在跑的批数（不含排队等并行名额的）。 */
  running(): number {
    return this.active;
  }

  /** 在跑和在排队的批数。 */
  pending(): number {
    let count = 0;
    for (const slot of this.slots.values()) count += slot.pending;
    return count;
  }

  /** 这一组在内存里的会话（测试和日志用）。 */
  loaded(key: string): LoadedShadowConversation | null {
    return this.slots.get(key)?.loaded ?? null;
  }

  /** 在内存里的会话有几个。 */
  loadedCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.loaded) count += 1;
    return count;
  }

  run<T>(key: string, job: (loaded: LoadedShadowConversation | null) => Promise<{ result: T; keep: LoadedShadowConversation | null }>): Promise<T> {
    const slot = this.slots.get(key) ?? { loaded: null, pending: 0, tail: Promise.resolve(), idle: null };
    this.slots.set(key, slot);
    slot.pending += 1;
    if (slot.idle) {
      clearTimeout(slot.idle);
      slot.idle = null;
    }
    const result = slot.tail.then(async () => {
      await this.acquire();
      try {
        const current = slot.loaded;
        let outcome: { result: T; keep: LoadedShadowConversation | null };
        try {
          outcome = await job(current);
        } catch (error) {
          this.unload(slot, current);
          throw error;
        }
        if (current && outcome.keep !== current) this.unload(slot, current);
        slot.loaded = outcome.keep;
        return outcome.result;
      } finally {
        this.release();
        slot.pending -= 1;
        this.scheduleIdle(key, slot);
      }
    });
    slot.tail = result.then(() => {}, () => {});
    return result;
  }

  /** 关掉所有在内存里的会话（daemon 停机）。文件留着。 */
  disposeAll(): void {
    for (const [key, slot] of this.slots) {
      if (slot.idle) clearTimeout(slot.idle);
      slot.idle = null;
      this.unload(slot, slot.loaded);
      if (slot.pending === 0) this.slots.delete(key);
    }
  }

  private unload(slot: Slot, loaded: LoadedShadowConversation | null): void {
    if (!loaded) return;
    if (slot.loaded === loaded) slot.loaded = null;
    try {
      loaded.session.dispose();
    } catch (error) {
      this.log(`shadow conversation: dispose failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleIdle(key: string, slot: Slot): void {
    if (slot.pending > 0) return;
    if (!slot.loaded) {
      this.slots.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      slot.idle = null;
      if (slot.pending > 0) return;
      this.unload(slot, slot.loaded);
      this.slots.delete(key);
      this.log(`shadow conversation: unloaded ${key} after ${Math.round(this.idleMs / 1000)} s idle`);
    }, this.idleMs);
    timer.unref?.();
    slot.idle = timer;
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxRuns) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

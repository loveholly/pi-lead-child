// 用户消息的本地发件箱。每条消息先写进本地存储，再上网络，所以连接断了、应用重新加载、进程重启都丢不了
// （2026-10-16：Mac 睡眠时，3 条消息只活在内存里，从来没到 daemon，重新加载以后就没了）。
//
// 规则：
//   · 一次只发一条，按写进来的顺序发。连接断着时等连上（connected()）再发。
//   · 临时错误（断线、超时、网络错误、服务端 5xx）：留在待发送，退避以后用同一个 clientMessageId 重发。
//     daemon 按这个 id 去重，所以重发不会开第二轮。
//   · 等重试只挡住同一个对话（Lead，或者同一张工单）后面的消息，别的对话照常发（2026-10-20：一条工单消息
//     重发了 177 次，后面发给 Lead 的消息一次都没发出去）。同一个对话里的消息不越过前一条。
//   · 服务端拒收（缺权限、参数不对、工单不存在）：标成发送失败，用户可以重试或删除。后面的消息照常发。
//   · 送达以后从发件箱里去掉，onDelivered 带着 daemon 开的那一轮。
//   · 进程在发送中被打断：下次加载时这条回到待发送，照原来的 id 重发。
//
// 存储由调用方给：companion 的 web 用 localStorage，原生应用用文件，plc 用数据目录里的文件。
import { Value } from 'typebox/value';

import { ChatImagesInputSchema, type ChatImageInput, type ChatPlacement } from '@pi-lead-child/protocol';

import { ControlPlaneClientError } from './controlPlaneClient.ts';
import type { KeyValueStorage } from './credentialStore.ts';

export type OutboxState = 'pending' | 'sending' | 'delivered' | 'failed';

export interface OutboxEntry {
  clientMessageId: string;
  message: string;
  ticketId: number | null;
  createdAt: string;
  state: OutboxState;
  // 已经发过几次（含失败的）。
  attempts: number;
  // 待发送：上一次为什么没发出去；发送失败：服务端为什么拒收。
  error: string | null;
  // 送达以后 daemon 开的那一轮。
  turnId: string | null;
  // Lead 忙时这条消息怎么放：插话（steer）或排队（followUp）。旧版本存下的条目没有它，按插话发。
  mode?: ChatPlacement;
  // 发给 Lead 的图片（base64，protocol 的 chat-images.ts）。和文字存在一起，重新加载以后照样发。
  images?: ChatImageInput[];
}

export interface OutboxStorage {
  load(): Promise<OutboxEntry[]>;
  save(entries: OutboxEntry[]): Promise<void>;
  // 别处（另一个标签页）改了存储时通知（web：window 的 storage 事件）。没有就不通知。
  subscribe?(listener: () => void): () => void;
}

const OUTBOX_KEY = 'pi-lead-child.chat-outbox.v1';

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<OutboxEntry>;
  return typeof entry.clientMessageId === 'string' && entry.clientMessageId.length > 0
    && typeof entry.message === 'string'
    && (entry.ticketId === null || Number.isInteger(entry.ticketId))
    && typeof entry.createdAt === 'string'
    && (entry.state === 'pending' || entry.state === 'sending' || entry.state === 'failed')
    && Number.isInteger(entry.attempts)
    && (entry.error === null || typeof entry.error === 'string')
    && (entry.turnId === null || typeof entry.turnId === 'string')
    && (entry.mode === undefined || entry.mode === 'steer' || entry.mode === 'followUp')
    && (entry.images === undefined || Value.Check(ChatImagesInputSchema, entry.images));
  // 工单 08 第一版存下的条目可能还带着 answerer（工单对话里选的回答者）。照样读回来、照样发，只是不再带它：
  // 2026-10-19 起工单对话一律交给工单的 agent。不能因为多一个旧字段丢掉用户的消息。
}

// 发件箱存成键值存储里的一条 JSON（companion 的 web 用 localStorage，原生应用用文件）。读不懂的条目丢掉。
export function createJsonOutboxStorage(storage: KeyValueStorage, key = OUTBOX_KEY): OutboxStorage {
  return {
    async load() {
      const raw = await storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(isOutboxEntry) : [];
      } catch {
        return [];
      }
    },
    async save(entries) {
      if (entries.length) await storage.setItem(key, JSON.stringify(entries));
      else await storage.removeItem(key);
    },
  };
}

export interface ChatOutboxOptions {
  storage: OutboxStorage;
  send(entry: OutboxEntry): Promise<{ turnId: string }>;
  // 现在连着吗。断着时不发，等 connected()。缺省总是连着。
  isConnected?: () => boolean;
  createId?: () => string;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  // 发件箱里的消息有变化（新写进来、开始发、发送失败、删除）。
  onChange?: (entries: readonly OutboxEntry[]) => void;
  onDelivered?: (entry: OutboxEntry) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

// 服务端明确拒收的错误：再发一次也一样，交给用户决定。其余的都当临时错误。
const REFUSED_CODES = new Set([
  'invalid_request', 'forbidden', 'not_found', 'conflict', 'unauthorized', 'binding_revoked',
  'protocol_version_unsupported', 'not_paired', 'invalid_response',
]);

export function isRefusedSendError(error: unknown): boolean {
  if (!(error instanceof ControlPlaneClientError)) return false;
  if (REFUSED_CODES.has(error.code)) return true;
  return error.code === 'http_error' && error.status !== undefined && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 消息属于哪个对话：Lead，或者某一张工单。
function conversationOf(entry: OutboxEntry): string {
  return entry.ticketId === null ? 'lead' : `ticket:${entry.ticketId}`;
}

function randomId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `msg_${random ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`}`;
}

export class ChatOutbox {
  private list: OutboxEntry[] = [];
  // 这个发件箱送达或删掉的消息：写存储时不从别处带回来（发布评审 f796c1c：两个标签页共用一份存储）。
  private readonly forgotten = new Set<string>();
  private flushing = false;
  private retryTimer: unknown = null;
  // 在等重试的对话（conversationOf）。重试计时器到期、连接恢复或用户点「重试」时清空。
  private readonly waiting = new Set<string>();
  private failures = 0;
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly isConnected: () => boolean;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly options: ChatOutboxOptions) {
    this.isConnected = options.isConnected ?? (() => true);
    this.createId = options.createId ?? randomId;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  // 读回存储里还没送达的消息。发送中被打断的回到待发送。
  async load(): Promise<void> {
    const stored = await this.options.storage.load().catch(() => [] as OutboxEntry[]);
    const loaded = stored
      .filter((entry) => entry.state !== 'delivered' && typeof entry.clientMessageId === 'string' && typeof entry.message === 'string')
      .map((entry): OutboxEntry => ({ ...entry, state: entry.state === 'sending' ? 'pending' : entry.state }));
    const known = new Set(this.list.map((entry) => entry.clientMessageId));
    this.list = [...loaded.filter((entry) => !known.has(entry.clientMessageId)), ...this.list];
    this.emit();
    void this.flush();
  }

  // 别处（另一个标签页）改了存储：读回来。别处新写的消息加进来；别处已经送达或删掉的（存储里没有了，
  // 这里也没在发）拿掉。都是同一个用户的消息，两个标签页都可能发同一条：daemon 按 clientMessageId 去重。
  async reload(): Promise<void> {
    const stored = await this.options.storage.load().catch(() => null);
    if (!stored) return;
    const storedIds = new Set(stored.map((entry) => entry.clientMessageId));
    const known = new Set(this.list.map((entry) => entry.clientMessageId));
    this.list = this.list.filter((entry) => entry.state === 'sending' || storedIds.has(entry.clientMessageId));
    for (const entry of stored) {
      if (known.has(entry.clientMessageId) || this.forgotten.has(entry.clientMessageId) || entry.state === 'delivered') continue;
      this.list.push({ ...entry, state: entry.state === 'sending' ? 'pending' : entry.state });
    }
    this.list.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.emit();
    void this.flush();
  }

  entries(): OutboxEntry[] {
    return this.list.map((entry) => ({ ...entry }));
  }

  // 写进发件箱（先存好），然后在连着时发出去。mode：Lead 忙时插话还是排队（工单 04），缺省插话。
  // images：发给 Lead 的图片。存储写不下（例如 localStorage 满了）时，这条照样在内存里发出去，只是重新加载以后就没有了。
  async enqueue(message: string, ticketId?: number, mode?: ChatPlacement, images?: readonly ChatImageInput[]): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      clientMessageId: this.createId(),
      message,
      ticketId: ticketId ?? null,
      createdAt: this.now().toISOString(),
      state: 'pending',
      attempts: 0,
      error: null,
      turnId: null,
      ...(mode ? { mode } : {}),
      ...(images?.length ? { images: images.map((image) => ({ ...image })) } : {}),
    };
    this.list.push(entry);
    await this.persist();
    this.emit();
    void this.flush();
    return { ...entry };
  }

  // 连接恢复了：不等退避，马上发。
  connected(): void {
    this.failures = 0;
    this.cancelRetry();
    void this.flush();
  }

  // 用户点「重试」：发送失败的消息回到待发送。
  retry(clientMessageId: string): void {
    const entry = this.list.find((candidate) => candidate.clientMessageId === clientMessageId);
    if (!entry || entry.state === 'sending') return;
    entry.state = 'pending';
    entry.error = null;
    this.failures = 0;
    this.cancelRetry();
    void this.persist();
    this.emit();
    void this.flush();
  }

  // 用户点「删除」：不再发这条。正在发的那条删不掉（它可能已经到了）。
  async remove(clientMessageId: string): Promise<void> {
    const entry = this.list.find((candidate) => candidate.clientMessageId === clientMessageId);
    if (!entry || entry.state === 'sending') return;
    this.list = this.list.filter((candidate) => candidate !== entry);
    this.forgotten.add(clientMessageId);
    await this.persist();
    this.emit();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      while (!this.stopped && this.isConnected()) {
        const entry = this.list.find((candidate) => candidate.state === 'pending' && !this.waiting.has(conversationOf(candidate)));
        if (!entry) return;
        entry.state = 'sending';
        entry.attempts += 1;
        await this.persist();
        this.emit();
        try {
          const result = await this.options.send({ ...entry });
          entry.state = 'delivered';
          entry.turnId = result.turnId;
          entry.error = null;
          // 还有对话在等重试时，退避不从头算：那边的错误还没好。
          if (!this.waiting.size) this.failures = 0;
          this.list = this.list.filter((candidate) => candidate !== entry);
          this.forgotten.add(entry.clientMessageId);
          // 先报送达，再报变化：调用方先把本地消息换成那一轮的消息，变化里这条才不在。
          this.options.onDelivered?.({ ...entry });
          await this.persist();
          this.emit();
        } catch (error) {
          entry.error = errorText(error);
          if (isRefusedSendError(error)) {
            entry.state = 'failed';
            await this.persist();
            this.emit();
            continue;
          }
          entry.state = 'pending';
          this.waiting.add(conversationOf(entry));
          await this.persist();
          this.emit();
          this.scheduleRetry();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // 临时错误以后退避：1 秒、2 秒、4 秒……最多 30 秒。连接断着时由 connected() 叫醒，不用计时器也行，
  // 但半开的连接看起来还连着：计时器保证它照样会再试。
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = Math.min(this.retryBaseMs * 2 ** this.failures, this.retryMaxMs);
    this.failures += 1;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.waiting.clear();
      void this.flush();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.waiting.clear();
  }

  // 写存储排成一队：后一次写的总是最新的状态。写失败不打断发送（下一次写会再试）。
  // 先读再写，按 clientMessageId 合并：存储里别处（另一个标签页）的消息留着，这里送达或删掉的不带回去。
  private persist(): Promise<void> {
    const snapshot = this.list.filter((entry) => entry.state !== 'delivered').map((entry) => ({ ...entry }));
    this.writes = this.writes.then(async () => {
      const stored = await this.options.storage.load().catch(() => [] as OutboxEntry[]);
      const mine = new Set(snapshot.map((entry) => entry.clientMessageId));
      const others = stored.filter((entry) => !mine.has(entry.clientMessageId) && !this.forgotten.has(entry.clientMessageId)
        && entry.state !== 'delivered');
      const merged = [...others, ...snapshot].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      await this.options.storage.save(merged);
    }).catch(() => {});
    return this.writes;
  }

  private emit(): void {
    this.options.onChange?.(this.entries());
  }
}

// aish 适配器：botfather protocol v1 的 WS 客户端（DESIGN-GATEWAY §3）。
// 状态机语义照抄 slack-to-agents/src/bridge/ws-client.ts：
// auth 首帧 5s、应用层 ping/pong 30s/15s、退避 1→60s、AUTH_* 致命停止。
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
  PROTOCOL_VERSION, parseServerMessage,
  type ClientMessage, type EventMessage, type ServerMessage,
} from "./aish-protocol.js";

export interface AishTimeouts {
  authMs: number; pingMs: number; pongMs: number;
  backoffBaseMs: number; backoffMaxMs: number; ackMs: number;
  flushChars: number; flushMs: number;
}
const DEFAULT_TIMEOUTS: AishTimeouts = {
  authMs: 5000, pingMs: 30_000, pongMs: 15_000,
  backoffBaseMs: 1000, backoffMaxMs: 60_000, ackMs: 10_000,
  flushChars: 256, flushMs: 100,
};

export interface AishAdapterOpts {
  url: string;
  token: string;
  onEvent: (ev: EventMessage) => void;
  onApproval?: (msg: Extract<ServerMessage, { type: "approval_result" }>) => void;
  onStatus?: (line: string) => void;
  // code 区分原因：AUTH_FAILED 是 token 本身无效，AUTH_TIMEOUT 只是这次握手没在时限内完成。
  onFatal?: (reason: string, code: "AUTH_FAILED" | "AUTH_TIMEOUT") => void;
  makeWebSocket?: (url: string) => WebSocket; // 测试注入
  timeouts?: Partial<AishTimeouts>;
}

export interface StreamHandle {
  append(delta: string): void;
  end(): Promise<void>;
}

export class AishAdapter extends EventEmitter {
  connected = false;
  botId: string | null = null;
  botName: string | null = null;

  private ws: WebSocket | null = null;
  private stopped = false;
  private fatal = false;
  private backoff: number;
  private t: AishTimeouts;
  private timers: NodeJS.Timeout[] = [];
  private pongTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void }>();

  constructor(private opts: AishAdapterOpts) {
    super();
    this.t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.backoff = this.t.backoffBaseMs;
  }

  private log(line: string) { this.opts.onStatus?.(`[aish] ${line}`); }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  private cleanup(): void {
    for (const t of this.timers) clearNodeTimeout(t);
    this.timers = [];
    if (this.pongTimer) { clearNodeTimeout(this.pongTimer); this.pongTimer = null; }
    for (const [, p] of this.pending) p.reject(new Error("connection lost"));
    this.pending.clear();
    this.connected = false;
  }

  private schedule(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setNodeTimeout(fn, ms) as unknown as NodeJS.Timeout;
    (t as any).unref?.();
    this.timers.push(t);
    return t;
  }

  private connect(): void {
    if (this.stopped || this.fatal) return;
    const make = this.opts.makeWebSocket ?? ((u: string) => new WebSocket(u));
    let ws: WebSocket;
    try { ws = make(this.opts.url); } catch (e: any) { this.log(`connect error: ${e.message}`); this.scheduleReconnect(); return; }
    this.ws = ws;

    const authTimer = this.schedule(() => {
      this.log("auth timeout (no connected frame)");
      ws.close();
    }, this.t.authMs);

    ws.onopen = () => this.send({ type: "auth", token: this.opts.token });
    ws.onmessage = (e: MessageEvent) => {
      const msg = parseServerMessage(String(e.data));
      if (!msg) return;
      this.markAlive();
      this.handle(msg, authTimer);
    };
    ws.onclose = () => {
      this.cleanup();
      if (!this.stopped && !this.fatal) this.scheduleReconnect();
      this.emit("close");
    };
    ws.onerror = () => { /* onclose 统一处理 */ };
  }

  private handle(msg: ServerMessage, authTimer: NodeJS.Timeout): void {
    switch (msg.type) {
      case "connected": {
        clearNodeTimeout(authTimer);
        this.connected = true;
        this.botId = msg.bot_id;
        this.botName = msg.bot_name;
        this.backoff = this.t.backoffBaseMs;
        if (msg.protocol_version !== PROTOCOL_VERSION) {
          this.log(`protocol_version mismatch: got ${msg.protocol_version}, expected ${PROTOCOL_VERSION}`);
        }
        this.log(`connected as ${msg.bot_name} (${msg.bot_id})`);
        this.startPinger();
        this.emit("connected", msg);
        break;
      }
      case "ping": this.send({ type: "pong" }); break;
      case "pong": break; // markAlive 已处理
      case "event": {
        // 收到即回 eyes 反应示意（fire-and-forget）
        void this.action({
          type: "add_reaction", request_id: randomUUID(),
          channel_id: msg.channel_id, message_ts: msg.thread_ts ?? "", emoji: "eyes",
        }).catch(() => {});
        this.opts.onEvent(msg);
        break;
      }
      case "action_result":
      case "thread_messages_result": {
        const p = this.pending.get(msg.request_id);
        if (p) { this.pending.delete(msg.request_id); p.resolve(msg); }
        break;
      }
      case "error": {
        if (msg.code === "AUTH_FAILED" || msg.code === "AUTH_TIMEOUT") {
          this.fatal = true;
          this.log(`fatal: ${msg.code} ${msg.message}`);
          this.opts.onFatal?.(`${msg.code}: ${msg.message}`, msg.code);
        } else {
          this.log(`server error: ${msg.code} ${msg.message}`);
        }
        break;
      }
      case "approval_result": this.opts.onApproval?.(msg); break;
      case "disconnected": this.log(`server disconnect: ${msg.reason}`); break;
      default: break; // 未知消息宽容
    }
  }

  private markAlive(): void {
    if (this.pongTimer) { clearNodeTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private startPinger(): void {
    const loop = () => {
      if (!this.connected || this.stopped) return;
      this.send({ type: "ping" });
      this.pongTimer = setNodeTimeout(() => {
        this.log("pong timeout, forcing reconnect");
        this.ws?.close();
      }, this.t.pongMs) as unknown as NodeJS.Timeout;
      (this.pongTimer as any).unref?.();
      this.schedule(loop, this.t.pingMs);
    };
    this.schedule(loop, this.t.pingMs);
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.t.backoffMaxMs);
    this.log(`reconnecting in ${delay}ms`);
    this.schedule(() => this.connect(), delay);
  }

  private send(msg: ClientMessage): void {
    try { this.ws?.send(JSON.stringify(msg)); } catch { /* onclose 兜底 */ }
  }

  /** 发送带 ACK 的动作，等待 action_result */
  private action(msg: ClientMessage & { request_id: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error("aish not connected")); return; }
      this.pending.set(msg.request_id, { resolve, reject });
      this.send(msg);
      this.schedule(() => {
        if (this.pending.has(msg.request_id)) {
          this.pending.delete(msg.request_id);
          reject(new Error(`ack timeout for ${msg.type}`));
        }
      }, this.t.ackMs);
    });
  }

  // 发起审批：aish 渲染 Approve/Deny 按钮；用户点击后经 onApproval 回调推回 approval_result
  async requestApproval(
    channelId: string, threadTs: string | undefined,
    approval: { approvalId: string; tool: string; description: string },
  ): Promise<void> {
    const r = await this.action({
      type: "approval_request", request_id: randomUUID(),
      channel_id: channelId, thread_ts: threadTs,
      approval_id: approval.approvalId, tool: approval.tool,
      description: approval.description, text: approval.description,
    });
    if (!r.ok) throw new Error(r.error ?? "approval_request failed");
  }

  async sendMessage(channelId: string, threadTs: string | undefined, text: string): Promise<void> {
    const r = await this.action({
      type: "send_message", request_id: randomUUID(),
      channel_id: channelId, thread_ts: threadTs, text,
    });
    if (!r.ok) throw new Error(r.error ?? "send_message failed");
  }

  /** 流式回帖：懒 start，缓冲 flush，stop 收尾；start 失败降级为整段 send_message */
  openStream(channelId: string, threadTs: string | undefined): StreamHandle {
    let streamTs: string | null = null;
    let starting: Promise<void> | null = null;
    let buffer = "";
    let all = "";
    let degraded = false;
    let flushTimer: NodeJS.Timeout | null = null;
    let chain: Promise<void> = Promise.resolve(); // append 串行化（协议允许 4 在途，串行最稳）

    const ensureStarted = (): Promise<void> => {
      starting ??= this.action({
        type: "stream_start", request_id: randomUUID(),
        channel_id: channelId, thread_ts: threadTs,
      }).then((r) => {
        if (!r.ok || !r.stream_ts) throw new Error(r.error ?? "no stream_ts");
        streamTs = r.stream_ts;
      }).catch(() => { degraded = true; });
      return starting;
    };

    const flush = (): void => {
      if (flushTimer) { clearNodeTimeout(flushTimer); flushTimer = null; }
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      chain = chain.then(async () => {
        await ensureStarted();
        if (degraded || !streamTs) return; // 降级：end 时整段发送
        await this.action({
          type: "stream_append", request_id: randomUUID(),
          channel_id: channelId, stream_ts: streamTs, text: chunk,
        }).catch(() => { degraded = true; });
      });
    };

    return {
      append: (delta: string) => {
        all += delta;
        buffer += delta;
        if (buffer.length >= this.t.flushChars) flush();
        else if (!flushTimer) {
          flushTimer = setNodeTimeout(flush, this.t.flushMs) as unknown as NodeJS.Timeout;
          (flushTimer as any).unref?.();
        }
      },
      end: async () => {
        flush();
        await chain;
        if (!degraded && streamTs) {
          // append 已发完全文；服务端 stop 的 text 是"完整替换"，再传全文会重复。传 undefined。
          await this.action({
            type: "stream_stop", request_id: randomUUID(),
            channel_id: channelId, stream_ts: streamTs,
          }).catch(() => {});
        } else if (all) {
          await this.sendMessage(channelId, threadTs, all).catch(() => {});
        }
      },
    };
  }
}

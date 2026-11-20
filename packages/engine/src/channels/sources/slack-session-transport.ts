// Slack 浏览器会话方式的传输（2026-11-02）：网页版 Slack 的 WebSocket，经过 gabriel-slack 的 GabrielCore。
// gabriel 负责：建连接、心跳、断线检测、快速重连、按退避重连、令牌失效时用 cookie 重新换令牌。这里只做我们自己的几件事：
//   1. 消息帧（type 是 message）按收到的顺序一个一个换成投递（toDelivery，和 Events API 一样的 event_callback），
//      交给 hub 的进程内入口。网页版没有 ack，也不重发：hub 按投递编号去重。
//   2. 每次连上（gabriel 的 hello）以后补拉（afterReconnect），排在投递队列里；补完告诉 gabriel 这一轮连接准备好了（markReady）。
//      交给补拉这次断线的真实时段（outage：连着的连接第一次断开、重新连上的时刻、断了几次）。
//   3. 连接的状态报给 host.status（设置页）。会话失效（cookie 换不出令牌，gabriel 停在 AUTH_DEAD）时报错：
//      「会话已失效，请重新登录」，不再重试，等用户在设置页重新登录（daemon 换了凭据以后先 stop 再 start）。
//   4. 停了以后能再开。每次 start 用凭据缓存里现在的会话（SlackSessions）：cookie 换了就是新的 GabrielCore。
import type {
  ChannelAdapterContext, ChannelDelivery, ChannelOutage, ChannelTransport, ChannelTransportContext, ChannelTransportDeliver, ChannelTransportStatus,
} from "../types.js";
import type { GabrielCore } from "./slack-gabriel.js";
import type { SlackSessions } from "./slack-session.js";

export interface SlackSessionTransportOptions {
  // 拿不到会话时（凭据还没换好、网络不通）多久以后再试：从 retryBaseMs 起翻倍，最多 retryMaxMs。缺省 2 秒、5 分钟。
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface SlackSessionTransportInput {
  options?: SlackSessionTransportOptions;
  sessions: SlackSessions;
  // 一个网页版的帧换成投递。不是要的帧时返回 null。
  toDelivery: (frame: Record<string, unknown>, context: ChannelAdapterContext) => Promise<ChannelDelivery | null>;
  // 连上以后补拉：在投递队列里跑。active() 为 false 时（传输停了）不要再往下补。
  afterReconnect?: (input: {
    context: ChannelAdapterContext;
    transport: ChannelTransportContext;
    deliver: ChannelTransportDeliver;
    active: () => boolean;
    // 这次补拉盖住的真实断线。daemon 启动以后第一次连上时是 null。
    outage: ChannelOutage | null;
  }) => Promise<void>;
}

/** 会话失效时设置页上的说明。 */
export const SLACK_SESSION_ENDED = "会话已失效，请重新登录：SSO 过期，或者你在 Slack 里登出了。在设置 → 消息通道 → Slack 里重新登录";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SlackSessionTransport implements ChannelTransport {
  private host: ChannelTransportContext | null = null;
  private deliver: ChannelTransportDeliver | null = null;
  private core: GabrielCore | null = null;
  private unsubscribe: Array<() => void> = [];
  private stopped = true;
  private generation = 0;
  private connectedBefore = false;
  private reported: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  // 还没补拉的断线：第一次断开的时刻和断了几次。
  private outageSince: number | null = null;
  private outageDrops = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly input: SlackSessionTransportInput) {
    this.retryBaseMs = Math.max(input.options?.retryBaseMs ?? 2_000, 1);
    this.retryMaxMs = Math.max(input.options?.retryMaxMs ?? 5 * 60_000, this.retryBaseMs);
  }

  start(host: ChannelTransportContext, deliver: ChannelTransportDeliver): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.failures = 0;
    this.reported = null;
    this.outageSince = null;
    this.outageDrops = 0;
    this.host = host;
    this.deliver = deliver;
    void this.open(this.generation);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.detach();
    await this.queue;
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────────────

  private stale(generation: number): boolean {
    return this.stopped || generation !== this.generation;
  }

  private async open(generation: number): Promise<void> {
    const host = this.host!;
    this.report({ state: "connecting" });
    // 取凭据就是换会话：凭据缓存调 resolveCredential，它打开（或者接着用）SlackSessions 里的会话。
    let context: ChannelAdapterContext | null = null;
    try {
      context = await host.context();
    } catch (error) {
      host.log(`session: could not read the credential: ${errorText(error)}`);
    }
    if (this.stale(generation)) return;
    const core = context ? this.input.sessions.core() : null;
    if (!core) {
      this.retry("no usable Slack session (see the credential lines above)", "浏览器会话不可用：会话 cookie 换不出会话（原因见 daemon 的日志）");
      return;
    }
    if (core.authManager.state === "AUTH_DEAD") {
      this.ended();
      return;
    }
    this.attach(core, generation);
    try {
      await core.connect();
    } catch (error) {
      if (this.stale(generation)) return;
      this.detach();
      this.retry(`could not connect: ${errorText(error)}`, `连不上 Slack：${errorText(error)}`);
    }
  }

  private attach(core: GabrielCore, generation: number): void {
    this.detach();
    this.core = core;
    this.unsubscribe = [
      core.onEvent("message", (frame) => this.onFrame(frame as Record<string, unknown>, generation)),
      core.onHello((info) => this.onHello(info.epoch, generation)),
      core.ws.on("state", (state) => this.onState(state, generation)),
    ];
  }

  private detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    const core = this.core;
    this.core = null;
    core?.disconnect();
  }

  // 拿不到会话时过一会儿再试。连不上的原因 gabriel 自己会退避重连，这里只管拿会话。
  private retry(problem: string, status: string): void {
    if (this.stopped) return;
    this.host?.log(`session: ${problem}; will retry`);
    this.report({ state: "error", error: status });
    this.failures += 1;
    const delay = Math.min(this.retryBaseMs * 2 ** Math.min(this.failures - 1, 20), this.retryMaxMs);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) void this.open(this.generation);
    }, delay);
    this.retryTimer.unref?.();
  }

  private ended(): void {
    this.host?.log("session: the Slack session ended (the cookie no longer signs in); waiting for a new sign-in");
    this.report({ state: "error", error: SLACK_SESSION_ENDED, reason: "signed_out" });
    this.detach();
  }

  private report(update: ChannelTransportStatus): void {
    const key = update.state === "error" ? `error:${update.error}` : update.state;
    if (key === this.reported) return;
    if (update.state === "connecting" && this.reported?.startsWith("error:")) return;
    this.reported = key;
    try {
      this.host?.status?.(update);
    } catch (error) {
      this.host?.log(`session: the status listener failed: ${errorText(error)}`);
    }
  }

  private onState(state: string, generation: number): void {
    if (this.stale(generation)) return;
    if (state === "AUTH_DEAD") this.ended();
    else if (state === "BACKOFF" && this.reported === "connected") {
      this.host?.log("session: disconnected; reconnecting");
      this.outageSince ??= Date.now();
      this.outageDrops += 1;
      this.report({ state: "connecting" });
    }
  }

  private onHello(epoch: number, generation: number): void {
    if (this.stale(generation)) return;
    const host = this.host!;
    this.failures = 0;
    this.report({ state: "connected" });
    host.log(this.connectedBefore ? "session: reconnected (browser session)" : "session: connected (browser session)");
    this.connectedBefore = true;
    const core = this.core;
    const afterReconnect = this.input.afterReconnect;
    const reconnectedAt = new Date();
    this.enqueue(async () => {
      if (afterReconnect) {
        const context = await host.context();
        if (context && !this.stale(generation)) {
          const outage = this.outageSince === null ? null : { disconnectedAt: new Date(this.outageSince), reconnectedAt, drops: this.outageDrops };
          this.outageSince = null;
          this.outageDrops = 0;
          await afterReconnect({ context, transport: host, deliver: this.deliver!, active: () => !this.stale(generation), outage });
        }
      }
      // 补完了：这一轮连接准备好了（gabriel 重置它的退避）。
      if (!this.stale(generation)) core?.ws.markReady(false, epoch);
    }, "catching up after the reconnect");
  }

  // ── 投递 ──────────────────────────────────────────────────────────────────────────

  private onFrame(frame: Record<string, unknown>, generation: number): void {
    if (this.stale(generation)) return;
    const host = this.host!;
    this.enqueue(async () => {
      const context = await host.context();
      if (!context || this.stale(generation)) return;
      const delivery = await this.input.toDelivery(frame, context);
      if (delivery) await this.deliver!(delivery);
    }, "delivering a message");
  }

  private enqueue(task: () => Promise<unknown>, what: string): void {
    this.queue = this.queue.then(task).then(() => {}, (error: unknown) => {
      this.host?.log(`session: failed while ${what}: ${errorText(error)}`);
    });
  }
}

/** 浏览器会话方式的传输。 */
export function createSlackSessionTransport(input: SlackSessionTransportInput): ChannelTransport {
  return new SlackSessionTransport(input);
}

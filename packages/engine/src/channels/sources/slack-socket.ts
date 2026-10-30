// Slack 的 Socket Mode 传输（slack-takeover 工单 02，spec D11）：用 Slack 官方 SDK 的 SocketModeClient（@slack/socket-mode）。
// SDK 负责：用 app-level token 调 apps.connections.open 拿地址、建 WebSocket、心跳（ping/pong 超时就断开）、
// 处理 Slack 的 hello 和 disconnect 消息、回 ack。这里只做我们自己的几件事：
//   1. 每个 envelope 先调 SDK 给的 ack()，再交给 hub 的进程内入口（deliver）。ack 失败也照样交：Slack 会重发，
//      hub 按投递编号去重。投递按收到的顺序一个一个交：线程里的后续消息要等它前面那条（开道的那条）记完。
//   2. 断了就重新连。不用 SDK 的自动重连（autoReconnectEnabled: false）：它在重连时调 start() 没有接住失败
//      （SocketModeClient 的 delayReconnectAttempt 里 cb.apply(this).then(res)），令牌失效（invalid_auth）这类错误会变成
//      没人处理的 Promise 拒绝，让 daemon 进程退出。这里在 SDK 的 disconnected 事件上重新 start()，失败接住、记日志、退避再试。
//      每次重连之前重新取凭据：令牌换了就换一个客户端。
//   3. 每次连上以后补拉（afterReconnect，SDK 的 connected 事件），排在投递队列里。第一次连上也补：daemon 重启期间
//      开着卡的道里来的消息，Slack 不一定重发。按投递编号（<频道>:<ts>）去重，补到的和实时收到的不会重复记。
//   4. SDK 的日志只要 warn 以上，转到 hub 的日志，去掉令牌。
//   5. 连接的状态（正在连、连上了、连不上）报给 host.status（设置页的通道状态，2026-10-20）。连不上以后再试时，
//      状态仍然是上一次的错误，直到连上。
//   6. 停了以后能再开（设置页改了凭据以后 daemon 先 stop 再 start）。每次 start 是新的一代：上一代还没结束的连接
//      看到换代就退出（连上了就断开），结束以后用新的凭据再连。
// SDK 在第一次连接时才加载（加载要一秒左右；engine 被很多进程引用）。测试用 createClient 注入假的客户端。
import type { SocketModeOptions } from "@slack/socket-mode";
import type {
  ChannelAdapterContext, ChannelDelivery, ChannelTransport, ChannelTransportContext, ChannelTransportDeliver, ChannelTransportStatus,
} from "../types.js";
import { scrubSlackText, slackSdkLogger, type SlackFetch } from "./slack-web-api.js";

/** SDK 的 slack_event 事件里我们用到的部分。 */
export interface SlackSocketEvent {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id?: string;
  type: string;
  body?: unknown;
}

/** 我们用到的 SocketModeClient 的部分（测试注入假的）。 */
export interface SlackSocketClient {
  on(event: "slack_event", listener: (event: SlackSocketEvent) => void): unknown;
  on(event: "connected" | "disconnected", listener: () => void): unknown;
  off(event: "slack_event", listener: (event: SlackSocketEvent) => void): unknown;
  off(event: "connected" | "disconnected", listener: () => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type SlackSocketClientFactory = (options: SocketModeOptions) => SlackSocketClient | Promise<SlackSocketClient>;

export interface SlackSocketOptions {
  // 测试注入假的客户端。缺省是 SDK 的 SocketModeClient。
  createClient?: SlackSocketClientFactory;
  // SDK 调 apps.connections.open 用的 fetch（测试注入假的 Slack）。缺省是全局的 fetch。
  fetch?: SlackFetch;
  // 连不上时（令牌不对、网络不通）多久以后再试：从 retryBaseMs 起翻倍，最多 retryMaxMs。缺省 2 秒、5 分钟。
  // 连接断了以后的第一次重连不等。
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface SlackSocketTransportInput {
  options?: SlackSocketOptions;
  // 从凭据里取 app-level token。没有时连不上。
  appToken: (context: ChannelAdapterContext) => string | null;
  // 重新连上以后补拉：在投递队列里跑。active() 为 false 时（传输停了）不要再往下补。
  afterReconnect?: (input: {
    context: ChannelAdapterContext;
    transport: ChannelTransportContext;
    deliver: ChannelTransportDeliver;
    active: () => boolean;
  }) => Promise<void>;
}

// 断开时最多等多久。SDK 的 disconnect() 要等 Slack 回关闭帧，最长 30 秒：停机不能等这么久。
const DISCONNECT_WAIT_MS = 2_000;
// 这些错误换个时间再试也一样：等用户换令牌，按最长的间隔再试。
const AUTH_ERRORS = ["not_authed", "invalid_auth", "account_inactive", "token_revoked", "user_removed_from_team", "team_disabled",
  "not_allowed_token_type", "missing_scope"];

const defaultClient: SlackSocketClientFactory = async (options) => {
  const { SocketModeClient } = await import("@slack/socket-mode");
  return new SocketModeClient(options) as unknown as SlackSocketClient;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined ? "the connection closed before Slack said hello" : String(error);
}

class SlackSocketTransport implements ChannelTransport {
  private host: ChannelTransportContext | null = null;
  private deliver: ChannelTransportDeliver | null = null;
  private client: SlackSocketClient | null = null;
  private clientToken: string | null = null;
  private stopped = true;
  private connectedBefore = false;
  private connecting: Promise<void> | null = null;
  // 第几次 start。open 开始时记下，等待以后发现换了一代就退出。
  private generation = 0;
  // start 时上一代的连接还没结束：它结束以后再连一次。
  private pendingConnect = false;
  // 上一次报给 host.status 的状态（同样的不重复报）。
  private reported: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastProblem: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly listeners = {
    event: (event: SlackSocketEvent) => this.onEvent(event),
    connected: () => this.onConnected(),
    disconnected: () => this.onDisconnected(),
  };

  constructor(private readonly input: SlackSocketTransportInput) {
    this.retryBaseMs = Math.max(input.options?.retryBaseMs ?? 2_000, 1);
    this.retryMaxMs = Math.max(input.options?.retryMaxMs ?? 5 * 60_000, this.retryBaseMs);
  }

  start(host: ChannelTransportContext, deliver: ChannelTransportDeliver): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.failures = 0;
    this.lastProblem = null;
    this.reported = null;
    this.host = host;
    this.deliver = deliver;
    if (this.connecting) this.pendingConnect = true;
    else this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingConnect = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.dropClient();
    // 已经 ack 过的投递要交完：Slack 不会再发它们。
    await this.queue;
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped || this.connecting) return;
    this.connecting = this.open(this.generation).finally(() => {
      this.connecting = null;
      if (this.pendingConnect) {
        this.pendingConnect = false;
        this.connect();
      }
    });
  }

  // 停了，或者已经换了一代（stop 以后又 start 了）。
  private stale(generation: number): boolean {
    return this.stopped || generation !== this.generation;
  }

  private async open(generation: number): Promise<void> {
    const host = this.host!;
    this.report({ state: "connecting" });
    let context: ChannelAdapterContext | null = null;
    try {
      context = await host.context();
    } catch (error) {
      host.log(`socket: could not read the credential: ${errorText(error)}`);
    }
    if (this.stale(generation)) return;
    const token = context ? this.input.appToken(context) : null;
    if (!context || !token) {
      this.retry(
        "no usable credential (the app-level token and the user token are both needed)",
        "凭据不可用：App-Level Token 和 User Token 都要有，User Token 要能通过 auth.test（原因见 daemon 的日志）",
      );
      return;
    }
    let client = this.client;
    try {
      if (!client || this.clientToken !== token) {
        await this.dropClient();
        client = await (this.input.options?.createClient ?? defaultClient)({
          appToken: token,
          autoReconnectEnabled: false,
          logger: slackSdkLogger((line) => host.log(`socket: ${line}`), "socket mode", () => [token]),
          clientOptions: {
            ...(this.input.options?.fetch ? { fetch: this.input.options.fetch } : {}),
            timeout: 15_000,
            retryConfig: { retries: 3, factor: 2, minTimeout: 1_000, maxTimeout: 15_000 },
          },
        });
        if (this.stale(generation)) return;
        client.on("slack_event", this.listeners.event);
        client.on("connected", this.listeners.connected);
        client.on("disconnected", this.listeners.disconnected);
        this.client = client;
        this.clientToken = token;
      }
      await client.start();
    } catch (error) {
      if (this.stale(generation)) return;
      const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
      const auth = typeof code === "string" && AUTH_ERRORS.includes(code);
      const text = scrubSlackText(errorText(error), [token]);
      this.retry(
        `could not connect: ${text}`,
        auth ? `Slack 拒绝了连接（${code}）：App-Level Token 无效、被撤销，或者缺 connections:write` : `连不上 Slack：${text}`,
        auth,
      );
      return;
    }
    // 在连的时候停了或者换了一代（stop 已经把 this.client 拿走）：SDK 连上以后再断开这一个。
    if (this.stale(generation)) await this.disconnect(client);
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientToken = null;
    if (client) await this.disconnect(client);
  }

  private async disconnect(client: SlackSocketClient): Promise<void> {
    client.off("slack_event", this.listeners.event);
    client.off("connected", this.listeners.connected);
    client.off("disconnected", this.listeners.disconnected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.disconnect(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCONNECT_WAIT_MS); timer.unref?.(); }),
      ]);
    } catch (error) {
      this.host?.log(`socket: disconnect failed: ${errorText(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // 过一会儿再连。同样的问题只记一次日志。status：给人看的原因（设置页）。auth：令牌的问题，按最长的间隔再试。
  private retry(problem: string, status: string, auth = false): void {
    if (this.stopped) return;
    if (problem !== this.lastProblem) this.host?.log(`socket: ${problem}; will retry`);
    this.lastProblem = problem;
    this.report({ state: "error", error: status });
    this.failures += 1;
    const delay = auth ? this.retryMaxMs : Math.min(this.retryBaseMs * 2 ** Math.min(this.failures - 1, 20), this.retryMaxMs);
    this.schedule(delay);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  // 报连接的状态。同样的不重复报。连不上以后再试（connecting）不报：设置页上仍然是那个错误，直到连上。
  private report(update: ChannelTransportStatus): void {
    const key = update.state === "error" ? `error:${update.error}` : update.state;
    if (key === this.reported) return;
    if (update.state === "connecting" && this.reported?.startsWith("error:")) return;
    this.reported = key;
    try {
      this.host?.status?.(update);
    } catch (error) {
      this.host?.log(`socket: the status listener failed: ${errorText(error)}`);
    }
  }

  private onConnected(): void {
    const host = this.host!;
    this.failures = 0;
    this.lastProblem = null;
    this.report({ state: "connected" });
    const reconnected = this.connectedBefore;
    this.connectedBefore = true;
    host.log(reconnected ? "socket: reconnected (Socket Mode)" : "socket: connected (Socket Mode)");
    const afterReconnect = this.input.afterReconnect;
    if (!afterReconnect) return;
    this.enqueue(async () => {
      const context = await host.context();
      if (!context || this.stopped) return;
      await afterReconnect({ context, transport: host, deliver: this.deliver!, active: () => !this.stopped });
    }, "catching up after the reconnect");
  }

  private onDisconnected(): void {
    if (this.stopped) return;
    this.host?.log("socket: disconnected; reconnecting");
    this.report({ state: "connecting" });
    // 连接断了以后的第一次重连不等（Slack 要我们换连接时就是这样）；之后连不上再退避。
    if (this.connecting) return;
    if (this.failures === 0) this.connect();
    else this.schedule(Math.min(this.retryBaseMs * 2 ** Math.min(this.failures - 1, 20), this.retryMaxMs));
  }

  // ── 投递 ──────────────────────────────────────────────────────────────────────────

  private onEvent(event: SlackSocketEvent): void {
    const host = this.host!;
    // 先回 ack，再交给 hub。
    const acked = event.ack().catch((error: unknown) => {
      host.log(`socket: ack failed for an envelope (Slack will send it again): ${errorText(error)}`);
    });
    if (event.type !== "events_api" || !event.body || typeof event.body !== "object") {
      void acked;
      host.log(`socket: ignored a ${event.type} envelope`);
      return;
    }
    const delivery: ChannelDelivery = { headers: {}, body: JSON.stringify(event.body), transport: "socket" };
    this.enqueue(async () => {
      await acked;
      await this.deliver!(delivery);
    }, "delivering an event");
  }

  private enqueue(task: () => Promise<unknown>, what: string): void {
    this.queue = this.queue.then(task).then(() => {}, (error: unknown) => {
      this.host?.log(`socket: failed while ${what}: ${errorText(error)}`);
    });
  }
}

/** Socket Mode 的传输。 */
export function createSlackSocketTransport(input: SlackSocketTransportInput): ChannelTransport {
  return new SlackSocketTransport(input);
}

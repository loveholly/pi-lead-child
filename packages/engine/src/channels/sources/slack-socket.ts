// Slack 的 Socket Mode 传输（slack-takeover 工单 02，spec D11）：用 Slack 官方 SDK 的 SocketModeClient（@slack/socket-mode）。
// SDK 负责：用 app-level token 调 apps.connections.open 拿地址、建 WebSocket、心跳（ping/pong 超时就断开）、
// 处理 Slack 的 hello 和 disconnect 消息、回 ack。等 pong 最多 20 秒（SDK 缺省 5 秒：2026-11-05 网络一抖，5 秒收不到 pong
// 就断开，每 20 秒左右断一次、重连、补拉一轮，补拉又占了网络）。这里只做我们自己的几件事：
//   1. 每个 envelope 先调 SDK 给的 ack()，再交给 hub 的进程内入口（deliver）。ack 失败也照样交：Slack 会重发，
//      hub 按投递编号去重。投递按收到的顺序一个一个交：线程里的后续消息要等它前面那条（开道的那条）记完。
//   2. 断了就重新连。不用 SDK 的自动重连（autoReconnectEnabled: false）：它在重连时调 start() 没有接住失败
//      （SocketModeClient 的 delayReconnectAttempt 里 cb.apply(this).then(res)），令牌失效（invalid_auth）这类错误会变成
//      没人处理的 Promise 拒绝，让 daemon 进程退出。这里在 SDK 的 disconnected 事件上重新 start()，失败接住、记日志、退避再试。
//      每次重连之前重新取凭据：令牌换了就换一个客户端。断开的第一次立刻重连；连着不到一分钟又断（连续很快又断）时，
//      从第二次起退避再连。断开时把能拿到的原因记进日志和报给 host.status 的状态（disconnectReason）：Slack 的 disconnect
//      消息的 reason、SDK 的警告（pong/ping 超时、WebSocket 出错）、WebSocket 的 close code；都拿不到时写明不知道。
//   3. 每次连上以后补拉（afterReconnect，SDK 的 connected 事件），排在投递队列里。第一次连上也补：daemon 重启期间
//      开着卡的道里来的消息，Slack 不一定重发。按投递编号（<频道>:<ts>）去重，补到的和实时收到的不会重复记。
//      很快又重连时合并补拉：上一次补拉还在排队，这次就不再排；还在跑，跑完再补一次（只补一次，不管这期间重连了几次）；
//      上一次补完不到 30 秒，等到满 30 秒再补。补拉每次从水位和道的最后一条往后读，到开始补的时刻为止，补完水位才往前推，
//      所以合并以后的一次补拉盖住了这几次断线的时间段（并集），不会漏。没连着时不补，等连上再补。
//      交给补拉这几次断线的真实时段（outage：第一次断开的时刻、最后一次连上的时刻、断了几次），补拉写进不完整事件。
//   4. SDK 的日志只要 warn 以上，转到 hub 的日志，去掉令牌。心跳超时（等不到 pong、ping）断开时，原因里带上 daemon
//      事件循环最近的延迟（perf_hooks.monitorEventLoopDelay，2026-11-06）：分得清是网络的问题，还是 daemon 自己卡住了没回。
//   5. 连接的状态（正在连、连上了、连不上）报给 host.status（设置页的通道状态，2026-10-20）。连不上以后再试时，
//      状态仍然是上一次的错误，直到连上。
//   6. 停了以后能再开（设置页改了凭据以后 daemon 先 stop 再 start）。每次 start 是新的一代：上一代还没结束的连接
//      看到换代就退出（连上了就断开），结束以后用新的凭据再连。
// SDK 在第一次连接时才加载（加载要一秒左右；engine 被很多进程引用）。测试用 createClient 注入假的客户端。
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { SocketModeOptions } from "@slack/socket-mode";
import type {
  ChannelAdapterContext, ChannelDelivery, ChannelOutage, ChannelTransport, ChannelTransportContext, ChannelTransportDeliver, ChannelTransportStatus,
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
  // WebSocket 收到的每一帧原文（SDK 的 ws_message）：只用来认出 Slack 的 disconnect 消息和它的 reason。
  on(event: "ws_message", listener: (data: unknown) => void): unknown;
  off(event: "slack_event", listener: (event: SlackSocketEvent) => void): unknown;
  off(event: "connected" | "disconnected", listener: () => void): unknown;
  off(event: "ws_message", listener: (data: unknown) => void): unknown;
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
  // 连接断了以后的第一次重连不等。连着不到 stableMs（缺省 1 分钟）又断了，从第二次起从 retryBaseMs 起翻倍地等，最多 1 分钟。
  retryBaseMs?: number;
  retryMaxMs?: number;
  stableMs?: number;
  // 上一次补拉做完以后，至少隔多久才开始下一次（缺省 30 秒）。
  catchUpSpacingMs?: number;
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
    // 这次补拉盖住的真实断线。daemon 启动以后第一次连上时是 null。
    outage: ChannelOutage | null;
  }) => Promise<void>;
}

// 断开时最多等多久。SDK 的 disconnect() 要等 Slack 回关闭帧，最长 30 秒：停机不能等这么久。
const DISCONNECT_WAIT_MS = 2_000;
// 等 Slack 回 pong 最多多久（SDK 缺省 5 秒，见文件开头）。SDK 每隔它的三分之一 ping 一次。
const CLIENT_PING_TIMEOUT_MS = 20_000;
// 连着不到这么久就断了，算很快又断了；连续很快又断时，重连最多等多久。
const STABLE_MS = 60_000;
const DROP_BACKOFF_MAX_MS = 60_000;
// 上一次补拉做完以后，至少隔多久才开始下一次。
const CATCH_UP_SPACING_MS = 30_000;
// 事件循环的延迟按多长一段统计（心跳超时时报这一段和上一段里的）：和等 pong 的时间一样长。
const LOOP_WINDOW_MS = CLIENT_PING_TIMEOUT_MS;
// SDK 等不到 pong、ping 时的警告（SlackWebSocket）。
const HEARTBEAT_TIMEOUT = /wasn't received from the server before the timeout/;
// 一次断开最多记几条原因、每条多长。
const DROP_NOTES = 5;
const DROP_NOTE_CHARS = 300;
// 这些错误换个时间再试也一样：等用户换令牌，按最长的间隔再试。
const AUTH_ERRORS = ["not_authed", "invalid_auth", "account_inactive", "token_revoked", "user_removed_from_team", "team_disabled",
  "not_allowed_token_type", "missing_scope"];

const defaultClient: SlackSocketClientFactory = async (options) => {
  const { SocketModeClient } = await import("@slack/socket-mode");
  return new SocketModeClient(options) as unknown as SlackSocketClient;
};

// SDK 的 debug 日志里 WebSocket 关闭时的那一行（SlackWebSocket 的 close 事件）。别的 debug 日志不要（有消息原文）。
const CLOSE_FRAME = /^WebSocket close frame received \(code: (\d+), reason: (.*)\)$/s;

function partsText(parts: unknown[]): string {
  return parts.map((part) => (part instanceof Error ? part.message : typeof part === "string" ? part : String(part))).join(" ");
}

const ms = (nanoseconds: number) => Math.round(nanoseconds / 1e6);

// daemon 的事件循环延迟：一段一段地统计，记最近两段（这一段和上一段）的最大值和 p99。
class LoopDelay {
  private readonly histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  private previous: { max: number; p99: number } | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.histogram.enable();
    this.timer = setInterval(() => {
      this.previous = { max: this.histogram.max, p99: this.histogram.percentile(99) };
      this.histogram.reset();
    }, LOOP_WINDOW_MS);
    this.timer.unref?.();
  }

  text(): string {
    const count = this.histogram.count;
    const max = Math.max(count ? this.histogram.max : 0, this.previous?.max ?? 0);
    const p99 = Math.max(count ? this.histogram.percentile(99) : 0, this.previous?.p99 ?? 0);
    const window = Math.round((this.previous ? 2 : 1) * LOOP_WINDOW_MS / 1000);
    return `daemon event loop delay in the last ${window}s: max ${ms(max)} ms, p99 ${ms(p99)} ms`;
  }

  stop(): void {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}

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
  // 这次连上的时刻（没连着时是 null）、连续很快又断了几次、这次连接断开的原因（连上时清空）。
  private connectedAt: number | null = null;
  private quickDrops = 0;
  private dropNotes: string[] = [];
  // 还没补拉的断线：第一次断开的时刻和断了几次（补拉开始时交出去、清空）。
  private outageSince: number | null = null;
  private outageDrops = 0;
  // 事件循环的延迟（开着时统计）。
  private loopDelay: LoopDelay | null = null;
  // 补拉：waiting 是排着队或者等着隔够时间，running 是在跑；again 是跑的时候又连上了，跑完再补一次。
  private catchUpState: "idle" | "waiting" | "running" = "idle";
  private catchUpAgain = false;
  private catchUpEndedAt: number | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly stableMs: number;
  private readonly catchUpSpacingMs: number;
  private readonly listeners = {
    event: (event: SlackSocketEvent) => this.onEvent(event),
    connected: () => this.onConnected(),
    disconnected: () => this.onDisconnected(),
    wsMessage: (data: unknown) => this.onWsMessage(data),
  };

  constructor(private readonly input: SlackSocketTransportInput) {
    this.retryBaseMs = Math.max(input.options?.retryBaseMs ?? 2_000, 1);
    this.retryMaxMs = Math.max(input.options?.retryMaxMs ?? 5 * 60_000, this.retryBaseMs);
    this.stableMs = Math.max(input.options?.stableMs ?? STABLE_MS, 0);
    this.catchUpSpacingMs = Math.max(input.options?.catchUpSpacingMs ?? CATCH_UP_SPACING_MS, 0);
  }

  start(host: ChannelTransportContext, deliver: ChannelTransportDeliver): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.failures = 0;
    this.lastProblem = null;
    this.quickDrops = 0;
    this.catchUpEndedAt = null;
    this.reported = null;
    this.outageSince = null;
    this.outageDrops = 0;
    this.loopDelay ??= new LoopDelay();
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
    this.connectedAt = null;
    this.catchUpAgain = false;
    this.loopDelay?.stop();
    this.loopDelay = null;
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
      this.catchUpState = "idle";
    }
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
        const sdkLogger = slackSdkLogger((line) => host.log(`socket: ${line}`), "socket mode", () => [token]);
        client = await (this.input.options?.createClient ?? defaultClient)({
          appToken: token,
          autoReconnectEnabled: false,
          clientPingTimeout: CLIENT_PING_TIMEOUT_MS,
          // SDK 的警告和错误照常进日志，也记成这次连接断开的原因；debug 只认 WebSocket 关闭的那一行（close code）。
          logger: {
            ...sdkLogger,
            debug: (...parts: unknown[]) => {
              const close = parts.length === 1 && typeof parts[0] === "string" ? CLOSE_FRAME.exec(parts[0]) : null;
              if (close) this.noteDrop(`WebSocket closed with code ${close[1]}${close[2] ? ` (${close[2]})` : ""}`, token);
            },
            warn: (...parts: unknown[]) => {
              this.noteDrop(`SDK warning: ${partsText(parts)}`, token);
              sdkLogger.warn(...parts);
            },
            error: (...parts: unknown[]) => {
              this.noteDrop(`SDK error: ${partsText(parts)}`, token);
              sdkLogger.error(...parts);
            },
          },
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
        client.on("ws_message", this.listeners.wsMessage);
        this.client = client;
        this.clientToken = token;
      }
      this.dropNotes = [];
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
    client.off("ws_message", this.listeners.wsMessage);
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
    this.connectedAt = Date.now();
    this.dropNotes = [];
    this.report({ state: "connected" });
    const reconnected = this.connectedBefore;
    this.connectedBefore = true;
    host.log(reconnected ? "socket: reconnected (Socket Mode)" : "socket: connected (Socket Mode)");
    this.requestCatchUp();
  }

  private onDisconnected(): void {
    if (this.stopped) return;
    const reason = this.dropNotes.length ? this.dropNotes.join("; ") : "reason unknown: neither Slack nor the SDK said why";
    this.dropNotes = [];
    const lived = this.connectedAt === null ? null : Date.now() - this.connectedAt;
    this.connectedAt = null;
    if (lived !== null) {
      this.quickDrops = lived < this.stableMs ? this.quickDrops + 1 : 0;
      this.outageSince ??= Date.now();
      this.outageDrops += 1;
    }
    // 连接断了以后的第一次重连不等（Slack 要我们换连接时就是这样）；连续很快又断时从第二次起退避；之后连不上再退避。
    const dropDelay = this.quickDrops <= 1 ? 0 : Math.min(this.retryBaseMs * 2 ** Math.min(this.quickDrops - 2, 20), DROP_BACKOFF_MAX_MS, this.retryMaxMs);
    const failureDelay = this.failures === 0 ? 0 : Math.min(this.retryBaseMs * 2 ** Math.min(this.failures - 1, 20), this.retryMaxMs);
    const delay = Math.max(dropDelay, failureDelay);
    const after = lived === null ? "" : ` after ${Math.round(lived / 1000)}s connected`;
    const next = delay === 0 ? "reconnecting now" : `reconnecting in ${delay} ms (${this.quickDrops} quick disconnects in a row)`;
    this.host?.log(`socket: disconnected${after} (${reason}); ${next}`);
    this.report({ state: "connecting", disconnectReason: reason });
    if (this.connecting) return;
    if (delay === 0) this.connect();
    else this.schedule(delay);
  }

  // 记下这次连接断开的一条原因（去掉令牌，同样的只记一次）。心跳超时带上事件循环的延迟。
  private noteDrop(text: string, token: string): void {
    const loop = HEARTBEAT_TIMEOUT.test(text) && this.loopDelay ? ` (${this.loopDelay.text()})` : "";
    const note = scrubSlackText(text, [token]).slice(0, DROP_NOTE_CHARS - loop.length) + loop;
    if (this.dropNotes.length < DROP_NOTES && !this.dropNotes.includes(note)) this.dropNotes.push(note);
  }

  // Slack 的 disconnect 消息（要我们换连接）：记下它的 reason（例如 refresh_requested、link_disabled）。
  private onWsMessage(data: unknown): void {
    if (typeof data !== "string" || !data.includes("disconnect")) return;
    let message: { type?: unknown; reason?: unknown };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (message?.type !== "disconnect") return;
    const reason = typeof message.reason === "string" && /^[\w.-]{1,64}$/.test(message.reason) ? message.reason : "unknown";
    this.noteDrop(`Slack asked for a new connection (reason: ${reason})`, this.clientToken ?? "");
  }

  // ── 补拉 ──────────────────────────────────────────────────────────────────────────

  // 连上以后要补拉。合并很快又来的几次（见文件开头）。
  private requestCatchUp(): void {
    const host = this.host;
    if (!this.input.afterReconnect || !host || this.stopped) return;
    if (this.catchUpState === "waiting") {
      host.log("socket: a catch-up is already waiting; it covers this reconnect too");
      return;
    }
    if (this.catchUpState === "running") {
      if (!this.catchUpAgain) host.log("socket: a catch-up is running; one more catch-up after it covers this reconnect");
      this.catchUpAgain = true;
      return;
    }
    this.catchUpState = "waiting";
    const wait = this.catchUpEndedAt === null ? 0 : Math.max(this.catchUpEndedAt + this.catchUpSpacingMs - Date.now(), 0);
    if (wait === 0) {
      this.enqueueCatchUp();
      return;
    }
    host.log(`socket: catching up in ${wait} ms (the last catch-up ended less than ${this.catchUpSpacingMs} ms ago)`);
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.enqueueCatchUp();
    }, wait);
    this.catchUpTimer.unref?.();
  }

  // 补拉排在投递队列里。开始时没连着就不补：等连上再补。
  private enqueueCatchUp(): void {
    const host = this.host!;
    const afterReconnect = this.input.afterReconnect!;
    this.enqueue(async () => {
      this.catchUpState = "running";
      let ran = false;
      try {
        if (this.stopped || this.connectedAt === null) return;
        const context = await host.context();
        if (!context || this.stopped) return;
        ran = true;
        // 交出这次补拉盖住的断线（合并的几次断开从第一次算起），清空：跑的时候又断了，下一次补拉交新的一段。
        const outage = this.outageSince === null
          ? null
          : { disconnectedAt: new Date(this.outageSince), reconnectedAt: new Date(this.connectedAt ?? Date.now()), drops: this.outageDrops };
        this.outageSince = null;
        this.outageDrops = 0;
        await afterReconnect({ context, transport: host, deliver: this.deliver!, active: () => !this.stopped, outage });
      } finally {
        this.catchUpState = "idle";
        if (ran) this.catchUpEndedAt = Date.now();
        if (this.catchUpAgain) {
          this.catchUpAgain = false;
          this.requestCatchUp();
        }
      }
    }, "catching up after the reconnect");
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

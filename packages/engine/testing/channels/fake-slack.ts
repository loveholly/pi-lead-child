// 假的 Slack（工单 11；slack-takeover 工单 02 加上 Socket Mode）：在内存里模拟 Slack，给 Slack 来源插件用。
// 不连网络，没有真的令牌。消息的 ts 按顺序生成，envelope 的 event_id 也是。
// 三个入口：
//   - api：SlackWebApi 的替身，直接调用。
//   - fetch：Slack Web API 的 HTTP 替身（https://slack.com/api/<method>，表单编码，Authorization 头带令牌），给真实的
//     WebClient（sources/slack-web-api.ts）和 SocketModeClient 开连接用。可以让某个方法下一次回 429（Retry-After）。
//   - createSocketClient：假的 SocketModeClient。push 把一次投递当成 Socket Mode 的 envelope 发给连着的客户端，
//     记下客户端回的 ack；dropConnection 模拟断线；failNextSocketStart 让下一次连接失败。
// 实现的 Web API：auth.test、apps.connections.open（只认 app-level token）、users.info、conversations.info（外部共享）、
// conversations.history、conversations.replies（oldest、limit）、chat.postMessage、chat.delete、chat.update、reactions.add、
// emoji.list（工作区的自定义 emoji，要 emoji:read；缺省的权限里没有它，和建应用的清单一样是可选的）。
// chat.update 和真的 Slack 一样只能改自己发的消息（别人的回 cant_update_message）；reactions.add 要 reactions:write，
// 同一个人对同一条消息回同一个表情第二次回 already_reacted。
// 令牌的权限：真实的 Slack 在 x-oauth-scopes 头里说这个令牌有哪些权限，WebClient 把它放进 response_metadata.scopes。
// fetch 照这样发头；api 直接把 response_metadata.scopes 放进结果。缺省给齐 Slack 通道要的权限（scopes 选项可以少给）。
// bot token（FAKE_SLACK_BOT_TOKEN）：auth.test 认它，结果带 bot_id（设置页要拒绝它）。
// 投递（Events API 的 event_callback）：dm、mention、chatter、selfReply、echoOf、edit、remove，签名按 Slack 的规则（v0 HMAC-SHA256）。
// 系统用 chat.postMessage 发出去的消息，Slack 会再推回一条 message 事件（echoOf 造这一条）。
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { SLACK_APP_TOKEN_ENV } from "@pi-lead-child/core";
import type {
  ChannelCredential, ChannelDelivery, SlackFetch, SlackSocketClient, SlackSocketClientFactory, SlackSocketEvent, SlackWebApi,
} from "../../src/index.js";

type SocketClientOptions = Parameters<SlackSocketClientFactory>[0];

export interface FakeSlackUser {
  name: string;
  // 用户所在的工作区。不给时是本工作区；给了别的工作区就是外部的人（Slack Connect）。
  team?: string;
  // users.info 的 real_name。缺省和 name 一样。
  realName?: string;
}

export interface FakeSlackMessage {
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  team?: string;
  text: string;
  // 发消息时带的 Block Kit（chat.postMessage 的 blocks）。没带时没有这一项。
  blocks?: Array<Record<string, unknown>>;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  deleted: boolean;
  // chat.update 改过几次。
  edits?: number;
  // 表情回应：名字和回了这个表情的人。
  reactions?: Array<{ name: string; users: string[] }>;
}

export interface FakeSlackOptions {
  teamId?: string;
  self?: { id: string; name: string };
  users?: Record<string, FakeSlackUser>;
  channels?: Record<string, string>;
  // 和别的工作区共享的频道（conversations.info 的 is_ext_shared）。
  sharedChannels?: readonly string[];
  // 凭据。缺省是一组只在测试里出现的哨兵值，合约测试检查它们没有出现在日志、事件和卡片里。
  token?: string;
  signingSecret?: string;
  appToken?: string;
  // 一个 bot token：auth.test 认它，结果带 bot_id。缺省是 FAKE_SLACK_BOT_TOKEN。
  botToken?: string;
  // 用户令牌的权限（x-oauth-scopes）。缺省是 FAKE_SLACK_USER_SCOPES。
  scopes?: readonly string[];
  // 和用户还没有私信对话的人（users.conversations 里没有，要 conversations.open，2026-10-23）。别的人都有私信 D0<编号>。
  noDirect?: readonly string[];
  // 工作区的自定义 emoji（emoji.list）：名字 → 图片地址或者 alias:<名字>。缺省没有。
  emoji?: Record<string, string>;
  now?: () => Date;
}

export const FAKE_SLACK_TOKEN = "xoxp-fake-sentinel-token-7f3a9c";
export const FAKE_SLACK_SIGNING_SECRET = "fake-slack-signing-secret-91be0d";
export const FAKE_SLACK_APP_TOKEN = "xapp-1-AFAKE-sentinel-app-token-5d2e81";
export const FAKE_SLACK_BOT_TOKEN = "xoxb-fake-sentinel-bot-token-3c9e1a";
// Slack 通道的应用清单要的用户权限（.scratch/slack-takeover/setup.md）。
export const FAKE_SLACK_USER_SCOPES: readonly string[] = [
  "channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read", "users:read", "chat:write", "reactions:write",
];

/** 假的 SocketModeClient：EventEmitter，和 SDK 一样发 slack_event、connected、disconnected。 */
export class FakeSocketModeClient extends EventEmitter implements SlackSocketClient {
  connected = false;
  // SDK 的 logger（测试可以往里写，看日志有没有去掉令牌）。
  readonly logger: SocketClientOptions["logger"] | null;
  readonly appToken: string;

  constructor(private readonly slack: FakeSlack, readonly options: SocketClientOptions) {
    super();
    this.appToken = options.appToken;
    this.logger = options.logger ?? null;
  }

  async start(): Promise<unknown> {
    await Promise.resolve();
    await this.slack.socketStartGate;
    const failure = this.slack.takeSocketFailure();
    if (failure) {
      const error = Object.assign(new Error(`An API error occurred: ${failure}`), {
        code: "slack_webapi_platform_error", data: { ok: false, error: failure },
      });
      throw error;
    }
    if (this.appToken !== this.slack.appToken) {
      throw Object.assign(new Error("An API error occurred: invalid_auth"), { code: "slack_webapi_platform_error", data: { ok: false, error: "invalid_auth" } });
    }
    this.connected = true;
    this.slack.connections += 1;
    this.emit("connected");
    return { ok: true, url: "wss://fake-slack.test/link" };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnected");
  }

  /** 连接断了（例如 Slack 要换连接、网络断了）。 */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnected");
  }

  /** 发一个 envelope。返回 envelope_id。 */
  envelope(type: string, body: unknown): string {
    const id = `env-${this.slack.nextEnvelope++}`;
    const ack = async () => {
      if (!this.connected) throw new Error("Failed to send a message as the client has no active connection");
      this.slack.acks.push(id);
      this.slack.timeline.push(`ack:${id}`);
    };
    const event: SlackSocketEvent = { ack, envelope_id: id, type, body };
    this.emit("slack_event", event);
    return id;
  }
}

export class FakeSlack {
  readonly teamId: string;
  readonly self: { id: string; name: string };
  readonly users: Map<string, FakeSlackUser>;
  readonly channelNames: Map<string, string>;
  readonly sharedChannels: Set<string>;
  readonly noDirect: Set<string>;
  readonly credential: ChannelCredential;
  readonly appToken: string;
  readonly botToken: string;
  // 用户令牌现在的权限。测试可以改它（例如用户在 Slack 里补了权限）。
  scopes: string[];
  // 工作区的自定义 emoji。测试可以改它（例如用户传了新的 emoji）。
  readonly emoji: Map<string, string>;
  readonly messages: FakeSlackMessage[] = [];
  // 收到的 Web API 调用（不含令牌）。
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  // fetch 收到的请求：方法、内容类型，和 Authorization 头里是不是 Bearer 令牌（不记令牌本身）。
  readonly requests: Array<{ method: string; contentType: string; bearer: boolean }> = [];
  // Socket Mode：建过的客户端、客户端回的 ack、ack 和别的事情的先后（测试自己也可以往里写）。
  readonly socketClients: FakeSocketModeClient[] = [];
  readonly acks: string[] = [];
  readonly timeline: string[] = [];
  connections = 0;
  nextEnvelope = 1;
  private readonly now: () => Date;
  private nextEvent = 1;
  private nextTs = 1_760_000_000;
  private crashAfterPost = false;
  private failures = new Map<string, string>();
  private holds = new Map<string, Promise<void>>();
  private responseHolds = new Map<string, Promise<void>>();
  private rateLimits = new Map<string, number>();
  private socketFailures: string[] = [];
  // holdSocketStart 时，连接停在 start() 里，等放行。
  socketStartGate: Promise<void> = Promise.resolve();

  constructor(options: FakeSlackOptions = {}) {
    this.teamId = options.teamId ?? "T0HOME";
    this.self = options.self ?? { id: "U0SELF", name: "我" };
    this.users = new Map(Object.entries({ U0ZHANG: { name: "张三" }, U0LI: { name: "李四" }, ...(options.users ?? {}) }));
    this.users.set(this.self.id, { name: this.self.name });
    this.channelNames = new Map(Object.entries({ C0PROJ: "proj-x", ...(options.channels ?? {}) }));
    this.sharedChannels = new Set(options.sharedChannels ?? []);
    this.noDirect = new Set(options.noDirect ?? []);
    this.appToken = options.appToken ?? FAKE_SLACK_APP_TOKEN;
    this.botToken = options.botToken ?? FAKE_SLACK_BOT_TOKEN;
    this.scopes = [...(options.scopes ?? FAKE_SLACK_USER_SCOPES)];
    this.emoji = new Map(Object.entries(options.emoji ?? {}));
    this.credential = {
      token: options.token ?? FAKE_SLACK_TOKEN,
      signingSecret: options.signingSecret ?? FAKE_SLACK_SIGNING_SECRET,
      account: this.self.id,
      accountName: this.self.name,
      secrets: { [SLACK_APP_TOKEN_ENV]: this.appToken },
    };
    this.now = options.now ?? (() => new Date());
  }

  // ── Web API ───────────────────────────────────────────────────────────────────────

  readonly api: SlackWebApi = {
    call: async (method, args, token) => this.handle(method, args, token),
  };

  private async handle(method: string, args: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
    const result = await this.handleNow(method, args, token);
    const hold = this.responseHolds.get(method);
    if (hold) {
      this.responseHolds.delete(method);
      await hold;
    }
    return result;
  }

  private async handleNow(method: string, args: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, args });
    // app-level token 只能开 Socket 连接；别的方法要用户令牌。
    if (method === "apps.connections.open") {
      return token === this.appToken ? { ok: true, url: "wss://fake-slack.test/link" } : { ok: false, error: "invalid_auth" };
    }
    if (token === this.appToken) return { ok: false, error: "not_allowed_token_type" };
    if (token === this.botToken) {
      if (method === "auth.test") {
        return {
          ok: true, user_id: "U0BOT", user: "assistant-bot", team_id: this.teamId, team: "Home", bot_id: "B0BOT",
          response_metadata: { scopes: ["chat:write", "channels:history"] },
        };
      }
      return { ok: false, error: "not_allowed_token_type" };
    }
    if (token !== this.credential.token) return { ok: false, error: "invalid_auth" };
    const hold = this.holds.get(method);
    if (hold) {
      this.holds.delete(method);
      await hold;
    }
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw new Error(failure);
    }
    switch (method) {
      case "auth.test":
        return {
          ok: true, user_id: this.self.id, user: "me", team_id: this.teamId, team: "Home",
          response_metadata: { scopes: [...this.scopes] },
        };
      case "users.info": {
        const user = this.users.get(String(args.user));
        return user
          ? { ok: true, user: { id: args.user, name: user.name, real_name: user.realName ?? user.name, profile: { display_name: user.name } } }
          : { ok: false, error: "user_not_found" };
      }
      case "conversations.info": {
        const id = String(args.channel);
        // 私信 D0<x> 的对方是 U0<x>（和 dm、users.conversations 一样）。用户发给自己的私信是 D0SELF，对方是用户本人。
        if (id.startsWith("D")) return { ok: true, channel: { id, is_im: true, user: `U0${id.slice(2)}`, is_ext_shared: false, is_shared: false } };
        const name = this.channelNames.get(id);
        const shared = this.sharedChannels.has(id);
        return name ? { ok: true, channel: { id, name, is_ext_shared: shared, is_shared: shared } } : { ok: false, error: "channel_not_found" };
      }
      // 找对话（Lead 代用户直接发消息，2026-10-23）：一页给完，没有下一页。
      case "users.list":
        return {
          ok: true, response_metadata: { next_cursor: "" },
          members: [...this.users].map(([id, user]) => ({
            id, name: user.name, real_name: user.realName ?? user.name, deleted: false, is_bot: false,
            profile: { display_name: user.name, real_name: user.realName ?? user.name },
          })),
        };
      case "users.conversations": {
        const types = String(args.types ?? "public_channel").split(",");
        const direct = types.includes("im")
          ? [...this.users.keys()].filter((id) => id !== this.self.id && !this.noDirect.has(id))
            .map((id) => ({ id: `D0${id.slice(2)}`, is_im: true, user: id }))
          : [];
        const channels = types.includes("public_channel")
          ? [...this.channelNames].map(([id, name]) => ({ id, name, is_channel: true, is_private: false }))
          : [];
        return { ok: true, channels: [...channels, ...direct], response_metadata: { next_cursor: "" } };
      }
      case "conversations.open": {
        // 和真的 Slack 一样：用户令牌开私信要 im:write。
        if (!this.scopes.includes("im:write")) return { ok: false, error: "missing_scope", needed: "im:write" };
        const user = String(args.users ?? "");
        if (!this.users.has(user)) return { ok: false, error: "user_not_found" };
        this.noDirect.delete(user);
        return { ok: true, channel: { id: `D0${user.slice(2)}` } };
      }
      case "conversations.history": {
        const top = this.live().filter((message) => message.channel === args.channel && !message.thread_ts && this.after(message, args.oldest));
        return { ok: true, messages: top.reverse().slice(0, this.limit(args.limit)).map((message) => this.wire(message)) };
      }
      case "conversations.replies": {
        const thread = this.live().filter((message) => message.channel === args.channel
          && (message.ts === args.ts || message.thread_ts === args.ts) && (message.ts === args.ts || this.after(message, args.oldest)));
        return { ok: true, messages: thread.slice(0, this.limit(args.limit)).map((message) => this.wire(message)) };
      }
      case "chat.postMessage": {
        // 和真的 Slack 一样检查 Block Kit：不合规就回 invalid_blocks，整条不发。
        if (args.blocks !== undefined && !validBlocks(args.blocks)) return { ok: false, error: "invalid_blocks" };
        const message: FakeSlackMessage = {
          channel: String(args.channel), ts: this.ts(), user: this.self.id, text: String(args.text ?? ""), deleted: false,
          ...(typeof args.thread_ts === "string" ? { thread_ts: args.thread_ts } : {}),
          ...(Array.isArray(args.blocks) ? { blocks: args.blocks as Array<Record<string, unknown>> } : {}),
          ...(args.metadata ? { metadata: args.metadata as FakeSlackMessage["metadata"] } : {}),
        };
        this.messages.push(message);
        if (this.crashAfterPost) {
          this.crashAfterPost = false;
          throw new Error("connection reset after the message was posted");
        }
        return { ok: true, channel: message.channel, ts: message.ts };
      }
      case "chat.update": {
        const message = this.live().find((candidate) => candidate.channel === args.channel && candidate.ts === args.ts);
        if (!message) return { ok: false, error: "message_not_found" };
        if (message.user !== this.self.id) return { ok: false, error: "cant_update_message" };
        const hasText = typeof args.text === "string" && args.text.length > 0;
        const hasBlocks = Array.isArray(args.blocks) && args.blocks.length > 0;
        if (!hasText && !hasBlocks) return { ok: false, error: "no_text" };
        if (args.blocks !== undefined && !(Array.isArray(args.blocks) && args.blocks.length === 0) && !validBlocks(args.blocks)) {
          return { ok: false, error: "invalid_blocks" };
        }
        if (typeof args.text === "string") message.text = args.text;
        // 和真的 Slack 一样：不传 blocks 时留着原来的，传空数组时清掉。
        if (Array.isArray(args.blocks)) {
          if (args.blocks.length) message.blocks = args.blocks as Array<Record<string, unknown>>;
          else delete message.blocks;
        }
        message.edits = (message.edits ?? 0) + 1;
        return { ok: true, channel: message.channel, ts: message.ts, text: message.text };
      }
      case "emoji.list": {
        if (!this.scopes.includes("emoji:read")) return { ok: false, error: "missing_scope", needed: "emoji:read" };
        return { ok: true, emoji: Object.fromEntries(this.emoji), cache_ts: "1760000000.000000" };
      }
      case "reactions.add": {
        if (!this.scopes.includes("reactions:write")) return { ok: false, error: "missing_scope", needed: "reactions:write" };
        if (typeof args.timestamp !== "string") return { ok: false, error: "no_item_specified" };
        if (typeof args.name !== "string" || !/^[a-z0-9_+'-]{1,100}$/.test(args.name)) return { ok: false, error: "invalid_name" };
        const message = this.live().find((candidate) => candidate.channel === args.channel && candidate.ts === args.timestamp);
        if (!message) return { ok: false, error: "message_not_found" };
        const reactions = message.reactions ?? (message.reactions = []);
        const reaction = reactions.find((entry) => entry.name === args.name);
        if (reaction?.users.includes(this.self.id)) return { ok: false, error: "already_reacted" };
        if (reaction) reaction.users.push(this.self.id);
        else reactions.push({ name: args.name, users: [this.self.id] });
        return { ok: true };
      }
      case "reactions.remove": {
        if (!this.scopes.includes("reactions:write")) return { ok: false, error: "missing_scope", needed: "reactions:write" };
        const message = this.live().find((candidate) => candidate.channel === args.channel && candidate.ts === args.timestamp);
        if (!message) return { ok: false, error: "message_not_found" };
        const reaction = message.reactions?.find((entry) => entry.name === args.name);
        if (!reaction?.users.includes(this.self.id)) return { ok: false, error: "no_reaction" };
        reaction.users = reaction.users.filter((user) => user !== this.self.id);
        if (!reaction.users.length) message.reactions = message.reactions!.filter((entry) => entry !== reaction);
        return { ok: true };
      }
      case "chat.delete": {
        const message = this.live().find((candidate) => candidate.channel === args.channel && candidate.ts === args.ts);
        if (!message) return { ok: false, error: "message_not_found" };
        message.deleted = true;
        return { ok: true, channel: message.channel, ts: message.ts };
      }
      default:
        return { ok: false, error: "unknown_method" };
    }
  }

  private after(message: FakeSlackMessage, oldest: unknown): boolean {
    return typeof oldest !== "string" || Number(message.ts) > Number(oldest);
  }

  private limit(value: unknown): number {
    const limit = Number(value);
    return Number.isFinite(limit) && limit > 0 ? limit : 1_000;
  }

  // 消息在 Web API 里的样子。
  private wire(message: FakeSlackMessage): Record<string, unknown> {
    return {
      type: "message", user: message.user, text: message.text, ts: message.ts, team: message.team ?? this.teamId,
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
  }

  /** Slack Web API 的 HTTP 替身（给真实的 WebClient）。 */
  readonly fetch: SlackFetch = (async (url: string | URL, init?: { headers?: unknown; body?: unknown }) => {
    const method = String(url).replace(/^.*\/api\//, "");
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const authorization = headers.get("authorization") ?? "";
    const contentType = headers.get("content-type") ?? "";
    this.requests.push({ method, contentType, bearer: authorization.startsWith("Bearer ") });
    const limited = this.rateLimits.get(method);
    if (limited !== undefined) {
      this.rateLimits.delete(method);
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": String(limited) },
      });
    }
    const args: Record<string, unknown> = {};
    let bodyToken = false;
    for (const [key, value] of new URLSearchParams(typeof init?.body === "string" ? init.body : "")) {
      if (key === "token") {
        bodyToken = true;
        continue;
      }
      args[key] = value.startsWith("{") || value.startsWith("[") ? JSON.parse(value) : value;
    }
    let result: Record<string, unknown>;
    try {
      // 和真的 Slack 一样：apps.connections.open 只认 Authorization 头，请求体里带了 token 就回 invalid_auth
      // （https://api.slack.com/methods/apps.connections.open；2026-10-21 用户的 App-Level Token 一直被判无效就是这个）。
      result = method === "apps.connections.open" && bodyToken
        ? { ok: false, error: "invalid_auth" }
        : await this.handle(method, args, authorization.replace(/^Bearer /, ""));
    } catch (error) {
      throw new TypeError(`fetch failed: ${(error as Error).message}`);
    }
    // 权限在 x-oauth-scopes 头里（WebClient 再放回 response_metadata.scopes），不在 JSON 里。
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    const metadata = result.response_metadata as { scopes?: string[] } | undefined;
    if (metadata?.scopes) {
      responseHeaders["x-oauth-scopes"] = metadata.scopes.join(",");
      const { response_metadata: _scopes, ...rest } = result;
      result = rest;
    }
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  }) as unknown as SlackFetch;

  /** 下一次调用这个方法停在 Slack 里，等返回的函数放行（模拟 Slack 很慢）。 */
  holdNext(method: string): () => void {
    let release!: () => void;
    this.holds.set(method, new Promise<void>((resolve) => { release = resolve; }));
    return () => release();
  }

  /** 下一次调用这个方法在 Slack 里做完了，回答却停住，等返回的函数放行（模拟推回来的事件比回答快）。 */
  holdNextResponse(method: string): () => void {
    let release!: () => void;
    this.responseHolds.set(method, new Promise<void>((resolve) => { release = resolve; }));
    return () => release();
  }

  /** 下一次 fetch 这个方法回 429，Retry-After 是 retryAfterSec 秒。 */
  rateLimitNext(method: string, retryAfterSec = 0): void {
    this.rateLimits.set(method, retryAfterSec);
  }

  /** 下一次 chat.postMessage 在 Slack 里发成以后、回结果之前断开（模拟进程在这时崩溃）。 */
  crashAfterNextPost(): void {
    this.crashAfterPost = true;
  }

  /** 下一次 chat.postMessage 失败，报错的文字里带着令牌、签名密钥和 app-level token（模拟一个不小心的客户端库）。 */
  failNextPostEchoingCredential(): void {
    this.failures.set("chat.postMessage", `401 for token ${this.credential.token} (secret ${this.credential.signingSecret}, app ${this.appToken})`);
  }

  /** 下一次调用这个方法时网络出错。 */
  failNext(method: string, message: string): void {
    this.failures.set(method, message);
  }

  /** 系统替用户发出去、还没删掉的消息。 */
  sent(channel?: string): FakeSlackMessage[] {
    return this.live().filter((message) => message.user === this.self.id && message.metadata && (!channel || message.channel === channel));
  }

  private live(): FakeSlackMessage[] {
    return this.messages.filter((message) => !message.deleted);
  }

  private ts(): string {
    this.nextTs += 1;
    return `${this.nextTs}.000100`;
  }

  /** 往后拨消息的时间戳（ts 按秒递增，和 now 无关）：之后的消息像是过了 ms 毫秒才发的，例如三天以后。 */
  later(ms: number): void {
    this.nextTs += Math.max(Math.round(ms / 1000), 0);
  }

  // ── Socket Mode ───────────────────────────────────────────────────────────────────

  /** 假的 SocketModeClient 工厂（SlackSocketOptions.createClient）。 */
  readonly createSocketClient = (options: SocketClientOptions): FakeSocketModeClient => {
    const client = new FakeSocketModeClient(this, options);
    this.socketClients.push(client);
    return client;
  };

  /** 现在连着的客户端。 */
  socket(): FakeSocketModeClient | undefined {
    return this.socketClients.filter((client) => client.connected).at(-1);
  }

  /** 把一次投递当成 Socket Mode 的 events_api envelope 发给连着的客户端。返回 envelope_id。 */
  push(delivery: ChannelDelivery): string {
    const client = this.socket();
    if (!client) throw new Error("no Socket Mode client is connected");
    return client.envelope("events_api", JSON.parse(delivery.body));
  }

  /** 连着的客户端断线。 */
  dropConnection(): void {
    this.socket()?.drop();
  }

  /** 下一次 Socket 连接失败，Slack 回这个错误（例如 invalid_auth）。 */
  failNextSocketStart(error: string): void {
    this.socketFailures.push(error);
  }

  /** 下一次（和之后的）Socket 连接停在 start() 里，直到调用返回的函数放行。 */
  holdSocketStart(): () => void {
    let release!: () => void;
    this.socketStartGate = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      this.socketStartGate = Promise.resolve();
      release();
    };
  }

  takeSocketFailure(): string | undefined {
    return this.socketFailures.shift();
  }

  // ── 投递（Events API）──────────────────────────────────────────────────────────────

  /** 别人发给用户的私信。channel 缺省是这个人和用户的私信频道（D0<用户>）。bot：发信人是一个应用（消息带 bot_id）。 */
  // bot：应用发的（带 bot_id）。attachments、blocks：应用常把正文放在这里，text 是空的（例如日历提醒）。
  dm(
    from: string, text: string,
    options: { channel?: string; thread?: string; bot?: boolean; attachments?: unknown[]; blocks?: unknown[] } = {},
  ): ChannelDelivery {
    const channel = options.channel ?? `D0${from.slice(2)}`;
    return this.post({
      channel, channel_type: "im", user: from, text, ...(options.thread ? { thread_ts: options.thread } : {}),
      ...(options.bot ? { bot_id: `B0${from.slice(2)}` } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      ...(options.blocks ? { blocks: options.blocks } : {}),
    });
  }

  /** 别人在频道里提到用户。 */
  mention(from: string, text: string, options: { channel?: string; thread?: string } = {}): ChannelDelivery {
    return this.post({
      channel: options.channel ?? "C0PROJ", channel_type: "channel", user: from, text: `<@${this.self.id}> ${text}`,
      ...(options.thread ? { thread_ts: options.thread } : {}),
    });
  }

  /** 频道里没有提到用户的消息（thread：发在这个线程里）。 */
  chatter(from: string, text: string, channel = "C0PROJ", options: { thread?: string } = {}): ChannelDelivery {
    return this.post({ channel, channel_type: "channel", user: from, text, ...(options.thread ? { thread_ts: options.thread } : {}) });
  }

  /** 用户本人在 Slack 里回复了。 */
  selfReply(channel: string, text: string, options: { thread?: string; channelType?: string } = {}): ChannelDelivery {
    return this.post({
      channel, channel_type: options.channelType ?? (channel.startsWith("D") ? "im" : "channel"), user: this.self.id, text,
      ...(options.thread ? { thread_ts: options.thread } : {}),
    });
  }

  /** Slack 把系统发出去的那条消息推回来。 */
  // options.metadata 为 false：推回来的事件里没有 metadata（Slack 的文档没有写明 message 事件带不带它）。
  echoOf(message: FakeSlackMessage, options: { metadata?: boolean } = {}): ChannelDelivery {
    const withMetadata = options.metadata ?? true;
    return this.envelope({
      type: "message", channel: message.channel, channel_type: message.channel.startsWith("D") ? "im" : "channel",
      user: message.user, text: message.text, ts: message.ts, ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.metadata && withMetadata ? { metadata: message.metadata } : {}),
    });
  }

  /** 这次投递里的那条消息（频道和 ts）。 */
  messageOf(delivery: ChannelDelivery): FakeSlackMessage {
    const event = (JSON.parse(delivery.body) as { event: { channel: string; ts: string } }).event;
    const message = this.messages.find((candidate) => candidate.channel === event.channel && candidate.ts === event.ts);
    if (!message) throw new Error(`no message ${event.channel}:${event.ts}`);
    return message;
  }

  /** 发信人改了这条消息（message_changed）。 */
  edit(delivery: ChannelDelivery, text: string): ChannelDelivery {
    const message = this.messageOf(delivery);
    const previous = this.wire(message);
    message.text = text;
    const changeTs = this.ts();
    return this.envelope({
      type: "message", subtype: "message_changed", hidden: true, channel: message.channel, channel_type: this.channelType(message.channel),
      ts: changeTs, event_ts: changeTs,
      message: { ...this.wire(message), user_team: message.team ?? this.teamId, edited: { user: message.user, ts: changeTs } },
      previous_message: previous,
    });
  }

  /** 发信人删了这条消息（message_deleted）。 */
  remove(delivery: ChannelDelivery): ChannelDelivery {
    const message = this.messageOf(delivery);
    message.deleted = true;
    const changeTs = this.ts();
    return this.envelope({
      type: "message", subtype: "message_deleted", hidden: true, channel: message.channel, channel_type: this.channelType(message.channel),
      ts: changeTs, event_ts: changeTs, deleted_ts: message.ts, previous_message: this.wire(message),
    });
  }

  /** 同一次投递，Slack 重试了一次：同一个 event_id，新的时间戳和签名。 */
  redeliver(delivery: ChannelDelivery): ChannelDelivery {
    return this.sign(delivery.body, { retry: true });
  }

  /** 签名不对的投递（别人伪造的请求）。 */
  forge(delivery: ChannelDelivery): ChannelDelivery {
    return this.sign(delivery.body, { secret: "not-the-signing-secret" });
  }

  /** 时间戳太旧的投递（重放）。 */
  replayed(delivery: ChannelDelivery, ageMs: number): ChannelDelivery {
    return this.sign(delivery.body, { timestamp: Math.floor((this.now().getTime() - ageMs) / 1000) });
  }

  private channelType(channel: string): string {
    return channel.startsWith("D") ? "im" : "channel";
  }

  private post(event: Record<string, unknown>): ChannelDelivery {
    const ts = this.ts();
    const user = this.users.get(String(event.user));
    const team = user?.team ?? this.teamId;
    const message: FakeSlackMessage = {
      channel: String(event.channel), ts, user: String(event.user), team, text: String(event.text), deleted: false,
      ...(typeof event.thread_ts === "string" ? { thread_ts: event.thread_ts } : {}),
    };
    this.messages.push(message);
    return this.envelope({ type: "message", ...event, ts, user_team: team });
  }

  private envelope(event: Record<string, unknown>): ChannelDelivery {
    const body = JSON.stringify({
      type: "event_callback", team_id: this.teamId, event_id: `Ev${String(this.nextEvent++).padStart(6, "0")}`,
      event_time: Math.floor(this.now().getTime() / 1000), event,
    });
    return this.sign(body, {});
  }

  private sign(body: string, options: { secret?: string; timestamp?: number; retry?: boolean }): ChannelDelivery {
    const timestamp = String(options.timestamp ?? Math.floor(this.now().getTime() / 1000));
    const signature = `v0=${createHmac("sha256", options.secret ?? this.credential.signingSecret!).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return {
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
        ...(options.retry ? { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } : {}),
      },
      body,
    };
  }
}

// Block Kit 的规则（https://docs.slack.dev/reference/block-kit/blocks）：一条消息 1 到 50 个 block；section 的 text 和
// context 的元素是文字对象（mrkdwn 或 plain_text，1 到 3000 个字）；context 有 1 到 10 个元素。这里只认系统会发的两种 block，
// 别的类型也按不合规处理：系统发了没想到的 block 时测试要失败。
const TEXT_TYPES = new Set(["mrkdwn", "plain_text"]);

function validTextObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as { type?: unknown; text?: unknown };
  return typeof object.type === "string" && TEXT_TYPES.has(object.type)
    && typeof object.text === "string" && object.text.length >= 1 && object.text.length <= 3_000;
}

function validBlocks(blocks: unknown): boolean {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 50) return false;
  return blocks.every((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const { type, text, elements } = block as { type?: unknown; text?: unknown; elements?: unknown };
    if (type === "section") return validTextObject(text);
    if (type === "context") return Array.isArray(elements) && elements.length >= 1 && elements.length <= 10 && elements.every(validTextObject);
    return false;
  });
}

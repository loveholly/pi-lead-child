// 假的 Slack（工单 11；slack-takeover 工单 02 加上 Socket Mode）：在内存里模拟 Slack，给 Slack 来源插件用。
// 不连网络，没有真的令牌。消息的 ts 按顺序生成，envelope 的 event_id 也是。
// 三个入口：
//   - api：SlackWebApi 的替身，直接调用。
//   - fetch：Slack Web API 的 HTTP 替身（https://slack.com/api/<method>，表单编码，Authorization 头带令牌），给真实的
//     WebClient（sources/slack-web-api.ts）和 SocketModeClient 开连接用。可以让某个方法下一次回 429（Retry-After）。
//   - createSocketClient：假的 SocketModeClient。push 把一次投递当成 Socket Mode 的 envelope 发给连着的客户端，
//     记下客户端回的 ack；dropConnection 模拟断线；failNextSocketStart 让下一次连接失败。
// 实现的 Web API：auth.test、apps.connections.open（只认 app-level token）、users.info、conversations.info（外部共享）、
// conversations.history（oldest、latest、limit）、conversations.replies（oldest、limit）、chat.postMessage、chat.delete、chat.update、reactions.add、
// emoji.list（工作区的自定义 emoji，要 emoji:read；缺省的权限里没有它，和建应用的清单一样是可选的）、
// files.info（消息里附带的文件，要 files:read；也是可选的权限）。
// 断线以后的补拉（2026-11-03）用的两个：search.messages（要 search:read，用户令牌缺省没有；会话令牌有用户的全部权限）和
// client.counts（网页版客户端自己用的方法，只认会话令牌；用户令牌回 not_allowed_token_type）。search.messages 和真的 Slack 一样：
// 按 sort=timestamp 排序、count 最多 100、page 从 1 起；同一个对话（频道或 thread）里挨得近（5 分钟以内）的几条匹配只回一条。
// 查询只认两种写法：<@用户编号>（正文里提到这个人）和 after:YYYY-MM-DD（这一天以后，按 UTC 算）。文件的内容按 url_private 下载：api.download，或者 fetch
// 一个 https://files.slack.com/ 的地址（Authorization 头带用户令牌；令牌不对时和真的 Slack 一样回登录网页）。
// chat.update 和真的 Slack 一样只能改自己发的消息（别人的回 cant_update_message）；reactions.add 要 reactions:write，
// 同一个人对同一条消息回同一个表情第二次回 already_reacted。
// 令牌的权限：真实的 Slack 在 x-oauth-scopes 头里说这个令牌有哪些权限，WebClient 把它放进 response_metadata.scopes。
// fetch 照这样发头；api 直接把 response_metadata.scopes 放进结果。缺省给齐 Slack 通道要的权限（scopes 选项可以少给）。
// bot token（FAKE_SLACK_BOT_TOKEN）：auth.test 认它，结果带 bot_id（设置页要拒绝它）。
// 投递（Events API 的 event_callback）：dm、mention、chatter、selfReply、echoOf、edit、remove，签名按 Slack 的规则（v0 HMAC-SHA256）。
// 系统用 chat.postMessage 发出去的消息，Slack 会再推回一条 message 事件（echoOf 造这一条）。
// 装了这个应用的人（Events API 的 authorizations）：和真的 Slack 一样，一个事件只发一次，authorizations 里只写一个能看到它的人，
// 完整名单用 event_context 调 apps.event.authorizations.list（只认 App-Level Token，要 authorizations:read，可以分页）。
// 缺省只有用户本人能看到；seenBy 改成别的装了这个应用的人（例如共用一个应用的同事）。
// 浏览器会话（网页版 Slack 的协议，2026-11-02）：sessionFetch 和 createSessionSocket 注入 gabriel-slack 的 GabrielCore。
//   - 换令牌：GET https://app.slack.com/auth（Cookie 头带 d=<会话 cookie>）。cookie 对时回工作区、用户和会话令牌（xoxc-），
//     不对或者会话结束了（endSession）时和真的 Slack 一样回跳转到登录页。
//   - 工作区 Web API：POST https://home.slack.com/api/<method>，表单里带会话令牌，Cookie 头带 cookie。两个都对才认，
//     方法和 api 一样。
//   - WebSocket：地址里带会话令牌，请求头带 cookie。连上以后发 hello；回 ping；sessionPush 把一次投递里的消息当成网页版的
//     消息帧发过去（没有 channel_type，没有外层的 envelope）；sessionReconnectUrl 发 reconnect_url；dropSession 断线。
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { SLACK_APP_TOKEN_ENV, SLACK_SESSION_COOKIE_ENV } from "@pi-lead-child/core";
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
  // 消息附带的文件（dm 的 files 选项）。
  files?: FakeSlackFile[];
  // 消息卡片：转发的消息、链接预览、应用的卡片（dm、mention 的 attachments 选项），照原样存。
  attachments?: unknown[];
  // 应用（机器人）发的消息带它（dm、chatter 的 bot 选项）。
  bot_id?: string;
  deleted: boolean;
  // chat.update 改过几次。
  edits?: number;
  // 表情回应：名字和回了这个表情的人。
  reactions?: Array<{ name: string; users: string[] }>;
}

/** 一个上传到 Slack 的文件（addFile）。 */
export interface FakeSlackFile {
  id: string;
  name: string;
  mimetype: string;
  data: Uint8Array;
  // files.info 给的下载地址。缺省是 files.slack.com 上的私有地址。
  url: string;
  // 上传时给的标题、上传的人、文件种类（files.completeUploadExternal 建的文件才有）。
  title?: string;
  owner?: string;
  filetype?: string;
  // 分享到了哪里（completeUploadExternal 的 channel_id、thread_ts）。
  shares?: Array<{ channel: string; ts: string; threadTs: string | null }>;
}

/** 一个 canvas（canvases.create）。内容按空行分成段，每段有编号和种类（h1、h2、h3、list、paragraph）。 */
export interface FakeSlackCanvas {
  id: string;
  title: string;
  owner: string;
  channel: string | null;
  sections: Array<{ id: string; type: string; markdown: string }>;
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
  // App-Level Token 的权限。缺省只有 connections:write（Slack 生成令牌时要自己选）。
  appScopes?: readonly string[];
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
// 浏览器会话的 cookie 和用它换出的会话令牌。和别的哨兵值一样不能出现在日志、事件和卡片里。
export const FAKE_SLACK_SESSION_COOKIE = "xoxd-fake-sentinel-session-cookie-4b7e2a";
export const FAKE_SLACK_SESSION_TOKEN = "xoxc-fake-sentinel-session-token-8d1f3c";
// 网页版的工作区地址（会话方式的 Web API 发到这里）。
export const FAKE_SLACK_WORKSPACE_URL = "https://home.slack.com/";
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

/** 假的网页版 WebSocket（gabriel-slack 的 WebSocketLike：ws 包的那几个方法）。 */
export class FakeSessionSocket extends EventEmitter {
  readyState = 0;
  // 客户端发上来的帧（ping 之类）。
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(private readonly slack: FakeSlack, readonly url: string, readonly headers: Readonly<Record<string, string>>) {
    super();
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    // 和真的连接一样，回答晚一拍到：客户端发完以后才开始等 reply_to。
    if (frame.type === "ping" && typeof frame.id === "number") {
      const id = frame.id;
      setTimeout(() => {
        if (this.readyState === 1) this.frame({ type: "pong", reply_to: id });
      }, 0);
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, ""));
  }

  /** 发一个帧给客户端。 */
  frame(frame: Record<string, unknown>): void {
    if (this.readyState !== 1) throw new Error("the fake session socket is not open");
    this.emit("message", JSON.stringify(frame));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
    this.frame({ type: "hello", fast_reconnect: false });
    this.slack.sessionConnections += 1;
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
  // App-Level Token 现在的权限。测试可以改它。
  appScopes: string[];
  // 工作区的自定义 emoji。测试可以改它（例如用户传了新的 emoji）。
  readonly emoji: Map<string, string>;
  readonly messages: FakeSlackMessage[] = [];
  // 上传过的文件（addFile），按编号。
  readonly files = new Map<string, FakeSlackFile>();
  // canvas（canvases.create），按编号。
  readonly canvases = new Map<string, FakeSlackCanvas>();
  // files.getUploadURLExternal 给出去、还没完成的上传：按上传地址。
  private readonly uploads = new Map<string, { id: string; filename: string; length: number; data: Uint8Array | null }>();
  private nextSection = 1;
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
  // 浏览器会话：会话方式的凭据、建过的 WebSocket、连上过几次、会话还在不在（endSession 结束它）。
  readonly sessionCredential: ChannelCredential;
  readonly sessionSockets: FakeSessionSocket[] = [];
  sessionConnections = 0;
  // 用 cookie 换会话（GET /auth）成功了几次。
  sessionSignIns = 0;
  sessionLive = true;
  // 认哪个会话 cookie。缺省是 FAKE_SLACK_SESSION_COOKIE；测试可以换成真实长度的（网页版的 d cookie 可能超过 1000 个字符）。
  sessionCookie = FAKE_SLACK_SESSION_COOKIE;
  // 会话方式的 Web API 收到的方法名（不含令牌和 cookie）。
  readonly sessionCalls: string[] = [];
  private readonly now: () => Date;
  private nextEvent = 1;
  // 每个事件的 event_context → 装了这个应用、能看到它的人（apps.event.authorizations.list 的回答）。
  private readonly visibility = new Map<string, string[]>();
  private nextFile = 1;
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
    this.appScopes = [...(options.appScopes ?? ["connections:write"])];
    this.emoji = new Map(Object.entries(options.emoji ?? {}));
    this.credential = {
      token: options.token ?? FAKE_SLACK_TOKEN,
      signingSecret: options.signingSecret ?? FAKE_SLACK_SIGNING_SECRET,
      account: this.self.id,
      accountName: this.self.name,
      secrets: { [SLACK_APP_TOKEN_ENV]: this.appToken },
    };
    this.sessionCredential = {
      token: FAKE_SLACK_SESSION_COOKIE, account: this.self.id, accountName: this.self.name,
      secrets: { [SLACK_SESSION_COOKIE_ENV]: FAKE_SLACK_SESSION_COOKIE },
    };
    this.now = options.now ?? (() => new Date());
  }

  // ── Web API ───────────────────────────────────────────────────────────────────────

  readonly api: SlackWebApi = {
    call: async (method, args, token) => this.handle(method, args, token),
    download: async (url, token, maxBytes) => {
      this.downloads.push(url);
      const file = [...this.files.values()].find((candidate) => candidate.url === url);
      if (!file) throw new Error("slack file download: HTTP 404");
      if (token !== this.credential.token) throw new Error("slack file download: Slack answered with a web page, not the file");
      if (file.data.byteLength > maxBytes) throw new Error(`slack file download: the file is larger than ${maxBytes} bytes`);
      return file.data;
    },
    // 只收 files.getUploadURLExternal 给的地址；长度要和当时说的一样（真的 Slack 在完成时报错，这里提前报）。
    upload: async (url, data) => {
      const pending = this.uploads.get(url);
      if (!pending) throw new Error("slack file upload: HTTP 404");
      if (data.byteLength !== pending.length) throw new Error("slack file upload: HTTP 400");
      pending.data = data;
    },
  };

  // 下载过的文件地址（api.download 和 fetch 都记）。
  readonly downloads: string[] = [];

  /** 上传一个文件，返回它（编号 F0…）。消息带上它：dm 的 files 选项。 */
  addFile(name: string, mimetype: string, data: Uint8Array, options: { url?: string } = {}): FakeSlackFile {
    const id = `F0${String(this.nextFile++).padStart(6, "0")}`;
    const file = { id, name, mimetype, data, url: options.url ?? `https://files.slack.com/files-pri/${this.teamId}-${id}/${encodeURIComponent(name)}` };
    this.files.set(id, file);
    return file;
  }

  /** 消息和 files.info 里的文件（和真的 Slack 一样，不带内容）。 */
  wireFile(file: FakeSlackFile): Record<string, unknown> {
    const shares: Record<string, Record<string, Array<Record<string, unknown>>>> = {};
    for (const share of file.shares ?? []) {
      const scope = share.channel.startsWith("C") ? "public" : "private";
      ((shares[scope] ??= {})[share.channel] ??= []).push({ ts: share.ts, ...(share.threadTs ? { thread_ts: share.threadTs } : {}) });
    }
    return {
      id: file.id, name: file.name, title: file.title ?? file.name, mimetype: file.mimetype,
      filetype: file.filetype ?? file.name.split(".").pop() ?? "",
      size: file.data.byteLength, mode: "hosted", url_private: file.url, url_private_download: `${file.url}?download=1`,
      ...(file.owner ? { user: file.owner, permalink: `https://fake.slack.com/files/${file.owner}/${file.id}` } : {}),
      ...(file.shares?.length ? { shares } : {}),
    };
  }

  /** canvas 的 Markdown 原文（canvases.getContent 给的）。 */
  canvasMarkdown(id: string): string {
    const canvas = this.canvases.get(id);
    return canvas ? `${canvas.sections.map((section) => section.markdown).join("\n\n")}\n` : "";
  }

  private canvasSections(markdown: string): FakeSlackCanvas["sections"] {
    return markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => ({
      id: `temp:C:fake${this.nextSection++}`,
      type: /^### /.test(block) ? "h3" : /^## /.test(block) ? "h2" : /^# /.test(block) ? "h1" : /^(- |\d+\. )/.test(block) ? "list" : "paragraph",
      markdown: block,
    }));
  }

  private markdownContent(value: unknown): string | null {
    const content = value && typeof value === "object" ? value as { type?: unknown; markdown?: unknown } : null;
    return content?.type === "markdown" && typeof content.markdown === "string" ? content.markdown : null;
  }

  // canvases.*：按 Slack 的文档。edit 一次只能一步；段按 sections.lookup 给的编号认。
  private canvasMethod(method: string, args: Record<string, unknown>): Record<string, unknown> {
    const write = method === "canvases.create" || method === "canvases.edit";
    if (!this.scopes.includes(write ? "canvases:write" : "canvases:read")) {
      return { ok: false, error: "missing_scope", needed: write ? "canvases:write" : "canvases:read" };
    }
    if (method === "canvases.create") {
      const markdown = args.document_content === undefined ? "" : this.markdownContent(args.document_content);
      if (markdown === null) return { ok: false, error: "invalid_arguments" };
      const channel = typeof args.channel_id === "string" ? args.channel_id : null;
      if (channel && !channel.startsWith("D") && !this.channelNames.has(channel)) return { ok: false, error: "channel_not_found" };
      const id = `F0${String(this.nextFile++).padStart(6, "0")}`;
      this.canvases.set(id, {
        id, title: typeof args.title === "string" ? args.title : "Untitled", owner: this.self.id, channel, sections: this.canvasSections(markdown),
      });
      return { ok: true, canvas_id: id };
    }
    const canvas = this.canvases.get(String(args.canvas_id));
    if (!canvas) return { ok: false, error: "canvas_not_found" };
    if (method === "canvases.getContent") return { ok: true, content: this.canvasMarkdown(canvas.id) };
    if (method === "canvases.sections.lookup") {
      const criteria = (args.criteria ?? {}) as { contains_text?: unknown; section_types?: unknown };
      const types = Array.isArray(criteria.section_types) ? criteria.section_types.map(String) : null;
      const text = typeof criteria.contains_text === "string" ? criteria.contains_text : null;
      if (!types && text === null) return { ok: false, error: "invalid_arguments" };
      const sections = canvas.sections.filter((section) => (text === null || section.markdown.includes(text))
        && (!types || types.includes(section.type) || (types.includes("any_header") && /^h[123]$/.test(section.type))));
      return { ok: true, sections: sections.map((section) => ({ id: section.id })) };
    }
    if (method === "canvases.edit") {
      const changes = Array.isArray(args.changes) ? args.changes as Array<Record<string, unknown>> : [];
      if (changes.length !== 1) return { ok: false, error: "invalid_arguments" };
      const change = changes[0]!;
      const operation = String(change.operation);
      if (operation === "rename") {
        const title = this.markdownContent(change.title_content);
        if (title === null || change.section_id !== undefined) return { ok: false, error: "invalid_arguments" };
        canvas.title = title;
        return { ok: true };
      }
      const at = typeof change.section_id === "string" ? canvas.sections.findIndex((section) => section.id === change.section_id) : -1;
      const needsSection = ["insert_after", "insert_before", "delete"].includes(operation);
      if (needsSection && at < 0) return { ok: false, error: "canvas_editing_failed", detail: "section not found" };
      if (operation === "delete") {
        canvas.sections.splice(at, 1);
        return { ok: true };
      }
      const markdown = this.markdownContent(change.document_content);
      if (markdown === null) return { ok: false, error: "invalid_arguments" };
      const added = this.canvasSections(markdown);
      if (operation === "insert_at_start") canvas.sections.unshift(...added);
      else if (operation === "insert_at_end") canvas.sections.push(...added);
      else if (operation === "insert_before") canvas.sections.splice(at, 0, ...added);
      else if (operation === "insert_after") canvas.sections.splice(at + 1, 0, ...added);
      else if (operation === "replace" && change.section_id === undefined) canvas.sections = added;
      else if (operation === "replace" && at >= 0) canvas.sections.splice(at, 1, ...added);
      else return { ok: false, error: "canvas_editing_failed", detail: `bad change ${operation}` };
      return { ok: true };
    }
    return { ok: false, error: "unknown_method" };
  }

  // files.getUploadURLExternal、files.completeUploadExternal、files.delete：上传两步走，完成时可以分享到一个频道（和 thread）。
  // Slack 没有改文件内容的方法。
  private fileMethod(method: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!this.scopes.includes("files:write")) return { ok: false, error: "missing_scope", needed: "files:write" };
    if (method === "files.getUploadURLExternal") {
      const length = Number(args.length);
      if (typeof args.filename !== "string" || !args.filename || !Number.isInteger(length) || length <= 0) return { ok: false, error: "invalid_arguments" };
      const id = `F0${String(this.nextFile++).padStart(6, "0")}`;
      const url = `https://files.slack.com/upload/v1/fake-${id}`;
      this.uploads.set(url, { id, filename: args.filename, length, data: null });
      return { ok: true, upload_url: url, file_id: id };
    }
    if (method === "files.completeUploadExternal") {
      const list = Array.isArray(args.files) ? args.files as Array<{ id?: unknown; title?: unknown }> : [];
      if (!list.length) return { ok: false, error: "invalid_arguments" };
      const channel = typeof args.channel_id === "string" ? args.channel_id : null;
      if (channel && !channel.startsWith("D") && !this.channelNames.has(channel)) return { ok: false, error: "channel_not_found" };
      const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : null;
      const done: FakeSlackFile[] = [];
      for (const entry of list) {
        const found = [...this.uploads.entries()].find(([, upload]) => upload.id === entry.id);
        if (!found || !found[1].data) return { ok: false, error: "file_not_found" };
        this.uploads.delete(found[0]);
        const { id, filename, data } = found[1];
        const file: FakeSlackFile = {
          id, name: filename, title: typeof entry.title === "string" ? entry.title : filename, mimetype: "text/plain",
          filetype: /\.(md|markdown)$/i.test(filename) ? "markdown" : "text", data, owner: this.self.id,
          url: `https://files.slack.com/files-pri/${this.teamId}-${id}/${encodeURIComponent(filename)}`, shares: [],
        };
        this.files.set(id, file);
        done.push(file);
      }
      if (channel) {
        const ts = this.ts();
        this.messages.push({
          channel, ts, user: this.self.id, team: this.teamId, text: "", deleted: false, files: done, ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        for (const file of done) file.shares!.push({ channel, ts, threadTs });
      }
      return { ok: true, files: done.map((file) => this.wireFile(file)) };
    }
    if (method === "files.delete") {
      const file = this.files.get(String(args.file));
      if (!file) return { ok: false, error: "file_not_found" };
      if (file.owner && file.owner !== this.self.id) return { ok: false, error: "cant_delete_file" };
      this.files.delete(file.id);
      return { ok: true };
    }
    return { ok: false, error: "unknown_method" };
  }

  // via：调用从哪里来。session 是网页版的会话令牌（有用户的全部权限，能调 client.counts）。
  private async handle(method: string, args: Record<string, unknown>, token: string, via: "app" | "session" = "app"): Promise<Record<string, unknown>> {
    const result = await this.handleNow(method, args, token, via);
    const hold = this.responseHolds.get(method);
    if (hold) {
      this.responseHolds.delete(method);
      await hold;
    }
    return result;
  }

  private async handleNow(method: string, args: Record<string, unknown>, token: string, via: "app" | "session"): Promise<Record<string, unknown>> {
    this.calls.push({ method, args });
    // app-level token 只能开 Socket 连接；别的方法要用户令牌。
    if (method === "apps.connections.open") {
      return token === this.appToken ? { ok: true, url: "wss://fake-slack.test/link" } : { ok: false, error: "invalid_auth" };
    }
    if (method === "apps.event.authorizations.list") return this.eventAuthorizations(args, token);
    if (token === this.appToken) return { ok: false, error: "not_allowed_token_type" };
    if (token === this.botToken) {
      if (method === "auth.test") {
        return {
          ok: true, url: FAKE_SLACK_WORKSPACE_URL, user_id: "U0BOT", user: "assistant-bot", team_id: this.teamId, team: "Home", bot_id: "B0BOT",
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
          ok: true, url: FAKE_SLACK_WORKSPACE_URL, user_id: this.self.id, user: "me", team_id: this.teamId, team: "Home",
          response_metadata: { scopes: [...this.scopes] },
        };
      case "files.info": {
        if (!this.scopes.includes("files:read")) return { ok: false, error: "missing_scope", needed: "files:read" };
        const canvas = this.canvases.get(String(args.file));
        if (canvas) {
          return {
            ok: true, file: {
              id: canvas.id, title: canvas.title, filetype: "quip", pretty_type: "Canvas", mimetype: "application/vnd.slack-docs",
              user: canvas.owner, permalink: `https://fake.slack.com/docs/${this.teamId}/${canvas.id}`,
            },
          };
        }
        const file = this.files.get(String(args.file));
        return file ? { ok: true, file: { ...this.wireFile(file), url_private_download: file.url } } : { ok: false, error: "file_not_found" };
      }
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
        const live = this.live();
        // latest：和真的 Slack 一样只要早于它的（inclusive 缺省是 false，工单 #588 读 thread 开始以前的主时间线）。
        const before = (message: FakeSlackMessage) => typeof args.latest !== "string"
          || (args.inclusive === true ? Number(message.ts) <= Number(args.latest) : Number(message.ts) < Number(args.latest));
        const top = live.filter((message) => message.channel === args.channel && !message.thread_ts && this.after(message, args.oldest)
          && before(message));
        // 真 Slack 的 thread 根消息带 reply_count（只有根消息，回复不在这里）。
        const replies = (ts: string) => live.filter((reply) => reply.channel === args.channel && reply.thread_ts === ts).length;
        return {
          ok: true,
          messages: top.reverse().slice(0, this.limit(args.limit)).map((message) => {
            const count = replies(message.ts);
            return { ...this.wire(message), ...(count ? { reply_count: count } : {}) };
          }),
        };
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
      case "search.messages":
        if (via === "app" && !this.scopes.includes("search:read")) return { ok: false, error: "missing_scope", needed: "search:read" };
        return this.searchMessages(args);
      case "client.counts":
        return via === "session" ? this.clientCounts() : { ok: false, error: "not_allowed_token_type" };
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
      case "canvases.create":
      case "canvases.edit":
      case "canvases.getContent":
      case "canvases.sections.lookup":
        return this.canvasMethod(method, args);
      case "files.getUploadURLExternal":
      case "files.completeUploadExternal":
      case "files.delete":
        return this.fileMethod(method, args);
      default:
        return { ok: false, error: "unknown_method" };
    }
  }

  // search.messages：只认 <@用户编号> 和 after:YYYY-MM-DD。挨得近的匹配只回一条（真的 Slack 的文档这样写）。
  private searchMessages(args: Record<string, unknown>): Record<string, unknown> {
    const query = String(args.query ?? "");
    const mention = /<@([A-Z0-9]+)>/.exec(query)?.[1] ?? null;
    const after = /after:(\d{4}-\d{2}-\d{2})/.exec(query)?.[1] ?? null;
    const day = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
    const hits = this.live()
      .filter((message) => (!mention || message.text.includes(`<@${mention}>`)) && (!after || day(message.ts) > after))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const shown: FakeSlackMessage[] = [];
    for (const message of hits) {
      const near = shown.find((other) => other.channel === message.channel && other.thread_ts === message.thread_ts
        && Math.abs(Number(other.ts) - Number(message.ts)) < 300);
      if (!near) shown.push(message);
    }
    if (args.sort === "timestamp" && args.sort_dir !== "asc") shown.reverse();
    const count = Math.min(Math.max(Number(args.count) || 20, 1), 100);
    const page = Math.max(Number(args.page) || 1, 1);
    const pages = Math.max(Math.ceil(shown.length / count), 1);
    const matches = shown.slice((page - 1) * count, page * count).map((message) => {
      const direct = message.channel.startsWith("D");
      const link = `${FAKE_SLACK_WORKSPACE_URL}archives/${message.channel}/p${message.ts.replace(".", "")}`;
      return {
        type: direct ? "im" : "message", iid: `${message.channel}-${message.ts}`, ts: message.ts, user: message.user, text: message.text,
        team: message.team ?? this.teamId, username: this.users.get(message.user)?.name ?? message.user,
        channel: { id: message.channel, name: direct ? message.user : this.channelNames.get(message.channel) ?? message.channel, is_mpim: false, is_private: false },
        permalink: message.thread_ts ? `${link}?thread_ts=${message.thread_ts}&cid=${message.channel}` : link,
      };
    });
    return { ok: true, query, messages: { matches, total: shown.length, paging: { count, total: shown.length, page, pages } } };
  }

  // client.counts：每个有消息的私信和频道，最新一条的 ts 和提到用户的条数（这里不记已读，提到的都算没读）。
  private clientCounts(): Record<string, unknown> {
    const latest = new Map<string, { latest: string; mentions: number }>();
    for (const message of this.live()) {
      const entry = latest.get(message.channel) ?? { latest: message.ts, mentions: 0 };
      if (Number(message.ts) > Number(entry.latest)) entry.latest = message.ts;
      if (message.text.includes(`<@${this.self.id}>`)) entry.mentions += 1;
      latest.set(message.channel, entry);
    }
    const row = ([id, entry]: [string, { latest: string; mentions: number }]) => ({
      id, latest: entry.latest, mention_count: entry.mentions, has_unreads: true,
    });
    const all = [...latest];
    return {
      ok: true,
      ims: all.filter(([id]) => id.startsWith("D")).map(row),
      mpims: [],
      channels: all.filter(([id]) => !id.startsWith("D")).map(row),
    };
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
      ...(message.bot_id ? { bot_id: message.bot_id } : {}),
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
      ...(message.files ? { files: message.files.map((file) => this.wireFile(file)) } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
    };
  }

  /** Slack Web API 的 HTTP 替身（给真实的 WebClient）。 */
  readonly fetch: SlackFetch = (async (url: string | URL, init?: { headers?: unknown; body?: unknown }) => {
    const method = String(url).replace(/^.*\/api\//, "");
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const authorization = headers.get("authorization") ?? "";
    if (String(url).startsWith("https://files.slack.com/")) {
      this.downloads.push(String(url));
      const file = [...this.files.values()].find((candidate) => candidate.url === String(url));
      if (!file) return new Response("not found", { status: 404 });
      // 和真的 Slack 一样：令牌不对（或者缺 files:read）时回 200 和登录网页，不是文件。
      if (authorization !== `Bearer ${this.credential.token}`) {
        return new Response("<!DOCTYPE html><title>Slack</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(Buffer.from(file.data), {
        status: 200, headers: { "content-type": file.mimetype, "content-length": String(file.data.byteLength) },
      });
    }
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

  /** 下一次 chat.postMessage 失败，报错的文字里带着会话 cookie 和会话令牌（浏览器会话方式下的不小心的客户端库）。 */
  failNextPostEchoingSession(): void {
    this.failures.set("chat.postMessage", `401 for cookie d=${FAKE_SLACK_SESSION_COOKIE} (token ${FAKE_SLACK_SESSION_TOKEN})`);
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

  // ── 浏览器会话（网页版协议）──────────────────────────────────────────────────────

  private sessionCookieOk(cookieHeader: string | null): boolean {
    return this.sessionLive && cookieHeader === `d=${this.sessionCookie}`;
  }

  /** 网页版的 HTTP 替身：换令牌和工作区 Web API。 */
  readonly sessionFetch = (async (url: string | URL, init?: { headers?: unknown; body?: unknown; method?: string }) => {
    const target = new URL(String(url));
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const cookieOk = this.sessionCookieOk(headers.get("cookie"));
    if (target.origin === "https://app.slack.com" && target.pathname === "/auth") {
      if (!cookieOk) return new Response("", { status: 302, headers: { location: "https://slack.com/signin" } });
      this.sessionSignIns += 1;
      return Response.json({
        teams: {
          [this.teamId]: {
            id: this.teamId, name: "Home", domain: "home", url: FAKE_SLACK_WORKSPACE_URL, user_id: this.self.id, token: FAKE_SLACK_SESSION_TOKEN,
          },
        },
      });
    }
    if (`${target.origin}/` === FAKE_SLACK_WORKSPACE_URL && target.pathname.startsWith("/api/")) {
      const method = target.pathname.slice("/api/".length);
      const fields: Record<string, unknown> = {};
      const body = init?.body;
      const entries: Iterable<[string, unknown]> = body instanceof FormData ? body.entries()
        : body instanceof URLSearchParams ? body.entries() : new URLSearchParams(typeof body === "string" ? body : "").entries();
      for (const [key, value] of entries) {
        const text = String(value);
        fields[key] = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
      }
      const { token, ...args } = fields;
      for (const key of Object.keys(args)) if (key.startsWith("_x_")) delete args[key];
      if (!cookieOk || token !== FAKE_SLACK_SESSION_TOKEN) return Response.json({ ok: false, error: "invalid_auth" });
      this.sessionCalls.push(method);
      const result = await this.handle(method, args, this.credential.token, "session");
      const { response_metadata: _scopes, ...rest } = result;
      return Response.json(rest);
    }
    if (target.origin === "https://files.slack.com") {
      this.downloads.push(target.toString());
      const file = [...this.files.values()].find((candidate) => candidate.url === target.toString());
      if (!file) return new Response("not found", { status: 404 });
      if (!cookieOk || headers.get("authorization") !== `Bearer ${FAKE_SLACK_SESSION_TOKEN}`) {
        return new Response("<!DOCTYPE html><title>Slack</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(Buffer.from(file.data), {
        status: 200, headers: { "content-type": file.mimetype, "content-length": String(file.data.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  /** 网页版 WebSocket 的替身（gabriel-slack 的 createWebSocket）。令牌或 cookie 不对时握手被拒（401）。 */
  readonly createSessionSocket = (url: string, headers: Record<string, string>): FakeSessionSocket => {
    const socket = new FakeSessionSocket(this, url, headers);
    this.sessionSockets.push(socket);
    const token = new URL(url).searchParams.get("token");
    const ok = this.sessionCookieOk(headers.Cookie ?? null) && token === FAKE_SLACK_SESSION_TOKEN;
    setTimeout(() => {
      if (socket.readyState === 3) return;
      if (!ok) {
        socket.emit("unexpected-response", {}, { statusCode: 401, headers: {} });
        return;
      }
      socket.open();
    }, 0);
    return socket;
  };

  /** 现在连着的网页版 WebSocket。 */
  sessionSocket(): FakeSessionSocket | undefined {
    return this.sessionSockets.filter((socket) => socket.readyState === 1).at(-1);
  }

  /** 把一次投递里的消息当成网页版的消息帧发给连着的客户端：没有 channel_type，没有外层的 envelope。 */
  sessionPush(delivery: ChannelDelivery): void {
    const socket = this.sessionSocket();
    if (!socket) throw new Error("no session socket is connected");
    const { channel_type: _type, ...event } = (JSON.parse(delivery.body) as { event: Record<string, unknown> }).event;
    socket.frame(event);
  }

  /** Slack 给客户端一个快速重连的地址。 */
  sessionReconnectUrl(url: string): void {
    this.sessionSocket()?.frame({ type: "reconnect_url", url });
  }

  /** 网页版的连接断了。 */
  dropSession(): void {
    this.sessionSocket()?.close(1006);
  }

  /** 会话结束了（例如 SSO 过期、用户在 Slack 里登出了所有设备）：cookie 换不出令牌，令牌也不认了。 */
  endSession(): void {
    this.sessionLive = false;
    const socket = this.sessionSocket();
    if (socket) socket.frame({ type: "error", error: { msg: "invalid_auth", code: 1 } });
  }

  // ── 投递（Events API）──────────────────────────────────────────────────────────────

  /** 别人发给用户的私信。channel 缺省是这个人和用户的私信频道（D0<用户>）。bot：发信人是一个应用（消息带 bot_id）。 */
  // bot：应用发的（带 bot_id）。attachments、blocks：应用常把正文放在这里，text 是空的（例如日历提醒）。
  dm(
    from: string, text: string,
    options: {
      channel?: string; thread?: string; bot?: boolean; attachments?: unknown[]; blocks?: unknown[]; files?: FakeSlackFile[]; subtype?: string;
    } = {},
  ): ChannelDelivery {
    const channel = options.channel ?? `D0${from.slice(2)}`;
    return this.post({
      channel, channel_type: "im", user: from, text, ...(options.thread ? { thread_ts: options.thread } : {}),
      ...(options.bot ? { bot_id: `B0${from.slice(2)}` } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      ...(options.blocks ? { blocks: options.blocks } : {}),
      ...(options.files ? { files: options.files.map((file) => this.wireFile(file)) } : {}),
      ...(options.subtype ? { subtype: options.subtype } : {}),
    }, options.files);
  }

  /** 别人在群聊（多人私信，channel_type mpim）里发的消息。channel 缺省是 G0<发信人>，这个频道以后都按群聊算。 */
  groupDm(from: string, text: string, options: { channel?: string; thread?: string } = {}): ChannelDelivery {
    const channel = options.channel ?? `G0${from.slice(2)}`;
    this.groupChannels.add(channel);
    return this.post({
      channel, channel_type: "mpim", user: from, text, ...(options.thread ? { thread_ts: options.thread } : {}),
    });
  }

  /** 别人在频道里提到用户。attachments：消息带的卡片，例如转发的消息。 */
  mention(from: string, text: string, options: { channel?: string; thread?: string; attachments?: unknown[] } = {}): ChannelDelivery {
    return this.post({
      channel: options.channel ?? "C0PROJ", channel_type: "channel", user: from, text: `<@${this.self.id}> ${text}`,
      ...(options.thread ? { thread_ts: options.thread } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
    });
  }

  /** 频道里没有提到用户的消息（thread：发在这个线程里；bot：发信人是一个应用；blocks：消息的 block，例如 rich_text）。 */
  chatter(from: string, text: string, channel = "C0PROJ", options: { thread?: string; bot?: boolean; blocks?: unknown[] } = {}): ChannelDelivery {
    return this.post({
      channel, channel_type: "channel", user: from, text, ...(options.thread ? { thread_ts: options.thread } : {}),
      ...(options.bot ? { bot_id: `B0${from.slice(2)}` } : {}),
      ...(options.blocks ? { blocks: options.blocks } : {}),
    });
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
      // 分享文件的消息（files.completeUploadExternal 带 channel_id）推回来时是 file_share。
      ...(message.files?.length ? { subtype: "file_share", files: message.files.map((file) => this.wireFile(file)) } : {}),
    });
  }

  /** 这次投递里的那条消息（频道和 ts）。 */
  messageOf(delivery: ChannelDelivery): FakeSlackMessage {
    const event = (JSON.parse(delivery.body) as { event: { channel: string; ts: string } }).event;
    const message = this.messages.find((candidate) => candidate.channel === event.channel && candidate.ts === event.ts);
    if (!message) throw new Error(`no message ${event.channel}:${event.ts}`);
    return message;
  }

  /** 发信人改了这条消息（message_changed）。blocks：改后的 block（应用常只改 block，text 照旧是空的）。 */
  edit(delivery: ChannelDelivery, text: string, options: { blocks?: Array<Record<string, unknown>> } = {}): ChannelDelivery {
    const message = this.messageOf(delivery);
    const previous = this.wire(message);
    message.text = text;
    if (options.blocks) message.blocks = options.blocks;
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

  // groupDm 发过消息的频道：改消息、删消息的 channel_type 也是 mpim。
  private readonly groupChannels = new Set<string>();

  private channelType(channel: string): string {
    return channel.startsWith("D") ? "im" : this.groupChannels.has(channel) ? "mpim" : "channel";
  }

  private post(event: Record<string, unknown>, files?: FakeSlackFile[]): ChannelDelivery {
    const ts = this.ts();
    const user = this.users.get(String(event.user));
    const team = user?.team ?? this.teamId;
    const message: FakeSlackMessage = {
      channel: String(event.channel), ts, user: String(event.user), team, text: String(event.text), deleted: false,
      ...(typeof event.thread_ts === "string" ? { thread_ts: event.thread_ts } : {}),
      ...(files ? { files } : {}),
      ...(Array.isArray(event.attachments) ? { attachments: event.attachments } : {}),
      ...(typeof event.bot_id === "string" ? { bot_id: event.bot_id } : {}),
      ...(Array.isArray(event.blocks) ? { blocks: event.blocks as Array<Record<string, unknown>> } : {}),
    };
    this.messages.push(message);
    return this.envelope({ type: "message", ...event, ts, user_team: team });
  }

  /** 同一次投递，但装了这个应用、能看到它的是这些人（第一个写进 authorizations）。例如张三也装了用户的应用。 */
  seenBy(delivery: ChannelDelivery, users: readonly string[]): ChannelDelivery {
    if (!users.length) throw new Error("seenBy needs at least one user");
    const envelope = JSON.parse(delivery.body) as Record<string, unknown>;
    const context = this.eventContext();
    this.visibility.set(context, [...users]);
    return this.sign(JSON.stringify({ ...envelope, authorizations: [this.authorization(users[0]!)], event_context: context }), {});
  }

  private authorization(user: string): Record<string, unknown> {
    return { enterprise_id: null, team_id: this.teamId, user_id: user, is_bot: false, is_enterprise_install: false };
  }

  private eventContext(): string {
    return `4-fake-${this.nextEvent}-${this.visibility.size + 1}`;
  }

  // apps.event.authorizations.list：只认 App-Level Token（放在 Authorization 头里），要 authorizations:read；按 limit 分页。
  private eventAuthorizations(args: Record<string, unknown>, token: string): Record<string, unknown> {
    if (token !== this.appToken) return { ok: false, error: token === this.credential.token ? "not_allowed_token_type" : "invalid_auth" };
    if (!this.appScopes.includes("authorizations:read")) return { ok: false, error: "missing_scope", needed: "authorizations:read" };
    const users = typeof args.event_context === "string" ? this.visibility.get(args.event_context) : undefined;
    if (!users) return { ok: false, error: "invalid_event_context" };
    const limit = Math.max(Number(args.limit) || 100, 1);
    const start = typeof args.cursor === "string" && args.cursor ? Number(args.cursor) : 0;
    if (!Number.isInteger(start) || start < 0 || start > users.length) return { ok: false, error: "invalid_cursor" };
    const next = start + limit < users.length ? String(start + limit) : "";
    return {
      ok: true, authorizations: users.slice(start, start + limit).map((user) => this.authorization(user)),
      response_metadata: { next_cursor: next },
    };
  }

  private envelope(event: Record<string, unknown>): ChannelDelivery {
    const context = this.eventContext();
    this.visibility.set(context, [this.self.id]);
    const body = JSON.stringify({
      type: "event_callback", team_id: this.teamId, event_id: `Ev${String(this.nextEvent++).padStart(6, "0")}`,
      event_time: Math.floor(this.now().getTime() / 1000), authorizations: [this.authorization(this.self.id)], event_context: context, event,
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

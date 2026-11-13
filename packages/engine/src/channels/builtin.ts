// 内置的来源插件（工单 11）。这里是通道的装配处：内核里只有这里和 sources/ 下的插件写着具体来源的名字
// （apps/daemon/test/channel-architecture.test.ts 检查）。新增一个来源：在 sources/ 下写插件，在这里登记，
// 再在 engine/testing/channels 里给它一个假服务，加进共享合约测试的 FAKES。
import type { PlcChannelsConfig } from "@pi-lead-child/core";
import {
  createSlackChannelAdapter, SLACK_SECRET_NAMES, SLACK_SOURCE, slackSecretNames, type SlackChannelOptions, type SlackConnection,
} from "./sources/slack.js";
import type { SlackSessionNetwork } from "./sources/slack-session.js";
import type { SlackSignInOptions } from "./sources/slack-session-login.js";
import type { SlackSessionTransportOptions } from "./sources/slack-session-transport.js";
import type { SlackSocketOptions } from "./sources/slack-socket.js";
import { createSlackWebApi, type SlackFetch } from "./sources/slack-web-api.js";
import type { ChannelAdapter } from "./types.js";

export {
  compareSlackTs, createSlackChannelAdapter, SLACK_EVENT_KINDS, SLACK_MESSAGE_BLOCKS_MAX, SLACK_REPLY_METADATA_TYPE, SLACK_SECRET_NAMES,
  SLACK_ASSISTANT_EMOJI_DEFAULT, SLACK_EMOJI_SCOPE_MISSING, SLACK_SOURCE, SLACK_TEXT_OBJECT_MAX, slackDisclosureBlocks, slackEmojiCode,
  slackCatchUpWindow, slackMemoryExclusion, slackMrkdwnFromMarkdown, slackTsOf,
  slackAttachmentsOnly, slackDisplayText, slackMarkupIds, slackMessageText, SLACK_SESSION_SECRET_NAMES, slackSecretNames,
} from "./sources/slack.js";
export type { SlackChannelOptions, SlackConnection, SlackMemoryExclusion, SlackWebApi } from "./sources/slack.js";
export type { SlackSessionNetwork } from "./sources/slack-session.js";
export { SLACK_SESSION_ENDED } from "./sources/slack-session-transport.js";
export { SLACK_SIGN_IN_URL, signInToSlack } from "./sources/slack-session-login.js";
export type { SlackSignInBrowser, SlackSignInOptions, SlackSignInWindow } from "./sources/slack-session-login.js";
export type { SlackSessionTransportOptions } from "./sources/slack-session-transport.js";
export { createSlackWebApi, scrubSlackText, slackSdkLogger } from "./sources/slack-web-api.js";
export {
  createSlackSettings, SLACK_OPTIONAL_USER_SCOPES, SLACK_SETUP_URL, SLACK_USER_EVENTS, SLACK_USER_SCOPES, slackAppManifest, slackSetupUrl,
} from "./sources/slack-settings.js";
export type { SlackFetch, SlackWebApiOptions } from "./sources/slack-web-api.js";
export { createSlackSocketTransport } from "./sources/slack-socket.js";
export type {
  SlackSocketClient, SlackSocketClientFactory, SlackSocketEvent, SlackSocketOptions, SlackSocketTransportInput,
} from "./sources/slack-socket.js";

/** 内置来源的配置。没给配置的来源不接。 */
export interface BuiltinChannelOptions {
  slack?: SlackChannelOptions;
}

/** 内置的来源，按名字。 */
export const BUILTIN_CHANNEL_SOURCES = ["slack"] as const;

/** 内置来源要的 daemon 专用密钥（都有时生产入口才接这个来源）。Slack 是缺省的连接方式（Slack 应用）要的，浏览器会话见 slackSecretNames。 */
export const BUILTIN_CHANNEL_SECRETS: Readonly<Record<(typeof BUILTIN_CHANNEL_SOURCES)[number], readonly string[]>> = {
  slack: SLACK_SECRET_NAMES,
};

/** 配置里的 Slack 连接方式（channels.slack.connection，用户写的，不信任它的形状）。不认识的值按缺省的 "app"。 */
export function slackConnectionOf(config?: PlcChannelsConfig): SlackConnection {
  return config?.slack?.connection === "session" ? "session" : "app";
}

// 设置页存的 Slack 连接方式。没存过或者不认识时是 null（按配置）。
function storedSlackConnection(mode: string | null): SlackConnection | null {
  return mode === "app" || mode === "session" ? mode : null;
}

/**
 * 按配置建内置来源的适配器。config 是 config.json 的 channels 段（用户写的，不信任它的形状）：来源的选项里没有给的，
 * 用它补上（Slack 的记忆沉淀排除名单 channels.slack.memory.exclude，建应用的清单里的主人名 channels.ownerName 和
 * 应用名 channels.assistantName，署名里的 emoji channels.slack.assistantEmoji）。
 */
// defaults.assistantName：配置里没有助手名时用的名字（daemon 给 Lead 的名字，设置 → 身份与风格；用户 2026-10-22）。
// defaults.assistantEmoji：署名 emoji 的生效值（daemon 给的：设置 → 身份与风格 → 形象的值 > 配置 > 缺省，2026-10-28），
// 每发一条消息问一次。它已经算进了配置，所以给了它时不再用配置的 channels.slack.assistantEmoji。
// defaults.connectionSettings：设置页存的连接方式和「代你往来源里写」开关（daemon 读 store 的 channel-connections.ts，2026-11-02）。
// 连接方式：设置页选的 > 配置的 channels.slack.connection > 缺省的 Slack 应用。每次用时现读：换了方式以后 daemon 重连这个来源。
export function builtinChannelAdapters(
  options: BuiltinChannelOptions, config?: PlcChannelsConfig,
  defaults: {
    assistantName?: () => string | null; assistantEmoji?: () => string | null | undefined;
    connectionSettings?: (source: string) => { mode: string | null; writes: boolean };
  } = {},
): ChannelAdapter[] {
  const exclude = config?.slack?.memory?.exclude;
  const ownerName = typeof config?.ownerName === "string" ? config.ownerName : undefined;
  const assistantName = typeof config?.assistantName === "string" ? config.assistantName : undefined;
  const assistantEmoji = typeof config?.slack?.assistantEmoji === "string" ? config.slack.assistantEmoji : undefined;
  let slack = options.slack && !options.slack.memory && Array.isArray(exclude)
    ? { ...options.slack, memory: { exclude: exclude.filter((entry): entry is string => typeof entry === "string") } }
    : options.slack;
  if (slack && slack.ownerName === undefined && ownerName !== undefined) slack = { ...slack, ownerName };
  if (slack && slack.assistantName === undefined && assistantName !== undefined) slack = { ...slack, assistantName };
  if (slack && slack.assistantName === undefined && defaults.assistantName) slack = { ...slack, assistantName: defaults.assistantName };
  if (slack && slack.assistantEmoji === undefined && defaults.assistantEmoji) slack = { ...slack, assistantEmoji: defaults.assistantEmoji };
  if (slack && slack.assistantEmoji === undefined && assistantEmoji !== undefined) slack = { ...slack, assistantEmoji };
  const stored = defaults.connectionSettings;
  if (slack && slack.connection === undefined) {
    const configured = slackConnectionOf(config);
    slack = { ...slack, connection: stored ? () => storedSlackConnection(stored(SLACK_SOURCE).mode) ?? configured : configured };
  }
  if (slack && slack.sessionWrites === undefined && stored) slack = { ...slack, sessionWrites: () => stored(SLACK_SOURCE).writes };
  return [...(slack ? [createSlackChannelAdapter(slack)] : [])];
}

/** 生产入口接真实来源时的选项。测试注入假的 fetch 和假的 Socket 客户端。 */
export interface LiveChannelOptions {
  // Web API（和 Socket Mode 开连接）用的 fetch。缺省是全局的 fetch。
  fetch?: SlackFetch;
  // Socket Mode 的客户端和重连的间隔。
  socket?: Omit<SlackSocketOptions, "fetch">;
  // config.json 的 channels 段和设置页存的连接方式（见 builtinChannelAdapters）：决定来源现在的连接方式，也就决定缺哪些密钥。
  // 这里只用来算 missing（日志）；适配器的连接方式由 builtinChannelAdapters 接上，每次用时现读。
  config?: PlcChannelsConfig;
  connectionSettings?: (source: string) => { mode: string | null; writes: boolean };
  // 浏览器会话方式的网络（测试注入假的 Slack）、重连的间隔和登录窗口。
  session?: SlackSessionTransportOptions & { network?: SlackSessionNetwork; signIn?: Omit<SlackSignInOptions, "network"> };
  // SDK 的 warn、error 日志（已经去掉令牌）。
  log?: (line: string) => void;
}

export interface LiveChannelSources {
  sources: BuiltinChannelOptions;
  // 缺密钥的来源，和缺的名字（只有名字，没有值）。它们照样接上（见下面），只是传输要等用户在设置页存了密钥才启动。
  missing: Array<{ source: string; names: string[] }>;
}

/**
 * 生产入口：内置来源都用真实的传输和 Web API 接上。它们都声明了凭据设置（settings），所以缺密钥的也接上：
 * daemon 在密钥齐了以前不启动它的传输，用户在设置页存了密钥以后马上连上，不用重启（slack-settings 工单 S1）。
 * missing 列出缺的名字。这里只看有没有，不留密钥的值：值由 daemon 取凭据时再读。
 */
export function liveBuiltinChannels(secret: (name: string) => string | null, options: LiveChannelOptions = {}): LiveChannelSources {
  const sources: BuiltinChannelOptions = {};
  const missing: LiveChannelSources["missing"] = [];
  const connection = storedSlackConnection(options.connectionSettings?.(SLACK_SOURCE).mode ?? null) ?? slackConnectionOf(options.config);
  const slackMissing = slackSecretNames(connection).filter((name) => !secret(name));
  if (slackMissing.length) missing.push({ source: SLACK_SOURCE, names: slackMissing });
  const log = options.log;
  sources.slack = {
    api: createSlackWebApi({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(log ? { log } : {}) }),
    socket: { ...options.socket, ...(options.fetch ? { fetch: options.fetch } : {}) },
    session: { ...options.session },
  };
  return { sources, missing };
}

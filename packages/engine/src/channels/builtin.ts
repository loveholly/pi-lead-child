// 内置的来源插件（工单 11）。这里是通道的装配处：内核里只有这里和 sources/ 下的插件写着具体来源的名字
// （apps/daemon/test/channel-architecture.test.ts 检查）。新增一个来源：在 sources/ 下写插件，在这里登记，
// 再在 engine/testing/channels 里给它一个假服务，加进共享合约测试的 FAKES。
import type { PlcChannelsConfig } from "@pi-lead-child/core";
import { createSlackChannelAdapter, SLACK_SECRET_NAMES, SLACK_SOURCE, type SlackChannelOptions } from "./sources/slack.js";
import type { SlackSocketOptions } from "./sources/slack-socket.js";
import { createSlackWebApi, type SlackFetch } from "./sources/slack-web-api.js";
import type { ChannelAdapter } from "./types.js";

export {
  compareSlackTs, createSlackChannelAdapter, SLACK_EVENT_KINDS, SLACK_MESSAGE_BLOCKS_MAX, SLACK_REPLY_METADATA_TYPE, SLACK_SECRET_NAMES,
  SLACK_ASSISTANT_EMOJI_DEFAULT, SLACK_EMOJI_SCOPE_MISSING, SLACK_SOURCE, SLACK_TEXT_OBJECT_MAX, slackDisclosureBlocks, slackEmojiCode,
  slackMemoryExclusion, slackMrkdwnFromMarkdown,
  slackDisplayText, slackMarkupIds, slackMessageText,
} from "./sources/slack.js";
export type { SlackChannelOptions, SlackMemoryExclusion, SlackWebApi } from "./sources/slack.js";
export { createSlackWebApi, scrubSlackText, slackSdkLogger } from "./sources/slack-web-api.js";
export {
  createSlackSettings, SLACK_OPTIONAL_USER_SCOPES, SLACK_SETUP_URL, SLACK_USER_EVENTS, SLACK_USER_SCOPES, slackAppManifest,
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

/** 内置来源要的 daemon 专用密钥（都有时生产入口才接这个来源）。 */
export const BUILTIN_CHANNEL_SECRETS: Readonly<Record<(typeof BUILTIN_CHANNEL_SOURCES)[number], readonly string[]>> = {
  slack: SLACK_SECRET_NAMES,
};

/**
 * 按配置建内置来源的适配器。config 是 config.json 的 channels 段（用户写的，不信任它的形状）：来源的选项里没有给的，
 * 用它补上（Slack 的记忆沉淀排除名单 channels.slack.memory.exclude，建应用的清单里的主人名 channels.ownerName 和
 * 应用名 channels.assistantName，署名里的 emoji channels.slack.assistantEmoji）。
 */
// defaults.assistantName：配置里没有助手名时用的名字（daemon 给 Lead 的名字，设置 → 身份与风格；用户 2026-10-22）。
// defaults.assistantEmoji：署名 emoji 的生效值（daemon 给的：设置 → 身份与风格 → 形象的值 > 配置 > 缺省，2026-10-28），
// 每发一条消息问一次。它已经算进了配置，所以给了它时不再用配置的 channels.slack.assistantEmoji。
export function builtinChannelAdapters(
  options: BuiltinChannelOptions, config?: PlcChannelsConfig,
  defaults: { assistantName?: () => string | null; assistantEmoji?: () => string | null | undefined } = {},
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
  return [...(slack ? [createSlackChannelAdapter(slack)] : [])];
}

/** 生产入口接真实来源时的选项。测试注入假的 fetch 和假的 Socket 客户端。 */
export interface LiveChannelOptions {
  // Web API（和 Socket Mode 开连接）用的 fetch。缺省是全局的 fetch。
  fetch?: SlackFetch;
  // Socket Mode 的客户端和重连的间隔。
  socket?: Omit<SlackSocketOptions, "fetch">;
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
  const slackMissing = BUILTIN_CHANNEL_SECRETS.slack.filter((name) => !secret(name));
  if (slackMissing.length) missing.push({ source: SLACK_SOURCE, names: slackMissing });
  const log = options.log;
  sources.slack = {
    api: createSlackWebApi({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(log ? { log } : {}) }),
    socket: { ...options.socket, ...(options.fetch ? { fetch: options.fetch } : {}) },
  };
  return { sources, missing };
}

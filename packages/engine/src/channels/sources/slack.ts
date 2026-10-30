// Slack 来源插件（工单 11，spec D14：Slack 是通道框架的第一个实例；slack-takeover 工单 02 接上真实的 Slack）。
// 内核不认识 Slack，Slack 的知识都在这里。外部通道共用的入站层（channels/inbound.ts，统一消息事件 spec D2）对 Slack 和
// 以后的通道一样（身份和去重、合并编辑、Jev 判定、外部标记、权限上限、不通过的只记录）；下面是 Slack 自己的扩展：
// thread 的根消息（replyTo、history）、订阅哪些频道（subscribed、followable）、回表情（capabilities.react）、消息格式（slackDisplayText）。
//   - 入站：Slack Events API 的 event_callback（私信 message.im、群聊 message.mpim、频道消息 message.channels）。
//     同一份 payload 有两条路进来：Socket Mode 的连接（slack-socket.ts，生产用这条，经 hub 的进程内入口，不验签名），
//     和推来的 HTTP 请求（verify 按签名校验；没有公网端点，现在只有测试走这条）。认出这些事：
//       别人发给用户的私信（slack.dm.received）、别人在频道里提到用户（slack.mention.received）、
//       用户本人的回复（slack.self.reply，触发「别处已处理」）、
//       用户的线程（已经有道）里没有提到用户的后续消息（slack.thread.message）、
//       别人改了、删了道里的一条消息（slack.message.edited、slack.message.deleted：对已有的道，只更新没结束的卡；
//       订阅频道里没有道的线程也收，只记录，给记忆沉淀用）、
//       订阅频道里的普通消息（slack.channel.message：只记录。这个频道 14 天内有过道就算订阅，hub 用 channel_lanes 回答；
//       配置 channels.slack.memory.exclude 里的频道不订阅）。
//     系统替用户发出去的回复被推回来时，带着我们写的 metadata，认成 echo，不算用户自己回复。和用户无关的频道消息不返回。
//   - 鉴权：Socket Mode 用两个 daemon 专用的密钥（auth.secrets）：app-level token（xapp-）开连接，用户令牌（xoxp-）调 Web API。
//     resolveCredential 用 auth.test 认出用户本人（编号和工作区），users.info 取用户的名字（accountName）。
//     推来的 HTTP 请求按 Slack 的签名规则校验（x-slack-signature = v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<body>")，
//     时间戳 5 分钟以内）。
//   - 身份：消息的投递编号是 <频道>:<ts>（改消息、删消息另加后缀）。Slack 重发时 ts 不变；重连以后补拉到的消息也是同一个编号，
//     所以同一条消息只记一次。
//   - 对象键：slack:<频道>:<线程>。私信里不在线程中的消息是 slack:<频道>:main（整段私信是一个对话）。
//   - 事实字段：频道、频道类型、频道名（channelName，问不到时 null）、ts、线程、echo、externalShared（conversations.info 的
//     is_ext_shared / is_shared，带缓存；问不到时是 null，用的人要按外部共享对待）。
//   - 记忆沉淀（slack-takeover 工单 07，spec D12；内核的 channels/memory.ts）：频道和私有频道（channel_type 是 channel、group）
//     里的线程整理成事实笔记，一个线程一条；私信（im、mpim）不沉淀，内容只留在卡和道里；排除名单里的频道不沉淀。
//   - 出站：chat.postMessage（带 metadata，幂等键写在里面）、chat.delete（撤回）、chat.update（改写，例如用最后的回复覆盖
//     「正在处理」的状态消息）、reactions.add（回表情，要 reactions:write）。发之前先在对话里找有没有同一个幂等键的消息：
//     进程在「发出去」和「记下来」之间崩溃时，重试不会多发一条。
//   - thread 里的回复带 replyTo（被回复的是 thread 的根消息）；每条消息带 messageRef（频道和 ts）。取历史（history）用
//     conversations.replies（thread）和 conversations.history（整段对话），只当上下文用。
//   - 重连以后补拉：对还有没结束的卡的道，从这条道记下的最后一个 ts 往后，用 conversations.replies / conversations.history 补，
//     有数量上限，靠投递编号去重。
//   - 默认常设指令：打断阈值很高（只有你信任的人发来的私信、并且系统判断你需要马上看到时才推送）；私信和同事的提及进会话卡；
//     外部的提及进摘要；订阅频道的消息、改和删只记录。模板代回、代查和按信心代回（channel.slack.delegate、.lookup、.reply）
//     已经退役（落地计划 A5、D1），停用不删；能替你做什么由授权表（channel.authority）决定。
//   - 紧急程度不在这里判断（用户 2026-10-19：理解自然语言不用正则）。这里只交出事实（发信人、信任、频道类型、文字、
//     是不是机器人），由通道内核问 SmartModel，结果写进事件的 urgent（channels/urgency.ts）。
//   - 凭据设置（设置页「Slack 通道」，slack-settings 工单 S1）：两个令牌、建应用的清单、检查一组令牌（slack-settings.ts）。
// Web API 的真实实现在 slack-web-api.ts，Socket Mode 的传输在 slack-socket.ts，都用 Slack 官方的 SDK。测试用假的 Slack。
import { createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import { SLACK_APP_TOKEN_ENV, SLACK_USER_TOKEN_ENV } from "@pi-lead-child/core";
import { normalizeSlackEmojiCode, SLACK_BYLINE_EMOJI_DEFAULT, type SenderTrust } from "@pi-lead-child/protocol";
import type { SystemStandingOrderSeed } from "@pi-lead-child/store";
import { channelInboundPayload } from "../payload.js";
import { ChannelTargetGoneError } from "../types.js";
import type {
  ChannelAdapter, ChannelAdapterContext, ChannelConversationCandidate, ChannelConversationTarget, ChannelCredential, ChannelDelivery,
  ChannelHistoryMessage, ChannelHistoryRequest, ChannelInbound, ChannelMarkLookup, ChannelMemorySpec, ChannelOutboundRequest, ChannelOutboundResult,
  ChannelTransportContext, ChannelTransportDeliver,
} from "../types.js";
import { createSlackSettings } from "./slack-settings.js";
import { createSlackSocketTransport, type SlackSocketOptions } from "./slack-socket.js";
import { scrubSlackText, type SlackWebApi } from "./slack-web-api.js";

export type { SlackWebApi } from "./slack-web-api.js";

export const SLACK_SOURCE = "slack";
// 系统替用户发出去的消息带的 metadata.event_type。Slack 把消息推回来时据此认出它。
export const SLACK_REPLY_METADATA_TYPE = "plc_reply";

/**
 * 署名里助手名前面的 emoji 的缺省值（用户 2026-10-21 传到工作区里的自定义 emoji，名字里是连字符）：protocol 的
 * SLACK_BYLINE_EMOJI_DEFAULT。工作区里没有这个名字的 emoji 时，Slack 原样显示短代码（第一次部署写成了 :fairy_zz:，就是这样）。
 */
export const SLACK_ASSISTANT_EMOJI_DEFAULT = SLACK_BYLINE_EMOJI_DEFAULT;

/**
 * Slack 的 emoji 短代码：冒号包着小写字母、数字、-、_、+、'（https://slack.com/help/articles/206870177）。写法和 protocol 的
 * normalizeSlackEmojiCode 一样，但这里不补冒号：配置是用户写的，不合这个写法时不加（返回 null），免得把别的字放进对外的署名。
 * 设置页的值已经整理过（带冒号），照样通过。
 */
export function slackEmojiCode(value: string | null | undefined): string | null {
  const code = value?.trim() ?? "";
  if (code.length < 3 || !code.startsWith(":") || !code.endsWith(":")) return null;
  return normalizeSlackEmojiCode(code) || null;
}

// 认推回来的消息用的：记住最近发出去的多少条；推回来比回答快时最多等多久。
const POSTED_MAX = 500;
const POSTING_WAIT_MS = 10_000;

// Block Kit 的上限（https://docs.slack.dev/reference/block-kit/blocks/section-block、context-block）：
// section 和 context 里的一个文字对象最多 3000 个字，一条消息最多 50 个 block。
export const SLACK_TEXT_OBJECT_MAX = 3_000;
export const SLACK_MESSAGE_BLOCKS_MAX = 50;

// mrkdwn 里 &、<、> 要转义（https://docs.slack.dev/messaging/formatting-message-text）：署名是我们写的话，
// 里面的名字不能被 Slack 当成提到谁、链接或者 @channel。
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 正文按行切成不超过 max 个字的几段；一行本身太长时按字切（不切开一个字符）。
function slackChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max) {
      current = next;
      continue;
    }
    flush();
    if (line.length <= max) {
      current = line;
      continue;
    }
    let piece = "";
    for (const char of line) {
      if (piece.length + char.length > max) {
        chunks.push(piece);
        piece = "";
      }
      piece += char;
    }
    current = piece;
  }
  flush();
  return chunks;
}

/**
 * 带署名的消息的 Block Kit（spec D8；用户 2026-10-21：署名像 Slack 的小号灰字）：署名放在 context block 里，
 * 正文按 3000 个字一段放在 section 里，照旧当 mrkdwn（和只发 text 时一样）。text 照样发，是通知和不显示 block 的客户端的退路。
 */
export function slackDisclosureBlocks(parts: { byline: string; body: string | null }): Array<Record<string, unknown>> {
  const byline = escapeMrkdwn(parts.byline.replace(/\s+/g, " ").trim().slice(0, 300));
  const blocks: Array<Record<string, unknown>> = [{ type: "context", elements: [{ type: "mrkdwn", text: byline }] }];
  const body = parts.body?.trim() ? parts.body : null;
  if (body) {
    for (const chunk of slackChunks(body, SLACK_TEXT_OBJECT_MAX).slice(0, SLACK_MESSAGE_BLOCKS_MAX - 1)) {
      if (chunk.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  }
  return blocks;
}

// 一行里不在行内代码中的部分换成 mrkdwn。顺序要紧：列表的「* 」先换成「• 」，单星号的斜体先换成 _x_，再换双星号的粗体。
function slackInlineMrkdwn(text: string): string {
  return text.split(/(`[^`\n]+`)/u).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/gu, "<$2|$1>")
      .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![*\w])/gu, "_$1_")
      .replace(/(\*\*|__)(?!\s)(.+?)(?<!\s)\1/gu, "*$2*")
      .replace(/~~(?!\s)(.+?)(?<!\s)~~/gu, "~$1~");
  }).join("");
}

/**
 * Lead 按 Markdown 写的回复换成 Slack 的 mrkdwn（https://docs.slack.dev/messaging/formatting-message-text）：
 * 标题和粗体换成 *x*，斜体换成 _x_，删除线换成 ~x~，链接换成 <url|文字>，列表的符号换成 •，代码块去掉语言名，
 * 表格放进代码块（Slack 不画表格）。代码块和行内代码里的字不动。
 */
export function slackMrkdwnFromMarkdown(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length) out.push("```", ...table, "```");
    table = [];
  };
  for (const line of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    if (/^\s*```/u.test(line)) {
      flushTable();
      fenced = !fenced;
      out.push(line.trim().startsWith("```") ? "```" : line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      table.push(line.trim());
      continue;
    }
    flushTable();
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      out.push(`*${heading[1]!.replace(/\*\*/gu, "")}*`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push("────────");
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
    out.push(bullet ? `${bullet[1]}• ${slackInlineMrkdwn(bullet[2]!)}` : slackInlineMrkdwn(line));
  }
  flushTable();
  return out.join("\n");
}
/** Slack 通道要的两个 daemon 专用密钥（core 的 SLACK_APP_TOKEN_ENV、SLACK_USER_TOKEN_ENV）。 */
export const SLACK_SECRET_NAMES = [SLACK_APP_TOKEN_ENV, SLACK_USER_TOKEN_ENV] as const;

export const SLACK_EVENT_KINDS = {
  dm: "slack.dm.received",
  mention: "slack.mention.received",
  selfReply: "slack.self.reply",
  thread: "slack.thread.message",
  edited: "slack.message.edited",
  deleted: "slack.message.deleted",
  channel: "slack.channel.message",
  // 用户关注的 thread（用户在里面发起或者回复过，照 Slack 的自动关注规则）里别人的消息，没有提到用户。只记录，沉淀进记忆。
  followed: "slack.followed.message",
} as const;

export interface SlackChannelOptions {
  api: SlackWebApi;
  // 用户指定信任的人、外部客户：Slack 的用户编号或者工作区编号。缺省都没有。
  trust?: { trusted?: readonly string[]; customers?: readonly string[] };
  // 签名的时间戳最多差多久。缺省 5 分钟（Slack 的建议）。
  maxSignatureAgeMs?: number;
  now?: () => Date;
  // Socket Mode 的传输。给了才有 transport（生产入口给；只测解析和出站的测试不给）。
  socket?: SlackSocketOptions;
  // 对话的名字和外部共享状态缓存多久。缺省 10 分钟。
  conversationTtlMs?: number;
  // 订阅：这个频道下多久以内有过道就算订阅。缺省 14 天（spec D12）。
  subscribeWindowMs?: number;
  // 记忆沉淀（spec D12，工单 07）。exclude：不订阅、不沉淀的频道，写频道编号（C0123ABCD）或者频道名（proj-x 或 #proj-x，
  // 不分大小写）。来自 config.json 的 channels.slack.memory.exclude（builtin.ts）。
  memory?: { exclude?: readonly string[] };
  // 主人名（配置的 channels.ownerName）：建应用的清单里的说明。来自 builtin.ts。
  ownerName?: string | null;
  // 助手名：建应用的清单里的应用名。配置的 channels.assistantName（字符串），没有时是 daemon 给的函数（Lead 的名字，
  // 2026-10-22），读清单时取。来自 builtin.ts。
  assistantName?: string | null | (() => string | null);
  // 署名里助手名前面的 emoji（Slack 的短代码）。不给时是 :robot_face:（Slack 自带的 emoji，任何工作区都有；用户 2026-10-30 定）；写 "" 或者不合短代码的
  // 写法时不加。字符串是配置的 channels.slack.assistantEmoji；函数是 daemon 给的生效值（设置 → 身份与风格 → 形象的值 >
  // 配置 > 缺省，2026-10-28），每发一条消息读一次，返回 undefined 时用缺省。来自 builtin.ts。
  assistantEmoji?: string | null | (() => string | null | undefined);
}

// 排除名单最多认这么多条，每条最多这么长（配置是用户写的，不信任它的大小）。
const EXCLUDE_MAX = 200;
const EXCLUDE_ENTRY_MAX = 100;

export interface SlackMemoryExclusion {
  // 名单是空的：什么都不排除。
  readonly empty: boolean;
  // 频道编号在名单里。
  hasId(channelId: string): boolean;
  // 频道（编号或者名字）在名单里。名单不空、频道名又是 null（问不到）时按排除处理：宁可少记，不把用户不想留的频道记下来。
  has(channelId: string, channelName: string | null): boolean;
}

/** 排除名单：频道编号原样比，频道名去掉开头的 # 以后不分大小写比。不合法的条目（不是字符串、空的、太长的）不用。 */
export function slackMemoryExclusion(entries: readonly unknown[] | undefined): SlackMemoryExclusion {
  const list = (entries ?? []).filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= EXCLUDE_ENTRY_MAX).slice(0, EXCLUDE_MAX);
  const ids = new Set(list);
  const names = new Set(list.map((entry) => entry.replace(/^#/, "").toLowerCase()));
  const empty = list.length === 0;
  return {
    empty,
    hasId: (channelId) => ids.has(channelId),
    has: (channelId, channelName) => !empty
      && (ids.has(channelId) || channelName === null || names.has(channelName.replace(/^#/, "").toLowerCase())),
  };
}

const SlackFields = {
  channelId: Type.String(),
  channelType: Type.String(),
  ts: Type.String(),
  threadTs: Type.Union([Type.String(), Type.Null()]),
  echo: Type.Boolean(),
  // 对话是不是和别的工作区共享（Slack Connect）。问不到时是 null。
  externalShared: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  // 频道名（不带 #）。私信、问不到时是 null。记忆沉淀用它做笔记的标题、按名字排除频道。
  channelName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 取历史一次最多几条；thread 一次取一页多少条（留根消息和最近的回复）。
const HISTORY_MAX = 50;
const REPLIES_PAGE = 200;
// 表情的名字：Slack 的短代码（小写字母、数字、- _ +），不带冒号。
const SLACK_EMOJI_NAME = /^[a-z0-9_+'-]{1,100}$/;
// 工作区的自定义 emoji（设置页的署名预览）：问一次用多久；alias 最多跟几层；一项的值最长多少（图片地址）。
const EMOJI_TTL_MS = 5 * MINUTE;
const EMOJI_ALIAS_HOPS = 5;
const EMOJI_VALUE_MAX = 2_048;
/** 用户令牌没有 emoji:read 时，设置页的署名预览给的原因。 */
export const SLACK_EMOJI_SCOPE_MISSING = "Slack 应用没有 emoji:read 权限：在应用的 OAuth & Permissions 里加上它，再重新安装。";
// chat.update 的这些错误说明这条消息改不了了（再试也一样）。
const SLACK_EDIT_GONE = new Set(["message_not_found", "cant_update_message", "edit_window_closed"]);
// 重连以后补拉：最多看几条道，每条道最多补几条消息。
const BACKFILL_LANES = 20;
const BACKFILL_MESSAGES = 50;
// 找对话（Lead 代用户直接发消息）：工作区的人一小时问一次，用户所在的对话十分钟问一次，每次最多翻几页；最多给几个结果。
const PEOPLE_TTL_MS = 60 * MINUTE;
const JOINED_TTL_MS = 10 * MINUTE;
const DIRECTORY_PAGES = 20;
const DIRECTORY_PAGE_SIZE = 200;
const FIND_MAX = 12;
// 对话编号：slack:@U123（私信这个人）、slack:C123:main（频道或私信的主对话）、slack:C123:<thread 的 ts>。
const PERSON_CONVERSATION = /^slack:@([A-Z0-9]{6,20})$/;
const PLACE_CONVERSATION = /^slack:([A-Z0-9]{6,20}):(main|\d{9,11}\.\d{6})$/;
// 新消息里认的 subtype。别的（加入频道、改名之类的系统消息）不管；改消息、删消息另外处理。
const MESSAGE_SUBTYPES = new Set(["thread_broadcast", "file_share"]);
// 线程和改、删的投递条件：同事和你信任的人进会话卡，别人进摘要。
const CONVERSATION_KINDS = [SLACK_EVENT_KINDS.mention, SLACK_EVENT_KINDS.thread, SLACK_EVENT_KINDS.edited, SLACK_EVENT_KINDS.deleted];

const SEEDS: readonly SystemStandingOrderSeed[] = [
  {
    id: "source.slack",
    seedRevision: 1,
    title: "来源 slack：默认进摘要，最高到 tell（永不打断 Lead 正在进行的回合）",
    priority: 100,
    condition: { sources: [SLACK_SOURCE] },
    action: { type: "rule", rule: "source.threshold", params: { source: SLACK_SOURCE, defaultLevel: "digest", maxLevel: "tell" } },
    limits: null,
    escalateTo: null,
    reason: "工单 11：Slack 是外部来源，它的事件永远排在 Lead 当前这一轮后面，不插话（硬性规则）。"
      + "Lead 的当前局面里只放每条道（对话）的一行摘要；投递给用户的方式由 channel.slack.delivery 定。",
  },
  {
    id: "slack.self_reply",
    seedRevision: 1,
    title: "用户自己在 Slack 里的回复只记录",
    priority: 90,
    condition: { kinds: [SLACK_EVENT_KINDS.selfReply] },
    action: { type: "level", level: "record" },
    limits: null,
    escalateTo: null,
    reason: "工单 11：用户本人的回复只用来认出「别处已处理」（对应的卡自动结束），不用 Lead 处理，也不问 Jev。",
  },
  {
    id: "slack.channel_message",
    seedRevision: 1,
    title: "订阅频道里的普通消息只记录（不开卡，不叫醒 Lead）",
    priority: 90,
    condition: { kinds: [SLACK_EVENT_KINDS.channel] },
    action: { type: "level", level: "record" },
    limits: null,
    escalateTo: null,
    reason: "slack-takeover 工单 02（spec D12）：用户被提到过的频道里，别人没有提到用户的消息只记进事件日志，给以后的记忆沉淀用。"
      + "不开卡、不开道，不问紧急程度，也不问 Jev。",
  },
  {
    id: "slack.record_only",
    seedRevision: 1,
    title: "投递方式是「只记录」的 Slack 消息，级别也只记录（不进 Lead 的当前局面）",
    priority: 90,
    condition: { sources: [SLACK_SOURCE], fields: { "payload.channelDelivery": "record" } },
    action: { type: "level", level: "record" },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-21：机器人的提醒、关注的 thread 里的消息只记录、沉淀进记忆，不进 Lead 的上下文。"
      + "投递方式定成只记录的消息，原来按来源的缺省进摘要（digest），会把原文带进 Lead 的当前局面；这里一律记成 record。",
  },
  {
    id: "slack.amendment",
    seedRevision: 1,
    title: "Slack 里改消息、删消息只记录（这个对话有没结束的卡时，卡照样更新）",
    priority: 90,
    condition: { kinds: [SLACK_EVENT_KINDS.edited, SLACK_EVENT_KINDS.deleted] },
    action: { type: "level", level: "record" },
    limits: null,
    escalateTo: null,
    reason: "slack-takeover 工单 02：改和删只对已有的道。没结束的卡上看得到（摘录换成新的，闸门重新判断），不用为它叫醒 Lead；"
      + "没有没结束的卡时不开新卡。",
  },
  {
    id: "channel.slack.delivery",
    // 2：紧急程度改由通道内核问快模型判断（2026-10-19），标题和说明跟着改；条件不变。
    // 3：线程里的后续消息、改消息、删消息和提及一样投递（slack-takeover 工单 02）；订阅频道的消息不匹配，只记录。
    // 4：机器人和应用发的消息（payload.sender.bot，来自 Slack 的 bot_id）只记录（用户 2026-10-21：日历提醒开了卡）。
    seedRevision: 4,
    title: "Slack 消息的投递：打断阈值很高（只有你信任的人发来私信、并且系统判断你需要马上看到时才推送）；"
      + "私信和同事的提及、你的线程里同事的后续消息进会话卡，其余的进摘要，订阅频道的消息和机器人发的消息只记录",
    priority: 100,
    condition: {},
    action: {
      type: "rule",
      rule: "channel.delivery",
      params: {
        source: SLACK_SOURCE,
        pushWhen: {
          kinds: [SLACK_EVENT_KINDS.dm],
          fields: { "payload.sender.trust": "trusted", "payload.urgent": true, "payload.sender.bot": { not: true } },
        },
        cardWhen: {
          fields: { "payload.sender.bot": { not: true } },
          anyOf: [
            { kinds: [SLACK_EVENT_KINDS.dm] },
            { kinds: CONVERSATION_KINDS, fields: { "payload.sender.trust": { in: ["trusted", "colleague"] } } },
          ],
        },
        digestWhen: { kinds: CONVERSATION_KINDS, fields: { "payload.sender.bot": { not: true } } },
      },
    },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-17：Slack 的打断阈值缺省很高。推送只给你信任的人（缺省没有）发来的私信，"
      + "并且系统判断你需要马上看到（payload.urgent：通道内核问快模型，阈值很高，不看关键词；问不成时按不紧急）；"
      + "私信、同事在频道里提到你、你的线程里同事的后续消息，进会话卡；外部的人的，进摘要；改和删只更新没结束的卡；其余只记录。"
      + "用户 2026-10-21：机器人和应用发的消息（例如日历提醒）只记录，不开卡、不进摘要。"
      + "开卡以前系统还会先判断这条消息要不要你回（请求 A 的 needs_reply），不用回的不开卡，只在 Lead 动态里记一笔。",
  },
  {
    id: "channel.slack.delegate",
    // 2：模板代回闸门和影子模式退役（用户 2026-10-22，落地计划 A5），由授权表（channel.authority）取代。停用，不删。
    seedRevision: 2,
    status: "disabled",
    title: "（已退役）Slack 的模板代回：由授权表（channel.authority）取代",
    priority: 100,
    condition: {},
    action: {
      type: "rule",
      rule: "channel.delegate",
      params: {
        source: SLACK_SOURCE,
        openCategories: [],
        allowedTrust: ["trusted", "colleague"],
        minConfidence: 0.85,
        maxSensitivity: 0.2,
        revokeWindowMs: 10 * MINUTE,
        shadowMinSamples: 20,
        shadowMinAgreement: 0.9,
      },
    },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-22（落地计划 A5）：模板代回闸门和影子模式退役了。别人找你时能替你做什么，由授权表（channel.authority）"
      + "按对方的意图决定：收尾回表情或者代你说一句，涉密的用固定的话拒绝，会议只提醒你，要干活的去干活，别的问你。",
  },
  {
    id: "channel.slack.lookup",
    // 2：代查退役（用户 2026-10-22，落地计划 D1），由 Lead 派的子 agent 工单取代。停用，不删。
    seedRevision: 2,
    status: "disabled",
    title: "（已退役）Slack 的代查：由 Lead 派的子 agent 工单取代",
    priority: 100,
    condition: {},
    action: {
      type: "rule",
      rule: "channel.lookup",
      params: {
        source: SLACK_SOURCE,
        playbooks: ["lookup", "review"],
        allowedTrust: ["trusted", "colleague"],
        minAskConfidence: 0.5,
        maxSensitiveQuery: 0.5,
        perRequesterDaily: 10,
        dailyMax: 40,
        concurrent: 2,
        timeoutMs: 15 * MINUTE,
        maxRepos: 2,
      },
    },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-22（落地计划 D1）：代查退役了。要干活的请求（查资料、问进度、代码 review）由授权表（channel.authority）"
      + "判断，交给 Lead 派子 agent 工单；工单的权限清单由代码按意图和对象算，子 agent 只能在清单里读和写。",
  },
  {
    id: "channel.slack.reply",
    // 2：PR review 也按信心自动发（用户 2026-10-21：「review 换量法，信心够时直接发到 PR」）。
    // 3：按信心代回退役（用户 2026-10-22，落地计划 D1），由授权表和信心模型取代。停用，不删。
    seedRevision: 3,
    status: "disabled",
    title: "（已退役）Slack 的按信心代回：由授权表（channel.authority）和信心模型取代",
    priority: 100,
    condition: {},
    action: {
      type: "rule",
      rule: "channel.reply",
      params: {
        source: SLACK_SOURCE,
        autoReply: { lookup: true, review: true },
        threshold: 0.85,
        coldStartMin: 0.9,
        calibrationMinSamples: 20,
        calibrationMinAgreement: 0.9,
        maxSensitivity: 0.2,
        maxResultAgeMs: 30 * MINUTE,
        revokeWindowMs: 10 * MINUTE,
      },
    },
    limits: null,
    escalateTo: null,
    reason: "用户 2026-10-22（落地计划 D1）：按信心代回退役了。子 agent 工单的结果交回通道以后，由请求 B 和信心模型算分，"
      + "授权表按意图定能不能自动回；在 PR 上留 review 由子 agent 在权限清单里做，不再由通道代发。",
  },
];

interface SlackEnvelope {
  type?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackMessageEvent;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  user_team?: string;
  team?: string;
  // 应用（机器人）发的消息带它。
  bot_id?: string;
  text?: string;
  // 应用发的消息常把正文放在这里，text 是空的（slackMessageText）。
  attachments?: unknown[];
  blocks?: unknown[];
  ts?: string;
  thread_ts?: string;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
}

interface SlackMessageEvent extends SlackMessage {
  channel?: string;
  channel_type?: string;
  event_ts?: string;
  // message_changed：改后的消息和改前的消息。message_deleted：删掉的是哪一条，和删之前的消息。
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
}

interface ConversationInfo {
  label: string;
  // 频道名（不带 #）。私信没有；问不到时是 null。
  name: string | null;
  externalShared: boolean | null;
  // 私信（im）的对方。用户发给自己的私信，对方就是用户本人。不是私信、问不到时是 null。
  user: string | null;
  at: number;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// 从附件和 block 里取出的正文最多多少字（和别的消息一样，之后还会按内核的上限截断）。
const MESSAGE_TEXT_MAX = 4_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// 文字对象（{ type, text }）里的字。
function textObject(value: unknown): string | null {
  return isRecord(value) && isString(value.text) ? value.text : null;
}

// rich_text 的元素里的字：text、link（没有字时用链接）、emoji（:名字:），嵌套的 section、list、quote 往里找。
function richText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (value.type === "text" && isString(value.text)) return value.text;
  if (value.type === "link") return isString(value.text) ? value.text : isString(value.url) ? value.url : "";
  if (value.type === "emoji" && isString(value.name)) return `:${value.name}:`;
  if (Array.isArray(value.elements)) {
    const joiner = value.type === "rich_text_list" ? "\n" : "";
    return value.elements.map(richText).filter(Boolean).join(joiner);
  }
  return "";
}

// 一个 block 里的字：header、section（正文和字段）、context、rich_text。别的（图片、按钮）没有要读的字。
function blockText(block: unknown): string[] {
  if (!isRecord(block)) return [];
  if (block.type === "header") return [textObject(block.text)].filter(isString);
  if (block.type === "section") {
    const fields = Array.isArray(block.fields) ? block.fields.map(textObject) : [];
    return [textObject(block.text), ...fields].filter(isString);
  }
  if (block.type === "context") return (Array.isArray(block.elements) ? block.elements.map(textObject) : []).filter(isString);
  if (block.type === "rich_text") return [richText(block)].filter(isString);
  return [];
}

// 一个附件里的字：前言、作者、标题、正文、字段、脚注；都没有时用 fallback。附件里也可能有 block。
function attachmentText(attachment: unknown): string[] {
  if (!isRecord(attachment)) return [];
  const fields = Array.isArray(attachment.fields)
    ? attachment.fields.flatMap((field) => isRecord(field) ? [[field.title, field.value].filter(isString).join(": ")] : [])
    : [];
  const blocks = Array.isArray(attachment.blocks) ? attachment.blocks.flatMap(blockText) : [];
  const parts = [attachment.pretext, attachment.author_name, attachment.title, attachment.text].filter(isString);
  const all = [...parts, ...fields.filter(isString), ...blocks, ...[attachment.footer].filter(isString)];
  return all.length ? all : [attachment.fallback].filter(isString);
}

/**
 * 一条消息的正文。text 有字时就是它。应用（例如日历提醒）常把正文放在附件或者 block 里，text 是空的（2026-10-21：Google
 * Calendar 的提醒判断时拿到的是空字符串）：这时按结构取出 block 和附件里的文字，一段一行。只按结构取，不看内容。
 */
export function slackMessageText(message: SlackMessage): string {
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  const blocks = Array.isArray(message.blocks) ? message.blocks.flatMap(blockText) : [];
  const attachments = Array.isArray(message.attachments) ? message.attachments.flatMap(attachmentText) : [];
  return [...blocks, ...attachments].map((part) => part.trim()).filter(Boolean).join("\n").slice(0, MESSAGE_TEXT_MAX);
}

// Slack 正文里的标记（https://docs.slack.dev/messaging/formatting-message-text）：<@U…> 提到一个人，<#C…|名字> 一个频道，
// <!channel> 这类特殊提及，<!subteam^S…|@组> 一个用户组，<!date^…|后备> 日期，<链接|文字> 链接；&lt; &gt; &amp; 是转义。
const SLACK_MARKUP = /<([^<>\n]+)>/g;
const SLACK_SPECIAL_MENTIONS: Readonly<Record<string, string>> = { channel: "@channel", here: "@here", everyone: "@everyone" };

/** 正文里提到的人和频道的编号（换成名字以前要先查）。 */
export function slackMarkupIds(text: string): { users: string[]; channels: string[] } {
  const users = new Set<string>();
  const channels = new Set<string>();
  for (const match of text.matchAll(SLACK_MARKUP)) {
    const [target = "", label] = match[1]!.split("|", 2);
    if (target.startsWith("@") && !label) users.add(target.slice(1));
    if (target.startsWith("#") && !label) channels.add(target.slice(1));
  }
  return { users: [...users], channels: [...channels] };
}

/**
 * 把 Slack 正文里的标记换成人看得懂的字：<@U…> 换成「@名字」，<#C…> 换成「#频道」，<!here> 换成「@here」，
 * 链接换成「文字（地址）」，再去掉转义。卡片、动态、Lead 和模型读到的都是它；认「有人提到用户」用原文，不经过这里。
 * user、channel 给出编号对应的名字，查不到时是 null（用编号）。
 */
export function slackDisplayText(
  text: string, lookup: { user: (id: string) => string | null; channel: (id: string) => string | null },
): string {
  const shown = text.replace(SLACK_MARKUP, (whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? "" : inner.slice(bar + 1);
    if (target.startsWith("@")) return `@${label || lookup.user(target.slice(1)) || target.slice(1)}`;
    if (target.startsWith("#")) return `#${label || (lookup.channel(target.slice(1)) ?? target.slice(1)).replace(/^#/, "")}`;
    if (target.startsWith("!")) {
      const special = target.slice(1);
      if (SLACK_SPECIAL_MENTIONS[special]) return SLACK_SPECIAL_MENTIONS[special]!;
      if (special.startsWith("subteam^")) return label ? (label.startsWith("@") ? label : `@${label}`) : "@用户组";
      return label || whole;
    }
    if (/^(https?|mailto|tel):/i.test(target)) {
      const plain = target.replace(/^mailto:|^tel:/i, "");
      return !label || label === target || label === plain ? plain : `${label}（${plain}）`;
    }
    return whole;
  });
  return shown.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 比较两个 Slack 的 ts（"秒.微秒"）。不转成浮点数：16 位数字会丢精度。 */
export function compareSlackTs(a: string, b: string): number {
  const [aSeconds = "0", aMicros = ""] = a.split(".");
  const [bSeconds = "0", bMicros = ""] = b.split(".");
  const seconds = Number(aSeconds) - Number(bSeconds);
  if (seconds !== 0) return Math.sign(seconds);
  const left = aMicros.padEnd(6, "0");
  const right = bMicros.padEnd(6, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

/** 一条消息属于哪个对话：对象键和回复的目标。私信里不在线程中的是整段私信；频道里不在线程中的是以它开头的线程。 */
function placeOf(channel: string, channelType: string, ts: string, threadTs: string | undefined) {
  const direct = channelType === "im" || channelType === "mpim";
  // 线程的第一条消息自己也带 thread_ts（等于它的 ts）：它不是线程里的回复。
  const thread = isString(threadTs) && threadTs !== ts ? threadTs : null;
  const root = thread ?? (direct ? null : ts);
  const replyTarget: Record<string, string> = root ? { channel, thread_ts: root } : { channel };
  return {
    direct,
    thread,
    objectKey: root ? `${SLACK_SOURCE}:${channel}:${root}` : `${SLACK_SOURCE}:${channel}:main`,
    replyTarget,
  };
}

export function createSlackChannelAdapter(options: SlackChannelOptions): ChannelAdapter {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxSignatureAgeMs ?? 5 * MINUTE;
  const conversationTtlMs = options.conversationTtlMs ?? 10 * MINUTE;
  const subscribeWindowMs = options.subscribeWindowMs ?? 14 * DAY;
  const trusted = new Set(options.trust?.trusted ?? []);
  const customers = new Set(options.trust?.customers ?? []);
  const excluded = slackMemoryExclusion(options.memory?.exclude);
  const names = new Map<string, string>();
  const conversations = new Map<string, ConversationInfo>();
  // 用户本人所在的工作区：auth.test 或者投递的 team_id 告诉我们。补拉的消息靠它认出外部的人。
  let homeTeam: string | null = null;
  // 系统自己发出去的消息（频道:ts），和正在发的（按频道）。Slack 推回来的 message 事件里带不带 metadata，文档没有写明
  // （conversations.history 加 include_all_metadata 时一定带）。2026-10-21 真实的 Slack 推回来时带了，这里是退路：
  // 认不出 metadata 时按 ts 认，推回来的那一条和发出去的 ts 一样。
  // 推回来可能比 chat.postMessage 的回答还快，所以这个频道有正在发的消息时，先等它发完再认（最多等 POSTING_WAIT_MS）。
  const posted = new Set<string>();
  const posting = new Map<string, Set<Promise<unknown>>>();

  function rememberPosted(channel: string, ts: string): void {
    posted.add(`${channel}:${ts}`);
    // 只留最近的一些（够认出推回来的那一条）。
    while (posted.size > POSTED_MAX) posted.delete(posted.values().next().value!);
  }

  function trackPosting<T>(channel: string, call: Promise<T>): Promise<T> {
    const set = posting.get(channel) ?? new Set<Promise<unknown>>();
    posting.set(channel, set);
    set.add(call);
    const done = () => {
      set.delete(call);
      if (!set.size && posting.get(channel) === set) posting.delete(channel);
    };
    call.then(done, done);
    return call;
  }

  async function postedByUs(channel: string, ts: string): Promise<boolean> {
    const pending = posting.get(channel);
    if (pending?.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, POSTING_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    }
    return posted.has(`${channel}:${ts}`);
  }

  // 署名里助手名前面的 emoji：选项是函数时每次问它（daemon 给的生效值），读不到时用缺省。
  function disclosureMarkNow(): string | null {
    let configured: string | null | undefined;
    if (typeof options.assistantEmoji === "function") {
      try {
        configured = options.assistantEmoji();
      } catch {
        configured = undefined;
      }
    } else {
      configured = options.assistantEmoji;
    }
    return slackEmojiCode(configured === undefined ? SLACK_ASSISTANT_EMOJI_DEFAULT : configured);
  }

  // 工作区的自定义 emoji（emoji.list，要用户令牌有 emoji:read）：名字 → 图片地址或者 alias:<名字>。几分钟问一次，同时只问一次。
  let customEmoji: { at: number; list: Map<string, string> } | null = null;
  let customEmojiLoading: Promise<Map<string, string> | ChannelMarkLookup> | null = null;

  async function loadCustomEmoji(context: ChannelAdapterContext): Promise<Map<string, string> | ChannelMarkLookup> {
    let result: Record<string, unknown>;
    try {
      result = await options.api.call("emoji.list", {}, context.credential.token);
    } catch (error) {
      return { status: "unavailable", reason: `问 Slack 失败：${scrubSlackText(errorText(error), [context.credential.token])}` };
    }
    if (result.ok !== true) {
      const code = isString(result.error) ? result.error : "not ok";
      if (code === "missing_scope") return { status: "unavailable", reason: SLACK_EMOJI_SCOPE_MISSING };
      return { status: "unavailable", reason: `Slack 回答 ${code.slice(0, 80)}，查不了工作区的 emoji。` };
    }
    const list = new Map<string, string>();
    const raw = result.emoji && typeof result.emoji === "object" && !Array.isArray(result.emoji) ? result.emoji as Record<string, unknown> : {};
    for (const [name, value] of Object.entries(raw)) {
      if (SLACK_EMOJI_NAME.test(name) && isString(value) && value.length <= EMOJI_VALUE_MAX) list.set(name, value);
    }
    customEmoji = { at: Date.now(), list };
    return list;
  }

  async function customEmojiList(context: ChannelAdapterContext): Promise<Map<string, string> | ChannelMarkLookup> {
    if (customEmoji && Date.now() - customEmoji.at < EMOJI_TTL_MS) return customEmoji.list;
    customEmojiLoading ??= loadCustomEmoji(context).finally(() => { customEmojiLoading = null; });
    return customEmojiLoading;
  }

  // 设置页的署名预览：短代码是不是工作区的自定义 emoji，是的话给它的图（alias 跟到原图）。只给 https 的地址。
  async function lookupDisclosureMark(mark: string, context: ChannelAdapterContext): Promise<ChannelMarkLookup> {
    const code = slackEmojiCode(mark);
    if (!code) return { status: "not_found" };
    const list = await customEmojiList(context);
    if (!(list instanceof Map)) return list;
    let name = code.slice(1, -1);
    for (let hop = 0; hop < EMOJI_ALIAS_HOPS; hop += 1) {
      const value = list.get(name);
      // 不在自定义 emoji 里：Slack 自带的 emoji（alias 指向它时也是），或者写错了。
      if (value === undefined) return { status: "not_found" };
      if (value.startsWith("alias:")) {
        name = value.slice("alias:".length);
        continue;
      }
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { status: "unavailable", reason: "Slack 给的图片地址不对，没法预览。" };
      }
      if (url.protocol !== "https:") return { status: "unavailable", reason: "Slack 给的图片地址不是 https，没法预览。" };
      return { status: "custom", imageUrl: url.toString() };
    }
    return { status: "not_found" };
  }

  async function api(method: string, args: Record<string, unknown>, context: ChannelAdapterContext): Promise<Record<string, unknown>> {
    const result = await options.api.call(method, args, context.credential.token);
    if (result.ok !== true) throw new Error(`slack ${method}: ${isString(result.error) ? result.error : "not ok"}`);
    return result;
  }

  async function userName(id: string, context: ChannelAdapterContext): Promise<string> {
    const cached = names.get(id);
    if (cached) return cached;
    try {
      const result = await api("users.info", { user: id }, context);
      const user = result.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const name = [user?.profile?.display_name, user?.profile?.real_name, user?.real_name, user?.name].find(isString) ?? id;
      names.set(id, name);
      return name;
    } catch (error) {
      context.log(`users.info failed for ${id}: ${errorText(error)}`);
      return id;
    }
  }

  // 给人和模型看的正文（slackDisplayText）：提到的人用 users.info 的名字（带缓存），用户本人用凭据里的名字（和署名一样），
  // 频道用 conversations.info 的名字。查不到时用编号。
  async function displayText(text: string, context: ChannelAdapterContext): Promise<string> {
    const ids = slackMarkupIds(text);
    if (!ids.users.length && !ids.channels.length) return slackDisplayText(text, { user: () => null, channel: () => null });
    const self = context.credential.account;
    const users = new Map<string, string>();
    for (const id of ids.users) {
      users.set(id, id === self && context.credential.accountName?.trim() ? context.credential.accountName.trim() : await userName(id, context));
    }
    const channels = new Map<string, string | null>();
    for (const id of ids.channels) channels.set(id, (await conversation(id, context)).name);
    return slackDisplayText(text, { user: (id) => users.get(id) ?? null, channel: (id) => channels.get(id) ?? null });
  }

  // 工作区的人（users.list）和用户所在的对话（users.conversations），找对话用（带缓存）。
  type SlackPerson = { id: string; name: string; realName: string; displayName: string; title: string };
  type SlackJoined = { id: string; name: string | null; kind: "im" | "channel" | "group"; user: string | null; private: boolean };
  let people: { at: number; list: SlackPerson[] } | null = null;
  let joined: { at: number; list: SlackJoined[] } | null = null;

  // 一个分页的列表方法，翻到底或者翻满 DIRECTORY_PAGES 页。
  async function allPages(method: string, args: Record<string, unknown>, field: string, context: ChannelAdapterContext) {
    const items: Array<Record<string, unknown>> = [];
    let cursor = "";
    for (let page = 0; page < DIRECTORY_PAGES; page++) {
      const result = await api(method, { ...args, limit: DIRECTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, context);
      const list = result[field];
      if (Array.isArray(list)) items.push(...list.filter(isRecord));
      const next = (result.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (!isString(next) || !next) break;
      cursor = next;
    }
    return items;
  }

  async function directory(context: ChannelAdapterContext): Promise<SlackPerson[]> {
    if (people && now().getTime() - people.at < PEOPLE_TTL_MS) return people.list;
    const members = await allPages("users.list", {}, "members", context);
    const list = members.flatMap((member): SlackPerson[] => {
      if (!isString(member.id) || member.deleted === true || member.is_bot === true || member.id === "USLACKBOT") return [];
      const profile = isRecord(member.profile) ? member.profile : {};
      const pick = (value: unknown) => (isString(value) ? value : "");
      return [{
        id: member.id, name: pick(member.name), realName: pick(member.real_name) || pick(profile.real_name),
        displayName: pick(profile.display_name), title: pick(profile.title),
      }];
    });
    people = { at: now().getTime(), list };
    return list;
  }

  async function membership(context: ChannelAdapterContext): Promise<SlackJoined[]> {
    if (joined && now().getTime() - joined.at < JOINED_TTL_MS) return joined.list;
    const channels = await allPages(
      "users.conversations", { types: "public_channel,private_channel,mpim,im", exclude_archived: true }, "channels", context,
    );
    const list = channels.flatMap((channel): SlackJoined[] => {
      if (!isString(channel.id)) return [];
      const kind = channel.is_im === true ? "im" : channel.is_mpim === true ? "group" : "channel";
      return [{
        id: channel.id, name: isString(channel.name) ? channel.name : null, kind,
        user: isString(channel.user) ? channel.user : null, private: channel.is_private === true,
      }];
    });
    joined = { at: now().getTime(), list };
    return list;
  }

  // 对话的名字和外部共享状态（带缓存）。问不到时用上一次的；从来没问到过时外部共享是 null（不缓存，下次再问）。
  async function conversation(id: string, context: ChannelAdapterContext): Promise<ConversationInfo> {
    const cached = conversations.get(id);
    if (cached && now().getTime() - cached.at < conversationTtlMs) return cached;
    try {
      const result = await api("conversations.info", { channel: id }, context);
      const channel = result.channel as {
        name?: string; is_ext_shared?: boolean; is_shared?: boolean; is_pending_ext_shared?: boolean; user?: string;
      } | undefined;
      const info: ConversationInfo = {
        label: isString(channel?.name) ? `#${channel.name}` : id,
        name: isString(channel?.name) ? channel.name : null,
        externalShared: channel?.is_ext_shared === true || channel?.is_shared === true || channel?.is_pending_ext_shared === true,
        user: isString(channel?.user) ? channel.user : null,
        at: now().getTime(),
      };
      conversations.set(id, info);
      return info;
    } catch (error) {
      context.log(`conversations.info failed for ${id}: ${errorText(error)}`);
      return cached ?? { label: id, name: null, externalShared: null, user: null, at: 0 };
    }
  }

  function trustOf(message: SlackMessage, envelope: SlackEnvelope): SenderTrust {
    const user = message.user;
    if (!user) return "unknown";
    const team = message.user_team ?? message.team;
    if (customers.has(user) || (team && customers.has(team))) return "customer";
    if (trusted.has(user)) return "trusted";
    if (team && envelope.team_id && team !== envelope.team_id) return "external";
    return "colleague";
  }

  // 一件事的公共部分：发信人、对话的名字、事实字段。
  async function inbound(input: {
    envelope: SlackEnvelope; message: SlackMessage; channel: string; channelType: string; ts: string;
    kind: string; role: ChannelInbound["role"]; deliveryId: string; text: string; echo: boolean; amends?: ChannelInbound["amends"];
    occurredAt: Date; follows?: boolean;
  }, context: ChannelAdapterContext): Promise<ChannelInbound> {
    const place = placeOf(input.channel, input.channelType, input.ts, input.message.thread_ts);
    const senderId = isString(input.message.user) ? input.message.user : "unknown";
    const senderName = input.role === "message" ? await userName(senderId, context) : "你";
    const info = await conversation(input.channel, context);
    let laneLabel: string;
    if (place.direct) {
      // 私信的道以对方命名。用户自己的话推回来时不知道对方是谁：这条道一定已经存在，hub 用已有的名字。
      laneLabel = input.channelType === "mpim" ? `${senderName}等人的群聊` : `${senderName}的私信`;
    } else {
      laneLabel = `${info.label} 里的讨论`;
    }
    return {
      deliveryId: input.deliveryId,
      kind: input.kind,
      role: input.role,
      objectKey: place.objectKey,
      laneLabel,
      occurredAt: Number.isNaN(input.occurredAt.getTime()) ? now().toISOString() : input.occurredAt.toISOString(),
      sender: {
        id: senderId, name: senderName, trust: input.role === "message" ? trustOf(input.message, input.envelope) : "trusted",
        ...(input.role === "message" && isString(input.message.bot_id) ? { bot: true } : {}),
      },
      text: input.text,
      replyTarget: place.replyTarget,
      messageRef: { channel: input.channel, ts: input.ts },
      messageId: input.ts,
      audience: input.channelType === "im" ? "direct" : input.channelType === "mpim" ? "group" : "channel",
      // thread 里的回复：被回复的是 thread 的根消息。私信里的根消息在整段私信的道里，频道里的根消息和回复在同一个道里。
      ...(place.thread ? { replyTo: { ref: place.thread, objectKey: place.direct ? `${SLACK_SOURCE}:${input.channel}:main` : place.objectKey } } : {}),
      fields: {
        channelId: input.channel, channelType: input.channelType, ts: input.ts, threadTs: place.thread, echo: input.echo,
        externalShared: info.externalShared, channelName: info.name,
      },
      ...(input.amends ? { amends: input.amends } : {}),
      ...(input.follows ? { follows: true } : {}),
    };
  }

  const occurred = (envelope: SlackEnvelope, ts: string | undefined) => (typeof envelope.event_time === "number"
    ? new Date(envelope.event_time * 1000)
    : new Date(Number(ts ?? "") * 1000));

  // 订阅的频道：这个频道下 14 天内有过道，并且不在排除名单里。排除名单有频道名时要问 conversations.info（带缓存）。
  // 这个频道里的 thread 能不能关注：记忆沉淀的排除名单里的频道不关注（和不订阅一样，用户写的是「不订阅、不沉淀」）。
  async function followable(channel: string, context: ChannelAdapterContext): Promise<boolean> {
    if (excluded.empty) return true;
    if (excluded.hasId(channel)) return false;
    return !excluded.has(channel, (await conversation(channel, context)).name);
  }

  async function subscribed(channel: string, context: ChannelAdapterContext): Promise<boolean> {
    if (!context.interest?.recentLaneUnder(`${SLACK_SOURCE}:${channel}:`, now().getTime() - subscribeWindowMs)) return false;
    if (excluded.empty) return true;
    if (excluded.hasId(channel)) return false;
    return !excluded.has(channel, (await conversation(channel, context)).name);
  }

  // 改消息、删消息：只对已有的道（和订阅频道里的线程）。用户自己的、系统替用户发的不算（改自己的话不是回复）；只改了附件预览、文字没变的不算。
  async function amendment(
    envelope: SlackEnvelope, event: SlackMessageEvent, channel: string, channelType: string, context: ChannelAdapterContext,
  ): Promise<ChannelInbound[]> {
    const self = context.credential.account;
    const edited = event.subtype === "message_changed";
    const message = edited ? event.message : event.previous_message;
    const ts = edited ? event.message?.ts : event.deleted_ts ?? event.previous_message?.ts;
    if (!message || !isString(ts)) return [];
    if (message.metadata?.event_type === SLACK_REPLY_METADATA_TYPE || (self && message.user === self)) return [];
    if (edited && (message.text ?? "") === (event.previous_message?.text ?? "")) return [];
    const place = placeOf(channel, channelType, ts, message.thread_ts);
    // 没有道的线程：订阅频道里的才收（只记录，给记忆沉淀用：删掉的消息不能留在笔记里）。私信里的不收。
    const known = context.interest?.laneExists(place.objectKey)
      || (!place.direct && context.interest?.followed(place.objectKey) && await followable(channel, context));
    if (!known && (place.direct || !await subscribed(channel, context))) return [];
    const changeTs = event.event_ts ?? event.ts ?? "";
    return [await inbound({
      envelope, message: { ...message, ts }, channel, channelType, ts,
      kind: edited ? SLACK_EVENT_KINDS.edited : SLACK_EVENT_KINDS.deleted, role: "message",
      deliveryId: edited ? `${channel}:${ts}:edited:${changeTs}` : `${channel}:${ts}:deleted`,
      text: edited ? await displayText(slackMessageText(message), context) : "（删除了一条消息）",
      echo: false, amends: edited ? "edited" : "deleted", occurredAt: occurred(envelope, changeTs || ts),
    }, context)];
  }

  async function resolveCredential(secrets: Readonly<Record<string, string>>, log: (line: string) => void): Promise<ChannelCredential | null> {
    const appToken = secrets[SLACK_APP_TOKEN_ENV];
    const userToken = secrets[SLACK_USER_TOKEN_ENV];
    if (!appToken?.startsWith("xapp-")) {
      log(`${SLACK_APP_TOKEN_ENV} is not an app-level token (it should start with xapp-)`);
      return null;
    }
    if (!userToken || !(userToken.startsWith("xoxp-") || userToken.startsWith("xoxe.xoxp-"))) {
      log(`${SLACK_USER_TOKEN_ENV} is not a user token (it should start with xoxp-)`);
      return null;
    }
    const scrub = (text: string) => scrubSlackText(text, [appToken, userToken]);
    let auth: Record<string, unknown>;
    try {
      auth = await options.api.call("auth.test", {}, userToken);
    } catch (error) {
      log(`auth.test failed: ${scrub(errorText(error))}`);
      return null;
    }
    if (auth.ok !== true || !isString(auth.user_id)) {
      log(`auth.test failed: ${scrub(isString(auth.error) ? auth.error : "no user in the answer")}`);
      return null;
    }
    if (isString(auth.team_id)) homeTeam = auth.team_id;
    let accountName: string | undefined;
    try {
      const info = await options.api.call("users.info", { user: auth.user_id }, userToken);
      const user = info.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      accountName = [user?.real_name, user?.profile?.real_name, user?.profile?.display_name, user?.name].find(isString);
    } catch (error) {
      log(`users.info failed for the user: ${scrub(errorText(error))}`);
    }
    return {
      token: userToken, account: auth.user_id, ...(accountName ? { accountName } : {}),
      ...(isString(auth.team_id) ? { team: { id: auth.team_id, name: isString(auth.team) ? auth.team : auth.team_id } } : {}),
      secrets: { [SLACK_APP_TOKEN_ENV]: appToken },
    };
  }

  // 重新连上以后补拉：还有没结束的卡的道，从记下的最后一个 ts 往后补。补到的消息照常经 hub 的进程内入口，按投递编号去重。
  async function catchUp(input: {
    context: ChannelAdapterContext; transport: ChannelTransportContext; deliver: ChannelTransportDeliver; active: () => boolean;
  }): Promise<void> {
    const { context, transport, deliver } = input;
    if (!homeTeam) {
      transport.log("catch-up skipped: the home workspace is not known yet");
      return;
    }
    for (const lane of transport.openLanes(BACKFILL_LANES)) {
      if (!input.active()) return;
      const parts = /^slack:([A-Z0-9]+):(main|\d+\.\d+)$/.exec(lane.objectKey);
      const last = lane.lastPayload ?? {};
      const lastTs = last.ts;
      if (!parts || !isString(lastTs)) continue;
      const [, channel, root] = parts as unknown as [string, string, string];
      const channelType = isString(last.channelType) ? last.channelType : channel.startsWith("D") ? "im" : "channel";
      let messages: SlackMessage[];
      try {
        const result = root === "main"
          ? await api("conversations.history", { channel, oldest: lastTs, limit: BACKFILL_MESSAGES, include_all_metadata: true }, context)
          : await api("conversations.replies", { channel, ts: root, oldest: lastTs, limit: BACKFILL_MESSAGES, include_all_metadata: true }, context);
        messages = Array.isArray(result.messages) ? result.messages as SlackMessage[] : [];
      } catch (error) {
        context.log(`catch-up of ${lane.objectKey} failed: ${errorText(error)}`);
        continue;
      }
      const missed = messages
        .filter((message) => isString(message.ts) && compareSlackTs(message.ts, lastTs) > 0)
        .sort((a, b) => compareSlackTs(a.ts!, b.ts!))
        .slice(0, BACKFILL_MESSAGES);
      for (const message of missed) {
        if (!input.active()) return;
        const event: SlackMessageEvent = {
          type: "message", channel, channel_type: channelType, ...message,
          ...(message.user_team ?? message.team ? { user_team: message.user_team ?? message.team } : {}),
        };
        await deliver({ headers: {}, body: JSON.stringify({ type: "event_callback", team_id: homeTeam, event }), transport: "socket" });
      }
      if (missed.length) context.log(`caught up ${missed.length} message(s) in ${lane.objectKey}`);
    }
  }

  const transport = options.socket
    ? createSlackSocketTransport({
      options: options.socket,
      appToken: (context) => context.credential.secrets?.[SLACK_APP_TOKEN_ENV] ?? null,
      afterReconnect: catchUp,
    })
    : undefined;

  // 找系统用这个幂等键发过的消息。
  async function findSent(target: Record<string, string>, key: string, context: ChannelAdapterContext): Promise<string | null> {
    const result = target.thread_ts
      ? await api("conversations.replies", { channel: target.channel, ts: target.thread_ts, include_all_metadata: true, limit: 200 }, context)
      : await api("conversations.history", { channel: target.channel, include_all_metadata: true, limit: 100 }, context);
    const messages = Array.isArray(result.messages) ? result.messages as SlackMessageEvent[] : [];
    const found = messages.find((message) => message.metadata?.event_type === SLACK_REPLY_METADATA_TYPE
      && message.metadata.event_payload?.idempotency_key === key);
    return found?.ts ?? null;
  }

  // 记忆沉淀（channels/memory.ts）：频道和私有频道里的线程（道里的消息和订阅频道的普通消息都算），私信不算。
  // 用户本人的话（self_reply）也算：线程里用户说过的话也是事实。
  const memorySpec: ChannelMemorySpec = {
    kinds: {
      [SLACK_EVENT_KINDS.mention]: "message", [SLACK_EVENT_KINDS.thread]: "message", [SLACK_EVENT_KINDS.channel]: "message",
      [SLACK_EVENT_KINDS.followed]: "message",
      [SLACK_EVENT_KINDS.selfReply]: "message", [SLACK_EVENT_KINDS.edited]: "edited", [SLACK_EVENT_KINDS.deleted]: "deleted",
    },
    messageRef: (payload) => (isString(payload.ts) ? payload.ts : null),
    accepts: (payload) => (payload.channelType === "channel" || payload.channelType === "group")
      && isString(payload.channelId)
      && !excluded.has(payload.channelId, isString(payload.channelName) ? payload.channelName : null),
    conversationName: (payload) => (isString(payload.channelName) ? `#${payload.channelName}` : isString(payload.channelId) ? payload.channelId : "频道"),
  };

  const kind = (name: string, description: string) => ({
    kind: name, sources: [SLACK_SOURCE], payload: channelInboundPayload(SlackFields), description,
  });

  return {
    id: SLACK_SOURCE,
    label: "Slack",
    kind: "conversation",
    auth: { connectionProvider: "slack", secrets: SLACK_SECRET_NAMES },
    capabilities: { reply: true, retract: true, edit: true, react: true, history: true },
    eventKinds: [
      kind(SLACK_EVENT_KINDS.dm, "别人在 Slack 里给用户发了私信（或者在用户在的群聊里发了消息）。"),
      kind(SLACK_EVENT_KINDS.mention, "别人在 Slack 的频道里提到了用户。"),
      kind(SLACK_EVENT_KINDS.selfReply, "用户本人在 Slack 里说了话（echo=true 时是系统替用户发的回复被推回来）。对应的卡「别处已处理」。"),
      kind(SLACK_EVENT_KINDS.thread, "别人在用户的 Slack 线程（已经有道）里发了后续消息，没有提到用户。"),
      kind(SLACK_EVENT_KINDS.edited, "别人改了 Slack 道里（或者订阅频道的线程里）的一条消息（text 是改后的文字，ts 是那条消息的）。只更新没结束的卡。"),
      kind(SLACK_EVENT_KINDS.deleted, "别人删了 Slack 道里（或者订阅频道的线程里）的一条消息（不带原文，ts 是那条消息的）。只更新没结束的卡。"),
      kind(SLACK_EVENT_KINDS.channel, "用户订阅的 Slack 频道（14 天内有过用户的对话）里，别人没有提到用户的普通消息。只记录。"),
      kind(SLACK_EVENT_KINDS.followed, "用户关注的 Slack thread（用户在里面发起或者回复过）里，别人没有提到用户的消息。只记录，沉淀进记忆。"),
    ],
    standingOrders: SEEDS,
    memory: memorySpec,
    // 每次读时现算（hub 每发一条消息读一次）：设置页改了 emoji 以后，下一条消息就用新的。
    get disclosureMark() {
      return disclosureMarkNow();
    },
    lookupDisclosureMark,
    resolveCredential,
    settings: createSlackSettings({
      api: options.api,
      ...(options.ownerName !== undefined ? { ownerName: options.ownerName } : {}),
      ...(options.assistantName !== undefined ? { assistantName: options.assistantName } : {}),
    }),
    ...(transport ? { transport } : {}),

    verify(delivery: ChannelDelivery, context: ChannelAdapterContext): boolean {
      const timestamp = delivery.headers["x-slack-request-timestamp"];
      const signature = delivery.headers["x-slack-signature"];
      const secret = context.credential.signingSecret;
      if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !secret) return false;
      if (Math.abs(now().getTime() - Number(timestamp) * 1000) > maxAgeMs) return false;
      const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${delivery.body}`).digest("hex")}`;
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    async parse(delivery: ChannelDelivery, context: ChannelAdapterContext): Promise<ChannelInbound[]> {
      const envelope = JSON.parse(delivery.body) as SlackEnvelope;
      // url_verification 等不是事件的请求：由接收请求的那一层回答。
      if (envelope.type !== "event_callback") return [];
      if (isString(envelope.team_id)) homeTeam ??= envelope.team_id;
      const event = envelope.event;
      if (!event || event.type !== "message" || !isString(event.channel)) return [];
      const channel = event.channel;
      const channelType = isString(event.channel_type) ? event.channel_type : "channel";
      if (event.subtype === "message_changed" || event.subtype === "message_deleted") {
        return amendment(envelope, event, channel, channelType, context);
      }
      if (!isString(event.ts)) return [];
      // 加入频道之类的系统消息不管。
      if (event.subtype && !MESSAGE_SUBTYPES.has(event.subtype)) return [];
      const self = context.credential.account;
      const text = slackMessageText(event);
      const place = placeOf(channel, channelType, event.ts, event.thread_ts);
      const fromSelf = Boolean(self) && event.user === self;
      const echo = event.metadata?.event_type === SLACK_REPLY_METADATA_TYPE || (fromSelf && await postedByUs(channel, event.ts));
      let kind: string;
      let role: ChannelInbound["role"];
      if (fromSelf && !echo && channelType === "im" && (await conversation(channel, context)).user === self) {
        // 用户发给自己的私信（用户 2026-10-30：「直接交给 Lead」）：是写给 Lead 的话，不是对别人的回复。hub 交给 daemon，
        // daemon 按用户本人的一轮交给 Lead。daemon 不收时（例如用户撤销了这个入口）hub 照用户本人的话处理。
        kind = SLACK_EVENT_KINDS.selfReply;
        role = "owner";
      } else if (echo || fromSelf) {
        kind = SLACK_EVENT_KINDS.selfReply;
        role = echo ? "echo" : "self_reply";
      } else if (place.direct) {
        kind = SLACK_EVENT_KINDS.dm;
        role = "message";
      } else if (self && text.includes(`<@${self}>`)) {
        kind = SLACK_EVENT_KINDS.mention;
        role = "message";
      } else if (place.thread && context.interest?.laneExists(place.objectKey)) {
        kind = SLACK_EVENT_KINDS.thread;
        role = "message";
      } else if (place.thread && context.interest?.followed(place.objectKey) && await followable(channel, context)) {
        // 用户关注的 thread（发起或者回复过）：只记录、沉淀进记忆。后来有人在这里提到用户时，上面的 mention 先认出来，
        // 开卡、开道；之后这个 thread 有道，按 thread 收，不会记两次（用户 2026-10-21）。
        kind = SLACK_EVENT_KINDS.followed;
        role = "message";
      } else if (await subscribed(channel, context)) {
        kind = SLACK_EVENT_KINDS.channel;
        role = "message";
      } else {
        return [];
      }
      // 用户本人在频道里说的话（不是私信，不是系统替用户发的）：照 Slack 的规则，发起或者回复一个 thread 就关注它。
      const follows = role === "self_reply" && !place.direct && await followable(channel, context);
      return [await inbound({
        envelope, message: event, channel, channelType, ts: event.ts, kind, role,
        deliveryId: `${channel}:${event.ts}`, text: await displayText(text, context), echo, occurredAt: occurred(envelope, event.ts), follows,
      }, context)];
    },

    // 找对话（Lead 代用户直接发消息，用户 2026-10-23）：人按名字、真名、显示名找，对话按名字找（只找用户所在的）。不区分大小写。
    async findConversations(query: string, context: ChannelAdapterContext): Promise<ChannelConversationCandidate[]> {
      const wanted = query.trim().toLowerCase();
      if (!wanted) return [];
      const self = context.credential.account;
      const matches = (...values: string[]) => values.some((value) => value.toLowerCase().includes(wanted));
      const found: ChannelConversationCandidate[] = [];
      for (const person of await directory(context)) {
        if (person.id === self || !matches(person.name, person.realName, person.displayName)) continue;
        found.push({
          id: `${SLACK_SOURCE}:@${person.id}`, kind: "person", label: person.realName || person.displayName || person.name,
          detail: person.title || null,
        });
        if (found.length >= FIND_MAX) return found;
      }
      for (const place of await membership(context)) {
        if (place.kind === "im" || !place.name || !matches(place.name)) continue;
        found.push({
          id: `${SLACK_SOURCE}:${place.id}:main`, kind: place.kind, label: place.kind === "group" ? place.name : `#${place.name}`,
          detail: place.private ? "私有频道" : null,
        });
        if (found.length >= FIND_MAX) break;
      }
      return found;
    },

    // 回给用户本人的话（用户发给自己的私信那一轮的回复）：Lead 写的 Markdown 换成 mrkdwn（用户 2026-10-30）。
    ownerReplyText: slackMrkdwnFromMarkdown,

    // 对话编号换成发消息的目标。私信某个人：先找已有的私信，没有时开一个（conversations.open，要 im:write）。
    async resolveConversation(id: string, context: ChannelAdapterContext): Promise<ChannelConversationTarget> {
      const person = PERSON_CONVERSATION.exec(id);
      if (person) {
        const userId = person[1]!;
        const name = await userName(userId, context);
        let channel = (await membership(context)).find((place) => place.kind === "im" && place.user === userId)?.id ?? null;
        if (!channel) {
          try {
            const opened = await api("conversations.open", { users: userId }, context);
            const value = (opened.channel as { id?: unknown } | undefined)?.id;
            channel = isString(value) ? value : null;
          } catch (error) {
            throw new Error(`和 ${name} 还没有私信对话，也打不开（${errorText(error)}）。缺 im:write 权限时，在应用的 OAuth & Permissions `
              + "的 User Token Scopes 里加上它，再重新安装；或者先在 Slack 里给他发一条");
          }
        }
        if (!channel) throw new Error(`打不开和 ${name} 的私信对话`);
        return {
          objectKey: `${SLACK_SOURCE}:${channel}:main`, target: { channel }, label: `${name}的私信`,
          audience: "direct", externalShared: (await conversation(channel, context)).externalShared,
        };
      }
      const place = PLACE_CONVERSATION.exec(id);
      if (!place) {
        throw new Error(`对话编号不对：${id}。要像 slack:@U123（私信这个人）、slack:C123:main（频道）、slack:C123:1792000000.000100（thread）`);
      }
      const [, channel, root] = place as unknown as [string, string, string];
      let label: string;
      // 会被谁看到、是不是外部共享（出站检验打分用）：私信、群聊、频道。
      const joined = (await membership(context)).find((candidate) => candidate.id === channel);
      const info = await conversation(channel, context);
      const audience = channel.startsWith("D") || joined?.kind === "im" ? "direct" as const : joined?.kind === "group" ? "group" as const : "channel" as const;
      if (channel.startsWith("D")) {
        const user = joined?.user;
        label = user ? `${await userName(user, context)}的私信` : "私信";
      } else {
        label = info.label;
      }
      const facts = { audience, externalShared: info.externalShared };
      return root === "main"
        ? { objectKey: `${SLACK_SOURCE}:${channel}:main`, target: { channel }, label, ...facts }
        : { objectKey: `${SLACK_SOURCE}:${channel}:${root}`, target: { channel, thread_ts: root }, label: `${label} 的 thread`, ...facts };
    },

    async history(request: ChannelHistoryRequest, context: ChannelAdapterContext): Promise<ChannelHistoryMessage[]> {
      const [source, channel, root] = request.objectKey.split(":");
      if (source !== SLACK_SOURCE || !isString(channel) || !channel || !isString(root)) throw new Error("slack: not a Slack conversation");
      const limit = Math.min(Math.max(Math.floor(request.limit), 1), HISTORY_MAX);
      // 给了 ref：取这条和它的 thread。没给：thread 的道取整个 thread，整段对话（main）取最近的。
      const thread = request.ref ?? (root === "main" ? null : root);
      // conversations.replies 从旧到新按页返回（limit 是页大小），conversations.history 从新到旧。thread 多取一页，
      // 留根消息和最近的回复；整段对话取最近的 limit 条。
      const result = thread
        ? await api("conversations.replies", { channel, ts: thread, limit: REPLIES_PAGE }, context)
        : await api("conversations.history", { channel, limit }, context);
      const sorted = (Array.isArray(result.messages) ? result.messages as SlackMessage[] : [])
        .filter((message) => isString(message.ts))
        .sort((a, b) => compareSlackTs(a.ts!, b.ts!));
      const messages = sorted.length <= limit ? sorted
        : thread ? [sorted[0]!, ...sorted.slice(sorted.length - limit + 1)] : sorted.slice(-limit);
      const self = context.credential.account;
      const out: ChannelHistoryMessage[] = [];
      for (const message of messages) {
        const mine = Boolean(self) && message.user === self;
        const ours = message.metadata?.event_type === SLACK_REPLY_METADATA_TYPE || (mine && posted.has(`${channel}:${message.ts}`));
        const id = isString(message.user) ? message.user : isString(message.bot_id) ? message.bot_id : "unknown";
        out.push({
          ref: message.ts!,
          at: new Date(Number(message.ts) * 1000).toISOString(),
          role: ours ? "assistant" : mine ? "me" : "them",
          sender: { id, name: mine ? "你" : isString(message.user) ? await userName(message.user, context) : id },
          text: (await displayText(slackMessageText(message), context)).slice(0, MESSAGE_TEXT_MAX),
        });
      }
      return out;
    },

    async send(request: ChannelOutboundRequest, sendOptions: { idempotencyKey: string }, context: ChannelAdapterContext): Promise<ChannelOutboundResult> {
      const channel = request.target.channel;
      if (!isString(channel)) throw new Error("slack: the target has no channel");
      if (request.action === "retract") {
        if (!isString(request.target.ts)) throw new Error("slack: nothing to retract (no ts)");
        const result = await options.api.call("chat.delete", { channel, ts: request.target.ts }, context.credential.token);
        if (result.ok === true) return { remoteRef: { channel, ts: request.target.ts }, duplicate: false };
        // 已经删掉了：重复调用是安全的。
        if (result.error === "message_not_found") return { remoteRef: { channel, ts: request.target.ts }, duplicate: true };
        throw new Error(`slack chat.delete: ${isString(result.error) ? result.error : "not ok"}`);
      }
      if (request.action === "unreact") {
        if (!isString(request.target.ts)) throw new Error("slack: nothing to unreact (no ts)");
        if (!isString(request.emoji) || !SLACK_EMOJI_NAME.test(request.emoji)) throw new Error("slack: removing a reaction needs an emoji name");
        const result = await options.api.call(
          "reactions.remove", { channel, timestamp: request.target.ts, name: request.emoji }, context.credential.token,
        );
        if (result.ok === true) return { remoteRef: { channel, ts: request.target.ts, emoji: request.emoji }, duplicate: false };
        // 本来就没有这个表情（撤过了）：重复调用是安全的。
        if (result.error === "no_reaction") return { remoteRef: { channel, ts: request.target.ts, emoji: request.emoji }, duplicate: true };
        throw new Error(`slack reactions.remove: ${isString(result.error) ? result.error : "not ok"}`);
      }
      if (request.action === "react") {
        if (!isString(request.target.ts)) throw new Error("slack: nothing to react to (no ts)");
        if (!isString(request.emoji) || !SLACK_EMOJI_NAME.test(request.emoji)) throw new Error("slack: the reaction needs an emoji name");
        const result = await options.api.call(
          "reactions.add", { channel, timestamp: request.target.ts, name: request.emoji }, context.credential.token,
        );
        if (result.ok === true) return { remoteRef: { channel, ts: request.target.ts, emoji: request.emoji }, duplicate: false };
        // 已经回过同一个表情：重复调用是安全的。
        if (result.error === "already_reacted") return { remoteRef: { channel, ts: request.target.ts, emoji: request.emoji }, duplicate: true };
        throw new Error(`slack reactions.add: ${isString(result.error) ? result.error : "not ok"}`);
      }
      if (!isString(request.text)) throw new Error("slack: a reply needs text");
      if (request.action === "edit") {
        if (!isString(request.target.ts)) throw new Error("slack: nothing to edit (no ts)");
        // 同样的内容改两次结果一样，所以改写本身是幂等的。不带署名的样式时清掉原来的 blocks（不传时 Slack 会留着旧的）。
        const result = await options.api.call("chat.update", {
          channel, ts: request.target.ts, text: request.text,
          blocks: request.parts ? slackDisclosureBlocks(request.parts) : [],
        }, context.credential.token);
        if (result.ok === true) return { remoteRef: { channel, ts: request.target.ts }, duplicate: false };
        const error = isString(result.error) ? result.error : "not ok";
        // 消息没了、不是自己的、过了能改的时间：再试也一样。
        if (SLACK_EDIT_GONE.has(error)) throw new ChannelTargetGoneError(`slack chat.update: ${error}`);
        throw new Error(`slack chat.update: ${error}`);
      }
      const existing = await findSent(request.target, sendOptions.idempotencyKey, context);
      if (existing) {
        rememberPosted(channel, existing);
        return { remoteRef: { channel, ts: existing }, duplicate: true };
      }
      const result = await trackPosting(channel, api("chat.postMessage", {
        channel,
        ...(request.target.thread_ts ? { thread_ts: request.target.thread_ts } : {}),
        text: request.text,
        ...(request.parts ? { blocks: slackDisclosureBlocks(request.parts) } : {}),
        metadata: { event_type: SLACK_REPLY_METADATA_TYPE, event_payload: { idempotency_key: sendOptions.idempotencyKey } },
      }, context));
      if (!isString(result.ts)) throw new Error("slack chat.postMessage: no ts in the response");
      rememberPosted(channel, result.ts);
      return { remoteRef: { channel, ts: result.ts }, duplicate: false };
    },
  };
}

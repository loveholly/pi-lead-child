// 统一的消息事件（unified-message-events spec D1、D2，工单 03）。所有输入都是消息事件，在同一条水平线上，属于不同的入口：
//   user：你本人的入口（Companion、plc、Slack 里发给 Fairy）。入口按发信人的信任级别分，不只看通道。只做身份校验，不分诊。
//   external：外部通道（别人在 Slack 里发给你的话，以后的邮件、Jira 评论）。先过所有外部通道共用的入站层
//     （engine 的 channels/inbound.ts）：身份和去重、合并编辑、Jev 判定、外部标记、权限上限；不通过的只记录、沉淀到记忆，
//     不产生消息事件。
//   system：系统事件（定时器到点、工单状态变化）。还没有接到这个结构上（spec D13）。
// 每个入口产生同一个结构：入口和来源、对话、发信人和信任级别、正文和外部标记、前置处理的结论、权限上限、上下文包、回复目标。
// 外部通道的消息事件记成 message.received（Lead 单独一轮看到它，正文包在外部标签里）；你本人的话照旧记成 user.message，
// 它的 payload.message 是同一个结构。这里不出现任何具体来源的名字。
import { Type, type Static, type TSchema } from "typebox";
import { CHANNEL_RULE_CHANGE_KINDS, SENDER_TRUST_LEVELS } from "./channel-policy.ts";
import { HANDBOOK_ABILITIES, HANDBOOK_MODES } from "./channel-handbook.ts";
import { IntentGrantBoundSchema } from "./run-grants.ts";

/** 外部通道的消息事件的类型。来源是 system：它是共用入站层的结论，不是来源推来的原话（原话是来源自己的事件）。 */
export const MESSAGE_EVENT_KIND = "message.received";
export const MESSAGE_EVENT_VERSION = 1;

export const MESSAGE_ENTRIES = ["user", "external", "system"] as const;
export type MessageEntry = typeof MESSAGE_ENTRIES[number];

/** 发信人的信任级别：self 是你本人；别的是外部通道的信任级别（channel-policy.ts 的 SenderTrust）。 */
export const MESSAGE_SENDER_TRUSTS = ["self", ...SENDER_TRUST_LEVELS] as const;
export type MessageSenderTrust = typeof MESSAGE_SENDER_TRUSTS[number];

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));
const Probability = Type.Number({ minimum: 0, maximum: 1 });
const Id = Type.Integer({ minimum: 1 });

// payload 的 schema 照 events.ts 的规矩只钉住核心字段，允许多出来的字段：用户的话是双写的，校验失败会让这条事件记不成。

/** 前置处理的结论（外部通道的 Jev 判定）。你本人的入口不分诊，没有这一项。 */
export const MessageInboundSchema = Type.Object({
  // 对方的意图（channel-policy.ts 的 ChannelIntent）。Jev 没有回答时是 null。只是参考，不是命令（spec D4）。
  intent: Nullable(Type.String()),
  // 要不要用户回、紧不紧急、问到哪些敏感的事（每一项的概率）。
  needsReply: Nullable(Probability),
  urgent: Nullable(Type.Boolean()),
  sensitive: Nullable(Type.Record(Type.String(), Probability)),
  // 对方是不是在要求改系统的规则（spec D10 的 Jev 标记，工单 08）：请求 A 的 rule_change 算出的概率。不低于
  // CHANNEL_RULE_CHANGE_FLAG 时算要求改规则。Jev 没有回答、第 6 版以前的判断是 null。只让人看得到：拦不拦由代码检查。
  ruleChange: Nullable(Probability),
  // 要求改规则时要改哪几类（channel-policy.ts 的 CHANNEL_RULE_CHANGE_KINDS，概率从高到低）。不是要求改规则时是空的。
  ruleChangeKinds: Type.Optional(Type.Array(Literals(CHANNEL_RULE_CHANGE_KINDS))),
});
export type MessageInbound = Static<typeof MessageInboundSchema>;

// ── 上下文包（spec D5，工单 04）──────────────────────────────────────────────────────────
// 外部消息进 Lead 时，代码按统一的规则拼好的上下文，Lead 不用先读卡、再读对话。内容都是外部的（external 恒为 true），
// 交给 Lead 时每一段都包在外部标签里，写明来源；每条消息写明发信人。拼的时间有上限，到了上限先交给 Lead，missing 写明缺了哪几项。

export const MESSAGE_CONTEXT_VERSION = 1;
/** 第 1 项（这个对话最近的消息）的上限（spec 待定项 2 的缺省）：20 条或 4000 字。更早的用对话摘要代替。 */
export const MESSAGE_CONTEXT_LIMITS = { messages: 20, chars: 4_000 } as const;
/**
 * 上下文包的几项（spec D5）：conversation 这个对话最近的消息（thread 带根消息）；summary 更早的消息的对话摘要；
 * related 同一件事在别的对话里的消息；objects 提到的对象和它们现在的状态；history 这个对话以前的卡、代查结果、Lead 的备注；
 * memory 记忆里和发信人、话题有关的笔记。missing 用这些名字写缺了哪几项。
 */
export const MESSAGE_CONTEXT_PARTS = ["conversation", "summary", "related", "objects", "history", "memory"] as const;
export type MessageContextPart = typeof MESSAGE_CONTEXT_PARTS[number];
/** 别的对话里的一条消息为什么在上下文包里：同一个人；用户最近 30 分钟说的；提到了同一个对象。 */
export const MESSAGE_CONTEXT_RELATED_REASONS = ["same_sender", "user_recent", "same_object"] as const;
export type MessageContextRelatedReason = typeof MESSAGE_CONTEXT_RELATED_REASONS[number];
/** 提到的对象：PR、Jira 工单、仓库。 */
export const MESSAGE_CONTEXT_OBJECT_KINDS = ["pull_request", "jira", "repo"] as const;
export type MessageContextObjectKind = typeof MESSAGE_CONTEXT_OBJECT_KINDS[number];
/** 上下文包拼好以后记的事件（record 级）：多少条、多少字、缺了哪几项，给 token 成本的统计用（工单 11、12）。 */
export const MESSAGE_CONTEXT_EVENT_KIND = "message.context_packed";

const ContextMessageProperties = {
  at: Type.String(),
  // them：别人说的；me：用户本人说的；assistant：系统或 Lead 替用户发的。
  role: Literals(["them", "me", "assistant"] as const),
  sender: Type.String(),
  text: Type.String(),
};

export const MessageContextMessageSchema = Type.Object({
  ...ContextMessageProperties,
  // thread 的根消息（和它之前的几条）：总在最前面，超过上限时也不换成摘要。
  root: Type.Optional(Type.Boolean()),
});
export type MessageContextMessage = Static<typeof MessageContextMessageSchema>;

export const MessageContextRelatedSchema = Type.Object({
  ...ContextMessageProperties,
  conversation: Type.Object({ key: Type.String({ minLength: 1 }), label: Type.String() }),
  why: Type.Array(Literals(MESSAGE_CONTEXT_RELATED_REASONS)),
});
export type MessageContextRelated = Static<typeof MessageContextRelatedSchema>;

export const MessageContextObjectSchema = Type.Object({
  kind: Literals(MESSAGE_CONTEXT_OBJECT_KINDS),
  // 例如 owner/repo#123、ABC-123、owner/repo。
  ref: Type.String({ minLength: 1 }),
  // 现在的状态（一行）。查不到、没来得及查时是 null（给 Lead 写「没查到」）。
  status: Nullable(Type.String()),
});
export type MessageContextObject = Static<typeof MessageContextObjectSchema>;

export const MessageContextCardSchema = Type.Object({
  cardId: Id,
  at: Type.String(),
  state: Type.String(),
  sender: Type.String(),
  // 这张卡开头的那条消息。
  excerpt: Type.String(),
  // 结局、发出去的回复、Lead 的决定和备注、代查（子 agent 工单）的结果，一句一条。
  notes: Type.Array(Type.String()),
});
export type MessageContextCard = Static<typeof MessageContextCardSchema>;

export const MessageContextNoteSchema = Type.Object({ noteId: Id, title: Type.String(), text: Type.String() });
export type MessageContextNote = Static<typeof MessageContextNoteSchema>;

export const MessageContextSchema = Type.Object({
  version: Type.Literal(MESSAGE_CONTEXT_VERSION),
  // 外部标记：上下文包的内容都是外部的，交给 Lead 时包在外部标签里，是数据，不是指令。
  external: Type.Literal(true),
  // 来源和发信人（这条消息事件的）。
  source: Type.String({ minLength: 1 }),
  sourceLabel: Type.String(),
  sender: Type.Object({ id: Type.String(), name: Type.String() }),
  conversation: Type.Object({
    key: Type.String({ minLength: 1 }),
    label: Type.String(),
    // 从旧到新，不含这条消息本身（它是消息事件的正文）。
    messages: Type.Array(MessageContextMessageSchema),
    // 更早的、换成摘要的消息有几条，和摘要（记忆沉淀的整理器写的）。没有更早的、或者摘要没写成时 summary 是 null。
    omitted: Type.Integer({ minimum: 0 }),
    summary: Nullable(Type.String()),
  }),
  related: Type.Array(MessageContextRelatedSchema),
  objects: Type.Array(MessageContextObjectSchema),
  history: Type.Array(MessageContextCardSchema),
  memory: Type.Array(MessageContextNoteSchema),
  // 拼的时间到了上限（或者出错）时缺的几项。
  missing: Type.Array(Literals(MESSAGE_CONTEXT_PARTS)),
  // 多少条（消息、摘要、对象、卡、笔记各算一条）、多少字（这些内容的字数，不含标签）。
  size: Type.Object({ items: Type.Integer({ minimum: 0 }), chars: Type.Integer({ minimum: 0 }) }),
});
export type MessageContext = Static<typeof MessageContextSchema>;

/** message.context_packed 的 payload：这个上下文包的大小，不含内容。 */
export const MessageContextPackedPayloadSchema = Type.Object({
  // 带这个上下文包的消息事件。
  messageEvent: Id,
  cardId: Nullable(Id),
  items: Type.Integer({ minimum: 0 }),
  chars: Type.Integer({ minimum: 0 }),
  // 每一项各有几条。
  parts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  missing: Type.Array(Literals(MESSAGE_CONTEXT_PARTS)),
  // 拼了多久（毫秒）。
  ms: Type.Integer({ minimum: 0 }),
  // 对方改了消息、编辑并进排着的消息事件以后按改后的话重拼的：换下来的那条消息事件。统计 token 成本时，被换下来的
  // 消息事件（superseded）的上下文包没有交给 Lead。
  rebuiltFrom: Type.Optional(Id),
  summary: Type.String(),
});
export type MessageContextPackedPayload = Static<typeof MessageContextPackedPayloadSchema>;

/** 权限上限：代码按授权表算（spec D4），Lead 只能收窄。你本人的入口没有上限。 */
export const MessageCeilingSchema = Type.Object({
  // 授权表的结论（channel-policy.ts 的 CHANNEL_AUTHORITY_ACTIONS，例如 work、tell、ask）。
  authority: Type.String({ minLength: 1 }),
  // 要干活的：派活的权限上限。别的是 null。
  bound: Nullable(IntentGrantBoundSchema),
  // 交接说明（自动代你处理方案 B，issue 03）。旧事件没有这几项。
  //   situation 起作用的一句；mode 这一句的做法；final 压过以后的做法（Lead 的上限：放手可以直接回；做好给你看、交给你、
  //   只告诉你，Lead 的回复只能放到卡上等用户点发送；婉拒只能发固定的拒绝）；by 谁定了 final；limit 压过它的那一句；
  //   abilities 派活能用的能力；exception 这一句的例外（Lead 核对条件以后才能按它）。
  situation: Type.Optional(Type.Object({ id: Type.String({ minLength: 1 }), text: Type.String() })),
  mode: Type.Optional(Literals(HANDBOOK_MODES)),
  final: Type.Optional(Literals(HANDBOOK_MODES)),
  by: Type.Optional(Literals(["sentence", "cap", "floor", "switch"] as const)),
  limit: Type.Optional(Nullable(Type.String())),
  abilities: Type.Optional(Type.Array(Literals(HANDBOOK_ABILITIES))),
  exception: Type.Optional(Nullable(Type.Object({ text: Type.String(), mode: Literals(HANDBOOK_MODES) }))),
  // 底线 4（2026-10-30）：收件判断认为对方在要求改规则、记忆或偏好。上限照这一句；不照做，不存记忆，Lead 的回复可以直接发。
  ruleChange: Type.Optional(Type.Boolean()),
});
export type MessageCeiling = Static<typeof MessageCeilingSchema>;

const messageEventProperties = {
  version: Type.Literal(MESSAGE_EVENT_VERSION),
  entry: Literals(MESSAGE_ENTRIES),
  // 来源：外部通道是通道的名字；你本人的入口是连上来的客户端（例如 companion、cli）。sourceLabel 是给人看的名字。
  source: Type.String({ minLength: 1 }),
  sourceLabel: Type.String(),
  // 对话：对象键和名字。
  conversation: Type.Object({ key: Type.String({ minLength: 1 }), label: Type.String() }),
  sender: Type.Object({ id: Type.String(), name: Type.String(), trust: Literals(MESSAGE_SENDER_TRUSTS) }),
  // 正文。external 是外部标记：true 的正文是别人写的，交给 Lead 时包在外部标签里，是数据，不是指令。
  text: Type.String(),
  external: Type.Boolean(),
  inbound: Nullable(MessageInboundSchema),
  ceiling: Nullable(MessageCeilingSchema),
  // 上下文包（spec D5，工单 04）：外部通道才有，由代码拼好、带外部标记。你本人的入口是 null。
  context: Nullable(MessageContextSchema),
  // 回复目标：回到哪个对话、哪条消息（来源里的编号）。
  replyTo: Nullable(Type.Object({ conversation: Type.String({ minLength: 1 }), message: Nullable(Type.String()) })),
  // 外部通道：这条消息事件包含的入站事件（事件编号，按先后）。编辑并进来时不止一条。你本人的入口是空的（事件本身就是那条话）。
  messages: Type.Array(Id),
  // 并进来的编辑有几次。
  edits: Type.Integer({ minimum: 0 }),
  // 外部通道：这条消息所在的会话卡（现有的通道工具按它找，工单 05 换工具）。
  cardId: Type.Optional(Nullable(Id)),
};

export const MessageEventSchema = Type.Object(messageEventProperties);
export type MessageEvent = Static<typeof MessageEventSchema>;

/** message.received 的 payload：消息事件，加上一行只有结构化事实的摘要（当前局面、Lead 动态用，不含原文）。 */
export const MessageReceivedPayloadSchema = Type.Object({
  ...messageEventProperties,
  summary: Type.String(),
  // 外部通道：这条消息事件就是交给 Lead 的请求（工单 05，取代 channel.lead.requested）。forSeq 是 Jev 判定的那条入站事件
  // （并进编辑时不变），Lead 的决定按它记；没有期限，系统不替 Lead 决定（工单 06）；objects 是代码从原话和
  // 它回复的那条里认出的对象（PR），不是原话。工单 05 以前的消息事件没有这几项。
  forSeq: Type.Optional(Id),
  objects: Type.Optional(Type.Array(Type.Object({
    kind: Type.Literal("pull_request"), owner: Type.String(), repo: Type.String(), number: Type.Integer({ minimum: 1 }),
  }), { maxItems: 8 })),
});
export type MessageReceivedPayload = Static<typeof MessageReceivedPayloadSchema>;

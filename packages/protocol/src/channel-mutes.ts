// 静音一个外部对话（工单 #533，2026-11-25）。一个对话（对象键，例如 slack:C123:<thread 的 ts>）静音期间，
// 它的消息照常记成事件、进道的上下文，但不开卡、不叫醒 Lead、不调快模型（紧急程度、收件判断都不问）。到点自动恢复。
// 两种开始：
//   - 熔断（breaker）：同一个对话在 breakerWindowMs 里叫醒 Lead breakerWakes 次（交给 Lead 的消息事件），Lead 每次的结论都是
//     不用管（处置 no_action），系统把它静音 breakerMuteMs。在「Lead 动态」里告诉用户，卡上带「取消静音」。
//   - Lead 自己静音（channel_conversation 的 mute 操作）：最长 maxMuteMs。在「Lead 动态」里记一笔，卡上带「撤销」。
//     这个操作只减少处理、不放开权限，外部消息叫醒的一轮也能做；但那一轮只能静音叫醒它的那个对话。
// 参数都在常设指令 channel.mute 里（系统种子写缺省值，读不到时用 CHANNEL_MUTE_DEFAULTS）。
//
// 这个文件只依赖 typebox 和同包的 events.ts，companion 也读它。
import { Type, type Static, type TProperties } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const MINUTE = 60_000;

// 熔断和静音的参数（常设指令 channel.mute 的 params）。
export const ChannelMuteParamsSchema = StrictObject({
  // 熔断看多长的一段时间。
  breakerWindowMs: Type.Integer({ minimum: MINUTE, maximum: 24 * 60 * MINUTE }),
  // 这段时间里叫醒 Lead 几次（每次都不用管）就熔断。
  breakerWakes: Type.Integer({ minimum: 2, maximum: 100 }),
  // 熔断以后静音多久。
  breakerMuteMs: Type.Integer({ minimum: MINUTE, maximum: 24 * 60 * MINUTE }),
  // Lead 静音一个对话最长多久。
  maxMuteMs: Type.Integer({ minimum: MINUTE, maximum: 24 * 60 * MINUTE }),
});
export type ChannelMuteParams = Static<typeof ChannelMuteParamsSchema>;

// 用户 2026-11-25 定的数：10 分钟里叫醒 5 次都不用管，静音 30 分钟；Lead 最长静音 120 分钟。
export const CHANNEL_MUTE_DEFAULTS: ChannelMuteParams = {
  breakerWindowMs: 10 * MINUTE,
  breakerWakes: 5,
  breakerMuteMs: 30 * MINUTE,
  maxMuteMs: 120 * MINUTE,
};

// 谁静音的：熔断、Lead、用户本人。
export const CHANNEL_MUTE_BY = ["breaker", "lead", "user"] as const;
export type ChannelMuteBy = typeof CHANNEL_MUTE_BY[number];

export const CHANNEL_MUTE_STARTED_KIND = "channel_mute.started";
export const CHANNEL_MUTE_ENDED_KIND = "channel_mute.ended";

// 静音事件的对象：同一个对话的开始和取消落在同一张「Lead 动态」卡上，原地更新。
export const channelMuteEntityKey = (objectKey: string): string => `channel_mute:${objectKey}`;

export const ChannelMuteStartedPayloadSchema = Type.Object({
  // 静音的对话（对象键）和它的名字（道的名字，例如「#perf 里的讨论」；没有道时是对象键）。
  conversation: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  by: Type.Union(CHANNEL_MUTE_BY.map((by) => Type.Literal(by))),
  until: Type.String({ minLength: 1 }),
  minutes: Type.Integer({ minimum: 1 }),
  reason: Type.String(),
  // 熔断：这段时间里叫醒 Lead 的消息事件（seq）。别的开始方式没有。
  wakes: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
  summary: Type.String(),
});
export type ChannelMuteStartedPayload = Static<typeof ChannelMuteStartedPayloadSchema>;

export const ChannelMuteEndedPayloadSchema = Type.Object({
  conversation: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  // 谁取消的。到点自动恢复不写这条事件。
  by: Type.Union([Type.Literal("lead"), Type.Literal("user")]),
  // 取消的是哪一次静音（channel_mute.started 的 seq）。
  startedSeq: Type.Integer({ minimum: 1 }),
  reason: Type.String(),
  summary: Type.String(),
});
export type ChannelMuteEndedPayload = Static<typeof ChannelMuteEndedPayloadSchema>;

export const CHANNEL_MUTE_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    // 级别由写入方定：digest，在「Lead 动态」里出现一张卡（熔断的带「取消静音」，Lead 的带「撤销」）。
    // 类型不以 channel. 开头：它是系统或 Lead 写的话，不带别人的原文，叫醒的一轮不算外部的一轮。
    kind: CHANNEL_MUTE_STARTED_KIND,
    sources: ["system", "lead"],
    payload: ChannelMuteStartedPayloadSchema,
    description: "一个外部对话开始静音：熔断（反复叫醒 Lead 都不用管）或者 Lead 静音了它。静音期间消息只记录，到点自动恢复。",
  },
  {
    kind: CHANNEL_MUTE_ENDED_KIND,
    sources: ["system", "lead"],
    payload: ChannelMuteEndedPayloadSchema,
    description: "一个外部对话的静音被提前取消（用户点了取消静音或撤销，或者 Lead 取消了）。",
  },
];

for (const definition of CHANNEL_MUTE_EVENT_KINDS) registerEventKind(definition);

// 入站事件的 payload（工单 11）：hub 写事件时补上的字段，加上适配器自己的结构化字段。来源插件注册事件类型时用它。
import { Type, type TProperties } from "typebox";

// 紧急程度的依据（urgency.ts 的 ChannelUrgencyBasis）。
const UrgencyBasis = Type.Object({
  by: Type.Union([Type.Literal("smart_model"), Type.Literal("fallback"), Type.Literal("not_asked")]),
  reason: Type.Union([Type.String(), Type.Null()]),
  backend: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  probability: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  threshold: Type.Number({ minimum: 0, maximum: 1 }),
  fallbackFrom: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  questionVersion: Type.Integer({ minimum: 1 }),
});

/**
 * 一个入站事件类型的 payload schema。extra 是适配器自己的字段（ChannelInbound.fields）。允许多出来的字段。
 * 内核的字段写在 extra 后面：适配器声明了同名的字段，也以内核的为准。
 */
export function channelInboundPayload<T extends TProperties>(extra: T) {
  return Type.Object({
    ...extra,
    role: Type.Union([Type.Literal("message"), Type.Literal("self_reply"), Type.Literal("echo")]),
    laneLabel: Type.String(),
    sender: Type.Object({ id: Type.String(), name: Type.String(), trust: Type.String(), bot: Type.Optional(Type.Boolean()) }),
    text: Type.String(),
    summary: Type.String(),
    // 紧急程度只由内核定（urgency.ts）。别人发来的消息带依据 urgency；用户本人的话、推回来的回复是 false，没有依据。
    urgent: Type.Boolean(),
    urgency: Type.Optional(UrgencyBasis),
    // 这条消息自己在来源里的引用（回表情用），和它回复的是哪一条（拼上下文用）。见 ChannelInbound。
    messageRef: Type.Optional(Type.Record(Type.String(), Type.String())),
    messageId: Type.Optional(Type.String()),
    // 谁看得到回复：direct 1 对 1 私信；group 群聊；channel 频道。见 ChannelInbound.audience。
    audience: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")])),
    replyTo: Type.Optional(Type.Object({ objectKey: Type.String(), ref: Type.String() })),
    // 要开卡的消息，先判断要不要用户回，再开卡（hub 的 settlePendingCard）：判断以前记下开卡要用的投递方式和回复的位置。
    cardPending: Type.Optional(Type.Object({
      delivery: Type.String(), replyTarget: Type.Record(Type.String(), Type.String()), at: Type.String(),
    })),
  });
}

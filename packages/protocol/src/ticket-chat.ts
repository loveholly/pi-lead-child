// 工单对话（Lead 事件主干 spec D13，工单 08）。
//
// 工单对话里的消息一律交给这张工单的 agent（用户 2026-10-19 的决定）：有 Run 在跑时交给那个 Run，没有时开一个
// 对话 Run，续接最近的会话。agent 的输入开头是系统现在的 TicketSummary。daemon 不按消息的内容分流，也不交给 Lead。
// 以前这里用正则和关键词表猜消息的意图（进展问题、问句交给 Lead），那是主会话自己定的，用户没有要求过。
//
// agent 的一轮回答结束以后，daemon 用 SmartModel 判断这段回复是不是在等你决定要不要做工单的某个动作
// （daemon 的 ticket-reply-actions.ts）。判断的结果记成一条事件，客户端在这一轮回复下面给这些动作的按钮。
import { Type, type Static } from "typebox";

import { KernelRuntimeIdSchema } from "./runtime-ids.ts";

// chat.send 的 context.answerer：工单 08 的第一版让你选由 Lead 还是执行 agent 回答。
// 2026-10-19 起 daemon 不再宣布 TICKET_CHAT_ANSWERER_CAPABILITY，新客户端不再带这个字段。
// 它是已发布的线上契约：命令的 schema 继续接受它（旧客户端带了也不报错），daemon 忽略它。
export const TicketChatAnswererSchema = Type.Union([Type.Literal("lead"), Type.Literal("agent")]);
export type TicketChatAnswerer = Static<typeof TicketChatAnswererSchema>;
export const TICKET_CHAT_ANSWERER_CAPABILITY = "chat.ticket-answerer.v1";

// 没有 Run 在跑时，工单消息续接的是哪一个已结束的会话（GET /v1/tickets/:id 的 chatResume）。
// lastTokens：这个会话上一次 Run 用了多少 token，输入框用它估算这次的成本；拿不到时是 null。
export const TicketChatResumeSchema = Type.Object({
  attemptId: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("executor"), Type.Literal("reviewer")]),
  runtime: KernelRuntimeIdSchema,
  lastTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type TicketChatResume = Static<typeof TicketChatResumeSchema>;

// ── 回复下面的动作按钮（2026-10-19）──────────────────────────────────────────────────────────────
// SmartModel 只在这一组动作里判断。id 和 companion 的 TicketOptionId 一致（决策卡上的选项）。
// 按钮永远来自工单当前的选项：模型只决定显示哪几个，不会造出工单现在做不了的动作。
export const TICKET_REPLY_ACTION_IDS = [
  "request_review", "complete", "rework", "cancel", "stop", "start", "restore",
] as const;
export type TicketReplyActionId = typeof TICKET_REPLY_ACTION_IDS[number];
export const TicketReplyActionIdSchema = Type.Union([
  Type.Literal("request_review"), Type.Literal("complete"), Type.Literal("rework"), Type.Literal("cancel"),
  Type.Literal("stop"), Type.Literal("start"), Type.Literal("restore"),
]);

export function isTicketReplyActionId(value: unknown): value is TicketReplyActionId {
  return typeof value === "string" && (TICKET_REPLY_ACTION_IDS as readonly string[]).includes(value);
}

// 判断结果的事件（record 级，source 是 ticket）。payload：turnId、itemId、actions。correlation_id 是 turn:<turnId>。
export const TICKET_REPLY_ACTIONS_KIND = "ticket_agent.reply_actions";
export const ticketReplyActionsCorrelation = (turnId: string): string => `turn:${turnId}`;

// GET /v1/conversation/turns?include=reply_actions：工单 agent 的轮次带上 replyActions。
// 旧客户端按 StrictObject 校验每一轮，多一个字段整页失败，所以只在客户端要时才给。旧 daemon 不认识这个取值，回 400。
export const TICKET_REPLY_ACTIONS_INCLUDE = "reply_actions";
// 判断结果写进账本以后，网关推一条 snapshot.required（resource 是这个，带 ticketId 和 turnId），
// 客户端据此重取这张工单的对话。只发给在事件流上声明了 include=reply_actions 的连接（index.ts 的 gatewayEventOptIn）：
// 旧客户端不认识这个 resource，会当成「全部重取」。
export const TICKET_REPLY_ACTIONS_RESOURCE = "ticket-reply-actions";
export const TICKET_REPLY_ACTIONS_OPT_IN = "reply_actions";

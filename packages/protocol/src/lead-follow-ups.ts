// Lead 忙时用户排着的追问（pi 的 followUp，工单 04 的「排队」）。主对话输入框上方的状态栏，每一行有两个操作（用户 2026-10-28）：
//   steer：把这一条插进 Lead 正在做的这一轮（变成 pi 的 steer）。和用户发送时选「插话」的结果一样，placement 变成 steered。
//   cancel：这一条不再发给 Lead，Lead 不回答它。用户的话照旧留在会话里（Lead 永远不能删掉用户说过的话），placement 变成 cancelled。
// 两个操作是操作层的 follow_up 目标（engine 的 ui-actions/catalog.ts），页面走 POST /v1/lead/follow-ups/steer、
// POST /v1/lead/follow-ups/cancel，Lead 走 perform_action。
//
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 用户的一条消息现在怎么放的（工单 04，spec D10）。lead.turn.started 的 payload.placement 也用这些值：
// 界面据此在用户的消息下面写「排队中」「已插入」「下一轮回答」，没有自己回答的写「和下一条一起回答」。
//   queued：排着队，Lead 答完这一轮再放进去；steered：插进了正在跑的一轮（已插入）；
//   next_turn：插话赶不上这一轮，转为下一轮的输入；delivered：排队的消息送到了，Lead 开始答它；
//   answered_together：没有自己的回答，和另一条一起答了；
//   cancelled：用户取消了这一条排着的追问，Lead 不会回答它（2026-10-28）。
// 加值的规矩：旧客户端严格校验 ConversationTurnSchema，会拒绝不认识的值（cancelled 就是这样）；lead.turn.started 的
// payload 校验是开放的，旧客户端把不认识的值当作没有。网页端跟着 daemon 一起更新。
export const TurnPlacementSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("steered"), Type.Literal("next_turn"), Type.Literal("delivered"),
  Type.Literal("answered_together"), Type.Literal("cancelled"),
]);
export type TurnPlacement = Static<typeof TurnPlacementSchema>;

/** daemon 支持排着的追问的两个操作时，在 hello.v2 的 capabilities 里报它。客户端据此显示「Steer」和「×」。 */
export const CHAT_FOLLOW_UP_ACTIONS_CAPABILITY = "chat.follow-up-actions.v1";

// 排着的追问的操作：插进这一轮，或者不再发给 Lead。
export const FollowUpActionSchema = Type.Union([Type.Literal("steer"), Type.Literal("cancel")]);
export type FollowUpAction = Static<typeof FollowUpActionSchema>;

// POST /v1/lead/follow-ups/steer、/v1/lead/follow-ups/cancel 的请求体：用户那一轮的 turn id。
export const FollowUpActionRequestSchema = StrictObject({ turnId: Type.String({ minLength: 1, maxLength: 200 }) });
export type FollowUpActionRequest = Static<typeof FollowUpActionRequestSchema>;

// 回答：这一条现在的放置。steer 以后是 steered，cancel 以后是 cancelled。
export const FollowUpActionResultSchema = StrictObject({
  turnId: Type.String(),
  placement: TurnPlacementSchema,
});
export type FollowUpActionResult = Static<typeof FollowUpActionResultSchema>;

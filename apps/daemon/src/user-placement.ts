// Lead 正在跑一轮时，用户发来的消息放在哪里（工单 04 的插话和排队，lead-tools-and-routing spec D16）。
// 2026-10-27 21:05：Lead 在一个读了 Slack 的跟进轮次里，用户说「1 分钟后提醒我」。消息被插进那一轮，那一轮的外部标记
// 按 pi 的一次运行算，于是用户本人的话也被当成外部的一轮：设提醒被拒，Lead 只能请用户「随便再发一条」。
// 现在：这一轮带着外部内容（外部消息叫醒的，或者读了对话、连接的结果）时，用户的消息不插进去，也不交给 pi 的
// followUp（它和这一轮在同一次运行里），而是等这一轮结束，由 daemon 开一轮只属于用户的（carryOverTurns）。
// 那一轮的来历是干净的：用户本人的权限（记偏好、设定时器、Lead 动手跑命令）都照常可用。
export type UserMessagePlacement = "start" | "steer" | "follow_up" | "own_turn_after";

export function userMessagePlacement(input: {
  busy: boolean;
  // 正在跑的这一轮是不是带着外部内容（turn-origin.ts 的 external）。
  external: boolean;
  // 用户选了「排队」。
  followUp: boolean;
}): UserMessagePlacement {
  if (!input.busy) return "start";
  if (input.external) return "own_turn_after";
  return input.followUp ? "follow_up" : "steer";
}

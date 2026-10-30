// 回复下面的动作按钮（复核 P1-9）。#66 的执行 agent 最后问「你要我现在就发起这次独立核查吗？」。
// 在工单对话里回答「好」只会再开一次对话 Run，对话 Run 不能改变工单状态；真正的按钮在决策卡上。
// 现在回复在等你决定要不要做某个动作时，回复下面直接给这个动作的按钮。
//
// 「回复在问哪几个动作」由 daemon 用快模型（SmartModel）判断（2026-10-19，daemon 的 ticket-reply-actions.ts），
// 结果在这一轮的 replyActions 里。以前这里用关键词表和「最后一段有问号」判断；用户说过，自然语言不用正则匹配。
//
// 按钮来自工单当前的选项（ticketStatePresentation，读的是 TicketSummary）：显示的是两者的交集。
// 模型只决定显示哪几个，不会造出工单现在做不了的动作。没有判断结果（还在判断、模型不可用）时不显示按钮，
// 决策卡上照样有真正的按钮。
import { TICKET_REPLY_ACTION_IDS, type TicketReplyActionId } from '@pi-lead-child/protocol';

import type { TicketOptionId } from './ticketState';

// 模型判断的每个动作都是决策卡上的一个选项。protocol 加了动作、这里没有对应的选项时，类型检查报错。
void (TICKET_REPLY_ACTION_IDS satisfies readonly TicketOptionId[]);

/** 模型说回复在问的动作 ∩ 工单现在能做的动作。顺序和传进来的选项一样。 */
export function replyActionButtons<T extends { id: TicketOptionId }>(
  asked: readonly TicketReplyActionId[] | null | undefined,
  options: readonly T[],
): T[] {
  if (!asked?.length) return [];
  const wanted = new Set<string>(asked);
  return options.filter((option) => wanted.has(option.id));
}

// 收件箱里哪些通知单独露出来。工单的当前状态是事实（items.stage、TicketSummary），通知是历史：
// 一条通知只在它还说明「现在要你做的事」时才单独出现。
//
// 实例上（2026-10-15）黄色通知卡在四个 tab 都出现，显示 42 条未确认通知里 id 最小的 3 条：
// 7 月的提醒、已完成的 #46「运行结束，但交接失败」、#51 的英文阻塞。#51 同时也在「需要你介入」里，
// 而且它有 9 条通知，确认一条又冒出下一条。
//
// 规则：
//   - 已确认的不出现。
//   - 提醒发出的通知合成一组；提醒已经确认或取消的不算。
//   - 不挂工单的通知单独列出，新的在前。
//   - 挂在工单上的通知：工单在等你（ticketTurn = user）时收进那一行；否则不出现，
//     工单详情里的记录还在。已结束的工单也是这样：历史通知不能把它拉回「需要你」。
// 这里只决定显示，不改库，不替用户确认。
import type { NotificationDto, TicketStatus, TicketSummary } from "./index.ts";
import { ticketTurn } from "./needs-user.ts";

export type InboxNotices = {
  /** 不挂工单的通知，新的在前。 */
  general: NotificationDto[];
  /** 提醒发出的通知，新的在前。收件箱合成一行。 */
  reminders: NotificationDto[];
  /** 等你的工单上的通知，按工单 id，新的在前。那一行显示「N 条通知」。 */
  byTicket: Record<number, NotificationDto[]>;
};

const CLOSED_REMINDER: ReadonlySet<TicketStatus> = new Set(["acked", "cancelled"]);

function newestFirst(left: NotificationDto, right: NotificationDto): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id - left.id;
}

export function inboxNotices(
  notifications: readonly NotificationDto[],
  tickets: readonly TicketSummary[],
  options: { reminderStages?: ReadonlyMap<number, TicketStatus> } = {},
): InboxNotices {
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const result: InboxNotices = { general: [], reminders: [], byTicket: {} };
  for (const notification of notifications) {
    if (notification.state === "acked") continue;
    if (notification.kind === "reminder") {
      const stage = notification.ticketId === null ? undefined : options.reminderStages?.get(notification.ticketId);
      if (stage === undefined || !CLOSED_REMINDER.has(stage)) result.reminders.push(notification);
      continue;
    }
    if (notification.ticketId === null) {
      result.general.push(notification);
      continue;
    }
    const ticket = ticketsById.get(notification.ticketId);
    if (!ticket || ticketTurn(ticket) !== "user") continue;
    (result.byTicket[ticket.id] ??= []).push(notification);
  }
  result.general.sort(newestFirst);
  result.reminders.sort(newestFirst);
  for (const list of Object.values(result.byTicket)) list.sort(newestFirst);
  return result;
}

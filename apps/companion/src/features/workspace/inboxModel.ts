// 收件箱（阶段 1）的视图模型。收件箱只回答「现在轮到我做什么」：每件等你的事一张卡，说清为什么、等了多久，
// 最多一个动作；做完就消失，可以清零。Lead 自己处理掉的事另列，不计数。
//
// 哪些工单在等你：ticketNeedsUser（Ticket.needsUser），和角标、会话底栏、工单 tab 的「等你」是同一组。
// 卡上的动作：详情决策卡的推荐动作（ticketDecision），不在这里另写一套。没有能一键做的，就打开工单。
import {
  ticketNeedsUserLabel,
  type InboxTicketFact,
  type LeadHandledEntry,
  type NotificationDto,
  type TicketNeedsUserReason,
  type WatchTimerDto,
} from '@pi-lead-child/protocol';

import { recommendedTicketOption, ticketDecision } from '@/features/tickets/ticketDecision';
import type { TicketOptionId, TicketOptionPresentation } from '@/features/tickets/ticketState';

import { ticketTitle, type Ticket } from './model';
import { milestoneChip } from './timelineModel';

export type InboxCardView = {
  ticketId: string;
  title: string;
  /** 「#72 · 需介入 · 等了 51 天」，有收起的通知时再加「· 2 条通知」。 */
  meta: string;
  reason: string | null;
  /** 最近的节点（阶段 3）：「提测 明天 18:00」。 */
  milestone: { text: string; overdue: boolean } | null;
  /** 一键动作；null 时卡上只有「查看」。 */
  action: TicketOptionPresentation | null;
  /** 收进这一行的通知。你在这一行上做了事（动作或查看），它们一起确认。 */
  noticeIds: number[];
};

// 能在收件箱里一键做的动作：后果在按钮上就说清了。返工要写原因、恢复要选范围、工作区动作要看状态，都去工单里做。
const ONE_TAP_OPTIONS: ReadonlySet<TicketOptionId> = new Set(['request_review', 'confirm', 'start', 'complete', 'ack']);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 等了多久，用最大的整单位：51 天、3 小时、12 分钟；不到一分钟是「刚刚」。 */
export function waitedText(since: string, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(since).getTime();
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return '刚刚';
  if (elapsed >= DAY) return `${Math.floor(elapsed / DAY)} 天`;
  if (elapsed >= HOUR) return `${Math.floor(elapsed / HOUR)} 小时`;
  return `${Math.floor(elapsed / MINUTE)} 分钟`;
}

// 审批会过期，排在最前；其余的等得越久越靠前。
function urgency(reason: TicketNeedsUserReason): number {
  return reason === 'approval' ? 0 : 1;
}

export function buildInboxCards(
  items: readonly Ticket[],
  facts: readonly InboxTicketFact[],
  noticesByTicket: Readonly<Record<string | number, readonly number[]>>,
  now: Date = new Date(),
): InboxCardView[] {
  const factsById = new Map(facts.map((fact) => [String(fact.ticketId), fact]));
  const waiting = items.filter((ticket): ticket is Ticket & { needsUser: TicketNeedsUserReason } => ticket.needsUser != null);
  return waiting
    .map((ticket) => ({ ticket, fact: factsById.get(ticket.id) }))
    .sort((left, right) => urgency(left.ticket.needsUser) - urgency(right.ticket.needsUser)
      || (left.fact?.since ?? '9999').localeCompare(right.fact?.since ?? '9999')
      || Number(left.ticket.id) - Number(right.ticket.id))
    .map(({ ticket, fact }) => {
      const noticeIds = [...(noticesByTicket[ticket.id] ?? [])];
      const recommended = recommendedTicketOption(ticketDecision({ ticket }));
      const meta = [
        `#${ticket.id}`,
        ticketNeedsUserLabel(ticket.needsUser),
        ...(fact ? [`等了 ${waitedText(fact.since, now)}`] : []),
        ...(noticeIds.length > 0 ? [`${noticeIds.length} 条通知`] : []),
      ].join(' · ');
      return {
        ticketId: ticket.id,
        title: ticketTitle(ticket),
        meta,
        reason: fact?.reason ?? null,
        milestone: ticket.nextMilestone ? milestoneChip(ticket.nextMilestone, now) : null,
        action: recommended && ONE_TAP_OPTIONS.has(recommended.id) ? recommended : null,
        noticeIds,
      };
    });
}

// 已触发、没有确认的提醒，30 天后从收件箱收起（决定 3）：它们在日程的「已过期」里。
const REMINDER_FOLD_AFTER_MS = 30 * DAY;

export function splitReminders(
  reminders: readonly NotificationDto[],
  now: Date = new Date(),
): { recent: NotificationDto[]; folded: NotificationDto[] } {
  const isOld = (reminder: NotificationDto) => now.getTime() - new Date(reminder.createdAt).getTime() >= REMINDER_FOLD_AFTER_MS;
  return { recent: reminders.filter((reminder) => !isOld(reminder)), folded: reminders.filter(isOld) };
}

/** 「Lead 已处理」：你上次看收件箱以后的事展开列出，更早的收成一行。没看过时都算新的。 */
export function splitLeadHandled(
  entries: readonly LeadHandledEntry[],
  seenAt: string | null,
): { fresh: LeadHandledEntry[]; earlier: LeadHandledEntry[] } {
  if (seenAt === null) return { fresh: [...entries], earlier: [] };
  return {
    fresh: entries.filter((entry) => entry.handledAt > seenAt),
    earlier: entries.filter((entry) => entry.handledAt <= seenAt),
  };
}

/**
 * 还在等的一条提醒（工单 07）：「待你」托盘里列出来，到点前一直在。外部的人要求设的定时器（spec D16，工单 12）也在这里：
 * requester 是谁要求的，timerRef 是它的编号（follow_up:12、reminder:5、trigger:3），用户可以取消。
 * 后台检查（.scratch/lead-watch/spec.md D5）也在这里：watch 写怎样查、谁设的、最后一次结果，timerRef 是 watch:<编号>。
 */
export type UpcomingReminder = {
  id: number | string;
  title: string;
  at: string | null;
  important: boolean;
  requester?: { name: string; sourceLabel: string } | null;
  timerRef?: string;
  watch?: UpcomingWatch;
};

/** 一个后台检查在提醒列表里要显示的部分。 */
export type UpcomingWatch = Pick<WatchTimerDto, 'schedule' | 'setBy' | 'running' | 'lastStatus' | 'lastCheckedAt'>;

/** 把网关给的一个后台检查变成提醒列表的一行。时间是下一次检查的时间；正在查时可能没有。 */
export function watchReminder(watch: WatchTimerDto): UpcomingReminder {
  return {
    id: watch.ref,
    timerRef: watch.ref,
    title: watch.title,
    at: watch.nextAt,
    important: false,
    requester: watch.requester,
    watch: {
      schedule: watch.schedule, setBy: watch.setBy, running: watch.running, lastStatus: watch.lastStatus, lastCheckedAt: watch.lastCheckedAt,
    },
  };
}

/** 提醒列表的顺序：下一次时间先到的在前，没有时间的放最后（例如正在查的后台检查）。时间相同时保持原来的顺序。 */
export function sortUpcoming(reminders: readonly UpcomingReminder[]): UpcomingReminder[] {
  const time = (reminder: UpcomingReminder) => {
    const at = reminder.at ? Date.parse(reminder.at) : Number.NaN;
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  return [...reminders].sort((left, right) => {
    const a = time(left);
    const b = time(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}

// 同时在等的后台检查最多 20 个（spec D5，PLC_WATCH_MAX_ACTIVE）。提醒卡里最多露出 3 个（P4.3），
// 其余的收成一行「还有 N 个后台检查」，点开在锚定浮层里列出，也能取消（P2）。提醒和别人要求设的定时器不受影响。
export const VISIBLE_WATCHES = 3;

/** 按顺序分出卡里露出的行和收起来的后台检查。 */
export function splitUpcoming(
  reminders: readonly UpcomingReminder[],
): { shown: UpcomingReminder[]; foldedWatches: UpcomingReminder[] } {
  const shown: UpcomingReminder[] = [];
  const foldedWatches: UpcomingReminder[] = [];
  let watches = 0;
  for (const reminder of reminders) {
    if (reminder.watch) {
      watches += 1;
      if (watches > VISIBLE_WATCHES) {
        foldedWatches.push(reminder);
        continue;
      }
    }
    shown.push(reminder);
  }
  return { shown, foldedWatches };
}

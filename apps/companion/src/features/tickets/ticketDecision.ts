// 「现在推荐你做什么」只有一个函数：详情的决策卡和收件箱的那一行都读它。以前这段逻辑写在 TicketThread 里，
// 收件箱要么拿不到，要么得另写一套（AGENTS.md：每个界面从同一个 TicketSummary 推导当前状态）。
// 详情知道的事实更多（子工单、阻塞记录、成果快照、在跑的 Run）；收件箱只给它知道的，其余按缺省算。
import type { KernelOutcomeSnapshotResource } from '@pi-lead-child/protocol';

import {
  buildTicketActionPresentation,
  isRuntimeRecoveryActive,
  ticketAttentionReason,
  type Ticket,
  type TicketActionPresentation,
} from '@/features/workspace/model';

import type { TicketRunProgress } from './ticketChatStatus';
import { ticketStatePresentation, type TicketOptionPresentation, type TicketStatePresentation } from './ticketState';

/** 工单停住了（阻塞、派发失败、要你处理的执行或工作区异常）：这时不给「开始」「停止」，你要先看原因。 */
export function isTicketBlockedForActions(ticket: Ticket): boolean {
  const dispatchFailed = ticket.executionState?.state === 'failed' || ticket.executionState?.state === 'blocked';
  const attentionReason = ticketAttentionReason(ticket);
  return ticket.status === 'blocked'
    || dispatchFailed
    || (ticket.status === 'active' && ticket.needsAttention)
    || attentionReason === 'workspace_failed'
    || attentionReason === 'workspace_blocked';
}

/**
 * 这张工单现在可以给你的动作。普通动作由协议矩阵投影；唯一的附加项是「继续恢复」：根工单已先恢复到 draft、
 * 子工单仍取消时，它代表用户继续完成同一个原子恢复方案，而不是一条新的单步 stage 边。
 */
export function ticketDecisionActions(
  ticket: Ticket,
  context: { cancelledChildCount?: number } = {},
): TicketActionPresentation[] {
  const recoveryInProgress = isRuntimeRecoveryActive(ticket);
  const ticketBlocked = isTicketBlockedForActions(ticket);
  const baseTicketActions = buildTicketActionPresentation(ticket);
  const ticketActions = ticket.status === 'draft' && (context.cancelledChildCount ?? 0) > 0
    ? [{ id: 'restore' as const, label: '继续恢复', tone: 'neutral' as const }, ...baseTicketActions]
    : baseTicketActions;
  return ticketActions
    .filter((action) => !(recoveryInProgress && action.id === 'start'))
    .filter((action) => !(ticketBlocked && (action.id === 'start' || action.id === 'stop')))
    .map((action) => action.id === 'start'
      && ticket.executionState?.kind === 'rework'
      && ticket.executionState.state === 'failed'
      ? { ...action, label: '重新启动返工' }
      : action);
}

export type TicketDecisionInput = {
  ticket: Ticket;
  cancelledChildCount?: number;
  /** 最新的阻塞记录（详情从进展记录里找；收件箱由服务端给出）。 */
  blocker?: { title: string; summary: string } | null;
  outcome?: KernelOutcomeSnapshotResource | null;
  timing?: { statusDurationMs?: number | null } | null;
  awaitingAfterIntervention?: boolean;
  liveRun?: TicketRunProgress | null;
  /** Lead 的名字（useLeadName）。不给时读最近一次取到的名字。 */
  leadName?: string;
};

export function ticketDecision(input: TicketDecisionInput): TicketStatePresentation {
  return ticketStatePresentation({
    ticket: input.ticket,
    actions: ticketDecisionActions(input.ticket, { cancelledChildCount: input.cancelledChildCount }),
    outcome: input.outcome ?? null,
    timing: input.timing ?? null,
    blocker: input.blocker ?? null,
    awaitingAfterIntervention: input.awaitingAfterIntervention ?? false,
    liveRun: input.liveRun ?? null,
    ...(input.leadName !== undefined ? { leadName: input.leadName } : {}),
  });
}

export function recommendedTicketOption(decision: TicketStatePresentation): TicketOptionPresentation | null {
  return decision.options.find((option) => option.recommended) ?? null;
}

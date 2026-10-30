// 「现在推荐你做什么」只有一个函数：详情的决策卡和收件箱的那一行都读它（spec：收件箱的动作和详情决策卡的
// 推荐动作出自同一个函数）。以前这段逻辑写在 TicketThread 里，收件箱拿不到。
import type { TicketReviewState, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { ticketSummaryToTicket } from '@/features/workspace/model';

import { recommendedTicketOption, ticketDecision, ticketDecisionActions } from './ticketDecision';

const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;

function ticket(overrides: Partial<TicketSummary> = {}) {
  const stage = overrides.stage ?? 'ready';
  return ticketSummaryToTicket({
    id: 72, title: '修复 review 状态投影', summary: '', kind: 'task', hasRun: true, priority: 'normal', project: 'pi-lead-child',
    dueAt: null, deferUntil: null, updatedAt: '2026-10-15T07:00:00.000Z', parentTicketId: null, rootTicketId: 72,
    runtime: idle, attention: { pendingApprovalCount: 0, blockerCount: 0 }, ...overrides, stage, status: stage,
  });
}

const notDispatched: TicketReviewState = {
  state: 'independent_review', label: '独立核查未派发', reviewerAttemptId: null, verdict: null,
  reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。', canRequestReview: true, reviewProgress: null, deliveryRunId: 49,
};

describe('ticketDecision', () => {
  it('recommends dispatching the review for a delivery nobody will review (the #66 case)', () => {
    const decision = ticketDecision({ ticket: ticket({ stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer' }) });
    expect(recommendedTicketOption(decision)).toMatchObject({ id: 'request_review', label: '派发独立核查' });
  });

  it('recommends confirming a draft Lead wrote', () => {
    const decision = ticketDecision({ ticket: ticket({ stage: 'draft', hasRun: false }) });
    expect(recommendedTicketOption(decision)?.id).toBe('confirm');
  });

  it('has no one-click recommendation for a blocked ticket: you decide in the ticket', () => {
    const blocked = ticket({ stage: 'blocked', runtime: { ...idle, state: 'blocked' } });
    expect(ticketDecisionActions(blocked).map((action) => action.id)).toEqual(['cancel']);
    expect(recommendedTicketOption(ticketDecision({ ticket: blocked }))).toBeNull();
  });

  it('names the blocker the caller found as the headline', () => {
    const blocked = ticket({ stage: 'blocked', runtime: { ...idle, state: 'blocked' } });
    const decision = ticketDecision({
      ticket: blocked,
      blocker: { title: 'Agent Run 未捕获异常', summary: 'Run #54 交付的成果格式不合法。' },
    });
    expect(decision.headline).toBe('Agent Run 未捕获异常');
    expect(decision.why).toBe('Run #54 交付的成果格式不合法。');
  });

  it('offers to continue a restore when the root came back as a draft and children stay cancelled', () => {
    const draft = ticket({ stage: 'draft', hasRun: false });
    expect(ticketDecisionActions(draft, { cancelledChildCount: 2 })[0]).toMatchObject({ id: 'restore', label: '继续恢复' });
  });
});

// 2026-10-16 用户要求：工单在等你回答一个决定（Lead 的决定卡，或者 agent 的决策请求）时，详情的决策卡和收件箱
// 不再推荐按阶段算出来的动作（以前是「派发独立核查」）。阶段动作留在「其他选择」里。
describe('a ticket waiting for your decision', () => {
  const owed = () => ticket({
    stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer',
    attention: { pendingApprovalCount: 0, blockerCount: 1, pendingDecisionCount: 1 },
  });

  it('recommends nothing from the stage, and says the decision comes first', () => {
    const decision = ticketDecision({ ticket: owed() });
    expect(recommendedTicketOption(decision)).toBeNull();
    expect(decision.chip).toBe('待你决定');
    expect(decision.headline).toBe('等你决定');
    expect(decision.options.map((option) => option.id)).toContain('request_review');
  });

  it('labels the ticket 待你决定 wherever its status shows', () => {
    expect(owed().statusLabel).toBe('待你决定');
    expect(owed().needsUser).toBe('decision');
  });
});


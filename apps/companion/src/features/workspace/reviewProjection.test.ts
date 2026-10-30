// stage='review' 的六种语义在界面上必须长得不一样（工单 #66 复盘第一点）。
//
// 卡死态的回归场景：stage=review、返工额度 1/1 已用尽、reviewer 的 FAIL 已被之后的交付作废
// （当前验证状态=未知）、最后一次交付没有登记成果，而 Lead 已经把 inbox 消费干净，
// blockerCount=0。修复前，这种工单在列表里就是一张普普通通的"待验收"卡片。
//
// 更正（2026-10-13）：这份 fixture 原先被当成 #66 的真实终局。#66 的最后一次交付 Run #49
// 其实登记了成果；"Run #51 没有成果"是把一次对话 Run 误当成交付。#66 今天的真实投影是
// "独立核查未派发"，见下面带 canRequestReview 的用例。这份 fixture 仍然代表真正的卡死态。
import type { TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildReviewNoticePresentation,
  buildTicketActionPresentation,
  formatTicketHeartbeatLabel,
  groupForTicket,
  isReviewDeadlocked,
  ticketRailCaption,
  ticketSummaryToTicket,
} from './model';

function summary(reviewState: TicketSummary['reviewState']): TicketSummary {
  return {
    id: 66,
    title: 'FINAL #45 implementation - outcome snapshot and registry mechanism',
    summary: '',
    kind: 'task',
    stage: 'review',
    status: 'review',
    hasRun: true,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-08-21T10:57:31.069Z',
    verificationPolicy: 'independent_reviewer',
    acceptancePolicy: 'delegated_to_lead',
    reworkPolicy: 'automatic',
    deliveryPolicy: 'continue_workflow',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    // #66 的真实计数：Lead 已消化 inbox，界面上没有任何"红点"可依赖。
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...(reviewState ? { reviewState } : {}),
  };
}

const ticket66ReviewState: TicketSummary['reviewState'] = {
  state: 'rework_exhausted',
  label: '返工已用尽且成果未登记，需要你决定',
  reviewerAttemptId: 43,
  verdict: null,
  reason: '返工 1/1 已用尽；Run #51 结束后没有可登记的成果快照，自我恢复失败；'
    + '当前验证状态未知：Run #43 的 FAIL 已被之后的执行作废',
  reworkCyclesUsed: 1,
  maxReworkCycles: 1,
  outcomeRecoveryFailed: true,
};

describe('review state projection', () => {
  it('regression #66: a deadlocked ticket is not rendered as a plain acceptance card', () => {
    const ticket = ticketSummaryToTicket(summary(ticket66ReviewState));

    expect(isReviewDeadlocked(ticket)).toBe(true);
    expect(ticket.needsAttention).toBe(true);
    expect(groupForTicket(ticket)).toBe('needs_intervention');
    expect(ticket.statusLabel).not.toBe('待验收');
    expect(formatTicketHeartbeatLabel(ticket)).toBe('需要你');
    expect(ticketRailCaption(ticket)).toBe('#66 · 返工已用尽且成果未登记，需要你决定 · 需要处理');

    const notice = buildReviewNoticePresentation(ticket);
    expect(notice).toMatchObject({
      id: 'rework_exhausted',
      tone: 'danger',
      title: '这张工单卡住了，不是在等你验收',
    });
    expect(notice!.facts).toEqual([
      { label: '当前验证状态', value: '未知' },
      { label: '核查 Run', value: '#43' },
      { label: '已用返工次数', value: '1/1' },
    ]);
    expect(notice!.acceptanceRisk).toContain('当前验证状态为未知');
    expect(notice!.acceptanceRisk).toContain('没有登记任何成果快照');
  });

  it('regression #66: the raw stage still offers acceptance, so the risk must be surfaced', () => {
    const ticket = ticketSummaryToTicket(summary(ticket66ReviewState));

    // 协议矩阵没变：review→done 依然是用户的权利，入口不该被 UI 偷偷拿掉。
    expect(buildTicketActionPresentation(ticket).map((action) => action.id))
      .toEqual(['complete', 'rework', 'cancel']);
    // 但它不能再是一次无声的确认——必须带风险原文。
    expect(buildReviewNoticePresentation(ticket)?.acceptanceRisk).not.toBeNull();
  });

  it('renders an unverified execution cycle as review-in-progress, with no acceptance risk copy hiding', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'independent_review',
      label: '独立核查中',
      reviewerAttemptId: null,
      verdict: null,
      reason: 'An independent reviewer is currently running.',
      reworkCyclesUsed: 0,
      maxReworkCycles: 1,
      reviewProgress: 'running',
    }));
    const notice = buildReviewNoticePresentation(ticket);

    expect(isReviewDeadlocked(ticket)).toBe(false);
    // 核查在跑就是在执行；没有单独的「待验收」组。
    expect(groupForTicket(ticket)).toBe('running');
    expect(notice).toMatchObject({ id: 'independent_review', tone: 'info', title: '独立核查中' });
    expect(notice!.facts).toEqual([
      { label: '当前验证状态', value: '未知' },
      { label: '已用返工次数', value: '0/1' },
    ]);
    expect(notice!.acceptanceRisk).toBe('独立核查尚未给出结论，现在验收等于跳过核查。');
  });

  it('regression #66: a delivery nobody will review needs the user, not the review queue', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'independent_review',
      label: '独立核查未派发',
      reviewerAttemptId: null,
      verdict: null,
      reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。',
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      deliveryRunId: 49,
      canRequestReview: true,
    }));

    expect(isReviewDeadlocked(ticket)).toBe(false);
    expect(ticket.needsAttention).toBe(true);
    expect(groupForTicket(ticket)).toBe('needs_intervention');
  });

  it('regression #66: names the expired review instead of presenting it as the current one', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'independent_review',
      label: '独立核查未派发',
      reviewerAttemptId: null,
      verdict: null,
      reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。',
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      reviewerHashState: 'unknown',
      supersededReview: { reviewerAttemptId: 43, verdict: 'fail', reviewedRunId: 42, supersededByRunId: 49 },
      deliveryRunId: 49,
      canRequestReview: true,
    }));

    expect(buildReviewNoticePresentation(ticket)!.facts).toEqual([
      { label: '当前验证状态', value: '未知' },
      { label: '上次核查', value: 'Run #43 · FAIL · 核查的是 Run #42 · 已被 Run #49 作废' },
      { label: '已用返工次数', value: '1/1' },
    ]);
  });

  // 可选的核查不算介入（needsAttention 仍是 false）；它在「等你」里，是因为交付在等你验收。
  it('files a user-accepted ticket under 等你 for acceptance, not as an intervention for the optional review', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null,
      deliveryRunId: 49, canRequestReview: true,
    }));

    expect(ticket.needsAttention).toBe(false);
    expect(ticket.needsUser).toBe('acceptance');
    expect(groupForTicket(ticket)).toBe('needs_intervention');
  });

  it('renders a reviewer PASS still in review as a success card that waits for the user', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'review_passed',
      label: '核查通过，等待验收',
      reviewerAttemptId: 52,
      verdict: 'pass',
      reason: 'full regression green',
      reworkCyclesUsed: 0,
      maxReworkCycles: 1,
    }));
    const notice = buildReviewNoticePresentation(ticket);

    expect(ticket.needsAttention).toBe(false);
    expect(groupForTicket(ticket)).toBe('needs_intervention');
    expect(notice).toMatchObject({
      id: 'review_passed',
      tone: 'success',
      // 托管的 PASS 会在出结论时直接结单；还停在 review 就是在等用户，不能再说"等待交付闭环"。
      title: '核查通过，等待你验收',
      acceptanceRisk: null,
    });
    expect(notice!.facts).toContainEqual({ label: '当前验证状态', value: '通过（PASS）' });
  });

  it('renders a reviewer FAIL awaiting rework as attention, distinct from the deadlock card', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'review_failed',
      label: '核查不通过，等你决定',
      reviewerAttemptId: 43,
      verdict: 'fail',
      reason: 'full regression failed',
      reworkCyclesUsed: 0,
      maxReworkCycles: 2,
    }));
    const notice = buildReviewNoticePresentation(ticket);

    expect(isReviewDeadlocked(ticket)).toBe(false);
    expect(ticket.needsAttention).toBe(true);
    expect(notice).toMatchObject({
      id: 'review_failed',
      tone: 'attention',
      title: '独立核查不通过',
      acceptanceRisk: null,
    });
    expect(notice!.facts).toContainEqual({ label: '已用返工次数', value: '0/2' });
  });

  it('omits the rework budget fact when the ticket has no automatic rework grant', () => {
    const ticket = ticketSummaryToTicket(summary({
      state: 'waiting_user',
      label: '等待用户验收',
      reviewerAttemptId: null,
      verdict: null,
      reason: null,
    }));
    const notice = buildReviewNoticePresentation(ticket);

    expect(notice).toMatchObject({ id: 'waiting_user', tone: 'info', title: '等待你验收' });
    expect(notice!.facts).toEqual([{ label: '当前验证状态', value: '未知' }]);
  });

  it('has nothing to render outside stage=review', () => {
    const blocked = ticketSummaryToTicket({
      ...summary(undefined),
      stage: 'blocked',
      status: 'blocked',
    });

    expect(buildReviewNoticePresentation(blocked)).toBeNull();
    expect(isReviewDeadlocked(blocked)).toBe(false);
  });
});

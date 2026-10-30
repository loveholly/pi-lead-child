import type { KernelOutcomeSnapshotResource, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildTicketActionPresentation, ticketSummaryToTicket } from '../workspace/model';
import { ticketStatePresentation } from './ticketState';

type ReviewState = NonNullable<TicketSummary['reviewState']>;

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 66,
    title: 'FINAL #45 implementation - outcome snapshot and registry mechanism',
    summary: 'User-requested real follow-up: implement the outcome snapshot mechanism.',
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
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
  };
}

const outcome: KernelOutcomeSnapshotResource = {
  latest: {
    id: 2,
    ticketId: 66,
    executorAttemptId: 49,
    completionCheckpointId: null,
    source: 'system_recovered',
    sourceEventSeq: 447,
    sourceOutputSha256: 'c52eaf3a94d7ac85849cd03b668ec404bd84a875d3183278cf456adcb0b53e14',
    summary: 'Closed the outcome-registry gap.',
    changes: [],
    deliverables: [],
    validations: [],
    completeness: 'complete',
    missingFields: [],
    recoveryNote: null,
    createdAt: '2026-08-21T10:48:04.022Z',
  },
  historyCount: 2,
  facts: { implementationCompleted: true, independentEvidence: 'missing', acceptance: 'none' },
  reviewerVerdict: null,
};

// #66 今天的真实投影（Phase 1/2 之后）：交付 Run #49 有快照，没有核查会来。
const ticket66: ReviewState = {
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
};

function present(reviewState: ReviewState, overrides: Partial<TicketSummary> = {}) {
  const ticket = ticketSummaryToTicket(summary({ ...overrides, reviewState }));
  return ticketStatePresentation({
    ticket,
    actions: buildTicketActionPresentation(ticket),
    outcome,
    timing: { statusDurationMs: 4_547_544_810 },
  });
}

// 复核 P0-5：#66 在对话 Run #72 收尾时的投影。有 Run 在进行时服务端不派核查，所以没有缺口，也没有核查在路上。
const ticket66DuringChat: ReviewState = { ...ticket66, label: '等待独立核查', canRequestReview: false, reviewProgress: null };
const chatRun = {
  runId: 72, purpose: 'conversation' as const, label: '对话 Run #72 · 正在回答', phase: 'running' as const, elapsedMs: 40_000, stalled: false,
};

describe('ticket state presentation', () => {
  it('regression #66 P0-5: does not claim a review is about to start while a chat run is still answering', () => {
    const ticket = ticketSummaryToTicket(summary({
      reviewState: ticket66DuringChat,
      runtime: { state: 'running', lastActivityAt: '2026-10-14T09:58:40.000Z', activeAttemptId: 72 },
    }));
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun: chatRun });

    expect(state).toMatchObject({
      chip: '等 Run 结束',
      headline: '工单对话 Run #72 还在回答，答完才能派发独立核查。',
      automation: 'Run 结束后状态会自动更新。',
    });
    expect(state.facts).toContainEqual({ label: '独立核查', value: 'Run #49 未核查' });
    expect(JSON.stringify(state)).not.toContain('即将开始');
  });

  it('says a run is still going when the run details have not arrived yet', () => {
    // 第一屏只有 TicketSummary，Run 的列表还没读到：只说有一个 Run 在进行，不猜它是什么。
    const state = present(ticket66DuringChat, { runtime: { state: 'running', lastActivityAt: null, activeAttemptId: null } });
    expect(state.headline).toBe('这张工单还有一个 Run 在进行，结束后才能派发独立核查。');
  });

  it('regression #66: says the delivery was never reviewed and recommends sending it to a reviewer', () => {
    const state = present(ticket66);

    expect(state).toMatchObject({
      chip: '核查未派发',
      headline: 'Run #49 已交付，但还没有被独立核查。',
      why: '系统不会自动派发核查，需要你决定下一步。返工额度已用完。',
      automation: '当前没有自动动作在进行。',
    });
    expect(state.facts).toEqual([
      { label: '最新交付', value: 'Run #49 · 成果快照 #2' },
      { label: '独立核查', value: 'Run #49 未核查' },
      { label: '上次核查', value: 'Run #43 · FAIL · 核查的是 Run #42 · 已被 Run #49 作废' },
      { label: '返工额度', value: '1/1 已用' },
      { label: '停留', value: '52d 15h 未变化' },
    ]);
    expect(state.options).toEqual([
      { id: 'request_review', label: '派发独立核查', consequence: '派一个独立 reviewer 核查 Run #49 的成果。', tone: 'primary', recommended: true },
      { id: 'complete', label: '仍要验收通过', consequence: '没有核查结论就结单。', tone: 'danger', recommended: false },
      { id: 'rework', label: '手动返工', consequence: '从 Run #49 的交付继续返工；这是你发起的返工，不占用 Paimon 的返工额度。', tone: 'neutral', recommended: false },
      { id: 'cancel', label: '取消工单', consequence: '放弃这次交付，工单结束。', tone: 'danger', recommended: false },
    ]);
  });

  it('describes a genuine deadlock without offering a reviewer', () => {
    const state = present({
      state: 'rework_exhausted',
      label: '返工已用尽且成果未登记，需要你决定',
      reviewerAttemptId: null,
      verdict: null,
      reason: '返工 1/1 已用尽；Run #50 结束后没有可登记的成果快照，自我恢复失败',
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      outcomeRecoveryFailed: true,
      deliveryRunId: 50,
      canRequestReview: false,
    });

    expect(state).toMatchObject({ chip: '卡住', tone: 'danger', automation: '当前没有自动动作在进行。' });
    expect(state.headline).toBe('最后一次交付（Run #50）没有登记成果，自动化已停止。');
    expect(state.options.map((option) => option.id)).toEqual(['complete', 'rework', 'cancel']);
    expect(state.options.find((option) => option.id === 'complete')).toMatchObject({ label: '仍要验收通过', tone: 'danger' });
    // 没有自动动作在等着：给出推荐，底部栏才有东西可放。
    expect(state.options.find((option) => option.recommended)?.id).toBe('rework');
  });

  // 核查自动化只在出结论的那一笔事务里跑一次：FAIL 时要么打回 active 并派返工，要么停手；
  // PASS 时要么直接结单，要么停手。工单还停在 review，说明它已经停手了——#66 的 FAIL 就发生在授权之前。
  it('never promises a rework after a failed review that is still waiting in review', () => {
    const failed: ReviewState = {
      state: 'review_failed', label: '核查不通过，等你决定', reviewerAttemptId: 52, verdict: 'fail',
      reason: 'unit suite red', reworkCyclesUsed: 0, maxReworkCycles: 1, deliveryRunId: 51, canRequestReview: false,
    };

    for (const state of [present(failed), present(failed, { acceptancePolicy: 'user_only', reworkPolicy: 'ask_user' })]) {
      expect(state.automation).toBe('当前没有自动动作在进行。');
      expect(state.options.find((option) => option.recommended)?.id).toBe('rework');
      expect(state.options.map((option) => option.id)).not.toContain('complete');
    }
  });

  it('asks the user to accept a passed review that is still waiting in review, even under delegation', () => {
    const passed: ReviewState = {
      state: 'review_passed', label: '核查通过，等待验收', reviewerAttemptId: 52, verdict: 'pass',
      reason: 'green', deliveryRunId: 51, canRequestReview: false,
    };

    for (const state of [present(passed), present(passed, { acceptancePolicy: 'user_only' })]) {
      expect(state).toMatchObject({ headline: '核查通过，等你验收。', automation: '当前没有自动动作在进行。' });
      expect(state.options.find((option) => option.recommended)?.id).toBe('complete');
    }
  });

  it('keeps every review state free of claims that another block would contradict', () => {
    const states: ReviewState[] = [
      ticket66,
      { ...ticket66, label: '独立核查中', canRequestReview: false, reviewProgress: 'running', reason: '独立核查正在进行。' },
      { ...ticket66, label: '独立核查排队中', canRequestReview: false, reviewProgress: 'queued', reason: '核查请求已排队，等待派发。' },
      { state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null },
      { state: 'review_failed', label: '核查不通过', reviewerAttemptId: 52, verdict: 'fail', reason: 'red', reworkCyclesUsed: 1, maxReworkCycles: 1 },
      { state: 'review_passed', label: '核查通过', reviewerAttemptId: 52, verdict: 'pass', reason: 'green' },
      { state: 'evidence_conflict', label: '证据冲突', reviewerAttemptId: 52, verdict: 'fail', reason: 'evidence_conflict' },
      { state: 'rework_exhausted', label: '返工已用尽', reviewerAttemptId: 52, verdict: 'fail', reason: 'red', reworkCyclesUsed: 1, maxReworkCycles: 1 },
    ];
    for (const reviewState of states) {
      const state = present(reviewState);
      const text = [state.chip, state.headline, state.why, state.automation, ...state.facts.map((fact) => fact.value)].join(' ');
      // "未通过 / 不通过" 只在当前有效的核查确实是 FAIL 时出现。
      if (reviewState.verdict !== 'fail') expect(text, reviewState.state).not.toMatch(/未通过|不通过/);
      // 用完额度或卡死时，不能再承诺自动返工或自动交付。
      if (reviewState.canRequestReview || reviewState.state === 'rework_exhausted') {
        expect(text, reviewState.state).not.toMatch(/自动返工|自动交付|完成交付/);
      }
      // 有推荐时只推荐一个。
      expect(state.options.filter((option) => option.recommended).length, reviewState.state).toBeLessThanOrEqual(1);
      // 只有真的有核查在排队、挂起或运行时，才能说自动化会做什么；否则必须给用户一个推荐。
      const pending = reviewState.reviewProgress != null;
      if (!pending && reviewState.state !== 'independent_review') {
        expect(state.automation, reviewState.state).toBe('当前没有自动动作在进行。');
        expect(state.options.some((option) => option.recommended), reviewState.state).toBe(true);
      }
    }
  });

  it('tells a queued review apart from a paused one and a running one', () => {
    const base = { ...ticket66, canRequestReview: false };
    const queued = present({ ...base, label: '独立核查排队中', reviewProgress: 'queued', reason: '核查请求已排队，等待派发。' });
    const paused = present({ ...base, label: '独立核查已暂停', reviewProgress: 'suspended', reason: 'Codex 账号余额不足。' });
    const running = present({ ...base, label: '独立核查中', reviewProgress: 'running', reason: '独立核查正在进行。' });

    expect([queued.headline, paused.headline, running.headline]).toEqual([
      '独立核查已排队，等待开始。',
      '独立核查已排队，但暂时不能开始。',
      '独立核查正在进行。',
    ]);
    expect(paused).toMatchObject({ chip: '核查已暂停', tone: 'attention', why: 'Codex 账号余额不足。' });
    expect([queued, paused, running].map((state) => state.facts.find((fact) => fact.label === '独立核查')?.value))
      .toEqual(['排队中', '已暂停', '进行中']);
  });

  it('regression 2026-10-21: a paused review that can be re-picked is not shown as never dispatched', () => {
    // 服务端在核查挂起时也让「派发核查」可点，用来换一个能用的核查员。以前这里命中第一个分支，写成「核查未派发」。
    const paused = present({
      ...ticket66, canRequestReview: true, label: '独立核查已暂停', reviewProgress: 'suspended', reason: 'Codex 账号已停用。',
    });
    expect(paused).toMatchObject({ chip: '核查已暂停', tone: 'attention', why: 'Codex 账号已停用。' });
    expect(paused.headline).not.toMatch(/还没有被独立核查/);
    expect(paused.options.find((option) => option.id === 'request_review')).toMatchObject({
      label: '重新排核查', consequence: '原来的核查员能用就用它，不能用就换一个能用的。',
    });
  });

  // 回归（2026-10-21 审查 M4）：服务端只在有能用的核查员时才让挂起的核查能重新排。没有能用的时不给按钮，
  // 这时按钮说明里不能再写「都不能用时仍然挂起」。由用户验收的工单上，挂起的核查也写「重新排核查」，不写「派发独立核查」。
  it('regression 2026-10-21: re-picks a paused review only when the server allows it, also on a user-accepted ticket', () => {
    const none = present({
      ...ticket66, canRequestReview: false, label: '独立核查已暂停', reviewProgress: 'suspended', reason: '没有能用的核查员。',
    });
    expect(none.options.some((option) => option.id === 'request_review')).toBe(false);

    const userAccepted = present({
      state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null,
      deliveryRunId: 49, canRequestReview: true, reviewProgress: 'suspended',
    }, { verificationPolicy: 'user', acceptancePolicy: 'user_only' });
    expect(userAccepted.options.find((option) => option.id === 'request_review')).toMatchObject({
      label: '重新排核查', consequence: '原来的核查员能用就用它，不能用就换一个能用的。',
    });
  });

  it('regression #66: says the review has not started when its run has been starting for minutes', () => {
    // 你点了「派发独立核查」，核查 Run #73 停在 starting 13 分钟，状态卡却写着「独立核查正在进行」。
    const ticket = ticketSummaryToTicket(summary({ reviewState: { ...ticket66, canRequestReview: false, reviewProgress: 'running' } }));
    const liveRun = {
      runId: 73, purpose: 'review' as const, label: '核查 Run #73 · 正在准备', phase: 'starting' as const,
      elapsedMs: 13 * 60_000, stalled: true,
    };
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun });

    expect(state).toMatchObject({
      chip: '核查没有开始',
      tone: 'attention',
      headline: '核查 Run #73 准备了 13 分钟，还没有开始。',
      why: '通常 10 秒内开始，这次可能卡住了。',
    });
    const fresh = ticketStatePresentation({
      ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun: { ...liveRun, elapsedMs: 5_000, stalled: false },
    });
    expect(fresh.headline).toBe('独立核查正在进行。');
  });

  it('offers an optional review on a user-accepted ticket without calling it stuck', () => {
    const state = present({
      state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null,
      deliveryRunId: 49, canRequestReview: true, reviewProgress: null,
    }, { verificationPolicy: 'user', acceptancePolicy: 'user_only' });

    expect(state).toMatchObject({ chip: '待验收', headline: '执行已结束，等你验收。' });
    expect(state.options.map((option) => [option.id, option.recommended])).toEqual([
      ['request_review', false],
      ['complete', true],
      ['rework', false],
      ['cancel', false],
    ]);
  });

  // release review 8：以下三条以前在 ticketComponents.test.ts 里钉着源码文本，现在断言行为。
  it('shows a running recovery in the state block, but leaves a plain running execution to the next-action copy', () => {
    const execution = (kind: 'execution' | 'recovery', label: string) => ({
      kind, state: 'running' as const, label, dispatchRequestId: null, attemptId: 50,
      reason: kind === 'recovery' ? '模型限流，30 秒后自动重试。' : null, updatedAt: null,
    });
    const presentFor = (executionState: ReturnType<typeof execution>) => {
      const ticket = ticketSummaryToTicket(summary({ stage: 'active', status: 'active', reviewState: undefined, executionState }));
      return ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket) });
    };

    expect(presentFor(execution('execution', '执行中'))).toMatchObject({ headline: '系统正在执行' });
    expect(presentFor(execution('recovery', '正在自动恢复'))).toMatchObject({
      chip: '正在自动恢复', headline: '正在自动恢复', tone: 'info', automation: '模型限流，30 秒后自动重试。',
    });
  });

  it('prefers the execution state over a blocker record, and the blocker over the generic copy', () => {
    const blocked = (executionState?: TicketSummary['executionState']) => ticketSummaryToTicket(summary({
      stage: 'blocked', status: 'blocked', reviewState: undefined, ...(executionState ? { executionState } : {}),
    }));
    const blocker = { title: 'Run #50 交接失败', summary: '工具桥断开，交接没有送达。' };

    const recorded = blocked();
    expect(ticketStatePresentation({ ticket: recorded, actions: buildTicketActionPresentation(recorded), blocker }))
      .toMatchObject({ headline: 'Run #50 交接失败', why: '工具桥断开，交接没有送达。', tone: 'danger' });
    const failed = blocked({
      kind: 'rework', state: 'failed', label: '返工启动失败', dispatchRequestId: 7, attemptId: null,
      reason: 'Codex 账号余额不足。', updatedAt: null,
    });
    expect(ticketStatePresentation({ ticket: failed, actions: buildTicketActionPresentation(failed), blocker }))
      .toMatchObject({ headline: '返工启动失败', why: 'Codex 账号余额不足。', tone: 'danger' });
  });

  it('uses the shared next-action copy outside review', () => {
    const ticket = ticketSummaryToTicket(summary({ stage: 'active', status: 'active', reviewState: undefined }));
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket) });

    expect(state).toMatchObject({ chip: ticket.statusLabel, headline: '系统正在执行', tone: 'info' });
    expect(state.options.map((option) => option.label)).toEqual(['停下', '取消工单']);
  });
});

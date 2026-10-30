import type { KernelCheckpoint, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildCheckpointCardViewModel } from '../chat/CheckpointCard';
import { groupForTicket, ticketRailCaption, ticketSummaryToTicket } from './model';

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 66,
    title: 'Outcome snapshot protocol',
    summary: '',
    kind: 'task',
    stage: 'review',
    status: 'review',
    hasRun: true,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-08-18T09:00:00.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
  };
}

const completedCheckpoint: KernelCheckpoint = {
  id: 68,
  ticketId: 66,
  attemptId: 42,
  author: { kind: 'executor', runtime: 'codex' },
  source: 'agent_reported',
  kind: 'completed',
  stage: 'review-handoff',
  title: 'Outcome snapshot protocol implemented',
  summary: 'Implementation was submitted for independent review.',
  keyFacts: [],
  artifactRefs: [],
  relatedTicketIds: [],
  nextStep: 'Independent review',
  actionRef: null,
  createdAt: '2026-08-18T08:55:00.000Z',
};

const failedCheckpoint: KernelCheckpoint = {
  ...completedCheckpoint,
  id: 89,
  attemptId: 46,
  author: { kind: 'system', runtime: 'claude' },
  source: 'system_derived',
  kind: 'blocked',
  stage: 'runtime',
  title: 'Run crashed',
  summary: 'OAuth session expired.',
  nextStep: 'Recover the ticket run.',
};

describe('cross-view ticket status consistency', () => {
  it('shows review failure consistently while preserving the historical handoff event', () => {
    const ticket = summary({
      reviewState: {
        state: 'review_failed',
        label: '核查不通过，等你决定',
        reviewerAttemptId: 43,
        verdict: 'fail',
        reason: 'full regression failed',
      },
    });
    const presentation = ticketSummaryToTicket(ticket);
    const checkpoint = buildCheckpointCardViewModel(completedCheckpoint, ticket);

    expect(presentation.status).toBe('review');
    expect(groupForTicket(presentation)).toBe('needs_intervention');
    expect(ticketRailCaption(presentation)).toBe('#66 · 核查不通过，等你决定 · 需要处理');
    // 卡片写事件当时的状态；工单现在等你决定，另起一个「现在」标签，文字和列表里一致。
    expect(checkpoint.kindLabel).toBe('已提交复核');
    expect(checkpoint.nowLabel).toBe(`现在：${presentation.statusLabel}`);
    expect(checkpoint.nowLabel).toBe('现在：核查不通过，等你决定');
  });

  it('keeps done terminal in every view even if a historical blocker counter remains', () => {
    const ticket = summary({
      stage: 'done',
      status: 'done',
      attention: { pendingApprovalCount: 0, blockerCount: 3 },
    });
    const presentation = ticketSummaryToTicket(ticket);
    const checkpoint = buildCheckpointCardViewModel(completedCheckpoint, ticket);

    expect(groupForTicket(presentation)).toBe('completed');
    expect(ticketRailCaption(presentation)).toBe('#66 · 已完成');
    expect(checkpoint.nowLabel).toBe(`现在：${presentation.statusLabel}`);
    expect(checkpoint.nowLabel).toBe('现在：完成');
  });

  it('moves a blocked ticket into recovery while keeping the old crash historical', () => {
    const ticket = summary({
      stage: 'blocked',
      status: 'blocked',
      executionState: {
        kind: 'recovery',
        state: 'starting',
        label: '正在恢复 · 启动中',
        dispatchRequestId: 50,
        attemptId: 47,
        reason: 'Switching runtime after authentication failure.',
        updatedAt: '2026-08-21T09:00:00.000Z',
      },
      attention: { pendingApprovalCount: 0, blockerCount: 1 },
    });
    const presentation = ticketSummaryToTicket(ticket);
    const checkpoint = buildCheckpointCardViewModel(failedCheckpoint, ticket);

    expect(groupForTicket(presentation)).toBe('running');
    expect(ticketRailCaption(presentation)).toBe('#66 · 正在恢复 · 启动中');
    expect(presentation.needsAttention).toBe(false);
    expect(checkpoint.kindLabel).toBe('需要介入');
    expect(checkpoint.nowLabel).toBe('现在：正在恢复 · 启动中');
  });

  // 2026-10-24 #117：换了账号后新的 Run 已经在跑，工单头还写「正在恢复」，Run 行写「执行中」。
  // 新 Run 跑起来以后，服务端的标签是「执行中」：列表、工单头和历史卡片的「现在」都写它，旧的失败仍然不算「需要你」。
  it('says a recovered ticket is running in every view once its new run runs', () => {
    const ticket = summary({
      stage: 'active',
      status: 'active',
      runtime: { state: 'running', lastActivityAt: '2026-10-24T13:47:13.000Z', activeAttemptId: 156 },
      executionState: {
        kind: 'recovery',
        state: 'running',
        label: '执行中',
        dispatchRequestId: 57,
        attemptId: 156,
        reason: null,
        updatedAt: '2026-10-24T13:47:13.000Z',
      },
      attention: { pendingApprovalCount: 0, blockerCount: 1 },
    });
    const presentation = ticketSummaryToTicket(ticket);
    const checkpoint = buildCheckpointCardViewModel(failedCheckpoint, ticket);

    expect(groupForTicket(presentation)).toBe('running');
    expect(presentation.statusLabel).toBe('执行中');
    expect(ticketRailCaption(presentation)).toBe('#66 · 执行中');
    expect(presentation.needsAttention).toBe(false);
    expect(checkpoint.nowLabel).toBe('现在：执行中');
  });
});

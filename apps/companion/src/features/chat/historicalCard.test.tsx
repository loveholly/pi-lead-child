// @vitest-environment jsdom
// 历史卡片写它那个时刻的状态。实例上一张 child 消息卡片写着「已提交复核」，旁边一行粗体「当前工单：完成」，
// 看起来像这条消息自己在说"完成"。现在卡片只写事件当时的状态；工单后来变了，另起一个小标签「现在：…」。
import type { KernelCheckpoint, TicketSummary } from '@pi-lead-child/protocol';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const submitted: KernelCheckpoint = {
  id: 68, ticketId: 47, attemptId: 42, author: { kind: 'executor', runtime: 'codex' }, source: 'agent_reported',
  kind: 'completed', stage: 'review-handoff', title: 'Workspace 表与 Run 关联已实现',
  summary: '实现已提交独立核查。', keyFacts: [], artifactRefs: [], relatedTicketIds: [],
  nextStep: '独立核查', actionRef: null, createdAt: '2026-10-12T08:55:00.000Z',
};

function ticket(overrides: Partial<TicketSummary>): TicketSummary {
  const stage = overrides.stage ?? 'review';
  return {
    id: 47, title: '#47-P1 数据模型', summary: '', kind: 'task', hasRun: true, priority: 'normal', project: null,
    dueAt: null, deferUntil: null, updatedAt: '2026-10-13T08:00:00.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides, stage, status: stage,
  };
}

function render(current: TicketSummary) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([current]);
  runtime.control.getState().mergeConversationCardPage({
    items: [{
      id: 1, key: 'checkpoint:68', kind: 'checkpoint', turnId: null, ticketId: 47, checkpointId: 68,
      createdAt: submitted.createdAt, updatedAt: submitted.createdAt,
    }],
    checkpoints: [submitted], interventionRefs: [], hasMore: false, nextBeforeId: null,
  }, 'replace');
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return screen.getByTestId('checkpoint-card-68');
}

describe('a historical checkpoint card', () => {
  it('states its own moment and puts the later state in a separate 现在 chip', () => {
    const card = render(ticket({ stage: 'done' }));
    expect(card.textContent).not.toContain('当前工单');
    expect(within(card).getByText('已提交复核')).toBeTruthy();
    expect(within(card).getByTestId('checkpoint-now-chip').textContent).toBe('现在：完成');
  });

  it('shows no chip while the ticket is still where the event left it', () => {
    const card = render(ticket({
      stage: 'review',
      reviewState: { state: 'independent_review', label: '独立核查中', reviewerAttemptId: null, verdict: null, reason: null, reviewProgress: 'running' },
    }));
    expect(card.textContent).not.toContain('当前工单');
    expect(within(card).getByText('已提交复核')).toBeTruthy();
    expect(within(card).queryByTestId('checkpoint-now-chip')).toBeNull();
  });

  it('shows the chip when the ticket, still in review, now waits for the user', () => {
    const card = render(ticket({
      stage: 'review',
      reviewState: { state: 'review_failed', label: '核查不通过，等你决定', reviewerAttemptId: 43, verdict: 'fail', reason: 'tests failed' },
    }));
    expect(within(card).getByTestId('checkpoint-now-chip').textContent).toBe('现在：核查不通过，等你决定');
  });
});

describe('a historical run-failure card', () => {
  it('does not take its words from Lead\'s current health once its ticket has finished', () => {
    const crashed: KernelCheckpoint = {
      id: 95, ticketId: 47, attemptId: 70, author: { kind: 'system', runtime: null }, source: 'system_derived',
      stage: null, kind: 'blocked', title: 'Run crashed', summary: 'Run #70 crashed (process_exit)',
      keyFacts: [
        { label: 'Agent', value: 'Codex' }, { label: 'Failure category', value: 'unknown' },
        { label: 'Failure scope', value: 'unknown' }, { label: 'Needs', value: 'none' },
      ],
      artifactRefs: [], relatedTicketIds: [], nextStep: 'Inspect the runtime failure and retry.', actionRef: null,
      createdAt: '2026-10-12T08:00:00.000Z',
    };
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({
      phase: 'ready', connectionState: 'connected',
      overview: {
        model: 'm', sessionId: 's', busy: false, runningTicketIds: [], aish: null,
        counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
        lead: {
          state: 'degraded', since: null, failures: 2, reason: 'Lead 的模型服务暂时连不上', detail: '503',
          nextAttemptAt: null, lastSuccessAt: null,
        },
      },
    });
    runtime.control.getState().replaceTickets([ticket({ stage: 'done' })]);
    runtime.control.getState().mergeConversationCardPage({
      items: [{ id: 1, key: 'checkpoint:95', kind: 'checkpoint', turnId: null, ticketId: 47, checkpointId: 95,
        createdAt: crashed.createdAt, updatedAt: crashed.createdAt }],
      checkpoints: [crashed], interventionRefs: [], hasMore: false, nextBeforeId: null,
    }, 'replace');
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const card = screen.getByTestId('checkpoint-card-95');
    expect(card.textContent).not.toContain('等 Lead 恢复');
    expect(card.textContent).not.toContain('Lead 会判断');
    expect(card.textContent).toContain('工单 #47 的 Codex 运行出错 · 现在：完成');
  });
});

// @vitest-environment jsdom
// 2026-10-15 用户决定：「系统的异常情况，lead 应该都是及时感知的，并且尽可能介入处理，UI 上我希望除非需要我介入，
// 否则我希望是弱反馈」。Lead 正在处理的 Run 失败在会话里只是一行：圆点、「Lead 处理中」、一句话，没有失败卡片。
// Lead 处理不了、升级给用户以后，才是带「打开工单」的失败卡片。
import type { KernelCheckpoint, TicketSummary } from '@pi-lead-child/protocol';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const crashed: KernelCheckpoint = {
  id: 81, ticketId: 66, attemptId: 81, author: { kind: 'system', runtime: null }, source: 'system_derived',
  kind: 'blocked', stage: null, title: 'Run crashed', summary: 'Run #81 crashed (process_exit)',
  keyFacts: [
    { label: 'Agent', value: 'Codex' }, { label: 'Failure category', value: 'unknown' },
    { label: 'Failure scope', value: 'unknown' }, { label: 'Needs', value: 'none' },
  ],
  artifactRefs: [], relatedTicketIds: [], nextStep: 'Inspect the runtime failure, adjust the execution path if needed, and retry.',
  actionRef: null, createdAt: '2026-10-15T08:00:00.000Z',
};

function ticket(attention: TicketSummary['attention']): TicketSummary {
  return {
    id: 66, title: '#66', summary: '', kind: 'task', hasRun: true, priority: 'normal', project: null,
    dueAt: null, deferUntil: null, updatedAt: '2026-10-15T08:00:00.000Z', stage: 'blocked', status: 'blocked',
    runtime: { state: 'blocked', lastActivityAt: null, activeAttemptId: null }, attention,
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
      id: 1, key: 'checkpoint:81', kind: 'checkpoint', turnId: null, ticketId: 66, checkpointId: 81,
      createdAt: crashed.createdAt, updatedAt: crashed.createdAt,
    }],
    checkpoints: [crashed], interventionRefs: [], hasMore: false, nextBeforeId: null,
  }, 'replace');
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return screen.getByTestId('checkpoint-card-81');
}

describe('a run failure in the Lead conversation', () => {
  it('is one quiet line while Lead handles it', () => {
    const card = render(ticket({ pendingApprovalCount: 0, blockerCount: 0, leadHandling: true }));
    expect(card.textContent).toContain('Paimon 正在处理');
    expect(within(card).queryByRole('button', { name: /打开工单/ })).toBeNull();
  });

  it('offers to open the ticket once it needs the user', () => {
    const card = render(ticket({ pendingApprovalCount: 0, blockerCount: 1 }));
    expect(within(card).getByRole('button', { name: '打开工单 #66' })).toBeTruthy();
  });
});

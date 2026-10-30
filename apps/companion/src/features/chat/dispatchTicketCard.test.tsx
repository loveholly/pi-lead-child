// @vitest-environment jsdom
// 一件事，一张卡（2026-10-17，会话方案第五版）。用 10-16 #77 那一段的数据：派活的工单卡、child #88 的完成汇报、
// Lead 在一个安静回合里写的批注。以前会话里出三块；现在只剩一张合一卡片，点开浮层看 child 的汇报。
import type { KernelCheckpoint, KernelConversationCard, TicketSummary } from '@pi-lead-child/protocol';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const report: KernelCheckpoint = {
  id: 186, ticketId: 77, attemptId: 88, author: { kind: 'executor', runtime: 'codex' }, source: 'agent_reported',
  kind: 'completed', stage: null, title: '目标技能已核查，提交 review',
  summary: '四项目标技能均已存在，且均有 SKILL.md。本次没有安装或覆盖。', keyFacts: [], artifactRefs: [], relatedTicketIds: [],
  nextStep: '等待独立 review', actionRef: null, createdAt: '2026-10-16T10:25:15.000Z',
};

const done: TicketSummary = {
  id: 77, title: '安装 Matt Pocock skills：retro、implement spec', summary: '', kind: 'task', hasRun: true, priority: 'normal',
  project: 'skills', dueAt: null, deferUntil: null, updatedAt: '2026-10-16T10:27:19.000Z',
  stageChangedAt: '2026-10-16T10:27:19.000Z',
  runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
  stage: 'done', status: 'done',
};

function ticketCard(id: number, turnId: string, names: string[], createdAt: string): KernelConversationCard {
  return {
    id, key: `turn:${turnId}:ticket:77`, kind: 'ticket_execution', turnId, ticketId: 77,
    operations: names.map((name, index) => ({ id: `${turnId}:${index}`, name, state: 'completed', label: name, detail: null })),
    operationsTruncated: false, createdAt, updatedAt: createdAt,
  } as KernelConversationCard;
}

function render() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([done]);
  runtime.control.getState().mergeConversationCardPage({
    items: [
      ticketCard(148, 'turn-dispatch', ['add_comment', 'spawn_child'], '2026-10-16T10:23:20.000Z'),
      {
        id: 149, key: 'checkpoint:186', kind: 'checkpoint', turnId: null, ticketId: 77, checkpointId: 186,
        createdAt: report.createdAt, updatedAt: report.createdAt,
      } as KernelConversationCard,
      ticketCard(150, 'turn-quiet', ['add_comment'], '2026-10-16T10:25:41.000Z'),
    ],
    checkpoints: [report], interventionRefs: [], hasMore: false, nextBeforeId: null,
  }, 'replace');
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return runtime;
}

describe('one card for one dispatch', () => {
  it('shows the dispatch as one card, without the child message card or the bookkeeping card', () => {
    render();
    const card = screen.getByTestId('dispatch-card-77');
    expect(within(card).getByText('#77')).toBeTruthy();
    expect(within(card).getByText('完成')).toBeTruthy();
    // 两条：child 的完成汇报、工单完成。
    expect(within(card).getByText('2 条')).toBeTruthy();
    expect(screen.queryByTestId('checkpoint-card-186')).toBeNull();
    expect(screen.queryByTestId('open-ticket-77')).toBeNull();
    expect(screen.queryByTestId('ticket-chip-77')).toBeNull();
    expect(screen.getAllByTestId(/^dispatch-card-77$/)).toHaveLength(1);
  });

  it('opens a panel with the child report and the ending, and closes it again', async () => {
    render();
    expect(screen.queryByTestId('dispatch-card-77-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 #77 的进展' }));
    // react-native-web 的 measureInWindow 是异步的：量完卡片的位置才打开浮层。
    const panel = await screen.findByTestId('dispatch-card-77-panel');
    expect(within(panel).getByText('目标技能已核查，提交 review')).toBeTruthy();
    expect(within(panel).getByText('四项目标技能均已存在，且均有 SKILL.md。本次没有安装或覆盖。')).toBeTruthy();
    expect(within(panel).getByText('工单已完成')).toBeTruthy();
    // 那一刻的说法，不是现在的状态；过时的「下一步」不再出现。
    expect(within(panel).getByText('已提交复核')).toBeTruthy();
    expect(within(panel).queryByText('等待独立 review')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: '收起 #77 的进展' }));
    expect(screen.queryByTestId('dispatch-card-77-panel')).toBeNull();
  });

  it('opens the ticket from the ticket number, not the panel', () => {
    const runtime = render();
    fireEvent.click(screen.getByRole('button', { name: '打开工单 #77 详情' }));
    expect(runtime.workspace.getState().selectedTicketId).toBe(77);
    expect(screen.queryByTestId('dispatch-card-77-panel')).toBeNull();
  });
});

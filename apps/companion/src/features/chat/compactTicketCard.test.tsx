// @vitest-environment jsdom
// 2026-10-15 用户决定（方案 A 画布评论）：会话里的工单卡要紧凑，不写「打开线程」「点右侧…」这类提示，
// 用 UI 元素（右侧的圆形箭头）提示可以点。卡片两行：编号、标题、状态；第二行是现状。
// 同一段对话里同一张工单只完整出现一次，再提到时折叠成一个小标签。
// （#66 那次：同一张卡 20 分钟出现 4 次，每次两行机器标题加英文工具名。）
import type { TicketSummary } from '@pi-lead-child/protocol';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { ticketDisplayTitle, ticketNowLine, ticketSummaryToTicket, type Ticket } from '../workspace/model';
import { EmbeddedTicketCard } from './EmbeddedTicketCard';
import { collapsedTicketCardIds, type LeadTimelineItem } from './LeadConversation';
import type { ConversationCardEntity } from '../../state/types';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const MACHINE_TITLE = '[E2E #51 T48-E2E-51-20260817061106] FINAL #45 implementation - outcome snapshot and registry mechanism';

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 66,
    title: MACHINE_TITLE,
    summary: '',
    kind: 'task',
    hasRun: true,
    priority: 'normal',
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-10-15T09:57:00.000Z',
    parentTicketId: null,
    rootTicketId: 66,
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'review',
    status: 'review',
    ...overrides,
  };
}

describe('the ticket title in the conversation', () => {
  it('drops machine prefixes in square brackets', () => {
    expect(ticketDisplayTitle({ title: MACHINE_TITLE })).toBe('FINAL #45 implementation - outcome snapshot and registry mechanism');
    expect(ticketDisplayTitle({ title: '【E2E】 修复 #66' })).toBe('修复 #66');
  });

  it('keeps a plain title, and a title that is only a bracket', () => {
    expect(ticketDisplayTitle({ title: '成果快照与登记机制' })).toBe('成果快照与登记机制');
    expect(ticketDisplayTitle({ title: '[草稿]' })).toBe('[草稿]');
  });
});

describe('the current state line', () => {
  it('names the running Run, its runtime and how long it has run', () => {
    const ticket: Ticket = {
      ...ticketSummaryToTicket(summary()),
      heartbeat: true,
      agentLabel: 'child #87',
      runtimeName: 'codex',
      elapsedMs: 12 * 60_000,
    };
    expect(ticketNowLine(ticket)).toBe('Run #87 · Codex · 已 12 分钟');
  });

  it('is empty when nothing runs and there is nothing to say', () => {
    expect(ticketNowLine(ticketSummaryToTicket(summary({ stage: 'ready', status: 'ready', hasRun: false })))).toBeNull();
  });
});

describe('the compact ticket card', () => {
  it('shows number, short title and status on one line, with an arrow instead of a hint', () => {
    renderUI(<EmbeddedTicketCard ticket={ticketSummaryToTicket(summary())} onPress={() => {}} />);
    expect(screen.getByText('#66')).toBeTruthy();
    expect(screen.getByText('FINAL #45 implementation - outcome snapshot and registry mechanism')).toBeTruthy();
    expect(screen.queryByText(/E2E #51/)).toBeNull();
    expect(screen.queryByText('点右侧从这张卡打开任务线程。')).toBeNull();
    expect(screen.queryByText('普通')).toBeNull();
    expect(screen.getByTestId('open-ticket-66-arrow')).toBeTruthy();
  });
});

describe('a ticket mentioned again in the same day', () => {
  const card = (id: string, ticketId: number): ConversationCardEntity => ({
    id, key: `turn:${id}:ticket:${ticketId}`, kind: 'ticket_execution', turnId: id, ticketId,
    operations: [], operationsTruncated: false, createdAt: '2026-10-15T09:57:00.000Z', updatedAt: '2026-10-15T09:57:00.000Z',
  } as unknown as ConversationCardEntity);

  it('collapses into a small tag after the first full card, and starts over on a new day', () => {
    const cards = Object.fromEntries([card('a', 66), card('b', 66), card('c', 72), card('d', 66)].map((value) => [value.id, value]));
    const timeline: LeadTimelineItem[] = [
      { kind: 'date', key: 'd1', label: '昨天' },
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['a'] },
      { kind: 'message', key: 'm2', messageId: 'm2', cardIds: ['b', 'c'] },
      { kind: 'date', key: 'd2', label: '今天' },
      { kind: 'message', key: 'm3', messageId: 'm3', cardIds: ['d'] },
    ];
    expect([...collapsedTicketCardIds(timeline, cards)]).toEqual(['b']);
  });
});

// master 的 v39：Lead 用 set_display_title 写的短标题。会话里的卡片和工单列表用同一个名字。
describe('a display title from Lead', () => {
  it('is what the conversation shows, before any prefix stripping', () => {
    const ticket = ticketSummaryToTicket(summary({ displayTitle: '成果快照与登记机制' }));
    expect(ticketDisplayTitle(ticket)).toBe('成果快照与登记机制');
  });
});


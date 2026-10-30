// @vitest-environment jsdom
// 2026-10-15 方案 A「Lead 动态」：Lead 处理了、但没有对用户说的事（延后、不处理、自己处理好），
// 在会话里收成一块淡色的动态，按时间放在对话中间，不占对话回合。
// 一句话也没说的 Lead 主动回合（只调了工具）也不再画成一个空回合（#66 那次 18:14 的「3 个工具 · 1 秒」）。
import { leadActivityCardFromItem, type LeadActivityCard, type LeadActivityItem } from '@pi-lead-child/protocol';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import type { MessageEntity } from '../../state/types';
import { LeadActivityBlockView, leadActivityRange } from './LeadActivityBlock';
import { buildLeadTimeline } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function message(id: string, role: MessageEntity['role'], at: string, turnId = id): MessageEntity {
  return {
    id, sessionId: 'session-1', turnId, ticketId: null, role, state: 'completed', failure: null,
    clientCommandId: role === 'user' ? `command-${id}` : null, source: 'snapshot', createdAt: at, updatedAt: at,
  };
}

// 以前的一条 Lead 处置（inbox 行）换成卡片的样子：一行一张卡，key 是 inbox:<id>。
function activity(id: number, at: string, disposition: LeadActivityItem['disposition'], reason: string): LeadActivityCard {
  return leadActivityCardFromItem({ id, at, disposition, reason, summary: `事件 ${id}`, ticketId: 66 });
}

describe('Lead activity in the timeline', () => {
  const lead1804 = message('a1804', 'assistant', '2026-10-15T10:04:26.000Z');
  const silent1814 = message('a1814', 'assistant', '2026-10-15T10:14:41.000Z');
  const lead1815 = message('a1815', 'assistant', '2026-10-15T10:15:10.000Z');
  const items = [
    activity(108, '2026-10-15T10:10:29.000Z', 'deferred', '等最终结论一起说'),
    activity(110, '2026-10-15T10:14:40.000Z', 'no_action', '这些是核查的发现，不是故障'),
  ];

  it('places what Lead handled quietly between the messages, as one block', () => {
    const timeline = buildLeadTimeline([lead1804, lead1815], [], [], { leadActivity: items });
    expect(timeline.map((item) => item.kind)).toEqual(['message', 'lead-activity', 'message']);
    expect(timeline[1]).toMatchObject({ kind: 'lead-activity', ids: ['inbox:108', 'inbox:110'] });
  });

  it('drops a Lead turn that said nothing, so the activity stays one block', () => {
    const timeline = buildLeadTimeline([lead1804, silent1814, lead1815], [], [], {
      leadActivity: items,
      isSilent: (value) => value.id === silent1814.id,
    });
    expect(timeline.map((item) => item.kind)).toEqual(['message', 'lead-activity', 'message']);
  });

  // 2026-10-24 线上：21:44 那一轮 Lead 对你说了「#117 的派发挂起了，等你 claude login」，同一轮里记了 4 条处置；
  // 21:45 一轮没说话，又记了同一件事的后续。会话里多出两块「动态」，第一块 4 行一模一样，第二块重复上面的话。
  // 说过的事挂在说它的那一轮下面；之后没有新对话时，同一个对象的后续也挂在那一轮下面。
  describe('folded into the turn that told you', () => {
    const turn = (id: string, role: MessageEntity['role'], from: string, to: string): MessageEntity => ({
      ...message(id, role, from), updatedAt: to,
    });
    const told = turn('a2144', 'assistant', '2026-10-24T13:44:31.803Z', '2026-10-24T13:44:37.000Z');
    const sameTime = '2026-10-24T13:44:31.814Z';
    const handledInTurn = [264, 265, 267].map((id) => activity(id, sameTime, 'handled', '已明确原因并提供终端切换命令'));
    const followUp = activity(271, '2026-10-24T13:45:23.998Z', 'handled', '等待用户执行 claude login');

    it('hangs what Lead handled in a turn it spoke under that turn, not in a block', () => {
      const timeline = buildLeadTimeline([told], [], [], { leadActivity: handledInTurn });
      expect(timeline).toEqual([expect.objectContaining({ kind: 'message', messageId: 'a2144', activityIds: ['inbox:264', 'inbox:265', 'inbox:267'] })]);
    });

    it('hangs a later follow-up of the same object there too, while nobody said anything in between', () => {
      const timeline = buildLeadTimeline([told], [], [], { leadActivity: [...handledInTurn, followUp] });
      expect(timeline.map((item) => item.kind)).toEqual(['message']);
      expect(timeline[0]).toMatchObject({ activityIds: ['inbox:264', 'inbox:265', 'inbox:267', 'inbox:271'] });
    });

    it('keeps a follow-up as activity once you have said something since', () => {
      const asked = message('u2145', 'user', '2026-10-24T13:45:00.000Z');
      const timeline = buildLeadTimeline([told, asked], [], [], { leadActivity: [...handledInTurn, followUp] });
      expect(timeline.map((item) => item.kind)).toEqual(['message', 'message', 'lead-activity']);
      expect(timeline[2]).toMatchObject({ ids: ['inbox:271'] });
    });

    it('keeps what Lead has not handled yet as activity', () => {
      const open: LeadActivityCard = { ...activity(300, '2026-10-24T13:44:33.000Z', 'handled', 'x'), state: 'open', lead: null };
      const timeline = buildLeadTimeline([told], [], [], { leadActivity: [open] });
      expect(timeline.map((item) => item.kind)).toEqual(['lead-activity', 'message']);
    });
  });

  it('says the time range and how many things in the header', () => {
    expect(leadActivityRange(items)).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    expect(leadActivityRange(items.slice(0, 1))).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('the Lead activity block', () => {
  const items = [
    activity(108, '2026-10-15T10:10:29.000Z', 'deferred', '等最终结论一起说'),
    activity(110, '2026-10-15T10:14:40.000Z', 'no_action', '这些是核查的发现，不是故障'),
  ];

  // 2026-10-27 画布「后台处理记录」：记录块，标题「Paimon 在后台处理了 2 件事 · 时间」；展开在浮层里。
  it('lists each thing with its disposition and reason, and collapses again', async () => {
    renderUI(<LeadActivityBlockView items={items} leadName="Paimon" defaultExpanded onOpenTicket={() => {}} />);
    const panel = await screen.findByTestId('lead-activity-panel');
    expect(screen.getAllByText(/^Paimon 在后台处理了 2 件事 · /).length).toBeGreaterThan(0);
    expect(within(panel).getByText('延后')).toBeTruthy();
    expect(within(panel).getByText('不处理')).toBeTruthy();
    expect(within(panel).getByText('Paimon：这些是核查的发现，不是故障')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起记录' }));
    expect(screen.queryByTestId('lead-activity-panel')).toBeNull();
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy();
  });

  // 2026-10-24 用户反馈：收起时只有一行「动态 · 4 件」，每次都要点开。收起时每件事一行摘要；展开才看依据。
  it('shows a one-line summary of each thing while collapsed, and the basis only when expanded', async () => {
    const withBasis = items.map((item) => ({ ...item, basis: [{ kind: 'order' as const, id: 'inbox.wake_lead', version: 1 }] }));
    renderUI(<LeadActivityBlockView items={withBasis} leadName="Paimon" onOpenTicket={() => {}} />);
    // 摘要里的数字加粗，文字拆成了几段：按整行读。
    expect(screen.getByTestId('lead-activity-inbox:108').textContent).toContain('事件 108');
    expect(screen.getByTestId('lead-activity-inbox:110').textContent).toContain('事件 110');
    expect(screen.queryByTestId('lead-activity-note')).toBeNull();
    expect(screen.queryByTestId('lead-activity-basis')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect((await screen.findAllByTestId('lead-activity-note')).map((note) => note.textContent))
      .toEqual(['Paimon：等最终结论一起说', 'Paimon：这些是核查的发现，不是故障']);
    expect(screen.getAllByTestId('lead-activity-basis')).toHaveLength(2);
  });

  // 线上 21:44：Lead 一次处置了 4 件事，理由一样，画成了 4 行一模一样的。同一次处置合成一行，写件数。
  it('merges the things Lead handled with one disposition into one row', async () => {
    const at = '2026-10-24T13:44:31.814Z';
    const same = [264, 265, 267, 266].map((id) => activity(id, at, 'handled', '已明确原因并提供终端切换命令'));
    renderUI(<LeadActivityBlockView items={same} leadName="Paimon" defaultExpanded onOpenTicket={() => {}} />);
    const panel = await screen.findByTestId('lead-activity-panel');
    expect(screen.getAllByTestId(/^lead-activity-inbox:/)).toHaveLength(1);
    expect(within(panel).getByText('4 件')).toBeTruthy();
    expect(screen.getAllByText('Paimon：已明确原因并提供终端切换命令')).toHaveLength(1);
    expect(screen.getAllByTestId('lead-activity-thing').map((thing) => thing.textContent)).toEqual(['事件 265', '事件 267', '事件 266']);
  });
});

// 2026-10-28 用户截图：13 次「允许写入」，会话里切成 4 个记录块，中间夹着 13 行「你刚刚允许…」。
// 改版稿第 2 组：卡上带着你做的主人操作（ownerAction），那一行并进记录；同一个对象的同一种操作合成一行，没做成的单独一行。
describe('what you approved, carried on the record', () => {
  const approved = (id: number, at: string, failed = false): LeadActivityCard => ({
    ...activity(id, at, 'handled', '已经执行，不用再说'),
    entityKey: `connection_confirmation:cfm_${id}`,
    summary: `用户允许了写入，已经执行：GitHub 的 add_comment（第 ${id} 条）`,
    ownerAction: {
      eventId: `0190a2b4-0000-7000-8000-${String(id).padStart(12, '0')}`, action: 'connection.confirm',
      summary: `允许GitHub写入：在 PR #119 加第 ${id}/13 条行内评论`, target: 'GitHub 的写入确认', failed,
    },
  });
  const cards = [
    approved(1, '2026-10-28T02:29:01.000Z'),
    approved(2, '2026-10-28T02:29:20.000Z'),
    approved(3, '2026-10-28T02:29:40.000Z'),
    approved(4, '2026-10-28T02:30:05.000Z', true),
  ];

  it('drops the approval lines the record carries, so the record stays one block', () => {
    const notes = cards.map((card, index) => message(`own${index}`, 'assistant', new Date(Date.parse(card.at) - 1_000).toISOString()));
    const timeline = buildLeadTimeline(notes, [], [], {
      leadActivity: cards,
      isOwnOwnerAction: () => true,
      isCarriedOwnerAction: (value) => value.id !== 'own3',
    });
    // 第 4 条没有带在卡上（例如卡不在快照里）：它照常是一行记录，把块切开。
    expect(timeline.map((item) => item.kind)).toEqual(['lead-activity', 'message', 'lead-activity']);
  });

  it('merges approvals of the same kind into one row, and writes the failed one on its own', async () => {
    renderUI(<LeadActivityBlockView items={cards} leadName="Fairy" onOpenTicket={() => {}} />);
    const ok = screen.getByTestId('lead-activity-inbox:1');
    expect(ok.textContent).toContain('你允许了');
    expect(ok.textContent).toContain('GitHub 的写入确认');
    expect(ok.textContent).toContain('3 件');
    expect(ok.textContent).not.toContain('用户允许了写入');
    expect(screen.getByTestId('lead-activity-inbox:4').textContent).toContain('你允许了，没做成');
    expect(screen.getByTestId('lead-activity-inbox:4').textContent).toContain('允许GitHub写入：在 PR #119 加第 4/13 条行内评论');
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const entries = await screen.findByTestId('lead-activity-owner-entries');
    expect(entries.textContent).toContain('加第 2/13 条行内评论');
  });

  it('groups the lines you made one after another on this device into one', () => {
    const notes = ['n1', 'n2', 'n3'].map((id, index) => message(id, 'assistant', `2026-10-28T02:46:0${index}.000Z`));
    const timeline = buildLeadTimeline(notes, [], [], { isOwnOwnerAction: () => true });
    expect(timeline).toEqual([expect.objectContaining({ kind: 'owner-action-group', messageIds: ['n1', 'n2', 'n3'], own: true })]);
  });
});

// 一件事，一张卡（2026-10-17，会话方案第五版）。10-16 的 #77：Lead 派活以后，会话里先后出了大工单卡、
// 「来自 child #88 的消息」、一张只写了批注的小工单卡，完成一件事画了三四块。
import type { KernelCheckpoint, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import type { ConversationCardEntity } from '../../state/types';
import { canFoldCheckpoint, dispatchUpdates, foldTicketDispatches, isDispatchCard } from './dispatchCards';
import type { LeadTimelineItem } from './LeadConversation';

function ticketCard(id: string, ticketId: number, names: string[], createdAt: string, state = 'completed'): ConversationCardEntity {
  return {
    id, durableId: null, source: 'durable', key: `turn:${id}:ticket:${ticketId}`, kind: 'ticket_execution', turnId: id, ticketId,
    operations: names.map((name, index) => ({ id: `${id}:${index}`, name, state, label: name, detail: null })),
    operationsTruncated: false, createdAt, updatedAt: createdAt,
  } as unknown as ConversationCardEntity;
}

function checkpointCard(id: string, ticketId: number, checkpointId: number, createdAt: string): ConversationCardEntity {
  return {
    id, durableId: null, source: 'durable', key: `checkpoint:${checkpointId}`, kind: 'checkpoint', turnId: null, ticketId,
    checkpointId, createdAt, updatedAt: createdAt,
  } as unknown as ConversationCardEntity;
}

function checkpoint(id: number, kind: KernelCheckpoint['kind'], createdAt: string, title: string, overrides: Partial<KernelCheckpoint> = {}): KernelCheckpoint {
  return {
    id, ticketId: 77, attemptId: 88, author: { kind: 'executor', runtime: 'codex' }, source: 'agent_reported',
    kind, stage: null, title, summary: `${title}的说明`, keyFacts: [], artifactRefs: [], relatedTicketIds: [],
    nextStep: null, actionRef: null, createdAt, ...overrides,
  } as KernelCheckpoint;
}

function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? 'done';
  return {
    id: 77, title: '安装 Matt Pocock skills', summary: '', kind: 'task', hasRun: true, priority: 'normal', project: null,
    dueAt: null, deferUntil: null, updatedAt: '2026-10-16T10:27:19.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides, stage, status: stage,
  } as TicketSummary;
}

const T = (clock: string) => `2026-10-16T${clock}.000Z`;
const cards = (...values: ConversationCardEntity[]) => Object.fromEntries(values.map((card) => [card.id, card]));

describe('folding the conversation around a dispatch', () => {
  const dispatch = ticketCard('dispatch', 77, ['add_comment', 'spawn_child'], T('10:23:20'));
  const childMessage = checkpointCard('c186', 77, 186, T('10:25:15'));
  const quietComment = ticketCard('quiet', 77, ['add_comment'], T('10:25:41'));
  const closingComment = ticketCard('closing', 77, ['add_comment'], T('10:27:34'));

  it('puts the child messages after a dispatch into its card, and drops cards that only hold Lead bookkeeping', () => {
    const timeline: LeadTimelineItem[] = [
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['dispatch'] },
      { kind: 'card', key: 'card:c186', cardId: 'c186' },
      { kind: 'card', key: 'card:quiet', cardId: 'quiet' },
      { kind: 'message', key: 'm2', messageId: 'm2', cardIds: ['closing'] },
    ];
    const folded = foldTicketDispatches(timeline, cards(dispatch, childMessage, quietComment, closingComment), () => true);
    expect(folded.items).toEqual([
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['dispatch'] },
      { kind: 'message', key: 'm2', messageId: 'm2', cardIds: [] },
    ]);
    expect(folded.windows).toEqual({ dispatch: { from: T('10:23:20'), until: null, checkpointIds: [186] } });
  });

  it('keeps a child message in the conversation when it still needs you', () => {
    const timeline: LeadTimelineItem[] = [
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['dispatch'] },
      { kind: 'card', key: 'card:c186', cardId: 'c186' },
    ];
    const folded = foldTicketDispatches(timeline, cards(dispatch, childMessage), () => false);
    expect(folded.items.map((item) => item.key)).toEqual(['m1', 'card:c186']);
    expect(folded.windows.dispatch!.checkpointIds).toEqual([]);
  });

  it('starts a new card at the next dispatch of the same ticket, and ends the old one there', () => {
    const rework = ticketCard('rework', 77, ['recover_ticket_run'], T('11:00:00'));
    const later = checkpointCard('c190', 77, 190, T('11:05:00'));
    const timeline: LeadTimelineItem[] = [
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['dispatch'] },
      { kind: 'card', key: 'card:c186', cardId: 'c186' },
      { kind: 'card', key: 'card:rework', cardId: 'rework' },
      { kind: 'card', key: 'card:c190', cardId: 'c190' },
    ];
    const folded = foldTicketDispatches(timeline, cards(dispatch, childMessage, rework, later), () => true);
    expect(folded.items.map((item) => item.key)).toEqual(['m1', 'card:rework']);
    expect(folded.windows.dispatch).toEqual({ from: T('10:23:20'), until: T('11:00:00'), checkpointIds: [186] });
    expect(folded.windows.rework).toEqual({ from: T('11:00:00'), until: null, checkpointIds: [190] });
  });

  it('leaves a child message alone when nothing was dispatched before it, and another ticket alone', () => {
    const other = checkpointCard('c300', 66, 300, T('10:24:00'));
    const timeline: LeadTimelineItem[] = [
      { kind: 'card', key: 'card:c186', cardId: 'c186' },
      { kind: 'message', key: 'm1', messageId: 'm1', cardIds: ['dispatch'] },
      { kind: 'card', key: 'card:c300', cardId: 'c300' },
    ];
    const folded = foldTicketDispatches(timeline, cards(dispatch, childMessage, other), () => true);
    expect(folded.items.map((item) => item.key)).toEqual(['card:c186', 'm1', 'card:c300']);
  });

  it('does not count a failed spawn as a dispatch', () => {
    expect(isDispatchCard(ticketCard('x', 77, ['spawn_child'], T('10:00:00'), 'failed'))).toBe(false);
    expect(isDispatchCard(ticketCard('y', 77, ['spawn_child'], T('10:00:00'), 'started'))).toBe(true);
    expect(isDispatchCard(ticketCard('z', 77, ['cancel_item'], T('10:00:00')))).toBe(false);
  });
});

describe('which child messages can go into the card', () => {
  it('keeps a block in the conversation while the ticket is still blocked', () => {
    const blocked = checkpoint(1, 'blocked', T('10:00:00'), '网络失败');
    expect(canFoldCheckpoint(blocked, ticket({ stage: 'blocked' }))).toBe(false);
    expect(canFoldCheckpoint(blocked, ticket({ stage: 'active' }))).toBe(true);
    expect(canFoldCheckpoint(blocked, undefined)).toBe(false);
    expect(canFoldCheckpoint(checkpoint(2, 'completed', T('10:00:00'), '已核查'), ticket({ stage: 'blocked' }))).toBe(true);
  });
});

describe('the key updates in the panel', () => {
  const scope = { from: T('10:23:20'), until: null, checkpointIds: [186] };
  const checkpoints = [
    checkpoint(184, 'progress', T('10:23:23'), 'Run started'),
    checkpoint(185, 'milestone', T('10:24:08'), '四项目标技能均已存在'),
    checkpoint(186, 'completed', T('10:25:15'), '目标技能已核查，提交 review'),
    // 10-08 那次失败：在这次派活以前，不算这次的更新。
    checkpoint(140, 'blocked', '2026-10-08T11:37:00.000Z', '网络失败'),
  ];

  it('lists milestones and reports since the dispatch, oldest first, without progress pings', () => {
    const rows = dispatchUpdates({ ticketId: 77, scope, checkpoints, ticket: ticket({ stage: 'review' }) });
    expect(rows.map((row) => [row.label, row.title])).toEqual([
      ['阶段完成', '四项目标技能均已存在'],
      ['已提交复核', '目标技能已核查，提交 review'],
    ]);
    expect(rows[0]!.body).toBeNull();
    expect(rows[1]!.body).toBe('目标技能已核查，提交 review的说明');
    expect(rows[1]!.source).toBe('child #88');
  });

  it('ends with the ending when the ticket finished inside this dispatch', () => {
    const rows = dispatchUpdates({ ticketId: 77, scope, checkpoints, ticket: ticket({ stage: 'done', stageChangedAt: T('10:27:19') }) });
    expect(rows.at(-1)).toMatchObject({ label: '进入终态', title: '工单已完成', tone: 'success', at: T('10:27:19') });
  });

  // gateway 只在 review 阶段给核查结论（reviewState）；结单以后不知道是谁验收的，就不说「核查通过」。
  it('ends with the review verdict while the ticket waits in review', () => {
    const waiting = ticket({
      stage: 'review',
      stageChangedAt: T('10:25:27'),
      reviewState: { state: 'review_failed', label: '核查不通过，等你决定', reviewerAttemptId: 89, verdict: 'fail', reason: '两个核心缺陷都已复现' } as TicketSummary['reviewState'],
    });
    const rows = dispatchUpdates({ ticketId: 77, scope, checkpoints, ticket: waiting });
    expect(rows.at(-1)).toMatchObject({ label: '核查不通过', source: 'reviewer #89', title: '核查不通过，等你决定', body: '两个核心缺陷都已复现', tone: 'danger' });
    const pending = ticket({ stage: 'review', stageChangedAt: T('10:25:27'), reviewState: { state: 'independent_review', label: '独立核查进行中', reviewerAttemptId: null, verdict: null, reason: null } as TicketSummary['reviewState'] });
    expect(dispatchUpdates({ ticketId: 77, scope, checkpoints, ticket: pending }).map((row) => row.id)).toEqual(['checkpoint:185', 'checkpoint:186']);
  });

  it('does not claim an ending that happened before this dispatch', () => {
    const rows = dispatchUpdates({ ticketId: 77, scope, checkpoints, ticket: ticket({ stage: 'done', stageChangedAt: T('09:00:00') }) });
    expect(rows.map((row) => row.id)).toEqual(['checkpoint:185', 'checkpoint:186']);
  });
});

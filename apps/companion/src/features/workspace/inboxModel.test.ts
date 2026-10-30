// 收件箱（阶段 1）的视图模型：每件等你的事一张卡，说清为什么、等了多久，最多一个动作；Lead 自己处理掉的事另列。
import type { InboxTicketFact, LeadHandledEntry, TicketReviewState, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildInboxCards, splitLeadHandled, waitedText } from './inboxModel';
import { ticketSummaryToTicket } from './model';

const now = new Date('2026-10-15T07:46:00.000Z');
const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;

function ticket(id: number, overrides: Partial<TicketSummary> = {}) {
  const stage = overrides.stage ?? 'blocked';
  return ticketSummaryToTicket({
    id, title: `工单 ${id}`, summary: '', kind: 'task', hasRun: true, priority: 'normal', project: 'pi-lead-child',
    dueAt: null, deferUntil: null, updatedAt: '2026-10-15T07:00:00.000Z', parentTicketId: null, rootTicketId: id,
    runtime: stage === 'blocked' ? { ...idle, state: 'blocked' } : idle,
    attention: { pendingApprovalCount: 0, blockerCount: 0 }, ...overrides, stage, status: stage,
  });
}

const notDispatched: TicketReviewState = {
  state: 'independent_review', label: '独立核查未派发', reviewerAttemptId: null, verdict: null,
  reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。', canRequestReview: true, reviewProgress: null, deliveryRunId: 49,
};

const facts: InboxTicketFact[] = [
  { ticketId: 72, reason: 'Run #54 交付的成果格式不合法', since: '2026-08-25T08:01:12.000Z' },
  { ticketId: 51, reason: '阻塞说的是 v16 的旧库', since: '2026-08-17T06:29:57.000Z' },
  { ticketId: 66, reason: notDispatched.reason, since: '2026-08-21T10:48:04.000Z' },
  { ticketId: 90, reason: '等你批准：删除 /tmp/plc-demo', since: '2026-10-15T07:40:00.000Z' },
];

describe('waitedText', () => {
  it('says how long something has waited in the largest whole unit', () => {
    expect(waitedText('2026-08-25T08:01:12.000Z', now)).toBe('50 天');
    expect(waitedText('2026-10-15T04:30:00.000Z', now)).toBe('3 小时');
    expect(waitedText('2026-10-15T07:34:00.000Z', now)).toBe('12 分钟');
    expect(waitedText('2026-10-15T07:45:30.000Z', now)).toBe('刚刚');
  });
});

describe('buildInboxCards', () => {
  const items = [
    ticket(72),
    ticket(51),
    ticket(66, { stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer' }),
    ticket(90, { stage: 'active', runtime: { state: 'running', lastActivityAt: null, activeAttemptId: 3 }, attention: { pendingApprovalCount: 1, blockerCount: 0 } }),
    ticket(18, { stage: 'ready', hasRun: false }),
  ];

  it('lists only what waits for you, approvals first, then what has waited longest', () => {
    expect(buildInboxCards(items, facts, {}, now).map((card) => card.ticketId)).toEqual(['90', '51', '66', '72']);
  });

  it('writes the number, the reason label and how long it has waited, and the reason in full', () => {
    const card = buildInboxCards(items, facts, {}, now).find((entry) => entry.ticketId === '72')!;
    expect(card.meta).toBe('#72 · 需介入 · 等了 50 天');
    expect(card.reason).toBe('Run #54 交付的成果格式不合法');
  });

  it('offers the decision card recommendation as the one action, or opens the ticket', () => {
    const cards = buildInboxCards(items, facts, {}, now);
    expect(cards.find((card) => card.ticketId === '66')!.action).toMatchObject({ id: 'request_review', label: '派发独立核查' });
    // 阻塞的工单没有一键动作：你要先看原因，在工单里决定。
    expect(cards.find((card) => card.ticketId === '72')!.action).toBeNull();
  });

  // 2026-10-16 用户要求：#66 在等你回答 Lead 的决定卡（并入 #72 / 再返工 / 取消），收件箱的主按钮却写「派发独立核查」。
  // 等你回答决定时，收件箱说「待你决定」，不另推荐按阶段算出来的动作；「查看」打开的工单里就是这条决定。
  it('offers no stage action while the ticket waits for your decision', () => {
    const owed = ticket(66, {
      stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer',
      attention: { pendingApprovalCount: 0, blockerCount: 1, pendingDecisionCount: 1 },
    });
    const [card] = buildInboxCards([owed], facts, {}, now);
    expect(card!.meta).toBe('#66 · 待你决定 · 等了 54 天');
    expect(card!.action).toBeNull();
  });

  it('carries the notices folded into the row so acting on it acknowledges them', () => {
    const card = buildInboxCards(items, facts, { 51: [101, 102] }, now).find((entry) => entry.ticketId === '51')!;
    expect(card.noticeIds).toEqual([101, 102]);
    expect(card.meta).toBe('#51 · 需介入 · 等了 59 天 · 2 条通知');
  });
});

describe('splitLeadHandled', () => {
  const entry = (id: string, handledAt: string): LeadHandledEntry => ({
    id, ticketId: 66, problem: 'p', cause: null, action: 'a', followUp: null, eventCount: 1, handledAt,
  });

  it('shows what Lead handled since you last looked and folds the rest', () => {
    const split = splitLeadHandled([
      entry('inbox:3', '2026-10-15T07:43:00.000Z'),
      entry('inbox:2', '2026-10-15T07:34:00.000Z'),
      entry('inbox:1', '2026-10-14T20:00:00.000Z'),
    ], '2026-10-15T01:12:00.000Z');
    expect(split.fresh.map((item) => item.id)).toEqual(['inbox:3', 'inbox:2']);
    expect(split.earlier.map((item) => item.id)).toEqual(['inbox:1']);
  });

  it('shows everything as new before you ever looked', () => {
    expect(splitLeadHandled([entry('inbox:1', '2026-10-14T20:00:00.000Z')], null).fresh).toHaveLength(1);
  });
});

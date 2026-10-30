// @vitest-environment jsdom
// 收件箱是一个行动队列（阶段 1，方向 A）。以前它就是工单列表加一个筛选：每行都写「阻塞 · 需要介入」，
// 不说原因、不说等了多久、没有动作；Lead 自己修好的事也看不到。
// 这里按实例上的工单渲染真正的 Workbench，读用户看到和能点的东西。
import type { InboxView, NotificationDto, TicketReviewState, TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import Workbench from './Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const now = new Date('2026-10-15T07:46:00.000Z');
const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;

function ticket(id: number, title: string, overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? 'blocked';
  return {
    id, title, summary: '', kind: 'task', hasRun: true, priority: 'normal', project: 'pi-lead-child',
    dueAt: null, deferUntil: null, updatedAt: '2026-10-15T07:00:00.000Z', parentTicketId: null, rootTicketId: id,
    runtime: stage === 'blocked' ? { ...idle, state: 'blocked' } : idle,
    attention: { pendingApprovalCount: 0, blockerCount: 0 }, ...overrides, stage, status: stage,
  };
}

const notDispatched: TicketReviewState = {
  state: 'independent_review', label: '独立核查未派发', reviewerAttemptId: null, verdict: null,
  reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。', canRequestReview: true, reviewProgress: null, deliveryRunId: 49,
};

const tickets = [
  ticket(72, '修复 review 状态投影与返工耗尽通知', {
    nextMilestone: { id: 5, kind: 'test_handoff', label: '提测', at: '2026-10-16T10:00:00.000Z', allDay: false },
  }),
  ticket(66, '成果快照与登记机制', { stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer' }),
  ticket(77, '安装 Matt Pocock skills', { stage: 'active', runtime: { state: 'running', lastActivityAt: null, activeAttemptId: 86 } }),
];

const inbox: InboxView = {
  tickets: [
    { ticketId: 72, reason: 'Run #54 交付的成果格式不合法', since: '2026-08-25T08:01:12.000Z' },
    { ticketId: 66, reason: notDispatched.reason, since: '2026-08-21T10:48:04.000Z' },
  ],
  leadHandled: [{
    id: 'inbox:120', ticketId: 77, problem: 'Run #64 崩溃：等网络时超时',
    cause: '网络中断', action: '网络恢复后重派 Run #86', followUp: null, eventCount: 3, handledAt: '2026-10-15T07:43:00.000Z',
  }],
  seenAt: '2026-10-15T01:12:00.000Z',
};

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

function reminder(id: number, createdAt: string): NotificationDto {
  return {
    id, ticketId: 200 + id, kind: 'reminder', dedupKey: null, urgency: 'immediate', title: `提醒 ${id}`, body: '',
    state: 'delivered', createdAt, deliveredAt: createdAt, deliveredVia: 'fallback', ackedAt: null,
  };
}

function render(options: { loaded?: boolean; notifications?: NotificationDto[] } = {}) {
  const client = {
    requestTicketReview: vi.fn(async () => ({})),
    markInboxSeen: vi.fn(async () => now.toISOString()),
    getInbox: vi.fn(async () => inbox),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => now.getTime() },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(tickets);
  if (options.notifications) runtime.control.getState().replaceNotifications(options.notifications);
  if (options.loaded !== false) runtime.control.getState().replaceInbox(inbox);
  runtime.workspace.setState({ hydrated: true });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  return { client, runtime };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  setWidth(1280);
});
afterEach(() => {
  vi.useRealTimers();
  setWidth(0);
});

describe('the inbox as an action queue', () => {
  it('gives every ticket that waits for you a card with why, how long and one action', () => {
    const { client } = render();

    const blocked = screen.getByTestId('inbox-card-72');
    expect(within(blocked).getByText('#72 · 需介入 · 等了 50 天')).toBeTruthy();
    expect(within(blocked).getByText('Run #54 交付的成果格式不合法')).toBeTruthy();
    // 阻塞的工单没有一键动作：只有「查看」。
    expect(within(blocked).queryByTestId('inbox-action-72')).toBeNull();

    const review = screen.getByTestId('inbox-card-66');
    fireEvent.click(within(review).getByTestId('inbox-action-66'));
    expect(client.requestTicketReview).toHaveBeenCalledWith(66);
  });

  it('opens the ticket from the card', () => {
    const { runtime } = render();
    fireEvent.click(screen.getByTestId('inbox-open-72'));
    expect(runtime.workspace.getState().selectedTicketId).toBe(72);
  });

  it('lists what Lead handled since you last looked, with the cause and what it did, outside the count', () => {
    const { client } = render();

    const handled = screen.getByTestId('lead-handled');
    expect(within(handled).getByText('Paimon 已处理')).toBeTruthy();
    fireEvent.click(within(handled).getByTestId('lead-handled-inbox:120'));
    expect(within(handled).getByText('Run #64 崩溃：等网络时超时')).toBeTruthy();
    expect(within(handled).getByText('网络中断')).toBeTruthy();
    expect(within(handled).getByText('网络恢复后重派 Run #86')).toBeTruthy();
    // 「需要你」只数等你的工单。
    expect(within(screen.getByTestId('inbox-queue')).getByText('需要你')).toBeTruthy();
    expect(within(screen.getByTestId('inbox-needs-count')).getByText('2')).toBeTruthy();
    // 打开收件箱就记下「看过了」。
    expect(client.markInboxSeen).toHaveBeenCalledTimes(1);
  });

  // 实机截图（2026-10-15）：收件箱一打开就记「看过了」，那时数据还没到；第一次拿到的 seenAt 已经是现在，
  // Lead 刚处理的两件事全被收进「更早」。要先拿到上次看的时间，再记这一次。
  it('records the visit only after it knows when you last looked', () => {
    const { client, runtime } = render({ loaded: false });
    expect(client.markInboxSeen).not.toHaveBeenCalled();

    act(() => runtime.control.getState().replaceInbox(inbox));
    expect(client.markInboxSeen).toHaveBeenCalledTimes(1);
    // 服务端已经记下了这一次；这一次打开仍按上次的时间算，Lead 刚处理的事还是新的。
    act(() => runtime.control.getState().replaceInbox({ ...inbox, seenAt: now.toISOString() }));
    expect(within(screen.getByTestId('lead-handled')).getByTestId('lead-handled-inbox:120')).toBeTruthy();
    expect(client.markInboxSeen).toHaveBeenCalledTimes(1);
  });

  // 阶段 3：卡上带最近的节点（提测 明天 18:00），一眼看出哪件事有日期压着。
  it('tags a card with the ticket\'s next milestone', () => {
    render();
    expect(within(screen.getByTestId('inbox-card-72')).getByText('提测 明天 18:00')).toBeTruthy();
  });

  // 决定 3：已触发、没有确认的提醒，30 天后从收件箱收起（它们在日程的「已过期」里）。
  it('folds reminders that have waited more than 30 days', () => {
    render({ notifications: [
      reminder(1, '2026-10-14T09:00:00.000Z'),
      reminder(2, '2026-07-29T09:00:00.000Z'),
      reminder(3, '2026-07-28T09:00:00.000Z'),
    ] });
    const card = screen.getByTestId('reminder-notices');
    expect(within(card).getByText('1 条提醒没有确认')).toBeTruthy();
    expect(within(card).getByText('另有 2 条超过 30 天，收在日程的「已过期」里')).toBeTruthy();
  });

  it('can reach zero', () => {
    const { runtime } = render();
    act(() => runtime.control.getState().replaceTickets([tickets[2]!]));
    expect(screen.getByText('没有需要你的事')).toBeTruthy();
  });
});

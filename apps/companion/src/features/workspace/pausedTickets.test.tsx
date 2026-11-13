// @vitest-environment jsdom
// 工单 #111（2026-11-06）：「#26 和 #28 从 11-04 起一直停着，#89 暂停，这两种我都没办法直观的看到，还需要去搜对应的工单才行」。
// 筛选只有等你、在执行、排队：#26 写成「排队 · 没人在动」，看不出停着；#28、#89 是轻子任务，算 Lead 的后台工作，
// 进了默认收起的组，哪个筛选都不数它们。这里按实例上的样子渲染真正的工作台，读用户看得到的筛选、分组、行和按钮。
import { PAUSE_OVERDUE_MS, type TicketPause, type TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import {
  buildTicketRailPresentation, groupForTicket, resolveWorkspaceTickets, ticketRailCaption, ticketRailFilters, type TicketFilter,
} from './model';
import Workbench from './Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;
const DAY = 24 * 60 * 60_000;

function ticket(id: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? 'active';
  return {
    id,
    title: `工单 ${id}`,
    summary: '',
    kind: 'task',
    hasRun: true,
    priority: 'normal',
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-11-06T07:00:00.000Z',
    parentTicketId: null,
    rootTicketId: id,
    runtime: idle,
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
    stage,
    status: stage,
  };
}

function paused(attemptId: number, ageMs: number, by: TicketPause['by'], lastCheckpoint: string | null = null): TicketPause {
  return { attemptId, since: new Date(Date.now() - ageMs).toISOString(), by, lastCheckpoint, overdue: ageMs > PAUSE_OVERDUE_MS };
}

// 2026-11-06 实例上的样子（只取和分类有关的字段）。
const liveTickets: TicketSummary[] = [
  ticket(7, { stage: 'ready', worklistVisibility: 'background' }),
  ticket(26, { pause: paused(35, 2 * DAY, 'lead', '改完了解析器') }),
  ticket(28, { worklistVisibility: 'background', pause: paused(37, 2 * DAY, 'user') }),
  ticket(89, { worklistVisibility: 'background', pause: paused(189, 20 * 60_000, 'user') }),
  ticket(101, { stage: 'review', reviewState: { state: 'independent_review', label: '核查中', reviewerAttemptId: 197, verdict: null, reason: null, reviewProgress: 'running' } }),
  ticket(104, { stage: 'active', executionState: { kind: 'recovery', state: 'blocked', label: 'Dispatch is suspended', dispatchRequestId: 68, attemptId: null, reason: 'no runtime', updatedAt: null } }),
  ticket(110, { stage: 'ready' }),
  ticket(111, { runtime: { state: 'running', lastActivityAt: null, activeAttemptId: 205 } }),
  ticket(112, { stage: 'blocked', runtime: { ...idle, state: 'blocked' }, attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true } }),
  ticket(47, { stage: 'done' }),
  ticket(48, { stage: 'cancelled' }),
];

describe('the paused filter and group', () => {
  const items = resolveWorkspaceTickets(true, liveTickets);
  const counts = (filter: TicketFilter = 'all') => buildTicketRailPresentation(items, { filter }).filterCounts;

  it('counts every paused ticket, background ones included, and takes them out of the queue', () => {
    // 等你：#26、#28 停了两天，#104 派发挂起（执行受阻，没有在自动恢复）。在执行：#101 的核查在跑，#111 在跑。
    // 排队只剩 #110（ready、没有 Run）；Red Bull 在管：#7（后台学习工单）、#112（Lead 正在处理的阻塞）。
    expect(counts()).toEqual({ all: 11, todo: 3, running: 2, paused: 3, queued: 1, lead: 2 });
    const ids = (filter: TicketFilter) => buildTicketRailPresentation(items, { filter }).groups.flatMap((group) => group.items.map((t) => t.id));
    expect(ids('paused').sort()).toEqual(['26', '28', '89']);
    expect(ids('queued')).toEqual(['110']);
  });

  it('groups a fresh pause under 已暂停, and a pause over a day under 等你', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(groupForTicket(byId.get('89')!)).toBe('paused');
    expect(groupForTicket(byId.get('26')!)).toBe('needs_intervention');
    expect(groupForTicket(byId.get('28')!)).toBe('needs_intervention');
    expect(byId.get('28')!.needsUser).toBe('paused');
    expect(groupForTicket(byId.get('104')!)).toBe('needs_intervention');
  });

  it('says who paused it and what it was doing', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(ticketRailCaption(byId.get('26')!, 'zh')).toMatch(/^#26 · .+ 暂停的 · 停在「改完了解析器」$/);
    expect(ticketRailCaption(byId.get('28')!, 'zh')).toBe('#28 · 你暂停的');
    expect(ticketRailCaption(byId.get('89')!, 'en')).toBe('#89 · Paused by you');
  });

  // 验收标准 3：没有工单掉在所有分类外面。没结束的工单至少落在一个筛选里，已结束的在「已完成」「已取消」组里。
  it('leaves no unfinished ticket outside every filter', () => {
    const filters = ticketRailFilters('en').map((filter) => filter.id).filter((id) => id !== 'all');
    for (const item of items) {
      const matched = filters.filter((filter) => buildTicketRailPresentation([item], { filter }).state === 'populated');
      if (item.turn === 'ended') expect(['completed', 'cancelled']).toContain(groupForTicket(item));
      else expect(matched.length, `#${item.id} (${item.turn})`).toBeGreaterThan(0);
    }
  });
});

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => setWidth(0));

function renderRail() {
  const runTicketAction = vi.fn(async (ticketId: number, action: string) => ({ ticketId, action, result: null, ticket: null }));
  const runtime = createCompanionStateRuntime({
    client: { runTicketAction } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(liveTickets);
  runtime.workspace.setState({ hydrated: true });
  setWidth(1280);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  act(() => runtime.workspace.getState().setRailView('tickets'));
  return { runtime, runTicketAction };
}

describe('the ticket rail', () => {
  it('has a 已暂停 filter that lists the three paused tickets, each with how long it has been paused', () => {
    const { runtime } = renderRail();
    expect(within(screen.getByTestId('ticket-filter-paused')).getByText('3')).toBeTruthy();
    act(() => runtime.workspace.getState().setTicketFilter('paused'));
    expect(screen.getByTestId('ticket-row-26')).toBeTruthy();
    expect(screen.getByTestId('ticket-row-89')).toBeTruthy();
    expect(screen.getByTestId('ticket-paused-for-26').textContent).toBe('Paused 2 days');
    expect(screen.getByTestId('ticket-paused-for-89').textContent).toBe('Paused 20 minutes');
    // 停了一天以上的在「等你」组里，也在这个筛选里。
    expect(screen.getByTestId('ticket-row-28')).toBeTruthy();
    expect(screen.getByTestId('ticket-group-needs_intervention')).toBeTruthy();
    expect(screen.getByTestId('ticket-group-paused')).toBeTruthy();
  });

  it('offers resume and cancel only on a ticket paused too long, and confirms the cancel in place', async () => {
    const { runTicketAction } = renderRail();
    expect(screen.getByTestId('ticket-paused-actions-28')).toBeTruthy();
    expect(screen.getByTestId('ticket-paused-actions-26')).toBeTruthy();
    expect(screen.queryByTestId('ticket-paused-actions-89')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId('ticket-resume-28')); });
    expect(runTicketAction).toHaveBeenCalledWith(28, 'resume_run', { input: { runId: 37 } });

    fireEvent.click(screen.getByTestId('ticket-cancel-26'));
    expect(runTicketAction).not.toHaveBeenCalledWith(26, 'cancel', expect.anything());
    await act(async () => { fireEvent.click(screen.getByTestId('ticket-cancel-confirm-26')); });
    expect(runTicketAction).toHaveBeenCalledWith(26, 'cancel', {});
  });
});

// 验收标准 4：「等你」和收件箱的「需要你」是同一个数（都按 protocol 的 ticketNeedsUser；Lead 的 list_needs_user 见 daemon 的 needs-user.test.ts）。
describe('the needs-you count with paused tickets', () => {
  it('is the same in the 等你 filter and the inbox', () => {
    const { runtime } = renderRail();
    expect(within(screen.getByTestId('ticket-filter-todo')).getByText('3')).toBeTruthy();
    act(() => runtime.workspace.getState().setRailView('inbox'));
    expect(within(screen.getByTestId('inbox-needs-count')).getByText('3')).toBeTruthy();
    expect(screen.getByTestId('inbox-card-28')).toBeTruthy();
    expect(within(screen.getByTestId('inbox-card-28')).getByText(/Paused too long/)).toBeTruthy();
  });
});

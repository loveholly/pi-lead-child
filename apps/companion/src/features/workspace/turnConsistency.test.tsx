// @vitest-environment jsdom
// 「在执行」在每个界面上是同一个数。实例上（2026-10-15）工单 tab 写「进行中 6」，会话底栏写「执行中 0」：
// 列表把 ready 算成在跑。那 6 张是 #18（9 月 18 日以后没有动静）和 5 张系统建的「沉淀失败经验」。
// 这里按实例上的工单渲染真正的 Workbench，读用户看得到的数字和分组。
import type { TicketSummary } from '@pi-lead-child/protocol';
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import Workbench from './Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;

function ticket(id: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? 'ready';
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
    updatedAt: '2026-10-15T07:00:00.000Z',
    parentTicketId: null,
    rootTicketId: id,
    runtime: idle,
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
    stage,
    status: stage,
  };
}

const liveTickets: TicketSummary[] = [
  ticket(18, { hasRun: false }),
  ticket(52, { hasRun: false, worklistVisibility: 'background' }),
  ticket(51, { stage: 'blocked', runtime: { ...idle, state: 'blocked' } }),
  ticket(66, {
    stage: 'review',
    verificationPolicy: 'independent_reviewer',
    reviewState: {
      state: 'independent_review', label: '独立核查排队中', reviewerAttemptId: null, verdict: null,
      reason: null, canRequestReview: false, reviewProgress: 'queued', deliveryRunId: 49,
    },
  }),
  ticket(77, { stage: 'active', runtime: { state: 'running', lastActivityAt: null, activeAttemptId: 86 } }),
  ticket(46, { stage: 'done' }),
];

function runtimeWith(tickets: TicketSummary[]) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(tickets);
  runtime.workspace.setState({ hydrated: true });
  return runtime;
}

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

function chipCount(testID: string): string {
  return within(screen.getByTestId(testID)).getAllByText(/^\d+$/).map((node) => node.textContent).join('');
}

afterEach(() => setWidth(0));

describe('whose turn it is', () => {
  it('counts the same running tickets in the ticket tab and the conversation top bar', () => {
    setWidth(1280);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('tickets'));

    // #77 在跑，#66 的独立核查在排队：两张。#18 和 #52 都没有 Run。
    expect(chipCount('ticket-filter-running')).toBe('2');
    // 会话里的执行中写在顶栏（方案 C，2026-10-28，主题 11.14）。
    expect(screen.getByTestId('lead-running-count').getAttribute('aria-label')).toBe('执行中 2');

    act(() => runtime.workspace.getState().setTicketFilter('running'));
    const rail = screen.getByTestId('grouped-ticket-list');
    expect(within(rail).getByTestId('ticket-row-77')).toBeTruthy();
    expect(within(rail).getByTestId('ticket-row-66')).toBeTruthy();
    expect(within(rail).queryByTestId('ticket-row-18')).toBeNull();
  });

  // 左栏头部以前写「Lead 工作区 / 任务线程模式」，后者对用户没有意义。现在写 Lead 的名字和同一个「在执行」的数。
  it('names Lead in the rail header and states the same running count', () => {
    setWidth(1280);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);

    const header = screen.getByTestId('work-rail-header');
    expect(within(header).getByText('2 个 Run 在跑')).toBeTruthy();
    expect(screen.queryByText('任务线程模式')).toBeNull();
  });

  it('leaves the rail header out on a phone: the bottom navigation already says where you are', () => {
    setWidth(390);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);

    expect(screen.queryByTestId('work-rail-header')).toBeNull();
    expect(screen.queryByText('任务线程模式')).toBeNull();
  });

  it('files a ready ticket with no run as queued and the system learning ticket under Lead', () => {
    setWidth(1280);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('tickets'));

    expect(chipCount('ticket-filter-queued')).toBe('1');
    const rail = screen.getByTestId('grouped-ticket-list');
    expect(within(rail).getByTestId('ticket-group-queued')).toBeTruthy();
    expect(within(rail).getByTestId('ticket-row-18')).toBeTruthy();
    // Lead 的后台工作默认收起：分组在，行不展开。
    expect(within(rail).getByTestId('ticket-group-background').getAttribute('aria-expanded')).toBe('false');
    expect(within(rail).queryByTestId('ticket-row-52')).toBeNull();
  });
});

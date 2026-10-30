// @vitest-environment jsdom
// 「需要你」在每个界面上是同一个数。实例上曾经是会话底栏 3、收件箱 4，而 Lead 说 5：
// 底栏漏了 #66（独立核查未派发），底栏和收件箱都漏了阻塞的子工单 #75。
// 这里按实例上的工单渲染真正的 Workbench，读用户看得到的数字。
import type { TicketReviewState, TicketSummary } from '@pi-lead-child/protocol';
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
    updatedAt: '2026-10-13T11:00:00.000Z',
    parentTicketId: null,
    rootTicketId: id,
    runtime: idle,
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
    stage,
    status: stage,
  };
}

const notDispatched: TicketReviewState = {
  state: 'independent_review',
  label: '独立核查未派发',
  reviewerAttemptId: null,
  verdict: null,
  reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。',
  canRequestReview: true,
  reviewProgress: null,
  deliveryRunId: 49,
};

// 2026-10-13 实例上的工单（只取和计数有关的字段）。
const liveTickets: TicketSummary[] = [
  ticket(14, { kind: 'reminder', stage: 'fired', hasRun: false }),
  ticket(18),
  ticket(47, { stage: 'done' }),
  ticket(51, { stage: 'blocked', runtime: { ...idle, state: 'blocked' } }),
  ticket(66, { stage: 'review', reviewState: notDispatched, verificationPolicy: 'independent_reviewer' }),
  ticket(72, { stage: 'blocked', runtime: { ...idle, state: 'blocked' } }),
  ticket(75, { stage: 'blocked', parentTicketId: 47, rootTicketId: 47, runtime: { ...idle, state: 'blocked' } }),
  ticket(77, { stage: 'blocked', runtime: { ...idle, state: 'blocked' } }),
  ticket(90, { stage: 'active', runtime: { state: 'running', lastActivityAt: null, activeAttemptId: 12 } }),
];
const NEEDS_YOU = 5;

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

// react-native-web 的窗口宽度读 document.documentElement.clientWidth，jsdom 里它是 0。
function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

function chipCount(testID: string): string {
  const chip = screen.getByTestId(testID);
  return within(chip).getAllByText(/^\d+$/).map((node) => node.textContent).join('');
}

afterEach(() => setWidth(0));

describe('the needs-you count', () => {
  // 方案 C（2026-10-28，主题 11.14）：输入框上方那一行「执行中 · 需要处理」去掉了，会话里只在顶栏写执行中 N；
  // 要你处理的事在收件箱里（手机上是底部导航的角标）。
  it('is the same number in the phone inbox badge and the inbox filter', () => {
    setWidth(390);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);

    const badge = within(screen.getByTestId('compact-nav-inbox')).getByText(/^\d+$/);
    expect(badge.textContent).toBe(String(NEEDS_YOU));
    // 收件箱没有筛选 chip 了（只有一个选项的 chip 点了也没有变化）；数字在「需要你」上。
    expect(chipCount('inbox-needs-count')).toBe(String(NEEDS_YOU));
    // 阻塞的子工单也在收件箱里：它需要你，而它的父工单已经完成了。
    expect(screen.getByText('工单 75')).toBeTruthy();
    expect(screen.getByText('工单 66')).toBeTruthy();

    act(() => runtime.workspace.getState().setCompactDestination('conversation'));
    expect(screen.getByTestId('lead-running-count').getAttribute('aria-label')).toBe('执行中 1');
    expect(screen.queryByText(/需处理|需要处理/)).toBeNull();
  });

  it('shows the needs-you count in the desktop inbox and only the running count in the conversation', () => {
    setWidth(1280);
    const runtime = runtimeWith(liveTickets);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);

    expect(chipCount('inbox-needs-count')).toBe(String(NEEDS_YOU));
    expect(screen.getByTestId('lead-running-count').getAttribute('aria-label')).toBe('执行中 1');
    expect(screen.queryByText(/需要处理/)).toBeNull();
  });
});

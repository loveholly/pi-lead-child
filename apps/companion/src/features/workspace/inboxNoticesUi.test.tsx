// @vitest-environment jsdom
// 通知卡只在收件箱，只放还在要你做事的通知。实例上（2026-10-15）黄色通知卡在四个 tab 都出现，
// 显示 42 条未确认通知里最早的 3 条：7 月的提醒、已完成的 #46「运行结束，但交接失败」、#51 的英文阻塞，
// 而 #51 就在下面的「需要你介入」里。这里按实例上的数据渲染真正的 Workbench。
import type { AgendaItem, NotificationDto, TicketSummary } from '@pi-lead-child/protocol';
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
  const stage = overrides.stage ?? 'blocked';
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

// 侧栏只放 Lead 决定推给你的通知和 Lead 不能工作时系统兜底推的（Jarvis 模式，userOutboxNotifications）。
// 这里的通知都是兜底推的：实例上 7 月那条提醒就是 fallback。
function notice(id: number, ticketId: number | null, title: string, createdAt: string, kind = 'blocked_checkpoint'): NotificationDto {
  return {
    id, ticketId, kind, dedupKey: null, urgency: 'immediate', title, body: '', state: 'delivered',
    createdAt, deliveredAt: createdAt, deliveredVia: 'fallback', ackedAt: null,
  };
}

const tickets = [ticket(46, { stage: 'done' }), ticket(51)];
const notifications = [
  notice(1, 14, '提醒：验收样本：三分钟后提醒我看一眼', '2026-07-28T09:57:54.788Z', 'reminder'),
  notice(3, 46, '工单 #46 运行结束，但交接失败', '2026-08-11T09:59:02.597Z', 'terminal_handoff_failed'),
  notice(4, 51, '工单 #51 阻塞：Runtime E2E blocked before migration', '2026-08-14T06:57:26.236Z'),
  notice(15, 51, '工单 #51 阻塞：Runtime E2E partially exercised', '2026-08-17T06:54:46.739Z'),
  notice(60, null, 'Codex 不支持该模型（gpt-5.5）：派发已挂起', '2026-10-14T16:41:11.302Z', 'runtime_incident'),
];
// 7 月 28 日的提醒到现在还是已触发、没有确认（日程的过期项把它的状态带过来）。
const firedReminder: AgendaItem = {
  id: 'ticket:14:reminder', kind: 'ticket_reminder', startsAt: '2026-07-28T09:57:41.083Z',
  title: '验收样本：三分钟后提醒我看一眼', ticketId: 14, scheduleId: null, status: 'fired', project: null,
};

function runtimeWithData() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(tickets);
  runtime.control.getState().replaceNotifications(notifications);
  runtime.control.getState().replaceAgenda([firedReminder]);
  runtime.workspace.setState({ hydrated: true });
  return runtime;
}

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => setWidth(0));

describe('notices in the work rail', () => {
  it('appear only in the inbox', () => {
    setWidth(1280);
    const runtime = runtimeWithData();
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);

    for (const view of ['tickets', 'projects', 'agenda'] as const) {
      act(() => runtime.workspace.getState().setRailView(view));
      expect(screen.queryByTestId('notification-outbox')).toBeNull();
    }
  });

  it('show what still asks you for something, and fold the rest into the ticket row', () => {
    setWidth(1280);
    const runtime = runtimeWithData();
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('inbox'));

    const outbox = screen.getByTestId('notification-outbox');
    expect(within(outbox).getByText('Codex 不支持该模型（gpt-5.5）：派发已挂起')).toBeTruthy();
    // 已完成的 #46 不再报「交接失败」；#51 的通知收进它那一行。
    expect(screen.queryByText('工单 #46 运行结束，但交接失败')).toBeNull();
    expect(within(outbox).queryByText(/工单 #51/)).toBeNull();
    expect(within(screen.getByTestId('inbox-card-51')).getByText(/2 条通知/)).toBeTruthy();
    // 已触发的提醒合成一行。7 月 28 日的这条已经超过 30 天，收起来（决定 3），在日程的「已过期」里。
    expect(within(screen.getByTestId('reminder-notices')).getByText('1 条提醒超过 30 天没有确认，收在日程的「已过期」里')).toBeTruthy();
  });
});

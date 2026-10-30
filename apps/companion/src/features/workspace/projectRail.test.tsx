// @vitest-environment jsdom
// 项目 tab 不是死路。实例上（2026-10-15）项目行点了没有反应（role=listitem），「unknown 20 工单」直接显示英文，
// 「17 工单 · 3 阻塞」和工单 tab 的数字对不上。点项目要打开这个项目的工单，数字和那里一样。
// 阶段 2 起项目 tab 是项目卡片（GET /v1/projects/overview），数字由服务端按 ticketTurn 算。
import type { ProjectOverview, ProjectSummary, TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import Workbench from './Workbench.web';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const idle = { state: 'idle', lastActivityAt: null, activeAttemptId: null } as const;

function ticket(id: number, project: string | null, overrides: Partial<TicketSummary> = {}): TicketSummary {
  const stage = overrides.stage ?? 'blocked';
  return {
    id, title: `工单 ${id}`, summary: '', kind: 'task', hasRun: true, priority: 'normal', project,
    dueAt: null, deferUntil: null, updatedAt: '2026-10-15T07:00:00.000Z', parentTicketId: null, rootTicketId: id,
    runtime: idle, attention: { pendingApprovalCount: 0, blockerCount: 0 }, ...overrides, stage, status: stage,
  };
}

function project(id: string, name: string, counts: Partial<ProjectSummary>): ProjectSummary {
  return { id, name, ticketCount: 0, runningCount: 0, reviewCount: 0, blockedCount: 0, nearestDueAt: null, ...counts };
}

const tickets = [
  ticket(72, 'pi-lead-child'),
  ticket(51, 'pi-lead-child'),
  ticket(18, 'Dialogue Returns Business Parity', { stage: 'ready', hasRun: false }),
  ticket(3, null, { stage: 'done' }),
];
const projects = [
  project('2', 'Dialogue Returns Business Parity', { ticketCount: 1 }),
  project('1', 'pi-lead-child', { ticketCount: 2, blockedCount: 2 }),
  project('unknown', 'unknown', { ticketCount: 1 }),
];

function overview(id: string, name: string, counts: Partial<ProjectOverview['counts']>): ProjectOverview {
  return {
    id, name, status: 'active', counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 0, ...counts },
    leadStatus: null, lastActivityAt: null, nextMilestone: null, spend: { costUsd: 0, tokens: 0 },
  };
}

const overviews = [
  overview('2', 'Dialogue Returns Business Parity', { queued: 1 }),
  overview('1', 'pi-lead-child', { user: 2 }),
  overview('unknown', 'unknown', { ended: 1 }),
];

function runtimeWithData() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(tickets);
  runtime.control.getState().replaceProjects(projects);
  runtime.control.getState().replaceProjectOverviews(overviews);
  runtime.workspace.setState({ hydrated: true });
  return runtime;
}

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => setWidth(0));

describe('the project tab', () => {
  it('names the tickets without a project in Chinese and counts with the ticket tab words', () => {
    setWidth(1280);
    const runtime = runtimeWithData();
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('projects'));

    expect(screen.queryByText('unknown')).toBeNull();
    expect(within(screen.getByTestId('project-row-1')).getByText('等你 2')).toBeTruthy();
    // 只有已结束工单的「未归属」收在安静的项目里。
    fireEvent.click(screen.getByTestId('projects-quiet'));
    expect(within(screen.getByTestId('project-row-unknown')).getByText('未归属')).toBeTruthy();
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('opens the tickets of the project you press, and the filter can be cleared', () => {
    setWidth(1280);
    const runtime = runtimeWithData();
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('projects'));

    fireEvent.click(screen.getByTestId('project-row-1'));

    expect(runtime.workspace.getState().railView).toBe('tickets');
    const rail = screen.getByTestId('grouped-ticket-list');
    expect(within(rail).getByTestId('ticket-row-72')).toBeTruthy();
    expect(within(rail).getByTestId('ticket-row-51')).toBeTruthy();
    expect(within(rail).queryByTestId('ticket-row-18')).toBeNull();
    // 筛选条上的数字是这个项目里的数字，和项目 tab 一样。
    expect(within(screen.getByTestId('ticket-filter-todo')).getByText('2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('ticket-project-clear'));
    expect(within(screen.getByTestId('grouped-ticket-list')).getByTestId('ticket-row-18')).toBeTruthy();
  });
});

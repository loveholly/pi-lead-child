// @vitest-environment jsdom
// 左栏改版阶段 2：项目卡片（Lead 的一句话、分布、最近的截止、花费；安静的和归档的收起，可以归档和恢复）、
// 工单 tab 的搜索框、工单行右边的停留时间、E2E 标题换成 Lead 写的短标题。按实例上的数据渲染真正的 Workbench。
import type { ProjectOverview, ProjectSummary, TicketSummary } from '@pi-lead-child/protocol';
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

const E2E_TITLE = '[E2E #51 T48-E2E-51-20260817061106] FINAL #45 implementation - outcome snapshot and registry mechanism';
const tickets = [
  ticket(72, '修复 review 状态投影与返工耗尽通知', {
    stageChangedAt: '2026-08-25T08:01:12.000Z',
    nextMilestone: { id: 1, kind: 'test_handoff', label: '提测', at: '2026-10-16T10:00:00.000Z', allDay: false },
  }),
  ticket(66, E2E_TITLE, {
    displayTitle: '成果快照与登记机制', stageChangedAt: '2026-08-21T10:48:04.000Z',
    nextMilestone: { id: 2, kind: 'due', label: '截止', at: '2026-10-13T07:00:00.000Z', allDay: false },
  }),
  ticket(18, 'Dialogue Returns 业务等价迁移总工单', { stage: 'ready', hasRun: false, project: 'Dialogue Returns Business Parity', stageChangedAt: '2026-09-18T01:48:14.000Z' }),
];

function overview(id: string, name: string, overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    id, name, status: 'active', counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 0 },
    leadStatus: null, lastActivityAt: null, nextMilestone: null, spend: { costUsd: 0, tokens: 0 }, ...overrides,
  };
}

const overviews = [
  overview('1', 'pi-lead-child', {
    counts: { user: 2, running: 0, lead: 0, queued: 0, ended: 0 },
    leadStatus: { text: '卡在 #72 的 review 投影；#66 正在重新核查。', at: '2026-10-15T07:43:00.000Z' },
    lastActivityAt: '2026-10-15T07:43:00.000Z', spend: { costUsd: 36.18, tokens: 316_253_687 },
  }),
  overview('2', 'Dialogue Returns Business Parity', { counts: { user: 0, running: 0, lead: 0, queued: 1, ended: 0 }, lastActivityAt: '2026-09-18T01:48:14.000Z' }),
  overview('4', 'companion-acceptance', { counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 1 } }),
  overview('3', 'pi-lead-child-e2e', { status: 'archived', counts: { user: 0, running: 0, lead: 0, queued: 0, ended: 17 } }),
];
const summaries: ProjectSummary[] = overviews.filter((item) => item.status === 'active').map((item) => ({
  id: item.id, name: item.name, ticketCount: 0, runningCount: 0, reviewCount: 0, blockedCount: 0, nearestDueAt: null,
}));

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

function render() {
  const client = {
    setProjectArchived: vi.fn(async () => undefined),
    getProjectsOverview: vi.fn(async () => overviews),
    getProjects: vi.fn(async () => summaries),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => now.getTime() },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets(tickets);
  runtime.control.getState().replaceProjects(summaries);
  runtime.control.getState().replaceProjectOverviews(overviews);
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

describe('the project cards', () => {
  it('show Lead line, the counts and the spend, and how long a project has been quiet', () => {
    const { runtime } = render();
    act(() => runtime.workspace.getState().setRailView('projects'));

    const main = screen.getByTestId('project-row-1');
    expect(within(main).getByText('卡在 #72 的 review 投影；#66 正在重新核查。')).toBeTruthy();
    expect(within(main).getByText('15:43 更新')).toBeTruthy();
    expect(within(main).getByText('等你 2')).toBeTruthy();
    expect(within(main).getByText('$36.18')).toBeTruthy();
    expect(within(screen.getByTestId('project-row-2')).getByText('27 天没有动静')).toBeTruthy();
  });

  it('fold quiet and archived projects, and archive or restore one', () => {
    const { client, runtime } = render();
    act(() => runtime.workspace.getState().setRailView('projects'));

    expect(screen.queryByTestId('project-row-4')).toBeNull();
    fireEvent.click(screen.getByTestId('projects-quiet'));
    fireEvent.click(screen.getByTestId('project-archive-4'));
    expect(client.setProjectArchived).toHaveBeenCalledWith(4, true);

    fireEvent.click(screen.getByTestId('projects-archived'));
    fireEvent.click(screen.getByTestId('project-restore-3'));
    expect(client.setProjectArchived).toHaveBeenCalledWith(3, false);
  });
});

describe('the ticket tab', () => {
  it('shows the short title Lead wrote, and how long each ticket has stayed in its stage', () => {
    const { runtime } = render();
    act(() => runtime.workspace.getState().setRailView('tickets'));

    const row = screen.getByTestId('ticket-row-66');
    expect(within(row).getByText('成果快照与登记机制')).toBeTruthy();
    expect(within(row).queryByText(E2E_TITLE)).toBeNull();
    expect(within(screen.getByTestId('ticket-row-72')).getByText('50 天')).toBeTruthy();
  });

  // 阶段 3：标签是最近的节点（任何类型），不只是截止。
  it('tags a ticket with its next milestone, and says when it is overdue', () => {
    const { runtime } = render();
    act(() => runtime.workspace.getState().setRailView('tickets'));

    expect(within(screen.getByTestId('ticket-row-72')).getByText('提测 明天 18:00')).toBeTruthy();
    expect(within(screen.getByTestId('ticket-row-66')).getByText('截止已过 2 天')).toBeTruthy();
  });

  it('has a search box that finds a ticket by its short title, original title or number', () => {
    const { runtime } = render();
    act(() => runtime.workspace.getState().setRailView('tickets'));

    act(() => runtime.workspace.getState().setTicketQuery('快照'));
    expect(screen.getByTestId('ticket-search')).toBeTruthy();
    expect(screen.getByTestId('ticket-row-66')).toBeTruthy();
    expect(screen.queryByTestId('ticket-row-72')).toBeNull();
  });
});

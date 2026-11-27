// @vitest-environment happy-dom
// 「证据与记录」（方案 D）：进展、Run、生命周期、产物收在这里。看证据时工单对话不能被盖住——
// 桌面上它占 Lead 会话栏，工单对话留在右边并展开；手机上它在工单面板里，对话坞还在底部。
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openHistory } from '../../../test/ticketDetail';
import { renderWorkbenchWithTicket, setViewportWidth, ticket66 } from '../../../test/workbench';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const TICKET = 66;

function renderWorkbench(width: number) {
  return renderWorkbenchWithTicket(ticket66(), { width });
}

afterEach(() => setViewportWidth(0));

// 工单登记了 PR（link_pr，工单 #497）：#493 的 PR 是推到 fork 以后手动开的，面板和产物区都看不到它。
const WITH_PULL_REQUEST = ticket66({
  workspace: {
    id: 7, ownerTicketId: TICKET, mode: 'isolated', kind: 'isolated_child', state: 'review_hold', inherited: false,
    availableActions: [], pullRequestUrl: 'https://github.com/acme/widgets/pull/85',
  },
});

describe('the evidence and records of a ticket', () => {
  it('opens in the Lead conversation column on desktop and keeps the ticket chat open on the right', () => {
    const runtime = renderWorkbench(1280);
    const thread = screen.getByTestId('ticket-thread');

    // 完整记录的入口在「经过与记录」里（画布 M3），执行中默认收着。
    fireEvent.click(within(openHistory(thread)).getByTestId('ticket-records-open'));

    expect(runtime.workspace.getState()).toMatchObject({ ticketRecordsOpenId: TICKET, ticketChatExpandedId: TICKET });
    const session = screen.getByTestId('workspace-session');
    expect(within(session).getByTestId('ticket-records')).toBeTruthy();
    // 工单面板还在右边，对话展开着，输入框可用：看着证据就能问。
    expect(within(thread).queryByTestId('ticket-records')).toBeNull();
    expect(within(thread).getByTestId('ticket-chat-dock-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(within(within(thread).getByTestId('ticket-chat-dock')).getByRole('textbox')).toBeTruthy();

    fireEvent.click(within(session).getByTestId('ticket-records-close'));
    expect(runtime.workspace.getState().ticketRecordsOpenId).toBeNull();
    expect(screen.queryByTestId('ticket-records')).toBeNull();
    expect(screen.getByTestId('lead-conversation')).toBeTruthy();
  });

  it('opens inside the ticket panel on a phone and keeps the chat dock', () => {
    const runtime = renderWorkbench(390);
    act(() => runtime.workspace.getState().openCompactPanel('thread'));
    const thread = screen.getByTestId('ticket-thread');

    // 完整记录的入口在「经过与记录」里（画布 M3），执行中默认收着。
    fireEvent.click(within(openHistory(thread)).getByTestId('ticket-records-open'));

    expect(runtime.workspace.getState().ticketRecordsOpenId).toBe(TICKET);
    expect(within(thread).getByTestId('ticket-records')).toBeTruthy();
    expect(within(thread).queryByTestId('ticket-thread-scroll')).toBeNull();
    expect(within(within(thread).getByTestId('ticket-chat-dock')).getByRole('textbox')).toBeTruthy();
    // 手机上只换主体，对话坞不自动展开。
    expect(runtime.workspace.getState().ticketChatExpandedId).toBeNull();

    fireEvent.click(within(thread).getByTestId('ticket-records-close'));
    expect(within(thread).queryByTestId('ticket-records')).toBeNull();
    expect(within(thread).getByTestId('ticket-thread-scroll')).toBeTruthy();
  });

  it('shows one tab at a time with a single scroll area', () => {
    const runtime = renderWorkbench(390);
    act(() => runtime.workspace.getState().openCompactPanel('thread'));
    fireEvent.click(within(openHistory(screen.getByTestId('ticket-thread'))).getByTestId('ticket-records-open'));
    const records = screen.getByTestId('ticket-records');

    expect(within(records).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Acceptance', 'Progress', 'Executions', 'Lifecycle', 'Artifacts']);
    fireEvent.click(within(records).getByTestId('ticket-records-tab-runs'));
    // 页签和这一页的标题都叫「执行」，不叫 Run（设计规范 P14.9）。
    expect(within(records).getAllByText('Executions')).toHaveLength(2);
    expect(within(records).getByText('Execution logs')).toBeTruthy();
  });

  // Lead 按任务选 runtime、模型和 effort（2026-10-15）。服务端的 attempt 列表带着 effort，
  // 「执行尝试」和「运行日志」都把它写在 runtime 和模型后面。
  it('names the runtime, model and effort of each run', () => {
    const runtime = renderWorkbench(1280);
    act(() => runtime.control.getState().replaceAttempts(TICKET, [{
      id: 49, ticketId: TICKET, role: 'executor', state: 'settled', model: 'opus', effort: 'max',
      runtime: 'claude', purpose: 'execution', exitCode: 0, errorCode: null, errorMessage: null,
      startedAt: '2026-10-14T02:00:00.000Z', endedAt: '2026-10-14T03:00:00.000Z',
    }, {
      id: 79, ticketId: TICKET, role: 'reviewer', state: 'settled', model: 'gpt-6.1-sol', effort: 'high',
      runtime: 'codex', purpose: 'review', exitCode: 0, errorCode: null, errorMessage: null,
      startedAt: '2026-10-15T02:00:00.000Z', endedAt: '2026-10-15T02:10:00.000Z',
    }]));
    fireEvent.click(within(openHistory(screen.getByTestId('ticket-thread'))).getByTestId('ticket-records-open'));
    const records = screen.getByTestId('ticket-records');
    fireEvent.click(within(records).getByTestId('ticket-records-tab-runs'));

    expect(within(within(records).getByTestId('attempt-79')).getByText('codex · gpt-6.1-sol · effort high')).toBeTruthy();
    expect(within(within(records).getByTestId('attempt-49')).getByText('claude · opus · effort max')).toBeTruthy();
    expect(within(records).getByTestId('run-log-group-79').textContent).toContain('codex · gpt-6.1-sol · effort high · ');
  });

  it('lists the ticket\'s pull request among the artifacts and opens it on GitHub', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWorkbenchWithTicket(WITH_PULL_REQUEST, { width: 1280 });
    fireEvent.click(within(openHistory(screen.getByTestId('ticket-thread'))).getByTestId('ticket-records-open'));
    const records = screen.getByTestId('ticket-records');

    // 页签上的数字算上这个 PR；没有文件产物时也不显示「没有产物」。
    expect(within(records).getByTestId('ticket-records-tab-artifacts').textContent).toBe('Artifacts 1');
    fireEvent.click(within(records).getByTestId('ticket-records-tab-artifacts'));
    const row = within(records).getByTestId('ticket-pull-request');
    expect(row.textContent).toContain('acme/widgets#85');
    expect(within(records).queryByText('No artifacts')).toBeNull();
    fireEvent.click(within(row).getByTestId('ticket-pull-request-open'));
    open.mockRestore();
  });

  it('shows no pull request row for a ticket that has none', () => {
    renderWorkbench(1280);
    fireEvent.click(within(openHistory(screen.getByTestId('ticket-thread'))).getByTestId('ticket-records-open'));
    const records = screen.getByTestId('ticket-records');
    fireEvent.click(within(records).getByTestId('ticket-records-tab-artifacts'));
    expect(within(records).queryByTestId('ticket-pull-request')).toBeNull();
  });
});

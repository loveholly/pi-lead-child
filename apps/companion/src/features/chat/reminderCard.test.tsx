// @vitest-environment jsdom
// 2026-10-16 07:57：Lead 建了提醒 #83，会话里出现一张「#83 正在同步工单。」的卡片，一直不变。
// 卡片在工单列表里找这条事项，可工单列表只装 task，提醒永远找不到。
// 现在会话里的提醒画成提醒。数据按编号取这条事项的 TicketDetail（不论 kind），和别的界面一样读它的 TicketSummary。
// 取不到时说操作本身的结果。
// 2026-10-27 按画布「提醒卡 · 方案一」重画（对象组件 Reminder）：一张票根，点一下原位置撑开成浮层，改时间和取消在浮层里。
import type { TicketDetail, TicketSummary } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { ConversationCardEntity } from '../../state/types';
import { TicketExecutionConversationCard } from './ConversationTicketCard';
import { reminderTimeWords } from './ReminderCard';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// 三天一小时以后：卡片写「还有 3 天 1 小时」。
const REMIND_AT = new Date(Date.now() + (3 * 24 + 1) * 3_600_000 + 30_000).toISOString();

function reminder(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 83, title: '关注 aish PR86 是否合并', summary: '', kind: 'reminder', hasRun: false, priority: 'normal',
    project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-16T07:57:03.000Z',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'scheduled', status: 'scheduled',
    ...overrides,
  };
}

function detail(summary: TicketSummary): TicketDetail {
  return {
    ticket: summary, brief: '', body: '', workdir: null, createdAt: '2026-10-16T07:57:03.000Z',
    totalTokens: 0, totalCostUsd: 0, remindAt: REMIND_AT, createdBy: 'lead',
  };
}

function card(operations: Array<{ name: string; state?: 'completed' | 'started' | 'failed' }>): ConversationCardEntity & { kind: 'ticket_execution' } {
  return {
    id: 'turn:t1:ticket:83', key: 'turn:t1:ticket:83', kind: 'ticket_execution', turnId: 't1', ticketId: 83,
    operations: operations.map((operation, index) => ({
      id: `t1:call-${index}`, name: operation.name, state: operation.state ?? 'completed',
      label: `${operation.name} #83`, detail: operation.name === 'create_reminder' ? 'Created reminder #83' : 'Operation completed',
    })),
    operationsTruncated: false, createdAt: '2026-10-16T07:57:03.000Z', updatedAt: '2026-10-16T07:57:03.000Z',
    source: 'durable', durableId: 1,
  } as ConversationCardEntity & { kind: 'ticket_execution' };
}

function render(
  getTicket: (id: number) => Promise<TicketDetail>,
  operations: Array<{ name: string; state?: 'completed' | 'started' | 'failed' }> = [{ name: 'create_reminder' }],
  contextLabel: string | null = null,
) {
  const runtime = createCompanionStateRuntime({
    client: { getTicket: vi.fn(getTicket) } as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <TicketExecutionConversationCard card={card(operations)} collapsed={false} compact={false} contextLabel={contextLabel} />
    </CompanionRuntimeProvider>,
  );
  return runtime;
}

describe('a reminder Lead created in the conversation', () => {
  it('is a ticket stub with the day, the title and the time left, not a ticket waiting to sync', async () => {
    render(async () => detail(reminder()));
    expect(await screen.findByText('还有 3 天 1 小时')).toBeTruthy();
    expect(screen.getByText('关注 aish PR86 是否合并')).toBeTruthy();
    const at = new Date(REMIND_AT);
    expect(screen.getByTestId('reminder-page-value').textContent).toBe(String(at.getDate()));
    expect(screen.getByTestId('reminder-page-eyebrow').textContent).toBe(`${at.getMonth() + 1}月`);
    expect(screen.getByTestId('reminder-card-83-stub-notch-top')).toBeTruthy();
    expect(screen.queryByText('正在同步工单。')).toBeNull();
    expect(screen.queryByText('#83')).toBeNull();
  });

  // 会话里别的工单的卡片上面写「其他工单 · #3」。提醒不是工单，不写这一行。
  it('is not labelled as another ticket', async () => {
    render(async () => detail(reminder()), [{ name: 'create_reminder' }], '其他工单 · #83');
    expect(await screen.findByText('还有 3 天 1 小时')).toBeTruthy();
    expect(screen.queryByText('其他工单 · #83')).toBeNull();
  });

  it('opens into a panel in place, not into the ticket thread, and the card has no buttons until then', async () => {
    const runtime = render(async () => detail(reminder()));
    await screen.findByText('还有 3 天 1 小时');
    expect(screen.queryByRole('button', { name: '取消提醒' })).toBeNull();
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-83-summary'));
    expect(await screen.findByRole('radio', { name: '1 小时后' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消提醒' })).toBeTruthy();
    expect(runtime.workspace.getState().threadOpen).toBe(false);
  });

  it('says an important reminder interrupts, in amber', async () => {
    render(async () => ({ ...detail(reminder()), reminder: { level: 'interrupt', earlyMs: null, repeat: null, ticketId: null, check: null } } as TicketDetail));
    expect(await screen.findByText('重要，到点会打断你')).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId('reminder-page-eyebrow')).backgroundColor).toBe('var(--c-warning-soft)');
  });

  it('shows when it was confirmed, with a check on a green band, and no longer opens', async () => {
    const confirmed = new Date(2026, 9, 27, 14, 3).toISOString();
    render(async () => detail(reminder({ stage: 'acked', status: 'acked', stageChangedAt: confirmed })));
    expect(await screen.findByText('14:03 已确认')).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId('reminder-page-eyebrow')).backgroundColor).toBe('var(--c-success-soft)');
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-83-summary'));
    expect(screen.queryByRole('radio', { name: '1 小时后' })).toBeNull();
  });

  it('greys out and strikes through a cancelled reminder, says when, and no longer opens', async () => {
    const cancelled = new Date(2026, 9, 27, 9, 12).toISOString();
    render(async () => detail(reminder({ stage: 'cancelled', status: 'cancelled', stageChangedAt: cancelled })), [{ name: 'cancel_item' }]);
    expect(await screen.findByText('你在 10-27 09:12 取消')).toBeTruthy();
    expect(screen.getByTestId('reminder-page-crossed')).toBeTruthy();
    expect(getComputedStyle(screen.getByText('关注 aish PR86 是否合并')).textDecorationLine).toBe('line-through');
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-83-summary'));
    expect(screen.queryByRole('radio', { name: '1 小时后' })).toBeNull();
  });

  // 提醒到点（scheduled → fired）时 daemon 不推事件：挂着的卡片在提醒时刻之后自己重取一次（调度器每分钟走一次）。
  it('reads the reminder again after its time, so a fired reminder does not keep counting down', async () => {
    const remindAt = new Date(Date.now() - 69_900).toISOString();
    const getTicket = vi.fn(async () => ({ ...detail(reminder()), remindAt }));
    render(getTicket);
    expect(await screen.findByText(/^已过 /)).toBeTruthy();
    getTicket.mockImplementation(async () => ({ ...detail(reminder({ stage: 'fired', status: 'fired' })), remindAt }));
    expect(await screen.findByText('到点了', {}, { timeout: 2_000 })).toBeTruthy();
    expect(getTicket).toHaveBeenCalledTimes(2);
  });

  // 审查发现（3688968）：事件取的是最后一个操作，不看它的状态。取消失败或者还在跑时，卡片写「Lead 取消了它」，
  // 可它还在等（AGENTS.md 的 Core Invariants 第 4 条）。只认做完了的操作。事件写在展开的浮层里。
  it('describes only an operation that completed, so the event never contradicts the state', async () => {
    render(async () => detail(reminder()), [{ name: 'reschedule_reminder' }, { name: 'cancel_item', state: 'started' }]);
    await screen.findByText('还有 3 天 1 小时');
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-83-summary'));
    expect(await screen.findByText('Paimon 改了时间')).toBeTruthy();
    expect(screen.queryByText('Paimon 取消了它')).toBeNull();
  });

  it('never waits forever: when the reminder cannot be read it says what the operation did', async () => {
    render(async () => { throw new Error('ticket not found'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(await screen.findByText('提醒 #83 已创建')).toBeTruthy();
    expect(screen.queryByText('正在同步工单。')).toBeNull();
  });
});

// 改时间、取消走操作层（提醒的 reschedule、工单的 cancel），和 Lead 的工具是同一个函数。
describe('changing and cancelling a reminder from its card', () => {
  async function opened() {
    const runtime = render(async () => detail(reminder()));
    runtime.control.getState().replaceTicketActions(83, [{
      id: 'cancel', label: '取消', area: 'ticket', permission: 'user_only', external: false, irreversible: false, undoable: true, available: true, reason: null,
    }]);
    vi.spyOn(runtime, 'listUiActions').mockResolvedValue([{
      target: { type: 'reminder', id: '83' }, id: 'reschedule', label: '改时间', permission: 'lead_allowed',
      external: false, irreversible: false, where: '会话里的提醒卡', confirm: null, available: true, reason: null,
    }]);
    const reschedule = vi.spyOn(runtime, 'performUiAction').mockResolvedValue({ target: { type: 'reminder', id: '83' }, action: 'reschedule', result: null });
    const cancel = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({} as never);
    await screen.findByText('还有 3 天 1 小时');
    fireEvent.click(screen.getByTestId('surface-disclosure-reminder-83-summary'));
    await screen.findByRole('radio', { name: '1 小时后' });
    return { reschedule, cancel };
  }

  it('previews the picked time on the card and the button, then moves the reminder there', async () => {
    const { reschedule } = await opened();
    fireEvent.click(screen.getByRole('radio', { name: '1 小时后' }));
    const panel = within(screen.getByTestId('reminder-card-83-open'));
    expect(panel.getByTestId('reminder-page-open-value').textContent).toBe(String(new Date(Date.now() + 3_600_000).getDate()));
    const button = await screen.findByRole('button', { name: /^改到周/ });
    const before = Date.now();
    await act(async () => { fireEvent.click(button); });
    const [type, id, action, request] = reschedule.mock.calls[0]!;
    expect([type, id, action]).toEqual(['reminder', '83', 'reschedule']);
    expect(Date.parse((request as { input: { remindAt: string } }).input.remindAt) - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
  });

  // 画布状态 3：点「取消提醒」，右下角那一行原地换成确认，防止误点（工单 #89 的误删也是这个原因）。
  it('asks once, in place of the buttons, before it cancels the reminder', async () => {
    const { cancel } = await opened();
    fireEvent.click(screen.getByRole('button', { name: '取消提醒' }));
    expect(screen.getByText(/^取消后，.+ 不再提醒你。$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^改到/ })).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认取消提醒' })); });
    expect(cancel).toHaveBeenCalledWith(83, 'cancel', { input: {} });
  });
});

describe('the reminder time in words', () => {
  it('names the weekday, the date and the time', () => {
    expect(reminderTimeWords(new Date(2026, 9, 19, 9, 0).toISOString())).toBe('周一 10-19 09:00');
    expect(reminderTimeWords(new Date(2026, 0, 4, 18, 5).toISOString())).toBe('周日 01-04 18:05');
    expect(reminderTimeWords('not a date')).toBeNull();
  });
});

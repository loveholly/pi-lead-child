// @vitest-environment happy-dom
// 会话卡片上的按钮做成以后（工单 #263）。用户 11-05 的截图：Lead 画了两行「预算调到 3000 万」，按下以后操作已经生效，
// 按钮却原样显示，看起来还在等他点。现在：成功以后按钮收起，原地一行「已完成」；刷新、换一台设备打开时，
// 从服务端的记录读回已完成；失败时按钮旁边写原因，按钮还能再按。
import type { SurfaceActionDone, TicketAction, TicketSummary, UiSurface } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => cleanup());

const TICKET = 259;
const CALL = 'call-budget';

const summary: TicketSummary = {
  id: TICKET, title: '单行发送回跳', summary: '', kind: 'task', hasRun: true, priority: 'normal',
  project: null, dueAt: null, deferUntil: null, updatedAt: '2026-11-05T10:50:00.000Z', parentTicketId: null, rootTicketId: TICKET,
  runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage: 'review', status: 'review',
};

const setBudget: TicketAction = {
  id: 'set_budget', label: '设置预算', area: 'ticket', permission: 'user_only', external: false, irreversible: false, undoable: false,
  available: true, reason: null,
};

// 截图里的那张卡：一行事项，左边已用的 token，右边一个按钮。
const card: UiSurface = {
  id: 'budget', catalogVersion: 1, root: 'row', fallbackText: '#259 用的 token 超过了预算，点按钮把预算调到 3000 万。',
  nodes: [
    { id: 'row', type: 'Item', props: { lead: { value: '2250万', caption: '已用', size: 'sm' }, title: '#259 单行发送回跳', meta: '实测前后各 3 次' }, children: ['raise'] },
    { id: 'raise', type: 'Action', props: { target: { type: 'ticket', id: TICKET }, action: 'set_budget', input: { tokenBudget: 30_000_000 }, role: 'primary', label: '预算调到 3000 万' } },
  ],
};

function setup(options: { callId?: string | null; recorded?: SurfaceActionDone[] } = {}) {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([summary]);
  runtime.control.getState().replaceTicketActions(TICKET, [setBudget]);
  const read = vi.spyOn(runtime, 'getSurfaceActions').mockResolvedValue(options.recorded ?? []);
  const run = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({ ticketId: TICKET, action: 'set_budget', result: null, ticket: null });
  const callId = options.callId === undefined ? CALL : options.callId;
  renderUI(<CompanionRuntimeProvider runtime={runtime}><SurfaceView surface={card} callId={callId} /></CompanionRuntimeProvider>);
  return { runtime, read, run };
}

const record = (extra: Partial<SurfaceActionDone> = {}): SurfaceActionDone => ({
  callId: CALL, node: 'raise', target: { type: 'ticket', id: String(TICKET) }, action: 'set_budget', at: '2026-11-05T10:54:00.000Z', ...extra,
});

describe('a button on a conversation card', () => {
  it('turns into a done line after the action succeeds, and tells the server which card it came from', async () => {
    const { run } = setup();
    const button = await screen.findByRole('button', { name: '预算调到 3000 万' });
    await act(async () => { fireEvent.click(button); });
    expect(run).toHaveBeenCalledWith(TICKET, 'set_budget', { input: { tokenBudget: 30_000_000 }, origin: { callId: CALL, node: 'raise' } });
    expect(screen.queryByRole('button', { name: '预算调到 3000 万' })).toBeNull();
    const done = screen.getByTestId('surface-action-raise-done');
    expect(done.textContent).toBe('Done预算调到 3000 万');
  });

  it('shows done when the card opens again, from the record on the server (a refresh or another device)', async () => {
    const { read } = setup({ recorded: [record()] });
    expect(await screen.findByTestId('surface-action-raise-done')).toBeTruthy();
    expect(read).toHaveBeenCalledWith([CALL]);
    expect(screen.queryByRole('button', { name: '预算调到 3000 万' })).toBeNull();
  });

  it('keeps the button when the record is for another action on the same node', async () => {
    setup({ recorded: [record({ action: 'set_priority' }), record({ node: 'other' })] });
    await waitFor(() => expect(screen.getByRole('button', { name: '预算调到 3000 万' })).toBeTruthy());
    expect(screen.queryByTestId('surface-action-raise-done')).toBeNull();
  });

  it('writes the reason next to the button when the action fails, and the button can be pressed again', async () => {
    const { run } = setup();
    run.mockRejectedValueOnce(new Error('工单已经取消，不能再改预算。'));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '预算调到 3000 万' })); });
    expect(screen.getByTestId('surface-action-raise-error').textContent).toBe('Failed: 工单已经取消，不能再改预算。');
    const button = screen.getByRole('button', { name: '预算调到 3000 万' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByTestId('surface-action-raise-done')).toBeNull();
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByTestId('surface-action-raise-done')).toBeTruthy();
    expect(screen.queryByTestId('surface-action-raise-error')).toBeNull();
  });

  it('picks up a press from another device when the ticket changes', async () => {
    const { runtime, read } = setup();
    expect(await screen.findByRole('button', { name: '预算调到 3000 万' })).toBeTruthy();
    read.mockResolvedValue([record()]);
    await act(async () => { runtime.control.getState().upsertTicket({ ...summary, updatedAt: '2026-11-05T10:54:01.000Z' }); });
    expect(await screen.findByTestId('surface-action-raise-done')).toBeTruthy();
  });

  it('stays a button on a card outside the conversation (a widget), which is used again and again', async () => {
    const { read, run } = setup({ callId: null });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '预算调到 3000 万' })); });
    expect(run).toHaveBeenCalledWith(TICKET, 'set_budget', { input: { tokenBudget: 30_000_000 } });
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '预算调到 3000 万' })).toBeTruthy();
  });
});

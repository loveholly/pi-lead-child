// 工单操作（工单 03 的操作层，工单 12 的界面）：页面上会改后端的按钮都走 POST /v1/tickets/:id/actions/:action。
// 做完以后重取「现在能做哪些操作」；服务端拒绝时也重取，页面上的按钮可能已经过时。
import type { TicketAction } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientError } from '@pi-lead-child/client';

import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from './runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

const pause = (available: boolean): TicketAction => ({
  id: 'pause_run', label: '暂停', area: 'execution', permission: 'user_only', external: false, irreversible: false,
  undoable: false, available, reason: available ? null : '没有正在运行的 Run 可以暂停。',
});

function actionRuntime(client: Record<string, unknown>) {
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['tickets:view', 'tickets:create']);
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTicketActions(42, [pause(true)]);
  return runtime;
}

describe('ticket actions', () => {
  it('runs the action and reloads what the ticket can do now', async () => {
    const runTicketAction = vi.fn(async () => ({ ticketId: 42, action: 'pause_run', result: null, ticket: null }));
    const listTicketActions = vi.fn(async () => [pause(false)]);
    const runtime = actionRuntime({ runTicketAction, listTicketActions });

    await runtime.runTicketAction(42, 'pause_run', { input: {} });

    expect(runTicketAction).toHaveBeenCalledWith(42, 'pause_run', { input: {} });
    expect(listTicketActions).toHaveBeenCalledWith(42, expect.anything());
    expect(runtime.control.getState().ticketActionsByTicket[42]).toEqual([pause(false)]);
  });

  it('reloads the action list when the server refuses, then rethrows', async () => {
    const refused = new ControlPlaneClientError('没有正在运行的 Run 可以暂停。', 'conflict', 409);
    const runTicketAction = vi.fn(async () => { throw refused; });
    const listTicketActions = vi.fn(async () => [pause(false)]);
    const runtime = actionRuntime({ runTicketAction, listTicketActions });

    await expect(runtime.runTicketAction(42, 'pause_run')).rejects.toBe(refused);
    expect(runtime.control.getState().ticketActionsByTicket[42]).toEqual([pause(false)]);
  });
});

// 交付的合并、开 PR、放弃（2026-10-21 审查 M2）：状态层带上界面画出来的那份交付（workspace.head、workspace.target），
// 服务端比对。交付在用户看过以后变了，服务端返回 409（details.reason 是 stale），状态层重取交付，让用户看过新的再决定。
import type { TicketDelivery } from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientError } from '@pi-lead-child/client';

import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from './runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));

const unavailable = { available: false, reason: '改动已经合并。' };
const delivery = (head: string): TicketDelivery => ({
  ticketId: 42, attemptId: null, source: 'isolated', files: [], truncated: false, totals: null,
  workspace: {
    workspaceId: 7, branch: 'plc/item-42', head, target: 'main', commits: 1, uncommittedFiles: 0,
    integration: 'unmerged', mergedInto: null, pullRequestUrl: null,
  },
  actions: { merge: { ...unavailable, acceptsTicket: false }, openPullRequest: unavailable, abandon: unavailable },
});

function deliveryRuntime(client: Record<string, unknown>) {
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({ phase: 'ready', connectionState: 'connected', deliveryByTicket: { ...state.deliveryByTicket, 42: delivery('a'.repeat(40)) } }));
  return runtime;
}

describe('delivery actions', () => {
  it('sends the head and the target the user saw', async () => {
    const performDeliveryAction = vi.fn(async () => ({ action: 'merge', delivery: delivery('a'.repeat(40)) }));
    const runtime = deliveryRuntime({ performDeliveryAction });
    await runtime.performDeliveryAction(42, 'merge');
    expect(performDeliveryAction).toHaveBeenCalledWith(42, 'merge', { expected: { head: 'a'.repeat(40), target: 'main' } });
  });

  it('reloads the delivery when the server says it changed since the user looked', async () => {
    const stale = new ControlPlaneClientError('分支在你看过以后有了新的提交。', 'conflict', 409, {
      error: { code: 'conflict', message: '分支在你看过以后有了新的提交。', details: { reason: 'stale' } },
    });
    const performDeliveryAction = vi.fn(async () => { throw stale; });
    const getTicketDelivery = vi.fn(async () => delivery('b'.repeat(40)));
    const runtime = deliveryRuntime({ performDeliveryAction, getTicketDelivery });
    await expect(runtime.performDeliveryAction(42, 'merge')).rejects.toBe(stale);
    expect(getTicketDelivery).toHaveBeenCalledWith(42, expect.anything());
    expect(runtime.control.getState().deliveryByTicket[42]?.workspace?.head).toBe('b'.repeat(40));
  });
});

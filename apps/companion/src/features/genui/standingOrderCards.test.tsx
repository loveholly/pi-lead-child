// @vitest-environment jsdom
// 会话里的常设指令确认卡（工单 10）：Paimon 提了更放开的修改后发一张 StandingOrderChangeConfirm，卡片只带审批号，
// 内容和状态从 /v1/standing-order-proposals/:id 实时读取；批准只来自你按的按钮。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { UiSurface } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { connectionsRuntime, renderWithRuntime, type FakeConnectionClient } from '../../../test/connections';
import { proposal } from '../../../test/standingOrders';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const APPROVAL = 42;

function surface(): UiSurface {
  return {
    id: 'surface-standing-order', catalogVersion: 1, root: 'card', fallbackText: 'Paimon 想改一条常设指令，要你批准。',
    nodes: [{ id: 'card', type: 'StandingOrderChangeConfirm', props: { approval: APPROVAL } }],
  };
}

function runtimeWith(client: { standingOrderProposal: ReturnType<typeof vi.fn>; decideStandingOrderProposal?: ReturnType<typeof vi.fn> }) {
  const fake = { decideStandingOrderProposal: vi.fn(() => new Promise(() => {})), ...client };
  return connectionsRuntime([], fake as unknown as Partial<FakeConnectionClient>);
}

describe('the standing order change card', () => {
  it('reads the proposal, shows the reason and why it needs you, and approves when you press 批准', async () => {
    const { runtime, client } = runtimeWith({
      standingOrderProposal: vi.fn(async () => ({ proposal: proposal(), order: null })),
      decideStandingOrderProposal: vi.fn(async () => ({ proposal: proposal({ state: 'approved', appliedVersion: 2 }), order: null })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect((client as any).standingOrderProposal).toHaveBeenCalledWith(APPROVAL, expect.any(AbortSignal));
    const card = screen.getByTestId(`surface-standing-order-${APPROVAL}`);
    expect(card.textContent).toContain('Paimon 想修改「要叫醒 Paimon 的事告诉 Paimon」');
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-reason`).textContent).toBe('Paimon 的原因：blocker 太多，先进摘要');
    // 只列更放开的几项：这是要你看的理由。
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-concern-0`).textContent).toContain('交给人的更少');
    expect(screen.queryByTestId(`surface-standing-order-${APPROVAL}-concern-1`)).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId(`surface-standing-order-${APPROVAL}-approve`)); });
    expect((client as any).decideStandingOrderProposal).toHaveBeenCalledWith(APPROVAL, true);
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-result`).textContent).toBe('已批准，生效为 v2');
    expect(screen.queryByTestId(`surface-standing-order-${APPROVAL}-approve`)).toBeNull();
  });

  it('keeps the order as it is with 不批准', async () => {
    const { runtime, client } = runtimeWith({
      standingOrderProposal: vi.fn(async () => ({ proposal: proposal(), order: null })),
      decideStandingOrderProposal: vi.fn(async () => ({ proposal: proposal({ state: 'rejected' }), order: null })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId(`surface-standing-order-${APPROVAL}-reject`)); });
    expect((client as any).decideStandingOrderProposal).toHaveBeenCalledWith(APPROVAL, false);
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-result`).textContent).toBe('你没有批准，指令照旧');
  });

  it('shows the current state when the proposal was voided in the meantime', async () => {
    const read = vi.fn(async () => ({ proposal: proposal(), order: null }));
    const { runtime } = runtimeWith({
      standingOrderProposal: read,
      decideStandingOrderProposal: vi.fn(async () => { throw new ControlPlaneClientError('常设指令在提议之后又变了', 'conflict', 409); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    read.mockResolvedValue({ proposal: proposal({ state: 'expired', voidedReason: 'superseded' }), order: null });
    await act(async () => { fireEvent.click(screen.getByTestId(`surface-standing-order-${APPROVAL}-approve`)); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-result`).textContent).toBe('指令后来又改过，这个提议作废了');
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-error`).textContent).toContain('又变了');
    expect(screen.queryByTestId(`surface-standing-order-${APPROVAL}-approve`)).toBeNull();
  });

  it('says so when the approval is not a standing order proposal', async () => {
    const { runtime } = runtimeWith({
      standingOrderProposal: vi.fn(async () => { throw new ControlPlaneClientError('没有常设指令的提议 #42', 'not_found', 404); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect(screen.getByTestId(`surface-standing-order-${APPROVAL}-gone`).textContent).toBe('找不到这个常设指令的提议。');
  });
});

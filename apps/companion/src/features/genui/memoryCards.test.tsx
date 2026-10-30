// @vitest-environment jsdom
// 会话里的记忆切换卡：Lead 收到要确认的 memory_switch 后发一张 MemorySwitchConfirm，卡片只带切换号，
// 状态从 /v1/memory/switches/:id 实时读取；确认只来自你按的按钮。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { MemorySwitch, UiSurface } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { connectionsRuntime, renderWithRuntime, type FakeConnectionClient } from '../../../test/connections';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SWITCH_ID = 'msw_abcdefgh1234';

function surface(): UiSurface {
  return {
    id: 'surface-memory', catalogVersion: 1, root: 'card', fallbackText: '记忆切换要你确认。',
    nodes: [{ id: 'card', type: 'MemorySwitchConfirm', props: { switch: SWITCH_ID } }],
  };
}

function memorySwitch(overrides: Partial<MemorySwitch> = {}): MemorySwitch {
  return {
    id: SWITCH_ID, summary: 'embedding 换成远程 text-embedding-3-small（api.example.com）',
    reason: '全部 12 条笔记会发给 api.example.com；要为 12 条笔记重建索引', needsConfirmation: true,
    dataFlows: [{ kind: 'embedding', host: 'api.example.com', maxCandidates: null }], parts: ['embedding'],
    state: 'pending', createdAt: '2026-10-16T08:00:00.000Z', ...overrides,
  };
}

function runtimeWith(memory: { memorySwitch: ReturnType<typeof vi.fn>; confirmMemorySwitch?: ReturnType<typeof vi.fn> }) {
  const fake = { confirmMemorySwitch: vi.fn(() => new Promise(() => {})), ...memory };
  return connectionsRuntime([], fake as unknown as Partial<FakeConnectionClient>);
}

describe('the memory switch card', () => {
  it('reads the switch, shows why it needs you, and switches when you press 切换', async () => {
    const { runtime, client } = runtimeWith({
      memorySwitch: vi.fn(async () => memorySwitch()),
      confirmMemorySwitch: vi.fn(async () => ({ memory: {}, switch: memorySwitch({ state: 'applied' }) })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    const card = screen.getByTestId(`surface-memory-switch-${SWITCH_ID}`);
    expect((client as any).memorySwitch).toHaveBeenCalledWith(SWITCH_ID, expect.any(AbortSignal));
    expect(card.textContent).toContain('api.example.com');
    expect(card.textContent).toContain('重建索引');

    await act(async () => { fireEvent.click(screen.getByTestId('surface-memory-switch-approve')); });
    expect((client as any).confirmMemorySwitch).toHaveBeenCalledWith(SWITCH_ID, true);
    expect(screen.getByTestId('surface-memory-switch-result').textContent).toBe('已切换，索引在后台重建');
    expect(screen.queryByTestId('surface-memory-switch-approve')).toBeNull();
  });

  it('keeps memory as it is with 先不切换', async () => {
    const { runtime, client } = runtimeWith({
      memorySwitch: vi.fn(async () => memorySwitch()),
      confirmMemorySwitch: vi.fn(async () => ({ memory: {}, switch: memorySwitch({ state: 'rejected' }) })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('surface-memory-switch-reject')); });
    expect((client as any).confirmMemorySwitch).toHaveBeenCalledWith(SWITCH_ID, false);
    expect(screen.getByTestId('surface-memory-switch-result').textContent).toBe('没有切换，记忆照旧');
  });

  it('words the result from the parts the switch waited for', async () => {
    const rerankOnly = memorySwitch({
      summary: 'reranker 换成决策模型 jev-latest', parts: ['reranker'],
      dataFlows: [{ kind: 'rerank', host: 'api.typesafe.ai', maxCandidates: 50 }],
    });
    const { runtime } = runtimeWith({
      memorySwitch: vi.fn(async () => rerankOnly),
      confirmMemorySwitch: vi.fn(async () => ({ memory: {}, switch: { ...rerankOnly, state: 'applied' } })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect(screen.getByTestId('surface-memory-switch-hint').textContent).toBe('不切换时，重排改为「不用」。以后也可以在设置 → Paimon → 记忆里改。');
    await act(async () => { fireEvent.click(screen.getByTestId('surface-memory-switch-approve')); });
    expect(screen.getByTestId('surface-memory-switch-result').textContent).toBe('已切换，重排改用决策模型');
  });

  it('says what a rejected switch leaves when both parts waited', async () => {
    const both = memorySwitch({ parts: ['embedding', 'reranker'] });
    const { runtime } = runtimeWith({
      memorySwitch: vi.fn(async () => both),
      confirmMemorySwitch: vi.fn(async () => ({ memory: {}, switch: { ...both, state: 'rejected' } })),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect(screen.getByTestId('surface-memory-switch-hint').textContent).toBe('不切换时，embedding 照旧，重排改为「不用」。以后也可以在设置 → Paimon → 记忆里改。');
    await act(async () => { fireEvent.click(screen.getByTestId('surface-memory-switch-reject')); });
    expect(screen.getByTestId('surface-memory-switch-result').textContent).toBe('没有切换，embedding 照旧，重排改为「不用」');
  });

  it('shows the current state when the switch was handled elsewhere', async () => {
    const read = vi.fn(async () => memorySwitch());
    const { runtime } = runtimeWith({
      memorySwitch: read,
      confirmMemorySwitch: vi.fn(async () => { throw new ControlPlaneClientError('设置已经变了，这个切换作废', 'conflict', 409); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    read.mockResolvedValue(memorySwitch({ state: 'superseded' }));
    await act(async () => { fireEvent.click(screen.getByTestId('surface-memory-switch-approve')); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('surface-memory-switch-result').textContent).toBe('设置又变了，这个切换作废');
    expect(screen.queryByTestId('surface-memory-switch-approve')).toBeNull();
  });

  it('says an older switch was already handled', async () => {
    const { runtime } = runtimeWith({
      memorySwitch: vi.fn(async () => { throw new ControlPlaneClientError('没有这个切换', 'not_found', 404); }),
    });
    await act(async () => { renderWithRuntime(<SurfaceView surface={surface()} />, runtime); });
    expect(screen.getByTestId(`surface-memory-switch-${SWITCH_ID}`).textContent).toBe('这个记忆切换已经处理过了。');
  });
});

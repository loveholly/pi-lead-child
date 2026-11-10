// @vitest-environment happy-dom
// 设置 → Lead → 身份与风格 →「Lead 忙时你发的消息」（主题 11.19，用户 2026-11-09）：排队（缺省）和插话二选一，
// 是一组单选（用户 2026-11-09：「把 tab 换成 radio 吧」），每个选项里一句说明，说明里的名字是 Lead 的名字。点了马上保存（操作层的 busy_placement.set）；没保存成功时写原因，选中项退回。
// 旧 daemon 不支持时不给选。契约在 packages/protocol/src/busy-placement.ts；客户端方法是假的。
import { CHAT_PLACEMENT_PREFERENCE_CAPABILITY, type BusyPlacementDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { BusyPlacementSection } from './BusyPlacementSection';
import { busyPlacementMessages } from './busyPlacement.messages';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/profile', Slot: () => null, Stack: () => null }));

function busyPlacementRuntime(initial: BusyPlacementDto, options: { capabilities?: string[]; fail?: string } = {}) {
  let current = initial;
  const fake = {
    getBusyPlacement: vi.fn(async () => current),
    performUiAction: vi.fn(async (type: string, id: string, action: string, request: { input: { placement: BusyPlacementDto['placement'] } }) => {
      if (options.fail) throw new Error(options.fail);
      const before = current.placement;
      current = { placement: request.input.placement };
      return { target: { type, id }, action, result: { changed: before !== current.placement, before, busyPlacement: current } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    capabilities: options.capabilities ?? [CHAT_PLACEMENT_PREFERENCE_CAPABILITY],
    busyPlacement: initial,
    resourceState: {
      ...state.resourceState,
      'busy-placement': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

const selected = (value: string) => screen.getByTestId(`busy-placement-${value}`).getAttribute('aria-checked');

describe('the busy placement card', () => {
  it('offers Queue and Steer as radio buttons, selects Queue by default, and explains each option with the Lead name', () => {
    const { runtime } = busyPlacementRuntime({ placement: 'followUp' });
    renderWithRuntime(<BusyPlacementSection />, runtime);
    expect(screen.getByTestId('busy-placement-section')).toBeTruthy();
    const group = screen.getByTestId('busy-placement');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Messages you send while Paimon is busy');
    expect(screen.getByTestId('busy-placement-followUp').getAttribute('role')).toBe('radio');
    expect(screen.getByTestId('busy-placement-steer').getAttribute('role')).toBe('radio');
    expect(screen.getByTestId('busy-placement-followUp').textContent)
      .toBe('QueuePaimon gets the message after it finishes this turn. To send it in now, click Steer on it in the queue bar above the message box.');
    expect(screen.getByTestId('busy-placement-steer').textContent)
      .toBe('SteerThe message goes into the turn that Paimon is working on now.');
    expect(selected('followUp')).toBe('true');
    expect(selected('steer')).toBe('false');
  });

  it('saves Steer right away through the operation, and back to Queue', async () => {
    const { runtime, client } = busyPlacementRuntime({ placement: 'followUp' });
    renderWithRuntime(<BusyPlacementSection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('busy-placement-steer')); });
    expect(client.performUiAction).toHaveBeenCalledWith('busy_placement', 'lead', 'set', { input: { placement: 'steer' } });
    expect(selected('steer')).toBe('true');
    expect(runtime.control.getState().busyPlacement).toEqual({ placement: 'steer' });

    await act(async () => { fireEvent.click(screen.getByTestId('busy-placement-followUp')); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('busy_placement', 'lead', 'set', { input: { placement: 'followUp' } });
    expect(selected('followUp')).toBe('true');
  });

  it('shows why the change did not save, and keeps the saved option selected', async () => {
    const { runtime } = busyPlacementRuntime({ placement: 'followUp' }, { fail: 'The daemon is busy' });
    renderWithRuntime(<BusyPlacementSection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('busy-placement-steer')); });
    expect(screen.getByTestId('busy-placement-error').textContent).toBe('The change did not save: The daemon is busy');
    expect(selected('followUp')).toBe('true');
  });

  it('offers no choice when the daemon does not place messages by this setting', () => {
    const { runtime } = busyPlacementRuntime({ placement: 'followUp' }, { capabilities: [] });
    renderWithRuntime(<BusyPlacementSection />, runtime);
    expect(screen.getByTestId('busy-placement-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('busy-placement-followUp')).toBeNull();
  });

  it('has the same texts in Chinese, with the Lead name', () => {
    const zh = busyPlacementMessages('zh');
    expect(zh.options.followUp).toBe('排队');
    expect(zh.options.steer).toBe('插话');
    expect(zh.notes.followUp('Fairy')).toBe('等 Fairy 答完这一轮再交给它，可以在输入框上方的排队栏里点 Steer 马上插进去。');
    expect(zh.notes.steer('Fairy')).toBe('直接插进 Fairy 正在做的这一轮。');
  });
});

// @vitest-environment jsdom
// 设置 → 免沙箱（工单 #246 实施单 A；用户 2026-11-10：「把 bypass 的时间限制去掉，也做成和 steer 一样的开关就好」）。
// 和「Lead 忙时你发的消息」（主题 11.19）同一种写法：关着（缺省）和开着二选一，是一组单选卡，每个选项里一句说明。
// 点了马上保存：开着走 host_bypass.enable（不带时长），关着走 host_bypass.disable。没有时长、没有倒计时，开着以后一直开着。
// 没保存成功时写原因，选中项退回保存着的那一个。契约在 packages/protocol/src/host-bypass.ts；客户端方法是假的。
import type { HostBypassDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { HostBypassSection } from './HostBypassSection';
import { hostBypassMessages } from './hostBypass.messages';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/host-bypass', Slot: () => null, Stack: () => null }));

afterEach(() => vi.useRealTimers());

const OFF: HostBypassDto = { enabled: false, enabledAt: null, bindingId: null, reason: null };
const ON: HostBypassDto = { enabled: true, enabledAt: new Date().toISOString(), bindingId: 3, reason: '在设置页打开了免沙箱' };

function hostBypassRuntime(initial: HostBypassDto, options: { fail?: unknown } = {}) {
  // 假的 daemon：读回的是现在的开关。
  let current = initial;
  const fake = {
    getHostBypass: vi.fn(async () => current),
    enableHostBypass: vi.fn(async () => {
      if (options.fail) throw options.fail;
      current = ON;
      return ON;
    }),
    disableHostBypass: vi.fn(async () => {
      if (options.fail) throw options.fail;
      current = OFF;
      return OFF;
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
    hostBypass: initial,
    resourceState: {
      ...state.resourceState,
      'host-bypass': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

const selected = (value: 'off' | 'on') => screen.getByTestId(`host-bypass-${value}`).getAttribute('aria-checked');

describe('the sandbox bypass settings', () => {
  it('offers Off and On as radio buttons, selects Off by default, and asks for no duration', () => {
    const { runtime } = hostBypassRuntime(OFF);
    renderWithRuntime(<HostBypassSection />, runtime);
    expect(screen.getByTestId('host-bypass-section')).toBeTruthy();
    expect(screen.getByTestId('host-bypass').getAttribute('role')).toBe('radiogroup');
    expect(screen.getByTestId('host-bypass-off').getAttribute('role')).toBe('radio');
    expect(screen.getByTestId('host-bypass-on').getAttribute('role')).toBe('radio');
    expect(selected('off')).toBe('true');
    expect(selected('on')).toBe('false');
    expect(screen.getByTestId('host-bypass-on').textContent).toContain('This stays on until you or Paimon turn it off.');
    expect(screen.getByTestId('host-bypass-footnote').textContent)
      .toBe('Saves right away and applies on all your devices. Only you can turn this on. Paimon can turn it off.');
    // 没有时长，也没有倒计时。
    expect(screen.queryByTestId('host-bypass-minutes')).toBeNull();
    expect(screen.getByTestId('host-bypass-section').textContent).not.toMatch(/minute|min\b|until \d/);
  });

  it('turns on right away with no duration, and turns off again', async () => {
    const { runtime, client } = hostBypassRuntime(OFF);
    renderWithRuntime(<HostBypassSection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('host-bypass-on')); });
    expect(client.enableHostBypass).toHaveBeenCalledTimes(1);
    expect(client.enableHostBypass.mock.calls[0]).toEqual([]);
    expect(selected('on')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByTestId('host-bypass-off')); });
    expect(client.disableHostBypass).toHaveBeenCalledTimes(1);
    expect(selected('off')).toBe('true');
  });

  it('stays on long after it was turned on', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { runtime, client } = hostBypassRuntime(ON);
    renderWithRuntime(<HostBypassSection />, runtime);
    expect(selected('on')).toBe('true');
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 60_000); });
    expect(selected('on')).toBe('true');
    expect(client.disableHostBypass).not.toHaveBeenCalled();
  });

  it('does nothing when you pick the option that is already saved', async () => {
    const { runtime, client } = hostBypassRuntime(ON);
    renderWithRuntime(<HostBypassSection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('host-bypass-on')); });
    expect(client.enableHostBypass).not.toHaveBeenCalled();
  });

  it('shows why the change did not save, and keeps the saved option selected', async () => {
    const { runtime } = hostBypassRuntime(OFF, { fail: Object.assign(new Error('forbidden'), { status: 403 }) });
    renderWithRuntime(<HostBypassSection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('host-bypass-on')); });
    expect(screen.getByTestId('host-bypass-error').textContent)
      .toBe('The change did not save: This device does not have permission to change this setting.');
    expect(selected('off')).toBe('true');
  });

  it('has the same texts in Chinese, with the Lead name', () => {
    const zh = hostBypassMessages('zh');
    expect(zh.options).toEqual({ off: '关着', on: '开着' });
    expect(zh.notes.off('Fairy')).toBe('Fairy 的命令都在沙箱里跑。沙箱外的事，Fairy 先发一张确认卡问你。');
    expect(zh.notes.on('Fairy')).toContain('一直开着，直到你或 Fairy 关掉。');
    expect(zh.footnote('Fairy')).toBe('选了马上保存，所有设备一起生效。只有你能打开，Fairy 能关。');
  });
});

// @vitest-environment jsdom
// 设置 → 执行 → 执行器（2026-10-19）：每个 runtime 一个开关，拨了马上发请求，界面换成 daemon 回的设置；
// 能做只读核查的执行器都停用时，写明自动核查派不出去。契约在 packages/protocol/src/runtime-settings.ts。
import type { RuntimeSettingsDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { RuntimesSection } from './RuntimesSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/runtimes', Slot: () => null, Stack: () => null }));

const ALL_ON: RuntimeSettingsDto = {
  runtimes: [
    { id: 'codex', label: 'Codex', enabled: true, installed: true, canReview: true },
    { id: 'claude', label: 'Claude Code', enabled: true, installed: true, canReview: false },
    { id: 'pi', label: 'pi', enabled: true, installed: false, canReview: false },
  ],
  reviewer: { id: 'codex', canReview: true },
};
const CODEX_OFF: RuntimeSettingsDto = {
  runtimes: ALL_ON.runtimes.map((entry) => (entry.id === 'codex' ? { ...entry, enabled: false } : entry)),
  // 2026-10-20 起 codex 停用以后，下一个启用的执行器接着当核查员（daemon 的 defaultReviewRuntime）。
  reviewer: { id: 'claude', canReview: true },
};
const ALL_OFF: RuntimeSettingsDto = {
  runtimes: ALL_ON.runtimes.map((entry) => ({ ...entry, enabled: false })),
  reviewer: { id: 'codex', canReview: false },
};

function runtimesRuntime(initial: RuntimeSettingsDto, afterUpdate: RuntimeSettingsDto = CODEX_OFF) {
  const fake = {
    getRuntimeSettings: vi.fn(async () => initial),
    updateRuntimeSettings: vi.fn(async () => afterUpdate),
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
    runtimeSettings: initial,
    resourceState: {
      ...state.resourceState,
      'runtime-settings': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

describe('the runtimes section', () => {
  it('turns a runtime off with one switch and shows what that means for automatic review', async () => {
    const { runtime, client } = runtimesRuntime(ALL_ON);
    renderWithRuntime(<RuntimesSection />, runtime);
    expect(screen.getByTestId('runtimes-reviewer').textContent).toBe('自动核查用 Codex。它不能用时，自动换下一个能用的执行器。');
    expect(screen.getByTestId('runtime-row-pi').textContent).toContain('没有安装');
    expect(screen.getByTestId('runtime-switch-codex').getAttribute('aria-checked')).toBe('true');

    await act(async () => { fireEvent.click(screen.getByTestId('runtime-switch-codex')); });
    expect(client.updateRuntimeSettings).toHaveBeenCalledWith({ runtime: 'codex', enabled: false });
    expect(screen.getByTestId('runtime-switch-codex').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('runtime-row-codex').textContent).toContain('已停用');
    // 回归（2026-10-21）：以前写「自动核查会排队等着，重新启用 Codex 以后自动派出」，可核查员已经自动换成了下一个。
    expect(screen.getByTestId('runtimes-reviewer').textContent)
      .toBe('自动核查用 Claude Code。Claude Code 只能读代码，不能运行测试，核查结论来自阅读。它不能用时，自动换下一个能用的执行器。');
  });

  it('says automatic review cannot go out only when every runtime is off', async () => {
    const { runtime } = runtimesRuntime(ALL_OFF, ALL_OFF);
    renderWithRuntime(<RuntimesSection />, runtime);
    expect(screen.getByTestId('runtimes-reviewer').textContent)
      .toBe('所有执行器都停用了，自动核查派不出去。委托给 Paimon 验收的工单要你自己验收。');
  });
});

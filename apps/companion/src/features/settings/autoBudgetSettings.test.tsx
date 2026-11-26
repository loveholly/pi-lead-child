// @vitest-environment happy-dom
// 设置 → Lead → 身份与风格 →「自动调用模型的上限」（工单 #553，主题 11.27）：三个数字字段，每个下面写缺省值和最近的用量；
// 点「保存」走操作层的 auto_budget.set，只交改了的字段，保存后卡片显示新的值；不合格的值不让保存，状态行写原因；没保存成功时写原因；
// 「恢复缺省」把字段填回缺省值；旧 daemon 不支持时只写一行说明。契约在 packages/protocol/src/auto-budget.ts；客户端方法是假的。
import { AUTO_BUDGET_SETTINGS_CAPABILITY, type AutoBudgetDto, type SetAutoBudgetRequest } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { AutoBudgetSection, parseLimit } from './AutoBudgetSection';
import { LeadIdentitySettings } from './LeadIdentitySettings';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/profile', Slot: () => null, Stack: () => null }));

const DEFAULTS = { callsPerHour: 120, callsPerDay: 1_500, uncachedTokensPerDay: 50_000_000 };
const INITIAL: AutoBudgetDto = {
  limits: { ...DEFAULTS, callsPerHour: 60 },
  defaults: DEFAULTS,
  usage: { callsLastHour: 14, callsLastDay: 318, uncachedTokensLastDay: 12_400_000 },
};

function autoBudgetRuntime(initial: AutoBudgetDto | null, options: { capabilities?: string[]; fail?: string } = {}) {
  let current = initial ?? INITIAL;
  const fake = {
    getAutoBudget: vi.fn(async () => current),
    performUiAction: vi.fn(async (type: string, id: string, action: string, request: { input: SetAutoBudgetRequest }) => {
      if (options.fail) throw new Error(options.fail);
      current = { ...current, limits: { ...current.limits, ...request.input } };
      return { target: { type, id }, action, result: { changed: true, autoBudget: current } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  // What the daemon announced in hello (the runtime reads the limits only when it did).
  (runtime as unknown as { capabilities: Set<string> }).capabilities = new Set(options.capabilities ?? [AUTO_BUDGET_SETTINGS_CAPABILITY]);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    capabilities: options.capabilities ?? [AUTO_BUDGET_SETTINGS_CAPABILITY],
    autoBudget: initial,
    resourceState: {
      ...state.resourceState,
      ...(initial ? { 'auto-budget': { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null } } : {}),
    },
  }));
  return { runtime, client: fake };
}

const input = (key: string) => screen.getByTestId(`auto-budget-${key}`) as HTMLInputElement;
const type = (key: string, value: string) => fireEvent.change(input(key), { target: { value } });
const status = () => screen.getByTestId('auto-budget-status').textContent;
const saveButton = () => screen.getByTestId('auto-budget-save');
const disabled = (element: HTMLElement) => element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled === true;

describe('the limits on automatic model calls', () => {
  it('sits on the Identity & style page and shows each limit with its default and recent usage', async () => {
    const { runtime } = autoBudgetRuntime(INITIAL);
    await act(async () => { renderWithRuntime(<LeadIdentitySettings />, runtime); });
    expect(screen.getByTestId('auto-budget-section').textContent).toContain('Limits on automatic model calls');
    expect(input('callsPerHour').value).toBe('60');
    expect(input('callsPerDay').value).toBe('1500');
    expect(input('uncachedTokensPerDay').value).toBe('50000000');
    const text = screen.getByTestId('auto-budget-section').textContent ?? '';
    expect(text).toContain('Default 120. 14 used in the last hour.');
    expect(text).toContain('Default 1,500. 318 used in the last 24 hours.');
    expect(text).toContain('Default 50,000,000. 12,400,000 used in the last 24 hours.');
    expect(status()).toContain('0 means no limit. Saving applies at once, no restart.');
    // Nothing changed yet: nothing to save.
    expect(disabled(saveButton())).toBe(true);
  });

  it('saves only the changed fields through the operation and shows the new value', async () => {
    const { runtime, client } = autoBudgetRuntime(INITIAL);
    await act(async () => { renderWithRuntime(<AutoBudgetSection />, runtime); });
    act(() => { type('callsPerDay', '3000'); });
    await act(async () => { fireEvent.click(saveButton()); });
    expect(client.performUiAction).toHaveBeenCalledWith('auto_budget', 'lead', 'set', { input: { callsPerDay: 3_000 } });
    expect(runtime.control.getState().autoBudget?.limits).toEqual({ ...DEFAULTS, callsPerHour: 60, callsPerDay: 3_000 });
    expect(input('callsPerDay').value).toBe('3000');
  });

  it('does not save a value that is not a whole number from 0 up, and says which field is wrong', async () => {
    const { runtime, client } = autoBudgetRuntime(INITIAL);
    await act(async () => { renderWithRuntime(<AutoBudgetSection />, runtime); });
    act(() => { type('callsPerHour', '-5'); });
    expect(status()).toBe('Calls per hour: write a whole number from 0 up.');
    expect(disabled(saveButton())).toBe(true);
    act(() => { type('callsPerHour', '999999999'); });
    expect(status()).toBe('Calls per hour: the largest value is 100,000.');
    await act(async () => { fireEvent.click(saveButton()); });
    expect(client.performUiAction).not.toHaveBeenCalled();
    // 0 is allowed: no limit.
    act(() => { type('callsPerHour', '0'); });
    await act(async () => { fireEvent.click(saveButton()); });
    expect(client.performUiAction).toHaveBeenCalledWith('auto_budget', 'lead', 'set', { input: { callsPerHour: 0 } });
  });

  it('says why when the save fails, and keeps what you typed', async () => {
    const { runtime } = autoBudgetRuntime(INITIAL, { fail: 'The daemon could not write config.json' });
    await act(async () => { renderWithRuntime(<AutoBudgetSection />, runtime); });
    act(() => { type('callsPerHour', '200'); });
    await act(async () => { fireEvent.click(saveButton()); });
    expect(status()).toContain('The change did not save:');
    expect(status()).toContain('The daemon could not write config.json');
    expect(input('callsPerHour').value).toBe('200');
  });

  it('fills the defaults back in with Restore defaults, and hides it when the fields hold the defaults', async () => {
    const { runtime, client } = autoBudgetRuntime(INITIAL);
    await act(async () => { renderWithRuntime(<AutoBudgetSection />, runtime); });
    act(() => { fireEvent.click(screen.getByTestId('auto-budget-defaults')); });
    expect(input('callsPerHour').value).toBe('120');
    expect(screen.queryByTestId('auto-budget-defaults')).toBeNull();
    await act(async () => { fireEvent.click(saveButton()); });
    expect(client.performUiAction).toHaveBeenCalledWith('auto_budget', 'lead', 'set', { input: { callsPerHour: 120 } });
  });

  it('reads the limits when the page opens', async () => {
    const { runtime, client } = autoBudgetRuntime(null);
    await act(async () => { renderWithRuntime(<AutoBudgetSection />, runtime); });
    expect(client.getAutoBudget).toHaveBeenCalled();
    expect(input('callsPerHour').value).toBe('60');
  });

  it('only says the daemon is too old when it did not announce the setting', () => {
    const { runtime, client } = autoBudgetRuntime(null, { capabilities: [] });
    renderWithRuntime(<AutoBudgetSection />, runtime);
    expect(screen.getByTestId('auto-budget-unsupported').textContent).toBe('This daemon cannot change these limits yet. Update it, then come back.');
    expect(client.getAutoBudget).not.toHaveBeenCalled();
  });
});

describe('parseLimit', () => {
  it('takes whole numbers from 0 up to the maximum, also with thousands separators', () => {
    expect(parseLimit('callsPerDay', '1,500')).toBe(1_500);
    expect(parseLimit('callsPerDay', ' 0 ')).toBe(0);
    expect(parseLimit('callsPerDay', '')).toBe('invalid');
    expect(parseLimit('callsPerDay', '1.5')).toBe('invalid');
    expect(parseLimit('callsPerHour', '100001')).toBe('too_large');
  });
});

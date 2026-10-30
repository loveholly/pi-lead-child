// @vitest-environment jsdom
// 首次启动页（2026-10-30，.scratch/onboarding/spec.md，画布 A1）走一遍：大脑不能用时整页挡住会话；
// 第一步按预设接入服务商（save_provider），读到目录后第二步出现，推荐的模型排第一；点「让 Paimon 上线」发 set_brain_chain，
// 设置状态说大脑能用了，这一页换成会话。「先进去看看」这次打开 App 时不再挡。
import type { BrainModel, ModelProvider, ModelSettingsDto, SetupStatus } from '@pi-lead-child/protocol';
import { SETUP_ITEM_KEYS } from '@pi-lead-child/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import RootTabs from '../../navigation/RootTabs.web';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/', Slot: () => <div data-testid="app-slot" />, Stack: () => null,
}));

function model(id: string): BrainModel {
  return {
    model: `anthropic/${id}`, id, name: id, image: true, contextWindow: 1_000_000, efforts: [], defaultEffort: null,
    released: null, blockedUntil: null,
  };
}

const anthropic: ModelProvider = {
  name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', keySet: true, keySource: 'settings', keyHost: 'api.anthropic.com',
  problem: null, models: [model('claude-haiku-5-5'), model('claude-sonnet-5-5'), model('claude-opus-5-5')],
};

function settings(providers: ModelProvider[]): ModelSettingsDto {
  return {
    brain: { chain: [], current: { model: 'openai/gpt-5.5', effort: null }, providers },
    fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
    maxBackups: 3,
  };
}

const setup = (brain: boolean): SetupStatus => ({
  items: SETUP_ITEM_KEYS.map((key) => ({ key, ready: key === 'brain' ? brain : false, detail: null })),
  changedAt: '2026-10-30T09:00:00.000Z',
});

type Perform = (type: string, id: string, action: string, request: unknown) => Promise<{ target: unknown; action: string; result: unknown }>;

function firstRunRuntime() {
  const state = { providers: [] as ModelProvider[], brain: false };
  const perform = vi.fn<Perform>(async (_type, _id, action) => {
    if (action === 'save_provider') state.providers = [anthropic];
    if (action === 'set_brain_chain') state.brain = true;
    return { target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null } };
  });
  const fake = {
    getModelSettings: vi.fn(async () => settings(state.providers)),
    getSetup: vi.fn(async () => setup(state.brain)),
    performUiAction: perform,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  runtime.control.setState((current) => ({
    phase: 'ready', connectionState: 'connected', modelSettings: settings([]), setup: setup(false),
    resourceState: { ...current.resourceState, 'model-settings': ready, setup: ready },
  }));
  return { runtime, perform };
}

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1280);
});

describe('the first-run page', () => {
  it('connects a provider, recommends a model, and gives way to the app once the brain works', async () => {
    const { runtime, perform } = firstRunRuntime();
    renderWithRuntime(<RootTabs />, runtime);
    expect(screen.getByTestId('first-run-title').textContent).toBe('先给 Paimon 接一个大模型');
    expect(screen.queryByTestId('app-slot')).toBeNull();
    expect(screen.queryByTestId('first-run-models')).toBeNull();

    // 预设只要 key；不填 key 不发请求。
    fireEvent.click(screen.getByTestId('first-run-connect'));
    expect(screen.getByTestId('first-run-problem').textContent).toBe('填上 Anthropic 的 API key。');
    expect(perform).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-ant-test' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-provider-done').textContent).toBe('anthropic · 读到 3 个模型'));
    expect(perform.mock.calls[0]!.slice(0, 3)).toEqual(['model_settings', 'models', 'save_provider']);
    expect((perform.mock.calls[0]![3] as { input: unknown }).input).toEqual({
      name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: 'sk-ant-test',
    });

    // 第二步：推荐最新的、不是小模型的那个，排第一。
    expect(screen.getByTestId('first-run-model-anthropic/claude-sonnet-5-5').textContent).toContain('推荐');
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    expect(perform.mock.calls[1]!.slice(0, 3)).toEqual(['model_settings', 'models', 'set_brain_chain']);
    expect((perform.mock.calls[1]![3] as { input: unknown }).input).toEqual({ models: [{ model: 'anthropic/claude-sonnet-5-5', effort: null }] });
  });

  it('lets the user in without a brain for this session', () => {
    const { runtime } = firstRunRuntime();
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.click(screen.getByTestId('first-run-skip'));
    expect(screen.getByTestId('app-slot')).toBeTruthy();
  });

  it('does not block the app before the setup status arrives', () => {
    const { runtime } = firstRunRuntime();
    runtime.control.setState({ setup: null });
    renderWithRuntime(<RootTabs />, runtime);
    expect(screen.getByTestId('app-slot')).toBeTruthy();
  });
});

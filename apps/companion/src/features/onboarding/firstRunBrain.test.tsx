// @vitest-environment happy-dom
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

// save：save_provider 以后 daemon 给的服务商列表（缺省是只有 Anthropic）。它拿到请求的 input 和现有的服务商，
// 可以照 accountPrefix 重新分组，或者按地址覆盖已有的那个。
type SaveInput = { name: string; baseUrl: string } & Record<string, unknown>;

function firstRunRuntime(save: (input: SaveInput, providers: ModelProvider[]) => ModelProvider[] = () => [anthropic]) {
  const state = { providers: [] as ModelProvider[], brain: false };
  const perform = vi.fn<Perform>(async (_type, _id, action, request) => {
    if (action === 'save_provider') state.providers = save((request as { input: SaveInput }).input, state.providers);
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

// 第一个用例要第一次渲染 RootTabs，冷启动时这台机器上要 5–8 秒，超过缺省的 5 秒（改这一步之前也一样）。
describe('the first-run page', { timeout: 30_000 }, () => {
  it('connects a provider, recommends a model, and gives way to the app once the brain works', async () => {
    const { runtime, perform } = firstRunRuntime();
    renderWithRuntime(<RootTabs />, runtime);
    expect(screen.getByTestId('first-run-title').textContent).toBe('Connect a model to Paimon');
    expect(screen.queryByTestId('app-slot')).toBeNull();
    expect(screen.queryByTestId('first-run-models')).toBeNull();

    // 预设只要 key；不填 key 不发请求。
    fireEvent.click(screen.getByTestId('first-run-connect'));
    expect(screen.getByTestId('first-run-problem').textContent).toBe('Enter the API key for Anthropic.');
    expect(perform).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-ant-test' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-provider-done').textContent).toBe('anthropic · 3 models found'));
    expect(perform.mock.calls[0]!.slice(0, 3)).toEqual(['model_settings', 'models', 'save_provider']);
    expect((perform.mock.calls[0]![3] as { input: unknown }).input).toEqual({
      name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: 'sk-ant-test',
    });

    // 第二步：推荐最新的、不是小模型的那个，排第一。
    expect(screen.getByTestId('first-run-model-anthropic/claude-sonnet-5-5').textContent).toContain('Recommended');
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    expect(perform.mock.calls[1]!.slice(0, 3)).toEqual(['model_settings', 'models', 'set_brain_chain']);
    expect((perform.mock.calls[1]![3] as { input: unknown }).input).toEqual({ models: [{ model: 'anthropic/claude-sonnet-5-5', effort: null }] });
  });

  // 其他服务连上了但目录读不出来，用户改了 key 再点「连接」：覆盖同一个服务商，config.json 里不再多出 deepseek-2、deepseek-3……
  it('overwrites the same provider when the user retries another service at the same address', async () => {
    const { runtime, perform } = firstRunRuntime((input, providers) => [
      ...providers.filter((entry) => entry.name !== input.name),
      { ...anthropic, name: input.name, baseUrl: input.baseUrl, api: 'openai-completions', keyHost: 'api.deepseek.com', models: [], problem: 'GET https://api.deepseek.com/v1/models failed: 401' },
    ]);
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.click(screen.getByTestId('first-run-preset-custom'));
    fireEvent.change(screen.getByTestId('first-run-base-url'), { target: { value: 'https://api.deepseek.com/v1' } });
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-test-wrong' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-problem').textContent).toBe('GET https://api.deepseek.com/v1/models failed: 401'));
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-test-right' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(2));
    const names = perform.mock.calls.map((call) => (call[3] as { input: SaveInput }).input.name);
    expect(names).toEqual(['deepseek', 'deepseek']);
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

// Lead 模型分组（用户 2026-11-05，原型 docs/prototypes/model-grouping 的第 1 个场景）。
const plainModel = (provider: string, id: string, source: string, group: string | null = null): BrainModel => ({
  model: `${provider}/${id}`, id, name: null, image: false, contextWindow: null, efforts: [], defaultEffort: null,
  released: null, blockedUntil: null, group, source,
});

// magpie 风格的服务：只有普通目录，id 带 auto/、deepseek/ 前缀。accountPrefix 为 true 时 daemon 把前缀当账号。
function magpie(input: Record<string, unknown>): ModelProvider {
  const account = input.accountPrefix === true;
  const name = String(input.name);
  return {
    name, baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', keySet: true, keySource: 'settings',
    keyHost: 'magpie.example.com', problem: null, accountPrefix: typeof input.accountPrefix === 'boolean' ? input.accountPrefix : null,
    accountPrefixActive: account, capabilities: 'auto', catalog: 'plain',
    models: [
      plainModel(name, 'auto/deepseek-flash', 'deepseek', account ? 'auto' : null),
      plainModel(name, 'deepseek/deepseek-v4', 'deepseek', account ? 'deepseek' : null),
      plainModel(name, 'bailian/qwen-max', 'bailian-token-plan', account ? 'bailian' : null),
    ],
  };
}

const vibeproxyProvider = (): ModelProvider => ({
  name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', keySet: false, keySource: null, keyHost: null,
  problem: null, accountPrefix: true, accountPrefixActive: true, capabilities: 'auto', catalog: 'detailed',
  models: [
    plainModel('vibeproxy', 'as4/claude-opus-5-5', 'anthropic', 'as4'),
    plainModel('vibeproxy', 'as1/claude-opus-5-5', 'anthropic', 'as1'),
    plainModel('vibeproxy', 'gemini-3-flash', 'antigravity'),
  ],
});

const inputs = (perform: ReturnType<typeof firstRunRuntime>['perform']) => perform.mock.calls.map((call) => [call[2], (call[3] as { input: unknown }).input]);

describe('the first-run page with model groups', { timeout: 30_000 }, () => {
  it('has a vibeproxy preset that writes accountPrefix: true and lists the models by account', async () => {
    const { runtime, perform } = firstRunRuntime(() => [vibeproxyProvider()]);
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.click(screen.getByTestId('first-run-preset-vibeproxy'));
    expect((screen.getByTestId('first-run-base-url') as HTMLInputElement).value).toBe('http://127.0.0.1:8317/v1');
    expect(screen.getByTestId('first-run-vibeproxy-note').textContent).toContain('accountPrefix: true');
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-provider-done')).toBeTruthy());
    expect(inputs(perform)[0]).toEqual(['save_provider', {
      name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', accountPrefix: true,
    }]);
    // 已经写了 accountPrefix：不问。按账号分段，as1 在 as4 前面。
    expect(screen.queryByTestId('first-run-prefix-question')).toBeNull();
    const titles = Array.from(screen.getByTestId('first-run-models').querySelectorAll('[data-testid^="first-run-section-"]'))
      .map((element) => element.getAttribute('data-testid'));
    expect(titles).toEqual([
      'first-run-section-vibeproxy|as1|anthropic', 'first-run-section-vibeproxy|as4|anthropic', 'first-run-section-vibeproxy||antigravity',
    ]);
  });

  it('asks whether the prefixes are accounts, and writes "yes" into the provider and regroups', async () => {
    const { runtime, perform } = firstRunRuntime((input) => [magpie(input)]);
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.click(screen.getByTestId('first-run-preset-custom'));
    fireEvent.change(screen.getByTestId('first-run-base-url'), { target: { value: 'https://magpie.example.com/v1' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-prefix-question')).toBeTruthy());
    // 问句用这家实际的两个前缀；缺省选「不是」，按通道分段。
    expect(screen.getByTestId('first-run-prefix-question').textContent).toContain('Are prefixes like auto/, deepseek/ accounts?');
    expect(screen.getByTestId('first-run-section-example||deepseek')).toBeTruthy();
    fireEvent.click(screen.getByText('Yes, the prefix is an account'));
    await waitFor(() => expect(screen.getByTestId('first-run-section-example|auto|deepseek')).toBeTruthy());
    expect(inputs(perform)[1]).toEqual(['save_provider', {
      name: 'example', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', accountPrefix: true,
    }]);
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    // 已经回答过：上线时不再写。
    expect(inputs(perform).map(([action]) => action)).toEqual(['save_provider', 'save_provider', 'set_brain_chain']);
  });

  it('writes the default "no" into the provider when the user goes online without answering', async () => {
    const { runtime, perform } = firstRunRuntime((input) => [magpie(input)]);
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.click(screen.getByTestId('first-run-preset-custom'));
    fireEvent.change(screen.getByTestId('first-run-base-url'), { target: { value: 'https://magpie.example.com/v1' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-prefix-question')).toBeTruthy());
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    expect(inputs(perform)[1]).toEqual(['save_provider', {
      name: 'example', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', accountPrefix: false,
    }]);
    expect(inputs(perform)[2]![0]).toBe('set_brain_chain');
  });
});

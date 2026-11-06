// @vitest-environment jsdom
// 设置 → Lead → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）：现在的分工（大脑和直觉各一个主用、最多 3 个备用）
// 和模型库（按服务商分组、可以折叠、最新的在上面）。客户端是假的，断言的是界面发出的操作（model_settings）。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { BrainModel, ModelProvider, ModelSettingsDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ModelSection } from './ModelSection';
import { brainPickerGroups } from './ModelPicker';
import { backupsLeft, brainModelName, brainRoles, contextLabel, providerGroup, releaseLabel, untilLabel, withSlot } from './modelSettingsModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/settings/model', Slot: () => null, Stack: () => null }));

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();

// group、source 照 daemon 给的写：vibeproxy 读到了详细目录，as4/ 是账号；通道是 owned_by。
function model(id: string, at: string | null, extra: Partial<BrainModel> = {}, provider = 'vibeproxy'): BrainModel {
  const source = provider === 'vibeproxy' ? (id.includes('gemini') ? 'antigravity' : 'anthropic') : provider;
  return {
    model: `${provider}/${id}`, id, name: null, image: true, contextWindow: 500_000, efforts: [], defaultEffort: null,
    released: at ? { at, source: 'provider' } : null, blockedUntil: null,
    group: provider === 'vibeproxy' && id.startsWith('as4/') ? 'as4' : null, source, ...extra,
  };
}

const vibeproxy: ModelProvider = {
  name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', keySet: false, keySource: null, keyHost: null, problem: null,
  accountPrefix: null, accountPrefixActive: true, capabilities: 'auto', catalog: 'detailed',
  models: [
    model('as4/claude-sonnet-5-5', day(14), { name: 'Claude Sonnet 5.5' }),
    model('claude-sonnet-5-5', day(14), { name: 'Claude Sonnet 5.5' }),
    model('as4/claude-haiku-5-5', day(13), { name: 'Claude Haiku 5.5' }),
    model('gemini-3.8-flash-high', day(2)),
    model('claude-sonnet-5', day(1)),
    model('claude-opus-4-7', '2026-04-16T00:00:00.000Z'),
    model('claude-3-7-sonnet', '2025-02-19T00:00:00.000Z'),
  ],
};
const openai: ModelProvider = {
  name: 'openai', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', keySet: true, keySource: 'settings', keyHost: 'api.openai.com', problem: null,
  accountPrefix: null, accountPrefixActive: false, capabilities: 'auto', catalog: 'plain',
  models: [model('gpt-5.5', day(2), {}, 'openai'), model('gpt-5', '2025-08-07T00:00:00.000Z', {}, 'openai')],
};

function settings(overrides: Partial<ModelSettingsDto['brain']> = {}, fast: Partial<ModelSettingsDto['fast']> = {}): ModelSettingsDto {
  return {
    brain: {
      chain: [{ model: 'vibeproxy/as4/claude-sonnet-5-5', effort: 'high' }, { model: 'vibeproxy/as4/claude-haiku-5-5', effort: null }],
      current: { model: 'vibeproxy/as4/claude-sonnet-5-5', effort: 'high' },
      providers: [vibeproxy, openai],
      ...overrides,
    },
    fast: {
      models: [
        { id: 'jev', name: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeySet: true, apiKeySource: 'env', apiKeyHost: 'api.typesafe.ai', problem: null },
        { id: 'decision-1', name: 'decision-1', baseUrl: 'https://jev.example.com', model: 'jev-latest', apiKeySet: true, apiKeySource: 'settings', apiKeyHost: 'jev.example.com', problem: null },
      ],
      chain: ['jev'],
      llmFallback: null,
      effectiveLlm: 'vibeproxy/as4/claude-haiku-5-5',
      ...fast,
    },
    maxBackups: 3,
  };
}

type Perform = (type: string, id: string, action: string, request: unknown) => Promise<{ target: unknown; action: string; result: unknown }>;

function modelRuntime(initial: ModelSettingsDto | Error, perform: ReturnType<typeof vi.fn<Perform>> = vi.fn<Perform>(async (_type, _id, action) => ({
  target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null },
}))) {
  const fake = {
    getModelSettings: vi.fn(async () => {
      if (initial instanceof Error) throw initial;
      return initial;
    }),
    performUiAction: perform,
    getMemory: vi.fn(async () => { throw new Error('not used'); }),
    getDecisionModel: vi.fn(async () => { throw new Error('not used'); }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  // 传的是错误时，模型设置还没取到：页面挂上以后自己去取。
  runtime.control.setState((state) => ({
    phase: 'ready', connectionState: 'connected', modelSettings: initial instanceof Error ? null : initial, memory: null,
    resourceState: {
      ...state.resourceState, memory: ready, 'decision-model': ready,
      ...(initial instanceof Error ? {} : { 'model-settings': ready }),
    },
  }));
  return { runtime, client: fake };
}

const inputOf = (perform: ReturnType<typeof vi.fn>, call = 0) => (perform.mock.calls[call]![3] as { input: unknown }).input;

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1280);
});

describe('the model rules', () => {
  it('counts the backups left, keeps an effort only for the same model, and labels sizes and dates', () => {
    expect([1, 2, 3, 4].map(backupsLeft)).toEqual([3, 2, 1, 0]);
    expect(withSlot([1, 2], 2, 3)).toEqual([1, 2, 3]);
    expect(contextLabel(1_048_576)).toBe('1M');
    expect(contextLabel(500_000)).toBe('500K');
    expect(releaseLabel({ at: '2026-11-02T08:00:00.000Z', source: 'first_seen' }, 'en')).toMatch(/^First seen 2026-11-0[23]$/);
    expect(releaseLabel({ at: '2026-11-02T08:00:00.000Z', source: 'first_seen' }, 'zh')).toMatch(/^首见 2026-11-0[23]$/);
    expect(releaseLabel(null, 'en')).toBeNull();
    expect(untilLabel('2026-11-02T08:00:00.000Z', new Date('2026-10-30T08:00:00.000Z'), 'en')).toMatch(/^(Sun|Mon) \d\d:00$/);
    expect(untilLabel('2026-11-02T08:00:00.000Z', new Date('2026-10-30T08:00:00.000Z'), 'zh')).toMatch(/^周[一日] \d\d:00$/);
    expect(brainRoles(settings(), 'vibeproxy/as4/claude-haiku-5-5', 'en')).toEqual(['Backup 1', 'Intuition fallback']);
    expect(brainRoles(settings(), 'vibeproxy/as4/claude-haiku-5-5', 'zh')).toEqual(['备用 1', '直觉兜底']);
  });

  it('shows the newest five of a provider plus every model in use, all of them when searching', () => {
    const used = new Set(['vibeproxy/claude-3-7-sonnet']);
    const group = providerGroup(vibeproxy, used);
    expect(group.models.map((entry) => entry.id)).toEqual([
      'as4/claude-sonnet-5-5', 'claude-sonnet-5-5', 'as4/claude-haiku-5-5', 'gemini-3.8-flash-high', 'claude-sonnet-5', 'claude-3-7-sonnet',
    ]);
    expect(group.hidden).toBe(1);
    expect(providerGroup(vibeproxy, used, { query: 'opus' }).models.map((entry) => entry.id)).toEqual(['claude-opus-4-7']);
  });
});

// 2026-10-29 部署时：网页先换成了新版，daemon 还没重启，旧 daemon 没有 GET /v1/models/settings，回 404。
// 页面只写了「读不到模型设置：not found」，看不出是 daemon 还没更新。
describe('an older daemon', () => {
  it('says the daemon has not been updated yet and needs a restart when it has no model settings', async () => {
    const { runtime } = modelRuntime(new ControlPlaneClientError('not found', 'not_found', 404));
    renderWithRuntime(<ModelSection />, runtime);
    const notice = await screen.findByTestId('model-old-daemon');
    expect(notice.textContent).toContain('daemon is not updated');
    expect(notice.textContent).toContain('Restart the daemon');
    expect(screen.queryByText(/not found/)).toBeNull();
  });

  // 还没配对、没有 scope 时资源也是 unsupported（页面先挂上，配对后来才完成）。那时不能说 daemon 还没更新。
  it('does not blame the daemon while the page is still pairing', () => {
    const { runtime } = modelRuntime(settings());
    runtime.control.setState((state) => ({
      modelSettings: null,
      resourceState: { ...state.resourceState, 'model-settings': { state: 'unsupported', generation: 0, observerCount: 1, lastSuccessAt: null, error: null } },
    }));
    renderWithRuntime(<ModelSection />, runtime);
    expect(screen.queryByTestId('model-old-daemon')).toBeNull();
    expect(screen.getByTestId('model-loading').textContent).toBe('Loading the model settings…');
  });

  it('still shows the reason for any other failure', async () => {
    const { runtime } = modelRuntime(new ControlPlaneClientError('读不到模型设置：vibeproxy 超时', 'internal_error', 503));
    renderWithRuntime(<ModelSection />, runtime);
    await waitFor(() => expect(screen.getByTestId('model-loading').textContent).toContain('vibeproxy 超时'));
    expect(screen.queryByTestId('model-old-daemon')).toBeNull();
  });
});

describe('who is on duty', () => {
  it('shows the primary, the backup, who answers now, and how many backups are left', () => {
    const { runtime } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    expect(screen.getByTestId('model-brain-slot-0').textContent).toContain('Claude Sonnet 5.5 · as4');
    expect(screen.getByTestId('model-brain-slot-0').textContent).toContain('Reasoning high');
    expect(screen.getByTestId('model-brain-slot-0').textContent).toContain('In use');
    expect(screen.getByTestId('model-brain-slot-1').textContent).not.toContain('In use');
    expect(screen.getByTestId('model-brain-add').textContent).toContain('You can add 2 more');
    expect(screen.getByTestId('model-fast-slot-0').textContent).toContain('api.typesafe.ai · jev-latest');
    expect(screen.getByTestId('model-fallback').textContent).toContain('Claude Haiku 5.5 · as4');
    expect(screen.getByTestId('model-fallback').textContent).toContain('Chosen by the system');
  });

  it('marks the backup in use while the primary waits for its quota', () => {
    const blocked = { ...vibeproxy, models: vibeproxy.models.map((entry) => (entry.id === 'as4/claude-sonnet-5-5' ? { ...entry, blockedUntil: '2026-11-02T08:00:00.000Z' } : entry)) };
    const { runtime } = modelRuntime(settings({ providers: [blocked, openai], current: { model: 'vibeproxy/as4/claude-haiku-5-5', effort: null } }));
    renderWithRuntime(<ModelSection />, runtime);
    expect(screen.getByTestId('model-brain-slot-0').textContent).toContain('Quota used up');
    expect(screen.getByTestId('model-brain-slot-1').textContent).toContain('In use');
  });

  it('adds a backup from the dropdown and keeps the effort of the slots it did not touch', async () => {
    const { runtime, client } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-brain-add'));
    // 已经在分工里的模型不能再选。
    // 浮层量好卡片的位置以后才出现。
    expect((await screen.findByTestId('model-brain-picker-add-option-vibeproxy/as4/claude-sonnet-5-5')).textContent).toContain('Already used as Primary');
    await act(async () => { fireEvent.click(screen.getByTestId('model-brain-picker-add-option-openai/gpt-5.5')); });
    expect(client.performUiAction).toHaveBeenCalledWith('model_settings', 'models', 'set_brain_chain', expect.anything());
    expect(inputOf(client.performUiAction)).toEqual({ models: [
      { model: 'vibeproxy/as4/claude-sonnet-5-5', effort: 'high' },
      { model: 'vibeproxy/as4/claude-haiku-5-5', effort: null },
      { model: 'openai/gpt-5.5', effort: null },
    ] });
    expect(client.getModelSettings).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('model-brain-message').textContent).toBe('Saved.'));
  });

  it('has no add slot once there are three backups, and says how to swap one', () => {
    const { runtime } = modelRuntime(settings({ chain: [
      { model: 'vibeproxy/as4/claude-sonnet-5-5', effort: null }, { model: 'vibeproxy/as4/claude-haiku-5-5', effort: null },
      { model: 'vibeproxy/gemini-3.8-flash-high', effort: null }, { model: 'openai/gpt-5.5', effort: null },
    ] }));
    renderWithRuntime(<ModelSection />, runtime);
    expect(screen.queryByTestId('model-brain-add')).toBeNull();
    expect(screen.getByTestId('model-brain-full').textContent).toContain('at most 3 backups');
  });

  it('removes a backup from its dropdown, and shows the daemon\'s reason when a change is refused', async () => {
    const perform = vi.fn<Perform>(async () => { throw new Error('换不到 vibeproxy/as4/claude-haiku-5-5，还在用 vibeproxy/as4/claude-sonnet-5-5'); });
    const { runtime } = modelRuntime(settings(), perform);
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-brain-picker-1-open'));
    const remove = await screen.findByTestId('model-brain-remove-1');
    await act(async () => { fireEvent.click(remove); });
    expect(inputOf(perform)).toEqual({ models: [{ model: 'vibeproxy/as4/claude-sonnet-5-5', effort: 'high' }] });
    await waitFor(() => expect(screen.getByTestId('model-brain-message').textContent).toContain('换不到'));
  });

  it('puts a decision model into the fast chain, and picks which brain model answers when they all fail', async () => {
    const { runtime, client } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-fast-add'));
    const option = await screen.findByTestId('model-fast-picker-add-option-decision-1');
    await act(async () => { fireEvent.click(option); });
    expect(inputOf(client.performUiAction)).toEqual({ chain: ['jev', 'decision-1'] });
    fireEvent.click(screen.getByTestId('model-fallback-picker-open'));
    const fallback = await screen.findByTestId('model-fallback-picker-option-vibeproxy/gemini-3.8-flash-high');
    await act(async () => { fireEvent.click(fallback); });
    expect(inputOf(client.performUiAction, 1)).toEqual({ chain: ['jev'], llmFallback: { model: 'vibeproxy/gemini-3.8-flash-high', effort: null } });
  });
});

describe('the model library', () => {
  it('opens the providers whose models are in use, folds the rest, and shows the rest of a long catalog on demand', () => {
    const { runtime } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    expect(screen.getByTestId('model-row-vibeproxy/as4/claude-sonnet-5-5').textContent).toContain('Primary');
    expect(screen.getByTestId('model-row-vibeproxy/as4/claude-haiku-5-5').textContent).toContain('Intuition fallback');
    expect(screen.queryByTestId('model-row-openai/gpt-5.5')).toBeNull();
    expect(screen.getByTestId('model-provider-sub-openai').textContent).toBe('OpenAI compatible · Key is set · 2 models · Latest 2026-10-02');
    // 服务商一行不写地址（地址在「设置」里）；按账号分组的写出来。
    expect(screen.getByTestId('model-provider-sub-vibeproxy').textContent).not.toContain('127.0.0.1');
    expect(screen.getByTestId('model-provider-sub-vibeproxy').textContent).toContain('Grouped by account');
    expect(screen.queryByTestId('model-row-vibeproxy/claude-3-7-sonnet')).toBeNull();
    fireEvent.click(screen.getByTestId('model-provider-more-vibeproxy'));
    expect(screen.getByTestId('model-row-vibeproxy/claude-3-7-sonnet')).toBeTruthy();
    fireEvent.click(screen.getByTestId('model-provider-toggle-openai'));
    expect(screen.getByTestId('model-row-openai/gpt-5.5')).toBeTruthy();
    fireEvent.click(screen.getByTestId('model-provider-toggle-vibeproxy'));
    expect(screen.queryByTestId('model-row-vibeproxy/as4/claude-sonnet-5-5')).toBeNull();
  });

  it('finds a model in any provider by search', () => {
    const { runtime } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.change(screen.getByTestId('model-library-search'), { target: { value: 'gpt-5' } });
    expect(screen.getByTestId('model-row-openai/gpt-5')).toBeTruthy();
    expect(screen.queryByTestId('model-provider-vibeproxy')).toBeNull();
  });

  it('connects a provider with a secret key field and clears the key from the form after saving', async () => {
    const { runtime, client } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-provider-add'));
    const key = screen.getByTestId('model-provider-key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(screen.getByTestId('model-provider-name'), { target: { value: 'Open AI' } });
    fireEvent.change(screen.getByTestId('model-provider-url'), { target: { value: 'https://api.openai.com/v1' } });
    fireEvent.click(screen.getByTestId('model-provider-save'));
    expect(screen.getByTestId('model-provider-message').textContent).toContain('The name can use only lowercase letters');
    expect(client.performUiAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('model-provider-name'), { target: { value: 'corp' } });
    fireEvent.change(screen.getByTestId('model-provider-url'), { target: { value: 'https://llm.corp.example.com/v1' } });
    fireEvent.change(key, { target: { value: 'sk-test-123' } });
    await act(async () => { fireEvent.click(screen.getByTestId('model-provider-save')); });
    expect(client.performUiAction).toHaveBeenCalledWith('model_settings', 'models', 'save_provider', {
      input: { name: 'corp', baseUrl: 'https://llm.corp.example.com/v1', api: 'openai-completions', apiKey: 'sk-test-123' },
    });
    expect(screen.queryByTestId('model-provider-form-new')).toBeNull();
  });

  it('will not delete a provider whose model is in the chain, and says why', () => {
    const { runtime } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-provider-edit-vibeproxy'));
    expect(screen.getByTestId('model-provider-delete').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('model-provider-form-vibeproxy').textContent).toContain('still uses vibeproxy/as4/claude-sonnet-5-5');
  });

  it('adds a decision model, tests a saved one, and deletes one outside the chain after an inline confirmation', async () => {
    const perform = vi.fn<Perform>(async (_type, _id, action) => ({
      target: { type: 'model_settings', id: 'models' }, action,
      result: action === 'test_fast_model' ? { ok: true, message: '决策模型可用', latencyMs: 410 } : { summary: 'ok', note: null, id: 'decision-2' },
    }));
    const { runtime } = modelRuntime(settings(), perform);
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-fast-add-entry'));
    fireEvent.change(screen.getByTestId('model-fast-name'), { target: { value: 'decision-2' } });
    fireEvent.change(screen.getByTestId('model-fast-url'), { target: { value: 'http://jev.corp.example.com' } });
    expect(screen.getByTestId('model-fast-plaintext').textContent).toContain('plain text');
    fireEvent.change(screen.getByTestId('model-fast-key'), { target: { value: 'tsk-2' } });
    await act(async () => { fireEvent.click(screen.getByTestId('model-fast-save')); });
    expect(inputOf(perform)).toEqual({ name: 'decision-2', baseUrl: 'http://jev.corp.example.com', model: 'jev-latest', apiKey: 'tsk-2' });

    fireEvent.click(screen.getByTestId('model-fast-row-decision-1'));
    await act(async () => { fireEvent.click(screen.getByTestId('model-fast-test')); });
    expect(inputOf(perform, 1)).toEqual({ id: 'decision-1' });
    expect(screen.getByTestId('model-fast-tested').textContent).toBe('Works · 410 ms');
    fireEvent.click(screen.getByTestId('model-fast-delete'));
    expect(perform).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(screen.getByTestId('model-fast-delete-yes')); });
    expect(perform.mock.calls[2]![2]).toBe('remove_fast_model');
  });

  // 2026-11-06：公司的 LLM 网关要自定义的鉴权头。新加时填头名就带上；不填不发这个字段（旧版 daemon 照样接受）。
  it('adds a decision model with a custom auth header, and refuses a header the request itself uses', async () => {
    const perform = vi.fn<Perform>(async (_type, _id, action) => ({
      target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null, id: 'decision-2' },
    }));
    const { runtime } = modelRuntime(settings(), perform);
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-fast-add-entry'));
    expect(screen.getByTestId('model-fast-auth-header-hint').textContent).toContain('x-gateway-key');
    fireEvent.change(screen.getByTestId('model-fast-name'), { target: { value: 'decision-2' } });
    fireEvent.change(screen.getByTestId('model-fast-url'), { target: { value: 'http://llm-gateway.example.com/gw' } });
    fireEvent.change(screen.getByTestId('model-fast-model'), { target: { value: 'decision-1' } });
    fireEvent.change(screen.getByTestId('model-fast-key'), { target: { value: 'gw-key' } });
    fireEvent.change(screen.getByTestId('model-fast-auth-header'), { target: { value: 'Content-Type' } });
    fireEvent.click(screen.getByTestId('model-fast-save'));
    expect(screen.getByTestId('model-fast-form-message').textContent).toContain('used by the request itself');
    expect(perform).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('model-fast-auth-header'), { target: { value: 'x-gateway-key' } });
    await act(async () => { fireEvent.click(screen.getByTestId('model-fast-save')); });
    expect(inputOf(perform)).toEqual({
      name: 'decision-2', baseUrl: 'http://llm-gateway.example.com/gw', model: 'decision-1', apiKey: 'gw-key', authHeader: 'x-gateway-key',
    });
  });

  it('shows the saved auth header when editing, and clearing it sends null to go back to Authorization', async () => {
    const perform = vi.fn<Perform>(async (_type, _id, action) => ({
      target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null, id: 'decision-1' },
    }));
    const base = settings();
    const withHeader = settings({}, { models: base.fast.models.map((entry) => (entry.id === 'decision-1' ? { ...entry, authHeader: 'x-gateway-key' } : entry)) });
    const { runtime } = modelRuntime(withHeader, perform);
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-fast-row-decision-1'));
    expect((screen.getByTestId('model-fast-auth-header') as HTMLInputElement).value).toBe('x-gateway-key');
    fireEvent.change(screen.getByTestId('model-fast-auth-header'), { target: { value: '' } });
    await act(async () => { fireEvent.click(screen.getByTestId('model-fast-save')); });
    expect(inputOf(perform)).toEqual({ id: 'decision-1', name: 'decision-1', baseUrl: 'https://jev.example.com', model: 'jev-latest', authHeader: null });
  });

  it('says the saved key stays with its host when a decision model moves', () => {
    const { runtime } = modelRuntime(settings());
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-fast-row-decision-1'));
    fireEvent.change(screen.getByTestId('model-fast-url'), { target: { value: 'https://jev2.example.com' } });
    expect(screen.getByTestId('model-fast-host-change').textContent).toContain('The saved key belongs to jev.example.com');
    expect(screen.getByTestId('model-fast-data-note').textContent).toContain('to jev.example.com');
  });
});

// Lead 模型分组（用户 2026-11-05，原型 docs/prototypes/model-grouping 的设置页）。
const magpie: ModelProvider = {
  name: 'magpie', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', keySet: true, keySource: 'settings', keyHost: 'magpie.example.com',
  problem: null, accountPrefix: null, accountPrefixActive: false, capabilities: 'auto', catalog: 'plain',
  models: [
    model('auto/deepseek-flash', day(3), {}, 'magpie'),
    model('deepseek/deepseek-flash', day(2), {}, 'magpie'),
    { ...model('bailian/qwen-max', day(1), {}, 'magpie'), source: 'bailian-token-plan' },
  ].map((entry) => ({ ...entry, source: entry.source === 'magpie' ? 'deepseek' : entry.source })),
};

describe('grouping by account and channel', () => {
  const groupTitles = (dto: ModelSettingsDto) => brainPickerGroups(dto, { search: '', showAll: new Set(), slot: -1, selected: null, onPick: () => {} })
    .map((group) => [group.title, group.options.map((option) => option.key)]);

  it('titles the dropdown sections provider · group · channel when there is more than one provider', () => {
    expect(groupTitles(settings({ providers: [vibeproxy, magpie] }))).toEqual([
      ['vibeproxy · as4 · anthropic', ['vibeproxy/as4/claude-sonnet-5-5', 'vibeproxy/as4/claude-haiku-5-5']],
      // 每个服务商先露最新的 4 个和在用的：claude-sonnet-5 和更旧的收在「显示其余」里。
      ['vibeproxy · anthropic', ['vibeproxy/claude-sonnet-5-5']],
      ['vibeproxy · antigravity', ['vibeproxy/gemini-3.8-flash-high']],
      ['magpie · deepseek', ['magpie/auto/deepseek-flash', 'magpie/deepseek/deepseek-flash']],
      ['magpie · bailian-token-plan', ['magpie/bailian/qwen-max']],
    ]);
    // 只有一个服务商：标题不写它。
    expect(groupTitles(settings({ providers: [vibeproxy] })).map(([title]) => title))
      .toEqual(['as4 · anthropic', 'anthropic', 'antigravity']);
  });

  it('names a model with its account only when the daemon says the prefix is an account', () => {
    const index = (provider: ModelProvider, id: string) => ({ provider, model: provider.models.find((entry) => entry.id === id)! });
    expect(brainModelName('vibeproxy/as4/claude-sonnet-5-5', index(vibeproxy, 'as4/claude-sonnet-5-5'))).toBe('Claude Sonnet 5.5 · as4');
    // magpie：前缀不是账号，没有显示名时写完整的 id，两个同名模型分得开。
    expect(brainModelName('magpie/auto/deepseek-flash', index(magpie, 'auto/deepseek-flash'))).toBe('auto/deepseek-flash');
    expect(brainModelName('magpie/deepseek/deepseek-flash', index(magpie, 'deepseek/deepseek-flash'))).toBe('deepseek/deepseek-flash');
  });

  it('uses the same sections in the brain dropdown, the intuition fallback dropdown and the library', async () => {
    const { runtime } = modelRuntime(settings({ providers: [vibeproxy, magpie] }));
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-brain-picker-0-open'));
    expect(await screen.findByTestId('model-brain-picker-0-group-vibeproxy|as4|anthropic')).toBeTruthy();
    expect(screen.getByTestId('model-brain-picker-0-group-magpie||deepseek').textContent).toContain('magpie · deepseek');
    fireEvent.click(screen.getByTestId('model-brain-picker-0-open'));
    fireEvent.click(screen.getByTestId('model-fallback-picker-open'));
    expect(await screen.findByTestId('model-fallback-picker-group-magpie||bailian-token-plan')).toBeTruthy();
    // 模型库：外层是服务商，里面的分段标题不再写服务商。
    expect(screen.getByTestId('model-section-vibeproxy|as4|anthropic').textContent).toContain('as4 · anthropic');
  });

  it('changes accountPrefix and capabilities in Advanced and saves them with save_provider', async () => {
    const { runtime, client } = modelRuntime(settings({ providers: [vibeproxy, magpie] }));
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-provider-edit-magpie'));
    expect(screen.getByTestId('model-provider-advanced').textContent).toContain('Prefix is account: no · capabilities: auto');
    fireEvent.click(screen.getByTestId('model-provider-advanced-toggle'));
    expect(screen.getByTestId('model-provider-advanced').textContent).toContain('only the plain catalog');
    fireEvent.click(screen.getByTestId('model-provider-prefix'));
    expect(screen.getByTestId('model-provider-advanced').textContent).toContain('You set this to "yes"');
    fireEvent.click(screen.getByText('Configuration'));
    await act(async () => { fireEvent.click(screen.getByTestId('model-provider-save')); });
    expect(inputOf(client.performUiAction)).toEqual({
      name: 'magpie', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', accountPrefix: true, capabilities: 'config',
    });
  });

  it('restores the default accountPrefix, and sends nothing extra when Advanced did not change', async () => {
    const declared = { ...vibeproxy, accountPrefix: false, accountPrefixActive: false };
    const { runtime, client } = modelRuntime(settings({ providers: [declared] }));
    renderWithRuntime(<ModelSection />, runtime);
    fireEvent.click(screen.getByTestId('model-provider-edit-vibeproxy'));
    await act(async () => { fireEvent.click(screen.getByTestId('model-provider-save')); });
    expect(inputOf(client.performUiAction)).toEqual({ name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions' });
    fireEvent.click(screen.getByTestId('model-provider-advanced-toggle'));
    fireEvent.click(screen.getByTestId('model-provider-prefix-default'));
    expect(screen.getByTestId('model-provider-advanced').textContent).toContain('returns the detailed catalog');
    await act(async () => { fireEvent.click(screen.getByTestId('model-provider-save')); });
    expect(inputOf(client.performUiAction, 1)).toMatchObject({ accountPrefix: null });
  });
});

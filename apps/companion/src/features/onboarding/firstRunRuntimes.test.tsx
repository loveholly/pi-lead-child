// @vitest-environment happy-dom
// 首次启动引导的第二步：选执行器（docs/desktop/macos-desktop-design.md 第 5.3 节，P0-6）走一遍。
// 第一步接好大脑以后出现；数据来自设置 → 执行器的同一个接口（getRuntimeSettings），已安装的和 pi 缺省开着；
// 「保存并继续」只拨变了的开关，用设置页同一个操作（updateRuntimeSettings）；「跳过」什么都不改；只出现一次；
// 「重新检测」重新取这份设置；大脑本来就能用的人不会看到它。
import type { BrainModel, ModelProvider, ModelSettingsDto, RuntimeSettingsDto, SetupStatus } from '@pi-lead-child/protocol';
import { SETUP_ITEM_KEYS } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import RootTabs from '../../navigation/RootTabs.web';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { resetFirstRunMemoryForTests } from './firstRunMemory';

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
  problem: null, models: [model('claude-sonnet-5-5')],
};

function modelSettings(providers: ModelProvider[]): ModelSettingsDto {
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

// Codex 装了，Claude Code 没找到，pi 是内置的。
const FIRST_LOOK: RuntimeSettingsDto = {
  runtimes: [
    { id: 'codex', label: 'Codex', enabled: true, installed: true, canReview: true },
    { id: 'claude', label: 'Claude Code', enabled: true, installed: false, canReview: false },
    { id: 'pi', label: 'pi', enabled: true, installed: true, canReview: false },
  ],
  reviewer: { id: 'codex', canReview: true },
};

type Perform = (type: string, id: string, action: string, request: unknown) => Promise<{ target: unknown; action: string; result: unknown }>;

function onboardingRuntime(options: { brain: boolean; runtimeSettings?: RuntimeSettingsDto[] }) {
  const state = { providers: options.brain ? [anthropic] : [] as ModelProvider[], brain: options.brain };
  // 每次 GET 回下一份（重新检测时 daemon 重新找可执行文件），用完了一直回最后一份。
  const answers = [...(options.runtimeSettings ?? [FIRST_LOOK])];
  let current = answers[0]!;
  const perform = vi.fn<Perform>(async (_type, _id, action) => {
    if (action === 'save_provider') state.providers = [anthropic];
    if (action === 'set_brain_chain') state.brain = true;
    return { target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null } };
  });
  const client = {
    getModelSettings: vi.fn(async () => modelSettings(state.providers)),
    getSetup: vi.fn(async () => setup(state.brain)),
    performUiAction: perform,
    getRuntimeSettings: vi.fn(async () => {
      current = answers.length > 1 ? answers.shift()! : answers[0]!;
      return current;
    }),
    updateRuntimeSettings: vi.fn(async (request: { runtime: string; enabled: boolean }) => {
      current = { ...current, runtimes: current.runtimes.map((entry) => (entry.id === request.runtime ? { ...entry, enabled: request.enabled } : entry)) };
      return current;
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  runtime.control.setState((existing) => ({
    phase: 'ready', connectionState: 'connected', modelSettings: modelSettings(state.providers), setup: setup(state.brain),
    resourceState: { ...existing.resourceState, 'model-settings': ready, setup: ready },
  }));
  return { runtime, client };
}

// 第一步：接入服务商、选模型、上线。
async function finishBrainStep() {
  fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-ant-test' } });
  fireEvent.click(screen.getByTestId('first-run-connect'));
  await waitFor(() => expect(screen.getByTestId('first-run-go')).toBeTruthy());
  fireEvent.click(screen.getByTestId('first-run-go'));
  await waitFor(() => expect(screen.getByTestId('first-run-runtimes-title')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.localStorage.clear();
  resetFirstRunMemoryForTests();
  setViewportWidth(1280);
});

// 第一个用例要第一次渲染 RootTabs，冷启动时这台机器上要 5–8 秒，超过缺省的 5 秒（改这一步之前也一样）。
describe('the runtime step of the first-run guide', { timeout: 30_000 }, () => {
  it('follows the brain step, checks what is installed, and saves only the switches that changed', async () => {
    const { runtime, client } = onboardingRuntime({ brain: false });
    renderWithRuntime(<RootTabs />, runtime);
    await finishBrainStep();
    expect(screen.getByTestId('first-run-runtimes-title').textContent).toBe('Choose the runtimes for Paimon');
    await waitFor(() => expect(screen.getByTestId('first-run-runtime-codex')).toBeTruthy());

    // 已安装的开着；没找到的关着，给安装说明；pi 内置，开着。
    expect(screen.getByTestId('first-run-runtime-switch-codex').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('first-run-runtime-codex').textContent).toContain('Installed');
    expect(screen.getByTestId('first-run-runtime-switch-claude').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('first-run-runtime-claude').textContent).toContain('Not found');
    expect(screen.getByTestId('first-run-runtime-install-claude').textContent).toBe('How to install Claude Code');
    expect(screen.getByTestId('first-run-runtime-switch-pi').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('first-run-runtime-pi').textContent).toContain('Built in. It uses the model provider that you just set up.');

    fireEvent.click(screen.getByTestId('first-run-runtime-switch-codex'));
    await act(async () => { fireEvent.click(screen.getByTestId('first-run-runtimes-save')); });
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    // 没勾的 Codex 和 Claude Code 停用；pi 没变，不发请求。
    expect(client.updateRuntimeSettings.mock.calls.map((call) => call[0])).toEqual([
      { runtime: 'codex', enabled: false }, { runtime: 'claude', enabled: false },
    ]);

    // 只出现一次：本机记下了，再打开 App、大脑又坏了再接好也不再出现。
    cleanup();
    resetFirstRunMemoryForTests();
    const again = onboardingRuntime({ brain: false });
    renderWithRuntime(<RootTabs />, again.runtime);
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-ant-test' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-go')).toBeTruthy());
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    expect(screen.queryByTestId('first-run-runtimes')).toBeNull();
  });

  it('changes nothing when the user skips', async () => {
    const { runtime, client } = onboardingRuntime({ brain: false });
    renderWithRuntime(<RootTabs />, runtime);
    await finishBrainStep();
    await waitFor(() => expect(screen.getByTestId('first-run-runtime-codex')).toBeTruthy());
    fireEvent.click(screen.getByTestId('first-run-runtime-switch-pi'));
    fireEvent.click(screen.getByTestId('first-run-runtimes-skip'));
    expect(screen.getByTestId('app-slot')).toBeTruthy();
    expect(client.updateRuntimeSettings).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('plc.firstRunRuntimesDone')).toBe('1');
  });

  it('checks again by reading the runtime settings again, and checks a runtime that is now installed', async () => {
    const installed: RuntimeSettingsDto = { ...FIRST_LOOK, runtimes: FIRST_LOOK.runtimes.map((entry) => ({ ...entry, installed: true })) };
    const { runtime, client } = onboardingRuntime({ brain: false, runtimeSettings: [FIRST_LOOK, installed] });
    renderWithRuntime(<RootTabs />, runtime);
    await finishBrainStep();
    await waitFor(() => expect(screen.getByTestId('first-run-runtime-install-claude')).toBeTruthy());
    const reads = client.getRuntimeSettings.mock.calls.length;

    await act(async () => { fireEvent.click(screen.getByTestId('first-run-runtimes-recheck')); });
    await waitFor(() => expect(screen.getByTestId('first-run-runtime-switch-claude').getAttribute('aria-checked')).toBe('true'));
    expect(client.getRuntimeSettings.mock.calls.length).toBe(reads + 1);
    expect(screen.getByTestId('first-run-runtime-claude').textContent).toContain('Installed');
    expect(screen.queryByTestId('first-run-runtime-install-claude')).toBeNull();
    expect(screen.queryByTestId('first-run-runtimes-recheck')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId('first-run-runtimes-save')); });
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
    expect(client.updateRuntimeSettings).not.toHaveBeenCalled();
  });

  it('keeps the page and shows the reason when saving fails', async () => {
    const { runtime, client } = onboardingRuntime({ brain: false });
    client.updateRuntimeSettings.mockRejectedValueOnce(new Error('daemon went away'));
    renderWithRuntime(<RootTabs />, runtime);
    await finishBrainStep();
    await waitFor(() => expect(screen.getByTestId('first-run-runtime-codex')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('first-run-runtimes-save')); });
    await waitFor(() => expect(screen.getByTestId('first-run-runtimes-problem').textContent).toContain('daemon went away'));
    expect(screen.queryByTestId('app-slot')).toBeNull();
    expect(globalThis.localStorage.getItem('plc.firstRunRuntimesDone')).toBeNull();
  });

  it('does not show up when the brain already works', () => {
    const { runtime, client } = onboardingRuntime({ brain: true });
    renderWithRuntime(<RootTabs />, runtime);
    expect(screen.getByTestId('app-slot')).toBeTruthy();
    expect(screen.queryByTestId('first-run-runtimes')).toBeNull();
    expect(client.getRuntimeSettings).not.toHaveBeenCalled();
  });

  it('does not block the app when the daemon has no runtime settings', async () => {
    const { runtime, client } = onboardingRuntime({ brain: false });
    (client as { getRuntimeSettings?: unknown }).getRuntimeSettings = undefined;
    renderWithRuntime(<RootTabs />, runtime);
    fireEvent.change(screen.getByTestId('first-run-api-key'), { target: { value: 'sk-ant-test' } });
    fireEvent.click(screen.getByTestId('first-run-connect'));
    await waitFor(() => expect(screen.getByTestId('first-run-go')).toBeTruthy());
    fireEvent.click(screen.getByTestId('first-run-go'));
    await waitFor(() => expect(screen.getByTestId('app-slot')).toBeTruthy());
  });
});

// 首次启动页的纯函数（2026-10-30，.scratch/onboarding/spec.md）：首次启动时还没有任何服务商，第一步按预设拼出接入请求，
// 第二步从读到的目录里推荐一个模型。
import type { BrainModel, ModelProvider, RuntimeSettingsDto } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import {
  customProviderName, firstRunModelList, firstRunProviderFacts, firstRunProviderRequest, firstRunRuntimeRequests, firstRunRuntimeRows,
  firstRunStep, modelPrefixes, prefixAnswerRequest, prefixQuestion, recommendedBrainModel, type FirstRunStepInput,
} from './firstRunModel';

function model(id: string, extra: Partial<BrainModel> = {}): BrainModel {
  return {
    model: `anthropic/${id}`, id, name: null, image: true, contextWindow: 1_000_000, efforts: [], defaultEffort: null,
    released: null, blockedUntil: null, ...extra,
  };
}

function provider(models: BrainModel[], problem: string | null = null): ModelProvider {
  return { name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', keySet: true, keySource: 'settings', keyHost: 'api.anthropic.com', models, problem };
}

describe('the provider request', () => {
  it('fills the preset address and protocol and needs only a key', () => {
    expect(firstRunProviderRequest({ preset: 'anthropic', apiKey: ' sk-ant ', baseUrl: '', api: 'openai-completions' }, [], 'en')).toEqual({
      ok: true, input: { name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: 'sk-ant' },
    });
    expect(firstRunProviderRequest({ preset: 'google', apiKey: 'g', baseUrl: '', api: 'openai-completions' }, [], 'en')).toMatchObject({
      ok: true, input: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions' },
    });
    expect(firstRunProviderRequest({ preset: 'openai', apiKey: '  ', baseUrl: '', api: 'openai-completions' }, [], 'en')).toEqual({
      ok: false, problem: 'Enter the API key for OpenAI.',
    });
    expect(firstRunProviderRequest({ preset: 'openai', apiKey: '  ', baseUrl: '', api: 'openai-completions' }, [], 'zh')).toEqual({
      ok: false, problem: '填上 OpenAI 的 API key。',
    });
  });

  it('takes the address and protocol for another service, with an optional key', () => {
    expect(firstRunProviderRequest({ preset: 'custom', apiKey: '', baseUrl: 'http://127.0.0.1:8317/v1/', api: 'openai-completions' }, [], 'en')).toEqual({
      ok: true, input: { name: 'local-8317', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions' },
    });
    expect(firstRunProviderRequest({ preset: 'custom', apiKey: '', baseUrl: 'ftp://x', api: 'openai-completions' }, [], 'en')).toMatchObject({ ok: false });
  });

  it('names another service after its host, avoiding names already taken', () => {
    expect(customProviderName('https://api.openrouter.ai/v1', [])).toBe('openrouter');
    expect(customProviderName('https://gateway.corp.example.com/v1', ['example'])).toBe('example-2');
  });

  // 连接失败后再点「连接」：同一个地址的服务商已经在了，覆盖它，不再新增 deepseek-2、deepseek-3……
  it('reuses the name of a provider already at the same address, so a retry overwrites it', () => {
    const custom = (baseUrl: string) => ({ preset: 'custom' as const, apiKey: 'sk-test', baseUrl, api: 'openai-completions' as const });
    const existing = [{ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }];
    expect(firstRunProviderRequest(custom('https://api.deepseek.com/v1/'), existing, 'en')).toEqual({
      ok: true, input: { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', apiKey: 'sk-test' },
    });
    // 按规范化后的地址比：主机名大小写不算不同。已经堆起来的重复项不清理，用第一个。
    const piled = [...existing, { name: 'deepseek-2', baseUrl: 'https://api.deepseek.com/v1' }];
    expect(firstRunProviderRequest(custom('https://API.DeepSeek.com/v1'), piled, 'en')).toMatchObject({ ok: true, input: { name: 'deepseek' } });
    // 地址不一样的照旧另起一个名字。
    expect(firstRunProviderRequest(custom('https://api.deepseek.com/v2'), existing, 'en')).toMatchObject({ ok: true, input: { name: 'deepseek-2' } });
  });
});

describe('the model choice', () => {
  it('recommends the newest model that is not a small one, and lists it first', () => {
    const models = [model('claude-haiku-5-5'), model('claude-sonnet-5-5'), model('claude-opus-5-5')];
    expect(recommendedBrainModel(models)?.id).toBe('claude-sonnet-5-5');
    expect(firstRunModelList(models, 2).map((entry) => entry.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(recommendedBrainModel([model('gpt-mini')])?.id).toBe('gpt-mini');
    expect(recommendedBrainModel([])).toBeNull();
  });

  it('stays on step one with the reason when the catalog is empty or failed', () => {
    expect(firstRunProviderFacts(null, 'en')).toMatchObject({ connected: false, problem: null });
    expect(firstRunProviderFacts(provider([], 'GET https://api.anthropic.com/v1/models failed: 401'), 'en')).toMatchObject({
      connected: false, problem: 'GET https://api.anthropic.com/v1/models failed: 401',
    });
    expect(firstRunProviderFacts(provider([]), 'en')).toMatchObject({
      connected: false, problem: 'The catalog of anthropic has no models. Check the address and the API format.',
    });
    expect(firstRunProviderFacts(provider([]), 'zh')).toMatchObject({ connected: false, problem: 'anthropic 的目录里一个模型也没有。检查地址和接口格式。' });
    expect(firstRunProviderFacts(provider([model('claude-sonnet-5-5')]), 'en')).toMatchObject({ connected: true, modelCount: 1, problem: null });
  });
});

// 第二步：选执行器（docs/desktop/macos-desktop-design.md 第 5.3 节，P0-6）。
const settings: RuntimeSettingsDto = {
  runtimes: [
    { id: 'codex', label: 'Codex', enabled: true, installed: true, canReview: true },
    { id: 'claude', label: 'Claude Code', enabled: true, installed: false, canReview: false },
    { id: 'pi', label: 'pi', enabled: true, installed: false, canReview: false },
  ],
  reviewer: { id: 'codex', canReview: true },
};

describe('the first-run step', () => {
  const base: FirstRunStepInput = { connected: true, brainReady: false, brainSkipped: false, brainShown: false, runtimesDone: false };

  it('shows the brain step while the brain does not work, unless the user looked around first', () => {
    expect(firstRunStep(base)).toBe('brain');
    expect(firstRunStep({ ...base, connected: false })).toBeNull();
    expect(firstRunStep({ ...base, brainSkipped: true })).toBeNull();
  });

  it('shows the runtimes step once, only after the brain step was finished on this page', () => {
    expect(firstRunStep({ ...base, brainReady: true, brainShown: true })).toBe('runtimes');
    // 大脑本来就能用（老用户、已经配过的人）：不出现。
    expect(firstRunStep({ ...base, brainReady: true })).toBeNull();
    // 做过或跳过一次以后不再出现，大脑又坏了再接好也一样。
    expect(firstRunStep({ ...base, brainReady: true, brainShown: true, runtimesDone: true })).toBeNull();
    // 跳过了第一步、后来在设置页接好大脑：不突然弹出第二步。
    expect(firstRunStep({ ...base, brainReady: true, brainShown: true, brainSkipped: true })).toBeNull();
  });
});

describe('the runtime choice', () => {
  it('checks the installed runtimes and pi, and gives an install link for the ones not found', () => {
    expect(firstRunRuntimeRows(settings, {})).toEqual([
      { id: 'codex', label: 'Codex', status: 'installed', checked: true, installUrl: null },
      { id: 'claude', label: 'Claude Code', status: 'not_found', checked: false, installUrl: 'https://code.claude.com/docs/en/setup' },
      { id: 'pi', label: 'pi', status: 'built_in', checked: true, installUrl: null },
    ]);
    expect(firstRunRuntimeRows(null, {})).toEqual([]);
  });

  it('checks a runtime that a recheck found, unless the user turned it off', () => {
    const found: RuntimeSettingsDto = { ...settings, runtimes: settings.runtimes.map((entry) => ({ ...entry, installed: true })) };
    expect(firstRunRuntimeRows(found, {}).find((row) => row.id === 'claude')).toMatchObject({ status: 'installed', checked: true, installUrl: null });
    expect(firstRunRuntimeRows(found, { claude: false }).find((row) => row.id === 'claude')?.checked).toBe(false);
  });

  it('turns off what is not checked and turns on what is checked, and sends nothing that does not change', () => {
    expect(firstRunRuntimeRequests(settings, {})).toEqual([{ runtime: 'claude', enabled: false }]);
    expect(firstRunRuntimeRequests(settings, { claude: true })).toEqual([]);
    expect(firstRunRuntimeRequests(settings, { codex: false, pi: false })).toEqual([
      { runtime: 'codex', enabled: false }, { runtime: 'claude', enabled: false }, { runtime: 'pi', enabled: false },
    ]);
    const claudeOff: RuntimeSettingsDto = {
      ...settings, runtimes: settings.runtimes.map((entry) => (entry.id === 'claude' ? { ...entry, enabled: false } : entry)),
    };
    expect(firstRunRuntimeRequests(claudeOff, {})).toEqual([]);
    expect(firstRunRuntimeRequests(claudeOff, { claude: true })).toEqual([{ runtime: 'claude', enabled: true }]);
    expect(firstRunRuntimeRequests(null, {})).toEqual([]);
  });
});

// Lead 模型分组（用户 2026-11-05）：vibeproxy 预设和「前缀是账号吗」。
describe('the vibeproxy preset and the prefix question', () => {
  it('connects vibeproxy at the local port by default, takes another address, and writes accountPrefix: true', () => {
    expect(firstRunProviderRequest({ preset: 'vibeproxy', apiKey: '', baseUrl: '', api: 'openai-completions' }, [], 'en')).toEqual({
      ok: true, input: { name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', accountPrefix: true },
    });
    expect(firstRunProviderRequest({ preset: 'vibeproxy', apiKey: 'k', baseUrl: 'http://127.0.0.1:9000/v1/', api: 'openai-responses' }, [], 'en'))
      .toEqual({ ok: true, input: { name: 'vibeproxy', baseUrl: 'http://127.0.0.1:9000/v1', api: 'openai-completions', apiKey: 'k', accountPrefix: true } });
    expect(firstRunProviderRequest({ preset: 'vibeproxy', apiKey: '', baseUrl: 'localhost:8317', api: 'openai-completions' }, [], 'en').ok).toBe(false);
  });

  it('asks only when ids have a slash and the catalog is not detailed, with the two first prefixes of this service', () => {
    const plain = (ids: string[], catalog: ModelProvider['catalog']): ModelProvider => ({
      ...provider(ids.map((id) => model(id))), name: 'example', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', catalog,
    });
    const magpie = plain(['auto/deepseek-flash', 'deepseek/deepseek-v4', 'auto/qwen', 'bailian/qwen-max'], 'plain');
    expect(modelPrefixes(magpie.models)).toEqual(['auto', 'deepseek', 'bailian']);
    expect(prefixQuestion(magpie, 'custom')).toEqual(['auto', 'deepseek']);
    expect(prefixQuestion(plain(['as4/claude-opus-5-5'], 'detailed'), 'custom')).toBeNull();
    expect(prefixQuestion(plain(['gpt-5.5'], 'plain'), 'custom')).toBeNull();
    expect(prefixQuestion(magpie, 'vibeproxy')).toBeNull();
    // 旧 daemon 不给 catalog：存不了 accountPrefix，不问。
    expect(prefixQuestion({ ...magpie, catalog: undefined }, 'custom')).toBeNull();
    expect(prefixAnswerRequest(magpie, true)).toEqual({
      name: 'example', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', accountPrefix: true,
    });
    expect(prefixAnswerRequest(magpie, false).accountPrefix).toBe(false);
  });
});

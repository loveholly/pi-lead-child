// 首次启动页的纯函数（2026-10-30，.scratch/onboarding/spec.md）：首次启动时还没有任何服务商，第一步按预设拼出接入请求，
// 第二步从读到的目录里推荐一个模型。
import type { BrainModel, ModelProvider } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import {
  customProviderName, firstRunModelList, firstRunProviderFacts, firstRunProviderRequest, recommendedBrainModel,
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
    expect(firstRunProviderRequest({ preset: 'anthropic', apiKey: ' sk-ant ', baseUrl: '', api: 'openai-completions' }, [])).toEqual({
      ok: true, input: { name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: 'sk-ant' },
    });
    expect(firstRunProviderRequest({ preset: 'google', apiKey: 'g', baseUrl: '', api: 'openai-completions' }, [])).toMatchObject({
      ok: true, input: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions' },
    });
    expect(firstRunProviderRequest({ preset: 'openai', apiKey: '  ', baseUrl: '', api: 'openai-completions' }, [])).toEqual({
      ok: false, problem: '填上 OpenAI 的 API key。',
    });
  });

  it('takes the address and protocol for another service, with an optional key', () => {
    expect(firstRunProviderRequest({ preset: 'custom', apiKey: '', baseUrl: 'http://127.0.0.1:8317/v1/', api: 'openai-completions' }, [])).toEqual({
      ok: true, input: { name: 'local-8317', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions' },
    });
    expect(firstRunProviderRequest({ preset: 'custom', apiKey: '', baseUrl: 'ftp://x', api: 'openai-completions' }, [])).toMatchObject({ ok: false });
  });

  it('names another service after its host, avoiding names already taken', () => {
    expect(customProviderName('https://api.openrouter.ai/v1', [])).toBe('openrouter');
    expect(customProviderName('https://gateway.corp.example.com/v1', ['example'])).toBe('example-2');
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
    expect(firstRunProviderFacts(null)).toMatchObject({ connected: false, problem: null });
    expect(firstRunProviderFacts(provider([], 'GET https://api.anthropic.com/v1/models failed: 401'))).toMatchObject({
      connected: false, problem: 'GET https://api.anthropic.com/v1/models failed: 401',
    });
    expect(firstRunProviderFacts(provider([]))).toMatchObject({ connected: false, problem: 'anthropic 的目录里一个模型也没有。检查地址和接口格式。' });
    expect(firstRunProviderFacts(provider([model('claude-sonnet-5-5')]))).toMatchObject({ connected: true, modelCount: 1, problem: null });
  });
});

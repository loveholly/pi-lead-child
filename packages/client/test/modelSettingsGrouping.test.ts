// Lead 模型分组（2026-11-05）：BrainModel 加了 group、source，ModelProvider 加了「高级」的字段。字段都是可选的；
// 旧版 Companion 的严格 schema 不认它们，所以网关只在客户端带 grouping=1 时才给（withoutModelGrouping）。
import { describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import {
  ModelSettingsResponseSchema, withoutModelGrouping, type BindingDto, type ModelSettingsDto,
} from '@pi-lead-child/protocol';

import { createJsonCredentialStore, type KeyValueStorage } from '../src/credentialStore.ts';
import { ControlPlaneClient } from '../src/controlPlaneClient.ts';
import { LegacyModelSettingsResponseSchema } from './legacyModelSettingsSchema.ts';

class MemoryKeyValueStorage implements KeyValueStorage {
  values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

const binding: BindingDto = { id: 7, kind: 'companion', name: 'phone', scopes: ['chat', 'tickets:view'] };

const model = (id: string, group: string | null, source: string | null) => ({
  model: `vibeproxy/${id}`, id, name: null, image: true, contextWindow: null, efforts: [], defaultEffort: null, released: null,
  blockedUntil: null, group, source,
});

const grouped: ModelSettingsDto = {
  brain: {
    chain: [{ model: 'vibeproxy/as1/claude-opus-5-5', effort: null }],
    current: { model: 'vibeproxy/as1/claude-opus-5-5', effort: null },
    providers: [{
      name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', keySet: false, keySource: null, keyHost: null,
      models: [model('as1/claude-opus-5-5', 'as1', 'anthropic'), model('gemini-3-flash', null, 'antigravity')],
      problem: null, accountPrefix: null, accountPrefixActive: true, capabilities: 'auto', catalog: 'detailed',
    }],
  },
  fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
  maxBackups: 3,
};

describe('model settings with the grouping fields', () => {
  it('lets an old client accept what the gateway sends without grouping=1', () => {
    // 旧版的严格 schema 拒收带分组字段的整份：所以网关要去掉它们。
    expect(Value.Check(LegacyModelSettingsResponseSchema, { modelSettings: grouped })).toBe(false);
    expect(Value.Check(LegacyModelSettingsResponseSchema, { modelSettings: withoutModelGrouping(grouped) })).toBe(true);
    // 新版的 schema 两种都接受：字段是可选的。
    expect(Value.Check(ModelSettingsResponseSchema, { modelSettings: grouped })).toBe(true);
    expect(Value.Check(ModelSettingsResponseSchema, { modelSettings: withoutModelGrouping(grouped) })).toBe(true);
  });

  // 直觉的鉴权头（2026-11-06）也只给带 grouping=1 的客户端。
  it('drops the fast model auth header for an old client', () => {
    const withHeader: ModelSettingsDto = {
      ...grouped,
      fast: {
        ...grouped.fast,
        models: [{
          id: 'gw', name: 'decision-1', baseUrl: 'http://llm-gateway.example.com/gw', model: 'decision-1',
          apiKeySet: true, apiKeySource: 'settings', apiKeyHost: 'llm-gateway.example.com', problem: null, authHeader: 'x-gateway-key',
        }],
      },
    };
    expect(Value.Check(ModelSettingsResponseSchema, { modelSettings: withHeader })).toBe(true);
    expect(Value.Check(LegacyModelSettingsResponseSchema, { modelSettings: withHeader })).toBe(false);
    const legacy = withoutModelGrouping(withHeader);
    expect(legacy.fast.models[0]).not.toHaveProperty('authHeader');
    expect(Value.Check(LegacyModelSettingsResponseSchema, { modelSettings: legacy })).toBe(true);
  });

  it('asks for the grouping fields and reads them', async () => {
    const credentials = createJsonCredentialStore(new MemoryKeyValueStorage());
    await credentials.save({ baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 });
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ modelSettings: grouped }), { headers: { 'content-type': 'application/json' } });
    });
    const client = new ControlPlaneClient({ fetch: fetcher, credentials });
    const settings = await client.getModelSettings();
    expect(asked).toEqual(['/v1/models/settings?grouping=1']);
    expect(settings.brain.providers[0]?.models.map((entry) => entry.group)).toEqual(['as1', null]);
  });
});

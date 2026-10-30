import type { LeadModelOption } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { effortForModel, groupLeadModels, leadModelLabel } from './leadModelGroups';

function option(model: string, source: string | null, efforts: string[] = []): LeadModelOption {
  const provider = model.slice(0, model.indexOf('/'));
  const id = model.slice(provider.length + 1);
  const slash = id.indexOf('/');
  return {
    model, provider, id, prefix: slash > 0 ? id.slice(0, slash) : null, source, name: null,
    image: true, efforts, defaultEffort: null, blockedUntil: null,
  };
}

// 2026-10-26：用户有两个 Anthropic 账号，在 vibeproxy 里加了前缀 as1、as4。选模型时要分得清。
describe('groupLeadModels', () => {
  it('puts each account prefix in its own group first, then the pooled and other sources', () => {
    const groups = groupLeadModels([
      option('vibeproxy/claude-sonnet-5', 'anthropic'),
      option('vibeproxy/gemini-3.8-flash-high', 'antigravity'),
      option('vibeproxy/as4/claude-sonnet-5', 'anthropic'),
      option('vibeproxy/as1/claude-sonnet-5', 'anthropic'),
      option('vibeproxy/as1/claude-opus-5-5', 'anthropic'),
      option('vibeproxy/as10/claude-opus-5-5', 'anthropic'),
    ]);
    expect(groups.map((group) => [group.title, group.models.map((model) => model.id)])).toEqual([
      ['as1 · Anthropic', ['as1/claude-sonnet-5', 'as1/claude-opus-5-5']],
      ['as4 · Anthropic', ['as4/claude-sonnet-5']],
      ['as10 · Anthropic', ['as10/claude-opus-5-5']],
      ['Anthropic · 不指定账号', ['claude-sonnet-5']],
      ['Antigravity', ['gemini-3.8-flash-high']],
    ]);
  });

  it('names the provider when there is more than one, and does not call a lone source pooled', () => {
    const groups = groupLeadModels([
      option('vibeproxy/claude-sonnet-5', 'anthropic'),
      option('openrouter/gpt-6', null),
    ]);
    expect(groups.map((group) => group.title)).toEqual(['vibeproxy · Anthropic', 'openrouter · 其他']);
  });
});

describe('leadModelLabel', () => {
  it('shows the bare model id and the effort, without the provider or the account prefix', () => {
    expect(leadModelLabel('vibeproxy/as4/claude-sonnet-5(high)')).toEqual({ id: 'claude-sonnet-5', effort: 'high' });
    expect(leadModelLabel('vibeproxy/gemini-3.8-flash-high')).toEqual({ id: 'gemini-3.8-flash-high', effort: null });
  });
});

describe('effortForModel', () => {
  it('keeps the effort when the new model supports it, and uses the model default otherwise', () => {
    expect(effortForModel(option('vibeproxy/as4/claude-sonnet-5', 'anthropic', ['low', 'high']), 'high')).toBe('high');
    expect(effortForModel(option('vibeproxy/gemini-3.8-flash-high', 'antigravity'), 'high')).toBeNull();
  });
});

// Lead 的模型选择（2026-10-26）：目录里的模型按来源分组，用户据此分清两个 Anthropic 账号（as1、as4）。
//   · 带账号前缀的模型（vibeproxy/as4/claude-sonnet-5）按前缀各成一组，排在前面，按前缀排序；
//   · 不带前缀的按上游成组（Anthropic、Antigravity），按在目录里第一次出现的先后；
//   · 同一个上游已经有带前缀的组时，不带前缀的那一组写「不指定账号」：vibeproxy 在这几个账号之间轮流用；
//   · 配了不止一个 provider 时，组名前面写 provider。
import { parseLeadModelSpec, type LeadModelOption } from '@pi-lead-child/protocol';

export interface LeadModelGroup {
  key: string;
  title: string;
  models: LeadModelOption[];
}

function sourceLabel(source: string | null): string {
  if (!source) return '其他';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function groupLeadModels(models: readonly LeadModelOption[]): LeadModelGroup[] {
  const providers = new Set(models.map((model) => model.provider));
  const groups = new Map<string, { prefix: string | null; provider: string; sources: Set<string | null>; models: LeadModelOption[] }>();
  for (const model of models) {
    const key = model.prefix ? `${model.provider}\u0000prefix\u0000${model.prefix}` : `${model.provider}\u0000source\u0000${model.source ?? ''}`;
    const group = groups.get(key) ?? { prefix: model.prefix, provider: model.provider, sources: new Set(), models: [] };
    group.sources.add(model.source);
    group.models.push(model);
    groups.set(key, group);
  }
  const prefixedSources = new Set(
    [...groups.values()].filter((group) => group.prefix).flatMap((group) => [...group.sources].map((source) => `${group.provider}\u0000${source}`)),
  );
  const entries = [...groups.entries()].map(([key, group]) => {
    const source = group.sources.size === 1 ? [...group.sources][0]! : null;
    const parts = [
      providers.size > 1 ? group.provider : null,
      group.prefix,
      group.prefix ? (source ? sourceLabel(source) : null) : sourceLabel(source),
      !group.prefix && prefixedSources.has(`${group.provider}\u0000${source}`) ? '不指定账号' : null,
    ].filter((part): part is string => Boolean(part));
    return { key, prefix: group.prefix, group: { key, title: parts.join(' · '), models: group.models } };
  });
  const prefixed = entries.filter((entry) => entry.prefix)
    .sort((left, right) => left.prefix!.localeCompare(right.prefix!, undefined, { numeric: true }));
  return [...prefixed, ...entries.filter((entry) => !entry.prefix)].map((entry) => entry.group);
}

// 输入框右下角写的：模型 id（不带 provider 和账号前缀）和推理强度。
export function leadModelLabel(spec: string): { id: string; effort: string | null } {
  const parsed = parseLeadModelSpec(spec);
  return { id: parsed.bareId, effort: parsed.effort };
}

// 换到另一个模型时用的推理强度：这个模型也支持现在的强度就留着，不支持时用模型自己的缺省（不加后缀）。
export function effortForModel(model: LeadModelOption, current: string | null): string | null {
  return current && model.efforts.includes(current) ? current : null;
}

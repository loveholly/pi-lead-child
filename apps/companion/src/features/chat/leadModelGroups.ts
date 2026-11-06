// Lead 的模型选择（2026-10-26）：会话输入框的模型浮层按分组列出目录里的模型。
// 分组规则和设置页、首次启动共用一个函数（protocol 的 model-groups.ts，用户 2026-11-05 定的方案）：
// provider → 「group · channel」分段。账号（group）只在服务商的 accountPrefix 生效时才有，目录 DTO 里写在 prefix 字段。
// 浮层（PR #11，2026-11-06）：上面一个搜索框，左栏是 provider（外层），右边是选中 provider 的分段（里层）；
// 左栏选「全部模型」时右边是全部分段。搜索只决定画哪些模型（groupModelsByProvider 的 keep），分段标题不跟着变。
import {
  flatModelSections, groupModelsByProvider, modelSectionTitle, parseLeadModelSpec, type LeadModelOption,
} from '@pi-lead-child/protocol';

export interface LeadModelGroup {
  key: string;
  // 分段标题：group · channel，右边画着多个 provider 时前面加 provider。都没有时是空字符串。
  title: string;
  // 这一段一共几个模型（不看搜索）。
  count: number;
  models: LeadModelOption[];
}

export interface LeadModelProvider {
  provider: string;
  // 这个 provider 一共几个模型（不看搜索）。
  count: number;
}

/**
 * 上游供应商：magpie 这类网关下 id 的第一段（deepseek、asin、bailian-token-plan、codex…），
 * 没有子路径时（asin/gemini-4-argon、auto/deepseek-flash）就是 provider 本身。
 * 2026-11-06 用户要求：左栏按供应商分类，不按网关实例（local-3425 / local-3425-2）。
 */
export function upstreamProvider(model: LeadModelOption): string {
  // 账号前缀（vibeproxy 的 as1/、as4/）不是供应商：先去掉，剩下的 id 还有斜杠才取第一段。
  const id = model.prefix && model.id.startsWith(`${model.prefix}/`) ? model.id.slice(model.prefix.length + 1) : model.id;
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : model.provider;
}

function grouped(models: readonly LeadModelOption[], keep?: (model: LeadModelOption) => boolean) {
  return groupModelsByProvider(
    models.map((model) => {
      const upstream = upstreamProvider(model);
      // 左栏按上游供应商分组；provider 被换掉时，原 provider（网关实例）落到 group 里，分段标题上还看得到来源。
      return { ...model, provider: upstream, group: model.prefix ?? (upstream === model.provider ? null : model.provider) };
    }),
    keep ? { keep } : {},
  );
}

// 搜索和设置页的模型库一样：按完整的 provider/id 和显示名，不分大小写。
export function matchesLeadModel(model: LeadModelOption, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return model.model.toLowerCase().includes(term) || (model.name?.toLowerCase().includes(term) ?? false);
}

/** 左栏：每个 provider 一格，按模型第一次出现的先后。不看搜索，搜索时左栏不变。 */
export function leadModelProviders(models: readonly LeadModelOption[]): LeadModelProvider[] {
  return grouped(models).map((provider) => ({ provider: provider.provider, count: provider.count }));
}

/** 右边的分段。provider 为 null 时是全部 provider 的分段；query 为空时不过滤。一个模型也不剩的分段不画。 */
export function groupLeadModels(
  models: readonly LeadModelOption[], options: { query?: string; provider?: string | null } = {},
): LeadModelGroup[] {
  const query = options.query?.trim() ?? '';
  const providers = grouped(models, query ? (model) => matchesLeadModel(model, query) : undefined);
  const provider = options.provider ?? null;
  // 只画一个 provider 时标题不写它（左栏已经写了）；画全部时有多个 provider 才写。
  const withProvider = provider === null && new Set(models.map(upstreamProvider)).size > 1;
  return flatModelSections(providers.filter((entry) => provider === null || entry.provider === provider)).map((section) => ({
    key: section.key,
    title: modelSectionTitle(section, withProvider),
    count: section.total,
    models: section.models,
  }));
}

// 输入框右下角写的：模型 id（不带 provider）和推理强度。不知道账号时写完整的 id（auto/deepseek-flash 和
// deepseek/deepseek-flash 不能显示成同一个名字）；知道账号时去掉它。
export function leadModelLabel(spec: string, group: string | null = null): { id: string; effort: string | null } {
  const parsed = parseLeadModelSpec(spec, group);
  return { id: parsed.bareId, effort: parsed.effort };
}

// 换到另一个模型时用的推理强度：这个模型也支持现在的强度就留着，不支持时用模型自己的缺省（不加后缀）。
export function effortForModel(model: LeadModelOption, current: string | null): string | null {
  return current && model.efforts.includes(current) ? current : null;
}

import type { BrainModel, ModelProvider, ModelProviderApi, ModelSettingsDto } from '@pi-lead-child/protocol';

// 首次启动页（2026-10-30，.scratch/onboarding/spec.md，画布 A1、A3）的纯函数：服务商预设、接入时的请求、推荐哪个模型。
// 首次启动时还没有任何服务商（用户 2026-10-30）：先选接口类型、填 key 或地址，连接后读这家的模型列表，再选模型。

export type FirstRunPresetId = 'anthropic' | 'openai' | 'google' | 'custom';

export interface FirstRunPreset {
  id: FirstRunPresetId;
  label: string;
  description: string;
  // 预设的服务商。custom 的地址和接口格式由用户填。
  name: string | null;
  baseUrl: string | null;
  api: ModelProviderApi | null;
}

export const FIRST_RUN_PRESETS: readonly FirstRunPreset[] = [
  { id: 'anthropic', label: 'Anthropic', description: 'Claude 系列 · 只填 key', name: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  { id: 'openai', label: 'OpenAI', description: 'GPT 系列 · 只填 key', name: 'openai', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
  // Gemini 走 Google 的 OpenAI 兼容端点：目录和对话都用 Bearer key。
  { id: 'google', label: 'Google', description: 'Gemini 系列 · 只填 key', name: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions' },
  { id: 'custom', label: '其他服务', description: 'OpenAI 兼容：vibeproxy、OpenRouter、公司网关，要填地址', name: null, baseUrl: null, api: null },
];

export function firstRunPreset(id: FirstRunPresetId): FirstRunPreset {
  return FIRST_RUN_PRESETS.find((preset) => preset.id === id) ?? FIRST_RUN_PRESETS[0]!;
}

/** 其他服务的名字：从主机名来（127.0.0.1:8317 → local-8317，api.example.com → example），和已有的重名时加编号。 */
export function customProviderName(baseUrl: string, existing: readonly string[]): string {
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    host = '';
  }
  const [hostname = '', port] = host.split(':');
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const parts = hostname.split('.').filter((part) => part && part !== 'api' && part !== 'www');
  const base = local ? `local${port ? `-${port}` : ''}` : (parts.length > 1 ? parts.at(-2)! : parts[0] ?? 'custom');
  const cleaned = base.replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 28) || 'custom';
  if (!existing.includes(cleaned)) return cleaned;
  for (let index = 2; index < 100; index++) if (!existing.includes(`${cleaned}-${index}`)) return `${cleaned}-${index}`;
  return `${cleaned}-${Date.now() % 1000}`;
}

export interface FirstRunProviderForm {
  preset: FirstRunPresetId;
  apiKey: string;
  // 只有其他服务用：地址和接口格式。
  baseUrl: string;
  api: ModelProviderApi;
}

/** 接入请求（save_provider 的 input）。填得不对时返回原因。 */
export function firstRunProviderRequest(
  form: FirstRunProviderForm,
  existing: readonly string[],
): { ok: true; input: { name: string; baseUrl: string; api: ModelProviderApi; apiKey?: string } } | { ok: false; problem: string } {
  const preset = firstRunPreset(form.preset);
  const apiKey = form.apiKey.trim();
  if (preset.id !== 'custom') {
    if (!apiKey) return { ok: false, problem: `填上 ${preset.label} 的 API key。` };
    return { ok: true, input: { name: preset.name!, baseUrl: preset.baseUrl!, api: preset.api!, apiKey } };
  }
  const baseUrl = form.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return { ok: false, problem: '服务地址要以 http:// 或 https:// 开头。' };
  return { ok: true, input: { name: customProviderName(baseUrl, existing), baseUrl, api: form.api, ...(apiKey ? { apiKey } : {}) } };
}

/** 刚接入的服务商（按名字找）。还没出现在模型设置里时为 null。 */
export function connectedProvider(dto: ModelSettingsDto | null, name: string | null): ModelProvider | null {
  if (!dto || !name) return null;
  return dto.brain.providers.find((provider) => provider.name === name) ?? null;
}

// 小、快、便宜的那一档不推荐当大脑。
const LIGHT_MODEL = /(haiku|mini|nano|flash|lite|small|tiny)/i;

/** 推荐当大脑的模型：目录里最新发布的、不是小模型的那个；都是小模型时取最新的。目录是空的时为 null。 */
export function recommendedBrainModel(models: readonly BrainModel[]): BrainModel | null {
  return models.find((model) => !LIGHT_MODEL.test(model.id)) ?? models[0] ?? null;
}

/** 页面上先列几个：推荐的排第一，再按目录的顺序（新的在前），一共 limit 个。 */
export function firstRunModelList(models: readonly BrainModel[], limit: number | null): BrainModel[] {
  const recommended = recommendedBrainModel(models);
  const ordered = recommended ? [recommended, ...models.filter((model) => model.model !== recommended.model)] : [...models];
  return limit === null ? ordered : ordered.slice(0, limit);
}

/** 模型名下面的一行：上下文窗口、能不能看图。 */
export function firstRunModelMeta(model: BrainModel): string {
  const parts: string[] = [];
  if (model.image) parts.push('图片');
  if (model.contextWindow) {
    parts.push(model.contextWindow >= 1_000_000 ? `${Math.round(model.contextWindow / 100_000) / 10}M 上下文` : `${Math.round(model.contextWindow / 1000)}K 上下文`);
  }
  if (model.released?.source === 'provider') parts.push(`发布于 ${model.released.at.slice(0, 10)}`);
  return parts.join(' · ') || model.id;
}

// 页面要的事实都在这里算：网页包开着 React Compiler，组件里读一个可能是 null 的对象的属性时，编译器会把它提到渲染时读，
// 对象是 null 时整个组件崩掉（2026-10-29 设置 → 模型踩过）。组件只拿这个函数的结果。
export function firstRunProviderFacts(provider: ModelProvider | null) {
  if (!provider) return { connected: false, name: null, modelCount: 0, models: [] as BrainModel[], problem: null };
  const connected = provider.problem === null && provider.models.length > 0;
  return {
    connected,
    name: provider.name,
    modelCount: provider.models.length,
    models: provider.models,
    // 接入了，但目录读不出来：说明原因，留在第一步。
    problem: connected ? null : provider.problem ?? `${provider.name} 的目录里一个模型也没有。检查地址和接口格式。`,
  };
}

/** 选中的模型的缺省推理强度（目录给的）。 */
export function modelEffort(models: readonly BrainModel[], model: string): string | null {
  return models.find((entry) => entry.model === model)?.defaultEffort ?? null;
}

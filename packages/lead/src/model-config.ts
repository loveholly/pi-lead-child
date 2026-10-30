import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
import {
  envConfigPath,
  loadPlcConfig,
  resolveEnvSpec,
  writePlcConfig,
  type EnvSpec,
  type PlcConfigFile,
} from "@pi-lead-child/core";
import { MODEL_MAX_CHAIN } from "@pi-lead-child/protocol";

export const DEFAULT_LEAD_MODEL = "openai/gpt-5.5";

export const OPENAI_COMPATIBLE_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type OpenAICompatibleApi = (typeof OPENAI_COMPATIBLE_APIS)[number];

export interface LeadProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
}

export interface LeadProviderConfig {
  api?: OpenAICompatibleApi;
  baseUrl: string;
  apiKey?: EnvSpec;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: LeadProviderModelConfig[];
  discover?: boolean;
}

export interface LeadModelConfig {
  providers: Record<string, LeadProviderConfig>;
  models: string[];
}

export interface ParsedModelName {
  provider: string;
  id: string;
}

export function parseModelName(spec: string): ParsedModelName {
  const i = spec.indexOf("/");
  if (i === -1) throw new Error(`模型格式应为 provider/model，收到: ${spec}`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

export function loadLeadModelConfig(
  dir?: string,
  env: Record<string, string | undefined> = process.env,
): LeadModelConfig {
  const file = loadPlcConfig(dir);
  return normalizeLeadModelConfig(file.lead, env);
}

export function normalizeLeadModelConfig(
  raw: PlcConfigFile["lead"],
  env: Record<string, string | undefined> = process.env,
): LeadModelConfig {
  const providers: Record<string, LeadProviderConfig> = {};
  for (const [name, provider] of Object.entries(raw?.providers ?? {})) {
    providers[name] = normalizeLeadProvider(name, provider);
  }
  // 分工最多一个主用加 3 个备用（设置 → 模型，用户 2026-10-29）。手改 config.json 写多了时，后面的不用。
  const models = (raw?.models ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, MODEL_MAX_CHAIN);
  if (env.PLC_LEAD_MODEL?.trim() && models.length === 0) {
    models.push(env.PLC_LEAD_MODEL.trim());
  }
  return { providers, models };
}

export function selectedLeadModelSpec(
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  return config.models[0] ?? env.PLC_LEAD_MODEL?.trim() ?? DEFAULT_LEAD_MODEL;
}

// 设置页存的服务商 key（daemon 的保险库，设置 → 模型，2026-10-29）。daemon 启动时用 setLeadProviderKeySource 接上；
// 它按服务商的名字和现在的地址给 key，地址的主机和存 key 时的不一样时给 null（key 只发给存它时的主机）。
// key 不进 config.json，也不进 process.env：child 继承 daemon 的全部环境。
export type LeadProviderKeySource = (name: string, provider: LeadProviderConfig) => string | null;
let providerKeySource: LeadProviderKeySource | null = null;

export function setLeadProviderKeySource(source: LeadProviderKeySource | null): void {
  providerKeySource = source;
}

/** 服务商的 key：设置页存的优先，其次是 config.json 里写的（value 或 fromEnv）。不知道服务商的名字时只看 config.json。 */
export function resolveLeadApiKey(
  provider: LeadProviderConfig,
  env: Record<string, string | undefined> = process.env,
  name?: string,
): string | undefined {
  if (name && providerKeySource) {
    const stored = providerKeySource(name, provider);
    if (stored) return stored;
  }
  return provider.apiKey ? resolveEnvSpec(provider.apiKey, env) : undefined;
}

export async function discoverOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url.href} failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new Error(`GET ${url.href} did not return OpenAI-compatible { data: [...] }`);
  }
  const ids: string[] = [];
  for (const item of payload.data) {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      const id = (item as { id: string }).id.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// Lead 的模型目录里的一个模型（2026-10-26，会话输入框的模型选择）。id 不带推理强度的后缀。
export interface LeadCatalogModel {
  provider: string;
  id: string;
  // id 里第一个斜杠前的部分：vibeproxy 给一个账号设了 prefix 时，这个账号的模型是 <prefix>/<model>（例如 as4/claude-sonnet-5）。
  // 没有斜杠时为 null。
  prefix: string | null;
  // 上游（/v1/models 的 owned_by，例如 anthropic、antigravity）。不知道时为 null。
  source: string | null;
  // 目录给的显示名。没有时为 null。
  name: string | null;
  input: Array<"text" | "image">;
  // 可以写在 id 后面的推理强度（vibeproxy 的 (level) 后缀，例如 claude-sonnet-5(high)）。目录没说时是空数组：不能选强度。
  efforts: string[];
  defaultEffort: string | null;
  // 目录给的上下文窗口和最大输出（vibeproxy 详细目录的 context_window、max_tokens）。目录没说时为 null。
  contextWindow: number | null;
  maxTokens: number | null;
  // 目录给的发布时间（ISO）：OpenAI 兼容目录的 created（秒），Anthropic 目录的 created_at。目录没说时为 null。
  created: string | null;
}

// Lead 的上下文最多按 500K 算（2026-10-26 用户：「500K压缩」）。模型按目录里的真实窗口注册，比 500K 大的按 500K 注册：
// pi 在「窗口减 reserveTokens（16384）」时自动压缩，也就是约 484K；沉淀检查在窗口的 PRECIPITATE_RATIO（70%）时先跑。
// 窗口比 500K 小的模型按它自己的窗口算。以前不读目录，一律按 128K 注册：Claude 的系统提示词、工具定义加上压缩摘要
// 就有 122K，pi 把回答的长度压到 1 个 token，回答以 stopReason length 结束（2026-10-26，as4/claude-sonnet-5-5）。
export const LEAD_CONTEXT_WINDOW_LIMIT = 500_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_HOST = "api.anthropic.com";
const DEFAULT_MAX_TOKENS = 16_384;

// 推理强度写在模型 id 后面的括号里（CLIProxyAPI 的写法）：代理去掉括号，把强度换成上游的参数。
const EFFORT_SUFFIX = /^(.+)\(([A-Za-z0-9_-]{1,32})\)$/;

/** claude-sonnet-5(high) → { base: "claude-sonnet-5", effort: "high" }。没有后缀时 effort 为 null。 */
export function splitLeadModelEffort(id: string): { base: string; effort: string | null } {
  const match = EFFORT_SUFFIX.exec(id);
  return match ? { base: match[1]!, effort: match[2]! } : { base: id, effort: null };
}

export function withLeadModelEffort(spec: string, effort: string | null): string {
  return effort ? `${spec}(${effort})` : spec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, pick: (item: unknown) => unknown = (item) => item): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(pick).filter((item): item is string => typeof item === "string").map((item) => item.trim()));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// 目录里一个模型的发布时间：OpenAI 兼容的 created 是秒（vibeproxy 给 Anthropic 的模型也写它），Anthropic 的 created_at 是 ISO。
// 2015 年以前、或者在未来一天以后的时间不可信（例如写成 0），当作没有。
const EARLIEST_MODEL_RELEASE = Date.UTC(2015, 0, 1);
function catalogCreatedAt(item: Record<string, unknown>, now = Date.now()): string | null {
  let ms: number | null = null;
  if (typeof item.created === "number" && Number.isFinite(item.created)) ms = item.created * 1000;
  else if (typeof item.created_at === "string") ms = Date.parse(item.created_at);
  if (ms === null || !Number.isFinite(ms) || ms < EARLIEST_MODEL_RELEASE || ms > now + 86_400_000) return null;
  return new Date(ms).toISOString();
}

// 一个 provider 的目录。discover 时先问普通的 OpenAI 目录（id 和 owned_by，拉不到就报错，和以前一样），
// 再问 CLIProxyAPI（vibeproxy）的详细目录（?client_version=pi：显示名、能不能看图、推理强度）。别的服务没有详细目录，
// 这一步失败或者没有 models 时只用普通目录。config 里写的模型排在前面，能不能看图以 config 写的为准。
async function providerCatalog(
  name: string,
  provider: LeadProviderConfig,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<{ models: LeadCatalogModel[]; note: string | null }> {
  const configured = provider.models ?? [];
  const entry = (id: string, extra: Partial<LeadCatalogModel> = {}): LeadCatalogModel => {
    const slash = id.indexOf("/");
    return {
      provider: name, id, prefix: slash > 0 ? id.slice(0, slash) : null, source: null, name: null,
      input: ["text"], efforts: [], defaultEffort: null, contextWindow: null, maxTokens: null, created: null, ...extra,
    };
  };
  const byId = new Map<string, LeadCatalogModel>();
  for (const model of configured) {
    byId.set(model.id, entry(model.id, { ...(model.name ? { name: model.name } : {}), ...(model.input ? { input: model.input } : {}) }));
  }
  let note: string | null = null;
  if (provider.discover !== false && (provider.discover === true || configured.length === 0)) {
    const apiKey = resolveLeadApiKey(provider, env, name);
    const base = provider.baseUrl.endsWith("/") ? provider.baseUrl : `${provider.baseUrl}/`;
    const headers: Record<string, string> = { Accept: "application/json" };
    // Anthropic 原生接口（首次启动引导的 Anthropic 预设，2026-10-30）：地址不带 /v1（pi 的缺省是 https://api.anthropic.com），
    // 目录在 /v1/models，key 放在 x-api-key，还要 anthropic-version。返回的 data[] 和 OpenAI 的一样（id、display_name、created_at）。
    // 代理（vibeproxy 这类）也可能用 anthropic-messages：它们认 Bearer，所以只有 Anthropic 自己的主机不带 Bearer。
    // Anthropic 的目录分页，一页最多 1000 个。
    const anthropic = provider.api === "anthropic-messages";
    if (apiKey && anthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
    if (apiKey && !(anthropic && new URL(base).hostname === ANTHROPIC_HOST)) headers.Authorization = `Bearer ${apiKey}`;
    try {
      const url = new URL(anthropic ? `${/\/v1\/$/u.test(base) ? "" : "v1/"}models?limit=1000` : "models", base);
      const response = await fetchImpl(url, { headers });
      if (!response.ok) throw new Error(`GET ${url.href} failed: ${response.status} ${response.statusText}`);
      const payload = await response.json() as { data?: unknown };
      if (!Array.isArray(payload.data)) throw new Error(`GET ${url.href} did not return OpenAI-compatible { data: [...] }`);
      const owners = new Map<string, string | null>();
      const created = new Map<string, string>();
      for (const item of payload.data) {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
        owners.set(item.id.trim(), typeof item.owned_by === "string" && item.owned_by.trim() ? item.owned_by.trim() : null);
        const at = catalogCreatedAt(item);
        if (at) created.set(item.id.trim(), at);
      }
      let rich: unknown[] = [];
      // Anthropic 的 display_name 在普通目录里就有。
      const displayNames = new Map<string, string>();
      for (const item of payload.data) {
        if (isRecord(item) && typeof item.id === "string" && typeof item.display_name === "string") displayNames.set(item.id.trim(), item.display_name);
      }
      // 只有 OpenAI 兼容的代理有详细目录。
      if (!anthropic) try {
        const detail = await fetchImpl(new URL("models?client_version=pi", base), { headers });
        const body = detail.ok ? await detail.json() as { models?: unknown } : null;
        if (Array.isArray(body?.models)) rich = body.models;
      } catch {
        // 不是 CLIProxyAPI：没有详细目录。
      }
      const details = new Map<string, Record<string, unknown>>();
      for (const item of rich) {
        if (isRecord(item) && typeof item.slug === "string" && item.visibility !== "hide") details.set(item.slug.trim(), item);
      }
      for (const id of uniqueStrings([...owners.keys(), ...details.keys()])) {
        const detail = details.get(id);
        const input = stringList(detail?.input_modalities).filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
        const previous = byId.get(id);
        byId.set(id, entry(id, {
          source: owners.get(id) ?? null,
          name: previous?.name ?? (typeof detail?.display_name === "string" ? detail.display_name : displayNames.get(id) ?? null),
          // config 写了 input 时以它为准（手动覆盖）；没写时用目录说的。
          input: configured.find((model) => model.id === id)?.input ?? (input.length ? input : ["text"]),
          efforts: stringList(detail?.supported_reasoning_levels, (level) => (isRecord(level) ? level.effort : level)),
          defaultEffort: typeof detail?.default_reasoning_level === "string" ? detail.default_reasoning_level : null,
          contextWindow: positiveInteger(detail?.context_window),
          maxTokens: positiveInteger(detail?.max_tokens),
          created: created.get(id) ?? null,
        }));
      }
      note = `${name}: discovered ${owners.size} model(s) from ${provider.baseUrl}${details.size ? ` (${details.size} with details)` : ""}`;
    } catch (error) {
      if (byId.size === 0) throw error;
      note = `${name}: discover failed, using ${byId.size} configured model(s): ${String(error)}`;
    }
  }
  if (byId.size === 0) throw new Error(`lead.providers.${name} has no models; set models[] or discover:true`);
  return { models: [...byId.values()], note };
}

/**
 * Lead 能用的模型（所有 provider 的目录）。目录拉不到、config 里也没写模型的 provider 跳过，原因写在 notes 里。
 * 会话输入框的模型选择和 Lead 的 list_lead_models 都读它。
 */
export async function leadModelCatalog(
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: LeadCatalogModel[]; notes: string[] }> {
  const models: LeadCatalogModel[] = [];
  const notes: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    try {
      const catalog = await providerCatalog(name, provider, env, fetchImpl);
      models.push(...catalog.models);
      if (catalog.note) notes.push(catalog.note);
    } catch (error) {
      notes.push(`${name}: no models (${String(error)})`);
    }
  }
  return { models, notes };
}

export async function registerLeadProviders(
  runtime: ModelRuntime,
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const notes: string[] = [];
  const chosenProviders = new Set(config.models.map((spec) => parseModelName(spec).provider));
  for (const [name, provider] of Object.entries(config.providers)) {
    let catalog: Awaited<ReturnType<typeof providerCatalog>>;
    try {
      catalog = await providerCatalog(name, provider, env, fetchImpl);
    } catch (error) {
      // 设置页能接入服务商（2026-10-29）：一个地址填错、分工里又没用它的服务商，不能让 Lead 起不来。跳过它，原因写进说明。
      // 分工里在用的服务商照旧报错：Lead 要用的模型注册不上。
      if (chosenProviders.has(name)) throw error;
      notes.push(`${name}: skipped (${String(error)})`);
      continue;
    }
    if (catalog.note) notes.push(catalog.note);
    // lead.models 里这个 provider 的模型也要注册：带推理强度后缀的（as4/claude-sonnet-5(high)）不在目录里。
    const chosen = config.models.flatMap((spec) => {
      const parsed = parseModelName(spec);
      return parsed.provider === name ? [parsed.id] : [];
    });
    const modelIds = uniqueStrings([...catalog.models.map((model) => model.id), ...chosen]);
    runtime.registerProvider(name, toProviderConfigInput(provider, modelIds, resolveLeadApiKey(provider, env, name), catalog.models));
  }
  return notes;
}

export async function listConfiguredLeadModelSpecs(
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const { models } = await leadModelCatalog(config, env, fetchImpl);
  return uniqueStrings([...config.models, ...models.map((model) => `${model.provider}/${model.id}`)]);
}

// 推理强度要在这个模型的目录里：claude-sonnet-5(high) 要 claude-sonnet-5 在目录里、并且支持 high。
export async function assertConfiguredLeadModel(
  spec: string,
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { provider, id } = parseModelName(spec);
  const { models } = await leadModelCatalog(config, env, fetchImpl);
  const available = uniqueStrings([...config.models, ...models.map((model) => `${model.provider}/${model.id}`)]);
  if (available.includes(spec)) return;
  const { base, effort } = splitLeadModelEffort(id);
  const model = models.find((candidate) => candidate.provider === provider && candidate.id === base);
  if (effort && model) {
    if (model.efforts.includes(effort)) return;
    throw new Error(`模型 ${provider}/${base} 不支持推理强度 ${effort}。`
      + (model.efforts.length ? `可选：${model.efforts.join("、")}` : "它不能选推理强度。"));
  }
  throw new Error(`模型 ${spec} 不在已配置的 Lead provider 目录中。可选：\n${available.join("\n")}`);
}

export async function resolveLeadModel(
  runtime: ModelRuntime,
  spec: string,
): Promise<{ provider: string; id: string; model: NonNullable<ReturnType<ModelRuntime["getModel"]>> }> {
  const { provider, id } = parseModelName(spec);
  const model = runtime.getModel(provider, id);
  if (!model) {
    const avail = (await runtime.getAvailable()).map((item) => `${item.provider}/${item.id}`).slice(0, 20);
    throw new Error(`找不到模型 ${spec}。可用：\n${avail.join("\n")}`);
  }
  return { provider, id, model };
}

// 排第一的就是 Lead 用的模型。同一个模型别的推理强度（claude-sonnet-5(low) 和 claude-sonnet-5(high)）从顺序里拿掉：
// 模型自动切换不该在同一个模型的几个强度之间换来换去。
export function setLeadModelInConfig(spec: string, dir?: string): string {
  parseModelName(spec);
  const base = splitLeadModelEffort(spec).base;
  const file = loadPlcConfig(dir);
  const existing = (file.lead?.models ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value && value !== spec && splitLeadModelEffort(value).base !== base);
  const next: PlcConfigFile = {
    ...file,
    lead: {
      ...file.lead,
      providers: file.lead?.providers ?? {},
      models: [spec, ...existing],
    },
  };
  writePlcConfig(next, dir);
  return envConfigPath(dir);
}

// 设置 → 模型（2026-10-29）：大脑的分工整个写进 lead.models（第一个主用）。调用方先校验（在目录里、没有重复、不超过上限）。
export function setLeadModelChainInConfig(specs: readonly string[], dir?: string): void {
  for (const spec of specs) parseModelName(spec);
  const file = loadPlcConfig(dir);
  writePlcConfig({ ...file, lead: { ...file.lead, providers: file.lead?.providers ?? {}, models: [...specs] } }, dir);
}

/**
 * 接入或修改一个服务商（lead.providers.<name>）。新的服务商拉目录（discover: true）。改了别的字段（models、headers……）照旧。
 * 地址换了主机、config.json 里又手写了 apiKey 时，删掉那个 key：key 只发给原来的主机。返回删没删。
 */
export function saveLeadProviderInConfig(
  name: string,
  settings: { baseUrl: string; api: OpenAICompatibleApi },
  hostOf: (url: string) => string | null,
  dir?: string,
): { droppedConfigKey: boolean } {
  const file = loadPlcConfig(dir);
  const providers = { ...(file.lead?.providers ?? {}) };
  const previous = isRecord(providers[name]) ? providers[name] as Record<string, unknown> : null;
  let droppedConfigKey = false;
  const next: Record<string, unknown> = previous ? { ...previous } : { discover: true };
  if (previous && typeof previous.baseUrl === "string" && hostOf(previous.baseUrl) !== hostOf(settings.baseUrl) && previous.apiKey !== undefined) {
    delete next.apiKey;
    droppedConfigKey = true;
  }
  next.baseUrl = settings.baseUrl;
  next.api = settings.api;
  providers[name] = next;
  writePlcConfig({ ...file, lead: { ...file.lead, providers, models: file.lead?.models ?? [] } }, dir);
  return { droppedConfigKey };
}

export function removeLeadProviderInConfig(name: string, dir?: string): void {
  const file = loadPlcConfig(dir);
  const providers = { ...(file.lead?.providers ?? {}) };
  delete providers[name];
  writePlcConfig({ ...file, lead: { ...file.lead, providers, models: file.lead?.models ?? [] } }, dir);
}

function normalizeLeadProvider(name: string, raw: unknown): LeadProviderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`lead.providers.${name} 必须是对象`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
    throw new Error(`lead.providers.${name}.baseUrl 必填`);
  }
  const api = value.api === undefined ? "openai-completions" : value.api;
  if (typeof api !== "string" || !OPENAI_COMPATIBLE_APIS.includes(api as OpenAICompatibleApi)) {
    throw new Error(`lead.providers.${name}.api 仅支持 ${OPENAI_COMPATIBLE_APIS.join(", ")}`);
  }
  return {
    api: api as OpenAICompatibleApi,
    baseUrl: value.baseUrl.trim(),
    apiKey: normalizeApiKey(name, value.apiKey),
    authHeader: value.authHeader === undefined ? true : Boolean(value.authHeader),
    headers: isStringRecord(value.headers) ? value.headers : undefined,
    compat: value.compat && typeof value.compat === "object" && !Array.isArray(value.compat)
      ? value.compat as Record<string, unknown>
      : undefined,
    models: normalizeProviderModels(name, value.models),
    discover: value.discover === undefined ? undefined : Boolean(value.discover),
  };
}

function normalizeApiKey(name: string, raw: unknown): EnvSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return { value: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`lead.providers.${name}.apiKey 必须是字符串或 { value | fromEnv }`);
  }
  const spec = raw as EnvSpec;
  if (spec.value === undefined && spec.fromEnv === undefined) {
    throw new Error(`lead.providers.${name}.apiKey 需要 value 或 fromEnv`);
  }
  return spec;
}

function normalizeProviderModels(name: string, raw: unknown): LeadProviderModelConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`lead.providers.${name}.models 必须是数组`);
  return raw.map((item, index) => {
    if (typeof item === "string") return { id: item };
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as { id?: unknown }).id !== "string") {
      throw new Error(`lead.providers.${name}.models[${index}] 需要 id`);
    }
    return item as LeadProviderModelConfig;
  });
}

function toProviderConfigInput(
  provider: LeadProviderConfig,
  modelIds: string[],
  apiKey: string | undefined,
  catalog: readonly LeadCatalogModel[] = [],
): ProviderConfigInput {
  const configured = new Map((provider.models ?? []).map((model) => [model.id, model]));
  const listed = new Map(catalog.map((model) => [model.id, model]));
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey,
    authHeader: provider.authHeader,
    headers: provider.headers,
    models: modelIds.map((id) => {
      // 带推理强度后缀的 id 用不带后缀的那个模型的设置和目录信息。
      const base = splitLeadModelEffort(id).base;
      const extra = configured.get(id) ?? configured.get(base);
      const known = listed.get(base);
      return {
        id,
        name: extra?.name ?? id,
        reasoning: extra?.reasoning ?? false,
        input: extra?.input ?? known?.input ?? ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // config.json 写了窗口时以它为准，没写时用目录的；都没有时按 128K。都不超过 LEAD_CONTEXT_WINDOW_LIMIT。
        contextWindow: Math.min(LEAD_CONTEXT_WINDOW_LIMIT, extra?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
        // 最大输出还是 16384，只有目录说的更小时用目录的。
        maxTokens: extra?.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, known?.maxTokens ?? DEFAULT_MAX_TOKENS),
        ...(provider.compat ? { compat: provider.compat as never } : {}),
      };
    }),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

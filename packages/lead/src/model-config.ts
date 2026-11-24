import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions, ThinkingLevel, ThinkingLevelMap, TranscriptContext } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
import {
  envConfigPath,
  loadPlcConfig,
  resolveEnvSpec,
  writePlcConfig,
  type EnvSpec,
  type PlcConfigFile,
} from "@pi-lead-child/core";
import {
  DEFAULT_LEAD_CONTEXT_WINDOW, MAGPIE_ROUTE_NAMES, MODEL_MAX_CHAIN, subscriptionAccountOf, subscriptionSlotSpec,
} from "@pi-lead-child/protocol";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export const DEFAULT_LEAD_MODEL = "openai/gpt-5.5";

export const OPENAI_COMPATIBLE_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type OpenAICompatibleApi = (typeof OPENAI_COMPATIBLE_APIS)[number];

// 模型能力（能不能看图）从哪里读（Lead 模型分组，2026-11-05）：
//   auto：有 CLIProxyAPI 的详细目录就读它，没有时读普通目录的条目（magpie 的 modalities.input）；
//   detailed：只读详细目录；plain：只读普通目录；config：只读 config.json 的 models[].input。
// config.json 里写了 models[].input 的模型，不管哪一种，都以写的为准。
export const LEAD_CAPABILITY_SOURCES = ["auto", "detailed", "plain", "config"] as const;
export type LeadCapabilitySource = (typeof LEAD_CAPABILITY_SOURCES)[number];
// 设置页「添加模型」的 API key 种类（模型配置方案 C，2026-11-16）。只给界面显示用：没写时界面按 accountPrefix 和模型 id 推断。
export const LEAD_PROVIDER_PRESETS = ["custom", "vibeproxy", "magpie"] as const;
export type LeadProviderPreset = (typeof LEAD_PROVIDER_PRESETS)[number];

export interface LeadProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  // Price in USD per 1M tokens (manual override of the catalog's price; background-model.ts reads it).
  cost?: { input: number; output: number; cacheRead?: number | null };
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
  // 模型 id 里第一个斜杠前的部分是不是账号（vibeproxy 的 as1/、as4/）。没写时：读到了详细目录就当作是，否则当作不是
  // （magpie 的 auto/、deepseek/ 不是账号）。
  accountPrefix?: boolean;
  // 能不能看图从哪里读。没写时是 auto。
  capabilities?: LeadCapabilitySource;
  // 设置页添加时选的种类（custom、vibeproxy、magpie）。只影响界面怎样显示这个服务商，不影响 Lead 怎样调用它。
  preset?: LeadProviderPreset;
  // Send the Lead session id as prompt_cache_key to this OpenAI-compatible endpoint (prompt-cache.ts). Default: on.
  // Set it to false when the endpoint rejects the field.
  promptCacheKey?: boolean;
  // How long the provider keeps Lead's prompt cache (prompt-cache.ts, cacheRetentionExtension). Default: short, the
  // provider's own default (5 minutes on Anthropic). long asks for 1 hour on Anthropic-style cache breakpoints and
  // for extended retention (prompt_cache_retention: "24h") on OpenAI-compatible endpoints. The 1-hour tier costs 2×
  // to write instead of 1.25×, so it pays only when Lead often waits 5 to 60 minutes between calls.
  cacheRetention?: LeadCacheRetention;
}

export const LEAD_CACHE_RETENTIONS = ["short", "long"] as const;
export type LeadCacheRetention = (typeof LEAD_CACHE_RETENTIONS)[number];

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

// 订阅（模型配置方案 C 的 S2，subscriptions.ts）：有账号登录了的订阅（openai-codex、github-copilot）。daemon 的订阅服务接上。
// 目录里列出它们的模型（pi 自带的目录），分工写 <base>/<id>。没接上时（测试、子 agent 另起的会话）不列订阅。
export type LeadSubscriptionSource = () => Promise<readonly string[]>;
let subscriptionSource: LeadSubscriptionSource | null = null;

export function setLeadSubscriptionSource(source: LeadSubscriptionSource | null): void {
  subscriptionSource = source;
}

/** 一种订阅的模型：pi 自带的目录（D3：分工里写 <base>/<id>）。 */
export function leadSubscriptionModels(base: string): LeadCatalogModel[] {
  if (!subscriptionAccountOf(base) || !(getBuiltinProviders() as readonly string[]).includes(base)) return [];
  return getBuiltinModels(base as Parameters<typeof getBuiltinModels>[0]).map((model) => ({
    provider: base, id: model.id, group: null, source: base, name: model.name ?? null,
    input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
    efforts: [], defaultEffort: null,
    contextWindow: positiveInteger(model.contextWindow), maxTokens: positiveInteger(model.maxTokens), created: null,
    price: (() => {
      const price = configuredPrice(model.cost);
      return price && (price.input > 0 || price.output > 0) ? { ...price, cacheRead: price.cacheRead || null } : knownModelPrice(model.id);
    })(),
  }));
}

async function connectedSubscriptions(notes: string[]): Promise<string[]> {
  if (!subscriptionSource) return [];
  try {
    return [...await subscriptionSource()];
  } catch (error) {
    notes.push(`subscriptions: not listed (${String(error)})`);
    return [];
  }
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
  // 账号（group）：id 里第一个斜杠前的部分，只在这家服务商的 accountPrefix 生效时才算（vibeproxy 给一个账号设了 prefix 时，
  // 这个账号的模型是 <prefix>/<model>，例如 as4/claude-sonnet-5）。不生效（magpie 的 auto/deepseek-flash）或者没有斜杠时为 null。
  group: string | null;
  // 上游（/v1/models 的 owned_by，例如 anthropic、antigravity）。不知道时为 null。
  source: string | null;
  // 目录给的显示名。没有时为 null。
  name: string | null;
  // 通道（magpie 的路由，字段名用 route：protocol 的 model-groups.ts 已经把 owned_by 叫 channel。同一个模型名可以走 auto/、claude/、codex/ 几条通道，显示名相同）。来自普通目录的 magpie_label
  // 里「 · 」后面的部分（routing group、Claude Code、Codex），没有这个字段时按 id 里第一个斜杠前的部分兜底（magpieRoute）。
  // 只有 magpie 有；别的服务商没有这个字段或者为 null。
  route?: string | null;
  input: Array<"text" | "image">;
  // 可以写在 id 后面的推理强度（例如 claude-sonnet-5(high)）。目录没说时是空数组：不能选强度。
  // CLIProxyAPI（有详细目录）：后缀原样发给代理，代理认它。别的服务商（magpie）：Lead 发请求时去掉后缀，
  // 把强度写进这家接口的字段（effortParameterSupported、leadEffortRequest），所以只列这个字段发得出去的强度。
  efforts: string[];
  defaultEffort: string | null;
  // 目录给的上下文窗口和最大输出（vibeproxy 详细目录的 context_window、max_tokens）。目录没说时为 null。
  contextWindow: number | null;
  maxTokens: number | null;
  // 目录给的发布时间（ISO）：OpenAI 兼容目录的 created（秒），Anthropic 目录的 created_at。目录没说时为 null。
  created: string | null;
  // Price in USD per 1M tokens (modelPrice): config.json's models[].cost, else the catalog's pricing, else pi's
  // built-in first-party price for the same id. null when no source knows it. background-model.ts reads it.
  price: LeadModelPrice | null;
}

/** A model's price in USD per 1M tokens. cacheRead is null when not known. */
export interface LeadModelPrice {
  input: number;
  output: number;
  cacheRead: number | null;
}

// One price field: a number or a decimal string, finite and not negative. Anything else is unknown.
function priceNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\s*\d+(?:\.\d+)?(?:e-?\d+)?\s*$/i.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Per-token prices are tiny decimals: round the per-1M value so 0.0000001 * 1e6 reads 0.1, not 0.09999999999999999.
const perMillion = (perToken: number): number => Math.round(perToken * 1e6 * 1e6) / 1e6;

/**
 * The price in a catalog entry's pricing (OpenRouter shape, as magpie reports it): USD per token, usually as strings
 * ({ prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" }). Returns USD per 1M tokens, or
 * null when the prompt or the completion price is missing or not a number.
 */
export function catalogPricing(item: unknown): LeadModelPrice | null {
  const pricing = isRecord(item) ? item.pricing : undefined;
  if (!isRecord(pricing)) return null;
  const input = priceNumber(pricing.prompt);
  const output = priceNumber(pricing.completion);
  if (input === null || output === null) return null;
  const cacheRead = priceNumber(pricing.input_cache_read);
  return { input: perMillion(input), output: perMillion(output), cacheRead: cacheRead === null ? null : perMillion(cacheRead) };
}

/** config.json's models[].cost (USD per 1M tokens). null when it is missing or not numbers. */
export function configuredPrice(cost: unknown): LeadModelPrice | null {
  if (!isRecord(cost)) return null;
  const input = priceNumber(cost.input);
  const output = priceNumber(cost.output);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: priceNumber(cost.cacheRead) };
}

let knownPrices: Map<string, LeadModelPrice> | null = null;

/**
 * pi's built-in price of a first-party model with the same name (the last part of the id, without the effort suffix),
 * in USD per 1M tokens. A price of 0 for both input and output is not a price (pi writes 0 when it does not know one).
 */
export function knownModelPrice(id: string): LeadModelPrice | null {
  const name = modelName(splitLeadModelEffort(id).base);
  try {
    if (!knownPrices) {
      const prices = new Map<string, LeadModelPrice>();
      const available = new Set<string>(getBuiltinProviders());
      for (const provider of FIRST_PARTY_CATALOGS) {
        if (!available.has(provider)) continue;
        for (const model of getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0])) {
          const key = model.id.toLowerCase();
          const price = configuredPrice(model.cost);
          if (!prices.has(key) && price && (price.input > 0 || price.output > 0)) {
            prices.set(key, { ...price, cacheRead: price.cacheRead || null });
          }
        }
      }
      knownPrices = prices;
    }
    return knownPrices.get(name) ?? null;
  } catch {
    return null;
  }
}

// Lead 的上下文最多按 500K 算（2026-10-26 用户：「500K压缩」）。模型按目录里的真实窗口注册，比 500K 大的按 500K 注册：
// pi 在「窗口减 reserveTokens（16384）」时自动压缩，也就是约 484K；沉淀检查在窗口的 PRECIPITATE_RATIO（70%）时先跑。
// 窗口比 500K 小的模型按它自己的窗口算。以前不读目录，一律按 128K 注册：Claude 的系统提示词、工具定义加上压缩摘要
// 就有 122K，pi 把回答的长度压到 1 个 token，回答以 stopReason length 结束（2026-10-26，as4/claude-sonnet-5-5）。
export const LEAD_CONTEXT_WINDOW_LIMIT = 500_000;
// The window Lead assumes when neither config.json, the provider's catalog nor pi's built-in catalog knows it.
// The settings page says so next to such a model (protocol's DEFAULT_LEAD_CONTEXT_WINDOW).
const DEFAULT_CONTEXT_WINDOW = DEFAULT_LEAD_CONTEXT_WINDOW;

// Known windows (2026-11-12, prompt cache): a gateway (DeepSeek behind Azure or a self-hosted proxy) often lists a model
// without its window, and Lead then assumed 128K and compacted about every 20K tokens. pi's built-in catalog knows the
// real windows of the first-party models (DeepSeek V4: 1M), so a model id that matches one of them gets that window.
// First-party catalogs come first: aggregators list the same ids with their own, often smaller, limits.
const FIRST_PARTY_CATALOGS = [
  "deepseek", "anthropic", "openai", "google", "xai", "mistral", "moonshotai", "zai", "minimax", "xiaomi",
];
// Windows the built-in catalog does not list (yet). deepseek-v4-flash: DeepSeek's pricing page, 1M context.
const EXTRA_KNOWN_WINDOWS: Record<string, number> = { "deepseek-v4-flash": 1_000_000 };
let knownWindows: { firstParty: Map<string, number>; other: Map<string, number> } | null = null;

// The last part of a model id, lowercased: "deepseek-ai/DeepSeek-V4.1-Flash" -> "deepseek-v4.1-flash".
function modelName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

function builtinWindows(): { firstParty: Map<string, number>; other: Map<string, number> } {
  if (knownWindows) return knownWindows;
  const providers = getBuiltinProviders();
  const available = new Set<string>(providers);
  const firstParty = new Map<string, number>(Object.entries(EXTRA_KNOWN_WINDOWS));
  for (const provider of FIRST_PARTY_CATALOGS) {
    if (!available.has(provider)) continue;
    for (const model of getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0])) {
      const id = model.id.toLowerCase();
      if (!firstParty.has(id) && positiveInteger(model.contextWindow)) firstParty.set(id, model.contextWindow);
    }
  }
  // A model that no first-party catalog lists yet (deepseek-v4.1-flash in pi-ai 1.5.2 is listed only by aggregators and
  // resellers): the smallest window any other built-in catalog gives for the same name. The smallest one is the safe
  // choice, because Lead compacts too late when the window is too large.
  const other = new Map<string, number>();
  const firstPartyProviders = new Set<string>(FIRST_PARTY_CATALOGS);
  for (const provider of providers) {
    if (firstPartyProviders.has(provider)) continue;
    for (const model of getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0])) {
      const window = positiveInteger(model.contextWindow);
      if (window === null) continue;
      const name = modelName(model.id);
      const previous = other.get(name);
      if (previous === undefined || window < previous) other.set(name, window);
    }
  }
  return (knownWindows = { firstParty, other });
}

/**
 * The known context window of a model id, or null. Matches the last part of the id (after a gateway or account prefix
 * such as auto/ or as4/, without the effort suffix) against pi's built-in first-party catalogs. When none of them lists
 * the model, it takes the smallest window that the other built-in catalogs give for the same name.
 */
export function knownContextWindow(id: string): number | null {
  const name = modelName(splitLeadModelEffort(id).base);
  try {
    const { firstParty, other } = builtinWindows();
    return firstParty.get(name) ?? other.get(name) ?? null;
  } catch {
    return null;
  }
}
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

// 推理强度作为请求字段发送（magpie 这类不认 (level) 后缀的服务商）。Lead 照旧用带后缀的 id 选模型、写分工、
// 做「只这一条」，只有发请求的那一步不同：发出的 model 去掉后缀，强度交给 pi 写进这家接口的字段：
//   anthropic-messages：output_config.effort（pi 的 adaptive thinking，compat.forceAdaptiveThinking）；
//   openai-completions：reasoning_effort；openai-responses：reasoning.effort。
// pi 只认这几个强度名（pi-ai 的 THINKING_LEVELS），thinkingLevelMap 把同名的强度原样发出去。目录里别的名字（GPT 的 ultra）
// pi 发不出去，不列：选了也只会被换成别的强度。
const PARAMETER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const EFFORT_PARAMETER_APIS: ReadonlySet<OpenAICompatibleApi> = new Set(["anthropic-messages", "openai-completions", "openai-responses"]);

function isParameterEffort(level: string): level is ThinkingLevel {
  return (PARAMETER_EFFORTS as readonly string[]).includes(level);
}

/**
 * Can Lead send an effort to this provider as a request field? Only through an API whose effort field pi writes
 * (EFFORT_PARAMETER_APIS), and not for a provider that shares its name with one of pi's built-in providers (Lead
 * replaces the provider's request function to send the field, and a built-in provider has its own). An OpenAI chat
 * provider whose config turns reasoning_effort off, or picks another thinking format, cannot take it either.
 */
export function effortParameterSupported(name: string, provider: Pick<LeadProviderConfig, "api" | "compat">): boolean {
  const api = provider.api ?? "openai-completions";
  if (!EFFORT_PARAMETER_APIS.has(api)) return false;
  if ((getBuiltinProviders() as readonly string[]).includes(name)) return false;
  if (api === "openai-completions") {
    const compat = provider.compat ?? {};
    if (compat.supportsReasoningEffort === false) return false;
    if (compat.thinkingFormat !== undefined && compat.thinkingFormat !== "openai") return false;
  }
  return true;
}

// pi 的强度表只开这一档：别的强度都标成不支持（null），off 也是，所以 pi 不会把它换成别的强度，也不会发「关掉思考」。
function singleEffortMap(effort: ThinkingLevel): ThinkingLevelMap {
  return {
    off: null,
    ...Object.fromEntries(PARAMETER_EFFORTS.map((level) => [level, level === effort ? effort : null])),
  } as ThinkingLevelMap;
}

/** The effort a registered model sends as a request field, or null when it sends none (no suffix, or the suffix mode). */
function parameterEffortOf(model: Pick<Model<Api>, "id" | "reasoning" | "thinkingLevelMap">): ThinkingLevel | null {
  const { effort } = splitLeadModelEffort(model.id);
  if (!effort || !model.reasoning || !isParameterEffort(effort)) return null;
  return model.thinkingLevelMap?.[effort] === effort ? effort : null;
}

/** The effort a request body carries in the field of its API, or null when it carries none. */
function payloadEffort(api: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const nested = (value: unknown) => (isRecord(value) && typeof value.effort === "string" ? value.effort : null);
  if (api === "anthropic-messages") return nested(payload.output_config);
  if (api === "openai-responses") return nested(payload.reasoning);
  if (api === "openai-completions") {
    return typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : nested(payload.reasoning);
  }
  return null;
}

/**
 * The request for a model whose effort goes as a request field (claude-opus-5-5(high) on magpie): the model id without
 * the suffix, and the effort as pi's reasoning level. Other models come back unchanged. The body is checked after every
 * payload hook: when it does not carry the chosen effort or carries another model id, the request fails with an error
 * instead of going out at another effort.
 */
export function leadEffortRequest<M extends Model<Api>>(
  model: M, options: SimpleStreamOptions | undefined,
): { model: M; options: SimpleStreamOptions | undefined } {
  const effort = parameterEffortOf(model);
  if (!effort) return { model, options };
  const wireId = splitLeadModelEffort(model.id).base;
  const previous = options?.onPayload;
  const onPayload: NonNullable<SimpleStreamOptions["onPayload"]> = async (payload, payloadModel) => {
    const next = (await previous?.(payload, payloadModel)) ?? payload;
    const sent = payloadEffort(model.api, next);
    if (sent !== effort) {
      throw new Error(`Lead could not send the effort ${effort} for ${model.provider}/${wireId} through ${model.api}`
        + ` (the request carries ${sent ?? "no effort"}); not sending it at another effort.`);
    }
    if (isRecord(next) && typeof next.model === "string" && next.model !== wireId) {
      throw new Error(`Lead would send the model ${next.model} instead of ${wireId} to ${model.provider}; not sending it.`);
    }
    return next;
  };
  return {
    model: { ...model, id: wireId },
    options: { ...options, reasoning: effort, onPayload },
  };
}

// The provider's request function when Lead sends efforts as a request field: the same API implementation that pi would
// call for this provider, with leadEffortRequest in front of it.
function effortParameterStream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const api = getApiProvider(model.api);
  if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
  const request = leadEffortRequest(model, options);
  return api.streamSimple(request.model, context, request.options);
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

// 一个 provider 的目录读到了什么（设置页的「高级」要显示）。
export interface LeadCatalogProviderInfo {
  // 读到了 CLIProxyAPI 的详细目录（?client_version=pi 返回了 models[]）。
  detailed: boolean;
  // accountPrefix 的生效值：config 写了用写的；没写时读到了详细目录就是 true，否则是 false。
  accountPrefix: boolean;
  // 能不能看图实际按哪里读：auto 换成了 detailed 或 plain。
  capabilities: Exclude<LeadCapabilitySource, "auto">;
}

/** accountPrefix 的生效值。 */
export function effectiveAccountPrefix(provider: Pick<LeadProviderConfig, "accountPrefix">, detailed: boolean): boolean {
  return provider.accountPrefix ?? detailed;
}

/** 能不能看图实际按哪里读：auto 时有详细目录读详细目录，没有时读普通目录。 */
export function effectiveCapabilities(
  provider: Pick<LeadProviderConfig, "capabilities">, detailed: boolean,
): Exclude<LeadCapabilitySource, "auto"> {
  const declared = provider.capabilities ?? "auto";
  if (declared !== "auto") return declared;
  return detailed ? "detailed" : "plain";
}

function inputKinds(value: unknown): Array<"text" | "image"> | null {
  if (!Array.isArray(value)) return null;
  const kinds = stringList(value).filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
  return kinds.length ? kinds : null;
}

// 普通目录（data[]）的一项里和能力有关的字段。magpie 没有详细目录，把这些写在普通目录里（2026-11-05）：
// modalities.input（或者 input_modalities）、display_name、context_window、max_output_tokens（或者 max_tokens）、
// 推理强度 supported_reasoning_levels（[{ effort }] 或字符串，没有时读 reasoning_levels）和 default_reasoning_level。
// reasoning: false 的条目没有强度。强度只在这家服务商能把它作为请求字段发出去时才用（effortParameterSupported）。
interface PlainCatalogFields {
  input: Array<"text" | "image"> | null;
  name: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  price: LeadModelPrice | null;
  efforts: string[];
  defaultEffort: string | null;
}

function plainCatalogFields(item: Record<string, unknown>): PlainCatalogFields {
  const modalities = isRecord(item.modalities) ? item.modalities.input : undefined;
  const reasons = item.reasoning !== false;
  const levels = stringList(item.supported_reasoning_levels, (level) => (isRecord(level) ? level.effort : level));
  return {
    input: inputKinds(item.input_modalities) ?? inputKinds(modalities),
    name: typeof item.display_name === "string" && item.display_name.trim() ? item.display_name : null,
    contextWindow: positiveInteger(item.context_window),
    maxTokens: positiveInteger(item.max_output_tokens) ?? positiveInteger(item.max_tokens),
    price: catalogPricing(item),
    efforts: reasons ? (levels.length ? levels : stringList(item.reasoning_levels)) : [],
    defaultEffort: reasons && typeof item.default_reasoning_level === "string" ? item.default_reasoning_level.trim() || null : null,
  };
}

// magpie 的通道名（选择器里同名模型靠它分开）：magpie_label 是「显示名 · 通道」，取最后一个「 · 」后面的部分。
// 没有 magpie_label 时按 id 里第一个斜杠前的部分：auto/ 是 Auto，claude/ 是 Claude Code，codex/ 是 Codex，别的照写前缀
// （对照表是 protocol 的 MAGPIE_ROUTE_NAMES）。id 没有斜杠时没有通道。
// 最长 MAGPIE_ROUTE_MAX_LENGTH 个字符，和 protocol 的 LeadModelOption.route 一样：更长的截断，否则 Companion 整份目录拒收。
const MAGPIE_LABEL_SEPARATOR = " · ";
const MAGPIE_ROUTE_MAX_LENGTH = 80;

export function magpieRoute(id: string, label: unknown): string | null {
  const route = magpieRouteText(id, label);
  return route === null ? null : Array.from(route).slice(0, MAGPIE_ROUTE_MAX_LENGTH).join("").trim() || null;
}

function magpieRouteText(id: string, label: unknown): string | null {
  if (typeof label === "string") {
    const at = label.lastIndexOf(MAGPIE_LABEL_SEPARATOR);
    const route = at >= 0 ? label.slice(at + MAGPIE_LABEL_SEPARATOR.length).trim() : "";
    if (route) return route;
  }
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const prefix = id.slice(0, slash);
  return MAGPIE_ROUTE_NAMES[prefix] ?? prefix;
}

// 普通目录的强度里能作为请求字段发出去的那些（PARAMETER_EFFORTS），顺序照目录。缺省强度不在里面时当作没有。
function parameterEfforts(flat: PlainCatalogFields | undefined): { efforts: string[]; defaultEffort: string | null } {
  const efforts: string[] = (flat?.efforts ?? []).filter(isParameterEffort);
  const defaultEffort = flat?.defaultEffort && efforts.includes(flat.defaultEffort) ? flat.defaultEffort : null;
  return { efforts, defaultEffort };
}

// 一个 provider 的目录。discover 时先问普通的 OpenAI 目录（id 和 owned_by，拉不到就报错，和以前一样），
// 再问 CLIProxyAPI（vibeproxy）的详细目录（?client_version=pi：显示名、能不能看图、推理强度）。别的服务没有详细目录，
// 这一步失败或者没有 models 时只用普通目录。config 里写的模型排在前面。
//
// 能不能看图（Lead 模型分组，2026-11-05）：config 的 models[].input 优先；其次按 capabilities 声明的来源读；
// 没声明（auto）时，有详细目录读它的 input_modalities，否则读普通目录条目的 modalities.input。
// 账号（group）只在 accountPrefix 生效时才取。
async function providerCatalog(
  name: string,
  provider: LeadProviderConfig,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<{ models: LeadCatalogModel[]; note: string | null; info: LeadCatalogProviderInfo }> {
  const configured = provider.models ?? [];
  const configuredInput = new Map(configured.flatMap((model) => (model.input ? [[model.id, model.input] as const] : [])));
  const entry = (id: string, extra: Partial<LeadCatalogModel> = {}): LeadCatalogModel => ({
    provider: name, id, group: null, source: null, name: null,
    input: ["text"], efforts: [], defaultEffort: null, contextWindow: null, maxTokens: null, created: null, price: null, ...extra,
  });
  const byId = new Map<string, LeadCatalogModel>();
  for (const model of configured) {
    byId.set(model.id, entry(model.id, { ...(model.name ? { name: model.name } : {}), ...(model.input ? { input: model.input } : {}) }));
  }
  let note: string | null = null;
  let detailed = false;
  // magpie：设置页按 magpie 接入的（preset），或者目录条目带 magpie_label 的。只有它显示通道（route，magpieRoute）。
  let magpie = provider.preset === "magpie";
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
      // 普通目录里的能力字段，和详细目录分开放：capabilities 决定读哪一份。
      const plain = new Map<string, PlainCatalogFields>();
      // magpie 普通目录条目的 magpie_label（通道名）。
      const labels = new Map<string, unknown>();
      for (const item of payload.data) {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
        const id = item.id.trim();
        owners.set(id, typeof item.owned_by === "string" && item.owned_by.trim() ? item.owned_by.trim() : null);
        const at = catalogCreatedAt(item);
        if (at) created.set(id, at);
        plain.set(id, plainCatalogFields(item));
        if (item.magpie_label !== undefined) labels.set(id, item.magpie_label);
      }
      if (labels.size) magpie = true;
      let rich: unknown[] = [];
      // 只有 OpenAI 兼容的代理有详细目录。
      if (!anthropic) try {
        const detail = await fetchImpl(new URL("models?client_version=pi", base), { headers });
        const body = detail.ok ? await detail.json() as { models?: unknown } : null;
        if (Array.isArray(body?.models)) {
          rich = body.models;
          detailed = true;
        }
      } catch {
        // 不是 CLIProxyAPI：没有详细目录。
      }
      const details = new Map<string, Record<string, unknown>>();
      for (const item of rich) {
        if (isRecord(item) && typeof item.slug === "string" && item.visibility !== "hide") details.set(item.slug.trim(), item);
      }
      const capabilities = provider.capabilities ?? "auto";
      // 强度从哪里读：CLIProxyAPI 的详细目录（后缀发给代理），或者普通目录（作为请求字段发送，这家接口要发得出去）。
      const plainEfforts = !detailed && effortParameterSupported(name, provider);
      for (const id of uniqueStrings([...owners.keys(), ...details.keys()])) {
        const detail = details.get(id);
        const flat = plain.get(id);
        const effort = detailed
          ? {
            efforts: stringList(detail?.supported_reasoning_levels, (level) => (isRecord(level) ? level.effort : level)),
            defaultEffort: typeof detail?.default_reasoning_level === "string" ? detail.default_reasoning_level : null,
          }
          : plainEfforts ? parameterEfforts(flat) : { efforts: [], defaultEffort: null };
        const detailInput = inputKinds(detail?.input_modalities);
        const fromCatalog = capabilities === "detailed" ? detailInput
          : capabilities === "plain" ? flat?.input ?? null
          : capabilities === "config" ? null
          : detail ? detailInput : flat?.input ?? null;
        const previous = byId.get(id);
        byId.set(id, entry(id, {
          source: owners.get(id) ?? null,
          ...(magpie && !detailed ? { route: magpieRoute(id, labels.get(id)) } : {}),
          name: previous?.name ?? (typeof detail?.display_name === "string" ? detail.display_name : flat?.name ?? null),
          // config 写了 input 时以它为准（手动覆盖）；没写时按 capabilities 读目录。
          input: configuredInput.get(id) ?? fromCatalog ?? ["text"],
          ...effort,
          contextWindow: positiveInteger(detail?.context_window) ?? flat?.contextWindow ?? null,
          maxTokens: positiveInteger(detail?.max_tokens) ?? flat?.maxTokens ?? null,
          created: created.get(id) ?? null,
          price: catalogPricing(detail) ?? flat?.price ?? null,
        }));
      }
      note = `${name}: discovered ${owners.size} model(s) from ${provider.baseUrl}${details.size ? ` (${details.size} with details)` : ""}`;
    } catch (error) {
      if (byId.size === 0) throw error;
      note = `${name}: discover failed, using ${byId.size} configured model(s): ${String(error)}`;
    }
  }
  if (byId.size === 0) throw new Error(`lead.providers.${name} has no models; set models[] or discover:true`);
  const info: LeadCatalogProviderInfo = {
    detailed,
    accountPrefix: effectiveAccountPrefix(provider, detailed),
    capabilities: effectiveCapabilities(provider, detailed),
  };
  // The window the settings page shows: config.json's, the catalog's, or the known one; null when none knows it.
  const configuredWindow = new Map(configured.flatMap((model) => (model.contextWindow ? [[model.id, model.contextWindow] as const] : [])));
  // The price: config.json's cost (manual override), the catalog's pricing, or pi's built-in first-party price.
  const configuredCost = new Map(configured.flatMap((model) => {
    const price = configuredPrice(model.cost);
    return price ? [[model.id, price] as const] : [];
  }));
  const models = [...byId.values()].map((model) => ({
    ...model,
    // config.json 里写的模型（目录没列，或者没有拉目录）也按 id 前缀给通道。
    ...(magpie && !detailed && model.route === undefined ? { route: magpieRoute(model.id, null) } : {}),
    group: info.accountPrefix ? modelGroup(model.id) : null,
    contextWindow: configuredWindow.get(model.id) ?? configuredWindow.get(splitLeadModelEffort(model.id).base)
      ?? model.contextWindow ?? knownContextWindow(model.id),
    price: configuredCost.get(model.id) ?? configuredCost.get(splitLeadModelEffort(model.id).base)
      ?? model.price ?? knownModelPrice(model.id),
  }));
  return { models, note, info };
}

function modelGroup(id: string): string | null {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : null;
}

/**
 * Lead 能用的模型（所有 provider 的目录）。目录拉不到、config 里也没写模型的 provider 跳过，原因写在 notes 里。
 * 会话输入框的模型选择、设置页和 Lead 的 list_lead_models 都读它。providers 是每家读到了什么（设置页的「高级」）。
 */
export async function leadModelCatalog(
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: LeadCatalogModel[]; notes: string[]; providers: Record<string, LeadCatalogProviderInfo> }> {
  const models: LeadCatalogModel[] = [];
  const notes: string[] = [];
  const providers: Record<string, LeadCatalogProviderInfo> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    try {
      const catalog = await providerCatalog(name, provider, env, fetchImpl);
      models.push(...catalog.models);
      providers[name] = catalog.info;
      if (catalog.note) notes.push(catalog.note);
    } catch (error) {
      notes.push(`${name}: no models (${String(error)})`);
    }
  }
  // 订阅的模型（D3）。config.json 里有同名的服务商时用服务商的。
  for (const base of await connectedSubscriptions(notes)) {
    if (base in config.providers) continue;
    models.push(...leadSubscriptionModels(base));
  }
  return { models, notes, providers };
}

export async function registerLeadProviders(
  runtime: ModelRuntime,
  config: LeadModelConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  // 最大输出。缺省是 Lead 用的 16384；子 agent 另起的 ModelRuntime 要更大的（lookup/session.ts）。目录说的更小时用目录的。
  options: { maxOutputTokens?: number } = {},
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
    runtime.registerProvider(name, toProviderConfigInput(
      provider, modelIds, resolveLeadApiKey(provider, env, name), catalog.models, options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      !catalog.info.detailed && effortParameterSupported(name, provider),
    ));
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
  // 订阅的第 n 个账号（<base>-<n>/<id>）和 <base>/<id> 是分工里的同一格（D5）。
  if (available.includes(spec) || available.includes(subscriptionSlotSpec(spec))) return;
  const { base, effort } = splitLeadModelEffort(id);
  const model = models.find((candidate) => candidate.provider === provider && candidate.id === base);
  if (effort && model) {
    if (model.efforts.includes(effort)) return;
    throw new Error(`模型 ${provider}/${base} 不支持推理强度 ${effort}。`
      + (model.efforts.length ? `可选：${model.efforts.join("、")}` : "它不能选推理强度。"));
  }
  throw new Error(`模型 ${spec} 不在已配置的 Lead provider 目录中。可选：\n${available.join("\n")}`);
}

/**
 * D7：Lead 不用 pi 自带的别的订阅登录。provider 走 OAuth 登录（auth.json 里存的是 oauth 凭据），又不是 openai-codex* 或
 * github-copilot* 时拒绝，例如 auth.json 里的 anthropic 登录。走 API key 的同一个 provider 照常能用。
 */
export async function assertLeadOAuthProviderAllowed(
  runtime: Pick<ModelRuntime, "listCredentials">, provider: string,
): Promise<void> {
  if (subscriptionAccountOf(provider) || typeof runtime.listCredentials !== "function") return;
  const credential = (await runtime.listCredentials()).find((entry) => entry.providerId === provider);
  if (credential?.type === "oauth") {
    throw new Error(`模型的服务商 ${provider} 用的是 OAuth 订阅登录。Lead 只用 GitHub Copilot 和 Codex 的订阅（经过 pi-multi-pass）；`
      + `${provider} 请改用 API key 接入。`);
  }
}

export async function resolveLeadModel(
  runtime: ModelRuntime,
  spec: string,
): Promise<{ provider: string; id: string; model: NonNullable<ReturnType<ModelRuntime["getModel"]>> }> {
  const { provider, id } = parseModelName(spec);
  await assertLeadOAuthProviderAllowed(runtime, provider);
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
 * accountPrefix、capabilities（设置页的「高级」、首次启动的「前缀是账号吗」）：不给时不变；accountPrefix 为 null、
 * capabilities 为 auto 时从 config 里删掉，回到缺省。preset（设置页添加时选的种类）：不给时不变。
 */
export function saveLeadProviderInConfig(
  name: string,
  settings: {
    baseUrl: string; api: OpenAICompatibleApi; accountPrefix?: boolean | null; capabilities?: LeadCapabilitySource; preset?: LeadProviderPreset;
  },
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
  if (settings.accountPrefix !== undefined) {
    if (settings.accountPrefix === null) delete next.accountPrefix;
    else next.accountPrefix = settings.accountPrefix;
  }
  if (settings.capabilities !== undefined) {
    if (settings.capabilities === "auto") delete next.capabilities;
    else next.capabilities = settings.capabilities;
  }
  if (settings.preset !== undefined) next.preset = settings.preset;
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
    ...(normalizeAccountPrefix(name, value.accountPrefix)),
    ...(normalizeCapabilities(name, value.capabilities)),
    ...(normalizePreset(name, value.preset)),
    ...(normalizePromptCacheKey(name, value.promptCacheKey)),
    ...(normalizeCacheRetention(name, value.cacheRetention)),
  };
}

function normalizeCacheRetention(name: string, raw: unknown): { cacheRetention?: LeadCacheRetention } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(LEAD_CACHE_RETENTIONS as readonly string[]).includes(raw)) {
    throw new Error(`lead.providers.${name}.cacheRetention 仅支持 ${LEAD_CACHE_RETENTIONS.join(", ")}`);
  }
  return { cacheRetention: raw as LeadCacheRetention };
}

/** How long this provider keeps Lead's prompt cache: short (the provider's default) unless the config says long. */
export function cacheRetentionOf(config: Pick<LeadModelConfig, "providers">, provider: string): LeadCacheRetention {
  return config.providers[provider]?.cacheRetention === "long" ? "long" : "short";
}

function normalizePromptCacheKey(name: string, raw: unknown): { promptCacheKey?: boolean } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "boolean") throw new Error(`lead.providers.${name}.promptCacheKey 必须是 true 或 false`);
  return { promptCacheKey: raw };
}

/** Whether Lead sends prompt_cache_key to this provider (on unless the config turns it off). */
export function promptCacheKeyEnabled(config: Pick<LeadModelConfig, "providers">, provider: string): boolean {
  return config.providers[provider]?.promptCacheKey !== false;
}

function normalizeAccountPrefix(name: string, raw: unknown): { accountPrefix?: boolean } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "boolean") throw new Error(`lead.providers.${name}.accountPrefix 必须是 true 或 false`);
  return { accountPrefix: raw };
}

function normalizeCapabilities(name: string, raw: unknown): { capabilities?: LeadCapabilitySource } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(LEAD_CAPABILITY_SOURCES as readonly string[]).includes(raw)) {
    throw new Error(`lead.providers.${name}.capabilities 仅支持 ${LEAD_CAPABILITY_SOURCES.join(", ")}`);
  }
  return { capabilities: raw as LeadCapabilitySource };
}

function normalizePreset(name: string, raw: unknown): { preset?: LeadProviderPreset } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(LEAD_PROVIDER_PRESETS as readonly string[]).includes(raw)) {
    throw new Error(`lead.providers.${name}.preset 仅支持 ${LEAD_PROVIDER_PRESETS.join(", ")}`);
  }
  return { preset: raw as LeadProviderPreset };
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
  maxOutputTokens: number = DEFAULT_MAX_TOKENS,
  // 这家的强度作为请求字段发送（effortParameterSupported，不是 CLIProxyAPI）。
  effortParameter = false,
): ProviderConfigInput {
  const configured = new Map((provider.models ?? []).map((model) => [model.id, model]));
  const listed = new Map(catalog.map((model) => [model.id, model]));
  let sendsEffortParameter = false;
  const models = modelIds.map((id) => {
    // 带推理强度后缀的 id 用不带后缀的那个模型的设置和目录信息。
    const { base, effort } = splitLeadModelEffort(id);
    const extra = configured.get(id) ?? configured.get(base);
    const known = listed.get(base);
    // 强度作为请求字段发送：目录给这个模型列了这个强度时，注册成会思考的模型，pi 的强度表只开这一档；
    // 发请求时 effortParameterStream 去掉后缀。不带后缀的模型和以前一样，什么强度参数都不发（服务商的缺省）。
    const parameterEffort = effortParameter && effort && isParameterEffort(effort) && known?.efforts.includes(effort) ? effort : null;
    if (parameterEffort) sendsEffortParameter = true;
    const compat = parameterEffort && provider.api === "anthropic-messages"
      ? { ...provider.compat, forceAdaptiveThinking: true }
      : provider.compat;
    return {
      id,
      name: extra?.name ?? id,
      reasoning: parameterEffort ? true : extra?.reasoning ?? false,
      ...(parameterEffort ? { thinkingLevelMap: singleEffortMap(parameterEffort) } : {}),
      input: extra?.input ?? known?.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // config.json 写了窗口时以它为准，没写时用目录的，再没有时用已知的窗口（knownContextWindow）；都没有时按 128K。
      // 都不超过 LEAD_CONTEXT_WINDOW_LIMIT。
      contextWindow: Math.min(
        LEAD_CONTEXT_WINDOW_LIMIT,
        extra?.contextWindow ?? known?.contextWindow ?? knownContextWindow(base) ?? DEFAULT_CONTEXT_WINDOW,
      ),
      // 最大输出按调用方要的（Lead 是 16384），只有目录说的更小时用目录的。
      maxTokens: extra?.maxTokens ?? Math.min(maxOutputTokens, known?.maxTokens ?? DEFAULT_MAX_TOKENS),
      ...(compat ? { compat: compat as never } : {}),
    };
  });
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey,
    authHeader: provider.authHeader,
    headers: provider.headers,
    // 只在有模型的强度作为请求字段发送时才换掉请求函数；别的服务商照旧走 pi 的。
    ...(sendsEffortParameter ? { streamSimple: effortParameterStream } : {}),
    models,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

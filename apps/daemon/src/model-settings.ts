// 设置 → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）。操作层的 ModelSettingsService 在 daemon 里的实现：
// 页面（GET /v1/models/settings、POST /v1/actions/model_settings/models/<操作>）和 Lead（perform_action）用的是同一个对象。
//
// 大脑（Lead 的 LLM）：
//   - 分工是 config.json 的 lead.models（第一个主用，最多 3 个备用）。换主用要用 Lead 的会话：server.ts 交来 applyChain。
//   - 服务商是 lead.providers。页面存的 key 加密存进保险库（lead.provider.<名字>），绑定主机；packages/lead 的
//     setLeadProviderKeySource 从这里取。config.json 里手写的 apiKey 照旧能用（页面删不掉）。
//   - 目录按服务商分组，最新发布的在前面。目录没给发布时间的模型，记下 daemon 第一次看到它的时间（kv lead.model_first_seen）。
//     一个服务商第一次拉目录时就有的那些不知道什么时候出的：不记时间，排在最后。以后新出现的才有「首见」时间。
// 直觉（决策模型）：config.json 的 decision（decision-models.ts）。改了以后记忆的重排跟着主用换（MemoryController）。
import {
  fastModelAuthHeaderMessages, fastModelAuthHeaderProblem, leadModelSpec, MODEL_MAX_BACKUPS, MODEL_MAX_CHAIN, modelChainProblem,
  normalizeFastModelAuthHeader, parseLeadModelSpec, normalizeServiceUrl,
  serviceUrlHost, serviceUrlMessages, serviceUrlProblem, type Locale,
  type BrainModel, type FastModel, type LeadModelChoice, type MemoryTestResponse, type ModelKeySource, type ModelProvider,
  type ModelProviderApi, type ModelSettingsDto, type SaveFastModelRequest, type SaveModelProviderRequest, type SetBrainChainRequest,
  type SetFastChainRequest,
} from "@pi-lead-child/protocol";
import {
  assertConfiguredLeadModel, effectiveAccountPrefix, leadModelCatalog, loadLeadModelConfig, OPENAI_COMPATIBLE_APIS, removeLeadProviderInConfig,
  saveLeadProviderInConfig, setLeadProviderKeySource, type LeadCatalogModel, type LeadCatalogProviderInfo, type LeadModelConfig,
  type LeadProviderConfig,
} from "@pi-lead-child/lead";
import { resolveEnvSpec } from "@pi-lead-child/core";
import { UiActionError, type ModelSettingsChange, type ModelSettingsService, type ModelSettingsSummary } from "@pi-lead-child/engine";
import type { SecretVault } from "@pi-lead-child/connections";
import { getLocale, leadDisplayName, type Db } from "@pi-lead-child/store";
import {
  decisionEntryInputs, decisionKeyFor, decisionSecretName, loadDecisionModels, writeDecisionModels, type DecisionEntryInput,
} from "./decision-models.js";
import { MemoryError, type MemoryController } from "./memory-controller.js";
import { modelSettingsMessages } from "./model-settings.messages.js";
import { SealedSecrets } from "./sealed-secrets.js";

const FIRST_SEEN_KEY = "lead.model_first_seen";

// 一个服务商的目录。info 是读到了什么（详细目录、accountPrefix 和 capabilities 的生效值），目录拉不到时为 null。
type ProviderCatalog = { models: LeadCatalogModel[]; problem: string | null; info: LeadCatalogProviderInfo | null };
const CATALOG_TTL_MS = 30_000;
const MAX_FAST_MODELS = 32;

export function providerSecretName(name: string): string {
  return `lead.provider.${name}`;
}

/** 页面存的服务商 key：保险库里的那一个，只在它绑定的主机和服务商现在的地址一样时给。没有或解不开时是 null。 */
export function storedProviderKey(
  secrets: SealedSecrets<string>, log: (line: string) => void, name: string, provider: Pick<LeadProviderConfig, "baseUrl">,
): { value: string; host: string } | null {
  let stored;
  try {
    stored = secrets.get(providerSecretName(name));
  } catch (error) {
    log(`[models] provider key for ${name} cannot be opened: ${error instanceof Error ? error.name : "Error"}`);
    return null;
  }
  const host = serviceUrlHost(provider.baseUrl);
  return stored && host && stored.host === host ? { value: stored.value, host } : null;
}

// Lead 的会话、查找会话、Hindsight 的 LLM 取服务商的 key 时先问保险库。daemon 建好保险库以后、建记忆服务和 Lead 的会话之前
// 就要接上：Lead 启动时第一次注册服务商、拉目录用的就是它（工单 #181）。只要 db 和保险库，不等 ModelSettings。
export function connectLeadProviderKeys(db: Db, vault: SecretVault, log: (line: string) => void): void {
  const secrets = new SealedSecrets<string>(db, vault);
  setLeadProviderKeySource((name, provider) => storedProviderKey(secrets, log, name, provider)?.value ?? null);
}

export interface ModelSettingsBrain {
  // Lead 正在用的模型（provider/id，可能带推理强度）。
  current(): string;
  // 额度用完、模型自动切换在跳过的模型和到什么时候（毫秒）。
  blocked(): Array<{ model: string; until: number }>;
  // 写进 lead.models，并按新的主用换模型。Lead 空闲时马上换，正在回答时这一轮结束后换。
  applyChain(specs: string[]): Promise<"now" | "after_turn" | "unchanged">;
  // 服务商改了：重新注册 Lead 的 provider，清掉输入框模型选择的目录缓存。
  providersChanged(): Promise<void>;
}

export interface ModelSettingsOptions {
  db: Db;
  dataDir: string;
  vault: SecretVault;
  log: (line: string) => void;
  brain: ModelSettingsBrain;
  // 记忆服务（决策模型的测试、改了以后的重排）。daemon 不托管记忆时为 null：直觉照样能改，测试不能用。
  memory: MemoryController | null;
  // Keychain、daemon 专用的环境变量里的密钥（TYPESAFE_API_KEY）。
  externalSecret: (name: string) => string | null;
  // SmartModel 的 LLM 后端缺省用的模型（Lead 的会话给的）。没有时为 null。
  smartModelLlm: () => string | null;
  // 设置变了：网关发 snapshot.required（resource model-settings）。
  publish: () => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface FirstSeen {
  providers: Record<string, true>;
  // provider/id → 第一次看到的时间（ISO）。null：服务商第一次拉目录时就有，不知道什么时候出的。
  seen: Record<string, string | null>;
}

const choiceOf = (spec: string): LeadModelChoice => {
  const parsed = parseLeadModelSpec(spec);
  return { model: parsed.model, effort: parsed.effort };
};

function invalid(message: string): never {
  throw new UiActionError("invalid_input", message);
}

function checkedUrl(raw: string, locale: Locale): string {
  const problem = serviceUrlProblem(raw);
  if (problem) invalid(serviceUrlMessages(locale)[problem]);
  return normalizeServiceUrl(raw)!;
}

// 新的一条直觉的编号：从名字来（小写字母、数字、- 和 _），用不了时是 decision-<n>。不和已有的重复。
function fastModelId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 28);
  const stem = /^[a-z0-9]/.test(base) ? base : "decision";
  if (!taken.has(stem) && stem !== "decision") return stem;
  for (let n = 1; ; n += 1) {
    const id = `${stem}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export class ModelSettings implements ModelSettingsService {
  private readonly secrets: SealedSecrets<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private catalogCache: { at: number; value: Promise<Map<string, ProviderCatalog>> } | null = null;

  constructor(private readonly options: ModelSettingsOptions) {
    this.secrets = new SealedSecrets<string>(options.db, options.vault);
    // daemon 启动时已经接上（connectLeadProviderKeys）。单独用 ModelSettings 时（测试）在这里接上，效果一样。
    connectLeadProviderKeys(options.db, options.vault, options.log);
  }

  // 用户现在选的界面语言：设置页直接显示这里返回的摘要、说明和错误。
  private locale(): Locale {
    return getLocale(this.options.db);
  }

  stop(): void {
    setLeadProviderKeySource(null);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private config(): LeadModelConfig {
    return loadLeadModelConfig(this.options.dataDir, this.options.env);
  }

  private storedProviderKey(name: string, provider: Pick<LeadProviderConfig, "baseUrl">): { value: string; host: string } | null {
    return storedProviderKey(this.secrets, this.options.log, name, provider);
  }

  private providerKey(name: string, provider: LeadProviderConfig): { set: boolean; source: ModelKeySource; host: string | null } {
    const stored = this.storedProviderKey(name, provider);
    if (stored) return { set: true, source: "settings", host: stored.host };
    if (provider.apiKey?.value !== undefined) return { set: true, source: "config", host: null };
    if (provider.apiKey && resolveEnvSpec(provider.apiKey, this.options.env ?? process.env)) return { set: true, source: "env", host: null };
    return { set: false, source: null, host: null };
  }

  // ── 概要（Lead 的 list_actions）──────────────────────────────────────────────

  summary(): ModelSettingsSummary {
    const config = this.config();
    const fast = loadDecisionModels(this.options.dataDir);
    return {
      brain: { chain: [...config.models], current: this.options.brain.current(), providers: Object.keys(config.providers) },
      fast: {
        chain: fast.chain,
        models: fast.entries.map((entry) => ({
          id: entry.id, name: entry.name, host: entry.host,
          keySet: decisionKeyFor(entry, this.secrets, this.options.externalSecret) !== null,
        })),
        llmFallback: fast.llmFallback,
      },
      maxBackups: MODEL_MAX_BACKUPS,
    };
  }

  // ── 页面用的整份 ──────────────────────────────────────────────────────────────

  private catalogs(config: LeadModelConfig): Promise<Map<string, ProviderCatalog>> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.value;
    const value = (async () => {
      const result = new Map<string, ProviderCatalog>();
      await Promise.all(Object.entries(config.providers).map(async ([name, provider]) => {
        const one: LeadModelConfig = { providers: { [name]: provider }, models: [] };
        const catalog = await leadModelCatalog(one, this.options.env, this.options.fetch);
        const failed = catalog.notes.find((note) => note.startsWith(`${name}: no models`) || note.startsWith(`${name}: discover failed`));
        result.set(name, {
          models: catalog.models, problem: failed ? failed.slice(name.length + 2).slice(0, 500) : null, info: catalog.providers[name] ?? null,
        });
      }));
      return result;
    })();
    this.catalogCache = { at: Date.now(), value };
    value.catch(() => { this.catalogCache = null; });
    return value;
  }

  private readFirstSeen(): FirstSeen {
    const row = this.options.db.prepare("SELECT value FROM kv WHERE key = ?").get(FIRST_SEEN_KEY) as { value: string } | undefined;
    try {
      const parsed = row ? JSON.parse(row.value) as Partial<FirstSeen> : {};
      return { providers: parsed.providers ?? {}, seen: parsed.seen ?? {} };
    } catch {
      return { providers: {}, seen: {} };
    }
  }

  // 记下目录里新出现的、目录没给发布时间的模型。服务商第一次拉目录时就有的记成 null（不知道什么时候出的）。
  private recordFirstSeen(catalogs: Map<string, ProviderCatalog>): FirstSeen {
    const state = this.readFirstSeen();
    const at = this.now().toISOString();
    let changed = false;
    for (const [name, catalog] of catalogs) {
      if (catalog.problem && catalog.models.length === 0) continue;
      const baseline = !state.providers[name];
      for (const model of catalog.models) {
        const spec = `${model.provider}/${model.id}`;
        if (model.created || spec in state.seen) continue;
        state.seen[spec] = baseline ? null : at;
        changed = true;
      }
      if (baseline) {
        state.providers[name] = true;
        changed = true;
      }
    }
    if (changed) {
      this.options.db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ).run(FIRST_SEEN_KEY, JSON.stringify(state));
    }
    return state;
  }

  async get(): Promise<ModelSettingsDto> {
    const config = this.config();
    const catalogs = await this.catalogs(config);
    const firstSeen = this.recordFirstSeen(catalogs);
    const blocked = new Map<string, number>();
    for (const entry of this.options.brain.blocked()) {
      const model = parseLeadModelSpec(entry.model).model;
      blocked.set(model, Math.max(blocked.get(model) ?? 0, entry.until));
    }
    const providers: ModelProvider[] = Object.entries(config.providers).map(([name, provider]) => {
      const catalog = catalogs.get(name) ?? { models: [], problem: null, info: null };
      const key = this.providerKey(name, provider);
      const models: BrainModel[] = catalog.models.map((model) => {
        const spec = `${model.provider}/${model.id}`;
        const seen = firstSeen.seen[spec];
        const until = blocked.get(spec);
        return {
          model: spec, id: model.id, name: model.name, image: model.input.includes("image"),
          contextWindow: model.contextWindow, efforts: model.efforts, defaultEffort: model.defaultEffort,
          released: model.created ? { at: model.created, source: "provider" as const } : seen ? { at: seen, source: "first_seen" as const } : null,
          blockedUntil: until === undefined ? null : new Date(until).toISOString(),
          group: model.group, source: model.source,
        };
      });
      // 最新发布的在前面；不知道时间的排在最后，按 id。
      models.sort((a, b) => (b.released?.at ?? "").localeCompare(a.released?.at ?? "") || a.id.localeCompare(b.id));
      return {
        name, baseUrl: provider.baseUrl, api: (provider.api ?? "openai-completions") as ModelProviderApi,
        keySet: key.set, keySource: key.source, keyHost: key.host, models, problem: catalog.problem,
        accountPrefix: provider.accountPrefix ?? null,
        accountPrefixActive: catalog.info?.accountPrefix ?? effectiveAccountPrefix(provider, false),
        capabilities: provider.capabilities ?? "auto",
        catalog: catalog.info && !catalog.problem ? (catalog.info.detailed ? "detailed" : "plain") : "none",
      };
    });
    const fast = loadDecisionModels(this.options.dataDir);
    const fastModels: FastModel[] = fast.entries.map((entry) => {
      const key = decisionKeyFor(entry, this.secrets, this.options.externalSecret);
      let storedHost: string | null = null;
      try {
        storedHost = this.secrets.get(decisionSecretName(entry.id))?.host ?? null;
      } catch {
        storedHost = null;
      }
      return {
        id: entry.id, name: entry.name, baseUrl: entry.baseUrl, model: entry.model,
        apiKeySet: key !== null, apiKeySource: key ? (key.source === "settings" ? "settings" : "env") : null,
        apiKeyHost: key?.host ?? storedHost, problem: entry.problem, authHeader: entry.authHeader,
      };
    });
    return {
      brain: { chain: config.models.map(choiceOf), current: choiceOf(this.options.brain.current()), providers },
      fast: {
        models: fastModels,
        chain: fast.chain,
        llmFallback: fast.llmFallback ? choiceOf(fast.llmFallback) : null,
        effectiveLlm: fast.llmFallback ?? this.options.smartModelLlm(),
      },
      maxBackups: MODEL_MAX_BACKUPS,
    };
  }

  // ── 大脑 ────────────────────────────────────────────────────────────────────

  setBrainChain(request: SetBrainChainRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const locale = this.locale();
      const m = modelSettingsMessages(locale);
      const problem = modelChainProblem(request.models, (choice) => choice.model, { locale });
      if (problem) invalid(problem);
      const specs = request.models.map(leadModelSpec);
      const config = this.config();
      for (const spec of specs) {
        try {
          await assertConfiguredLeadModel(spec, config, this.options.env, this.options.fetch);
        } catch (error) {
          invalid(error instanceof Error ? error.message : String(error));
        }
      }
      const applied = await this.options.brain.applyChain(specs);
      this.options.publish();
      const [primary, ...backups] = specs;
      return {
        summary: m.brainSummary(primary!, backups),
        applied,
        note: applied === "after_turn" ? m.afterTurn(leadDisplayName(this.options.db)) : null,
      };
    });
  }

  saveProvider(request: SaveModelProviderRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const locale = this.locale();
      const m = modelSettingsMessages(locale);
      if (!(OPENAI_COMPATIBLE_APIS as readonly string[]).includes(request.api)) invalid(m.apiFormat(OPENAI_COMPATIBLE_APIS));
      const baseUrl = checkedUrl(request.baseUrl, locale);
      const host = serviceUrlHost(baseUrl);
      const existed = request.name in this.config().providers;
      const { droppedConfigKey } = saveLeadProviderInConfig(request.name, {
        baseUrl, api: request.api,
        ...(request.accountPrefix !== undefined ? { accountPrefix: request.accountPrefix } : {}),
        ...(request.capabilities !== undefined ? { capabilities: request.capabilities } : {}),
      }, serviceUrlHost, this.options.dataDir);
      const secret = providerSecretName(request.name);
      const notes: string[] = [];
      if (typeof request.apiKey === "string") {
        this.secrets.set(secret, { value: request.apiKey, host });
      } else if (request.apiKey === null) {
        this.secrets.set(secret, null);
      } else {
        const stored = this.secrets.get(secret);
        if (stored && stored.host !== host) {
          this.secrets.set(secret, null);
          notes.push(m.keyDropped(host, stored.host));
        }
      }
      if (droppedConfigKey) notes.push(m.configKeyDropped);
      this.catalogCache = null;
      await this.options.brain.providersChanged();
      this.options.publish();
      this.options.log(`[models] provider ${request.name} ${existed ? "updated" : "added"} (${host})`);
      return {
        summary: existed ? m.providerChanged(request.name, host) : m.providerAdded(request.name, host),
        note: notes.length ? m.joinNotes(notes) : null,
      };
    });
  }

  removeProvider(name: string): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const m = modelSettingsMessages(this.locale());
      const config = this.config();
      if (!(name in config.providers)) throw new UiActionError("not_found", m.noProvider(name));
      const used = config.models.filter((spec) => parseLeadModelSpec(spec).provider === name);
      if (used.length) invalid(m.providerInBrain(used));
      const fallback = loadDecisionModels(this.options.dataDir).llmFallback;
      if (fallback && parseLeadModelSpec(fallback).provider === name) {
        invalid(m.providerIsFallback(fallback));
      }
      removeLeadProviderInConfig(name, this.options.dataDir);
      this.secrets.set(providerSecretName(name), null);
      this.catalogCache = null;
      await this.options.brain.providersChanged();
      this.options.publish();
      this.options.log(`[models] provider ${name} removed`);
      return { summary: m.providerRemoved(name) };
    });
  }

  // ── 直觉 ────────────────────────────────────────────────────────────────────

  private async fastChanged(): Promise<void> {
    if (this.options.memory) await this.options.memory.decisionSettingsChanged();
    this.options.publish();
  }

  saveFastModel(request: SaveFastModelRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const locale = this.locale();
      const m = modelSettingsMessages(locale);
      const baseUrl = checkedUrl(request.baseUrl, locale);
      const host = serviceUrlHost(baseUrl);
      const current = loadDecisionModels(this.options.dataDir);
      const inputs = decisionEntryInputs(this.options.dataDir);
      let id = request.id;
      let added = false;
      if (id !== undefined) {
        if (!inputs.some((entry) => entry.id === id)) throw new UiActionError("not_found", m.noFastModel([id]));
      } else {
        if (inputs.length >= MAX_FAST_MODELS) invalid(m.tooManyFastModels(MAX_FAST_MODELS));
        id = fastModelId(request.name, new Set(inputs.map((entry) => entry.id)));
        added = true;
      }
      // 鉴权头：不给时不变（新加的是缺省），null、空的和 Authorization 是缺省。
      let authHeader: string | null = added ? null : inputs.find((candidate) => candidate.id === id)?.authHeader ?? null;
      if (request.authHeader !== undefined) {
        const headerProblem = request.authHeader === null ? null : fastModelAuthHeaderProblem(request.authHeader);
        if (headerProblem) invalid(fastModelAuthHeaderMessages(locale)[headerProblem]);
        authHeader = normalizeFastModelAuthHeader(request.authHeader);
      }
      const entry: DecisionEntryInput = { id, name: request.name.trim(), baseUrl, model: request.model, authHeader };
      const next = added ? [...inputs, entry] : inputs.map((candidate) => (candidate.id === id ? entry : candidate));
      // 还没有主用时，第一条加进来就是主用：刚开始配的人不用再去选一次。
      const chain = added && current.chain.length === 0 ? [id] : current.chain;
      writeDecisionModels(this.options.dataDir, { models: next, chain, llmFallback: current.llmFallback });
      const secret = decisionSecretName(id);
      let note: string | null = null;
      if (typeof request.apiKey === "string") {
        this.secrets.set(secret, { value: request.apiKey, host });
      } else if (request.apiKey === null) {
        this.secrets.set(secret, null);
      } else {
        const stored = this.secrets.get(secret);
        if (stored && stored.host !== host) {
          this.secrets.set(secret, null);
          note = m.keyDropped(host, stored.host);
        }
      }
      await this.fastChanged();
      this.options.log(`[models] decision model ${id} ${added ? "added" : "updated"} (${host})`);
      return { summary: added ? m.fastAdded(entry.name, host) : m.fastChanged(entry.name, host), note, id };
    });
  }

  removeFastModel(id: string): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const m = modelSettingsMessages(this.locale());
      const current = loadDecisionModels(this.options.dataDir);
      const entry = current.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new UiActionError("not_found", m.noFastModel([id]));
      if (current.chain.includes(id)) invalid(m.fastInChain(entry.name));
      writeDecisionModels(this.options.dataDir, {
        models: decisionEntryInputs(this.options.dataDir).filter((candidate) => candidate.id !== id),
        chain: current.chain, llmFallback: current.llmFallback,
      });
      this.secrets.set(decisionSecretName(id), null);
      await this.fastChanged();
      this.options.log(`[models] decision model ${id} removed`);
      return { summary: m.fastRemoved(entry.name) };
    });
  }

  setFastChain(request: SetFastChainRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const locale = this.locale();
      const m = modelSettingsMessages(locale);
      const current = loadDecisionModels(this.options.dataDir);
      const known = new Set(current.entries.map((entry) => entry.id));
      const unknown = request.chain.filter((id) => !known.has(id));
      if (unknown.length) throw new UiActionError("not_found", m.noFastModel(unknown));
      const problem = modelChainProblem(request.chain, (id) => id, { allowEmpty: true, locale });
      if (problem) invalid(problem);
      let llmFallback = current.llmFallback;
      if (request.llmFallback !== undefined) {
        llmFallback = request.llmFallback === null ? null : leadModelSpec(request.llmFallback);
        if (llmFallback) {
          try {
            await assertConfiguredLeadModel(llmFallback, this.config(), this.options.env, this.options.fetch);
          } catch (error) {
            invalid(error instanceof Error ? error.message : String(error));
          }
        }
      }
      writeDecisionModels(this.options.dataDir, {
        models: decisionEntryInputs(this.options.dataDir), chain: request.chain, llmFallback,
      });
      await this.fastChanged();
      const names = request.chain.map((id) => current.entries.find((entry) => entry.id === id)?.name ?? id);
      const [primary, ...backups] = names;
      return {
        summary: m.fastSummary(primary ?? null, backups, llmFallback),
      };
    });
  }

  async testFastModel(id: string): Promise<MemoryTestResponse> {
    const memory = this.options.memory;
    if (!memory) throw new UiActionError("unavailable", modelSettingsMessages(this.locale()).noMemoryService);
    try {
      return await memory.testDecisionEntry(id);
    } catch (error) {
      if (error instanceof MemoryError) {
        throw new UiActionError(error.code === "not_found" ? "not_found" : "invalid_input", error.message);
      }
      throw error;
    }
  }
}

export const MODEL_SETTINGS_LIMITS = { maxBackups: MODEL_MAX_BACKUPS, maxChain: MODEL_MAX_CHAIN, maxFastModels: MAX_FAST_MODELS };

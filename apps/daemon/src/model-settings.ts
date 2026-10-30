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
  leadModelSpec, MODEL_MAX_BACKUPS, MODEL_MAX_CHAIN, modelChainProblem, parseLeadModelSpec, SERVICE_URL_MESSAGES, normalizeServiceUrl,
  serviceUrlHost, serviceUrlProblem,
  type BrainModel, type FastModel, type LeadModelChoice, type MemoryTestResponse, type ModelKeySource, type ModelProvider,
  type ModelProviderApi, type ModelSettingsDto, type SaveFastModelRequest, type SaveModelProviderRequest, type SetBrainChainRequest,
  type SetFastChainRequest,
} from "@pi-lead-child/protocol";
import {
  assertConfiguredLeadModel, leadModelCatalog, loadLeadModelConfig, OPENAI_COMPATIBLE_APIS, removeLeadProviderInConfig,
  saveLeadProviderInConfig, setLeadProviderKeySource, type LeadCatalogModel, type LeadModelConfig, type LeadProviderConfig,
} from "@pi-lead-child/lead";
import { resolveEnvSpec } from "@pi-lead-child/core";
import { UiActionError, type ModelSettingsChange, type ModelSettingsService, type ModelSettingsSummary } from "@pi-lead-child/engine";
import type { SecretVault } from "@pi-lead-child/connections";
import type { Db } from "@pi-lead-child/store";
import {
  decisionEntryInputs, decisionKeyFor, decisionSecretName, loadDecisionModels, writeDecisionModels, type DecisionEntryInput,
} from "./decision-models.js";
import { MemoryError, type MemoryController } from "./memory-controller.js";
import { SealedSecrets } from "./sealed-secrets.js";

const FIRST_SEEN_KEY = "lead.model_first_seen";
const CATALOG_TTL_MS = 30_000;
const MAX_FAST_MODELS = 32;

export function providerSecretName(name: string): string {
  return `lead.provider.${name}`;
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

function checkedUrl(raw: string): string {
  const problem = serviceUrlProblem(raw);
  if (problem) invalid(SERVICE_URL_MESSAGES[problem]);
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
  private catalogCache: { at: number; value: Promise<Map<string, { models: LeadCatalogModel[]; problem: string | null }>> } | null = null;

  constructor(private readonly options: ModelSettingsOptions) {
    this.secrets = new SealedSecrets<string>(options.db, options.vault);
    // Lead 的会话、查找会话、Hindsight 的 LLM 取服务商的 key 时先问这里：页面存的、绑定现在主机的那一个。
    setLeadProviderKeySource((name, provider) => this.storedProviderKey(name, provider)?.value ?? null);
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
    let stored;
    try {
      stored = this.secrets.get(providerSecretName(name));
    } catch (error) {
      this.options.log(`[models] provider key for ${name} cannot be opened: ${error instanceof Error ? error.name : "Error"}`);
      return null;
    }
    const host = serviceUrlHost(provider.baseUrl);
    return stored && host && stored.host === host ? { value: stored.value, host } : null;
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

  private catalogs(config: LeadModelConfig): Promise<Map<string, { models: LeadCatalogModel[]; problem: string | null }>> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.value;
    const value = (async () => {
      const result = new Map<string, { models: LeadCatalogModel[]; problem: string | null }>();
      await Promise.all(Object.entries(config.providers).map(async ([name, provider]) => {
        const one: LeadModelConfig = { providers: { [name]: provider }, models: [] };
        const catalog = await leadModelCatalog(one, this.options.env, this.options.fetch);
        const failed = catalog.notes.find((note) => note.startsWith(`${name}: no models`) || note.startsWith(`${name}: discover failed`));
        result.set(name, { models: catalog.models, problem: failed ? failed.slice(name.length + 2).slice(0, 500) : null });
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
  private recordFirstSeen(catalogs: Map<string, { models: LeadCatalogModel[]; problem: string | null }>): FirstSeen {
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
      const catalog = catalogs.get(name) ?? { models: [], problem: null };
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
        };
      });
      // 最新发布的在前面；不知道时间的排在最后，按 id。
      models.sort((a, b) => (b.released?.at ?? "").localeCompare(a.released?.at ?? "") || a.id.localeCompare(b.id));
      return {
        name, baseUrl: provider.baseUrl, api: (provider.api ?? "openai-completions") as ModelProviderApi,
        keySet: key.set, keySource: key.source, keyHost: key.host, models, problem: catalog.problem,
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
        apiKeyHost: key?.host ?? storedHost, problem: entry.problem,
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
      const problem = modelChainProblem(request.models, (choice) => choice.model);
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
        summary: `大脑：主用 ${primary}${backups.length ? `，备用 ${backups.join("、")}` : "，没有备用"}`,
        applied,
        note: applied === "after_turn" ? "Lead 正在回答，这一轮结束后换主用。" : null,
      };
    });
  }

  saveProvider(request: SaveModelProviderRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      if (!(OPENAI_COMPATIBLE_APIS as readonly string[]).includes(request.api)) invalid(`接口格式只能是 ${OPENAI_COMPATIBLE_APIS.join("、")}`);
      const baseUrl = checkedUrl(request.baseUrl);
      const host = serviceUrlHost(baseUrl);
      const existed = request.name in this.config().providers;
      const { droppedConfigKey } = saveLeadProviderInConfig(request.name, { baseUrl, api: request.api }, serviceUrlHost, this.options.dataDir);
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
          notes.push(`地址换到了 ${host}，原来的 key 只给 ${stored.host}，已经删掉。`);
        }
      }
      if (droppedConfigKey) notes.push("地址换了主机，config.json 里原来的 key 已经删掉。");
      this.catalogCache = null;
      await this.options.brain.providersChanged();
      this.options.publish();
      this.options.log(`[models] provider ${request.name} ${existed ? "updated" : "added"} (${host})`);
      return {
        summary: existed ? `改了服务商 ${request.name}（${host}）` : `接入了服务商 ${request.name}（${host}）`,
        note: notes.length ? notes.join("") : null,
      };
    });
  }

  removeProvider(name: string): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const config = this.config();
      if (!(name in config.providers)) throw new UiActionError("not_found", `没有这个服务商：${name}`);
      const used = config.models.filter((spec) => parseLeadModelSpec(spec).provider === name);
      if (used.length) invalid(`大脑的分工里还在用 ${used.join("、")}。先在「现在的分工」里换掉，再删服务商。`);
      const fallback = loadDecisionModels(this.options.dataDir).llmFallback;
      if (fallback && parseLeadModelSpec(fallback).provider === name) {
        invalid(`直觉都用不了时问的是 ${fallback}。先换掉它，再删服务商。`);
      }
      removeLeadProviderInConfig(name, this.options.dataDir);
      this.secrets.set(providerSecretName(name), null);
      this.catalogCache = null;
      await this.options.brain.providersChanged();
      this.options.publish();
      this.options.log(`[models] provider ${name} removed`);
      return { summary: `删掉了服务商 ${name}` };
    });
  }

  // ── 直觉 ────────────────────────────────────────────────────────────────────

  private async fastChanged(): Promise<void> {
    if (this.options.memory) await this.options.memory.decisionSettingsChanged();
    this.options.publish();
  }

  saveFastModel(request: SaveFastModelRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const baseUrl = checkedUrl(request.baseUrl);
      const host = serviceUrlHost(baseUrl);
      const current = loadDecisionModels(this.options.dataDir);
      const inputs = decisionEntryInputs(this.options.dataDir);
      let id = request.id;
      let added = false;
      if (id !== undefined) {
        if (!inputs.some((entry) => entry.id === id)) throw new UiActionError("not_found", `没有这条直觉：${id}`);
      } else {
        if (inputs.length >= MAX_FAST_MODELS) invalid(`直觉最多 ${MAX_FAST_MODELS} 条`);
        id = fastModelId(request.name, new Set(inputs.map((entry) => entry.id)));
        added = true;
      }
      const entry: DecisionEntryInput = { id, name: request.name.trim(), baseUrl, model: request.model };
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
          note = `地址换到了 ${host}，原来的 key 只给 ${stored.host}，已经删掉。`;
        }
      }
      await this.fastChanged();
      this.options.log(`[models] decision model ${id} ${added ? "added" : "updated"} (${host})`);
      return { summary: added ? `添加了直觉 ${entry.name}（${host}）` : `改了直觉 ${entry.name}（${host}）`, note, id };
    });
  }

  removeFastModel(id: string): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const current = loadDecisionModels(this.options.dataDir);
      const entry = current.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new UiActionError("not_found", `没有这条直觉：${id}`);
      if (current.chain.includes(id)) invalid(`${entry.name} 还在直觉的分工里。先在「现在的分工」里移出，再删。`);
      writeDecisionModels(this.options.dataDir, {
        models: decisionEntryInputs(this.options.dataDir).filter((candidate) => candidate.id !== id),
        chain: current.chain, llmFallback: current.llmFallback,
      });
      this.secrets.set(decisionSecretName(id), null);
      await this.fastChanged();
      this.options.log(`[models] decision model ${id} removed`);
      return { summary: `删掉了直觉 ${entry.name}` };
    });
  }

  setFastChain(request: SetFastChainRequest): Promise<ModelSettingsChange> {
    return this.serial(async () => {
      const current = loadDecisionModels(this.options.dataDir);
      const known = new Set(current.entries.map((entry) => entry.id));
      const unknown = request.chain.filter((id) => !known.has(id));
      if (unknown.length) throw new UiActionError("not_found", `没有这条直觉：${unknown.join("、")}`);
      const problem = modelChainProblem(request.chain, (id) => id, { allowEmpty: true });
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
        summary: (primary ? `直觉：主用 ${primary}${backups.length ? `，备用 ${backups.join("、")}` : "，没有备用"}` : "直觉：不用决策模型，判断都问大脑")
          + `；都用不了时问 ${llmFallback ?? "系统选的大脑模型"}`,
      };
    });
  }

  async testFastModel(id: string): Promise<MemoryTestResponse> {
    const memory = this.options.memory;
    if (!memory) throw new UiActionError("unavailable", "这台 daemon 没有托管记忆服务，测不了决策模型");
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

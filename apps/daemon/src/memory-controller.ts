// Lead 的记忆设置（设置页「Lead → 记忆 / 模型」，2026-10-16 用户决定）。daemon 里唯一管 Hindsight 的地方。
//
// 设置：
// - embedding：本地模型（用户选了才在后台下载）或者 OpenAI 兼容的远程接口。还没选时有远程配置就用远程，
//   否则 Hindsight 不启动，记忆只用 SQLite 全文检索。
// - reranker：决策模型（缺省，Jev 或者用户自建的兼容端点；没有 key 时退到「不用」）、本地模型（选了才下载）或者不用。
// - 决策模型：baseUrl、model、key。SmartModel 也用它。
// 非密钥的设置存在 config.json（memory、decision 两段）。密钥（远程 embedding 的 key、决策模型的 key、
// Hindsight 自己的 key、pg0 的密码）加密存进 kv（保险库，packages/connections 的 vault），不进 config.json 的明文，
// 也不进 process.env：child 继承 daemon 的全部环境。
//
// 地址和 key（2026-10-16 发布评审）：
// - 地址都走 protocol 的 serviceUrlProblem：http 或 https、不带用户名密码、查询参数里没有像密钥的名字。
//   内网的 gateway 可以用 http（2026-10-26），设置页提示明文传输。
//   写 config.json 之前校验；读的时候也校验，不合法时当作没配置，并在 service.message / problem 里说明。
// - key 绑定主机：存 key 时记下主机，只发给这个主机。baseUrl 换到别的主机、请求里又没带新 key 时，旧 key 删掉。
//   Keychain 或环境变量里的 TYPESAFE_API_KEY 只发给 api.typesafe.ai。
//
// 切换（热重载）：只重启 Hindsight 这个 launchd 任务，daemon 和 Lead 不动；重启的几秒里 search_notes 退回全文检索。
// - 自动切换，事后告诉用户：换本地 reranker、换决策模型的 key、第一次启用 embedding（还没有索引）、关掉 Hindsight。
// - 要用户确认：
//   - 已经有索引时换 embedding（建新库、全部笔记重新提取：每条一次 LLM 调用，重建完之前召回不完整）；
//   - 笔记要发给新的接收方：从本地换成远程 embedding，或者换了远程的主机；
//   - 开始用外部的决策模型做 reranker（每次召回把查询和最多 N 条记忆片段发给它的主机）。这一项单独等确认：
//     其余不用确认的部分先生效，reranker 先保持现在的（或者不用）。
// - 用户拒绝时，设置退回到正在用的那一个（embedding；外部 reranker 退成「不用」），下次 reconcile 不会再问。
// 确认只能来自用户（POST /v1/memory/switches/:id/confirm，Lead 的工具走不到）。要确认的切换和切换的结果都经
// 收件箱交给 Lead（Jarvis 模式：Lead 决定怎样告诉用户；要确认时它发一张 MemorySwitchConfirm 卡）。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeServiceUrl,
  redactSecretText,
  SERVICE_URL_MESSAGES,
  serviceUrlHost,
  serviceUrlProblem,
  type DecisionModelDto,
  type DecisionModelSettingsRequest,
  type MemoryDataFlow,
  type MemoryDownload,
  type MemoryHindsightDto,
  MEMORY_INVALIDATED_LIMIT,
  type MemorySettingsDto,
  type MemorySettingsRequest,
  type MemorySwitch,
  type MemorySwitchConfirmResponse,
  type MemoryTestResponse,
  type SetSummaryModelRequest,
  type SummaryModelSlot,
} from "@pi-lead-child/protocol";
import { loadPlcConfig, writePlcConfig, type PlcMemoryConfig } from "@pi-lead-child/core";
import {
  HindsightBackend, invalidatedMemoryFacts, memoryBackendSetting, UiActionError,
  type DecisionModelCredentials, type MemorySettingsChange, type MemorySettingsService, type MemorySettingsSummary, type NotesMemory,
} from "@pi-lead-child/engine";
import type { SecretVault } from "@pi-lead-child/connections";
import { addInbox, type Db } from "@pi-lead-child/store";
import {
  describeEmbedding, describeReranker, embeddingFingerprint, ensureHindsightService, findUvx, hindsightDir, ModelDownloads,
  readServiceFile, uninstallHindsightService,
  type EnsureHindsightOptions, type HindsightEmbedding, type HindsightEndpoint, type HindsightLlmTarget, type HindsightReranker,
  type HindsightSecrets, type ModelDownloadState, type ModelKind,
} from "@pi-lead-child/supervisor";
import type { DecisionModelService, MemoryService } from "@pi-lead-child/gateway";
import type { SummaryModelChoice, SummaryModels, SummaryModelSettings } from "./memory-backend.js";
import { SealedSecrets } from "./sealed-secrets.js";
import {
  DEFAULT_DECISION_BASE_URL, decisionEntryInputs, decisionKeyFor, decisionSecretName, loadDecisionModels, primaryDecision,
  writeDecisionModels, type DecisionEntry, type DecisionSecretName,
} from "./decision-models.js";

// 决策模型的缺省值和 Keychain 的 key 只给的主机，定义在 decision-models.ts（设置 → 模型的「直觉」也用）。
export { DEFAULT_DECISION_BASE_URL, DEFAULT_DECISION_MODEL, TYPESAFE_HOST } from "./decision-models.js";

// 本地模型的缺省值，各固定到一个 commit（2026-10-16 发布评审：只用 safetensors，固定版本）。
// 中文要多语言模型（Hindsight 缺省的模型只支持英文）。BAAI/bge-m3 的 main 上只有 pytorch_model.bin（pickle），
// 所以 embedding 用 intfloat/multilingual-e5-large（MIT，safetensors，1024 维，约 2.2 GB）。
// reranker 用 Hindsight 多语言文档里较轻的那个（约 0.5 GB，支持中文）。
export const DEFAULT_LOCAL_EMBEDDING = "intfloat/multilingual-e5-large";
export const DEFAULT_LOCAL_RERANKER = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
export const PINNED_MODEL_REVISIONS: Readonly<Record<string, string>> = {
  [DEFAULT_LOCAL_EMBEDDING]: "3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3",
  [DEFAULT_LOCAL_RERANKER]: "1427fd652930e4ba29e8149678df786c240d8825",
};
// 决策模型做 reranker 时，每次召回最多发给它的候选记忆条数（2026-10-16 发布评审：Hindsight 缺省 300，太多）。
// config.json 的 memory.reranker.maxCandidates 可以改，范围 1–300。
export const DEFAULT_RERANK_MAX_CANDIDATES = 50;
const MAX_RERANK_CANDIDATES = 300;
// hindsight-main 解开 secrets.sealed 用的附加数据（AAD）。
export const HINDSIGHT_SECRETS_AAD = "hindsight-secrets";

export function hindsightSecretsPath(dataDir: string): string {
  return join(hindsightDir(dataDir), "secrets.sealed");
}

// 路由按 code 选 HTTP 状态，并把 code 放进 error.details.reason（gateway 的 memory-routes.ts）。
export type MemoryErrorCode = "invalid_request" | "invalid_url" | "key_host_mismatch" | "not_found" | "not_pending" | "unavailable";

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message);
  }
}

// 加密存在 kv 里的密钥（sealed-secrets.ts，和外部通道的令牌共用）。Hindsight 自己的 key 和 pg0 的密码只在本机用，host 是 null。
// 决策模型的 key 一条一个（decision-models.ts 的 decisionSecretName）：jev 是 decision.apiKey，别的是 decision.apiKey.<id>。
type SecretName = "hindsight.apiKey" | "hindsight.databasePassword" | "memory.embedding.apiKey" | DecisionSecretName;

interface Desired {
  embedding: HindsightEmbedding | null;
  reranker: HindsightReranker;
}

interface StoredSwitch extends MemorySwitch {
  desired: Desired;
}

// 决策模型的配置。地址不合法时 baseUrl 和 host 是 null，problem 说明原因。
interface DecisionConfig {
  baseUrl: string | null;
  host: string | null;
  model: string;
  problem: string | null;
}

// 远程 embedding 的配置。地址不合法时是 null，problem 说明原因。
interface RemoteConfig {
  embedding: Extract<HindsightEmbedding, { provider: "openai" }> | null;
  host: string | null;
  problem: string | null;
}

interface Confirmation {
  reason: string;
  dataFlows: MemoryDataFlow[];
  // embedding 那一部分要确认。为 false 时只差外部 reranker：其余部分先生效。
  embeddingPart: boolean;
}

export interface MemoryControllerOptions {
  db: Db;
  dataDir: string;
  vault: SecretVault;
  memory: NotesMemory;
  log: (line: string) => void;
  // 设置或状态变了：网关发 snapshot.required。
  publish: (resource: "memory" | "decision-model") => void;
  // 决策模型的 key 的其他来源（Keychain、daemon 专用的环境变量）。保险库里没有时用它，只发给 api.typesafe.ai。
  externalSecret: (name: string) => string | null;
  // Hindsight 的两个摘要模型、地址和 key（memory-backend.ts 的 summaryModels），按设置页的选择算。
  summaryModels: (settings: SummaryModelSettings) => Promise<SummaryModels>;
  // launchd 运行 hindsight-main 的命令。
  programArguments: string[];
  env?: Record<string, string | undefined>;
  // 测试注入。
  ensure?: (options: EnsureHindsightOptions) => Promise<HindsightEndpoint | null>;
  stopService?: () => Promise<void>;
  downloads?: (onChange: (repo: string, state: ModelDownloadState) => void) => ModelDownloads;
  fetch?: typeof fetch;
  healthIntervalMs?: number;
}

// 测试替换的部分（server.ts 的 DaemonOpts.manageMemory）。
export type MemoryControllerHooks = Partial<Pick<MemoryControllerOptions,
  "ensure" | "stopService" | "downloads" | "fetch" | "env" | "summaryModels" | "externalSecret" | "healthIntervalMs">>;

const json = (value: unknown) => JSON.stringify(value);

// 存下的切换去掉 desired 就是 DTO。早先存的切换没有 dataFlows 或 parts：按「在等 embedding」读，和以前界面的理解一样。
function switchDto(stored: StoredSwitch): MemorySwitch {
  const { desired: _desired, ...dto } = stored;
  return { ...dto, dataFlows: dto.dataFlows ?? [], parts: dto.parts ?? ["embedding"] };
}
const digest = (secrets: HindsightSecrets) => createHash("sha256").update(json(secrets)).digest("hex");
const rerankHost = (reranker: HindsightReranker) => reranker.provider === "typesafe" ? serviceUrlHost(reranker.baseUrl) : null;
const embeddingHost = (embedding: HindsightEmbedding | null) =>
  embedding?.provider === "openai" ? serviceUrlHost(embedding.baseUrl) : null;
const sameEmbedding = (a: HindsightEmbedding | null, b: HindsightEmbedding | null) =>
  (a === null || b === null) ? a === b : embeddingFingerprint(a) === embeddingFingerprint(b);
const target = (choice: SummaryModelChoice | undefined): HindsightLlmTarget | null =>
  choice?.llm ? { provider: choice.llm.provider, baseUrl: choice.llm.baseUrl, model: choice.llm.model } : null;
// 交给 Hindsight 的摘要模型。整理观察只在单独选了、而且和缺省不同的时候才给：否则 Hindsight 用缺省。
function llmTargets(models: SummaryModels | null): { default: HindsightLlmTarget | null; consolidation: HindsightLlmTarget | null } {
  const fallback = target(models?.default);
  const consolidation = models?.consolidation.source === "settings" ? target(models.consolidation) : null;
  return { default: fallback, consolidation: fallback && consolidation && json(consolidation) !== json(fallback) ? consolidation : null };
}
const SLOT_LABEL: Record<SummaryModelSlot, string> = { default: "缺省摘要模型", consolidation: "整理观察的模型" };

export class MemoryController implements MemoryService {
  private readonly secrets: SealedSecrets<SecretName>;
  private readonly downloads: ModelDownloads;
  private readonly env: Record<string, string | undefined>;
  // secretsDigest：交给 Hindsight 的密钥的指纹。只换 key（远程 embedding 或者决策模型）时期望状态不变，
  // 靠它发现要重新加密、重启服务。
  // llmTargets：交给 Hindsight 的摘要模型（不含 key）。只换摘要模型时期望状态不变，靠它发现要重启服务。
  private applied: (Desired & { endpoint: HindsightEndpoint; backend: HindsightBackend; secretsDigest: string; llmTargets: string }) | null = null;
  // 最近一次算出的摘要模型。设置页的概要（summary）用它，不为了概要去拉模型目录。
  private lastModels: SummaryModels | null = null;
  private serviceState: "off" | "starting" | "healthy" | "down" = "off";
  private serviceMessage: string | null = null;
  // 没起来的期望状态（launchctl 失败）。健康检查按它重试，直到服务起来或者设置变了。
  private retry: Desired | null = null;
  private lastProgressPublish = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private loggedBackendSetting = false;
  // 同一时刻只做一次切换：设置、下载完成、确认可能同时来。
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MemoryControllerOptions) {
    this.env = options.env ?? process.env;
    this.secrets = new SealedSecrets<SecretName>(options.db, options.vault);
    const onDownload = (repo: string, state: ModelDownloadState) => this.onDownload(repo, state);
    this.downloads = options.downloads?.(onDownload) ?? new ModelDownloads({
      dataDir: options.dataDir, uvx: findUvx(this.env), onChange: onDownload, log: options.log,
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  // daemon 启动时调一次：接着下没下完的模型（关掉 Hindsight 时不下），让 Hindsight 处在期望状态。
  async start(): Promise<void> {
    if (!this.off()) this.downloads.resume();
    await this.serial(() => this.reconcile("startup"));
    this.healthTimer = setInterval(() => void this.checkHealth(), this.healthIntervalMs());
    this.healthTimer.unref?.();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.downloads.stopAll();
  }

  // PLC_MEMORY_BACKEND=sqlite 关掉 Hindsight。不认识的值也当作 sqlite（说一次）：比如 off，用户的意思是关掉。
  private off(): boolean {
    try {
      return memoryBackendSetting(this.env) === "sqlite";
    } catch (error) {
      if (!this.loggedBackendSetting) {
        this.loggedBackendSetting = true;
        this.options.log(`[memory] ${error instanceof Error ? error.message : String(error)}; treating it as sqlite (Hindsight off)`);
      }
      return true;
    }
  }

  private config(): PlcMemoryConfig {
    return loadPlcConfig(this.options.dataDir).memory ?? {};
  }

  // 记忆的重排和旧路由（/v1/decision-model）用的那一条：直觉的主用（设置 → 模型，2026-10-29 spec D8、D9）。
  // 分工是空的（不用直觉）时是第一条，只给旧路由显示；inChain 为 false，重排不用它。
  private decisionEntry(): { entry: DecisionEntry; inChain: boolean } {
    const models = loadDecisionModels(this.options.dataDir);
    const primary = primaryDecision(models);
    if (primary) return { entry: primary, inChain: true };
    const first = models.entries[0];
    if (first) return { entry: first, inChain: false };
    return {
      entry: { id: "jev", name: "jev", baseUrl: DEFAULT_DECISION_BASE_URL, host: serviceUrlHost(DEFAULT_DECISION_BASE_URL), model: "jev-latest", problem: null },
      inChain: false,
    };
  }

  private decision(): DecisionConfig {
    const { entry, inChain } = this.decisionEntry();
    if (!inChain) return { baseUrl: null, host: null, model: entry.model, problem: "直觉没有主用（设置 → 模型）" };
    return { baseUrl: entry.baseUrl, host: entry.host, model: entry.model, problem: entry.problem };
  }

  // 主用的 key：设置页存的（绑定 host），否则 Keychain / 环境变量里的（只给 api.typesafe.ai）。
  private decisionKey(host: string | null = this.decision().host): { value: string; source: "settings" | "external"; host: string } | null {
    return decisionKeyFor({ id: this.decisionEntry().entry.id, host }, this.secrets, this.options.externalSecret);
  }

  private remote(): RemoteConfig {
    const remote = this.config().embedding?.remote;
    if (!remote) return { embedding: null, host: null, problem: null };
    const problem = typeof remote.baseUrl === "string" ? serviceUrlProblem(remote.baseUrl) : "invalid_url";
    if (problem) return { embedding: null, host: null, problem: `config.json 的远程 embedding 地址：${SERVICE_URL_MESSAGES[problem]}` };
    return {
      embedding: { provider: "openai", baseUrl: normalizeServiceUrl(remote.baseUrl)!, model: remote.model, dimensions: remote.dimensions ?? null },
      host: serviceUrlHost(remote.baseUrl),
      problem: null,
    };
  }

  private embeddingKey(host: string | null): string | null {
    const stored = this.secrets.get("memory.embedding.apiKey");
    return stored && host && stored.host === host ? stored.value : null;
  }

  // config.json 是用户能直接改的文件：不是 1–300 的整数时用缺省值。
  private rerankMaxCandidates(): number {
    const value = this.config().reranker?.maxCandidates;
    if (value === undefined) return DEFAULT_RERANK_MAX_CANDIDATES;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_RERANK_CANDIDATES) return value;
    this.options.log(`[memory] memory.reranker.maxCandidates must be an integer from 1 to ${MAX_RERANK_CANDIDATES}; using ${DEFAULT_RERANK_MAX_CANDIDATES}`);
    return DEFAULT_RERANK_MAX_CANDIDATES;
  }

  // 用决策模型做 reranker：有 key 时才用，否则不用。
  private decisionReranker(): HindsightReranker {
    const decision = this.decision();
    return decision.baseUrl && this.decisionKey(decision.host)
      ? { provider: "typesafe", baseUrl: decision.baseUrl, model: decision.model, maxCandidates: this.rerankMaxCandidates() }
      : { provider: "none" };
  }

  // 本地模型：repo 和固定的 commit。用户自己填的 repo 没有固定的 commit，下载时把 main 解析成一个。
  private localModel(kind: ModelKind): { model: string; revision: string | null } {
    const config = this.config();
    const model = (kind === "embedding" ? config.embedding?.local?.model : config.reranker?.local?.model)
      ?? (kind === "embedding" ? DEFAULT_LOCAL_EMBEDDING : DEFAULT_LOCAL_RERANKER);
    return { model, revision: PINNED_MODEL_REVISIONS[model] ?? null };
  }

  // 按设置、下载和密钥算出期望状态。startDownloads 时顺便开始用户选了、还没下的本地模型。
  private desired(startDownloads = true): Desired {
    if (this.off()) return { embedding: null, reranker: { provider: "none" } };
    const config = this.config();
    let embedding: HindsightEmbedding | null;
    if (config.embedding?.mode === "local") {
      const { model, revision } = this.localModel("embedding");
      if (startDownloads) this.ensureDownload(model, "embedding", revision);
      const snapshot = this.downloads.snapshot(model, revision);
      // 下好之前接着用现在的（第一次启用时就是没有）。
      embedding = snapshot ? { provider: "local", model, ...snapshot } : this.applied?.embedding ?? null;
    } else {
      embedding = this.remote().embedding;
    }
    let reranker: HindsightReranker;
    const mode = config.reranker?.mode ?? "decision";
    if (mode === "none") {
      reranker = { provider: "none" };
    } else if (mode === "local") {
      const { model, revision } = this.localModel("reranker");
      if (startDownloads) this.ensureDownload(model, "reranker", revision);
      const snapshot = this.downloads.snapshot(model, revision);
      // 下好之前接着用现在的本地 reranker，或者不用。不悄悄换成外部的决策模型。
      const current = this.applied?.reranker;
      reranker = snapshot ? { provider: "local", model, ...snapshot } : current?.provider === "local" ? current : { provider: "none" };
    } else {
      reranker = this.decisionReranker();
    }
    return { embedding, reranker };
  }

  private ensureDownload(model: string, kind: ModelKind, revision: string | null): void {
    const state = this.downloads.status(model);
    // 失败过的不自动重试：用户在设置页再保存一次就会重试（update 里先清掉失败）。固定的 commit 变了时重新下。
    if (state?.state === "failed" || state?.state === "downloading") return;
    if (!this.downloads.ready(model, revision)) this.downloads.start(model, kind, revision);
  }

  private pending(): StoredSwitch | null {
    const row = this.options.db.prepare("SELECT value FROM kv WHERE key = 'memory.pendingSwitch'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as StoredSwitch;
    } catch {
      return null;
    }
  }

  private savePending(value: StoredSwitch | null): void {
    if (!value) {
      this.options.db.prepare("DELETE FROM kv WHERE key = 'memory.pendingSwitch'").run();
      return;
    }
    this.options.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('memory.pendingSwitch', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(json(value));
  }

  private supersede(pending: StoredSwitch): void {
    this.savePending({ ...pending, state: "superseded" });
    addInbox(this.options.db, {
      dedupScope: `memory-switch:${pending.id}:resolved`, severity: "attention", source: "structural",
      summary: `记忆切换 ${pending.id} 作废了：设置又变了（${pending.summary}）。不用再请用户确认这一个。`,
      payload: { kind: "memory_switch", switch: pending.id, state: "superseded", wakeLead: false, needsUser: false },
    });
  }

  // 这个切换新增的数据外发：和正在用的比，笔记的内容开始发给哪些新主机。
  private dataFlows(next: Desired): MemoryDataFlow[] {
    const flows: MemoryDataFlow[] = [];
    const current = this.applied;
    const embedding = embeddingHost(next.embedding);
    if (embedding && embedding !== embeddingHost(current?.embedding ?? null)) {
      flows.push({ kind: "embedding", host: embedding, maxCandidates: null });
    }
    const rerank = next.embedding ? rerankHost(next.reranker) : null;
    if (rerank && rerank !== (current?.embedding ? rerankHost(current.reranker) : null) && next.reranker.provider === "typesafe") {
      flows.push({ kind: "rerank", host: rerank, maxCandidates: next.reranker.maxCandidates });
    }
    return flows;
  }

  // 这次切换要不要用户确认，以及为什么。null 表示不用确认。
  private confirmation(next: Desired): Confirmation | null {
    const reasons: string[] = [];
    const current = this.applied?.embedding ?? null;
    const target = next.embedding;
    const flows = this.dataFlows(next);
    let embeddingPart = false;
    if (current && target && !sameEmbedding(current, target)) {
      const { notes, indexed } = this.options.memory.progress();
      const embeddingFlow = flows.find((flow) => flow.kind === "embedding");
      if (embeddingFlow) reasons.push(`全部 ${notes} 条笔记会发给 ${embeddingFlow.host}`);
      if (indexed > 0) reasons.push(`要为 ${notes} 条笔记重建索引：每条一次 LLM 调用，重建完之前按意思召回不完整`);
      embeddingPart = reasons.length > 0;
    }
    const rerank = flows.find((flow) => flow.kind === "rerank");
    if (rerank) {
      reasons.push(`每次召回会把查询和最多 ${rerank.maxCandidates} 条记忆片段发给 ${rerank.host}。`
        + "要停止：在设置页把 reranker 设为「不用」或「本地」");
    }
    if (!reasons.length) return null;
    // 第一次启用远程 embedding 不用确认：地址是用户自己填的。只列出确实要确认的外发。
    const dataFlows = flows.filter((flow) => flow.kind === "rerank" || embeddingPart);
    return { reason: reasons.join("；"), dataFlows, embeddingPart };
  }

  private summary(next: Desired): string {
    const parts: string[] = [];
    if (!sameEmbedding(next.embedding, this.applied?.embedding ?? null)) {
      parts.push(next.embedding ? `embedding 换成${describeEmbedding(next.embedding)}` : "关掉 Hindsight，记忆只用全文检索");
    }
    if (next.embedding && json(next.reranker) !== json(this.applied?.reranker ?? null)) {
      parts.push(`reranker 换成${describeReranker(next.reranker)}`);
    }
    return parts.join("，") || "更新了记忆服务用的密钥";
  }

  // 让 Hindsight 处在期望状态：一样时什么也不做；要确认时记下待切换并告诉 Lead；否则马上切换。
  private async reconcile(origin: "startup" | "settings" | "download"): Promise<void> {
    // daemon 重启时 Hindsight 一般还在跑（它是独立的 launchd 任务）。先重新连上它：ensure 在期望状态没变时不重启服务。
    // 然后再和新的期望状态比较：daemon 停着的时候用户可能改了 config.json。
    if (origin === "startup" && !this.applied) {
      const running = this.runningService();
      if (running && !this.off()) await this.apply(running, { reconnect: true });
    }
    const next = this.desired();
    // 同一个期望状态正在重试：不重新判断，不再要用户确认一次。设置变了：不再重试旧的，
    // 并且不能把旧设置当作「没变」，因为服务没在跑。
    const retrying = this.retry !== null;
    if (retrying && json(this.retry) === json(next)) return;
    this.retry = null;
    const pending = this.pending();
    if (pending && pending.state === "pending" && json(pending.desired) !== json(next)) {
      // 设置又变了：旧的待切换作废，按新的重新判断。
      this.supersede(pending);
    }
    // 只有服务在跑时才要比较密钥和摘要模型：关着记忆启动 daemon 时不去查 provider 的模型列表。
    const models = this.applied ? await this.modelsSafely() : null;
    const unchanged = retrying ? false : this.applied
      ? json({ embedding: this.applied.embedding, reranker: this.applied.reranker }) === json(next)
        && this.applied.secretsDigest === digest(this.secretsFor(next, models, false))
        && this.applied.llmTargets === json(llmTargets(models))
      : next.embedding === null;
    if (unchanged) {
      if (next.embedding === null && origin === "startup") await this.stopService();
      this.options.publish("memory");
      return;
    }
    const confirmation = this.confirmation(next);
    if (confirmation) {
      const existing = this.pending();
      if (existing?.state === "pending" && json(existing.desired) === json(next)) return;
      if (!confirmation.embeddingPart) {
        // 只差外部 reranker：其余部分先生效，reranker 保持现在的（外部的不算）或者不用。
        const current = this.applied?.reranker;
        const interim: Desired = { embedding: next.embedding, reranker: current && current.provider !== "typesafe" ? current : { provider: "none" } };
        const appliedDesired = this.applied ? { embedding: this.applied.embedding, reranker: this.applied.reranker } : null;
        if (json(interim) !== json(appliedDesired)) await this.apply(interim);
      }
      const id = `msw_${randomBytes(9).toString("base64url")}`;
      const summary = this.summary(next);
      // 在等确认、还没生效的部分。只差外部 reranker 时，embedding 上面已经先生效了。
      const reranker = json(next.reranker) !== json(this.applied?.reranker ?? { provider: "none" });
      const parts: MemorySwitch["parts"] = [...(confirmation.embeddingPart ? ["embedding" as const] : []), ...(reranker ? ["reranker" as const] : [])];
      this.savePending({
        id, summary, reason: confirmation.reason, dataFlows: confirmation.dataFlows, parts, needsConfirmation: true,
        state: "pending", createdAt: new Date().toISOString(), desired: next,
      });
      addInbox(this.options.db, {
        dedupScope: `memory-switch:${id}`, severity: "attention", source: "structural", lossless: true,
        summary: `记忆切换要用户确认：${summary}。原因：${confirmation.reason}。用 render_ui 发一张 MemorySwitchConfirm 卡`
          + `（switch 填 ${id}）请用户决定，一两句话说明原因；你不能替用户确认。用户也可以在设置页 → Lead → 记忆里确认。`,
        payload: { kind: "memory_switch", switch: id, state: "pending", wakeLead: true, needsUser: false },
      });
      this.options.log(`[memory] switch ${id} waits for the user: ${summary} (${confirmation.reason})`);
      this.options.publish("memory");
      return;
    }
    const summary = this.summary(next);
    await this.apply(next);
    if (origin !== "startup") {
      addInbox(this.options.db, {
        dedupScope: "memory-switch", severity: "attention", source: "structural",
        summary: `记忆已切换：${summary}。不需要用户做什么，有机会时顺带告诉用户一句即可。`,
        payload: { kind: "memory_switch", state: "applied", wakeLead: false, needsUser: false },
      });
    }
  }

  // 上次应用的期望状态（service.json）。服务没装、或者是旧格式（本地模型没有快照目录）时是 null。
  private runningService(): Desired | null {
    const service = readServiceFile(this.options.dataDir);
    if (!service) return null;
    const localWithoutPath = (part: { provider: string; path?: unknown }) => part.provider === "local" && typeof part.path !== "string";
    if (localWithoutPath(service.embedding) || localWithoutPath(service.reranker)) return null;
    return { embedding: service.embedding, reranker: service.reranker };
  }

  private generated(name: "hindsight.apiKey" | "hindsight.databasePassword", make: () => string): string {
    const existing = this.secrets.get(name);
    if (existing) return existing.value;
    const value = make();
    this.secrets.set(name, { value, host: null });
    return value;
  }

  // 正在用的密钥（secrets.sealed）。没有或者解不开时是 null。
  private sealed(): HindsightSecrets | null {
    const path = hindsightSecretsPath(this.options.dataDir);
    try {
      return existsSync(path) ? this.options.vault.open<HindsightSecrets>(readFileSync(path), HINDSIGHT_SECRETS_AAD) : null;
    } catch {
      return null;
    }
  }

  // hindsight-main 要的密钥。每个外部 key 只给它绑定的主机。
  // reconnect（daemon 重启后接上正在跑的服务）时，远程 embedding 的 key 沿用 secrets.sealed 里的：
  // 设置里的 key 可能属于一个还在等用户确认的新端点。
  private secretsFor(next: Desired, models: SummaryModels | null, reconnect: boolean): HindsightSecrets {
    const sealed = reconnect ? this.sealed() : null;
    const embeddingApiKey = next.embedding?.provider !== "openai" ? null
      : sealed ? sealed.embeddingApiKey ?? null : this.embeddingKey(embeddingHost(next.embedding));
    const decisionApiKey = next.reranker.provider === "typesafe" ? this.decisionKey(rerankHost(next.reranker))?.value ?? null : null;
    const targets = llmTargets(models);
    const llmApiKey = models?.default.llm?.apiKey ?? null;
    const consolidationLlmApiKey = targets.consolidation ? models?.consolidation.llm?.apiKey ?? null : null;
    return {
      // daemon 第一次初始化 Hindsight 时生成（2026-10-16 用户决定）。之后连接和启动都用它。
      apiKey: this.generated("hindsight.apiKey", () => randomUUID()),
      databasePassword: this.generated("hindsight.databasePassword", () => randomBytes(24).toString("base64url")),
      ...(embeddingApiKey ? { embeddingApiKey } : {}),
      ...(decisionApiKey ? { decisionApiKey } : {}),
      ...(llmApiKey ? { llmApiKey } : {}),
      ...(consolidationLlmApiKey ? { consolidationLlmApiKey } : {}),
    };
  }

  // 把密钥加密写进 secrets.sealed。内容没变时不重写，版本不变，服务不会因此重启。
  private sealSecrets(secrets: HindsightSecrets): number {
    const path = hindsightSecretsPath(this.options.dataDir);
    const versionRow = this.options.db.prepare("SELECT value FROM kv WHERE key = 'hindsight.secretsVersion'").get() as { value: string } | undefined;
    let version = Number(versionRow?.value ?? 0);
    if (json(this.sealed()) !== json(secrets)) {
      mkdirSync(hindsightDir(this.options.dataDir), { recursive: true, mode: 0o700 });
      writeFileSync(path, this.options.vault.seal(secrets, HINDSIGHT_SECRETS_AAD), { mode: 0o600 });
      version += 1;
      this.options.db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES ('hindsight.secretsVersion', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ).run(String(version));
    }
    return version;
  }

  // Hindsight 的摘要模型。解析失败时不提取新事实，召回照常。
  private async modelsSafely(): Promise<SummaryModels | null> {
    try {
      this.lastModels = await this.options.summaryModels(this.config().llm ?? {});
      return this.lastModels;
    } catch (error) {
      this.options.log(`[memory] no LLM for Hindsight: ${redactSecretText(error instanceof Error ? error.message : String(error))}`);
      return null;
    }
  }

  private async stopService(): Promise<void> {
    await (this.options.stopService ?? (() => uninstallHindsightService()))();
    this.options.memory.setBackend(null);
    this.options.memory.setUnavailable(null);
    this.applied = null;
    this.serviceState = "off";
  }

  private async apply(next: Desired, { reconnect = false }: { reconnect?: boolean } = {}): Promise<void> {
    if (!next.embedding) {
      this.retry = null;
      await this.stopService();
      this.serviceMessage = null;
      this.options.log("[memory] Hindsight is off; Lead memory uses notes full-text search only");
      this.options.publish("memory");
      return;
    }
    const models = await this.modelsSafely();
    const targets = llmTargets(models);
    const secrets = this.secretsFor(next, models, reconnect);
    const secretsVersion = this.sealSecrets(secrets);
    let endpoint: HindsightEndpoint | null;
    try {
      endpoint = await (this.options.ensure ?? ensureHindsightService)({
        dataDir: this.options.dataDir, programArguments: this.options.programArguments,
        embedding: next.embedding, reranker: next.reranker,
        llm: targets.default, consolidationLlm: targets.consolidation, observations: true, secretsVersion,
        env: this.env, log: this.options.log,
      });
    } catch (error) {
      // 服务没起来：状态说「停了」和原因，不再往旧索引推笔记，健康检查接着重试（2026-10-26）。
      const reason = redactSecretText(error instanceof Error ? error.message : String(error));
      const message = `记忆服务没有起来：${reason}。每 ${Math.round(this.healthIntervalMs() / 1000)} 秒自动重试一次，现在只用全文检索`;
      if (message !== this.serviceMessage) this.options.log(`[memory] Hindsight did not start: ${reason}; retrying`);
      this.retry = next;
      this.options.memory.setBackend(null);
      this.options.memory.setUnavailable(`记忆服务没有起来：${reason}`);
      this.serviceState = "down";
      this.serviceMessage = message;
      this.options.publish("memory");
      throw new MemoryError("unavailable", `记忆服务没有起来：${reason}`);
    }
    this.retry = null;
    if (!endpoint) {
      this.applied = null;
      this.serviceState = "off";
      this.serviceMessage = "没有找到 uv（uvx），Hindsight 起不来。装上 uv 之后重启 daemon。";
      this.options.memory.setBackend(null);
      this.options.memory.setUnavailable("没有找到 uv（uvx），Hindsight 起不来");
      this.options.publish("memory");
      return;
    }
    // 有摘要模型时 Hindsight 整理观察（ensure 的 observations），召回时也要观察。
    const backend = new HindsightBackend({
      baseUrl: endpoint.url, apiKey: secrets.apiKey, index: endpoint.index, observations: targets.default !== null,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    this.options.memory.setBackend(backend);
    this.applied = { ...next, endpoint, backend, secretsDigest: digest(secrets), llmTargets: json(targets) };
    this.serviceState = endpoint.restarted ? "starting" : "healthy";
    this.options.memory.setUnavailable(endpoint.restarted ? "记忆服务正在启动" : null);
    this.serviceMessage = null;
    this.options.publish("memory");
    void this.checkHealth();
  }

  private healthIntervalMs(): number {
    return this.options.healthIntervalMs ?? 15_000;
  }

  private async checkHealth(): Promise<void> {
    const retry = this.retry;
    if (retry) {
      // 设置在这期间变了时，retry 已经被新的切换替换或清空。
      await this.serial(() => (this.retry === retry ? this.apply(retry) : Promise.resolve())).catch(() => {});
      return;
    }
    const applied = this.applied;
    if (!applied?.backend) return;
    const healthy = await applied.backend.healthy();
    const next = healthy ? "healthy" : this.serviceState === "starting" ? "starting" : "down";
    if (next !== this.serviceState) {
      this.serviceState = next;
      this.options.memory.setUnavailable(next === "healthy" ? null : next === "starting" ? "记忆服务正在启动" : "记忆服务停了（健康检查不通）");
      this.options.publish("memory");
    }
  }

  private onDownload(repo: string, state: ModelDownloadState): void {
    if (state.state === "downloading") {
      // 进度最多一秒发一次事件：每个事件都让客户端重新 GET /v1/memory。
      const now = Date.now();
      if (now - this.lastProgressPublish < 1_000) return;
      this.lastProgressPublish = now;
      this.options.publish("memory");
      return;
    }
    this.options.publish("memory");
    if (state.state === "ready") {
      void this.serial(() => this.reconcile("download")).catch((error: unknown) => {
        const message = redactSecretText(error instanceof Error ? error.message : String(error));
        this.options.log(`[memory] switching after the download of ${repo} failed: ${message}`);
        this.serviceMessage = `${repo} 下好了，但切换失败：${message}`;
        this.options.publish("memory");
      });
    } else if (state.state === "failed") {
      addInbox(this.options.db, {
        dedupScope: `memory-download:${repo}`, severity: "attention", source: "structural",
        summary: `本地模型 ${repo} 下载失败：${state.error ?? "未知原因"}。用户可以在设置页 → Lead → 记忆里重试，或者换成远程。`,
        payload: { kind: "memory_download", model: repo, state: "failed", wakeLead: true, needsUser: false },
      });
    }
  }

  private download(model: string): MemoryDownload {
    const state = this.downloads.status(model);
    return {
      model,
      state: state?.state ?? "idle",
      bytes: Math.max(0, Math.round(state?.bytes ?? 0)),
      total: Math.max(0, Math.round(state?.total ?? 0)),
      error: state?.error ?? null,
    };
  }

  get(): MemorySettingsDto {
    const config = this.config();
    const embedding = config.embedding ?? {};
    const reranker = config.reranker ?? {};
    const embeddingModel = this.localModel("embedding").model;
    const rerankerModel = this.localModel("reranker").model;
    const applied = this.applied;
    const effective = applied?.reranker.provider ?? "none";
    const pending = this.pending();
    const pendingDto = pending ? switchDto(pending) : null;
    const remote = this.remote();
    const storedEmbeddingKey = this.secrets.get("memory.embedding.apiKey");
    const decision = this.decision();
    // 按设置算：开着 Hindsight、reranker 用决策模型并且有 key 时，召回会把数据发出去。
    const plan = this.desired(false);
    const external = plan.embedding && plan.reranker.provider === "typesafe"
      ? { host: rerankHost(plan.reranker) ?? decision.host ?? "", maxCandidates: plan.reranker.maxCandidates }
      : null;
    const writes = this.options.memory.writeStatus();
    const problems = [
      this.serviceMessage, remote.problem, reranker.mode !== "none" ? decision.problem : null,
      writes.failed ? `${writes.failed} 条笔记没写进 Hindsight（${writes.lastError ?? "原因不明"}），按意思召回不到它们` : null,
    ].filter(Boolean);
    return {
      embedding: {
        mode: embedding.mode ?? "unset",
        local: { model: embeddingModel, download: this.download(embeddingModel) },
        remote: {
          // 不合法的地址不回显：它可能带着用户名、密码或者 key。
          baseUrl: remote.embedding?.baseUrl ?? null,
          model: embedding.remote?.model ?? null,
          dimensions: embedding.remote?.dimensions ?? null,
          apiKeySet: this.embeddingKey(remote.host) !== null,
          apiKeyHost: storedEmbeddingKey?.host ?? null,
        },
      },
      reranker: {
        mode: reranker.mode ?? "decision",
        effective: effective === "typesafe" ? "decision" : effective,
        local: { model: rerankerModel, download: this.download(rerankerModel) },
        external: external?.host ? external : null,
      },
      service: {
        state: applied || this.retry ? this.serviceState : "off",
        embedding: applied?.embedding ? describeEmbedding(applied.embedding) : null,
        reranker: applied ? describeReranker(applied.reranker) : null,
        index: this.options.memory.progress(),
        message: problems.length ? problems.join("；") : null,
        backend: this.off() ? "sqlite" : "hindsight",
      },
      pendingSwitch: pending && pending.state === "pending" ? pendingDto as MemorySwitch : null,
    };
  }

  update(request: MemorySettingsRequest): Promise<MemorySettingsDto> {
    return this.serial(async () => {
      const file = loadPlcConfig(this.options.dataDir);
      const memory: PlcMemoryConfig = structuredClone(file.memory ?? {});
      if (request.embedding) {
        const embedding = { ...(memory.embedding ?? {}) };
        embedding.mode = request.embedding.mode;
        if (request.embedding.mode === "local") {
          const model = request.embedding.model ?? embedding.local?.model ?? DEFAULT_LOCAL_EMBEDDING;
          embedding.local = { model };
          this.retryFailedDownload(model, "embedding");
        } else if (request.embedding.mode === "remote") {
          const baseUrl = this.checkedUrl(request.embedding.baseUrl);
          const host = serviceUrlHost(baseUrl)!;
          embedding.remote = { baseUrl, model: request.embedding.model, dimensions: request.embedding.dimensions ?? null };
          // key 只发给存它时的主机。换了主机又没带新 key：旧 key 删掉。
          if (request.embedding.apiKey) {
            this.secrets.set("memory.embedding.apiKey", { value: request.embedding.apiKey, host });
          } else if (this.secrets.get("memory.embedding.apiKey")?.host !== host) {
            this.secrets.set("memory.embedding.apiKey", null);
          }
        }
        memory.embedding = embedding;
      }
      if (request.reranker) {
        const reranker = { ...(memory.reranker ?? {}) };
        reranker.mode = request.reranker.mode;
        if (request.reranker.mode === "local") {
          const model = request.reranker.model ?? reranker.local?.model ?? DEFAULT_LOCAL_RERANKER;
          reranker.local = { model };
          this.retryFailedDownload(model, "reranker");
        }
        memory.reranker = reranker;
      }
      writePlcConfig({ ...file, memory }, this.options.dataDir);
      await this.reconcile("settings");
      return this.get();
    });
  }

  // 校验并规范化一个地址。不合法时抛 invalid_url，消息和设置页客户端的检查用同一句话。
  private checkedUrl(raw: string): string {
    const problem = serviceUrlProblem(raw);
    if (problem) throw new MemoryError("invalid_url", SERVICE_URL_MESSAGES[problem]);
    return normalizeServiceUrl(raw)!;
  }

  private retryFailedDownload(model: string, kind: ModelKind): void {
    if (this.downloads.status(model)?.state === "failed") this.downloads.start(model, kind, PINNED_MODEL_REVISIONS[model] ?? null);
  }

  // 发一次请求测试连接：不跟随重定向（key 不能被带到别的主机），错误信息里盖掉像密钥的字符串。
  private async probe(url: string, key: string | null, body: unknown, check: (res: Response) => Promise<MemoryTestResponse>): Promise<MemoryTestResponse> {
    const started = Date.now();
    try {
      const res = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: json(body),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}`, latencyMs: Date.now() - started };
      return await check(res);
    } catch (error) {
      let message = redactSecretText(error instanceof Error ? error.message : String(error));
      if (key) message = message.split(key).join("[REDACTED]");
      return { ok: false, message, latencyMs: null };
    }
  }

  async test(): Promise<MemoryTestResponse> {
    const remote = this.remote();
    if (remote.problem) throw new MemoryError("invalid_url", remote.problem);
    if (!remote.embedding) throw new MemoryError("invalid_request", "还没有配置远程 embedding");
    const stored = this.secrets.get("memory.embedding.apiKey");
    if (stored && stored.host !== remote.host) {
      throw new MemoryError("key_host_mismatch", `存的 key 属于 ${stored.host}，不会发给 ${remote.host}。先保存，或者重新粘贴 key。`);
    }
    const { baseUrl, model, dimensions } = remote.embedding;
    const started = Date.now();
    return this.probe(`${baseUrl}/embeddings`, stored?.value ?? null,
      { model, input: "pi-lead-child connection test", ...(dimensions ? { dimensions } : {}) },
      async (res) => {
        const body = await res.json() as { data?: Array<{ embedding?: unknown }> };
        const vector = body.data?.[0]?.embedding;
        if (!Array.isArray(vector)) return { ok: false, message: "响应里没有 embedding", latencyMs: Date.now() - started };
        return { ok: true, message: `返回 ${vector.length} 维向量`, latencyMs: Date.now() - started };
      });
  }

  confirmSwitch(id: string, approve: boolean, resolvedBy: string): Promise<MemorySwitchConfirmResponse> {
    return this.serial(async () => {
      const pending = this.pending();
      if (!pending || pending.id !== id) throw new MemoryError("not_found", "没有这个待切换");
      if (pending.state === "superseded") throw new MemoryError("not_pending", "设置已经变了，这个切换作废");
      if (pending.state !== "pending") throw new MemoryError("not_pending", "这个切换已经处理过了");
      if (json(this.desired()) !== json(pending.desired)) {
        // 卡片发出之后设置又变了：这张卡作废，按新设置重新判断。
        await this.reconcile("settings");
        throw new MemoryError("not_pending", "设置已经变了，这个切换作废");
      }
      this.savePending({ ...pending, state: approve ? "applied" : "rejected" });
      if (approve) {
        await this.apply(pending.desired);
      } else {
        this.revertRejected(pending);
        // 同一次保存里不用确认的部分照常生效。
        await this.reconcile("settings");
      }
      addInbox(this.options.db, {
        dedupScope: `memory-switch:${id}:resolved`, severity: "attention", source: "structural", lossless: true,
        summary: approve
          ? `${resolvedBy} 确认了记忆切换，已经切换：${pending.summary}。`
          : `${resolvedBy} 选择先不切换：${pending.summary}。记忆照旧。`,
        payload: { kind: "memory_switch", switch: id, state: approve ? "applied" : "rejected", wakeLead: true, needsUser: false },
      });
      this.options.log(`[memory] switch ${id} ${approve ? "applied" : "rejected"} by ${resolvedBy}`);
      this.options.publish("memory");
      return { memory: this.get(), switch: this.getSwitch(id) };
    });
  }

  getSwitch(id: string): MemorySwitch {
    const stored = this.pending();
    if (!stored || stored.id !== id) throw new MemoryError("not_found", "没有这个切换：daemon 只记最近的一个");
    return switchDto(stored);
  }

  // 用户拒绝切换：设置退回到正在用的那一个，设置页和实际一致，下次 reconcile 也不会再问。
  // - embedding：从本地换远程被拒时，填过的远程配置和 key 留着；从远程 A 换远程 B 被拒时，退回 A 的配置和 key。
  // - 外部 reranker 被拒：reranker 设成「不用」（正在用本地 reranker 时设成「本地」）。
  private revertRejected(pending: StoredSwitch): void {
    const file = loadPlcConfig(this.options.dataDir);
    const memory: PlcMemoryConfig = structuredClone(file.memory ?? {});
    const applied = this.applied?.embedding;
    if (applied && !sameEmbedding(applied, pending.desired.embedding)) {
      const embedding = { ...(memory.embedding ?? {}) };
      if (applied.provider === "local") {
        embedding.mode = "local";
        embedding.local = { model: applied.model };
      } else {
        embedding.mode = "remote";
        embedding.remote = { baseUrl: applied.baseUrl, model: applied.model, dimensions: applied.dimensions };
        const key = this.sealed()?.embeddingApiKey;
        this.secrets.set("memory.embedding.apiKey", key ? { value: key, host: serviceUrlHost(applied.baseUrl) } : null);
      }
      memory.embedding = embedding;
    }
    if ((pending.dataFlows ?? []).some((flow) => flow.kind === "rerank")) {
      memory.reranker = { ...(memory.reranker ?? {}), mode: this.applied?.reranker.provider === "local" ? "local" : "none" };
    }
    writePlcConfig({ ...file, memory }, this.options.dataDir);
  }

  // —— 决策模型（DecisionModelService）——

  // SmartModel 每次调用时读它（server.ts 传给 Lead 会话）。没有 key 或者地址不合法时是 null，SmartModel 只用 LLM。
  // key 只经这个函数交给 Lead 的进程内代码，不进 process.env；它只发给绑定的主机。
  decisionCredentials(): DecisionModelCredentials | null {
    const decision = this.decision();
    const key = this.decisionKey(decision.host);
    return decision.baseUrl && key ? { baseUrl: decision.baseUrl, model: decision.model, apiKey: key.value, keyHost: key.host } : null;
  }

  // 直觉的整条分工（主用在前）。SmartModel 按这个顺序问，都失败时问 LLM。没有 key 或者地址不合法的那一条跳过。
  decisionChainCredentials(): DecisionModelCredentials[] {
    const models = loadDecisionModels(this.options.dataDir);
    const credentials: DecisionModelCredentials[] = [];
    for (const id of models.chain) {
      const entry = models.entries.find((candidate) => candidate.id === id);
      if (!entry?.baseUrl) continue;
      const key = decisionKeyFor(entry, this.secrets, this.options.externalSecret);
      if (key) credentials.push({ baseUrl: entry.baseUrl, model: entry.model, apiKey: key.value, keyHost: key.host });
    }
    return credentials;
  }

  // 设置 → 模型改了直觉（model-settings.ts）：设置页、记忆页重新取，重排跟着主用换（往新主机发召回内容时要确认）。
  decisionSettingsChanged(): Promise<void> {
    return this.serial(async () => {
      this.options.publish("decision-model");
      await this.reconcile("settings");
    });
  }

  getDecisionModel(): DecisionModelDto {
    const decision = this.decision();
    const key = this.decisionKey(decision.host);
    return {
      baseUrl: decision.baseUrl,
      model: decision.model,
      apiKeySet: key !== null,
      apiKeySource: key?.source ?? null,
      apiKeyHost: key?.host ?? this.secrets.get(decisionSecretName(this.decisionEntry().entry.id))?.host ?? null,
      problem: decision.problem,
    };
  }

  // 旧路由（/v1/decision-model/settings）：改直觉的主用（分工是空的时改第一条）。
  updateDecisionModel(request: DecisionModelSettingsRequest): Promise<DecisionModelDto> {
    return this.serial(async () => {
      const target = this.decisionEntry().entry;
      const models = loadDecisionModels(this.options.dataDir);
      const inputs = decisionEntryInputs(this.options.dataDir).map((entry) => (entry.id === target.id ? {
        ...entry,
        ...(request.baseUrl ? { baseUrl: this.checkedUrl(request.baseUrl) } : {}),
        ...(request.model ? { model: request.model } : {}),
      } : entry));
      const updated = inputs.find((entry) => entry.id === target.id);
      const host = serviceUrlHost(updated?.baseUrl ?? DEFAULT_DECISION_BASE_URL);
      writeDecisionModels(this.options.dataDir, { models: inputs, chain: models.chain, llmFallback: models.llmFallback });
      // key 只发给存它时的主机。换了主机又没带新 key：旧 key 删掉。
      const secret = decisionSecretName(target.id);
      if (typeof request.apiKey === "string") {
        this.secrets.set(secret, { value: request.apiKey, host });
      } else if (request.apiKey === null || (this.secrets.get(secret) && this.secrets.get(secret)?.host !== host)) {
        this.secrets.set(secret, null);
      }
      this.options.publish("decision-model");
      // reranker 用决策模型时跟着换。开始往一个新主机发召回内容时要用户确认。
      await this.reconcile("settings");
      return this.getDecisionModel();
    });
  }

  // 旧路由（/v1/decision-model/test）：测直觉的主用（分工是空的时测第一条）。
  testDecisionModel(): Promise<MemoryTestResponse> {
    return this.testDecisionEntry(this.decisionEntry().entry.id);
  }

  // 测一条直觉（设置 → 模型的「测试」，model-settings.ts）：用它存的 key 发一次很小的判断。key 只发给它绑定的主机。
  async testDecisionEntry(id: string): Promise<MemoryTestResponse> {
    const entry = loadDecisionModels(this.options.dataDir).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new MemoryError("not_found", `没有这条决策模型：${id}`);
    if (!entry.baseUrl) throw new MemoryError("invalid_url", entry.problem ?? "决策模型的地址不合法");
    const key = decisionKeyFor(entry, this.secrets, this.options.externalSecret);
    if (!key) {
      const stored = this.secrets.get(decisionSecretName(entry.id));
      if (stored && stored.host !== entry.host) {
        throw new MemoryError("key_host_mismatch", `存的 key 属于 ${stored.host}，不会发给 ${entry.host}。先保存，或者重新粘贴 key。`);
      }
      throw new MemoryError("invalid_request", `${entry.name} 还没有 key`);
    }
    const started = Date.now();
    return this.probe(`${entry.baseUrl}/v1/systemone`, key.value,
      { state: "This is a connection test.", model: entry.model, questions: { ok: { type: "noul", instructions: "Is this a connection test?" } } },
      async () => ({ ok: true, message: "决策模型可用", latencyMs: Date.now() - started }));
  }

  // —— 摘要模型和写入（MemorySettingsService，操作层的 memory_settings）——

  private slotDtos(models: SummaryModels | null): MemoryHindsightDto["summaryModels"] {
    const settings = this.config().llm ?? {};
    return (["default", "consolidation"] as const).map((slot) => {
      const choice = models?.[slot];
      return choice
        ? { slot, model: choice.spec, source: choice.source, setting: choice.setting, problem: choice.problem }
        : { slot, model: null, source: "none" as const, setting: settings[slot] ?? null, problem: models ? null : "还没有算出摘要模型（读不到 Lead 的模型目录）" };
    });
  }

  // list_actions 的概要：不拉模型目录，用最近一次算出的摘要模型。
  settingsSummary(): MemorySettingsSummary {
    return { enabled: !this.off(), summaryModels: this.slotDtos(this.lastModels), writes: this.options.memory.writeStatus() };
  }

  // 设置页的整份：现在的摘要模型（按设置重新算）、写入情况、记忆库的统计。
  async hindsight(): Promise<MemoryHindsightDto> {
    const models = await this.modelsSafely();
    const stats = this.applied && this.serviceState === "healthy" ? await this.options.memory.stats(AbortSignal.timeout(3_000)) : null;
    return {
      enabled: !this.off(), summaryModels: this.slotDtos(models), writes: this.options.memory.writeStatus(), stats,
      // 现在失效着的事实（2026-10-29）：设置页列出来，能恢复（操作层的 memory_fact / <编号> / restore）。
      invalidated: invalidatedMemoryFacts(this.options.db, MEMORY_INVALIDATED_LIMIT),
    };
  }

  // 选一个槽的摘要模型。模型要在 Lead 的模型目录里（设置 → 模型的服务商）。存进 config.json 的 memory.llm，
  // 然后按新的期望状态重启记忆服务（reconcile 比较 llmTargets）。
  setSummaryModel(request: SetSummaryModelRequest): Promise<MemorySettingsChange> {
    return this.serial(async () => {
      if (request.model !== null) {
        const models = await this.options.summaryModels({ ...(this.config().llm ?? {}), [request.slot]: request.model });
        const choice = models[request.slot];
        if (choice.source !== "settings" && choice.source !== "env") {
          throw new UiActionError("invalid_input", choice.problem ?? `${request.model} 用不了`);
        }
      }
      const file = loadPlcConfig(this.options.dataDir);
      const memory: PlcMemoryConfig = structuredClone(file.memory ?? {});
      memory.llm = { ...(memory.llm ?? {}), [request.slot]: request.model };
      writePlcConfig({ ...file, memory }, this.options.dataDir);
      const before = this.applied?.llmTargets ?? null;
      await this.reconcile("settings");
      const models = this.lastModels;
      const restarted = this.applied !== null && before !== null && this.applied.llmTargets !== before;
      const label = SLOT_LABEL[request.slot];
      const summary = request.model === null
        ? `${label}改回${request.slot === "default" ? "自动（最新的 haiku）" : "跟缺省一样"}`
        : `${label}改成 ${request.model}`;
      const notes = [
        restarted ? "记忆服务正在重启，几秒里召回只用全文检索" : null,
        this.off() ? "记忆后端现在不是 Hindsight：选择存下了，启用 Hindsight 后生效" : null,
        models?.[request.slot].source === "env" || (request.slot === "default" && this.env.PLC_HINDSIGHT_LLM?.trim())
          ? "daemon 的环境变量 PLC_HINDSIGHT_LLM 盖住了缺省槽的选择" : null,
      ].filter(Boolean);
      this.options.log(`[memory] summary model: ${summary}`);
      this.options.publish("memory");
      return { summary, note: notes.length ? notes.join("；") : null };
    });
  }

  // 测一个槽现在用的摘要模型：用它的服务商发一次很小的补全（OpenAI 兼容的 /chat/completions）。key 只发给这个服务商。
  async testSummaryModel(slot: SummaryModelSlot): Promise<MemoryTestResponse> {
    const models = await this.modelsSafely();
    const llm = models?.[slot].llm;
    if (!llm) throw new UiActionError("unavailable", `${SLOT_LABEL[slot]}现在没有可用的模型`);
    const started = Date.now();
    return this.probe(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, llm.apiKey,
      { model: llm.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 5 },
      async (res) => {
        const body = await res.json() as { choices?: unknown };
        if (!Array.isArray(body.choices)) return { ok: false, message: "响应里没有 choices", latencyMs: Date.now() - started };
        return { ok: true, message: `${llm.provider}/${llm.model} 可用`, latencyMs: Date.now() - started };
      });
  }

  async retryFailedWrites(): Promise<MemorySettingsChange> {
    const count = this.options.memory.retryFailed();
    this.options.publish("memory");
    return count
      ? { summary: `${count} 条写入失败的笔记重新排队`, note: "Hindsight 会重新处理它们；原因没修好时还会失败" }
      : { summary: "没有写入失败的笔记", note: null };
  }

  memorySettingsService(): MemorySettingsService {
    return {
      summary: () => this.settingsSummary(),
      hindsight: () => this.hindsight(),
      setSummaryModel: (request) => this.setSummaryModel(request),
      testSummaryModel: (slot) => this.testSummaryModel(slot),
      retryFailedWrites: () => this.retryFailedWrites(),
    };
  }

  // 网关的 DecisionModelService 接口按名字调用这三个方法。
  decisionModelService(): DecisionModelService {
    return {
      get: () => this.getDecisionModel(),
      update: (request) => this.updateDecisionModel(request),
      test: () => this.testDecisionModel(),
    };
  }
}

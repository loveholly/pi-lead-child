// Hindsight（github.com/vectorize-io/hindsight，MIT）的记忆后端。用官方客户端 @vectorize-io/hindsight-client 1.0.0
// 生成的接口（sdk），和服务端版本一致（.scratch/hindsight-primary-memory/spec.md D12）。用到的接口：
// retain（异步，带我们生成的任务编号）、查任务和重试任务、recall（事实和观察）、删文档、单条事实失效、/stats、/health。
// 服务由 supervisor 的 hindsight 托管（独立的 launchd 任务），这里只是客户端。
import { createClient, createConfig, sdk } from "@vectorize-io/hindsight-client";
import { redactSecretText } from "@pi-lead-child/protocol";
import type { NoteKind } from "@pi-lead-child/store";
import {
  MemoryNotFoundError, MemoryRejectedError,
  type MemoryBackend, type MemoryFactInfo, type MemoryHit, type MemoryHitType, type MemoryItem, type MemoryOperationStatus, type MemoryStats,
} from "./backend.js";

// Hindsight 拒收内容时的状态码。401、403（key 不对）和 404 不算：那是配置的问题，不是某条笔记的问题。
const REJECTED_STATUS = new Set([400, 413, 415, 422]);

export interface HindsightBackendOptions {
  // 服务地址，例如 http://127.0.0.1:47188。
  baseUrl: string;
  // 服务开了 API key 认证时的 key。只放进 Authorization 头，不进日志和错误信息。
  apiKey?: string;
  // 记忆库。不存在时 Hindsight 在第一次写入时创建它。
  bank?: string;
  // 记忆库的身份（supervisor 的 ensureHindsightService 按库地址算出）。
  index?: string;
  // 召回观察（Hindsight 打开了观察整理时）。关着时只召回事实。
  observations?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const HINDSIGHT_DEFAULT_BANK = "plc-lead";
const BANK = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ERROR_CHARS = 200;
// 观察的来源事实最多取这么多 token：只用来找回笔记。
const SOURCE_FACT_TOKENS = 2048;

function kindTag(kind: NoteKind): string {
  return `kind:${kind}`;
}

const EXTERNAL_TAG = "origin:external";

// 生成的接口返回 { data, error, response }，不抛错。
interface SdkResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

const RESULT_TYPES = new Set<MemoryHitType>(["world", "experience", "observation"]);

interface RawResult {
  id?: unknown; text?: unknown; type?: unknown; document_id?: unknown; source_fact_ids?: unknown; tags?: unknown;
  occurred_start?: unknown; mentioned_at?: unknown; scores?: { final?: unknown } | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export class HindsightBackend implements MemoryBackend {
  readonly name = "hindsight";
  readonly index: string | undefined;
  private readonly bank: string;
  private readonly timeoutMs: number;
  private readonly observations: boolean;
  private readonly client: ReturnType<typeof createClient>;

  constructor(private readonly options: HindsightBackendOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Hindsight URL must be http or https: ${url.protocol}`);
    }
    this.bank = options.bank ?? HINDSIGHT_DEFAULT_BANK;
    if (!BANK.test(this.bank)) throw new Error(`Hindsight bank id is not valid: ${this.bank}`);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.observations = options.observations ?? true;
    this.index = options.index;
    this.client = createClient(createConfig({
      baseUrl: url.toString().replace(/\/+$/, ""),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiKey ? { headers: { authorization: `Bearer ${options.apiKey}` } } : {}),
    }));
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private path<T extends Record<string, string>>(extra?: T): { bank_id: string } & T {
    return { bank_id: this.bank, ...(extra ?? {}) } as { bank_id: string } & T;
  }

  // 请求失败时抛错：拒收内容是 MemoryRejectedError，别的是 Error。错误信息不带 key（key 只在请求头里）。
  private fail(what: string, result: SdkResult<unknown>): never {
    const status = result.response?.status ?? 0;
    const raw = result.error === undefined ? "" : typeof result.error === "string" ? result.error : JSON.stringify(result.error);
    const detail = redactSecretText(raw ?? "").slice(0, MAX_ERROR_CHARS);
    const message = `Hindsight ${what} failed: HTTP ${status}${detail ? ` ${detail}` : ""}`;
    throw REJECTED_STATUS.has(status) ? new MemoryRejectedError(message, status) : new Error(message);
  }

  // 发给 Hindsight 的文字都先经 redactSecretText 脱敏（2026-10-16 发布评审）：Hindsight 把笔记交给 LLM 提取事实、
  // 交给 embedding（可能是远程的），召回时把查询和候选记忆交给 reranker。全文检索仍然读 SQLite 里的原文。
  // async：Hindsight 马上返回，事实提取在它的后台做。同一个 document_id 再写一次就替换旧的内容（replace）。
  // 观察按来源整理（spec D14）：observation_scopes 是 [[origin:<来源>]]，用户本人的笔记在一个范围里整理（跨 kind 的矛盾也能合并），
  // 外部通道整理来的在另一个范围里。Hindsight 只在同一个标签范围内合并观察（observations.mdx），所以别人说的话
  // 不会和用户的偏好合成一条观察。kind 标签留在事实上，召回时按它过滤。
  async remember(item: MemoryItem, opts: { operationId: string; signal?: AbortSignal }): Promise<void> {
    const result = await sdk.retainMemories({
      client: this.client,
      path: this.path(),
      body: {
        async: true,
        operation_id: opts.operationId,
        items: [{
          content: redactSecretText(item.content),
          timestamp: item.occurredAt,
          context: redactSecretText(item.context),
          document_id: item.sourceKey,
          metadata: { kind: item.kind },
          tags: [kindTag(item.kind), `origin:${item.origin}`],
          update_mode: "replace",
          observation_scopes: [[`origin:${item.origin}`]],
        }],
      },
      signal: this.signal(opts.signal),
    }) as SdkResult<{ operation_id?: string | null }>;
    if (!result.response?.ok) this.fail("retain", result);
  }

  async operation(operationId: string, signal?: AbortSignal): Promise<MemoryOperationStatus> {
    const result = await sdk.getOperationStatus({
      client: this.client, path: this.path({ operation_id: operationId }), signal: this.signal(signal),
    }) as SdkResult<{ status?: unknown; error_message?: unknown }>;
    if (result.response?.status === 404) return { state: "gone", error: null };
    if (!result.response?.ok) this.fail("operation status", result);
    const status = result.data?.status;
    const error = str(result.data?.error_message);
    if (status === "completed") return { state: "completed", error: null };
    if (status === "failed") return { state: "failed", error: error ?? "failed" };
    if (status === "cancelled") return { state: "failed", error: error ?? "cancelled" };
    return { state: "pending", error: null };
  }

  async retryOperation(operationId: string, signal?: AbortSignal): Promise<void> {
    const result = await sdk.retryOperation({
      client: this.client, path: this.path({ operation_id: operationId }), signal: this.signal(signal),
    }) as SdkResult<unknown>;
    if (!result.response?.ok) this.fail("retry operation", result);
  }

  // 有观察时：事实和观察一起召回，观察取代它整理的那些事实（prefer_observations）。按 kind 过滤时只要事实：
  // 观察的范围只有来源标签，没有 kind 标签。观察的来源笔记从 source_facts 的 document_id 找。
  async recall(query: string, opts: { limit: number; kind?: NoteKind; signal?: AbortSignal }): Promise<MemoryHit[]> {
    const withObservations = this.observations && !opts.kind;
    const result = await sdk.recallMemories({
      client: this.client,
      path: this.path(),
      body: {
        query: redactSecretText(query),
        budget: "mid",
        max_tokens: 4096,
        types: withObservations ? ["world", "experience", "observation"] : ["world", "experience"],
        ...(withObservations ? { prefer_observations: true } : {}),
        include: { entities: null, ...(withObservations ? { source_facts: { max_tokens: SOURCE_FACT_TOKENS } } : {}) },
        ...(opts.kind ? { tags: [kindTag(opts.kind)], tags_match: "any_strict" as const } : {}),
      },
      signal: this.signal(opts.signal),
    }) as SdkResult<{ results?: unknown; source_facts?: Record<string, RawResult> | null }>;
    // 记忆库在第一次写入时才建。还没写过时召回不到任何东西，不算错误。
    if (result.response?.status === 404) return [];
    if (!result.response?.ok) this.fail("recall", result);
    const results = result.data?.results;
    if (!Array.isArray(results)) throw new Error("Hindsight recall returned no results array");
    const sources = result.data?.source_facts ?? {};
    const hits: MemoryHit[] = [];
    for (const raw of results as RawResult[]) {
      if (typeof raw.text !== "string") continue;
      const type = RESULT_TYPES.has(raw.type as MemoryHitType) ? raw.type as MemoryHitType : null;
      const own = str(raw.document_id);
      const fromFacts = Array.isArray(raw.source_fact_ids)
        ? raw.source_fact_ids.map((id) => (typeof id === "string" ? str(sources[id]?.document_id) : null))
        : [];
      hits.push({
        id: str(raw.id),
        type,
        text: raw.text,
        sourceKeys: [...new Set([own, ...fromFacts].filter((key): key is string => key !== null))],
        occurredAt: str(raw.occurred_start) ?? str(raw.mentioned_at),
        external: Array.isArray(raw.tags) && raw.tags.includes(EXTERNAL_TAG),
        score: typeof raw.scores?.final === "number" ? raw.scores.final : null,
      });
      if (hits.length >= opts.limit) break;
    }
    return hits;
  }

  // 删文档时，Hindsight 一起删掉由它提取的事实，以及由这些事实整理出的观察（observations.mdx「When Memories Are Deleted」）。
  async forget(sourceKeys: string[], signal?: AbortSignal): Promise<void> {
    for (const key of sourceKeys) {
      const result = await sdk.deleteDocument({
        client: this.client, path: this.path({ document_id: key }), signal: this.signal(signal),
      }) as SdkResult<unknown>;
      if (!result.response?.ok && result.response?.status !== 404) this.fail("delete document", result);
    }
  }

  // 只有 world、experience 事实能失效；观察由事实推出，Hindsight 不让改（PATCH memories/{id} 的说明）。
  // 先读这条记忆：确认它在、是事实，并拿到它的文档编号（调用方按来源笔记判断能不能改）。
  async invalidate(memoryId: string, opts: {
    reason: string; restore?: boolean; signal?: AbortSignal; guard?: (fact: MemoryFactInfo) => void;
  }): Promise<MemoryFactInfo> {
    const found = await sdk.getMemory({
      client: this.client, path: this.path({ memory_id: memoryId }), signal: this.signal(opts.signal),
    }) as SdkResult<{ type?: unknown; fact_type?: unknown; document_id?: unknown; text?: unknown; tags?: unknown }>;
    const status = found.response?.status;
    if (status === 404 || status === 400) throw new MemoryNotFoundError(`Hindsight has no memory ${memoryId}`);
    if (!found.response?.ok) this.fail("get memory", found);
    const type = found.data?.fact_type ?? found.data?.type;
    if (type === "observation") {
      throw new MemoryNotFoundError(`memory ${memoryId} is an observation; observations are derived and cannot be invalidated`);
    }
    const tags = Array.isArray(found.data?.tags) ? found.data.tags.filter((tag): tag is string => typeof tag === "string") : null;
    const fact: MemoryFactInfo = {
      sourceKey: str(found.data?.document_id), text: str(found.data?.text), external: tags ? tags.includes(EXTERNAL_TAG) : null,
    };
    opts.guard?.(fact);
    const result = await sdk.updateMemory({
      client: this.client,
      path: this.path({ memory_id: memoryId }),
      body: { state: opts.restore ? "valid" : "invalidated", ...(opts.reason ? { reason: redactSecretText(opts.reason).slice(0, 500) } : {}) },
      signal: this.signal(opts.signal),
    }) as SdkResult<unknown>;
    if (result.response?.status === 404) throw new MemoryNotFoundError(`Hindsight has no memory ${memoryId}`);
    if (!result.response?.ok) this.fail("update memory", result);
    return fact;
  }

  async stats(signal?: AbortSignal): Promise<MemoryStats | null> {
    const result = await sdk.getAgentStats({
      client: this.client, path: this.path(), signal: this.signal(signal),
    }) as SdkResult<{
      total_documents?: number; nodes_by_fact_type?: Record<string, number>; total_observations?: number; pending_consolidation?: number;
    }>;
    if (result.response?.status === 404) return { documents: 0, facts: 0, observations: 0, pendingConsolidation: 0 };
    if (!result.response?.ok) this.fail("stats", result);
    const data = result.data ?? {};
    const byType = data.nodes_by_fact_type ?? {};
    return {
      documents: data.total_documents ?? 0,
      facts: (byType.world ?? 0) + (byType.experience ?? 0),
      observations: data.total_observations ?? byType.observation ?? 0,
      pendingConsolidation: data.pending_consolidation ?? 0,
    };
  }

  // /health 查数据库，数据库不通时返回 503。它不要求认证。
  async healthy(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await sdk.healthEndpointHealthGet({ client: this.client, signal: this.signal(signal) }) as SdkResult<unknown>;
      return Boolean(result.response?.ok);
    } catch {
      return false;
    }
  }
}

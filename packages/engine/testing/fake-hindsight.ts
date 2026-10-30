// 记忆后端的替身：按 Hindsight 1.0.0 的规则做事（.scratch/hindsight-primary-memory/spec.md「Testing Decisions」）。
// 只会「收下就成功」的替身测不出 2026-10-26 的问题，所以这里：
// - retain 是异步的：收下后任务是 pending，process() 时才提取事实；摘要模型坏了（llmBroken）时任务失败。
// - 同一个任务编号再交一次，不做新的事（RetainRequest.operation_id）。
// - 失败的任务能重试（POST operations/{id}/retry）；查不到的任务是 gone。
// - 同一个文档再写一次是 replace：旧的事实和由它们整理出的观察都删掉。
// - 删文档连带删事实和观察；失效的事实不再被召回，由它整理出的观察也删掉；观察不能失效。
// - 观察只在同一个范围里整理（observation_scopes 是 [[origin:<来源>]]）：用户本人和外部来源的事实不会合成一条观察。
// - 服务停了（down）时每个请求都抛网络错误。
import { randomUUID } from "node:crypto";
import type { NoteKind } from "@pi-lead-child/store";
import {
  MemoryNotFoundError, MemoryRejectedError,
  type MemoryBackend, type MemoryFactInfo, type MemoryHit, type MemoryItem, type MemoryOperationStatus, type MemoryStats,
} from "../src/memory/backend.js";

interface FakeOperation {
  id: string;
  item: MemoryItem;
  state: "pending" | "completed" | "failed";
  error: string | null;
}

interface FakeFact {
  id: string;
  type: "world" | "observation";
  text: string;
  sourceKey: string | null;
  kind: NoteKind | null;
  // 观察整理自哪些事实。
  from: string[];
  invalidated: boolean;
  // 带 origin:external 标签（外部来源的事实，或者外部范围里的观察）。
  external: boolean;
}

export class FakeHindsight implements MemoryBackend {
  readonly name = "hindsight";
  down = false;
  // 摘要模型坏了：retain 的任务在 process() 时失败（2026-10-26：embedding 的 key 无效，任务 401）。
  llmBroken = false;
  // 召回出错，或者召回一直不回（直到调用方的 signal 超时）。
  recallError: string | null = null;
  recallHangs = false;
  // 这些文档内容被拒收（400、422……）。
  rejects: (item: MemoryItem) => boolean = () => false;
  readonly operations = new Map<string, FakeOperation>();
  readonly facts = new Map<string, FakeFact>();
  readonly calls: string[] = [];

  constructor(readonly index: string = "bank-1") {}

  private reachable(what: string): void {
    this.calls.push(what);
    if (this.down) throw new Error(`connect ECONNREFUSED 127.0.0.1:47188 (${what})`);
  }

  async remember(item: MemoryItem, opts: { operationId: string; signal?: AbortSignal }): Promise<void> {
    this.reachable(`retain ${item.sourceKey}`);
    if (this.rejects(item)) throw new MemoryRejectedError("Hindsight retain failed: HTTP 422 bad content", 422);
    if (this.operations.has(opts.operationId)) return;
    this.operations.set(opts.operationId, { id: opts.operationId, item, state: "pending", error: null });
  }

  // Hindsight 的后台处理完排着的任务。
  process(): void {
    for (const op of this.operations.values()) {
      if (op.state !== "pending") continue;
      if (this.llmBroken) {
        op.state = "failed";
        op.error = "Error code: 401 - invalid api key";
        continue;
      }
      this.dropDocument(op.item.sourceKey);
      const id = randomUUID();
      this.facts.set(id, {
        id, type: "world", text: op.item.content.replace(/\n/g, " "), sourceKey: op.item.sourceKey, kind: op.item.kind, from: [],
        invalidated: false, external: op.item.origin === "external",
      });
      op.state = "completed";
    }
  }

  // 整理出一条观察（测试按需要加）。和 Hindsight 一样只在一个范围里整理：来源事实的 origin 必须相同。
  observe(text: string, fromFactIds: string[]): string {
    const origins = new Set(fromFactIds.map((factId) => this.facts.get(factId)?.external));
    if (origins.size > 1) throw new Error("observations are consolidated within one tag scope; these facts are in different scopes");
    const id = randomUUID();
    this.facts.set(id, { id, type: "observation", text, sourceKey: null, kind: null, from: fromFactIds, invalidated: false, external: origins.has(true) });
    return id;
  }

  factsOf(sourceKey: string): FakeFact[] {
    return [...this.facts.values()].filter((fact) => fact.sourceKey === sourceKey);
  }

  private dropDocument(sourceKey: string): void {
    const gone = new Set(this.factsOf(sourceKey).map((fact) => fact.id));
    for (const [id, fact] of this.facts) {
      if (gone.has(id) || fact.from.some((source) => gone.has(source))) this.facts.delete(id);
    }
  }

  async operation(operationId: string): Promise<MemoryOperationStatus> {
    this.reachable(`operation ${operationId}`);
    const op = this.operations.get(operationId);
    if (!op) return { state: "gone", error: null };
    return { state: op.state, error: op.error };
  }

  async retryOperation(operationId: string): Promise<void> {
    this.reachable(`retry ${operationId}`);
    const op = this.operations.get(operationId);
    if (!op || op.state !== "failed") throw new Error(`Hindsight retry operation failed: HTTP 409 not failed`);
    op.state = "pending";
    op.error = null;
  }

  async recall(query: string, opts: { limit: number; kind?: NoteKind; signal?: AbortSignal }): Promise<MemoryHit[]> {
    this.reachable(`recall ${query}`);
    if (this.recallHangs) {
      await new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true });
      });
    }
    if (this.recallError) throw new Error(`Hindsight recall failed: HTTP 500 ${this.recallError}`);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: MemoryHit[] = [];
    const live = [...this.facts.values()].filter((fact) => !fact.invalidated);
    // prefer_observations：观察取代它整理的事实。按 kind 过滤时只要事实。
    const observations = opts.kind ? [] : live.filter((fact) => fact.type === "observation");
    const covered = new Set(observations.flatMap((fact) => fact.from));
    for (const fact of [...observations, ...live.filter((fact) => fact.type === "world")]) {
      if (fact.type === "world" && (covered.has(fact.id) || (opts.kind && fact.kind !== opts.kind))) continue;
      if (!words.some((word) => fact.text.toLowerCase().includes(word))) continue;
      const sourceKeys = fact.type === "observation"
        ? [...new Set(fact.from.map((id) => this.facts.get(id)?.sourceKey).filter((key): key is string => Boolean(key)))]
        : fact.sourceKey ? [fact.sourceKey] : [];
      hits.push({ id: fact.id, type: fact.type, text: fact.text, sourceKeys, occurredAt: null, external: fact.external, score: null });
      if (hits.length >= opts.limit) break;
    }
    return hits;
  }

  async forget(sourceKeys: string[]): Promise<void> {
    this.reachable(`forget ${sourceKeys.join(",")}`);
    for (const key of sourceKeys) this.dropDocument(key);
  }

  async invalidate(memoryId: string, opts: {
    reason: string; restore?: boolean; guard?: (fact: MemoryFactInfo) => void;
  }): Promise<MemoryFactInfo> {
    this.reachable(`invalidate ${memoryId}`);
    const fact = this.facts.get(memoryId);
    if (!fact) throw new MemoryNotFoundError(`Hindsight has no memory ${memoryId}`);
    if (fact.type === "observation") throw new MemoryNotFoundError(`memory ${memoryId} is an observation`);
    // GET memories/{id} 的样子：文档编号、原文、标签（origin:<来源>）。
    const info: MemoryFactInfo = { sourceKey: fact.sourceKey, text: fact.text, external: fact.external };
    opts.guard?.(info);
    fact.invalidated = !opts.restore;
    if (!opts.restore) {
      for (const [id, other] of this.facts) if (other.from.includes(memoryId)) this.facts.delete(id);
    }
    return info;
  }

  async stats(): Promise<MemoryStats> {
    this.reachable("stats");
    const facts = [...this.facts.values()];
    return {
      documents: new Set(facts.map((fact) => fact.sourceKey).filter(Boolean)).size,
      facts: facts.filter((fact) => fact.type === "world").length,
      observations: facts.filter((fact) => fact.type === "observation").length,
      pendingConsolidation: 0,
    };
  }

  async healthy(): Promise<boolean> {
    return !this.down;
  }
}

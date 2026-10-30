// 记忆设置测试用的替身：launchd、模型下载、Hindsight 的 /health 和远程 embedding。
// ensure 用真的 ensureHindsightService，只换掉 launchctl、plist 的位置、uvx 和 Postgres 探测，
// 所以「期望状态不变就不重启」走的是真代码。
import { join } from "node:path";
import {
  ensureHindsightService, HINDSIGHT_LABEL,
  type EnsureHindsightOptions, type ModelDownloads, type ModelDownloadState, type ModelKind,
} from "@pi-lead-child/supervisor";
import type { SummaryModelSlot } from "@pi-lead-child/protocol";
import type { MemoryControllerHooks } from "../src/memory-controller.js";
import type { SummaryModelChoice, SummaryModels, SummaryModelSettings } from "../src/memory-backend.js";

// 摘要模型（memory-backend.ts 的 summaryModels）的替身：两个服务商 vibeproxy、anthropic，各有自己的 key。
// 缺省槽：设置里选了就用它，否则自动（vibeproxy 的 haiku）；整理观察槽：选了就用它，否则跟缺省一样。别的服务商用不了。
const SUMMARY_PROVIDERS: Record<string, { baseUrl: string; apiKey: string }> = {
  vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1", apiKey: "vibe-key" },
  anthropic: { baseUrl: "https://api.anthropic.example/v1", apiKey: "anthropic-key" },
};

export function fakeSummaryModels(settings: SummaryModelSettings): SummaryModels {
  const choose = (slot: SummaryModelSlot, spec: string, source: SummaryModelChoice["source"], setting: string | null): SummaryModelChoice | string => {
    const [provider, model] = [spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1)];
    const known = SUMMARY_PROVIDERS[provider];
    return known ? { slot, spec, source, setting, problem: null, llm: { provider, model, ...known } } : `服务商 ${provider} 不在设置 → 模型的服务商里`;
  };
  const chosen = settings.default ? choose("default", settings.default, "settings", settings.default) : null;
  const fallback = choose("default", "vibeproxy/claude-haiku-5-5", "auto", settings.default ?? null) as SummaryModelChoice;
  const first = chosen && typeof chosen !== "string" ? chosen : { ...fallback, problem: typeof chosen === "string" ? chosen : null };
  const consolidation = settings.consolidation ? choose("consolidation", settings.consolidation, "settings", settings.consolidation) : null;
  return {
    default: first,
    consolidation: consolidation && typeof consolidation !== "string" ? consolidation : {
      slot: "consolidation", spec: first.spec, source: "inherit", setting: settings.consolidation ?? null,
      problem: typeof consolidation === "string" ? consolidation : null, llm: first.llm,
    },
  };
}

export class FakeDownloads {
  readonly started: Array<[string, ModelKind]> = [];
  readonly revisions: Array<string | null> = [];
  private readonly states = new Map<string, ModelDownloadState>();

  constructor(private readonly onChange: (repo: string, state: ModelDownloadState) => void) {}

  start(repo: string, kind: ModelKind, revision: string | null = null): void {
    this.started.push([repo, kind]);
    this.revisions.push(revision);
    this.set(repo, { kind, state: "downloading", bytes: 0, total: 100, error: null, updatedAt: new Date().toISOString(), revision, path: null });
  }

  status(repo: string): ModelDownloadState | null {
    return this.states.get(repo) ?? null;
  }

  ready(repo: string, revision: string | null = null): boolean {
    const state = this.states.get(repo);
    return state?.state === "ready" && (revision === null || state.revision === revision);
  }

  snapshot(repo: string, revision: string | null = null): { revision: string; path: string } | null {
    const state = this.states.get(repo);
    return this.ready(repo, revision) && state?.revision && state.path ? { revision: state.revision, path: state.path } : null;
  }

  resume(): void {}
  stopAll(): void {}

  // 模拟下载结束。
  finish(repo: string, error: string | null = null): void {
    const current = this.states.get(repo)!;
    // 用户自己填的 repo 没有固定的 commit：下载时解析出一个。
    const revision = current.revision ?? "f".repeat(40);
    this.set(repo, {
      ...current, state: error ? "failed" : "ready", bytes: error ? current.bytes : 100, error,
      ...(error ? {} : { revision, path: `/hf/hub/models--${repo.replace("/", "--")}/snapshots/${revision}` }),
    });
  }

  private set(repo: string, state: ModelDownloadState): void {
    this.states.set(repo, state);
    this.onChange(repo, state);
  }
}

export interface MemoryHarness {
  hooks: MemoryControllerHooks;
  // launchctl 的子命令，按调用顺序：print / bootstrap / bootout；stopService 记成 uninstall。
  launchctl: string[];
  downloads(): FakeDownloads;
  // Hindsight 和远程 embedding 收到的请求（不含 /health）。redirect 是请求带的重定向策略。
  requests: Array<{ url: string; authorization: string | null; body: unknown; redirect: RequestRedirect | undefined }>;
  // 下一个请求（不含 /health）抛这个错误。
  failNext(error: Error): void;
  setExternalSecret(name: string, value: string | null): void;
}

export function memoryHarness(dataDir: string): MemoryHarness {
  const launchctl: string[] = [];
  const requests: MemoryHarness["requests"] = [];
  const external = new Map<string, string>();
  let loaded = false;
  let downloads: FakeDownloads | null = null;
  let failure: Error | null = null;
  const plistPath = join(dataDir, "LaunchAgents", `${HINDSIGHT_LABEL}.plist`);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response("{}", { status: loaded ? 200 : 503 });
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null, redirect: init?.redirect });
    if (failure) {
      const error = failure;
      failure = null;
      throw error;
    }
    if (url.endsWith("/embeddings")) return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    return Response.json({});
  }) as typeof fetch;
  return {
    launchctl,
    requests,
    downloads: () => downloads!,
    failNext: (error) => { failure = error; },
    setExternalSecret: (name, value) => { if (value === null) external.delete(name); else external.set(name, value); },
    hooks: {
      env: {},
      fetch: fetchImpl,
      healthIntervalMs: 3_600_000,
      externalSecret: (name) => external.get(name) ?? null,
      summaryModels: async (settings) => fakeSummaryModels(settings),
      downloads: (onChange) => (downloads = new FakeDownloads(onChange)) as unknown as ModelDownloads,
      stopService: async () => { launchctl.push("uninstall"); loaded = false; },
      ensure: (options: EnsureHindsightOptions) => ensureHindsightService({
        ...options, plistPath, uvx: "/Users/u/.local/bin/uvx",
        findPostgres: async () => ({ found: null, reasons: [] }),
        launchctl: async (args) => {
          launchctl.push(args[0]!);
          if (args[0] === "print") return { ok: loaded, out: "" };
          if (args[0] === "bootstrap") loaded = true;
          if (args[0] === "bootout") loaded = false;
          return { ok: true, out: "" };
        },
      }),
    },
  };
}

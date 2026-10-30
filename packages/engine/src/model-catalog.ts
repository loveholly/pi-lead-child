// daemon 的模型目录（2026-10-15 用户决定：不写死模型，由 Lead 按任务选 runtime、模型和 effort）。
// 每个 runtime 的目录来自它的 CLI（packages/runtime 的 model-discovery.ts），在这里缓存：
//   - 内存里一份；daemon 启动时、定时、Run 因为模型或配置失败以后自动刷新，Lead 也可以按需刷新（get_model_catalog）。
//   - kv 表里存上一次成功的结果。daemon 重启后、刷新完成之前，Lead 的提示词和校验先用它。
//   - 发现失败的 runtime 记成 unknown：不替 Run 选模型，Lead 明确给的模型也不核对，照原样交给 CLI。
import type { RuntimeId } from "@pi-lead-child/core";
import type { Db } from "@pi-lead-child/store";
import { resolveRuntimeModel, runtimeAdapters, type DiscoveredModel, type RuntimeEnv } from "@pi-lead-child/runtime";

export interface RuntimeModelCatalog {
  runtime: RuntimeId;
  /** known：CLI 给出了目录；unknown：没有发现过，或者发现失败。 */
  state: "known" | "unknown";
  models: DiscoveredModel[];
  /** 这个 runtime 认的全部 effort 档位。 */
  efforts: string[];
  /** CLI 自己配置的默认模型。不知道时为 null。 */
  cliDefaultModel: string | null;
  /** 目录从哪里来，例如 "codex debug models"。 */
  source: string;
  /** 用谁的账号（adapter 说的）。不知道时为 null。 */
  account: string | null;
  /** 目录以外 CLI 也接受的模型名（正则源码，adapter 说的）。 */
  freeformModelPattern: string | null;
  refreshedAt: string | null;
  error: string | null;
}

export interface ModelCatalog {
  runtimes: RuntimeModelCatalog[];
  refreshedAt: string | null;
}

const KV_KEY = "runtime_model_catalog";
/** 目录多久以后算旧，下次读的时候在后台刷新。 */
export const MODEL_CATALOG_MAX_AGE_MS = 6 * 60 * 60_000;

let memory: ModelCatalog | null = null;
let inFlight: Promise<ModelCatalog> | null = null;

function unknownEntry(runtime: RuntimeId, error: string): RuntimeModelCatalog {
  return {
    runtime, state: "unknown", models: [], efforts: [], cliDefaultModel: null, source: "not discovered",
    account: null, freeformModelPattern: null, refreshedAt: null, error,
  };
}

function emptyCatalog(): ModelCatalog {
  return { runtimes: runtimeAdapters().map((adapter) => unknownEntry(adapter.id, "not discovered yet")), refreshedAt: null };
}

function readStored(db: Db): ModelCatalog | null {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(KV_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as ModelCatalog;
    return Array.isArray(parsed.runtimes) ? parsed : null;
  } catch {
    return null;
  }
}

function store(db: Db, catalog: ModelCatalog): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(KV_KEY, JSON.stringify(catalog));
}

/** 现在的目录。内存里没有时读 kv 里上一次的结果；都没有时每个 runtime 都是 unknown。不会触发刷新。 */
export function currentModelCatalog(db?: Db): ModelCatalog {
  if (memory) return memory;
  const stored = db ? readStored(db) : null;
  if (stored) memory = stored;
  return memory ?? emptyCatalog();
}

/** 只给测试用：直接放一份目录，或者清空（null）。 */
export function setModelCatalogForTesting(catalog: ModelCatalog | null): void {
  memory = catalog;
  inFlight = null;
}

export interface ModelCatalogRefreshOptions {
  db?: Db;
  /** 项目根目录。pi 的可执行文件在它的 node_modules 里。 */
  cwd: string;
  env?: RuntimeEnv;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * 问每个 runtime 的 CLI 要目录。并发调用共用同一次刷新。某个 runtime 发现失败时，这个 runtime 保留
 * 上一次成功的目录（标明这次的错误）；从来没成功过就是 unknown。
 */
export function refreshModelCatalog(options: ModelCatalogRefreshOptions): Promise<ModelCatalog> {
  if (inFlight) return inFlight;
  const previous = currentModelCatalog(options.db);
  inFlight = (async () => {
    const at = (options.now ?? (() => new Date()))().toISOString();
    const runtimes = await Promise.all(runtimeAdapters().map(async (adapter): Promise<RuntimeModelCatalog> => {
      const before = previous.runtimes.find((entry) => entry.runtime === adapter.id);
      if (!adapter.discoverModels) return before ?? unknownEntry(adapter.id, "runtime has no model discovery");
      const result = await adapter.discoverModels({ cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })
        .catch((error: unknown) => ({ ok: false as const, error: String((error as Error)?.message ?? error), source: "discovery" }));
      if (result.ok) {
        return {
          runtime: adapter.id, state: "known", models: result.models, efforts: result.efforts,
          cliDefaultModel: result.cliDefaultModel, source: result.source, account: result.account,
          freeformModelPattern: result.freeformModelPattern, refreshedAt: at, error: null,
        };
      }
      return before && before.state === "known"
        ? { ...before, error: `${result.source}: ${result.error}` }
        : { ...unknownEntry(adapter.id, result.error), source: result.source };
    }));
    const catalog: ModelCatalog = { runtimes, refreshedAt: at };
    memory = catalog;
    if (options.db) {
      try { store(options.db, catalog); } catch { /* 存不进去只影响重启后的第一份目录 */ }
    }
    return catalog;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** 目录比 maxAgeMs 旧（或者从没刷新过）时刷新；否则直接返回现在的目录。 */
export async function freshModelCatalog(
  options: ModelCatalogRefreshOptions & { maxAgeMs?: number },
): Promise<ModelCatalog> {
  const current = currentModelCatalog(options.db);
  const age = current.refreshedAt ? Date.now() - Date.parse(current.refreshedAt) : Number.POSITIVE_INFINITY;
  return age > (options.maxAgeMs ?? MODEL_CATALOG_MAX_AGE_MS) ? refreshModelCatalog(options) : current;
}

/**
 * 两份目录之间变了什么，一个 runtime 一行。自动刷新以后告诉 Lead：它的工具描述里的目录摘要是会话开始时的。
 * 没有变化时返回空数组。
 */
export function describeModelCatalogChanges(before: ModelCatalog, after: ModelCatalog): string[] {
  const lines: string[] = [];
  for (const next of after.runtimes) {
    const prev = before.runtimes.find((entry) => entry.runtime === next.runtime);
    if (!prev || prev.state !== next.state) {
      lines.push(next.state === "known"
        ? `${next.runtime}：目录可用了（${next.models.length} 个模型）`
        : `${next.runtime}：目录不可用了（${next.error ?? "原因未知"}）`);
      continue;
    }
    if (next.state !== "known") continue;
    const was = new Set(prev.models.map((model) => model.id));
    const now = new Set(next.models.map((model) => model.id));
    const added = [...now].filter((id) => !was.has(id));
    const removed = [...was].filter((id) => !now.has(id));
    const parts = [
      added.length ? `新增 ${added.join("、")}` : null,
      removed.length ? `移除 ${removed.join("、")}` : null,
      prev.cliDefaultModel !== next.cliDefaultModel
        ? `CLI 默认 ${prev.cliDefaultModel ?? "未知"} → ${next.cliDefaultModel ?? "未知"}`
        : null,
    ].filter(Boolean);
    if (parts.length) lines.push(`${next.runtime}：${parts.join("；")}`);
    else if (next.error && next.error !== prev.error) lines.push(`${next.runtime}：这次发现失败，沿用上一次的目录（${next.error}）`);
  }
  return lines;
}

export class ModelChoiceError extends Error {}

export interface ModelChoice {
  /** 交给派发的模型名。null 表示不指定，由 CLI 自己的配置决定。 */
  model: string | null;
  effort: string | null;
  /** 目录是 unknown 时说一句：这次选择没有核对。模型名按目录归一过时，说一句归一成了什么。 */
  note: string | null;
}

// 工具输入可以带 provider 前缀（例如 openai/…）。adapter 的 resolve 把它换成目录里的名字；
// 模型不属于这个 runtime 时 resolve 抛错，这里当成不在目录里。
function catalogId(runtime: RuntimeId, model: string): string {
  try {
    return resolveRuntimeModel(runtime, model) ?? model;
  } catch {
    return model;
  }
}

// 模型名的 provider 前缀（runtime 的 profile.ts 用同一条规则）：第一段不带冒号，Bedrock 的 ARN 不算。
const PROVIDER_PREFIX = /^[A-Za-z0-9][\w.-]*\//;

// 目录里的模型，或者 adapter 认的目录外写法。
function catalogModel(
  runtime: RuntimeId, entry: RuntimeModelCatalog, model: string,
): { model: string; chosen: DiscoveredModel | undefined } | null {
  const chosen = entry.models.find((candidate) => candidate.id === catalogId(runtime, model));
  if (chosen) return { model, chosen };
  return entry.freeformModelPattern && new RegExp(entry.freeformModelPattern).test(model) ? { model, chosen: undefined } : null;
}

// Lead 写的模型名和目录里的写法常差一个 provider 前缀（2026-10-29：pi 的目录里是 vibeproxy/claude-opus-5-5，
// Lead 写 claude-opus-5-5 被拒；Lead 也会把 pi 的写法 vibeproxy/claude-… 带到 Claude Code 上）。按目录归一：
//   - 没有前缀：目录里恰好有一个「<provider>/<这个名字>」时用它的全名。有几个时不替人挑，列出这几个。
//   - 有前缀、带着前缀不认：去掉前缀以后目录认（在目录里，或者是 adapter 认的写法）时用去掉前缀的名字。
//     去掉前缀以后不再按名字找别的 provider：pi 上的 anthropic/… 不会换成 vibeproxy/…，那是另一个账号。
// 认不出时返回 null，由调用方报错。
function normalizedModel(
  runtime: RuntimeId, entry: RuntimeModelCatalog, model: string,
): { model: string; chosen: DiscoveredModel | undefined } | null {
  const direct = catalogModel(runtime, entry, model);
  if (direct) return direct;
  if (!PROVIDER_PREFIX.test(model)) {
    const matches = entry.models.filter((candidate) => candidate.id.endsWith(`/${model}`));
    if (matches.length > 1) {
      throw new ModelChoiceError(
        `${runtime} 的模型目录（${entry.source}）里有几个 ${model}，要写全名：${matches.map((candidate) => candidate.id).join("、")}`,
      );
    }
    return matches.length === 1 ? { model: matches[0]!.id, chosen: matches[0] } : null;
  }
  return catalogModel(runtime, entry, model.replace(PROVIDER_PREFIX, ""));
}

/**
 * 按目录核对 Lead 或恢复选的模型和 effort。目录 known 时：模型必须在目录里，或者符合 adapter 说的
 * 目录外写法（例如 Claude Code 的完整模型名）；effort 必须是这个模型（没选模型时是 CLI 默认模型，
 * 不知道默认模型时是这个 runtime）认的档位。不合法时抛 ModelChoiceError，消息里列出可选项。
 * 只差一个 provider 前缀的名字按目录归一（normalizedModel）：返回的 model 是归一后的写法，调用方派发时用它。
 */
export function validateModelChoice(
  catalog: ModelCatalog,
  input: { runtime: RuntimeId; model?: string | null; effort?: string | null },
): ModelChoice {
  let model = input.model?.trim() || null;
  const effort = input.effort?.trim() || null;
  const entry = catalog.runtimes.find((candidate) => candidate.runtime === input.runtime);
  if (!entry || entry.state !== "known") {
    return { model, effort, note: model || effort ? `${input.runtime} 的模型目录未知，这次选择没有核对。` : null };
  }
  const ids = entry.models.map((candidate) => candidate.id);
  let chosen: DiscoveredModel | undefined;
  let note: string | null = null;
  if (model) {
    const found = normalizedModel(input.runtime, entry, model);
    if (!found) {
      throw new ModelChoiceError(`${input.runtime} 的模型目录（${entry.source}）里没有 ${model}。可选：${ids.join("、")}`);
    }
    if (found.model !== model) note = `模型 ${model} 按 ${input.runtime} 的模型目录写成 ${found.model}。`;
    model = found.model;
    chosen = found.chosen;
  } else if (entry.cliDefaultModel) {
    chosen = entry.models.find((candidate) => candidate.id === entry.cliDefaultModel);
  }
  if (effort) {
    const allowed = chosen ? chosen.efforts : entry.efforts;
    if (allowed.length === 0) {
      throw new ModelChoiceError(`${chosen?.id ?? input.runtime} 不支持调 effort。`);
    }
    if (!allowed.includes(effort)) {
      throw new ModelChoiceError(`${chosen?.id ?? input.runtime} 不认 effort=${effort}。可选：${allowed.join("、")}`);
    }
  }
  return { model, effort, note };
}

/** 换模型的候选：同一个 runtime 目录里、还没试过、不是失败的那个模型，按目录顺序。 */
export function alternativeModels(
  catalog: ModelCatalog,
  runtime: RuntimeId,
  exclude: ReadonlySet<string>,
): DiscoveredModel[] {
  const entry = catalog.runtimes.find((candidate) => candidate.runtime === runtime);
  if (!entry || entry.state !== "known") return [];
  return entry.models.filter((model) => !exclude.has(model.id));
}

const MODELS_IN_SUMMARY = 8;

/** 给 Lead 的简短目录：每个 runtime 一行。完整目录用 get_model_catalog 读。 */
export function formatModelCatalogForLead(catalog: ModelCatalog): string {
  const lines = catalog.runtimes.map((entry) => {
    const account = entry.account ? `，${entry.account}` : "";
    if (entry.state !== "known") {
      return `- ${entry.runtime}（目录未知${account}）：${entry.error ?? "没有发现过"}。不要替它选模型。`;
    }
    const shown = entry.models.slice(0, MODELS_IN_SUMMARY).map((model) => {
      const marks = [
        model.id === entry.cliDefaultModel ? "CLI 默认" : null,
        model.efforts.length ? `effort ${model.efforts.join("/")}` : "不支持 effort",
        model.defaultEffort ? `默认 ${model.defaultEffort}` : null,
      ].filter(Boolean).join("，");
      return `${model.id}（${marks}）`;
    });
    const more = entry.models.length > MODELS_IN_SUMMARY ? `，另有 ${entry.models.length - MODELS_IN_SUMMARY} 个` : "";
    return `- ${entry.runtime}（${entry.source}${account}）：${shown.join("、")}${more}`;
  });
  return [
    `本机模型目录（来自各 CLI 自己${catalog.refreshedAt ? `，${catalog.refreshedAt} 刷新` : ""}）：`,
    ...lines,
  ].join("\n");
}

/** 完整目录：每个模型一行，带 effort 档位、默认档位和说明。runtime 给出时只列这一个。 */
export function formatModelCatalogDetail(catalog: ModelCatalog, runtime?: RuntimeId): string {
  const entries = catalog.runtimes.filter((entry) => !runtime || entry.runtime === runtime);
  if (entries.length === 0) return `没有 runtime ${runtime} 的目录。`;
  const blocks = entries.map((entry) => {
    const account = entry.account ?? "";
    const head = `## ${entry.runtime}（${entry.state === "known" ? entry.source : "目录未知"}${account ? `，${account}` : ""}`
      + `${entry.refreshedAt ? `，${entry.refreshedAt}` : ""}）`;
    if (entry.state !== "known") return `${head}
${entry.error ?? "没有发现过"}。不要替它选模型，让 CLI 用自己的配置。`;
    const lines = entry.models.map((model) => {
      const parts = [
        model.id === entry.cliDefaultModel ? "CLI 默认" : null,
        model.efforts.length ? `effort ${model.efforts.join("/")}` : "不支持 effort",
        model.defaultEffort ? `默认 ${model.defaultEffort}` : null,
        model.note,
      ].filter(Boolean);
      return `- ${model.id}${model.label !== model.id ? `（${model.label}）` : ""}：${parts.join("；")}`;
    });
    return [head, ...lines, ...(entry.error ? [`上次刷新失败，沿用之前的目录：${entry.error}`] : [])].join("\n");
  });
  return blocks.join("\n\n");
}

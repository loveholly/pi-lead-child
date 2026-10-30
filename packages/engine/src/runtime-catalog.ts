import { projectRoot } from "@pi-lead-child/core";
import { addActivity } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import type { RuntimeId } from "@pi-lead-child/core";
import {
  isRuntimeDisabled, runtimeAdapter, runtimeAdapters, runtimeDisabledReason, runtimeIds,
} from "@pi-lead-child/runtime";
import type { RuntimeCapabilities } from "@pi-lead-child/runtime";

// 内置 runtime 的优先顺序，在模块加载时从 registry 取一次。保留它是为了已有的脚本。
// 内核读 registry 的 runtimeIds()，它也包括之后登记的 runtime（工单 12）。
export const CHILD_RUNTIME_ORDER: readonly RuntimeId[] = runtimeIds();

export interface RuntimeCatalogEntry {
  id: RuntimeId;
  available: boolean;
  executable: string | null;
  defaultModel: string | null;
  models: string[];
  capabilities: RuntimeCapabilities;
  reason: string | null;
  // 用户在设置里停用了它（PLC_DISABLED_RUNTIMES，2026-10-19）。可执行文件在不在由 available 说明，两者无关。
  // 手写的目录（测试）可以不给，这时按环境变量判断。
  disabled?: boolean;
}

export interface RuntimeCatalog {
  entries: RuntimeCatalogEntry[];
}

export type RuntimeCatalogEnv = Record<string, string | undefined>;

export interface RuntimeCatalogProbe {
  findExecutable?: (id: RuntimeId) => string | null;
  env?: RuntimeCatalogEnv;
  cwd?: string;
}

export interface SelectChildRuntimeInput {
  requested?: RuntimeId | null;
  role?: "executor" | "reviewer";
  catalog?: RuntimeCatalog;
  env?: RuntimeCatalogEnv;
  // 健康账本（spec D2）：这个 runtime 的 profile 是否不可用。
  unavailable?: (runtime: RuntimeId) => boolean;
}

export interface SelectChildRuntimeResult {
  runtime: RuntimeId;
  source: "requested" | "env" | "catalog";
  fallbackFrom: RuntimeId | null;
  reason: string;
}

function envList(env: RuntimeCatalogEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function modelsFor(runtime: RuntimeId, env: RuntimeCatalogEnv): string[] {
  const selected = runtimeAdapter(runtime).models.defaultModel(env);
  const specific = envList(env, `PLC_${runtime.toUpperCase()}_FALLBACK_MODELS`);
  const global = envList(env, "PLC_FALLBACK_MODELS");
  return [selected, ...specific, ...global].filter((model, index, all): model is string =>
    Boolean(model) && all.indexOf(model) === index,
  );
}

// 目录的条目、顺序、能力、默认模型和可执行文件都来自 registry 里的 adapter（工单 12）。
export function probeChildRuntimeCatalog(options: RuntimeCatalogProbe = {}): RuntimeCatalog {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? projectRoot();
  return {
    entries: runtimeAdapters().map((adapter) => {
      const { id } = adapter;
      const executable = options.findExecutable ? options.findExecutable(id) : adapter.locateExecutable(cwd);
      const models = modelsFor(id, env);
      return {
        id,
        available: Boolean(executable),
        executable,
        defaultModel: models[0] ?? null,
        models,
        capabilities: adapter.capabilities,
        reason: executable ? null : "executable not found",
        disabled: isRuntimeDisabled(id, env),
      };
    }),
  };
}

// 这个 runtime 是不是被用户停用了：目录里记着的，或者环境变量里现在的。
export function catalogEntryDisabled(entry: RuntimeCatalogEntry, env: RuntimeCatalogEnv = process.env): boolean {
  return entry.disabled === true || isRuntimeDisabled(entry.id, env);
}

// 能用的条目：可执行文件在、没被用户停用。核查员按能不能做可执行只读核查排序，能做的在前（2026-10-20）：
// 以前做不了的直接排除，Codex 停用以后就没有核查员可选了。
function healthyEntries(catalog: RuntimeCatalog, role: "executor" | "reviewer", env: RuntimeCatalogEnv): RuntimeCatalogEntry[] {
  const usable = catalog.entries.filter((entry) => entry.available && !catalogEntryDisabled(entry, env));
  if (role !== "reviewer") return usable;
  return [
    ...usable.filter((entry) => entry.capabilities.executableReadOnlyReview),
    ...usable.filter((entry) => !entry.capabilities.executableReadOnlyReview),
  ];
}

export function selectChildRuntime(input: SelectChildRuntimeInput = {}): SelectChildRuntimeResult {
  const env = input.env ?? process.env;
  const role = input.role ?? "executor";
  const catalog = input.catalog ?? probeChildRuntimeCatalog({ env });
  const requested = input.requested
    ?? (env.PLC_CHILD_RUNTIME?.trim() as RuntimeId | undefined)
    ?? null;
  const source: SelectChildRuntimeResult["source"] = input.requested
    ? "requested"
    : env.PLC_CHILD_RUNTIME?.trim()
      ? "env"
      : "catalog";
  const capable = healthyEntries(catalog, role, env);
  // 不固定 runtime 时，跳过 profile 不可用的 runtime（spec D2）。全部不可用时不跳过：
  // 派发 gate 会让请求挂起并写明原因，而不是让请求在这里报错丢失。
  const reachable = capable.filter((entry) => !input.unavailable?.(entry.id));
  const healthy = reachable.length ? reachable : capable;

  if (requested) {
    const entry = catalog.entries.find((item) => item.id === requested);
    // 调用方点名的 runtime 是固定的，不因健康状态切换。环境变量给的只是默认值，可以跳过。
    const pinned = source === "requested";
    // 用户停用的 runtime：点名它是错误，要调用方改派（停用是用户的决定，不替他换）；环境变量给的默认值跳过它。
    const disabled = entry ? catalogEntryDisabled(entry, env) : false;
    if (disabled && pinned) throw new Error(`runtime '${requested}' is disabled: ${runtimeDisabledReason(requested)}`);
    const usable = entry?.available && !disabled && (pinned || !input.unavailable?.(entry.id) || reachable.length === 0);
    if (entry && usable) {
      return {
        runtime: entry.id,
        source,
        fallbackFrom: null,
        reason: `using ${source} runtime ${entry.id}`,
      };
    }
    const next = healthy[0];
    if (!next) {
      throw new Error(`requested runtime '${requested}' is unavailable and no healthy child runtime remains`);
    }
    return {
      runtime: next.id,
      source: "catalog",
      fallbackFrom: requested,
      reason: disabled
        ? `requested runtime '${requested}' is disabled by the user; using ${next.id}`
        : entry?.available
          ? `requested runtime '${requested}' has an unavailable profile; using healthy ${next.id}`
          : `requested runtime '${requested}' is unavailable; using healthy ${next.id}`,
    };
  }

  const first = healthy[0];
  if (!first) throw new Error("no healthy child runtime is available");
  return {
    runtime: first.id,
    source: "catalog",
    fallbackFrom: null,
    reason: `runtime omitted; picked first healthy host ${first.id}`,
  };
}

export function persistSelectedRuntime(
  db: Db,
  itemId: number,
  selected: SelectChildRuntimeResult,
): void {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item #${itemId} not found`);
  if (item.requested_runtime === selected.runtime && !selected.fallbackFrom) return;
  // 工单上的模型属于原来的 runtime（例如 codex 的 gpt-5.2-codex）。换了 runtime 还留着它，下一次派发会把它用在
  // 新 runtime 上（run-choice.ts 的 runModelFor 认工单的模型）。所以换 runtime 时一起清掉，由新 runtime 用自己的配置
  // （2026-10-19 复审：返工第二次得到 claude/gpt-5.2-codex）。工单原来没有 runtime 时不动模型。
  const clearedModel = item.requested_runtime !== null && item.requested_runtime !== selected.runtime
    ? item.requested_model : null;
  db.prepare(
    `UPDATE items SET requested_runtime=?, requested_model=CASE WHEN ? THEN NULL ELSE requested_model END,
       updated_at=datetime('now') WHERE id=?`,
  ).run(selected.runtime, clearedModel !== null ? 1 : 0, itemId);
  addActivity(db, {
    itemId,
    actor: "system",
    kind: "decision",
    payload: {
      decision: "runtime_selected",
      runtime: selected.runtime,
      source: selected.source,
      fallbackFrom: selected.fallbackFrom,
      reason: selected.reason,
      ...(clearedModel !== null ? { clearedModel } : {}),
    },
  });
}

export function formatRuntimeCatalogForLead(catalog: RuntimeCatalog = probeChildRuntimeCatalog()): string {
  const lines = catalog.entries.map((entry) => {
    const health = catalogEntryDisabled(entry) ? "已被用户停用（设置 → 执行器）"
      : entry.available ? `可用 (${entry.executable})` : "不可用";
    const models = entry.models.length ? entry.models.join(", ") : "无已配置模型";
    const review = entry.capabilities.executableReadOnlyReview ? "核查时能跑命令（只读）" : "核查时只读代码、不能跑命令";
    return `- ${entry.id}: ${health} · 模型 ${models} · ${review}`;
  });
  return [
    "本机 child runtime 目录（派发时从目录选择 runtime 和模型；省略时 host 按健康度选择，不会默认落到 Pi）：",
    ...lines,
    "编码任务优先 Codex / Claude Code。任何 runtime 都能当核查员：能跑命令的优先；不能跑命令的核查员只读代码和交付记录，"
      + "证据里会写明没有实际运行。核查员不可用时系统自动换下一个，也可以用 ticket_action 的 change_reviewer 换。",
    "当前目录来自本机可执行文件探活；派发前可用 get_runtime_health 再核对一次。",
  ].join("\n");
}

export function resolveDispatchRuntime(input: {
  requested?: RuntimeId | null;
  role?: "executor" | "reviewer";
  catalog?: RuntimeCatalog;
  env?: RuntimeCatalogEnv;
}): RuntimeId {
  return selectChildRuntime(input).runtime;
}

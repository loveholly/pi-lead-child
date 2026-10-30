// runtime registry（spec D8，工单 12）。
// 这里是装配 adapter 的唯一地方。内核模块里只有这里写着具体的 runtime 名字。
// 还有两处例外是留下的债，见 test/runtime-architecture.test.ts 的例外名单。
// 内核按 runtime id 从这里读 adapter 的知识：
//   - 能力和展示名称
//   - 模型规则和失败分类
//   - 可执行文件和实例
import type { AgentRuntime, RuntimeAdapter, RuntimeEnv } from "./types.js";
import type { Run, RuntimeId, TypedFailure } from "@pi-lead-child/core";
import { piAdapter, type PiRuntimeOptions } from "./pi.js";
import { codexAdapter, type CodexRuntimeOptions } from "./codex.js";
import { claudeAdapter, type ClaudeRuntimeOptions } from "./claude.js";
import {
  classifyHostFailure, matchProviderFailure, residualFailureCode, storedFailure, typedFailure,
  type FailureEvidence,
} from "./typed-failure.js";
import type { RuntimeProfile } from "./profile.js";

// 内置的 adapter。顺序就是 runtime 的优先顺序：本机目录、不固定 runtime 时的选择和 fallback 都按它。
const BUILTIN_ADAPTERS: readonly RuntimeAdapter[] = [codexAdapter, claudeAdapter, piAdapter];

// 用 registerRuntimeAdapter 登记的 adapter，排在内置的后面。现在只有测试登记。
const registeredAdapters: RuntimeAdapter[] = [];

// 登记一个 adapter。返回的函数撤销这次登记，测试用它清理。
export function registerRuntimeAdapter(adapter: RuntimeAdapter): () => void {
  if (findRuntimeAdapter(adapter.id)) throw new Error(`child runtime '${adapter.id}' is already registered`);
  registeredAdapters.push(adapter);
  return () => {
    const index = registeredAdapters.indexOf(adapter);
    if (index !== -1) registeredAdapters.splice(index, 1);
  };
}

export function runtimeAdapters(): readonly RuntimeAdapter[] {
  return [...BUILTIN_ADAPTERS, ...registeredAdapters];
}

// 所有登记的 runtime id，按优先顺序排列。
export function runtimeIds(): RuntimeId[] {
  return runtimeAdapters().map((adapter) => adapter.id);
}

// value 来自外部输入（CLI 参数、环境变量、库里的旧数据）时，用它判断是不是登记的 runtime。
export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && findRuntimeAdapter(value) !== undefined;
}

export function findRuntimeAdapter(id: string): RuntimeAdapter | undefined {
  return runtimeAdapters().find((adapter) => adapter.id === id);
}

export function runtimeAdapter(id: RuntimeId): RuntimeAdapter {
  const adapter = findRuntimeAdapter(id);
  if (!adapter) throw new Error(`child runtime '${id}' is not configured`);
  return adapter;
}

// fallback 的 runtime 顺序：配置（PLC_RUNTIME_FALLBACKS）在前，registry 的优先顺序在后。
// 配置里的名字没有登记时，丢掉它。
export function runtimeFallbackOrder(env: RuntimeEnv = process.env): RuntimeId[] {
  const configured = (env.PLC_RUNTIME_FALLBACKS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return [...configured, ...runtimeIds()].filter((runtime, index, all): runtime is RuntimeId =>
    isRuntimeId(runtime) && all.indexOf(runtime) === index);
}

// 用户停用的 runtime（2026-10-19，设置页「执行器」，config.json 的 runtimes.disabled）。
// daemon 启动时和设置改了以后把名单写进这个环境变量（apps/daemon 的 runtime-settings.ts），内核从这里读：
// 和 PLC_REVIEW_RUNTIME、PLC_RUNTIME_FALLBACKS 一样，子进程也继承它。测试不设它，所以不受本机配置影响。
// 停用是用户的决定，不是健康状态：选 runtime、选核查员、选型建议都跳过它，点名它的执行派发挂起等 Lead 改派。
// 核查请求不等：认领时换成下一个能用的核查员（2026-10-20，engine 的 dispatch.ts）。
export const DISABLED_RUNTIMES_ENV = "PLC_DISABLED_RUNTIMES";

export function disabledRuntimes(env: RuntimeEnv = process.env): RuntimeId[] {
  return (env[DISABLED_RUNTIMES_ENV] ?? "").split(",").map((value) => value.trim())
    .filter((runtime, index, all): runtime is RuntimeId => isRuntimeId(runtime) && all.indexOf(runtime) === index);
}

export function isRuntimeDisabled(runtime: RuntimeId, env: RuntimeEnv = process.env): boolean {
  return disabledRuntimes(env).includes(runtime);
}

// 停用的 runtime 被派发 gate 挂起时写的原因。Lead 的工具报错、选型建议的排除原因也用这一句。
export function runtimeDisabledReason(runtime: RuntimeId): string {
  return `用户在设置里停用了 ${findRuntimeAdapter(runtime)?.displayName ?? runtime}（设置 → 执行器）。`;
}

// 选核查员的候选顺序（2026-10-20）：PLC_REVIEW_RUNTIME（设置了的话）→ 能做可执行只读核查的 → 其余，各自按 registry 的顺序
// （内置是 codex、claude、pi）。executableReadOnlyReview 只影响排序，不再是硬闸：以前只有 codex 能当核查员，用户停用
// codex 以后核查一直挂着，Lead 和用户都换不了（2026-10-20 用户反馈）。Claude Code 当核查员时只开只读工具，pi 当核查员时
// 关掉 bash 和写文件的工具（各自的 adapter），任何 runtime 核查前后都比对工作区指纹，改了文件结论就不登记。
// 跳过停用和故障的 runtime 要查健康账本，由 engine 的 reviewer-choice.ts 做；这里只给顺序。
export function reviewRuntimeOrder(env: RuntimeEnv = process.env): RuntimeId[] {
  const configured = env.PLC_REVIEW_RUNTIME?.trim();
  const adapters = runtimeAdapters();
  return [
    ...(configured && isRuntimeId(configured) ? [configured] : []),
    ...adapters.filter((adapter) => adapter.capabilities.executableReadOnlyReview).map((adapter) => adapter.id),
    ...adapters.filter((adapter) => !adapter.capabilities.executableReadOnlyReview).map((adapter) => adapter.id),
  ].filter((runtime, index, all) => all.indexOf(runtime) === index);
}

// 不查健康账本时的核查员：顺序里第一个没被用户停用的。都停用了就返回第一个，请求由派发 gate 挂起并写明原因。
// 只给没有数据库的地方用（设置页）。派发和自动核查用 engine 的 pickReviewRuntime，它还跳过有故障的 runtime。
export function defaultReviewRuntime(env: RuntimeEnv = process.env): RuntimeId {
  const order = reviewRuntimeOrder(env);
  return order.find((runtime) => !isRuntimeDisabled(runtime, env)) ?? order[0]!;
}

// 本地 runtime：可执行文件在项目自己的 node_modules 里，不需要 daemon 的配置就能启动。
// runItem 没有拿到 runtime 实例时用它（例如测试），测试注入的 childPi 也是它。
// 多 runtime 之前，所有 Run 都跑在它上面。所以 runs.runtime 的 DDL 默认值是它，
// createRun 没有拿到 runtime 时也记成它。
export const LOCAL_RUNTIME_ID: RuntimeId = piAdapter.id;

export function createLocalRuntime(options: PiRuntimeOptions = {}): AgentRuntime {
  return piAdapter.create(options);
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<RuntimeId, AgentRuntime>();

  constructor(runtimes: AgentRuntime[] = []) {
    for (const runtime of runtimes) this.register(runtime);
  }

  register(runtime: AgentRuntime): void { this.runtimes.set(runtime.id, runtime); }

  get(id: RuntimeId): AgentRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`child runtime '${id}' is not configured`);
    return runtime;
  }

  list(): AgentRuntime[] { return [...this.runtimes.values()]; }
}

// daemon 的默认 registry：每个登记的 adapter 按默认配置创建一个实例。options 覆盖内置 adapter 的配置。
export function createDefaultRuntimeRegistry(options?: {
  pi?: PiRuntimeOptions;
  codex?: CodexRuntimeOptions;
  claude?: ClaudeRuntimeOptions;
}): RuntimeRegistry {
  const configured: Partial<Record<string, unknown>> = { ...options };
  return new RuntimeRegistry(runtimeAdapters().map((adapter) => adapter.create(configured[adapter.id])));
}

// 默认 registry 里这个 runtime 的 profile。daemon 没有注入自己的 registry 时，派发和执行用的就是它。
export function defaultRuntimeProfile(runtime: RuntimeId): RuntimeProfile {
  const profile = runtimeAdapter(runtime).create().profile;
  if (!profile) throw new Error(`child runtime '${runtime}' declares no profile`);
  return profile;
}

// 一个 runtime 实例的 profile。测试里的假 runtime 不声明 profile。
// 这时用同名 runtime 的默认 profile，派发 gate 也查这一个，两边因此一致。
export function runtimeProfileOf(runtime: AgentRuntime): RuntimeProfile {
  return runtime.profile ?? defaultRuntimeProfile(runtime.id);
}

// 内核的兜底分类器，只给没有类型的失败用。一种是 v26 之前落库的旧 Run。
// 另一种是内核自己观察到的失败，例如 runtime.start 抛错，或者进程退出却没有终止事件。
// 宿主代码自己写下的失败码先由内核认领。其余的失败交给这个 Run 的 adapter 的分类函数。
// 没有登记的 runtime（例如旧数据里已经移除的 runtime）只按 provider 诊断和进程启动失败分类。
export function classifyFailure(runtime: RuntimeId, evidence: FailureEvidence): TypedFailure {
  return classifyHostFailure(evidence)
    ?? findRuntimeAdapter(runtime)?.classifyFailure(evidence)
    ?? typedFailure(matchProviderFailure(evidence.message) ?? residualFailureCode(evidence), evidence);
}

// 一个失败 Run 的类型化失败：有落库的类型就用它，没有就按 error_code 和 error_message 兜底分类。
export function runFailure(
  run: Pick<Run, "runtime" | "error_code" | "error_message" | "failure_scope" | "failure_retry"
    | "failure_needs" | "failure_code" | "failure_evidence">,
): TypedFailure {
  return storedFailure(run)
    ?? classifyFailure(run.runtime, { errorCode: run.error_code, message: run.error_message });
}

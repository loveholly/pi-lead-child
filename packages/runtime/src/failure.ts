// 类型化失败（spec D1）。
// adapter 根据 CLI 的原生输出给出类型化失败。内核只在两种情况下自己分类：
// 一是 v26 之前落库、没有类型的旧 Run；二是内核自己观察到、没有经过 adapter 的失败。
// 两种情况都调用这个 Run 的 adapter 的分类函数（见 registry.ts）。
// 映射表只有一张，在 typed-failure.ts。这里是内核用的部分：决策边界、给人看的文字和恢复判断。
// 文字里的 runtime 名字从 registry 读（工单 12）。
import { localIso } from "@pi-lead-child/core";
import type { FailureScope, RunPurpose, RuntimeId, TypedFailure } from "@pi-lead-child/core";
import { findRuntimeAdapter } from "./registry.js";
import {
  FAILURE_CLASSES, usageResetAt, type FailureClass, type FailureCode, type RuntimeFailureCategory,
} from "./typed-failure.js";

export {
  classifyHostFailure, FAILURE_CLASSES, matchProviderFailure, residualFailureCode, storedFailure, typedFailure, usageResetAt,
  type FailureCode, type FailureEvidence, type RuntimeFailureCategory,
} from "./typed-failure.js";

// ── 决策边界 ───────────────────────────────────────────────────────────────────
// 只有 task 和 unknown 需要 lead 或用户判断要不要重试，也只有它们扣工单的重试额度。
// 其他作用域要么由系统处理，要么需要某个人去做一件具体的事：登录、充值、改配置、修宿主代码。
// 两条规则出自 D1 的同一张表，所以共用一个集合。
const LEAD_DECIDES: readonly FailureScope[] = ["task", "unknown"];

export function chargesRetryBudget(failure: Pick<TypedFailure, "scope">): boolean {
  return LEAD_DECIDES.includes(failure.scope);
}

export function leadDecides(failure: Pick<TypedFailure, "scope">): boolean {
  return LEAD_DECIDES.includes(failure.scope);
}

// 瞬时失败的决策边界（spec D5，工单 06）。scope 为 attempt、重试方式为 backoff 的失败，由内核退避后自动重试。
// 只重试执行、评审和集成的 Run。工单对话的回答过时就没有用了。修复回合有自己的额度（工单 09）。
// 代查（lookup，slack-takeover spec D5）也不重试：失败交回通道 hub，要不要重查由 hub 和用户决定。
// run_interrupted 的重试方式是 resume，不在这里：daemon 重启和租约过期已经把原来的请求交回队列。
const TRANSIENT_RETRY_PURPOSES: readonly RunPurpose[] = ["execution", "review", "integration"];

export function kernelRetriesTransient(failure: Pick<TypedFailure, "scope" | "retry">, purpose: RunPurpose): boolean {
  return failure.scope === "attempt" && failure.retry === "backoff" && TRANSIENT_RETRY_PURPOSES.includes(purpose);
}

// 这次失败由内核处理，不是这个 Run 自己的事：账本上的故障（工单 03），或者内核退避重试的瞬时失败（工单 06）。
// 这类失败不升起单个 Run 的 blocker，也不计入 reviewer 自己的重试次数。
export function kernelHandlesFailure(failure: Pick<TypedFailure, "scope" | "retry" | "code">, purpose: RunPurpose): boolean {
  return healthLevel(failure) !== null || kernelRetriesTransient(failure, purpose);
}

// 健康账本的决策边界（spec D2）。runtime 和 account 作用域的失败不属于工单，属于执行它的 profile。
// 这类失败记在账本上：派发挂起，每次故障只通知一次。
// 模型级故障只记在"profile 加模型"上。账号或代理不支持某个模型，不影响这个 profile 的其他模型。
export type HealthLevel = "profile" | "model";
// 用量额度（usage_limited）也只记在模型上：额度往往按模型算（Run #111 只有 Opus 用完了，Gemini 照样能用）。
const MODEL_LEVEL_CODES: readonly FailureCode[] = ["model_unsupported", "usage_limited"];

export function healthLevel(failure: Pick<TypedFailure, "scope" | "code">): HealthLevel | null {
  if (failure.scope !== "runtime" && failure.scope !== "account") return null;
  return (MODEL_LEVEL_CODES as readonly string[]).includes(failure.code) ? "model" : "profile";
}

// 恢复的决策边界（工单 04 的例外）。一般的故障到了退避时间就自动探针，探针通过就关闭故障（2026-10-20 起没有金丝雀）。
// 下面这些故障探针看不出来，也不会自己消失：账号或工作区停用后，codex login status 照样通过，
// 只有用户换了账号才会恢复。自动探针会一轮一轮地关闭故障、放出注定失败的 Run（工单 #98 的 Run #114–#116）。
// 所以它们只在用户运行 plc recheck 时探针。
const RECHECK_ONLY_CODES: readonly FailureCode[] = ["account_deactivated"];

export function recoversOnlyOnRecheck(failure: Pick<TypedFailure, "code">): boolean {
  return (RECHECK_ONLY_CODES as readonly string[]).includes(failure.code);
}

// 用量额度用完、报错里没写重置时间（工单 #117 的 Run 151–155：「resets Oct 26 at 4pm」这种写法认不出）。
// 探针只查登录和模型，看不到额度：这样的故障到了退避时间就被探针关闭，挂起的请求放回同一个用完的模型，又失败。
// 所以它和账号停用一样，只在用户 plc recheck 时探针（health-recovery.ts）。写了重置时间的，探针等到那个时间以后。
// at 是报错的时间：「Resets in 2h」这类相对时间从它算起。
export function usageResetUnknown(failure: Pick<TypedFailure, "code" | "evidence">, at: Date): boolean {
  return failure.code === "usage_limited" && usageResetAt(failure.evidence, at) === null;
}

// 账本上的失败以后，内核在同一个 runtime 和模型上排的那一次重试（manager.ts 的 runtime-health-retry）。
// 一般的故障照旧排，等故障关闭再放行：探针看得出它们恢复了没有。
// 用量额度用完（usage_limited）不能这样：探针看不到额度（工单 #117 连着失败五次）。
//   - 报错里写了重置时间：重试不早于那个时间（notBefore）。
//   - 没写：不排。换模型或 runtime 由 Lead 判断（2026-10-15 用户决定），Lead 用 recover_ticket_run 的 action=auto 换。
export type SameTargetRetry = { queue: true; notBefore: Date | null } | { queue: false };

export function sameTargetRetry(failure: Pick<TypedFailure, "code" | "evidence">, at: Date): SameTargetRetry {
  if (failure.code !== "usage_limited") return { queue: true, notBefore: null };
  const reset = usageResetAt(failure.evidence, at);
  return reset ? { queue: true, notBefore: reset } : { queue: false };
}

// 额度用完时给 Lead 的下一步。只给 Lead 看（inbox 的 leadNextStep），用户看的那一句是 healthIncidentNextStep。
export function usageLimitLeadNextStep(input: {
  itemId: number; runId: number; role: "executor" | "reviewer"; retry: SameTargetRetry;
}): string {
  if (input.role === "reviewer") return "这次核查派发时，系统自动换一个能用的核查员，不用做什么。";
  const recover = `用 recover_ticket_run（ticket_id=${input.itemId}，run_id=${input.runId}，action=auto）换一个 runtime 接着做`;
  if (input.retry.queue && input.retry.notBefore) {
    return `报错里写了重置时间：系统等到 ${localIso(input.retry.notBefore)} 以后，在这个模型上重试 Run #${input.runId}。`
      + `不想等就${recover}。`;
  }
  return `系统不会在这个用完的模型上自动重试 Run #${input.runId}。${recover}。`;
}

// ── 展示 ───────────────────────────────────────────────────────────────────────
// 名字由 adapter 声明。没有登记的 runtime（例如旧数据里已经移除的 runtime）显示它的 id。
export function runtimeDisplayName(runtime: RuntimeId): string {
  return findRuntimeAdapter(runtime)?.displayName ?? runtime;
}

export function failureCategory(failure: TypedFailure): RuntimeFailureCategory {
  const known = (FAILURE_CLASSES as Record<string, FailureClass>)[failure.code];
  if (known) return known.category;
  // 表里没有的码（例如以后新增的码出现在旧代码里）按作用域归组。
  if (failure.scope === "attempt") return "provider_unavailable";
  if (failure.scope === "runtime") return "runtime_configuration";
  if (failure.scope === "account") return failure.needs === "refill" ? "account_quota" : "authentication";
  if (failure.scope === "host") return "host_defect";
  if (failure.scope === "task") return "task_failure";
  return "unknown";
}

export function runtimeFailureTitle(runtime: RuntimeId, failure: TypedFailure): string {
  const agent = runtimeDisplayName(runtime);
  if (failure.code === "account_deactivated") return `${agent} 账号已停用`;
  if (failure.code === "usage_limited") return `${agent} 用量额度用完，在等重置`;
  if (failure.code === "network_error") return `${agent} 网络中断`;
  if (failure.code === "content_filtered") return `${agent} 的回答被 provider 的内容过滤拦下`;
  switch (failureCategory(failure)) {
    case "authentication": return `${agent} 认证失败`;
    case "account_quota": return `${agent} 账号余额不足`;
    case "usage_limit": return `${agent} 用量额度用完，在等重置`;
    case "model_capacity": return `${agent} 模型不可用`;
    case "provider_unavailable": return `${agent} Provider 不可用`;
    case "run_interrupted": return `${agent} Run 被中断`;
    case "session_expired": return `${agent} 会话已过期`;
    case "model_unsupported": return `${agent} 不支持该模型`;
    case "runtime_unavailable": return `${agent} 启动失败`;
    case "runtime_configuration": return `${agent} 配置错误`;
    case "host_defect": return "宿主代码出错";
    default: return `${agent} 运行失败`;
  }
}

// 瞬时失败的自动重试（spec D5，工单 06）。内核按这个结果写说明。
// retry：内核排了一次退避重试。exhausted：自动重试已经到上限，内核不再重试。
export type TransientRetryNote =
  | { kind: "retry"; attempt: number; limit: number; notBefore: string; resume: boolean }
  | { kind: "exhausted"; limit: number };

// 不需要 lead 决定的失败，检查点的"下一步"只做说明：系统会怎么处理，或者需要谁做什么。
// 这段文字同时给用户看，所以不写"Lead 应……"，也不让 lead 调用恢复工具。
export function failureNextStep(runtime: RuntimeId, failure: TypedFailure, transient?: TransientRetryNote): string {
  const agent = runtimeDisplayName(runtime);
  const free = "这次失败不扣工单的重试额度。";
  if (failure.needs === "code_fix") return `宿主代码出错，需要修复宿主代码。修复后，再处理这张工单。${free}`;
  const repair = healthRepair(agent, failure);
  if (repair) return `${repair}${healthHold(runtime, failure)}${free}`;
  if (failure.code === "session_not_found") {
    return `${agent} 原来的会话已经不存在（CLI 按保留期删除了它的记录），这个 Run 无法接着它做。`
      + `下一次续接时，系统会开一个新会话，并附上工单的上下文。${free}`;
  }
  const fault = failure.code === "content_filtered"
    ? "provider 的内容过滤拦下了这次回答。这常常是误判，再来一次往往就过。"
    : "这是瞬时失败，例如模型满载或网络中断。";
  if (transient?.kind === "retry") {
    const session = transient.resume ? "接着原来的 session 继续" : "重新开始这次尝试";
    return `${fault}系统会在 ${localIso(new Date(transient.notBefore))} 自动重试`
      + `（第 ${transient.attempt}/${transient.limit} 次），${session}。不需要任何操作。${free}`;
  }
  if (transient?.kind === "exhausted") {
    const tried = transient.limit > 0
      ? `系统已经自动重试 ${transient.limit} 次，仍然失败，所以停止自动重试。`
      : "自动重试已经关闭。";
    return `${fault}${tried}${agent} 已经标记为 degraded（不稳定）。需要用户稍后重试这张工单。${free}`;
  }
  // 内核只重试执行、评审和集成的 Run。工单对话的 Run 不自动重试。
  return `${fault}系统不会自动重试这个 Run，需要用户稍后再试。${free}`;
}

// 账本上的故障需要谁做什么。用户通知、lead 的说明和检查点都用这一段话。
function healthRepair(agent: string, failure: Pick<TypedFailure, "needs" | "code">): string | null {
  if (failure.code === "account_deactivated") return `需要用户换一个可用的 ${agent} 账号或工作区，然后重新登录 ${agent}。`;
  if (failure.code === "usage_limited") {
    return `${agent} 这个模型的用量额度用完了，要等额度重置。不用充值；急的话换一个模型或 runtime 接着做。`;
  }
  if (failure.needs === "login") return `需要用户重新登录 ${agent}。`;
  if (failure.needs === "refill") return `需要给 ${agent} 的账号充值。`;
  if (failure.code === "model_unsupported") {
    return `${agent} 的当前账号或代理不支持这个模型。需要换一个模型，或者修正 ${agent} 的账号或代理配置。`;
  }
  if (failure.code === "executable_missing" || failure.code === "runtime_start_failed") {
    return `${agent} 无法启动。需要安装 ${agent}，或者修正它的可执行文件路径。`;
  }
  if (failure.code === "extension_missing") return `${agent} 需要的扩展文件不存在。需要修正扩展文件的路径。`;
  if (failure.code === "interpreter_mismatch") {
    return `${agent} 运行在不符合要求的 Node 版本上。需要换成符合要求的 Node 版本。`;
  }
  if (failure.code === "tool_channel_unavailable") {
    return `${agent} 的会话没有连上 plc 工具通道，agent 无法交接成果。需要检查 plc 的 MCP 服务器能否启动。`;
  }
  if (failure.needs === "config") return `需要修正 ${agent} 的配置。`;
  return null;
}

// 账本上的故障让派发挂起（spec D2），探针通过就关闭故障（工单 04；2026-10-20 去掉了金丝雀）。这段话说明系统会怎样恢复，
// 以及用户修好之后怎样重检。只能由用户重检的故障（recoversOnlyOnRecheck）不说"定期重检"。
// 核查请求不在这里等：认领时换成下一个能用的核查员（engine 的 dispatch.ts），所以这段话只说执行。
function healthHold(runtime: RuntimeId, failure: Pick<TypedFailure, "scope" | "code">): string {
  const agent = runtimeDisplayName(runtime);
  const level = healthLevel(failure);
  if (!level) return "";
  const target = level === "model" ? `${agent} 这个模型` : agent;
  const held = `派发到 ${target} 的执行请求暂时挂起，不再创建会失败的 Run；核查请求自动换别的核查员。`;
  const release = "重检通过后，挂起的请求马上放行。";
  if (recoversOnlyOnRecheck(failure)) {
    return `${held}系统看不出它是否已经恢复，所以不会自动重检。修好后，需要运行 plc recheck ${runtime}。${release}`;
  }
  if (failure.code === "usage_limited") {
    return `${held}报错里写了重置时间时，系统等到那个时间再重检。没写时系统看不出额度什么时候恢复，不会自动重检：`
      + `额度恢复后，需要运行 plc recheck ${runtime}。${release}`;
  }
  return `${held}系统会定期重检。${release}修好后，可以运行 plc recheck ${runtime} 立即重检。`;
}

// 健康账本里一次故障（incident）的说明。用户通知和 lead 的说明用同一段话。
export function healthIncidentNextStep(runtime: RuntimeId, failure: Pick<TypedFailure, "scope" | "needs" | "code">): string {
  const agent = runtimeDisplayName(runtime);
  return `${healthRepair(agent, failure) ?? `需要修正 ${agent} 的配置。`}${healthHold(runtime, failure)}`;
}

// 失败对恢复意味着什么。2026-10-15 起它不再拦 Lead 的选择（recover_ticket_run 接受任何失败）：
// category 和 reason 写进账本，sameRuntimeModelFallback 给 auto 排候选，recoverable 和 nextRuntimeFallback
// 说明换 runtime 有没有可能有用，供展示和测试读。
export interface FailureRecovery {
  category: RuntimeFailureCategory;
  recoverable: boolean;
  sameRuntimeModelFallback: boolean;
  nextRuntimeFallback: boolean;
  reason: string;
}

const RECOVERY_REASONS: Record<RuntimeFailureCategory, string> = {
  model_capacity: "The selected model/provider is temporarily unavailable or at capacity.",
  provider_unavailable: "The provider is unavailable; a bounded fallback may be tried.",
  run_interrupted: "The host interrupted the run before it could finish; the request is dispatched again.",
  session_expired: "The runtime session to resume no longer exists; a fresh session with the ticket context can continue.",
  authentication: "The selected runtime is not authenticated; a configured authenticated runtime may be tried.",
  account_quota: "The selected runtime account is out of credits; a configured runtime with credits may be tried.",
  usage_limit: "The usage quota of this model or account is used up until it resets; another model or runtime may be tried.",
  model_unsupported: "The selected model is not available to this runtime account or proxy; another model or runtime may be tried.",
  runtime_unavailable: "The selected runtime could not be started; another configured runtime may be tried.",
  runtime_configuration: "The runtime configuration failed before task work could be evaluated.",
  host_defect: "The host failed while handling the run; this is not a child-runtime outage.",
  task_failure: "The run reached task execution and failed without a safe runtime fallback signal.",
  unknown: "The failure cause is not classified as a safe runtime recovery case.",
};

export function failureRecovery(failure: TypedFailure): FailureRecovery {
  const category = failureCategory(failure);
  // 换模型或换 runtime 只对外部故障有用。宿主缺陷不会因为换 runtime 而消失。task 和 unknown 由用户决定。
  const recoverable = failure.scope === "attempt" || failure.scope === "runtime" || failure.scope === "account";
  return {
    category,
    recoverable,
    sameRuntimeModelFallback: failure.scope === "attempt" || failure.code === "model_unsupported",
    nextRuntimeFallback: recoverable,
    reason: RECOVERY_REASONS[category],
  };
}

// 类型化失败的映射表和分类工具（spec D1）。adapter 和内核共用这一张表。
// adapter 用它把 CLI 的原生输出分类。这个模块不依赖任何 adapter，所以 adapter 可以引用它，
// 不会和 registry 形成循环依赖。内核读 adapter 知识的部分在 failure.ts（工单 12）。
import { isHostOutcomeRegistrationDefect } from "@pi-lead-child/core";
import type {
  FailureNeeds, FailureRetry, FailureScope, Run, TypedFailure,
} from "@pi-lead-child/core";

export type RuntimeFailureCategory =
  | "model_capacity"
  | "provider_unavailable"
  | "run_interrupted"
  | "session_expired"
  | "authentication"
  | "account_quota"
  | "usage_limit"
  | "model_unsupported"
  | "runtime_unavailable"
  | "runtime_configuration"
  | "host_defect"
  | "task_failure"
  | "unknown";

export interface FailureClass {
  scope: FailureScope;
  retry: FailureRetry;
  needs: FailureNeeds;
  // 给人看的分组，用于标题、keyFacts 和恢复工具的结果。
  category: RuntimeFailureCategory;
}

// D1 映射表。每个稳定错误码固定对应一行。
export const FAILURE_CLASSES = {
  out_of_credits: { scope: "account", retry: "never", needs: "refill", category: "account_quota" },
  // 用量额度用完、在等重置（2026-10-19，Run #111：「Individual quota reached … Resets in 162h16m36s」；Claude Code 的
  // 「You've hit your limit」「Usage limit reached」）。不用充值，等到重置时间就恢复，所以不通知用户，交给 Lead 换模型或 runtime。
  // 只记在这个模型上（failure.ts 的 MODEL_LEVEL_CODES）：同一个账号的别的模型往往还能用。
  usage_limited: { scope: "account", retry: "never", needs: "none", category: "usage_limit" },
  auth_required: { scope: "account", retry: "never", needs: "login", category: "authentication" },
  // 账号或它所在的工作区被停用（工单 #93）。需要用户换一个可用的账号。探针看不出它是否恢复（failure.ts 的 recoversOnlyOnRecheck）。
  account_deactivated: { scope: "account", retry: "never", needs: "login", category: "authentication" },
  model_unsupported: { scope: "runtime", retry: "other_runtime", needs: "config", category: "model_unsupported" },
  executable_missing: { scope: "runtime", retry: "never", needs: "config", category: "runtime_unavailable" },
  runtime_start_failed: { scope: "runtime", retry: "never", needs: "config", category: "runtime_unavailable" },
  extension_missing: { scope: "runtime", retry: "never", needs: "config", category: "runtime_configuration" },
  interpreter_mismatch: { scope: "runtime", retry: "never", needs: "config", category: "runtime_configuration" },
  // 会话初始化后 plc 工具通道没有就绪（工单 05，runs 53、54）。agent 没有交接工具，干了也交不了。
  tool_channel_unavailable: { scope: "runtime", retry: "never", needs: "config", category: "runtime_configuration" },
  provider_overloaded: { scope: "attempt", retry: "backoff", needs: "none", category: "model_capacity" },
  provider_unavailable: { scope: "attempt", retry: "backoff", needs: "none", category: "provider_unavailable" },
  network_error: { scope: "attempt", retry: "backoff", needs: "none", category: "provider_unavailable" },
  // provider 的内容过滤拦下了这次回答（2026-10-29 Run #183，pi 核查员："Provider finish_reason: content_filter"）。
  // 常常是误判，再来一次往往就过：只算这一次尝试的失败，内核退避后重试，不扣工单的重试额度。
  // 给人看的分组借用 provider_unavailable：App 的分组是固定的，标题按失败码另写（failure.ts）。
  content_filtered: { scope: "attempt", retry: "backoff", needs: "none", category: "provider_unavailable" },
  // 宿主打断了这次尝试：daemon 重启回收孤儿 Run，或派发租约在启动前过期。两条路径都会重新派发。
  run_interrupted: { scope: "attempt", retry: "resume", needs: "none", category: "run_interrupted" },
  // 要 resume 的外部会话已经不存在：CLI 按保留期删了它的记录（工单 #66 的 Run #71）。
  // 这次尝试失败了，任务没有问题。再 resume 同一个会话没有用，所以 retry 是 never。
  // 内核在同一个 Run 里开一个新会话接着做（manager.ts），调用方给不出新会话的提示时才记下这次失败。
  session_not_found: { scope: "attempt", retry: "never", needs: "none", category: "session_expired" },
  host_registration_failed: { scope: "host", retry: "never", needs: "code_fix", category: "host_defect" },
  host_exception: { scope: "host", retry: "never", needs: "code_fix", category: "host_defect" },
  // daemon 反复重启，同一份工作被接管或重派超过崩溃循环额度（工单 15）。多半是宿主的缺陷让 daemon 崩溃。
  restart_crash_loop: { scope: "host", retry: "never", needs: "code_fix", category: "host_defect" },
  task_failed: { scope: "task", retry: "never", needs: "none", category: "task_failure" },
  unknown: { scope: "unknown", retry: "never", needs: "none", category: "unknown" },
} as const satisfies Record<string, FailureClass>;

export type FailureCode = keyof typeof FAILURE_CLASSES;

// adapter 交给分类函数的原始证据。message 是 adapter 认定的终止原因，stderr 是进程输出的末尾。
export interface FailureEvidence {
  errorCode: string | null;
  message: string | null;
  stderr?: string | null;
}

const MAX_MESSAGE_EVIDENCE = 2_000;
const MAX_STDERR_EVIDENCE = 2_000;

// 崩溃输出的关键行在开头，长日志的关键行在末尾，所以超长时两头都留。
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

// 证据会落库。CLI 的认证报错里可能带着令牌，组织的安全规范不允许凭据进日志，所以先脱敏。
// 替换时保留前面的标签（"Bearer "、"api_key="），只换掉令牌本身。
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(bearer\s+)[\w.~+/=-]{8,}/gi, "$1[redacted]"],
  [/\b(?:sk|rk|pk)-[\w-]{12,}/g, "[redacted]"],
  [/((?:access|refresh|id)_token|api[_-]?key|secret|password)("?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, "$1$2[redacted]"],
];

function redact(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function typedFailure(code: FailureCode, evidence: FailureEvidence): TypedFailure {
  const { scope, retry, needs } = FAILURE_CLASSES[code];
  const message = clip((evidence.message ?? evidence.errorCode ?? "").trim(), MAX_MESSAGE_EVIDENCE);
  const stderr = evidence.stderr?.trim() ? clip(evidence.stderr.trim(), MAX_STDERR_EVIDENCE) : "";
  const text = stderr ? `${message}\n--- stderr ---\n${stderr}` : message;
  return { scope, retry, needs, code, evidence: redact(text) };
}

// 多家 CLI 都会原样转出的 provider 诊断。adapter 决定把哪段文本交给它。
// 终止错误可信，stderr 里常有与失败无关的报错。
// 顺序有意义：更具体的模式在前。例如"502：代理不认识该模型"是模型故障，不是瞬时的 5xx（run 62）。
const PROVIDER_PATTERNS: ReadonlyArray<readonly [RegExp, FailureCode]> = [
  // 停用在余额之前：停用的原文里也有 402（Run #113："unexpected status 402 Payment Required: … auth error code:
  // deactivated_workspace"）。
  [/deactivated_workspace|account_deactivated|(?:workspace|account) (?:has been |is |was )?deactivated/i,
    "account_deactivated"],
  // 402 只认带上下文的写法，和下面的 5xx 一样。裸的 "402" 会命中堆栈里的行号，例如 index.js:402:17。
  [/out of credits|credit balance is too low|insufficient_quota|exceeded your current quota|refill in order to continue|status:? ?402\b|\b402 payment required/i,
    "out_of_credits"],
  // 用量额度用完、在等重置。写法取自 Run #111（vibeproxy 转出的 Antigravity 429）和 Claude Code 2.1.258 二进制里的字符串。
  [/individual quota reached|"code":\s*"model_cooldown"|usage limit reached|you've (?:hit|reached) your (?:[\w-]+ )?limit/i,
    "usage_limited"],
  [/failed to authenticate|oauth (session|token)[^\n]*expired|refresh token (was|has been) (revoked|invalidated)|refresh_token_invalidated|not logged in|please run \/login|invalid api key|authentication_error/i,
    "auth_required"],
  // 最后两种写法：CLI 版本太旧，不认这个模型（2026-10-29 Run #164："Claude Code 2.1.258 does not support this model;
  // version 2.1.280 or newer is required."）。换 runtime 或升级 CLI 才能好，所以也是 model_unsupported。
  [/model[^\n]{0,80}not supported|unknown provider for model|cannot use model|model[^\n]{0,80}(does not exist|not found)|does not support (?:this|the) model|version [\d.]+ or newer is required/i,
    "model_unsupported"],
  // pi-ai 1.x 把 OpenAI 兼容接口的 finish_reason=content_filter 写成 "Provider finish_reason: content_filter"。
  // 只认 finish_reason 后面紧跟的写法：裸的 content_filter 可能是配置项或日志里的字段名。
  [/finish_reason\W{0,5}content_filter/i, "content_filtered"],
  [/at capacity|overloaded|rate.?limit|too many requests|status:? ?429/i, "provider_overloaded"],
  [/waiting for network|connection failed|error sending request|connection reset|econnreset|etimedout|socket hang up|stream disconnected/i,
    "network_error"],
  // 只认带上下文的 5xx。裸的 "502" 会命中堆栈里的行号。
  [/status:? ?50[0234]\b|bad gateway|service unavailable|gateway timeout|internal server error|temporarily unavailable/i,
    "provider_unavailable"],
];

// 用量额度的重置时间（usage_limited 的证据里常有）。认三种写法：
//   - 「Resets in 162h16m36s」「resets in 2h 5m」（Run #111 的 Antigravity 原文）
//   - 「"resetsAt":1792414800」（Claude Code 的 rate_limit_event，秒）
//   - 「"resets_at":"2026-10-19T15:00:00Z"」（ISO 时间）
// 认不出时返回 null。最多认 30 天以后：更远的多半是读错了。
const MAX_RESET_MS = 30 * 24 * 3_600_000;
export function usageResetAt(text: string | null | undefined, at: Date): Date | null {
  if (!text) return null;
  const relative = /resets? in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(text);
  if (relative) {
    let ms = 0;
    for (const part of relative[1]!.matchAll(/(\d+)\s*([dhms])/gi)) {
      const unit = part[2]!.toLowerCase();
      ms += Number(part[1]) * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
    }
    return ms > 0 && ms <= MAX_RESET_MS ? new Date(at.getTime() + ms) : null;
  }
  // 证据里的 JSON 可能又被转义了一层（\"resetsAt\":…），所以引号前后允许反斜杠。
  const epoch = /resets_?at[\\"]*\s*[:=]\s*[\\"]*(\d{10})\b/i.exec(text);
  const iso = /resets_?at[\\"]*\s*[:=]\s*[\\"]*(\d{4}-\d{2}-\d{2}T[^"\\]+)/i.exec(text);
  const when = epoch ? new Date(Number(epoch[1]) * 1_000) : iso ? new Date(iso[1]!) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  const ahead = when.getTime() - at.getTime();
  return ahead > 0 && ahead <= MAX_RESET_MS ? when : null;
}

export function matchProviderFailure(text: string | null | undefined): FailureCode | null {
  if (!text) return null;
  for (const [pattern, code] of PROVIDER_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

// 进程没能起来时记下的失败码。adapter 的 spawn 失败和内核的派发失败都在这里。
// runtime_unavailable / runtime_configuration 是旧版本写下的码，只会出现在旧数据里。
const START_FAILURE_CODES: readonly string[] = [
  "spawn_error", "claude_spawn_error", "dispatch_start_failed", "runtime_unavailable", "runtime_configuration",
];

// adapter 认不出具体原因时的收尾。进程没起来是 runtime 的事，其余一律 unknown。
// unknown 不自动重试，照旧扣重试额度，并且邀请 lead。未知情况因此落在需要关注的分支。
export function residualFailureCode(evidence: FailureEvidence): FailureCode {
  if (!START_FAILURE_CODES.includes(evidence.errorCode ?? "")) return "unknown";
  return /\bENOENT\b|command not found|no such file or directory/i.test(evidence.message ?? "")
    ? "executable_missing"
    : "runtime_start_failed";
}

// 宿主代码自己写下的失败码，不来自任何 adapter。
export function classifyHostFailure(evidence: FailureEvidence): TypedFailure | null {
  if (isHostOutcomeRegistrationDefect({ errorCode: evidence.errorCode, errorMessage: evidence.message })) {
    return typedFailure("host_registration_failed", evidence);
  }
  if (evidence.errorCode === "unhandled_run_exception") return typedFailure("host_exception", evidence);
  if (evidence.errorCode === "lease_expired") return typedFailure("run_interrupted", evidence);
  return null;
}

export function storedFailure(
  run: Pick<Run, "failure_scope" | "failure_retry" | "failure_needs" | "failure_code" | "failure_evidence">,
): TypedFailure | null {
  if (!run.failure_scope || !run.failure_retry || !run.failure_needs || !run.failure_code) return null;
  return {
    scope: run.failure_scope,
    retry: run.failure_retry,
    needs: run.failure_needs,
    code: run.failure_code,
    evidence: run.failure_evidence ?? "",
  };
}

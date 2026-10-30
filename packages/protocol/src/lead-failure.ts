// Lead 调用模型失败时，原始错误是 provider 返回的一整段文字（例如 `503: {"message":"auth_unavailable: …"}`）。
// 给人看的是一句白话；原文只放在「技术详情」里。顶栏的健康状态和会话里的失败卡片用同一套分类。
import { DEFAULT_LEAD_NAME } from "./lead-profile.ts";

export type LeadModelFailureKind =
  // 这台机器的网络断了：DNS 解析不了、网络不可达、离线、连接被拒或被重置（2026-10-15 19:11 起和
  // 2026-10-16 09:29 的 DarkWake：代理报 "lookup api.anthropic.com: no such host"）。不是模型的问题，
  // 网络恢复以后系统接着做。
  | "network"
  // 模型服务连不上（5xx、本机的模型代理没开）。系统会自己再试。
  | "unavailable"
  // 模型服务限流或过载。系统会自己再试。
  | "busy"
  // 模型账号认证失败，或者没有权限（401、403；代理的 auth_unavailable 里带着上游的 401、403）。再试也一样，要有人重新登录或换 key。
  | "auth"
  // 模型配置有误（模型名不存在、不支持）。再试也一样，要有人改配置。
  | "config"
  // Lead 的上下文满了，压缩没有成功（2026-10-28：摘要写到输出上限，压缩一直失败，回答被截成空的）。
  // 原样再试也一样；系统下一轮开始前先按长度预算压缩一次，还不行就换模型（model-failover.ts 的连续溢出）。
  | "context"
  | "unknown";

const BUSY = /\b(?:429|529)\b|rate.?limit|overloaded|capacity|too many requests/i;
const NETWORK = /no such host|ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|EHOSTUNREACH|ENETDOWN|network (?:is )?unreachable|ERR_INTERNET_DISCONNECTED|\boffline\b|ECONNREFUSED|ECONNRESET|connection (?:refused|reset)/i;
// 连本机回环地址被拒：是本机的模型代理没开，网络是好的。IPv6 的回环写作 ::1 或 [::1]（fe80::1 不是）。
const LOOPBACK = /\b127\.\d+\.\d+\.\d+|\blocalhost\b|\[::1\]|(?<![\w:])::1(?![\w.])/i;
// daemon 确认本机网络是通的（DNS 探测通过），模型的连接却被拒或被重置：是模型服务或它的代理的问题（发布评审 f796c1c 的 B1）。
const UPSTREAM_PREFIX = "模型服务连不上（本机网络正常）：";

// 给这种失败的原文加上说明，之后各处都把它分成"模型服务连不上"，不当断网。
export function markUpstreamFailure(raw: string): string {
  return raw.startsWith(UPSTREAM_PREFIX) ? raw : `${UPSTREAM_PREFIX}${raw}`;
}
const UNAVAILABLE = /\b5\d\d\b|unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out|fetch failed|socket hang up|network/i;
// 传输层的失败：请求没有拿到模型服务的回答（超时、连接断开、fetch 失败）。可能是本机网络在抖，也可能是模型服务的问题，
// 要先探一次网络才知道（2026-10-19 审查：以前直接算模型服务不可用，一次抖动就换模型）。
const TRANSPORT = /fetch failed|ETIMEDOUT|timed? ?out|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i;

/** 这次失败是不是传输层的（没拿到回答）：daemon 先探网络，断网就按断网处理，不换模型。本机代理的回环地址不算。 */
export function isLeadTransportFailure(raw: string): boolean {
  return !raw.startsWith(UPSTREAM_PREFIX) && TRANSPORT.test(raw) && !LOOPBACK.test(raw);
}
// auth_unavailable、no auth available 本身不算：代理在所有账号冷却、或者上游暂时 5xx 时也这么回，那是短暂的故障，
// 系统应该自己再试（发布评审）。用户实际遇到的那条里带着上游的 403 forbidden，靠后面的上游错误认出来。
const AUTH = /\b40[13]\b|unauthori[sz]ed|forbidden|request not allowed|invalid[ _-]?(?:x-)?api[ _-]?key|authentication failed|认证失败/i;
// 上下文满了：pi 的溢出恢复失败（"Context overflow recovery failed"），或者 daemon 记的「上下文满了」（lead-health.ts）。
const CONTEXT = /context overflow|上下文满了/i;
const CONFIG = /\b404\b|model[ _-]?not[ _-]?found|unknown[ _-]?model|invalid[ _-]?model|no such model|model .*not supported/i;

export function classifyLeadModelError(raw: string): LeadModelFailureKind {
  // 上下文满了排在最前面：原文里带着压缩时遇到的 503、超时一类的字样，也不能当成连不上（再试也一样）。
  if (CONTEXT.test(raw)) return "context";
  if (BUSY.test(raw)) return "busy";
  // 认证排在"连不上"前面。用户实际遇到的失败是代理的 503 auth_unavailable，里面包着上游的
  // 403 forbidden "Request not allowed"：状态码是 503，可再试也一样，要有人检查账号。
  if (AUTH.test(raw)) return "auth";
  if (raw.startsWith(UPSTREAM_PREFIX)) return "unavailable";
  if (NETWORK.test(raw) && !LOOPBACK.test(raw)) return "network";
  if (UNAVAILABLE.test(raw)) return "unavailable";
  if (CONFIG.test(raw)) return "config";
  return "unknown";
}

// 原因里称呼 Lead 用它的名字（设置 → 身份与风格，lead-profile.ts）。调用方不给时用缺省的名字。
const REASONS: Record<LeadModelFailureKind, (name: string) => string> = {
  network: () => "网络不可用",
  unavailable: (name) => `${name} 的模型服务暂时连不上`,
  busy: (name) => `${name} 的模型服务正忙`,
  auth: (name) => `${name} 的模型账号认证失败`,
  config: (name) => `${name} 的模型配置有误`,
  context: (name) => `${name} 的上下文满了，压缩没有成功`,
  unknown: (name) => `${name} 调用模型失败`,
};

// 系统自己再试也好不了的失败：要有人检查登录或配置。顶栏不承诺自动重试。
export function leadModelFailureNeedsUser(kind: LeadModelFailureKind): boolean {
  return kind === "auth" || kind === "config";
}

export function leadModelFailureReason(kind: LeadModelFailureKind, name: string = DEFAULT_LEAD_NAME): string {
  return REASONS[kind](name);
}

const SHORT_LABELS: Record<LeadModelFailureKind, string> = {
  network: "网络不可用",
  unavailable: "模型暂时连不上",
  busy: "模型正忙",
  auth: "模型认证失败",
  config: "模型配置有误",
  context: "上下文满了",
  unknown: "模型调用失败",
};

// 顶栏一行里放得下的说法。
export function leadModelFailureShortLabel(kind: LeadModelFailureKind): string {
  return SHORT_LABELS[kind];
}

// Lead 的一轮被 daemon 停机打断（部署、plc daemon stop、重启、SIGTERM，2026-10-16 07:57 的提醒 #83）。
// 这不是模型的问题，daemon 存下这一句作为这一轮的错误。下一个 daemon 接着处理：
//   · 这一轮没调工具：轮次停在 queued（带着这一句），下一个 daemon 再答一次；
//   · 已经调过工具：轮次是 failed（带着这一句），用户的话不再发一次。下一个 daemon 用一条系统事件叫醒 Lead，
//     事件里列出做完的工具和结果，由 Lead 接着回复。
// 客户端认这一句（isLeadRestartInterruption），不当成「Lead 没有回答」，也不给「重发」。
export const LEAD_RESTART_INTERRUPTED_ERROR = "Lead 的回复被 daemon 重启打断。";

export function isLeadRestartInterruption(raw: string | null | undefined): boolean {
  return raw?.trim() === LEAD_RESTART_INTERRUPTED_ERROR;
}

// 一轮 Lead 回合失败时给人看的一句话（plc chat 用；companion 的失败卡片说法相同，另外带着按钮）。
// system：Lead 自己发起的一轮，没有人在等回答；系统会在下一次需要时再叫醒 Lead。
// 用户的一轮失败了，系统不会替用户重发。认证和配置的失败再试也一样，不叫人重试，也不说系统会再试。
// 认不出的错误返回 null：调用方照原文显示。name 是 Lead 的名字，不给时用缺省的。
export function leadTurnFailureSentence(raw: string, options: { system: boolean; name?: string }): string | null {
  const name = options.name ?? DEFAULT_LEAD_NAME;
  // 被重启打断的用户的一轮是 failed 时，说明它已经调过工具：做过的事不重做，Lead 重启后接着回复。
  if (isLeadRestartInterruption(raw)) {
    return options.system
      ? `${name} 的这一轮被重启打断；重启后系统会继续，你不需要操作。`
      : `${name} 的回复被重启打断；已经做完的事不会重做，重启后 ${name} 会接着回复你。`;
  }
  const kind = classifyLeadModelError(raw);
  if (kind === "unknown") return null;
  const reason = REASONS[kind](name);
  // 断网：系统等网络恢复再接着做，不按"模型出错"说。
  if (kind === "network") {
    return options.system
      ? `${reason}，${name} 这次没能调用模型；网络恢复后系统会继续，你不需要操作。`
      : `${reason}，这条消息没有得到回答；你可以再发一次。`;
  }
  if (leadModelFailureNeedsUser(kind)) {
    const what = kind === "auth" ? "账号" : "配置";
    return options.system
      ? `${reason}；系统没法自己恢复，请检查 ${name} 的模型${what}。`
      : `${reason}，这条消息没有得到回答；请先检查 ${name} 的模型${what}，再发一次。`;
  }
  return options.system
    ? `${reason}；系统会自动再试，你不需要操作。`
    : `${reason}，这条消息没有得到回答；系统不会自动重发，你可以再发一次。`;
}

// 用户的一轮没答上，daemon 会在网络或模型恢复后自动再试一次（notice.created 带 retry=waiting）。
// 这时不是失败：不叫人重发（再发一次会多出一轮）。companion 和 plc chat 都用这一句。
// 被重启打断、还没调过工具的一轮（以及停机期间发来的消息）也在等：重启后的 daemon 再答一次。
export function leadTurnWaitingSentence(raw: string, waitingFor: "network" | "model", name: string = DEFAULT_LEAD_NAME): string {
  if (isLeadRestartInterruption(raw)) return `${name} 正在重启，这条消息还没有得到回答。重启后会自动再答一次。`;
  return waitingFor === "network"
    ? "网络不可用，这条消息还没有得到回答。网络恢复后会自动再试一次。"
    : `${REASONS[classifyLeadModelError(raw)](name)}，这条消息还没有得到回答。稍后会自动再试一次。`;
}

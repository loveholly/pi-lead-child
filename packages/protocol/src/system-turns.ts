// lead 自己发起的回合，以及 daemon 自己发出的系统通知。它们在会话流里各是一轮：
// 没有用户消息（userText 为空），没有发起的 binding，所有带 chat scope 的客户端都收得到。
// originKind 以 system: 开头，客户端用 systemTurnLabel 给它们贴标签。
import type { Locale } from "./i18n.ts";
import { sanitizeLeadReply } from "./reply-guard.ts";
import { systemTurnMessages } from "./system-turns.messages.ts";

export const SYSTEM_TURN_ORIGIN_PREFIX = "system:";

export const SYSTEM_TURN_ORIGINS = {
  // daemon 唤醒 lead 处理新的异常（blocker，以及标了 wakeLead 的说明）。
  blocker: "system:blocker",
  // daemon 让 lead 播报必须立即告知的通知。
  notification: "system:notification",
  // 旧版 daemon（工单 04 之前）的心跳巡检：长时间没人对话时，daemon 让 lead 消化积压的通知。
  // 现在的 daemon 不再发起这种回合，会话里已有的这种回合照常显示。
  heartbeat: "system:heartbeat",
  // 按批的摘要（Lead 事件主干 spec D3，工单 04、05）：常设指令 events.digest_batch 说该交给 Lead 时（最早的一条等满了，
  // 或者用户回来了），daemon 让 lead 看一批 digest 级的事。
  digest: "system:digest",
  // 上下文接近上限时，daemon 让 lead 先把要记住的东西存成笔记。
  precipitate: "system:precipitate",
  // daemon 自己发出的 blocker 提示（不经过 lead）。
  blockerNotice: "system:blocker-notice",
  // lead 没有按时播报，daemon 直接发出的通知（spec §4 的兜底投递）。
  fallbackNotice: "system:fallback-notice",
  // 一次高风险的主人操作（工单 15）：daemon 直接写的会话卡，带「不是我」。轮次编号是 ownerActionTurnId(事件编号, 凭证编号)。
  ownerAction: "system:owner-action",
  // 安全报警（security-alerts.ts）：daemon 发现有人绕过 API 改了账本里的设置、或者 child 想写账本，直接写的会话卡。
  securityAlert: "system:security-alert",
  // A requested compaction of Lead's context ended (compact_lead_context, /compact, 2026-11-18): the daemon writes one line
  // with the tokens before and after and the model that wrote the summary.
  contextNotice: "system:context-notice",
  // 提醒到点（工单 07）：Lead 空着时，daemon 为一条到点的提醒单独开一轮。这一轮说的话挂在提醒卡下面（lead.turn_responding）。
  reminder: "system:reminder",
} as const;

export type SystemTurnOrigin = typeof SYSTEM_TURN_ORIGINS[keyof typeof SYSTEM_TURN_ORIGINS];

// Lead 自己发起的回合只写「Lead」，和用户发起的回合一样：发生了什么由消息内容说明（2026-10-15 用户决定，
// 方案 A）。daemon 自己写的通知不是 Lead 在说话，标成系统通知。
// 系统通知的标签按界面语言（system-turns.messages.ts）。
const NOTICE_LABELS: Record<string, "blockerNotice" | "fallbackNotice" | "ownerAction" | "securityAlert" | "contextNotice"> = {
  [SYSTEM_TURN_ORIGINS.blockerNotice]: "blockerNotice",
  [SYSTEM_TURN_ORIGINS.fallbackNotice]: "fallbackNotice",
  [SYSTEM_TURN_ORIGINS.ownerAction]: "ownerAction",
  [SYSTEM_TURN_ORIGINS.securityAlert]: "securityAlert",
  [SYSTEM_TURN_ORIGINS.contextNotice]: "contextNotice",
};

// daemon 自己写的通知：不是 Lead 的回合，也不是任何人的回答。
export const DAEMON_NOTICE_ORIGINS: readonly SystemTurnOrigin[] = [
  SYSTEM_TURN_ORIGINS.blockerNotice, SYSTEM_TURN_ORIGINS.fallbackNotice, SYSTEM_TURN_ORIGINS.ownerAction,
  SYSTEM_TURN_ORIGINS.securityAlert, SYSTEM_TURN_ORIGINS.contextNotice,
];

export function isDaemonNoticeOrigin(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && (DAEMON_NOTICE_ORIGINS as readonly string[]).includes(originKind);
}

export function isSystemTurnOrigin(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && originKind.startsWith(SYSTEM_TURN_ORIGIN_PREFIX);
}

// 用户发起的回合返回 null。不认识的 system: 来源（更新的 daemon）也算 Lead 发起的回合。
// locale 暂时缺省 zh：plc chat 照旧输出中文，都迁完以后去掉缺省值。
export function systemTurnLabel(originKind: string | null | undefined, locale: Locale = "zh"): string | null {
  if (!isSystemTurnOrigin(originKind)) return null;
  const key = NOTICE_LABELS[originKind!];
  return key ? systemTurnMessages(locale)[key] : "Lead";
}

// Lead 自己发起的内部回合（摘要、整理笔记）没有要告诉用户的事时，只回复这个词。
// daemon 见到它（或者什么都没说）就不在会话里留下这一轮。
export const QUIET_REPLY = "NO_REPLY";

// Remove NO_REPLY at the start or the end of the text (with the full stop after it, also several in a row) and drop a made-up
// input envelope. The quiet word is for the daemon and never shows in the conversation. The rule is in reply-guard.ts: every exit uses it.
export function stripQuietReply(text: string): string {
  return sanitizeLeadReply(text).text;
}

export function isQuietReply(text: string): boolean {
  return sanitizeLeadReply(text).silent;
}

// 没有通知、也没有卡片的 blocker（例如派发重试用完）在会话里只留这一行，daemon 直接写，不经过 Lead：
// Lead 忙着、在整理笔记、或者模型连不上时，它照样在。开头总是「工单 #N」，客户端据此给出「打开工单」。
// locale 暂时缺省 zh，和 daemon 写进数据库的其他文字一样。
export function blockerNoticeText(itemId: number | null, summary: string, locale: Locale = "zh"): string {
  // 摘要开头的「工单 #N」就是这张工单时去掉，不说两遍。是另一张工单时保留：
  // orchestrator 把子工单的 reviewer 重试耗尽记在父工单上，两张工单都要点名。
  const reason = summary.trim()
    .replace(/^工单\s*#(\d+)\s*/u, (whole, id: string) => (Number(id) === itemId ? "" : whole))
    .replace(/^阻塞[：:]\s*/u, "")
    .replace(/^的\s*/u, "");
  const m = systemTurnMessages(locale);
  return itemId === null ? m.blockerSomewhere(reason) : m.blockerOnTicket(itemId, reason);
}

// 一行 blocker 记录说的是哪张工单（旧版 daemon 写的是「🔴 工单 #N 阻塞：…」，也认；英文写的是「Ticket #N …」）。
export function blockerNoticeTicketId(text: string): number | null {
  const match = /^(?:🔴\s*)?(?:工单|Ticket)\s*#(\d+)/u.exec(text.trim());
  return match ? Number(match[1]) : null;
}

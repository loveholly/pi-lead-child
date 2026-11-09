// 超预算转派（lead-tools-and-routing spec D7，用户 2026-10-27 采纳）。Lead 自己判断就地做还是派子 agent，判断错一次
// 的代价靠这道兜底变小：就地做的一轮，顶层的工具调用次数或时长超过阈值时，daemon 在这一轮里插一条提醒
// （system_event kind=overflow），请 Lead 二选一：把剩下的部分交给轻子 agent，或者先回用户一句还要多久再接着做。
// 每一轮只提醒一次。阈值可以用环境变量调。
// 2026-11-03（用户：「黄灯转红灯」）：这是黄灯，缺省 2 分钟（原来 3 分钟）。31 次提醒 Lead 只派出去 4 次，提醒里
// 「马上就能做完的可以做完」让它每次都觉得自己快做完了，这句去掉了。红灯在 red-line.ts。
import { leadSystemEvent } from "./envelope.js";

export const LEAD_OVERFLOW_TOOL_CALLS_ENV = "PLC_LEAD_OVERFLOW_TOOL_CALLS";
export const LEAD_OVERFLOW_MS_ENV = "PLC_LEAD_OVERFLOW_MS";
export const DEFAULT_OVERFLOW_TOOL_CALLS = 10;
export const DEFAULT_OVERFLOW_MS = 2 * 60_000;

export interface OverflowLimits {
  toolCalls: number;
  ms: number;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function overflowLimits(env: Record<string, string | undefined> = process.env): OverflowLimits {
  return {
    toolCalls: positive(env[LEAD_OVERFLOW_TOOL_CALLS_ENV], DEFAULT_OVERFLOW_TOOL_CALLS),
    ms: positive(env[LEAD_OVERFLOW_MS_ENV], DEFAULT_OVERFLOW_MS),
  };
}

export type OverflowReason = "tool_calls" | "duration";

/** 这一轮是不是超了。toolCalls 是这一轮到现在为止顶层的工具调用次数（codemode 脚本里的嵌套调用不算）。 */
export function overflowReached(
  state: { toolCalls: number; startedAt: number }, now: number, limits: OverflowLimits,
): OverflowReason | null {
  if (state.toolCalls >= limits.toolCalls) return "tool_calls";
  if (now - state.startedAt >= limits.ms) return "duration";
  return null;
}

// 代价信号（lead-self-routing spec C 第 3 条）：Lead 在一轮里时，一条外部消息排队超过这么久，插一条说明，同一轮只插一次。
export const LEAD_QUEUE_NOTICE_MS_ENV = "PLC_LEAD_QUEUE_NOTICE_MS";
export const DEFAULT_QUEUE_NOTICE_MS = 5 * 60_000;

export function queueNoticeMs(env: Record<string, string | undefined> = process.env): number {
  return positive(env[LEAD_QUEUE_NOTICE_MS_ENV], DEFAULT_QUEUE_NOTICE_MS);
}

// 用户本人的消息排队或插进来没回，超过这么久就插同一条说明（2026-11-03：以前只算外部的人，用户自己的消息 Lead 不知道）。
export const LEAD_USER_QUEUE_NOTICE_MS_ENV = "PLC_LEAD_USER_QUEUE_NOTICE_MS";
export const DEFAULT_USER_QUEUE_NOTICE_MS = 60_000;

export function userQueueNoticeMs(env: Record<string, string | undefined> = process.env): number {
  return positive(env[LEAD_USER_QUEUE_NOTICE_MS_ENV], DEFAULT_USER_QUEUE_NOTICE_MS);
}

/** 排着队的一个对话：谁、在哪个对话里、几条、排了多久。 */
export interface WaitingConversation {
  who: string;
  conversation: string;
  count: number;
  waitedMs: number;
  // 用户本人的消息（不是外部的人）。
  user?: boolean;
  // 每条的第一句（只给用户本人在这一轮里插进来或排着的消息）：Lead 据此判断它是不是对手上这件事的纠正。
  firstLines?: readonly string[];
}

/** 一条消息的第一句：第一行非空的字，最长 60 个字。 */
export function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function waited(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}

/** 「Owen（韩梅梅 Owen Li 的私信，1 条）等了 6 分钟」，几个对话用分号隔开。没有排队的时候是 null。 */
export function waitingText(waiting: readonly WaitingConversation[]): string | null {
  if (!waiting.length) return null;
  return waiting.map((entry) => {
    const lines = entry.firstLines?.length ? `：${entry.firstLines.map((line) => `「${line}」`).join("")}` : "";
    return `${entry.who}（${entry.conversation}，${entry.count} 条）等了 ${waited(entry.waitedMs)}${lines}`;
  }).join("；");
}

/** 排队超过阈值时插进这一轮的说明。是信息，不是命令：Lead 自己判断先回他们、做完再回，还是把剩下的派出去。 */
export function queueNotice(waiting: readonly WaitingConversation[]): string {
  return leadSystemEvent("queue", [
    `有人在等你：${waitingText(waiting) ?? ""}。排着队的消息要等这一轮结束才交给你；已经插进来的，你还没回。`,
    "这件事还要好几步时，可以把剩下的交给轻子 agent，先处理他们；马上就能做完的，做完再处理。",
  ].join("\n"));
}

/**
 * 插进这一轮的提醒（黄灯）。extra：上下文用了多少（lead 的 contextUsageLine）、谁在等（waitingText）、红线是多久，
 * 让 Lead 看到为什么该派出去，而不只是「该派」（lead-self-routing spec C）。
 */
export function overflowReminder(
  state: { toolCalls: number; startedAt: number }, now: number, reason: OverflowReason,
  extra: { context?: string | null; waiting?: string | null; redLine?: string | null } = {},
): string {
  const minutes = Math.max(1, Math.round((now - state.startedAt) / 60_000));
  const what = reason === "tool_calls" ? `已经调用了 ${state.toolCalls} 次工具` : `已经做了约 ${minutes} 分钟`;
  return leadSystemEvent("overflow", [
    `这一轮${what}，比就地做的活大。用户在这期间发的消息要排队，你的上下文也在变大。`,
    ...(extra.context ? [extra.context] : []),
    extra.waiting ? `现在在等你的：${extra.waiting}。` : "现在没有人在等你。",
    "二选一：",
    "1. 用 hand_off 把剩下的交给子 agent（一次调用；交接包里有你做过的步骤和结果，子 agent 不用从头再查），note 写一句还剩什么；"
      + "然后用一句话告诉用户你交出去了、大约多久有结果。轻子 agent 通常要 3–5 分钟。",
    "2. 自己接着做：先用一句话告诉用户你在做什么、还要多久，再接着做。",
    ...(extra.redLine ? [`做到 ${extra.redLine} 时，系统会停下这一轮，请你把没做完的交出去。`] : []),
  ].join("\n"));
}

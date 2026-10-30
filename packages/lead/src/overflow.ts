// 超预算转派（lead-tools-and-routing spec D7，用户 2026-10-27 采纳）。Lead 自己判断就地做还是派子 agent，判断错一次
// 的代价靠这道兜底变小：就地做的一轮，顶层的工具调用次数或时长超过阈值时，daemon 在这一轮里插一条提醒
// （system_event kind=overflow），请 Lead 把剩下的部分交给轻子 agent。提醒不是硬停：马上就能做完的可以做完。
// 每一轮只提醒一次。阈值可以用环境变量调（spec 待定项 3：缺省 10 次或 3 分钟，先观察一周再调）。
import { leadSystemEvent } from "./envelope.js";

export const LEAD_OVERFLOW_TOOL_CALLS_ENV = "PLC_LEAD_OVERFLOW_TOOL_CALLS";
export const LEAD_OVERFLOW_MS_ENV = "PLC_LEAD_OVERFLOW_MS";
export const DEFAULT_OVERFLOW_TOOL_CALLS = 10;
export const DEFAULT_OVERFLOW_MS = 3 * 60_000;

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

/** 排着队的一个对话：谁、在哪个对话里、几条、排了多久。 */
export interface WaitingConversation {
  who: string;
  conversation: string;
  count: number;
  waitedMs: number;
}

function waited(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}

/** 「Owen（韩梅梅 Owen Li 的私信，1 条）排了 6 分钟」，几个对话用分号隔开。没有排队的时候是 null。 */
export function waitingText(waiting: readonly WaitingConversation[]): string | null {
  if (!waiting.length) return null;
  return waiting.map((entry) => `${entry.who}（${entry.conversation}，${entry.count} 条）排了 ${waited(entry.waitedMs)}`).join("；");
}

/** 排队超过阈值时插进这一轮的说明。是信息，不是命令：Lead 自己判断先回他们、做完再回，还是把剩下的派出去。 */
export function queueNotice(waiting: readonly WaitingConversation[]): string {
  return leadSystemEvent("queue", [
    `有人在等你：${waitingText(waiting) ?? ""}。这一轮结束以前，他们的消息不会交给你。`,
    "这件事还要好几步时，可以把剩下的交给轻子 agent，先处理他们；马上就能做完的，做完再处理。",
  ].join("\n"));
}

/**
 * 插进这一轮的提醒。extra：上下文用了多少（lead 的 contextUsageLine）、谁在排队（waitingText），
 * 让 Lead 看到为什么该派出去，而不只是「该派」（lead-self-routing spec C）。
 */
export function overflowReminder(
  state: { toolCalls: number; startedAt: number }, now: number, reason: OverflowReason,
  extra: { context?: string | null; waiting?: string | null } = {},
): string {
  const minutes = Math.max(1, Math.round((now - state.startedAt) / 60_000));
  const what = reason === "tool_calls" ? `已经调用了 ${state.toolCalls} 次工具` : `已经做了约 ${minutes} 分钟`;
  return leadSystemEvent("overflow", [
    `这一轮${what}，比就地做的活大。用户在这期间发的消息要排队，你的上下文也在变大。`,
    ...(extra.context ? [extra.context] : []),
    ...(extra.waiting ? [`现在排着队的：${extra.waiting}。`] : []),
    "把剩下的部分交给轻子 agent（create_task 的 light=true，再 spawn_child）：把已经查到的东西写进任务说明，子 agent 不用从头再查；"
      + "然后用一句话告诉用户你派出去了、结果回来后会告诉他。",
    "马上就能做完的（例如只差一两步），可以做完，在回复里说明一句。",
  ].join("\n"));
}

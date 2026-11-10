// 红灯（用户 2026-11-03：「黄灯转红灯」，lead-tools-and-routing spec D7）。黄灯是 overflow.ts 的提醒。
// 就地做的一轮做到 2 分半，有人在等（用户或外部的人；系统事件不算）时，daemon 停下这一轮：
//   · 正在跑的写操作（bash、往外写的连接调用）先做完，最多等 PLC_LEAD_WRITE_GRACE_MS：中途打断的写操作结果写成
//     「已中断」，事情却可能已经做了，Lead 或接手的子 agent 会再做一次（例如同一条消息发两遍）；
//   · 然后中断这一轮（pi 的 abort），在同一轮里马上给 Lead 一条红线消息，排在排队的消息前面：谁在等、等了多久，
//     请它把手上没做完的交给子 agent，写好交接；
//   · 之后这一轮只能用交接的工具（redLineGateExtension），交接完限制解除，接着答排队的消息。
// 没有人在等时不停，只再提醒一次。2026-11-03 那天：一轮就地查了 6 分多钟，三条消息排了 6–9 分钟；31 次黄灯提醒，
// Lead 只派出去 4 次。
// 2026-11-09（lead-scheduler spec P2，用户的决定 10）：这是「被迫交」（H1）。没有人在等也停下；交接用一次 hand_off
// （交接包由系统附上），交接窗口从 3 分钟缩到 30 秒（H8）；窗口里没交，单元挂起（H10），下一轮由 Lead 决定。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { leadSystemEvent } from "./envelope.js";
import { waitingText, type WaitingConversation } from "./overflow.js";

export const LEAD_RED_LINE_MS_ENV = "PLC_LEAD_RED_LINE_MS";
export const LEAD_WRITE_GRACE_MS_ENV = "PLC_LEAD_WRITE_GRACE_MS";
export const LEAD_HANDOFF_MS_ENV = "PLC_LEAD_HANDOFF_MS";
export const DEFAULT_RED_LINE_MS = 150_000;
export const DEFAULT_WRITE_GRACE_MS = 30_000;
// 红线消息送到以后，交接最多做多久。到点还没做完，daemon 再中断一次，这一轮结束，单元挂起，排着的消息照常交给 Lead。
// 影子回放（2026-11-03 的真实会话、真实模型）：手写任务说明再建单、派出，交接一件调查约 40 秒，建 4 张工单再派出约 80–90 秒，
// 所以以前的上限是 3 分钟。P2 起交接是一次 hand_off 调用加一句话（交接包由系统拼），目标 10 秒以内，窗口是 30 秒（spec H8）。
export const DEFAULT_HANDOFF_MS = 30_000;

export interface RedLineLimits {
  ms: number;
  writeGraceMs: number;
  handoffMs: number;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function redLineLimits(env: Record<string, string | undefined> = process.env): RedLineLimits {
  return {
    ms: positive(env[LEAD_RED_LINE_MS_ENV], DEFAULT_RED_LINE_MS),
    writeGraceMs: positive(env[LEAD_WRITE_GRACE_MS_ENV], DEFAULT_WRITE_GRACE_MS),
    handoffMs: positive(env[LEAD_HANDOFF_MS_ENV], DEFAULT_HANDOFF_MS),
  };
}

// 红线以后能用的工具：交接（建轻任务、派子 agent）、给自己记一条（只有 Lead 能做的部分）、记笔记、
// 按纠正收回已经派出去的（取消工单、工单操作），和回外部来源一句话（外部消息叫醒的一轮）。
export const RED_LINE_HANDOFF_TOOLS: readonly string[] = [
  "hand_off", "create_task", "spawn_child", "follow_up", "save_note", "update_note", "cancel_item", "ticket_action", "reply_to_source",
];

export const RED_LINE_GATE_REASON = "这一轮已经超过就地预算，系统停下了它。现在只能交接："
  + `${RED_LINE_HANDOFF_TOOLS.join("、")}。用 hand_off 把没做完的交给子 agent（交接包系统已经备好），`
  + "然后用一句话告诉用户。别的事等下一轮。";

/** 「2 分 30 秒」「45 秒」。 */
export function durationText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${seconds} 秒`;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/**
 * 红线时送进这一轮的消息：排在排队的消息前面（被迫交，spec H1）。windowMs 是交接窗口：窗口里没交，单元挂起。
 * waiting 为空：没有人在等，照样交（待定 9）。
 */
export function redLineMessage(elapsedMs: number, waiting: readonly WaitingConversation[], windowMs = DEFAULT_HANDOFF_MS): string {
  const who = waitingText(waiting);
  return leadSystemEvent("red_line", [
    `系统停下了这一轮：你已经就地做了 ${durationText(elapsedMs)}，到了就地预算。`
      + (who ? `有人在等你：${who}。` : "现在没有人在等你，但下一条输入随时会来，所以照样交出去。"),
    ...(who ? ["先看在等的消息是不是对手上这件事的纠正（例如「已经有了」「不用做了」「换个做法」）。是的话，照纠正改，不要把旧的计划交出去。"] : []),
    "把没做完的交给子 agent：调用一次 hand_off，note 写一句话：已经知道什么、还剩什么。交接包（目标、你做过的步骤和结果、"
      + "已经提交和状态未知的写操作、碰过的对象）由系统附上，你不用再写任务说明。",
    "剩下的只有你能做（工单操作、以你的身份发消息、记笔记）时，用 follow_up 给自己记一条，写明还剩什么。",
    "然后用一句话告诉用户：交给了后台 agent、大约多久有结果。这一轮到这里结束，系统接着把在等的消息交给你。",
    `交接窗口是 ${durationText(windowMs)}：这期间没有交出去，这件事会挂起，下一轮由你决定接着做还是交出去。`,
    `现在只能用这几个工具：${RED_LINE_HANDOFF_TOOLS.join("、")}。`,
  ].join("\n"));
}

/** 过了红线、没有人在等时再提醒一次。不停下这一轮。 */
export function overflowSecondReminder(elapsedMs: number, extra: { context?: string | null } = {}): string {
  return leadSystemEvent("overflow", [
    `这一轮你已经就地做了 ${durationText(elapsedMs)}，现在没有人在等你。`,
    ...(extra.context ? [extra.context] : []),
    "还要好几步时，把剩下的交给轻子 agent；自己接着做时，先用一句话告诉用户还要多久。",
    "有人开始等你时，系统会停下这一轮，请你把没做完的交出去。",
  ].join("\n"));
}

/**
 * 停下这一轮会不会把这个调用做到一半（要先等它做完）：bash 和 pi 的 edit、write 收到中断就停；连接调用除了只读的
 * （服务器标了 readOnlyHint）都算写。Lead 自己的工具不理中断信号，pi 等它们做完，不算。
 * readOnlyConnectionTool：这个连接的这个工具是不是只读（连接 hub 的 isReadOnlyTool）。
 */
export function interruptibleWrite(
  name: string, args: unknown, readOnlyConnectionTool: (connection: string, tool: string) => boolean,
): boolean {
  if (name === "bash" || name === "edit" || name === "write") return true;
  if (name !== "call_connection_tool") return false;
  const input = (args ?? {}) as { connection?: unknown; tool?: unknown };
  return !(typeof input.connection === "string" && typeof input.tool === "string"
    && readOnlyConnectionTool(input.connection, input.tool));
}

/** pi 扩展：红线以后这一轮只能用交接的工具。gate 返回现在能用的工具；没有限制时为 null。 */
export function redLineGateExtension(gate: () => ReadonlySet<string> | null, log?: (line: string) => void): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      const allowed = gate();
      if (!allowed || allowed.has(event.toolName)) return undefined;
      log?.(`[lead] ${event.toolName} refused after the red line`);
      return { block: true, reason: RED_LINE_GATE_REASON };
    });
  };
}

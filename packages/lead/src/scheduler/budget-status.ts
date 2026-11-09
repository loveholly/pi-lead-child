// 每一步的预算状态（lead-scheduler spec D3、H2，P2）：每次模型请求前，Lead 看到一行
//   L0 · 已用 42 秒（3 步）· 预算 2 分 30 秒 · 在等：无
// 这样它每一步都能重新预估：还剩几步、要不要中途交出去（hand_off）。不另加一次工具调用，预估就是 Lead 每一步的做法。
// 这一行由 extension 附在一批工具的最后一个结果后面（extension.ts），和结果一起存进会话，不破坏提示缓存的前缀。
//
// 一步的 p90（让出点的判断用，D4）：2026-11-04 到 11-09 的 195 次用户运行，一步 p50 约 7 秒、p90 约 19 秒。
import { leadSystemEvent } from "../envelope.js";
import { durationText } from "../red-line.js";
import { countedWaiting, type WaitingEntry } from "./core.js";
import { laneName, type Lane } from "./lanes.js";

export const LEAD_STEP_P90_MS_ENV = "PLC_LEAD_STEP_P90_MS";
export const DEFAULT_STEP_P90_MS = 19_000;

export function stepP90Ms(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_STEP_P90_MS_ENV]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STEP_P90_MS;
}

function waited(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}

/** 预算状态的一行（不带外层的 system_event）。 */
export function budgetStatusText(input: {
  lane: Lane; usedMs: number; steps: number; budgetMs: number; waiting: readonly WaitingEntry[];
}): string {
  const counted = countedWaiting({ lane: input.lane }, input.waiting);
  const held = input.waiting.length - counted.length;
  const who = counted.length
    ? counted.map((entry) => `${entry.user ? "用户" : entry.who} ${entry.count} 条，等了 ${waited(entry.waitedMs)}`).join("；")
    : "无";
  const left = Math.max(0, input.budgetMs - input.usedMs);
  return [
    laneName(input.lane),
    `已用 ${durationText(Math.max(1_000, input.usedMs))}（${input.steps} 步）`,
    `预算 ${durationText(input.budgetMs)}，还剩 ${left > 0 ? durationText(left) : "0 秒"}`,
    `在等：${who}${held > 0 ? `（另有 ${held} 个外部对话排队，这件事做完或交出去以后再处理）` : ""}`,
  ].join(" · ");
}

/** 附在工具结果后面的那一行：包成 <system_event kind="budget">。 */
export function budgetStatusLine(input: Parameters<typeof budgetStatusText>[0]): string {
  return leadSystemEvent("budget", `${budgetStatusText(input)}。剩下的超过预算时，用 hand_off 交出去。`);
}

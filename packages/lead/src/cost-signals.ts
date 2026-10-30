// 代价信号（.scratch/lead-self-routing/spec.md C，用户 2026-10-28：「让它自己判断就地做还是派轻子 agent，不加强制限制」）。
// Lead 判断一件事就地做还是派出去，要看得到做它的代价。2026-10-28 那次评审，Lead 的上下文已经约 48 万 token，它不知道；
// 它把 PR #119 的全部文件读进来核对行号，上下文超过了压缩线。这里给 Lead 几个数，都是信息，不拦任何调用：
//   - 上下文用了多少、在哪里压缩（每一轮的当前局面里一行，daemon 写）；
//   - 一个工具结果很大时，结果末尾加一句尾注：它有多大、上下文现在到哪了（这个扩展）；
//   - 有人排队多久（daemon 插一条说明），交回的结果有多长（daemon 的 run-finished.ts）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// 工具结果超过多少 token 时加尾注。PLC_LEAD_RESULT_NOTE_TOKENS 可以改。
export const LEAD_RESULT_NOTE_TOKENS = 8_000;

export function resultNoteTokens(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.PLC_LEAD_RESULT_NOTE_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : LEAD_RESULT_NOTE_TOKENS;
}

/** 给人看的 token 数：一万以上写成「45.2 万」，以下照写。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 10_000) return String(Math.round(tokens));
  return `${(tokens / 10_000).toFixed(1).replace(/\.0$/u, "")} 万`;
}

/**
 * 一段文字大约多少 token。中文（和别的非 ASCII 字符）大约一个字一个 token，英文和代码大约四个字符一个 token。
 * 只用来给 Lead 一个量级，不用来算账。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return other + Math.ceil(ascii / 4);
}

export interface LeadContextUsage {
  tokens: number;
  window: number;
  // 自动压缩线（窗口减 reserveTokens）。不知道时为 null。
  compactAt: number | null;
}

function usageText(usage: LeadContextUsage): string {
  const percent = Math.round((usage.tokens / usage.window) * 100);
  const line = `约 ${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.window)} token（${percent}%）`;
  return usage.compactAt === null ? line : `${line}，约 ${formatTokenCount(usage.compactAt)}时自动压缩`;
}

/** 当前局面「关于你自己」一节的那一行。 */
export function contextUsageLine(usage: LeadContextUsage): string {
  return `你的上下文：${usageText(usage)}。`;
}

/**
 * Lead 会话现在的上下文用量：最近一次回答的 usage（和 pi 的算法一样，input、output、cacheRead、cacheWrite 加起来）。
 * reserveTokens 是压缩参数（compaction-settings.ts），给了时算出压缩线。读不到时为 null。
 */
export function leadContextUsage(session: unknown, reserveTokens: number | null): LeadContextUsage | null {
  const value = session as { model?: { contextWindow?: unknown }; agent?: { state?: { messages?: unknown } } } | null;
  const window = value?.model?.contextWindow;
  const messages = value?.agent?.state?.messages;
  if (typeof window !== "number" || window <= 0 || !Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; usage?: Record<string, unknown> } | undefined;
    if (message?.role !== "assistant" || !message.usage) continue;
    const count = (key: string) => (typeof message.usage![key] === "number" ? message.usage![key] as number : 0);
    const tokens = count("input") + count("output") + count("cacheRead") + count("cacheWrite");
    return { tokens, window, compactAt: reserveTokens === null ? null : window - reserveTokens };
  }
  return null;
}

/**
 * 大的工具结果加一句尾注。codemode 脚本里嵌套的调用不加：结果交给脚本，脚本可能按 JSON 解析它，
 * 脚本自己的结果（顶层的那一个）够大时照样加。compactAt：按窗口算压缩线（Lead 会话的压缩参数）。
 */
export function costSignalsExtension(options: { thresholdTokens?: number; compactAt?: (window: number) => number | null } = {}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (event, ctx) => {
      if (event.parentToolCallId) return undefined;
      const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const size = estimateTextTokens(text);
      if (size < (options.thresholdTokens ?? resultNoteTokens())) return undefined;
      const usage = ctx.getContextUsage();
      const now = usage && usage.tokens !== null
        ? `你的上下文现在${usageText({
          tokens: usage.tokens + size, window: usage.contextWindow, compactAt: options.compactAt?.(usage.contextWindow) ?? null,
        })}。`
        : "";
      return { content: [...event.content, { type: "text" as const, text: `（这个结果约 ${formatTokenCount(size)} token。${now}）` }] };
    });
  };
}

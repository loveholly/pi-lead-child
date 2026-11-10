// 历史太长、一次放不进摘要请求时，分段压缩（2026-11-01）。
//
// 2026-10-31 晚上，压缩用的模型连续几个小时返回 503，压缩一直失败，Lead 的上下文涨到约 135 万 token，超过模型 100 万的上限。
// 这时 pi 的压缩把要摘要的消息拼成一个请求，请求本身就超长（prompt is too long）：压缩永远成功不了，Lead 每一轮都失败，
// 重启也一样。
//
// 这里接住 pi 的 session_before_compact：
//   - 要摘要的历史放得进一次请求时什么都不做，pi 照常压缩。
//   - 放不进时按段滚动摘要：每一段带上前一段写好的摘要（pi 的 generateSummaryWithUsage 的 previousSummary），
//     最后一段的摘要就是这次压缩的结果。单条放不进一段的消息（巨大的工具结果）先截短：它反正要被摘要掉。
//   - 每写完一段告诉 daemon（onProgress），daemon 重新计压缩的时限：时限防的是一次调用卡住，不是段数多。
// 估算用 core 的 estimateTokens（中日韩文字每个 1 个 token），pi 的估算按 4 个字符 1 个 token，对中文偏少。
import {
  convertToLlm, generateSummaryWithUsage, serializeConversation,
  type ExtensionContext, type ExtensionFactory, type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@pi-lead-child/core";

type CompactionMessage = Parameters<typeof convertToLlm>[0][number];
type SummaryUsage = Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"];

/** 一段最多占模型窗口的多少：估算有误差，摘要请求里还有说明和上一段的摘要。 */
export const CHUNK_WINDOW_SHARE = 0.5;
/** 再小的模型窗口，一段也至少这么多 token。 */
const MIN_CHUNK_TOKENS = 2_000;
// 截短一条消息时，每个长字符串至少留这么多字。
const MIN_KEPT_CHARS = 200;

export interface CompactionProgress {
  // 写完了第几段（从 1 开始），一共几段。
  done: number;
  total: number;
  // 要摘要的历史一共估多少 token。
  tokens: number;
}

/** 一条消息发给摘要模型时大约多少 token（按它序列化以后的文字算）。 */
export function messageTokens(message: CompactionMessage): number {
  return estimateTokens(serializeConversation(convertToLlm([message])));
}

/** 一段的 token 上限：窗口的一半，再减去摘要输出的预留。 */
export function chunkTokenBudget(contextWindow: number, reserveTokens: number): number {
  return Math.max(MIN_CHUNK_TOKENS, Math.floor(contextWindow * CHUNK_WINDOW_SHARE) - reserveTokens);
}

// 把一条消息里的长字符串按同一个比例截短，头尾各留一半，中间写明省略了多少字。消息的结构和角色不变。
function shrinkStrings(value: unknown, ratio: number): unknown {
  if (typeof value === "string") {
    if (value.length <= MIN_KEPT_CHARS * 2) return value;
    const keep = Math.max(MIN_KEPT_CHARS * 2, Math.floor(value.length * ratio));
    if (keep >= value.length) return value;
    const half = Math.floor(keep / 2);
    return `${value.slice(0, half)}\n[……压缩时省略了 ${value.length - keep} 字……]\n${value.slice(value.length - half)}`;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, ratio));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkStrings(item, ratio)]));
  }
  return value;
}

/** 把一条放不进一段的消息截短到一段以内。截不到时（结构本身就太大）原样返回。 */
export function shrinkMessage(message: CompactionMessage, budget: number, tokens = messageTokens): CompactionMessage {
  let current = message;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const size = tokens(current);
    if (size <= budget) return current;
    current = shrinkStrings(current, (budget / size) * 0.9) as CompactionMessage;
  }
  return current;
}

/**
 * 按顺序把消息分成几段，每段估算不超过 budget。单条超过 budget 的先截短，自己一段。
 * 纯函数（tokens 可以换成测试用的估算）。
 */
export function planCompactionChunks(
  messages: readonly CompactionMessage[], budget: number, tokens: (message: CompactionMessage) => number = messageTokens,
): CompactionMessage[][] {
  const chunks: CompactionMessage[][] = [];
  let current: CompactionMessage[] = [];
  let used = 0;
  for (const message of messages) {
    const size = tokens(message);
    if (size > budget) {
      if (current.length > 0) chunks.push(current);
      chunks.push([shrinkMessage(message, budget, tokens)]);
      current = [];
      used = 0;
      continue;
    }
    if (current.length > 0 && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// 几次摘要调用的用量加在一起（数字逐项相加，cost 里的也一样）。
function addUsage(total: SummaryUsage | undefined, next: SummaryUsage): SummaryUsage {
  if (!total) return next;
  const add = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) {
      const current = out[key];
      if (typeof value === "number") out[key] = (typeof current === "number" ? current : 0) + value;
      else if (value && typeof value === "object" && current && typeof current === "object") {
        out[key] = add(current as Record<string, unknown>, value as Record<string, unknown>);
      }
    }
    return out;
  };
  return add(total as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>) as unknown as SummaryUsage;
}

// 压缩用到的文件（pi 自己的压缩在摘要末尾列出读过和改过的文件）。
function fileLists(fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"]): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return { readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() };
}

function fileListText(files: { readFiles: string[]; modifiedFiles: string[] }): string {
  const parts: string[] = [];
  if (files.readFiles.length) parts.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
  if (files.modifiedFiles.length) parts.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

export interface CompactionChunksOptions {
  onProgress?: (progress: CompactionProgress) => void;
  log?: (line: string) => void;
  // 测试换掉真正的摘要调用。
  summarize?: typeof generateSummaryWithUsage;
  // pi 自己触发的压缩（没有 customInstructions）也要带上的要求（compaction-settings.ts 的 leadAutoCompactionInstructions）。
  instructions?: string;
  // 这次压缩已经由别的扩展接上（空闲车道写好的摘要，scheduler/idle-runtime.ts）：不再自己写。
  skip?: (event: SessionBeforeCompactEvent) => boolean;
}

/**
 * 处理一次 session_before_compact。要摘要的历史放得进一段时返回 undefined（pi 照常压缩）；
 * 放不进时分段摘要，返回 pi 要的 compaction。
 */
export async function compactInChunks(
  event: SessionBeforeCompactEvent, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, options: CompactionChunksOptions = {},
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: SummaryUsage; details: unknown } } | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  const { preparation } = event;
  // 切在一轮中间时，那一轮的前半段也并进历史一起摘要：分段时不再单独写「这一轮的前情」。
  const messages = [...preparation.messagesToSummarize, ...(preparation.isSplitTurn ? preparation.turnPrefixMessages : [])];
  const budget = chunkTokenBudget(model.contextWindow, preparation.settings.reserveTokens);
  const tokens = messages.reduce((total, message) => total + messageTokens(message), 0);
  // pi 自己触发的压缩不带要求（customInstructions 是空的）：有要给它的要求时由这里来写，放得进一次请求也一样。
  const instructions = event.customInstructions ?? options.instructions;
  const ours = event.customInstructions === undefined && options.instructions !== undefined;
  if (tokens <= budget && !ours) return undefined;

  const chunks = tokens <= budget ? [messages] : planCompactionChunks(messages, budget);
  if (chunks.length > 1) {
    options.log?.(`[lead] compaction: the history is about ${tokens} tokens, over ${budget} per request; summarizing it in ${chunks.length} parts`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  const resolved = auth as { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
  const requestModel = resolved.baseUrl ? { ...model, baseUrl: resolved.baseUrl } : model;
  const summarize = options.summarize ?? generateSummaryWithUsage;
  let summary = preparation.previousSummary;
  let usage: SummaryUsage | undefined;
  for (const [index, chunk] of chunks.entries()) {
    if (event.signal.aborted) throw new Error("Compaction cancelled");
    const result = await summarize(
      chunk, requestModel, preparation.settings.reserveTokens, resolved.apiKey, resolved.headers, event.signal, instructions, summary,
    );
    summary = result.text;
    usage = addUsage(usage, result.usage);
    options.onProgress?.({ done: index + 1, total: chunks.length, tokens });
  }
  const files = fileLists(preparation.fileOps);
  return {
    compaction: {
      summary: `${summary ?? ""}${fileListText(files)}`,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      ...(usage ? { usage } : {}),
      details: { ...files, chunks: chunks.length },
    },
  };
}

/** pi 扩展：历史放不进一次摘要请求时分段压缩。 */
export function compactionChunksExtension(options: CompactionChunksOptions = {}): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event, ctx) => (options.skip?.(event) ? undefined : compactInChunks(event, ctx, options)));
  };
}

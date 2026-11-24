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
//
// What goes into a summary, and how much (2026-11-16). For two days every model call failed. Each wake wrote its prompt
// into the session (1,838 daemon wake prompts, none answered) and the compaction that should have removed them failed
// too. The history grew to 3.94M tokens. When the user moved to a working model, the compaction sent all of it, in 18
// requests. Two rules stop that:
//   - Wakes that got no answer are not history (dropUnansweredWakes): in a run of them only the last one stays.
//   - One compaction reads at most one model window of history (capToWindow). Older messages are left out and a note
//     says how many; the previous summary still covers them.
//
// Which model writes the summary (chooseSummaryRoute, 2026-11-16). A summary on the session prefix is cheap only while
// the provider still holds that prefix in its cache: then the request reads the history at the cache price. After the
// cache has expired, the same request pays the full write price for the whole context on Lead's model, which is often
// the most expensive one. So: a warm prefix goes to Lead's model; otherwise a cheaper summary model writes the summary
// in a separate request, when there is one. If the cheaper model fails, Lead's model writes it.
//
// Summary on the session prefix (prompt cache, 2026-11-12). pi's summary request uses its own system prompt and a
// serialized copy of the history, so no provider can serve any of it from cache: every compaction paid for the whole
// history again. When the prefix of the last Lead request is known (prompt-cache.ts, RequestPrefixRecorder), the summary
// request is that prefix plus one user message that asks for the summary: same system prompt, same tools, same
// messages, same session id. It falls back to the old path when the prefix does not fit, the provider fails, or the model
// answers with a tool call.
import {
  convertToLlm, generateSummaryWithUsage, serializeConversation,
  type ExtensionContext, type ExtensionFactory, type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "@pi-lead-child/core";
import { withPromptCacheKey, type RequestPrefix } from "./prompt-cache.js";
import { leadEffortRequest } from "./model-config.js";

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

// The text of a user message as the model reads it.
function userText(message: CompactionMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
    ? (block as { text: string }).text : "")).join("");
}

// A user message that holds only daemon system events (envelope.ts): no words of the user and no external text.
// The envelope escapes every "<" in a body, so these tags cannot come from content.
function isSystemOnlyWake(message: CompactionMessage): boolean {
  if (message.role !== "user") return false;
  const text = userText(message);
  return text.includes("<system_event") && !text.includes("<user_message") && !text.includes("<untrusted_external_text");
}

// A model call that failed or was stopped.
function isFailedAttempt(message: CompactionMessage): boolean {
  if (message.role !== "assistant") return false;
  const stop = (message as { stopReason?: string }).stopReason;
  return stop === "error" || stop === "aborted";
}

function hasContent(message: CompactionMessage): boolean {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content.trim() !== "" : Array.isArray(content) && content.length > 0;
}

/**
 * Removes the wakes that got no answer. A turn starts at a user message. A turn is unanswered when everything after its
 * user message is a failed attempt. In a run of unanswered turns that hold only system events, only the last turn
 * stays: the daemon writes the current state again at each wake, so the older ones say nothing more. A turn with the
 * user's words or external text always stays. Failed attempts without content go in every unanswered turn.
 * Pure function. dropped counts the removed turns.
 */
export function dropUnansweredWakes(messages: readonly CompactionMessage[]): { messages: CompactionMessage[]; dropped: number } {
  const turns: CompactionMessage[][] = [];
  const head: CompactionMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push([message]);
    else if (turns.length === 0) head.push(message);
    else turns[turns.length - 1]!.push(message);
  }
  const unanswered = (turn: CompactionMessage[]) => turn.slice(1).every(isFailedAttempt);
  const out = [...head];
  let dropped = 0;
  for (const [index, turn] of turns.entries()) {
    if (!unanswered(turn)) {
      out.push(...turn);
      continue;
    }
    const next = turns[index + 1];
    if (isSystemOnlyWake(turn[0]!) && next && unanswered(next) && isSystemOnlyWake(next[0]!)) {
      dropped += 1;
      continue;
    }
    out.push(turn[0]!, ...turn.slice(1).filter(hasContent));
  }
  return { messages: out, dropped };
}

/**
 * Keeps the newest messages that fit in cap tokens, and starts them at a user message when one is there.
 * omitted counts the older messages that were left out, omittedTokens their estimated size. Pure function.
 */
export function capToWindow(
  messages: readonly CompactionMessage[], cap: number, tokens: (message: CompactionMessage) => number = messageTokens,
): { messages: CompactionMessage[]; omitted: number; omittedTokens: number } {
  const sizes = messages.map((message) => tokens(message));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= cap) return { messages: [...messages], omitted: 0, omittedTokens: 0 };
  let start = messages.length;
  let used = 0;
  // The newest message always stays: planCompactionChunks shrinks it when it is larger than a part.
  while (start > 0 && (start === messages.length || used + sizes[start - 1]! <= cap)) {
    start -= 1;
    used += sizes[start]!;
  }
  const turnStart = messages.findIndex((message, index) => index >= start && message.role === "user");
  if (turnStart > start) {
    for (let index = start; index < turnStart; index += 1) used -= sizes[index]!;
    start = turnStart;
  }
  return { messages: messages.slice(start), omitted: start, omittedTokens: total - used };
}

// The note that stands in for what a compaction left out. It is a user message at the start of the history.
function leftOutNote(dropped: number, omitted: number, omittedTokens: number): CompactionMessage | null {
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(`这次压缩只读了最近的一段历史。更早的 ${omitted} 条消息（约 ${omittedTokens} token）没有读：它们超过了一个模型窗口。更早的内容以上一次的摘要为准。`);
  }
  if (dropped > 0) {
    lines.push(`这段历史里有 ${dropped} 轮系统唤醒没有得到回复（模型调用失败），已经略去；每一段连续的失败只留了最后一轮。那段时间里你没有处理任何事件，现状以最新的当前局面为准。`);
  }
  if (lines.length === 0) return null;
  return { role: "user", content: `[压缩说明] ${lines.join("")}`, timestamp: Date.now() } as CompactionMessage;
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

// Room the summary prompt itself takes in the prefix request (estimate).
const PREFIX_PROMPT_TOKENS = 2_000;
// The prefix request may use a smaller output cap than the standard summary when the context is close to the window,
// but not below this: a shorter summary is likely to hit the cap.
export const PREFIX_MIN_OUTPUT_TOKENS = 8_192;

/** The output cap pi uses for a summary: 80% of the reserve, at most the model's own output limit. */
export function summaryMaxTokens(model: { maxTokens: number }, reserveTokens: number): number {
  return Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
}

/**
 * Output cap for a summary request on the session prefix, or null when the prefix leaves too little room in the window.
 * contextTokens is the size of the current context (pi's tokensBefore).
 */
export function prefixSummaryMaxTokens(
  model: { maxTokens: number; contextWindow: number }, reserveTokens: number, contextTokens: number,
): number | null {
  const room = model.contextWindow - contextTokens - PREFIX_PROMPT_TOKENS;
  const cap = Math.min(summaryMaxTokens(model, reserveTokens), room);
  return cap >= PREFIX_MIN_OUTPUT_TOKENS ? cap : null;
}

/** The user message that asks for the summary at the end of the session prefix. */
export function prefixSummaryPrompt(instructions: string | undefined): string {
  const lines = [
    "[Context compaction] Pause the task. Do not call any tool and do not continue the work in this reply.",
    "Write a structured context checkpoint of the whole conversation above. It replaces the conversation: you will continue",
    "the work from it, together with the most recent messages, which stay in the context as they are.",
    "If the conversation starts with an earlier summary, merge it in: keep what still matters, move finished work to Done,",
    "and drop what no longer affects the work.",
    "",
    "Use this format:",
    "",
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "",
    "Keep each section concise. Preserve exact file paths, function names, ids and error messages. Reply with the summary only.",
  ];
  if (instructions) lines.push("", `Additional focus: ${instructions}`);
  return lines.join("\n");
}

/** The prefix request could not be used; the caller falls back to the serialized summary. */
export class PrefixSummaryUnavailable extends Error {}

const TOKEN_CAP_ERROR = "Summarization failed: generation hit the token cap and the summary is incomplete";

type CompleteFn = typeof completeSimple;
type SummaryModel = Parameters<typeof generateSummaryWithUsage>[1];

/**
 * One summary request on the session prefix. Throws PrefixSummaryUnavailable when the old path should be used instead,
 * and the token-cap error (like pi) when the summary hit the standard output cap.
 */
export async function summarizeOnPrefix(input: {
  prefix: RequestPrefix;
  model: SummaryModel;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens: number;
  standardMaxTokens: number;
  instructions?: string;
  signal: AbortSignal;
  complete?: CompleteFn;
}): Promise<{ text: string; usage: SummaryUsage }> {
  const { prefix, model } = input;
  const messages: Message[] = [
    ...prefix.messages,
    { role: "user", content: [{ type: "text", text: prefixSummaryPrompt(input.instructions) }], timestamp: Date.now() },
  ];
  // The same thinking level as the session: Anthropic drops the cached messages when thinking parameters change.
  const reasoning = model.reasoning && prefix.thinkingLevel && prefix.thinkingLevel !== "off" ? prefix.thinkingLevel : undefined;
  const complete = input.complete ?? completeSimple;
  let response: Awaited<ReturnType<CompleteFn>>;
  try {
    // This request goes to pi-ai directly, not through the provider: a model whose effort goes as a request field
    // (magpie, model-config.ts) gets the same id and effort here as in the session's requests.
    const request = leadEffortRequest(model, {
      maxTokens: input.maxTokens,
      signal: input.signal,
      sessionId: prefix.sessionId,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(reasoning ? { reasoning: reasoning as never } : {}),
      ...(prefix.promptCacheKey ? { onPayload: (payload: unknown) => withPromptCacheKey(payload, model, prefix.sessionId) } : {}),
    });
    response = await complete(request.model, { messages }, request.options);
  } catch (error) {
    if (input.signal.aborted) throw new Error("Compaction cancelled");
    throw new PrefixSummaryUnavailable(error instanceof Error ? error.message : String(error));
  }
  if (response.stopReason === "aborted" || input.signal.aborted) throw new Error("Compaction cancelled");
  if (response.stopReason === "error") throw new PrefixSummaryUnavailable(response.errorMessage || "provider error");
  if (response.content.some((block) => block.type === "toolCall")) throw new PrefixSummaryUnavailable("the model called a tool");
  if (response.stopReason === "length") {
    // A smaller cap than the standard summary: the old path may still fit. At the standard cap: fail like pi does.
    if (input.maxTokens < input.standardMaxTokens) throw new PrefixSummaryUnavailable("hit a reduced output cap");
    throw new Error(TOKEN_CAP_ERROR);
  }
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new PrefixSummaryUnavailable("empty summary");
  return { text, usage: response.usage as SummaryUsage };
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
  // The prefix of the last Lead request (prompt-cache.ts). When it is there, the summary is written on it first.
  prefix?: (model: { provider: string; id: string }) => RequestPrefix | null | undefined;
  // A cheaper model for a summary that cannot use the provider's cache (chooseSummaryRoute). Returns undefined when
  // there is none, or when it is Lead's own model.
  summaryModel?: (main: SummaryModel) => SummaryModel | undefined;
  // How many tokens of history one compaction reads at most. Default: the window of Lead's model. The idle child
  // gets it from the daemon, because there the summary model can be the only model it knows.
  historyCap?: number;
  // How long after its last message a prefix counts as held in the provider's cache. Default PREFIX_WARM_MS; a
  // provider with long cache retention gets PREFIX_WARM_LONG_MS from the session.
  prefixWarmMs?: number | ((main: { provider: string; id: string }) => number);
  now?: () => number;
  // Tests replace the prefix summary call.
  complete?: CompleteFn;
}

/**
 * A prefix counts as warm this long after its last message. Anthropic's default cache lifetime is 5 minutes, and each
 * read starts it again; the margin covers the time the request itself takes.
 */
export const PREFIX_WARM_MS = 4.5 * 60_000;
/** The same for a provider that keeps the cache for 1 hour (lead.providers.<name>.cacheRetention: "long"). */
export const PREFIX_WARM_LONG_MS = 55 * 60_000;

/**
 * How to write the summary. prefix: try the session prefix first, on Lead's model. model: who writes a separate
 * request (when there is no prefix to try, or the prefix request did not work).
 * - The prefix is warm: the prefix (the history is read at the cache price); then the cheaper model, when there is one.
 * - The prefix is cold or missing, and there is a cheaper model: that model, in a separate request.
 * - No cheaper model: as before (Lead's model, on the prefix when there is one).
 * A prefix without a time (older code, tests) counts as warm. Pure function.
 */
export function chooseSummaryRoute<M extends { provider: string; id: string }>(input: {
  main: M; cheap: M | undefined; prefix: RequestPrefix | null | undefined; now: number; warmMs?: number;
}): { prefix: RequestPrefix | null; model: M; reason: "warm_prefix" | "cheap_model" | "main_model" } {
  const { main } = input;
  const prefix = input.prefix && input.prefix.provider === main.provider && input.prefix.model === main.id ? input.prefix : null;
  const cheap = input.cheap && !(input.cheap.provider === main.provider && input.cheap.id === main.id) ? input.cheap : undefined;
  const warm = prefix !== null && (prefix.at === undefined || input.now - prefix.at <= (input.warmMs ?? PREFIX_WARM_MS));
  if (warm) return { prefix, model: cheap ?? main, reason: "warm_prefix" };
  if (cheap) return { prefix: null, model: cheap, reason: "cheap_model" };
  return { prefix, model: main, reason: "main_model" };
}

/**
 * 处理一次 session_before_compact。要摘要的历史放得进一段时返回 undefined（pi 照常压缩）；
 * 放不进时分段摘要，返回 pi 要的 compaction。
 */
export async function compactInChunks(
  event: SessionBeforeCompactEvent, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, options: CompactionChunksOptions = {},
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: SummaryUsage; details: unknown } } | undefined> {
  const main = ctx.model;
  if (!main) return undefined;
  const instructions = event.customInstructions ?? options.instructions;
  const route = chooseSummaryRoute({
    main, cheap: options.summaryModel?.(main) as typeof main | undefined, prefix: options.prefix?.(main),
    now: (options.now ?? Date.now)(),
    ...(options.prefixWarmMs !== undefined
      ? { warmMs: typeof options.prefixWarmMs === "function" ? options.prefixWarmMs(main) : options.prefixWarmMs } : {}),
  });
  if (route.prefix) {
    const onPrefix = await compactOnPrefix(event, main, route.prefix, ctx, instructions, options);
    if (onPrefix) return onPrefix;
  }
  if (route.model !== main) {
    options.log?.(`[lead] compaction: the summary cannot use the provider's cache (${route.reason === "warm_prefix" ? "the request on the session prefix did not work" : "the session prefix is cold or missing"}); ${route.model.provider}/${route.model.id} writes it`);
    try {
      return await compactSeparately(event, route.model, main, ctx, instructions, options);
    } catch (error) {
      if (event.signal.aborted) throw error;
      options.log?.(`[lead] compaction: ${route.model.provider}/${route.model.id} did not write the summary (${error instanceof Error ? error.message : String(error)}); using ${main.provider}/${main.id}`);
    }
  }
  return compactSeparately(event, main, main, ctx, instructions, options);
}

// The summary in a separate request (pi's serialized history), in parts when it does not fit in one request.
// model writes it; main is Lead's model: the cap on how much history one compaction reads follows Lead's window.
async function compactSeparately(
  event: SessionBeforeCompactEvent,
  model: NonNullable<ExtensionContext["model"]>,
  main: NonNullable<ExtensionContext["model"]>,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  instructions: string | undefined,
  options: CompactionChunksOptions,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: SummaryUsage; details: unknown } } | undefined> {
  const { preparation } = event;
  // 切在一轮中间时，那一轮的前半段也并进历史一起摘要：分段时不再单独写「这一轮的前情」。
  const history = [...preparation.messagesToSummarize, ...(preparation.isSplitTurn ? preparation.turnPrefixMessages : [])];
  const budget = chunkTokenBudget(model.contextWindow, preparation.settings.reserveTokens);
  // 没有得到回复的系统唤醒不是历史；一次压缩最多读一个模型窗口的历史（文件开头，2026-11-16）。
  const answered = dropUnansweredWakes(history);
  const capped = capToWindow(answered.messages, Math.max(budget, options.historyCap ?? main.contextWindow));
  const note = leftOutNote(answered.dropped, capped.omitted, capped.omittedTokens);
  const messages = note ? [note, ...capped.messages] : capped.messages;
  const tokens = messages.reduce((total, message) => total + messageTokens(message), 0);
  if (note) {
    options.log?.(`[lead] compaction: left out ${answered.dropped} unanswered wakes and ${capped.omitted} older messages (about ${capped.omittedTokens} tokens); summarizing about ${tokens} tokens`);
  }
  // pi 自己触发的压缩不带要求（customInstructions 是空的）：有要给它的要求时由这里来写，放得进一次请求也一样。
  // 略去了东西时也由这里来写：pi 自己的压缩会把略去的部分照样发出去。
  const ours = event.customInstructions === undefined && options.instructions !== undefined;
  // 交回给 pi 时是 Lead 的模型来写：换了模型时由这里写。
  if (tokens <= budget && !ours && !note && model === main) return undefined;

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
      details: {
        ...files, chunks: chunks.length,
        ...(model === main ? {} : { model: `${model.provider}/${model.id}` }),
        ...(note ? { unansweredWakes: answered.dropped, omittedMessages: capped.omitted, omittedTokens: capped.omittedTokens } : {}),
      },
    },
  };
}

// The summary on the session prefix, or undefined when the old path is used: no prefix, another model, overflow
// recovery (the prefix itself did not fit), not enough room for the output, or the request did not work.
async function compactOnPrefix(
  event: SessionBeforeCompactEvent,
  model: NonNullable<ExtensionContext["model"]>,
  prefix: RequestPrefix,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  instructions: string | undefined,
  options: CompactionChunksOptions,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: SummaryUsage; details: unknown } } | undefined> {
  if (event.reason === "overflow") return undefined;
  const { preparation } = event;
  const maxTokens = prefixSummaryMaxTokens(model, preparation.settings.reserveTokens, preparation.tokensBefore);
  if (maxTokens === null) {
    options.log?.(`[lead] compaction: the context (${preparation.tokensBefore} tokens) leaves no room for a summary on the session prefix; using a separate request`);
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  const resolved = auth as { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
  const requestModel = resolved.baseUrl ? { ...model, baseUrl: resolved.baseUrl } : model;
  let result: { text: string; usage: SummaryUsage };
  try {
    result = await summarizeOnPrefix({
      prefix, model: requestModel, maxTokens, standardMaxTokens: summaryMaxTokens(model, preparation.settings.reserveTokens),
      signal: event.signal,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(instructions ? { instructions } : {}),
      ...(options.complete ? { complete: options.complete } : {}),
    });
  } catch (error) {
    if (!(error instanceof PrefixSummaryUnavailable)) throw error;
    options.log?.(`[lead] compaction: the summary on the session prefix did not work (${error.message}); using a separate request`);
    return undefined;
  }
  options.onProgress?.({ done: 1, total: 1, tokens: preparation.tokensBefore });
  const files = fileLists(preparation.fileOps);
  return {
    compaction: {
      summary: `${result.text}${fileListText(files)}`,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage: result.usage,
      details: { ...files, chunks: 1, prefix: true },
    },
  };
}

/** pi 扩展：历史放不进一次摘要请求时分段压缩。 */
export function compactionChunksExtension(options: CompactionChunksOptions = {}): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event, ctx) => (options.skip?.(event) ? undefined : compactInChunks(event, ctx, options)));
  };
}

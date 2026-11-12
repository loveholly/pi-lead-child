// Prompt cache decisions (prompt-cache.ts and the prefix path of compaction-chunks.ts). The full flow through a real Lead
// session and an OpenAI-compatible stub is in prompt-cache-session.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  compactInChunks, prefixSummaryMaxTokens, PREFIX_MIN_OUTPUT_TOKENS, summaryMaxTokens,
} from "../src/compaction-chunks.js";
import {
  isPromptCacheKeyRejection, PROMPT_CACHE_KEY_MAX_LENGTH, RequestPrefixRecorder, withPromptCacheKey, type RequestPrefix,
} from "../src/prompt-cache.js";
import { promptCacheKeyEnabled } from "../src/model-config.js";
import { runIdleCompact } from "../src/scheduler/idle-compact-child.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const system = { role: "system" as const, content: "prompt", toolsAdded: [], timestamp: 0 };
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions", provider: "gw", model: "m",
  usage, stopReason: "stop" as const, timestamp: 0, ...extra,
});

describe("withPromptCacheKey", () => {
  const completions = { api: "openai-completions", id: "deepseek-flash" };

  it("adds the session id as prompt_cache_key and nothing else", () => {
    const payload = { model: "deepseek-flash", messages: [], stream: true, prompt_cache_key: undefined };
    expect(withPromptCacheKey(payload, completions, "session-1")).toEqual({ ...payload, prompt_cache_key: "session-1" });
    expect(withPromptCacheKey(payload, completions, "session-1")).not.toHaveProperty("prompt_cache_retention");
    expect(withPromptCacheKey({ model: "m", input: [] }, { api: "openai-responses", id: "m" }, "s")).toMatchObject({ prompt_cache_key: "s" });
  });

  it("keeps the payload when the field does not apply or is already there", () => {
    expect(withPromptCacheKey({ model: "m", prompt_cache_key: "pi" }, { api: "openai-completions", id: "m" }, "s")).toBeUndefined();
    expect(withPromptCacheKey({ model: "m" }, { api: "anthropic-messages", id: "m" }, "s")).toBeUndefined();
    expect(withPromptCacheKey({ model: "m" }, { api: "google-generative-ai", id: "m" }, "s")).toBeUndefined();
    expect(withPromptCacheKey({ model: "other" }, { api: "openai-completions", id: "m" }, "s")).toBeUndefined();
    expect(withPromptCacheKey({ model: "m" }, { api: "openai-completions", id: "m" }, undefined)).toBeUndefined();
    expect(withPromptCacheKey("not an object", { api: "openai-completions", id: "m" }, "s")).toBeUndefined();
  });

  it("clamps a long key to the documented length", () => {
    const result = withPromptCacheKey({ model: "m" }, { api: "openai-completions", id: "m" }, "k".repeat(100)) as { prompt_cache_key: string };
    expect(result.prompt_cache_key).toHaveLength(PROMPT_CACHE_KEY_MAX_LENGTH);
  });

  it("is on unless the provider config turns it off", () => {
    const config = { providers: { a: { baseUrl: "x" }, b: { baseUrl: "y", promptCacheKey: false } } };
    expect(promptCacheKeyEnabled(config, "a")).toBe(true);
    expect(promptCacheKeyEnabled(config, "b")).toBe(false);
    expect(promptCacheKeyEnabled(config, "missing")).toBe(true);
  });

  it("recognizes a provider error about the field", () => {
    expect(isPromptCacheKeyRejection("Unrecognized request argument supplied: prompt_cache_key")).toBe(true);
    expect(isPromptCacheKeyRejection("rate limited")).toBe(false);
    expect(isPromptCacheKeyRejection(undefined)).toBe(false);
  });
});

describe("RequestPrefixRecorder", () => {
  const ctx = { model: { provider: "gw", id: "m" }, sessionManager: { getSessionId: () => "session-1" }, thinkingLevel: "high" };

  it("gives the last request's transcript plus the reply as the prefix", () => {
    const recorder = new RequestPrefixRecorder({ promptCacheKey: () => true });
    recorder.recordRequest([system, user("hi")] as never, ctx as never);
    recorder.recordMessage(assistant("hello") as never);
    const prefix = recorder.snapshot({ provider: "gw", id: "m" })!;
    expect(prefix).toMatchObject({ provider: "gw", model: "m", sessionId: "session-1", thinkingLevel: "high", promptCacheKey: true });
    expect(prefix.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("gives nothing for another model, an unfinished reply, or after a compaction", () => {
    const recorder = new RequestPrefixRecorder();
    expect(recorder.snapshot({ provider: "gw", id: "m" })).toBeNull();
    recorder.recordRequest([system, user("hi")] as never, ctx as never);
    // The reply has not ended yet.
    expect(recorder.snapshot({ provider: "gw", id: "m" })).toBeNull();
    recorder.recordMessage(assistant("hello") as never);
    expect(recorder.snapshot({ provider: "gw", id: "other" })).toBeNull();
    expect(recorder.snapshot({ provider: "gw", id: "m" })?.promptCacheKey).toBe(false);
    // A reply that calls a tool, or one that failed, is not a place to ask for a summary.
    recorder.recordMessage(assistant("", { content: [{ type: "toolCall", id: "1", name: "ls", arguments: {} }], stopReason: "toolUse" }) as never);
    expect(recorder.snapshot({ provider: "gw", id: "m" })).toBeNull();
    recorder.recordRequest([system, user("hi")] as never, ctx as never);
    recorder.recordMessage(assistant("", { stopReason: "error" }) as never);
    expect(recorder.snapshot({ provider: "gw", id: "m" })).toBeNull();
    recorder.recordRequest([system, user("hi")] as never, ctx as never);
    recorder.recordMessage(assistant("ok") as never);
    recorder.clear();
    expect(recorder.snapshot({ provider: "gw", id: "m" })).toBeNull();
  });
});

describe("compaction on the session prefix", () => {
  const prefix: RequestPrefix = {
    provider: "gw", model: "m", sessionId: "session-1", promptCacheKey: true,
    messages: [system, user("hi"), assistant("hello")] as never,
  };
  const model = { provider: "gw", id: "m", api: "openai-completions", contextWindow: 200_000, maxTokens: 16_384, reasoning: false };
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ apiKey: "test-key" })) } };
  const event = (extra: Record<string, unknown> = {}) => ({
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "keep-1", messagesToSummarize: [user("old")], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100_000,
      fileOps: { read: new Set(["a.ts"]), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 20_480, keepRecentTokens: 20_000 },
    },
    branchEntries: [], reason: "threshold", willRetry: false, signal: new AbortController().signal, customInstructions: undefined, ...extra,
  });
  const reply = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason, usage, api: "openai-completions", provider: "gw", model: "m", timestamp: 0 });

  it("sends the prefix plus one summary prompt, with the session id and its cache key", async () => {
    let seen: { messages: Array<{ role: string; content: unknown }> } | null = null;
    let options: Record<string, unknown> = {};
    const complete = vi.fn(async (_model: unknown, context: typeof seen, opts: Record<string, unknown>) => {
      seen = context;
      options = opts;
      return reply([{ type: "text", text: "## Goal\nsummary" }]);
    });
    const summarize = vi.fn();
    const result = await compactInChunks(event() as never, ctx as never, {
      prefix: () => prefix, complete: complete as never, summarize: summarize as never, instructions: "keep it short",
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(seen!.messages.slice(0, 3)).toEqual(prefix.messages);
    expect(seen!.messages).toHaveLength(4);
    expect(JSON.stringify(seen!.messages[3])).toContain("[Context compaction]");
    expect(JSON.stringify(seen!.messages[3])).toContain("keep it short");
    expect(options).toMatchObject({ sessionId: "session-1", apiKey: "test-key", maxTokens: summaryMaxTokens(model, 20_480) });
    // The summary request does not opt out of caching (pi's own summary sends cacheRetention "none").
    expect(options).not.toHaveProperty("cacheRetention");
    expect((options.onPayload as (payload: unknown) => unknown)({ model: "m" })).toEqual({ model: "m", prompt_cache_key: "session-1" });
    expect(result!.compaction).toMatchObject({ firstKeptEntryId: "keep-1", tokensBefore: 100_000, details: { chunks: 1, prefix: true } });
    expect(result!.compaction.summary).toContain("## Goal\nsummary");
    expect(result!.compaction.summary).toContain("<read-files>\na.ts");
  });

  it("falls back to the separate summary when the model calls a tool or the provider fails", async () => {
    for (const answer of [
      reply([{ type: "toolCall", id: "1", name: "ls", arguments: {} }], "toolUse"),
      { ...reply([]), stopReason: "error", errorMessage: "bad request" },
    ]) {
      const summarize = vi.fn(async () => ({ text: "separate summary", usage }));
      const log = vi.fn();
      const result = await compactInChunks(event() as never, ctx as never, {
        prefix: () => prefix, complete: vi.fn(async () => answer) as never, summarize: summarize as never, instructions: "x", log,
      });
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(result!.compaction.summary.startsWith("separate summary")).toBe(true);
      expect(log.mock.calls.flat().join("\n")).toMatch(/session prefix did not work/);
    }
  });

  it("fails like pi when the summary hits the standard output cap", async () => {
    const complete = vi.fn(async () => reply([{ type: "text", text: "partial" }], "length"));
    await expect(compactInChunks(event() as never, ctx as never, { prefix: () => prefix, complete: complete as never }))
      .rejects.toThrow(/hit the token cap/);
  });

  it("does not use the prefix for overflow recovery, for another model, or when it leaves no room", async () => {
    const complete = vi.fn();
    const summarize = vi.fn(async () => ({ text: "separate summary", usage }));
    const options = { prefix: () => prefix, complete: complete as never, summarize: summarize as never, instructions: "x" };
    await compactInChunks(event({ reason: "overflow" }) as never, ctx as never, options);
    await compactInChunks(event() as never, { ...ctx, model: { ...model, id: "other" } } as never, options);
    const full = event();
    full.preparation.tokensBefore = 195_000;
    await compactInChunks(full as never, ctx as never, options);
    expect(complete).not.toHaveBeenCalled();
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("caps the output to the room left in the window, and not below a floor", () => {
    expect(prefixSummaryMaxTokens(model, 20_480, 100_000)).toBe(summaryMaxTokens(model, 20_480));
    expect(prefixSummaryMaxTokens(model, 20_480, 188_000)).toBe(10_000);
    expect(prefixSummaryMaxTokens(model, 20_480, 200_000 - 2_000 - PREFIX_MIN_OUTPUT_TOKENS + 1)).toBeNull();
  });

  it("is used by the idle-lane summary child when the request carries the prefix", async () => {
    const complete = vi.fn(async () => reply([{ type: "text", text: "child summary" }]));
    const summarize = vi.fn();
    const response = await runIdleCompact({
      version: 1, model: model as never, auth: { apiKey: "k" }, prefix,
      preparation: {
        firstKeptEntryId: "keep-1", messagesToSummarize: [user("old")], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100_000,
        fileOps: { read: [], written: [], edited: [] }, settings: { enabled: true, reserveTokens: 20_480, keepRecentTokens: 20_000 },
      },
    }, { complete: complete as never, summarize: summarize as never });
    expect(response).toMatchObject({ ok: true, summary: "child summary", chunks: 1 });
    expect(summarize).not.toHaveBeenCalled();
  });
});

// Prompt cache helpers for the Lead session.
//
// 1. prompt_cache_key for OpenAI-compatible endpoints. Providers with automatic prefix caching (OpenAI, Azure OpenAI,
//    DeepSeek behind a gateway, self-hosted gateways) route a request to the machine that holds its prefix by this key.
//    pi-ai sends it only to api.openai.com, or together with `prompt_cache_retention: "24h"` when long retention is on,
//    and that second field is rejected by some deployments. Here Lead adds only the key, set to its session id, so all
//    requests of one Lead session share a routing key. A provider can turn it off with
//    `lead.providers.<name>.promptCacheKey: false`. When a provider answers with an error that names the field, the
//    extension stops sending it to that provider until the daemon restarts.
//
// 2. Long cache retention, off by default (cacheRetentionExtension). With `lead.providers.<name>.cacheRetention: "long"`
//    Lead asks that provider to keep its prompt cache longer: `ttl: "1h"` on every Anthropic-style cache breakpoint
//    (cache_control), and `prompt_cache_retention: "24h"` on OpenAI-compatible endpoints. This is what pi-ai sends with
//    cacheRetention "long", but pi's session passes no retention per request, and the env switch PI_CACHE_RETENTION
//    applies to every provider at once. The 1-hour tier costs 2× to write instead of 1.25×: in Lead's data from
//    11-10 to 11-14 it saves about half on quiet days and costs about 30% more on the busiest day, so it stays off until
//    the user turns it on for a provider. When the provider answers with an error that names one of the fields, the
//    extension stops changing requests to that provider until the daemon restarts. Compaction requests
//    (compaction-chunks.ts) keep the provider's default retention.
//
// 3. The request prefix of the last model call (RequestPrefixRecorder). Compaction (compaction-chunks.ts) sends its
//    summary request on top of this prefix instead of a new system prompt and a serialized copy of the history, so the
//    provider can serve the whole prefix from its cache.
import { convertToLlm, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { splitLeadModelEffort } from "./model-config.js";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type ModelRef = { provider: string; id: string; api: string };

// The payload is for another model. A model whose effort goes as a request field (claude-opus-5-5(high) on magpie,
// model-config.ts leadEffortRequest) sends its id without the suffix: that is still this model.
function forAnotherModel(payload: Record<string, unknown>, model: Pick<ModelRef, "id">): boolean {
  return typeof payload.model === "string" && payload.model !== model.id && payload.model !== splitLeadModelEffort(model.id).base;
}

/** OpenAI documents a 64-character limit for prompt_cache_key; pi-ai clamps to the same length. */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

// APIs whose request body takes a top-level prompt_cache_key (Chat Completions and Responses).
const PROMPT_CACHE_KEY_APIS = new Set(["openai-completions", "openai-responses"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampKey(key: string): string {
  const chars = Array.from(key);
  return chars.length <= PROMPT_CACHE_KEY_MAX_LENGTH ? key : chars.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Returns the payload with `prompt_cache_key` set to the session id, or undefined to keep the payload as it is:
 * the API does not take the field, the payload already has a key, or the payload is for another model.
 * It never adds `prompt_cache_retention` or any other field.
 */
export function withPromptCacheKey(payload: unknown, model: Pick<ModelRef, "api" | "id">, sessionId: string | undefined): unknown {
  if (!sessionId || !PROMPT_CACHE_KEY_APIS.has(model.api)) return undefined;
  if (!isRecord(payload) || payload.prompt_cache_key !== undefined) return undefined;
  if (forAnotherModel(payload, model)) return undefined;
  return { ...payload, prompt_cache_key: clampKey(sessionId) };
}

/** True when a provider error is about the prompt_cache_key field (the provider does not accept it). */
export function isPromptCacheKeyRejection(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" && /prompt_cache_key/i.test(errorMessage);
}

export interface PromptCacheKeyOptions {
  // False when the provider's config turns the key off (lead.providers.<name>.promptCacheKey: false).
  enabled: (provider: string) => boolean;
  log?: (line: string) => void;
}

/** pi extension: adds the session's prompt_cache_key to each Lead request to an OpenAI-compatible endpoint. */
export function promptCacheKeyExtension(options: PromptCacheKeyOptions): ExtensionFactory {
  const rejected = new Set<string>();
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!model || rejected.has(model.provider) || !options.enabled(model.provider)) return undefined;
      return withPromptCacheKey(event.payload, model, ctx.sessionManager.getSessionId());
    });
    pi.on("message_end", (event, ctx) => {
      const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
      const provider = ctx.model?.provider;
      if (!provider || message.role !== "assistant" || message.stopReason !== "error") return undefined;
      if (!isPromptCacheKeyRejection(message.errorMessage) || rejected.has(provider)) return undefined;
      rejected.add(provider);
      options.log?.(`[lead] prompt cache: ${provider} rejected prompt_cache_key; no longer sending it to this provider`);
      return undefined;
    });
  };
}

const LONG_TTL = "1h";
const LONG_OPENAI_RETENTION = "24h";
// APIs whose request body takes a top-level prompt_cache_retention.
const PROMPT_CACHE_RETENTION_APIS = new Set(["openai-completions", "openai-responses"]);
// APIs that can carry Anthropic-style cache_control breakpoints (OpenAI-compatible gateways in front of Claude may).
const CACHE_CONTROL_APIS = new Set(["anthropic-messages", "openai-completions"]);

function withLongTtl(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value) || !isRecord(value.cache_control)) return { value, changed: false };
  const control = value.cache_control;
  if (control.type !== "ephemeral" || control.ttl !== undefined) return { value, changed: false };
  return { value: { ...value, cache_control: { ...control, ttl: LONG_TTL } }, changed: true };
}

function withLongTtls(list: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(list)) return { value: list, changed: false };
  let changed = false;
  const value = list.map((entry) => {
    let next = withLongTtl(entry);
    // Content blocks of a message carry the breakpoints too.
    if (isRecord(next.value) && Array.isArray(next.value.content)) {
      const blocks = withLongTtls(next.value.content);
      if (blocks.changed) next = { value: { ...next.value, content: blocks.value }, changed: true };
    }
    changed ||= next.changed;
    return next.value;
  });
  return { value, changed };
}

/**
 * Returns the payload with long cache retention, or undefined to keep the payload as it is: the API takes neither field,
 * the payload already sets a retention, or the payload is for another model. Only the cache breakpoints that pi already
 * placed get a TTL; no new breakpoint is added.
 */
export function withLongCacheRetention(payload: unknown, model: Pick<ModelRef, "api" | "id">): unknown {
  if (!isRecord(payload)) return undefined;
  if (forAnotherModel(payload, model)) return undefined;
  let next: Record<string, unknown> = payload;
  let changed = false;
  if (CACHE_CONTROL_APIS.has(model.api)) {
    for (const key of ["system", "tools", "messages"] as const) {
      const result = withLongTtls(next[key]);
      if (result.changed) { next = { ...next, [key]: result.value }; changed = true; }
    }
  }
  if (PROMPT_CACHE_RETENTION_APIS.has(model.api) && payload.prompt_cache_retention === undefined) {
    next = { ...next, prompt_cache_retention: LONG_OPENAI_RETENTION };
    changed = true;
  }
  return changed ? next : undefined;
}

/** True when a provider error is about the retention fields (the provider does not accept them). */
export function isCacheRetentionRejection(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" && /prompt_cache_retention|cache_control\.ttl|\bttl\b/i.test(errorMessage);
}

export interface CacheRetentionOptions {
  // The provider's setting (lead.providers.<name>.cacheRetention). Only "long" changes requests.
  retention: (provider: string) => "short" | "long";
  log?: (line: string) => void;
}

/** pi extension: asks providers set to long retention to keep Lead's prompt cache longer. */
export function cacheRetentionExtension(options: CacheRetentionOptions): ExtensionFactory {
  const rejected = new Set<string>();
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!model || rejected.has(model.provider) || options.retention(model.provider) !== "long") return undefined;
      return withLongCacheRetention(event.payload, model);
    });
    pi.on("message_end", (event, ctx) => {
      const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
      const provider = ctx.model?.provider;
      if (!provider || message.role !== "assistant" || message.stopReason !== "error") return undefined;
      if (rejected.has(provider) || options.retention(provider) !== "long" || !isCacheRetentionRejection(message.errorMessage)) return undefined;
      rejected.add(provider);
      options.log?.(`[lead] prompt cache: ${provider} rejected long cache retention; using the provider's default retention`);
      return undefined;
    });
  };
}

/** The prefix of the last Lead request, ready to be sent again with one more user message at the end. */
export interface RequestPrefix {
  provider: string;
  model: string;
  sessionId: string;
  thinkingLevel?: string;
  // Send prompt_cache_key with the summary request too (same rule as promptCacheKeyExtension).
  promptCacheKey: boolean;
  // When the last message of this prefix went to or came from the provider (ms). The provider's cache holds the prefix
  // for a short time after that (compaction-chunks.ts, chooseSummaryRoute). Absent in prefixes from older code.
  at?: number;
  // LLM messages: the system messages (prompt and tools) and the conversation, ending with a finished assistant reply.
  messages: Message[];
}

function finishedAssistant(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  const assistant = message as { stopReason?: string; content?: Array<{ type?: string }> };
  if (assistant.stopReason !== "stop") return false;
  return !(assistant.content ?? []).some((block) => block.type === "toolCall");
}

/**
 * Records the transcript of the last Lead request (after every `context` transform, such as ObservationPack) and the
 * messages that came after it. snapshot() returns them as the prefix for a summary request, or null when they no longer
 * match the session: another model, a compaction since, or a conversation that does not end with a finished reply.
 */
export class RequestPrefixRecorder {
  #transcript: AgentMessage[] | null = null;
  #tail: AgentMessage[] = [];
  #model: { provider: string; id: string } | null = null;
  #sessionId: string | null = null;
  #thinkingLevel: string | undefined;
  #at = 0;
  readonly #promptCacheKey: (provider: string) => boolean;
  readonly #now: () => number;

  constructor(options: { promptCacheKey?: (provider: string) => boolean; now?: () => number } = {}) {
    this.#promptCacheKey = options.promptCacheKey ?? (() => false);
    this.#now = options.now ?? Date.now;
  }

  /** Called with the final transcript of each request (pi's context_with_system). */
  recordRequest(messages: AgentMessage[], ctx: Pick<ExtensionContext, "model" | "sessionManager" | "thinkingLevel">): void {
    this.#transcript = messages;
    this.#tail = [];
    this.#model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    this.#sessionId = ctx.sessionManager.getSessionId();
    this.#thinkingLevel = ctx.thinkingLevel;
    this.#at = this.#now();
  }

  /** Called for each message that ends after the request (the reply, tool results, queued input). */
  recordMessage(message: AgentMessage): void {
    if (!this.#transcript) return;
    this.#tail.push(message);
    this.#at = this.#now();
  }

  clear(): void {
    this.#transcript = null;
    this.#tail = [];
    this.#model = null;
  }

  snapshot(model: Pick<ModelRef, "provider" | "id"> | undefined): RequestPrefix | null {
    const transcript = this.#transcript;
    if (!transcript || !model || !this.#model || !this.#sessionId) return null;
    if (this.#model.provider !== model.provider || this.#model.id !== model.id) return null;
    const all = [...transcript, ...this.#tail];
    if (!finishedAssistant(all[all.length - 1])) return null;
    // The prompt and tools travel in system messages (pi replays them in order; they need not come first).
    if (!all.some((message) => message.role === "system")) return null;
    return {
      provider: model.provider,
      model: model.id,
      sessionId: this.#sessionId,
      ...(this.#thinkingLevel ? { thinkingLevel: this.#thinkingLevel } : {}),
      promptCacheKey: this.#promptCacheKey(model.provider),
      at: this.#at,
      messages: convertToLlm(all) as Message[],
    };
  }

  /** pi extension that feeds this recorder. Register it after every extension that changes the request transcript. */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.on("context_with_system", (event, ctx) => {
        this.recordRequest(event.messages, ctx);
        return undefined;
      });
      pi.on("message_end", (event) => {
        this.recordMessage(event.message);
        return undefined;
      });
      pi.on("session_compact", () => this.clear());
    };
  }
}

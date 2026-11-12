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
// 2. The request prefix of the last model call (RequestPrefixRecorder). Compaction (compaction-chunks.ts) sends its
//    summary request on top of this prefix instead of a new system prompt and a serialized copy of the history, so the
//    provider can serve the whole prefix from its cache.
import { convertToLlm, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type ModelRef = { provider: string; id: string; api: string };

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
  if (typeof payload.model === "string" && payload.model !== model.id) return undefined;
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

/** The prefix of the last Lead request, ready to be sent again with one more user message at the end. */
export interface RequestPrefix {
  provider: string;
  model: string;
  sessionId: string;
  thinkingLevel?: string;
  // Send prompt_cache_key with the summary request too (same rule as promptCacheKeyExtension).
  promptCacheKey: boolean;
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
  readonly #promptCacheKey: (provider: string) => boolean;

  constructor(options: { promptCacheKey?: (provider: string) => boolean } = {}) {
    this.#promptCacheKey = options.promptCacheKey ?? (() => false);
  }

  /** Called with the final transcript of each request (pi's context_with_system). */
  recordRequest(messages: AgentMessage[], ctx: Pick<ExtensionContext, "model" | "sessionManager" | "thinkingLevel">): void {
    this.#transcript = messages;
    this.#tail = [];
    this.#model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    this.#sessionId = ctx.sessionManager.getSessionId();
    this.#thinkingLevel = ctx.thinkingLevel;
  }

  /** Called for each message that ends after the request (the reply, tool results, queued input). */
  recordMessage(message: AgentMessage): void {
    if (this.#transcript) this.#tail.push(message);
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

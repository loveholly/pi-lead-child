// Effort as a request field. magpie lists the effort levels of each model in its plain catalog (data[]:
// reasoning, supported_reasoning_levels) and rejects the (level) model-id suffix that only CLIProxyAPI understands.
// Lead keeps the suffix in its own model specs (picker, chain, one-turn model) and, for such a provider, sends the model
// id without it and the effort in the field of the provider's API. A local stub stands in for the gateway: it serves the
// catalogs and records each request body. No real model is called.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";

import {
  assertConfiguredLeadModel, leadEffortRequest, leadModelCatalog, normalizeLeadModelConfig, registerLeadProviders,
} from "../src/model-config.js";
import { summarizeOnPrefix } from "../src/compaction-chunks.js";
import { createLeadSession } from "../src/session.js";

type Body = Record<string, any>;

// A magpie-like plain catalog: effort levels in data[], no detailed catalog. GPT lists ultra, which pi cannot send.
const plainCatalog = {
  data: [
    {
      id: "claude/claude-opus-5-5", owned_by: "claude", display_name: "Claude Opus 5.5", reasoning: true,
      reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
      context_window: 1_000_000, max_output_tokens: 128_000,
    },
    {
      id: "codex/gpt-6-sol", owned_by: "codex", display_name: "GPT-6 Sol", reasoning: true,
      reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    { id: "deepseek/deepseek-flash", owned_by: "deepseek", reasoning: false, supported_reasoning_levels: [{ effort: "high" }] },
  ],
};

// A CLIProxyAPI-like detailed catalog (?client_version=pi): the suffix goes to the proxy as it is.
const detailedCatalog = {
  models: [{ slug: "claude-sonnet-5", display_name: "Claude Sonnet 5", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
};

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function sse(res: import("node:http").ServerResponse, events: Array<[string | null, object]>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

// The gateway: GET models (plain, or detailed when asked), POST answers with a short reply and records the body.
async function gatewayStub(options: { detailed?: boolean } = {}): Promise<{ origin: string; bodies: Body[] }> {
  const bodies: Body[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (req.method === "GET") {
      if (url.searchParams.get("client_version") === "pi") {
        if (!options.detailed) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(detailedCatalog));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.detailed ? { data: [{ id: "claude-sonnet-5", owned_by: "anthropic" }] } : plainCatalog));
      return;
    }
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Body;
      bodies.push(body);
      if (url.pathname.endsWith("/messages")) {
        sse(res, [
          ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
        res.end();
        return;
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const chunk = (value: object): [null, object] => [null, { id: "c", object: "chat.completion.chunk", created: 0, model: body.model, ...value }];
        sse(res, [
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        ]);
        res.end("data: [DONE]\n\n");
        return;
      }
      // The Responses API: only the request body matters here.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub" } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, bodies };
}

const providerConfig = (provider: Record<string, unknown>, models: string[] = []) => normalizeLeadModelConfig({
  providers: { magpie: { apiKey: { value: "test" }, discover: true, ...provider } as never },
  models,
});

// Registers the providers in a real ModelRuntime and sends one request for each spec.
async function send(config: ReturnType<typeof providerConfig>, specs: string[]): Promise<Array<{ stopReason: string; errorMessage?: string }>> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  await registerLeadProviders(runtime, { ...config, models: [...config.models, ...specs] }, {});
  const results: Array<{ stopReason: string; errorMessage?: string }> = [];
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
    if (!model) throw new Error(`not registered: ${spec}`);
    const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    results.push(reply as never);
  }
  return results;
}

describe("discovering the effort levels of a plain catalog", () => {
  it("lists the levels that the provider's API can send, and none for a model that does not reason", async () => {
    const stub = await gatewayStub();
    const { models, providers } = await leadModelCatalog(providerConfig({ api: "anthropic-messages", baseUrl: stub.origin }), {});
    expect(providers.magpie?.detailed).toBe(false);
    const byId = (id: string) => models.find((model) => model.id === id);
    expect(byId("claude/claude-opus-5-5")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null });
    // ultra has no request field that pi can write: not listed.
    expect(byId("codex/gpt-6-sol")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byId("deepseek/deepseek-flash")?.efforts).toEqual([]);
  });

  it("lists no levels where the API cannot carry them, or where the config turns the effort field off", async () => {
    const stub = await gatewayStub();
    const efforts = async (provider: Record<string, unknown>) => (await leadModelCatalog(providerConfig(provider), {}))
      .models.find((model) => model.id === "claude/claude-opus-5-5")?.efforts;
    expect(await efforts({ api: "google-generative-ai", baseUrl: `${stub.origin}/v1` })).toEqual([]);
    expect(await efforts({ api: "openai-completions", baseUrl: `${stub.origin}/v1`, compat: { supportsReasoningEffort: false } })).toEqual([]);
    expect(await efforts({ api: "openai-completions", baseUrl: `${stub.origin}/v1`, compat: { thinkingFormat: "qwen" } })).toEqual([]);
    expect(await efforts({ api: "openai-completions", baseUrl: `${stub.origin}/v1` })).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(await efforts({ api: "openai-responses", baseUrl: `${stub.origin}/v1` })).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("refuses a level the provider cannot be sent, instead of choosing another one", async () => {
    const stub = await gatewayStub();
    const config = providerConfig({ api: "anthropic-messages", baseUrl: stub.origin });
    await expect(assertConfiguredLeadModel("magpie/claude/claude-opus-5-5(max)", config, {})).resolves.toBeUndefined();
    await expect(assertConfiguredLeadModel("magpie/codex/gpt-6-sol(ultra)", config, {})).rejects.toThrow(/不支持推理强度 ultra/);
  });
});

describe("sending the effort as a request field", () => {
  it("anthropic-messages: output_config.effort with the model id unchanged; no effort fields for the default", async () => {
    const stub = await gatewayStub();
    const config = providerConfig({ api: "anthropic-messages", baseUrl: stub.origin });
    const replies = await send(config, ["magpie/claude/claude-opus-5-5(high)", "magpie/claude/claude-opus-5-5(max)", "magpie/claude/claude-opus-5-5"]);
    expect(replies.map((reply) => reply.stopReason)).toEqual(["stop", "stop", "stop"]);
    const [high, max, plain] = stub.bodies as [Body, Body, Body];
    expect(high.model).toBe("claude/claude-opus-5-5");
    expect(high.output_config).toEqual({ effort: "high" });
    expect(high.thinking).toMatchObject({ type: "adaptive" });
    // pi maps max to high unless the model's level map says otherwise: max goes out as max.
    expect(max.model).toBe("claude/claude-opus-5-5");
    expect(max.output_config).toEqual({ effort: "max" });
    // The default sends what it sent before: the plain id, no effort, no thinking settings.
    expect(plain.model).toBe("claude/claude-opus-5-5");
    expect(plain).not.toHaveProperty("output_config");
    expect(plain).not.toHaveProperty("thinking");
  }, 30_000);

  it("openai-completions: reasoning_effort; openai-responses: reasoning.effort", async () => {
    const stub = await gatewayStub();
    await send(providerConfig({ api: "openai-completions", baseUrl: `${stub.origin}/v1` }), ["magpie/codex/gpt-6-sol(xhigh)", "magpie/codex/gpt-6-sol"]);
    const [xhigh, plain] = stub.bodies as [Body, Body];
    expect(xhigh.model).toBe("codex/gpt-6-sol");
    expect(xhigh.reasoning_effort).toBe("xhigh");
    expect(plain.model).toBe("codex/gpt-6-sol");
    expect(plain).not.toHaveProperty("reasoning_effort");

    stub.bodies.length = 0;
    await send(providerConfig({ api: "openai-responses", baseUrl: `${stub.origin}/v1` }), ["magpie/codex/gpt-6-sol(low)"]);
    expect(stub.bodies[0]).toMatchObject({ model: "codex/gpt-6-sol", reasoning: { effort: "low" } });
  }, 30_000);

  it("CLIProxyAPI keeps the suffix in the model id and sends no effort field, as before", async () => {
    const stub = await gatewayStub({ detailed: true });
    const config = providerConfig({ api: "openai-completions", baseUrl: `${stub.origin}/v1` });
    const { providers } = await leadModelCatalog(config, {});
    expect(providers.magpie?.detailed).toBe(true);
    await send(config, ["magpie/claude-sonnet-5(high)", "magpie/claude-sonnet-5"]);
    const [high, plain] = stub.bodies as [Body, Body];
    expect(high.model).toBe("claude-sonnet-5(high)");
    expect(high).not.toHaveProperty("reasoning_effort");
    expect(plain.model).toBe("claude-sonnet-5");
  }, 30_000);

  it("fails the request when the body would not carry the chosen effort, instead of sending another one", async () => {
    const model = {
      id: "claude/claude-opus-5-5(high)", provider: "magpie", api: "anthropic-messages", reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
    } as unknown as Model<Api>;
    const stripped = leadEffortRequest(model, { onPayload: (payload: unknown) => ({ ...(payload as Body), output_config: undefined }) });
    expect(stripped.model.id).toBe("claude/claude-opus-5-5");
    expect(stripped.options?.reasoning).toBe("high");
    await expect(stripped.options!.onPayload!({ model: "claude/claude-opus-5-5", output_config: { effort: "high" } }, stripped.model))
      .rejects.toThrow(/could not send the effort high/);
    const kept = leadEffortRequest(model, {});
    await expect(kept.options!.onPayload!({ model: "claude/claude-opus-5-5", output_config: { effort: "high" } }, kept.model))
      .resolves.toMatchObject({ output_config: { effort: "high" } });
    await expect(kept.options!.onPayload!({ model: "claude/claude-opus-5-5(high)", output_config: { effort: "high" } }, kept.model))
      .rejects.toThrow(/instead of claude\/claude-opus-5-5/);
    // A model without a parameter effort (the default, or a CLIProxyAPI suffix) is not touched.
    const untouched = { ...model, reasoning: false } as Model<Api>;
    const options = { maxTokens: 1 };
    expect(leadEffortRequest(untouched, options)).toEqual({ model: untouched, options });
  });

  it("the summary on the session prefix sends the same model id and effort as the session", async () => {
    const stub = await gatewayStub();
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    await registerLeadProviders(runtime, providerConfig({ api: "anthropic-messages", baseUrl: stub.origin }, ["magpie/claude/claude-opus-5-5(high)"]), {});
    const model = runtime.getModel("magpie", "claude/claude-opus-5-5(high)")!;
    const calls: Array<{ id: string; reasoning: unknown }> = [];
    await summarizeOnPrefix({
      prefix: { provider: "magpie", model: model.id, sessionId: "s", promptCacheKey: false, messages: [] },
      model, maxTokens: 1_000, standardMaxTokens: 1_000, signal: new AbortController().signal,
      complete: (async (wire: Model<Api>, _context: unknown, options: { reasoning?: unknown }) => {
        calls.push({ id: wire.id, reasoning: options.reasoning });
        return { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "stop", usage: {} };
      }) as never,
    });
    expect(calls).toEqual([{ id: "claude/claude-opus-5-5", reasoning: "high" }]);
  });
});

describe("a Lead session on a provider that takes the effort as a field", () => {
  it("switches to a chosen effort (also a one-turn model) and sends it, with prompt_cache_key kept", async () => {
    const stub = await gatewayStub();
    const dataDir = tempDir("plc-lead-effort-parameter-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { magpie: { api: "openai-completions", baseUrl: `${stub.origin}/v1`, apiKey: { value: "test" }, discover: true } },
        models: ["magpie/claude/claude-opus-5-5"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as { prompt(text: string): Promise<void>; sessionManager: { getSessionId(): string }; dispose(): void };
    try {
      await session.prompt("default effort");
      // The one-turn model is not in config.json's chain: switchModel registers it (turn-model-session.test.ts).
      await lead.switchModel("magpie/claude/claude-opus-5-5(high)");
      expect(lead.currentModel()).toBe("magpie/claude/claude-opus-5-5(high)");
      await session.prompt("high effort");
      await lead.switchModel("magpie/claude/claude-opus-5-5");
      await session.prompt("default again");
      const chats = stub.bodies;
      expect(chats.map((body) => body.model)).toEqual(["claude/claude-opus-5-5", "claude/claude-opus-5-5", "claude/claude-opus-5-5"]);
      expect(chats.map((body) => body.reasoning_effort)).toEqual([undefined, "high", undefined]);
      const sessionId = session.sessionManager.getSessionId();
      expect(chats.map((body) => body.prompt_cache_key)).toEqual([sessionId, sessionId, sessionId]);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

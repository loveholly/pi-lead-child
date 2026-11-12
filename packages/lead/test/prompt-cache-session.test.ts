// Prompt cache, end to end: a real createLeadSession against a local OpenAI-compatible stub (a gateway, not
// api.openai.com). The stub rejects prompt_cache_retention like a deployment without long cache retention does.
//   - Every Lead request carries the session id as prompt_cache_key, and no prompt_cache_retention.
//   - Compaction sends its summary request on the session prefix: the same system message, tools and messages as the
//     last request, then one user message that asks for the summary. Before, it sent a new system prompt and the
//     history as one serialized text, so no provider could serve any of it from cache.
//   - promptCacheKey: false in the provider config turns the key off.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown; prompt_cache_key?: string; prompt_cache_retention?: unknown };

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function gatewayStub(): Promise<{ baseUrl: string; bodies: Body[] }> {
  const bodies: Body[] = [];
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Body;
      bodies.push(body);
      if (body.prompt_cache_retention !== undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Unrecognized request argument supplied: prompt_cache_retention" } }));
        return;
      }
      const last = JSON.stringify(body.messages[body.messages.length - 1]?.content ?? "");
      const text = last.includes("[Context compaction]") ? "## Goal\nsummary on the prefix" : `reply ${bodies.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, bodies };
}

function writeConfig(dataDir: string, baseUrl: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    lead: {
      providers: {
        gateway: {
          api: "openai-completions", baseUrl, apiKey: { value: "test" }, discover: false,
          models: [{ id: "m", contextWindow: 200_000, maxTokens: 16_384 }], ...extra,
        },
      },
      models: ["gateway/m"],
    },
  }));
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// An earlier history, large enough that pi has something to compact (about 40K tokens; the window is 200K).
function writeHistory(dataDir: string): void {
  const manager = SessionManager.create(dataDir, join(dataDir, "lead-sessions"));
  for (let round = 0; round < 20; round += 1) {
    manager.appendMessage({ role: "user", content: `question ${round} ${"q".repeat(4_000)}`, timestamp: round * 2 });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: `answer ${round} ${"a".repeat(4_000)}` }],
      api: "openai-completions", provider: "gateway", model: "m", usage, stopReason: "stop", timestamp: round * 2 + 1,
    } as never);
  }
}

type TestSession = {
  prompt(text: string): Promise<void>;
  compact(instructions?: string): Promise<unknown>;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  dispose(): void;
};

describe("Lead prompt cache against an OpenAI-compatible gateway", () => {
  it("sends the session id as prompt_cache_key, and compacts on the session prefix", async () => {
    const stub = await gatewayStub();
    const dataDir = tempDir("plc-lead-prompt-cache-");
    writeConfig(dataDir, stub.baseUrl);
    writeHistory(dataDir);
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as TestSession;
    try {
      await session.prompt("hello");
      await session.prompt("one more thing");
      const sessionId = session.sessionManager.getSessionId();
      expect(stub.bodies.length).toBe(2);
      for (const body of stub.bodies) {
        expect(body.prompt_cache_key).toBe(sessionId);
        expect(body).not.toHaveProperty("prompt_cache_retention");
      }

      await session.compact();

      expect(stub.bodies.length).toBe(3);
      const [, last, summary] = stub.bodies as [Body, Body, Body];
      // Same routing key, and nothing the gateway rejects (it would have answered 400).
      expect(summary.prompt_cache_key).toBe(sessionId);
      expect(summary).not.toHaveProperty("prompt_cache_retention");
      // Same tools, and the last request's messages are the start of the summary request.
      expect(summary.tools).toEqual(last.tools);
      expect(summary.messages.slice(0, last.messages.length)).toEqual(last.messages);
      // Then the reply to the last request, then the summary prompt.
      expect(summary.messages.length).toBe(last.messages.length + 2);
      expect(summary.messages[last.messages.length]!.role).toBe("assistant");
      expect(JSON.stringify(summary.messages[summary.messages.length - 1])).toContain("[Context compaction]");
      // Not pi's separate summarization request: no serialized <conversation> text.
      expect(JSON.stringify(summary.messages)).not.toContain("<conversation>");

      const saved = readFileSync(session.sessionManager.getSessionFile()!, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { type: string; summary?: string; details?: { prefix?: boolean } });
      const compaction = saved.find((entry) => entry.type === "compaction");
      expect(compaction?.summary).toContain("summary on the prefix");
      expect(compaction?.details?.prefix).toBe(true);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);

  it("does not send prompt_cache_key when the provider config turns it off", async () => {
    const stub = await gatewayStub();
    const dataDir = tempDir("plc-lead-prompt-cache-off-");
    writeConfig(dataDir, stub.baseUrl, { promptCacheKey: false });
    writeHistory(dataDir);
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as TestSession;
    try {
      await session.prompt("hello");
      await session.compact();
      expect(stub.bodies.length).toBe(2);
      for (const body of stub.bodies) expect(body).not.toHaveProperty("prompt_cache_key");
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

// 打断式插话走完整的一跳（2026-11-09）：真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上。
// 第一次请求开了头就不再说话（模型在想）。这时插话、中止这一步：同一次 prompt 里，pi 把插话送进去再请求一次，
// 第二次请求里还有原来的问题（之前的任务没丢），没有被中止的那半步。用来核对 step-interrupt.ts 依赖的 pi 行为：
// 只中止这一步的流（stopReason=aborted），pi 看到队列里有插话就自己 continue()。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

let server: Server | null = null;
const open: ServerResponse[] = [];
afterEach(async () => {
  for (const res of open.splice(0)) res.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

// 带「问题 A」的第一次请求：发了响应头以后一直不说话。之后的请求回一句话就结束。
async function thinkingStub(): Promise<{ baseUrl: string; chats: string[]; closed: () => number }> {
  const chats: string[] = [];
  let closed = 0;
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      if (body.includes("问题 A")) chats.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (body.includes("问题 A") && chats.length === 1) {
        open.push(res);
        res.on("close", () => { closed += 1; });
        return;
      }
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "B 的回答。" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, chats, closed: () => closed };
}

const textOf = (message: any): string => (typeof message?.content === "string"
  ? message.content
  : (message?.content ?? []).map((part: any) => part?.text ?? "").join(""));

describe("interrupting a real Lead session's step for a steer", () => {
  it("stops the unfinished step, then answers the steer in the same prompt with the earlier question still in context", async () => {
    const stub = await thinkingStub();
    const dataDir = tempDir("plc-lead-step-interrupt-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: {
          stub: {
            api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false,
            models: [{ id: "m", contextWindow: 64_000, maxTokens: 2_000 }],
          },
        },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as {
      prompt(text: string): Promise<void>; steer(text: string): Promise<unknown>; subscribe(listener: (event: any) => void): () => void;
      dispose(): void;
    };
    const events: any[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const running = session.prompt("问题 A");
      // 模型开始回答了，还没说话：这一步可以中止。
      await vi.waitFor(() => expect(events.some((event) => event.type === "message_start" && event.message?.role === "assistant")).toBe(true));
      await session.steer("插话 B");
      expect(lead.interruptStep()).toBe(true);
      await running;

      // 中止的是这一次流：连接断了，pi 接着请求了第二次。
      expect(stub.closed()).toBe(1);
      expect(stub.chats).toHaveLength(2);
      expect(stub.chats[1]).toContain("插话 B");
      expect(stub.chats[1]).toContain("问题 A");
      const ends = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message.stopReason);
      expect(ends).toEqual(["aborted", "stop"]);
      const abortedAt = events.findIndex((event) => event.type === "message_end" && event.message?.stopReason === "aborted");
      const steerAt = events.findIndex((event) => event.type === "message_start" && event.message?.role === "user" && textOf(event.message) === "插话 B");
      expect(steerAt).toBeGreaterThan(abortedAt);
      // 这时没有可以中止的一步了。
      expect(lead.interruptStep()).toBe(false);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

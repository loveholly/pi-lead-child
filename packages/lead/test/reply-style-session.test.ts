// 代回复风格进 Lead 的系统提示（2026-10-28，.scratch/channel-reply-style/spec.md 2.3 节）：用真实的 createLeadSession，
// 模型接到本机的 OpenAI 兼容桩上，看每一轮发给模型的系统提示。在设置页保存以后，下一轮就有 reply-style 一节；
// 清空以后，下一轮这一节就没有了。不用重建会话。
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { runUiAction } from "@pi-lead-child/engine";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

// OpenAI 兼容的 /chat/completions：记下每次请求的系统消息，流式回答一句话。
async function openAiStub(): Promise<{ baseUrl: string; systems: string[] }> {
  const systems: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      systems.push(parsed.messages.filter((message) => message.role === "system" || message.role === "developer")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "好的。" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, systems };
}

describe("the reply style in Lead's system prompt", () => {
  it("appears the turn after you save it on the settings page, and goes away the turn after you clear it", async () => {
    const stub = await openAiStub();
    const dataDir = tempDir("plc-lead-reply-style-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as { prompt(text: string): Promise<void>; dispose(): void };
    const style = "- 极其精简，不寒暄\n- 对方回 ok 时回 :heart:，不回 :ok_hand:";
    try {
      await session.prompt("你好");
      expect(stub.systems[0]).not.toContain("代回复风格");

      await runUiAction(db, { target: { type: "reply_style", id: "user" }, action: "update", input: { mode: "replace", text: style }, caller: { kind: "user" } });
      await session.prompt("帮我回 Oliver");
      expect(stub.systems[1]).toContain("代用户写给别人的话按下面的代回复风格写");
      expect(stub.systems[1]).toContain(style);

      await runUiAction(db, { target: { type: "reply_style", id: "user" }, action: "update", input: { mode: "replace", text: "" }, caller: { kind: "user" } });
      await session.prompt("再说一次");
      expect(stub.systems[2]).not.toContain(style);
    } finally {
      session.dispose();
      db.close();
    }
  }, 30_000);
});

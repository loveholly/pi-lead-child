// 模型回复慢（lead-scheduler spec D7、D11，P3 的 S8c）：真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上。
// 桩回了响应头以后过很久才给第一段输出。核对：过了阈值记一条 stage.slow stage=B（不算卡死），通知界面「模型回复慢」，
// 有了第一段输出以后撤掉；这一步不被中止，回答照常到。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  vi.unstubAllEnvs();
});

async function slowFirstToken(delayMs: number): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      setTimeout(() => {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "终于想好了。" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.end("data: [DONE]\n\n");
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

describe("a slow model in a real Lead session (D7, S8c)", () => {
  it("logs the slow stage, shows it, clears it at the first output, and does not stop the step", async () => {
    vi.stubEnv("PLC_LEAD_MODEL_SLOW_MS", "300");
    const baseUrl = await slowFirstToken(1_200);
    const dataDir = tempDir("plc-lead-model-slow-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl, apiKey: { value: "test" }, discover: false, models: [{ id: "m", contextWindow: 64_000, maxTokens: 2_000 }] } },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const logs: string[] = [];
    const statuses: Array<string | null> = [];
    const lead = await createLeadSession({
      dataDir, dbPath: join(dataDir, "plc.db"), db, schedulerLog: (line) => logs.push(line),
      schedulerHooks: { stepStatus: (status) => statuses.push(status?.kind ?? null) },
    });
    const session = lead.session as unknown as { prompt(text: string): Promise<void>; subscribe(listener: (event: any) => void): () => void; dispose(): void };
    const ends: string[] = [];
    session.subscribe((event) => { if (event.type === "message_end" && event.message?.role === "assistant") ends.push(event.message.stopReason); });
    try {
      await session.prompt("想一想再回答");
      expect(ends).toEqual(["stop"]);
      expect(statuses).toEqual(["model_slow", null]);
      const slow = logs.find((line) => line.startsWith("[sched] stage.slow stage=B"))!;
      expect(slow).toContain("model_slow=true stall=false");
      expect(slow).toContain("thresholdMs=300");
      expect(logs.some((line) => line.startsWith("[sched] stage.over stage=B"))).toBe(true);
      expect(logs.some((line) => line.includes("abort"))).toBe(false);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

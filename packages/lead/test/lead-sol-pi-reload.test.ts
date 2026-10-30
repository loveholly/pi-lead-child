import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

// SoL-Pi 在 daemon 运行中装好时，加载进正在运行的 Lead 会话，不重启 daemon（2026-10-16 用户要求）。
// Lead 是一个常驻会话，自己从不重建。以前 SoL-Pi 第一次装好之后，要等 daemon 重启，Lead 才用得上它。
// 这里用真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上：reload 之后 obs_recall 能用，
// 会话 id 和上下文不变，模型照样能调（pi 的 reload 会重置 API provider）。

let server: Server | null = null;
const savedEntry = process.env.PLC_SOL_PI_ENTRY;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (savedEntry === undefined) delete process.env.PLC_SOL_PI_ENTRY;
  else process.env.PLC_SOL_PI_ENTRY = savedEntry;
});

// OpenAI 兼容的 /chat/completions，流式回答一句话。
async function openAiStub(): Promise<{ baseUrl: string; calls: () => number }> {
  let calls = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (body: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...body })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "好的。" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, calls: () => calls };
}

// 假的 SoL-Pi 包：和上游一样没有 node_modules，ObservationPack 注册 obs_recall。
function fakeSolPiEntry(): string {
  const dir = join(tempDir("plc-sol-pi-pkg-"), "src", "sol-pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.ts"), `export const DEFAULT_CONFIG = Object.freeze({ version: 1, actionFusion: false,
    observationPack: false, evidencePreservingReducer: false, onlineContextCompact: false, cacheWriteReadRatio: 12.5 });\n`);
  writeFileSync(join(dir, "index.ts"), `
import { Type } from "typebox";
export function createSolPiExtension(load) {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      if (!load(ctx).observationPack) return;
      pi.registerTool({ name: "obs_recall", label: "Recall", description: "recall", parameters: Type.Object({ id: Type.String() }),
        async execute() { return { content: [{ type: "text", text: "" }], details: undefined }; } });
    });
  };
}
`);
  return join(dir, "index.ts");
}

describe("SoL-Pi installed while the Lead session runs", () => {
  it("binds into the live Lead session: same session and context, obs_recall active, the model still answers", async () => {
    delete process.env.PLC_SOL_PI_ENTRY;
    const stub = await openAiStub();
    const dataDir = tempDir("plc-lead-reload-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as {
      sessionId: string; messages: unknown[]; getActiveToolNames(): string[]; prompt(text: string): Promise<void>; dispose(): void;
    };
    try {
      await session.prompt("你好");
      expect(stub.calls()).toBe(1);
      expect(session.getActiveToolNames()).not.toContain("obs_recall");
      const sessionId = session.sessionId;
      const messages = session.messages.length;

      // daemon 运行中，SoL-Pi 第一次装好（engine 的 sol-pi-package.ts 的 sync）。
      process.env.PLC_SOL_PI_ENTRY = fakeSolPiEntry();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await lead.reloadExtensions!();
      // 部署时据此确认 Lead 真的绑上了 SoL-Pi：机制名和固定 commit 的前 7 位，没有路径。
      const lines = logged.mock.calls.map((call) => String(call[0]));
      logged.mockRestore();
      expect(lines).toContain("[lead] sol-pi loaded: observationPack (41fa7e0)");
      expect(lines.join("\n")).not.toContain(process.env.PLC_SOL_PI_ENTRY);

      expect(session.sessionId).toBe(sessionId);
      expect(session.messages).toHaveLength(messages);
      const active = session.getActiveToolNames();
      expect(active).toContain("obs_recall");
      // Lead 自己的工具和授权照旧：受授权的 confirm_item 没有授权时仍然不激活；沙箱里的 bash、edit、write 和 codemode
      // 照常激活（lead-tools-and-routing spec D5）。
      expect(active).toEqual(expect.arrayContaining(["query_tickets", "save_note", "read", "bash", "edit", "write", "codemode"]));
      expect(active).not.toContain("confirm_item");

      await session.prompt("再说一次");
      expect(stub.calls()).toBe(2);
      expect(session.messages.length).toBeGreaterThan(messages);
    } finally {
      session.dispose();
      db.close();
    }
  }, 30_000);

  it("logs the success line when a new Lead session binds SoL-Pi, and nothing when it is not installed", async () => {
    const stub = await openAiStub();
    const dataDir = tempDir("plc-lead-reload-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
        models: ["stub/m"],
      },
    }));
    const start = async () => {
      const db = openDb(join(dataDir, "plc.db"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
      const lines = logged.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("sol-pi"));
      logged.mockRestore();
      (lead.session as unknown as { dispose(): void }).dispose();
      db.close();
      return lines;
    };

    delete process.env.PLC_SOL_PI_ENTRY;
    expect(await start()).toEqual([]);
    process.env.PLC_SOL_PI_ENTRY = fakeSolPiEntry();
    expect(await start()).toEqual(["[lead] sol-pi loaded: observationPack (41fa7e0)"]);
  }, 30_000);
});

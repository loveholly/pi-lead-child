// 每一步的预算状态走完整的一跳（lead-scheduler spec D3，P2）：真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上。
// 第一次请求回一个工具调用（ls），第二次请求回最后的回答。核对调度器 extension 依赖的 pi 行为：
//   · turn_end 里发的不显示的自定义消息（triggerTurn=false）接在工具结果后面，第二次请求里看得到；
//   · 它不改工具结果（界面和读结果的代码看不到它），也不让这次运行多调一次模型；
//   · 做过的步骤报给了交接的钩子，第二步开始前叫了让出点。
import { afterEach, describe, expect, it } from "vitest";
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
});

const BUDGET = '<system_event kind="budget" source="daemon">\nL0 · 已用 1 秒（1 步）\n</system_event>';

async function toolThenAnswer(): Promise<{ baseUrl: string; bodies: any[] }> {
  const bodies: any[] = [];
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      if (bodies.length === 1) {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ls", arguments: JSON.stringify({ path: "." }) } }] }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      } else {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "看过了。" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, bodies };
}

const textOf = (message: any): string => (typeof message?.content === "string"
  ? message.content
  : (message?.content ?? []).map((part: any) => part?.text ?? "").join(""));

describe("the budget status line in a real Lead session (D3)", () => {
  it("reaches the model after the tool result, leaves the result alone, and adds no model call", async () => {
    const stub = await toolThenAnswer();
    const dataDir = tempDir("plc-lead-budget-line-");
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
    const work: string[] = [];
    const yields: number[] = [];
    const lead = await createLeadSession({
      dataDir, dbPath: join(dataDir, "plc.db"), db,
      schedulerHooks: {
        work: { toolStart: (call) => work.push(`start:${call.tool}`), toolEnd: (call) => work.push(`end:${call.id}`) },
        budgetStatus: () => BUDGET,
        yieldPoint: (step) => yields.push(step),
      },
    });
    const session = lead.session as unknown as {
      prompt(text: string): Promise<void>; subscribe(listener: (event: any) => void): () => void; dispose(): void;
    };
    const events: any[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.prompt("看一下数据目录里有什么");
      expect(stub.bodies).toHaveLength(2);
      const messages = stub.bodies[1].messages as any[];
      const toolAt = messages.findIndex((message) => message.role === "tool");
      const budgetAt = messages.findIndex((message) => message.role === "user" && textOf(message).includes('kind="budget"'));
      expect(toolAt).toBeGreaterThan(0);
      expect(budgetAt).toBeGreaterThan(toolAt);
      expect(textOf(messages[toolAt])).not.toContain('kind="budget"');
      // 工具结果的事件里也没有它（界面画的是这个）。
      const ended = events.find((event) => event.type === "tool_execution_end" && event.toolName === "ls");
      expect(JSON.stringify(ended.result)).not.toContain('kind="budget"');
      expect(work).toEqual(["start:ls", "end:call_1"]);
      expect(yields).toEqual([2]);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

// 打断式插话走完整的一跳（2026-11-09）：真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上。
// 第一次请求开了头就不再说话（模型在想）。这时插话、中止这一步：同一次 prompt 里，pi 把插话送进去再请求一次，
// 第二次请求里还有原来的问题（之前的任务没丢），没有被中止的那半步。用来核对 step-interrupt.ts 依赖的 pi 行为：
// 只中止这一步的流（stopReason=aborted），pi 看到队列里有插话就自己 continue()。
// 第一次请求在写长文时（2026-11-10）：写出的字作为一条正常结束的回答留下，插话在同一次运行里送进去，前面带「被打断」的说明。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// headers=false：第一次请求连响应头也不回，像 vibeproxy 那样要等模型想完才回（2026-11-09 实测）。
// writing=true：第一次请求一直在写长文，每 20 毫秒写一句，自己不结束（2026-11-10：Lead 正在写长文时用户插话）。
async function thinkingStub(options: { headers?: boolean; writing?: boolean } = {}): Promise<{ baseUrl: string; chats: string[]; closed: () => number }> {
  const chats: string[] = [];
  let closed = 0;
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      if (body.includes("问题 A")) chats.push(body);
      const holding = body.includes("问题 A") && chats.length === 1;
      if (holding && options.headers === false) {
        open.push(res);
        res.on("close", () => { closed += 1; });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const chunk = (value: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...value })}\n\n`);
      if (holding) {
        open.push(res);
        res.on("close", () => { closed += 1; });
        if (options.writing) {
          let sentence = 0;
          const timer = setInterval(() => chunk({ choices: [{ index: 0, delta: { content: `长文第${++sentence}句。` }, finish_reason: null }] }), 20);
          res.on("close", () => clearInterval(timer));
        }
        return;
      }
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "B 的回答。" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, chats, closed: () => closed };
}

// 新会话的第一次请求要先建好提示词和工具：机器忙时超过 vi.waitFor 缺省的 1 秒（2026-11-10 本地连跑 3 次失败 1 次）。
const FIRST_REQUEST = { timeout: 10_000 };

const textOf = (message: any): string => (typeof message?.content === "string"
  ? message.content
  : (message?.content ?? []).map((part: any) => part?.text ?? "").join(""));

async function interruptScenario(headers: boolean): Promise<void> {
    const stub = await thinkingStub({ headers });
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
      // 模型开始回答了，还没说话：这一步可以中止。代理还没回响应头时（headers=false）也一样。
      if (headers) {
        await vi.waitFor(() => expect(events.some((event) => event.type === "message_start" && event.message?.role === "assistant")).toBe(true), FIRST_REQUEST);
      } else {
        await vi.waitFor(() => expect(stub.chats).toHaveLength(1), FIRST_REQUEST);
        expect(events.some((event) => event.type === "message_start" && event.message?.role === "assistant")).toBe(false);
      }
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
}

describe("interrupting a real Lead session's step for a steer", () => {
  it("stops the unfinished step, then answers the steer in the same prompt with the earlier question still in context", async () => {
    await interruptScenario(true);
  }, 60_000);

  // 回归（2026-11-09）：vibeproxy 要等模型想完才回响应头。以前这时还没有 message_start，不能中止，插话照旧等一整步。
  it("also stops a step whose request has no response headers yet, as behind a proxy that waits for the first token", async () => {
    await interruptScenario(false);
  }, 60_000);

  // 回归（2026-11-10 插话验收）：Lead 正在写长文时插话，以前要等整篇写完；「写短一点」5 轮里 4 轮先写完 2000 字的长文。
  // 现在这一步马上结束，写出的字作为一条完整的助手消息留在上下文里（不是 aborted，模型记得它写过什么），
  // 插话在同一次运行里送进去；发给模型的那一份里，插话前面有一段说明：上一条回答被打断了，用户看到了那些字。
  it("cuts a step that is writing text: the text stays as a complete message, and the steer follows in the same run", async () => {
    const stub = await thinkingStub({ writing: true });
    const dataDir = tempDir("plc-lead-step-cut-");
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
    let streamed = "";
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") streamed += event.assistantMessageEvent.delta;
    });
    try {
      const running = session.prompt("问题 A");
      await vi.waitFor(() => expect(streamed).toContain("长文第3句。"), FIRST_REQUEST);
      await session.steer("插话 B");
      expect(lead.interruptStep()).toBe(true);
      await running;

      // 写长文的那次请求断了，pi 在同一次运行里接着请求了一次（没有结束运行再 continue()）。
      expect(stub.closed()).toBe(1);
      expect(stub.chats).toHaveLength(2);
      expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
      const ends = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
      expect(ends.map((message) => message.stopReason)).toEqual(["stop", "stop"]);
      // 被打断的那条：内容就是界面已经收到的字，没有多也没有少；带着标记，没有错误。
      expect(ends[0].interruptedBy).toBe("steer");
      expect(ends[0].errorMessage).toBeUndefined();
      expect(textOf(ends[0])).toBe(streamed.slice(0, textOf(ends[0]).length));
      expect(textOf(ends[0]).length).toBeGreaterThan(0);
      expect(ends[1].interruptedBy).toBeUndefined();

      // 第二次请求：原来的问题、写到一半的回答（assistant），然后是说明和插话（同一条 user 消息，说明在前）。
      const sent = JSON.parse(stub.chats[1]!) as { messages: Array<{ role: string; content: unknown }> };
      const tail = sent.messages.slice(-3);
      expect(tail.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(JSON.stringify(tail[0]!.content)).toContain("问题 A");
      expect(JSON.stringify(tail[1]!.content)).toContain(textOf(ends[0]));
      const steer = JSON.stringify(tail[2]!.content);
      expect(steer).toContain('kind=\\"steer\\"');
      expect(steer).toContain("被用户打断");
      expect(steer.indexOf("被用户打断")).toBeLessThan(steer.indexOf("插话 B"));
      // 说明只在发给模型的那一份里：会话里的插话还是原文。
      const delivered = events.find((event) => event.type === "message_start" && event.message?.role === "user" && textOf(event.message).includes("插话 B"));
      expect(textOf(delivered.message)).toBe("插话 B");
      // 标记存进了会话文件：重启以后读回来，发给模型时照样带说明。
      const sessionFiles = readdirSync(join(dataDir, "lead-sessions")).filter((name) => name.endsWith(".jsonl"));
      const persisted = sessionFiles.flatMap((name) => readFileSync(join(dataDir, "lead-sessions", name), "utf8").split("\n").filter(Boolean))
        .map((line) => JSON.parse(line) as { message?: { role?: string; stopReason?: string; interruptedBy?: string } })
        .filter((entry) => entry.message?.interruptedBy === "steer");
      expect(persisted.map((entry) => entry.message!.stopReason)).toEqual(["stop"]);
      expect(lead.interruptStep()).toBe(false);
    } finally {
      session.dispose();
      db.close();
    }
  }, 60_000);
});

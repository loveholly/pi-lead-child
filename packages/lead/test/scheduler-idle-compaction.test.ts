// 空闲车道写摘要的子进程（lead-scheduler spec D8，P4）：真的起子进程（经 tsx 跑源码），模型是本机的一个假的
// openai-completions 服务。凭据只经标准输入给子进程；子进程登记成后台作业，起止各一行 [sched] job.*。
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runningHostJobs, setHostJobLog } from "@pi-lead-child/core";
import { runIdleCompact } from "../src/scheduler/idle-compact-child.js";
import { summarizeInChild, type IdleCompactRequest } from "../src/scheduler/index.js";

let server: Server | null = null;
afterEach(async () => {
  setHostJobLog(null);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

// 每个请求答一段流式的 chat.completion.chunk。记下收到的请求头和正文。
async function fakeModel(answer: string): Promise<{ baseUrl: string; seen: Array<{ authorization: string | undefined; body: any }> }> {
  const seen: Array<{ authorization: string | undefined; body: any }> = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] });
      chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen };
}

function request(baseUrl: string): IdleCompactRequest {
  return {
    version: 1,
    model: {
      id: "fake-model", name: "fake-model", provider: "fake", api: "openai-completions", baseUrl, reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384,
    },
    auth: { apiKey: "test-key-from-stdin" },
    preparation: {
      firstKeptEntryId: "entry-9",
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "李雷 asked to rename the report." }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Renamed it." }], timestamp: 2, api: "openai-completions", provider: "fake", model: "fake-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 150_000,
      fileOps: { read: ["/Users/alice/notes.md"], written: [], edited: [] },
      settings: { enabled: true, reserveTokens: 20_480, keepRecentTokens: 20_000 },
    },
  };
}

describe("the idle compaction child process", () => {
  it("writes the summary in a child process, with the key only on stdin, and logs the job", async () => {
    const model = await fakeModel("SUMMARY FROM THE CHILD");
    const lines: string[] = [];
    setHostJobLog((line) => lines.push(line));
    let pid: number | null = null;
    const summarizing = summarizeInChild(request(model.baseUrl), { id: "idle_compact_t1", timeoutMs: 60_000 });
    // 子进程登记成后台作业（探针的卡顿说明里能看到它）。
    pid = runningHostJobs().find((job) => job.kind === "idle-compact")?.pid ?? null;
    const { response } = await summarizing;
    expect(response).toMatchObject({ ok: true, summary: expect.stringContaining("SUMMARY FROM THE CHILD"), level: "normal", chunks: 1 });
    // 读过的文件照 pi 的样子附在摘要末尾。
    expect(response.ok && response.summary).toContain("<read-files>\n/Users/alice/notes.md\n</read-files>");
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]!.authorization).toBe("Bearer test-key-from-stdin");
    // 带着长度预算（compaction-settings.ts 的 leadCompactionInstructions）。
    expect(JSON.stringify(model.seen[0]!.body.messages)).toContain("8000 字");
    expect(pid).toEqual(expect.any(Number));
    expect(lines[0]).toMatch(/^\[sched\] job\.start id=\d+ kind=idle-compact label=idle_compact_t1 pid=\d+ io=(utility|default)$/);
    expect(lines[1]).toMatch(/^\[sched\] job\.end id=\d+ kind=idle-compact label=idle_compact_t1 pid=\d+ ms=\d+ exit=0$/);
    // 日志里没有凭据和对话原文。
    expect(lines.join("\n")).not.toMatch(/test-key|李雷/);
  }, 60_000);

  it("reports a bad request and a stopped child as failures, not as summaries", async () => {
    const bad = await runIdleCompact({ version: 2 } as never);
    expect(bad).toEqual({ ok: false, error: "bad request" });
    const controller = new AbortController();
    const slow = summarizeInChild(request("http://127.0.0.1:9/v1"), { id: "idle_compact_t2", timeoutMs: 60_000, signal: controller.signal, program: { command: "/bin/sleep", args: ["30"] } });
    controller.abort();
    expect((await slow).response).toEqual({ ok: false, error: "cancelled" });
    const timedOut = await summarizeInChild(request("http://127.0.0.1:9/v1"), { id: "idle_compact_t3", timeoutMs: 100, program: { command: "/bin/sleep", args: ["30"] } });
    expect(timedOut.response).toEqual({ ok: false, error: "timed out after 100ms" });
  }, 30_000);
});

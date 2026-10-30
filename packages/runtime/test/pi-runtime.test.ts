import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPiFailure, PiRuntime } from "../src/pi.js";
import { createPiEventMapper } from "../src/pi-events.js";
import type { RuntimeEvent, RuntimeEventInput, RuntimeHandle } from "../src/types.js";
import { packageSource } from "@pi-lead-child/core";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_PI = resolve("packages/runtime/testing/fake-pi.ts");
// 工单 13 的用例启动的 pi 和临时目录。测试中途失败时，afterEach 照样停止 pi 并删除目录。
const handles: RuntimeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.interrupt("test cleanup");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("Pi runtime adapter", () => {
  it("rejects a missing extension before spawning Pi", async () => {
    const runtime = new PiRuntime({
      ticketToolsExtension: packageSource("engine", "extension", "missing-tools.ts"),
    });

    await expect(runtime.start({
      itemId: 1,
      runId: 6,
      role: "executor",
      purpose: "execution",
      prompt: "do it",
      workdir: process.cwd(),
      env: {},
    })).rejects.toThrow(/Pi extension path does not exist/);
  });

  // 工单 #102：pi 的 message.usage 是一次 API 调用的用量。旧映射按 cumulative 报，ingest 只记下最大的一次调用。
  it("reports each assistant message's usage as a delta", () => {
    const events: RuntimeEventInput[] = [];
    const map = createPiEventMapper({
      runId: 7, runtime: "pi", model: null, emit: (event) => events.push(event), settle: () => {},
    });
    const assistant = (id: string, totalTokens: number) => ({
      type: "message_end",
      message: { id, role: "assistant", content: [], usage: { input: totalTokens, output: 0, totalTokens, cost: { total: 0.001 } } },
    });
    map({ type: "agent_start" });
    map(assistant("m1", 59_152));
    map(assistant("m2", 41_950));

    expect(events.filter((event) => event.type === "usage.updated")).toEqual([
      expect.objectContaining({ mode: "delta", totalTokens: 59_152 }),
      expect.objectContaining({ mode: "delta", totalTokens: 41_950 }),
    ]);
  });

  it("normalizes session, message, usage, tool, and terminal events", async () => {
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI] });
    const handle = await runtime.start({
      itemId: 1,
      runId: 7,
      role: "executor",
      purpose: "execution",
      prompt: "do it",
      workdir: process.cwd(),
      env: { FAKE_SCENARIO: "tool" },
    });
    const events: RuntimeEvent[] = [];
    for await (const event of handle.events) events.push(event);

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session.updated", "run.started", "tool.started", "tool.updated", "tool.completed",
      "message.completed", "usage.updated", "run.completed",
    ]));
    expect(events.every((event, index) => event.runId === 7 && event.seq === index + 1)).toBe(true);
    expect(events.find((event) => event.type === "session.updated")).toMatchObject({
      externalSessionId: "fake-session-1",
    });
    expect(events.find((event) => event.type === "usage.updated")).toMatchObject({
      mode: "delta", totalTokens: 150, costUsd: 0.003,
    });
    await handle.interrupt("test complete");
    expect((await handle.wait()).ok).toBe(true);
  });

  // 崩溃的样本（扩展缺失、Node 过旧、没有证据的崩溃）现在是共享合约测试的 D1 样本（工单 13）：
  // test/runtime-adapter-contract.test.ts 里 pi 的 failures。每个样本都断言只有一个 run.failed，wait() 的 ok 为 false。

  // 工单 13：pi 自己的错误文本（pi-coding-agent 1.1.0 的代码）。决策边界：pi 的规则和通用 provider 诊断的先后。
  it.each([
    ["Authentication failed for \"openai-codex\". Credentials may have expired or network is unavailable. "
      + "Run '/login openai-codex' to re-authenticate.", "auth_required"],
    ["No API key found for openai-codex.\n\nUse /login to log into a provider via OAuth or API key.", "auth_required"],
    ["fetch failed", "network_error"],
    // 通用的 provider 诊断在 pi 的网络规则之前：文本说了满载，就是满载。
    ["fetch failed after retries: Selected model is at capacity. Please try a different model.", "provider_overloaded"],
    // 安装类的规则在最前。
    ["Extension path does not exist: /repo/x.ts (No API key found for openai)", "extension_missing"],
    ["the model refused the request shape", "unknown"],
  ])("classifies the pi text %j as %s", (message, code) => {
    expect(classifyPiFailure({ errorCode: "llm_error", message }).code).toBe(code);
  });

  // 工单 #93 的审查：pi 的分类读 stderr，stderr 里的堆栈带行号。402 只在带上下文时算数，
  // 否则一个崩溃的行号就会把 pi 的 profile 挂起。
  it.each([
    ["TypeError: turn is undefined\n    at runTurn (/opt/pi/dist/index.js:402:17)", "unknown"],
    ["unexpected status 402 Payment Required: Payment Required", "out_of_credits"],
    ["auth error: 402, auth error code: deactivated_workspace", "account_deactivated"],
  ])("classifies the pi stderr %j as %s", (stderr, code) => {
    expect(classifyPiFailure({ errorCode: "process_exit", message: "pi exited with code 1", stderr }).code).toBe(code);
  });

  // 工单 13：pi 自己重试满载这类错误（agent_end 带 willRetry=true）。adapter 等 pi 的最后结论。
  describe("an LLM error that pi retries by itself", () => {
    async function drain(scenario: string): Promise<RuntimeEvent[]> {
      const dir = tempDir("plc-pi-retry-");
      const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI], killGraceMs: 200 });
      const handle = await runtime.start({
        itemId: 1, runId: 12, role: "executor", purpose: "execution", prompt: "work",
        workdir: process.cwd(), sessionDir: dir, env: { FAKE_SCENARIO: scenario },
      });
      handles.push(handle);
      const events: RuntimeEvent[] = [];
      for await (const event of handle.events) events.push(event);
      return events;
    }

    it("is the same run when the retry succeeds: one run.started, no error message, one run.completed", async () => {
      const events = await drain("retry_recovers");
      expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "message.completed" && event.stopReason === "error")).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime.stderr", text: expect.stringContaining("pi retries after an LLM error: Selected model is at capacity"),
      }));
      expect(events.filter((event) => event.type === "run.completed" || event.type === "run.failed"))
        .toEqual([expect.objectContaining({ type: "run.completed" })]);
    });

    it("fails with the last error when the retry never starts", async () => {
      const events = await drain("retry_abandoned");
      expect(events.at(-1)).toMatchObject({
        type: "run.failed", errorCode: "llm_error",
        failure: { scope: "attempt", retry: "backoff", needs: "none", code: "provider_overloaded" },
      });
    });
  });

  // 2026-10-15：Lead 按任务选 effort。pi 的控制是 --thinking（1.1.0 的 --help：off … max）。
  it("passes the chosen thinking level", async () => {
    const dir = tempDir("plc-pi-effort-");
    const capture = join(dir, "capture.json");
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI], env: { FAKE_PI_CAPTURE: capture }, killGraceMs: 200 });
    const handle = await runtime.start({
      itemId: 1, runId: 14, role: "executor", purpose: "execution", prompt: "go", model: "openai/gpt-6.1-sol", effort: "high",
      workdir: process.cwd(), sessionDir: dir, env: {},
    });
    handles.push(handle);
    for await (const _event of handle.events) { /* drain */ }
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 6))
      .toEqual(["--provider", "openai", "--model", "gpt-6.1-sol", "--thinking", "high"]);
  });

  // 2026-10-20：pi 也能当核查员。核查员不能改文件（pi 1.1.0 的 docs/cli.md）。2026-10-28（lead-tools-and-routing spec D15）：
  // 核查员留着 bash，沙箱扩展把它换成沙箱里的，能装依赖、能跑测试。执行者照常用缺省的工具。
  it("gives a reviewer the read tools and the sandboxed bash, no edit tools, and leaves an executor's tools alone", async () => {
    const dir = tempDir("plc-pi-reviewer-");
    const capture = join(dir, "capture.json");
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI], env: { FAKE_PI_CAPTURE: capture }, killGraceMs: 200 });
    const launch = async (role: "executor" | "reviewer", runId: number): Promise<string[]> => {
      const handle = await runtime.start({
        itemId: 1, runId, role, purpose: role === "reviewer" ? "review" : "execution", prompt: "go",
        workdir: process.cwd(), sessionDir: dir, env: {},
      });
      handles.push(handle);
      for await (const _event of handle.events) { /* drain */ }
      return JSON.parse(readFileSync(capture, "utf8")).args as string[];
    };
    const reviewer = await launch("reviewer", 16);
    expect(reviewer.slice(reviewer.indexOf("--tools"), reviewer.indexOf("--tools") + 4))
      .toEqual(["--tools", "+grep,+find,+ls", "--exclude-tools", "powershell,edit,write,codemode,mcp__*"]);
    // 回归（2026-10-21 审查 M1）：--tools 不去掉 MCP 工具，用户 pi 配置里的 MCP 服务器和自己装的扩展照样能写外部系统。
    // --no-mcp 不连 MCP 服务器；-ne 不加载发现的、配置的扩展，显式 -e 的 plc 扩展照样加载。
    expect(reviewer).toContain("--no-mcp");
    expect(reviewer).toContain("-ne");
    expect(reviewer.filter((arg, i) => reviewer[i - 1] === "-e")).toHaveLength(4);
    const executor = await launch("executor", 17);
    expect(executor).not.toContain("--tools");
    expect(executor).not.toContain("--exclude-tools");
    expect(executor).not.toContain("--no-mcp");
    expect(executor).not.toContain("-ne");
    // PLC 内置的 skill（child-skills.ts）只给执行 agent：--skill 指向 skills 目录，pi 递归找里面的 SKILL.md。
    expect(executor[executor.indexOf("--skill") + 1]).toBe(join(packageSource("engine", "child-skills", "executor"), "skills"));
    expect(reviewer).not.toContain("--skill");
  });

  // 内置的 SoL-Pi：执行器入口和 ticket/web 工具一样用 -e 加载。开哪些机制由它自己按 PLC_SOL_PI 决定。
  it("loads the built-in SoL-Pi entry with the other extensions", async () => {
    const dir = tempDir("plc-pi-sol-pi-");
    const capture = join(dir, "capture.json");
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI], env: { FAKE_PI_CAPTURE: capture }, killGraceMs: 200 });
    const handle = await runtime.start({
      itemId: 1, runId: 15, role: "executor", purpose: "execution", prompt: "go", workdir: process.cwd(), sessionDir: dir, env: {},
    });
    handles.push(handle);
    for await (const _event of handle.events) { /* drain */ }
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    const extensions = args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));
    expect(extensions).toEqual([
      packageSource("engine", "extension", "ticket-tools.ts"),
      packageSource("engine", "extension", "web-tools.ts"),
      packageSource("engine", "extension", "sol-pi-executor.ts"),
      // 沙箱扩展（lead-tools-and-routing spec D2）：bash 在沙箱里跑，edit、write 只能写工作目录。
      packageSource("engine", "extension", "sandbox.ts"),
    ]);
    expect(runtime.profile.extensions).toEqual(extensions);
  });

  // 工单 13：pi 按 session 文件 resume。合适的文件不存在时，pi 开一个新 session，并留下一条诊断。
  describe("resuming a session", () => {
    async function resume(header: Record<string, unknown> | null, options: { forkSession?: boolean } = {}) {
      const dir = tempDir("plc-pi-resume-");
      const file = join(dir, "2026-10-11T00-00-00-000Z_session-9.jsonl");
      if (header) writeFileSync(file, `${JSON.stringify(header)}\n`);
      const capture = join(dir, "capture.json");
      const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI], env: { FAKE_PI_CAPTURE: capture }, killGraceMs: 200 });
      const handle = await runtime.start({
        itemId: 1, runId: 13, role: "executor", purpose: "execution", prompt: "go on", resumeSessionId: "session-9",
        workdir: process.cwd(), sessionDir: dir, env: {}, ...options,
      });
      handles.push(handle);
      const events: RuntimeEvent[] = [];
      for await (const event of handle.events) events.push(event);
      const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
      return { args, events, file };
    }

    it.each([
      ["there is no session file", null],
      ["the session's working directory no longer exists", { type: "session", version: 3, id: "session-9", cwd: "/definitely/gone" }],
      ["the file belongs to another session", { type: "session", version: 3, id: "session-8", cwd: process.cwd() }],
    ])("starts a new session when %s", async (_case, header) => {
      const { args, events } = await resume(header);
      expect(args).not.toContain("--session");
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime.stderr", text: expect.stringContaining("pi session session-9 has no usable session file"),
      }));
    });

    it("opens the session file whose header names the session", async () => {
      const { args } = await resume({ type: "session", version: 3, id: "session-9", cwd: process.cwd() });
      expect(args[args.indexOf("--session") + 1]).toMatch(/_session-9\.jsonl$/);
    });

    // 工单对话不能写进一个暂停的 Run 的 session：恢复控制之后还要续接它。pi 用 --fork 在副本上开始，
    // 新 session 有自己的 id，原文件不变（2026-10-13 用真实的 pi 1.1.0 核实）。
    it("forks the session file into a new session when the request asks for a fork", async () => {
      const header = { type: "session", version: 3, id: "session-9", cwd: process.cwd() };
      const { args, events, file } = await resume(header, { forkSession: true });
      expect(args[args.indexOf("--fork") + 1]).toBe(file);
      expect(args).not.toContain("--session");
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.updated", externalSessionId: expect.stringMatching(/^session-9-fork-/),
      }));
      expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(header)}\n`);
    });
  });

  it("preserves runtime stderr in the normalized process failure", async () => {
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [FAKE_PI] });
    const handle = await runtime.start({
      itemId: 1, runId: 9, role: "executor", purpose: "execution",
      prompt: "crash", workdir: process.cwd(),
      env: { FAKE_SCENARIO: "crash_stderr" },
    });
    const events: RuntimeEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const failed = events.find((event) => event.type === "run.failed");
    expect(failed).toMatchObject({ type: "run.failed", errorCode: "process_exit" });
    expect((failed as Extract<RuntimeEvent, { type: "run.failed" }>).error)
      .toContain("zlib.createZstdDecompress");
  });
});

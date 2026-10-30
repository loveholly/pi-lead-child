import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { codexChildSkillListing, defaultChildSkillsRoot } from "../src/child-skills.js";
import { CodexRuntime, classifyCodexFailure } from "../src/codex.js";
import type {
  RuntimeEvent,
  RuntimeHandle,
  RuntimeStartRequest,
} from "../src/types.js";

const FAKE_BIN = process.execPath;
const FAKE_SCRIPT = resolve("packages/runtime/testing/fake-codex.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = tempDir("plc-codex-runtime-");
  tempDirs.push(dir);
  return join(dir, name);
}

function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    itemId: 10,
    runId: 42,
    role: "executor",
    purpose: "execution",
    prompt: "Implement the ticket",
    workdir: process.cwd(),
    env: {},
    ...overrides,
  };
}

function runtime(
  scenario: string,
  options: { env?: Record<string, string>; killGraceMs?: number } = {},
): CodexRuntime {
  return new CodexRuntime({
    bin: FAKE_BIN,
    prefixArgs: ["--import=tsx", FAKE_SCRIPT],
    env: { FAKE_CODEX_SCENARIO: scenario, ...options.env },
    killGraceMs: options.killGraceMs,
  });
}

async function collect(handle: RuntimeHandle): Promise<{ events: RuntimeEvent[]; exit: Awaited<ReturnType<RuntimeHandle["wait"]>> }> {
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return { events, exit: await handle.wait() };
}

function terminalEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.filter((event) => event.type === "run.completed" || event.type === "run.failed");
}

describe("CodexRuntime", () => {
  it("advertises the Codex runtime contract", () => {
    const adapter = runtime("happy");
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities).toEqual({
      streaming: true,
      steering: false,
      resume: true,
      interrupt: true,
      approvals: false,
      mcp: true,
      executableReadOnlyReview: true,
    });
  });

  it("builds executor argv with model, environment, and the plc MCP server", async () => {
    const capture = tempPath("capture.json");
    const adapter = runtime("happy", {
      env: { FAKE_CODEX_CAPTURE: capture, FAKE_BASE_ENV: "base" },
    });
    const handle = await adapter.start(request({
      model: "openai/gpt-test",
      env: { FAKE_REQUEST_ENV: "request" },
      mcpServer: {
        command: "/opt/plc/mcp server",
        args: ["--stdio", "argument with spaces"],
        env: { ZED: "last", MCP_ONLY: "secret" },
      },
    }));

    const { events, exit } = await collect(handle);
    const captured = JSON.parse(readFileSync(capture, "utf8"));
    expect(exit.ok).toBe(true);
    expect(captured.args).toEqual([
      "exec",
      "--json",
      "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"',
      "--skip-git-repo-check",
      "--cd", process.cwd(),
      "--model", "gpt-test",
      "-c", 'mcp_servers.plc.command="/opt/plc/mcp server"',
      "-c", 'mcp_servers.plc.args=["--stdio","argument with spaces"]',
      "-c", "mcp_servers.plc.required=true",
      "-c", 'mcp_servers.plc.default_tools_approval_mode="approve"',
      // 工单 10：MCP 服务器的变量值不进 argv。值放在 Codex 进程的环境里，argv 只点名，Codex 按名字转发。
      "-c", 'mcp_servers.plc.env_vars=["MCP_ONLY","ZED"]',
      // PLC 内置的 skill 列在新会话的提示词末尾（child-skills.ts）：Codex 没有每次运行加 skill 的参数。
      `Implement the ticket\n\n${codexChildSkillListing(defaultChildSkillsRoot(), "executor")}`,
    ]);
    expect(events[0]).toMatchObject({ type: "run.started", runtime: "codex", model: "gpt-test" });
    expect(captured.env).toEqual({ base: "base", request: "request", mcpOnly: "secret" });
  });

  // 2026-10-15：Lead 按任务选 effort。Codex 的控制是配置项 model_reasoning_effort；没有选模型时不传 --model。
  it("passes the chosen reasoning effort and no model when none is chosen", async () => {
    const capture = tempPath("effort.json");
    const handle = await runtime("happy", { env: { FAKE_CODEX_CAPTURE: capture } }).start(request({ effort: "high" }));
    await collect(handle);
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    expect(args).not.toContain("--model");
    expect(args[args.indexOf('model_reasoning_effort="high"') - 1]).toBe("-c");
  });

  // 工单 11（2026-10-11 的用户决定）：Codex 照常读 CODEX_HOME/config.toml。用户的 MCP 服务器、hooks、插件和
  // apps 都加载，和用户独立运行时一样。按 codex-cli 0.153.3 的 --help 和 `features list` 核实，能关掉它们的参数有：
  // --ignore-user-config、--disable <feature>、-c features.<name>=false、-c mcp_servers.<名字>.enabled=false。
  it("disables none of the user's MCP servers, hooks, plugins or apps, and keeps plc required", async () => {
    const capture = tempPath("user-config.json");
    const handle = await runtime("happy", { env: { FAKE_CODEX_CAPTURE: capture } }).start(request({
      mcpServer: { command: "/opt/plc/mcp", args: [], env: { PLC_AGENT_TOOL_TOKEN: "t11-token" } },
    }));
    await collect(handle);
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    const disabling = args.filter((arg) => ["--ignore-user-config", "--ignore-rules", "--disable"].includes(arg)
      || arg.startsWith("features.") || /\.enabled\s*=\s*false$/.test(arg));
    expect(disabling).toEqual([]);
    expect(args).toContain("mcp_servers.plc.required=true");
  });

  it("rejects a non-OpenAI provider before spawning Codex", async () => {
    await expect(runtime("happy").start(request({ model: "anthropic/claude-opus" })))
      .rejects.toThrow(/runtime 'codex' cannot use model 'anthropic\/claude-opus'/);
  });

  it("uses a read-only sandbox for reviewers", async () => {
    const capture = tempPath("reviewer.json");
    const handle = await runtime("happy", { env: { FAKE_CODEX_CAPTURE: capture } }).start(request({
      role: "reviewer",
      purpose: "review",
      prompt: "Review only",
    }));

    await collect(handle);
    const captured = JSON.parse(readFileSync(capture, "utf8"));
    expect(captured.args).toContain("read-only");
    expect(captured.args).not.toContain("workspace-write");
    // 核查员没有内置的 skill：提示词原样送到 Codex。
    expect(captured.args.at(-1)).toBe("Review only");
  });

  it("resumes a session while preserving JSON and execution flags", async () => {
    const capture = tempPath("resume.json");
    const handle = await runtime("happy", { env: { FAKE_CODEX_CAPTURE: capture } }).start(request({
      resumeSessionId: "thread-existing",
    }));

    await collect(handle);
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("--cd");
    expect(args.slice(-3)).toEqual(["resume", "thread-existing", "Implement the ticket"]);
  });

  // 工单对话不能写进一个暂停的 Run 的 session（恢复控制之后还要续接它）：codex exec fork 在副本上开一个新 thread
  // （codex-cli 0.162.1 的 --help；不存在的 id 报 "no rollout found"）。session 是新 thread，不是原来那个。
  it("forks a session into a new thread when the request asks for a fork", async () => {
    const capture = tempPath("fork.json");
    const handle = await runtime("happy", { env: { FAKE_CODEX_CAPTURE: capture } }).start(request({
      resumeSessionId: "thread-existing",
      forkSession: true,
    }));

    const { events, exit } = await collect(handle);
    const args: string[] = JSON.parse(readFileSync(capture, "utf8")).args;
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args.slice(-3)).toEqual(["fork", "thread-existing", "Implement the ticket"]);
    expect(events.filter((event) => event.type === "session.updated")).toEqual([
      expect.objectContaining({ externalSessionId: "codex-thread-1" }),
    ]);
    expect(exit.externalSessionId).toBe("codex-thread-1");
  });

  it("normalizes session, assistant message, cumulative usage, and successful exit", async () => {
    const handle = await runtime("happy").start(request({ model: "gpt-test" }));
    const { events, exit } = await collect(handle);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "session.updated",
      "message.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(events[0]).toMatchObject({ runtime: "codex", model: "gpt-test" });
    expect(events[1]).toMatchObject({ externalSessionId: "codex-thread-1" });
    expect(events[2]).toMatchObject({
      messageId: "message-1",
      role: "assistant",
      text: "work complete",
    });
    expect(events[3]).toMatchObject({
      mode: "cumulative",
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      costUsd: null,
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((event) => event.runId === 42)).toBe(true);
    expect(events.every((event) => !Number.isNaN(Date.parse(event.occurredAt)))).toBe(true);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(exit).toEqual({
      ok: true,
      exitCode: 0,
      signal: null,
      externalSessionId: "codex-thread-1",
      errorCode: null,
      errorMessage: null,
    });
  });

  it("normalizes command and MCP tool lifecycle events", async () => {
    const { events, exit } = await collect(await runtime("tools").start(request()));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.started",
        callId: "command-1",
        name: "command_execution",
        args: { command: "printf ok", cwd: "/tmp/project" },
      }),
      expect.objectContaining({
        type: "tool.completed",
        callId: "command-1",
        name: "command_execution",
        result: { status: "completed", exitCode: 0, output: "ok" },
      }),
      expect.objectContaining({
        type: "tool.started",
        callId: "mcp-1",
        name: "plc.ticket_update",
        args: { status: "review" },
      }),
      expect.objectContaining({
        type: "tool.completed",
        callId: "mcp-1",
        name: "plc.ticket_update",
        result: { content: [{ type: "text", text: "updated" }] },
      }),
      expect.objectContaining({
        type: "tool.failed",
        callId: "mcp-2",
        name: "plc.request_approval",
        error: "denied",
      }),
    ]));
    expect(exit.ok).toBe(true);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it("emits stderr without disrupting a successful run", async () => {
    const { events, exit } = await collect(await runtime("stderr").start(request()));
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime.stderr",
      text: "codex warning\n",
    }));
    expect(exit.ok).toBe(true);
  });

  it("tolerates a bounded number of malformed JSONL lines", async () => {
    const { events, exit } = await collect(await runtime("malformed-tolerated").start(request()));
    const parseWarnings = events.filter(
      (event) => event.type === "runtime.stderr" && event.text.includes("malformed Codex JSONL"),
    );
    expect(parseWarnings).toHaveLength(2);
    expect(exit.ok).toBe(true);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "run.completed", exitCode: 0 }),
    ]);
  });

  it("fails and terminates a process after excessive malformed output", async () => {
    const { events, exit } = await collect(await runtime("malformed-excess", { killGraceMs: 20 }).start(request()));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({
        type: "run.failed",
        errorCode: "malformed_output",
      }),
    ]);
    expect(exit.ok).toBe(false);
    expect(exit.errorCode).toBe("malformed_output");
  });

  it.each([
    ["error", "remote_error", "remote exploded"],
    ["turn-failed", "turn_rejected", "turn rejected"],
  ])("normalizes native %s failures exactly once", async (scenario, errorCode, errorMessage) => {
    const { events, exit } = await collect(await runtime(scenario).start(request()));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "run.failed", errorCode, error: errorMessage }),
    ]);
    expect(exit).toMatchObject({ ok: false, errorCode, errorMessage });
  });

  it("turns a non-zero process exit into a terminal runtime failure", async () => {
    const { events, exit } = await collect(await runtime("nonzero").start(request()));
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime.stderr",
      text: "fatal from codex\n",
    }));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "run.failed", exitCode: 7, errorCode: "process_exit" }),
    ]);
    expect(exit).toMatchObject({ ok: false, exitCode: 7, signal: null, errorCode: "process_exit" });
  });

  // 工单 #66：Codex 的会话记录（rollout）不在了。Codex 只在 stderr 说明原因，以 1 退出。
  // 旧代码把它归为 unknown，错误文本只有 "Codex exited with code 1"。
  it("types a resume of a missing thread as session_not_found and says why", async () => {
    const thread = "01a00f50-51ac-7581-8781-39c9e28b1ede";
    const { events, exit } = await collect(await runtime("resume-missing").start(request({ resumeSessionId: thread })));
    expect(terminalEvents(events)).toEqual([expect.objectContaining({
      type: "run.failed",
      exitCode: 1,
      error: expect.stringContaining(`no rollout found for thread id ${thread}`),
      failure: expect.objectContaining({ scope: "attempt", retry: "never", needs: "none", code: "session_not_found" }),
    })]);
    expect(exit).toMatchObject({ ok: false, exitCode: 1 });
  });

  // exec fork 一个不存在的 thread：文本相同，只是 resume 换成 fork（codex-cli 0.162.1）。
  it("types a fork of a missing thread as session_not_found", async () => {
    const thread = "01a00f50-51ac-7581-8781-39c9e28b1ede";
    const { events } = await collect(await runtime("resume-missing").start(
      request({ resumeSessionId: thread, forkSession: true }),
    ));
    expect(terminalEvents(events)).toEqual([expect.objectContaining({
      type: "run.failed",
      error: expect.stringContaining(`thread/fork failed: no rollout found for thread id ${thread}`),
      failure: expect.objectContaining({ code: "session_not_found" }),
    })]);
  });

  it("reports spawn failures through events and wait", async () => {
    const adapter = new CodexRuntime({ bin: "/definitely/missing/codex" });
    const { events, exit } = await collect(await adapter.start(request()));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "run.failed", exitCode: null, errorCode: "spawn_error" }),
    ]);
    expect(exit).toMatchObject({ ok: false, exitCode: null, signal: null, errorCode: "spawn_error" });
  });

  // 类型化失败的样本（6 个历史失败、可执行文件缺失、plc 没有就绪、无法识别的退出）现在是
  // 共享合约测试的 D1 样本（工单 13）：test/runtime-adapter-contract.test.ts 里 codex 的 failures。

  // 工单 #93：账号所在的工作区被停用。原文取自 Run #113（2026-10-19）。停用时，模型目录的刷新也在 stderr 里报 402。
  const DEACTIVATED_WORKSPACE = "Reconnecting... 2/5 (unexpected status 402 Payment Required: Payment Required, "
    + "url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: a4ce9692089f3e2b-SIN, auth error: 402, "
    + "auth error code: deactivated_workspace)";
  const MODELS_REFRESH_402 = "ERROR codex_models_manager::manager: failed to refresh available models: "
    + "unexpected status 402 Payment Required: Payment Required\n";

  it("classifies the deactivated workspace in the terminal error as an account failure that needs a login", () => {
    const failure = classifyCodexFailure({
      errorCode: "codex_error", message: DEACTIVATED_WORKSPACE, stderr: MODELS_REFRESH_402,
    });
    expect(failure).toMatchObject({ code: "account_deactivated", scope: "account", retry: "never", needs: "login" });
  });

  // stderr 只作证据（classifyCodexFailure 的规则）。进程因为别的原因退出时，stderr 里的 402 说明不了终止原因。
  it("does not classify a process exit by a 402 or a deactivated workspace in stderr", () => {
    const failure = classifyCodexFailure({
      errorCode: "process_exit", message: "Codex exited with code 1",
      stderr: `${MODELS_REFRESH_402}auth error code: deactivated_workspace\n`,
    });
    expect(failure.code).toBe("unknown");
    expect(failure.evidence).toContain("deactivated_workspace");
  });

  it("interrupts with SIGTERM and escalates to SIGKILL after the grace period", async () => {
    const ready = tempPath("interrupt-ready");
    const signals = tempPath("signals.log");
    const adapter = runtime("interrupt", {
      killGraceMs: 30,
      env: { FAKE_CODEX_READY_FILE: ready, FAKE_CODEX_SIGNAL_FILE: signals },
    });
    const handle = await adapter.start(request());
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2_000 });

    await handle.interrupt("operator requested stop");
    const { events, exit } = await collect(handle);

    expect(readFileSync(signals, "utf8")).toContain("SIGTERM");
    expect(exit).toMatchObject({
      ok: false,
      signal: "SIGKILL",
      errorCode: "interrupted",
      errorMessage: "operator requested stop",
    });
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "run.failed", errorCode: "interrupted" }),
    ]);
  });
});

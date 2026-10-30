import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeExit,
  RuntimeStartRequest,
} from "../src/types.js";
import { childSkillsDir, defaultChildSkillsRoot } from "../src/child-skills.js";

const fakeBin = process.execPath;
const fakeScript = resolve("packages/runtime/testing/fake-claude.ts");
const fakePrefixArgs = ["--import", "tsx", fakeScript];
const tempDirs: string[] = [];

interface ClaudeRuntimeOptions {
  bin?: string;
  prefixArgs?: string[];
  env?: Record<string, string>;
  killGraceMs?: number;
}

interface ClaudeRuntimeConstructor {
  new(options?: ClaudeRuntimeOptions): AgentRuntime;
}

async function loadClaudeRuntime(): Promise<ClaudeRuntimeConstructor> {
  const module = await import("../src/claude.js");
  return module.ClaudeRuntime;
}

function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    itemId: 11,
    runId: 22,
    role: "executor",
    purpose: "execution",
    prompt: "do work",
    workdir: process.cwd(),
    env: {},
    ...overrides,
  };
}

async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function runFake(
  scenario: string,
  requestOverrides: Partial<RuntimeStartRequest> = {},
  runtimeOptions: ClaudeRuntimeOptions = {},
): Promise<{ runtime: AgentRuntime; events: RuntimeEvent[]; exit: RuntimeExit }> {
  const ClaudeRuntime = await loadClaudeRuntime();
  const runtime = new ClaudeRuntime({
    bin: fakeBin,
    prefixArgs: fakePrefixArgs,
    env: { FAKE_CLAUDE_SCENARIO: scenario, ...runtimeOptions.env },
    killGraceMs: runtimeOptions.killGraceMs,
  });
  const handle = await runtime.start(request(requestOverrides));
  const eventsPromise = collect(handle.events);
  const exit = await handle.wait();
  return { runtime, events: await eventsPromise, exit };
}

function completedText(events: RuntimeEvent[]): string {
  const event = events.find((candidate) => candidate.type === "message.completed");
  if (!event || event.type !== "message.completed") throw new Error("missing assistant message");
  return event.text;
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(5);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// 工单 11（2026-10-11 的用户决定）：executor 能用到用户独立运行 Claude Code 时能用的一切。
// 用户的 MCP 服务器、hooks、插件、CLAUDE.md 和用户设置都照常加载，plc 经 --mcp-config 叠加在上面。
// fake CLI 按 Claude Code 2.1.258 的代码模拟两个 flag：--safe-mode 丢掉 plc，--strict-mcp-config 丢掉用户的服务器。
describe("ClaudeRuntime and the user's own configuration", () => {
  const PLC = { command: "node", args: ["server.js"], env: { PLC_AGENT_TOOL_TOKEN: "t11-token" } };
  const ISOLATING_FLAGS = ["--safe-mode", "--strict-mcp-config", "--setting-sources", "--bare", "--restricted"];
  const SKIPPING_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"];

  // 用户自己的 MCP 服务器，写在用户范围的配置里（CLAUDE_CONFIG_DIR/.claude.json）。
  async function userConfigDir(): Promise<string> {
    const dir = tempDir("plc-claude-user-config-");
    tempDirs.push(dir);
    await writeFile(join(dir, ".claude.json"), JSON.stringify({
      mcpServers: { design: { type: "http", url: "https://mcp.example.test" } },
    }));
    return dir;
  }

  async function inspect(overrides: Partial<RuntimeStartRequest>) {
    const { events } = await runFake("inspect", overrides, { env: { CLAUDE_CONFIG_DIR: await userConfigDir() } });
    return JSON.parse(completedText(events));
  }

  // 回归：旧代码给 executor 加了 --safe-mode 和 --strict-mcp-config。
  // Claude Code 2.1.258 在 safe mode 下丢掉 --mcp-config 里的 plc，所以 plc 工具通道从来没有连上。
  it("loads the executor with the user's MCP servers, and plc on top", async () => {
    const inspection = await inspect({ mcpServer: PLC });
    expect(inspection.argv.filter((arg: string) => ISOLATING_FLAGS.includes(arg))).toEqual([]);
    expect(inspection.mcpServers).toEqual([
      { name: "design", status: "connected" },
      { name: "plc", status: "connected" },
    ]);
    expect(inspection.prompt).toBe("do work");
  });

  it("grants the executor the verification commands and plc on top of the user's settings, with no skipping flag", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const inspection = await inspect({ mcpServer: PLC });
    const profile = new ClaudeRuntime({ bin: fakeBin }).profile!;
    expect(inspection.allowedTools).toEqual([...profile.allowedTools, "mcp__plc__*"]);
    expect(profile.allowedTools).toEqual(expect.arrayContaining([
      "Bash(npm test *)", "Bash(npm run typecheck*)", "Bash(npm run lint*)", "Bash(git status)", "Bash(git diff --check)",
    ]));
    // auto（用户 2026-10-28：「不要啥都让我审批」）：-p 模式下没有人回答许可请求，由 Claude Code 自己判断。
    expect(inspection.argv[inspection.argv.indexOf("--permission-mode") + 1]).toBe("auto");
    // 执行者能在自己的分支上提交、推送。
    expect(profile.allowedTools).toEqual(expect.arrayContaining(["Bash(git push *)", "Bash(rtk git push *)"]));
    expect(inspection.argv.filter((arg: string) => SKIPPING_FLAGS.includes(arg))).toEqual([]);
  });

  // lead-tools-and-routing spec D2、D15：命令在 Claude Code 自带的沙箱里跑，不用审批，不许绕开沙箱。2026-10-28 起能写整个 home
  // 和工作目录，只挡会在沙箱外执行的地方；读不到私钥。
  it("runs the executor's commands in Claude Code's sandbox: home and the workdir, no private keys", async () => {
    const inspection = await inspect({ mcpServer: PLC });
    const settings = JSON.parse(inspection.argv[inspection.argv.indexOf("--settings") + 1]) as {
      sandbox: { enabled: boolean; autoAllowBashIfSandboxed: boolean; allowUnsandboxedCommands: boolean;
        filesystem: { allowWrite: string[]; denyRead: string[] }; network: { allowedDomains: string[] } };
    };
    expect(settings.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([process.cwd(), homedir()]));
    expect(settings.sandbox.filesystem.denyRead.some((path) => path.endsWith("/.ssh/id_*"))).toBe(true);
    expect(settings.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    // 设置里没有密钥：只有路径和域名，可以放在命令行上。
    expect(JSON.stringify(settings)).not.toMatch(/token|secret/i);
  });

  // 2026-10-21，Run #118：用户全局的 rtk hook（`rtk hook claude`）把命令改写成 `rtk …`，Claude Code 按改写后的命令判权限。
  // 改写后，上面的 Bash(git status) 等规则匹配不上，-p 模式不能问，所以拒绝。
  // Run #118 有 90 次工具调用，26 次失败，其中 22 次是权限拒绝。右边是 rtk 0.37.1 的改写（用 rtk hook claude 核对，写死在这里）。
  const RTK_REWRITES: ReadonlyArray<readonly [string, string]> = [
    ["npm test", "npm test"],
    ["npm run test:unit", "rtk npm run test:unit"],
    ["npm run typecheck", "rtk npm run typecheck"],
    ["npm run lint", "rtk lint"],
    ["npm run lint -- --fix", "rtk lint -- --fix"],
    ["npm run lint:fix", "rtk npm run lint:fix"],
    ["npm run verify", "rtk npm run verify"],
    ["git status", "rtk git status"],
    ["git diff", "rtk git diff"],
    ["git diff --check", "rtk git diff --check"],
    ["git log", "rtk git log"],
    ["ls -la src", "rtk ls -la src"],
  ];

  // Claude Code 2.1.258 的 Bash 规则（claude.ts 的注释）：没有 * 时整条命令相等；"x *" 是 x 本身或 x 加空格开头；"x*" 是纯前缀。
  function allows(rules: readonly string[], command: string): boolean {
    return rules.some((rule) => {
      const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (pattern === undefined) return false;
      if (pattern.endsWith(" *")) {
        const base = pattern.slice(0, -2);
        return command === base || command.startsWith(`${base} `);
      }
      if (pattern.endsWith("*")) return command.startsWith(pattern.slice(0, -1));
      return command === pattern;
    });
  }

  it("grants the rtk rewrites of the verification commands and ls", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const rules = new ClaudeRuntime({ bin: fakeBin }).profile!.allowedTools;
    expect(RTK_REWRITES.filter(([, rewritten]) => !allows(rules, rewritten))).toEqual([]);
  });

  // rtk 的形式不能多给能力（2026-10-21 的独立审查，在本机 rtk 0.37.1 上核实）：
  // - rtk lint 把第一个参数当程序运行，只要它不以 - 开头、不含 / 和 .：`rtk lint sh -c …` 会执行命令。
  // - rtk grep 把多余的参数转给 ripgrep，装了 rg 时 --pre 对每个文件执行程序。
  // - rtk read 能一步读工作区以外的文件。内置的 Read 工具有工作区的限制。
  // - 还有原来的规则故意不给的：git 写文件的参数、npx、rtk 的任意命令代理。
  it("does not grant rtk commands that can run a program or read outside the workspace", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const rules = new ClaudeRuntime({ bin: fakeBin }).profile!.allowedTools;
    for (const command of [
      "rtk lint sh -c x", "rtk lint -- sh -c x", "rtk lint touch x",
      "rtk grep foo . --pre sh", "rtk grep -rn foo src",
      "rtk read ~/.ssh/id_rsa", "rtk read README.md",
      "rtk git diff --output=notes.txt", "rtk git log --output=notes.txt",
      "rtk npx some-package", "rtk proxy rm -rf build", "rtk curl https://example.test", "rtk npm install left-pad",
    ]) {
      expect(allows(rules, command), command).toBe(false);
    }
  });

  // 2026-10-28：沙箱里 Claude Code 仍要审批 git commit，执行者又要在自己的分支上提交、推送：明确放行 add、commit、push
  // （照样在沙箱里跑，git 的 hooks、config 写不了；推送经用户的 ssh-agent，读不到私钥）。用户：「推代码本身也没什么问题」。
  it("grants git add, commit and push, plain and rewritten by rtk", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const rules = new ClaudeRuntime({ bin: fakeBin }).profile!.allowedTools;
    for (const command of [
      "git add src/a.ts", "git commit -m x", "rtk git add .", "rtk git commit -m x",
      "git push", "rtk git push", "git push origin plc/item-1",
    ]) {
      expect(allows(rules, command), command).toBe(true);
    }
  });

  it("does not grant plc tools when there is no plc server", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const inspection = await inspect({});
    expect(inspection.allowedTools).toEqual(new ClaudeRuntime({ bin: fakeBin }).profile!.allowedTools);
    expect(inspection.prompt).toBe("do work");
  });

  // Claude Code 不能做可执行的只读 review（executableReadOnlyReview 为 false），这里只看 adapter 给的参数。
  // reviewer 要用 plc 提交结论（buildReviewerPrompt），所以不能用 --safe-mode。
  // 它不加载用户的 MCP 服务器：那些服务器的工具可能有写操作。内置工具只有 Read、Glob、Grep。
  it("keeps the reviewer without edit tools, in the sandbox, with plc as its only MCP server", async () => {
    const inspection = await inspect({ role: "reviewer", purpose: "review", prompt: "review only", mcpServer: PLC });
    expect(inspection.argv).not.toContain("--safe-mode");
    // 核查员在沙箱里能跑命令（lead-tools-and-routing spec D15），没有 Edit、Write。
    expect(inspection.argv[inspection.argv.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(inspection.argv[inspection.argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Bash");
    // 核查员没有内置的 skill。
    expect(inspection.argv).not.toContain("--plugin-dir");
    expect(inspection.mcpServers).toEqual([{ name: "plc", status: "connected" }]);
    expect(inspection.allowedTools).toEqual(["mcp__plc__*"]);
    expect(inspection.prompt).toBe("review only");
  });
});

// 工单 13：Claude Code 自己写的模型错误（2.1.258 二进制里的字符串）。通用的 provider 诊断认不出它们。
describe("classifyClaudeFailure on Claude Code's own model errors", () => {
  it.each([
    "There's an issue with the selected model (claude-fake-9). It may not exist or you may not have access to it. "
      + "Run /model to pick a different model.",
    "The model claude-fake-9 is not available on your bedrock deployment. Try switching to claude-fake-8, "
      + "or ask your admin to enable this model.",
  ])("types %j as an unsupported model", async (message) => {
    const { classifyClaudeFailure } = await import("../src/claude.js");
    expect(classifyClaudeFailure({ errorCode: "claude_result_error", message })).toMatchObject({
      scope: "runtime", retry: "other_runtime", needs: "config", code: "model_unsupported",
    });
  });
});

// 工单 #66 的 Run #71：Claude Code 按保留期删了旧会话的记录，--resume 立即失败。
// 旧代码把它归为 unknown，lead 收到一条「Run crashed」。
describe("a resumed Claude session that no longer exists", () => {
  it("types the failure as session_not_found", async () => {
    const store = tempDir("plc-claude-sessions-");
    tempDirs.push(store);
    const expired = "20fd5938-01a7-42ce-b4b4-bb1a98831c80";
    const { events, exit } = await runFake(
      "sessions", { resumeSessionId: expired }, { env: { FAKE_CLAUDE_SESSION_DIR: store } },
    );

    expect(events.filter((event) => event.type === "run.failed")).toEqual([expect.objectContaining({
      errorCode: "claude_error_during_execution",
      error: `No conversation found with session ID: ${expired}`,
      failure: expect.objectContaining({ scope: "attempt", retry: "never", needs: "none", code: "session_not_found" }),
    })]);
    expect(exit).toMatchObject({ ok: false, exitCode: 1 });
  });

  // 工单对话在一个暂停的 Run 的会话副本上回答（--fork-session）。原会话不存在时，Claude 报同一句话。
  it("types a fork of a missing session as session_not_found", async () => {
    const store = tempDir("plc-claude-sessions-");
    tempDirs.push(store);
    const expired = "20fd5938-01a7-42ce-b4b4-bb1a98831c80";
    const { events } = await runFake(
      "sessions", { resumeSessionId: expired, forkSession: true }, { env: { FAKE_CLAUDE_SESSION_DIR: store } },
    );

    expect(events.filter((event) => event.type === "run.failed")).toEqual([expect.objectContaining({
      error: `No conversation found with session ID: ${expired}`,
      failure: expect.objectContaining({ code: "session_not_found" }),
    })]);
  });
});

describe("ClaudeRuntime", () => {
  it("spawns an executor with model, resume, the plc MCP config, and merged environment", async () => {
    const { runtime, events, exit } = await runFake("inspect", {
      model: "claude-test",
      resumeSessionId: "resume-123",
      env: {
        CLAUDE_REQUEST_ENV: "request",
        CLAUDE_OVERRIDE_ENV: "request-wins",
      },
      mcpServer: {
        command: "node",
        args: ["server.js", "--stdio"],
        env: { MCP_TOKEN: "secret" },
      },
    }, {
      env: {
        CLAUDE_BASE_ENV: "base",
        CLAUDE_OVERRIDE_ENV: "base-loses",
      },
    });

    expect(runtime.id).toBe("claude");
    expect(runtime.capabilities).toEqual({
      streaming: true,
      steering: false,
      resume: true,
      interrupt: true,
      approvals: false,
      mcp: true,
      executableReadOnlyReview: true,
    });

    const inspection = JSON.parse(completedText(events));
    expect(inspection.argv).toEqual([
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", inspection.argv[inspection.argv.indexOf("--settings") + 1],
      // PLC 内置的 skill（child-skills.ts）：这次会话加载的插件，不装进用户的系统。
      "--plugin-dir", childSkillsDir(defaultChildSkillsRoot(), "executor"),
      // 工单 10：MCP 配置里有凭据，argv 只放配置文件的路径。
      "--mcp-config", inspection.mcpConfigPath,
      // 工单 11：校验命令和 plc 的工具，追加在用户自己的许可之上。
      "--allowedTools", [...runtime.profile!.allowedTools, "mcp__plc__*"].join(","),
      "--permission-mode", "auto",
      "--model", "claude-test",
      "--resume", "resume-123",
      "do work",
    ]);
    expect(inspection.mcpConfig).toEqual({
      mcpServers: {
        plc: {
          command: "node",
          args: ["server.js", "--stdio"],
          env: { MCP_TOKEN: "secret" },
          // 工单 05：plc 在会话开始前连接，初始化事件据此报告 plc 工具通道的状态。
          alwaysLoad: true,
        },
      },
    });
    expect(inspection.env).toEqual({
      CLAUDE_BASE_ENV: "base",
      CLAUDE_REQUEST_ENV: "request",
      CLAUDE_OVERRIDE_ENV: "request-wins",
    });
    expect(exit).toMatchObject({ ok: true, exitCode: 0, signal: null });
  });

  // 工单对话不能写进一个暂停的 Run 的 session（恢复控制之后还要续接它）：--fork-session 让 Claude Code
  // 在 resume 的历史上开一个新 session id（2.1.258 的 --help），原 session 不变。
  it("forks the resumed session into a new session id when the request asks for a fork", async () => {
    const { events, exit } = await runFake("inspect", { resumeSessionId: "resume-123", forkSession: true, prompt: "chat" });

    const inspection = JSON.parse(completedText(events));
    expect(inspection.argv.slice(-4)).toEqual(["--resume", "resume-123", "--fork-session", "chat"]);
    expect(exit.ok).toBe(true);
  });

  // 2026-10-15：Lead 按任务选 effort。Claude Code 的控制是 --effort（2.1.258 的 --help：low … max）。
  it("passes the chosen effort after the model", async () => {
    const { events } = await runFake("inspect", { model: "opus", effort: "xhigh", prompt: "hard work" });
    const argv: string[] = JSON.parse(completedText(events)).argv;
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4)).toEqual(["--model", "opus", "--effort", "xhigh"]);
  });

  it("spawns a reviewer in the sandbox with read tools and Bash, and no edit tools", async () => {
    const { runtime, events, exit } = await runFake("inspect", {
      role: "reviewer",
      purpose: "review",
      prompt: "review only",
    });

    const inspection = JSON.parse(completedText(events));
    expect(inspection.argv).toEqual([
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", inspection.argv[inspection.argv.indexOf("--settings") + 1],
      "--strict-mcp-config",
      "--tools", "Read,Glob,Grep,Bash",
      "--permission-mode", "auto",
      "review only",
    ]);
    expect(inspection.prompt).toBe("review only");
    expect(runtime.capabilities.executableReadOnlyReview).toBe(true);
    expect(exit.ok).toBe(true);
  });

  it("normalizes Claude stream-json while ignoring stderr, hooks, rate limits, and isolated malformed lines", async () => {
    const { events, exit } = await runFake("happy");

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "session.updated",
      "message.completed",
      "tool.started",
      "usage.updated",
      "tool.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.every((event) => event.runId === 22)).toBe(true);
    expect(events.some((event) => event.type === "runtime.stderr")).toBe(false);
    expect(events[0]).toMatchObject({ type: "run.started", runtime: "claude", model: null });
    expect(events[1]).toMatchObject({
      type: "session.updated",
      externalSessionId: "claude-session-1",
      runtimeVersion: "2.1.215",
    });
    expect(events[2]).toMatchObject({
      type: "message.completed",
      messageId: "msg-1",
      role: "assistant",
      text: "Checking file",
      stopReason: "tool_use",
    });
    expect(events[3]).toMatchObject({
      type: "tool.started",
      callId: "tool-1",
      name: "Read",
      args: { file_path: "README.md" },
    });
    expect(events[4]).toMatchObject({
      type: "usage.updated",
      mode: "cumulative",
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      costUsd: null,
    });
    expect(events[5]).toMatchObject({
      type: "tool.completed",
      callId: "tool-1",
      name: "Read",
      result: "file contents",
    });
    expect(events[6]).toMatchObject({
      type: "usage.updated",
      mode: "cumulative",
      inputTokens: 27,
      outputTokens: 6,
      totalTokens: 33,
      costUsd: 0.0125,
    });
    expect(events.filter((event) => event.type === "run.completed" || event.type === "run.failed"))
      .toHaveLength(1);
    expect(exit).toEqual({
      ok: true,
      exitCode: 0,
      signal: null,
      externalSessionId: "claude-session-1",
      errorCode: null,
      errorMessage: null,
    });
  });

  // 工单 #102 的 Run #118（Claude Code 2.1.258）：items.total_tokens 记成 17,071,923。夹具是这个 Run 原始输出里的用量行。
  // stream-json 把一次 API 响应按内容块拆成几行 assistant。每行带同一份 usage，output_tokens 只是流开始时的值。
  // 后台子 agent 的响应也在里面（parent_tool_use_id）。result 的 usage 只算本回合的主线程。
  // 这个 Run 有两个回合（后台任务的通知开了第二回合），两条 result 的 modelUsage 和 total_cost_usd 相同：整个进程的累计，含子 agent。
  it("reports the process total from modelUsage and counts each API response once", async () => {
    const { events, exit } = await runFake("replay", {}, {
      env: { FAKE_CLAUDE_REPLAY: resolve("packages/runtime/testing/fixtures/claude-usage-run-118.jsonl") },
    });
    const usage = events.filter((event) => event.type === "usage.updated");

    expect(usage.every((event) => event.mode === "cumulative")).toBe(true);
    // 67 次 API 响应（主线程 38 次，子 agent 29 次）各一条，加上两条 result。
    expect(usage).toHaveLength(67 + 2);
    expect(usage.at(-1)).toMatchObject({
      inputTokens: 134 + 296_699 + 5_631_822,
      outputTokens: 52_778,
      totalTokens: 5_981_433,
      costUsd: 2.5841608999999996,
    });
    const totals = usage.map((event) => event.totalTokens);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    expect(exit.ok).toBe(true);
  });

  // 用量账本的另外几条分支（2026-10-21 审查补的测试）：同一次响应的用量变大时只更新这一次响应；result 以后又来的
  // 响应接着累计；已经算进 result 的响应再出现时不重复算；没有 modelUsage 的旧版本取估计和各回合之和里较大的那个。
  it("updates a response whose usage grows, keeps counting after a result, and falls back without modelUsage", async () => {
    const dir = tempDir("plc-claude-ledger-");
    const replay = join(dir, "ledger.jsonl");
    const assistant = (id: string, input: number, output: number) => JSON.stringify({
      type: "assistant", parent_tool_use_id: null, session_id: "claude-session-1",
      message: { id, role: "assistant", content: [], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } },
    });
    const result = (input: number, output: number) => JSON.stringify({
      type: "result", subtype: "success", is_error: false, session_id: "claude-session-1",
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
    });
    await writeFile(replay, [
      assistant("msg-a", 10, 1),
      assistant("msg-a", 10, 5), // 同一次响应，输出变大：只更新它
      assistant("msg-a", 10, 5), // 重复的一行：不报
      result(10, 7), // 本回合的 usage 比估计大：取较大的
      assistant("msg-b", 20, 3), // result 以后的新回合：接着累计
      assistant("msg-a", 10, 9), // 已经算进上一条 result 的响应：不重复算
      result(20, 4),
    ].join("\n"));

    const { events } = await runFake("replay", {}, { env: { FAKE_CLAUDE_REPLAY: replay } });
    const usage = events.filter((event) => event.type === "usage.updated");
    expect(usage.map((event) => [event.inputTokens, event.outputTokens, event.totalTokens])).toEqual([
      [10, 1, 11],
      [10, 5, 15],
      [10, 7, 17],
      [30, 10, 40],
      [30, 11, 41],
    ]);
  });

  it("turns an error result into usage plus one failed terminal event", async () => {
    const { events, exit } = await runFake("result-error");

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "session.updated",
      "usage.updated",
      "run.failed",
    ]);
    expect(events[2]).toMatchObject({
      type: "usage.updated",
      mode: "cumulative",
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      costUsd: 0.004,
    });
    expect(events[3]).toMatchObject({
      type: "run.failed",
      exitCode: 0,
      errorCode: "claude_error_during_execution",
      error: "tool failed",
    });
    expect(exit).toEqual({
      ok: false,
      exitCode: 0,
      signal: null,
      externalSessionId: "claude-session-1",
      errorCode: "claude_error_during_execution",
      errorMessage: "tool failed",
    });
  });

  // 认证失败的 result 带着 subtype=success。旧 adapter 据此报出 claude_success（runs 46、47、63）。
  it("types an expired OAuth session as an account login failure, not claude_success", async () => {
    const { events, exit } = await runFake("auth-expired");

    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "claude_result_error",
      error: "Failed to authenticate: OAuth session expired and could not be refreshed",
      failure: { scope: "account", retry: "never", needs: "login", code: "auth_required" },
    });
    expect(exit.errorCode).toBe("claude_result_error");
  });

  it("types a turn-limit stop as a task failure", async () => {
    const { events } = await runFake("max-turns");
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "claude_error_max_turns",
      failure: { scope: "task", retry: "never", needs: "none", code: "task_failed" },
    });
  });

  it("fails after a bounded number of malformed stdout lines", async () => {
    const { events, exit } = await runFake("malformed-flood");

    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "claude_protocol_error",
    });
    expect(events.filter((event) => event.type === "run.completed" || event.type === "run.failed"))
      .toHaveLength(1);
    expect(exit).toMatchObject({ ok: false, errorCode: "claude_protocol_error" });
  });

  it("reports spawn and non-zero process failures through wait and events", async () => {
    const ClaudeRuntime = await loadClaudeRuntime();
    const missingRuntime = new ClaudeRuntime({ bin: "/definitely/missing/claude" });
    const missingHandle = await missingRuntime.start(request());
    const missingEventsPromise = collect(missingHandle.events);
    const missingExit = await missingHandle.wait();
    const missingEvents = await missingEventsPromise;

    expect(missingHandle.pid).toBeNull();
    expect(missingEvents.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "claude_spawn_error",
    });
    expect(missingExit).toMatchObject({ ok: false, errorCode: "claude_spawn_error" });
    expect(missingEvents.at(-1)).toMatchObject({
      failure: { scope: "runtime", retry: "never", needs: "config", code: "executable_missing" },
    });

    const nonZero = await runFake("exit-error");
    expect(nonZero.events.at(-1)).toMatchObject({
      type: "run.failed",
      exitCode: 7,
      errorCode: "claude_exit",
    });
    expect(nonZero.exit).toMatchObject({ ok: false, exitCode: 7, signal: null });
  });

  it("waits for process exit after a success result", async () => {
    const directory = tempDir("plc-claude-runtime-");
    tempDirs.push(directory);
    const marker = join(directory, "exit-marker");
    const { events, exit } = await runFake("result-delay", {}, {
      env: { FAKE_CLAUDE_MARKER: marker },
    });

    expect(await readFile(marker, "utf8")).toBe("exited\n");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", exitCode: 0 });
    expect(exit.ok).toBe(true);
  });

  it("interrupts with SIGTERM, escalates to SIGKILL, and resolves wait once", async () => {
    const directory = tempDir("plc-claude-runtime-");
    tempDirs.push(directory);
    const marker = join(directory, "signal-marker");
    const ClaudeRuntime = await loadClaudeRuntime();
    const runtime = new ClaudeRuntime({
      bin: fakeBin,
      prefixArgs: fakePrefixArgs,
      env: {
        FAKE_CLAUDE_SCENARIO: "ignore-term",
        FAKE_CLAUDE_MARKER: marker,
      },
      killGraceMs: 250,
    });
    const handle = await runtime.start(request());
    const eventsPromise = collect(handle.events);
    const firstWait = handle.wait();

    expect(await waitForFile(marker)).toContain("READY");
    await handle.interrupt("stop requested");
    const [exit, repeatedExit, events] = await Promise.all([
      firstWait,
      handle.wait(),
      eventsPromise,
    ]);

    expect(await readFile(marker, "utf8")).toContain("SIGTERM");
    expect(repeatedExit).toEqual(exit);
    expect(exit).toEqual({
      ok: false,
      exitCode: null,
      signal: "SIGKILL",
      externalSessionId: "claude-session-1",
      errorCode: "claude_interrupted",
      errorMessage: "stop requested",
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      exitCode: null,
      errorCode: "claude_interrupted",
      error: "stop requested",
    });
    expect(events.filter((event) => event.type === "run.completed" || event.type === "run.failed"))
      .toHaveLength(1);
  });
});

// auto 模式不能用的账号上，PLC_CLAUDE_PERMISSION_MODE 退回 acceptEdits。写错的值不认，仍然用 auto。
describe("claudePermissionMode", () => {
  it("defaults to auto and accepts only known modes", async () => {
    const { claudePermissionMode } = await import("../src/claude.js");
    expect(claudePermissionMode({})).toBe("auto");
    expect(claudePermissionMode({ PLC_CLAUDE_PERMISSION_MODE: "acceptEdits" })).toBe("acceptEdits");
    expect(claudePermissionMode({ PLC_CLAUDE_PERMISSION_MODE: "yolo" })).toBe("auto");
  });
});

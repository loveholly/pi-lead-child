import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "happy";
// 场景 sessions 按会话存档换成实际的会话。其他场景都用这一个。
let sessionId = "claude-session-1";
const markerPath = process.env.FAKE_CLAUDE_MARKER;

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// 健康探针（工单 04）。每一次调用的 argv 都追加写进 FAKE_PROBE_LOG。
// auth status 的字段取自 Claude Code 2.1.258。email 是假的，测试用它证明探针不复制状态输出。
const argv = process.argv.slice(2);
if (process.env.FAKE_PROBE_LOG) appendFileSync(process.env.FAKE_PROBE_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === "--version") {
  process.stdout.write("2.1.258 (Claude Code)\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "logged-in";
  const status = auth === "logged-in"
    ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.test" }
    : { loggedIn: false, authMethod: "none", apiProvider: auth === "third-party" ? "bedrock" : "firstParty" };
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(status.loggedIn ? 0 : 1);
}

// argv 按真实 CLI 的方式拆开（Claude Code 2.1.258 用 commander）。
// 带 <x...> 的选项收取后面的值，直到下一个以 - 开头的参数，所以它后面紧跟的提示词会被当成它的值。
// --resume 的值可以省略。提示词是剩下的位置参数。
// --plugin-dir 一次取一个值，可以重复（Claude Code 2.1.311 的 --help）。
const VALUE_OPTIONS = new Set(["--output-format", "--permission-mode", "--model", "--setting-sources", "--settings", "--plugin-dir"]);
const VARIADIC_OPTIONS = new Set(["--mcp-config", "--allowedTools", "--allowed-tools", "--tools", "--disallowedTools"]);
const OPTIONAL_VALUE_OPTIONS = new Set(["--resume", "-r"]);

function parseArgv(args: string[]): { options: Record<string, string[]>; flags: string[]; positionals: string[] } {
  const options: Record<string, string[]> = {};
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const takesNext = () => index + 1 < args.length && !args[index + 1]!.startsWith("-");
    if (VALUE_OPTIONS.has(arg)) {
      (options[arg] ??= []).push(args[++index] ?? "");
    } else if (OPTIONAL_VALUE_OPTIONS.has(arg)) {
      if (takesNext()) (options[arg] ??= []).push(args[++index]!);
      else flags.push(arg);
    } else if (VARIADIC_OPTIONS.has(arg)) {
      const values = options[arg] ??= [];
      while (takesNext()) values.push(args[++index]!);
    } else if (arg.startsWith("-")) {
      flags.push(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { options, flags, positionals };
}

const parsed = parseArgv(argv);

// --allowedTools 的值用逗号或空格分隔，括号里的逗号和空格不算（Claude Code 2.1.258）。
function toolList(values: string[] = []): string[] {
  const tools: string[] = [];
  for (const value of values) {
    let current = "";
    let inParens = false;
    for (const char of value) {
      if (char === "(") inParens = true;
      if (char === ")") inParens = false;
      if (!inParens && (char === "," || char === " ")) {
        if (current.trim()) tools.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) tools.push(current.trim());
  }
  return tools;
}

// 初始化事件里的 MCP 服务器状态（工单 05）。形状按 Claude Code 2.1.258 核实：
// mcp_servers 是 { name, status } 的数组，status 取 connected、failed、needs-auth、pending、disabled。
// FAKE_CLAUDE_MCP_STATUS 模拟 plc 工具通道连不上。
// --mcp-config 的值可以是 JSON 字符串，也可以是 JSON 文件的路径（Claude Code 2.1.258 的 --help）。
function mcpConfigArg(): string | null {
  return parsed.options["--mcp-config"]?.[0] ?? null;
}

function mcpConfig(): { mcpServers?: Record<string, { type?: string }> } | null {
  const value = mcpConfigArg();
  if (value === null) return null;
  return JSON.parse(value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8"));
}

// 配置文件的权限位。配置是 JSON 字符串时为 null。
function mcpConfigMode(): string | null {
  const value = mcpConfigArg();
  if (value === null || value.trimStart().startsWith("{")) return null;
  return (statSync(value).mode & 0o777).toString(8);
}

// 用户自己的 MCP 服务器：用户范围的配置在 CLAUDE_CONFIG_DIR/.claude.json 的 mcpServers 里。
// fake 只在设置了 CLAUDE_CONFIG_DIR 时读它，不读开发者真实的 ~/.claude.json。
function userMcpServers(): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return [];
  try {
    return Object.keys(JSON.parse(readFileSync(`${dir}/.claude.json`, "utf8")).mcpServers ?? {});
  } catch {
    return [];
  }
}

// 两个 flag 对 MCP 服务器的影响，按 Claude Code 2.1.258 的代码核实（读安装的二进制，没有发起模型调用）：
// - --strict-mcp-config：只用 --mcp-config 的服务器，不加载用户的服务器。
// - --safe-mode：不加载用户的服务器，并且丢掉 --mcp-config 里所有不是 sdk 类型的服务器。plc 是 stdio，也被丢掉。
function mcpServers(): Array<{ name: string; status: string }> {
  const safeMode = parsed.flags.includes("--safe-mode");
  const strict = parsed.flags.includes("--strict-mcp-config");
  const flagServers = Object.entries(mcpConfig()?.mcpServers ?? {})
    .filter(([, server]) => !safeMode || server.type === "sdk")
    .map(([name]) => ({ name, status: process.env.FAKE_CLAUDE_MCP_STATUS ?? "connected" }));
  const userServers = safeMode || strict ? [] : userMcpServers().map((name) => ({ name, status: "connected" }));
  return [...userServers, ...flagServers];
}

function init(): void {
  const servers = mcpServers();
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.215",
    model: "claude-fake-1",
    tools: ["Read", "Glob", "Grep", ...servers
      .filter((server) => server.status === "connected")
      .map((server) => `mcp__${server.name}__ticket_update`)],
    mcp_servers: servers,
  });
}

function successResult(): void {
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 25,
    duration_api_ms: 20,
    num_turns: 1,
    result: "Checking file",
    session_id: sessionId,
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      output_tokens: 6,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
  });
}

function assistantText(text: string): void {
  out({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-fake-1",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

// 工单 13：API 错误的样本。文本取自 Claude Code 2.1.258 二进制里的字符串（没有发起模型调用）。
// 形状和 runs 46、47、63 的认证失败一样：错误文本是一条助手消息，result 的 subtype 是 success，is_error 为 true。
const API_ERRORS: Record<string, string> = {
  "credit-low": "Credit balance is too low",
  "model-missing": "There's an issue with the selected model (claude-fake-9). It may not exist or you may not have access to it. "
    + "Run /model to pick a different model.",
  "overloaded": "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. "
    + "Try again in a moment.",
  "connection-lost": "API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.",
};

function apiError(message: string): void {
  init();
  assistantText(message);
  out({
    type: "result", subtype: "success", is_error: true, duration_ms: 5, num_turns: 1, result: message,
    session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, uuid: "result-api-error-1",
  });
  process.exitCode = 1;
}

// 会话存档（工单 #66 的 Run #71）。FAKE_CLAUDE_SESSION_DIR 里一个会话一个文件。
// 删掉文件，就是 CLI 按保留期清理了这个会话的记录。
// - 不带 --resume：开一个新会话，回答一句话。
// - --resume 一个存在的会话：在同一个会话里回答。带 --fork-session 时在一个新会话里回答，原会话不变。
// - --resume 一个不存在的会话：输出照抄 Run #71（Claude Code 2.1.258）：stderr 一行，
//   一条 subtype 为 error_during_execution 的 result，退出码 1。没有 init。
//   带 --fork-session 时文本相同，result 的 session_id 是一个新的随机 id（2026-10-14 用真实 CLI 核实）。
// 每次启动在 FAKE_CLAUDE_LOG 里追加一行：要 resume 的会话、是否 fork、实际用的会话和提示词。
function sessions(): void {
  const store = process.env.FAKE_CLAUDE_SESSION_DIR;
  if (!store) throw new Error("scenario sessions needs FAKE_CLAUDE_SESSION_DIR");
  const resume = parsed.options["--resume"]?.[0] ?? null;
  const fork = parsed.flags.includes("--fork-session");
  const prompt = parsed.positionals.at(-1) ?? "";
  const log = (session: string | null) => {
    if (process.env.FAKE_CLAUDE_LOG) {
      appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ resume, fork, session, prompt })}\n`);
    }
  };
  if (resume !== null && !existsSync(join(store, resume))) {
    log(null);
    const error = `No conversation found with session ID: ${resume}`;
    process.stderr.write(`${error}\n`);
    out({
      type: "result", subtype: "error_during_execution", duration_ms: 0, duration_api_ms: 0, is_error: true,
      num_turns: 0, stop_reason: null, session_id: fork ? randomUUID() : resume, total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), errors: [error],
    });
    process.exitCode = 1;
    return;
  }
  sessionId = resume !== null && !fork ? resume : `claude-session-${randomUUID()}`;
  writeFileSync(join(store, sessionId), "");
  log(sessionId);
  init();
  // FAKE_CLAUDE_SESSION_TOOL=1：回答之前先说一句话、读一个文件（任务卡的测试看这次调用落在哪一轮）。
  if (process.env.FAKE_CLAUDE_SESSION_TOOL === "1") {
    out({
      type: "assistant", session_id: sessionId,
      message: {
        id: `msg-tool-${randomUUID()}`, role: "assistant", model: "claude-fake-1", stop_reason: "tool_use",
        content: [
          { type: "text", text: "我先看一下。" },
          { type: "tool_use", id: "tool-session-read", name: "Read", input: { file_path: "README.md" } },
        ],
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    });
    out({
      type: "user", session_id: sessionId,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-session-read", content: "readme", is_error: false }] },
    });
  }
  assistantText(`answer in ${sessionId}`);
  successResult();
}

if (scenario === "inspect") {
  init();
  // 工单 10：envNames 记下 child 收到的全部变量名。值只报 FAKE_CAPTURE_ENV 点名的变量。
  // FAKE_CLAUDE_CAPTURE 给出时，同样的内容也写进这个文件，供经过 runItem 的测试读取。
  const inspection = JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      CLAUDE_BASE_ENV: process.env.CLAUDE_BASE_ENV,
      CLAUDE_REQUEST_ENV: process.env.CLAUDE_REQUEST_ENV,
      CLAUDE_OVERRIDE_ENV: process.env.CLAUDE_OVERRIDE_ENV,
    },
    envNames: Object.keys(process.env).sort(),
    values: Object.fromEntries((process.env.FAKE_CAPTURE_ENV ?? "").split(",").filter(Boolean)
      .map((name) => [name, process.env[name] ?? null])),
    mcpConfig: mcpConfig(),
    mcpConfigPath: mcpConfigArg()?.trimStart().startsWith("{") ? null : mcpConfigArg(),
    mcpConfigMode: mcpConfigMode(),
    // 工单 11：CLI 解析出的提示词、许可清单和初始化时的 MCP 服务器。
    prompt: parsed.positionals.length === 1 ? parsed.positionals[0] : null,
    allowedTools: toolList([...(parsed.options["--allowedTools"] ?? []), ...(parsed.options["--allowed-tools"] ?? [])]),
    mcpServers: mcpServers(),
  });
  if (process.env.FAKE_CLAUDE_CAPTURE) writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, inspection);
  assistantText(inspection);
  successResult();
} else if (scenario === "linger") {
  // 工单 14：初始化以后一直运行，直到收到信号。FAKE_CLAUDE_CAPTURE 记下 MCP 配置文件的路径。
  init();
  if (process.env.FAKE_CLAUDE_CAPTURE) {
    writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ mcpConfigPath: mcpConfigArg() }));
  }
  setInterval(() => {}, 1_000);
} else if (scenario === "happy") {
  process.stderr.write("diagnostic stderr that the adapter must ignore\n");
  process.stdout.write("not-json\n");
  init();
  out({ type: "system", subtype: "hook_started", hook_id: "hook-1" });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  out({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-fake-1",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Checking file" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
      ],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 5,
        output_tokens: 3,
      },
    },
  });
  out({
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "file contents",
        is_error: false,
      }],
    },
  });
  successResult();
} else if (scenario === "result-error") {
  init();
  out({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0.004,
    usage: { input_tokens: 7, output_tokens: 2 },
    modelUsage: {},
    permission_denials: [],
    errors: ["tool failed"],
    uuid: "result-error-1",
  });
} else if (scenario === "auth-expired") {
  // runs 46、47、63 的原生形状：API 错误以一条助手消息出现，result 的 subtype 仍是 success。
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  init();
  assistantText(message);
  out({
    type: "result",
    subtype: "success",
    is_error: true,
    duration_ms: 5,
    num_turns: 1,
    result: message,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    uuid: "result-auth-1",
  });
  process.exitCode = 1;
} else if (scenario === "max-turns") {
  init();
  out({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 40,
    session_id: sessionId,
    usage: { input_tokens: 7, output_tokens: 2 },
    uuid: "result-max-turns-1",
  });
} else if (scenario === "malformed-flood") {
  init();
  for (let index = 0; index < 32; index += 1) {
    process.stdout.write(`malformed-${index}\n`);
  }
  successResult();
} else if (scenario === "exit-error") {
  init();
  process.stderr.write("fatal diagnostic\n");
  process.exitCode = 7;
} else if (scenario === "result-delay") {
  init();
  successResult();
  setTimeout(() => {
    if (markerPath) writeFileSync(markerPath, "exited\n");
    process.exit(0);
  }, 80);
} else if (scenario === "ignore-term") {
  process.on("SIGTERM", () => {
    if (markerPath) appendFileSync(markerPath, "SIGTERM\n");
  });
  if (markerPath) appendFileSync(markerPath, "READY\n");
  init();
  setInterval(() => {}, 1_000);
// ── 工单 13：合约测试的场景 ──────────────────────────────────────────────────
} else if (scenario === "tools") {
  // 一个工具调用成功，一个工具调用失败（tool_result 的 is_error 为 true），然后正常完成。
  init();
  out({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: "msg-tools", role: "assistant", model: "claude-fake-1", stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "README.md" } },
        { type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "npm test" } },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  });
  out({
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-read", content: "file contents", is_error: false },
        { type: "tool_result", tool_use_id: "tool-bash", content: "Exit code 1\nnpm ERR! test failed", is_error: true },
      ],
    },
  });
  assistantText("Tests fail");
  successResult();
} else if (scenario === "malformed-tolerated") {
  // 两行畸形行（不是 JSON 的输出行），然后正常完成。
  process.stdout.write("not json\n{broken\n");
  init();
  assistantText("done");
  successResult();
} else if (scenario === "malformed-hang") {
  // 很多行畸形行，然后一直运行，不退出。
  init();
  for (let index = 0; index < 40; index += 1) process.stdout.write(`malformed-${index}\n`);
  setInterval(() => {}, 1_000);
} else if (scenario === "missing-result") {
  // 没有 result 消息，进程以 0 退出。
  init();
  assistantText("partial");
} else if (scenario === "sessions") {
  sessions();
} else if (scenario === "replay") {
  // 原样输出 FAKE_CLAUDE_REPLAY 文件里录下的 stream-json 行，例如 fixtures/claude-usage-run-118.jsonl。
  const replay = process.env.FAKE_CLAUDE_REPLAY;
  if (!replay) throw new Error("scenario replay needs FAKE_CLAUDE_REPLAY");
  init();
  for (const line of readFileSync(replay, "utf8").split("\n")) {
    if (line.trim()) process.stdout.write(`${line}\n`);
  }
} else if (API_ERRORS[scenario] !== undefined) {
  apiError(API_ERRORS[scenario]!);
} else {
  throw new Error(`unknown fake Claude scenario: ${scenario}`);
}

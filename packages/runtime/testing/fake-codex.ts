import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "happy";
const capturePath = process.env.FAKE_CODEX_CAPTURE;
const readyPath = process.env.FAKE_CODEX_READY_FILE;
const signalPath = process.env.FAKE_CODEX_SIGNAL_FILE;

const out = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

// 健康探针（工单 04）。每一次调用的 argv 都追加写进 FAKE_PROBE_LOG，测试据此断言探针没有跑 exec。
// 输出的形状取自 codex-cli 0.153.3：未登录时打印 "Not logged in"，退出码 1。
const argv = process.argv.slice(2);
if (process.env.FAKE_PROBE_LOG) appendFileSync(process.env.FAKE_PROBE_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.153.3\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  const loggedIn = (process.env.FAKE_CODEX_LOGIN ?? "logged-in") === "logged-in";
  process.stdout.write(loggedIn ? "Logged in using ChatGPT\n" : "Not logged in\n");
  process.exit(loggedIn ? 0 : 1);
}

// 工单 10：envNames 记下 child 收到的全部变量名。值只记 FAKE_CAPTURE_ENV 点名的变量，
// 不把开发者环境里可能存在的凭据写进文件。
if (capturePath) {
  writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    env: {
      base: process.env.FAKE_BASE_ENV ?? null,
      request: process.env.FAKE_REQUEST_ENV ?? null,
      mcpOnly: process.env.MCP_ONLY ?? null,
    },
    envNames: Object.keys(process.env).sort(),
    values: Object.fromEntries((process.env.FAKE_CAPTURE_ENV ?? "").split(",").filter(Boolean)
      .map((name) => [name, process.env[name] ?? null])),
    mcpServers: loadedMcpServers(process.argv.slice(2)),
  }));
}

// 工单 13：Codex 加载的 MCP 服务器。规则按 codex-cli 0.153.3 的 --help 和配置的字段（见工单 11 的核实）：
// - 用户的服务器写在 CODEX_HOME/config.toml 的 [mcp_servers.<名字>] 里。--ignore-user-config 不读这个文件。
// - -c mcp_servers.<名字>.command=… 加一个服务器，-c mcp_servers.<名字>.enabled=false 关掉一个服务器。
// fake 只在设置了 CODEX_HOME 时读配置，不读开发者真实的 ~/.codex。
function loadedMcpServers(args: string[]): string[] {
  const servers = new Set<string>();
  const home = process.env.CODEX_HOME;
  if (home && !args.includes("--ignore-user-config")) {
    try {
      for (const match of readFileSync(`${home}/config.toml`, "utf8").matchAll(/^\s*\[mcp_servers\.([\w-]+)\]\s*$/gm)) {
        servers.add(match[1]!);
      }
    } catch {
      // 没有配置文件。
    }
  }
  const overrides = args.filter((_, index) => index > 0 && args[index - 1] === "-c");
  for (const value of overrides) {
    const added = /^mcp_servers\.([\w-]+)\.command=/.exec(value);
    if (added) servers.add(added[1]!);
  }
  for (const value of overrides) {
    const disabled = /^mcp_servers\.([\w-]+)\.enabled\s*=\s*false$/.exec(value);
    if (disabled) servers.delete(disabled[1]!);
  }
  return [...servers];
}

function happy(): void {
  out({ type: "thread.started", thread_id: "codex-thread-1" });
  out({ type: "turn.started" });
  out({
    type: "item.started",
    item: { id: "message-1", type: "agent_message", status: "in_progress" },
  });
  out({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "work complete", status: "completed" },
  });
  out({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 25,
      output_tokens: 40,
      reasoning_output_tokens: 10,
    },
  });
}

function tools(): void {
  out({ type: "thread.started", thread_id: "codex-thread-tools" });
  out({ type: "turn.started" });
  out({
    type: "item.started",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "printf ok",
      cwd: "/tmp/project",
      status: "in_progress",
    },
  });
  out({
    type: "item.completed",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "printf ok",
      cwd: "/tmp/project",
      aggregated_output: "ok",
      exit_code: 0,
      error: null,
      status: "completed",
    },
  });
  out({
    type: "item.started",
    item: {
      id: "mcp-1",
      type: "mcp_tool_call",
      server: "plc",
      tool: "ticket_update",
      arguments: { status: "review" },
      status: "in_progress",
    },
  });
  out({
    type: "item.completed",
    item: {
      id: "mcp-1",
      type: "mcp_tool_call",
      server: "plc",
      tool: "ticket_update",
      arguments: { status: "review" },
      result: { content: [{ type: "text", text: "updated" }] },
      error: null,
      status: "completed",
    },
  });
  out({
    type: "item.started",
    item: {
      id: "mcp-2",
      type: "mcp_tool_call",
      server: "plc",
      tool: "request_approval",
      arguments: { reason: "needs access" },
      status: "in_progress",
    },
  });
  out({
    type: "item.completed",
    item: {
      id: "mcp-2",
      type: "mcp_tool_call",
      server: "plc",
      tool: "request_approval",
      arguments: { reason: "needs access" },
      error: { message: "denied" },
      status: "failed",
    },
  });
  out({
    type: "turn.completed",
    usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
  });
}

// 历史失败的原生样本（packages/runtime/testing/fixtures/runtime-failures.json）。Codex 先在 stderr 打出与失败无关的
// 报错（模型缓存、refresh token 被吊销），然后用一条 JSONL error 说出真正的终止原因。
const NOISY_STDERR = "ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions`\n"
  + "ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: "
  + "{\"code\": \"refresh_token_invalidated\"} Please log out and sign in again.\n";
const HISTORICAL_ERRORS: Record<string, string> = {
  "out-of-credits": "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "model-unsupported": JSON.stringify({
    type: "error", status: 400,
    error: {
      type: "invalid_request_error",
      message: "The 'openai/gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    },
  }),
  "proxy-unknown-model": "Reconnecting... 1/5 (unexpected status 502 Bad Gateway: unknown provider for model "
    + "gpt-5.4-mini, url: http://codex-proxy.example/v1/responses)",
  "capacity": "Selected model is at capacity. Please try a different model.",
  "token-revoked": "Your access token could not be refreshed because your refresh token was revoked. "
    + "Please log out and sign in again.",
  "network": "Reconnecting... waiting for network (Connection failed: error sending request)",
  // 工单 #93：账号所在的工作区被停用（Run #113，2026-10-19）。
  "workspace-deactivated": "Reconnecting... 2/5 (unexpected status 402 Payment Required: Payment Required, "
    + "url: wss://chatgpt.com/backend-api/codex/responses, auth error: 402, auth error code: deactivated_workspace)",
};

switch (scenario) {
  case "out-of-credits":
  case "model-unsupported":
  case "proxy-unknown-model":
  case "capacity":
  case "token-revoked":
  case "network":
  case "workspace-deactivated":
    // stderr 与 stdout 是两条管道，到达顺序没有保证。先等 stderr 写完再输出终止错误，
    // 测试才能确定噪声已经在 adapter 手里。
    process.stderr.write(NOISY_STDERR, () => setTimeout(() => {
      out({ type: "thread.started", thread_id: `codex-thread-${scenario}` });
      out({ type: "turn.started" });
      out({ type: "error", message: HISTORICAL_ERRORS[scenario] });
      process.exitCode = 1;
    }, 50));
    break;
  case "happy":
    happy();
    break;
  case "tools":
    tools();
    break;
  case "stderr":
    process.stderr.write("codex warning\n");
    happy();
    break;
  case "malformed-tolerated":
    process.stdout.write("not json\n{broken\n");
    happy();
    break;
  case "malformed-excess":
    process.stdout.write("bad-1\nbad-2\nbad-3\nbad-4\n");
    setInterval(() => {}, 1_000);
    break;
  // 工单 #66：要 resume 或 fork 的会话已经不存在。文本和形状按 codex-cli 0.162.1 核实
  // （CODEX_HOME 指向空目录，provider 指向关闭的端口，不发起模型调用）：stdout 没有 JSONL，
  // stderr 一行，退出码 1。exec fork 的文本把 resume 换成 fork。不带 resume 和 fork 时照常回答。
  case "resume-missing": {
    const at = argv.findIndex((arg) => arg === "resume" || arg === "fork");
    if (at === -1) {
      happy();
      break;
    }
    const verb = argv[at];
    process.stderr.write(
      `Error: thread/${verb}: thread/${verb} failed: no rollout found for thread id ${argv[at + 1]} (code -32600)\n`,
    );
    process.exitCode = 1;
    break;
  }
  case "error":
    out({ type: "error", code: "remote_error", message: "remote exploded" });
    process.exitCode = 1;
    break;
  case "turn-failed":
    out({ type: "thread.started", thread_id: "codex-thread-failed" });
    out({ type: "turn.started" });
    out({ type: "turn.failed", error: { code: "turn_rejected", message: "turn rejected" } });
    process.exitCode = 1;
    break;
  // 工单 05：plc 设成了 required，它起不来时 Codex 在会话初始化阶段退出。报错文本取自 codex-cli 0.153.3
  // 二进制里的字符串 "required MCP servers failed to initialize: "。exec 模式是走 stderr 还是 JSONL error
  // 没有用真实 CLI 核实，两种形状都模拟。
  case "plc-required-stderr":
    process.stderr.write("Error: required MCP servers failed to initialize: plc: connection closed\n");
    process.exitCode = 1;
    break;
  case "plc-required-error":
    out({ type: "error", message: "required MCP servers failed to initialize: plc: connection closed" });
    process.exitCode = 1;
    break;
  case "nonzero":
    out({ type: "thread.started", thread_id: "codex-thread-nonzero" });
    process.stderr.write("fatal from codex\n");
    process.exitCode = 7;
    break;
  // 工单 14：一个长时间运行的 Run。每 50 毫秒向 stdout 写一行，并在心跳文件里追加一行。
  // stdout 的读端没了时，写入出错，进程退出。测试据此看出 child 是否还连着 daemon 的管道。
  // 到 FAKE_CODEX_HEARTBEAT_MS 后正常结束。
  case "heartbeat": {
    const heartbeatPath = process.env.FAKE_CODEX_HEARTBEAT_FILE;
    const endAt = Date.now() + Number(process.env.FAKE_CODEX_HEARTBEAT_MS ?? 20_000);
    out({ type: "thread.started", thread_id: "codex-thread-heartbeat" });
    out({ type: "turn.started" });
    let beat = 0;
    const timer = setInterval(() => {
      beat += 1;
      if (heartbeatPath) appendFileSync(heartbeatPath, `${beat}\n`);
      if (Date.now() < endAt) {
        out({ type: "item.started", item: { id: `beat-${beat}`, type: "agent_message", text: "", status: "in_progress" } });
        return;
      }
      clearInterval(timer);
      out({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "heartbeat done", status: "completed" } });
      out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }, 50);
    break;
  }
  // 工单 15：测试用一个闸门文件控制 Run 的进度，所以 daemon 停机期间也能产生输出。
  // 闸门文件里每新增一行，Codex 做一件事：
  // "step <文字>" 输出一条助手消息，"finish" 正常结束，"fail" 以一条 JSONL 错误结束（退出码 1）。
  case "gated": {
    const gatePath = process.env.FAKE_CODEX_GATE_FILE;
    if (!gatePath) throw new Error("FAKE_CODEX_GATE_FILE is required");
    out({ type: "thread.started", thread_id: "codex-thread-gated" });
    out({ type: "turn.started" });
    let handled = 0;
    const timer = setInterval(() => {
      let lines: string[];
      try {
        lines = readFileSync(gatePath, "utf8").split("\n").filter(Boolean);
      } catch {
        return;
      }
      for (const line of lines.slice(handled)) {
        handled += 1;
        if (line.startsWith("step ")) {
          out({ type: "item.completed", item: { id: `step-${handled}`, type: "agent_message", text: line.slice(5), status: "completed" } });
        } else if (line === "finish") {
          clearInterval(timer);
          out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
          return;
        } else if (line === "fail") {
          clearInterval(timer);
          out({ type: "error", code: "remote_error", message: "remote exploded" });
          process.exitCode = 1;
          return;
        }
      }
    }, 30);
    break;
  }
  case "interrupt":
    out({ type: "thread.started", thread_id: "codex-thread-interrupt" });
    out({ type: "turn.started" });
    process.on("SIGTERM", () => {
      if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    });
    if (readyPath) writeFileSync(readyPath, "ready\n");
    setInterval(() => {}, 1_000);
    break;
  // 工单 13：回合没有结束（没有 turn.completed，也没有错误），进程却以 0 退出。
  case "no-turn-completed":
    out({ type: "thread.started", thread_id: "codex-thread-no-result" });
    out({ type: "turn.started" });
    out({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "partial", status: "completed" } });
    break;
  default:
    throw new Error(`unknown fake Codex scenario: ${scenario}`);
}

// 模拟 pi --mode rpc 的最小协议实现（仅测试用）。
// 协议依据 @mariozechner/pi-coding-agent@0.73.1 docs/rpc.md。
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const scenario = process.env.FAKE_SCENARIO ?? "happy";
const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

// 工单 10：记下 argv、运行它的 Node 和全部变量名。值只记 FAKE_CAPTURE_ENV 点名的变量，
// 不把开发者环境里可能存在的凭据写进文件。
if (process.env.FAKE_PI_CAPTURE && process.argv[2] !== "--version") {
  writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({
    args: process.argv.slice(2),
    execPath: process.execPath,
    envNames: Object.keys(process.env).sort(),
    values: Object.fromEntries((process.env.FAKE_CAPTURE_ENV ?? "").split(",").filter(Boolean)
      .map((name) => [name, process.env[name] ?? null])),
  }));
}

// 工单 13：捕获文件里再记两样东西。
// - extensions：-e 加载的扩展。userExtensions：pi 1.1.0 从 PI_CODING_AGENT_DIR/extensions/ 发现的用户扩展，
//   --no-extensions（-ne）关掉它们，-e 给出的扩展照常加载（pi 1.1.0 的 docs/cli.md）。
//   fake 只在设置了 PI_CODING_AGENT_DIR 时读这个目录，不读开发者真实的 ~/.pi/agent。
// - prompt：经 RPC 收到的提示词，收到 prompt 命令时补进文件。
function mergeCapture(fields: Record<string, unknown>): void {
  const file = process.env.FAKE_PI_CAPTURE;
  if (!file) return;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...fields }));
}
if (process.env.FAKE_PI_CAPTURE && process.argv[2] !== "--version") {
  const args = process.argv.slice(2);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const discover = agentDir && !args.includes("--no-extensions") && !args.includes("-ne");
  mergeCapture({
    extensions: args.filter((_, index) => index > 0 && ["-e", "--extension"].includes(args[index - 1]!)),
    userExtensions: discover && existsSync(`${agentDir}/extensions`)
      ? readdirSync(`${agentDir}/extensions`).map((name) => name.replace(/\.[jt]s$/, ""))
      : [],
  });
}

// 健康探针（工单 04）。每一次调用的 argv 都追加写进 FAKE_PROBE_LOG。
// auth check 的输出形状取自 pi 1.1.0：就绪时 status=ready，否则 status=not_ready 并带 reason，退出码 1。
const argv = process.argv.slice(2);
if (process.env.FAKE_PROBE_LOG) appendFileSync(process.env.FAKE_PROBE_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === "--version") {
  process.stdout.write("1.1.0\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "check") {
  const ready = (process.env.FAKE_PI_AUTH ?? "ready") === "ready";
  out(ready
    ? { status: "ready", provider: "openai", authType: "oauth" }
    : { status: "not_ready", provider: "openai", reason: "credentials_not_configured" });
  process.exit(ready ? 0 : 1);
}

// runs 14、15、23 的原生形状：pi 在读 stdin 之前加载扩展失败，打印到 stderr 后退出。
if (scenario === "extension_missing") {
  process.stderr.write('Error: Failed to load extension "/repo/src/extension/item-tools.ts": '
    + "Extension path does not exist: /repo/src/extension/item-tools.ts\n");
  process.exit(1);
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

// 工单 13：pi 1.1.0 的 LLM 错误。形状取自 pi-coding-agent 1.1.0 的 docs/json.md 和 dist/core/agent-session.js：
// - 助手消息以 stopReason=error 结束，错误文本在 errorMessage 里，content 为空。随后是 agent_end。
// - pi 认为能重试的错误（满载、断网等，pi-ai 的 utils/retry.js）：agent_end 带 willRetry=true，pi 自己退避重试。
//   重试用完以后，最后一个 agent_end 带 willRetry=false，再发 auto_retry_end（success=false）。最后是 agent_settled。
// fake 只重试一次。错误文本：前三条取自同一个 ChatGPT 后端的历史失败（runs 35、12、55），fetch failed 是 undici 的报错。
const AT_CAPACITY = "Selected model is at capacity. Please try a different model.";
const LLM_ERRORS: Record<string, { message: string; retryable: boolean }> = {
  llm_out_of_credits: {
    message: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.", retryable: false,
  },
  llm_model_unsupported: {
    message: "The 'openai/gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.", retryable: false,
  },
  llm_capacity: { message: AT_CAPACITY, retryable: true },
  llm_network: { message: "fetch failed", retryable: true },
  llm_unrecognized: { message: "the model refused the request shape", retryable: false },
  // 第一次满载，pi 重试后成功。
  retry_recovers: { message: AT_CAPACITY, retryable: true },
  // agent_end 说了 willRetry=true，重试却没有开始（例如用户中止了它）。pi 直接发 agent_settled。
  retry_abandoned: { message: AT_CAPACITY, retryable: true },
};

// pi 1.1.0 在 prompt 的预检里发现没有凭据时，prompt 命令的回复是 success=false，不发 agent_start
// （dist/modes/rpc/rpc-mode.js 和 dist/core/agent-session.js 的 _getRequiredRequestAuth）。
const PROMPT_AUTH_ERROR = "Authentication failed for \"openai-codex\". Credentials may have expired or network is unavailable. "
  + "Run '/login openai-codex' to re-authenticate.";

function errorMessageEnd(text: string): void {
  out({ type: "message_end", message: {
    role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.5",
    stopReason: "error", errorMessage: text, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } });
}

function llmErrorTurn(cmd: any, error: { message: string; retryable: boolean }): void {
  if (scenario === "retry_abandoned") {
    errorMessageEnd(error.message);
    out({ type: "agent_end", messages: [], willRetry: true });
    out({ type: "agent_settled", aborted: true });
    return;
  }
  if (error.retryable) {
    errorMessageEnd(error.message);
    out({ type: "agent_end", messages: [], willRetry: true });
    out({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: error.message });
    out({ type: "agent_start" });
  }
  if (scenario === "retry_recovers") {
    finish(cmd);
    out({ type: "agent_settled", aborted: false });
    return;
  }
  errorMessageEnd(error.message);
  out({ type: "agent_end", messages: [], willRetry: false });
  if (error.retryable) out({ type: "auto_retry_end", success: false, attempt: 1, finalError: error.message });
  out({ type: "agent_settled", aborted: false });
}

// 工单 13：--session <文件> 打开已有的 session，get_state 报告它的 id（pi 1.1.0 的行为，见 src/runtimes/pi.ts）。
// --fork <文件> 在 --session-dir 里写一个新的 session 文件，新 id，头里的 parentSession 指向原文件。
// 原文件不变。get_state 报告新的 session。2026-10-13 用真实的 pi 1.1.0 在 RPC 模式下核实。
function argValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function readHeader(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8").split("\n")[0]!);
}

const forkedSession = ((): { file: string; id: string } | null => {
  const source = argValue("--fork");
  const dir = argValue("--session-dir");
  if (!source || !dir) return null;
  const header = readHeader(source);
  const id = `${String(header.id)}-fork-${process.pid}`;
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ ...header, id, parentSession: source })}\n`);
  return { file, id };
})();

function resumedSession(): { file: string; id: string } | null {
  if (forkedSession) return forkedSession;
  const file = argValue("--session");
  if (!file) return null;
  return { file, id: String(readHeader(file).id) };
}

// 收到的插话（steer）。answer_steer 场景等到一条插话才回答。
const steers: string[] = [];
let onSteer: (() => void) | null = null;

// 工单 08：现在的模型和推理强度。启动参数给出初值，set_model 和 set_thinking_level 改它们。
// hold_for_profile 场景：回合先调一次模型（带用量），然后等到 set_thinking_level（最多 10 秒），
// 再用新的模型调一次，回答里写明用的模型和强度。hold_for_profile_then_fail：换过以后，账号不支持新的模型。
let model = argValue("--provider") && argValue("--model") ? `${argValue("--provider")}/${argValue("--model")}` : argValue("--model") ?? "fake/fake-1";
let thinking = argValue("--thinking") ?? "off";
let onProfile: (() => void) | null = null;

function handle(cmd: any): void {
  // 工单 14：记下收到的每一条 RPC 命令，测试据此断言 steer 送达了 CLI。
  // 工单 08：换模型和推理强度的命令另外记下参数。
  if (process.env.FAKE_PI_COMMAND_LOG) {
    const profile = cmd.type === "set_model" ? { provider: cmd.provider, modelId: cmd.modelId }
      : cmd.type === "set_thinking_level" ? { level: cmd.level } : {};
    appendFileSync(process.env.FAKE_PI_COMMAND_LOG, `${JSON.stringify({ type: cmd.type, message: cmd.message ?? null, ...profile })}\n`);
  }
  // 工单 08：pi 1.1.0 的 set_model 回包带上选中的模型。之后的回合用它。
  if (cmd.type === "set_model") {
    model = `${cmd.provider}/${cmd.modelId}`;
    out({ type: "response", command: "set_model", id: cmd.id, success: true, data: { provider: cmd.provider, id: cmd.modelId } });
    return;
  }
  if (cmd.type === "set_thinking_level") {
    thinking = String(cmd.level);
    out({ type: "response", command: "set_thinking_level", id: cmd.id, success: true });
    onProfile?.();
    return;
  }
  if (cmd.type === "get_state") {
    out({ type: "response", command: "get_state", id: cmd.id, success: true,
      data: { sessionFile: resumedSession()?.file ?? "/tmp/fake-session.jsonl", sessionId: resumedSession()?.id ?? "fake-session-1",
              isStreaming: false, model: null } });
    return;
  }
  if (cmd.type === "steer") {
    out({ type: "response", command: "steer", id: cmd.id, success: true });
    steers.push(String(cmd.message ?? ""));
    onSteer?.();
    return;
  }
  if (cmd.type === "prompt") {
    mergeCapture({ prompt: cmd.message });
    if (scenario === "prompt_auth") {
      out({ type: "response", command: "prompt", id: cmd.id, success: false, error: PROMPT_AUTH_ERROR });
      return;
    }
    out({ type: "response", command: "prompt", id: cmd.id, success: true });
    out({ type: "agent_start" });
    if (scenario === "crash") process.exit(1);
    if (scenario === "crash_stderr") {
      process.stderr.write("TypeError: zlib.createZstdDecompress is not a function\n");
      process.exit(1);
    }
    // 工单 14：大段 stderr 写完以后再退出。进程退出时，stderr 的末尾可能还在管道里。
    if (scenario === "crash_big_stderr") {
      process.stderr.write(`${"noise line\n".repeat(30_000)}END-OF-STDERR\n`, () => { process.exitCode = 3; process.exit(); });
      return;
    }
    if (scenario === "slow") { setTimeout(() => finish(cmd), 1500); return; }
    if (scenario === "answer_steer") { answerSteer(cmd); return; }
    if (scenario === "hold_for_profile" || scenario === "hold_for_profile_then_fail") { holdForProfile(); return; }
    if (LLM_ERRORS[scenario]) { llmErrorTurn(cmd, LLM_ERRORS[scenario]!); return; }
    // 工单 13：两行畸形行（不是 JSON 的输出行），然后正常完成。
    if (scenario === "malformed_tolerated") process.stdout.write("not json\n{broken\n");
    // 工单 13：很多行畸形行，然后不结束回合。进程也不退出，因为 stdin 一直开着。
    if (scenario === "malformed_hang") {
      for (let index = 0; index < 40; index += 1) process.stdout.write(`malformed-${index}\n`);
      return;
    }
    // 工单 13：回合一直不结束，并忽略 SIGTERM。就绪时在 FAKE_PI_MARKER 里写 ready，收到 SIGTERM 时追加一行。
    if (scenario === "ignore_term") {
      const marker = process.env.FAKE_PI_MARKER;
      process.on("SIGTERM", () => { if (marker) appendFileSync(marker, "SIGTERM\n"); });
      if (marker) writeFileSync(marker, "ready\n");
      return;
    }
    // 工单 13：回合没有结束（没有 agent_end），进程却以 0 退出。
    if (scenario === "exit_before_end") {
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" } });
      process.exit(0);
    }
    finish(cmd);
    return;
  }
  out({ type: "response", command: cmd.type, id: cmd.id, success: true });
}

// 用户在 agent 还在回答时又发了一句（release review 2a）：agent 先说一句"我先去查一下"，
// 跑一个工具，等到一条插话（最多 8 秒）以后才回答插话。回答也分两条消息：先说"收到"，再给结果。
function answerSteer(cmd: any): void {
  out({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: "我先去查一下。" }],
    api: "fake", provider: "fake", model: "fake-1", stopReason: "toolUse", timestamp: Date.now(),
  } });
  out({ type: "tool_execution_start", toolCallId: "call-look", toolName: "read", args: { path: "README.md" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = () => {
    onSteer = null;
    if (timer) clearTimeout(timer);
    out({ type: "tool_execution_end", toolCallId: "call-look", toolName: "read", result: { content: [{ type: "text", text: "file" }] }, isError: false });
    out({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "收到，我再看一眼。" }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "toolUse", timestamp: Date.now(),
    } });
    out({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: `answered: ${steers.at(-1) ?? String(cmd.message).slice(0, 20)}` }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "stop", timestamp: Date.now(),
    } });
    out({ type: "agent_end", messages: [] });
  };
  if (steers.length > 0) { answer(); return; }
  onSteer = answer;
  timer = setTimeout(answer, 8000);
}

function holdForProfile(): void {
  const call = (text: string, stopReason: string) => out({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], api: "fake", provider: "fake", model, stopReason, timestamp: Date.now(),
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  } });
  call(`working with ${model} at ${thinking}`, "toolUse");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = () => {
    onProfile = null;
    if (timer) clearTimeout(timer);
    if (scenario === "hold_for_profile_then_fail") {
      errorMessageEnd(`The '${model}' model is not supported when using Codex with a ChatGPT account.`);
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled", aborted: false });
      return;
    }
    call(`finished with ${model} at ${thinking}`, "stop");
    out({ type: "agent_end", messages: [] });
  };
  onProfile = answer;
  timer = setTimeout(answer, 10_000);
}

function finish(cmd: any): void {
  if (scenario === "tool") {
    out({ type: "tool_execution_start", toolCallId: "child-call", toolName: "read", args: { path: "/tmp/input" } });
    out({ type: "tool_execution_update", toolCallId: "child-call", toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
    out({ type: "tool_execution_end", toolCallId: "child-call", toolName: "read", result: { content: [{ type: "text", text: "done" }] }, isError: false });
  }
  // 工单 #66 复核 F5：带工具的回合有多条助手消息。先说一句"我去查"，跑一个工具，最后才是回答。
  if (scenario === "narrate_then_answer") {
    out({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "我先去跑一遍验收门。" }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "toolUse", timestamp: Date.now(),
    } });
    out({ type: "tool_execution_start", toolCallId: "call-gate", toolName: "bash", args: { command: "vitest run" } });
    out({ type: "tool_execution_end", toolCallId: "call-gate", toolName: "bash", result: { content: [{ type: "text", text: "158 passed" }] }, isError: false });
  }
  // 工单 #102：一个回合两次模型调用，每条助手消息带它自己那一次调用的用量（不是累计）。
  if (scenario === "usage_two_calls") {
    out({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "我先读一下代码。" }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 40_000, output: 1_000, cacheRead: 18_000, cacheWrite: 152, totalTokens: 59_152,
        cost: { input: 0.002, output: 0.001, cacheRead: 0.001, cacheWrite: 0, total: 0.004 } },
    } });
    out({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "README.md" } });
    out({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", result: { content: [{ type: "text", text: "file" }] }, isError: false });
  }
  // 工单 13：一个工具调用成功，一个失败（isError 为 true）。
  if (scenario === "tools") {
    out({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "README.md" } });
    out({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", result: { content: [{ type: "text", text: "file" }] }, isError: false });
    out({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "npm test" } });
    out({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", result: { content: [{ type: "text", text: "Exit code 1" }] }, isError: true });
  }
  out({ type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "done: " + cmd.message.slice(0, 20) }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  } });
  out({ type: "agent_end", messages: [] });
}

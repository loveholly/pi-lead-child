// 工单 13（spec D8）：每个登记的 adapter 用自己的 fake CLI 跑同一组合约用例。
// 新增一个 runtime 时，在 FAKES 里加上它的 ContractFake。没有 ContractFake 的 adapter 让这个文件直接失败。
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClaudeRuntimeOptions } from "../src/claude.js";
import type { CodexRuntimeOptions } from "../src/codex.js";
import type { PiRuntimeOptions } from "../src/pi.js";
import type { RuntimeStartRequest } from "../src/types.js";
import { runtimeAdapters } from "../src/registry.js";
import { describeAdapterContract, readJson, type ContractFake } from "../testing/runtime-adapter-contract.js";

const TSX = resolve("node_modules/.bin/tsx");

// 同一个 ChatGPT 后端的历史原文（runs 35、12、55）。Codex 和 pi 的样本都用它们。
const OUT_OF_CREDITS = "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";
const MODEL_UNSUPPORTED = "The 'openai/gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
const AT_CAPACITY = "Selected model is at capacity. Please try a different model.";

// Codex 的原生样本取自历史失败（packages/runtime/testing/fixtures/runtime-failures.json）。fake 先在 stderr 打出与失败无关的
// refresh token 报错，再在 JSONL 里给出终止错误。证据里要有这段 stderr，分类却不能用它。
const codex: ContractFake<CodexRuntimeOptions> = {
  options: (scenario, env, tuning) => ({
    bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
    env: { FAKE_CODEX_SCENARIO: scenario, ...env }, killGraceMs: tuning?.killGraceMs ?? 200,
    // 合约核对提示词原样送到 CLI。Codex 在新会话的提示词末尾列出 PLC 内置的 skill，那一段在 codex-runtime.test.ts 里核对。
    childSkillsRoot: null,
  }),
  missingExecutable: () => ({ bin: "/definitely/missing/codex" }),
  scenarios: {
    complete: "happy",
    tools: "tools",
    malformedTolerated: "malformed-tolerated",
    malformedFlood: "malformed-excess",
    missingResult: "no-turn-completed",
    capture: "happy",
    interrupt: "interrupt",
  },
  captureVariable: "FAKE_CODEX_CAPTURE",
  readCapture(file) {
    const captured = readJson(file);
    return {
      argv: captured.args, prompt: captured.args.at(-1) ?? null, values: captured.values,
      loaded: { user: captured.mcpServers.filter((name: string) => name !== "plc"), plc: captured.mcpServers.includes("plc") },
    };
  },
  markerEnv: (file) => ({ FAKE_CODEX_READY_FILE: file, FAKE_CODEX_SIGNAL_FILE: file }),
  resume: { args: (_request, sessionId) => ["resume", sessionId] },
  userConfig: {
    variable: "CODEX_HOME",
    write: (dir, name) => writeFileSync(join(dir, "config.toml"), `[mcp_servers.${name}]\ncommand = "npx"\nargs = ["${name}-mcp"]\n`),
  },
  failures: [
    { scenario: "out-of-credits", code: "out_of_credits", evidence: ["--- stderr ---"], historical: { run: 35, text: OUT_OF_CREDITS } },
    { scenario: "token-revoked", code: "auth_required", evidence: ["--- stderr ---"], historical: { run: 55, text: "refresh token was revoked" } },
    { scenario: "model-unsupported", code: "model_unsupported", evidence: ["--- stderr ---"], historical: { run: 12, text: MODEL_UNSUPPORTED } },
    { scenario: "proxy-unknown-model", code: "model_unsupported", evidence: ["--- stderr ---"], historical: { run: 62, text: "unknown provider for model gpt-5.4-mini" } },
    { scenario: null, code: "executable_missing", evidence: [], historical: { run: 39, text: "ENOENT" } },
    { scenario: "plc-required-stderr", code: "tool_channel_unavailable", evidence: ["required MCP servers failed to initialize"] },
    { scenario: "plc-required-error", code: "tool_channel_unavailable", evidence: ["required MCP servers failed to initialize"] },
    { scenario: "capacity", code: "provider_overloaded", evidence: ["--- stderr ---"], historical: { run: 55, text: AT_CAPACITY } },
    { scenario: "network", code: "network_error", evidence: ["--- stderr ---"], historical: { run: 64, text: "Reconnecting... waiting for network (Connection failed: error sending request)" } },
    { scenario: "workspace-deactivated", code: "account_deactivated", evidence: ["--- stderr ---", "deactivated_workspace"] },
    { scenario: "nonzero", code: "unknown", evidence: ["Codex exited with code 7", "fatal from codex"] },
  ],
};

// Claude Code 的认证样本取自历史失败（runs 46、47、63）。其余样本的文本取自 Claude Code 2.1.258 二进制里的字符串。
const claude: ContractFake<ClaudeRuntimeOptions> = {
  options: (scenario, env, tuning) => ({
    bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-claude.ts")],
    env: { FAKE_CLAUDE_SCENARIO: scenario, ...env }, killGraceMs: tuning?.killGraceMs ?? 200,
  }),
  missingExecutable: () => ({ bin: "/definitely/missing/claude" }),
  scenarios: {
    complete: "happy",
    tools: "tools",
    malformedTolerated: "malformed-tolerated",
    malformedFlood: "malformed-hang",
    missingResult: "missing-result",
    capture: "inspect",
    interrupt: "ignore-term",
  },
  captureVariable: "FAKE_CLAUDE_CAPTURE",
  readCapture(file) {
    const captured = readJson(file);
    const servers: string[] = captured.mcpServers.map((server: { name: string }) => server.name);
    return {
      argv: captured.argv, prompt: captured.prompt, values: captured.values,
      loaded: { user: servers.filter((name) => name !== "plc"), plc: servers.includes("plc") },
    };
  },
  markerEnv: (file) => ({ FAKE_CLAUDE_MARKER: file }),
  resume: { args: (_request, sessionId) => ["--resume", sessionId] },
  userConfig: {
    variable: "CLAUDE_CONFIG_DIR",
    write: (dir, name) => writeFileSync(join(dir, ".claude.json"), JSON.stringify({
      mcpServers: { [name]: { type: "http", url: "https://mcp.example.test" } },
    })),
  },
  failures: [
    { scenario: "credit-low", code: "out_of_credits", evidence: ["Credit balance is too low"] },
    { scenario: "auth-expired", code: "auth_required", evidence: [], historical: { run: 46, text: "Failed to authenticate: OAuth session expired and could not be refreshed" } },
    { scenario: "model-missing", code: "model_unsupported", evidence: ["issue with the selected model"] },
    { scenario: null, code: "executable_missing", evidence: ["ENOENT"] },
    { scenario: "overloaded", code: "provider_overloaded", evidence: ["Repeated 529 Overloaded errors"] },
    { scenario: "connection-lost", code: "network_error", evidence: ["Connection to the API was lost (ECONNRESET)"] },
    { scenario: "max-turns", code: "task_failed", evidence: ["error_max_turns"] },
    { scenario: "exit-error", code: "unknown", evidence: ["Claude exited with code 7", "fatal diagnostic"] },
  ],
};

// pi 1.1.0 的 session 文件名是"时间戳_session id.jsonl"，放在 --session-dir 里。
const piSessionFile = (request: RuntimeStartRequest, sessionId: string): string =>
  join(request.sessionDir!, `2026-10-11T00-00-00-000Z_${sessionId}.jsonl`);

// pi 的样本见 test/fake-pi.ts。历史上 pi 只有安装类失败（runs 14、15、23、52、59）。
// LLM 错误的文本取自同一个 ChatGPT 后端的历史失败，以及 pi-coding-agent 1.1.0 的代码。
const pi: ContractFake<PiRuntimeOptions> = {
  options: (scenario, env, tuning) => ({
    bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_SCENARIO: scenario, ...env },
    killGraceMs: tuning?.killGraceMs ?? 200,
  }),
  missingExecutable: () => ({ bin: "/definitely/missing/pi" }),
  scenarios: {
    complete: "happy",
    tools: "tools",
    malformedTolerated: "malformed_tolerated",
    malformedFlood: "malformed_hang",
    missingResult: "exit_before_end",
    capture: "happy",
    interrupt: "ignore_term",
  },
  captureVariable: "FAKE_PI_CAPTURE",
  readCapture(file) {
    const captured = readJson(file);
    const plc = captured.extensions.some((path: string) => path.endsWith("/src/extension/ticket-tools.ts"));
    return {
      argv: captured.args, prompt: captured.prompt ?? null, values: captured.values,
      loaded: { user: captured.userExtensions, plc },
    };
  },
  markerEnv: (file) => ({ FAKE_PI_MARKER: file }),
  resume: {
    // pi 按 session 文件 resume（--session <文件>）。文件在这个 Run 的 session 目录里，第一行是 session 头。
    prepare(request, sessionId) {
      mkdirSync(request.sessionDir!, { recursive: true });
      writeFileSync(piSessionFile(request, sessionId), `${JSON.stringify({
        type: "session", version: 3, id: sessionId, timestamp: "2026-10-11T00:00:00.000Z", cwd: request.workdir,
      })}\n`);
    },
    args: (request, sessionId) => ["--session", piSessionFile(request, sessionId)],
  },
  userConfig: {
    variable: "PI_CODING_AGENT_DIR",
    write(dir, name) {
      mkdirSync(join(dir, "extensions"), { recursive: true });
      writeFileSync(join(dir, "extensions", `${name}.ts`), "export default function () {}\n");
    },
  },
  failures: [
    { scenario: "llm_out_of_credits", code: "out_of_credits", evidence: [], historical: { run: 35, text: OUT_OF_CREDITS } },
    { scenario: "prompt_auth", code: "auth_required", evidence: ["Authentication failed for \"openai-codex\""] },
    { scenario: "llm_model_unsupported", code: "model_unsupported", evidence: [], historical: { run: 12, text: MODEL_UNSUPPORTED } },
    { scenario: null, code: "executable_missing", evidence: ["ENOENT"] },
    { scenario: "extension_missing", code: "extension_missing", evidence: [], historical: { run: 14, text: "Extension path does not exist" } },
    { scenario: "crash_stderr", code: "interpreter_mismatch", evidence: [], historical: { run: 52, text: "createZstdDecompress is not a function" } },
    { scenario: "llm_capacity", code: "provider_overloaded", evidence: [], historical: { run: 55, text: AT_CAPACITY } },
    { scenario: "llm_network", code: "network_error", evidence: ["fetch failed"] },
    { scenario: "crash", code: "unknown", evidence: ["Pi process exited before agent_end (1)"] },
    { scenario: "llm_unrecognized", code: "unknown", evidence: ["the model refused the request shape"] },
  ],
};

const FAKES: Record<string, ContractFake<any>> = { codex, claude, pi };

for (const adapter of runtimeAdapters()) {
  const fake = FAKES[adapter.id];
  if (!fake) throw new Error(`runtime '${adapter.id}' has no fake CLI for the adapter contract`);
  describeAdapterContract(adapter, fake);
}

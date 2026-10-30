import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout, setTimeout } from "node:timers";
import { AsyncEventQueue, RuntimeEventSequencer } from "./event-queue.js";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventInput,
  RuntimeExit,
  RuntimeHandle,
  RuntimePreflightRequest,
  RuntimeProbeRequest,
  RuntimeProbeResult,
  RuntimeAttachRequest,
  RuntimeStartRequest,
} from "./types.js";
import { runInstallChecks, type ProbeCommand, type ProbeStep } from "./probe.js";
import type { RuntimeAdapter, RuntimeEnv } from "./types.js";
import { findRuntimeExecutable, resolveRuntimeExecutable } from "./executable.js";
import {
  cliEffortValue, parseCodexConfigModel, parseCodexModelCatalog, runDiscoveryCommand, type ModelDiscovery,
} from "./model-discovery.js";
import {
  matchProviderFailure, residualFailureCode, typedFailure, type FailureEvidence,
} from "./typed-failure.js";
import type { TypedFailure } from "@pi-lead-child/core";
import { adapterProfile, type RuntimeProfile } from "./profile.js";
import { childEnvironment, isVariableName } from "./environment.js";
import { attachProcess, launchProcess, type LaunchedProcess } from "./launcher.js";
import { codexChildSkillListing, defaultChildSkillsRoot } from "./child-skills.js";

const MAX_MALFORMED_LINES = 3;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_STDERR_TAIL_CHARS = 16_000;

export interface CodexRuntimeOptions {
  bin?: string;
  prefixArgs?: string[];
  env?: Record<string, string>;
  killGraceMs?: number;
  // PLC 内置给 child 的 skill（child-skills.ts）的根目录。不给时用 engine 的 src/child-skills，null 表示不加载。
  childSkillsRoot?: string | null;
}

interface RuntimeFailure {
  code: string;
  message: string;
}

type JsonRecord = Record<string, unknown>;

// Codex 把失败写在 JSONL 的 error / turn.failed 事件里，那段文本是可信的终止原因。
// stderr 只作证据，不参与分类。历史上 Codex 的 stderr 常带与失败无关的报错，例如模型缓存
// 和 refresh token 被吊销。拿它分类，会把满载和断网误判成账号故障（run 55、64）。
export function classifyCodexFailure(evidence: FailureEvidence): TypedFailure {
  if (REQUIRED_TOOL_CHANNEL_FAILED.test(evidence.message ?? "")) return typedFailure("tool_channel_unavailable", evidence);
  if (SESSION_NOT_FOUND.test(evidence.message ?? "")) return typedFailure("session_not_found", evidence);
  // 例外：进程在会话初始化时退出、JSONL 里没有终止错误时，stderr 里的这两句就是终止原因。
  // 它们只在 required 的 MCP 服务器起不来、或者要 resume 的会话不存在时出现，不会是无关的噪声。
  if (evidence.errorCode === "process_exit" && REQUIRED_TOOL_CHANNEL_FAILED.test(evidence.stderr ?? "")) {
    return typedFailure("tool_channel_unavailable", evidence);
  }
  if (evidence.errorCode === "process_exit" && SESSION_NOT_FOUND.test(evidence.stderr ?? "")) {
    return typedFailure("session_not_found", evidence);
  }
  // 终止错误自带的错误码（例如 deactivated_workspace）和文本一样可信。
  const providerCode = matchProviderFailure(evidence.message) ?? matchProviderFailure(evidence.errorCode);
  return typedFailure(providerCode ?? residualFailureCode(evidence), evidence);
}

// plc 设成了 required（buildArgs）。它起不来时，Codex 在会话初始化阶段报这句话并退出（工单 05）。
// 文本取自 codex-cli 0.153.3 的二进制。它走 JSONL 还是 stderr 没有用真实 CLI 核实，所以两处都认。
const REQUIRED_TOOL_CHANNEL_FAILED = /required MCP servers? failed to initialize/i;

// 要 resume 或 fork 的会话已经不存在：会话记录（rollout）被删掉了（工单 #66）。
// 按 codex-cli 0.162.1 核实：exec resume 一个不存在的 thread 时，stdout 没有 JSONL，stderr 一行
// "Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)"，退出码 1。
// exec fork 的文本相同，只是 resume 换成 fork。
// 二进制里还有旧的写法 "no rollout found for conversation id" 和 "No saved session found with ID"，三种都认。
const SESSION_NOT_FOUND = /no rollout found for (?:thread|conversation) id|no saved session found with id/i;

// 会话不存在时，Codex 只在 stderr 里说明原因。错误文本用这一行，人能看懂发生了什么。
function sessionNotFoundLine(stderr: string): string | null {
  return stderr.split(/\r?\n/).find((line) => SESSION_NOT_FOUND.test(line))?.trim() ?? null;
}

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    steering: false,
    resume: true,
    interrupt: true,
    approvals: false,
    mcp: true,
    executableReadOnlyReview: true,
  };

  private readonly bin: string;
  private readonly prefixArgs: string[];
  private readonly env: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly childSkillsRoot: string | null;

  constructor(options: CodexRuntimeOptions = {}) {
    this.bin = options.bin ?? "codex";
    this.prefixArgs = [...(options.prefixArgs ?? [])];
    this.env = { ...(options.env ?? {}) };
    this.killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.childSkillsRoot = options.childSkillsRoot === undefined ? defaultChildSkillsRoot() : options.childSkillsRoot;
  }

  // 模型目录（工单 05）：Codex 只接受 OpenAI 的模型。派发请求时，resolveRuntimeModel 已经执行这条规则。
  // 它把 openai/… 换成 Codex 的原生模型名，所以 preflight 看到的是原生名。
  get profile(): RuntimeProfile {
    return adapterProfile("codex", this.bin, this.env, {
      models: { defaultModel: codexDefaultModel() ?? null, providers: ["openai"] },
    });
  }

  // 探针和 child 用同一个环境（工单 10）。
  private probeCommand(signal?: AbortSignal): ProbeCommand {
    return {
      bin: this.bin, prefixArgs: this.prefixArgs, env: childEnvironment(this.profile.environment, this.env), signal,
    };
  }

  private readonly versionStep: ProbeStep = {
    label: "codex --version", args: ["--version"], failure: "runtime_start_failed", keepStderr: true,
  };

  // preflight（工单 05）：只检查安装，不检查登录。
  preflight(request: RuntimePreflightRequest): Promise<RuntimeProbeResult> {
    return runInstallChecks(this.probeCommand(request.signal), [this.versionStep], this.profile.interpreter);
  }

  // 健康探针（工单 04），按 codex-cli 0.153.3 核实：`login status` 已登录时退出码 0，未登录时 1。
  // 两条命令都不发起模型调用。余额是否用完，探针看不出来：探针通过就关闭故障，余额还没充时下一个 Run 失败，
  // 故障重新开启，退避加倍（store 的 runtime-health.ts）。安装检查和 preflight 共用。
  probe(request: RuntimeProbeRequest): Promise<RuntimeProbeResult> {
    return runInstallChecks(this.probeCommand(request.signal), [
      this.versionStep,
      { label: "codex login status", args: ["login", "status"], failure: "auth_required" },
    ], this.profile.interpreter);
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const model = resolveCodexModel(request.model ?? codexDefaultModel());
    // PLC 内置的 skill（child-skills.ts）：Codex 没有每次运行加 skill 的参数，列在新会话的提示词末尾。
    // 续接和分叉的会话里已经有这一段。
    const listing = request.resumeSessionId ? "" : codexChildSkillListing(this.childSkillsRoot, request.role);
    const nativeRequest = {
      ...request, ...(model === request.model ? {} : { model }), ...(listing ? { prompt: `${request.prompt}\n\n${listing}` } : {}),
    };
    const env = childEnvironment(this.profile.environment, this.env, request.env);
    const mcpEnvNames = request.mcpServer ? forwardMcpEnv(request.mcpServer, env) : [];
    const args = [...this.prefixArgs, ...buildArgs(nativeRequest, mcpEnvNames)];
    // CLI 经启动垫片运行（工单 14）。daemon 进程退出时，Codex 不会因为管道断开而退出。
    const child = await launchProcess({
      runId: request.runId, command: this.bin, args, env, baseDir: request.launchDir,
    });
    // fork 的 thread 是新的，它的 id 由 thread.started 报告。在那之前不能把原 thread 当成这个 Run 的 session。
    return this.supervise(child, {
      runId: request.runId, model, resumeSessionId: request.forkSession ? undefined : request.resumeSessionId,
    });
  }

  // 接管 daemon 重启前启动的 Codex（工单 15）。解析和 start 相同，从输出文件的开头重放，
  // 所以重新产生的事件和原来的事件 seq 相同。
  async attach(request: RuntimeAttachRequest): Promise<RuntimeHandle> {
    return this.supervise(attachProcess(request.launch, { hasStdin: false }), {
      runId: request.runId, model: request.model, resumeSessionId: request.resumeSessionId,
    });
  }

  private supervise(
    child: LaunchedProcess,
    context: { runId: number; model: string | undefined; resumeSessionId?: string },
  ): RuntimeHandle {
    const model = context.model;
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const sequencer = new RuntimeEventSequencer(context.runId);
    let externalSessionId = context.resumeSessionId ?? null;
    let failure: RuntimeFailure | null = null;
    let stderrTail = "";
    let interruptedReason: string | null = null;
    let malformedLines = 0;
    // codex exec 的回合以 turn.completed 结束。进程以 0 退出却没有它时，这个 Run 没有结果（工单 13）。
    let turnCompleted = false;
    let closed = false;
    let spawnFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveExit!: (exit: RuntimeExit) => void;
    const exitPromise = new Promise<RuntimeExit>((resolve) => {
      resolveExit = resolve;
    });

    const emit = (event: RuntimeEventInput): void => {
      if (sequencer.hasTerminalEvent) return;
      queue.push(sequencer.event(event));
    };

    const fail = (code: string, message: string, exitCode: number | null): void => {
      failure ??= { code, message };
      emit({
        type: "run.failed", exitCode, errorCode: failure.code, error: failure.message,
        failure: classifyCodexFailure({ errorCode: failure.code, message: failure.message, stderr: stderrTail }),
      });
    };

    const terminate = (): void => {
      if (closed) return;
      child.kill("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, this.killGraceMs);
    };

    const parseItem = (nativeType: string, item: JsonRecord): void => {
      const itemId = stringField(item, "id") ?? "codex-item";
      const itemType = stringField(item, "type");

      if (itemType === "agent_message") {
        const text = stringField(item, "text") ?? "";
        if (nativeType === "item.started") {
          if (text) emit({ type: "message.delta", messageId: itemId, delta: text });
          return;
        }
        emit({
          type: "message.completed",
          messageId: itemId,
          role: "assistant",
          text,
          ...(stringField(item, "stop_reason") ? { stopReason: stringField(item, "stop_reason")! } : {}),
        });
        return;
      }

      if (itemType === "command_execution") {
        const command = stringField(item, "command") ?? "";
        const cwd = stringField(item, "cwd");
        const toolArgs = cwd ? { command, cwd } : { command };
        if (nativeType === "item.started") {
          emit({ type: "tool.started", callId: itemId, name: "command_execution", args: toolArgs });
          return;
        }

        const exitCode = numberField(item, "exit_code");
        const status = stringField(item, "status") ?? "completed";
        if (status === "failed" || (exitCode !== null && exitCode !== 0) || hasValue(item.error)) {
          emit({
            type: "tool.failed",
            callId: itemId,
            name: "command_execution",
            error: errorText(item.error)
              ?? stringField(item, "aggregated_output")
              ?? (exitCode === null ? "command failed" : `command exited with code ${exitCode}`),
          });
          return;
        }

        emit({
          type: "tool.completed",
          callId: itemId,
          name: "command_execution",
          result: {
            status,
            exitCode,
            output: stringField(item, "aggregated_output") ?? "",
          },
        });
        return;
      }

      if (itemType === "mcp_tool_call") {
        const server = stringField(item, "server") ?? stringField(item, "server_name");
        const tool = stringField(item, "tool") ?? stringField(item, "tool_name") ?? "mcp_tool_call";
        const name = server ? `${server}.${tool}` : tool;
        const toolArgs = item.arguments ?? item.args ?? null;
        if (nativeType === "item.started") {
          emit({ type: "tool.started", callId: itemId, name, args: toolArgs });
          return;
        }

        const status = stringField(item, "status") ?? "completed";
        if (status === "failed" || hasValue(item.error)) {
          emit({
            type: "tool.failed",
            callId: itemId,
            name,
            error: errorText(item.error) ?? "MCP tool call failed",
          });
          return;
        }
        emit({
          type: "tool.completed",
          callId: itemId,
          name,
          result: item.result ?? item.output ?? null,
        });
      }
    };

    const parseEvent = (value: unknown): void => {
      if (!isRecord(value)) return;
      const nativeType = stringField(value, "type");
      switch (nativeType) {
        case "thread.started": {
          const threadId = stringField(value, "thread_id");
          if (!threadId) return;
          externalSessionId = threadId;
          emit({ type: "session.updated", externalSessionId: threadId });
          return;
        }
        case "turn.started":
          return;
        case "item.started":
        case "item.completed":
          if (isRecord(value.item)) parseItem(nativeType, value.item);
          return;
        case "turn.completed": {
          turnCompleted = true;
          if (!isRecord(value.usage)) return;
          const inputTokens = numberField(value.usage, "input_tokens") ?? 0;
          const outputTokens = numberField(value.usage, "output_tokens") ?? 0;
          const totalTokens = numberField(value.usage, "total_tokens") ?? inputTokens + outputTokens;
          emit({
            type: "usage.updated",
            mode: "cumulative",
            inputTokens,
            outputTokens,
            totalTokens,
            costUsd: null,
          });
          return;
        }
        case "error": {
          const nativeError = isRecord(value.error) ? value.error : value;
          const code = stringField(nativeError, "code") ?? "codex_error";
          const message = stringField(nativeError, "message") ?? "Codex reported an error";
          fail(code, message, null);
          return;
        }
        case "turn.failed": {
          const nativeError = isRecord(value.error) ? value.error : value;
          const code = stringField(nativeError, "code") ?? "turn_failed";
          const message = stringField(nativeError, "message") ?? "Codex turn failed";
          fail(code, message, null);
          return;
        }
      }
    };

    const parseLine = (rawLine: string): void => {
      if (sequencer.hasTerminalEvent) return;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;
      try {
        parseEvent(JSON.parse(line));
      } catch {
        malformedLines += 1;
        const excerpt = line.slice(0, MAX_DIAGNOSTIC_CHARS);
        emit({
          type: "runtime.stderr",
          text: `malformed Codex JSONL line ${malformedLines}: ${excerpt}\n`,
        });
        if (malformedLines > MAX_MALFORMED_LINES) {
          fail("malformed_output", `Codex emitted more than ${MAX_MALFORMED_LINES} malformed JSONL lines`, null);
          terminate();
        }
      }
    };

    const decoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += decoder.write(chunk);
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        parseLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stdout?.on("end", () => {
      stdoutBuffer += decoder.end();
      if (stdoutBuffer) parseLine(stdoutBuffer);
      stdoutBuffer = "";
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      stderrTail = `${stderrTail}${text}`.slice(-MAX_STDERR_TAIL_CHARS);
      emit({ type: "runtime.stderr", text });
    });

    child.once("error", (error) => {
      spawnFailed = true;
      fail("spawn_error", error.message, null);
    });

    child.once("close", (code, signal) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);

      if (interruptedReason) {
        fail("interrupted", interruptedReason, code);
      } else if (!failure && code === 0 && signal === null && turnCompleted) {
        emit({ type: "run.completed", exitCode: 0 });
      } else if (!failure && code === 0 && signal === null) {
        fail("missing_result", "Codex exited without turn.completed", 0);
      } else if (!failure) {
        const message = signal
          ? `Codex exited from signal ${signal}`
          : sessionNotFoundLine(stderrTail) ?? `Codex exited with code ${code ?? "unknown"}`;
        fail("process_exit", message, code);
      }

      queue.end();
      const finalFailure = failure;
      resolveExit({
        ok: !finalFailure && !interruptedReason && code === 0 && signal === null,
        exitCode: spawnFailed ? null : code,
        signal: signal as NodeJS.Signals | null,
        externalSessionId,
        errorCode: finalFailure?.code ?? null,
        errorMessage: finalFailure?.message ?? null,
      });
    });

    emit({ type: "run.started", runtime: "codex", model: model ?? null });

    return {
      pid: child.pid ?? null,
      process: child,
      events: queue,
      interrupt: async (reason: string): Promise<void> => {
        if (!closed && !interruptedReason) {
          interruptedReason = reason;
          terminate();
        }
        await exitPromise;
      },
      wait: () => exitPromise,
    };
  }
}

// plc 的 MCP 服务器要的变量（含工具桥 token）不写进 argv（工单 10）。
// 2026-10-10 按 codex-cli 0.153.3 核实：Codex 只把下面三类变量转发给 MCP 服务器。
// - 少数默认变量，例如 HOME、PATH、TMPDIR。
// - mcp_servers.<名字>.env 里写明的值。
// - mcp_servers.<名字>.env_vars 点名的变量。
// 核实方法：CODEX_HOME 指向空的临时目录，模型 provider 指向本机一个关闭的端口。这样不发起模型调用。
// 一个只记录环境的 MCP 服务器收到了 env_vars 点名的变量。它没有收到没点名的变量。
// 所以这里把值写进 Codex 进程的环境（env），返回变量名。argv 里只写变量名。
function forwardMcpEnv(server: NonNullable<RuntimeStartRequest["mcpServer"]>, env: Record<string, string>): string[] {
  const names = Object.keys(server.env ?? {}).sort();
  for (const name of names) {
    if (!isVariableName(name)) throw new Error(`MCP 服务器的变量名不合法：${JSON.stringify(name)}`);
    const value = server.env![name]!;
    // 内核给 child 和 MCP 服务器的同名变量取值相同。不同时无法只用变量名转发，所以拒绝启动。
    if (env[name] !== undefined && env[name] !== value) {
      throw new Error(`MCP 服务器的变量 ${name} 和 Codex 进程的同名变量取值不同`);
    }
    env[name] = value;
  }
  return names;
}

// mcpEnvNames 是 forwardMcpEnv 写进 Codex 进程环境的变量名。
function buildArgs(request: RuntimeStartRequest, mcpEnvNames: string[]): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox", request.role === "reviewer" ? "read-only" : "workspace-write",
    "-c", 'approval_policy="never"',
    "--skip-git-repo-check",
    "--cd", request.workdir,
  ];

  if (request.model) args.push("--model", request.model);
  // Codex 的推理强度是配置项 model_reasoning_effort（~/.codex/config.toml 里同名；档位见 codex debug models）。
  const effort = cliEffortValue(request.effort);
  if (effort) args.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
  if (request.mcpServer) {
    args.push("-c", `mcp_servers.plc.command=${tomlString(request.mcpServer.command)}`);
    args.push("-c", `mcp_servers.plc.args=${JSON.stringify(request.mcpServer.args)}`);
    args.push("-c", "mcp_servers.plc.required=true");
    args.push("-c", 'mcp_servers.plc.default_tools_approval_mode="approve"');
    if (mcpEnvNames.length) args.push("-c", `mcp_servers.plc.env_vars=${JSON.stringify(mcpEnvNames)}`);
  }

  // exec fork 在副本上开一个新 thread，原 thread 不变（codex-cli 0.162.1 的 --help）。
  if (request.resumeSessionId) args.push(request.forkSession ? "fork" : "resume", request.resumeSessionId);
  args.push(request.prompt);
  return args;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonRecord, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberField(value: JsonRecord, key: string): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
}

function errorText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringField(value, "message") ?? stringField(value, "error");
  return null;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

// ── registry 的登记项（spec D8，工单 12）──────────────────────────────────────
// 模型规则以前在 model.ts 里按 runtime 名字分支，现在由 Codex adapter 自己声明。

// 没有配置 PLC_CODEX_MODEL 时不传 --model，由 Codex 用自己的配置（~/.codex/config.toml 的 model）。
// 以前这里写死 openai/gpt-5.5，还把 gpt-5.6-sol 改写成 gpt-5.5。2026-10 账号不再支持 gpt-5.5，
// 工单 #66 的核查连续失败 7 次（Run #73–#79），而用户自己的 Codex 配置是 gpt-6.1-sol。
export function codexDefaultModel(env: RuntimeEnv = process.env): string | undefined {
  return env.PLC_CODEX_MODEL?.trim() || undefined;
}

// 工具输入用 provider/model，这样 pi 能按 provider 路由。Codex 的 ChatGPT 账号 CLI 只认原生模型名。
// 所以在创建 Run 之前就转换结构化的选择，不让进程之后才崩溃。
function nativeCodexModel(value: string): string {
  const separator = value.indexOf("/");
  if (separator === -1) return value;
  const provider = value.slice(0, separator).toLowerCase();
  const nativeModel = value.slice(separator + 1);
  if (provider !== "openai" || !nativeModel) {
    throw new Error(
      `runtime 'codex' cannot use model '${value}'; use a native Codex model id from \`codex debug models\``,
    );
  }
  return nativeModel;
}

export function resolveCodexModel(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  return value ? nativeCodexModel(value) : undefined;
}

// `codex debug models`：账号可用的模型目录，带每个模型的 effort 档位（codex-cli 0.162.1）。
// CLI 自己的默认模型读 $CODEX_HOME/config.toml 顶层的 model 一行；那个文件不放凭据，凭据在 auth.json。
async function discoverCodexModels(context: { env?: RuntimeEnv; timeoutMs?: number }): Promise<ModelDiscovery> {
  const source = "codex debug models";
  const bin = findRuntimeExecutable(codexBin());
  if (!bin) return { ok: false, error: "codex executable not found", source };
  try {
    const models = parseCodexModelCatalog(await runDiscoveryCommand({ bin, env: context.env, timeoutMs: context.timeoutMs }, ["debug", "models"]));
    if (models.length === 0) return { ok: false, error: "codex debug models lists no models", source };
    const efforts = models.flatMap((model) => model.efforts).filter((value, index, all) => all.indexOf(value) === index);
    return {
      ok: true, models, efforts, cliDefaultModel: codexConfigModel(context.env ?? process.env), source,
      account: "Codex 内置的订阅账号", freeformModelPattern: null,
    };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error).slice(0, 300), source };
  }
}

function codexConfigModel(env: RuntimeEnv): string | null {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try { return parseCodexConfigModel(readFileSync(join(home, "config.toml"), "utf8")); } catch { return null; }
}

// 没有指定可执行文件时，用 PLC_CODEX_BIN，再找 PATH 上的 codex。目录和实例用同一条规则。
function codexBin(): string {
  return process.env.PLC_CODEX_BIN ?? "codex";
}

export const codexAdapter: RuntimeAdapter<CodexRuntimeOptions> = {
  id: "codex",
  displayName: "Codex",
  // 能力只在 CodexRuntime 里声明一次。
  capabilities: new CodexRuntime().capabilities,
  models: { defaultModel: codexDefaultModel, resolve: nativeCodexModel },
  reportsCost: false,
  classifyFailure: classifyCodexFailure,
  locateExecutable: () => findRuntimeExecutable(codexBin()),
  discoverModels: (context) => discoverCodexModels(context),
  create: (options) => new CodexRuntime({
    ...options,
    bin: resolveRuntimeExecutable(options?.bin ?? codexBin()),
  }),
};

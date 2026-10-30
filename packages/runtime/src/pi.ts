import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageSource, projectRoot } from "@pi-lead-child/core";
import { RpcClient, type RpcResponse } from "./rpc-client.js";
import {
  cliEffortValue, parsePiModelList, parsePiSettingsDefault, parsePiThinkingLevels, piProviders, runDiscoveryCommand, type ModelDiscovery,
} from "./model-discovery.js";
import { AsyncEventQueue, RuntimeEventSequencer } from "./event-queue.js";
import type {
  AgentRuntime, RuntimeAttachRequest, RuntimeCapabilities, RuntimeEvent, RuntimeExit, RuntimeHandle,
  RuntimePreflightRequest, RuntimeProbeRequest, RuntimeProbeResult, RuntimeStartRequest,
} from "./types.js";
import {
  runInstallChecks, safeArgValue, statusJson, type ProbeCommand, type ProbeStep, type ProbeStepOutput,
} from "./probe.js";
import type { RuntimeAdapter, RuntimeEnv } from "./types.js";
import { findRuntimeExecutable } from "./executable.js";
import {
  matchProviderFailure, residualFailureCode, typedFailure, type FailureEvidence,
} from "./typed-failure.js";
import type { TypedFailure } from "@pi-lead-child/core";
import { adapterProfile, type RuntimeProfile } from "./profile.js";
import { childEnvironment } from "./environment.js";
import { daemonNodeLaunch, type RuntimeInterpreter } from "./interpreter.js";
import { attachProcess, launchProcess, type LaunchedProcess } from "./launcher.js";
import { createPiEventMapper } from "./pi-events.js";
import { defaultChildSkillsRoot, piChildSkillArgs } from "./child-skills.js";

export interface PiRuntimeOptions {
  bin?: string;
  prefixArgs?: string[];
  ticketToolsExtension?: string;
  webToolsExtension?: string;
  // 内置的 SoL-Pi 的执行器入口（engine 的 extension/sol-pi-executor.ts）。null 表示不加载。
  solPiExtension?: string | null;
  // 沙箱扩展（engine 的 extension/sandbox.ts，lead-tools-and-routing spec D2）：bash 在沙箱里跑，edit、write 只能写工作目录。
  // null 表示不加载（只给测试用）。
  sandboxExtension?: string | null;
  // PLC 内置给 child 的 skill（child-skills.ts）的根目录。不给时用 engine 的 src/child-skills，null 表示不加载。
  childSkillsRoot?: string | null;
  env?: Record<string, string>;
  additionalArgs?: string[];
  // 停止 pi 时，SIGTERM 之后等多久再发 SIGKILL。
  killGraceMs?: number;
}

// 畸形行（RPC 输出里不是 JSON 的行）的上限。超过时 Run 失败（工单 13 的合约用例）。
const MAX_MALFORMED_LINES = 8;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

// resume 要打开的 session 文件（工单 13）。pi 1.1.0 按文件路径打开 session（--session <文件>）。
// 不传 session id：在别的工作目录下找到这个 id 时，pi 在 stdin 上问要不要 fork。RPC 模式下 stdin 是协议，
// pi 读到的回答不是 y，于是打印 Aborted 并以 0 退出。2026-10-11 用真实的 pi 1.1.0 核实，只发了 get_state。
// session 头里的工作目录不存在时，pi 拒绝打开这个文件（退出码 1），所以这种文件不用。
// 找不到合适的文件时返回 null，pi 开一个新 session，和以前一样。
function resumableSessionFile(sessionDir: string, sessionId: string): string | null {
  let names: string[];
  try {
    names = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const path = join(sessionDir, name);
    const header = sessionHeader(path);
    if (header?.type !== "session" || header.id !== sessionId) continue;
    if (typeof header.cwd === "string" && !existsSync(header.cwd)) continue;
    return path;
  }
  return null;
}

// session 文件的第一行是 session 头（pi 1.1.0 的 docs/session-format.md）。只读文件开头的一段。
function sessionHeader(path: string): { type?: unknown; id?: unknown; cwd?: unknown } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    const newline = text.indexOf("\n");
    return JSON.parse(newline === -1 ? text : text.slice(0, newline));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// pi 进程在 agent_end 之前退出时，没有结构化的错误，只有退出码和 stderr。
// 所以 pi 的分类要读 stderr：扩展缺失和 Node 版本不符都只出现在那里（run 14、52）。
export function classifyPiFailure(evidence: FailureEvidence): TypedFailure {
  const text = `${evidence.message ?? ""}\n${evidence.stderr ?? ""}`;
  if (/extension path does not exist/i.test(text)) return typedFailure("extension_missing", evidence);
  // pi-coding-agent 1.1.0 自带的 undici 需要 Node 22.19 的 zlib.createZstdDecompress。
  if (/createZstdDecompress is not a function/i.test(text)) return typedFailure("interpreter_mismatch", evidence);
  if (PI_AUTH_FAILED.test(text)) return typedFailure("auth_required", evidence);
  const provider = matchProviderFailure(text);
  if (provider) return typedFailure(provider, evidence);
  if (PI_NETWORK_FAILED.test(text)) return typedFailure("network_error", evidence);
  return typedFailure(residualFailureCode(evidence), evidence);
}

// pi 自己写的认证错误，取自 pi-coding-agent 1.1.0 的代码（工单 13）：
// - 凭据过期或缺失："Authentication failed for "<provider>". … Run '/login <provider>' to re-authenticate."
// - 没有 API key："No API key found for <provider>."
// 这两句话出现在 prompt 的预检里，pi 不发起模型调用。通用的 provider 诊断认不出它们。
const PI_AUTH_FAILED = /authentication failed for "|no api key found for /i;
// pi-ai 1.1.0 用 fetch 访问 provider。断网时 undici 报 "fetch failed"，pi-ai 的 utils/retry.js 把它当作网络错误重试。
const PI_NETWORK_FAILED = /\bfetch failed\b/i;

// `pi auth check --json` 的判断。只读 status 和 reason：加 --credentials 才会输出凭据，探针从不加它。
function piAuthCheck(output: ProbeStepOutput): string | null {
  const check = statusJson(output.stdout);
  if (check?.status === "ready") return null;
  if (typeof check?.status === "string") {
    const reason = check.reason;
    return `未就绪${typeof reason === "string" && /^[\w-]{1,64}$/.test(reason) ? `（${reason}）` : ""}`;
  }
  return output.exitCode === 0 ? null : `退出码 ${output.exitCode}`;
}

// pi 当核查员时只给只读的工具（2026-10-20）。以前 pi 没有按角色的约束，所以不能当核查员；现在核查员可以是任何 runtime，
// 这里按 pi 1.1.0 的 docs/cli.md 限制工具：
//   - --tools 只写 +name 时是在缺省的工具上加减，不是白名单，所以 plc 的工单工具和 web 工具（扩展注册的）照样在；
//     加上只读的 grep、find、ls。
//   - --exclude-tools 在所有选择之后生效，扩展注册的同名工具也去掉：bash、powershell（不能运行命令），edit、write（SoL-Pi 的
//     Action Fusion 也注册这两个），codemode（它能调别的工具）。
//   - --tools 不去掉 MCP 工具（docs/cli.md 的 MCP tools 一节）。用户 pi 配置里的 MCP 服务器能写外部系统，工作区指纹看不到
//     这种副作用（2026-10-21 审查 M1）。所以 --no-mcp 不连 MCP 服务器，-ne 不加载发现的、配置的扩展（显式 -e 的 plc 扩展
//     照样加载），--exclude-tools 再去掉其余名字以 mcp__ 开头的工具。
// 2026-10-28（lead-tools-and-routing spec D15）：核查员留着 bash。它被沙箱扩展（engine 的 extension/sandbox.ts）换成沙箱里的，
// 能装依赖、能跑测试；没有 edit、write，所以不改交付，bash 写到工作区里的改动由核查前后的工作区指纹发现（manager.ts）。
export const PI_REVIEWER_TOOL_ARGS: readonly string[] = [
  "--no-mcp", "-ne",
  "--tools", "+grep,+find,+ls",
  "--exclude-tools", "powershell,edit,write,codemode,mcp__*",
];

export class PiRuntime implements AgentRuntime {
  readonly id = "pi" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    steering: true,
    resume: true,
    interrupt: true,
    approvals: true,
    mcp: false,
    // 核查员在沙箱里能跑命令（lead-tools-and-routing spec D15）。
    executableReadOnlyReview: true,
  };

  constructor(private readonly options: PiRuntimeOptions = {}) {}

  private get bin(): string {
    return this.options.bin ?? join(projectRoot(), "node_modules", ".bin", "pi");
  }

  // pi 的 CLI 入口是 node 脚本（pi-coding-agent 1.1.0 的 dist/bundle/cli.js）。
  // 工单 10：用 daemon 自己的 Node 运行入口文件，不经 shebang 和 PATH。
  // 历史上 PATH 上的第一个 node 是 22.14，pi 1.1.0 因此崩溃（runs 52、59）。
  // 入口不是 node 脚本时（例如测试里的原生可执行文件），照旧直接运行它。
  // bin 可以是命令名，所以先按 child 的 PATH 的同一组目录解析成路径，和 profile 的 executable 一致。
  private get launch(): { command: string; args: string[]; interpreter?: RuntimeInterpreter } {
    const prefixArgs = this.options.prefixArgs ?? [];
    const executable = findRuntimeExecutable(this.bin, this.options.env?.PATH ?? process.env.PATH ?? "") ?? this.bin;
    const node = daemonNodeLaunch(executable);
    return node
      ? { command: node.command, args: [...node.args, ...prefixArgs], interpreter: node.interpreter }
      : { command: this.bin, args: [...prefixArgs] };
  }

  // pi 按 provider 路由，接受任意 provider 的模型名。扩展文件是 profile 的一部分（工单 05）。
  // 解释器是 daemon 的 Node，所以 preflight 检查的就是 child 实际用的那个 Node。
  get profile(): RuntimeProfile {
    return adapterProfile("pi", this.bin, this.options.env, {
      extensions: [...this.extensions],
      models: { defaultModel: piDefaultModel() ?? null, providers: null },
      interpreter: this.launch.interpreter,
    });
  }

  // 扩展文件是 engine 包的源码：pi 用自己的加载器直接读 TypeScript，所以生产环境也指向源码。
  // SoL-Pi 的入口总是加载。它按 PLC_SOL_PI 决定开哪些机制，import pi 包管理器装好的 SoL-Pi
  // （PLC_SOL_PI_ENTRY，child 从 daemon 继承）。没装时它什么也不做。
  private get extensions(): string[] {
    const solPi = this.options.solPiExtension === undefined
      ? packageSource("engine", "extension", "sol-pi-executor.ts")
      : this.options.solPiExtension;
    const sandbox = this.options.sandboxExtension === undefined
      ? packageSource("engine", "extension", "sandbox.ts")
      : this.options.sandboxExtension;
    return [
      this.options.ticketToolsExtension ?? packageSource("engine", "extension", "ticket-tools.ts"),
      this.options.webToolsExtension ?? packageSource("engine", "extension", "web-tools.ts"),
      ...(solPi ? [solPi] : []),
      ...(sandbox ? [sandbox] : []),
    ];
  }

  // 扩展文件和 start 检查的是同一份清单。
  private missingExtension(): RuntimeProbeResult | null {
    const missing = this.extensions.find((extension) => !existsSync(extension));
    return missing ? {
      ok: false, checks: ["pi extensions"],
      failure: typedFailure("extension_missing", {
        errorCode: "probe_failed", message: `Pi extension path does not exist: ${missing}`,
      }),
    } : null;
  }

  // 探针和 child 用同一个启动方式和同一个环境（工单 10）。
  private probeCommand(signal?: AbortSignal): ProbeCommand {
    const { command, args } = this.launch;
    return {
      bin: command, prefixArgs: args, env: childEnvironment(this.profile.environment, this.options.env ?? {}), signal,
    };
  }

  private readonly versionStep: ProbeStep = {
    label: "pi --version", args: ["--version"], failure: "runtime_start_failed", keepStderr: true,
  };

  // preflight（工单 05）：扩展文件存在，child 实际会用的 Node 满足 pi 的 engines，版本命令能运行。
  // 不跑 auth check：那是账号检查。
  async preflight(request: RuntimePreflightRequest): Promise<RuntimeProbeResult> {
    return this.missingExtension()
      ?? runInstallChecks(this.probeCommand(request.signal), [this.versionStep], this.profile.interpreter);
  }

  // 健康探针（工单 04），按 pi 1.1.0 核实：`auth check --model <m> --json` 在 provider 就绪时
  // 输出 status=ready，退出码 0。它不发起模型调用。OAuth 过期时它会刷新令牌，和真实 Run 一样，
  // 刷新不花钱。安装检查和 preflight 共用。
  async probe(request: RuntimeProbeRequest): Promise<RuntimeProbeResult> {
    const missing = this.missingExtension();
    if (missing) return missing;
    // 模型名来自库里，属于外部输入。看起来像选项的值不交给 CLI，跳过这一步：只跑版本检查。
    const model = request.model ?? piDefaultModel() ?? null;
    return runInstallChecks(this.probeCommand(request.signal), [
      this.versionStep,
      ...(safeArgValue(model) ? [{
        label: "pi auth check", args: ["auth", "check", "--model", model, "--json"],
        failure: "auth_required" as const, judge: piAuthCheck,
      }] : []),
    ], this.profile.interpreter);
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const launch = this.launch;
    const sessionDir = request.sessionDir ?? join(process.cwd(), ".pi-sessions", `run-${request.runId}`);
    mkdirSync(sessionDir, { recursive: true });
    const extensions = this.extensions;
    const missingExtension = extensions.find((extension) => !existsSync(extension));
    if (missingExtension) {
      throw new Error(`Pi extension path does not exist: ${missingExtension}`);
    }
    // resume 的 session 文件不存在时，pi 开一个新 session。这件事记一条诊断，见下面的 runtime.stderr。
    // --fork 在 --session-dir 里写一个新 session 文件，复制原文件的历史，原文件不变。
    // 2026-10-13 用真实的 pi 1.1.0 在 RPC 模式下核实：get_state 报告新 session 的 id。
    const resumeFile = request.resumeSessionId ? resumableSessionFile(sessionDir, request.resumeSessionId) : null;
    const args = [
      ...launch.args,
      "--mode", "rpc",
      "--session-dir", sessionDir,
      ...(resumeFile ? [request.forkSession ? "--fork" : "--session", resumeFile] : []),
      ...extensions.flatMap((extension) => ["-e", extension]),
      ...piChildSkillArgs(
        this.options.childSkillsRoot === undefined ? defaultChildSkillsRoot() : this.options.childSkillsRoot, request.role,
      ),
      ...(request.model
        ? request.model.includes("/")
          ? ["--provider", request.model.slice(0, request.model.indexOf("/")), "--model", request.model.slice(request.model.indexOf("/") + 1)]
          : ["--model", request.model]
        : []),
      // --thinking <level>：off, minimal, low, medium, high, xhigh, max（pi 1.1.0 的 --help）。
      ...(cliEffortValue(request.effort) ? ["--thinking", cliEffortValue(request.effort)!] : []),
      ...(request.role === "reviewer" ? PI_REVIEWER_TOOL_ARGS : []),
      ...(this.options.additionalArgs ?? []),
    ];
    // CLI 经启动垫片运行（工单 14）。RPC 和 steer 写进 stdin，stdin 经垫片的控制 socket 送达 pi。
    // 垫片读完全部输出才报告退出，所以 exit 事件里的 stderr 是完整的，退出码和信号也是真实的。
    const proc = await launchProcess({
      runId: request.runId, command: launch.command, args, cwd: request.workdir,
      // PLC_SANDBOX_ROLE：沙箱扩展（engine 的 extension/sandbox.ts）按它定边界，例如只有执行者拿到 ssh-agent。
      env: childEnvironment(this.profile.environment, this.options.env ?? {}, {
        ...request.env, PLC_SANDBOX_ROLE: request.role === "reviewer" ? "reviewer" : "executor",
      }),
      stdin: true, baseDir: request.launchDir,
    });
    const notices = request.resumeSessionId && !resumeFile
      ? [`pi session ${request.resumeSessionId} has no usable session file in ${sessionDir}; pi starts a new session\n`]
      : [];
    writeLaunchNotices(proc.launcher.dir, notices);
    return this.supervise(proc, request, false, notices);
  }

  // 接管 daemon 重启前启动的 pi（工单 15）。从输出文件的开头重放，不再发 get_state 和 prompt。
  // RPC 换一个 id 前缀，重放出来的旧回包不会兑现新的请求。steer 和 prompt 仍经控制 socket 写进 stdin。
  async attach(request: RuntimeAttachRequest): Promise<RuntimeHandle> {
    return this.supervise(
      attachProcess(request.launch, { hasStdin: true }),
      { runId: request.runId, model: request.model, prompt: "" },
      true,
      readLaunchNotices(request.launch.identity.dir),
    );
  }

  // request 只用到 runId、model 和 prompt。adopted 为 true 时不发启动时的命令。
  // notices 是 adapter 自己产生、不在输出文件里的诊断。它们排在所有事件之前，
  // 接管时从启动目录读回来，所以重放的事件编号和原来一样（工单 13 和 15）。
  private supervise(
    proc: LaunchedProcess,
    request: Pick<RuntimeStartRequest, "runId" | "model" | "prompt">,
    adopted: boolean,
    notices: readonly string[] = [],
  ): RuntimeHandle {
    const rpc = new RpcClient(proc, adopted ? { idPrefix: `plc-a${Date.now().toString(36)}-` } : {});
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const events = new RuntimeEventSequencer(request.runId);
    let terminal = false;
    let externalSessionId: string | null = null;
    let stderrText = "";
    for (const text of notices) queue.push(events.event({ type: "runtime.stderr", text }));
    let resolveExit!: (exit: RuntimeExit) => void;
    const exitPromise = new Promise<RuntimeExit>((resolve) => { resolveExit = resolve; });

    const finish = (exit: RuntimeExit, event: RuntimeEvent) => {
      if (terminal) return;
      terminal = true;
      queue.push(event);
      queue.end();
      resolveExit(exit);
    };

    // SIGTERM，宽限期之后 SIGKILL。pi 可能忽略 SIGTERM。
    const killGraceMs = Math.max(0, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const running = () => proc.exitCode === null && proc.signalCode === null;
    const terminate = (): void => {
      if (!running()) return;
      proc.kill("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (running()) proc.kill("SIGKILL");
      }, killGraceMs);
    };
    // 进程结束。启动失败时只有 close，没有 exit。
    const processEnded = new Promise<void>((resolve) => {
      if (!running()) resolve();
      proc.once("exit", () => resolve());
      proc.once("close", () => resolve());
    });
    void processEnded.then(() => { if (killTimer) clearTimeout(killTimer); });

    // adapter 自己判定 Run 失败，这时 pi 还活着（工单 13）。pi 在 RPC 模式下不会自己退出，所以要停止它。
    // 否则它停留到 linger 到期。在这之前，manager 不给这张工单启动新的 Run，内核的重试因此失败。
    const failAndStop = (errorCode: string, message: string): void => {
      finish({
        ok: false, exitCode: null, signal: null, externalSessionId, errorCode, errorMessage: message,
      }, events.event({
        type: "run.failed", exitCode: null, errorCode, error: message,
        failure: classifyPiFailure({ errorCode, message, stderr: stderrText }),
      }));
      terminate();
    };

    // 畸形行（RPC 输出里不是 JSON 的行，工单 13）。每一行记一条诊断，超过上限时 Run 失败。
    // pi 1.1.0 在 RPC 模式下接管 stdout（rpc-mode.js 的 takeOverStdout），扩展打印的内容不进协议。
    // 所以畸形行说明协议坏了，不是正常的噪声。
    let malformedLines = 0;
    rpc.on("parse_error", (line: string) => {
      if (terminal) return;
      malformedLines += 1;
      queue.push(events.event({
        type: "runtime.stderr", text: `malformed pi RPC line ${malformedLines}: ${line.slice(0, MAX_DIAGNOSTIC_CHARS)}\n`,
      }));
      if (malformedLines > MAX_MALFORMED_LINES) {
        failAndStop("malformed_output", `Pi emitted more than ${MAX_MALFORMED_LINES} malformed RPC lines`);
      }
    });

    // 原生事件到 RuntimeEvent 的映射和进程内的代查 runtime 共用（pi-events.ts）。LLM 错误的处理也在那里：
    // 回合以 LLM 错误结束时，Run 以类型化的 run.failed 结束（工单 13，spec D1）。
    const mapNative = createPiEventMapper({
      runId: request.runId,
      runtime: "pi",
      model: request.model ?? null,
      emit: (input) => { if (!terminal) queue.push(events.event(input)); },
      settle: (llmError) => {
        if (terminal) return;
        if (llmError === null) {
          finish({
            ok: true, exitCode: 0, signal: null, externalSessionId,
            errorCode: null, errorMessage: null,
          }, events.event({ type: "run.completed", exitCode: 0 }));
          return;
        }
        failAndStop("llm_error", llmError);
      },
    });

    rpc.on("event", (native: any) => {
      try {
        mapNative(native);
      } catch (error) {
        if (!terminal) {
          finish({
            ok: false, exitCode: null, signal: null, externalSessionId,
            errorCode: "event_normalization", errorMessage: String(error),
          }, events.event({
            type: "run.failed", exitCode: null,
            errorCode: "event_normalization", error: String(error),
            failure: classifyPiFailure({ errorCode: "event_normalization", message: String(error), stderr: stderrText }),
          }));
        }
      }
    });

    // session id 在 get_state 的回包里。回包交付时同步记下它，从头重放时 session.updated 的位置和原来一样。
    rpc.on("response", (response: RpcResponse) => {
      if (terminal || externalSessionId !== null) return;
      if (response.command !== "get_state" || !response.success || !response.data?.sessionId) return;
      externalSessionId = String(response.data.sessionId);
      queue.push(events.event({
        type: "session.updated",
        externalSessionId,
        runtimeVersion: response.data.version ? String(response.data.version) : undefined,
      }));
    });

    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      // Keep the final failure useful for classification without allowing an unbounded stderr
      // stream to inflate the Run error or leak an entire process log into the ledger.
      stderrText = `${stderrText}${text}`.slice(-16_000);
      if (!terminal) queue.push(events.event({ type: "runtime.stderr", text }));
    });
    proc.on("error", (error) => {
      if (!terminal) finish({
        ok: false, exitCode: null, signal: null, externalSessionId,
        errorCode: "spawn_error", errorMessage: error.message,
      }, events.event({
        type: "run.failed", exitCode: null, errorCode: "spawn_error", error: error.message,
        failure: classifyPiFailure({ errorCode: "spawn_error", message: error.message, stderr: stderrText }),
      }));
    });
    proc.on("exit", (code, signal) => {
      if (!terminal) finish({
        ok: false, exitCode: code, signal, externalSessionId,
        errorCode: "process_exit",
        errorMessage: `Pi process exited before agent_end (${code ?? signal})${stderrText ? `\n${stderrText}` : ""}`,
      }, events.event({
        type: "run.failed", exitCode: code, errorCode: "process_exit",
        error: `Pi process exited before agent_end (${code ?? signal})${stderrText ? `\n${stderrText}` : ""}`,
        failure: classifyPiFailure({
          errorCode: "process_exit", message: `Pi process exited before agent_end (${code ?? signal})`, stderr: stderrText,
        }),
      }));
    });

    void (async () => {
      if (adopted) return;
      try {
        // session.updated 在 get_state 的回包里同步发出（工单 15），这里不再重复。
        await rpc.send({ type: "get_state" });
        // pi 1.1.0 在 prompt 的预检里失败时（例如没有凭据），回复 success=false，也不开始回合
        // （dist/modes/rpc/rpc-mode.js）。不处理这个回复的话，Run 一直等不到 agent_end（工单 13）。
        const response = await rpc.send({ type: "prompt", message: request.prompt });
        if (!response.success && !terminal) failAndStop("prompt_rejected", String(response.error || "pi rejected the prompt"));
      } catch (error) {
        if (!terminal) finish({
          ok: false, exitCode: null, signal: null, externalSessionId,
          errorCode: "rpc_error", errorMessage: String(error),
        }, events.event({
          type: "run.failed", exitCode: null, errorCode: "rpc_error", error: String(error),
          failure: classifyPiFailure({ errorCode: "rpc_error", message: String(error), stderr: stderrText }),
        }));
      }
    })();

    return {
      pid: proc.pid ?? null,
      process: proc,
      events: queue,
      send: async (message) => {
        const response = await rpc.send({ type: "prompt", message });
        if (!response.success) throw new Error(response.error ?? "Pi prompt failed");
      },
      steer: async (message) => {
        const response = await rpc.send({ type: "steer", message });
        if (!response.success) throw new Error(response.error ?? "Pi steer failed");
      },
      // 换模型和推理强度（工单 08）：RPC 的 set_model 和 set_thinking_level（pi 1.1.0 的 docs/rpc-commands.md），
      // 从下一次调用模型开始生效，进程不重启。set_model 要 provider 和 modelId：目录里的模型是 provider/model；
      // 没写 provider 时用 pi 现在的 provider（get_state 的 model.provider）。
      setProfile: async (change) => {
        if (change.model) {
          const slash = change.model.indexOf("/");
          let provider = slash > 0 ? change.model.slice(0, slash) : null;
          const modelId = slash > 0 ? change.model.slice(slash + 1) : change.model;
          if (!provider) {
            const state = await rpc.send({ type: "get_state" });
            provider = typeof state.data?.model?.provider === "string" ? state.data.model.provider : null;
            if (!provider) throw new Error(`Pi set_model needs provider/model: ${change.model}`);
          }
          const response = await rpc.send({ type: "set_model", provider, modelId });
          if (!response.success) throw new Error(response.error ?? "Pi set_model failed");
        }
        const level = cliEffortValue(change.effort);
        if (level) {
          const response = await rpc.send({ type: "set_thinking_level", level });
          if (!response.success) throw new Error(response.error ?? "Pi set_thinking_level failed");
        }
      },
      // 停止 pi，并等它的进程结束（工单 13 的合约用例）。pi 忽略 SIGTERM 时，宽限期之后 SIGKILL。
      interrupt: async () => {
        terminate();
        await processEnded;
      },
      wait: () => exitPromise,
    };
  }
}

// ── registry 的登记项（spec D8，工单 12）──────────────────────────────────────

// PLC_CHILD_MODEL 是旧的配置名，只对 pi 生效。都没有配置时不传 --model，由 pi 自己的配置决定。
export function piDefaultModel(env: RuntimeEnv = process.env): string | undefined {
  return env.PLC_PI_MODEL?.trim() || env.PLC_CHILD_MODEL?.trim() || undefined;
}

// pi 的目录：`pi --list-models` 列出它的 provider 配置下可用的 provider/model 和是否支持 thinking，
// `pi --help` 的 --thinking 说明列出档位（pi 1.1.0）。不调用 pi auth：那组命令会打印凭据。
// pi 的 agent 目录（PI_CODING_AGENT_DIR，默认 ~/.pi/agent）里的 settings.json：只读默认模型那两项。
function piSettingsDefault(env: RuntimeEnv | undefined): string | null {
  const dir = env?.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  try {
    return parsePiSettingsDefault(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    return null;
  }
}

async function discoverPiModels(context: { cwd: string; env?: RuntimeEnv; timeoutMs?: number }): Promise<ModelDiscovery> {
  const source = "pi --list-models";
  const bin = piAdapter.locateExecutable(context.cwd);
  if (!bin) return { ok: false, error: "pi executable not found", source };
  try {
    const command = { bin, env: context.env, timeoutMs: context.timeoutMs };
    const efforts = parsePiThinkingLevels(await runDiscoveryCommand(command, ["--help"]));
    const models = parsePiModelList(await runDiscoveryCommand(command, ["--list-models"]), efforts);
    if (models.length === 0) return { ok: false, error: "pi --list-models lists no models", source };
    return {
      ok: true, models, efforts, cliDefaultModel: piSettingsDefault(context.env), source,
      account: `pi 自己的 provider 配置（${piProviders(models).join("、")}）`, freeformModelPattern: null,
    };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error).slice(0, 300), source };
  }
}

export const piAdapter: RuntimeAdapter<PiRuntimeOptions> = {
  id: "pi",
  displayName: "Pi agent",
  // 能力只在 PiRuntime 里声明一次。
  capabilities: new PiRuntime().capabilities,
  // pi 按 provider 路由，模型名原样交给它。
  models: { defaultModel: piDefaultModel, resolve: (model) => model },
  reportsCost: true,
  classifyFailure: classifyPiFailure,
  // pi 装在项目自己的 node_modules 里。
  locateExecutable: (cwd) => findRuntimeExecutable(process.env.PLC_PI_BIN ?? join(cwd, "node_modules", ".bin", "pi")),
  discoverModels: (context) => discoverPiModels(context),
  create: (options) => new PiRuntime(options),
};

// adapter 自己产生的诊断写进启动目录（工单 13 和 15）。权限与启动目录里的其他文件一样，是 0600。
// 没有诊断时不写文件。
const LAUNCH_NOTICES_FILE = "notices.json";

function writeLaunchNotices(dir: string, notices: readonly string[]): void {
  if (!notices.length) return;
  writeFileSync(join(dir, LAUNCH_NOTICES_FILE), JSON.stringify(notices), { mode: 0o600 });
}

function readLaunchNotices(dir: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, LAUNCH_NOTICES_FILE), "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// adapter 健康探针的执行器（spec D2，工单 04）。
// 探针按顺序跑几条 CLI 命令，第一条没通过的命令决定类型化失败。
// 只允许不发起模型调用、不花钱的命令，例如版本命令和登录状态命令。每个 adapter 自己挑命令。
// 命令以 argv 数组交给 spawn，不经过 shell。
// 状态命令的输出可能带账号信息，所以 stdout 只交给 judge 判断，从不进证据。
import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { typedFailure, type FailureCode } from "./typed-failure.js";
import { parseVersion, satisfiesRange, type RuntimeInterpreter } from "./interpreter.js";
import type { RuntimeProbeResult } from "./types.js";

const STEP_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_STDERR_CHARS = 2_000;

export interface ProbeStepOutput {
  exitCode: number | null;
  stdout: string;
}

export interface ProbeStep {
  // 检查项的名字，例如 "codex login status"。它进诊断和 checks。
  label: string;
  args: string[];
  // 这一步没通过时的错误码，取自 D1 的映射表。
  failure: FailureCode;
  // 判断这一步是否通过。返回 null 表示通过，返回字符串表示没通过的原因。默认看退出码是否为 0。
  judge?: (output: ProbeStepOutput) => string | null;
  // 版本命令的 stderr 能说明安装哪里坏了，可以进证据。状态命令的 stderr 不进证据。
  keepStderr?: boolean;
}

export interface ProbeCommand {
  bin: string;
  prefixArgs?: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// 状态命令的 JSON 输出。不是 JSON 对象时返回 null，judge 退回到只看退出码。
export function statusJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface StepRun extends ProbeStepOutput {
  stderr: string;
  signal: NodeJS.Signals | null;
  spawnError: NodeJS.ErrnoException | null;
  timedOut: boolean;
}

// 交给 CLI 的参数值不能以 "-" 开头，否则 CLI 会把它当成选项。值来自库里的模型名，属于外部输入。
export function safeArgValue(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][\w.:/@+-]{0,199}$/.test(value);
}

function runStep(command: ProbeCommand, step: ProbeStep): Promise<StepRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.bin, [...(command.prefixArgs ?? []), ...step.args], {
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(command.signal ? { signal: command.signal } : {}),
      });
    } catch (error) {
      // 参数本身不合法时（例如可执行文件路径为空），spawn 同步抛错。
      resolve({ exitCode: null, signal: null, stdout, stderr, spawnError: error as NodeJS.ErrnoException, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, STEP_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    // spawn 失败（例如可执行文件不存在）时，先来 error，再来 close。close 之后 stdio 已经读完。
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, spawnError, timedOut });
    });
  });
}

const MISSING_EXECUTABLE = ["ENOENT", "EACCES", "ENOTDIR"];

// 解释器的版本命令的判断：版本满足 engines 时通过。版本或要求认不出时放行，不因为解析不了就判失败。
function interpreterJudge(interpreter: RuntimeInterpreter, engines: string) {
  return (output: ProbeStepOutput): string | null => {
    if (output.exitCode !== 0) return `退出码 ${output.exitCode}`;
    const version = output.stdout.trim().split(/\s+/)[0] ?? "";
    if (!parseVersion(version)) return null;
    return satisfiesRange(version, engines) === false
      ? `${interpreter.path} 是 ${version}，不满足要求 ${engines}`
      : null;
  };
}

// 安装检查之一（工单 05）：child 实际会用的解释器满足 CLI 的 engines 要求。
// 解释器的路径已经按 child 的 PATH 解析好（interpreter.ts），这里跑它的版本命令。
async function interpreterCheck(
  command: ProbeCommand,
  interpreter: RuntimeInterpreter | null | undefined,
): Promise<RuntimeProbeResult | null> {
  if (!interpreter?.engines) return null;
  const label = `${interpreter.command} --version`;
  if (!interpreter.path) {
    return {
      ok: false, checks: [label],
      failure: typedFailure("interpreter_mismatch", {
        errorCode: "probe_failed",
        message: `child 的 PATH 上找不到 ${interpreter.command}，CLI 要求 ${interpreter.engines}`,
      }),
    };
  }
  const result = await runProbe({ bin: interpreter.path, env: command.env, signal: command.signal }, [{
    label, args: ["--version"], failure: "interpreter_mismatch", keepStderr: true,
    judge: interpreterJudge(interpreter, interpreter.engines),
  }]);
  if (result.ok || result.failure.code === "interpreter_mismatch") return result;
  // 解释器本身起不来，也算解释器不符：child 会在同一个地方失败。
  return {
    ok: false, checks: result.checks,
    failure: typedFailure("interpreter_mismatch", { errorCode: "probe_failed", message: result.failure.evidence }),
  };
}

// 安装检查（工单 05）：解释器满足要求，然后各个命令都能运行。
// preflight 只跑版本命令。健康探针（工单 04）在版本命令之后再跑账号检查。两者共用这一个入口。
export async function runInstallChecks(
  command: ProbeCommand,
  steps: ProbeStep[],
  interpreter: RuntimeInterpreter | null | undefined,
): Promise<RuntimeProbeResult> {
  const interpreterResult = await interpreterCheck(command, interpreter);
  if (interpreterResult && !interpreterResult.ok) return interpreterResult;
  const result = await runProbe(command, steps);
  return interpreterResult ? { ...result, checks: [...interpreterResult.checks, ...result.checks] } : result;
}

// 工具通道的探针（工单 #113）：拉起 MCP 服务器，发一次 initialize，等它回答。和 CLI 连 plc 时走同一段路：
// 起 node、加载 mcp-server 的模块、回答握手。不调用工具，不发起模型调用。
// 等待的上限和真实执行的 MCP_TIMEOUT 一样：机器忙到真实执行会超时，探针也超时，故障就不关闭。
export interface McpServerCommand {
  command: string;
  args: string[];
}

export interface McpProbeOutcome {
  // null 表示服务器回答了 initialize。
  problem: string | null;
  stderr: string;
  timedOut: boolean;
}

const MCP_PROBE_KILL_GRACE_MS = 2_000;

export function probeMcpServer(
  server: McpServerCommand,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<McpProbeOutcome> {
  return new Promise((resolve) => {
    let stderr = "";
    let buffer = "";
    let problem: string | null = null;
    let answered = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(server.command, server.args, {
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      resolve({ problem: `无法启动：${(error as Error).message}`, stderr, timedOut });
      return;
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // 拿到结论就停掉服务器。它收到 SIGTERM 会自己退出（mcp-server.ts），不退出就 SIGKILL。
    const stop = (): void => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), MCP_PROBE_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      problem = `${Math.round(options.timeoutMs / 1000)} 秒内没有回答 initialize`;
      stop();
    }, options.timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (answered || problem !== null) return;
      buffer = (buffer + chunk).slice(-MAX_OUTPUT_CHARS);
      for (const line of buffer.split("\n").slice(0, -1)) {
        const reply = statusJson(line);
        if (reply?.id !== 1) continue;
        answered = true;
        if (!reply.result) problem = `initialize 返回了错误：${JSON.stringify(reply.error ?? null).slice(0, 300)}`;
        clearTimeout(timer);
        stop();
        return;
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    // 服务器没读 stdin 就退出时，写入会报 EPIPE。退出码在 close 里报。
    child.stdin!.on("error", () => {});
    child.once("error", (error: NodeJS.ErrnoException) => {
      problem ??= `无法启动：${error.message}`;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!answered && problem === null) problem = `没有回答 initialize 就退出了（${exitCode ?? signal}）`;
      resolve({ problem, stderr, timedOut });
    });
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plc-probe", version: "1.0.0" } },
    })}\n`);
  });
}

export async function runProbe(command: ProbeCommand, steps: ProbeStep[]): Promise<RuntimeProbeResult> {
  const checks: string[] = [];
  for (const step of steps) {
    checks.push(step.label);
    const run = await runStep(command, step);
    const fail = (code: FailureCode, message: string, stderr?: string): Extract<RuntimeProbeResult, { ok: false }> => ({
      ok: false, checks, failure: typedFailure(code, { errorCode: "probe_failed", message, stderr: stderr ?? null }),
    });
    if (run.spawnError) {
      const missing = MISSING_EXECUTABLE.includes(run.spawnError.code ?? "");
      return fail(missing ? "executable_missing" : "runtime_start_failed", `${step.label} 无法启动：${run.spawnError.message}`);
    }
    if (run.timedOut) return { ...fail(step.failure, `${step.label} 超时`), timedOut: true };
    const problem = step.judge
      ? step.judge(run)
      : run.exitCode === 0 ? null : `退出码 ${run.exitCode ?? run.signal}`;
    if (problem) return fail(step.failure, `${step.label}：${problem}`, step.keepStderr ? run.stderr : undefined);
  }
  return { ok: true, checks };
}

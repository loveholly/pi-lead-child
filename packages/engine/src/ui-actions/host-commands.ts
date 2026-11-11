// 在用户的 Mac 上、沙箱外跑一条命令（2026-10-29）。兜底：Lead 在沙箱里做不了的事（读进程表、杀进程、改 LaunchAgents、
// brew 升级、用钥匙串里的凭证）以前只能把命令发给用户，请他粘到终端里跑。用户：「你起码要让 lead agent 有能力处理，最差
// 最差没考虑到的场景应该弹一个授权卡给我授权 lead 处理」。
// 只在用户点了确认卡以后跑（rule-change-confirmations.ts 的 run_on_host）：命令和目录原样显示在卡上，账本记下是哪台设备
// 确认的。命令用用户的登录 shell 跑（zsh -l，和终端里一样的 PATH），输出脱敏后存进 Lead 的临时目录，Lead 再读。
// 免沙箱开关开着时（docs/ticket-246-user-turn-bypass.md，实施单 C），用户本人的一轮里 run_on_host 不弹卡、直接跑，Lead 的
// bash 也在沙箱外跑（sandbox/host-bash.ts）。三条路共用这里的 spawn、时限、脱敏和落盘，每条命令都写 host_command.started
// 和 finished（5.5）。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { dataDir as defaultDataDir } from "@pi-lead-child/core";
import {
  HOST_COMMAND_FINISHED_KIND, HOST_COMMAND_STARTED_KIND, hostCommandEntityKey, redactKnownValues, redactSecretText, secretEnvValues,
  type HostCommandTurnOrigin, type HostCommandVia, type HostCommandWokenBy,
} from "@pi-lead-child/protocol";
import { appendEvent, type Db } from "@pi-lead-child/store";
import { UiActionError } from "./types.js";

export const HOST_COMMAND_LIMITS = {
  // 卡上能完整显示的长度（RULE_CHANGE_CONFIRMATION_LIMITS.value）：用户看不全的命令不能让他确认。
  command: 400,
  // 免沙箱直接跑的命令（不发卡）能有多长：筛查器读得了整条命令就行，不受卡上的长度限制（工单 #324）。
  screenedCommand: 20_000,
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 1_800,
  // 存下的输出最多这么多字节，多的截掉并写明。
  outputBytes: 512 * 1024,
  // 交给 Lead 的结果里带的输出末尾。
  tailChars: 1_200,
} as const;

export interface HostCommandInput {
  command: string;
  cwd: string;
  timeout_seconds: number;
  // Lead 自报这条命令会花钱（设计文档 4.2）。只在 true 时有这个字段：存下的参数和以前一样。
  spends_money?: true;
}

/** 命令比 limit 长时给 Lead 的话：写成 lead-scratch 里的脚本。 */
export function commandTooLongForCard(limit: number): string {
  return limit === HOST_COMMAND_LIMITS.command
    ? `命令超过 ${limit} 个字符，卡上显示不全。把它写进 Lead 临时目录里的一个脚本，命令写成 bash <脚本路径>`
    : `命令超过 ${limit} 个字符。把它写进 Lead 临时目录里的一个脚本，命令写成 bash <脚本路径>`;
}

/**
 * 存下的参数（Lead 给的）：命令、在哪个目录跑、最多跑多久。不对时报 invalid_input。
 * maxCommand：命令最长多少字。缺省是卡上能完整显示的长度；免沙箱直接跑、不发卡时，调用方给 screenedCommand。
 */
export function hostCommandInputOf(input: unknown, maxCommand: number = HOST_COMMAND_LIMITS.command): HostCommandInput {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) throw new UiActionError("invalid_input", "要写 command");
  if (command.length > maxCommand) throw new UiActionError("invalid_input", commandTooLongForCard(maxCommand));
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : process.env.HOME ?? "/";
  if (!isAbsolute(cwd)) throw new UiActionError("invalid_input", "cwd 要写绝对路径");
  const timeout = typeof raw.timeout_seconds === "number" && Number.isFinite(raw.timeout_seconds)
    ? Math.round(raw.timeout_seconds) : HOST_COMMAND_LIMITS.defaultTimeoutSeconds;
  if (timeout < 1 || timeout > HOST_COMMAND_LIMITS.maxTimeoutSeconds) {
    throw new UiActionError("invalid_input", `timeout_seconds 要在 1 到 ${HOST_COMMAND_LIMITS.maxTimeoutSeconds} 之间`);
  }
  return { command, cwd, timeout_seconds: timeout, ...(raw.spends_money === true ? { spends_money: true as const } : {}) };
}

export interface HostCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  // 被 signal 停下（用户 /stop 时 run_on_host 停掉进程组）。
  aborted: boolean;
  outputPath: string;
  text: string;
}

/** 一次沙箱外的进程跑完的结果。output 已经脱敏。 */
export interface HostProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  // 被 signal 停下（Lead 的 /stop、pi 的中止）。
  aborted: boolean;
  output: string;
  outputBytes: number;
  truncated: boolean;
  durationMs: number;
}

/** 已知密钥的值（daemon 的环境里有）和像密钥的字符串都盖掉。 */
export function redactHostText(text: string): string {
  return redactSecretText(redactKnownValues(text, secretEnvValues(process.env)));
}

function killGroup(pid: number | undefined, child: { kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * 在沙箱外起一个进程跑这条命令：用户的登录 shell（zsh -l，和终端里一样的 PATH），环境是 daemon 的 process.env。
 * 到时限先 SIGTERM，5 秒后 SIGKILL，整个进程组一起停。onData 收到的每一段都先脱敏。run_on_host 和免沙箱的 bash 共用它。
 */
export function spawnHostProcess(command: string, options: {
  cwd: string; timeoutSeconds?: number | undefined; shell?: string; signal?: AbortSignal | undefined; onData?: (chunk: Buffer) => void;
}): Promise<HostProcessResult> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return new Promise((resolve) => {
    const child = spawn(options.shell ?? "/bin/zsh", ["-lc", command], {
      cwd: options.cwd, env: { ...process.env, TERM: "dumb" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      killGroup(child.pid, child, "SIGTERM");
      setTimeout(() => killGroup(child.pid, child, "SIGKILL"), 5_000).unref();
    };
    const timer = options.timeoutSeconds && options.timeoutSeconds > 0
      ? setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutSeconds * 1000)
      : undefined;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (chunk: Buffer) => {
      options.onData?.(Buffer.from(redactHostText(chunk.toString("utf8"))));
      if (size >= HOST_COMMAND_LIMITS.outputBytes) { cut = true; return; }
      const room = HOST_COMMAND_LIMITS.outputBytes - size;
      if (chunk.length > room) cut = true;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      size += part.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (exitCode: number | null) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const output = redactHostText(Buffer.concat(chunks).toString("utf8"));
      resolve({ exitCode, timedOut, aborted, output, outputBytes: size, truncated: cut, durationMs: Date.now() - started });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(`\n（启动失败：${error.message}）\n`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** 输出存进 <数据目录>/lead-scratch/host-commands/<编号>.log，返回路径。 */
export function saveHostCommandOutput(dataDir: string | undefined, id: string, result: Pick<HostProcessResult, "output" | "truncated">): string {
  const dir = join(dataDir ?? defaultDataDir(), "lead-scratch", "host-commands");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outputPath = join(dir, `${id}.log`);
  writeFileSync(outputPath, `${result.output}${result.truncated ? `\n（输出超过 ${HOST_COMMAND_LIMITS.outputBytes} 字节，后面的没有存）\n` : ""}`, { mode: 0o600 });
  return outputPath;
}

/** 给 Lead 的一段话：跑完没有、退出码、用了多久、全文在哪里、末尾几行。 */
export function hostCommandResultText(input: { timeoutSeconds: number }, result: HostProcessResult, outputPath: string): string {
  const seconds = Math.round(result.durationMs / 100) / 10;
  const lines = result.output.split("\n").filter((line) => line.length > 0).length;
  const tail = result.output.length > HOST_COMMAND_LIMITS.tailChars ? `…${result.output.slice(-HOST_COMMAND_LIMITS.tailChars)}` : result.output;
  const status = result.timedOut ? `超过 ${input.timeoutSeconds} 秒没跑完，停掉了`
    : result.aborted ? "这一步被停下了，命令也停掉了（整个进程组）"
    : result.exitCode === 0 ? "跑完了，退出码 0" : `跑完了，退出码 ${result.exitCode ?? "未知"}`;
  return `${status}，用了 ${seconds} 秒。输出共 ${lines} 行，全文在 ${outputPath}（用 read 读）。`
    + (tail.trim() ? `\n末尾：\n${tail.trim()}` : "\n没有输出。");
}

/** 跑这条命令（沙箱外）。输出脱敏后存进 <数据目录>/lead-scratch/host-commands/<编号>.log，返回给 Lead 的一段话。 */
export async function runHostCommand(
  input: HostCommandInput, options: { id: string; dataDir?: string; shell?: string },
): Promise<HostCommandResult> {
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new UiActionError("invalid_input", `目录不存在：${input.cwd}`);
  const result = await spawnHostProcess(input.command, {
    cwd: input.cwd, timeoutSeconds: input.timeout_seconds, ...(options.shell ? { shell: options.shell } : {}),
  });
  const outputPath = saveHostCommandOutput(options.dataDir, options.id, result);
  return {
    exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted, outputPath,
    text: hostCommandResultText({ timeoutSeconds: input.timeout_seconds }, result, outputPath),
  };
}

// ——— 事件（设计文档 5.5）———

/** 这条沙箱外的命令是凭什么跑的：写进 host_command.started。 */
export interface HostCommandRecord {
  id: string;
  turnId: string | null;
  turnOrigin: HostCommandTurnOrigin;
  // 系统事件叫醒的一轮：发起它的系统来源和交给它的事件 kind（turnOrigin 是 system_event 时才有）。
  wokenBy?: HostCommandWokenBy;
  // 这一轮带着的外部内容：外部消息的来源、读到外部内容的工具。
  externalContent?: string[];
  via: HostCommandVia;
  confirmationId: string | null;
  command: string;
  cwd: string;
  timeoutSeconds: number | null;
  screen: { verdict: string; rule: string | null } | null;
  spendsMoney: boolean;
}

/** 新的沙箱外命令的编号。确认卡上跑的用卡的编号。 */
export function newHostCommandId(): string {
  return `hc_${randomBytes(9).toString("base64url")}`;
}

/** spawn 之前写 host_command.started。命令脱敏，最多 400 字。 */
export function recordHostCommandStarted(db: Db, record: HostCommandRecord, now = new Date()): void {
  const command = redactHostText(record.command);
  db.transaction(() => appendEvent(db, {
    source: "system", kind: HOST_COMMAND_STARTED_KIND, entityKey: hostCommandEntityKey(record.id), level: "record",
    payload: {
      ...record,
      command: command.length > HOST_COMMAND_LIMITS.command ? `${command.slice(0, HOST_COMMAND_LIMITS.command - 1)}…` : command,
    },
    occurredAt: now.toISOString(),
  }))();
}

/** 进程结束以后写 host_command.finished。 */
export function recordHostCommandFinished(db: Db, id: string, result: HostProcessResult, outputPath: string): void {
  db.transaction(() => appendEvent(db, {
    source: "system", kind: HOST_COMMAND_FINISHED_KIND, entityKey: hostCommandEntityKey(id), level: "record",
    payload: {
      id, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Math.max(0, Math.round(result.durationMs)),
      outputPath, outputBytes: result.outputBytes, truncated: result.truncated,
    },
    occurredAt: new Date().toISOString(),
  }))();
}

/**
 * 跑一条沙箱外的命令，前后写 host_command.started 和 finished，输出落盘。run_on_host（直接跑或确认卡上跑）用它；
 * 免沙箱的 bash 走 sandbox/host-bash.ts，它要把输出流给 pi，自己调上面三个函数。
 */
export async function runRecordedHostCommand(
  db: Db, input: HostCommandInput, record: Omit<HostCommandRecord, "command" | "cwd" | "timeoutSeconds">,
  // run：真正跑的命令（脚本换成筛查过的副本以后的那一条）。事件里记 Lead 写的 input.command。
  // signal：中止时停掉整个进程组（spawnHostProcess）。免沙箱直接跑的 run_on_host 传，确认卡上跑的不传。
  options: { dataDir?: string; shell?: string; run?: string; signal?: AbortSignal } = {},
): Promise<HostCommandResult> {
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new UiActionError("invalid_input", `目录不存在：${input.cwd}`);
  recordHostCommandStarted(db, { ...record, command: input.command, cwd: input.cwd, timeoutSeconds: input.timeout_seconds });
  const result = await spawnHostProcess(options.run ?? input.command, {
    cwd: input.cwd, timeoutSeconds: input.timeout_seconds, ...(options.shell ? { shell: options.shell } : {}), signal: options.signal,
  });
  const outputPath = saveHostCommandOutput(options.dataDir, record.id, result);
  recordHostCommandFinished(db, record.id, result, outputPath);
  return {
    exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted, outputPath,
    text: hostCommandResultText({ timeoutSeconds: input.timeout_seconds }, result, outputPath),
  };
}

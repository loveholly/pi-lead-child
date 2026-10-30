// 在用户的 Mac 上、沙箱外跑一条命令（2026-10-29）。兜底：Lead 在沙箱里做不了的事（读进程表、杀进程、改 LaunchAgents、
// brew 升级、用钥匙串里的凭证）以前只能把命令发给用户，请他粘到终端里跑。用户：「你起码要让 lead agent 有能力处理，最差
// 最差没考虑到的场景应该弹一个授权卡给我授权 lead 处理」。
// 只在用户点了确认卡以后跑（rule-change-confirmations.ts 的 run_on_host）：命令和目录原样显示在卡上，账本记下是哪台设备
// 确认的。命令用用户的登录 shell 跑（zsh -l，和终端里一样的 PATH），输出脱敏后存进 Lead 的临时目录，Lead 再读。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { dataDir as defaultDataDir } from "@pi-lead-child/core";
import { redactKnownValues, redactSecretText, secretEnvValues } from "@pi-lead-child/protocol";
import { UiActionError } from "./types.js";

export const HOST_COMMAND_LIMITS = {
  // 卡上能完整显示的长度（RULE_CHANGE_CONFIRMATION_LIMITS.value）：用户看不全的命令不能让他确认。
  command: 400,
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
}

/** 存下的参数（Lead 给的）：命令、在哪个目录跑、最多跑多久。不对时报 invalid_input。 */
export function hostCommandInputOf(input: unknown): HostCommandInput {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) throw new UiActionError("invalid_input", "要写 command");
  if (command.length > HOST_COMMAND_LIMITS.command) {
    throw new UiActionError("invalid_input",
      `命令超过 ${HOST_COMMAND_LIMITS.command} 个字符，卡上显示不全。把它写进 Lead 临时目录里的一个脚本，命令写成 bash <脚本路径>`);
  }
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : process.env.HOME ?? "/";
  if (!isAbsolute(cwd)) throw new UiActionError("invalid_input", "cwd 要写绝对路径");
  const timeout = typeof raw.timeout_seconds === "number" && Number.isFinite(raw.timeout_seconds)
    ? Math.round(raw.timeout_seconds) : HOST_COMMAND_LIMITS.defaultTimeoutSeconds;
  if (timeout < 1 || timeout > HOST_COMMAND_LIMITS.maxTimeoutSeconds) {
    throw new UiActionError("invalid_input", `timeout_seconds 要在 1 到 ${HOST_COMMAND_LIMITS.maxTimeoutSeconds} 之间`);
  }
  return { command, cwd, timeout_seconds: timeout };
}

export interface HostCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  outputPath: string;
  text: string;
}

/** 跑这条命令（沙箱外）。输出脱敏后存进 <数据目录>/lead-scratch/host-commands/<编号>.log，返回给 Lead 的一段话。 */
export async function runHostCommand(
  input: HostCommandInput, options: { id: string; dataDir?: string; shell?: string } ,
): Promise<HostCommandResult> {
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new UiActionError("invalid_input", `目录不存在：${input.cwd}`);
  const dir = join(options.dataDir ?? defaultDataDir(), "lead-scratch", "host-commands");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outputPath = join(dir, `${options.id}.log`);
  const started = Date.now();
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  const { exitCode, timedOut } = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn(options.shell ?? "/bin/zsh", ["-lc", input.command], {
      cwd: input.cwd, env: { ...process.env, TERM: "dumb" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, input.timeout_seconds * 1000);
    const take = (chunk: Buffer) => {
      if (size >= HOST_COMMAND_LIMITS.outputBytes) { cut = true; return; }
      const room = HOST_COMMAND_LIMITS.outputBytes - size;
      if (chunk.length > room) cut = true;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      size += part.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      chunks.push(Buffer.from(`\n（启动失败：${error.message}）\n`));
      resolve({ exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut });
    });
  });
  // 已知密钥的值（daemon 的环境里有）和像密钥的字符串都盖掉，再落盘、交给 Lead。
  const output = redactSecretText(redactKnownValues(Buffer.concat(chunks).toString("utf8"), secretEnvValues(process.env)));
  writeFileSync(outputPath, `${output}${cut ? `\n（输出超过 ${HOST_COMMAND_LIMITS.outputBytes} 字节，后面的没有存）\n` : ""}`, { mode: 0o600 });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const lines = output.split("\n").filter((line) => line.length > 0).length;
  const tail = output.length > HOST_COMMAND_LIMITS.tailChars ? `…${output.slice(-HOST_COMMAND_LIMITS.tailChars)}` : output;
  const status = timedOut ? `超过 ${input.timeout_seconds} 秒没跑完，停掉了` : exitCode === 0 ? "跑完了，退出码 0" : `跑完了，退出码 ${exitCode ?? "未知"}`;
  const text = `${status}，用了 ${seconds} 秒。输出共 ${lines} 行，全文在 ${outputPath}（用 read 读）。`
    + (tail.trim() ? `\n末尾：\n${tail.trim()}` : "\n没有输出。");
  return { exitCode, timedOut, outputPath, text };
}

// 启动垫片的 daemon 一侧（spec D7，工单 14）。
// adapter 不再直接 spawn CLI，而是调用 launchProcess。垫片（launcher-shim.mjs）是一个 detached 的进程，
// 它启动 CLI、持有 CLI 的 stdio，把输出追加写进本次启动的文件。daemon 只 tail 这个文件。
// 所以 daemon 进程死了，CLI 不会因为管道断开而退出。
//
// launchProcess 返回的 LaunchedProcess 和 node 的 ChildProcess 有同样的用法：
// stdout、stderr 是可读流，stdin 是可写流，kill 发信号，事件有 spawn、error、exit、close。
// adapter 的解析只读这些流，不关心数据来自管道还是文件。
// stdin 和信号经本 Run 专用的控制 socket 交给垫片。pi 的 RPC 和 steer 因此仍然可用。
//
// 启动目录里的文件（格式见 launcher-shim.mjs）：output.jsonl、exit.json、shim.log。
// 控制 socket 一般也在这里。路径太长时，它放在 /tmp 下一个私有目录里（unix socket 路径有长度上限）。
// 工单 15 用 LauncherIdentity 在 daemon 重启后认出还活着的垫片：pid 加 token，再经控制 socket 核对。
// launch.json 是 daemon 写的启动记录，见 writeLaunchRecord。
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { attachJsonlReader } from "./jsonl.js";
import { deliverOutputFrame } from "./output-cursor.js";
import type { RuntimeProcess } from "./types.js";

const PROTOCOL_VERSION = 1;
// 垫片和 launcher 来自同一份代码：源码运行时在 src/runtimes/ 里，构建产物运行时在 dist/ 里（scripts/build.ts 复制）。
const SHIM_PATH = fileURLToPath(new URL("./launcher-shim.mjs", import.meta.url));
const HANDSHAKE_TIMEOUT_MS = 15_000;
const READ_CHUNK_BYTES = 256 * 1024;
const MIN_POLL_MS = 5;
const MAX_POLL_MS = 100;
// macOS 的 unix socket 路径上限是 104 字节（含结尾的 0）。留一点余量。
const MAX_SOCKET_PATH_BYTES = 100;

export const LAUNCH_FILES = {
  output: "output.jsonl",
  exit: "exit.json",
  log: "shim.log",
  control: "ctl.sock",
  record: "launch.json",
} as const;

// 垫片的身份。daemon 记进 runs.launcher。pid 是垫片的 pid，不是 CLI 的 pid。
// token 只用于控制 socket 的认证和身份核对，不进 argv，不进日志。
export interface LauncherIdentity {
  version: 1;
  pid: number;
  childPid: number | null;
  token: string;
  dir: string;
  controlPath: string;
  // daemon 给这个 Run 开的工具桥（工单 15）。CLI 的 plc MCP 服务器连这个 socket，token 在 CLI 的配置里。
  // daemon 重启后，接管时在同一路径、用同一 token 重建工具桥。launcher 自己不用它。
  toolBridge?: { socketPath: string; token: string };
  // 同一个 Run 里的第几个进程从哪个 seq 往后编号。resume 的会话不存在时，daemon 在同一个 Run 里
  // 开第二个进程（manager.ts 的 startFreshSession），它的 adapter 从 1 编号，daemon 给它加上这个数。
  // 接管时重放这个进程的输出，也要加上同一个数。launcher 自己不用它。没有时为 0。
  seqBase?: number;
}

export interface LaunchSpec {
  runId: number;
  command: string;
  args: string[];
  // 没有给出时，CLI 在 daemon 的当前目录里运行，和直接 spawn 一样。
  cwd?: string;
  // 原样交给 CLI。垫片不增不减。
  env: Record<string, string | undefined>;
  // CLI 是否有 stdin（pi 的 RPC 需要）。没有时 stdin 是 ignore。
  stdin?: boolean;
  // 启动目录的父目录。没有给出时用系统临时目录，进程结束后删除整个启动目录。
  baseDir?: string;
  // CLI 退出后垫片删除的路径（绝对路径）。daemon 来不及清理时，垫片清理。
  removeOnExit?: string[];
  // 垫片自己被终止时，SIGTERM 之后等多久再发 SIGKILL。
  killGraceMs?: number;
}

// 退出记录（exit.json）。
export interface ExitRecord {
  version: number;
  runId: number | null;
  shimPid: number;
  childPid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: SpawnErrorRecord | null;
  outputBytes: number;
  endedAt: string;
}

interface SpawnErrorRecord {
  message: string;
  code: string | null;
  errno: number | null;
  syscall: string | null;
  path: string | null;
}

export interface OutputFrame {
  stream: "stdout" | "stderr";
  text: string;
  // 这一帧在 output.jsonl 里的起止字节偏移。
  start: number;
  end: number;
}

// 从 output.jsonl 的一段字节里取出完整的帧（决策边界，工单 14）。
// 偏移按字节算，不按字符算。最后一行没有换行时，它还没写完：不消费它，下次从它的开头重读。
// 换行符是单字节，所以按字节切开的每一行都是完整的 UTF-8。
// 不是合法帧的行被跳过：它的字节仍然算作已消费，否则 tail 会卡在这一行。
export function decodeOutputFrames(bytes: Buffer, startOffset: number): { frames: OutputFrame[]; consumed: number } {
  const frames: OutputFrame[] = [];
  let consumed = 0;
  while (consumed < bytes.length) {
    const newline = bytes.indexOf(0x0a, consumed);
    if (newline === -1) break;
    const start = startOffset + consumed;
    const end = startOffset + newline + 1;
    const frame = parseFrame(bytes.subarray(consumed, newline).toString("utf8"));
    if (frame) frames.push({ ...frame, start, end });
    consumed = newline + 1;
  }
  return { frames, consumed };
}

function parseFrame(line: string): { stream: "stdout" | "stderr"; text: string } | null {
  try {
    const value = JSON.parse(line) as { stream?: unknown; text?: unknown };
    if ((value.stream === "stdout" || value.stream === "stderr") && typeof value.text === "string") {
      return { stream: value.stream, text: value.text };
    }
  } catch {
    // 不是 JSON。
  }
  return null;
}

export function readExitRecord(dir: string): ExitRecord | null {
  const path = join(dir, LAUNCH_FILES.exit);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ExitRecord;
  } catch {
    return null;
  }
}

// 启动记录：这次启动的垫片身份和 Run id。daemon 在启动垫片以后、把启动说明交给垫片之前写下它。
// 垫片拿到完整的启动说明才启动 CLI，所以凡是可能启动了 CLI 的垫片，都有启动记录。
// daemon 在记下 runs.launcher 之前被杀掉时，库里没有这个垫片的身份。下一个 daemon 按启动记录核对并停止它
// （engine 的 stopUntrackedLaunchers），否则重派的 Run 会和旧的 CLI 同时运行。
// 记录里有 token，所以和库里的身份一样只给当前用户：文件 0600，启动目录 0700。token 不进 argv，不进日志。
// 先写临时文件再改名，读的一方看不到写了一半的记录。
export interface LaunchRecord {
  runId: number;
  identity: LauncherIdentity;
}

function writeLaunchRecord(record: LaunchRecord): void {
  const path = join(record.identity.dir, LAUNCH_FILES.record);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...record.identity, runId: record.runId })}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

// 读启动记录。格式不对、或者记录指向别的启动目录时返回 null。
export function readLaunchRecord(dir: string): LaunchRecord | null {
  const path = join(dir, LAUNCH_FILES.record);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const identity = parseLauncherIdentity(text);
    const runId = (JSON.parse(text) as { runId?: unknown }).runId;
    if (!identity || identity.dir !== dir || !Number.isInteger(runId)) return null;
    return {
      runId: runId as number,
      identity: {
        version: 1, pid: identity.pid, childPid: identity.childPid ?? null, token: identity.token,
        dir: identity.dir, controlPath: identity.controlPath,
      },
    };
  } catch {
    return null;
  }
}

// 宿主进程（daemon 或测试进程）结束时，停止它启动的 child（工单 14）。
// 以前 child 的 stdio 是宿主的管道，宿主一结束，child 就因为管道断开而退出。
// 以前 child 也和宿主在同一个进程组里，终端的 Ctrl-C 同时送到 child。
// 垫片切断了这两层关系，所以这里显式停止，行为保持不变：
// - 宿主正常退出（process.exit、未捕获的异常）：在 exit 事件里给每个垫片发 SIGTERM。
// - 宿主收到 SIGINT、SIGTERM 或 SIGHUP，并且没有别的处理函数：信号会直接结束进程，没有 exit 事件。
//   这里先停止 child，再用同一个信号结束进程。daemon 自己处理 SIGINT 和 SIGTERM（正常停机），这时不插手。
// 被 SIGKILL 的宿主不会走到这里，child 继续运行。
// daemon 不停止 child（工单 15）：它调用 retainChildrenOnHostExit，重启后的 daemon 接管 child。
// 其他宿主（例如测试进程）没有人接管 child，所以仍然停止它们。
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const active = new Set<LaunchedProcess>();
let stopHooksInstalled = false;
let retainOnHostExit = false;

// daemon 启动时调用（spec D7，工单 15）。之后宿主进程退出或被信号结束时，child 继续运行。
// daemon 正常停机结束时传 false：这时 child 都已经分离或结束，同一进程里之后启动的 child 照常停止。
export function retainChildrenOnHostExit(retain = true): void {
  retainOnHostExit = retain;
}

function stopActiveChildren(): void {
  if (retainOnHostExit) return;
  for (const launched of active) {
    try { process.kill(launched.launcher.pid, "SIGTERM"); } catch { /* 已经退出 */ }
  }
}

function installStopHooks(): void {
  if (stopHooksInstalled) return;
  stopHooksInstalled = true;
  process.once("exit", stopActiveChildren);
  for (const signal of STOP_SIGNALS) {
    const onSignal = (): void => {
      if (process.listenerCount(signal) > 1) return;
      stopActiveChildren();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

// runs.launcher 里存的身份。格式不对时返回 null。
export function parseLauncherIdentity(text: string | null): LauncherIdentity | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<LauncherIdentity>;
    const bridge = value.toolBridge;
    const bridgeValid = bridge === undefined
      || (typeof bridge === "object" && bridge !== null
        && typeof bridge.socketPath === "string" && typeof bridge.token === "string");
    const seqBaseValid = value.seqBase === undefined || (Number.isInteger(value.seqBase) && value.seqBase >= 0);
    return value.version === 1 && Number.isInteger(value.pid) && (value.pid ?? 0) > 0
      && typeof value.token === "string" && typeof value.dir === "string" && typeof value.controlPath === "string"
      && bridgeValid && seqBaseValid
      ? value as LauncherIdentity
      : null;
  } catch {
    return null;
  }
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

// 控制 socket 的路径。启动目录的路径太长时，换到 /tmp 下一个新建的私有目录。
function controlPathFor(dir: string): { path: string; extraDir: string | null } {
  const preferred = join(dir, LAUNCH_FILES.control);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return { path: preferred, extraDir: null };
  const extraDir = mkdtempSync("/tmp/plc-ctl-");
  return { path: join(extraDir, LAUNCH_FILES.control), extraDir };
}

interface Handshake {
  version?: number;
  ok: boolean;
  shimPid?: number;
  childPid?: number | null;
  spawnError?: SpawnErrorRecord;
  fatal?: string;
}

function readHandshake(shim: ChildProcess): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => settle(() => {
      shim.kill("SIGKILL");
      reject(new Error("launcher did not report the CLI start in time"));
    }), HANDSHAKE_TIMEOUT_MS);
    shim.stdout!.setEncoding("utf8");
    shim.stdout!.on("data", (chunk: string) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      settle(() => {
        try {
          resolve(JSON.parse(text.slice(0, newline)) as Handshake);
        } catch (error) {
          reject(new Error(`launcher sent an invalid handshake: ${String(error)}`));
        }
      });
    });
    shim.once("error", (error) => settle(() => reject(error)));
    shim.once("exit", (code, signal) => settle(() => {
      reject(new Error(`launcher exited before the CLI started (${code ?? signal})`));
    }));
  });
}

// 垫片会递归删除 removeOnExit 里的路径，所以只接受系统临时目录下的绝对路径，并且不能是临时目录本身。
function assertRemovable(path: string): void {
  const inside = (root: string) => path.startsWith(`${resolve(root)}${sep}`);
  if (!isAbsolute(path) || resolve(path) !== path || !(inside(tmpdir()) || inside("/tmp"))) {
    throw new Error(`launcher refuses to remove ${JSON.stringify(path)} on exit: not a private temporary path`);
  }
}

export async function launchProcess(spec: LaunchSpec): Promise<LaunchedProcess> {
  for (const path of spec.removeOnExit ?? []) assertRemovable(path);
  const ownsBase = spec.baseDir === undefined;
  const base = spec.baseDir ?? tmpdir();
  privateDir(base);
  // 每次启动一个新目录。暂停后恢复的 Run 沿用同一个 Run id，所以目录名带随机后缀。
  const dir = mkdtempSync(join(base, ownsBase ? "plc-launch-" : `r${spec.runId}-`));
  chmodSync(dir, 0o700);
  const control = controlPathFor(dir);
  const token = randomBytes(24).toString("hex");
  const logFd = openSync(join(dir, LAUNCH_FILES.log), "a", 0o600);
  let shim: ChildProcess;
  try {
    // 垫片自己的环境是空的：它不需要 daemon 的环境。CLI 的环境在启动说明里。
    shim = spawn(process.execPath, [SHIM_PATH], {
      cwd: dir, env: {} as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", logFd],
    });
  } finally {
    closeSync(logFd);
  }
  const removeOnExit = [...(spec.removeOnExit ?? []), ...(control.extraDir ? [control.extraDir] : [])];
  const discard = () => {
    if (ownsBase) rmSync(dir, { recursive: true, force: true });
    if (control.extraDir) rmSync(control.extraDir, { recursive: true, force: true });
  };
  shim.stdin!.on("error", () => { /* 垫片提前退出时，握手会报告 */ });
  // 先写启动记录，再交出启动说明（见 writeLaunchRecord）。写不了记录时，垫片还没有启动 CLI，停止它。
  if (shim.pid !== undefined) {
    try {
      writeLaunchRecord({
        runId: spec.runId,
        identity: { version: 1, pid: shim.pid, childPid: null, token, dir, controlPath: control.path },
      });
    } catch (error) {
      shim.kill("SIGKILL");
      discard();
      throw error;
    }
  }
  shim.stdin!.end(JSON.stringify({
    version: PROTOCOL_VERSION,
    runId: spec.runId,
    token,
    dir,
    controlPath: control.path,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd ?? process.cwd(),
    env: spec.env,
    stdin: spec.stdin === true,
    removeOnExit,
    killGraceMs: spec.killGraceMs,
  }));
  let handshake: Handshake;
  try {
    handshake = await readHandshake(shim);
  } catch (error) {
    discard();
    throw error;
  }
  if (handshake.version !== PROTOCOL_VERSION) {
    discard();
    throw new Error(`launcher speaks protocol ${String(handshake.version)}, expected ${PROTOCOL_VERSION}`);
  }
  if (!handshake.ok && !handshake.spawnError) {
    discard();
    throw new Error(`launcher failed: ${handshake.fatal ?? "unknown error"}`);
  }
  // 握手以后 daemon 和垫片之间只剩文件和控制 socket。
  shim.stdout!.destroy();
  shim.unref();
  const launched = new LaunchedProcess({
    shim,
    identity: {
      version: 1, pid: handshake.shimPid ?? shim.pid!, childPid: handshake.childPid ?? null,
      token, dir, controlPath: control.path,
    },
    spawnError: handshake.spawnError ?? null,
    hasStdin: spec.stdin === true,
    removeDirOnClose: ownsBase,
  });
  return launched;
}

// ── 接管（spec D7，工单 15）────────────────────────────────────────────────────
// daemon 重启后，用 runs.launcher 里的身份重新找到垫片。身份核对分两步：
// 1. 连上控制 socket，用 Run 的 token 通过 hello。token 不对、socket 不在或者拒绝连接，都说明这不是本 Run 的垫片。
// 2. hello 回复里的 shimPid 和 runId 必须等于身份里记下的值。
// 所以 pid 被别的进程复用时，接管不会把那个进程当成垫片，也不会给它发信号。
export type LauncherReattach =
  // 垫片还活着。control 是核对过身份的连接，接管的进程用它发命令，并据它的关闭得知垫片退出。
  | { state: "alive"; identity: LauncherIdentity; hello: LauncherHello; control: LauncherControl }
  // 垫片已经退出，留下了本次启动的退出记录。输出文件已经完整。
  | { state: "exited"; identity: LauncherIdentity; record: ExitRecord }
  // 找不到本 Run 的垫片，也没有退出记录（例如机器重启，或者垫片被 SIGKILL）。
  | { state: "gone"; identity: LauncherIdentity; reason: string };

// 垫片回复 hello 只需要一次事件循环。等这么久还没有回复，说明机器负载很高，或者对端不是垫片。
const REATTACH_TIMEOUT_MS = 10_000;

// 库里记下的身份只在它指向这个数据目录的启动目录时才用（工单 15）。
// 控制 socket 在启动目录里，或者在 /tmp 下 mkdtemp 新建的私有目录里（路径太长时，见 controlPathFor）。
// 这样库里的值不能让 daemon 去连别处的 socket，或者读别处的文件。
export function launcherWithin(identity: LauncherIdentity, launchRoot: string): boolean {
  const dir = resolve(identity.dir);
  if (dir !== identity.dir || dirname(dir) !== resolve(launchRoot) || !/^r\d+-[^/]+$/.test(basename(dir))) return false;
  const control = resolve(identity.controlPath);
  if (control !== identity.controlPath) return false;
  if (control === join(dir, LAUNCH_FILES.control)) return true;
  return dirname(dirname(control)) === "/tmp" && basename(dirname(control)).startsWith("plc-ctl-")
    && basename(control) === LAUNCH_FILES.control;
}

export async function reattachLauncher(
  identity: LauncherIdentity,
  runId: number,
  options: { timeoutMs?: number } = {},
): Promise<LauncherReattach> {
  const control = new LauncherControl(identity, { timeoutMs: options.timeoutMs ?? REATTACH_TIMEOUT_MS });
  try {
    const hello = await control.hello;
    if (hello.shimPid !== identity.pid || hello.runId !== runId) {
      control.close();
      return { state: "gone", identity, reason: "launcher identity does not match the run" };
    }
    return { state: "alive", identity: { ...identity, childPid: hello.childPid ?? identity.childPid }, hello, control };
  } catch (error) {
    control.close();
    const record = readExitRecord(identity.dir);
    if (record && record.shimPid === identity.pid && record.runId === runId) {
      return { state: "exited", identity, record };
    }
    return { state: "gone", identity, reason: error instanceof Error ? error.message : String(error) };
  }
}

// 从核对过的身份构造一个 LaunchedProcess（工单 15）。不启动垫片，从输出文件的开头读。
// adapter 的解析状态在偏移之前积累（例如 Claude 的工具名、pi 的 session），所以从头重放，
// 重新产生的事件和已经落库的事件 seq 相同，由 seq 去重。
export type AttachableLaunch = Exclude<LauncherReattach, { state: "gone" }>;

export function attachProcess(reattach: AttachableLaunch, options: { hasStdin: boolean }): LaunchedProcess {
  return new LaunchedProcess({
    shim: null,
    identity: reattach.identity,
    spawnError: null,
    hasStdin: options.hasStdin,
    removeDirOnClose: false,
    control: reattach.state === "alive" ? reattach.control : null,
    shimExited: reattach.state === "exited",
  });
}

// 停止一个核对过身份的垫片（工单 15，例如崩溃循环额度用完时）。
// 只在连接还开着时发信号：连接开着，说明垫片还活着，它的 pid 没有被复用。
// 垫片收到 SIGTERM 后，给 CLI 的进程组发 SIGTERM，宽限期后发 SIGKILL，再写下退出记录。
export function stopReattachedLauncher(reattach: Extract<LauncherReattach, { state: "alive" }>): void {
  if (reattach.control.open) {
    try { process.kill(reattach.identity.pid, "SIGTERM"); } catch { /* 已经退出 */ }
  }
  reattach.control.close();
}

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
}

// 控制 socket 的 hello 回复。工单 15 用 shimPid 和 runId 核对垫片的身份。
export interface LauncherHello {
  runId: number | null;
  shimPid: number | null;
  childPid: number | null;
  exited: boolean;
}

// 本 Run 的控制 socket 的客户端。先用 token 认证，之后按顺序发命令。
// 连接一直开着。垫片退出时连接关闭，接管的进程据此知道垫片已经退出（工单 15）。
export class LauncherControl {
  readonly hello: Promise<LauncherHello>;
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private readonly closeListeners: Array<() => void> = [];

  constructor(private readonly identity: LauncherIdentity, options: { timeoutMs?: number } = {}) {
    this.hello = this.connect(options.timeoutMs);
    this.hello.catch(() => { /* 命令各自报告失败 */ });
  }

  // 连接还开着：对端还活着。
  get open(): boolean {
    return !this.closed && this.socket !== null && !this.socket.destroyed;
  }

  // 连接关闭时调用 listener。已经关闭时立即调用。
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  private connect(timeoutMs?: number): Promise<LauncherHello> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.identity.controlPath);
      this.socket = socket;
      let authed = false;
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        if (authed) return;
        reject(new Error("launcher control did not answer in time"));
        socket.destroy();
      }, timeoutMs);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", token: this.identity.token })}\n`);
      });
      attachJsonlReader(socket, (line) => {
        let message: {
          type?: string; ok?: boolean; id?: string; error?: string;
          runId?: unknown; shimPid?: unknown; childPid?: unknown; exited?: unknown;
        };
        try { message = JSON.parse(line); } catch { return; }
        if (!authed) {
          if (timer) clearTimeout(timer);
          if (message.type === "hello" && message.ok) {
            authed = true;
            resolve({
              runId: integerOrNull(message.runId),
              shimPid: integerOrNull(message.shimPid),
              childPid: integerOrNull(message.childPid),
              exited: message.exited === true,
            });
          } else {
            reject(new Error(`launcher control refused: ${message.error ?? "unknown"}`));
            socket.destroy();
          }
          return;
        }
        const request = message.id ? this.pending.get(message.id) : undefined;
        if (!request) return;
        this.pending.delete(message.id!);
        if (message.ok) request.resolve();
        else request.reject(new Error(message.error ?? "launcher command failed"));
      });
      socket.on("error", (error) => reject(error));
      socket.on("close", () => {
        if (timer) clearTimeout(timer);
        this.closed = true;
        reject(new Error("launcher control closed"));
        for (const request of this.pending.values()) request.reject(new Error("launcher control closed"));
        this.pending.clear();
        for (const listener of this.closeListeners.splice(0)) listener();
      });
    });
  }

  async request(command: Record<string, unknown>): Promise<void> {
    await this.hello;
    if (this.closed || !this.socket) throw new Error("launcher control closed");
    const id = String(this.nextId++);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? value as number : null;
}

// 垫片托管的一个 CLI 进程。daemon 一侧只读文件、经控制 socket 发命令。
export class LaunchedProcess extends EventEmitter implements RuntimeProcess {
  readonly pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly stdin: Writable | null;
  readonly launcher: LauncherIdentity;
  // output.jsonl 里已经交给 stdout、stderr 的字节数，总在帧的边界上。
  outputOffset = 0;

  private readonly control: LauncherControl | null;
  private readonly removeDirOnClose: boolean;
  private file: FileHandle | null = null;
  private readonly readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
  private partial = Buffer.alloc(0);
  // 还没有结束的那一行 stdout 的第一帧的起点。
  private openLineStart: number | null = null;
  private shimExited = false;
  private finished = false;
  private detached = false;
  private pollDelay = MIN_POLL_MS;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;

  // shim：daemon 自己启动的垫片。接管的垫片（工单 15）不是 daemon 的子进程，这时 shim 为 null：
  // 垫片还活着时，control 是已经核对过身份的连接，连接关闭就说明垫片退出了；垫片已经退出时，shimExited 为 true。
  constructor(options: {
    shim: ChildProcess | null;
    identity: LauncherIdentity;
    spawnError: SpawnErrorRecord | null;
    hasStdin: boolean;
    removeDirOnClose: boolean;
    control?: LauncherControl | null;
    shimExited?: boolean;
  }) {
    super();
    this.launcher = options.identity;
    this.removeDirOnClose = options.removeDirOnClose;
    this.pid = options.spawnError ? undefined : options.identity.childPid ?? undefined;
    const shimGone = () => {
      this.shimExited = true;
      this.wake?.();
    };
    options.shim?.once("exit", shimGone);
    this.shimExited = options.shimExited === true;
    this.control = options.spawnError ? null
      : options.control !== undefined ? options.control : new LauncherControl(options.identity);
    if (!options.shim) this.control?.onClose(shimGone);
    this.stdin = options.hasStdin ? this.stdinStream() : null;
    if (options.spawnError) {
      this.reportSpawnError(options.spawnError);
      return;
    }
    active.add(this);
    installStopHooks();
    void this.pump();
  }

  // 和 ChildProcess 一样：spawn 失败时先发 error，再发 close。没有 exit。
  // stdin 在 error 之后才销毁：在这之前写入的数据不会抢在 error 之前报告失败。
  private reportSpawnError(record: SpawnErrorRecord): void {
    const error = Object.assign(new Error(record.message), {
      code: record.code ?? undefined, errno: record.errno ?? undefined,
      syscall: record.syscall ?? undefined, path: record.path ?? undefined,
    });
    this.exitCode = record.errno;
    setImmediate(() => {
      this.emit("error", error);
      this.stdin?.destroy();
      this.stdout.push(null);
      this.stderr.push(null);
      this.stdout.resume();
      this.stderr.resume();
      this.emit("close", record.errno, null);
      this.cleanup();
    });
  }

  // 写进 stdin 的数据经控制 socket 交给垫片，垫片再写进 CLI 的 stdin。顺序不变。
  private stdinStream(): Writable {
    const control = this.control;
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (!control) return callback(new Error("process is not running"));
        control.request({ type: "stdin", data: chunk.toString("base64") }).then(() => callback(), callback);
      },
      final: (callback) => {
        if (!control) return callback();
        control.request({ type: "close_stdin" }).then(() => callback(), () => callback());
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null || this.finished || !this.control) return false;
    this.killed = true;
    this.control.request({ type: "signal", signal }).catch(() => {
      // 控制 socket 不可用时，直接给 CLI 的进程组发信号。
      if (this.finished || this.pid === undefined) return;
      try { process.kill(-this.pid, signal); } catch { /* 已经退出 */ }
    });
    return true;
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.wake = null;
        resolve();
      };
      this.pollTimer = setTimeout(() => this.wake?.(), this.pollDelay);
    });
  }

  private async pump(): Promise<void> {
    try {
      this.file = await open(join(this.launcher.dir, LAUNCH_FILES.output), "r");
      while (!this.finished) {
        if (await this.readAvailable()) {
          this.pollDelay = MIN_POLL_MS;
          continue;
        }
        if (this.detached) return;
        // 垫片在写完全部输出之后才写退出记录。所以看到退出记录后，再读一遍就读到了末尾。
        const record = readExitRecord(this.launcher.dir);
        if (record) {
          while (await this.readAvailable()) { /* 读到末尾 */ }
          this.finish(record);
          return;
        }
        if (this.shimExited) {
          while (await this.readAvailable()) { /* 读到末尾 */ }
          const record = readExitRecord(this.launcher.dir);
          if (!record) this.stopUnsupervisedChild("launcher exited without an exit record");
          this.finish(record ?? this.recordWithoutShim());
          return;
        }
        await this.sleep();
        this.pollDelay = Math.min(MAX_POLL_MS, this.pollDelay * 2);
      }
    } catch (error) {
      // 分离以后关闭文件，正在进行的读取会报错。这不是 tail 失败，CLI 要继续运行。
      if (this.detached) return;
      this.stopUnsupervisedChild(`launcher tail failed: ${String(error)}`);
      this.finish(this.recordWithoutShim());
    }
  }

  // daemon 正常停机时调用（spec D7，工单 15）。daemon 不再读输出，也不再控制 CLI，CLI 和垫片继续运行。
  // 不发 exit 和 close 事件：Run 没有结束。重启后的 daemon 从身份接管它（attachProcess）。
  detach(): void {
    if (this.finished) return;
    this.finished = true;
    this.detached = true;
    active.delete(this);
    this.wake?.();
    void this.file?.close().catch(() => {});
    this.control?.close();
  }

  // 垫片没有留下退出记录就没了（例如它被 SIGKILL），或者 daemon 读不了输出文件。
  // CLI 可能还在跑，却没有人看管，所以停掉它的进程组，并把原因写进 stderr。
  private stopUnsupervisedChild(reason: string): void {
    if (this.detached) return;
    if (this.pid !== undefined) {
      try { process.kill(-this.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    this.stderr.push(Buffer.from(`${reason}\n`));
  }

  // 没有退出记录时，daemon 自己写一份：退出码和信号都未知。
  private recordWithoutShim(): ExitRecord {
    return {
      version: PROTOCOL_VERSION, runId: null, shimPid: this.launcher.pid, childPid: this.pid ?? null,
      exitCode: null, signal: null, spawnError: null, outputBytes: this.outputOffset, endedAt: new Date().toISOString(),
    };
  }

  // 读出新写入的完整帧，交给 stdout、stderr。返回是否读到了新字节。
  private async readAvailable(): Promise<boolean> {
    const { bytesRead } = await this.file!.read(this.readBuffer, 0, this.readBuffer.length, this.outputOffset + this.partial.length);
    if (bytesRead === 0 || this.detached) return false;
    this.partial = Buffer.concat([this.partial, this.readBuffer.subarray(0, bytesRead)]);
    const base = this.outputOffset;
    const { frames, consumed } = decodeOutputFrames(this.partial, base);
    this.partial = this.partial.subarray(consumed);
    for (const frame of frames) {
      // 一行 stdout 超过垫片的上限时，垫片把它拆成几帧。这一行结束之前，游标停在它的第一帧。
      // 这样续读时，adapter 拿到的是完整的一行。
      const cursorStart = this.openLineStart ?? frame.start;
      if (frame.stream === "stdout") this.openLineStart = frame.text.endsWith("\n") ? null : cursorStart;
      // 同步交付这一帧。adapter 在 data 事件里解析它，这时产生的事件带上游标的位置（output-cursor.ts）。
      deliverOutputFrame(cursorStart, () => {
        (frame.stream === "stdout" ? this.stdout : this.stderr).push(Buffer.from(frame.text, "utf8"));
      });
      this.outputOffset = frame.end;
    }
    this.outputOffset = base + consumed;
    return true;
  }

  private finish(record: ExitRecord): void {
    if (this.finished) return;
    this.finished = true;
    active.delete(this);
    this.exitCode = record.exitCode;
    this.signalCode = record.signal;
    void this.file?.close().catch(() => {});
    this.control?.close();
    // 先让已经推进流里的数据送达，再报告退出。pi 在 exit 事件里读 stderr，这时 stderr 已经完整。
    setImmediate(() => {
      this.emit("exit", record.exitCode, record.signal);
      let open = 2;
      const closed = () => {
        open -= 1;
        if (open > 0) return;
        this.emit("close", record.exitCode, record.signal);
        this.cleanup();
      };
      for (const stream of [this.stdout, this.stderr]) {
        stream.once("end", closed);
        stream.push(null);
        // 和 ChildProcess 一样：没有人读的流也要读完，否则 close 不会来。
        if (stream.listenerCount("data") === 0 && !stream.readableFlowing) stream.resume();
      }
    });
  }

  private cleanup(): void {
    if (this.removeDirOnClose) rmSync(this.launcher.dir, { recursive: true, force: true });
  }
}

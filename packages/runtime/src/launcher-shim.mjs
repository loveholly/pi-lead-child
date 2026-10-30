// @ts-check
// 启动垫片（spec D7，工单 14）。daemon 用自己的 Node 运行这个文件，垫片处于 detached 状态。
// 垫片启动 CLI，持有 CLI 的 stdio，所以 daemon 进程退出时 CLI 不会因为管道断开而退出。
// 这个文件是纯 JavaScript，只用 node 内置模块。daemon 不经 tsx、不经构建就能直接运行它，启动也快。
// 协议的另一端是 launcher.ts。两边的格式必须一起改。
//
// 输入：daemon 把启动说明（JSON）写进垫片的 stdin，然后关闭。说明里有 CLI 的环境，可能含凭据，
// 所以不走 argv，也不落盘。
// 握手：垫片在 stdout 写一行 JSON，报告 CLI 是否启动成功。之后垫片不再使用 stdin 和 stdout。
// 文件（都在启动目录里，只有当前用户能读写）：
//   output.jsonl  CLI 的输出。一行一帧：{"stream":"stdout"|"stderr","text":"..."}。
//                 stdout 按行成帧，帧的边界就是 CLI 输出行的边界。超过 1 MiB 的行例外，它被拆成几帧，
//                 只有最后一帧以换行结尾。
//   exit.json     退出记录：退出码、信号、启动错误。写在全部输出之后，用改名保证原子。
//   控制 socket   本 Run 专用。daemon 先用 token 认证，再发 stdin、close_stdin、signal 命令。
// 垫片自己收到 SIGTERM、SIGINT 或 SIGHUP 时，先给 CLI 的进程组发 SIGTERM，宽限期后发 SIGKILL。
// 启动目录被删除时，垫片也这样停止 CLI，然后退出（见 watchLaunchDir）。
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  chmodSync, closeSync, fstatSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const PROTOCOL_VERSION = 1;
// 一行 stdout 超过这个长度还没有换行时，先把已有的部分写成一帧，垫片不无限缓存。
const MAX_PARTIAL_LINE = 1024 * 1024;
// 控制 socket 上一条命令的长度上限。pi 的 prompt 走 stdin 命令，所以上限要宽。
const MAX_CONTROL_LINE = 16 * 1024 * 1024;
const ALLOWED_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
// CLI 退出以后，等它的管道关闭的最长时间。继承了 CLI 管道的子孙进程可能让管道一直不关。
const DRAIN_MS = 2_000;
// 多久检查一次启动目录还在不在。
const LAUNCH_DIR_CHECK_MS = 1_000;

// 垫片创建的文件和 socket 只给当前用户。
process.umask(0o077);

/** @param {unknown} error */
function log(error) {
  try { process.stderr.write(`[launcher-shim ${process.pid}] ${String(error instanceof Error ? error.stack : error)}\n`); } catch { /* 日志不可用 */ }
}
// 垫片的错误只写进 shim.log。CLI 已经启动以后，垫片不能因为自己的错误丢下 CLI。
process.on("uncaughtException", log);

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

// 握手写完以后才能退出。stdout 是管道时，写入可能是异步的。
/** @type {Promise<void>} */
let handshakeFlushed = Promise.resolve();
/** @param {unknown} message */
function handshake(message) {
  process.stdout.on("error", () => { /* daemon 已经走了，握手没人读 */ });
  handshakeFlushed = new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, shimPid: process.pid, ...Object(message) })}\n`, () => resolve());
    setTimeout(resolve, 1_000).unref();
  });
}

/** @param {any} spec */
function validSpec(spec) {
  return spec && spec.version === PROTOCOL_VERSION
    && typeof spec.command === "string" && Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === "string")
    && typeof spec.dir === "string" && isAbsolute(spec.dir)
    && typeof spec.controlPath === "string" && isAbsolute(spec.controlPath)
    && typeof spec.token === "string" && spec.token.length >= 32
    && spec.env && typeof spec.env === "object";
}

/** @returns {any} */
function parseSpec(/** @type {string} */ text) {
  try { return JSON.parse(text); } catch { return null; }
}

const spec = parseSpec(await readStdin());
process.stdin.destroy();
if (!validSpec(spec)) {
  handshake({ ok: false, fatal: "invalid launch spec" });
  await handshakeFlushed;
  process.exit(2);
}

const outputPath = join(spec.dir, "output.jsonl");
const exitPath = join(spec.dir, "exit.json");
const killGraceMs = Number.isFinite(spec.killGraceMs) ? Math.max(0, spec.killGraceMs) : 5_000;
const outputFd = openSync(outputPath, "ax", 0o600);
let outputBytes = 0;

/** @param {"stdout" | "stderr"} stream @param {string} text */
function writeFrame(stream, text) {
  if (!text) return;
  const line = `${JSON.stringify({ stream, text })}\n`;
  writeSync(outputFd, line);
  outputBytes += Buffer.byteLength(line);
}

// stdout 按行成帧，stderr 按块成帧。stderr 不是行协议，按块写能及时送达。
/** @param {"stdout" | "stderr"} stream @param {boolean} byLine */
function framer(stream, byLine) {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  return {
    /** @param {Buffer} chunk */
    write(chunk) {
      const text = decoder.write(chunk);
      if (!byLine) return writeFrame(stream, text);
      partial += text;
      let newline = partial.indexOf("\n");
      while (newline !== -1) {
        writeFrame(stream, partial.slice(0, newline + 1));
        partial = partial.slice(newline + 1);
        newline = partial.indexOf("\n");
      }
      if (partial.length > MAX_PARTIAL_LINE) {
        writeFrame(stream, partial);
        partial = "";
      }
    },
    end() {
      writeFrame(stream, partial + decoder.end());
      partial = "";
    },
  };
}

// 退出记录。临时文件写完、刷盘后再改名，读的一方看到的总是完整的记录。
/** @param {Record<string, unknown>} fields */
function writeExitRecord(fields) {
  const record = {
    version: PROTOCOL_VERSION,
    runId: spec.runId ?? null,
    shimPid: process.pid,
    childPid: child?.pid ?? null,
    exitCode: null,
    signal: null,
    spawnError: null,
    ...fields,
    outputBytes,
    endedAt: new Date().toISOString(),
  };
  const temporary = `${exitPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, exitPath);
}

// 退出时删除的路径，例如 Claude 的 MCP 配置目录（工单 10）。daemon 没等到 CLI 退出时，由垫片清理。
function removeOnExit() {
  for (const path of Array.isArray(spec.removeOnExit) ? spec.removeOnExit : []) {
    if (typeof path !== "string" || !isAbsolute(path) || path === "/") continue;
    try { rmSync(path, { recursive: true, force: true }); } catch (error) { log(error); }
  }
}

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
let childExited = false;
let finished = false;
/** @type {NodeJS.Timeout | null} */
let killTimer = null;
/** @type {NodeJS.Timeout | null} */
let launchDirCheck = null;
const stdoutFramer = framer("stdout", true);
const stderrFramer = framer("stderr", false);

// CLI 有自己的进程组（detached）。信号发给整个组，CLI 启动的子进程也一起收到。
/** @param {NodeJS.Signals} signal */
function signalChild(signal) {
  if (!child?.pid || childExited) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

function terminate() {
  if (!signalChild("SIGTERM")) return;
  killTimer ??= setTimeout(() => signalChild("SIGKILL"), killGraceMs);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, terminate);

const token = Buffer.from(spec.token);
/** @param {unknown} received */
function authorized(received) {
  if (typeof received !== "string") return false;
  const candidate = Buffer.from(received);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

/** @param {import("node:net").Socket} socket @param {unknown} message */
function reply(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** @param {import("node:net").Socket} socket @param {any} command */
function handleCommand(socket, command) {
  const id = typeof command?.id === "string" ? command.id : null;
  const done = (error) => reply(socket, error ? { id, ok: false, error } : { id, ok: true });
  switch (command?.type) {
    case "stdin": {
      if (!child?.stdin || child.stdin.destroyed || typeof command.data !== "string") return done("stdin is not available");
      child.stdin.write(Buffer.from(command.data, "base64"), (error) => done(error ? String(error.message) : null));
      return;
    }
    case "close_stdin":
      child?.stdin?.end();
      return done(null);
    case "signal":
      if (!ALLOWED_SIGNALS.has(command.signal)) return done("signal is not allowed");
      return done(signalChild(command.signal) ? null : "process is not running");
    default:
      return done("unknown command");
  }
}

const server = createServer((socket) => {
  let authed = false;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => { /* 对端断开 */ });
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_CONTROL_LINE) {
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      let message;
      try { message = JSON.parse(line); } catch { message = null; }
      if (!authed) {
        if (message?.type !== "hello" || !authorized(message.token)) {
          reply(socket, { type: "hello", ok: false, error: "unauthorized" });
          socket.end();
          return;
        }
        authed = true;
        reply(socket, {
          type: "hello", ok: true, version: PROTOCOL_VERSION, runId: spec.runId ?? null,
          shimPid: process.pid, childPid: child?.pid ?? null, exited: childExited,
        });
        continue;
      }
      handleCommand(socket, message);
    }
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(spec.controlPath, () => resolve(undefined));
});
// umask 已经去掉了组和其他用户的权限。socket 不需要执行位，所以收紧到 0600。
chmodSync(spec.controlPath, 0o600);

function closeControl() {
  server.close();
  try { rmSync(spec.controlPath, { force: true }); } catch { /* 已经不在 */ }
}

// 退出之前的清理：删除 removeOnExit 里的路径（例如带工具桥 token 的 MCP 配置目录、/tmp 下的控制 socket 目录），
// 关闭控制 socket。每条退出的路径都调用它，只执行一次。
let released = false;
function release() {
  if (released) return;
  released = true;
  removeOnExit();
  closeControl();
}

// 收尾：写完输出和退出记录，清理，然后退出。启动失败时，退出记录写好以后才握手，
// 所以 daemon 收到握手时，退出记录已经在了。
/** @param {Record<string, unknown>} fields @param {unknown} [lateHandshake] */
function finish(fields, lateHandshake) {
  if (finished) return;
  finished = true;
  if (killTimer) clearTimeout(killTimer);
  if (launchDirCheck) clearInterval(launchDirCheck);
  try {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    stdoutFramer.end();
    stderrFramer.end();
    fsyncSync(outputFd);
    closeSync(outputFd);
    writeExitRecord(fields);
  } catch (error) {
    log(error);
  }
  release();
  if (lateHandshake) handshake(lateHandshake);
  void handshakeFlushed.then(() => process.exit(0));
}

let spawned = false;
try {
  child = spawn(spec.command, spec.args, {
    cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
    // 环境原样交给 CLI。环境由 adapter 决定，垫片不增不减。
    env: spec.env,
    stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: true,
  });
} catch (error) {
  child = null;
  spawnFailed(error);
}

/** @param {any} error */
function spawnFailed(error) {
  const spawnError = {
    message: String(error?.message ?? error),
    code: typeof error?.code === "string" ? error.code : null,
    errno: typeof error?.errno === "number" ? error.errno : null,
    syscall: typeof error?.syscall === "string" ? error.syscall : null,
    path: typeof error?.path === "string" ? error.path : null,
  };
  finish({ spawnError }, { ok: false, spawnError });
}

if (child) {
  let streamsOpen = 2;
  /** @type {NodeJS.Timeout | null} */
  let drainTimer = null;
  /** @type {{ exitCode: number | null; signal: NodeJS.Signals | null } | null} */
  let exitInfo = null;
  const settle = () => {
    if (exitInfo && streamsOpen === 0) finish(exitInfo);
  };
  child.stdout?.on("data", (chunk) => stdoutFramer.write(chunk));
  child.stderr?.on("data", (chunk) => stderrFramer.write(chunk));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.once("end", () => { streamsOpen -= 1; settle(); });
    stream?.once("error", log);
  }
  child.stdin?.on("error", () => { /* CLI 不再读 stdin */ });
  child.once("spawn", () => {
    spawned = true;
    handshake({ ok: true, childPid: child?.pid ?? null });
  });
  child.once("error", (error) => {
    if (!spawned) spawnFailed(error);
    else log(error);
  });
  // CLI 退出后，最多再等 DRAIN_MS 让管道关闭。
  child.once("exit", (exitCode, signal) => {
    childExited = true;
    exitInfo = { exitCode, signal };
    drainTimer = setTimeout(() => finish(exitInfo ?? {}), DRAIN_MS);
    settle();
  });
}

// 启动目录被删除以后（例如测试删掉了数据目录），没有人还能读到 CLI 的输出和退出记录，也连不上控制 socket。
// CLI 再运行下去就没有人看管，所以垫片停止它，然后退出。以前垫片和 CLI 在这之后一直运行，成了孤儿进程。
// 判断依据是 output.jsonl 的链接数：它为 0 时，这个文件已经没有路径。
// CLI 被 SIGKILL 以后，垫片照常收尾。到兜底时间还没有退出时，垫片清理以后直接退出。
function watchLaunchDir() {
  launchDirCheck = setInterval(() => {
    let gone = false;
    try { gone = fstatSync(outputFd).nlink === 0; } catch { /* 输出文件已经关闭：垫片正在收尾 */ }
    if (!gone || finished) return;
    if (launchDirCheck) clearInterval(launchDirCheck);
    log("the launch directory is gone; stopping the CLI");
    terminate();
    setTimeout(() => {
      signalChild("SIGKILL");
      release();
      process.exit(1);
    }, killGraceMs + DRAIN_MS + 1_000).unref();
  }, LAUNCH_DIR_CHECK_MS);
  launchDirCheck.unref();
}

if (!finished) watchLaunchDir();

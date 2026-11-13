import { connect } from "node:net";
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import type { SupervisorCommand } from "./protocol.js";

export function supervisorSockPath(dir: string = dataDir()): string {
  return join(dir, "supervisor.sock");
}

// 「已经有实例在跑」只看连接能不能建立。进程活着但正忙时，内核照样接受连接，而 status 请求可能要等好几秒。
// 用 status 判断会把一个忙着的实例当成不在，再起第二个（2026-10-15 live：两个 supervisor 同时在跑）。
// 连接一直没有结果时按「在跑」算：宁可不起第二个实例。
export function socketListening(path: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

export function supervisorListening(dir: string = dataDir()): Promise<boolean> {
  return socketListening(supervisorSockPath(dir));
}

// 负载高时 daemon 启动会超过 30 秒：2026-10-19 14:54Z 负载约 37，daemon 用了 39 秒才开始监听。
// 进程还活着就接着等，所以这个期限只用来认定启动卡住了，可以比正常启动时间长得多。
// 2026-11-03 负载 35–90：daemon 154 秒、129 秒才开始监听，以前的 120 秒期限两次把它记成"没有就绪"，phase 变成 degraded。
// 现在期限是 10 分钟。supervisor（server.ts）和等 ensure_running 的客户端都用这里的值。
export const DEFAULT_DAEMON_READY_TIMEOUT_MS = 10 * 60_000;

/** supervisor 等 daemon 回答第一次 status 的期限。PLC_DAEMON_READY_TIMEOUT_MS 是正整数时用它（毫秒）。 */
export function daemonReadyTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.PLC_DAEMON_READY_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_DAEMON_READY_TIMEOUT_MS;
}

/**
 * 客户端等 ensure_running 回答的期限。supervisor 要等 daemon 就绪才回答，所以比它的期限多 30 秒：
 * 机器忙、daemon 启动慢时，客户端不会比 supervisor 先放弃，把还在启动说成失败。
 */
export function ensureRunningTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return daemonReadyTimeoutMs(env) + 30_000;
}

export const SUPERVISOR_REQUEST_TIMEOUT = "supervisor_request_timeout";

export function supervisorRequest<T = unknown>(
  command: SupervisorCommand,
  opts?: { dataDir?: string; timeoutMs?: number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(supervisorSockPath(opts?.dataDir));
    // 超时带 code SUPERVISOR_REQUEST_TIMEOUT：调用方据此区分「supervisor 还没回答」和「supervisor 拒绝了」（例如 plc daemon start 等 daemon 就绪）。
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("supervisor request timed out"), { code: SUPERVISOR_REQUEST_TIMEOUT }));
    }, opts?.timeoutMs ?? 15_000);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      const response = JSON.parse(line) as { type: string; success: boolean; data?: T; error?: string; code?: string };
      if (response.type !== "response") return;
      clearTimeout(timeout);
      socket.end();
      if (!response.success) {
        reject(Object.assign(new Error(response.error ?? "supervisor request failed"), response.code ? { code: response.code } : {}));
      }
      else resolve(response.data as T);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

export async function supervisorAvailable(dir: string = dataDir()): Promise<boolean> {
  try {
    await supervisorRequest({ type: "status" }, { dataDir: dir, timeoutMs: 1_000 });
    return true;
  } catch {
    return false;
  }
}


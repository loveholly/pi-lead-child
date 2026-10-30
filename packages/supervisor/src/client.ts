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

export function supervisorRequest<T = unknown>(
  command: SupervisorCommand,
  opts?: { dataDir?: string; timeoutMs?: number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(supervisorSockPath(opts?.dataDir));
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("supervisor request timed out"));
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


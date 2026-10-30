// 数据目录里的两条本机 Unix socket：plc.sock（daemon 的本机自举和运维）和 supervisor.sock
// （运行时控制）。协议是 LF 分隔的 JSON 行，消息类型定义在 @pi-lead-child/protocol。
import { connect } from "node:net";
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import type { LocalSocketResponse } from "@pi-lead-child/protocol";

export const plcSockPath = (dir: string = dataDir()) => join(dir, "plc.sock");
export const supervisorSockPath = (dir: string = dataDir()) => join(dir, "supervisor.sock");

// 连不上（没有 socket 文件，或者没有进程在听）。调用方据此判断 daemon 或 supervisor 没在运行。
export class LocalSocketUnavailableError extends Error {}

export type LocalRequest = <T>(path: string, command: object, timeoutMs?: number) => Promise<T>;

export const localRequest: LocalRequest = <T>(path: string, command: object, timeoutMs = 15_000) =>
  new Promise<T>((resolve, reject) => {
    const socket = connect(path);
    let connected = false;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`请求超时：${path}`));
    }, timeoutMs);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.end();
      settle();
    };
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(connected ? error : new LocalSocketUnavailableError(error.message));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: LocalSocketResponse<T>;
        try {
          message = JSON.parse(line) as LocalSocketResponse<T>;
        } catch {
          finish(() => reject(new Error(`无法解析的响应：${path}`)));
          return;
        }
        if (message.type !== "response") continue;
        if (message.success) finish(() => resolve(message.data as T));
        else finish(() => reject(new Error(message.error ?? "请求失败")));
        return;
      }
    });
  });

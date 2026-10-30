import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Db } from "@pi-lead-child/store";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { createAgentToolHandlers } from "./definitions.js";
import { loadCheckpointPolicyConfig } from "@pi-lead-child/core";

export interface AgentToolBridge {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

function send(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function authorized(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Unix socket 路径的长度上限：macOS 是 104 字节（含结尾的 NUL），Linux 是 108 字节。取较小的一个。
const MAX_SOCKET_PATH_BYTES = 103;

// socket 放在数据目录里，不放在工单的工作目录里。工作目录可以很长，socket 路径会因此超限，
// listen 报 EINVAL（run 66）。数据目录由 daemon 决定，路径短而且固定。
function socketDirOf(dataDir: string): string {
  return join(dataDir, "run");
}

// 重建的工具桥只能在本 Run 的 socket 目录里，文件名和新建时的格式相同。
// 这样库里的值不能让 daemon 删除或占用别处的文件。
// 旧版本把 socket 开在工作目录的 .plc 里，升级时还活着的 Run 在那里重建。
function validReuse(
  reuse: { socketPath: string; token: string },
  socketDirs: readonly string[],
  runId: number,
): { socketPath: string; token: string } {
  const prefix = `r${runId}-`;
  const inRunDir = socketDirs.some((socketDir) => {
    const name = reuse.socketPath.slice(socketDir.length + 1);
    return reuse.socketPath === join(socketDir, name) && name.startsWith(prefix)
      && /^[0-9a-f]{8}\.sock$/.test(name.slice(prefix.length));
  });
  if (!inRunDir) {
    throw new Error(`tool bridge path ${JSON.stringify(reuse.socketPath)} is not a socket of run #${runId}`);
  }
  if (!/^[0-9a-f]{48}$/.test(reuse.token)) throw new Error(`tool bridge token of run #${runId} is malformed`);
  return reuse;
}

export async function startAgentToolBridge(args: {
  db: Db;
  itemId: number;
  runId: number;
  workdir: string;
  dataDir: string;
  env?: Record<string, string>;
  // daemon 重启后接管 Run 时（工单 15），在原来的路径、用原来的 token 重建工具桥。
  // CLI 的 plc MCP 服务器只认这两个值。值来自库，所以先核对它们的格式。
  reuse?: { socketPath: string; token: string };
}): Promise<AgentToolBridge> {
  const socketDir = socketDirOf(args.dataDir);
  const reuse = args.reuse
    ? validReuse(args.reuse, [socketDir, join(args.workdir, ".plc")], args.runId)
    : null;
  const token = reuse?.token ?? randomBytes(24).toString("hex");
  const socketPath = reuse?.socketPath ?? join(socketDir, `r${args.runId}-${randomBytes(4).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `tool bridge socket path ${JSON.stringify(socketPath)} is too long `
      + `(${Buffer.byteLength(socketPath)} bytes, limit ${MAX_SOCKET_PATH_BYTES}); use a shorter data directory`,
    );
  }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const handlers = createAgentToolHandlers({
    db: args.db,
    itemId: args.itemId,
    runId: args.runId,
    dataDir: args.dataDir,
    checkpointPolicy: loadCheckpointPolicyConfig(args.env ?? process.env),
  });
  const server: Server = createServer((socket) => {
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let request: any;
      try {
        request = JSON.parse(line);
      } catch {
        send(socket, { type: "response", success: false, error: "parse error" });
        return;
      }
      if (request.type !== "agent_tool" || !authorized(request.token, token)
          || typeof request.id !== "string" || typeof request.name !== "string") {
        send(socket, {
          type: "response",
          id: request?.id,
          success: false,
          error: "unauthorized agent tool request",
        });
        return;
      }
      void handlers.call(request.name, request.arguments ?? {}).then(
        (value) => send(socket, { type: "response", id: request.id, success: true, data: value }),
        (error) => send(socket, {
          type: "response",
          id: request.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    token,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        rmSync(socketPath, { force: true });
        try { rmSync(socketDir, { recursive: false }); } catch { /* shared or non-empty */ }
        resolve();
      });
    }),
  };
}

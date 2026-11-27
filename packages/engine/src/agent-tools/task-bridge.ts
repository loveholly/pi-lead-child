// 通道派的代查跑在 Claude Code 里时的工具桥（工单 #464）。代查的三个工具（lead 的 agent-task/tools.ts）只在 daemon 进程里：
// 它们经连接中心干活，令牌不进 CLI 的进程。CLI 只连 task-mcp-server.ts 这个 MCP 服务器，它经这个 socket 把「列工具」和「调工具」
// 转给 daemon。和 host-bridge.ts 的区别：这里的工具是调用方给的一张固定清单，没有工单的工具，也不碰账本。
// socket 放在数据目录的 run/ 下，每个 Run 一个，带一次性的 token；Run 结束就关。
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { authorized, MAX_SOCKET_PATH_BYTES, send, socketDirOf } from "./host-bridge.js";

export interface TaskToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface TaskBridgeTool {
  name: string;
  description: string;
  // JSON Schema。
  inputSchema: unknown;
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<TaskToolResult>;
}

export interface TaskToolBridge {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

// 一个请求一个连接，请求的 type 是下面两个之一；回答是 { type: "response", id, success, data | error }。
export const TASK_BRIDGE_LIST = "task_tools";
export const TASK_BRIDGE_CALL = "task_call";

export async function startTaskToolBridge(args: {
  dataDir: string;
  runId: number;
  tools: readonly TaskBridgeTool[];
}): Promise<TaskToolBridge> {
  const socketDir = socketDirOf(args.dataDir);
  const token = randomBytes(24).toString("hex");
  const socketPath = join(socketDir, `t${args.runId}-${randomBytes(4).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`task tool bridge socket path is too long (${Buffer.byteLength(socketPath)} bytes, limit ${MAX_SOCKET_PATH_BYTES}); use a shorter data directory`);
  }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const byName = new Map(args.tools.map((tool) => [tool.name, tool]));
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    // 对方断开时写回答会出 EPIPE：和 host-bridge 一样，不让它变成未处理的 error 事件。
    const abort = new AbortController();
    sockets.add(socket);
    socket.on("error", () => { socket.destroy(); });
    // CLI 被中断、进程没了：还在跑的工具调用跟着中止。
    socket.on("close", () => { sockets.delete(socket); abort.abort(); });
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let request: any;
      try {
        request = JSON.parse(line);
      } catch {
        send(socket, { type: "response", success: false, error: "parse error" });
        return;
      }
      if (!authorized(request?.token, token) || typeof request.id !== "string") {
        send(socket, { type: "response", id: request?.id, success: false, error: "unauthorized task tool request" });
        return;
      }
      if (request.type === TASK_BRIDGE_LIST) {
        send(socket, {
          type: "response", id: request.id, success: true,
          data: args.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
        return;
      }
      const tool = request.type === TASK_BRIDGE_CALL && typeof request.name === "string" ? byName.get(request.name) : undefined;
      if (!tool) {
        send(socket, { type: "response", id: request.id, success: false, error: `unknown task tool ${JSON.stringify(request.name)}` });
        return;
      }
      const toolArgs = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments) ? request.arguments : {};
      void tool.call(toolArgs, abort.signal).then(
        (value) => send(socket, { type: "response", id: request.id, success: true, data: value }),
        (error) => send(socket, {
          type: "response", id: request.id, success: false, error: error instanceof Error ? error.message : String(error),
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
        resolve();
      });
      // 还连着的 CLI 不让 close 一直等。
      for (const socket of sockets) socket.destroy();
    }),
  };
}

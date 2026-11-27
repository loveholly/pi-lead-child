// 通道派的代查在 Claude Code 里的工具通道（工单 #464）：一个只做转发的 MCP stdio 服务器。
// 它不碰账本、没有令牌：只认 PLC_AGENT_TASK_SOCKET 和 PLC_AGENT_TASK_TOKEN，把 tools/list、tools/call 转给 daemon 里的
// task-bridge.ts。有哪些工具、怎么执行都由 daemon 说了算。这是一个独立进程的入口，引用它会执行顶层代码。
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { CONNECTION_AGENT_TOOL_TIMEOUT_MS } from "./tool-timeouts.js";

const bridgeSocket = process.env.PLC_AGENT_TASK_SOCKET;
const bridgeToken = process.env.PLC_AGENT_TASK_TOKEN;
if (!bridgeSocket || !bridgeToken) {
  process.stderr.write("task-mcp-server: PLC_AGENT_TASK_SOCKET and PLC_AGENT_TASK_TOKEN are required\n");
  process.exit(2);
}

const send = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const result = (id: string | number, value: unknown): void => send({ jsonrpc: "2.0", id, result: value });
const failure = (id: string | number | null, code: number, message: string): void =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

// 一个请求一个连接。mcp 请求被取消时关掉连接：daemon 那边的工具调用跟着中止。
function callBridge(type: "task_tools" | "task_call", extra: Record<string, unknown>, onSocket?: (close: () => void) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(bridgeSocket!);
    const id = randomUUID();
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("agent task tool timed out")), CONNECTION_AGENT_TOOL_TIMEOUT_MS);
    onSocket?.(() => finish(new Error("cancelled")));
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "response" || message.id !== id) return;
      if (message.success) finish(undefined, message.data);
      else finish(new Error(message.error ?? "daemon task tool failed"));
    });
    socket.once("connect", () => { socket.write(`${JSON.stringify({ type, id, token: bridgeToken, ...extra })}\n`); });
    socket.once("error", (error) => finish(error));
  });
}

const cancellers = new Map<string | number, () => void>();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request: { jsonrpc?: string; id?: string | number; method?: string; params?: any };
  try {
    request = JSON.parse(line);
  } catch {
    failure(null, -32700, "parse error");
    return;
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    if (request.id !== undefined) failure(request.id, -32600, "invalid request");
    return;
  }
  if (request.method === "notifications/cancelled") {
    cancellers.get(request.params?.requestId)?.();
    return;
  }
  if (request.method.startsWith("notifications/")) return;
  if (request.id === undefined) return;
  const id = request.id;
  if (request.method === "initialize") {
    result(id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pi-lead-child-agent-task", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "ping") {
    result(id, {});
    return;
  }
  if (request.method === "tools/list") {
    void callBridge("task_tools", {}).then((tools) => result(id, { tools }), (error) => failure(id, -32000, error instanceof Error ? error.message : String(error)));
    return;
  }
  if (request.method !== "tools/call") {
    failure(id, -32601, `method not found: ${request.method}`);
    return;
  }
  const name = request.params?.name;
  if (typeof name !== "string") {
    failure(id, -32602, "tools/call requires a tool name");
    return;
  }
  void callBridge("task_call", { name, arguments: request.params?.arguments ?? {} }, (close) => cancellers.set(id, close)).then(
    (value) => result(id, value),
    (error) => result(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }),
  ).finally(() => cancellers.delete(id));
});
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

import { createInterface } from "node:readline";
import { connect } from "node:net";
import { openDb } from "@pi-lead-child/store";
import { AGENT_TOOL_DEFINITIONS, createAgentToolHandlers } from "./definitions.js";
import { CONNECTION_AGENT_TOOL_TIMEOUT_MS, HOST_AGENT_TOOL_TIMEOUT_MS } from "./tool-timeouts.js";
import { loadCheckpointPolicyConfig } from "@pi-lead-child/core";
import { attachJsonlReader } from "@pi-lead-child/runtime";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: any;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: string | number, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const dbPath = process.env.PLC_DB;
const itemId = Number(process.env.PLC_TICKET_ID);
const runId = Number(process.env.PLC_ATTEMPT_ID);
if (!dbPath || !Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(runId) || runId < 1) {
  process.stderr.write("mcp-server: PLC_DB, PLC_TICKET_ID, and PLC_ATTEMPT_ID are required\n");
  process.exit(2);
}

const bridgeSocket = process.env.PLC_AGENT_TOOL_SOCKET ?? null;
const bridgeToken = process.env.PLC_AGENT_TOOL_TOKEN ?? null;
// 工单 10：token 由 Codex 的 env_vars 或 Claude 的配置文件送达，不再写在 argv 上。
// 只收到 socket、没收到 token，说明送达的路径坏了。这时启动失败，不悄悄改成直接写库。
if ((bridgeSocket === null) !== (bridgeToken === null)) {
  process.stderr.write("mcp-server: PLC_AGENT_TOOL_SOCKET and PLC_AGENT_TOOL_TOKEN must be set together\n");
  process.exit(2);
}
const proxyThroughBridge = bridgeSocket !== null && bridgeToken !== null;
const db = proxyThroughBridge ? null : openDb(dbPath);
const handlers = db
  ? createAgentToolHandlers({
      db,
      itemId,
      runId,
      dataDir: process.env.PLC_DATA_DIR,
      checkpointPolicy: loadCheckpointPolicyConfig(),
    })
  : null;
const aborters = new Map<string | number, AbortController>();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function callHostTool(
  requestId: string | number,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!bridgeSocket || !bridgeToken) throw new Error("agent tool bridge is unavailable");
  return new Promise((resolve, reject) => {
    const socket = connect(bridgeSocket);
    const id = `mcp:${requestId}`;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error);
      else resolve(value);
    };
    // 连接的工具要等外部服务，最多两分钟多；别的工具 30 秒（tool-timeouts.ts）。
    const timer = setTimeout(() => finish(new Error("host agent tool timed out")),
      name === "call_connection_tool" || name === "search_connection_tools" ? CONNECTION_AGENT_TOOL_TIMEOUT_MS : HOST_AGENT_TOOL_TIMEOUT_MS);
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "response" || message.id !== id) return;
      if (message.success) finish(undefined, message.data);
      else finish(new Error(message.error ?? "daemon agent tool failed"));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        type: "agent_tool",
        id,
        token: bridgeToken,
        name,
        arguments: args,
      })}\n`);
    });
    socket.once("error", (error) => finish(error));
  });
}

lines.on("line", (line) => {
  if (!line.trim()) return;
  let request: JsonRpcRequest;
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
    aborters.get(request.params?.requestId)?.abort();
    return;
  }
  if (request.method.startsWith("notifications/")) return;
  if (request.id === undefined) return;

  if (request.method === "initialize") {
    result(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pi-lead-child-coordinator", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "ping") {
    result(request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    result(request.id, {
      tools: (handlers?.definitions ?? AGENT_TOOL_DEFINITIONS).map((tool) => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      })),
    });
    return;
  }
  if (request.method !== "tools/call") {
    failure(request.id, -32601, `method not found: ${request.method}`);
    return;
  }
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (typeof name !== "string") {
    failure(request.id, -32602, "tools/call requires a tool name");
    return;
  }
  const controller = new AbortController();
  aborters.set(request.id, controller);
  const invocation = proxyThroughBridge
    ? callHostTool(request.id, name, args)
    : handlers!.call(name, args, controller.signal);
  void invocation.then(
    (value) => result(request.id!, {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    }),
    (error) => result(request.id!, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    }),
  ).finally(() => aborters.delete(request.id!));
});

const close = () => {
  for (const controller of aborters.values()) controller.abort();
  db?.close();
};
process.once("SIGTERM", () => { close(); process.exit(0); });
process.once("SIGINT", () => { close(); process.exit(0); });
process.once("exit", close);

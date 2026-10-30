import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDb } from "@pi-lead-child/store";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { AGENT_TOOL_DEFINITIONS, createAgentToolHandlers } from "../agent-tools/definitions.js";
import { AGENT_BRIDGE_TOOLS } from "../agent-tools/connection-host.js";

function readEnv(): { dbPath: string; itemId: number; runId: number } {
  const dbPath = process.env.PLC_DB;
  const itemId = Number(process.env.PLC_TICKET_ID);
  const runId = Number(process.env.PLC_ATTEMPT_ID);
  if (!dbPath || !itemId || !runId) {
    throw new Error("item-tools: PLC_DB / PLC_TICKET_ID / PLC_ATTEMPT_ID env not set");
  }
  return { dbPath, itemId, runId };
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function render(name: string, value: any, itemId: number) {
  if (name === "ticket_update") {
    return text(`Item #${itemId} updated${value.status ? `, status → ${value.status}` : ""}.`);
  }
  if (name === "notify_lead") {
    return text(value.suppressed
      ? "通知已合并到既有通知中（去抖/熔断生效）。"
      : "已通知 lead。");
  }
  if (name === "request_approval") {
    if (value.session_exempt) return text("已获本工单会话豁免，无需再次审批，可继续。", { status: "approved" });
    if (value.status === "approved") return text(`[审批 #${value.approval_id}] 已获批准，可执行。`, { status: "approved" });
    if (value.status === "rejected") return text(`[审批 #${value.approval_id}] 被拒绝，不要执行。`, { status: "rejected" });
    if (value.status === "expired") return text(`[审批 #${value.approval_id}] 审批超时，不要执行。`, { status: "expired" });
    if (value.status === "aborted") return text("审批等待被中止。", { status: "aborted" });
  }
  return text(JSON.stringify(value));
}

// 连接的工具只在 daemon 进程里（令牌不进 child）。pi child 经 daemon 为这个 Run 开的工具桥调用它们：
// socket 和 token 在环境变量里，和 plc MCP 服务器用的是同一个桥。
function callThroughBridge(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const socketPath = process.env.PLC_AGENT_TOOL_SOCKET;
  const token = process.env.PLC_AGENT_TOOL_TOKEN;
  if (!socketPath || !token) return Promise.reject(new Error("connection tools need the daemon tool bridge, which this run does not have"));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const id = `pi:${randomUUID()}`;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.end();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => finish(new Error("connection tool timed out")), 130_000);
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "response" || message.id !== id) return;
      if (message.success) finish(undefined, message.data);
      else finish(new Error(message.error ?? "daemon agent tool failed"));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "agent_tool", id, token, name, arguments: args })}\n`);
    });
    socket.once("error", (error) => finish(error));
  });
}

export default function registerTicketTools(pi: ExtensionAPI) {
  for (const definition of AGENT_TOOL_DEFINITIONS) {
    pi.registerTool({
      name: definition.name,
      label: definition.name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
      description: definition.description,
      parameters: definition.inputSchema as any,
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        if (AGENT_BRIDGE_TOOLS.includes(definition.name)) {
          return text(JSON.stringify(await callThroughBridge(definition.name, params, signal)));
        }
        const { dbPath, itemId, runId } = readEnv();
        const db = openDb(dbPath);
        try {
          const handlers = createAgentToolHandlers({
            db, itemId, runId, dataDir: process.env.PLC_DATA_DIR,
          });
          return render(definition.name, await handlers.call(definition.name, params, signal), itemId);
        } finally {
          db.close();
        }
      },
    });
  }
}

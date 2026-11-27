// 通道派的代查在 Claude Code 里的工具通道（工单 #464）：daemon 里的 task-bridge 和 CLI 里的 task-mcp-server。
// 看三件事：只有给定的工具；token 不对就拒绝；MCP 服务器把 tools/list、tools/call 原样转给桥。
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { startTaskToolBridge, TASK_BRIDGE_CALL, TASK_BRIDGE_LIST, type TaskToolBridge } from "../src/agent-tools/task-bridge.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function rawRequest(bridge: TaskToolBridge, message: Record<string, unknown>): Promise<any> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(bridge.socketPath);
    attachJsonlReader(socket, (line) => { if (line.trim()) { socket.end(); resolveRequest(JSON.parse(line)); } });
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.once("error", reject);
  });
}

async function fixture() {
  const calls: Array<{ args: Record<string, unknown>; aborted: boolean }> = [];
  const dir = tempDir("plc-task-bridge-");
  const bridge = await startTaskToolBridge({
    dataDir: dir, runId: 7,
    tools: [{
      name: "echo", description: "echo the text", inputSchema: { type: "object", properties: { text: { type: "string" } } },
      call: async (args, signal) => {
        calls.push({ args, aborted: signal.aborted });
        return { content: [{ type: "text", text: `echo: ${String(args.text)}` }] };
      },
    }, {
      name: "boom", description: "always fails", inputSchema: { type: "object" },
      call: async () => { throw new Error("tool exploded"); },
    }],
  });
  cleanups.push(() => bridge.close());
  return { bridge, calls };
}

describe("the agent task tool bridge", () => {
  it("lists only the tools it was given and runs them", async () => {
    const { bridge, calls } = await fixture();
    const listed = await rawRequest(bridge, { type: TASK_BRIDGE_LIST, id: "1", token: bridge.token });
    expect(listed.data.map((tool: { name: string }) => tool.name)).toEqual(["echo", "boom"]);
    const called = await rawRequest(bridge, { type: TASK_BRIDGE_CALL, id: "2", token: bridge.token, name: "echo", arguments: { text: "hi" } });
    expect(called).toMatchObject({ success: true, data: { content: [{ type: "text", text: "echo: hi" }] } });
    expect(calls).toEqual([{ args: { text: "hi" }, aborted: false }]);
  });

  it("refuses a wrong token, an unknown tool and a tool that throws", async () => {
    const { bridge, calls } = await fixture();
    expect(await rawRequest(bridge, { type: TASK_BRIDGE_CALL, id: "1", token: "0".repeat(48), name: "echo", arguments: {} }))
      .toMatchObject({ success: false, error: "unauthorized task tool request" });
    expect(await rawRequest(bridge, { type: TASK_BRIDGE_CALL, id: "2", token: bridge.token, name: "bash", arguments: {} }))
      .toMatchObject({ success: false, error: expect.stringContaining("unknown task tool") });
    expect(await rawRequest(bridge, { type: TASK_BRIDGE_CALL, id: "3", token: bridge.token, name: "boom", arguments: {} }))
      .toMatchObject({ success: false, error: "tool exploded" });
    expect(calls).toEqual([]);
  });
});

describe("the agent task MCP server", () => {
  it("forwards tools/list and tools/call to the bridge, and reports a tool failure as an MCP error result", async () => {
    const { bridge } = await fixture();
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/engine/src/agent-tools/task-mcp-server.ts")], {
      env: { ...process.env, PLC_AGENT_TASK_SOCKET: bridge.socketPath, PLC_AGENT_TASK_TOKEN: bridge.token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => { child.kill(); });
    const pending = new Map<number, (value: any) => void>();
    attachJsonlReader(child.stdout!, (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(Number(message.id))?.(message);
    });
    const request = (id: number, method: string, params?: unknown) => new Promise<any>((resolveRequest) => {
      pending.set(id, resolveRequest);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    expect((await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })).result.serverInfo.name).toBe("pi-lead-child-agent-task");
    expect((await request(2, "tools/list", {})).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo", "boom"]);
    expect((await request(3, "tools/call", { name: "echo", arguments: { text: "yo" } })).result.content[0].text).toBe("echo: yo");
    expect((await request(4, "tools/call", { name: "boom", arguments: {} })).result).toMatchObject({ isError: true, content: [{ text: "tool exploded" }] });
  }, 30_000);

  it("does not start without the bridge address", async () => {
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/engine/src/agent-tools/task-mcp-server.ts")], {
      env: { ...process.env, PLC_AGENT_TASK_SOCKET: "", PLC_AGENT_TASK_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    expect(code).toBe(2);
  }, 30_000);
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { startAgentToolBridge } from "../src/agent-tools/host-bridge.js";

describe("Coordinator MCP stdio server", () => {
  it("initializes, lists tools, and executes calls with run-bound identity", async () => {
    const dir = tempDir("plc-mcp-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "parent", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running" });
    const bridge = await startAgentToolBridge({
      db,
      itemId,
      runId,
      workdir: dir,
      dataDir: dir,
    });

    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/engine/src/agent-tools/mcp-server.ts")], {
      env: {
        ...process.env,
        PLC_DB: dbPath,
        PLC_TICKET_ID: String(itemId),
        PLC_ATTEMPT_ID: String(runId),
        PLC_AGENT_TOOL_SOCKET: bridge.socketPath,
        PLC_AGENT_TOOL_TOKEN: bridge.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, (value: any) => void>();
    attachJsonlReader(child.stdout!, (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(Number(message.id))?.(message);
    });
    const request = (id: number, method: string, params?: unknown) => new Promise<any>((resolveRequest) => {
      pending.set(id, resolveRequest);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    try {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      });
      expect(initialized.result.serverInfo.name).toBe("pi-lead-child-coordinator");
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await request(2, "tools/list", {});
      expect(listed.result.tools.map((tool: any) => tool.name)).toContain("begin_planning");
      expect(listed.result.tools.map((tool: any) => tool.name)).toContain("activate_ticket_run");
      const called = await request(3, "tools/call", { name: "begin_planning", arguments: {} });
      expect(called.result.structuredContent).toEqual({ revision: 1 });
      // 执行计划（工单 06）：Codex 和 Claude 经这个服务器拿到 update_ticket_plan，Pi 经扩展拿到同一份定义。
      expect(listed.result.tools.map((tool: any) => tool.name)).toContain("update_ticket_plan");
      const planned = await request(5, "tools/call", {
        name: "update_ticket_plan",
        arguments: { items: [{ id: "read", title: "读现有的代码", status: "in_progress" }] },
      });
      expect(planned.result.structuredContent).toEqual({ ticket_id: itemId, revision: 1, changed: true });

      addActivity(db, {
        itemId,
        runId,
        actor: "user",
        kind: "comment",
        payload: { content: "继续当前工单", route: "ticket_agent_start" },
      });
      const activation = await request(4, "tools/call", {
        name: "activate_ticket_run",
        arguments: {
          mode: "execution",
          instruction: "继续当前工单",
          reason: "user asked the ticket agent to continue",
        },
      });
      expect(activation.result.structuredContent).toMatchObject({
        status: "already_active",
        ticket_id: itemId,
        run_id: runId,
      });
    } finally {
      child.kill();
      await new Promise<void>((resolveChild) => child.once("exit", () => resolveChild()));
      await bridge.close();
      db.close();
    }
  }, 15_000);

  // 工单 10：token 改由 Codex 的 env_vars 或 Claude 的配置文件送达。没送到时，服务器不能悄悄改成直接写库，
  // 而要启动失败。plc 是 required（Codex）或有初始化检查（Claude），Run 因此以 tool_channel_unavailable 失败。
  it("refuses to start when the bridge socket arrives without its token", async () => {
    const dir = tempDir("plc-mcp-half-");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      PLC_DB: join(dir, "plc.db"), PLC_TICKET_ID: "1", PLC_ATTEMPT_ID: "1",
      PLC_AGENT_TOOL_SOCKET: join(dir, "bridge.sock"),
    };
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/engine/src/agent-tools/mcp-server.ts")], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolveExit) => child.once("exit", (exitCode) => resolveExit(exitCode)));
    expect(code).toBe(2);
    expect(stderr).toContain("PLC_AGENT_TOOL_TOKEN");
    expect(existsSync(join(dir, "plc.db"))).toBe(false);
  }, 15_000);
});

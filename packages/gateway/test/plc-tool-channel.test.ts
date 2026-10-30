// 工单 05：plc 工具通道检查。
// runs 53、54 的 plc 工具通道不可用：Claude 的 ToolSearch 找不到 ticket_update。
// agent 照样干了 27 分钟和 9 分钟。Run 结束后，系统才判它"交接失败"。
// 录制里没有初始化消息，所以这里用 fake Claude CLI 构造（Seam 2）。
// 然后经过 runItem 和真实 SQLite，看完整的落库结果（Seam 1）。
// 初始化事件的字段按 Claude Code 2.1.258 核实（读安装的二进制里构造 init 消息的代码，没有发起模型调用）：
// { type: "system", subtype: "init", mcp_servers: [{ name, status }] }，status 取 connected、failed、
// needs-auth、pending、disabled。配置校验失败的服务器另列在 mcp_server_errors 里。
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runItem } from "@pi-lead-child/engine";
import { ClaudeRuntime, toolChannelProblem } from "@pi-lead-child/runtime";
import type { RuntimeEvent, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { listInbox, openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { readGatewayNotifications } from "../testing/gateway-reader.js";

// 用 tsx 启动 fake CLI：runItem 把工单的工作目录设为 cwd，"--import tsx" 在那里解析不到 tsx。
const TSX = resolve("node_modules/.bin/tsx");
const FAKE_CLAUDE = [resolve("packages/runtime/testing/fake-claude.ts")];
const MCP = { command: "node", args: ["plc-mcp-server.js"] };
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function claude(env: Record<string, string>): ClaudeRuntime {
  return new ClaudeRuntime({ bin: TSX, prefixArgs: FAKE_CLAUDE, env, killGraceMs: 200 });
}

async function start(runtime: ClaudeRuntime, request: Partial<RuntimeStartRequest> = {}) {
  const handle = await runtime.start({
    itemId: 1, runId: 7, role: "executor", purpose: "execution", prompt: "do work",
    workdir: process.cwd(), env: {}, mcpServer: MCP, ...request,
  });
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return { events, exit: await handle.wait() };
}

// 决策边界：只有 connected 算就绪。plc 设了 alwaysLoad，所以 pending 也算没连上。
describe("whether the plc tool channel is ready", () => {
  const init = (fields: Record<string, unknown>) => ({ type: "system", subtype: "init", session_id: "s", ...fields });

  it.each([
    ["connected", true],
    ["failed", false],
    ["needs-auth", false],
    ["pending", false],
    ["disabled", false],
  ])("status %s is ready: %s", (status, ready) => {
    expect(toolChannelProblem(init({ mcp_servers: [{ name: "other", status: "failed" }, { name: "plc", status }] })) === null)
      .toBe(ready);
  });

  it("is not ready when plc is missing or its configuration was rejected", () => {
    expect(toolChannelProblem(init({ mcp_servers: [] }))).toContain("没有 MCP 服务器 plc");
    expect(toolChannelProblem(init({}))).toContain("没有 MCP 服务器 plc");
    expect(toolChannelProblem(init({ mcp_servers: [], mcp_server_errors: [{ name: "plc", error: "bad" }] })))
      .toContain("配置无效");
  });
});

describe("the Claude adapter's plc tool channel check", () => {
  it("fails the Run at initialization when plc is not connected", async () => {
    const { events, exit } = await start(claude({ FAKE_CLAUDE_SCENARIO: "happy", FAKE_CLAUDE_MCP_STATUS: "failed" }));
    // 初始化之后的工作一概不认：agent 不在没有 plc 工具通道的情况下工作。
    expect(events.map((event) => event.type)).toEqual(["run.started", "session.updated", "run.failed"]);
    const failed = events.at(-1) as Extract<RuntimeEvent, { type: "run.failed" }>;
    expect(failed.errorCode).toBe("claude_tool_channel_unavailable");
    expect(failed.failure).toMatchObject({ scope: "runtime", retry: "never", needs: "config", code: "tool_channel_unavailable" });
    expect(failed.error).toContain("plc");
    expect(failed.error).toContain("failed");
    expect(exit).toMatchObject({ ok: false, errorCode: "claude_tool_channel_unavailable", externalSessionId: "claude-session-1" });
  });

  it("asks Claude to connect plc before the session starts, and runs normally when it is connected", async () => {
    const { events, exit } = await start(claude({ FAKE_CLAUDE_SCENARIO: "inspect" }));
    const text = events.find((event) => event.type === "message.completed") as Extract<RuntimeEvent, { type: "message.completed" }>;
    // fake CLI 读 --mcp-config 指向的文件（工单 10：配置不再写在 argv 上）。
    const { mcpConfig } = JSON.parse(text.text) as { mcpConfig: unknown };
    // alwaysLoad：Claude Code 2.1.258 在会话开始前连上这个服务器，它的工具也不放进 ToolSearch 的延迟列表。
    // 所以初始化事件里的状态是确定的结果，不是 pending。
    expect(mcpConfig).toEqual({
      mcpServers: { plc: { ...MCP, alwaysLoad: true } },
    });
    expect(exit.ok).toBe(true);
  });

  it("does not check a channel it was not asked to provide", async () => {
    const { exit } = await start(claude({ FAKE_CLAUDE_SCENARIO: "happy", FAKE_CLAUDE_MCP_STATUS: "failed" }), {
      mcpServer: undefined,
    });
    expect(exit.ok).toBe(true);
  });
});

describe("a Claude Run without the plc tool channel", () => {
  // 回归测试：旧代码让 Claude 一直跑到结束，Run 是 finished，然后才判"交接失败"。
  it("fails at initialization with runtime/config and records the profile in the health ledger", async () => {
    const dir = tempDir("plc-tool-channel-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    dbs.push(db);
    const itemId = createItem(db, {
      title: "historical item 72", brief: "b", createdBy: "user", workdir: tempDir("plc-tc-wd-"),
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runtime = claude({ FAKE_CLAUDE_SCENARIO: "happy", FAKE_CLAUDE_MCP_STATUS: "failed" });

    const { runId } = await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions", "item"), prompt: "work",
      runtime, runtimeId: "claude", model: "claude-opus-5", mcpServer: MCP, lingerMs: 0,
    });

    expect(db.prepare("SELECT state, failure_scope, failure_needs, failure_code FROM runs WHERE id=?").get(runId))
      .toEqual({ state: "failed", failure_scope: "runtime", failure_needs: "config", failure_code: "tool_channel_unavailable" });
    // agent 没有在没有 plc 的情况下干活：初始化之后的工具调用没有落库。
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id=? AND event_type='tool.started'").get(runId))
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT runtime, level, code, opened_run_id FROM runtime_incidents").all())
      .toEqual([{ runtime: "claude", level: "profile", code: "tool_channel_unavailable", opened_run_id: runId }]);
    // 不是"交接失败"：工单没有进 blocked。
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?").get(`run-handoff-failed:${runId}`))
      .toEqual({ n: 0 });
    expect(getItem(db, itemId)?.stage).toBe("active");
    // 2026-10-15 起配置故障先交给 Lead：用户不收通知；Lead 马上收到故障说明（Lead 处理不了时才升级给用户）。
    expect(await readGatewayNotifications(db)).toEqual([]);
    expect(listInbox(db, {}).map((row) => JSON.parse(row.payload)).filter((payload) => payload.kind === "runtime_incident"))
      .toEqual([expect.objectContaining({ wakeLead: true, needsUser: false, code: "tool_channel_unavailable" })]);
  });
});

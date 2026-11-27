// 通道派的子 agent 跑在 Claude Code 里（工单 #464）：真实的 tools.ts 工具、假的连接中心和假的 Claude Code runtime，
// 工具桥换成内存里的（看 startBridge 接缝；真的 unix socket 桥在 engine 的 task-bridge.test.ts 里测）。核对：
//   - Claude Code 拿到的是只读形态：agentTask 的系统提示词、只连一个工具通道、模型和推理强度照给；
//   - 桥上只有三个工具，调用走 tools.ts：权限清单照常检查，结果照常核实；
//   - 交了结果并且 CLI 正常结束才算成功；没交结果、超过调用次数上限、CLI 出错都是失败，桥用完就关；
//   - 不是 Claude Code 的 runtime 不能拿来跑代查。
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunGrant } from "@pi-lead-child/protocol";
import {
  AsyncEventQueue, RuntimeEventSequencer,
  type AgentRuntime, type RuntimeEvent, type RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import type { TaskBridgeTool, TaskToolBridge } from "@pi-lead-child/engine";
import { createClaudeAgentTaskRuntime, type AgentTaskConnections } from "../src/index.js";

const GRANT: RunGrant = { version: 1, intent: "knowledge", rules: [], localRepos: [] };

function connections(overrides: Partial<AgentTaskConnections> = {}): AgentTaskConnections {
  return {
    search: async () => [{ connection: "github", name: "get_file_contents", description: "read a file", readOnly: true, inputSchema: {} }],
    call: async () => ({ text: "export const limit = 10;", truncated: false, isError: false }),
    grant: () => ({ revision: 1, labels: ["只读 Acme/x"], grant: GRANT }),
    reads: () => ({ files: [], connectionResults: [] }) as never,
    ...overrides,
  };
}

const RESULT = { found: "yes", answer: "答案", sources: [], checked: ["a"], caveats: [], replyDraft: "draft" };

interface Script {
  // 假 CLI 这一回合要做的事：经桥调用工具（和 MCP 服务器转发的一样），返回它怎么结束。
  (tools: Map<string, TaskBridgeTool>, signal: AbortSignal): Promise<"completed" | "failed" | "wait-for-interrupt">;
}

function harness(script: Script, extra: { id?: string } = {}) {
  const seen: { request: RuntimeStartRequest | null; tools: string[]; bridgeClosed: boolean; interrupted: string | null; workdirEntries: string[] | null } = {
    request: null, tools: [], bridgeClosed: false, interrupted: null, workdirEntries: null,
  };
  let bridgeTools = new Map<string, TaskBridgeTool>();
  const startBridge = async (args: { tools: readonly TaskBridgeTool[] }): Promise<TaskToolBridge> => {
    bridgeTools = new Map(args.tools.map((tool) => [tool.name, tool]));
    seen.tools = args.tools.map((tool) => tool.name);
    return { socketPath: "/fake/bridge.sock", token: "fake-token", close: async () => { seen.bridgeClosed = true; } };
  };
  const inner: AgentRuntime = {
    id: (extra.id ?? "claude") as never,
    capabilities: { streaming: true, steering: true, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: true },
    async start(request) {
      seen.request = request;
      seen.workdirEntries = existsSync(request.workdir) ? readdirSync(request.workdir) : null;
      const queue = new AsyncEventQueue<RuntimeEvent>();
      const events = new RuntimeEventSequencer(request.runId);
      const abort = new AbortController();
      let release!: () => void;
      const interrupted = new Promise<void>((resolve) => { release = resolve; });
      queue.push(events.event({ type: "run.started", runtime: "claude", model: request.model ?? null }));
      const done = script(bridgeTools, abort.signal).then(async (how) => {
        if (how === "wait-for-interrupt") await interrupted;
        if (how === "failed" || how === "wait-for-interrupt") {
          queue.push(events.event({
            type: "run.failed", exitCode: 1, errorCode: how === "failed" ? "claude_api_error" : "interrupted",
            error: how === "failed" ? "claude exploded" : "interrupted",
            failure: { code: "unknown", scope: "unknown", retry: "never", needs: "none", evidence: "" } as never,
          }));
        } else {
          queue.push(events.event({ type: "run.completed", exitCode: 0 }));
        }
        queue.end();
        return how;
      });
      return {
        pid: 1, events: queue,
        interrupt: async (reason) => { seen.interrupted = reason; abort.abort(); release(); },
        wait: async () => {
          const how = await done;
          return how === "completed"
            ? { ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }
            : { ok: false, exitCode: 1, signal: null, externalSessionId: null, errorCode: "claude_api_error", errorMessage: "claude exploded" };
        },
      };
    },
  };
  return { inner, seen, startBridge };
}

async function run(
  h: ReturnType<typeof harness>,
  options: Partial<Parameters<typeof createClaudeAgentTaskRuntime>[0]> = {},
  conns: AgentTaskConnections = connections(),
) {
  const runtime = createClaudeAgentTaskRuntime({
    inner: h.inner, intent: "knowledge", ownerName: "Leo", connections: conns, dataDir: "/fake",
    model: "sonnet", effort: "medium", startBridge: h.startBridge as never, ...options,
  });
  const handle = await runtime.start({
    itemId: 1, runId: 5, role: "executor", purpose: "lookup", workdir: "/", env: {}, prompt: "who owns Acme/x?",
  });
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return { runtime, events, exit: await handle.wait(), terminal: events.at(-1)! };
}

const callTool = (tools: Map<string, TaskBridgeTool>, name: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
  tools.get(name)!.call(args, signal);

describe("the Claude Code agent task runtime", () => {
  it("starts Claude Code read-only: system prompt, one tool channel, the given model and effort, and only the three tools", async () => {
    const h = harness(async (tools) => { await callTool(tools, "submit_result", RESULT); return "completed"; });
    await run(h);
    expect(h.seen.tools).toEqual(["search_connection_tools", "call_connection_tool", "submit_result"]);
    const request = h.seen.request!;
    expect(request).toMatchObject({ model: "sonnet", effort: "medium", purpose: "lookup" });
    expect(request.mcpServer?.env).toEqual({ PLC_AGENT_TASK_SOCKET: "/fake/bridge.sock", PLC_AGENT_TASK_TOKEN: "fake-token" });
    expect(request.agentTask?.systemPrompt).toContain("只读 Acme/x");
    expect(request.agentTask?.systemPrompt).toContain("mcp__plc__submit_result");
  });

  // 工单 #464 评审：代查工单没有 workdir，CLI 会在 daemon 的 cwd 里启动，可能读到那里往上的 CLAUDE.md。
  it("starts Claude Code in an empty temporary directory, not the daemon's cwd, and removes it afterwards", async () => {
    const h = harness(async (tools) => { await callTool(tools, "submit_result", RESULT); return "completed"; });
    await run(h);
    const workdir = h.seen.request!.workdir;
    expect(workdir).not.toBe("/");
    expect(workdir).not.toBe(process.cwd());
    expect(h.seen.workdirEntries).toEqual([]);
    expect(existsSync(workdir)).toBe(false);
  });

  it("succeeds when the result is submitted and the CLI ends normally; the grant check and the source check stay in code", async () => {
    const h = harness(async (tools) => {
      expect((await callTool(tools, "call_connection_tool", { connection: "github", tool: "get_file_contents", arguments: {} })).content[0]!.text)
        .toContain("<untrusted_external_text");
      await callTool(tools, "submit_result", RESULT);
      return "completed";
    });
    const { runtime, terminal, exit } = await run(h);
    expect(terminal.type).toBe("run.completed");
    expect(exit.ok).toBe(true);
    expect(runtime.outcome()).toMatchObject({ error: null, calls: 1, result: { found: "yes", answer: "答案" } });
    expect(h.seen.bridgeClosed).toBe(true);
  });

  it("reports a refused tool call to the model as an error result", async () => {
    const h = harness(async (tools) => {
      const refused = await callTool(tools, "call_connection_tool", { connection: "github", tool: "merge_pull_request", arguments: {} });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.content[0]!.text).toContain("没有调成");
      await callTool(tools, "submit_result", RESULT);
      return "completed";
    });
    const { terminal } = await run(h, {}, connections({ call: async () => { throw Object.assign(new Error("不在清单里"), { code: "grant_refused" }); } }));
    expect(terminal.type).toBe("run.completed");
  });

  // 工单 #464 评审：进程内的 pi 会话先按 schema 校验参数再调 execute；经桥直接调 execute 就没有这一步。
  it("refuses tool arguments that do not match the tool schema, without calling the connection", async () => {
    let calls = 0;
    const h = harness(async (tools) => {
      for (const bad of [{ connection: 42, tool: "get_file_contents" }, { connection: "github" }, { connection: "x".repeat(41), tool: "t" }]) {
        const refused = await callTool(tools, "call_connection_tool", bad);
        expect(refused).toMatchObject({ isError: true });
        expect(refused.content[0]!.text).toContain("参数不符合");
      }
      await callTool(tools, "submit_result", RESULT);
      return "completed";
    });
    const { terminal } = await run(h, {}, connections({ call: async () => { calls += 1; return { text: "x", truncated: false, isError: false }; } }));
    expect(calls).toBe(0);
    expect(terminal.type).toBe("run.completed");
  });

  it("fails a run that ends normally without submit_result", async () => {
    const h = harness(async () => "completed");
    const { runtime, terminal, exit } = await run(h);
    expect(terminal).toMatchObject({ type: "run.failed", errorCode: "agent_task_no_result" });
    expect(exit).toMatchObject({ ok: false, errorCode: "agent_task_no_result" });
    expect(runtime.outcome()).toMatchObject({ result: null, error: "子 agent 没有用 submit_result 交结果" });
    expect(h.seen.bridgeClosed).toBe(true);
  });

  it("fails when Claude Code itself fails, keeping its error", async () => {
    const h = harness(async () => "failed");
    const { runtime, terminal } = await run(h);
    expect(terminal).toMatchObject({ type: "run.failed", errorCode: "claude_api_error" });
    expect(runtime.outcome().error).toBe("claude exploded");
    expect(h.seen.bridgeClosed).toBe(true);
  });

  it("stops the run when the tool call limit is exceeded", async () => {
    const h = harness(async (tools, signal) => {
      for (let index = 0; index < 20 && !signal.aborted; index += 1) await callTool(tools, "search_connection_tools", {});
      return "wait-for-interrupt";
    });
    const { runtime, terminal } = await run(h, { limits: { maxToolCalls: 2 } });
    expect(h.seen.interrupted).toContain("用完了工具调用的次数");
    expect(terminal).toMatchObject({ type: "run.failed", errorCode: "agent_task_limit" });
    expect(runtime.outcome().error).toContain("用完了工具调用的次数");
  });

  it("stops the run when it passes the duration limit", async () => {
    const h = harness(async () => "wait-for-interrupt");
    const { terminal } = await run(h, { maxDurationMs: 20 });
    expect(h.seen.interrupted).toContain("时长上限");
    expect(terminal).toMatchObject({ type: "run.failed", errorCode: "agent_task_limit" });
  });

  it("refuses a runtime that is not Claude Code, because it would not honour the read-only form", () => {
    const h = harness(async () => "completed", { id: "codex" });
    expect(() => createClaudeAgentTaskRuntime({
      inner: h.inner, intent: "knowledge", ownerName: "Leo", connections: connections(), dataDir: "/fake", model: null, effort: null,
    })).toThrow(/only works on Claude Code/);
  });

  it("closes the tool bridge when Claude Code cannot start", async () => {
    const h = harness(async () => "completed");
    h.inner.start = async () => { throw new Error("spawn failed"); };
    const runtime = createClaudeAgentTaskRuntime({
      inner: h.inner, intent: "knowledge", ownerName: "Leo", connections: connections(), dataDir: "/fake", model: "sonnet", effort: "medium",
      startBridge: h.startBridge as never,
    });
    await expect(runtime.start({ itemId: 1, runId: 5, role: "executor", purpose: "lookup", workdir: "/", env: {}, prompt: "q" })).rejects.toThrow("spawn failed");
    expect(h.seen.bridgeClosed).toBe(true);
  });
});

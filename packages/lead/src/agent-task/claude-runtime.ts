// 通道派的子 agent 在用户停用 pi 时跑在 Claude Code 里（工单 #464，2026-11-25）：代查不能再落到停用的 pi 会话。缺省仍是 pi（工单 #501）。
// 形态还是只读，和 runtime.ts 的进程内会话一样：
//   - CLI 没有自带工具，不读用户的设置和 hooks，只连一个工具通道（claude.ts 的 buildAgentTaskArgs，RuntimeStartRequest.agentTask）；
//   - 工具通道是 task-mcp-server.ts，它把「列工具」「调工具」经 daemon 里的 task-bridge 转给 tools.ts 的三个工具：
//     search_connection_tools、call_connection_tool、submit_result。令牌和连接中心都在 daemon 进程里，CLI 拿不到；
//   - 权限清单、调用次数上限、出处核实和 runtime.ts 用同一份代码（tools.ts、provenance.ts）。
// 内核照常管它：runItem 建 Run、落事件、按 purpose=lookup 收尾。Run 的结局：交了结果（submit_result）并且 CLI 正常结束是
// run.completed；CLI 正常结束却没交结果、超过工具调用上限或时长上限、CLI 出错、被中断，都是 run.failed。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { agentTaskMcpServer, removeTree, type TypedFailure } from "@pi-lead-child/core";
import { startTaskToolBridge, type TaskToolBridge } from "@pi-lead-child/engine";
import type { GrantIntent } from "@pi-lead-child/protocol";
import {
  AGENT_TASK_TOOL_CHANNEL_RUNTIME, typedFailure, type AgentRuntime, type RuntimeEvent, type RuntimeExit, type RuntimeHandle, type RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { agentTaskSystemPrompt } from "./prompt.js";
import { verifyAgentTaskResult, type AgentTaskVerification } from "./provenance.js";
import { DEFAULT_AGENT_TASK_MAX_DURATION_MS, type AgentTaskRunOutcome, type AgentTaskRuntime } from "./runtime.js";
import { createAgentTaskTools, type AgentTaskConnections, type AgentTaskToolLimits, type AgentTaskToolState } from "./tools.js";

// Claude Code 里 MCP 工具的名字带服务器名（claude.ts 的 TOOL_CHANNEL_SERVER）。提示词里的工具名是不带前缀的，这里补一句。
const TOOL_NAME_NOTE = "你的工具来自一个叫 plc 的 MCP 服务器，实际名字带前缀 mcp__plc__（例如 mcp__plc__submit_result）。上面的工具名都指它们。";

export function createClaudeAgentTaskRuntime(options: {
  // Claude Code 的 runtime（daemon 的 registry 里的那个）。
  inner: AgentRuntime;
  intent: GrantIntent;
  ownerName: string;
  replyStyle?: string;
  connections: AgentTaskConnections;
  dataDir: string;
  model: string | null;
  effort: string | null;
  limits?: Partial<AgentTaskToolLimits>;
  maxDurationMs?: number;
  // 测试接缝：默认是 daemon 里真的 unix socket 工具桥。
  startBridge?: typeof startTaskToolBridge;
}): AgentTaskRuntime {
  const { inner } = options;
  // 不认识 agentTask 的 adapter 会给子 agent 全部自带工具：不能拿来跑代查。
  if (inner.id !== AGENT_TASK_TOOL_CHANNEL_RUNTIME) {
    throw new Error(`the agent task tool channel only works on Claude Code, not '${inner.id}'`);
  }
  let toolState: AgentTaskToolState | null = null;
  let started = false;
  let error: string | null = null;
  let runId: number | null = null;
  let verification: AgentTaskVerification | null = null;

  const verify = (): AgentTaskVerification | null => {
    if (!toolState?.submitted || runId === null) return null;
    const grant = options.connections.grant(runId)?.grant ?? null;
    verification ??= verifyAgentTaskResult({
      result: toolState.submitted,
      grant: grant ?? { version: 1, intent: options.intent, rules: [], localRepos: [] },
      reads: options.connections.reads(runId),
    });
    return verification;
  };

  return {
    id: inner.id,
    // 一个回合就结束：不 resume、不 steer。
    capabilities: { ...inner.capabilities, steering: false, resume: false },
    ...(inner.profile ? { profile: inner.profile } : {}),
    // 装好了没有、登录了没有：问 Claude Code 自己，健康账本和派发 gate 才看得到它。
    ...(inner.probe ? { probe: inner.probe.bind(inner) } : {}),
    ...(inner.preflight ? { preflight: inner.preflight.bind(inner) } : {}),
    outcome: (): AgentTaskRunOutcome => {
      const checked = verify();
      return { result: checked?.result ?? null, verification: checked, error, calls: toolState?.calls ?? 0 };
    },
    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      if (started) throw new Error("an agent task runtime runs only once");
      started = true;
      runId = request.runId;
      let handle: RuntimeHandle | null = null;
      let limitReason: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const stop = (reason: string): void => {
        limitReason ??= reason;
        void handle?.interrupt(reason).catch(() => {});
      };

      const { tools, state } = createAgentTaskTools({
        runId: request.runId, connections: options.connections,
        ...(options.limits ? { limits: options.limits } : {}),
        onLimitExceeded: () => stop("子 agent 用完了工具调用的次数还在继续调用"),
      });
      toolState = state;
      let bridge: TaskToolBridge | null = null;
      // 代查工单没有工作目录，CLI 会在 daemon 的 cwd 里启动，可能读到那里往上的 CLAUDE.md（评审意见）。
      // 换成一个空的临时目录：项目里的记忆文件读不到。用户自己的 ~/.claude/CLAUDE.md 不在这里管：--restricted 没说它会跳过。
      const scratchDir = mkdtempSync(join(tmpdir(), "plc-agent-task-"));
      const closeBridge = async (): Promise<void> => {
        const closing = bridge;
        bridge = null;
        // 在子进程里删（core 的 removeTree），不在 daemon 进程里递归删除（lead-scheduler spec P0）。删不掉不影响这次的结局。
        await removeTree(scratchDir, { kind: "agent-task-scratch-delete", label: "agent task scratch", priority: "utility" }).catch(() => undefined);
        await closing?.close().catch(() => {});
      };
      // 结局：没交结果或超限，就算 CLI 自己正常退出，这次也是失败。
      const unmet = (): { code: string; message: string } | null => {
        if (limitReason !== null) return { code: "agent_task_limit", message: limitReason };
        if (!state.submitted) return { code: "agent_task_no_result", message: "子 agent 没有用 submit_result 交结果" };
        return null;
      };
      const failureEvent = (event: RuntimeEvent, code: string, message: string): RuntimeEvent => ({
        type: "run.failed", runId: event.runId, seq: event.seq, occurredAt: event.occurredAt,
        exitCode: null, errorCode: code, error: message,
        failure: typedFailure("task_failed", { errorCode: code, message }) as TypedFailure,
      });

      try {
        bridge = await (options.startBridge ?? startTaskToolBridge)({
          dataDir: options.dataDir, runId: request.runId,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            call: async (args, signal) => {
              // 进程内的 pi 会话在调 execute 以前按 schema 校验参数；经桥直接调 execute 就没有这一步，所以这里补上，
              // 不通过的当成工具报错还给模型（和 pi 的行为一致）。
              if (!Value.Check(tool.parameters, args)) {
                const first = [...Value.Errors(tool.parameters, args)][0] as { instancePath?: string; message?: string } | undefined;
                return {
                  content: [{ type: "text" as const, text: `参数不符合这个工具的要求：${first ? `${first.instancePath || "/"} ${first.message}` : "格式不对"}。改好参数再调。` }],
                  isError: true,
                };
              }
              const out = await (tool.execute as (...input: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>)(
                `${request.runId}:${tool.name}`, args, signal, undefined, undefined,
              );
              return { content: out.content, ...(out.isError ? { isError: true } : {}) };
            },
          })),
        });
        const server = agentTaskMcpServer();
        const maxDurationMs = options.maxDurationMs ?? DEFAULT_AGENT_TASK_MAX_DURATION_MS;
        handle = await inner.start({
          ...request,
          workdir: scratchDir,
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          mcpServer: { ...server, env: { PLC_AGENT_TASK_SOCKET: bridge.socketPath, PLC_AGENT_TASK_TOKEN: bridge.token } },
          agentTask: {
            systemPrompt: [agentTaskSystemPrompt({
              ownerName: options.ownerName, intent: options.intent, grantLabels: options.connections.grant(request.runId)?.labels ?? [],
              replyStyle: options.replyStyle ?? "",
            }), "", TOOL_NAME_NOTE].join("\n"),
          },
        });
        timer = setTimeout(() => stop(`子 agent 超过了 ${Math.round(maxDurationMs / 1000)} 秒的时长上限`), maxDurationMs);
        timer.unref?.();
      } catch (setupError) {
        if (timer) clearTimeout(timer);
        await closeBridge();
        throw setupError;
      }

      const live: RuntimeHandle = handle;
      const finish = async (): Promise<void> => {
        if (timer) clearTimeout(timer);
        await closeBridge();
      };
      async function* events(): AsyncGenerator<RuntimeEvent> {
        try {
          for await (const event of live.events) {
            if (event.type === "run.completed") {
              const missing = unmet();
              if (missing) {
                error = missing.message;
                yield failureEvent(event, missing.code, missing.message);
                continue;
              }
            } else if (event.type === "run.failed") {
              const reason = limitReason !== null ? { code: "agent_task_limit", message: limitReason } : null;
              error = reason?.message ?? event.error;
              yield reason ? failureEvent(event, reason.code, reason.message) : event;
              continue;
            }
            yield event;
          }
        } finally {
          await finish();
        }
      }
      return {
        pid: live.pid,
        ...(live.process ? { process: live.process } : {}),
        events: events(),
        interrupt: (reason: string) => live.interrupt(reason),
        wait: async (): Promise<RuntimeExit> => {
          const exit = await live.wait();
          await finish();
          if (!exit.ok) {
            error ??= exit.errorMessage;
            return exit;
          }
          const missing = unmet();
          if (!missing) {
            verify();
            return exit;
          }
          error ??= missing.message;
          return { ...exit, ok: false, errorCode: missing.code, errorMessage: missing.message };
        },
      };
    },
  };
}

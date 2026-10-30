// 子 agent（通道派的工单）的 runtime：只读形态（landing.md 第 5 节）。一个 AgentRuntime，在 daemon 进程里跑一个受限的 pi 会话：
// 不开子进程，没有 shell，拿不到环境变量，不加载用户的 MCP、扩展、技能和 AGENTS.md，也没有 pi 自带的读文件工具。
// 工具只有 tools.ts 里经连接中心的那几个，连接中心按这个 Run 的权限清单检查每一次调用。会话的隔离和代查共用
// （lookup/session.ts 的 createIsolatedLookupSession：建好以后核对一次工具，多一个少一个都不用这个会话）。
//
// 为什么不用 Claude、Codex、pi 的 CLI（2026-10-22 看过 packages/runtime）：
//   - Claude Code 能做到：--tools "" 去掉所有自带工具，--strict-mcp-config 只连 plc；但用户的 hooks、插件和设置照样加载，
//     子进程拿到 daemon 的整个环境。
//   - pi 能做到：--tools 写白名单、--no-mcp、-ne 只加载显式的扩展；子进程同样拿到整个环境。
//   - Codex 做不到：exec 一定带 shell 工具（read-only 沙箱只挡写，不挡读本机的任何文件），~/.codex/config.toml 里的 MCP 照样连。
//   进程内的会话最干净：工具就是我们给的那几个，没有别的进程。
//
// 内核照常管它：runItem 建 Run、落事件、按 purpose=lookup 收尾（不改生命周期、不升 blocker、不叫醒 Lead）。
// Run 的结局：交了结果（submit_result）并且回合正常结束是 run.completed；没交结果、LLM 错误、超过工具调用上限或时长上限、
// 被中断是 run.failed。结束以后 outcome() 给出核实过出处的结果（provenance.ts），派单器交回发起方。
import type { TypedFailure } from "@pi-lead-child/core";
import type { AgentTaskResult, GrantIntent } from "@pi-lead-child/protocol";
import {
  AsyncEventQueue, classifyPiFailure, createPiEventMapper, LOCAL_RUNTIME_ID, RuntimeEventSequencer, typedFailure,
  type AgentRuntime, type RuntimeEvent, type RuntimeExit, type RuntimeHandle, type RuntimeProfile, type RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import type { LookupSession, LookupSessionFactory } from "../lookup/session.js";
import { agentTaskSystemPrompt } from "./prompt.js";
import { verifyAgentTaskResult, type AgentTaskVerification } from "./provenance.js";
import {
  AGENT_TASK_TOOL_NAMES, createAgentTaskTools, type AgentTaskConnections, type AgentTaskToolLimits, type AgentTaskToolState,
} from "./tools.js";

// 一次运行最长多久。派单器另有自己的超时。
export const DEFAULT_AGENT_TASK_MAX_DURATION_MS = 15 * 60_000;

/**
 * profile 身份：runtime 记 pi（线上契约的 RuntimeId 是封闭联合），可执行文件是一个不存在的进程内标记，
 * 所以健康账本不会把它和真实的 pi CLI 混在一起。没有子进程，所以也没有 PATH、解释器、扩展和环境变量。
 */
export const AGENT_TASK_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  runtime: LOCAL_RUNTIME_ID,
  executable: "in-process:agent-task",
  configDir: null,
  interpreter: null,
  extensions: [],
  models: { defaultModel: null, providers: null },
  environment: { path: "", inherit: "all", adapterVariables: [] },
  allowedTools: [...AGENT_TASK_TOOL_NAMES],
}) as RuntimeProfile;

export interface AgentTaskRunOutcome {
  // 核实过出处的结果。没交结果时为 null。
  result: AgentTaskResult | null;
  verification: AgentTaskVerification | null;
  // Run 失败时的原因；正常结束时为 null。
  error: string | null;
  // 工具调用的次数。
  calls: number;
}

export interface AgentTaskRuntime extends AgentRuntime {
  /** 这次运行到现在为止的结局。Run 结束以后读它。 */
  outcome(): AgentTaskRunOutcome;
}

export function createAgentTaskRuntime(options: {
  intent: GrantIntent;
  ownerName: string;
  // 用户的代回复风格（protocol 的 reply-style.ts）。空的时候按缺省的写法。
  replyStyle?: string;
  connections: AgentTaskConnections;
  sessionFactory: LookupSessionFactory;
  limits?: Partial<AgentTaskToolLimits>;
  maxDurationMs?: number;
  now?: () => Date;
}): AgentTaskRuntime {
  const now = options.now ?? (() => new Date());
  let toolState: AgentTaskToolState | null = null;
  let started = false;
  let error: string | null = null;
  let runId: number | null = null;
  let verification: AgentTaskVerification | null = null;

  // 核实在交了结果以后、第一次读结局时做一次：连接中心的读取记录在 Run 结束以后由派单器丢掉，所以派单器先读结局再丢。
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
    id: LOCAL_RUNTIME_ID,
    // 一个回合就结束：不 resume、不 steer。放宽的权限在下一次工具调用时生效（tools.ts 的 grantNote）。
    capabilities: {
      streaming: true, steering: false, resume: false, interrupt: true, approvals: false, mcp: false,
      executableReadOnlyReview: false,
    },
    profile: AGENT_TASK_RUNTIME_PROFILE,
    outcome: () => {
      const checked = verify();
      return { result: checked?.result ?? null, verification: checked, error, calls: toolState?.calls ?? 0 };
    },
    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      if (started) throw new Error("an agent task runtime runs only once");
      started = true;
      runId = request.runId;
      const queue = new AsyncEventQueue<RuntimeEvent>();
      const events = new RuntimeEventSequencer(request.runId, () => now().toISOString());
      let resolveExit!: (exit: RuntimeExit) => void;
      const exitPromise = new Promise<RuntimeExit>((resolve) => { resolveExit = resolve; });
      let terminal = false;
      let session: LookupSession | null = null;
      let unsubscribe: (() => void) | null = null;
      let disposed = false;
      let interruptReason: string | null = null;
      let limitReason: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        unsubscribe?.();
        try { session?.dispose(); } catch { /* 会话已经坏了，没有别的要收拾 */ }
      };
      const finish = (exit: RuntimeExit, event: RuntimeEvent): void => {
        if (terminal) return;
        terminal = true;
        if (timer) clearTimeout(timer);
        if (!exit.ok) error = exit.errorMessage;
        else verify();
        queue.push(event);
        queue.end();
        resolveExit(exit);
      };
      const fail = (errorCode: string, message: string, failure: TypedFailure): void => {
        finish(
          { ok: false, exitCode: null, signal: null, externalSessionId: null, errorCode, errorMessage: message },
          events.event({ type: "run.failed", exitCode: null, errorCode, error: message, failure }),
        );
      };
      // 回合结束时定结局。中断和超限优先：那时会话是被我们停下的。
      const settle = (llmError: string | null): void => {
        if (terminal) return;
        if (interruptReason !== null) {
          fail("interrupted", interruptReason, typedFailure("run_interrupted", { errorCode: "interrupted", message: interruptReason }));
        } else if (limitReason !== null) {
          fail("agent_task_limit", limitReason, typedFailure("task_failed", { errorCode: "agent_task_limit", message: limitReason }));
        } else if (llmError !== null) {
          fail("llm_error", llmError, classifyPiFailure({ errorCode: "llm_error", message: llmError }));
        } else if (!toolState?.submitted) {
          const message = "子 agent 没有用 submit_result 交结果";
          fail("agent_task_no_result", message, typedFailure("task_failed", { errorCode: "agent_task_no_result", message }));
        } else {
          finish(
            { ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null },
            events.event({ type: "run.completed", exitCode: 0 }),
          );
        }
      };
      const stop = (reason: { interrupt?: string; limit?: string }): void => {
        if (terminal) return;
        if (reason.interrupt !== undefined) interruptReason ??= reason.interrupt;
        if (reason.limit !== undefined) limitReason ??= reason.limit;
        void session?.abort().catch(() => {});
      };

      const { tools, state } = createAgentTaskTools({
        runId: request.runId, connections: options.connections,
        ...(options.limits ? { limits: options.limits } : {}),
        onLimitExceeded: () => stop({ limit: "子 agent 用完了工具调用的次数还在继续调用" }),
      });
      toolState = state;

      let model: string | null;
      try {
        const created = await options.sessionFactory({
          runId: request.runId,
          systemPrompt: agentTaskSystemPrompt({
            ownerName: options.ownerName, intent: options.intent, grantLabels: options.connections.grant(request.runId)?.labels ?? [],
            replyStyle: options.replyStyle ?? "",
          }),
          tools,
        });
        session = created.session;
        model = created.model;
      } catch (setupError) {
        const message = `子 agent 的会话建不起来：${setupError instanceof Error ? setupError.message : String(setupError)}`;
        fail("agent_task_setup_failed", message, typedFailure("runtime_start_failed", { errorCode: "agent_task_setup_failed", message }));
        return { pid: null, events: queue, interrupt: async () => {}, wait: () => exitPromise };
      }

      const mapNative = createPiEventMapper({
        runId: request.runId,
        runtime: LOCAL_RUNTIME_ID,
        model,
        emit: (input) => { if (!terminal) queue.push(events.event(input)); },
        settle,
      });
      unsubscribe = session.subscribe((native) => {
        try {
          mapNative(native);
        } catch (mapError) {
          const message = String(mapError);
          fail("event_normalization", message, typedFailure("host_exception", { errorCode: "event_normalization", message }));
          stop({});
        }
      });
      const maxDurationMs = options.maxDurationMs ?? DEFAULT_AGENT_TASK_MAX_DURATION_MS;
      timer = setTimeout(() => stop({ limit: `子 agent 超过了 ${Math.round(maxDurationMs / 1000)} 秒的时长上限` }), maxDurationMs);
      timer.unref?.();

      const running = (async () => {
        try {
          await session!.prompt(request.prompt);
        } catch (promptError) {
          if (!terminal && interruptReason === null && limitReason === null) {
            const message = promptError instanceof Error ? promptError.message : String(promptError);
            fail("prompt_failed", message, classifyPiFailure({ errorCode: "prompt_failed", message }));
          }
        } finally {
          settle(null);
          dispose();
        }
      })();

      return {
        pid: null,
        events: queue,
        interrupt: async (reason: string) => {
          stop({ interrupt: reason || "interrupted" });
          await running;
        },
        wait: () => exitPromise,
      };
    },
  };
}

import type { RunPurpose, RuntimeId, TypedFailure } from "@pi-lead-child/core";
import type { RuntimeProfile } from "./profile.js";
import type { FailureEvidence } from "./typed-failure.js";
import type { AttachableLaunch, LauncherIdentity } from "./launcher.js";
import type { ModelDiscovery } from "./model-discovery.js";

export interface RuntimeCapabilities {
  streaming: boolean;
  steering: boolean;
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  mcp: boolean;
  executableReadOnlyReview: boolean;
}

export interface RuntimeStartRequest {
  itemId: number;
  runId: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  prompt: string;
  workdir: string;
  sessionDir?: string;
  model?: string;
  // 推理强度（effort）。adapter 换成自己 CLI 的控制：Claude Code 的 --effort、Codex 的
  // model_reasoning_effort、pi 的 --thinking。没有时不传，由 CLI 自己决定。
  effort?: string;
  resumeSessionId?: string;
  // 和 resumeSessionId 一起用：在这个 session 的副本上开一个新 session，原来的 session 不变。
  // 工单对话用它读一个暂停的 Run 的上下文：恢复控制之后还要续接那个 session。
  forkSession?: boolean;
  env: Record<string, string>;
  mcpServer?: { command: string; args: string[]; env?: Record<string, string> };
  // 启动垫片放文件的目录（工单 14）。没有给出时，垫片用系统临时目录，进程结束后删除。
  launchDir?: string;
}

// daemon 重启后接管一个还在跑或已经退出的 CLI（spec D7，工单 15）。
// launch 是内核核对过身份的垫片。adapter 用 attachProcess 从它构造进程，从输出文件的开头读，
// 再用和 start 相同的解析处理它：不启动新进程，也不再发启动时的命令。
// 重新产生的事件和已经落库的事件 seq 相同，由内核去重。
export interface RuntimeAttachRequest {
  itemId: number;
  runId: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  workdir: string;
  model?: string;
  // 启动时是否给了 plc 工具通道。Claude 据此检查初始化消息里的通道状态，重放时要和启动时一致。
  toolChannel: boolean;
  // 启动时 resume 的外部 session。Codex 在重放出 thread id 之前用它。
  resumeSessionId?: string;
  launch: AttachableLaunch;
}

interface RuntimeEventBase {
  runId: number;
  seq: number;
  occurredAt: string;
}

export type RuntimeEvent = RuntimeEventBase & (
  | { type: "run.started"; runtime: RuntimeId; model: string | null }
  | { type: "session.updated"; externalSessionId: string; runtimeVersion?: string }
  | { type: "message.delta"; messageId: string; delta: string }
  | { type: "message.completed"; messageId: string; role: "assistant"; text: string; stopReason?: string }
  | { type: "tool.started"; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; callId: string; name: string; update: unknown }
  | { type: "tool.completed"; callId: string; name: string; result: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string }
  | {
      type: "usage.updated"; mode: "delta" | "cumulative";
      inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number | null;
    }
  | { type: "run.completed"; exitCode: number; reason?: string }
  // failure 由 adapter 根据原生输出给出（spec D1）。errorCode 是 runtime 自己报的码，只作诊断。
  | { type: "run.failed"; exitCode: number | null; errorCode: string; error: string; failure: TypedFailure }
  | { type: "runtime.stderr"; text: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RuntimeEventInput = DistributiveOmit<RuntimeEvent, keyof RuntimeEventBase>;

export interface RuntimeExit {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  externalSessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

// 一个 CLI 进程（工单 14）。adapter 经启动垫片启动 CLI，得到 launcher.ts 的 LaunchedProcess。
// 它和 node 的 ChildProcess 有同样的这些成员，所以 manager 和停止的代码不区分两者。
export interface RuntimeProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  // 垫片的身份。工单 15 在 daemon 重启后据此认出还活着的垫片。
  readonly launcher?: LauncherIdentity;
  // daemon 正常停机时不再读这个进程，进程继续运行（工单 15）。只有垫片启动的进程有它。
  detach?(): void;
}

export interface RuntimeHandle {
  readonly pid: number | null;
  readonly process?: RuntimeProcess;
  readonly events: AsyncIterable<RuntimeEvent>;
  send?(message: string): Promise<void>;
  steer?(message: string): Promise<void>;
  // 不停进程换模型和推理强度（工单 08，spec 5.3）：同一个 Run 接着跑，从下一次调用模型开始生效。只给要换的项。
  // adapter 没有它时，内核停在当前这一步，用同一个会话和新的参数重新拉起（新 Run 带 resumed_from_run_id）。
  setProfile?(change: { model?: string; effort?: string }): Promise<void>;
  interrupt(reason: string): Promise<void>;
  wait(): Promise<RuntimeExit>;
}

// 健康探针的输入（spec D2，工单 04）。model 是要检查的模型，没有时用 runtime 的默认模型。
export interface RuntimeProbeRequest {
  model: string | null;
  signal?: AbortSignal;
}

// checks 列出跑过的检查项，只作诊断。失败时 failure 用 D1 的同一张映射表。
// 探针不读取、不返回 CLI 打印的账号信息。
// timedOut：最后一条命令超时。超时说明不了安装坏了，所以 preflight 不因此挂起请求（工单 05）。
export type RuntimeProbeResult =
  | { ok: true; checks: string[] }
  | { ok: false; checks: string[]; failure: TypedFailure; timedOut?: boolean };

// preflight 的输入（工单 05）。preflight 只检查安装，不看模型和账号。
export interface RuntimePreflightRequest {
  signal?: AbortSignal;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  // 健康账本按 profile 记录状态（spec D2）。没有给出时，内核用这个 runtime 的默认 profile。
  readonly profile?: RuntimeProfile;
  start(request: RuntimeStartRequest): Promise<RuntimeHandle>;
  // 接管 daemon 重启前启动的 CLI（工单 15）。adapter 没有它时，内核不接管这个 runtime 的 Run，
  // 改走孤儿回收。
  attach?(request: RuntimeAttachRequest): Promise<RuntimeHandle>;
  // 不发起模型调用、不花钱的健康探针（工单 04），例如版本命令和登录状态命令。
  // adapter 没有探针时，到了探针时间按通过处理，故障关闭。
  probe?(request: RuntimeProbeRequest): Promise<RuntimeProbeResult>;
  // 派发 claim 之前的安装检查（工单 05）：解释器满足要求、扩展文件存在、版本命令能运行。
  // 它是探针的前一段，不检查账号：登录状态命令在 API key 这类配置下可能误判，claim 时不能因此挂起派发。
  // adapter 没有它时，preflight 只做模型和工作区的检查。
  preflight?(request: RuntimePreflightRequest): Promise<RuntimeProbeResult>;
}

// 环境变量表。目录和默认模型读它，测试可以注入自己的表。
export type RuntimeEnv = Record<string, string | undefined>;

// 模型目录与校验（spec D8）。
export interface RuntimeModelRules {
  // 没有指定模型时用的模型。返回 undefined 时，由 CLI 自己决定。
  defaultModel(env?: RuntimeEnv): string | undefined;
  // 把派发里的模型名换成 CLI 接受的名字。模型名已经去掉首尾空白，并且不为空。
  // 模型不属于这个 runtime 时抛错，这样在创建 Run 之前就拒绝它。
  resolve(model: string): string;
}

// 一个 runtime 在 registry 里的登记项（spec D8，工单 12）。
// 内核按 runtime id 从 registry 读这些知识，不按 runtime 的名字写分支。
// 新增一个 runtime：写一个 AgentRuntime 和它的 RuntimeAdapter，再在 registry 的装配处登记。
export interface RuntimeAdapter<Options = unknown> {
  readonly id: RuntimeId;
  // 给人看的名字。失败标题、检查点和通知都用它。
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;
  readonly models: RuntimeModelRules;
  // usage 事件是否带 USD 成本。配置了 USD 预算的工单只能派给带成本的 runtime。
  readonly reportsCost: boolean;
  // 类型化失败的分类（spec D1）。内核只对没有类型的失败调用它，例如进程退出却没有终止事件。
  classifyFailure(evidence: FailureEvidence): TypedFailure;
  // 本机目录用：这个 CLI 的可执行文件。找不到时返回 null。cwd 是项目的根目录。
  locateExecutable(cwd: string): string | null;
  // 模型目录：问 CLI 自己接受哪些模型和 effort 档位（model-discovery.ts）。只读，不读凭据。
  // 没有它，或者它返回 ok=false 时，这个 runtime 的目录是 unknown。
  discoverModels?(context: { cwd: string; env?: RuntimeEnv; timeoutMs?: number }): Promise<ModelDiscovery>;
  // child 命令里的 $TMPDIR 和后台命令输出的位置（给 Lead 的 read_run_events 用）。它们和 Lead 的沙箱 $TMPDIR 不同。
  // 没有它，或者它返回 null 时，Lead 只看事件。
  tempFiles?(context: { workdir: string | null; sessionId: string | null }): { tmpdir: string; tasks: string | null } | null;
  // 按 daemon 的默认配置创建一个可以启动的实例。options 覆盖默认配置。
  create(options?: Options): AgentRuntime;
}

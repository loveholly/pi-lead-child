// 回放型 runtime：把一次已经归一化的历史 Run 交给 child manager。
// 事件保持录制时 adapter 归一化后的样子。回放时只重写 runId、seq 和 occurredAt。
// 因此同一份录制可以在任意 Run 上回放，账本看到的是一个真实的 runtime。
// 录制早于类型化失败（工单 02），run.failed 没有 failure。回放时用真实 adapter 的分类函数，
// 按录制里的终止错误和 stderr 补上，与 adapter 当时看到的证据一致。
import { ClaudeRuntime } from "../src/claude.js";
import { CodexRuntime } from "../src/codex.js";
import { PiRuntime } from "../src/pi.js";
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeEvent, RuntimeEventInput, RuntimeExit,
  RuntimeHandle, RuntimeStartRequest,
} from "../src/types.js";
import { classifyFailure } from "../src/registry.js";
import type { RuntimeId } from "@pi-lead-child/core";

type FailedEvent = Extract<RuntimeEventInput, { type: "run.failed" }>;
type RecordedFailedEvent = Omit<FailedEvent, "failure"> & { failure?: FailedEvent["failure"] };
export type RecordedEvent = Exclude<RuntimeEventInput, FailedEvent> | RecordedFailedEvent;

export interface RecordedRun {
  runtime: RuntimeId;
  events: RecordedEvent[];
}

type TerminalEvent = Extract<RecordedEvent, { type: "run.completed" | "run.failed" }>;

// 能力取自真实 adapter，回放与生产不会各自漂移。
const ADAPTERS: Record<RuntimeId, AgentRuntime> = {
  pi: new PiRuntime(),
  codex: new CodexRuntime(),
  claude: new ClaudeRuntime(),
};

function isTerminal(event: RecordedEvent): event is TerminalEvent {
  return event.type === "run.completed" || event.type === "run.failed";
}

export class ReplayRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  private readonly recording: RecordedRun;
  private readonly terminal: TerminalEvent;

  constructor(recording: RecordedRun) {
    const last = recording.events.at(-1);
    if (!last || !isTerminal(last) || recording.events.filter(isTerminal).length !== 1) {
      throw new Error("a recorded run must end with exactly one terminal event");
    }
    this.id = recording.runtime;
    this.capabilities = { ...ADAPTERS[recording.runtime].capabilities };
    this.recording = recording;
    this.terminal = last;
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const stderr = this.recording.events
      .map((event) => event.type === "runtime.stderr" ? event.text : "")
      .join("");
    const events = this.recording.events.map((event, index) => ({
      ...event,
      ...(event.type === "run.failed" && !event.failure ? {
        failure: classifyFailure(this.id, { errorCode: event.errorCode, message: event.error, stderr }),
      } : {}),
      runId: request.runId,
      seq: index + 1,
      occurredAt: new Date().toISOString(),
    }) as RuntimeEvent);
    const exit = this.exit();
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => exit,
    };
  }

  private exit(): RuntimeExit {
    let externalSessionId: string | null = null;
    for (const event of this.recording.events) {
      if (event.type === "session.updated") externalSessionId = event.externalSessionId;
    }
    if (this.terminal.type === "run.failed") {
      return {
        ok: false, exitCode: this.terminal.exitCode, signal: null, externalSessionId,
        errorCode: this.terminal.errorCode, errorMessage: this.terminal.error,
      };
    }
    return {
      ok: true, exitCode: this.terminal.exitCode, signal: null, externalSessionId,
      errorCode: null, errorMessage: null,
    };
  }
}

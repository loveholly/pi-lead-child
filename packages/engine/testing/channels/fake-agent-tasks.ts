// 假的子 agent 派单器（落地计划 B 的测试用）：照 C 的派单器的接口（protocol 的 AgentTaskDispatcher）。派单时用真的
// computeRunGrant 算清单（上限 ∩ 范围，超出的丢掉），在库里建一张工单和一个 Run（工单 active）；测试用 finish 交回结果，
// 和 daemon 一样按回调交给 hub.agentTaskFinished，工单跟着进 done 或 cancelled。
import {
  computeRunGrant, type AgentTaskAction, type AgentTaskDispatch, type AgentTaskDispatcher, type AgentTaskOutcome,
  type AgentTaskRequest, type AgentTaskResult, type GrantLocalRepo, type RunGrant,
} from "@pi-lead-child/protocol";
import { createItem, createRun, transition, type Db } from "@pi-lead-child/store";
import type { ChannelHub } from "../../src/index.js";

export class FakeAgentTaskDispatcher implements AgentTaskDispatcher {
  readonly requests: Array<AgentTaskRequest & { runId: number; itemId: number; grant: RunGrant; dropped: string[] }> = [];
  hub: Pick<ChannelHub, "agentTaskFinished"> | null = null;
  failNext: string | null = null;
  private readonly handlers = new Map<string, (outcome: AgentTaskOutcome) => void>();

  constructor(private readonly db: Db, private readonly localRepos: Record<string, string> = {}) {}

  async dispatch(request: AgentTaskRequest): Promise<AgentTaskDispatch> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    const resolveLocalRepo = (name: string): GrantLocalRepo | null => (this.localRepos[name] ? { name, root: this.localRepos[name]! } : null);
    const { grant, dropped } = computeRunGrant({ intent: request.intent, scope: request.scope, ...(request.bound ? { bound: request.bound } : {}), resolveLocalRepo });
    const ids = this.db.transaction(() => {
      const itemId = createItem(this.db, { title: `子 agent：${request.request.summary.slice(0, 40)}`, brief: "测试", createdBy: "system", purpose: "lookup" });
      const runId = createRun(this.db, { itemId, purpose: "lookup" });
      transition(this.db, { itemId, to: "active", actor: "system", reason: "agent task started", runId });
      return { itemId, runId };
    })();
    this.requests.push({ ...request, ...ids, grant, dropped });
    return { ...ids, grant, dropped };
  }

  async cancel(runId: number): Promise<void> {
    await this.finish(runId, { status: "cancelled", result: null });
  }

  onFinished(kind: string, handler: (outcome: AgentTaskOutcome) => void): void {
    this.handlers.set(kind, handler);
  }

  /** 交回一张工单的结果：缺省查到了，草稿是给定的一句。 */
  async finish(runId: number, input: {
    status?: AgentTaskOutcome["status"]; result?: AgentTaskResult | null; actions?: AgentTaskAction[]; error?: string | null;
  } = {}): Promise<void> {
    const request = this.requests.find((entry) => entry.runId === runId);
    if (!request) throw new Error(`没有派过 Run #${runId}`);
    const status = input.status ?? "finished";
    const step = (to: "review" | "done" | "cancelled") => transition(this.db, { itemId: request.itemId, to, actor: "system", reason: `agent task ${status}`, runId });
    this.db.transaction(() => {
      if (status === "finished") {
        step("review");
        step("done");
      } else {
        step("cancelled");
      }
    })();
    const outcome: AgentTaskOutcome = {
      runId, itemId: request.itemId, callback: request.callback, status,
      result: input.result === undefined ? null : input.result, actions: input.actions ?? [], reads: [], error: input.error ?? null,
      grant: request.grant,
    };
    const handler = this.handlers.get(request.callback.kind);
    if (handler) handler(outcome);
    else this.hub?.agentTaskFinished(outcome);
  }
}

/** 子 agent 交的结果：查到了，一处核实过的出处。 */
export function agentTaskResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    found: "yes",
    answer: "重试最多等 10 分钟（MAX_DELAY_MS = 600_000）。",
    sources: [{ via: "local", repo: "acme/orders", path: "src/retry.ts", startLine: 1, endLine: 1, quote: "MAX_DELAY_MS = 600_000", verified: true }],
    checked: ["acme/orders 的 src/retry.ts"],
    caveats: [],
    replyDraft: "重试最多等 10 分钟，见 src/retry.ts 的 MAX_DELAY_MS。",
    ...overrides,
  };
}

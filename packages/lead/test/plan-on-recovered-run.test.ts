// 审查 H1（工单 06）：执行 Run 开新会话、不续接时，看不到当前计划。被拒以后 agent 按报错把原来的步骤补回去，
// 标题只能猜，原标题就丢了。recover_ticket_run 换 runtime 时就是这样：新 runtime 不能续接另一个 CLI 的会话，
// resumeFromRunId 是 undefined（runtime-recovery.ts）。这里走完整的路：Lead 换 runtime 恢复 → 派发认领 → 启动新 Run，
// 断言新 Run 的提示词里有现在的计划。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, recoverTicketRun } from "@pi-lead-child/engine";
import {
  createItem, createRun, getExecutionPlan, openDb, recordExecutionPlan, transition, updateRun,
} from "@pi-lead-child/store";
import { RuntimeRegistry, type AgentRuntime, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { runningChildren, spawnClaimedItem, type LeadDeps } from "../src/tools.js";

function fakeClaude(captured: RuntimeStartRequest[]): AgentRuntime {
  return {
    id: "claude",
    capabilities: { streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: false },
    async start(request): Promise<RuntimeHandle> {
      captured.push(request);
      return {
        pid: null, events: (async function* () {})(), interrupt: async () => {},
        wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
      };
    },
  };
}

describe("a run that recover_ticket_run moves to another runtime", () => {
  it("starts with the current execution plan in its prompt", async () => {
    const dir = tempDir("plc-plan-recovery-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "修复空输入", brief: "修好空输入。", createdBy: "lead", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const failed = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5" });
    updateRun(db, failed, { state: "running" });
    recordExecutionPlan(db, {
      itemId, runId: failed,
      steps: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入的处理", status: "in_progress", note: "改到一半" },
      ],
    });
    updateRun(db, failed, {
      state: "failed", endedAt: true, externalSessionId: "codex-thread-1",
      errorCode: "codex_error", errorMessage: "Selected model is at capacity. Please try a different model.",
    });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "runtime failed", runId: failed });

    const recovered = recoverTicketRun(db, {
      itemId, failedRunId: failed, action: "switch_runtime", runtime: "claude", authorityRef: "runtime-recovery:capacity",
    });
    expect(recovered).toMatchObject({ status: "queued", runtime: "claude", resumedFromRunId: null });
    const claim = createDispatcher(db).claimNext();
    expect(claim).toMatchObject({ itemId, runtime: "claude", resumeFromRunId: null });

    const captured: RuntimeStartRequest[] = [];
    const deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([fakeClaude(captured)]) } as LeadDeps;
    spawnClaimedItem(deps, claim!);
    await runningChildren().get(itemId);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.resumeSessionId).toBeUndefined();
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain("## 执行计划");
    expect(prompt).toContain('- [done] read："读现有的解析器"');
    expect(prompt).toContain('- [in_progress] fix："修复空输入的处理"（备注："改到一半"）');
    // 计划本身没有变：新 Run 拿到的就是账本里的那一版。
    expect(getExecutionPlan(db, itemId)?.revision).toBe(1);
  });
});

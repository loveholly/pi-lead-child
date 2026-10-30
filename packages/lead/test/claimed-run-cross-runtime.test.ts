// 派发认领的 Run 要续接来源 Run 的会话，但来源 Run 是另一个 runtime 的（例如它的 runtime 被用户停用，这次重新选了一个，
// 2026-10-19 发布评审）。那是另一个 CLI 的会话：不传 resume，开新会话，提示里带上工单的上下文。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, openDb, updateRun } from "@pi-lead-child/store";
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

describe("a claimed run whose resume source ran on another runtime", () => {
  it("starts a fresh session instead of resuming the other CLI's session", async () => {
    const dir = tempDir("plc-cross-runtime-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "修复登录", brief: "修好登录。", createdBy: "lead" });
    const source = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, source, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare("UPDATE runs SET external_session_id='codex-thread-1' WHERE id=?").run(source);
    const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    const captured: RuntimeStartRequest[] = [];
    const deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([fakeClaude(captured)]) } as LeadDeps;
    spawnClaimedItem(deps, {
      requestId: 1, itemId, runId, leaseToken: "t", role: "executor", purpose: "execution", runtime: "claude",
      model: null, effort: null, resumeFromRunId: source, instruction: "按 reviewer 的失败证据修复。", trigger: "user-rework",
      planOwnerItemId: null, planRevision: null, workflowKind: "generic", workspaceId: null,
    });
    await runningChildren().get(itemId);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.resumeSessionId).toBeUndefined();
    expect(captured[0]!.prompt).toContain("修好登录。");
    expect(captured[0]!.prompt).toContain("按 reviewer 的失败证据修复。");
  });
});

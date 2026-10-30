// 集成测试（2026-10-20）：核查员不能用时自动换，走完整的持久化流程。
// 交付 → 自动核查排到 codex 并被认领 → codex 账号停用，核查 Run 失败，内核排一个挂起的重试 → 下一次认领把重试换给
// Claude Code → 真的认领、真的跑。以前这个重试点名 codex，挂起等 codex 恢复，Lead 和用户都换不了。
// 经过 Seam 1：编排器 tick、dispatcher claim、runItem，真实 SQLite，Run 由录制回放。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOrchestrator, runItem, type DispatchClaim } from "@pi-lead-child/engine";
import { createItem, openDb } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { ReplayRuntime, type RecordedRun } from "@pi-lead-child/runtime/testing";

const outcome = `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "Done", changes: [], deliverables: [], validations: [] })}`;

// pi 的交付：调用 ticket_update 进 review，留下成果信封。
const piDelivery: RecordedRun = {
  runtime: "pi",
  events: [
    { type: "run.started", runtime: "pi", model: "vibeproxy/opus" },
    { type: "session.updated", externalSessionId: "pi-delivery" },
    { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
    { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
    { type: "message.completed", messageId: "m-1", role: "assistant", text: outcome },
    { type: "run.completed", exitCode: 0 },
  ],
};

// Codex 当核查员时撞上账号停用（工单 #98 的 Run #113 的原文）。
const codexDeactivated: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "session.updated", externalSessionId: "thread-deactivated" },
    {
      type: "run.failed", exitCode: null, errorCode: "codex_error",
      error: "Reconnecting... 2/5 (unexpected status 402 Payment Required: Payment Required, "
        + "url: wss://chatgpt.com/backend-api/codex/responses, auth error: 402, auth error code: deactivated_workspace)",
    },
  ],
};

// Claude Code 的核查：读完代码，正常结束。
const claudeReview: RecordedRun = {
  runtime: "claude",
  events: [
    { type: "run.started", runtime: "claude", model: "opus" },
    { type: "session.updated", externalSessionId: "claude-review" },
    { type: "message.completed", messageId: "m-2", role: "assistant", text: "【独立核查报告】没有实际运行测试，结论来自阅读。" },
    { type: "run.completed", exitCode: 0 },
  ],
};

describe("a review whose codex reviewer fails on a deactivated account", () => {
  it("is retried on Claude Code at the next claim, and that retry runs", async () => {
    const dir = tempDir("plc-reviewer-fallback-flow-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const samples: RecordedRun[] = [];
    const claims: DispatchClaim[] = [];
    const unexpected: number[] = [];
    const orchestrator = createOrchestrator(db, {
      dataDir: dir,
      maxDispatchPerTick: 1,
      onDispatch: async (claim) => {
        claims.push(claim);
        const sample = samples.shift();
        if (!sample) {
          unexpected.push(claim.runId);
          return;
        }
        await runItem(db, claim.itemId, {
          dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`),
          prompt: "replay", role: claim.role, purpose: claim.purpose, runId: claim.runId,
          runtime: new ReplayRuntime(sample), runtimeId: claim.runtime,
          model: claim.model ?? undefined, lingerMs: 0,
        });
      },
    });
    const tickWith = async (sample: RecordedRun) => {
      samples.push(sample);
      await orchestrator.tick();
    };

    const itemId = createItem(db, {
      title: "needs an independent review", brief: "b", createdBy: "user", verificationPolicy: "independent_reviewer",
    });
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "pi", trigger: "test", idempotencyKey: "deliver",
    });

    // 交付：工单进 review。
    await tickWith(piDelivery);
    expect(db.prepare("SELECT stage FROM items WHERE id=?").get(itemId)).toEqual({ stage: "review" });

    // 自动核查排到 codex（这时 codex 还健康），被认领；核查 Run 撞上账号停用。
    await tickWith(codexDeactivated);
    const review = db.prepare(
      "SELECT id, runtime FROM dispatch_requests WHERE item_id=? AND trigger='automatic-review'",
    ).get(itemId) as { id: number; runtime: string };
    expect(review.runtime).toBe("codex");
    const incident = db.prepare("SELECT id, code FROM runtime_incidents WHERE closed_at IS NULL").get() as {
      id: number; code: string;
    };
    expect(incident.code).toBe("account_deactivated");
    const retry = db.prepare(
      "SELECT id FROM dispatch_requests WHERE item_id=? AND role='reviewer' AND trigger='runtime-health-retry'",
    ).get(itemId) as { id: number };

    // 下一次认领：重试换给 Claude Code，真的被认领、真的跑完。
    await tickWith(claudeReview);
    expect(claims.map((claim) => [claim.role, claim.runtime])).toEqual([
      ["executor", "pi"], ["reviewer", "codex"], ["reviewer", "claude"],
    ]);
    expect(claims.at(-1)?.requestId).toBe(retry.id);
    expect(unexpected).toEqual([]);
    expect(db.prepare("SELECT runtime, state FROM dispatch_requests WHERE id=?").get(retry.id))
      .toEqual({ runtime: "claude", state: "started" });
    expect(db.prepare(
      "SELECT runtime, state FROM runs WHERE item_id=? AND role='reviewer' ORDER BY id",
    ).all(itemId)).toEqual([
      { runtime: "codex", state: "failed" },
      { runtime: "claude", state: "finished" },
    ]);
    const switched = db.prepare(
      `SELECT payload FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'`,
    ).all(itemId) as Array<{ payload: string }>;
    expect(switched.map((row) => JSON.parse(row.payload).message)).toEqual([
      `核查员从 Codex 换成 Claude Code：Codex 账号已停用（故障 #${incident.id}）`,
    ]);
    // 故障照样开着：codex 的执行请求照旧挂起，只是核查不再等它。
    expect(db.prepare("SELECT closed_at FROM runtime_incidents WHERE id=?").get(incident.id)).toEqual({ closed_at: null });
    db.close();
  });
});

// 回归（工单 #66，2026-10-14/15）：独立核查用 Codex 订阅账号跑 gpt-5.5，账号不支持这个模型。
// 旧代码：内核给失败的核查排一个同一模型的健康重试，金丝雀一次次放行它，同一个 gpt-5.5 失败了 9 次
// （Run #73–#81）。Lead 按规则只转告，而且 recover_ticket_run 不接受核查 Run。
// 2026-10-15 用户决定：Lead 能处理的自己处理，事后报告；能力要通用，判断交给 Lead。
// 现在内核只记下故障、通知用户一次、告诉 Lead 故障出现在哪张工单的哪个 Run。Lead 用 recover_ticket_run
// 按模型目录换一个模型重新核查。核查通过以后，同一模型的健康重试自动作废，不会再跑一次。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CodexRuntime, typedFailure } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { createItem, getRun, openDb, transition, type Db } from "@pi-lead-child/store";

import { runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { provisionWorkspace } from "../src/coordinator/workspace.js";
import { recoverTicketRun } from "../src/coordinator/runtime-recovery.js";
import { setModelCatalogForTesting, type ModelCatalog } from "../src/model-catalog.js";

// 本机 2026-10-15 的 Codex 目录（codex debug models），截短：账号支持 gpt-6.1-sol 和 gpt-5.6-sol，不支持 gpt-5.5。
const CATALOG: ModelCatalog = {
  refreshedAt: "2026-10-15T02:00:00.000Z",
  runtimes: [{
    runtime: "codex", state: "known", source: "codex debug models", refreshedAt: "2026-10-15T02:00:00.000Z", error: null,
    account: "Codex 内置的订阅账号", freeformModelPattern: null,
    cliDefaultModel: "gpt-6.1-sol", efforts: ["low", "medium", "high"],
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", note: null },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", note: null },
    ],
  }],
};

const REJECTED = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";

// 一个假的 Codex：收到 gpt-5.5 时像真实账号一样拒绝；收到别的模型时交一个通过的核查结论。
class AccountCodex implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities = { ...new CodexRuntime().capabilities };
  readonly models: Array<string | undefined> = [];

  constructor(private readonly db: Db) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.models.push(request.model);
    const event = (seq: number, input: object) => ({
      ...input, runId: request.runId, seq, occurredAt: new Date().toISOString(),
    }) as RuntimeEvent;
    if (request.model === "gpt-5.5") {
      return handle([
        event(1, { type: "run.started", runtime: "codex", model: "gpt-5.5" }),
        event(2, {
          type: "run.failed", exitCode: null, errorCode: "codex_error", error: REJECTED,
          failure: typedFailure("model_unsupported", { errorCode: "codex_error", message: REJECTED }),
        }),
      ], 1);
    }
    createDispatcher(this.db).submitReviewVerdict({ runId: request.runId, verdict: "pass", evidence: "独立复跑全部测试，全部通过" });
    return handle([
      event(1, { type: "run.started", runtime: "codex", model: request.model ?? null }),
      event(2, { type: "run.completed", exitCode: 0 }),
    ], 0);
  }
}

function handle(events: RuntimeEvent[], exitCode: number): RuntimeHandle {
  return {
    pid: null,
    events: (async function* () { yield* events; })(),
    interrupt: async () => {},
    wait: async () => ({ ok: exitCode === 0, exitCode, signal: null, externalSessionId: null }),
  } as unknown as RuntimeHandle;
}

function ticketInReview(): { db: Db; dir: string; dbPath: string; itemId: number } {
  const dir = tempDir("plc-review-recovery-");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "source.txt"), "delivered\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "delivery"]);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: "#66", brief: "outcome snapshots", createdBy: "user", workflowKind: "coding", workdir: repo });
  provisionWorkspace(db, { itemId, mode: "shared" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
  return { db, dir, dbPath, itemId };
}

function decisions(db: Db, itemId: number, decision: string): Array<Record<string, unknown>> {
  return (db.prepare(
    `SELECT payload FROM activities WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=? ORDER BY id`,
  ).all(itemId, decision) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));
}

afterEach(() => setModelCatalogForTesting(null));

describe("recovering a review whose model the account rejects (#66)", () => {
  it("tells Lead where the failure is, and Lead's recovery reruns the review on a catalog model", async () => {
    setModelCatalogForTesting(CATALOG);
    const { db, dir, dbPath, itemId } = ticketInReview();
    const codex = new AccountCodex(db);
    const options = { dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "review", role: "reviewer" as const, lingerMs: 0, runtime: codex };

    await runItem(db, itemId, { ...options, model: "gpt-5.5" });
    const failedRunId = (db.prepare("SELECT id FROM runs WHERE item_id=?").get(itemId) as { id: number }).id;

    // 内核不替 Lead 选模型：故障记在健康账本上，同一模型的健康重试挂起。模型被拒先交给 Lead：用户不收通知，
    // Lead 马上被叫醒（wakeLead）。
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind='runtime_incident'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT model, trigger, state FROM dispatch_requests WHERE item_id=?").all(itemId))
      .toEqual([{ model: "gpt-5.5", trigger: "runtime-health-retry", state: "pending" }]);
    // Lead 读到的说明写着故障出现在哪张工单的哪个 Run，它才能去恢复。
    const note = db.prepare("SELECT summary, payload FROM inbox WHERE dedup_scope LIKE 'runtime-incident:%'").get() as { summary: string; payload: string };
    expect(note.summary).toContain(`工单 #${itemId} 的 Run #${failedRunId}`);
    expect(JSON.parse(note.payload)).toMatchObject({ wakeLead: true, needsUser: false });

    // Lead 恢复失败的核查 Run：不需要用户开口，也不需要委托授权。
    const recovery = recoverTicketRun(db, { itemId, failedRunId, action: "auto", authorityRef: "lead:runtime-failure" });
    expect(recovery).toMatchObject({ status: "queued", runtime: "codex", model: "gpt-6.1-sol" });
    expect(decisions(db, itemId, "runtime_recovery_queued")).toEqual([expect.objectContaining({
      role: "reviewer", purpose: "review", fromModel: "gpt-5.5", model: "gpt-6.1-sol", authorityRef: "lead:runtime-failure",
    })]);

    // 派发器认领换过模型的核查（同一模型的重试还挂着），核查通过。
    const claim = createDispatcher(db).claimNext();
    expect(claim).toMatchObject({ role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-6.1-sol" });
    await runItem(db, itemId, { ...options, runId: claim!.runId, purpose: "review", model: claim!.model ?? undefined });
    expect(getRun(db, claim!.runId)).toMatchObject({ state: "finished", model: "gpt-6.1-sol" });
    expect(db.prepare("SELECT verdict FROM review_verdicts WHERE run_id=?").get(claim!.runId)).toEqual({ verdict: "pass" });

    // 同一模型的健康重试不会再跑：下一次认领把它作废。
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE trigger='runtime-health-retry' AND item_id=?").get(itemId))
      .toEqual({ state: "cancelled" });
    expect(codex.models).toEqual(["gpt-5.5", "gpt-6.1-sol"]);
  });
});

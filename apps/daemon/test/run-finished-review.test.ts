// Run 结束的说明在什么时刻写（2026-10-19 审查发现）：great-dirac 让 daemon 在 Run 处理完终止事件的那一刻就写
// 「Run 结束了，工单现在是 …」，免得 pi 的执行 Run 停留 5 分钟才告诉 Lead。可核查 Run 的结论要到进程退出时才登记
// （engine 的 manager.ts 收尾），终止事件那一刻工单还停在 review；进程退出时那一条又因为同一个 Run 只说一次被去掉。
// 委托给 Lead 验收的工单，核查 PASS 以后已经 done，Lead 收到的却是「工单现在是 review」。
// 现在只有交付后会停留的执行 Run 在终止事件那一刻写；核查 Run 等进程退出（onChildDone）再写，写的是登记以后的 stage。
// 走真实的 manager、核查登记和委托验收，daemon 的两个回调用它们在 server.ts 里调用的同一组函数。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, provisionWorkspace, runItem } from "@pi-lead-child/engine";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { createItem, getItem, grantDelegationPolicy, openDb, type Db } from "@pi-lead-child/store";
import { recordRunFinished, recordRunFinishedAtTerminalEvent, runLingersAfterTurn } from "../src/run-finished.js";

function deliveredCodingTicket(): { db: Db; dir: string; dbPath: string; itemId: number } {
  const dir = tempDir("plc-run-finished-review-");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "source.txt"), "delivered\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "delivered"]);
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const itemId = createItem(db, { title: "委托验收的交付", brief: "b", createdBy: "user", workflowKind: "coding", workdir: repo });
  provisionWorkspace(db, { itemId, mode: "shared" });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  grantDelegationPolicy(db, { itemId, createdVia: "test" });
  return { db, dir, dbPath, itemId };
}

const completedReview: RecordedEvent[] = [
  { type: "session.updated", externalSessionId: "review-session", runtimeVersion: "test" },
  { type: "run.started", runtime: "claude", model: null },
  { type: "message.completed", messageId: "m-last", role: "assistant", text: "核查完成。", stopReason: "stop" },
  { type: "run.completed", exitCode: 0 },
];

function runFinishedNotes(db: Db, itemId: number): string[] {
  return (db.prepare(
    "SELECT summary FROM inbox WHERE item_id=? AND json_extract(payload, '$.kind')='run_finished' ORDER BY id",
  ).all(itemId) as Array<{ summary: string }>).map((row) => row.summary);
}

describe("when Lead hears that a run finished", () => {
  it("only an execution run is told at its terminal event", () => {
    expect(runLingersAfterTurn({ purpose: "execution", role: "executor" })).toBe(true);
    for (const run of [
      { purpose: "review", role: "reviewer" }, { purpose: "integration", role: "executor" },
      { purpose: "outcome_repair", role: "executor" }, { purpose: "conversation", role: "executor" },
    ]) expect(runLingersAfterTurn(run)).toBe(false);
  });

  it("tells Lead about a review only after its verdict is registered, with the ticket's stage at that point", async () => {
    const { db, dir, dbPath, itemId } = deliveredCodingTicket();
    const reviewer = new ReplayRuntime({ runtime: "claude", events: completedReview });
    const start = reviewer.start.bind(reviewer);
    reviewer.start = async (request) => {
      createDispatcher(db).submitReviewVerdict({ runId: request.runId, verdict: "pass", evidence: "独立复跑了全部测试，都通过" });
      return start(request);
    };
    let stageAtTerminalEvent: string | undefined;
    // daemon 的 onChildEvent：终止事件那一刻。
    await runItem(db, itemId, {
      dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "review", role: "reviewer", lingerMs: 0, runtime: reviewer,
      onEvent: (event, ids) => {
        if (event.type !== "run.completed" && event.type !== "run.failed") return;
        stageAtTerminalEvent = getItem(db, ids.itemId)?.stage;
        recordRunFinishedAtTerminalEvent(db, ids);
      },
    });
    // 终止事件那一刻工单还在 review：这时不说。
    expect(stageAtTerminalEvent).toBe("review");
    // daemon 的 onChildDone：进程退出、结论登记以后。委托验收已经把工单关了。
    expect(getItem(db, itemId)?.stage).toBe("done");
    recordRunFinished(db, { itemId });
    const notes = runFinishedNotes(db, itemId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("（核查）结束了，工单现在是 done");
    db.close();
  });
});

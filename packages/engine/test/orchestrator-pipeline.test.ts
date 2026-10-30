import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createDispatcher, type DispatchClaim } from "../src/coordinator/dispatch.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { openDb } from "@pi-lead-child/store";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";

describe("orchestration pipeline", () => {
  it("dispatches automatic review, then resumes parent integration", async () => {
    const db = openDb(join(tempDir("plc-orchestration-pipeline-"), "plc.db"));
    const coordinator = createCoordinator({ db });
    const root = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(root);
    const planner = createRun(db, { itemId: root });
    updateRun(db, planner, { state: "running" });
    const revision = coordinator.beginPlanning({ itemId: root, runId: planner });
    const leaf = coordinator.createSubitem(
      { itemId: root, runId: planner, revision },
      { title: "leaf", brief: "b" },
    );
    grantDelegationPolicy(db, { itemId: leaf, createdVia: "test" });
    coordinator.finishPlanning({ itemId: root, runId: planner, revision });
    updateRun(db, planner, { state: "finished", endedAt: true });
    const dispatcher = createDispatcher(db);
    const executor = dispatcher.claimNext()!;
    dispatcher.markStarted(executor);
    updateRun(db, executor.runId, { state: "finished", endedAt: true });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(leaf);
    grantDelegationPolicy(db, { itemId: leaf, createdVia: "test" });

    const dispatched: DispatchClaim[] = [];
    const orchestrator = createOrchestrator(db, {
      onDispatch: async (claim) => { dispatched.push(claim); },
    });
    await orchestrator.tick();
    const reviewer = dispatched.find((claim) => claim.role === "reviewer")!;
    expect(reviewer).toMatchObject({ itemId: leaf, purpose: "review" });

    dispatcher.submitReviewVerdict({
      runId: reviewer.runId, verdict: "pass", evidence: "verified",
    });
    db.prepare("DELETE FROM gateway_events").run();
    dispatched.length = 0;
    await orchestrator.tick();
    expect(getItem(db, root)?.plan_state).toBe("integrating");
    expect(dispatched).toContainEqual(expect.objectContaining({
      itemId: root, purpose: "integration", role: "executor",
    }));
    expect(db.prepare(
      "SELECT kind, related_item_ids, idempotency_key FROM checkpoints WHERE item_id=? ORDER BY id DESC LIMIT 1",
    ).get(root)).toEqual({
      kind: "milestone",
      related_item_ids: JSON.stringify([leaf]),
      idempotency_key: `subitem-completed:${root}:${leaf}:${executor.runId}`,
    });
    expect(db.prepare("SELECT event_type, item_id FROM gateway_events ORDER BY seq").all()).toEqual([
      { event_type: "attempt.updated", item_id: leaf },
      { event_type: "ticket.updated", item_id: root },
    ]);

    await orchestrator.tick();
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?",
    ).get(`subitem-completed:${root}:${leaf}:${executor.runId}`) as any).n).toBe(1);
  });
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { openDb } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";

function plannedRoot(options: { tokenBudget?: number; costBudgetUsd?: number } = {}) {
  const db = openDb(join(tempDir("plc-budget-"), "plc.db"));
  const coordinator = createCoordinator({ db });
  const root = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "lead" });
  db.prepare("UPDATE items SET stage='active', token_budget=?, cost_budget_usd=? WHERE id=?")
    .run(options.tokenBudget ?? null, options.costBudgetUsd ?? null, root);
  const planner = createRun(db, { itemId: root });
  updateRun(db, planner, { state: "running" });
  const revision = coordinator.beginPlanning({ itemId: root, runId: planner });
  const child = coordinator.createSubitem(
    { itemId: root, runId: planner, revision },
    { title: "child", brief: "b", runtime: "codex" },
  );
  coordinator.finishPlanning({ itemId: root, runId: planner, revision });
  return { db, root, child };
}

describe("orchestration budgets", () => {
  it("warns at the soft token threshold but still dispatches", () => {
    const { db, root, child } = plannedRoot({ tokenBudget: 100 });
    db.prepare("UPDATE items SET total_tokens=80 WHERE id=?").run(child);
    const dispatcher = createDispatcher(db, { softBudgetRatio: 0.8 });
    expect(dispatcher.claimNext()?.itemId).toBe(child);
    expect(listInbox(db, { severity: "attention" }).some((row) => row.summary.includes("预算接近上限"))).toBe(true);
    expect(getItem(db, root)?.stage).toBe("active");
  });

  it("blocks the root when descendant tokens reach the hard budget", () => {
    const { db, root, child } = plannedRoot({ tokenBudget: 100 });
    db.prepare("UPDATE items SET total_tokens=100 WHERE id=?").run(child);
    const dispatcher = createDispatcher(db);
    expect(dispatcher.claimNext()).toBeNull();
    expect(getItem(db, root)).toMatchObject({ stage: "blocked", plan_state: "failed" });
    expect(listInbox(db, { severity: "blocker" }).some((row) => row.summary.includes("token 预算"))).toBe(true);
  });

  it("rejects unknown-cost runtimes under a hard USD budget unless an estimator exists", () => {
    const first = plannedRoot({ costBudgetUsd: 2 });
    expect(createDispatcher(first.db).claimNext()).toBeNull();
    expect(getItem(first.db, first.root)?.stage).toBe("blocked");

    const second = plannedRoot({ costBudgetUsd: 2 });
    expect(createDispatcher(second.db, {
      hasCostEstimator: (runtime) => runtime === "codex",
    }).claimNext()?.itemId).toBe(second.child);
  });

  it("does not claim an item that already has an active run", () => {
    const { db, child } = plannedRoot();
    const run = createRun(db, { itemId: child });
    updateRun(db, run, { state: "running" });
    expect(createDispatcher(db).claimNext()).toBeNull();
  });
});

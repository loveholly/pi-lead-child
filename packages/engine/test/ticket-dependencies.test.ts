import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-deps-"), "plc.db"));
});

function setupRoot(title = "root") {
  const coordinator = createCoordinator({ db });
  const itemId = coordinator.createRootItem({ title, brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
  const revision = coordinator.beginPlanning({ itemId, runId });
  return { coordinator, itemId, runId, revision };
}

describe("item dependency DAG", () => {
  it("does not dispatch until sealing and preserves serial dependencies", () => {
    const { coordinator, itemId, runId, revision } = setupRoot();
    const plan = coordinator.createWorkPlan({ itemId, runId, revision }, {
      items: [
        { key: "a", title: "A", brief: "parallel A" },
        { key: "b", title: "B", brief: "parallel B" },
        { key: "c", title: "C", brief: "after both", dependsOn: ["a", "b"] },
      ],
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests").get() as any).n).toBe(0);

    coordinator.finishPlanning({ itemId, runId, revision });

    expect((db.prepare("SELECT COUNT(*) AS n FROM dispatch_requests WHERE state='pending'").get() as any).n)
      .toBe(3);
    const c = plan.byKey.c;
    expect(coordinator.listDependencies(c).map((edge) => edge.depends_on_item_id).sort())
      .toEqual([plan.byKey.a, plan.byKey.b].sort());
    expect(() => coordinator.addDependency(
      { itemId, runId, revision }, plan.byKey.a, plan.byKey.c,
    )).toThrow(/sealed/i);
  });

  it("rejects cycles and cross-parent edges", () => {
    const left = setupRoot("left");
    const a = left.coordinator.createSubitem(left, { title: "A", brief: "b" });
    const b = left.coordinator.createSubitem(left, { title: "B", brief: "b" });
    left.coordinator.addDependency(left, b, a);
    expect(() => left.coordinator.addDependency(left, a, b)).toThrow(/cycle/i);

    const right = setupRoot("right");
    const other = right.coordinator.createSubitem(right, { title: "other", brief: "b" });
    expect(() => left.coordinator.addDependency(left, a, other)).toThrow(/same parent revision/i);
  });

  it("replans by retaining a completed child without deleting old revision history", () => {
    const ctx = setupRoot();
    const old = ctx.coordinator.createSubitem(ctx, { title: "old", brief: "b" });
    const retained = ctx.coordinator.createSubitem(ctx, { title: "retained", brief: "b" });
    ctx.coordinator.finishPlanning(ctx);
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(retained);
    db.prepare("UPDATE dispatch_requests SET state='completed'").run();

    const revision2 = ctx.coordinator.reopenPlanning(
      { itemId: ctx.itemId, runId: ctx.runId },
      { retainChildIds: [retained] },
    );
    const replacement = ctx.coordinator.createSubitem(
      { itemId: ctx.itemId, runId: ctx.runId, revision: revision2 },
      { title: "replacement", brief: "b" },
    );
    ctx.coordinator.finishPlanning({ itemId: ctx.itemId, runId: ctx.runId, revision: revision2 });

    const memberships = db.prepare(
      "SELECT revision, child_item_id FROM item_plan_memberships WHERE parent_item_id=? ORDER BY revision, child_item_id",
    ).all(ctx.itemId) as Array<{ revision: number; child_item_id: number }>;
    expect(memberships).toContainEqual({ revision: ctx.revision, child_item_id: old });
    expect(memberships).toContainEqual({ revision: revision2, child_item_id: retained });
    expect(memberships).toContainEqual({ revision: revision2, child_item_id: replacement });
  });
});

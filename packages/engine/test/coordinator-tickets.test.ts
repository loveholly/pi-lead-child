import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-coordinator-"), "plc.db"));
});

function runningRun(itemId: number): number {
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
  return runId;
}

describe("Coordinator hierarchy", () => {
  it("creates bounded children with inherited root, project, and automatic review", () => {
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({
      title: "root", brief: "b", createdBy: "system", project: "returns",
    });
    db.prepare("UPDATE items SET max_depth=2, max_children=3 WHERE id=?").run(rootId);
    const runId = runningRun(rootId);
    const revision = coordinator.beginPlanning({ itemId: rootId, runId });
    const childId = coordinator.createSubitem(
      { itemId: rootId, runId, revision },
      { title: "child", brief: "do child", runtime: "codex" },
    );

    expect(getItem(db, childId)).toMatchObject({
      parent_item_id: rootId,
      root_item_id: rootId,
      project: "returns",
      verification_policy: "independent_reviewer",
      requested_runtime: "codex",
      created_by_run_id: runId,
    });
    expect(coordinator.listChildren(rootId).map((item) => item.id)).toEqual([childId]);
  });

  it("allows nested planning but rejects depth overflow", () => {
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system" });
    db.prepare("UPDATE items SET max_depth=1 WHERE id=?").run(rootId);
    const rootRun = runningRun(rootId);
    const rootRevision = coordinator.beginPlanning({ itemId: rootId, runId: rootRun });
    const childId = coordinator.createSubitem(
      { itemId: rootId, runId: rootRun, revision: rootRevision },
      { title: "child", brief: "b" },
    );
    coordinator.finishPlanning({ itemId: rootId, runId: rootRun, revision: rootRevision });

    const childRun = runningRun(childId);
    const childRevision = coordinator.beginPlanning({ itemId: childId, runId: childRun });
    expect(() => coordinator.createSubitem(
      { itemId: childId, runId: childRun, revision: childRevision },
      { title: "too deep", brief: "b" },
    )).toThrow(/max depth/i);
  });

  it("builds the safe ticket workbench and batch work-item read models", () => {
    const coordinator = createCoordinator({
      db,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    const rootId = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system" });
    const runId = runningRun(rootId);
    const revision = coordinator.beginPlanning({ itemId: rootId, runId });
    const childId = coordinator.createSubitem(
      { itemId: rootId, runId, revision },
      { title: "child", brief: "b" },
    );

    // getTicketWorkbench 投的是线上 DTO：ticket / activeAttempt / parentTicketId /
    // relatedTicketIds 都由 protocol 冻结，内部改名不动它们。
    const workbench = coordinator.getTicketWorkbench(rootId);
    expect(workbench).toMatchObject({
      ticket: { id: rootId },
      activeAttempt: { id: runId, ticketId: rootId },
      children: [{ id: childId, parentTicketId: rootId }],
      latestCheckpoints: [{ kind: "delegation", relatedTicketIds: [childId] }],
      interventionRefs: [],
    });
    expect(coordinator.listTicketWorkItems({ itemIds: [rootId] })).toEqual([
      expect.objectContaining({
        ticketId: rootId,
        activeExecution: expect.objectContaining({ attemptId: runId }),
        pendingInterventionCount: 0,
        // latestCheckpoints 现在是可选的（没有 Run 就整个不投，spec §11）。
        // 这个工单有 Run，所以字段在；?. 只是让类型收窄，不改变断言。
        latestCheckpointId: workbench?.latestCheckpoints?.[0]?.id,
      }),
    ]);
  });

  it("projects deterministic terminal, explicit, and direct-child progress", () => {
    const coordinator = createCoordinator({
      db,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    const cancelledId = coordinator.createRootItem({
      title: "cancelled", brief: "no progress", createdBy: "system",
    });
    const doneId = coordinator.createRootItem({
      title: "done", brief: "terminal", createdBy: "system",
    });
    db.prepare("UPDATE items SET stage='cancelled' WHERE id=?").run(cancelledId);
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(doneId);

    const explicitId = coordinator.createRootItem({
      title: "explicit", brief: "latest wins", createdBy: "system",
    });
    const explicitRun = runningRun(explicitId);
    coordinator.submitCheckpoint({
      itemId: explicitId,
      runId: explicitRun,
      kind: "progress",
      title: "First ratio",
      summary: "Initial measurable progress.",
      progress: { current: 1, total: 3, label: "Coverage" },
    });
    const latest = coordinator.submitCheckpoint({
      itemId: explicitId,
      runId: explicitRun,
      kind: "milestone",
      title: "Latest ratio",
      summary: "The newest explicit checkpoint is authoritative.",
      progress: { current: 2, total: 3, label: "Coverage" },
    });

    const parentId = coordinator.createRootItem({
      title: "parent", brief: "direct children", createdBy: "system",
    });
    const doneChild = createItem(db, {
      title: "done child", brief: "done", createdBy: "system",
      parentItemId: parentId, rootItemId: parentId,
    });
    const pendingChild = createItem(db, {
      title: "pending child", brief: "pending", createdBy: "system",
      parentItemId: parentId, rootItemId: parentId,
    });
    const cancelledChild = createItem(db, {
      title: "cancelled child", brief: "ignored", createdBy: "system",
      parentItemId: parentId, rootItemId: parentId,
    });
    createItem(db, {
      title: "grandchild", brief: "must not recurse", createdBy: "system",
      parentItemId: pendingChild, rootItemId: parentId,
    });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(doneChild);
    db.prepare("UPDATE items SET stage='cancelled' WHERE id=?").run(cancelledChild);

    const byId = new Map(coordinator.listTicketWorkItemsV2({
      itemIds: [cancelledId, doneId, explicitId, parentId],
    }).map((item) => [item.ticketId, item]));
    expect(byId.get(cancelledId)?.progress).toBeNull();
    expect(byId.get(doneId)?.progress).toEqual({
      current: 1, total: 1, percent: 100, label: null,
      source: "terminal", checkpointId: null,
    });
    expect(byId.get(explicitId)?.progress).toEqual({
      current: 2, total: 3, percent: 67, label: "Coverage",
      source: "explicit", checkpointId: latest.checkpoint.id,
    });
    expect(byId.get(parentId)?.progress).toEqual({
      current: 1, total: 2, percent: 50, label: "子任务",
      source: "children", checkpointId: null,
    });
  });

  it("folds current PoW and counts distinct tool starts across runs", () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const coordinator = createCoordinator({ db, now: () => now });
    const itemId = coordinator.createRootItem({
      title: "pow", brief: "deterministic proof", createdBy: "system",
    });
    const executorId = createRun(db, { itemId, role: "executor", runtime: "codex" });
    // reviewer 的 Run 只在 review 这个 stage 上开得出来（spec §6.5），所以先把 item 推到 review。
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "system", reason: "await review" });
    const reviewerId = createRun(db, { itemId, role: "reviewer", runtime: "claude" });
    updateRun(db, executorId, { state: "running" });
    updateRun(db, reviewerId, { state: "running" });
    db.prepare("UPDATE items SET first_run_at=?, stage='blocked' WHERE id=?")
      .run("2026-07-24T09:00:00.000Z", itemId);

    coordinator.submitCheckpoint({
      itemId,
      runId: executorId,
      kind: "progress",
      title: "Proof seeded",
      summary: "Initial proof state.",
      proofItems: [
        { id: "auth", label: "Authorization", state: "pending", evidence: null },
        { id: "legacy", label: "Legacy", state: "passed", evidence: "old" },
      ],
    });
    coordinator.submitCheckpoint({
      itemId,
      runId: executorId,
      kind: "milestone",
      title: "Proof updated",
      summary: "Current proof state.",
      proofItems: [
        { id: "auth", label: "Authorization", state: "passed", evidence: "tests pass" },
        { id: "legacy", label: "Legacy", state: "retired", evidence: null },
        { id: "storage", label: "Storage", state: "failed", evidence: "repair needed" },
      ],
    });
    const insertEvent = db.prepare(
      `INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at)
       VALUES (?, ?, 'tool.started', ?, ?)`,
    );
    for (const [runId, seq, callId] of [
      [executorId, 1, "same"],
      [executorId, 2, "same"],
      [executorId, 3, "other"],
      [reviewerId, 1, "same"],
    ] as const) {
      insertEvent.run(
        runId,
        seq,
        JSON.stringify({ type: "tool.started", runId, seq, callId, name: "test" }),
        "2026-07-24T09:30:00.000Z",
      );
    }

    const workbench = coordinator.getTicketWorkbenchV2(itemId)!;
    expect(workbench.pow).toMatchObject({
      verdict: "attention",
      items: [
        { id: "auth", state: "passed" },
        { id: "storage", state: "failed" },
      ],
      metrics: {
        passed: 1,
        total: 2,
        checkpointCount: 2,
        toolOperationCount: 3,
        elapsedMs: 3_600_000,
        pendingInterventionCount: 0,
      },
      computedAt: now.toISOString(),
    });
  });

  it("does not keep stale proof issues or the reviewer's accepted caveats active after a passing review", () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const coordinator = createCoordinator({ db, now: () => now });
    const itemId = coordinator.createRootItem({
      title: "reviewed pow", brief: "proof issues are historical after pass", createdBy: "system",
      verificationPolicy: "independent_reviewer",
    });
    const firstExecutor = createRun(db, { itemId, role: "executor", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "system", reason: "await first review" });
    coordinator.submitCheckpoint({
      itemId,
      runId: firstExecutor,
      kind: "completed",
      title: "Initial implementation",
      summary: "Contains unresolved proof.",
      proofItems: [
        { id: "targeted", label: "Targeted tests", state: "passed", evidence: "passed" },
        { id: "old-gap", label: "Old gap", state: "pending", evidence: "will be fixed in rework" },
        { id: "socket", label: "Socket test", state: "failed", evidence: "sandbox denied listen calls with EPERM" },
      ],
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "rework" });
    const secondExecutor = createRun(db, { itemId, role: "executor", runtime: "codex" });
    transition(db, { itemId, to: "review", actor: "system", reason: "await final review" });
    coordinator.submitCheckpoint({
      itemId,
      runId: secondExecutor,
      kind: "completed",
      title: "Rework complete",
      summary: "Fresh evidence passed.",
      proofItems: [
        { id: "full-suite", label: "Full suite", state: "passed", evidence: "150 files passed" },
      ],
    });
    const reviewer = createRun(db, { itemId, role: "reviewer", runtime: "claude" });
    coordinator.submitCheckpoint({
      itemId,
      runId: reviewer,
      kind: "completed",
      title: "Independent review passed",
      summary: "Only environment caveats remain.",
      proofItems: [
        { id: "companion-standalone", label: "Companion standalone", state: "failed", evidence: "blocked before assertions by EPERM writing temp dirs" },
        { id: "review", label: "Independent review", state: "passed", evidence: "no functional blockers" },
      ],
    });
    db.prepare(
      "INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, 'pass', ?)",
    ).run(reviewer, itemId, "reviewer accepted environment caveats");

    const pow = coordinator.getTicketWorkbenchV2(itemId)!.pow!;
    expect(pow.verdict).toBe("passed");
    expect(pow.items.map((item) => item.id)).toEqual(["targeted", "full-suite", "review"]);
    expect(pow.metrics).toMatchObject({ passed: 3, total: 3, pendingInterventionCount: 0 });

    // 核查通过之后又有人报了一条失败（这里是一次对话 Run，不会让 PASS 过期）。它是新证据，必须显示，
    // 不能因为文字里有 "EPERM" 就被当成环境问题藏起来（工单 #66 复核 F7）。
    const chat = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
    coordinator.submitCheckpoint({
      itemId,
      runId: chat,
      kind: "progress",
      title: "Re-ran the socket test",
      summary: "Still failing.",
      proofItems: [
        { id: "socket-rerun", label: "Socket test rerun", state: "failed", evidence: "listen failed with EPERM" },
      ],
    });
    const after = coordinator.getTicketWorkbenchV2(itemId)!.pow!;
    expect(after.items.map((item) => item.id)).toContain("socket-rerun");
    expect(after.verdict).toBe("attention");
  });

  it("replays a keyed work plan without duplicating child items or lifecycle effects", () => {
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system" });
    const runId = runningRun(rootId);
    coordinator.beginPlanning({ itemId: rootId, runId });
    const context = { itemId: rootId, runId };
    const plan = {
      items: [
        { key: "planning", title: "Plan", brief: "write the plan" },
        { key: "implementation", title: "Implement", brief: "ship it", dependsOn: ["planning"] },
      ],
    };

    const first = coordinator.createWorkPlan(context, plan);
    const countsAfterFirst = db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM item_plan_memberships) AS memberships,
        (SELECT COUNT(*) FROM item_dependencies) AS dependencies,
        (SELECT COUNT(*) FROM checkpoints) AS checkpoints,
        (SELECT COUNT(*) FROM activities) AS activities,
        (SELECT COUNT(*) FROM gateway_events) AS events`,
    ).get();
    const replay = coordinator.createWorkPlan(context, plan);

    expect(replay).toEqual(first);
    expect(db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM item_plan_memberships) AS memberships,
        (SELECT COUNT(*) FROM item_dependencies) AS dependencies,
        (SELECT COUNT(*) FROM checkpoints) AS checkpoints,
        (SELECT COUNT(*) FROM activities) AS activities,
        (SELECT COUNT(*) FROM gateway_events) AS events`,
    ).get()).toEqual(countsAfterFirst);
  });

  it("rejects a conflicting work-plan retry that reuses an item key with different content", () => {
    const coordinator = createCoordinator({ db });
    const rootId = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system" });
    const runId = runningRun(rootId);
    const revision = coordinator.beginPlanning({ itemId: rootId, runId });
    const context = { itemId: rootId, runId, revision };

    coordinator.createWorkPlan(context, {
      items: [{ key: "implementation", title: "Implement", brief: "ship v1" }],
    });

    expect(() => coordinator.createWorkPlan(context, {
      items: [{ key: "implementation", title: "Implement differently", brief: "ship v2" }],
    })).toThrow(/plan key.*conflict/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE parent_item_id=?").get(rootId))
      .toEqual({ n: 1 });
  });
});

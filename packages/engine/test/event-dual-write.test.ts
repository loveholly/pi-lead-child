// 双写（Lead 事件主干 spec D2，工单 01）：engine 里的写入点。
//   - 提醒到点、Lead 跟进到点（scheduler）；
//   - 不经过 addInbox、直接 INSERT 的两处 inbox：审批和决定、编排预算。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addLeadFollowUp, createItem, createRun, getItem, listEvents, listInbox, openDb, updateRun, type Db,
} from "@pi-lead-child/store";
import { createCoordinator } from "../src/coordinator/service.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createScheduler } from "../src/pipeline/scheduler.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-engine-events-"), "plc.db"));
});

const at = (iso: string) => () => new Date(iso);
const INBOX_KINDS = ["inbox.blocker", "inbox.attention"];

describe("scheduler", () => {
  it("records a due reminder as a timer event, together with its stage change and its notification", () => {
    const id = createItem(db, {
      title: "交房租", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    const scheduler = createScheduler(db, { now: at("2026-07-25T10:00:01.000Z") });
    scheduler.tick();
    scheduler.tick();
    // 到点事件的级别是提醒自己的级别（工单 07）：没有设置的提醒是 tell，按 Lead 的事件游标交给 Lead。
    expect(listEvents(db).map((event) => [event.kind, event.entityKey, event.level])).toEqual([
      ["stage.changed", `reminder:${id}`, "record"],
      ["notification.created", `reminder:${id}`, "tell"],
      ["timer.fired", `reminder:${id}`, "tell"],
    ]);
    expect(listEvents(db, { kind: "timer.fired" })[0]).toMatchObject({
      source: "timer", occurredAt: "2026-07-25T10:00:01.000Z",
      payload: { timer: "reminder", scheduledAt: "2026-07-25T10:00:00.000Z", itemId: id, title: "交房租" },
    });
  });

  it("writes none of the reminder's events when its transaction rolls back", () => {
    const id = createItem(db, {
      title: "交房租", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-07-25T10:00:00.000Z",
    });
    db.exec(`CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(FAIL, 'down'); END;`);
    const errors: string[] = [];
    createScheduler(db, { now: at("2026-07-25T10:00:01.000Z"), onError: (step) => errors.push(step) }).tick();
    expect(errors).toEqual(["reminder"]);
    expect(getItem(db, id)!.stage).toBe("scheduled");
    expect(listEvents(db)).toEqual([]);
  });

  it("records a Lead follow-up coming due once", () => {
    const id = addLeadFollowUp(db, { at: new Date("2026-07-25T10:00:00.000Z"), note: "看看 CI" });
    createScheduler(db, { now: at("2026-07-25T09:59:00.000Z") }).tick();
    expect(listEvents(db, { kind: "timer.fired" })).toEqual([]);
    const scheduler = createScheduler(db, { now: at("2026-07-25T10:00:30.000Z") });
    scheduler.tick();
    scheduler.tick();
    expect(listEvents(db, { kind: "timer.fired" }).map((event) => [event.sourceRef, event.level, event.correlationId]))
      .toEqual([[`followup:${id}`, "tell", `inbox:${id}`]]);
  });
});

describe("inbox rows written outside addInbox", () => {
  it("records the approval's inbox row, and disposes it when the approval is resolved", () => {
    const coordinator = createCoordinator({ db, now: () => new Date("2026-07-24T09:00:00.000Z") });
    const itemId = coordinator.createRootItem({ title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "running" });
    const request = coordinator.requestApproval({
      itemId, runId, requestedBy: "child", tool: "send_email", action: "Send the report",
      checkpoint: { title: "Waiting to send", summary: "Sending is irreversible.", nextStep: "Send after approval." },
    });
    if (request.status !== "pending") throw new Error("expected pending approval");
    const [row] = listInbox(db);
    const [event] = listEvents(db, { kind: INBOX_KINDS });
    expect(event).toMatchObject({
      sourceRef: `inbox:${row!.id}`, entityKey: `ticket:${itemId}`, correlationId: `inbox:${row!.id}`, disposition: null,
      payload: { inboxId: row!.id, severity: row!.severity, inboxSource: "semantic", payload: { authorityType: "approval", authorityId: request.approvalId } },
    });

    coordinator.resolveApproval({
      approvalId: request.approvalId, decision: "approve_session", actor: { kind: "user", resolvedBy: "user via cli" },
    });
    expect(listEvents(db, { kind: INBOX_KINDS })[0]).toMatchObject({ disposition: "resolved_elsewhere" });
  });

  it("records the orchestration budget's inbox row", () => {
    const coordinator = createCoordinator({ db });
    const root = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET stage='active', token_budget=100 WHERE id=?").run(root);
    const planner = createRun(db, { itemId: root });
    updateRun(db, planner, { state: "running" });
    const revision = coordinator.beginPlanning({ itemId: root, runId: planner });
    const child = coordinator.createSubitem({ itemId: root, runId: planner, revision }, { title: "child", brief: "b", runtime: "codex" });
    coordinator.finishPlanning({ itemId: root, runId: planner, revision });
    db.prepare("UPDATE items SET total_tokens=100 WHERE id=?").run(child);

    expect(createDispatcher(db).claimNext()).toBeNull();
    const budget = listInbox(db, { severity: "blocker" }).find((row) => row.summary.includes("token 预算"))!;
    expect(listEvents(db, { kind: "inbox.blocker" }).find((event) => event.sourceRef === `inbox:${budget.id}`)).toMatchObject({
      entityKey: `ticket:${root}`, level: "tell", rootCause: { code: "orchestration_budget" },
      payload: { inboxKind: "orchestration_budget" },
    });
  });
});

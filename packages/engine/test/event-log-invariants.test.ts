// 核心不变量（Lead 事件主干 spec D5，工单 01）：每个事件都要有最终处置。
// 「级别不是 record、没有处置、并且超过时限」的事件必须为空。
//
// 跑一组真实流程：派发、Run 失败、提醒到点、用户发消息、Lead 回合失败。用的是 engine 和 store 的真实写入路径；
// daemon 那一侧（Lead 的一轮成功、Lead 播报通知）用 daemon 自己调用的同一组 store 函数代替
// （apps/daemon/src/server.ts 的 runTurnNow：drainNotices 标 delivered，成功后 markInbox consumed 和
// recordSeenDispositions；通知播报成功后 markNotificationDelivered(…, "lead")）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  completeTurn, createItem, createTurn, dueDigestBatch, failTurn, getEvent, listEvents, listInbox, listNotifications, setEventDisposition,
  listUndisposedEvents, markEventsDigested, markInbox, markNotificationDelivered, openDb, recordSeenDispositions,
  setItemTime, UNDISPOSED_EVENT_DEADLINE_MS, type Db,
} from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createIngestor } from "../src/pipeline/ingest.js";
import { createScheduler } from "../src/pipeline/scheduler.js";

function runFlows(db: Db, now: Date): void {
  // 派发：一张就绪的工单被认领，Run 起来。
  const itemId = createItem(db, { title: "整理周报", brief: "b", createdBy: "user" });
  const dispatcher = createDispatcher(db);
  dispatcher.request({
    itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "user", idempotencyKey: `dispatch:${itemId}`,
  });
  const claim = dispatcher.claimNext();
  if (!claim) throw new Error("expected a dispatch claim");
  dispatcher.markStarted(claim);

  // Run 失败：进程起来后退出，没有收尾。
  const ingest = createIngestor(db, { itemId, runId: claim.runId });
  ingest.onEvent({ type: "agent_start" });
  ingest.onExit(1);

  // 提醒到点。
  createItem(db, {
    kind: "reminder", title: "交房租", brief: "b", createdBy: "user", remindAt: new Date(now.getTime() - 1_000).toISOString(),
  });
  createScheduler(db, { now: () => now }).tick();

  // 用户发消息，Lead 答完。
  const answered = createTurn(db, { originKind: "paired:companion", userText: "周报进展如何？" });
  completeTurn(db, answered.id);

  // Lead 回合失败：模型限流。
  const failed = createTurn(db, { originKind: "paired:companion", userText: "再帮我看看" });
  failTurn(db, failed.id, "429 Too Many Requests: rate_limit_error");
}

// daemon 那一侧：Lead 的下一轮把积压的事都灌进去并且成功了；它把提醒的通知当面说给了在看的用户。
function leadHandlesBacklog(db: Db): void {
  const ids = listInbox(db, { state: ["pending", "delivered"] }).map((row) => row.id);
  markInbox(db, ids, "delivered");
  markInbox(db, ids, "consumed");
  recordSeenDispositions(db, ids);
  for (const notification of listNotifications(db, { state: ["pending"], urgency: "immediate" })) {
    markNotificationDelivered(db, notification.id, "lead");
  }
  // 提醒到点的事件（工单 07，tell 级）按事件游标交给 Lead：这一轮成功以后，Lead 没有另记处置的，记成看过了。
  // （接了推送通道时，daemon 推送时就记成告诉了用户；这里的 scheduler 没接通道。）
  for (const fire of listEvents(db, { kind: "timer.fired" })) {
    if (fire.disposition === null && fire.level !== "record") setEventDisposition(db, fire.seq, "seen");
  }
}

describe("event log invariant: every event above record gets a disposition in time", () => {
  it("catches the events nobody disposed once the deadline passes, and finds none after Lead handles them", () => {
    const db = openDb(join(tempDir("plc-event-invariant-"), "plc.db"));
    const now = new Date();
    runFlows(db, now);

    // 每一个流程都写进了日志。
    const kinds = new Set(listEvents(db, { limit: 1000 }).map((event) => event.kind));
    for (const kind of [
      "stage.changed", "run.started", "run.failed", "inbox.blocker", "timer.fired", "notification.created",
      "user.message", "lead.turn_completed", "lead.turn_failed",
    ]) expect(kinds).toContain(kind);

    // 现在：都还在时限内。
    expect(listUndisposedEvents(db, { olderThan: new Date(now.getTime() - UNDISPOSED_EVENT_DEADLINE_MS) })).toEqual([]);

    // 过了时限还没人处置：测试抓得到它们（Run 失败的 blocker、提醒的通知和到点事件）。用户的消息都有了结局，不在里面。
    const deadline = new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS);
    expect(listUndisposedEvents(db, { olderThan: deadline }).map((event) => [event.kind, event.level]).sort()).toEqual([
      ["inbox.blocker", "tell"],
      ["notification.created", "tell"],
      ["timer.fired", "tell"],
    ]);

    leadHandlesBacklog(db);
    expect(listUndisposedEvents(db, { olderThan: deadline })).toEqual([]);
    expect(listEvents(db, { kind: "user.message" }).map((event) => event.dispositionDetail?.outcome)).toEqual(["done", "unanswered"]);
    db.close();
  });
});

// 到时限还没有处置的事件升一级（工单 05，spec D3）。升级以后，不变量里留下的只有要 Lead 自己处理的事。
// 摘要级的事件（这里是逾期的可批量通知）两条路：按批交给 Lead 并记成 digested；或者没有赶上，到时限升成 tell。
describe("event log invariant: digest events nobody disposed in time are escalated", () => {
  function overdueTask(db: Db, now: Date): void {
    const itemId = createItem(db, { title: "交周报", brief: "b", createdBy: "user" });
    setItemTime(db, itemId, { dueAt: new Date(now.getTime() - 60_000).toISOString() });
  }
  const undisposedAt = (db: Db, at: Date) =>
    listUndisposedEvents(db, { olderThan: new Date(at.getTime() - UNDISPOSED_EVENT_DEADLINE_MS) });

  it("escalates a digest event at the deadline, and the invariant holds once Lead handles what it was told", () => {
    const db = openDb(join(tempDir("plc-event-escalation-"), "plc.db"));
    const now = new Date();
    runFlows(db, now);
    overdueTask(db, now);
    createScheduler(db, { now: () => now }).tick();
    const overdue = listEvents(db, { kind: "notification.created" }).find((event) => event.payload.notificationKind === "overdue")!;
    expect(overdue).toMatchObject({ level: "digest", triage: { order: { id: "notification.batchable", version: 1 } } });

    // 到时限：scheduler 这一拍把它升成 tell，原事件记成 superseded。
    const later = new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS + 60_000);
    createScheduler(db, { now: () => later }).tick();
    expect(getEvent(db, overdue.seq)).toMatchObject({ disposition: "superseded", dispositionDetail: { reason: "escalated" } });
    const escalated = listEvents(db, { kind: "event.escalated" });
    expect(escalated.map((event) => [event.payload.escalatedSeq, event.level, event.correlationId]))
      .toEqual([[overdue.seq, "tell", overdue.correlationId]]);
    // 不变量里只剩下 tell 级、要 Lead 处理的事（内部来源最高 tell，不再升）。
    expect(undisposedAt(db, later).map((event) => [event.kind, event.level]).sort()).toEqual([
      ["inbox.blocker", "tell"],
      ["notification.created", "tell"],
      ["timer.fired", "tell"],
    ]);

    // Lead 处理了积压，也把升级来的逾期通知告诉了用户：承载它的那一行送达，升级出来的事件一起处置。
    leadHandlesBacklog(db);
    markNotificationDelivered(db, overdue.payload.notificationId as number, "lead");
    expect(undisposedAt(db, new Date(later.getTime() + UNDISPOSED_EVENT_DEADLINE_MS + 60_000))).toEqual([]);
    db.close();
  });

  it("leaves nothing to escalate when the digest batch reaches Lead in time", () => {
    const db = openDb(join(tempDir("plc-event-digest-"), "plc.db"));
    const now = new Date();
    overdueTask(db, now);
    createScheduler(db, { now: () => now }).tick();
    const batch = dueDigestBatch(db, new Date(Date.now() + 25 * 60_000));
    expect(batch).toMatchObject({ due: true, reason: "max_wait" });
    expect(batch.events.map((event) => event.payload.notificationKind)).toEqual(["overdue"]);
    markEventsDigested(db, batch.events.map((event) => event.seq), { digestId: "digest-1" });
    const later = new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS + 60_000);
    createScheduler(db, { now: () => later }).tick();
    expect(listEvents(db, { kind: "event.escalated" })).toEqual([]);
    expect(undisposedAt(db, later)).toEqual([]);
    db.close();
  });
});

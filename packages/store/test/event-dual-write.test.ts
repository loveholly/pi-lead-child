// 双写（Lead 事件主干 spec D2，工单 01 第 4–6 步）：原来的写入点不变，同时在同一个事务里写一条事件。
// 每个写入点：写一次，日志里有一条对应类型的事件，entity_key 正确；原写入回滚时事件也不在。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  ackNotification, addInbox, addLeadFollowUp, addNotification, cancelLeadFollowUp, completeTurn, createItem, createRun,
  createTurn, escalateLeadBacklog, failTurn, insertCheckpoint, listEvents, listInbox, markNotificationDelivered,
  listNotifications, markRunFailed, markRunFinished, markTurnSteered, openDb, pauseRun, recordDueLeadFollowUps, recordInboxDisposition,
  recordSeenDispositions, resumeRun, retractCheckpointBlockers, setEventTriage, transition, updateRun, waitTurnForRetry,
  type Db,
} from "../src/index.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-event-dual-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

const rows = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const only = (kind: string) => {
  const events = listEvents(db, { kind });
  expect(events).toHaveLength(1);
  return events[0]!;
};

// 原写入在调用方的事务里回滚：它写的行和它的事件都不在。
function expectRollsBackTogether(table: string, write: () => unknown): void {
  const before = { rows: rows(table), events: rows("events") };
  expect(() => db.transaction(() => {
    write();
    expect(rows("events")).toBeGreaterThan(before.events);
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect({ rows: rows(table), events: rows("events") }).toEqual(before);
}

describe("inbox", () => {
  it("records one event per new row, keyed by the ticket and correlated with the row", () => {
    const { id } = addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: "完成了", payload: { kind: "child_done", wakeLead: true },
    });
    expect(only("inbox.attention")).toMatchObject({
      source: "system", sourceRef: `inbox:${id}`, entityKey: `ticket:${itemId}`, correlationId: `inbox:${id}`, level: "tell",
      payload: { inboxId: id, itemId, severity: "attention", summary: "完成了", wakeLead: true, delivery: "row", payload: { kind: "child_done" } },
    });
    expectRollsBackTogether("inbox", () => addInbox(db, { itemId, severity: "attention", source: "structural", summary: "x", lossless: true }));
  });

  it("gives a blocker a root cause from its structured payload", () => {
    addInbox(db, {
      itemId, severity: "blocker", source: "structural", summary: "Run #3 崩溃", lossless: true,
      payload: { blockerCode: "process_exit", nextStep: "检查日志", evidence: { exitCode: 1 } },
    });
    expect(only("inbox.blocker")).toMatchObject({
      level: "tell",
      rootCause: { code: "process_exit", next_step: "检查日志", message: "Run #3 崩溃", evidence: '{"exitCode":1}' },
    });
  });

  it("keys a row without a ticket by its scope", () => {
    addInbox(db, { dedupScope: "runtime-incident:4", severity: "attention", source: "structural", summary: "codex 不可用" });
    addInbox(db, { dedupScope: "memory-switch", severity: "attention", source: "structural", summary: "记忆切换" });
    expect(listEvents(db, { kind: "inbox.attention" }).map((event) => event.entityKey))
      .toEqual(["runtime-incident:4", "inbox-scope:memory-switch"]);
  });

  // spec Problem Statement：attention 合并只追加摘要，新行的 payload 和叫醒标记会丢（inbox.ts 约 42–52 行）。
  it("keeps every merged attention as its own event, with its own payload and wake flag", () => {
    const first = addInbox(db, { itemId, severity: "attention", source: "structural", summary: "进展 1", payload: { step: 1 } });
    const second = addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: "进展 2", payload: { step: 2, wakeLead: true },
    });
    const third = addInbox(db, {
      itemId, severity: "attention", source: "structural", summary: "进展 3", payload: { step: 3, needsUser: true },
    });
    expect([second, third]).toEqual([{ id: first.id, suppressed: true }, { id: first.id, suppressed: true }]);

    const events = listEvents(db, { kind: "inbox.attention" });
    expect(events.map((event) => [event.sourceRef, event.payload.delivery, event.payload.summary, event.payload.wakeLead,
      event.payload.needsUser, event.payload.payload, event.level])).toEqual([
      [`inbox:${first.id}`, "row", "进展 1", false, false, { step: 1 }, "digest"],
      [`inbox:${first.id}:merge:1`, "merged", "进展 2", true, false, { step: 2, wakeLead: true }, "tell"],
      [`inbox:${first.id}:merge:2`, "merged", "进展 3", false, true, { step: 3, needsUser: true }, "digest"],
    ]);
    expect(events.every((event) => event.correlationId === `inbox:${first.id}`)).toBe(true);
    // inbox 行上只有计数和最新的摘要；它原来的样子（第一条的摘要、merged 列表）不变。
    const [row] = listInbox(db);
    expect(row!.summary).toBe("进展 1");
    expect(JSON.parse(row!.payload)).toEqual({ step: 1, merged: ["进展 2", "进展 3"], mergedCount: 2, lastSummary: "进展 3" });
  });

  // spec Problem Statement：同一 scope 一小时内第 3 条起的 blocker 被折叠，原文只留在 lastSummary（约 55–83 行）。
  it("keeps every blocker folded by the fuse as its own event", () => {
    const summaries = ["崩溃 1", "崩溃 2", "崩溃 3", "崩溃 4", "崩溃 5"];
    for (const [index, summary] of summaries.entries()) {
      addInbox(db, { itemId, severity: "blocker", source: "structural", summary, payload: { blockerCode: `crash_${index + 1}` } });
    }
    const inbox = listInbox(db);
    expect(inbox.map((row) => row.summary)).toEqual([
      "崩溃 1", "崩溃 2", `工单 #${itemId} 异常频繁（1 小时内多次 blocker），建议人工介入`,
    ]);
    const fuse = inbox[2]!;
    expect(JSON.parse(fuse.payload)).toEqual({ suppressedCount: 3, lastSummary: "崩溃 5" });

    const events = listEvents(db, { kind: "inbox.blocker" });
    expect(events.map((event) => [event.payload.summary, event.payload.delivery, event.payload.fuseOpened ?? null,
      event.correlationId, event.level, event.rootCause?.code])).toEqual([
      ["崩溃 1", "row", null, `inbox:${inbox[0]!.id}`, "tell", "crash_1"],
      ["崩溃 2", "row", null, `inbox:${inbox[1]!.id}`, "tell", "crash_2"],
      ["崩溃 3", "folded", true, `inbox:${fuse.id}`, "tell", "crash_3"],
      ["崩溃 4", "folded", false, `inbox:${fuse.id}`, "digest", "crash_4"],
      ["崩溃 5", "folded", false, `inbox:${fuse.id}`, "digest", "crash_5"],
    ]);
  });

  // 双写阶段事件出错不让原写入回滚（events.ts 的 appendEventGuarded）：inbox 行照常提交，日志里有一条被拒的记录。
  it("keeps the inbox row when its event is rejected, and records the rejection", () => {
    setEventTriage(db, () => { throw new Error("triage down"); });
    const { id } = addInbox(db, { itemId, severity: "attention", source: "structural", summary: "x" });
    expect(listInbox(db).map((row) => row.id)).toEqual([id]);
    expect(listEvents(db, { kind: "inbox.attention" })).toEqual([]);
    expect(only("system.event_rejected")).toMatchObject({
      entityKey: `ticket:${itemId}`, level: "digest",
      payload: { rejectedKind: "inbox.attention", rejectedSourceRef: `inbox:${id}`, error: "triage down" },
    });
  });

  it("rolls the inbox write back when its event cannot be inserted", () => {
    db.exec("CREATE TRIGGER events_down BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk full'); END;");
    expect(() => addInbox(db, { itemId, severity: "attention", source: "structural", summary: "x" })).toThrow(/disk full/);
    expect(rows("inbox")).toBe(0);
  });
});

describe("dispositions of inbox events", () => {
  it("copies Lead's record_disposition onto every event of the row", () => {
    const { id } = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "卡住", payload: { blockerCode: "x" } });
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "a" });
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "b" });
    recordInboxDisposition(db, [id!], { disposition: "handled", reason: "重试好了", cause: "网络抖动", action: "重试" });
    expect(only("inbox.blocker")).toMatchObject({
      disposition: "handled", dispositionDetail: { reason: "重试好了", cause: "网络抖动", action: "重试" },
    });
    expect(listEvents(db, { kind: "inbox.attention" }).map((event) => event.disposition)).toEqual([null, null]);
  });

  it("marks the events of a turn's rows as seen after the turn succeeds, without overwriting Lead's own", () => {
    const told = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "a", payload: { blockerCode: "x" }, lossless: true });
    const quiet = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "b", payload: { blockerCode: "y" }, lossless: true });
    recordInboxDisposition(db, [told.id!], { disposition: "told_user", reason: "说了" });
    recordSeenDispositions(db, [told.id!, quiet.id!]);
    expect(listEvents(db, { kind: "inbox.blocker" }).map((event) => event.disposition)).toEqual(["told_user", "seen"]);
  });

  it("disposes the events of a retracted blocker as superseded", () => {
    const checkpoint = insertCheckpoint(db, {
      itemId, runId: null, source: "system_derived", kind: "blocked", title: "等登录", summary: "需要登录",
      nextStep: "请用户登录", idempotencyKey: "cp-1",
    });
    addInbox(db, {
      itemId, severity: "blocker", source: "structural", summary: "等登录", lossless: true,
      payload: { blockerKey: `checkpoint:${checkpoint.id}`, blockerCode: "blocked_checkpoint" },
    });
    expect(retractCheckpointBlockers(db, ["cp-1"])).toBe(1);
    expect(only("inbox.blocker")).toMatchObject({ disposition: "superseded" });
  });

  it("disposes a cancelled follow-up and an escalated backlog", () => {
    const followUp = addLeadFollowUp(db, { at: new Date(Date.now() + 3_600_000), note: "看看 CI" });
    cancelLeadFollowUp(db, followUp, { reason: "CI 已经好了" });
    expect(only("inbox.attention")).toMatchObject({ level: "record", disposition: "no_action", dispositionDetail: { reason: "CI 已经好了" } });

    const { id } = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "卡住", payload: { blockerCode: "x" } });
    escalateLeadBacklog(db, [id!], { reason: "Lead 的模型连不上" });
    expect(only("inbox.blocker")).toMatchObject({ disposition: "told_user", dispositionDetail: { via: "fallback", reason: "Lead 的模型连不上" } });
  });
});

describe("Lead follow-ups coming due", () => {
  it("records one timer event when a follow-up comes due, keyed like its row", () => {
    const at = new Date("2026-10-17T09:00:00.000Z");
    const id = addLeadFollowUp(db, { at, note: "看看 CI", itemId });
    expect(recordDueLeadFollowUps(db, new Date("2026-10-17T08:59:59.000Z"))).toBe(0);
    expect(recordDueLeadFollowUps(db, at)).toBe(1);
    expect(recordDueLeadFollowUps(db, new Date("2026-10-17T09:05:00.000Z"))).toBe(0);
    expect(only("timer.fired")).toMatchObject({
      source: "timer", sourceRef: `followup:${id}`, entityKey: `ticket:${itemId}`, correlationId: `inbox:${id}`, level: "tell",
      occurredAt: at.toISOString(), payload: { timer: "lead_followup", inboxId: id, itemId, note: "看看 CI", wakeLead: true },
    });
    recordSeenDispositions(db, [id]);
    expect(only("timer.fired").disposition).toBe("seen");
  });
});

describe("notifications", () => {
  it("records one event per notification, and none for a repeated dedup key", () => {
    const id = addNotification(db, { itemId, kind: "review_passed", urgency: "immediate", title: "核查通过", dedupKey: "rp:1" });
    addNotification(db, { itemId, kind: "review_passed", urgency: "immediate", title: "核查通过", dedupKey: "rp:1" });
    expect(only("notification.created")).toMatchObject({
      source: "system", sourceRef: `notification:${id}`, entityKey: `ticket:${itemId}`, correlationId: `notification:${id}`,
      level: "tell", payload: { notificationId: id, urgency: "immediate", notificationKind: "review_passed", dedupKey: "rp:1" },
    });
    expectRollsBackTogether("notifications", () => addNotification(db, { kind: "x", urgency: "batchable", title: "t" }));
  });

  it("keeps a notification whose event does not validate, and records the rejection", () => {
    const id = addNotification(db, { itemId, kind: "reminder", urgency: "immediate", title: "提醒", createdAt: "下周一早上" });
    expect(listNotifications(db).map((row) => row.id)).toEqual([id]);
    expect(listEvents(db, { kind: "notification.created" })).toEqual([]);
    expect(only("system.event_rejected")).toMatchObject({
      payload: { rejectedKind: "notification.created", error: expect.stringMatching(/occurredAt/) },
    });
  });

  it("disposes a notification's event as told when it is delivered or acknowledged", () => {
    const delivered = addNotification(db, { itemId, kind: "reminder", urgency: "immediate", title: "提醒" });
    const acked = addNotification(db, { kind: "overdue", urgency: "batchable", title: "逾期" });
    markNotificationDelivered(db, delivered, "fallback");
    ackNotification(db, acked);
    expect(listEvents(db, { kind: "notification.created" }).map((event) => [event.disposition, event.dispositionDetail]))
      .toEqual([["told_user", { via: "fallback" }], ["told_user", { via: "ack" }]]);
  });
});

describe("checkpoints", () => {
  it("records one event per new checkpoint, and none for a deduplicated one", () => {
    const input = {
      itemId, runId: null, source: "system_derived" as const, kind: "progress" as const, title: "进展", summary: "做了一半",
      nextStep: "继续", idempotencyKey: "cp-progress",
    };
    const checkpoint = insertCheckpoint(db, input);
    insertCheckpoint(db, input);
    expect(only("checkpoint.recorded")).toMatchObject({
      source: "ticket", sourceRef: `checkpoint:${checkpoint.id}`, entityKey: `ticket:${itemId}`, level: "record",
      payload: { checkpointId: checkpoint.id, itemId, checkpointKind: "progress", title: "进展", nextStep: "继续" },
    });
    expectRollsBackTogether("checkpoints", () => insertCheckpoint(db, { ...input, idempotencyKey: "cp-2", title: "另一个" }));
  });
});

describe("stage transitions", () => {
  it("records each transition with a rising entity version", () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "crash" });
    expect(listEvents(db, { kind: "stage.changed" }).map((event) => [event.sourceRef, event.entityKey, event.entityVersion,
      event.payload.from, event.payload.to, event.level])).toEqual([
      [`ticket:${itemId}:v1`, `ticket:${itemId}`, 1, "ready", "active", "record"],
      [`ticket:${itemId}:v2`, `ticket:${itemId}`, 2, "active", "blocked", "record"],
    ]);
    expectRollsBackTogether("activities", () => transition(db, { itemId, to: "active", actor: "system", reason: "retry" }));
  });

  it("keys a reminder as a reminder", () => {
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "b", createdBy: "user", remindAt: "2026-10-17T01:00:00.000Z" });
    transition(db, { itemId: reminder, to: "fired", actor: "system", reason: "remind_at reached" });
    expect(only("stage.changed")).toMatchObject({ entityKey: `reminder:${reminder}`, payload: { itemKind: "reminder", to: "fired" } });
  });
});

describe("run state", () => {
  it("records start, pause, resume and finish, and nothing when the state does not change", () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    updateRun(db, runId, { state: "running", pid: 42 });
    pauseRun(db, runId, new Date("2026-10-17T08:00:00.000Z"));
    resumeRun(db, runId, new Date("2026-10-17T08:05:00.000Z"));
    markRunFinished(db, runId, { exitCode: 0 });
    expect(listEvents(db, { entityKey: `run:${runId}` }).map((event) => [event.kind, event.sourceRef, event.level])).toEqual([
      ["run.started", `run:${runId}:started`, "record"],
      ["run.paused", `run:${runId}:paused:2026-10-17T08:00:00.000Z`, "record"],
      ["run.resumed", `run:${runId}:resumed:2026-10-17T08:00:00.000Z`, "record"],
      ["run.finished", `run:${runId}:finished`, "record"],
    ]);
    expect(listEvents(db, { kind: "run.finished" })[0]!.payload).toMatchObject({
      runId, itemId, role: "executor", purpose: "execution", runtime: "codex", from: "running", to: "finished", exitCode: 0,
    });
    const another = createRun(db, { itemId, runtime: "codex" });
    expectRollsBackTogether("activities", () => {
      updateRun(db, another, { state: "running" });
      db.prepare("INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'system', 'comment', '{}')").run(itemId);
    });
    expect(listEvents(db, { entityKey: `run:${another}` })).toEqual([]);
  });

  it("gives a failed run a root cause from its typed failure and error code", () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    markRunFailed(db, runId, {
      exitCode: 1, errorCode: "process_exit", errorMessage: "exit 1",
      failure: { scope: "task", retry: "resume", needs: "none", code: "process_exit", evidence: "stderr tail" },
    });
    expect(only("run.failed")).toMatchObject({
      sourceRef: `run:${runId}:failed`, entityKey: `run:${runId}`,
      payload: { exitCode: 1, errorCode: "process_exit" },
      rootCause: { code: "process_exit", scope: "task", needs: "none", retry: "resume", evidence: "stderr tail", message: "exit 1",
        next_step: expect.any(String) },
    });
  });

  it("rolls the run state back only when its event cannot be inserted", () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    db.exec("CREATE TRIGGER events_down BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk full'); END;");
    expect(() => markRunFailed(db, runId, { errorCode: "process_exit", errorMessage: "exit 1" })).toThrow(/disk full/);
    expect(db.prepare("SELECT state FROM runs WHERE id = ?").get(runId)).toEqual({ state: "running" });
  });

  it("classifies a failed run that carries only an error code", () => {
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "lease_expired", errorMessage: "lease expired" });
    expect(only("run.failed").rootCause).toMatchObject({ code: expect.any(String), scope: expect.any(String), message: "lease expired" });
  });
});

describe("channel turns", () => {
  it("records a user's message at the conversation level and settles it when the turn completes", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "进展如何" });
    expect(only("user.message")).toMatchObject({
      source: "user", sourceRef: `turn:${turn.id}`, entityKey: "chat:main", level: "conversation", disposition: null,
      payload: { turnId: turn.id, originKind: "paired:companion", text: "进展如何" },
    });
    completeTurn(db, turn.id);
    expect(only("lead.turn_completed")).toMatchObject({ source: "lead", entityKey: "chat:main", payload: { turnId: turn.id }, level: "record" });
    expect(only("user.message")).toMatchObject({ disposition: "handled", dispositionDetail: { outcome: "done" } });
    expectRollsBackTogether("channel_turns", () => createTurn(db, { originKind: "paired:companion", userText: "再问" }));
  });

  it("rolls a turn's end back together with its event", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "进展如何" });
    expect(() => db.transaction(() => {
      completeTurn(db, turn.id);
      expect(listEvents(db, { kind: "lead.turn_completed" })).toHaveLength(1);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(db.prepare("SELECT state FROM channel_turns WHERE id = ?").get(turn.id)).toEqual({ state: "streaming" });
    expect(listEvents(db, { kind: "lead.turn_completed" })).toEqual([]);
    expect(only("user.message").disposition).toBeNull();
  });

  it("records a failed Lead turn with a root cause, and leaves the message unanswered", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "帮我查一下" });
    failTurn(db, turn.id, "429 Too Many Requests: rate_limit_error");
    expect(only("lead.turn_failed")).toMatchObject({
      level: "record", payload: { turnId: turn.id, error: "429 Too Many Requests: rate_limit_error", willRetry: false },
      rootCause: { code: "lead_model_busy", scope: "runtime" },
    });
    expect(only("user.message")).toMatchObject({ disposition: "no_action", dispositionDetail: { outcome: "unanswered" } });
  });

  it("records an attempt that waits for an automatic retry, and leaves the message open", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "帮我查一下" });
    waitTurnForRetry(db, turn.id, "getaddrinfo ENOTFOUND api.anthropic.com");
    expect(only("lead.turn_failed")).toMatchObject({ payload: { willRetry: true }, rootCause: { code: "lead_model_network" } });
    expect(only("user.message").disposition).toBeNull();
  });

  it("settles a steered message, keys a ticket conversation by its ticket, and records the ticket agent's turns", () => {
    const steered = createTurn(db, { originKind: "paired:companion", userText: "插一句", state: "queued" });
    markTurnSteered(db, steered.id);
    expect(only("user.message")).toMatchObject({ disposition: "handled", dispositionDetail: { outcome: "steered" } });

    const ticketTurn = createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "做完了吗" });
    failTurn(db, ticketTurn.id, "child crashed");
    expect(listEvents(db, { kind: "user.message" })[1]).toMatchObject({ entityKey: `ticket:${itemId}` });
    expect(only("ticket_agent.turn_failed")).toMatchObject({ source: "ticket", entityKey: `ticket:${itemId}` });
    expect(listEvents(db, { kind: "lead.turn_failed" })).toEqual([]);
  });

  it("records Lead's own turns, and nothing for the daemon's notices", () => {
    const leadTurn = createTurn(db, { originKind: "system:blocker", userText: "" });
    completeTurn(db, leadTurn.id);
    const notice = createTurn(db, { originKind: "system:fallback-notice", userText: "" });
    completeTurn(db, notice.id);
    expect(listEvents(db).map((event) => event.kind)).toEqual(["lead.turn_completed"]);
    expect(listEvents(db, { kind: "user.message" })).toEqual([]);
  });
});

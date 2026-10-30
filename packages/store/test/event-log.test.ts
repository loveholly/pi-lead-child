// 事件日志内核（Lead 事件主干 spec D1、D2、D5，工单 01）：appendEvent 和查询、处置、级别。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { EventEnvelope } from "@pi-lead-child/protocol";
import {
  appendEvent, appendEventGuarded, getEvent, listEvents, listUndisposedEvents, openDb, setEventDisposition, setEventLevel,
  setEventTriage, UNDISPOSED_EVENT_DEADLINE_MS, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-event-log-"), "plc.db"));
});

const append = (envelope: EventEnvelope) => db.transaction(() => appendEvent(db, envelope))();
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

const stageChanged = (itemId: number, version: number): EventEnvelope => ({
  source: "ticket",
  sourceRef: `ticket:${itemId}:v${version}`,
  kind: "stage.changed",
  entityKey: `ticket:${itemId}`,
  entityVersion: version,
  payload: { itemId, itemKind: "task", from: "ready", to: "active", actor: "system", reason: "dispatch" },
});

const blocker = (inboxId: number, rootCause = true): EventEnvelope => ({
  source: "system",
  sourceRef: `inbox:${inboxId}`,
  kind: "inbox.blocker",
  entityKey: "ticket:7",
  correlationId: `inbox:${inboxId}`,
  payload: {
    inboxId, itemId: 7, scope: "item:7", severity: "blocker", inboxSource: "structural", summary: "卡住了",
    wakeLead: true, needsUser: false, delivery: "row", payload: {},
  },
  ...(rootCause ? { rootCause: { code: "process_exit", message: "exit 1" } } : {}),
});

describe("appendEvent", () => {
  it("only runs inside the caller's transaction", () => {
    expect(() => appendEvent(db, stageChanged(1, 1))).toThrow(/transaction/);
    expect(count()).toBe(0);
  });

  it("stores the envelope with a global seq, a sortable event id and the triaged level", () => {
    const first = append(stageChanged(1, 1));
    const second = append(stageChanged(1, 2));
    expect(first.inserted).toBe(true);
    expect(second.event.seq).toBeGreaterThan(first.event.seq);
    expect(first.event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.event.eventId > first.event.eventId).toBe(true);
    expect(first.event).toMatchObject({
      source: "ticket", sourceRef: "ticket:1:v1", kind: "stage.changed", entityKey: "ticket:1", entityVersion: 1,
      payload: { itemId: 1, to: "active" }, rootCause: null, level: "record", disposition: null,
    });
    expect(Date.parse(first.event.occurredAt)).not.toBeNaN();
    expect(Date.parse(first.event.receivedAt)).not.toBeNaN();
  });

  it("returns the existing row for a repeated (source, source_ref) and writes nothing new", () => {
    const first = append(stageChanged(1, 1));
    const again = append({ ...stageChanged(1, 1), payload: { ...stageChanged(1, 1).payload, reason: "replayed" } });
    expect(again.inserted).toBe(false);
    expect(again.event.seq).toBe(first.event.seq);
    expect(again.event.payload.reason).toBe("dispatch");
    expect(count()).toBe(1);
  });

  it("does not deduplicate events without a source ref", () => {
    append({ ...stageChanged(1, 1), sourceRef: null });
    append({ ...stageChanged(1, 1), sourceRef: null });
    expect(count()).toBe(2);
  });

  it("rejects an unregistered kind", () => {
    expect(() => append({ ...stageChanged(1, 1), kind: "stage.teleported" })).toThrow(/stage\.teleported/);
    expect(count()).toBe(0);
  });

  it("rejects a failure event without a root cause", () => {
    expect(() => append({
      source: "run", sourceRef: "run:3:failed", kind: "run.failed", entityKey: "run:3",
      payload: { runId: 3, itemId: 1, role: "executor", purpose: "execution", runtime: "codex", from: "running", to: "failed" },
    })).toThrow(/root_cause/);
    // 级别到了 tell 的异常（blocker）同样要根因。
    expect(() => append(blocker(9, false))).toThrow(/root_cause/);
    expect(count()).toBe(0);
  });

  it("fixes a user's own message at the conversation level, without triage", () => {
    setEventTriage(db, () => "interrupt");
    const message = append({
      source: "user", sourceRef: "turn:t1", kind: "user.message", entityKey: "chat:main", level: "digest",
      payload: { turnId: "t1", originKind: "paired:companion", text: "你好" },
    });
    expect(message.event.level).toBe("conversation");
  });

  it("uses the triage installed for this database, and an explicit level over it", () => {
    setEventTriage(db, () => "digest");
    expect(append(stageChanged(1, 1)).event.level).toBe("digest");
    expect(append({ ...stageChanged(1, 2), level: "tell" }).event.level).toBe("tell");
    setEventTriage(db, null);
    expect(append(stageChanged(1, 3)).event.level).toBe("record");
  });
});

describe("listEvents", () => {
  it("filters by cursor, entity, kind and level, oldest first by default, newest first on request", () => {
    const a = append(stageChanged(1, 1)).event;
    const b = append(stageChanged(2, 1)).event;
    const c = append(blocker(5)).event;
    const d = append(stageChanged(1, 2)).event;
    expect(listEvents(db).map((event) => event.seq)).toEqual([a.seq, b.seq, c.seq, d.seq]);
    expect(listEvents(db, { sinceSeq: b.seq }).map((event) => event.seq)).toEqual([c.seq, d.seq]);
    expect(listEvents(db, { entityKey: "ticket:1" }).map((event) => event.seq)).toEqual([a.seq, d.seq]);
    expect(listEvents(db, { kind: "inbox.blocker" }).map((event) => event.seq)).toEqual([c.seq]);
    expect(listEvents(db, { level: "tell" }).map((event) => event.seq)).toEqual([c.seq]);
    expect(listEvents(db, { order: "desc", limit: 2 }).map((event) => event.seq)).toEqual([d.seq, c.seq]);
    expect(getEvent(db, c.seq)?.rootCause).toEqual({ code: "process_exit", message: "exit 1" });
  });
});

describe("dispositions and levels", () => {
  it("lists only events above record, without a disposition, older than the cutoff", () => {
    const recorded = append(stageChanged(1, 1)).event;
    const told = append(blocker(5)).event;
    const disposed = append(blocker(6)).event;
    setEventDisposition(db, disposed.seq, "handled", { cause: "磁盘满了" });

    const later = new Date(Date.now() + 60_000);
    expect(listUndisposedEvents(db, { olderThan: later }).map((event) => event.seq)).toEqual([told.seq]);
    expect(listUndisposedEvents(db, { olderThan: new Date(Date.parse(told.receivedAt) - 1) })).toEqual([]);
    expect(getEvent(db, recorded.seq)?.disposition).toBeNull();
    expect(getEvent(db, disposed.seq)).toMatchObject({
      disposition: "handled", dispositionDetail: { cause: "磁盘满了" }, disposedAt: expect.any(String),
    });
  });

  it("validates disposition and level values", () => {
    const event = append(stageChanged(1, 1)).event;
    expect(() => setEventDisposition(db, event.seq, "ignored" as never)).toThrow(/disposition/);
    expect(() => setEventLevel(db, event.seq, "urgent" as never)).toThrow(/level/);
    expect(setEventLevel(db, event.seq, "digest")).toBe(true);
    expect(getEvent(db, event.seq)?.level).toBe("digest");
    expect(setEventLevel(db, 999_999, "digest")).toBe(false);
  });

  it("refuses to raise an anomaly without a root cause to tell", () => {
    const quiet = db.transaction(() => appendEvent(db, { ...blocker(8, false), level: "digest" }))().event;
    expect(() => setEventLevel(db, quiet.seq, "tell")).toThrow(/root_cause/);
    expect(getEvent(db, quiet.seq)?.level).toBe("digest");
  });
});

// 双写阶段（spec D15）事件日志还不是事实来源：事件本身出错不能让原来的写入回滚。
// 原来的写入照常提交，日志里改记一条 system.event_rejected（digest），它会出现在「没有处置的事件」里。
// 只有 SQL 层的失败（INSERT 不成功）才和原写入一起回滚。
describe("appendEventGuarded", () => {
  const originalWrite = () => db.prepare("INSERT INTO kv (key, value) VALUES ('original', 'write')").run();
  const committed = () => db.prepare("SELECT value FROM kv WHERE key = 'original'").get();
  const rejections = () => listEvents(db, { kind: "system.event_rejected" });
  const guarded = (build: () => EventEnvelope) => db.transaction(() => {
    originalWrite();
    return appendEventGuarded(db, build);
  })();

  it("writes the event as usual when nothing goes wrong", () => {
    expect(guarded(() => stageChanged(1, 1)).event).toMatchObject({ kind: "stage.changed", entityKey: "ticket:1" });
    expect(committed()).toEqual({ value: "write" });
    expect(rejections()).toEqual([]);
  });

  it("commits the original write and records a rejection when building the envelope throws", () => {
    guarded(() => { throw new Error("classifier exploded"); });
    expect(committed()).toEqual({ value: "write" });
    expect(rejections()).toEqual([expect.objectContaining({
      source: "system", entityKey: "system:event-rejected", level: "digest", disposition: null,
      payload: expect.objectContaining({ rejectedKind: null, error: "classifier exploded" }),
    })]);
  });

  it("commits the original write and records a rejection when the kind is not registered", () => {
    guarded(() => ({ ...stageChanged(1, 1), kind: "stage.teleported" }));
    expect(committed()).toEqual({ value: "write" });
    expect(rejections()).toEqual([expect.objectContaining({
      entityKey: "ticket:1", level: "digest", sourceRef: "rejected:ticket:ticket:1:v1",
      payload: expect.objectContaining({ rejectedKind: "stage.teleported", entityKey: "ticket:1", error: expect.stringMatching(/没有注册/) }),
    })]);
    expect(listEvents(db, { kind: "stage.changed" })).toEqual([]);
  });

  it("commits the original write and records a rejection when the envelope does not validate", () => {
    guarded(() => ({ ...stageChanged(1, 1), payload: { itemId: "one" } }));
    expect(committed()).toEqual({ value: "write" });
    expect(rejections()[0]).toMatchObject({
      entityKey: "ticket:1", payload: { rejectedKind: "stage.changed", error: expect.stringMatching(/payload/) },
    });
  });

  it("commits the original write and records a rejection when triage throws, without asking triage again", () => {
    let calls = 0;
    setEventTriage(db, () => { calls++; throw new Error("standing orders unreadable"); });
    guarded(() => stageChanged(1, 1));
    expect(calls).toBe(1);
    expect(committed()).toEqual({ value: "write" });
    expect(rejections()[0]).toMatchObject({ level: "digest", payload: { error: "standing orders unreadable" } });
  });

  it("keeps a rejection among the undisposed events until someone disposes it", () => {
    guarded(() => { throw new Error("x"); });
    expect(listUndisposedEvents(db, { olderThan: new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS) }).map((event) => event.kind))
      .toEqual(["system.event_rejected"]);
  });

  it("records one rejection per delivery when the same delivery is rejected again", () => {
    const bad = () => ({ ...stageChanged(1, 1), kind: "stage.teleported" });
    db.transaction(() => { appendEventGuarded(db, bad); appendEventGuarded(db, bad); })();
    expect(rejections()).toHaveLength(1);
  });

  it("rolls the original write back when the event cannot be inserted", () => {
    db.exec("CREATE TRIGGER events_down BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk full'); END;");
    expect(() => guarded(() => stageChanged(1, 1))).toThrow(/disk full/);
    expect(committed()).toBeUndefined();
    // 被拒的事件也写不进去时同样回滚：SQL 的错误照常抛出。
    expect(() => guarded(() => { throw new Error("x"); })).toThrow(/disk full/);
    expect(committed()).toBeUndefined();
  });

  it("still runs only inside the caller's transaction", () => {
    expect(() => appendEventGuarded(db, () => stageChanged(1, 1))).toThrow(/transaction/);
    expect(count()).toBe(0);
  });
});

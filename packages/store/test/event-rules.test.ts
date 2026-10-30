// 规则层里和时间有关的部分（工单 05，spec D3、D5）：按根因合并、到时限升级、摘要按批。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { StandingOrderDefinition } from "@pi-lead-child/protocol";
import {
  addInbox, addNotification, appendEventGuarded, createItem, dueDigestBatch, escalateOverdueEvents, getEvent,
  listEvents, listRootCauseMerged, listUndisposedEvents, markEventsDigested, openDb, recordSeenDispositions,
  recordStandingOrderVersion, SYSTEM_STANDING_ORDERS, UNDISPOSED_EVENT_DEADLINE_MS, type Db, type EventRecord,
} from "../src/index.js";

const MINUTE = 60_000;

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-event-rules-"), "plc.db"));
});

const seed = (id: string): StandingOrderDefinition => SYSTEM_STANDING_ORDERS.find((order) => order.id === id)!;

// 把事件的收到时间往回拨，模拟它已经等了一段时间。
function age(seq: number, ms: number): void {
  const event = getEvent(db, seq)!;
  db.prepare("UPDATE events SET received_at = ? WHERE seq = ?").run(new Date(Date.parse(event.receivedAt) - ms).toISOString(), seq);
}

const lastEvent = (kind: string): EventRecord => listEvents(db, { kind, order: "desc", limit: 1 })[0]!;

// 瞬时失败的重试说明（engine 的 transient-retry.ts 写的样子）。
function retryNotice(itemId: number, code = "network_error"): EventRecord {
  addInbox(db, {
    itemId, severity: "attention", source: "structural", summary: `工单 #${itemId}：网络中断，30 秒后自动重试`,
    payload: { kind: "transient_retry", runId: itemId * 10, attempt: 1, limit: 5, code }, lossless: true,
  });
  return lastEvent("inbox.attention");
}

const task = (title = "t") => createItem(db, { title, brief: "b", createdBy: "user" });

describe("merging by root cause", () => {
  it("merges a second event with the same infrastructure root cause into the first, and Lead hears it once", () => {
    const first = retryNotice(task("a"));
    const second = retryNotice(task("b"));
    expect(first).toMatchObject({ level: "digest", disposition: null, rootCause: { code: "network_error" } });
    expect(second).toMatchObject({
      level: "digest",
      disposition: "superseded",
      dispositionDetail: {
        reason: "merged_root_cause", mergedInto: first.seq, rootCauseCode: "network_error",
        standingOrder: { id: "events.merge_root_cause", version: 1 },
      },
      triage: {
        order: { id: "run.transient_retry", version: 1 },
        applied: [{ id: "events.merge_root_cause", version: 1, effect: "merged_root_cause" }],
        mergedInto: first.seq,
      },
    });
    expect(listRootCauseMerged(db, first.seq).map((event) => event.seq)).toEqual([second.seq]);
    // 第三条也并进第一条，不并进已经合并掉的那条。
    const third = retryNotice(task("c"));
    expect(third.dispositionDetail?.mergedInto).toBe(first.seq);
  });

  it("does not merge a different code, a handled first event, an old one, or a ticket's own failure", () => {
    const first = retryNotice(task("a"));
    expect(retryNotice(task("b"), "rate_limited").disposition).toBeNull();
    // 第一条已经处置了：之后再发生是新的一次，要让 Lead 知道。
    recordSeenDispositions(db, [first.payload.inboxId as number]);
    expect(retryNotice(task("c")).disposition).toBeNull();
    // 超过 30 分钟的时间窗不合并。
    const later = lastEvent("inbox.attention");
    age(later.seq, 31 * MINUTE);
    expect(retryNotice(task("d")).disposition).toBeNull();
    // 工单自己的失败（没有作用域，或者 scope=task）不按码合并：码相同不等于原因相同。
    const crash = (itemId: number) => {
      addInbox(db, {
        itemId, severity: "blocker", source: "structural", summary: "崩溃",
        payload: { blockerCode: "process_exit", failure: { scope: "task", code: "task_failed" } }, lossless: true,
      });
      return lastEvent("inbox.blocker");
    };
    crash(task("e"));
    expect(crash(task("f")).disposition).toBeNull();
  });

  it("merges blockers whose root cause is the account, but never an approval", () => {
    const blocker = (itemId: number, extra: Record<string, unknown> = {}) => {
      addInbox(db, {
        itemId, severity: "blocker", source: "structural", summary: "要登录",
        payload: { blockerCode: "auth_required", failure: { scope: "account", needs: "login", code: "auth_required" }, ...extra },
        lossless: true,
      });
      return lastEvent("inbox.blocker");
    };
    const first = blocker(task("a"));
    expect(blocker(task("b"))).toMatchObject({ level: "tell", disposition: "superseded", dispositionDetail: { mergedInto: first.seq } });
    const approval = blocker(task("c"), { authorityType: "approval", authorityId: 4 });
    expect(approval).toMatchObject({ level: "tell", disposition: null });
  });
});

describe("escalating events nobody disposed in time", () => {
  const attention = (itemId: number) => {
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "交付进了待验收" });
    return lastEvent("inbox.attention");
  };

  it("escalates a digest event past the deadline to tell, and supersedes the original", () => {
    const itemId = task();
    const waiting = attention(itemId);
    expect(waiting.level).toBe("digest");
    expect(escalateOverdueEvents(db, new Date())).toEqual([]);
    const now = new Date(Date.parse(waiting.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    const [escalation] = escalateOverdueEvents(db, now);
    expect(escalation).toMatchObject({ seq: waiting.seq, from: "digest", to: "tell" });
    expect(getEvent(db, waiting.seq)).toMatchObject({
      disposition: "superseded",
      dispositionDetail: {
        reason: "escalated", escalatedTo: escalation!.escalatedSeq, fromLevel: "digest", toLevel: "tell",
        standingOrder: { id: "events.escalate_overdue", version: 1 },
      },
    });
    const escalated = getEvent(db, escalation!.escalatedSeq)!;
    expect(escalated).toMatchObject({
      source: "system", kind: "event.escalated", level: "tell", entityKey: waiting.entityKey,
      correlationId: waiting.correlationId, causationId: waiting.eventId, receivedAt: now.toISOString(), disposition: null,
      payload: {
        escalatedSeq: waiting.seq, escalatedKind: "inbox.attention", escalatedSource: "system", fromLevel: "digest",
        toLevel: "tell", summary: "交付进了待验收", mergedSeqs: [],
      },
      triage: {
        order: { id: "events.escalate_overdue", version: 1 },
        applied: [{ id: "inbox.no_wake", version: 1, effect: "escalate_to_tell" }],
      },
    });
    // 不变量：过了时限还没有处置的事件为空。
    expect(listUndisposedEvents(db, { olderThan: new Date(now.getTime() - UNDISPOSED_EVENT_DEADLINE_MS) })).toEqual([]);
    // 同一个时刻再跑一遍不会再升。
    expect(escalateOverdueEvents(db, now)).toEqual([]);
    // 承载这件事的那一行被 Lead 看过了：升级出来的那条一起处置。
    recordSeenDispositions(db, [waiting.payload.inboxId as number]);
    expect(getEvent(db, escalation!.escalatedSeq)?.disposition).toBe("seen");
  });

  it("does not raise an internal event above tell: the invariant reports it instead", () => {
    const itemId = task();
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "崩溃" });
    const told = lastEvent("inbox.blocker");
    expect(told.level).toBe("tell");
    const now = new Date(Date.parse(told.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    expect(escalateOverdueEvents(db, now)).toEqual([]);
    expect(listUndisposedEvents(db, { olderThan: new Date(now.getTime() - UNDISPOSED_EVENT_DEADLINE_MS) }).map((event) => event.seq))
      .toEqual([told.seq]);

    // 升级出来的 tell 也一样：又过了一个时限，它留在原地，由不变量报告。
    const waiting = attention(task("b"));
    const first = new Date(Date.parse(waiting.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    const [escalation] = escalateOverdueEvents(db, first);
    const second = new Date(first.getTime() + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    expect(escalateOverdueEvents(db, second)).toEqual([]);
    expect(listUndisposedEvents(db, { olderThan: new Date(second.getTime() - UNDISPOSED_EVENT_DEADLINE_MS) }).map((event) => event.seq))
      .toEqual([told.seq, escalation!.escalatedSeq]);
  });

  it("escalates an event without a basis by the ladder", () => {
    db.transaction(() => appendEventGuarded(db, () => { throw new Error("坏了"); }))();
    const rejected = lastEvent("system.event_rejected");
    expect(rejected).toMatchObject({ level: "digest", triage: null });
    const now = new Date(Date.parse(rejected.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    expect(escalateOverdueEvents(db, now)).toEqual([expect.objectContaining({ seq: rejected.seq, from: "digest", to: "tell" })]);
  });

  it("skips an event it cannot escalate and still escalates the ones after it", () => {
    const broken = attention(task("a"));
    const fine = attention(task("b"));
    // 根因坏了（没有 code）：升级出来的事件校验不过。
    db.prepare("UPDATE events SET root_cause = '{\"x\":1}' WHERE seq = ?").run(broken.seq);
    const errors: number[] = [];
    const now = new Date(Date.parse(fine.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    expect(escalateOverdueEvents(db, now, { onError: (seq) => errors.push(seq) }).map((escalation) => escalation.seq))
      .toEqual([fine.seq]);
    expect(errors).toEqual([broken.seq]);
    expect(getEvent(db, broken.seq)?.disposition).toBeNull();
  });

  it("follows the standing orders: the source's threshold and the number per pass", () => {
    const events = [attention(task("a")), attention(task("b")), attention(task("c"))];
    const now = new Date(Date.parse(events.at(-1)!.receivedAt) + UNDISPOSED_EVENT_DEADLINE_MS + 1);
    recordStandingOrderVersion(db, { ...seed("events.escalate_overdue"), limits: { count: 2, windowMs: 30 * MINUTE }, reason: "每轮 2 条" },
      { author: "user", approvedBy: "user" });
    expect(escalateOverdueEvents(db, now).map((escalation) => escalation.seq)).toEqual([events[0]!.seq, events[1]!.seq]);
    // 来源 system 的打断阈值改成 digest：digest 的事件不再升。
    recordStandingOrderVersion(db, {
      ...seed("source.system"),
      action: { type: "rule", rule: "source.threshold", params: { source: "system", defaultLevel: "record", maxLevel: "digest" } },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    expect(escalateOverdueEvents(db, now)).toEqual([]);
  });
});

describe("the digest batch", () => {
  const batchable = (itemId: number, title: string) => {
    addNotification(db, { itemId, kind: "overdue", urgency: "batchable", title });
    return lastEvent("notification.created");
  };

  it("waits for the oldest digest event to reach 25 minutes, or for the user to return", () => {
    expect(dueDigestBatch(db)).toMatchObject({ due: false, reason: null, events: [], entries: [], dueAt: null });
    const itemId = task();
    const first = batchable(itemId, "工单逾期了");
    const second = batchable(itemId, "工单又逾期了");
    const other = batchable(task("b"), "另一张逾期了");
    const received = Date.parse(first.receivedAt);
    const early = dueDigestBatch(db, new Date(received + 24 * MINUTE));
    expect(early).toMatchObject({
      due: false, reason: null, dueAt: new Date(received + 25 * MINUTE).toISOString(),
      order: { id: "events.digest_batch", version: 1 },
    });
    expect(early.events.map((event) => event.seq)).toEqual([first.seq, second.seq, other.seq]);
    // 按对象合并：同一张工单的放在一起。
    expect(early.entries.map((entry) => [entry.entityKey, entry.events.map((event) => event.seq)])).toEqual([
      [`ticket:${itemId}`, [first.seq, second.seq]],
      [other.entityKey, [other.seq]],
    ]);
    expect(dueDigestBatch(db, new Date(received + 25 * MINUTE))).toMatchObject({ due: true, reason: "max_wait" });
    expect(dueDigestBatch(db, new Date(received + MINUTE), { userReturned: true })).toMatchObject({ due: true, reason: "user_returned" });
  });

  it("attaches the events merged into a digest event, and marks the batch digested once Lead has it", () => {
    const first = retryNotice(task("a"));
    const merged = retryNotice(task("b"));
    const batch = dueDigestBatch(db, new Date(), { userReturned: true });
    expect(batch.events.map((event) => event.seq)).toEqual([first.seq]);
    expect(batch.entries[0]!.merged.map((event) => event.seq)).toEqual([merged.seq]);
    expect(markEventsDigested(db, batch.events.map((event) => event.seq), { digestId: "turn-7" })).toBe(1);
    expect(getEvent(db, first.seq)).toMatchObject({
      disposition: "digested", dispositionDetail: { digestId: "turn-7", standingOrder: { id: "events.digest_batch", version: 1 } },
    });
    // 已经有处置的不改。
    expect(markEventsDigested(db, [first.seq, merged.seq], { digestId: "turn-8" })).toBe(0);
    expect(getEvent(db, merged.seq)?.disposition).toBe("superseded");
    expect(dueDigestBatch(db, new Date(), { userReturned: true })).toMatchObject({ due: false, events: [] });
  });
});

// 事件写入后的进程内通知（Lead 事件主干 spec D6，工单 04）：事务提交以后才通知，回滚掉的不通知；
// 别的连接写的事件靠 flushCommittedEvents 发现。游标存在 kv 里，读不懂的值当作没有。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, appendEvent, flushCommittedEvents, LEAD_EVENT_CURSOR_KEY, loadLeadEventCursor, openDb, saveLeadEventCursor,
  subscribeCommittedEvents, type EventRecord,
} from "../src/index.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("committed event notifications", () => {
  it("tells the subscriber after the transaction commits, never in the middle of it", async () => {
    const db = openDb(join(tempDir("plc-event-notify-"), "plc.db"));
    const seen: EventRecord[][] = [];
    let inTransactionWhenCalled = false;
    const stop = subscribeCommittedEvents(db, (events) => {
      inTransactionWhenCalled ||= db.inTransaction;
      seen.push(events);
    });
    db.transaction(() => {
      addInbox(db, { dedupScope: "scope:a", severity: "blocker", source: "structural", summary: "第一条", lossless: true });
      addInbox(db, { dedupScope: "scope:b", severity: "blocker", source: "structural", summary: "第二条", lossless: true });
      expect(seen).toEqual([]);
    })();
    await tick();
    expect(inTransactionWhenCalled).toBe(false);
    expect(seen.flat().map((event) => event.payload.summary)).toEqual(["第一条", "第二条"]);
    stop();
    db.close();
  });

  it("does not report events whose transaction rolled back", async () => {
    const db = openDb(join(tempDir("plc-event-notify-"), "plc.db"));
    const seen: EventRecord[] = [];
    subscribeCommittedEvents(db, (events) => seen.push(...events));
    expect(() => db.transaction(() => {
      appendEvent(db, { source: "system", kind: "inbox.attention", entityKey: "scope:x", payload: {
        inboxId: 1, itemId: null, scope: "scope:x", severity: "attention", inboxSource: "structural", summary: "回滚掉的",
        wakeLead: false, needsUser: false, delivery: "row", payload: {},
      } });
      throw new Error("roll back");
    })()).toThrow("roll back");
    addInbox(db, { dedupScope: "scope:y", severity: "attention", source: "structural", summary: "提交了的", lossless: true });
    await tick();
    expect(seen.map((event) => event.payload.summary)).toEqual(["提交了的"]);
    db.close();
  });

  it("finds events another connection wrote when asked to flush", () => {
    const path = join(tempDir("plc-event-notify-"), "plc.db");
    const db = openDb(path);
    const other = openDb(path);
    const seen: EventRecord[] = [];
    subscribeCommittedEvents(db, (events) => seen.push(...events));
    addInbox(other, { dedupScope: "scope:z", severity: "blocker", source: "structural", summary: "别的进程写的", lossless: true });
    expect(seen).toEqual([]);
    expect(flushCommittedEvents(db)).toBe(1);
    expect(seen.map((event) => event.payload.summary)).toEqual(["别的进程写的"]);
    expect(flushCommittedEvents(db)).toBe(0);
    other.close();
    db.close();
  });
});

describe("Lead's event cursor", () => {
  it("round-trips through kv, keeps only settled sequence numbers after the cursor, and ignores a value it cannot read", () => {
    const db = openDb(join(tempDir("plc-lead-cursor-"), "plc.db"));
    expect(loadLeadEventCursor(db)).toBeNull();
    saveLeadEventCursor(db, { seq: 5, settled: [9, 3, 7, 7] });
    expect(loadLeadEventCursor(db)).toEqual({ seq: 5, settled: [7, 9], ranges: [] });
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run("{oops", LEAD_EVENT_CURSOR_KEY);
    expect(loadLeadEventCursor(db)).toBeNull();
    db.close();
  });

  // 工单 14：收紧以后的区间。只留游标后面的部分，重叠和相接的并成一段，区间里的单个序号不再另记。
  it("keeps the folded ranges after the cursor, merged, and drops single numbers they cover", () => {
    const db = openDb(join(tempDir("plc-lead-cursor-"), "plc.db"));
    saveLeadEventCursor(db, { seq: 10, settled: [12, 30, 41], ranges: [[25, 31], [3, 11], [32, 40], [50, 50]] });
    expect(loadLeadEventCursor(db)).toEqual({ seq: 10, settled: [12, 41], ranges: [[11, 11], [25, 40], [50, 50]] });
    // 工单 14 以前存的值没有 ranges：读出来是空的。
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(JSON.stringify({ seq: 5, settled: [6] }), LEAD_EVENT_CURSOR_KEY);
    expect(loadLeadEventCursor(db)).toEqual({ seq: 5, settled: [6], ranges: [] });
    // 区间不合格（起点比终点大）：整个值读不懂。
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(JSON.stringify({ seq: 5, settled: [], ranges: [[9, 7]] }), LEAD_EVENT_CURSOR_KEY);
    expect(loadLeadEventCursor(db)).toBeNull();
    db.close();
  });
});

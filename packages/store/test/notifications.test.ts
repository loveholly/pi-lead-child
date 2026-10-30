import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { createCronTrigger, recordTriggerFailure, getTrigger } from "../src/triggers.js";
import {
  addNotification, listNotifications, getNotification, markNotificationDelivered,
  notificationsNeedingFallback, ackNotification,
} from "../src/notifications.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

describe("notifications", () => {
  it("never merges two notifications on the same item", () => {
    addNotification(db, { itemId, kind: "reminder", urgency: "immediate", title: "一" });
    addNotification(db, { itemId, kind: "reminder", urgency: "immediate", title: "二" });
    expect(listNotifications(db, { state: ["pending"] })).toHaveLength(2);
  });

  it("marks delivered with the channel that delivered it", () => {
    const id = addNotification(db, { kind: "crash", urgency: "immediate", title: "boom" });
    markNotificationDelivered(db, id, "lead", new Date("2026-07-27T00:00:00.000Z"));
    const n = getNotification(db, id)!;
    expect(n.state).toBe("delivered");
    expect(n.delivered_via).toBe("lead");
    expect(n.delivered_at).toBe("2026-07-27T00:00:00.000Z");
  });

  it("surfaces immediate notifications past the fallback window", () => {
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "a",
                          createdAt: "2026-07-27T00:00:00.000Z" });
    addNotification(db, { kind: "budget", urgency: "batchable", title: "b",
                          createdAt: "2026-07-27T00:00:00.000Z" });
    const overdue = notificationsNeedingFallback(db,
      new Date("2026-07-27T00:05:00.000Z"), 120_000);
    expect(overdue.map((n) => n.title)).toEqual(["a"]);  // batchable 不走兜底
  });

  it("leaves an immediate notification alone inside the window", () => {
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "a",
                          createdAt: "2026-07-27T00:00:00.000Z" });
    expect(notificationsNeedingFallback(
      db, new Date("2026-07-27T00:01:00.000Z"), 120_000)).toHaveLength(0);
  });

  it("stops surfacing a notification the lead already delivered", () => {
    const id = addNotification(db, { kind: "reminder", urgency: "immediate", title: "a",
                                     createdAt: "2026-07-27T00:00:00.000Z" });
    markNotificationDelivered(db, id, "lead", new Date("2026-07-27T00:01:00.000Z"));
    expect(notificationsNeedingFallback(
      db, new Date("2026-07-27T00:05:00.000Z"), 120_000)).toHaveLength(0);
  });

  it("acks", () => {
    const id = addNotification(db, { kind: "reminder", urgency: "immediate", title: "a" });
    ackNotification(db, id);
    expect(getNotification(db, id)!.state).toBe("acked");
  });

  // 工单 03：Lead 的 read_notifications 按时间从新到旧读，可以只看某个时刻以后的。旧库的 created_at 是
  // 'YYYY-MM-DD HH:MM:SS'，和 ISO 混在一列里，所以按时间比较，不按字符串比较。
  it("lists newest first and since a moment, across both created_at formats", () => {
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "旧库的行", createdAt: "2026-10-16 23:00:00" });
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "早", createdAt: "2026-10-16T08:00:00.000Z" });
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "晚", createdAt: "2026-10-17T08:00:00.000Z" });
    expect(listNotifications(db, { newestFirst: true }).map((n) => n.title)).toEqual(["晚", "旧库的行", "早"]);
    expect(listNotifications(db, { since: "2026-10-16T22:00:00.000Z", newestFirst: true }).map((n) => n.title))
      .toEqual(["晚", "旧库的行"]);
    expect(listNotifications(db, { newestFirst: true, limit: 1 }).map((n) => n.title)).toEqual(["晚"]);
    expect(listNotifications(db).map((n) => n.title)).toEqual(["旧库的行", "早", "晚"]);
  });

  it("filters by item", () => {
    const other = createItem(db, { title: "o", brief: "b", createdBy: "user" });
    addNotification(db, { itemId, kind: "reminder", urgency: "immediate", title: "a" });
    addNotification(db, { itemId: other, kind: "reminder", urgency: "immediate", title: "b" });
    expect(listNotifications(db, { itemId }).map((n) => n.title)).toEqual(["a"]);
  });
});

describe("trigger auto-disable notifies the user", () => {
  it("writes a batchable notification when the failure streak trips the fuse", () => {
    const id = createCronTrigger(db, {
      label: "bad", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "task", title: "x", brief: "b" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    for (let i = 0; i < 5; i++) recordTriggerFailure(db, id, "boom");
    expect(getTrigger(db, id)!.enabled).toBe(0);
    const rows = listNotifications(db, { state: ["pending"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].urgency).toBe("batchable");
    expect(rows[0].kind).toBe("trigger_disabled");
  });
});

// Lead 是常驻的助理（2026-10-15 用户决定，Jarvis 模式）：委派出去的事都先让 Lead 知道，由 Lead 决定怎样告诉用户。
//   · Lead 可以给自己设跟进：到点前不叫醒它，到点再叫醒。
//   · Lead 的每个处置都落账：它说了怎么处理的就记它的话；它没说，一轮成功以后系统记「看过了」。
//   · Lead 不能工作时，系统把积压的事一次性升级给用户。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { listActivities } from "../src/activities.js";
import {
  addInbox, addLeadFollowUp, escalateLeadBacklog, inboxDue, listInbox, listLeadBacklog, markInbox,
  recordInboxDisposition, recordSeenDispositions,
} from "../src/inbox.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-events-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

const payload = (id: number) => JSON.parse(listInbox(db, {}).find((row) => row.id === id)!.payload);

describe("a follow-up Lead sets for itself", () => {
  it("is not due before its time, then wakes Lead", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    const id = addLeadFollowUp(db, { at: new Date("2026-10-15T08:30:00.000Z"), note: "看 #66 的核查恢复了没有", itemId });
    const row = listInbox(db, {}).find((candidate) => candidate.id === id)!;
    expect(row.summary).toBe("跟进：看 #66 的核查恢复了没有");
    expect(payload(id)).toMatchObject({ kind: "lead_followup", wakeLead: true, notBefore: "2026-10-15T08:30:00.000Z" });
    expect(inboxDue(row, now)).toBe(false);
    expect(inboxDue(row, new Date("2026-10-15T08:30:00.000Z"))).toBe(true);
    expect(listLeadBacklog(db, now)).toEqual([]);
  });
});

describe("Lead's disposition of an event", () => {
  it("keeps Lead's own words, and records 'seen' for the rest after a successful turn", () => {
    const told = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false }, lossless: true }).id!;
    const quiet = addInbox(db, { dedupScope: "x", severity: "attention", source: "structural", summary: "目录有变化", lossless: true }).id!;
    recordInboxDisposition(db, [told], { disposition: "told_user", reason: "交接通道坏了，已经告诉用户" });
    markInbox(db, [told, quiet], "consumed");
    recordSeenDispositions(db, [told, quiet]);

    expect(payload(told).disposition).toMatchObject({ kind: "told_user", reason: "交接通道坏了，已经告诉用户" });
    expect(payload(quiet).disposition).toMatchObject({ kind: "seen" });
    expect(listActivities(db, itemId).map((row) => JSON.parse(row.payload)))
      .toContainEqual(expect.objectContaining({ decision: "lead_disposition", disposition: "told_user", inboxId: told }));
  });
});

describe("the backlog when Lead cannot work", () => {
  it("lists what Lead has not finished, and escalates each event once", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    const first = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败", payload: { needsUser: false }, lossless: true }).id!;
    const second = addInbox(db, { dedupScope: "runtime-incident:1", severity: "attention", source: "structural", summary: "Codex 不支持该模型", payload: { wakeLead: true, needsUser: false }, lossless: true }).id!;
    addInbox(db, { dedupScope: "y", severity: "attention", source: "structural", summary: "不叫醒的说明", lossless: true });
    addLeadFollowUp(db, { at: new Date("2026-10-15T09:00:00.000Z"), note: "以后再看" });
    expect(listLeadBacklog(db, now).map((row) => row.id)).toEqual([first, second]);

    expect(escalateLeadBacklog(db, [first, second], { reason: "Lead 的模型调用失败", at: now })).toEqual([first, second]);
    expect(escalateLeadBacklog(db, [first, second], { reason: "again", at: now })).toEqual([]);
    expect(payload(first)).toMatchObject({ needsUser: true, escalationReason: "Lead 的模型调用失败" });
    expect(listLeadBacklog(db, now)).toEqual([]);
  });
});

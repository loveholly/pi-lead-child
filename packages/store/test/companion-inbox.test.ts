// 收件箱的两件服务端事实：你上次看收件箱是什么时候，和 Lead 自己处理掉的事（Jarvis 模式的 record_disposition）。
// 「Lead 已处理」按一次处置合成一条：#66 的核查失败了 9 次，Lead 一次处理掉，收件箱里就是一条，不是 9 条。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { addInbox, listInbox, recordInboxDisposition, recordSeenDispositions } from "../src/inbox.js";
import { inboxSeenAt, latestBlockedReason, listLeadHandled, markInboxSeen } from "../src/companion-inbox.js";
import { insertCheckpoint } from "../src/checkpoints.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-companion-inbox-"), "plc.db"));
  itemId = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "user" });
});

function event(summary: string): number {
  return addInbox(db, { itemId, severity: "blocker", source: "structural", summary, lossless: true }).id!;
}

describe("when you last looked at the inbox", () => {
  it("is unknown until the companion records it, then the latest time", () => {
    expect(inboxSeenAt(db)).toBeNull();
    markInboxSeen(db, new Date("2026-10-15T08:00:00.000Z"));
    markInboxSeen(db, new Date("2026-10-15T09:12:00.000Z"));
    expect(inboxSeenAt(db)).toBe("2026-10-15T09:12:00.000Z");
  });
});

describe("what Lead handled by itself", () => {
  it("merges the events of one disposition into one entry, with the problem, cause, action and follow-up", () => {
    const first = event("工单 #66 阻塞：Codex 不支持该模型");
    const second = event("工单 #66 阻塞：Codex 不支持该模型");
    recordInboxDisposition(db, [first, second], {
      disposition: "handled",
      reason: "核查改用 Claude Code 重派",
      cause: "Codex（ChatGPT 账号）不支持 gpt-5.5",
      action: "用 Claude Code 重派核查 Run #85",
      followUp: "模型目录改为自动发现，发布后不会再出现",
      at: new Date("2026-10-15T07:34:00.000Z"),
    });

    expect(listLeadHandled(db, { since: "2026-10-15T00:00:00.000Z" })).toEqual([{
      eventIds: [first, second],
      itemId,
      problem: "工单 #66 阻塞：Codex 不支持该模型",
      reason: "核查改用 Claude Code 重派",
      cause: "Codex（ChatGPT 账号）不支持 gpt-5.5",
      action: "用 Claude Code 重派核查 Run #85",
      followUp: "模型目录改为自动发现，发布后不会再出现",
      handledAt: "2026-10-15T07:34:00.000Z",
    }]);
  });

  it("leaves out what Lead told you, deferred, only looked at, and what it handled before the window", () => {
    const told = event("交接失败");
    const seen = event("目录有变化");
    const old = event("旧的事");
    recordInboxDisposition(db, [told], { disposition: "told_user", reason: "已经告诉用户", at: new Date("2026-10-15T07:00:00.000Z") });
    recordSeenDispositions(db, [seen], new Date("2026-10-15T07:00:00.000Z"));
    recordInboxDisposition(db, [old], { disposition: "handled", reason: "重试成功", at: new Date("2026-10-01T07:00:00.000Z") });

    expect(listLeadHandled(db, { since: "2026-10-15T00:00:00.000Z" })).toEqual([]);
  });

  it("keeps the reason as the action when Lead wrote only a reason", () => {
    const only = event("Run #64 崩溃：等网络超时");
    recordInboxDisposition(db, [only], { disposition: "handled", reason: "网络恢复后重派 Run #86", at: new Date("2026-10-15T07:43:00.000Z") });
    expect(listLeadHandled(db, { since: "2026-10-15T00:00:00.000Z" })[0]).toMatchObject({
      reason: "网络恢复后重派 Run #86", cause: null, action: null, followUp: null,
    });
    expect(JSON.parse(listInbox(db, {}).find((row) => row.id === only)!.payload).disposition).not.toHaveProperty("cause");
  });
});

describe("why a blocked ticket waits for you", () => {
  it("says it with the latest blocked record, without the stack trace", () => {
    insertCheckpoint(db, {
      itemId, runId: null, source: "system_derived", kind: "blocked", title: "Run crashed", summary: "旧的原因",
      nextStep: "检查本次运行结果", idempotencyKey: "blocked:1",
    }, { now: new Date("2026-08-21T08:00:00.000Z") });
    insertCheckpoint(db, {
      itemId, runId: null, source: "system_derived", kind: "blocked", title: "Agent Run 未捕获异常",
      summary: "Run #54 交付的成果格式不合法：outcome.validations[3].outcome is invalid\n    at <anonymous> (/Users/alice/x.ts:1:1)",
      nextStep: "修好成果格式后重跑", idempotencyKey: "blocked:2",
    }, { now: new Date("2026-08-25T08:01:12.000Z") });

    expect(latestBlockedReason(db, itemId)).toBe("Run #54 交付的成果格式不合法：outcome.validations[3].outcome is invalid");
  });

  it("has no reason when nothing was recorded", () => {
    expect(latestBlockedReason(db, itemId)).toBeNull();
  });
});

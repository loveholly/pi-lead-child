// 常设指令（工单 05）在 engine 这一侧：瞬时失败重试和提醒到点从常设指令读参数，行为不变；spec 场景 3。
//   - 对照：搬之前的 transientRetryConfig 原样抄在下面，同样的环境变量得到同样的配置；提醒到点的通知和搬之前一样。
//   - 指令是数据：改一个版本，重试的等待时间、提醒的标题跟着变。
//   - 场景 3：两张工单因同一个根因失败。合成一条，按常设指令自动处理（排上退避重试），进摘要。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { StandingOrderDefinition } from "@pi-lead-child/protocol";
import { typedFailure, type RuntimeProfileIdentity } from "@pi-lead-child/runtime";
import {
  createItem, createRun, dueDigestBatch, listActivities, listEvents, listInbox, listNotifications, listUndisposedEvents,
  markEventsDigested, openDb, recordStandingOrderVersion, SYSTEM_STANDING_ORDERS, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import {
  applyTransientRetry, standingTransientRetryConfig, transientRetryConfig, transientRetryDelayMs,
} from "../src/pipeline/transient-retry.js";
import { createScheduler } from "../src/pipeline/scheduler.js";

const MINUTE = 60_000;

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-standing-rules-"), "plc.db"));
});

const seed = (id: string): StandingOrderDefinition => SYSTEM_STANDING_ORDERS.find((order) => order.id === id)!;

// 搬之前的实现（提交 8b138b0 的 packages/engine/src/pipeline/transient-retry.ts），原样保留在这里做对照。
function legacyTransientRetryConfig(env: Record<string, string | undefined>) {
  const DEFAULT_BASE_MS = 30_000;
  const DEFAULT_MAX_MS = 600_000;
  const DEFAULT_LIMIT = 5;
  const MAX_LIMIT = 20;
  const positiveMs = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const retryLimit = (value: string | undefined) => {
    if (value === undefined || value.trim() === "") return DEFAULT_LIMIT;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
  };
  return {
    baseMs: positiveMs(env.PLC_TRANSIENT_RETRY_BASE_MS, DEFAULT_BASE_MS),
    maxMs: positiveMs(env.PLC_TRANSIENT_RETRY_MAX_MS, DEFAULT_MAX_MS),
    limit: retryLimit(env.PLC_TRANSIENT_RETRY_LIMIT),
  };
}

describe("the transient retry, compared with before it moved", () => {
  it("gives the same configuration for every environment", () => {
    const values = [undefined, "", " ", "0", "1000", "-1", "2.5", "soon", "45000"];
    const limits = [undefined, "", " ", "0", "2", "2.5", "-1", "7", "1000"];
    for (const base of values) {
      for (const max of values) {
        for (const limit of limits) {
          const env = { PLC_TRANSIENT_RETRY_BASE_MS: base, PLC_TRANSIENT_RETRY_MAX_MS: max, PLC_TRANSIENT_RETRY_LIMIT: limit };
          const before = legacyTransientRetryConfig(env);
          expect(transientRetryConfig(env), JSON.stringify(env)).toEqual(before);
          expect(standingTransientRetryConfig(db, env), JSON.stringify(env))
            .toEqual({ ...before, order: { id: "run.transient_retry", version: 1 } });
        }
      }
    }
    const config = standingTransientRetryConfig(db, {});
    expect([1, 2, 3, 4, 5, 6, 40].map((attempt) => transientRetryDelayMs(attempt, config)))
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it("reads a new version of the standing order; the environment still wins, and 20 retries stay the ceiling", () => {
    recordStandingOrderVersion(db, {
      ...seed("run.transient_retry"),
      action: { type: "rule", rule: "run.transient_retry", params: { baseMs: 5_000, maxMs: 40_000 }, level: "digest" },
      limits: { count: 50 },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    expect(standingTransientRetryConfig(db, {})).toEqual({
      baseMs: 5_000, maxMs: 40_000, limit: 20, order: { id: "run.transient_retry", version: 2 },
    });
    expect(standingTransientRetryConfig(db, { PLC_TRANSIENT_RETRY_BASE_MS: "1000", PLC_TRANSIENT_RETRY_LIMIT: "3" }))
      .toEqual({ baseMs: 1_000, maxMs: 40_000, limit: 3, order: { id: "run.transient_retry", version: 2 } });
  });
});

describe("a reminder firing, compared with before it moved", () => {
  const remind = (title: string) => createItem(db, {
    kind: "reminder", title, brief: "带上身份证", createdBy: "user", remindAt: new Date(Date.now() - 1_000).toISOString(),
  });

  it("writes the same immediate notification as before, told to Lead on the reminder's standing order", () => {
    const id = remind("交房租");
    createScheduler(db, {}).tick();
    // 搬之前：kind reminder，immediate，标题「提醒：」加提醒的标题，正文是提醒的 body（这里是空的）。
    expect(listNotifications(db)).toEqual([expect.objectContaining({
      item_id: id, kind: "reminder", urgency: "immediate", title: "提醒：交房租", body: "", state: "pending",
    })]);
    expect(listEvents(db, { kind: "notification.created" })[0]).toMatchObject({
      level: "tell", triage: { order: { id: "reminder.fire", version: 1 } },
    });
  });

  it("takes the title prefix from a new version of the standing order", () => {
    recordStandingOrderVersion(db, {
      ...seed("reminder.fire"),
      action: { type: "rule", rule: "reminder.fire", params: { notificationKind: "reminder", urgency: "immediate", titlePrefix: "到点了：" }, level: "tell" },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    remind("交房租");
    createScheduler(db, {}).tick();
    expect(listNotifications(db).map((notification) => notification.title)).toEqual(["到点了：交房租"]);
    expect(listEvents(db, { kind: "notification.created" })[0]?.triage).toEqual({ order: { id: "reminder.fire", version: 2 } });
  });
});

// spec 场景 3：两张工单因同一个根因失败（模型服务断网）：合成一条，按常设指令自动处理，进摘要。
describe("scenario 3: two tickets fail on the same root cause", () => {
  const profile: RuntimeProfileIdentity = { runtime: "codex", executable: "codex", configDir: null };

  function failOnNetwork(title: string, at: Date): { itemId: number; runId: number } {
    const itemId = createItem(db, { title, brief: "b", createdBy: "user", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const failure = typedFailure("network_error", { errorCode: "network_error", message: "ECONNRESET: socket hang up" });
    db.transaction(() => {
      updateRun(db, runId, {
        state: "failed", endedAt: true, exitCode: 1, errorCode: "network_error", errorMessage: "ECONNRESET: socket hang up", failure,
      });
      applyTransientRetry(db, { runId, failure, at, resume: false, profile });
    })();
    return { itemId, runId };
  }

  it("retries both automatically, tells Lead once in the digest, and leaves nothing undisposed", () => {
    const at = new Date();
    const a = failOnNetwork("迁移 A", at);
    const b = failOnNetwork("迁移 B", at);

    // 按常设指令自动处理：两张工单各排上一次退避重试，依据记在活动里。工单不进 blocked。
    for (const ticket of [a, b]) {
      expect(listActivities(db, ticket.itemId).map((activity) => JSON.parse(activity.payload))
        .filter((payload) => payload.decision === "transient_retry_scheduled")).toEqual([expect.objectContaining({
        decision: "transient_retry_scheduled", attempt: 1, limit: 5, code: "network_error",
        notBefore: new Date(at.getTime() + 30_000).toISOString(), standingOrder: { id: "run.transient_retry", version: 1 },
      })]);
    }
    expect(listInbox(db).map((row) => [row.item_id, JSON.parse(row.payload).kind])).toEqual([
      [a.itemId, "transient_retry"], [b.itemId, "transient_retry"],
    ]);

    // 合成一条：第二张工单的说明并进第一张的，Lead 说一次。
    const notices = listEvents(db, { kind: "inbox.attention" });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      level: "digest", disposition: null, rootCause: { code: "network_error" },
      triage: { order: { id: "run.transient_retry", version: 1 } },
    });
    expect(notices[1]).toMatchObject({
      level: "digest", disposition: "superseded",
      dispositionDetail: { reason: "merged_root_cause", mergedInto: notices[0]!.seq, standingOrder: { id: "events.merge_root_cause", version: 1 } },
    });
    // Run 的失败只记录，不单独告诉 Lead。
    expect(listEvents(db, { kind: "run.failed" }).map((event) => [event.level, event.rootCause?.scope])).toEqual([
      ["record", "attempt"], ["record", "attempt"],
    ]);

    // 进摘要：25 分钟后这一批该交给 Lead，里面一条，带着并进来的那一条。
    const batch = dueDigestBatch(db, new Date(Date.parse(notices[0]!.receivedAt) + 25 * MINUTE));
    expect(batch).toMatchObject({ due: true, reason: "max_wait" });
    expect(batch.entries.map((entry) => [entry.events.map((event) => event.seq), entry.merged.map((event) => event.seq)]))
      .toEqual([[[notices[0]!.seq], [notices[1]!.seq]]]);
    markEventsDigested(db, batch.events.map((event) => event.seq), { digestId: "digest-1" });
    expect(listUndisposedEvents(db, { olderThan: new Date(Date.now() + 60 * MINUTE) })).toEqual([]);
  });
});

// 后台检查的存储和「检查完以后怎样」（.scratch/lead-watch/spec.md）。
// 2026-10-28：用户要每 20 分钟刷新一次 clime 登录，Lead 只能把 launchd 配置交给用户；设备码登录成功了也没有东西告诉 Lead。
// 迁移（v59）三条路径：新库、老库（v58）升级、重新打开。只加表，不动已有的表和行。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  abandonWatchCheck, agentWatchTokensSince, attachWatchCheckItem, cancelWatch, createItem, createWatch, decideAfterCheck, dueWatches,
  finishWatchCheck, getItem, getWatch, LATEST_SCHEMA_VERSION, listWatchChecks, openDb, runningWatchChecks, SCHEMA_MIGRATION_VERSIONS,
  startWatchCheck, transition, watchCheckOfItem, WatchInputError, WATCH_LIMITS, type Db, type Watch,
} from "../src/index.js";

const T0 = new Date("2026-10-28T06:28:38.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const fresh = () => openDb(join(tempDir("plc-watch-"), "plc.db"));
const system = { kind: "system" } as const;

function deviceLogin(db: Db, overrides: Partial<Parameters<typeof createWatch>[1]> = {}): number {
  return createWatch(db, {
    label: "clime 登录", check: { kind: "command", command: "clime auth whoami" }, mode: "until", everySeconds: 10,
    untilAt: at(600).toISOString(), note: "告诉用户登录好了", origin: system, ...overrides,
  }, T0);
}

function check(db: Db, id: number, status: "pass" | "fail" | "error", seconds: number, output = "") {
  const checkId = startWatchCheck(db, id, at(seconds));
  if (checkId === null) throw new Error("not claimed");
  return finishWatchCheck(db, { checkId, status, output, exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null, now: at(seconds) })!;
}

describe("the v59 watches migration", () => {
  it("creates the tables in a new database", () => {
    const db = fresh();
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 59").get()).toEqual({ name: "watches-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(59);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(59);
    expect([...SCHEMA_MIGRATION_VERSIONS]).toEqual([...SCHEMA_MIGRATION_VERSIONS].sort((a, b) => a - b));
    expect(getWatch(db, deviceLogin(db))).toMatchObject({ state: "waiting", next_check_at: T0.toISOString() });
    db.close();
  });

  it("upgrades a v58 database without touching items or triggers, then reopens", () => {
    const path = join(tempDir("plc-v59-legacy-"), "plc.db");
    const legacy = openDb(path);
    const task = createItem(legacy, { title: "t", brief: "b", createdBy: "lead" });
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    legacy.exec("DROP TABLE watch_checks; DROP TABLE watches;");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 59").run();
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      triggers: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'triggers'").get(),
      migrations: db.prepare("SELECT version, name FROM schema_migrations WHERE version <> 59 ORDER BY version").all(),
    });
    const before = snapshot(legacy);
    legacy.close();

    const migrated = openDb(path);
    expect(snapshot(migrated)).toEqual(before);
    expect(getItem(migrated, task)?.stage).toBe("ready");
    expect(getItem(migrated, done)).toMatchObject({ stage: "done", closed_at: expect.any(String) });
    // 规则的 C5 不变：Lead 建的规则仍然只建单。
    expect((before.triggers as { sql: string }).sql).toContain("CHECK (action_type = 'create_item' OR created_by = 'user')");
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 59").get()).toEqual({ version: 59 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    deviceLogin(migrated);
    migrated.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 59").get()).toEqual({ n: 1 });
    expect(snapshot(reopened)).toEqual(before);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

describe("createWatch", () => {
  it("rejects what breaks the floors", () => {
    const db = fresh();
    const bad = (overrides: Partial<Parameters<typeof createWatch>[1]>) => () => deviceLogin(db, overrides);
    expect(bad({ everySeconds: 5 })).toThrow(WatchInputError);
    expect(bad({ untilAt: at(-1).toISOString() })).toThrow(/已经过去/);
    expect(bad({ untilAt: at(8 * 24 * 3600).toISOString() })).toThrow(/7 天/);
    expect(bad({ check: { kind: "agent", brief: "看 CI" }, untilAt: at(25 * 3600).toISOString() })).toThrow(/24 小时/);
    expect(bad({ mode: "repeat", untilAt: undefined, everySeconds: 1200, cron: "*/20 * * * *" })).toThrow(/只写一个/);
    expect(bad({ mode: "repeat", untilAt: undefined, everySeconds: undefined, cron: "nope" })).toThrow(/cron 不对/);
    // 子代理检查每次都开一个子 agent：repeat 两次之间最少 30 分钟。
    expect(bad({ check: { kind: "agent", brief: "看 CI" }, mode: "repeat", untilAt: undefined, everySeconds: 600 })).toThrow(/30 分钟|1800/);
    expect(bad({ check: { kind: "agent", brief: "看 CI" }, mode: "repeat", untilAt: undefined, everySeconds: undefined, cron: "*/20 * * * *" })).toThrow(/30 分钟/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 0 });
    db.close();
  });

  it("caps how many watches can wait at once", () => {
    const db = fresh();
    deviceLogin(db, { maxActive: 2 });
    deviceLogin(db, { maxActive: 2 });
    expect(() => deviceLogin(db, { maxActive: 2 })).toThrow(/已经有 2 个/);
    db.close();
  });

  it("checks a repeat-by-interval watch at once and a cron watch at the next occurrence", () => {
    const db = fresh();
    const every = deviceLogin(db, { mode: "repeat", untilAt: undefined, everySeconds: 1200, label: "刷新登录" });
    const cron = deviceLogin(db, { mode: "repeat", untilAt: undefined, everySeconds: undefined, cron: "*/20 * * * *", tz: "UTC" });
    expect(getWatch(db, every)?.next_check_at).toBe(T0.toISOString());
    expect(getWatch(db, cron)?.next_check_at).toBe("2026-10-28T06:40:00.000Z");
    expect(dueWatches(db, T0).map((watch) => watch.id)).toEqual([every]);
    db.close();
  });
});

// 决策边界（spec D3）：叫不叫醒 Lead、检查结束没有、下一次什么时候。
describe("decideAfterCheck", () => {
  const until = {
    check_kind: "command", mode: "until", every_seconds: 10, cron_expr: null, cron_tz: null,
    until_at: at(600).toISOString(), last_status: null, consecutive_errors: 0,
  } as const satisfies Partial<Watch>;
  const repeat = { ...until, mode: "repeat", until_at: null, every_seconds: 1200 } as const;

  it("until: wakes Lead once when the check passes, keeps quiet while it fails", () => {
    expect(decideAfterCheck(until, "fail", at(0))).toEqual({ wake: null, end: null, nextCheckAt: at(10).toISOString(), consecutiveErrors: 0 });
    expect(decideAfterCheck(until, "pass", at(50))).toEqual({ wake: "passed", end: "passed", nextCheckAt: null, consecutiveErrors: 0 });
  });

  it("until: the last check lands on the deadline, then it expires", () => {
    expect(decideAfterCheck(until, "fail", at(595)).nextCheckAt).toBe(at(600).toISOString());
    expect(decideAfterCheck(until, "fail", at(600))).toMatchObject({ wake: "expired", end: "expired" });
  });

  it("until: stops after three errors in a row", () => {
    expect(decideAfterCheck({ ...until, consecutive_errors: 1 }, "error", at(20))).toMatchObject({ wake: null, consecutiveErrors: 2 });
    expect(decideAfterCheck({ ...until, consecutive_errors: 2 }, "error", at(30))).toMatchObject({ wake: "errors", end: "errors", consecutiveErrors: 3 });
    expect(decideAfterCheck({ ...until, consecutive_errors: 2 }, "fail", at(30))).toMatchObject({ wake: null, consecutiveErrors: 0 });
  });

  it("repeat: wakes Lead only when the state changes", () => {
    expect(decideAfterCheck(repeat, "pass", at(0))).toMatchObject({ wake: null, end: null, nextCheckAt: at(1200).toISOString() });
    expect(decideAfterCheck(repeat, "fail", at(0)).wake).toBe("failed");
    expect(decideAfterCheck({ ...repeat, last_status: "pass" }, "pass", at(0)).wake).toBeNull();
    expect(decideAfterCheck({ ...repeat, last_status: "pass" }, "fail", at(0)).wake).toBe("failed");
    expect(decideAfterCheck({ ...repeat, last_status: "pass" }, "error", at(0)).wake).toBe("failed");
    expect(decideAfterCheck({ ...repeat, last_status: "fail" }, "fail", at(0)).wake).toBeNull();
    expect(decideAfterCheck({ ...repeat, last_status: "error" }, "fail", at(0)).wake).toBeNull();
    expect(decideAfterCheck({ ...repeat, last_status: "fail" }, "pass", at(0)).wake).toBe("recovered");
    expect(decideAfterCheck({ ...repeat, consecutive_errors: 9 }, "error", at(0)).end).toBeNull();
  });

  it("repeat by cron: the next check is the next occurrence", () => {
    expect(decideAfterCheck({ ...repeat, every_seconds: null, cron_expr: "*/20 * * * *", cron_tz: "UTC" }, "pass", at(0)).nextCheckAt)
      .toBe("2026-10-28T06:40:00.000Z");
  });

  it("agent checks: the Run-finished note wakes Lead, so the check itself does not; a check that could not start does", () => {
    const agentUntil = { ...until, check_kind: "agent" } as const;
    expect(decideAfterCheck(agentUntil, "pass", at(0))).toMatchObject({ wake: null, end: "agent_done" });
    expect(decideAfterCheck(agentUntil, "error", at(0), { agentFailed: true })).toMatchObject({ wake: "agent_failed", end: "errors" });
    const agentRepeat = { ...repeat, check_kind: "agent", every_seconds: 3600 } as const;
    expect(decideAfterCheck(agentRepeat, "pass", at(0))).toMatchObject({ wake: null, end: null });
    expect(decideAfterCheck(agentRepeat, "error", at(0), { agentFailed: true }).wake).toBe("agent_failed");
    expect(decideAfterCheck({ ...agentRepeat, last_status: "error" }, "error", at(0), { agentFailed: true }).wake).toBeNull();
  });
});

describe("running checks", () => {
  it("claims a check once, records the result and ends an until watch that passed", () => {
    const db = fresh();
    const id = deviceLogin(db);
    const first = startWatchCheck(db, id, at(0))!;
    expect(startWatchCheck(db, id, at(0))).toBeNull();
    expect(dueWatches(db, at(0))).toEqual([]);
    finishWatchCheck(db, { checkId: first, status: "fail", exitCode: 1, output: "token refresh failed", now: at(0) });
    expect(finishWatchCheck(db, { checkId: first, status: "pass", now: at(1) })).toBeNull();
    expect(getWatch(db, id)).toMatchObject({ state: "waiting", running_since: null, last_status: "fail", next_check_at: at(10).toISOString(), check_count: 1 });
    const passed = check(db, id, "pass", 50, "alice@example.com");
    expect(passed.decision.wake).toBe("passed");
    expect(passed.watch).toMatchObject({ state: "done", ended_reason: "passed", next_check_at: null, last_output: "alice@example.com" });
    expect(passed.check).toMatchObject({ status: "pass", exit_code: 0, woke: "passed" });
    db.close();
  });

  it("keeps only the tail of long output and the last 50 checks", () => {
    const db = fresh();
    const id = deviceLogin(db, { mode: "repeat", untilAt: undefined, everySeconds: 10 });
    const long = `${"x".repeat(5_000)}END`;
    for (let index = 0; index < 55; index += 1) check(db, id, "pass", index * 10, long);
    const checks = listWatchChecks(db, id, 100);
    expect(checks).toHaveLength(WATCH_LIMITS.keepChecks);
    expect([...checks[0]!.output!]).toHaveLength(WATCH_LIMITS.outputChars + 1);
    expect(checks[0]!.output!.endsWith("END")).toBe(true);
    db.close();
  });

  it("a cancelled watch records the running check without waking Lead or scheduling another", () => {
    const db = fresh();
    const id = deviceLogin(db);
    const checkId = startWatchCheck(db, id, at(0))!;
    expect(cancelWatch(db, id, { reason: "用户说不用了", at: at(1) })).toBe(true);
    expect(cancelWatch(db, id, { reason: "again" })).toBe(false);
    const finished = finishWatchCheck(db, { checkId, status: "pass", exitCode: 0, now: at(2) })!;
    expect(finished.decision.wake).toBeNull();
    expect(finished.watch).toMatchObject({ state: "cancelled", next_check_at: null, running_since: null });
    expect(dueWatches(db, at(100))).toEqual([]);
    db.close();
  });

  it("a check cut off by a restart is retried at once and does not count as an error", () => {
    const db = fresh();
    const id = deviceLogin(db, { mode: "repeat", untilAt: undefined, everySeconds: 1200 });
    check(db, id, "pass", 0);
    const checkId = startWatchCheck(db, id, at(1200))!;
    expect(runningWatchChecks(db).map((running) => running.check.id)).toEqual([checkId]);
    expect(abandonWatchCheck(db, checkId, { reason: "daemon 重启", now: at(1300) })).toBe(true);
    expect(getWatch(db, id)).toMatchObject({ running_since: null, last_status: "pass", consecutive_errors: 0, next_check_at: at(1300).toISOString() });
    expect(runningWatchChecks(db)).toEqual([]);
    db.close();
  });

  it("links an agent check to its light ticket and sums its tokens", () => {
    const db = fresh();
    const id = deviceLogin(db, { check: { kind: "agent", brief: "看 PR 有没有人回复" } });
    const checkId = startWatchCheck(db, id, at(0))!;
    const itemId = createItem(db, { title: "后台检查", brief: "b", createdBy: "lead" });
    attachWatchCheckItem(db, checkId, itemId);
    db.prepare("UPDATE items SET total_tokens = 12345 WHERE id = ?").run(itemId);
    expect(watchCheckOfItem(db, itemId)).toMatchObject({ watch: { id }, check: { id: checkId, status: "running" } });
    expect(agentWatchTokensSince(db, at(-60))).toBe(12345);
    expect(agentWatchTokensSince(db, at(60))).toBe(0);
    db.close();
  });
});

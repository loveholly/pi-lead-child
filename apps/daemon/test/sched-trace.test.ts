// plc sched trace（lead-scheduler spec D12）：一个工作单元的调度记录分在三个地方（daemon 日志、Lead 的会话文件、events 表），
// 这里按时间合成一条时间线。只看这条时间线就要能说出这个单元停在哪里、为什么。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, recordSchedulerEvent, schedulerEventsOfUnit, schedulerUnitsOfTurn } from "@pi-lead-child/store";
import {
  formatSchedTrace, readTraceLogLines, readTraceSessionEntries, SCHED_TRACE_ID, schedTrace, unitsOf,
} from "../src/sched-trace.js";

const LOG = [
  "[2026-11-09T05:44:00.000Z] [sched] probe.summary loopMaxMs=3 poolMaxMs=2 jobs=none",
  "[2026-11-09T05:44:59.900Z] [sched] job.start id=9 kind=worktree-delete label=\"item-42\" pid=501 io=background",
  "[2026-11-09T05:45:00.000Z] [sched] unit.start unit=unit_aa1 lane=L0 turn=turn_42 source=user origin=- deadlineMs=10000",
  "[2026-11-09T05:45:00.050Z] user message received",
  "[2026-11-09T05:45:11.000Z] [sched] stage.slow stage=A unit=unit_aa1 run=1 step=2 turn=turn_42 waitedMs=10000 thresholdMs=10000 pool=\"waiting 9800ms\"",
  "[2026-11-09T05:47:30.000Z] [sched] decide unit=unit_aa1 lane=L0 turn=turn_42 decision=red_line_stop elapsedMs=150000 budgetMs=150000 waiting=L0:user:1:150s queued=L1:external:1:2s",
  "[2026-11-09T05:47:30.001Z] [sched] abort unit=unit_aa1 lane=L0 turn=turn_42 seg=1 reason=budget elapsedMs=150000",
  "[2026-11-09T05:47:30.020Z] [sched] unit.start unit=unit_bb2 lane=L3 turn=- source=system origin=system:digest deadlineMs=1800000",
  "[2026-11-09T05:50:00.000Z] [sched] probe.summary loopMaxMs=2 poolMaxMs=1 jobs=none",
];

describe("sched trace", () => {
  // 空闲车道（P4）的作业：按作业编号查，连同它开的那个单元（整理笔记那一轮）一起列出来。
  it("traces an idle-lane job with the unit it opened", () => {
    expect(SCHED_TRACE_ID.test("idle_precipitate_mw9asd3m01")).toBe(true);
    expect(SCHED_TRACE_ID.test("idle_x; rm -rf /")).toBe(false);
    const lines = [
      "[2026-11-09T06:00:00.000Z] [sched] idle.start job=precipitate id=idle_precipitate_k1 ratio=0.75 line=0.7 idleMs=15000 yields=0",
      "[2026-11-09T06:00:00.010Z] [sched] unit.start unit=unit_cc3 lane=L4 turn=- source=system origin=system:precipitate deadlineMs=-",
      "[2026-11-09T06:00:04.000Z] [sched] idle.yield job=precipitate id=idle_precipitate_k1 unit=unit_cc3 by=L0 what=user action=abort_at_yield_point runMs=3990",
      "[2026-11-09T06:00:04.001Z] [sched] decide unit=unit_cc3 lane=L4 turn=- decision=idle_yield by=L0 steps=0",
      "[2026-11-09T06:00:04.300Z] [sched] unit.end unit=unit_cc3 lane=L4 turn=- outcome=yielded ms=4290 steps=1 toolCalls=0 aborts=idle_yield:L0 redLine=-",
      "[2026-11-09T06:00:04.310Z] [sched] idle.yielded job=precipitate id=idle_precipitate_k1 unit=unit_cc3 outcome=yielded ms=4310 yields=1",
      "[2026-11-09T06:00:05.000Z] [sched] unit.start unit=unit_dd4 lane=L0 turn=turn_7 source=user origin=- deadlineMs=10000",
    ];
    const sources = { logLines: lines, sessionEntries: [], events: [] };
    const units = unitsOf("idle_precipitate_k1", sources);
    expect(units).toEqual(["idle_precipitate_k1", "unit_cc3"]);
    const text = formatSchedTrace(schedTrace("idle_precipitate_k1", units, sources)).join("\n");
    expect(text).toContain("idle.start job=precipitate");
    expect(text).toContain("decision=idle_yield by=L0");
    expect(text).toContain("outcome=yielded");
    expect(text).not.toContain("unit_dd4");
  });

  // lead-scheduler spec P2：交出去的单元，结果在另一个单元里交回、转告；挂起的单元在另一个单元里恢复。只看用户那一个单元的
  // 时间线，要能一路查到结果（开发模式的复查发现以前查不到）。
  it("follows a hand-off to the unit where its result comes back, and a suspended unit to where it resumes", () => {
    const logLines = [
      "[2026-11-09T15:57:00.000Z] [sched] unit.start unit=unit_u1 lane=L0 turn=turn_7 source=user origin=- deadlineMs=10000",
      "[2026-11-09T15:57:10.000Z] [sched] handoff unit=unit_u1 turn=turn_7 pkg=hof_a1b2c3d4 of=unit_u1 entry=lead_midway ticket=8 ms=36",
      "[2026-11-09T15:57:13.000Z] [sched] unit.end unit=unit_u1 lane=L0 turn=turn_7 outcome=answered ms=13000",
      "[2026-11-09T15:57:35.000Z] [sched] unit.start unit=unit_r2 lane=L2 turn=- source=system origin=system:blocker deadlineMs=300000",
      "[2026-11-09T15:57:35.010Z] [sched] lane unit=unit_r2 turn=- from=L2 to=L0 why=handoff_result",
      "[2026-11-09T15:57:35.020Z] [sched] result unit=unit_r2 of=unit_u1 pkg=hof_a1b2c3d4 ticket=8 lane=L0",
      "[2026-11-09T15:57:55.000Z] [sched] unit.end unit=unit_r2 lane=L0 turn=turn_9 outcome=answered ms=20000",
      "[2026-11-09T15:58:00.000Z] [sched] unit.start unit=unit_z9 lane=L3 turn=- source=system origin=system:digest deadlineMs=1800000",
    ];
    const sources = { logLines, sessionEntries: [], events: [] };
    expect(unitsOf("unit_u1", sources).sort()).toEqual(["unit_r2", "unit_u1"]);
    expect(unitsOf("turn_7", sources).sort()).toEqual(["unit_r2", "unit_u1"]);
    const text = formatSchedTrace(schedTrace("unit_u1", unitsOf("unit_u1", sources), sources)).join("\n");
    expect(text).toContain("[sched] result unit=unit_r2 of=unit_u1");
    expect(text).toContain("unit.end unit=unit_r2");
    expect(text).not.toContain("unit_z9");
  });

  it("accepts unit and turn ids only", () => {
    expect(SCHED_TRACE_ID.test("unit_mw9asd3m002")).toBe(true);
    expect(SCHED_TRACE_ID.test("turn_575d99e3-b509-4ef5")).toBe(true);
    expect(SCHED_TRACE_ID.test("unit_x; rm -rf /")).toBe(false);
    expect(SCHED_TRACE_ID.test("../plc.db")).toBe(false);
  });

  it("finds the units of a turn and merges the three sources by time, with the host records of the unit's window", () => {
    const sessionEntries = [
      { kind: "step", unitId: "unit_aa1", run: 1, step: 1, turnId: "turn_42", a: 120, b1: 800, tools: [{ name: "bash", ms: 400 }], at: "2026-11-09T05:45:01.500Z" },
      { kind: "step", unitId: "unit_bb2", run: 2, step: 1, turnId: null, a: 90, at: "2026-11-09T05:47:31.000Z" },
    ];
    const db = openDb(join(tempDir("plc-sched-trace-"), "plc.db"));
    try {
      recordSchedulerEvent(db, "unit_started", { unitId: "unit_aa1", turnId: "turn_42", lane: "L0", source: "user", origin: null });
      recordSchedulerEvent(db, "decided", { unitId: "unit_aa1", turnId: "turn_42", lane: "L0", decision: "red_line_stop", elapsedMs: 150_000 });
      recordSchedulerEvent(db, "unit_started", { unitId: "unit_bb2", turnId: null, lane: "L3", source: "system", origin: "system:digest" });
      expect(schedulerUnitsOfTurn(db, "turn_42")).toEqual(["unit_aa1"]);
      const units = unitsOf("turn_42", { logLines: LOG, sessionEntries, events: [] }, schedulerUnitsOfTurn(db, "turn_42"));
      expect(units).toEqual(["unit_aa1"]);
      const events = units.flatMap((unit) => schedulerEventsOfUnit(db, unit));
      // 事件的时间是写入的时间：这里只看它们在不在、是不是这个单元的。
      expect(events.map((event) => event.kind)).toEqual(["scheduler.unit_started", "scheduler.decided"]);
      const entries = schedTrace("turn_42", units, { logLines: LOG, sessionEntries, events: [] });
      const lines = entries.map((entry) => `${entry.source} ${entry.text}`);
      expect(lines).toEqual([
        'log [sched] job.start id=9 kind=worktree-delete label="item-42" pid=501 io=background',
        "log [sched] unit.start unit=unit_aa1 lane=L0 turn=turn_42 source=user origin=- deadlineMs=10000",
        "session step unitId=unit_aa1 run=1 step=1 turnId=turn_42 a=120 b1=800 tools=bash:400",
        'log [sched] stage.slow stage=A unit=unit_aa1 run=1 step=2 turn=turn_42 waitedMs=10000 thresholdMs=10000 pool="waiting 9800ms"',
        "log [sched] decide unit=unit_aa1 lane=L0 turn=turn_42 decision=red_line_stop elapsedMs=150000 budgetMs=150000 waiting=L0:user:1:150s queued=L1:external:1:2s",
        "log [sched] abort unit=unit_aa1 lane=L0 turn=turn_42 seg=1 reason=budget elapsedMs=150000",
        "log [sched] unit.start unit=unit_bb2 lane=L3 turn=- source=system origin=system:digest deadlineMs=1800000",
      ].filter((line) => !line.includes("unit_bb2")));
      expect(formatSchedTrace(entries)[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} log {5}\[sched\] job\.start/u);
    } finally {
      db.close();
    }
  });

  it("reads the [sched] lines of the logs and the scheduler entries of the session files", async () => {
    const dir = tempDir("plc-sched-trace-files-");
    writeFileSync(join(dir, "daemon.log"), `${LOG.join("\n")}\n`);
    mkdirSync(join(dir, "lead-sessions", "s1"), { recursive: true });
    writeFileSync(join(dir, "lead-sessions", "s1", "a.jsonl"), [
      JSON.stringify({ type: "message", message: { role: "user", content: "原文不读" } }),
      JSON.stringify({ type: "custom", customType: "scheduler", data: { kind: "unit_started", unitId: "unit_aa1", at: "2026-11-09T05:45:00.001Z" } }),
      "{\"type\":\"custom\",\"customType\":\"scheduler\",\"data\":{\"kind\"",
    ].join("\n"));
    const lines = await readTraceLogLines([join(dir, "daemon.log"), join(dir, "missing.log")], "unit_aa1");
    expect(lines).not.toContain(LOG[3]);
    expect(lines).toHaveLength(LOG.length - 1);
    expect(await readTraceSessionEntries(join(dir, "lead-sessions"))).toEqual([
      { kind: "unit_started", unitId: "unit_aa1", at: "2026-11-09T05:45:00.001Z" },
    ]);
  });
});

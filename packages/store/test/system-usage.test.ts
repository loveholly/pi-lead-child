// 组件的调用记录和用量汇总（Lead 事件主干 spec D17，工单 13）。
// 用户问「Jev 被调用了几次」时，Lead 的数字只能来自事件日志：没有调用时是 0，有调用时是对的次数。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  listEvents, listUndisposedEvents, openDb, recordDecisionModelCall, recordMemoryRecall, summarizeSystemUsage,
  UNDISPOSED_EVENT_DEADLINE_MS, type DecisionModelCallInput, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-system-usage-"), "plc.db"));
});

const KEY = "tsk-live-0123456789abcdef0123";

const call = (overrides: Partial<DecisionModelCallInput> = {}): DecisionModelCallInput => ({
  purpose: "route", backend: "jev", model: "jev-1.13.0", latencyMs: 120, ok: true,
  error: null, errorKind: null, fallbackFrom: null, ...overrides,
});

describe("recordDecisionModelCall", () => {
  it("writes one record-level decision_model.called event that is already disposed", () => {
    const seq = recordDecisionModelCall(db, call());
    const [event] = listEvents(db, { kind: "decision_model.called" });
    expect(event).toMatchObject({
      seq, source: "system", entityKey: "component:decision_model", level: "record",
      disposition: "handled_by_rule", dispositionDetail: { rule: "component_telemetry" }, rootCause: null,
      payload: {
        component: "decision_model", purpose: "route", backend: "jev", model: "jev-1.13.0", latencyMs: 120,
        ok: true, error: null, errorKind: null, fallbackFrom: null,
      },
    });
    expect(listUndisposedEvents(db, { olderThan: new Date(Date.now() + UNDISPOSED_EVENT_DEADLINE_MS) })).toEqual([]);
  });

  it("records a failure with its cause cut, then masked, and a root cause", () => {
    recordDecisionModelCall(db, call({
      ok: false, backend: "jev→llm", model: null, errorKind: "http",
      error: `jev: HTTP 401 token=${KEY} ${"x".repeat(2_000)}`,
    }));
    const [event] = listEvents(db, { kind: "decision_model.called" });
    const error = event!.payload.error as string;
    expect(event!.payload).toMatchObject({ ok: false, backend: "jev→llm", errorKind: "http" });
    expect(error.startsWith("jev: HTTP 401")).toBe(true);
    expect(error).not.toContain(KEY);
    expect(error.length).toBeLessThanOrEqual(501);
    expect(event!.rootCause).toMatchObject({ code: "http", scope: "decision_model" });
    expect(JSON.stringify(event)).not.toContain(KEY);
  });

  it("keeps the purpose to the decision-log rule", () => {
    recordDecisionModelCall(db, call({ purpose: "Route With Spaces" }));
    expect(listEvents(db, { kind: "decision_model.called" })[0]!.payload.purpose).toBe("unspecified");
  });

  it("rolls back nothing else: it runs in its own short transaction", () => {
    expect(db.inTransaction).toBe(false);
    recordDecisionModelCall(db, call());
    expect(db.inTransaction).toBe(false);
  });
});

describe("summarizeSystemUsage", () => {
  it("returns 0 calls for every component when nothing was called", () => {
    expect(summarizeSystemUsage(db).components).toEqual([
      expect.objectContaining({ component: "decision_model", calls: 0, failures: 0, avgLatencyMs: null, byBackend: [] }),
      expect.objectContaining({ component: "memory", calls: 0, failures: 0, avgLatencyMs: null, byBackend: [] }),
    ]);
    expect(summarizeSystemUsage(db, { component: "decision_model" }).components.map((usage) => usage.component))
      .toEqual(["decision_model"]);
  });

  it("counts calls, failures, average latency, backends, purposes and fallbacks from the event log", () => {
    recordDecisionModelCall(db, call({ latencyMs: 100 }));
    recordDecisionModelCall(db, call({
      backend: "llm", model: "stub/haiku", latencyMs: 300, fallbackFrom: { backend: "jev", error: "jev: HTTP 429 rate_limited" },
    }));
    recordDecisionModelCall(db, call({ ok: false, backend: "jev→llm", model: null, latencyMs: 200, error: "both failed", errorKind: "network" }));
    recordMemoryRecall(db, { backend: "hindsight", latencyMs: 40, ok: true, error: null, hits: 3 });

    const [decision, memory] = summarizeSystemUsage(db).components;
    expect(decision).toMatchObject({
      component: "decision_model", calls: 3, failures: 1, avgLatencyMs: 200,
      byPurpose: [{ name: "route", calls: 3, failures: 1 }],
      fallbacks: [{ name: "jev", calls: 1, failures: 0 }],
    });
    expect(decision!.byBackend).toEqual(expect.arrayContaining([
      { name: "jev", calls: 1, failures: 0 }, { name: "llm", calls: 1, failures: 0 }, { name: "jev→llm", calls: 1, failures: 1 },
    ]));
    expect(memory).toMatchObject({ component: "memory", calls: 1, failures: 0, avgLatencyMs: 40, byBackend: [{ name: "hindsight", calls: 1 }] });
  });

  it("only counts calls inside [since, until)", () => {
    recordDecisionModelCall(db, call());
    const [event] = listEvents(db, { kind: "decision_model.called" });
    const at = Date.parse(event!.occurredAt);
    const calls = (since?: number, until?: number) => summarizeSystemUsage(db, {
      component: "decision_model",
      ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
      ...(until !== undefined ? { until: new Date(until).toISOString() } : {}),
    }).components[0]!.calls;
    expect(calls(at, at + 1)).toBe(1);
    expect(calls(at + 1, at + 60_000)).toBe(0);
    expect(calls(undefined, at)).toBe(0);
    expect(calls()).toBe(1);
  });

  it("rejects a time that does not parse, a reversed range, and an unknown component", () => {
    expect(() => summarizeSystemUsage(db, { since: "昨天" })).toThrow(/since 不是合法的时间/);
    expect(() => summarizeSystemUsage(db, { since: "2026-10-18T00:00:00Z", until: "2026-10-17T00:00:00Z" })).toThrow(/晚于/);
    expect(() => summarizeSystemUsage(db, { component: "jev" as never })).toThrow(/没有组件 jev/);
  });
});

describe("recordMemoryRecall", () => {
  it("writes a memory.recalled event with the backend, latency, outcome and hit count only", () => {
    recordMemoryRecall(db, { backend: "hindsight", latencyMs: 12.6, ok: false, error: `connect ECONNREFUSED password=${KEY}`, hits: 5 });
    const [event] = listEvents(db, { kind: "memory.recalled" });
    expect(event).toMatchObject({
      entityKey: "component:memory", level: "record", disposition: "handled_by_rule",
      payload: { component: "memory", backend: "hindsight", latencyMs: 13, ok: false, hits: 0 },
      rootCause: { code: "memory_recall_failed", scope: "memory" },
    });
    expect(JSON.stringify(event)).not.toContain(KEY);
  });
});

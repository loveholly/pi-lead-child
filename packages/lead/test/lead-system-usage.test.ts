// get_system_usage（工单 13，spec D17）：Lead 按组件读调用次数、失败次数和平均耗时。数字只来自事件日志。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, recordDecisionModelCall, recordMemoryRecall, type Db } from "@pi-lead-child/store";
import { LEAD_QUIET_TOOLS } from "../src/session.js";
import { createLeadTools } from "../src/tools.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = tempDir("plc-lead-usage-");
  db = openDb(join(dir, "plc.db"));
});

async function usage(params: Record<string, unknown> = {}): Promise<any> {
  const tool = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir }).find((candidate) => candidate.name === "get_system_usage")!;
  const result = await tool.execute("call", params, undefined, undefined, undefined as never);
  return JSON.parse(result.content.map((part: { type: string; text?: string }) => part.text ?? "").join(""));
}

describe("get_system_usage", () => {
  it("says 0 for every component when nothing was called", async () => {
    const report = await usage();
    expect(report.source).toBe("事件日志（events 表）");
    expect(report.components.map((component: any) => [component.component, component.calls, component.failures, component.note]))
      .toEqual([["decision_model", 0, 0, "这段时间没有调用，次数是 0。"], ["memory", 0, 0, "这段时间没有调用，次数是 0。"]]);
    expect(report.not_recorded).toContain("Hindsight 在自己的进程里调用决策模型做重排序");
  });

  it("counts the calls in the event log, per component, backend, purpose and fallback", async () => {
    recordDecisionModelCall(db, {
      purpose: "route", backend: "llm", model: "stub/haiku", latencyMs: 300, ok: true, error: null, errorKind: null,
      fallbackFrom: { backend: "jev", error: "jev: timed out" },
    });
    recordDecisionModelCall(db, {
      purpose: "route", backend: "jev", model: "jev-1", latencyMs: 100, ok: true, error: null, errorKind: null, fallbackFrom: null,
    });
    recordMemoryRecall(db, { backend: "hindsight", latencyMs: 20, ok: false, error: "connection refused", hits: 0 });

    const [decision] = (await usage({ component: "decision_model" })).components;
    expect(decision).toMatchObject({
      component: "decision_model", calls: 2, failures: 0, avg_latency_ms: 200,
      by_purpose: [{ name: "route", calls: 2, failures: 0 }],
      fallbacks_from: [{ name: "jev", calls: 1, failures: 0 }],
    });
    expect(decision.by_backend).toEqual(expect.arrayContaining([{ name: "llm", calls: 1, failures: 0 }, { name: "jev", calls: 1, failures: 0 }]));
    expect(decision.note).toBeUndefined();
    const [memory] = (await usage({ component: "memory" })).components;
    expect(memory).toMatchObject({ component: "memory", calls: 1, failures: 1, avg_latency_ms: 20 });
    expect(memory.by_purpose).toBeUndefined();
  });

  it("filters by time and rejects a time it cannot read", async () => {
    recordDecisionModelCall(db, {
      purpose: "route", backend: "llm", model: null, latencyMs: 1, ok: true, error: null, errorKind: null, fallbackFrom: null,
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await usage({ since: future, until: new Date(Date.now() + 120_000).toISOString() })).components[0].calls).toBe(0);
    expect((await usage({ until: future })).components[0].calls).toBe(1);
    await expect(usage({ since: "上周" })).rejects.toThrow(/since 不是合法的时间/);
  });

  it("is a quiet, read-only tool", () => {
    expect(LEAD_QUIET_TOOLS.has("get_system_usage")).toBe(true);
  });
});

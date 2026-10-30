// query_events（工单 14，spec D8）：Lead 按序号、对象、类型、级别查事件日志，从新到旧。
// 每条给 seq、kind、source、entity_key、level、处置、发生时间、根因代码、摘要和截断、脱敏过的 payload；
// 组件的调用记录（遥测）不给 payload。当前局面按预算截掉的变化，Lead 用它查回来。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addInbox, appendEvent, createItem, createRun, listEvents, openDb, recordDecisionModelCall, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";
import { createLeadTools } from "../src/tools.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = tempDir("plc-lead-query-events-");
  db = openDb(join(dir, "plc.db"));
});

async function query(params: Record<string, unknown> = {}): Promise<any> {
  const tool = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir }).find((candidate) => candidate.name === "query_events")!;
  const result = await tool.execute("call", params, undefined, undefined, undefined as never);
  return JSON.parse(result.content.map((part: { type: string; text?: string }) => part.text ?? "").join(""));
}

function stageChanges(count: number, itemId = 77): void {
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      appendEvent(db, {
        source: "ticket", kind: "stage.changed", entityKey: `ticket:${itemId}`,
        payload: { itemId, itemKind: "task", from: "ready", to: "active", actor: "system", reason: `第 ${index + 1} 次` },
      });
    }
  })();
}

describe("query_events", () => {
  it("lists events newest first with their facts, 20 by default and never more than 100", async () => {
    stageChanges(130);
    const newest = listEvents(db, { order: "desc", limit: 1 })[0]!;
    const report = await query();
    expect(report.source).toBe("事件日志（events 表），从新到旧");
    expect(report.count).toBe(20);
    expect(report.has_more).toBe(true);
    expect(report.events[0]).toEqual({
      seq: newest.seq, kind: "stage.changed", source: "ticket", entity_key: "ticket:77", level: newest.level,
      disposition: null, occurred_at: newest.occurredAt, root_cause_code: null,
      summary: "#77 stage ready → active（system：第 130 次）",
      payload: JSON.stringify(newest.payload),
    });
    const seqs = report.events.map((event: { seq: number }) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => b - a));
    expect((await query({ limit: 500 })).count).toBe(100);
  });

  it("filters by since_seq, entity_key, kind (exact or prefix) and level, and pages back with before_seq", async () => {
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "开始" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const since = listEvents(db, { order: "desc", limit: 1 })[0]!.seq;
    updateRun(db, runId, { state: "failed", errorCode: "codex_error", errorMessage: "model rejected" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "Run 失败了" });

    const after = await query({ since_seq: since });
    expect(after.events.every((event: { seq: number }) => event.seq > since)).toBe(true);
    expect(after.events.map((event: { kind: string }) => event.kind)).toEqual(expect.arrayContaining(["run.failed", "inbox.blocker"]));

    const failed = (await query({ kind: "run.failed" })).events;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "run.failed", entity_key: `run:${runId}`, root_cause_code: expect.any(String) });
    expect(failed[0].summary).toContain(`Run #${runId}`);
    expect(failed[0].summary).toContain("错误码 codex_error");
    const runs = (await query({ kind: "run.*" })).events.map((event: { kind: string }) => event.kind);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((kind: string) => kind.startsWith("run."))).toBe(true);
    // 前缀里的点就是点：run.* 不匹配 runtime_xxx 一类的类型。
    expect((await query({ kind: "run.*" })).events.some((event: { kind: string }) => !event.kind.startsWith("run."))).toBe(false);

    const ticket = (await query({ entity_key: `ticket:${itemId}` })).events;
    expect(ticket.length).toBeGreaterThan(0);
    expect(ticket.every((event: { entity_key: string }) => event.entity_key === `ticket:${itemId}`)).toBe(true);
    expect((await query({ level: "tell" })).events.map((event: { kind: string }) => event.kind)).toEqual(["inbox.blocker"]);

    const all = listEvents(db, { order: "desc", limit: 1000 });
    const page1 = await query({ limit: 2 });
    expect(page1.has_more).toBe(true);
    expect(page1.next).toContain(`before_seq 传 ${page1.events[1].seq}`);
    const page2 = await query({ limit: 2, before_seq: page1.events[1].seq });
    expect([...page1.events, ...page2.events].map((event: { seq: number }) => event.seq)).toEqual(all.slice(0, 4).map((event) => event.seq));
  });

  it("caps and redacts the payload, and leaves telemetry payloads out", async () => {
    addInbox(db, {
      dedupScope: "sys:secret", severity: "attention", source: "structural", summary: "连接要你处理",
      payload: { apiKey: "sk-live-0123456789abcdefghij", log: "x".repeat(2_000) }, lossless: true,
    });
    recordDecisionModelCall(db, {
      purpose: "route", backend: "jev", model: "jev-1", latencyMs: 120, ok: true, error: null, errorKind: null, fallbackFrom: null,
    });
    const [telemetry, inbox] = (await query()).events;
    expect(telemetry).toMatchObject({ kind: "decision_model.called", payload: null, summary: "用途 route，后端 jev，成功，120 毫秒" });
    expect(inbox.kind).toBe("inbox.attention");
    expect(inbox.summary).toBe("连接要你处理");
    expect(inbox.payload).not.toContain("sk-live-0123456789abcdefghij");
    expect(inbox.payload).toContain("截断");
    expect(inbox.payload.length).toBeLessThan(700);
  });

  it("is a quiet, read-only tool that the prompt tells Lead to use", () => {
    expect(LEAD_QUIET_TOOLS.has("query_events")).toBe(true);
    expect(LEAD_SYSTEM_PROMPT).toContain("query_events");
  });
});

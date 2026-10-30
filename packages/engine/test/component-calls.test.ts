// 组件调用写成事件（工单 13，spec D17）：SmartModel 的每次判断、daemon 向记忆服务的每次召回，都在事件日志里
// 留一条 record 级的事件。用户问「Jev 被调用了几次」时，Lead 的数字从这里来。
// 事件里只有用途、后端、模型、耗时、成败和失败原因：没有 state、问题、回答和查询原文。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listEvents, openDb, recordDecisionModelCall, summarizeSystemUsage, type Db } from "@pi-lead-child/store";
import {
  createSmartModel, NotesMemory, SmartModelBackendError, SmartModelInputError, withCallObserver,
  type SmartModel, type SmartModelCallRecord, type SmartQuestionSet,
} from "../src/index.js";
import { FakeHindsight } from "../testing/index.js";

const STATE = "STATE-MARKER the user wants a refund";
const QUESTIONS = { ok: { type: "yes_no", prompt: "Is it fine?" } } as const satisfies SmartQuestionSet;
const KEY = "tsk-test-0123456789abcdef";

function db(): Db {
  return openDb(join(tempDir("plc-component-calls-"), "plc.db"));
}

function recorder() {
  const records: SmartModelCallRecord[] = [];
  return { records, onCall: (record: SmartModelCallRecord) => { records.push(record); } };
}

// 只给 LLM 后端：complete 返回 reply，或者抛错。
const llm = (reply: string | Error) => async (): Promise<string> => {
  if (reply instanceof Error) throw reply;
  return reply;
};

// Jev 的配置：https 的端点，key 绑定同一个主机。fetch 由测试注入，不连网络。
const jev = () => ({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: KEY, keyHost: "api.typesafe.ai" });
const failingFetch = (async () => { throw new Error("getaddrinfo ENOTFOUND api.typesafe.ai"); }) as unknown as typeof fetch;

describe("SmartModel call records", () => {
  it("reports a successful call with purpose, backend, model and latency, and nothing of the state or answers", async () => {
    const { records, onCall } = recorder();
    const model = createSmartModel({ complete: llm('{"ok": {"yes": true}}'), completeModel: "stub/haiku", onCall })!;
    await model.decide(STATE, QUESTIONS, { purpose: "route" });
    expect(records).toEqual([{
      purpose: "route", backend: "llm", model: "stub/haiku", latencyMs: expect.any(Number),
      ok: true, error: null, errorKind: null, fallbackFrom: null,
    }]);
    expect(JSON.stringify(records)).not.toContain("STATE-MARKER");
  });

  it("reports the fallback when Jev fails and the LLM answers, without the key", async () => {
    const { records, onCall } = recorder();
    const model = createSmartModel({
      decisionModel: jev, fetch: failingFetch, complete: llm('{"ok": {"yes": false}}'), completeModel: "stub/haiku", onCall,
    })!;
    await model.decide(STATE, QUESTIONS, { purpose: "route" });
    expect(records).toEqual([expect.objectContaining({
      ok: true, backend: "llm", fallbackFrom: { backend: "jev", error: expect.stringContaining("ENOTFOUND") },
    })]);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it("reports a failed call with its kind, and the caller still gets the error", async () => {
    const { records, onCall } = recorder();
    const model = createSmartModel({ complete: llm("not json"), onCall })!;
    await expect(model.decide(STATE, QUESTIONS, { purpose: "route" })).rejects.toBeInstanceOf(SmartModelBackendError);
    await expect(model.decide("", QUESTIONS)).rejects.toBeInstanceOf(SmartModelInputError);
    expect(records).toEqual([
      expect.objectContaining({ purpose: "route", backend: "llm", model: null, ok: false, errorKind: "invalid_answer", error: expect.stringContaining("invalid answer") }),
      expect.objectContaining({ purpose: "unspecified", ok: false, errorKind: "input" }),
    ]);
  });

  it("does not let a failing observer break the decision", async () => {
    const inner: SmartModel = { backend: "stub", decide: async () => ({ answers: { ok: { type: "yes_no", probability: 1 } }, backend: "stub", model: null, latencyMs: 1, fallbackFrom: null }) as never };
    const model = withCallObserver(inner, () => { throw new Error("db is closed"); });
    await expect(model.decide(STATE, QUESTIONS)).resolves.toMatchObject({ backend: "stub" });
  });

  // 验收：SmartModel 调用一次，事件日志里有一条 decision_model.called，用途和成败正确；失败时也有事件。
  it("lands as one decision_model.called event per call, success and failure alike", async () => {
    const store = db();
    const onCall = (record: SmartModelCallRecord) => { recordDecisionModelCall(store, record); };
    const working = createSmartModel({ complete: llm('{"ok": {"yes": true}}'), completeModel: "stub/haiku", onCall })!;
    const broken = createSmartModel({ complete: llm(new Error(`503 upstream token=${KEY}`)), onCall })!;

    expect(summarizeSystemUsage(store, { component: "decision_model" }).components[0]!.calls).toBe(0);
    await working.decide(STATE, QUESTIONS, { purpose: "route" });
    expect(listEvents(store, { kind: "decision_model.called" }).map((event) => [event.payload.purpose, event.payload.ok]))
      .toEqual([["route", true]]);
    expect(summarizeSystemUsage(store, { component: "decision_model" }).components[0]!.calls).toBe(1);

    await expect(broken.decide(STATE, QUESTIONS, { purpose: "triage" })).rejects.toThrow();
    const events = listEvents(store, { kind: "decision_model.called" });
    expect(events.map((event) => [event.payload.purpose, event.payload.ok])).toEqual([["route", true], ["triage", false]]);
    expect(events[1]).toMatchObject({ level: "record", disposition: "handled_by_rule", rootCause: { scope: "decision_model" } });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain("STATE-MARKER");
    expect(summarizeSystemUsage(store, { component: "decision_model" }).components[0]).toMatchObject({ calls: 2, failures: 1 });
  });
});

describe("memory recall events", () => {
  it("records each recall that Hindsight answers or falls back from, with its outcome and hit count but not the query", async () => {
    const store = db();
    const backend = new FakeHindsight();
    const memory = new NotesMemory(store, backend);
    memory.save({ title: "时区", content: "用户在 UTC+8", tags: [] });
    memory.save({ title: "时区设置", content: "日程按 UTC+8 写", tags: [] });
    await memory.idle();
    backend.process();
    await memory.sync();
    await memory.search("QUERY-MARKER 时区");
    backend.recallError = "connection refused";
    await memory.search("QUERY-MARKER 时区");

    const events = listEvents(store, { kind: "memory.recalled" });
    expect(events.map((event) => event.payload)).toEqual([
      { component: "memory", backend: "hindsight", latencyMs: expect.any(Number), ok: true, error: null, hits: 2, fallback: false, reason: null },
      {
        component: "memory", backend: "hindsight", latencyMs: expect.any(Number), ok: false,
        error: "Hindsight 召回出错：Hindsight recall failed: HTTP 500 connection refused", hits: 0, fallback: true, reason: "error",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("QUERY-MARKER");
    expect(summarizeSystemUsage(store, { component: "memory" }).components[0]).toMatchObject({ calls: 2, failures: 1 });
  });

  it("records nothing when there is no backend: full-text search is not a component call", async () => {
    const store = db();
    await new NotesMemory(store, null).search("时区");
    expect(listEvents(store, { kind: "memory.recalled" })).toEqual([]);
  });
});

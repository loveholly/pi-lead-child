// 组件调用的事件类型（工单 13，spec D17）：decision_model.called 和 memory.recalled。
import { describe, expect, it } from "vitest";
import { COMPONENT_CALL_KINDS, componentEntityKey, eventKindDefinition, validateEventEnvelope } from "../src/index.ts";

const decisionCall = {
  source: "system" as const,
  kind: "decision_model.called",
  entityKey: componentEntityKey("decision_model"),
  payload: {
    component: "decision_model", purpose: "route", backend: "jev", model: "jev-1.13.0", latencyMs: 80,
    ok: true, error: null, errorKind: null, fallbackFrom: null,
  },
};

describe("component call event kinds", () => {
  it("registers one kind per component, from the system source", () => {
    for (const kind of Object.values(COMPONENT_CALL_KINDS)) {
      expect(eventKindDefinition(kind)?.sources).toEqual(["system"]);
    }
    expect(validateEventEnvelope(decisionCall, "record")).toEqual([]);
    expect(validateEventEnvelope({
      source: "system", kind: "memory.recalled", entityKey: componentEntityKey("memory"),
      payload: { component: "memory", backend: "hindsight", latencyMs: 5, ok: false, error: "connection refused", hits: 0 },
    }, "record")).toEqual([]);
  });

  // 事件里不能有 state、问题、回答或者查询原文：schema 不收多出来的字段。
  it("rejects a payload that carries anything beyond the call facts", () => {
    for (const extra of [{ state: "the user's text" }, { questions: ["ok"] }, { answers: { ok: true } }]) {
      expect(validateEventEnvelope({ ...decisionCall, payload: { ...decisionCall.payload, ...extra } }, "record").join("\n"))
        .toMatch(/decision_model\.called 的 payload/);
    }
    expect(validateEventEnvelope({
      source: "system", kind: "memory.recalled", entityKey: componentEntityKey("memory"),
      payload: { component: "memory", backend: "hindsight", latencyMs: 5, ok: true, error: null, hits: 1, query: "时区" },
    }, "record").join("\n")).toMatch(/memory\.recalled 的 payload/);
  });

  it("does not require a root cause: a call event is not a .failed kind", () => {
    expect(validateEventEnvelope({ ...decisionCall, payload: { ...decisionCall.payload, ok: false, error: "x", errorKind: "http" } }, "record"))
      .toEqual([]);
  });
});

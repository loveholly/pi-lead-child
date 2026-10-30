// 事件信封和按 kind 注册的 schema（Lead 事件主干 spec D1、D2，工单 01）。
import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import {
  EVENT_LEVELS,
  eventKindDefinition,
  eventRequiresRootCause,
  listEventKinds,
  registerEventKind,
  validateEventEnvelope,
} from "../src/index.ts";

const runFailed = {
  source: "run" as const,
  sourceRef: "run:91:failed",
  kind: "run.failed",
  entityKey: "run:91",
  payload: {
    runId: 91, itemId: 77, role: "executor", purpose: "execution", runtime: "codex",
    from: "running", to: "failed", exitCode: 1, errorCode: "process_exit",
  },
  rootCause: { code: "process_exit", scope: "task", message: "exit 1" },
};

describe("event kinds registered for the first phase", () => {
  it("covers every internal source the dual-write uses", () => {
    const kinds = listEventKinds().map((definition) => definition.kind);
    for (const kind of [
      "user.message", "lead.turn_completed", "lead.turn_failed",
      "ticket_agent.turn_completed", "ticket_agent.turn_failed",
      "stage.changed", "checkpoint.recorded",
      "run.started", "run.resumed", "run.paused", "run.finished", "run.failed", "run.stopped",
      "inbox.blocker", "inbox.attention", "notification.created", "timer.fired", "system.event_rejected",
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(EVENT_LEVELS).toEqual(["record", "digest", "auto", "tell", "interrupt", "conversation"]);
  });
});

describe("validateEventEnvelope", () => {
  it("accepts a registered kind whose payload matches its schema", () => {
    expect(validateEventEnvelope(runFailed, "record")).toEqual([]);
  });

  it("rejects a kind nobody registered", () => {
    expect(validateEventEnvelope({ ...runFailed, kind: "run.exploded" }, "record").join("\n"))
      .toMatch(/run\.exploded.*没有注册/);
  });

  it("rejects a payload that does not match the kind's schema", () => {
    const errors = validateEventEnvelope({ ...runFailed, payload: { ...runFailed.payload, runId: "91" } }, "record");
    expect(errors.join("\n")).toMatch(/run\.failed 的 payload/);
  });

  it("rejects a source the kind does not come from", () => {
    expect(validateEventEnvelope({ ...runFailed, source: "user" }, "record").join("\n")).toMatch(/source/);
  });

  it("rejects an entity key without a type prefix", () => {
    expect(validateEventEnvelope({ ...runFailed, entityKey: "91" }, "record").join("\n")).toMatch(/entityKey/);
  });

  it("requires a root cause on every .failed kind, whatever its level", () => {
    const { rootCause: _omit, ...withoutCause } = runFailed;
    expect(eventRequiresRootCause("run.failed", "record")).toBe(true);
    expect(validateEventEnvelope(withoutCause, "record").join("\n")).toMatch(/root_cause/);
  });

  it("requires a root cause on an anomaly that reaches tell or interrupt, not on a recorded one", () => {
    expect(eventRequiresRootCause("inbox.blocker", "tell")).toBe(true);
    expect(eventRequiresRootCause("inbox.blocker", "interrupt")).toBe(true);
    expect(eventRequiresRootCause("inbox.blocker", "digest")).toBe(false);
    expect(eventRequiresRootCause("inbox.attention", "tell")).toBe(false);
    expect(eventRequiresRootCause("stage.changed", "tell")).toBe(false);
  });

  it("rejects a root cause without a code", () => {
    expect(validateEventEnvelope({ ...runFailed, rootCause: { message: "x" } as never }, "record").join("\n"))
      .toMatch(/root_cause/);
  });
});

describe("registerEventKind", () => {
  it("adds a new kind that validates against its own schema", () => {
    registerEventKind({
      kind: "test.registered_kind",
      sources: ["system"],
      payload: Type.Object({ value: Type.Integer() }),
      description: "只在这个测试里用",
    });
    expect(eventKindDefinition("test.registered_kind")?.sources).toEqual(["system"]);
    expect(validateEventEnvelope({
      source: "system", kind: "test.registered_kind", entityKey: "test:1", payload: { value: 1 },
    }, "record")).toEqual([]);
  });

  it("refuses to register the same kind twice", () => {
    expect(() => registerEventKind({
      kind: "run.failed", sources: ["run"], payload: Type.Object({}), description: "重复",
    })).toThrow(/run\.failed/);
  });
});

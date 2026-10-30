import { describe, expect, it } from "vitest";
import { AsyncEventQueue, RuntimeEventSequencer } from "../src/event-queue.js";

describe("normalized runtime event primitives", () => {
  it("delivers queued events in order and terminates exactly once", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();
    queue.end();
    const values: number[] = [];
    for await (const value of queue) values.push(value);
    expect(values).toEqual([1, 2]);
    expect(() => queue.push(3)).toThrow(/closed/i);
  });

  it("rejects a blocked consumer on process failure", async () => {
    const queue = new AsyncEventQueue<number>();
    const consume = (async () => {
      for await (const _value of queue) { /* wait */ }
    })();
    queue.fail(new Error("process failed"));
    await expect(consume).rejects.toThrow("process failed");
  });

  it("adds run identity and monotonic sequence and permits one terminal event", () => {
    const sequencer = new RuntimeEventSequencer(42, () => "2026-07-23T12:00:00.000Z");
    expect(sequencer.event({ type: "run.started", runtime: "codex", model: null }))
      .toMatchObject({ runId: 42, seq: 1, occurredAt: "2026-07-23T12:00:00.000Z" });
    expect(sequencer.event({
      type: "usage.updated", mode: "cumulative", inputTokens: 10,
      outputTokens: 2, totalTokens: 12, costUsd: null,
    })).toMatchObject({ seq: 2, mode: "cumulative" });
    expect(sequencer.event({ type: "run.completed", exitCode: 0 })).toMatchObject({ seq: 3 });
    expect(() => sequencer.event({
      type: "run.failed", exitCode: 1, errorCode: "late", error: "late",
      failure: { scope: "unknown", retry: "never", needs: "none", code: "unknown", evidence: "late" },
    })).toThrow(/terminal/i);
  });
});

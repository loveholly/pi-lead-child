// 工单 14 的决策边界：输出游标。事件落库以后能存下哪一对（字节偏移, seq）。
// 从游标处续读时，重新交付 offset 处的那一帧，sequencer 从 seq 接着编号，
// 重新产生的事件和已经落库的事件 seq 相同，所以不会漏，也不会重复。
import { describe, expect, it } from "vitest";
import { RuntimeEventSequencer } from "../src/event-queue.js";
import { deliverOutputFrame, outputCursorOf } from "../src/output-cursor.js";

describe("output cursor of an event", () => {
  it("points at the start of the frame that produced the event, with the seq before that frame", () => {
    const sequencer = new RuntimeEventSequencer(1);
    const started = sequencer.event({ type: "runtime.stderr", text: "before any frame" });
    let fromFirst: ReturnType<typeof sequencer.event>[] = [];
    deliverOutputFrame(0, () => {
      fromFirst = [
        sequencer.event({ type: "session.updated", externalSessionId: "s" }),
        sequencer.event({ type: "runtime.stderr", text: "same frame" }),
      ];
    });
    let fromSecond!: ReturnType<typeof sequencer.event>;
    deliverOutputFrame(57, () => { fromSecond = sequencer.event({ type: "runtime.stderr", text: "next frame" }); });

    expect(outputCursorOf(started)).toBeUndefined();
    expect(fromFirst.map((event) => outputCursorOf(event))).toEqual([{ offset: 0, seq: 1 }, { offset: 0, seq: 1 }]);
    expect(outputCursorOf(fromSecond)).toEqual({ offset: 57, seq: 3 });
  });

  it("does not tag an event produced outside a frame delivery, so the cursor never runs ahead", () => {
    const sequencer = new RuntimeEventSequencer(1);
    deliverOutputFrame(0, () => { sequencer.event({ type: "runtime.stderr", text: "frame" }); });
    const later = sequencer.event({ type: "session.updated", externalSessionId: "async" });
    expect(outputCursorOf(later)).toBeUndefined();
  });

  it("starts a new frame even when two frames produce events back to back", () => {
    const sequencer = new RuntimeEventSequencer(1);
    const events: ReturnType<typeof sequencer.event>[] = [];
    deliverOutputFrame(10, () => { events.push(sequencer.event({ type: "runtime.stderr", text: "a" })); });
    deliverOutputFrame(20, () => { events.push(sequencer.event({ type: "runtime.stderr", text: "b" })); });
    deliverOutputFrame(30, () => { /* 这一帧没有产生事件 */ });
    deliverOutputFrame(40, () => { events.push(sequencer.event({ type: "runtime.stderr", text: "c" })); });
    expect(events.map((event) => outputCursorOf(event))).toEqual([
      { offset: 10, seq: 0 }, { offset: 20, seq: 1 }, { offset: 40, seq: 2 },
    ]);
  });
});

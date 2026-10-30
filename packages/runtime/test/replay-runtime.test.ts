import { describe, expect, it } from "vitest";
import { ReplayRuntime, type RecordedRun } from "../testing/replay-runtime.js";
import type { RuntimeEvent, RuntimeStartRequest } from "../src/types.js";

function request(runId: number): RuntimeStartRequest {
  return {
    itemId: 7, runId, role: "executor", purpose: "execution",
    prompt: "replay", workdir: "/tmp", env: {},
  };
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const seen: RuntimeEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

const failedCodexRun: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "session.updated", externalSessionId: "thread-a" },
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "runtime.stderr", text: "Reconnecting... 1/5\n" },
    { type: "run.failed", exitCode: null, errorCode: "codex_error", error: "Your workspace is out of credits." },
  ],
};

describe("replay runtime", () => {
  it("replays the recorded events in order under the run id it was started with", async () => {
    const handle = await new ReplayRuntime(failedCodexRun).start(request(91));
    const events = await drain(handle.events);

    expect(events.map((event) => [event.type, event.runId, event.seq])).toEqual([
      ["session.updated", 91, 1],
      ["run.started", 91, 2],
      ["runtime.stderr", 91, 3],
      ["run.failed", 91, 4],
    ]);
    expect(events[3]).toMatchObject({ errorCode: "codex_error", error: "Your workspace is out of credits." });
    // 录制早于类型化失败。回放用 adapter 的分类函数补上类型，证据带着录制的 stderr。
    expect(events[3]).toMatchObject({
      failure: { scope: "account", needs: "refill", code: "out_of_credits", evidence: expect.stringContaining("Reconnecting") },
    });
  });

  it("reports a failed exit with the recorded failure and external session", async () => {
    const handle = await new ReplayRuntime(failedCodexRun).start(request(5));
    await drain(handle.events);

    expect(await handle.wait()).toEqual({
      ok: false, exitCode: null, signal: null, externalSessionId: "thread-a",
      errorCode: "codex_error", errorMessage: "Your workspace is out of credits.",
    });
  });

  it("reports a clean exit for a run that completed", async () => {
    const handle = await new ReplayRuntime({
      runtime: "claude",
      events: [
        { type: "run.started", runtime: "claude", model: null },
        { type: "run.completed", exitCode: 0 },
      ],
    }).start(request(6));
    await drain(handle.events);

    expect(await handle.wait()).toEqual({
      ok: true, exitCode: 0, signal: null, externalSessionId: null,
      errorCode: null, errorMessage: null,
    });
  });

  it("refuses a recording that does not end with exactly one terminal event", () => {
    expect(() => new ReplayRuntime({
      runtime: "pi",
      events: [{ type: "run.started", runtime: "pi", model: null }],
    })).toThrow(/terminal event/);
    expect(() => new ReplayRuntime({
      runtime: "pi",
      events: [
        { type: "run.completed", exitCode: 0 },
        { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: "late" },
      ],
    })).toThrow(/terminal event/);
  });

  it("carries the runtime's real capabilities", () => {
    expect(new ReplayRuntime(failedCodexRun).capabilities).toMatchObject({ resume: true, steering: false });
    expect(new ReplayRuntime({
      runtime: "pi",
      events: [{ type: "run.completed", exitCode: 0 }],
    }).capabilities).toMatchObject({ steering: true, mcp: false });
  });
});

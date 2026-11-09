// 打断式插话（step-interrupt.ts，2026-11-09）：只在模型还在想、没写字也没调工具时中止这一步的模型请求；
// 中止的是这一步自己的信号，不是这次运行的信号（工具和压缩不受影响）；压缩、摘要的请求不能打断。
import { describe, expect, it } from "vitest";
import { installStepInterrupt } from "../src/step-interrupt.js";

function fakeSession() {
  const listeners: Array<(event: any) => void> = [];
  const requests: Array<{ signal: AbortSignal | undefined }> = [];
  const session = {
    agent: {
      streamFunction: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal; getSteeringMessages?: () => Promise<unknown[]> }) => {
        requests.push({ signal: options?.signal });
        return { stream: requests.length };
      },
    },
    subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
  };
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const loopRequest = (runSignal?: AbortSignal) => session.agent.streamFunction({}, {}, {
    getSteeringMessages: async () => [], ...(runSignal ? { signal: runSignal } : {}),
  });
  return { session, emit, requests, loopRequest };
}

const assistantStart = { type: "message_start", message: { role: "assistant" } };
const assistantEnd = { type: "message_end", message: { role: "assistant" } };
const update = (type: string) => ({ type: "message_update", assistantMessageEvent: { type } });

describe("interrupting the model's step for a steer", () => {
  it("aborts the step's own request while the model is only thinking, and leaves the run's signal alone", () => {
    const { session, emit, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const run = new AbortController();
    loopRequest(run.signal);
    emit(assistantStart);
    emit(update("thinking_start"));
    emit(update("thinking_delta"));

    expect(interrupter.interrupt()).toBe(true);
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    // 同一步不再中止第二次。
    expect(interrupter.interrupt()).toBe(false);
  });

  it("does not interrupt once the step shows text or starts a tool call, or before the reply has started", () => {
    const { session, emit, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);

    loopRequest();
    expect(interrupter.interrupt()).toBe(false);
    emit(assistantStart);
    emit(update("text_delta"));
    expect(interrupter.interrupt()).toBe(false);
    emit(assistantEnd);

    loopRequest();
    emit(assistantStart);
    emit(update("toolcall_start"));
    expect(interrupter.interrupt()).toBe(false);
    emit(assistantEnd);
    // 这一步结束了（工具在跑）：没有可以中止的模型请求。
    expect(interrupter.interrupt()).toBe(false);
    expect(requests.every((request) => !request.signal?.aborted)).toBe(true);
  });

  it("never touches a compaction or summary request, which carries no steering queue", () => {
    const { session, emit, requests } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const compaction = new AbortController();
    session.agent.streamFunction({}, {}, { signal: compaction.signal });
    emit(assistantStart);
    expect(interrupter.interrupt()).toBe(false);
    expect(requests[0]!.signal).toBe(compaction.signal);
  });
});

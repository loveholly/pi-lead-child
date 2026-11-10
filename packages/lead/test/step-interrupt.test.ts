// 打断式插话（step-interrupt.ts）的决策边界：
//   · 模型还在想（没写字也没调工具）：中止这一步的模型请求，pi-ai 记成 aborted（2026-11-09）。请求发出去、还没收到回答的开头时也算在想：
//     vibeproxy 这类代理要等模型想完才回响应头。
//   · 已经写出了字、还没调工具（2026-11-10）：中止，写出的字作为一条正常结束的助手消息交给对话循环，带标记；
//     发给模型时插话前面加一段说明。
//   · 开始调工具：不中止。
// 中止的是这一步自己的信号，不是这次运行的信号（工具和压缩不受影响）；压缩、摘要的请求不能打断。
import { describe, expect, it } from "vitest";
import { INTERRUPTED_NOTE, installStepInterrupt, isInterruptedForSteer, withInterruptedNotes } from "../src/step-interrupt.js";

// 像 pi-ai 的流：测试往里推事件；请求的信号中止时，按 pi-ai 的样子以 aborted 结尾（content 是到那时为止收到的内容）。
function fakeStream(signal: AbortSignal | undefined) {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let final: any = null;
  const partial: any = { role: "assistant", content: [], stopReason: "stop", usage: { input: 0, output: 0 } };
  const push = (event: any) => {
    if (finished) return;
    if (event.type === "done") { final = event.message; finished = true; }
    if (event.type === "error") { final = event.error; finished = true; }
    queue.push(event);
    wake?.();
  };
  signal?.addEventListener("abort", () => push({
    type: "error", reason: "aborted", error: { ...partial, content: partial.content.map((block: any) => ({ ...block })), stopReason: "aborted", errorMessage: "Request was aborted" },
  }));
  return {
    partial,
    push,
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) {
            const event = queue.shift();
            yield event;
            if (event.type === "done" || event.type === "error") return;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      result: async () => final,
    },
  };
}

function fakeSession() {
  const requests: Array<{ signal: AbortSignal | undefined; source: ReturnType<typeof fakeStream> }> = [];
  const session = {
    agent: {
      streamFunction: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal; getSteeringMessages?: () => Promise<unknown[]> }) => {
        const source = fakeStream(options?.signal);
        requests.push({ signal: options?.signal, source });
        return source.stream;
      },
      transformContext: undefined as ((messages: any[]) => Promise<any[]>) | undefined,
    },
  };
  // 对话循环的一次请求：返回包过的流，和推事件的办法。
  const loopRequest = (runSignal?: AbortSignal) => {
    const stream = session.agent.streamFunction({}, {}, {
      getSteeringMessages: async () => [], ...(runSignal ? { signal: runSignal } : {}),
    }) as any;
    const source = requests.at(-1)!.source;
    const seen: any[] = [];
    // 像 agent-loop.js 一样一边读一边处理：读完（done 或 error）以后取 result()。
    const consumed = (async () => {
      for await (const event of stream) seen.push(event);
      return stream.result();
    })();
    return { stream, source, seen, consumed };
  };
  return { session, requests, loopRequest };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (source: ReturnType<typeof fakeStream>, index: number, delta: string) => {
  const block = source.partial.content[index] ?? (source.partial.content[index] = { type: "text", text: "" });
  block.text += delta;
  source.push({ type: "text_delta", contentIndex: index, delta, partial: source.partial });
};

describe("interrupting the model's step for a steer", () => {
  it("aborts the step's own request while the model is only thinking, and leaves the run's signal alone", async () => {
    const { session, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const run = new AbortController();
    const { source, consumed } = loopRequest(run.signal);
    source.push({ type: "start", partial: source.partial });
    source.partial.content.push({ type: "thinking", thinking: "想" });
    source.push({ type: "thinking_start", contentIndex: 0, partial: source.partial });
    source.push({ type: "thinking_delta", contentIndex: 0, delta: "想", partial: source.partial });
    await tick();

    expect(interrupter.interrupt()).toBe(true);
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    // 同一步不再中止第二次。
    expect(interrupter.interrupt()).toBe(false);
    // 没写字：照旧以 aborted 结束（pi 结束运行，再 continue() 送插话）。
    expect((await consumed).stopReason).toBe("aborted");
  });

  // 回归（2026-11-09）：vibeproxy 等模型想完、吐出第一个字时才回响应头，pi 这时才有 message_start。
  // 以前要等 message_start 才能中止，接这类代理时能打断的时间几乎是零，插话照旧等一整步。
  it("aborts a request that is still waiting for the model's first byte", async () => {
    const { session, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const run = new AbortController();
    const { consumed } = loopRequest(run.signal);

    expect(interrupter.interrupt()).toBe(true);
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    expect((await consumed).stopReason).toBe("aborted");
  });

  // 回归（2026-11-10 插话验收）：以前写出了字就不中止，「写短一点」要等 2000 字的长文写完。
  it("stops a step that is writing text and keeps what it wrote as a finished answer marked as interrupted", async () => {
    const { session, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const run = new AbortController();
    const { source, seen, consumed } = loopRequest(run.signal);
    source.push({ type: "start", partial: source.partial });
    // 写完的思考（带签名）、写出的字、又开始想的半截思考。
    source.partial.content.push({ type: "thinking", thinking: "先想好结构", thinkingSignature: "sig" });
    source.push({ type: "thinking_start", contentIndex: 0, partial: source.partial });
    source.push({ type: "thinking_end", contentIndex: 0, content: "先想好结构", partial: source.partial });
    source.partial.content.push({ type: "text", text: "" });
    source.push({ type: "text_start", contentIndex: 1, partial: source.partial });
    text(source, 1, "第一段。");
    text(source, 1, "第二段写到一");
    source.partial.content.push({ type: "thinking", thinking: "半截" });
    source.push({ type: "thinking_start", contentIndex: 2, partial: source.partial });
    await tick();

    expect(interrupter.interrupt()).toBe(true);
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    const message = await consumed;
    // 对话循环看到的是一条正常结束的回答：done，不是 error。
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(seen.at(-1).message).toBe(message);
    expect(message).toMatchObject({ role: "assistant", stopReason: "stop", interruptedBy: "steer" });
    expect(message.errorMessage).toBeUndefined();
    expect(message.content).toEqual([
      { type: "thinking", thinking: "先想好结构", thinkingSignature: "sig" },
      { type: "text", text: "第一段。第二段写到一" },
    ]);
    expect(isInterruptedForSteer(message)).toBe(true);
    expect(interrupter.interrupt()).toBe(false);
  });

  it("does not interrupt a step that has started a tool call, or a step that has ended", async () => {
    const { session, requests, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);

    const first = loopRequest();
    first.source.push({ type: "start", partial: first.source.partial });
    text(first.source, 0, "我查一下。");
    first.source.partial.content.push({ type: "toolCall", id: "c1", name: "bash", arguments: {} });
    first.source.push({ type: "toolcall_start", contentIndex: 1, partial: first.source.partial });
    await tick();
    expect(interrupter.interrupt()).toBe(false);
    first.source.push({ type: "done", reason: "toolUse", message: { ...first.source.partial, stopReason: "toolUse" } });
    await first.consumed;
    // 这一步结束了（工具在跑）：没有可以中止的模型请求。
    expect(interrupter.interrupt()).toBe(false);
    expect(requests.every((request) => !request.signal?.aborted)).toBe(true);
  });

  it("passes the answer through unchanged when it ends on its own before the abort lands", async () => {
    const { session, loopRequest } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const { source, consumed } = loopRequest();
    source.push({ type: "start", partial: source.partial });
    text(source, 0, "答完了。");
    const done = { ...source.partial, content: [{ type: "text", text: "答完了。" }], stopReason: "stop" };
    source.push({ type: "done", reason: "stop", message: done });
    // 流里的 done 已经到了，循环还没读到它：这时要求中止，结尾照原样交出去。
    interrupter.interrupt();
    const message = await consumed;
    expect(message).toBe(done);
    expect(isInterruptedForSteer(message)).toBe(false);
  });

  it("never touches a compaction or summary request, which carries no steering queue", () => {
    const { session, requests } = fakeSession();
    const interrupter = installStepInterrupt(session);
    const compaction = new AbortController();
    session.agent.streamFunction({}, {}, { signal: compaction.signal });
    expect(interrupter.interrupt()).toBe(false);
    expect(requests[0]!.signal).toBe(compaction.signal);
  });

  it("chains onto the agent's existing context transform", async () => {
    const { session } = fakeSession();
    session.agent.transformContext = async (messages) => [...messages, { role: "user", content: "pi 加的" }];
    installStepInterrupt(session);
    const out = await session.agent.transformContext!([{ role: "user", content: "问" }]);
    expect(out.map((message) => message.content)).toEqual(["问", "pi 加的"]);
  });
});

describe("the note in front of the steer that follows an interrupted answer", () => {
  const cut = { role: "assistant", stopReason: "stop", interruptedBy: "steer", content: [{ type: "text", text: "写到一半" }] };
  const steer = { role: "user", content: [{ type: "text", text: "写短一点" }] };

  it("goes in front of the first user message after the interrupted answer, only in the copy sent to the model", () => {
    const system = { role: "system", content: "" };
    const messages = [{ role: "user", content: "写长文" }, cut, system, steer, { role: "user", content: "后来的话" }];
    const out = withInterruptedNotes(messages);
    expect(out[3].content).toEqual([{ type: "text", text: INTERRUPTED_NOTE }, { type: "text", text: "写短一点" }]);
    expect(INTERRUPTED_NOTE).toContain('<system_event kind="steer"');
    // 别的消息原样，原来的对象没有改。
    expect(out[4]).toBe(messages[4]);
    expect(out[2]).toBe(system);
    expect(steer.content).toEqual([{ type: "text", text: "写短一点" }]);
  });

  it("leaves a history without interrupted answers as it is", () => {
    const messages = [{ role: "user", content: "问" }, { role: "assistant", stopReason: "stop", content: [] }, steer];
    expect(withInterruptedNotes(messages)).toBe(messages);
  });

  it("turns a plain-text user message into blocks with the note first", () => {
    const out = withInterruptedNotes([cut, { role: "user", content: "写短一点" }]);
    expect(out[1].content).toEqual([{ type: "text", text: INTERRUPTED_NOTE }, { type: "text", text: "写短一点" }]);
  });
});

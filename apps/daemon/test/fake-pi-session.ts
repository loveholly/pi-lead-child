// 按 pi 的语义写的假 Lead 会话（工单 04 的场景测试用）。它不调模型，但输入的放置和 pi 一样
// （pi-agent-core 的 agent-loop.js、pi-coding-agent 的 agent-session.js）：
//   · prompt(text)：一次运行开始。先送这条用户消息，再取插话队列里已有的插话，然后调第一次模型；
//   · 每次送进一条用户消息都发 message_start 和 message_end（role=user），daemon 据此知道插话、排队消息什么时候送到；
//   · 每次调模型时，记下这一次新送进来的输入里的当前局面（daemon 放在每一轮输入开头的 <system_event kind="situation">）；
//   · 这次回答调了工具：工具做完以后取插话，有插话就送进去，再调一次模型；
//   · 这次回答没有调工具（最后的回答）：先取插话；没有插话时取排队消息（followUpMode=all：全部一起送），再调一次模型；
//     都没有时这次运行结束；
//   · steer、followUp 只是入队；clearQueue 取出并清空队列（只还回文字，图片跟着丢掉）；
//   · prompt、steer、followUp 带的图片和那条消息一起送进上下文（消息的 content 里文字后面跟着图片块，和 pi 一样）；
//   · abort()：中断正在等的回答，发 stopReason=aborted 的 message_end，等这次运行结束才返回。
// script 决定每一次调模型的回答。回答可以先说一段、等一个 Promise（测试在这时发消息）、再接着说。

export interface FakeCall {
  index: number;
  // 这一次调模型之前新送进来的用户消息（prompt、插话、排队消息），按送到的顺序。
  inputs: string[];
  // 这些输入里的当前局面（最后一份），没有时是 null。
  situation: string | null;
  // 和这些输入一起送进来的图片，按送到的顺序。
  images: FakeImage[];
}

export interface FakeImage {
  type: "image";
  data: string;
  mimeType: string;
}

const SITUATION = /<system_event kind="situation"[^>]*>\n([\s\S]*?)\n<\/system_event>/gu;

/** 一段输入里 daemon 放的当前局面（最后一份），没有时是 null。 */
export function situationIn(text: string): string | null {
  const found = [...text.matchAll(SITUATION)];
  return found.length ? found.at(-1)![1]! : null;
}

export interface FakeReply {
  // 说的话。字符串之间可以夹 Promise：说到这里先等它。
  say?: string | Array<string | Promise<unknown>>;
  // 说完以后调的工具（每个一次）。调了工具的回答不是最后的回答。
  tools?: string[];
  // 这次调模型以这个错误结束（stopReason=error），这次运行也结束。
  error?: string;
  // 上下文满了（pi 的溢出恢复）：回答被截成空的（stopReason=length，没有内容），pi 接着做一次溢出压缩，
  // 压缩以这个 errorMessage 失败，这次运行结束（2026-10-28 的停摆）。
  cutOff?: string;
}

export type FakeScript = (call: FakeCall) => FakeReply | Promise<FakeReply>;

export interface FakePiLeadOptions {
  // 不支持 clearQueue（老的会话端口）。
  noClearQueue?: boolean;
  // 送进上下文时不发 message_start 的输入（模拟 daemon 没认出来的送到，例如 pi 改写了原文）。
  silentDelivery?: (text: string) => boolean;
  // 会话的 SmartModel（真的会话是 Lead 的 smart-model.ts）。测试给一个替身，不调真的 Jev 或 LLM。
  smartModel?: unknown;
  // 会话的便宜模型的自由文本补全（smart-model.ts 的 complete）。测试给一个替身。
  complete?: unknown;
  // 手动压缩（pi 的 session.compact(customInstructions)）怎样结束：返回就算成功，抛错就算失败（错误原文是 pi 的 errorMessage）。
  // 不给时会话没有 compact。
  compact?: (instructions: string | undefined) => void | Promise<void>;
  // 会话的上下文窗口和最近一次回答用了多少 token（daemon 的 leadContextUsage 读 model.contextWindow 和最后一条回答的 usage）。
  contextUsage?: { window: number; tokens: number };
}

export function fakePiLead(script: FakeScript, options: FakePiLeadOptions = {}) {
  let listeners: Array<(event: any) => void> = [];
  const calls: FakeCall[] = [];
  const prompts: string[] = [];
  let steering: string[] = [];
  let followUps: string[] = [];
  let pendingInputs: string[] = [];
  let pendingImages: FakeImage[] = [];
  // 带着图片交进来、还没送到的消息：原文 → 图片。
  const imagesOf = new Map<string, FakeImage[]>();
  const withImages = (text: string, images: FakeImage[] | undefined) => { if (images?.length) imagesOf.set(text, images); };
  let abortRun: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let deps: any = {};
  const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };

  const deliver = (texts: string[]) => {
    for (const text of texts) {
      const images = imagesOf.get(text) ?? [];
      imagesOf.delete(text);
      pendingImages.push(...images);
      const message = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
      if (!options.silentDelivery?.(text)) {
        emit({ type: "message_start", message });
        emit({ type: "message_end", message });
      }
      pendingInputs.push(text);
    }
  };
  const takeSteering = () => { const taken = steering; steering = []; return taken; };
  const takeFollowUps = () => { const taken = followUps; followUps = []; return taken; };

  // 等 promise，或者等 abort。
  const waitOrAbort = (promise: Promise<unknown>, aborted: Promise<"aborted">) =>
    Promise.race([promise.then(() => "done" as const), aborted]);

  async function run(text: string): Promise<void> {
    let abortNow!: () => void;
    const aborted = new Promise<"aborted">((resolve) => { abortNow = () => resolve("aborted"); });
    abortRun = abortNow;
    const end = (stopReason: "aborted" | "error", errorMessage?: string) => emit({
      type: "message_end",
      message: { role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}), content: [] },
    });
    deliver([text]);
    deliver(takeSteering());
    for (;;) {
      const call: FakeCall = {
        index: calls.length, inputs: pendingInputs,
        situation: pendingInputs.map(situationIn).filter((text): text is string => text !== null).at(-1) ?? null,
        images: pendingImages,
      };
      pendingInputs = [];
      pendingImages = [];
      calls.push(call);
      const answer = Promise.resolve(script(call));
      if (await waitOrAbort(answer, aborted) === "aborted") { end("aborted"); return; }
      const reply = await answer;
      if (reply.error) { end("error", reply.error); return; }
      if (reply.cutOff !== undefined) {
        emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [], usage: { input: 4, output: 1 } } });
        emit({ type: "compaction_start", reason: "overflow" });
        emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true, errorMessage: reply.cutOff });
        return;
      }
      const parts = reply.say === undefined ? [] : typeof reply.say === "string" ? [reply.say] : reply.say;
      let said = "";
      for (const part of parts) {
        if (typeof part === "string") {
          said += part;
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: part } });
        } else if (await waitOrAbort(part, aborted) === "aborted") {
          end("aborted");
          return;
        }
      }
      const tools = reply.tools ?? [];
      emit({
        type: "message_end",
        message: {
          role: "assistant", stopReason: tools.length ? "toolUse" : "stop",
          content: [
            ...(said ? [{ type: "text", text: said }] : []),
            ...tools.map((name, n) => ({ type: "toolCall", id: `call-${calls.length}-${n}`, name, arguments: {} })),
          ],
        },
      });
      for (const [n, name] of tools.entries()) {
        const toolCallId = `call-${calls.length}-${n}`;
        emit({ type: "tool_execution_start", toolCallId, toolName: name, args: {} });
        emit({ type: "tool_execution_end", toolCallId, toolName: name, args: {}, result: { content: [{ type: "text", text: "ok" }] }, isError: false });
      }
      const steered = takeSteering();
      if (steered.length) { deliver(steered); continue; }
      if (tools.length) continue;
      const queued = takeFollowUps();
      if (queued.length) { deliver(queued); continue; }
      return;
    }
  }

  const factory = async (args: any) => {
    deps = args;
    return {
      modelName: "stub/model",
      // 和 pi 一样：用户消息送进上下文时发 message_start。
      reportsInputDelivery: true,
      ...(options.smartModel !== undefined ? { smartModel: options.smartModel } : {}),
      ...(options.complete !== undefined ? { complete: options.complete } : {}),
      session: {
        sessionId: "fake-pi-session",
        ...(options.contextUsage ? {
          model: { contextWindow: options.contextUsage.window },
          agent: { state: { messages: [{ role: "assistant", usage: { input: options.contextUsage.tokens, output: 0, cacheRead: 0 } }] } },
        } : {}),
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        prompt(text: string, options?: { images?: FakeImage[] }) {
          prompts.push(text);
          withImages(text, options?.images);
          running = run(text).finally(() => { abortRun = null; });
          return running;
        },
        async steer(text: string, images?: FakeImage[]) { withImages(text, images); steering.push(text); return "queued"; },
        async followUp(text: string, images?: FakeImage[]) { withImages(text, images); followUps.push(text); return "queued"; },
        ...(options.noClearQueue ? {} : {
          // 和 pi 一样只还回文字：排着的消息带的图片跟着队列一起丢掉（pi 的 agent.clearAllQueues）。放回去时要重新带上。
          clearQueue() {
            const cleared = { steering, followUp: followUps };
            for (const text of [...steering, ...followUps]) imagesOf.delete(text);
            steering = [];
            followUps = [];
            return cleared;
          },
        }),
        ...(options.compact ? {
          // 和 pi 的 AgentSession.compact 一样：发 compaction_start（manual），结束时发 compaction_end，失败时抛错。
          async compact(instructions?: string) {
            emit({ type: "compaction_start", reason: "manual" });
            try {
              await options.compact!(instructions);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage });
              throw error;
            }
            emit({
              type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
              result: { summary: "摘要", firstKeptEntryId: "entry-1", tokensBefore: 480_000 },
            });
          },
        } : {}),
        async abort() {
          abortRun?.();
          await running;
        },
        dispose() {
          listeners = [];
          abortRun?.();
        },
      },
    };
  };

  return {
    factory,
    calls,
    prompts,
    // 现在 pi 队列里排着的插话和排队消息。
    queued: () => ({ steering: [...steering], followUp: [...followUps] }),
    // daemon 交给会话工厂的依赖（currentTurnId……）。
    deps: () => deps,
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

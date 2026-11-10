// 打断式插话（用户 2026-11-09：「可以支持打断式插话，但是需要注意让 lead agent 不能遗漏打断前的任务」）。
//
// pi 1.1 只在一步做完以后取插话：一步是一次模型回答加上它调的全部工具（pi-agent-core 的 agent-loop.js）。
// 模型还在想（high 推理一步常要十几秒到几分钟）或者在写长文时，插话只能等。pi 没有现成的「打断式插话」开关，
// 但它自带的几件东西拼起来就是：
//   1. steer() 把插话放进队列（daemon 照旧调）；
//   2. 只中止这一步的模型请求：这里给 agent 的 streamFunction 包一层，每次对话循环的请求带一个自己的中止信号。
//      中止它只结束这一次流，不碰这次运行的中止信号，所以正在跑的工具、压缩都不受影响；
//   3. 这一步结束以后 pi 取队列里的插话，送进去再调一次模型。整个过程在同一次 session.prompt() 里。
//
// 这一步在什么状态，就怎样结束：
//   · 还没写出看得见的字，也没开始调工具（模型在想）：中止，pi-ai 记成 stopReason=aborted。pi 结束这次运行，看到队列里有插话
//     就自己 continue()（agent-session.js 的 _handlePostAgentRun），continue() 先把插话送进去，再调一次模型。
//     中止的那半步不会再发给模型（pi-ai 的 transform-messages.js 跳过 aborted 的助手消息）：上下文里是原来的任务、做完的工具和结果，
//     然后是插话，和在一步的边界插进去完全一样。
//     还没收到回答的开头（没有 message_start）也能中止（2026-11-09）：vibeproxy 这类代理要等模型想完、吐出第一个字
//     才回响应头。这时 pi 照样补一对 message_start / message_end（agent-loop.js 的 streamAssistantResponse）。
//   · 已经写出了字，还没开始调工具（2026-11-10 插话验收：写长文时插话要等整篇写完，「写短一点」5 轮里 4 轮先写完 2000 字）：
//     中止，但不把 pi-ai 的 aborted 结尾交给对话循环，改成一条正常结束的助手消息（stopReason=stop）：内容是到中止为止收到的字
//     和写完的思考，带标记 interruptedBy="steer"。界面已经显示了这些字，模型也记得它们，两边一致。
//     对话循环照常往下走：取插话，送进去，再请求一次（同一次运行，不经过 continue()）。标记存进会话文件，重启以后还在。
//     发给模型时（agent 的 transformContext，只改发出去的那一份），被打断的那条后面的第一条用户消息前面加一段说明（INTERRUPTED_NOTE）。
//   · 开始调工具：工具调用的参数在流，render_ui 的卡片也在画。参数写到一半不能执行，也不能交给模型：等这一步做完再插。
// 压缩和摘要也用 agent 的 streamFunction（agent-session.js 的 _runDefaultCompaction），它们不带对话循环的
// getSteeringMessages：只包对话循环的请求，压缩照旧做完。
import { leadSystemEvent } from "./envelope.js";

export interface StepInterruptAgent {
  // pi-agent-core 的 Agent.streamFunction：(model, context, options) => 流（可能是 Promise）。
  streamFunction: (model: any, context: any, options?: any) => any;
  // pi-agent-core 的 Agent.transformContext：每次请求前改发给模型的消息（pi 自己也在这条链上，agent-session.js）。
  transformContext?: ((messages: any[], signal?: AbortSignal) => any[] | Promise<any[]>) | undefined;
}

export interface StepInterruptSession {
  agent: StepInterruptAgent;
}

export interface StepInterrupt {
  // 这一步的模型请求还能中止时（在想，或者在写字、还没调工具）中止它，返回 true；pi 接着把排着的插话送进去再调模型。
  // 否则什么也不做，返回 false。
  interrupt(): boolean;
}

// 被插话打断、写出的字留在上下文里的助手消息带这个标记（会话文件里也有）。daemon 在 message_end 上认它。
export const STEP_INTERRUPTED_BY_STEER = "steer";

export function isInterruptedForSteer(message: unknown): boolean {
  return (message as { interruptedBy?: unknown } | null)?.interruptedBy === STEP_INTERRUPTED_BY_STEER;
}

// 发给模型时加在插话前面的说明。daemon 的插话说明（server.ts 的 steerNote）说插话之前在做什么、要接着做完；
// 这一段只说被打断的那条回答：它停在哪里，用户看到了什么，接着做时不要从头重复。
// 默认「接着写剩下的部分」（.scratch/steer-during-text/proposal.md 的「默认值」）：用户刚看到那半篇，从头重写等于让用户读两遍。
// 从断掉的那一段的开头写起（2026-11-10 开发模式验证）：只说「从断的地方接着写」时，模型从断开的那个字接着写
// （上一条停在「(H」，新的一条从「otSpot 默认上限是 15)」开始），新的那条单独读不通。重写一段，最多重复一段。
export const INTERRUPTED_NOTE = leadSystemEvent("steer", [
  "你上一条回答写到一半时被用户打断了：后面那句话进来时，那条回答停在了上面这些字（可能停在半句）。用户已经看到了这些字。",
  "先按后面那句话做。原来的事还要做时，接着写剩下的部分：从断掉的那一段的开头写起，把这一段完整地写一遍，再往下写；"
    + "前面已经写完的段落不要再写。那句话要你重写（例如写短一点）时，按它写新的一版。",
].join("\n"));

type Step = {
  controller: AbortController;
  // 写出了看得见的字（text_delta 带字）。思考（thinking_*）和流的开头（start）不算。
  wrote: boolean;
  // 开始调工具（toolcall_*）。
  calling: boolean;
  // 要求了「留下写出的字」的中止。
  keepText: boolean;
  // 写完的思考块（thinking_end），按 contentIndex。写到一半的思考块不留。
  closedThinking: Set<number>;
  // 这一步的流结束了：没有可以中止的模型请求了。
  ended: boolean;
};

export function installStepInterrupt(session: StepInterruptSession): StepInterrupt {
  let step: Step | null = null;
  const agent = session.agent;
  const original = agent.streamFunction.bind(agent);
  agent.streamFunction = (model, context, options) => {
    // 不是对话循环的请求（压缩、摘要）：原样转过去，不能打断。
    if (typeof options?.getSteeringMessages !== "function") return original(model, context, options);
    const current: Step = {
      controller: new AbortController(), wrote: false, calling: false, keepText: false, closedThinking: new Set(), ended: false,
    };
    step = current;
    const signal: AbortSignal = options.signal
      ? AbortSignal.any([options.signal as AbortSignal, current.controller.signal])
      : current.controller.signal;
    const response = original(model, context, { ...options, signal });
    const finish = (stream: any) => watchStep(stream, current);
    return typeof response?.then === "function" ? Promise.resolve(response).then(finish) : finish(response);
  };
  const previousTransform = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
    return withInterruptedNotes(transformed);
  };
  return {
    interrupt() {
      const current = step;
      if (!current || current.ended || current.calling || current.controller.signal.aborted) return false;
      current.keepText = current.wrote;
      current.controller.abort();
      return true;
    },
  };
}

// 包住这一步的流：记下这一步写到了哪里（写字、调工具、写完的思考），被要求留下写出的字时，把 pi-ai 的 aborted 结尾换成正常结束。
// 对话循环只用流的两样东西：for await 取事件，result() 取最后的消息（agent-loop.js 的 streamAssistantResponse）。
function watchStep(stream: any, current: Step): any {
  let kept: any = null;
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of stream) {
          const type = String(event?.type ?? "");
          if (type === "text_delta" && event.delta) current.wrote = true;
          else if (type.startsWith("toolcall_")) current.calling = true;
          else if (type === "thinking_end" && typeof event.contentIndex === "number") current.closedThinking.add(event.contentIndex);
          if (type === "done" || type === "error") current.ended = true;
          if (type === "error" && event.reason === "aborted" && current.keepText && !current.calling) {
            kept = keptMessage(event.error, current.closedThinking);
            if (kept) {
              yield { type: "done", reason: "stop", message: kept };
              return;
            }
          }
          yield event;
        }
      } finally {
        current.ended = true;
      }
    },
    result: async () => kept ?? await stream.result(),
  };
}

// 中止时 pi-ai 交回的那条消息（stopReason=aborted，content 是到中止为止收到的全部内容），改成一条正常结束的回答：
// 留下有字的文字块和写完的思考块（带着签名，原样留下），去掉写到一半的思考块和工具调用；没有字时返回 null（按 aborted 结束）。
function keptMessage(aborted: any, closedThinking: ReadonlySet<number>): any {
  const content = (Array.isArray(aborted?.content) ? aborted.content : []).filter((block: any, index: number) =>
    block?.type === "text" ? typeof block.text === "string" && block.text.length > 0
      : block?.type === "thinking" ? closedThinking.has(index)
        : false);
  if (!content.some((block: any) => block.type === "text")) return null;
  const { errorMessage: _errorMessage, ...rest } = aborted;
  return { ...rest, content, stopReason: "stop", interruptedBy: STEP_INTERRUPTED_BY_STEER };
}

// 发给模型的那一份里，被打断的助手消息后面的第一条用户消息（插话）前面加 INTERRUPTED_NOTE。只看会话里的标记：
// 同一段历史每次都得到同一份（不破坏提示缓存），重启以后也一样。不改原来的消息对象。
export function withInterruptedNotes(messages: any[]): any[] {
  let pending = false;
  let changed = false;
  const result = messages.map((message) => {
    if (message?.role === "assistant") {
      pending = isInterruptedForSteer(message);
      return message;
    }
    if (!pending || message?.role !== "user") return message;
    pending = false;
    changed = true;
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    return { ...message, content: [{ type: "text", text: INTERRUPTED_NOTE }, ...content] };
  });
  return changed ? result : messages;
}

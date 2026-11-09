// 打断式插话（用户 2026-11-09：「可以支持打断式插话，但是需要注意让 lead agent 不能遗漏打断前的任务」）。
//
// pi 1.1 只在一步做完以后取插话：一步是一次模型回答加上它调的全部工具（pi-agent-core 的 agent-loop.js）。
// 模型还在想（high 推理一步常要十几秒到几分钟）时，插话只能等。pi 没有现成的「打断式插话」开关，
// 但它自带的三件东西拼起来就是：
//   1. steer() 把插话放进队列（daemon 照旧调）；
//   2. 只中止这一步的模型请求：这里给 agent 的 streamFunction 包一层，每次对话循环的请求带一个自己的中止信号。
//      中止它只结束这一次流（stopReason=aborted），不碰这次运行的中止信号，所以正在跑的工具、压缩都不受影响；
//   3. pi 结束这次运行以后，看到队列里有插话就自己 continue()（agent-session.js 的 _handlePostAgentRun），
//      continue() 发现最后一条是助手消息，先把插话送进去，再调一次模型。整个过程在同一次 session.prompt() 里。
// 中止的那半步不会再发给模型（pi-ai 的 transform-messages.js 跳过 aborted 的助手消息）：上下文里是原来的任务、
// 做完的工具和结果，然后是插话，和在一步的边界插进去完全一样。之前做的事一件不少，只有没想完的那一步要重想。
//
// 只在这一步还「干净」时中止：模型已经开始回答（message_start），但还没写出看得见的字，也没开始调工具。
//   · 写出了字：那些字已经流到会话里，中止以后模型不记得它们，会话里就留下一段没人认的话。等这一步写完再插。
//   · 开始调工具：工具调用的参数在流，render_ui 的卡片也在画。等这一步做完再插。
//   · 准备请求的阶段（还没有 message_start）：中止会被 pi-ai 记成 stopReason=error，可能触发自动重试。等它开始。
// 压缩和摘要也用 agent 的 streamFunction（agent-session.js 的 _runDefaultCompaction），它们不带对话循环的
// getSteeringMessages：只包对话循环的请求，压缩照旧做完。
export interface StepInterruptAgent {
  // pi-agent-core 的 Agent.streamFunction：(model, context, options) => 流（可能是 Promise）。
  streamFunction: (model: any, context: any, options?: any) => any;
}

export interface StepInterruptSession {
  agent: StepInterruptAgent;
  subscribe(listener: (event: any) => void): () => void;
}

export interface StepInterrupt {
  // 这一步还干净时中止它的模型请求，返回 true；pi 接着把排着的插话送进去再调模型。否则什么也不做，返回 false。
  interrupt(): boolean;
}

// 看得见的东西：文字和工具调用。思考（thinking_*）和流的开头（start）不算。
const VISIBLE_EVENTS = new Set(["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"]);

export function installStepInterrupt(session: StepInterruptSession): StepInterrupt {
  type Step = { controller: AbortController; started: boolean; visible: boolean };
  let step: Step | null = null;
  const original = session.agent.streamFunction.bind(session.agent);
  session.agent.streamFunction = (model, context, options) => {
    // 不是对话循环的请求（压缩、摘要）：原样转过去，不能打断。
    if (typeof options?.getSteeringMessages !== "function") return original(model, context, options);
    const current: Step = { controller: new AbortController(), started: false, visible: false };
    step = current;
    const signal: AbortSignal = options.signal
      ? AbortSignal.any([options.signal as AbortSignal, current.controller.signal])
      : current.controller.signal;
    return original(model, context, { ...options, signal });
  };
  session.subscribe((event) => {
    if (!step || event?.message?.role === "user") return;
    if (event?.type === "message_start" && event.message?.role === "assistant") step.started = true;
    if (event?.type === "message_update" && VISIBLE_EVENTS.has(String(event.assistantMessageEvent?.type))) step.visible = true;
    if (event?.type === "message_end" && event.message?.role === "assistant") step = null;
  });
  return {
    interrupt() {
      const current = step;
      if (!current || !current.started || current.visible || current.controller.signal.aborted) return false;
      current.controller.abort();
      return true;
    },
  };
}

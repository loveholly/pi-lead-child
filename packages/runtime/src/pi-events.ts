// pi 的原生事件到 RuntimeEvent 的映射。pi.ts 的 RPC adapter 和进程内的代查 runtime（lead 的 lookup/）共用它。
//
// 两种来源的事件形状（2026-10-19 用 pi-coding-agent 1.1.0 的代码核对）：
//   - RPC 模式把会话事件原样写成一行 JSON（modes/rpc/rpc-mode.js 的 session.subscribe → toJsonEvent）。
//   - 进程内是 AgentSession.subscribe 直接给的事件。
// 只有 message_update 不一样：toJsonEvent（modes/json-event.js）去掉了 message 和 assistantMessageEvent.partial，
// 只留 usage 和增量。这里只读两边都有的字段（assistantMessageEvent.type、delta，message 只当可选的 id 来源），
// 所以同一份代码处理两种来源。agent_start、message_end、tool_execution_*、agent_end、agent_settled 两边一样。
import type { RuntimeId } from "@pi-lead-child/core";
import type { RuntimeEventInput } from "./types.js";

export function piMessageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? [])
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text ?? ""))
    .join("");
}

export interface PiEventMapperOptions {
  runId: number;
  // run.started 报的 runtime。
  runtime: RuntimeId;
  model: string | null;
  // 交出一个非终止事件。调用方在 Run 已经结束后丢掉它。
  emit(event: RuntimeEventInput): void;
  // 回合结束：agent_end 不再重试，或者 agent_settled。llmError 是回合以 LLM 错误结束时的错误文本，否则为 null。
  // 调用方据此给出 run.completed 或类型化的 run.failed。
  settle(llmError: string | null): void;
}

/**
 * 返回一个处理 pi 原生事件的函数。它记着两件事：是否已经报告过 run.started，和最近一条以 LLM 错误结束的助手消息。
 *
 * pi 的 LLM 错误（工单 13，spec D1）是一条 stopReason=error 的助手消息，错误文本在 errorMessage 里，随后是 agent_end。
 * pi 自己重试一部分错误（满载、断网）。这时 agent_end 带 willRetry=true，pi 接着开始新的一轮。
 * 所以错误消息先留着，到 agent_end 才决定：
 * - pi 要重试：不报告这条消息，只记一条诊断。pi 也从对话里去掉失败的这一轮（_omitRecoveryAttempt）。
 * - pi 不重试：报告这条消息，然后 settle(错误文本)。
 */
export function createPiEventMapper(options: PiEventMapperOptions): (native: any) => void {
  const { runId, emit } = options;
  let started = false;
  // 回合已经结束：之后的事件不再映射（调用方这时已经交出了终止事件）。
  let settled = false;
  // message 是还没报告的原生消息，pi 重试时丢掉它。
  let lastError: { text: string; message: any } | null = null;

  // pi 的 message.usage 是这一次 API 调用的用量，不是累计（工单 #102：Run #111 的值从 59,152 掉到 41,950），所以按 delta 报。
  const emitUsage = (message: any): void => {
    if (!message.usage) return;
    emit({
      type: "usage.updated",
      mode: "delta",
      inputTokens: Number(message.usage.input ?? 0),
      outputTokens: Number(message.usage.output ?? 0),
      totalTokens: Number(message.usage.totalTokens ?? 0),
      costUsd: typeof message.usage.cost?.total === "number" ? message.usage.cost.total : null,
    });
  };
  // 一条助手消息：消息事件和它的用量。
  const emitAssistant = (message: any): void => {
    emit({
      type: "message.completed",
      messageId: String(message.id ?? `message-${runId}`),
      role: "assistant",
      text: piMessageText(message),
      stopReason: message.stopReason ? String(message.stopReason) : undefined,
    });
    emitUsage(message);
  };
  const settle = (): void => {
    settled = true;
    if (lastError === null) {
      options.settle(null);
      return;
    }
    if (lastError.message) emitAssistant(lastError.message);
    options.settle(lastError.text);
  };

  return (native: any): void => {
    if (settled) return;
    switch (native?.type) {
      case "agent_start":
        // pi 重试时会再发一次 agent_start。这仍是同一个 Run。
        if (started) break;
        started = true;
        emit({ type: "run.started", runtime: options.runtime, model: options.model });
        break;
      case "message_update":
        if (native.assistantMessageEvent?.type === "text_delta") {
          emit({
            type: "message.delta",
            messageId: String(native.message?.id ?? `message-${runId}`),
            delta: String(native.assistantMessageEvent.delta ?? ""),
          });
        }
        break;
      case "message_end": {
        const message = native.message ?? {};
        if (message.role !== "assistant") break;
        if (message.stopReason === "error") {
          lastError = { text: String(message.errorMessage || "pi assistant message ended with stopReason=error"), message };
          break;
        }
        lastError = null;
        emitAssistant(message);
        break;
      }
      case "tool_execution_start":
        emit({
          type: "tool.started", callId: String(native.toolCallId ?? "unknown"),
          name: String(native.toolName ?? "unknown"), args: native.args ?? {},
        });
        break;
      case "tool_execution_update":
        emit({
          type: "tool.updated", callId: String(native.toolCallId ?? "unknown"),
          name: String(native.toolName ?? "unknown"), update: native.partialResult ?? native,
        });
        break;
      case "tool_execution_end":
        emit(native.isError ? {
          type: "tool.failed", callId: String(native.toolCallId ?? "unknown"),
          name: String(native.toolName ?? "unknown"), error: JSON.stringify(native.result ?? native.error ?? "tool failed"),
        } : {
          type: "tool.completed", callId: String(native.toolCallId ?? "unknown"),
          name: String(native.toolName ?? "unknown"), result: native.result ?? {},
        });
        break;
      case "agent_end":
        if (native.willRetry === true) {
          if (lastError?.message) emitUsage(lastError.message);
          if (lastError) lastError.message = null;
          emit({ type: "runtime.stderr", text: `pi retries after an LLM error: ${lastError?.text ?? "unknown"}\n` });
          break;
        }
        settle();
        break;
      // pi 1.1.0 不再自动继续。agent_end 说了 willRetry=true，重试却没有开始时（例如用户中止了它），Run 在这里结束。
      case "agent_settled":
        settle();
        break;
    }
  };
}

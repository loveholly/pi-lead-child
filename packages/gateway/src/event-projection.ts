import type { ItemOperationState } from "@pi-lead-child/core";
import { isSensitiveFieldName, REDACTED, redactAndCap } from "@pi-lead-child/protocol";

export interface ProjectionLimits {
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
}

export function redactProtocolValue(value: unknown, limits: ProjectionLimits = {}): unknown {
  const maxDepth = limits.maxDepth ?? 6;
  const maxEntries = limits.maxEntries ?? 50;
  const maxStringLength = limits.maxStringLength ?? 4_000;
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    // 字段名和字符串里的密钥都用 protocol 的同一套规则（redaction.ts），落库和推送之前就去掉。
    // 先截断再脱敏：这里在 daemon 的同步事件路径上。
    if (typeof current === "string") {
      const clean = redactAndCap(current, maxStringLength);
      return clean.truncated ? `${clean.text}...[TRUNCATED]` : clean.text;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") return current;
    if (current === undefined) return null;
    if (typeof current === "bigint") return String(current);
    if (typeof current !== "object") return String(current);
    if (Buffer.isBuffer(current)) return `[BINARY ${current.byteLength} BYTES]`;
    if (current instanceof ArrayBuffer) return `[BINARY ${current.byteLength} BYTES]`;
    if (ArrayBuffer.isView(current)) return `[BINARY ${current.byteLength} BYTES]`;
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      const projected = current.slice(0, maxEntries).map((item) => visit(item, depth + 1));
      if (current.length > maxEntries) projected.push(`[${current.length - maxEntries} MORE ITEMS]`);
      return projected;
    }

    const projected: Record<string, unknown> = {};
    const entries = Object.entries(current).slice(0, maxEntries);
    for (const [key, item] of entries) {
      projected[key] = isSensitiveFieldName(key) ? REDACTED : visit(item, depth + 1);
    }
    if (Object.keys(current).length > maxEntries) projected.__truncated__ = true;
    return projected;
  }

  return visit(value, 0);
}

export function projectToolOperationState(event: any): ItemOperationState | undefined {
  if (["tool_execution_start", "tool.started", "lead.tool.started"].includes(event?.type)) {
    return "started";
  }
  if (["tool_execution_update", "tool.updated", "lead.tool.updated"].includes(event?.type)) {
    return "running";
  }
  if (["tool.failed", "lead.tool.failed"].includes(event?.type)) return "failed";
  if (["tool.completed", "lead.tool.completed"].includes(event?.type)) return "completed";
  if (event?.type === "tool_execution_end") return event.isError ? "failed" : "completed";
  return undefined;
}

export function projectToolEvent(event: any): Record<string, unknown> {
  const operationState = projectToolOperationState(event);
  return {
    toolCallId: String(event.callId ?? event.toolCallId ?? "unknown"),
    toolName: String(event.name ?? event.toolName ?? "unknown"),
    ...(operationState === undefined ? {} : { operationState }),
    ...(event.args === undefined ? {} : { args: redactProtocolValue(event.args) }),
    ...((event.update ?? event.partialResult) === undefined ? {} : {
      partialResult: redactProtocolValue(event.update ?? event.partialResult),
    }),
    ...(event.result === undefined ? {} : { result: redactProtocolValue(event.result) }),
    ...((event.type === "tool.failed" || event.isError !== undefined) ? {
      isError: event.type === "tool.failed" || Boolean(event.isError),
    } : {}),
    // runtime 的 tool.failed 只在 error 里说为什么失败（没有 result）。
    ...(typeof event.error === "string" && event.error ? { error: redactProtocolValue(event.error) } : {}),
  };
}

export function assistantMessageText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

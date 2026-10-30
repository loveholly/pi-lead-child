import { Type, type Static, type TProperties } from "typebox";

import { isSensitiveFieldName, REDACTED, redactAndCap } from "./redaction.ts";

// 一轮对话里的工具调用（任务卡的步骤）。
//
// 实时：客户端收到 lead.tool.* 和 child.tool.* 事件，每收到一条就用 foldToolCall 更新这一次调用。
// 刷新：GET /v1/conversation/turns?include=tool_calls 的每一轮带 toolCalls。服务端用 foldTurnToolCalls
// 把 gateway_events 里这一轮的同一批事件折叠成同样的结果。两边是同一个函数、同一批事件，所以刷新以后的
// 任务卡和实时看到的一样。
//
// textOffset 是这次调用开始时，这一轮的回复已经有多少字（JS 字符串长度）。客户端按它把回复切成
// 「工具之间的话」和「最后一个工具之后的回复」，所以文字和工具调用的先后和事件的先后一致。
//
// 线上词汇：这里没有 item/run。child.tool.* 的 payload 里讲 attemptId，那是线上的名字
// （内部叫 run，映射见 packages/core/src/wire-vocabulary.ts）。

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 展开一步时显示的参数和结果的上限（字符）。快照和实时都截到这个长度，所以两边看到的一样。
export const TOOL_CALL_DISPLAY_LIMIT = 2_000;

export const ToolDisplayProjectionSchema = StrictObject({
  preview: Type.String(),
  truncated: Type.Boolean(),
  redacted: Type.Boolean(),
  artifactRefs: Type.Array(Type.String()),
});
export type ToolDisplayProjection = Static<typeof ToolDisplayProjectionSchema>;

export const ToolCallStateSchema = Type.Union([
  Type.Literal("started"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"),
]);
export type ToolCallState = Static<typeof ToolCallStateSchema>;

export const ConversationToolCallSchema = StrictObject({
  callId: Type.String(),
  name: Type.String(),
  state: ToolCallStateSchema,
  textOffset: Type.Integer({ minimum: 0 }),
  args: Type.Union([ToolDisplayProjectionSchema, Type.Null()]),
  result: Type.Union([ToolDisplayProjectionSchema, Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.String(),
  endedAt: Type.Union([Type.String(), Type.Null()]),
});
export type ConversationToolCall = Static<typeof ConversationToolCallSchema>;

export type ToolCallPhase = "started" | "updated" | "completed" | "failed";

// 一条工具事件里折叠要用的部分。参数和结果已经投影成展示文本（脱敏、有上限）。
export interface ToolCallUpdate {
  phase: ToolCallPhase;
  occurredAt: string;
  callId: string;
  name: string;
  args: ToolDisplayProjection | null;
  result: ToolDisplayProjection | null;
  isError: boolean;
  errorText: string | null;
  textOffset: number | null;
}

// 账本里的一条事件，只要折叠用得到的字段。
export interface TurnToolEvent {
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

const PHASE_BY_SUFFIX: Record<string, ToolCallPhase> = {
  started: "started",
  updated: "updated",
  completed: "completed",
  failed: "failed",
};

function toolPhase(type: string): ToolCallPhase | null {
  const match = /^(?:lead|child)\.tool\.(\w+)$/.exec(type);
  return match ? PHASE_BY_SUFFIX[match[1]!] ?? null : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// 一条工具事件（lead.tool.* 或 child.tool.*）在折叠里的样子。不是工具事件时返回 null。
// fallbackOffset 给没有 textOffset 的旧事件用。
export function toolCallUpdateFromEvent(event: TurnToolEvent, fallbackOffset: number | null): ToolCallUpdate | null {
  const phase = toolPhase(event.type);
  if (!phase) return null;
  const payload = event.payload;
  if (typeof payload.toolCallId !== "string") return null;
  return {
    phase,
    occurredAt: event.occurredAt,
    callId: payload.toolCallId,
    name: typeof payload.toolName === "string" ? payload.toolName : "unknown",
    args: projectToolDisplay(payload.args),
    result: phase === "updated" ? null : projectToolDisplay(payload.result),
    isError: payload.isError === true,
    errorText: typeof payload.error === "string" && payload.error ? payload.error : null,
    textOffset: nonNegativeInteger(payload.textOffset) ?? fallbackOffset,
  };
}

// 把一条工具事件并进这次调用。
// - 开始事件带参数，结束事件带结果。结束事件没有参数时保留开始时的参数。
// - 进度事件（updated）不改调用，只在还没见过开始时先建出这次调用。
// - 已经结束的调用不再改。
export function foldToolCall(previous: ConversationToolCall | undefined, update: ToolCallUpdate): ConversationToolCall {
  if (previous && (previous.state === "completed" || previous.state === "failed")) return previous;
  const base: ConversationToolCall = previous ?? {
    callId: update.callId,
    name: update.name,
    state: "started",
    textOffset: update.textOffset ?? 0,
    args: capToolDisplay(update.args),
    result: null,
    error: null,
    startedAt: update.occurredAt,
    endedAt: null,
  };
  if (update.phase === "started" || update.phase === "updated") {
    return base.args || !update.args ? base : { ...base, args: capToolDisplay(update.args) };
  }
  const failed = update.phase === "failed" || update.isError;
  const result = capToolDisplay(update.result) ?? base.result;
  return {
    ...base,
    name: update.name === "unknown" ? base.name : update.name,
    state: failed ? "failed" : "completed",
    args: base.args ?? capToolDisplay(update.args),
    result,
    error: failed ? redactAndCap(update.errorText ?? result?.preview ?? "tool failed", TOOL_CALL_DISPLAY_LIMIT).text : null,
    endedAt: update.occurredAt,
  };
}

// 一轮的全部工具调用，按开始的先后。events 是这一轮在账本里的事件，按 seq 排。
// - lead.turn.started（mode=started）表示 daemon 重新打开了这一轮（系统回合重试），之前的调用作废。
// - 旧事件没有 textOffset：用它之前流出的 lead.message.delta 的总长度。
export function foldTurnToolCalls(events: readonly TurnToolEvent[]): ConversationToolCall[] {
  let calls: ConversationToolCall[] = [];
  let indexByCallId = new Map<string, number>();
  let textLength = 0;
  for (const event of events) {
    if (event.type === "lead.turn.started") {
      if (event.payload.mode === "started") {
        calls = [];
        indexByCallId = new Map();
        textLength = 0;
      }
      continue;
    }
    if (event.type === "lead.message.delta") {
      if (typeof event.payload.delta === "string") textLength += event.payload.delta.length;
      continue;
    }
    const update = toolCallUpdateFromEvent(event, textLength);
    if (!update) continue;
    const index = indexByCallId.get(update.callId);
    const next = foldToolCall(index === undefined ? undefined : calls[index], update);
    if (index === undefined) {
      indexByCallId.set(update.callId, calls.length);
      calls.push(next);
    } else {
      calls[index] = next;
    }
  }
  return calls;
}

// 截到展示上限。投影的开头不受截断影响，所以先投影再截和直接截的结果一样。
export function capToolDisplay(projection: ToolDisplayProjection | null): ToolDisplayProjection | null {
  if (!projection || projection.preview.length <= TOOL_CALL_DISPLAY_LIMIT) return projection;
  return { ...projection, preview: projection.preview.slice(0, TOOL_CALL_DISPLAY_LIMIT), truncated: true };
}

// ——— 展示投影 ———
// 工具的参数和结果在进入界面之前先变成有上限、已脱敏的文本。脱敏规则在 redaction.ts。

const ARTIFACT_KEY = /^(?:artifactId|artifact_id)$/i;

export function projectToolDisplay(value: unknown): ToolDisplayProjection | null {
  if (value === undefined || value === null) return null;
  const state = { redacted: false, truncated: false, artifactRefs: new Set<string>() };
  const sanitized = sanitize(value, state, null, 0);
  let preview = stringify(sanitized);
  if (preview.length > 16 * 1_024) {
    preview = preview.slice(0, 16 * 1_024);
    state.truncated = true;
  }
  return {
    preview,
    truncated: state.truncated,
    redacted: state.redacted,
    artifactRefs: [...state.artifactRefs].sort(),
  };
}

function sanitize(
  value: unknown,
  state: { redacted: boolean; truncated: boolean; artifactRefs: Set<string> },
  key: string | null,
  depth: number,
): unknown {
  if (key && isSensitiveFieldName(key)) {
    state.redacted = true;
    return REDACTED;
  }
  if (typeof value === "string") {
    if (key && ARTIFACT_KEY.test(key) && value) state.artifactRefs.add(value);
    if (value.length >= 256 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      state.redacted = true;
      state.truncated = true;
      return "[BINARY REDACTED]";
    }
    // 先截断再脱敏（redaction.ts 的 redactAndCap）：一个几 MB 的输出不会卡住事件路径。
    const clean = redactAndCap(value, 4_096);
    if (clean.redacted) state.redacted = true;
    if (clean.truncated) {
      state.truncated = true;
      return `${clean.text}...[TRUNCATED]`;
    }
    return clean.text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (depth >= 6) {
    state.truncated = true;
    return "[MAX DEPTH]";
  }
  if (Array.isArray(value)) {
    if (key && /artifactIds|artifact_ids/i.test(key)) {
      for (const item of value) if (typeof item === "string") state.artifactRefs.add(item);
    }
    if (value.length > 50) state.truncated = true;
    return value.slice(0, 50).map((item) => sanitize(item, state, null, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 50) state.truncated = true;
    return Object.fromEntries(entries.slice(0, 50).map(([childKey, child]) => [
      childKey,
      sanitize(child, state, childKey, depth + 1),
    ]));
  }
  return String(value);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch { return "[UNSERIALIZABLE]"; }
}

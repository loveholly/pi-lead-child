// 一轮对话里的工具调用：服务端从事件账本折叠出会话快照里的 toolCalls，客户端在实时事件上做同一个折叠。
// 两边用同一个函数，所以刷新以后的任务卡和实时看到的一样。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  ConversationTurnSchema,
  TOOL_CALL_DISPLAY_LIMIT,
  foldToolCall,
  foldTurnToolCalls,
  projectToolDisplay,
  toolCallUpdateFromEvent,
  type ConversationToolCall,
  type TurnToolEvent,
} from "../src/index.js";

const at = (second: number) => `2026-10-13T10:00:${String(second).padStart(2, "0")}.000Z`;

function event(type: TurnToolEvent["type"], second: number, payload: Record<string, unknown>): TurnToolEvent {
  return { type, occurredAt: at(second), payload };
}

describe("folding the tool calls of one turn", () => {
  it("keeps the arguments of the start and the result of the end, in the order the calls started", () => {
    const calls = foldTurnToolCalls([
      event("lead.turn.started", 0, { mode: "started" }),
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "query_tickets", args: { stage: "review" }, textOffset: 6 }),
      event("lead.tool.started", 2, { toolCallId: "b", toolName: "list_items", args: {}, textOffset: 6 }),
      event("lead.tool.completed", 3, { toolCallId: "b", toolName: "list_items", result: "[]", isError: false }),
      event("lead.tool.completed", 4, { toolCallId: "a", toolName: "query_tickets", result: { items: [] }, isError: false }),
    ]);

    expect(calls.map((call) => call.callId)).toEqual(["a", "b"]);
    expect(calls[0]).toEqual({
      callId: "a",
      name: "query_tickets",
      state: "completed",
      textOffset: 6,
      args: { preview: '{"stage":"review"}', truncated: false, redacted: false, artifactRefs: [] },
      result: { preview: '{"items":[]}', truncated: false, redacted: false, artifactRefs: [] },
      error: null,
      startedAt: at(1),
      endedAt: at(4),
    } satisfies ConversationToolCall);
  });

  it("marks a failed call and keeps why it failed", () => {
    const [lead, child] = foldTurnToolCalls([
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "spawn_child", args: { ticket_id: 7 }, textOffset: 0 }),
      event("lead.tool.failed", 2, { toolCallId: "a", toolName: "spawn_child", result: "ticket #7 is done", isError: true }),
      event("child.tool.started", 3, { attemptId: 4, toolCallId: "b", toolName: "Bash", args: { command: "npm test" }, textOffset: 0 }),
      event("child.tool.failed", 4, { attemptId: 4, toolCallId: "b", toolName: "Bash", isError: true, error: "exit code 1" }),
    ]);

    expect(lead).toMatchObject({ state: "failed", error: "ticket #7 is done", endedAt: at(2) });
    expect(child).toMatchObject({ name: "Bash", state: "failed", error: "exit code 1", args: { preview: '{"command":"npm test"}' } });
  });

  it("starts over when the daemon reopens the turn, but not when a message is steered into it", () => {
    const calls = foldTurnToolCalls([
      event("lead.turn.started", 0, { mode: "started" }),
      event("lead.tool.started", 1, { toolCallId: "old", toolName: "list_items", textOffset: 0 }),
      event("lead.turn.started", 5, { mode: "started" }),
      event("lead.tool.started", 6, { toolCallId: "new", toolName: "list_items", textOffset: 0 }),
      event("lead.turn.started", 7, { mode: "steered" }),
      event("lead.tool.started", 8, { toolCallId: "after-steer", toolName: "query_tickets", textOffset: 0 }),
    ]);

    expect(calls.map((call) => call.callId)).toEqual(["new", "after-steer"]);
  });

  it("finds where a call sits in the text from the streamed text when an older event has no offset", () => {
    const calls = foldTurnToolCalls([
      event("lead.turn.started", 0, { mode: "started" }),
      event("lead.message.delta", 1, { delta: "我先去" }),
      event("lead.message.delta", 1, { delta: "查一下。" }),
      event("lead.tool.started", 2, { toolCallId: "a", toolName: "query_tickets", args: {} }),
      event("lead.message.delta", 3, { delta: "\n\n" }),
      event("lead.tool.started", 4, { toolCallId: "b", toolName: "list_items", args: {} }),
    ]);

    expect(calls.map((call) => call.textOffset)).toEqual(["我先去查一下。".length, "我先去查一下。\n\n".length]);
  });

  it("ignores progress updates, except that an update can open a call it has not seen start", () => {
    const started = foldTurnToolCalls([
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "bash", args: { command: "ls" }, textOffset: 0 }),
      event("lead.tool.updated", 2, { toolCallId: "a", toolName: "bash", partialResult: "file-a" }),
    ]);
    expect(started[0]).toMatchObject({ state: "started", result: null });

    const opened = foldTurnToolCalls([
      event("lead.tool.updated", 2, { toolCallId: "a", toolName: "bash", partialResult: "file-a" }),
    ]);
    expect(opened[0]).toMatchObject({ callId: "a", state: "started", result: null, startedAt: at(2) });
  });

  it("does not reopen a call that already ended", () => {
    const calls = foldTurnToolCalls([
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "bash", textOffset: 0 }),
      event("lead.tool.completed", 2, { toolCallId: "a", toolName: "bash", result: "ok" }),
      event("lead.tool.started", 3, { toolCallId: "a", toolName: "bash", textOffset: 9 }),
    ]);
    expect(calls[0]).toMatchObject({ state: "completed", textOffset: 0, endedAt: at(2) });
  });

  it("bounds the arguments and the result to the display limit and says so", () => {
    const [call] = foldTurnToolCalls([
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "read", args: { path: "a.txt" }, textOffset: 0 }),
      event("lead.tool.completed", 2, { toolCallId: "a", toolName: "read", result: "line of output\n".repeat(200) }),
    ]);
    expect(call!.result!.preview).toHaveLength(TOOL_CALL_DISPLAY_LIMIT);
    expect(call!.result!.truncated).toBe(true);
  });

  it("gives the same call whether it folds stored events at once or live events one by one", () => {
    const events = [
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "read", args: { path: "a.txt", token: "t" }, textOffset: 3 }),
      event("lead.tool.completed", 2, { toolCallId: "a", toolName: "read", result: "more output\n".repeat(600) }),
    ];
    let live: ConversationToolCall | undefined;
    for (const item of events) live = foldToolCall(live, toolCallUpdateFromEvent(item, null)!);
    expect(foldTurnToolCalls(events)).toEqual([live]);
  });
});

describe("tool display projection", () => {
  it("redacts secret fields, long binary strings and records artifact refs", () => {
    const projection = projectToolDisplay({
      path: "/tmp/repo",
      token: "secret-token",
      binary: "A".repeat(20_000),
      artifactId: "artifact-1",
    });
    expect(projection).toMatchObject({ truncated: true, redacted: true, artifactRefs: ["artifact-1"] });
    expect(projection!.preview).not.toContain("secret-token");
    expect(projection!.preview).not.toContain("A".repeat(256));
  });
});

describe("conversation turn snapshot", () => {
  const turn = {
    id: "turn_1",
    originBindingId: null,
    originKind: "paired:companion",
    ticketId: null,
    state: "completed",
    userText: "查一下",
    assistantText: "好了。",
    error: null,
    createdAt: at(0),
    updatedAt: at(9),
  };

  it("accepts a turn without tool calls, as older daemons send it", () => {
    expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
  });

  it("accepts the folded tool calls of a turn", () => {
    const toolCalls = foldTurnToolCalls([
      event("lead.tool.started", 1, { toolCallId: "a", toolName: "query_tickets", args: { stage: "review" }, textOffset: 0 }),
      event("lead.tool.completed", 2, { toolCallId: "a", toolName: "query_tickets", result: "[]" }),
    ]);
    expect(Value.Check(ConversationTurnSchema, { ...turn, toolCalls })).toBe(true);
  });
});

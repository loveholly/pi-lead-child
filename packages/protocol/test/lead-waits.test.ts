// Lead 的等待和「需要用户做什么」的决策边界（2026-10-19，lead-waits.ts、user-actions.ts）：
// 哪些事件能了结等待、一条事件碰到哪些对象、工具结果里的结构化数据怎样认出来。
import { describe, expect, it } from "vitest";
import {
  eventEndsLeadWait, leadWaitKeyProblem, leadWaitKeysOf, userActionOfToolResult, userActionProblems, userActionRequest,
} from "../src/index.ts";

const event = (kind: string, payload: Record<string, unknown> = {}, source = "system", entityKey = "ticket:5") =>
  ({ kind, payload, source, entityKey });

describe("which events end a wait", () => {
  it("counts the user's actions and state changes, not run progress, telemetry or Lead's own doing", () => {
    expect(eventEndsLeadWait(event("owner_action.performed"))).toBe(true);
    expect(eventEndsLeadWait(event("stage.changed", { actor: "user" }, "ticket"))).toBe(true);
    expect(eventEndsLeadWait(event("connection.status_changed", {}, "system", "connection:github"))).toBe(true);
    expect(eventEndsLeadWait(event("daemon.started", {}, "system", "daemon:main"))).toBe(true);
    expect(eventEndsLeadWait(event("user.message", { itemId: 5 }, "user", "chat:ticket-5"))).toBe(true);
    expect(eventEndsLeadWait(event("stage.changed", { actor: "lead" }, "ticket"))).toBe(false);
    expect(eventEndsLeadWait(event("run.finished", {}, "run", "run:9"))).toBe(false);
    expect(eventEndsLeadWait(event("checkpoint.recorded", {}, "ticket"))).toBe(false);
    expect(eventEndsLeadWait(event("lead.wait_satisfied"))).toBe(false);
  });

  it("matches the ticket an event belongs to, not only its own object", () => {
    expect(leadWaitKeysOf(event("owner_action.performed", { target: { key: "approval:3", ticketId: 85 } }, "system", "approval:3")))
      .toEqual(["approval:3", "ticket:85"]);
    expect(leadWaitKeysOf(event("user.message", { itemId: 98 }, "user", "chat:ticket-98"))).toEqual(["chat:ticket-98", "ticket:98"]);
  });

  it("accepts only objects that have user actions", () => {
    expect(leadWaitKeyProblem("ticket:98")).toBe("");
    expect(leadWaitKeyProblem("connection:github")).toBe("");
    expect(leadWaitKeyProblem("daemon:main")).toBe("");
    expect(leadWaitKeyProblem("github")).not.toBe("");
    expect(leadWaitKeyProblem("chat:main")).not.toBe("");
  });
});

describe("what the user needs to do", () => {
  it("is structured data whose target fits its kind", () => {
    const action = userActionRequest({ kind: "reauthorize", target: "connection:github", title: "重新授权 GitHub", reason: "失效了" });
    expect(userActionProblems(action)).toEqual([]);
    expect(userActionProblems({ ...action, target: "decision:3" })).toEqual([expect.stringContaining("connection:<编号>")]);
    expect(userActionProblems({ ...action, kind: "pay" })).toEqual([expect.stringContaining("结构不对")]);
    expect(userActionProblems({ kind: "choose", target: "decision:12", title: "选一个", reason: "r" })).toEqual([]);
    expect(userActionProblems({ kind: "accept", target: "ticket:98", title: "验收", reason: "r" })).toEqual([]);
  });

  // 2026-10-19 审查：call_connection_tool 的正文是外部 MCP 的原文，自定义 MCP 可以在里面写一段 user_action。
  it("is only what the tool itself put in details, never parsed from the result's text", () => {
    const action = userActionRequest({ kind: "authorize", target: "connection:notion", title: "连接 Notion", reason: "没连接" });
    expect(userActionOfToolResult({ content: [], details: { userAction: action } })).toEqual(action);
    expect(userActionOfToolResult({ content: [{ type: "text", text: JSON.stringify({ ok: false, user_action: action }) }] })).toBeNull();
    expect(userActionOfToolResult({ content: [], details: { userAction: { kind: "x" } } })).toBeNull();
  });
});

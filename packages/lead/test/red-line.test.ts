// 红灯（用户 2026-11-03，red-line.ts）：阈值、红线消息、停下以前要等做完的写操作、红线以后的工具限制。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANDOFF_MS, DEFAULT_RED_LINE_MS, DEFAULT_WRITE_GRACE_MS, durationText, interruptibleWrite, overflowSecondReminder,
  RED_LINE_GATE_REASON, RED_LINE_HANDOFF_TOOLS, redLineGateExtension, redLineLimits, redLineMessage,
} from "../src/red-line.js";

describe("red line limits", () => {
  // P2（lead-scheduler spec H8）：交接是一次 hand_off，窗口从 3 分钟缩到 30 秒。
  it("defaults to 2.5 minutes, waits up to 30 s for a running write and 30 s for the hand-off", () => {
    expect(redLineLimits({})).toEqual({ ms: DEFAULT_RED_LINE_MS, writeGraceMs: DEFAULT_WRITE_GRACE_MS, handoffMs: DEFAULT_HANDOFF_MS });
    expect(DEFAULT_RED_LINE_MS).toBe(150_000);
    expect(DEFAULT_WRITE_GRACE_MS).toBe(30_000);
    expect(DEFAULT_HANDOFF_MS).toBe(30_000);
    expect(redLineLimits({ PLC_LEAD_RED_LINE_MS: "300", PLC_LEAD_WRITE_GRACE_MS: "0", PLC_LEAD_HANDOFF_MS: "x" }))
      .toEqual({ ms: 300, writeGraceMs: DEFAULT_WRITE_GRACE_MS, handoffMs: DEFAULT_HANDOFF_MS });
  });

  it("writes durations the way the messages say them", () => {
    expect(durationText(150_000)).toBe("2 分 30 秒");
    expect(durationText(120_000)).toBe("2 分钟");
    expect(durationText(45_000)).toBe("45 秒");
  });
});

describe("the red line message", () => {
  const waiting = [{ who: "用户", conversation: "和你的对话", count: 1, waitedMs: 240_000, user: true, firstLines: ["acme/b 已经有 PR 了"] }];

  it("says who waits and what they said, and asks Lead to check for a correction before it hands off", () => {
    const text = redLineMessage(150_000, waiting);
    expect(text).toContain('kind="red_line"');
    expect(text).toContain("2 分 30 秒");
    expect(text).toContain("用户（和你的对话，1 条）等了 4 分钟：「acme/b 已经有 PR 了」");
    expect(text).toContain("照纠正改，不要把旧的计划交出去");
    expect(text).toContain("调用一次 hand_off");
    expect(text).toContain("交接包");
    expect(text).toContain("follow_up");
    expect(text).toContain("用一句话告诉用户");
    expect(text).toContain("交接窗口是 30 秒");
    for (const tool of RED_LINE_HANDOFF_TOOLS) expect(text).toContain(tool);
  });

  // P2（spec 待定 9）：没有人在等也交出去。
  it("asks for a hand-off when nobody waits, and does not ask to check for a correction", () => {
    const text = redLineMessage(150_000, []);
    expect(text).toContain("现在没有人在等你，但下一条输入随时会来，所以照样交出去");
    expect(text).not.toContain("照纠正改");
    expect(text).toContain("hand_off");
  });

  it("reminds again without stopping when nobody waits", () => {
    const text = overflowSecondReminder(160_000, { context: "上下文用了 40%" });
    expect(text).toContain('kind="overflow"');
    expect(text).toContain("现在没有人在等你");
    expect(text).toContain("上下文用了 40%");
    expect(text).toContain("有人开始等你时，系统会停下这一轮");
  });
});

describe("writes the red line waits for", () => {
  const readOnly = (connection: string, tool: string) => connection === "github" && tool === "search_pull_requests";

  it("waits for bash, edit, write and connection writes", () => {
    expect(interruptibleWrite("bash", { command: "git push" }, readOnly)).toBe(true);
    expect(interruptibleWrite("edit", {}, readOnly)).toBe(true);
    expect(interruptibleWrite("write", {}, readOnly)).toBe(true);
    expect(interruptibleWrite("call_connection_tool", { connection: "github", tool: "add_comment" }, readOnly)).toBe(true);
    expect(interruptibleWrite("call_connection_tool", {}, readOnly)).toBe(true);
  });

  it("does not wait for read-only connection calls or Lead's own tools, which finish anyway", () => {
    expect(interruptibleWrite("call_connection_tool", { connection: "github", tool: "search_pull_requests" }, readOnly)).toBe(false);
    expect(interruptibleWrite("codemode", {}, readOnly)).toBe(false);
    expect(interruptibleWrite("create_task", {}, readOnly)).toBe(false);
    expect(interruptibleWrite("read", {}, readOnly)).toBe(false);
  });
});

describe("the tool gate after the red line", () => {
  function gate(allowed: ReadonlySet<string> | null) {
    const handlers: Array<(event: { toolName: string }) => { block: boolean; reason: string } | undefined> = [];
    redLineGateExtension(() => allowed)({ on: (_name: string, handler: (typeof handlers)[number]) => handlers.push(handler) } as never);
    return (toolName: string) => handlers[0]!({ toolName });
  }

  it("blocks everything but the hand-off tools, and says what to do instead", () => {
    const check = gate(new Set(RED_LINE_HANDOFF_TOOLS));
    expect(check("create_task")).toBeUndefined();
    expect(check("spawn_child")).toBeUndefined();
    expect(check("follow_up")).toBeUndefined();
    expect(check("bash")).toEqual({ block: true, reason: RED_LINE_GATE_REASON });
    expect(check("codemode")).toEqual({ block: true, reason: RED_LINE_GATE_REASON });
    expect(RED_LINE_GATE_REASON).toContain("用一句话告诉用户");
  });

  it("blocks nothing when there is no red line", () => {
    expect(gate(null)("bash")).toBeUndefined();
  });
});

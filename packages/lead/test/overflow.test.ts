// 超预算转派（lead-tools-and-routing spec D7）：阈值和提醒（黄灯）的文字。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERFLOW_MS, DEFAULT_OVERFLOW_TOOL_CALLS, DEFAULT_USER_QUEUE_NOTICE_MS, firstLine, LEAD_OVERFLOW_MS_ENV,
  LEAD_OVERFLOW_TOOL_CALLS_ENV, overflowLimits, overflowReached, overflowReminder, userQueueNoticeMs, waitingText,
} from "../src/overflow.js";

describe("overflow limits", () => {
  // 2026-11-03（用户：「黄灯转红灯」）：黄灯从 3 分钟改成 2 分钟。
  it("defaults to 10 tool calls or 2 minutes, and reads positive overrides only", () => {
    expect(overflowLimits({})).toEqual({ toolCalls: DEFAULT_OVERFLOW_TOOL_CALLS, ms: DEFAULT_OVERFLOW_MS });
    expect(DEFAULT_OVERFLOW_TOOL_CALLS).toBe(10);
    expect(DEFAULT_OVERFLOW_MS).toBe(120_000);
    expect(overflowLimits({ [LEAD_OVERFLOW_TOOL_CALLS_ENV]: "4", [LEAD_OVERFLOW_MS_ENV]: "60000" })).toEqual({ toolCalls: 4, ms: 60_000 });
    expect(overflowLimits({ [LEAD_OVERFLOW_TOOL_CALLS_ENV]: "0", [LEAD_OVERFLOW_MS_ENV]: "abc" }))
      .toEqual({ toolCalls: DEFAULT_OVERFLOW_TOOL_CALLS, ms: DEFAULT_OVERFLOW_MS });
  });

  it("is reached by tool calls or by time, whichever comes first", () => {
    const limits = { toolCalls: 3, ms: 1_000 };
    expect(overflowReached({ toolCalls: 2, startedAt: 0 }, 500, limits)).toBeNull();
    expect(overflowReached({ toolCalls: 3, startedAt: 0 }, 500, limits)).toBe("tool_calls");
    expect(overflowReached({ toolCalls: 1, startedAt: 0 }, 1_000, limits)).toBe("duration");
  });

  // 回归（2026-11-03）：31 次提醒 Lead 只派出去 4 次；「马上就能做完的可以做完」让它每次都觉得自己快做完了。
  it("asks Lead to choose: hand the rest off, or tell the user how long before going on", () => {
    const text = overflowReminder({ toolCalls: 12, startedAt: 0 }, 60_000, "tool_calls", { redLine: "2 分 30 秒" });
    expect(text).toContain('kind="overflow"');
    expect(text).toContain("已经调用了 12 次工具");
    expect(text).toContain("hand_off");
    expect(text).toContain("二选一");
    expect(text).toContain("还要多久");
    expect(text).toContain("现在没有人在等你");
    expect(text).toContain("做到 2 分 30 秒 时，系统会停下这一轮");
    expect(text).not.toContain("可以做完");
  });

  it("names who is waiting, with the first line of the user's own messages", () => {
    const waiting = waitingText([
      { who: "用户", conversation: "和你的对话", count: 2, waitedMs: 90_000, user: true, firstLines: ["已经有 PR 了", "顺便看一下 acme/b"] },
      { who: "Nina", conversation: "Nina 的私信", count: 1, waitedMs: 20_000 },
    ]);
    expect(waiting).toBe("用户（和你的对话，2 条）等了 2 分钟：「已经有 PR 了」「顺便看一下 acme/b」；Nina（Nina 的私信，1 条）等了 20 秒");
    const text = overflowReminder({ toolCalls: 3, startedAt: 0 }, 120_000, "duration", { waiting });
    expect(text).toContain("现在在等你的：用户（和你的对话，2 条）");
  });
});

describe("the user's own queued messages", () => {
  it("are noticed after a minute by default", () => {
    expect(DEFAULT_USER_QUEUE_NOTICE_MS).toBe(60_000);
    expect(userQueueNoticeMs({})).toBe(60_000);
    expect(userQueueNoticeMs({ PLC_LEAD_USER_QUEUE_NOTICE_MS: "30000" })).toBe(30_000);
  });

  it("are quoted by their first non-empty line, cut at 60 characters", () => {
    expect(firstLine("\n  先别提 PR \n第二行")).toBe("先别提 PR");
    expect(firstLine("a".repeat(70))).toBe(`${"a".repeat(60)}…`);
  });
});

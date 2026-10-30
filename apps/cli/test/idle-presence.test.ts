// plc chat 运行时算有人在看；PRESENCE_IDLE_MS（5 分钟）没有输入就不算，下一次输入又算。
import { describe, expect, it, vi } from "vitest";
import { PRESENCE_IDLE_MS } from "@pi-lead-child/protocol";
import { IdlePresence } from "../src/chat.js";

describe("IdlePresence", () => {
  it("is attended while the user types, and goes idle after the idle time", () => {
    vi.useFakeTimers();
    try {
      const sent: boolean[] = [];
      const presence = new IdlePresence((attended) => sent.push(attended), PRESENCE_IDLE_MS);
      presence.start();
      expect(sent).toEqual([true]);
      vi.advanceTimersByTime(PRESENCE_IDLE_MS - 1);
      presence.input();
      vi.advanceTimersByTime(PRESENCE_IDLE_MS - 1);
      expect(sent).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([true, false]);
      presence.input();
      expect(sent).toEqual([true, false, true]);
      presence.stop();
      vi.advanceTimersByTime(PRESENCE_IDLE_MS * 2);
      expect(sent).toEqual([true, false, true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

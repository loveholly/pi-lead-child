// 用户的消息放在哪里（lead-tools-and-routing spec D16）：带着外部内容的一轮不吞下用户的消息。
import { describe, expect, it } from "vitest";
import { userMessagePlacement } from "../src/user-placement.js";

describe("where a user's message goes while Lead is busy", () => {
  it("starts a turn when Lead is idle", () => {
    expect(userMessagePlacement({ busy: false, external: false, followUp: false })).toBe("start");
    expect(userMessagePlacement({ busy: false, external: true, followUp: true })).toBe("start");
  });

  it("steers or queues into the running turn when that turn read no external content", () => {
    expect(userMessagePlacement({ busy: true, external: false, followUp: false })).toBe("steer");
    expect(userMessagePlacement({ busy: true, external: false, followUp: true })).toBe("follow_up");
  });

  // 回归（2026-10-27 21:05）：跟进轮次读了 Slack，用户插话「1 分钟后提醒我」被当成外部的一轮，设提醒被拒。
  it("waits for a turn of its own when the running turn read external content, whether the user steered or queued", () => {
    expect(userMessagePlacement({ busy: true, external: true, followUp: false })).toBe("own_turn_after");
    expect(userMessagePlacement({ busy: true, external: true, followUp: true })).toBe("own_turn_after");
  });
});

// L1 的时限从什么时候算（lead-scheduler spec D1；P1 报告的实施记录）：L1 不能抢占 L0，用户的单元在跑的时间不算。
import { describe, expect, it } from "vitest";
import { laneClockMs } from "../src/scheduler/index.js";

const NOW = 1_000_000;

describe("laneClockMs", () => {
  it("does not count an L1 message while the user's unit that started before it runs", () => {
    // 私信在用户的单元开始 5 秒后到，已经等了 90 秒，用户的单元还在跑。
    expect(laneClockMs({ lane: 1, waitedMs: 90_000, now: NOW, userUnitOpenedAt: NOW - 95_000, userUnitEndedAt: null })).toBe(0);
  });

  it("counts an L1 message from the end of the user's unit", () => {
    // 私信等了 98 秒，用户的单元 20 秒前结束：按时限只算 20 秒。
    expect(laneClockMs({ lane: 1, waitedMs: 98_000, now: NOW, userUnitOpenedAt: null, userUnitEndedAt: NOW - 20_000 })).toBe(20_000);
  });

  it("counts the time an L1 message waited before the user's unit started, and stops while it runs", () => {
    // 私信先到，等了 30 秒，用户才发消息；用户的单元已经跑了 60 秒。
    expect(laneClockMs({ lane: 1, waitedMs: 90_000, now: NOW, userUnitOpenedAt: NOW - 60_000, userUnitEndedAt: null })).toBe(30_000);
  });

  it("counts from arrival when the message came after the last user unit ended", () => {
    expect(laneClockMs({ lane: 1, waitedMs: 10_000, now: NOW, userUnitOpenedAt: null, userUnitEndedAt: NOW - 50_000 })).toBe(10_000);
  });

  it("counts the other lanes from arrival", () => {
    for (const lane of [0, 2, 3, 4] as const) {
      expect(laneClockMs({ lane, waitedMs: 90_000, now: NOW, userUnitOpenedAt: NOW - 95_000, userUnitEndedAt: null })).toBe(90_000);
    }
  });
});

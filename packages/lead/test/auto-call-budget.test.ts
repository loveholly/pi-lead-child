// 自动调用的预算（auto-call-budget.ts，2026-11-16）：系统自己发起的模型调用超过每小时、每天的上限时返回超的那一条和暂停到的时间。
import { describe, expect, it } from "vitest";
import { AutoCallBudget, autoCallBudgetLimits, DEFAULT_AUTO_CALL_BUDGET, uncachedTokens } from "../src/auto-call-budget.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function budget(limits = DEFAULT_AUTO_CALL_BUDGET) {
  let now = 0;
  const made = new AutoCallBudget({ limits, now: () => now });
  return { made, advance: (ms: number) => { now += ms; }, clock: () => now };
}

describe("AutoCallBudget", () => {
  it("allows the busiest normal hour (88 calls) and stops at 120 calls in an hour", () => {
    const { made, advance, clock } = budget();
    for (let i = 0; i < 88; i += 1) {
      expect(made.record(250_000)).toBeNull();
      advance(30_000);
    }
    let over = null;
    for (let i = 88; i < 120 && !over; i += 1) over = made.record(1_000);
    expect(over).toMatchObject({ limit: "callsPerHour", detail: "120 automatic model calls in the last hour (limit 120)" });
    // 暂停到这一小时里的用量降到八成（96 次）以下。
    expect(over!.until).toBeGreaterThan(clock());
    expect(over!.until).toBeLessThanOrEqual(clock() + HOUR);
    advance(over!.until - clock());
    expect(made.exceeded()).toBeNull();
    expect(made.usage().callsLastHour).toBeLessThan(96);
  });

  it("stops a slow storm at 1,500 calls in a day", () => {
    const { made, advance } = budget();
    let over = null;
    let calls = 0;
    // 每 40 秒一次：每小时 90 次，不到每小时的上限；一天会有 2,160 次。
    while (!over && calls < 5_000) {
      over = made.record(1_000);
      calls += 1;
      advance(40_000);
    }
    expect(over).toMatchObject({ limit: "callsPerDay" });
    expect(calls).toBe(1_500);
  });

  it("stops at 50 million uncached input tokens in a day", () => {
    const { made, advance } = budget();
    let over = null;
    let calls = 0;
    while (!over && calls < 1_000) {
      over = made.record(250_000);
      calls += 1;
      advance(5 * MINUTE);
    }
    expect(over).toMatchObject({ limit: "uncachedTokensPerDay" });
    expect(calls).toBe(200);
  });

  it("takes new limits at once and keeps the calls it counted (ticket #553: the settings page changes them)", () => {
    const { made } = budget({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 3 });
    made.record(0);
    made.record(0);
    expect(made.record(0)).toMatchObject({ limit: "callsPerHour" });
    made.setLimits({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 10 });
    expect(made.limits.callsPerHour).toBe(10);
    expect(made.exceeded()).toBeNull();
    expect(made.usage().callsLastHour).toBe(3);
    made.setLimits({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 2 });
    expect(made.exceeded()).toMatchObject({ limit: "callsPerHour", detail: "3 automatic model calls in the last hour (limit 2)" });
  });

  it("reads the limits from config, keeps the default for a wrong value, and 0 means no limit", () => {
    expect(autoCallBudgetLimits(undefined)).toEqual(DEFAULT_AUTO_CALL_BUDGET);
    expect(autoCallBudgetLimits({ callsPerHour: 30, callsPerDay: "many", uncachedTokensPerDay: 0 }))
      .toEqual({ callsPerHour: 30, callsPerDay: 1_500, uncachedTokensPerDay: 0 });
    const { made } = budget({ callsPerHour: 0, callsPerDay: 0, uncachedTokensPerDay: 0 });
    for (let i = 0; i < 3_000; i += 1) expect(made.record(1_000_000)).toBeNull();
  });
});

describe("uncachedTokens", () => {
  it("adds the input and the cache write of a usage record, and ignores what is not a count", () => {
    expect(uncachedTokens({ input: 1_200, cacheWrite: 233_000, cacheRead: 900_000, output: 4_000 })).toBe(234_200);
    expect(uncachedTokens({ input: 10 })).toBe(10);
    expect(uncachedTokens({ input: "12", cacheWrite: -5 })).toBe(0);
    expect(uncachedTokens(undefined)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_WAKE_RETRY_MAX_FAILURES, nextWakeRetry, wakeRetryBlocks } from "../src/lead-wake-retry.js";

const input = (now: number, maxFailures = 5) => ({ now, baseMs: 15_000, maxFailures });

describe("nextWakeRetry", () => {
  it("backs off 15s, 30s, 60s, 120s from the first failure, with no cap on the wait but the 5 minute ceiling", () => {
    let retry = nextWakeRetry(null, input(1_000, 20));
    const waits = [retry.at - 1_000];
    for (let index = 0; index < 6; index += 1) {
      retry = nextWakeRetry(retry, input(1_000, 20));
      waits.push(retry.at - 1_000);
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(retry.stopped).toBe(false);
  });

  // 回归（#21）：以前连续失败多少次都照样再叫醒，11-03 夜里 DeepSeek 不可用，252 次失败请求。
  it("stops at the failure cap instead of scheduling another attempt", () => {
    let retry = nextWakeRetry(null, input(0, 3));
    retry = nextWakeRetry(retry, input(0, 3));
    expect(retry).toMatchObject({ failures: 2, stopped: false });
    retry = nextWakeRetry(retry, input(0, 3));
    expect(retry).toMatchObject({ failures: 3, stopped: true });
  });

  it("stays stopped while failures keep coming", () => {
    const stopped = { at: 0, failures: 3, stopped: true };
    expect(nextWakeRetry(stopped, input(10, 3))).toMatchObject({ failures: 4, stopped: true });
  });

  it("uses a default cap of 5: four waits of 15s, 30s, 60s and 120s, then it stops", () => {
    expect(DEFAULT_WAKE_RETRY_MAX_FAILURES).toBe(5);
    const waits: number[] = [];
    let retry = nextWakeRetry(null, input(0));
    while (!retry.stopped) {
      waits.push(retry.at);
      retry = nextWakeRetry(retry, input(0));
    }
    expect(retry.failures).toBe(5);
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000]);
  });

  it("treats a missing or non-positive cap as the default", () => {
    let retry = nextWakeRetry(null, input(0, 0));
    for (let index = 0; index < 3; index += 1) retry = nextWakeRetry(retry, input(0, Number.NaN));
    expect(retry).toMatchObject({ failures: 4, stopped: false });
    retry = nextWakeRetry(retry, input(0, 0));
    expect(retry).toMatchObject({ failures: 5, stopped: true });
  });
});

describe("wakeRetryBlocks", () => {
  it("does not block when there was no failure", () => {
    expect(wakeRetryBlocks(null, 5_000)).toBe(false);
  });

  it("blocks until the backoff time, then lets the next attempt through", () => {
    const retry = { at: 10_000, failures: 1, stopped: false };
    expect(wakeRetryBlocks(retry, 9_999)).toBe(true);
    expect(wakeRetryBlocks(retry, 10_000)).toBe(false);
  });

  it("blocks forever once stopped", () => {
    expect(wakeRetryBlocks({ at: 10_000, failures: 5, stopped: true }, 10_000_000)).toBe(true);
  });
});

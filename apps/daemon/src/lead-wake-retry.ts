// 叫醒 Lead 的回合失败以后的退避，和失败的上限（工单 #21，#18 的调查）。
// 带事的回合（leadWakeRetry）和摘要回合（digestRetry）共用：2026-11-03 17:41 起 DeepSeek 不可用，每约 5 分钟重试一次直到午夜，
// 252 次失败请求，没有上限；key 一恢复，每次重试带约 10 万 token 上下文。到上限就停下，由 server.ts 通知用户。

export interface WakeRetry {
  /** 下一次可以再叫醒的时间（毫秒时间戳）。stopped 时不再用。 */
  at: number;
  /** 连续失败的次数。 */
  failures: number;
  /** 已经到上限：不再自动叫醒，等 Lead 的一次成功回合清掉。 */
  stopped: boolean;
}

/** 连续失败多少次以后停止自动叫醒。15、30、60、120 秒各等一次，第 5 次失败就停。 */
export const DEFAULT_WAKE_RETRY_MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

/** 又失败了一次：算下一次叫醒的时间，到上限时标成停止。maxFailures 不是正数时用缺省值。 */
export function nextWakeRetry(
  previous: WakeRetry | null, input: { now: number; baseMs: number; maxFailures: number },
): WakeRetry {
  const failures = (previous?.failures ?? 0) + 1;
  const cap = input.maxFailures > 0 ? input.maxFailures : DEFAULT_WAKE_RETRY_MAX_FAILURES;
  return {
    at: input.now + Math.min(input.baseMs * 2 ** (failures - 1), MAX_BACKOFF_MS),
    failures,
    stopped: failures >= cap,
  };
}

/** 现在不该叫醒 Lead：还在退避，或者已经停止。 */
export function wakeRetryBlocks(retry: WakeRetry | null, now: number): boolean {
  return retry !== null && (retry.stopped || retry.at > now);
}

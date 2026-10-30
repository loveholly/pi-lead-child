// 后端共用的超时和取消。调用方的 signal 和这次调用的超时合成一个 signal。
// 后端不理会 signal 时，raceAbort 照样按时放弃等待。
import { redactSecretText } from "@pi-lead-child/protocol";
import { SmartModelBackendError } from "./types.js";

const MAX_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 200;

export interface Deadline {
  signal: AbortSignal;
  /** signal 为什么触发：调用方取消、超时，或者还没触发。 */
  cause(): "aborted" | "timeout" | null;
}

export function deadline(callerSignal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  const timer = AbortSignal.timeout(ms);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timer]) : timer;
  return {
    signal,
    cause: () => (callerSignal?.aborted ? "aborted" : timer.aborted ? "timeout" : null),
  };
}

/** promise 结束或者 signal 触发，哪个先到用哪个。 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** 错误的一行说明：脱敏、截短。错误会进决策日志和工具结果。 */
export function errorText(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  const clean = redactSecretText(message).replace(/\s+/g, " ").trim();
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

/** 把一次失败归类成 SmartModelBackendError。已经归过类的原样返回。 */
export function backendFailure(
  backend: string,
  error: unknown,
  timing: Deadline,
  secrets: readonly string[] = [],
): SmartModelBackendError {
  if (error instanceof SmartModelBackendError) return error;
  const cause = timing.cause();
  if (cause === "aborted") return new SmartModelBackendError(backend, `${backend}: aborted by the caller`, "aborted");
  if (cause === "timeout") return new SmartModelBackendError(backend, `${backend}: timed out`, "timeout");
  const detail = errorText(error, secrets);
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  const suffix = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
  return new SmartModelBackendError(backend, `${backend}: ${detail}${suffix}`, "network");
}

// 瞬时失败的自动重试（spec D5，工单 06）。
// scope 为 attempt、重试方式为 backoff 的失败（模型满载、429、5xx、断网），既不是任务失败，也不是 profile 坏了。
// 内核按指数退避排一个重试请求，下次时间以绝对时间写在请求上（not_before），claim 遵守这个时间。
// 外部 session 已经有进展时，重试 resume 这个 session，长任务的进展不丢。run 64 就是干了 28 分钟后断网。
// 重试延续的是同一次尝试，所以不需要委托授权，也不扣工单的重试额度。lead 只收到一条说明。
// 自动重试到上限后，升起一个 blocker，并把 profile 标成 degraded。
import { createDispatcher } from "../coordinator/dispatch.js";
import { addActivity } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { addInbox } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { markRuntimeDegraded } from "@pi-lead-child/store";
import { transientRetryDefaults } from "@pi-lead-child/store";
import type { StandingOrderRef } from "@pi-lead-child/protocol";
import type { Run, TypedFailure } from "@pi-lead-child/core";
import {
  failureNextStep, kernelRetriesTransient, runtimeFailureTitle, type TransientRetryNote,
} from "@pi-lead-child/runtime";
import type { RuntimeProfileIdentity } from "@pi-lead-child/runtime";

export const TRANSIENT_RETRY_TRIGGER = "transient-retry";

// ── 配置 ───────────────────────────────────────────────────────────────────────
// 第 n 次自动重试等 base·2ⁿ⁻¹，最多等 max。重试 limit 次以后不再重试。
// 参数来自常设指令 run.transient_retry（工单 05）：第一版 30 秒起，最多 10 分钟，最多 5 次，
// 依次等 30 秒、1、2、4、8 分钟，共约 15 分钟。模型满载和短暂断网通常在这段时间内恢复。
// 更长的中断需要用户知道，所以到上限后升起 blocker。环境变量 PLC_TRANSIENT_RETRY_* 优先于常设指令。
// limit 为 0 表示不自动重试：第一次瞬时失败就升起 blocker。limit 最大 20，防止配置写错后一直重试：
// 这是写在代码里的上限，常设指令和环境变量都越不过它。
export interface TransientRetryConfig {
  baseMs: number;
  maxMs: number;
  limit: number;
  // 参数依据的常设指令（编号和版本）。环境变量覆盖了的参数仍记这条指令：没覆盖的那些来自它。
  order?: StandingOrderRef;
}

const MAX_LIMIT = 20;

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function retryLimit(value: string | undefined, fallback: number): number {
  const bounded = Math.min(fallback, MAX_LIMIT);
  if (value === undefined || value.trim() === "") return bounded;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return bounded;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * 重试的配置：环境变量优先，没给（或者不合格）的用 defaults。defaults 缺省是常设指令 run.transient_retry 的种子；
 * 有库时用 standingTransientRetryConfig 读库里现在的版本。
 */
export function transientRetryConfig(
  env: Record<string, string | undefined> = process.env,
  defaults: Pick<TransientRetryConfig, "baseMs" | "maxMs" | "limit"> = transientRetryDefaults(),
): TransientRetryConfig {
  return {
    baseMs: positiveMs(env.PLC_TRANSIENT_RETRY_BASE_MS, defaults.baseMs),
    maxMs: positiveMs(env.PLC_TRANSIENT_RETRY_MAX_MS, defaults.maxMs),
    limit: retryLimit(env.PLC_TRANSIENT_RETRY_LIMIT, defaults.limit),
  };
}

/** 按库里现在的常设指令 run.transient_retry 算重试的配置，带上依据。 */
export function standingTransientRetryConfig(
  db: Db, env: Record<string, string | undefined> = process.env,
): TransientRetryConfig {
  const defaults = transientRetryDefaults(db);
  return { ...transientRetryConfig(env, defaults), order: defaults.order };
}

// attempt 从 1 开始。先截断指数，避免溢出成 Infinity。
export function transientRetryDelayMs(attempt: number, config: TransientRetryConfig = transientRetryConfig()): number {
  return Math.min(config.baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 31), config.maxMs);
}

// ── 决策 ───────────────────────────────────────────────────────────────────────
export type TransientRetryPlan =
  | { kind: "retry"; attempt: number; limit: number; notBefore: string; resumeFromRunId: number | null }
  | { kind: "exhausted"; limit: number };

// 失败的 Run 是第几次自动重试派出来的。不是由退避重试派出来的 Run 记为 0。
// claim 行要到 Run 结束后的下一轮派发才删除，所以 Run 失败时它还在。
// daemon 重启回收孤儿 Run 时，原来的请求回到队列，次数跟着请求走，不会清零。
function previousAttempt(db: Db, runId: number): number {
  const row = db.prepare(
    `SELECT r.backoff_attempt FROM dispatch_claims c
     JOIN dispatch_requests r ON r.id = c.request_id
     WHERE c.run_id = ?`,
  ).get(runId) as { backoff_attempt: number | null } | undefined;
  return row?.backoff_attempt ?? 0;
}

// 重试 resume 哪个 Run 的外部 session。失败的 Run 已经有 session 时，就是它自己。
// 一次 resume 在拿到 session 之前就失败时，它自己没有 session。这时沿用它 resume 的那个 Run，进展不丢。
function sessionSourceRunId(db: Db, run: Run): number | null {
  if (run.external_session_id) return run.id;
  if (run.resumed_from_run_id === null) return null;
  const source = getRun(db, run.resumed_from_run_id);
  return source?.item_id === run.item_id && source.external_session_id ? source.id : null;
}

/**
 * 这次失败该怎么处理。只读，不写库。不是内核退避重试的失败时返回 null。
 * resume 是 runtime 的能力：不支持 resume 的 runtime 每次都重新开始。
 */
function planTransientRetry(
  db: Db,
  input: { runId: number; failure: Pick<TypedFailure, "scope" | "retry">; at: Date; resume: boolean },
  config: TransientRetryConfig,
): TransientRetryPlan | null {
  const run = getRun(db, input.runId);
  if (!run || !kernelRetriesTransient(input.failure, run.purpose)) return null;
  const attempt = previousAttempt(db, run.id) + 1;
  if (attempt > config.limit) return { kind: "exhausted", limit: config.limit };
  return {
    kind: "retry",
    attempt,
    limit: config.limit,
    notBefore: new Date(input.at.getTime() + transientRetryDelayMs(attempt, config)).toISOString(),
    resumeFromRunId: input.resume ? sessionSourceRunId(db, run) : null,
  };
}

/**
 * 处理一次瞬时失败。调用方负责事务，并且已经把 Run 记成 failed，带上类型化失败。
 * 返回写说明用的结果。不是内核退避重试的失败时返回 null，什么也不写。
 *   - retry：排一个带"不早于"时间的重试请求。第一次重试时给 lead 一条说明。工单的 stage 不变，没有 blocker。
 *   - exhausted：工单从 active 转为 blocked，profile 标成 degraded。
 *     blocker 由调用方在写下失败的检查点之后升起（raiseTransientRetryBlocker）。
 */
export function applyTransientRetry(
  db: Db,
  input: {
    runId: number;
    failure: TypedFailure;
    at: Date;
    resume: boolean;
    profile: RuntimeProfileIdentity;
  },
  config: TransientRetryConfig = standingTransientRetryConfig(db),
): TransientRetryNote | null {
  const plan = planTransientRetry(db, input, config);
  if (!plan) return null;
  const run = getRun(db, input.runId)!;
  if (plan.kind === "retry") {
    const note: TransientRetryNote = {
      kind: "retry", attempt: plan.attempt, limit: plan.limit, notBefore: plan.notBefore,
      resume: plan.resumeFromRunId !== null,
    };
    scheduleRetry(db, run, input.failure, plan, note, config.order);
    return note;
  }
  const note: TransientRetryNote = { kind: "exhausted", limit: plan.limit };
  haltRetries(db, { run, failure: input.failure, at: input.at, profile: input.profile, config });
  return note;
}

function scheduleRetry(
  db: Db,
  run: Run,
  failure: TypedFailure,
  plan: Extract<TransientRetryPlan, { kind: "retry" }>,
  note: TransientRetryNote,
  order: StandingOrderRef | undefined,
): void {
  // 同一个 runtime、同一个模型：换 runtime 是跨 runtime 的 fallback，需要委托授权（spec 用户故事 32）。
  // 之后工单又跑了同一角色、同一用途的 Run，这个重试在 claim 时作废（retry_of_run_id，工单 03）。
  const requestId = createDispatcher(db).request({
    itemId: run.item_id,
    role: run.role,
    purpose: run.purpose,
    runtime: run.runtime,
    model: run.model ?? undefined,
    resumeFromRunId: plan.resumeFromRunId ?? undefined,
    retryOfRunId: run.id,
    notBefore: plan.notBefore,
    backoffAttempt: plan.attempt,
    trigger: TRANSIENT_RETRY_TRIGGER,
    idempotencyKey: `${TRANSIENT_RETRY_TRIGGER}:${run.id}`,
  });
  const nextStep = failureNextStep(run.runtime, failure, note);
  const details = {
    dispatchRequestId: requestId,
    attempt: plan.attempt,
    limit: plan.limit,
    notBefore: plan.notBefore,
    resumeFromRunId: plan.resumeFromRunId,
    code: failure.code,
    // 依据：常设指令的编号和版本（spec D5）。
    ...(order ? { standingOrder: order } : {}),
  };
  addActivity(db, {
    itemId: run.item_id, runId: run.id, actor: "system", kind: "decision",
    payload: { decision: "transient_retry_scheduled", ...details },
  });
  // lead 只收到一条说明（spec D5）：整条重试链只在第一次失败时写这一条。它是 attention，不是 blocker。
  // 之后的重试只记活动。lead 的工单详情能读到下一次重试的时间。到上限时，lead 收到那条 blocker。
  if (plan.attempt !== 1) return;
  addInbox(db, {
    itemId: run.item_id,
    severity: "attention",
    source: "structural",
    summary: `工单 #${run.item_id} 的 Run #${run.id}：${runtimeFailureTitle(run.runtime, failure)}。${nextStep}`,
    payload: { kind: "transient_retry", runId: run.id, ...details, nextStep },
    lossless: true,
  });
}

function haltRetries(
  db: Db,
  args: {
    run: Run;
    failure: TypedFailure;
    at: Date;
    profile: RuntimeProfileIdentity;
    config: TransientRetryConfig;
  },
): void {
  const { run, failure, at } = args;
  if (getItem(db, run.item_id)?.stage === "active") {
    transition(db, {
      itemId: run.item_id, to: "blocked", actor: "system",
      reason: "transient retry limit reached", runId: run.id, now: at,
    });
  }
  // degraded 带绝对的恢复时间：过了退避的最长间隔，profile 按已经恢复处理。
  const degraded = markRuntimeDegraded(db, {
    profile: args.profile, at, recoverAt: new Date(at.getTime() + args.config.maxMs),
  });
  addActivity(db, {
    itemId: run.item_id, runId: run.id, actor: "system", kind: "decision",
    payload: {
      decision: "transient_retry_exhausted",
      limit: args.config.limit,
      code: failure.code,
      runtime: run.runtime,
      profileDegraded: degraded,
      ...(args.config.order ? { standingOrder: args.config.order } : {}),
    },
  });
}

/**
 * 自动重试到上限时，升起整条重试链上唯一的 blocker。在它之前，lead 只在第一次重试时收到一条说明。
 * blocker 的 key 是失败检查点的 key。daemon 启动时的 blocker 补发（repairMissingBlockerAlerts）
 * 按同一个 key 去重，所以重启后不会再发第二条。调用方负责事务。
 */
export function raiseTransientRetryBlocker(
  db: Db,
  input: { runId: number; failure: TypedFailure; note: TransientRetryNote; checkpointId: number; at: Date },
): void {
  const run = getRun(db, input.runId)!;
  const { failure } = input;
  raiseBlocker(db, {
    // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
    needsUser: false,
    itemId: run.item_id,
    runId: run.id,
    code: "transient_retry_exhausted",
    title: `${runtimeFailureTitle(run.runtime, failure)}：自动重试已到上限`,
    summary: `工单 #${run.item_id} 的 Run #${run.id} 瞬时失败：${(run.error_message ?? failure.code).slice(0, 1_400)}`,
    nextStep: failureNextStep(run.runtime, failure, input.note),
    source: "structural",
    dedupKey: `checkpoint:${input.checkpointId}`,
    evidence: {
      checkpointId: input.checkpointId,
      errorCode: run.error_code,
      failure: { scope: failure.scope, retry: failure.retry, needs: failure.needs, code: failure.code },
      ...(input.note.kind === "exhausted" ? { transientRetryLimit: input.note.limit } : {}),
    },
    at: input.at,
  });
}

// 同一张工单上重跑一次 Run：换 runtime、换模型、换 effort、换指令，或者原样再来一次。
// 不创建新工单，不改任务内容，不扣业务重试额度。每一步都写进工单账本。
//
// 2026-10-15 用户决定：Lead 是数字助理，能力要通用，判断交给 Lead。代码里只留三类硬限制：
//   - 机密：不把凭据写进提示、日志或消息（这里不碰凭据）。
//   - 安全：核查恢复以后还是只读的独立核查。2026-10-20 起任何 runtime 都能接核查：每个 adapter 按 reviewer 角色只开
//     只读的工具，核查前后比对工作区指纹（manager.ts）。auto 按选核查员的顺序挑，能跑命令的在前。
//   - token：每条失败链最多恢复 3 次（MAX_RECOVERY_STEPS）；执行的业务重试额度在派发时照样生效
//     （dispatch.ts 的 cancelRetryExhausted）；之后又跑过同一角色、同一用途的 Run，这次恢复就作废。
// 其余都由 Lead 决定：任何用途的 Run（执行、核查、合并、成果修复、学习、工单对话）、任何失败类别、
// 失败或停下的 Run。以前只接受执行 Run、只接受运行时故障，工单 #66 的核查因此连续失败 9 次。
// 失败类别只用来给 auto 排候选，不再拦 Lead 的明确选择。
//
// 候选来自模型目录（model-catalog.ts）和显式配置（PLC_<RUNTIME>_FALLBACK_MODELS），没有写死的模型。
// 核查恢复以后只续接它自己的 session，不碰执行者的 session；排队时照常记下针对哪次交付，
// 过期的核查请求照常作废（review-authority.ts）。
// 工单对话没有派发请求，它从一条消息开始：调用方（Lead 的工具）提供 startConversation，
// 默认重发原来那条消息，Lead 也可以换成自己的话。
import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { activeRun, getRun } from "@pi-lead-child/store";
import { unavailableIncident, unavailableProfileIncident } from "@pi-lead-child/store";
import type { Run, RuntimeId } from "@pi-lead-child/core";
import { activeDelegationPolicy } from "@pi-lead-child/store";
import {
  defaultRuntimeProfile, isRuntimeDisabled, reviewRuntimeOrder, runFailure, runtimeDisabledReason, runtimeFallbackOrder,
  resolveRuntimeModel,
  type RuntimeProfile,
} from "@pi-lead-child/runtime";
import { failureRecovery, type FailureRecovery } from "@pi-lead-child/runtime";
import { createDispatcher } from "./dispatch.js";
import {
  alternativeModels, currentModelCatalog, ModelChoiceError, validateModelChoice, type ModelCatalog,
} from "../model-catalog.js";

/**
 * auto：系统按失败类别和目录挑一个没试过的候选。
 * retry：用给定的 runtime、模型和 effort，不给的沿用失败的 Run（原样再来一次也可以）。
 * next_model、switch_runtime：retry 的两种常见写法，分别要求换模型、换 runtime。
 */
export type RuntimeRecoveryAction = "auto" | "retry" | "next_model" | "switch_runtime";

export interface ConversationTarget {
  runtime: RuntimeId;
  model: string | null;
  effort: string | null;
  message: string;
}

export interface RuntimeRecoveryRequest {
  itemId: number;
  failedRunId: number;
  action: RuntimeRecoveryAction;
  model?: string;
  runtime?: RuntimeId;
  effort?: string;
  /** 谁、凭什么恢复。以 "system:" 开头的记成 system，其他记成 lead。 */
  authorityRef: string;
  /** Lead 给这次重跑的指令。工单对话里它就是要发的消息，不给时重发原来那条。 */
  instruction?: string;
  /** 工单对话的 Run 用它重新发消息，返回新的 Run id。不给时不能恢复工单对话。 */
  startConversation?: (target: ConversationTarget) => number;
  /** 只给测试：不传时用 daemon 现在的模型目录。 */
  catalog?: ModelCatalog;
  /** 只给测试：runtime 的 profile，用来查健康账本。 */
  runtimeProfile?: (runtime: RuntimeId) => RuntimeProfile;
}

export type RuntimeRecoveryResult =
  | {
      /** queued：排了派发请求。started：工单对话已经开始新的 Run。 */
      status: "queued" | "already_queued" | "started";
      itemId: number;
      failedRunId: number;
      dispatchRequestId: number | null;
      runId: number | null;
      runtime: RuntimeId;
      model: string | null;
      effort: string | null;
      category: FailureRecovery["category"];
      resumedFromRunId: number | null;
    }
  | {
      status: "needs_user" | "no_candidate";
      itemId: number;
      failedRunId: number;
      category: FailureRecovery["category"];
      reason: string;
    };

/** 一条失败链上最多恢复几次：例如同一 runtime 换两次模型，再换一次 runtime。 */
export const MAX_RECOVERY_STEPS = 3;

function configuredList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function candidateKey(runtime: RuntimeId, model: string | null): string {
  return `${runtime}:${model ?? "<default>"}`;
}

interface QueuedRecovery {
  failedRunId: number;
  runtime: RuntimeId;
  model: string | null;
  payload: Record<string, unknown>;
}

function queuedRecoveries(db: Db, itemId: number): QueuedRecovery[] {
  const rows = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='decision'
       AND json_extract(payload, '$.decision')='runtime_recovery_queued'
     ORDER BY id`,
  ).all(itemId) as Array<{ payload: string }>;
  const queued: QueuedRecovery[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (typeof payload.runtime !== "string" || typeof payload.failedRunId !== "number") continue;
      queued.push({
        failedRunId: payload.failedRunId,
        runtime: payload.runtime as RuntimeId,
        model: typeof payload.model === "string" ? payload.model : null,
        payload,
      });
    } catch {
      // 旧的或者坏掉的记录不挡住恢复。
    }
  }
  return queued;
}

// 失败链：同一角色、同一用途上，最后一个正常结束的 Run 之后的那些恢复。正常结束以后链就断了，
// 下一次失败从零开始算，长寿的工单不会因为很久以前的恢复用完额度。
function chainStart(db: Db, run: Run): number {
  const healthy = db.prepare(
    `SELECT MAX(id) AS id FROM runs
     WHERE item_id=? AND role=? AND purpose=? AND state='finished' AND error_code IS NULL AND id < ?`,
  ).get(run.item_id, run.role, run.purpose, run.id) as { id: number | null };
  return healthy.id ?? 0;
}

function priorResult(prior: QueuedRecovery, itemId: number): RuntimeRecoveryResult {
  return {
    status: "already_queued",
    itemId,
    failedRunId: prior.failedRunId,
    dispatchRequestId: typeof prior.payload.dispatchRequestId === "number" ? prior.payload.dispatchRequestId : null,
    runId: typeof prior.payload.runId === "number" ? prior.payload.runId : null,
    runtime: prior.runtime,
    model: prior.model,
    effort: typeof prior.payload.effort === "string" ? prior.payload.effort : null,
    category: prior.payload.category as FailureRecovery["category"],
    resumedFromRunId: prior.payload.sameRuntimeSession === true ? prior.failedRunId : null,
  };
}

/** 工单对话的 Run 收到的那条消息：以这个 Run 为来源的第一条 comment。 */
function conversationMessage(db: Db, run: Run): string | null {
  const row = db.prepare(
    "SELECT payload FROM activities WHERE run_id=? AND kind='comment' ORDER BY id LIMIT 1",
  ).get(run.id) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const content = (JSON.parse(row.payload) as { content?: unknown }).content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

export function recoverTicketRun(db: Db, input: RuntimeRecoveryRequest): RuntimeRecoveryResult {
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item #${input.itemId} not found`);
  const failedRun = getRun(db, input.failedRunId);
  if (!failedRun || failedRun.item_id !== input.itemId) {
    throw new Error(`run #${input.failedRunId} does not belong to item #${input.itemId}`);
  }
  if (failedRun.state === "starting" || failedRun.state === "running" || failedRun.state === "paused") {
    throw new Error(`run #${failedRun.id} is still ${failedRun.state}; stop it first (ticket_action stop_run), then recover it`);
  }
  if (failedRun.state === "finished") {
    throw new Error(
      `run #${failedRun.id} finished; recovery reruns a failed or stopped run. `
      + "For a finished delivery use ticket_action rework; for another review use spawn_child.",
    );
  }
  const conversation = failedRun.purpose === "conversation";
  if (conversation && !input.startConversation) {
    throw new Error(`run #${failedRun.id} is a ticket chat; resending it needs the ticket message route (Lead's recover_ticket_run)`);
  }
  if (!conversation && activeRun(db, input.itemId)) {
    throw new Error(`item #${input.itemId} already has an active run`);
  }
  const actor = input.authorityRef.startsWith("system:") ? "system" as const : "lead" as const;
  const queued = queuedRecoveries(db, input.itemId);
  const prior = [...queued].reverse().find((entry) => entry.failedRunId === input.failedRunId);
  if (prior) return priorResult(prior, input.itemId);

  const classification = failureRecovery(runFailure(failedRun));
  const start = chainStart(db, failedRun);
  const chain = queued.filter((entry) => entry.failedRunId > start
    && entry.payload.role === failedRun.role && entry.payload.purpose === failedRun.purpose);
  if (chain.length >= MAX_RECOVERY_STEPS) {
    return {
      status: "needs_user",
      itemId: input.itemId,
      failedRunId: input.failedRunId,
      category: classification.category,
      reason: `runtime recovery limit reached (${MAX_RECOVERY_STEPS} recoveries since the last healthy ${failedRun.purpose} run)`,
    };
  }

  const catalog = input.catalog ?? currentModelCatalog(db);
  const profileOf = input.runtimeProfile ?? defaultRuntimeProfile;
  const currentRuntime = failedRun.runtime;
  const currentModel = failedRun.model ?? null;
  // 试过的候选：这条链上排过的，和失败的这一个。只给 auto 用：Lead 明确选的候选可以再试，预算兜底。
  const tried = new Set([
    candidateKey(currentRuntime, currentModel),
    ...chain.map((entry) => candidateKey(entry.runtime, entry.model)),
  ]);
  const triedModels = new Set([
    ...(currentModel ? [currentModel] : []),
    ...chain.filter((entry) => entry.runtime === currentRuntime && entry.model).map((entry) => entry.model!),
  ]);
  const reviewer = failedRun.role === "reviewer";
  const modelHealthy = (runtime: RuntimeId, model: string | null): boolean => {
    try {
      return unavailableIncident(db, { profile: profileOf(runtime), model }) === null;
    } catch {
      return true;
    }
  };
  const runtimeUsable = (runtime: RuntimeId): boolean => {
    try {
      // 用户停用的 runtime 不在自动挑选的候选里（2026-10-19）。
      return !isRuntimeDisabled(runtime) && unavailableProfileIncident(db, profileOf(runtime)) === null;
    } catch {
      return false;
    }
  };
  const noCandidate = (reason: string): RuntimeRecoveryResult => ({
    status: "no_candidate",
    itemId: input.itemId,
    failedRunId: input.failedRunId,
    category: classification.category,
    reason,
  });

  let targetRuntime: RuntimeId | null = null;
  let targetModel: string | null = null;

  try {
    if (input.action === "auto" && !input.model && !input.runtime) {
      // 系统挑：失败类别说同一 runtime 换模型有用时，先试目录里的模型（显式配置的备选优先）；再试健康的 runtime。
      if (classification.sameRuntimeModelFallback && !isRuntimeDisabled(currentRuntime)) {
        const configured = [
          ...configuredList(`PLC_${currentRuntime.toUpperCase()}_FALLBACK_MODELS`),
          ...configuredList("PLC_FALLBACK_MODELS"),
        ].map((model) => resolveRuntimeModel(currentRuntime, model) ?? model);
        const fromCatalog = alternativeModels(catalog, currentRuntime, triedModels).map((model) => model.id);
        const model = [...configured, ...fromCatalog].find((candidate) =>
          !triedModels.has(candidate)
          && !tried.has(candidateKey(currentRuntime, candidate))
          && modelHealthy(currentRuntime, candidate));
        if (model) {
          targetRuntime = currentRuntime;
          targetModel = model;
        }
      }
      if (!targetRuntime) {
        // 核查按选核查员的顺序挑（能跑命令的在前，registry.ts 的 reviewRuntimeOrder），执行按 fallback 的顺序。
        const runtime = (reviewer ? reviewRuntimeOrder() : runtimeFallbackOrder()).find((candidate) =>
          candidate !== currentRuntime
          && !tried.has(candidateKey(candidate, null))
          && runtimeUsable(candidate));
        if (runtime) {
          targetRuntime = runtime;
          // 不替它选模型：由那个 CLI 自己的配置决定。
          targetModel = null;
        }
      }
      if (!targetRuntime) return noCandidate("no unused model or runtime is available in the catalog or configuration");
    } else {
      // Lead 明确选：不给的沿用失败的 Run。换了 runtime 又没给模型时，由那个 CLI 自己的配置决定。
      targetRuntime = input.runtime ?? currentRuntime;
      if (input.action === "switch_runtime" && targetRuntime === currentRuntime) {
        return noCandidate("switch_runtime needs a different runtime");
      }
      if (isRuntimeDisabled(targetRuntime)) return noCandidate(runtimeDisabledReason(targetRuntime));
      const chosen = validateModelChoice(catalog, { runtime: targetRuntime, model: input.model }).model;
      targetModel = chosen
        ? resolveRuntimeModel(targetRuntime, chosen) ?? null
        : targetRuntime === currentRuntime ? currentModel : null;
      if (input.action === "next_model" && (!targetModel || targetModel === currentModel)) {
        return noCandidate("next_model needs a different model");
      }
    }
  } catch (error) {
    if (error instanceof ModelChoiceError) return noCandidate(error.message);
    throw error;
  }
  const key = candidateKey(targetRuntime, targetModel);

  // effort：明确给的要按目录核对，不合法就不排；没给时，新目标也认原来的档位就沿用，不认就不传
  // （由 CLI 用这个模型的默认档位）；换 runtime 时不传。
  let effort: string | null = null;
  if (input.effort) {
    try {
      effort = validateModelChoice(catalog, { runtime: targetRuntime, model: targetModel, effort: input.effort }).effort;
    } catch (error) {
      if (error instanceof ModelChoiceError) return noCandidate(error.message);
      throw error;
    }
  } else if (failedRun.effort && targetRuntime === currentRuntime) {
    try {
      effort = validateModelChoice(catalog, { runtime: targetRuntime, model: targetModel, effort: failedRun.effort }).effort;
    } catch (error) {
      if (!(error instanceof ModelChoiceError)) throw error;
    }
  }

  const sameRuntime = targetRuntime === currentRuntime;
  const resumeFromRunId = sameRuntime && failedRun.external_session_id ? failedRun.id : undefined;
  const leadInstruction = input.instruction?.trim() || null;
  const policy = activeDelegationPolicy(db, input.itemId);
  const common = {
    category: classification.category,
    failedRunId: failedRun.id,
    failedRunState: failedRun.state,
    role: failedRun.role,
    purpose: failedRun.purpose,
    fromRuntime: currentRuntime,
    fromModel: currentModel,
    runtime: targetRuntime,
    model: targetModel,
    ...(effort ? { effort } : {}),
    ...(leadInstruction ? { instruction: leadInstruction } : {}),
    authorityRef: input.authorityRef,
    delegationPolicyId: policy?.id ?? null,
    sameRuntimeSession: sameRuntime && resumeFromRunId !== undefined,
  };

  if (conversation) {
    const message = leadInstruction ?? conversationMessage(db, failedRun);
    if (!message) return noCandidate(`run #${failedRun.id} has no message to resend; pass the message as instruction`);
    addActivity(db, {
      itemId: input.itemId, runId: failedRun.id, actor, kind: "decision",
      payload: { decision: "runtime_recovery_selected", ...common, reason: leadInstruction ?? classification.reason },
    });
    const runId = input.startConversation!({ runtime: targetRuntime, model: targetModel, effort, message });
    addActivity(db, {
      itemId: input.itemId, actor, kind: "decision",
      payload: { decision: "runtime_recovery_queued", runId, dispatchRequestId: null, ...common, reason: classification.reason },
    });
    return {
      status: "started",
      itemId: input.itemId,
      failedRunId: failedRun.id,
      dispatchRequestId: null,
      runId,
      runtime: targetRuntime,
      model: targetModel,
      effort,
      category: classification.category,
      resumedFromRunId: null,
    };
  }

  const evidence = failedRun.error_message ?? failedRun.error_code ?? `run ${failedRun.state}`;
  const instruction = reviewer
    ? [
        `这是一次重新发起的独立核查：上一次核查 Run #${failedRun.id} 没有完成（${classification.category}）。`,
        "核查纪律不变：只读、独立，不修改任何产物。",
        leadInstruction,
      ].filter(Boolean).join("\n")
    : [
        "这是同一张工单的重跑，不是新工单。",
        `原 Run #${failedRun.id}（${failedRun.state}）：${classification.category}。`,
        `失败证据：${evidence}`,
        leadInstruction ?? "请继续原工单的执行目标，先检查原失败原因，再完成剩余工作并提交结构化结果。",
      ].join("\n");
  const idempotencyKey = `runtime-recovery:${input.itemId}:source:${failedRun.id}:candidate:${key}`;
  const existing = db.prepare("SELECT id FROM dispatch_requests WHERE idempotency_key=?")
    .get(idempotencyKey) as { id: number } | undefined;
  if (existing) {
    return {
      status: "already_queued",
      itemId: input.itemId,
      failedRunId: failedRun.id,
      dispatchRequestId: existing.id,
      runId: null,
      runtime: targetRuntime,
      model: targetModel,
      effort,
      category: classification.category,
      resumedFromRunId: resumeFromRunId ?? null,
    };
  }

  const requestId = db.transaction(() => {
    // 只有执行 Run 改工单的执行配置：之后的返工和续作用新的 runtime 和模型。核查、合并、修复回合不改。
    if (failedRun.role === "executor" && failedRun.purpose === "execution") {
      db.prepare(
        "UPDATE items SET requested_runtime=?, requested_model=?, updated_at=datetime('now') WHERE id=?",
      ).run(targetRuntime, targetModel, input.itemId);
    }
    addActivity(db, {
      itemId: input.itemId,
      runId: failedRun.id,
      actor,
      kind: "decision",
      payload: { decision: "runtime_recovery_selected", ...common, reason: leadInstruction ?? classification.reason },
    });
    const request = createDispatcher(db).request({
      itemId: input.itemId,
      role: failedRun.role,
      purpose: failedRun.purpose,
      runtime: targetRuntime!,
      model: targetModel ?? undefined,
      ...(effort ? { effort } : {}),
      resumeFromRunId,
      // 之后工单又跑了同一角色、同一用途的 Run（例如用户手动换了 runtime），这次恢复就作废，不会多跑一次。
      retryOfRunId: failedRun.id,
      instruction,
      trigger: "runtime-recovery",
      idempotencyKey,
    });
    addActivity(db, {
      itemId: input.itemId,
      actor,
      kind: "decision",
      payload: { decision: "runtime_recovery_queued", dispatchRequestId: request, runId: null, ...common, reason: classification.reason },
    });
    return request;
  })();

  return {
    status: "queued",
    itemId: input.itemId,
    failedRunId: failedRun.id,
    dispatchRequestId: requestId,
    runId: null,
    runtime: targetRuntime,
    model: targetModel,
    effort,
    category: classification.category,
    resumedFromRunId: resumeFromRunId ?? null,
  };
}

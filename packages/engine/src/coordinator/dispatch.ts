import { randomUUID } from "node:crypto";
import { runUpdatedEvent } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { createRun, getRun, markRunFailed, markRunFinished, updateRun } from "@pi-lead-child/store";
import { getItem, getReviewerSetting, getReviewVerdictDetails, sameReviewVerdictDetails, transition, writeReviewVerdictDetails } from "@pi-lead-child/store";
import {
  assertRunAllowed, executorRetryBudget, outcomeRepairRefusal, retryExhaustedMessage,
} from "@pi-lead-child/store";
import type { RunPurpose, RuntimeDisabledBy, RuntimeId } from "@pi-lead-child/core";
import { addActivity } from "@pi-lead-child/store";
import { addInbox, recordInboxEvent } from "@pi-lead-child/store";
import { createCoordinator } from "./service.js";
import { persistSelectedRuntime, selectChildRuntime } from "../runtime-catalog.js";
import { runEffortFor, runModelFor, runProfileChoice } from "./run-choice.js";
import { typedFailure } from "@pi-lead-child/runtime";
import { defaultRuntimeProfile, findRuntimeAdapter, isRuntimeDisabled, runtimeDisabledReason } from "@pi-lead-child/runtime";
import { runtimeProfileHash, type RuntimeProfile } from "@pi-lead-child/runtime";
import { preflightAllowsClaim, type RuntimePreflight } from "../pipeline/preflight.js";
import { runtimeSuspensionReason, unavailableIncident, unavailableProfileIncident } from "@pi-lead-child/store";
import { listBlockingDependencies } from "@pi-lead-child/store";
import { dispatchWorkspaceId } from "./workspace-policy.js";
import { applyReviewAutomation, noteDelegatedReviewBlocked } from "./delegated-review.js";
import {
  staleReviewRequestReason, verificationBoundaryRunId, verificationState,
} from "./review-authority.js";
import { latestDeliveryRunId } from "../pipeline/delivery-run.js";
import { normalizeReviewVerdict, type ReviewVerdictSubmission } from "./review-verdict.js";
import type { BlockingTicket } from "@pi-lead-child/store";
import {
  itemReviewer, recordReviewerSwitch, reviewerIncidentReason, reviewerProfileFor, reviewerUnavailableReason, reviewRequestRuntime,
} from "./reviewer-choice.js";

export interface DispatchRequestInput {
  itemId: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  workflowKind?: "generic" | "coding";
  workspaceId?: number;
  runtime?: RuntimeId;
  model?: string;
  // 推理强度（effort）。没有时按 run-choice.ts 沿用上一个同类 Run 的选择，再没有就不传。
  effort?: string;
  resumeFromRunId?: number;
  // 内核为这个失败的 Run 自动排的重试（工单 03）。工单之后又跑了新的 Run，这个重试就作废。
  retryOfRunId?: number;
  // 内核的退避重试（工单 06）：不早于这个绝对时间（ISO）才能 claim，以及这是第几次自动重试。
  notBefore?: string;
  backoffAttempt?: number;
  instruction?: string;
  planOwnerItemId?: number;
  planRevision?: number;
  trigger: string;
  idempotencyKey: string;
}

export interface DispatchClaim {
  requestId: number;
  itemId: number;
  runId: number;
  leaseToken: string;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  workflowKind: "generic" | "coding";
  workspaceId: number | null;
  runtime: RuntimeId;
  model: string | null;
  effort: string | null;
  resumeFromRunId: number | null;
  instruction: string | null;
  trigger: string;
  planOwnerItemId: number | null;
  planRevision: number | null;
}

interface DispatchRequestRow {
  id: number;
  item_id: number;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  runtime: RuntimeId | null;
  model: string | null;
  effort: string | null;
  resume_from_run_id: number | null;
  instruction: string | null;
  plan_owner_item_id: number | null;
  plan_revision: number | null;
  trigger: string;
  idempotency_key: string;
  state: string;
  suspended_reason: string | null;
  suspended_incident_id: number | null;
  retry_of_run_id: number | null;
  not_before: string | null;
  backoff_attempt: number | null;
}

export interface Dispatcher {
  request(input: DispatchRequestInput): number;
  claimNext(): DispatchClaim | null;
  markStarted(claim: DispatchClaim): void;
  completeRun(runId: number): void;
  // 认领的 Run 在启动时被 runItem 拒绝（run_start_refused）：这件事还没做。请求退避一段时间后回到队列。
  requeueRefusedStart(runId: number): void;
  reclaimExpired(): number;
  // 核查员的 review_verdict（工单 10）：总结论和证据，加上逐条结论（criteria）和可选的 escalate。
  // 逐条结论要和这次的核查包对得上（review-verdict.ts 的 normalizeReviewVerdict），对不上时抛 ReviewVerdictError。
  submitReviewVerdict(input: { runId: number } & ReviewVerdictSubmission): void;
}

// 派发请求的"不早于"时间（工单 06）到了没有。claim、工单投影和 lead 的工单详情共用这一条判断。
// 没有这个时间的请求随时可以派发。读不懂的时间按已到期处理，请求不会永远卡在队列里。
export function notBeforeReached(notBefore: string | null, at: Date): boolean {
  return notBefore === null || !(Date.parse(notBefore) > at.getTime());
}

function expireReviewRequest(db: Db, row: { id: number; item_id: number; trigger: string }, reason: string): boolean {
  return db.transaction(() => {
    const cancelled = db.prepare(
      "UPDATE dispatch_requests SET state='cancelled', updated_at=datetime('now') WHERE id=? AND state='pending'",
    ).run(row.id).changes === 1;
    if (!cancelled) return false;
    addActivity(db, {
      itemId: row.item_id,
      actor: "system",
      kind: "decision",
      payload: { decision: "review_request_expired", dispatchRequestId: row.id, trigger: row.trigger, reason },
    });
    return true;
  })();
}

/**
 * 新一次交付开始时，作废之前排着的核查请求：它们要核查的那份成果马上就会变。
 * 有的请求看不出自己为哪次交付而建（Lead 的 spawn-suspended、工单 agent 的 ticket-agent-continuation）。
 * 用户返工后直接点"开始执行"时，dispatcher 一次也看不到工单离开 review（交付 Run 在跑时 claim 跳过这张
 * 工单），新交付回到 review 以后，这种请求就像是为新交付排的。所以在交付开始的这一刻作废。
 */
export function expireReviewRequestsForNewDelivery(db: Db, input: { itemId: number; runId: number }): number {
  const rows = db.prepare(
    "SELECT id, item_id, trigger FROM dispatch_requests WHERE item_id=? AND role='reviewer' AND state='pending'",
  ).all(input.itemId) as Array<{ id: number; item_id: number; trigger: string }>;
  return rows.filter((row) => expireReviewRequest(db, row, `交付 Run #${input.runId} 开始了，之前的成果不再需要核查`))
    .length;
}

export function createDispatcher(
  db: Db,
  options?: {
    now?: () => Date;
    leaseMs?: number;
    softBudgetRatio?: number;
    hasCostEstimator?: (runtime: RuntimeId, model: string | null) => boolean;
    // 派发 gate 按 profile 查健康账本。daemon 传入自己 registry 里的 profile，执行时记账用的也是它。
    runtimeProfile?: (runtime: RuntimeId) => RuntimeProfile;
    // 停用的执行器是谁停用的（D11，工单 11）：核查挂起时的通知按它判断 Lead 能不能凭证据验收。daemon 注入工单操作宿主的同一个函数。
    runtimeDisabledBy?: (runtime: RuntimeId) => RuntimeDisabledBy | null;
    // claim 之前的 preflight（工单 05）。没有给出时不做 preflight。
    preflight?: RuntimePreflight;
    // 这张工单是不是还被一个 Run 占着（宿主的 live 表）。库里的状态盖不住收尾阶段：那时 Run 已是 finished，
    // 进程还在退出。认领它会和那个 Run 撞上（发布评审：claimNext 不看在跑的表）。
    itemBusy?: (itemId: number) => boolean;
    log?: (line: string) => void;
  },
): Dispatcher {
  const now = options?.now ?? (() => new Date());
  const leaseMs = options?.leaseMs ?? Number(process.env.PLC_DISPATCH_LEASE_MS ?? 30_000);
  const softBudgetRatio = options?.softBudgetRatio ?? Number(process.env.PLC_BUDGET_SOFT_RATIO ?? 0.8);
  // 配置了 USD 预算的工单只能派给 usage 带 USD 成本的 runtime。adapter 声明它带不带（工单 12）。
  const hasCostEstimator = options?.hasCostEstimator
    ?? ((runtime: RuntimeId) => findRuntimeAdapter(runtime)?.reportsCost ?? false);
  const coordinator = createCoordinator({ db, now });
  const preflight = options?.preflight;
  const runtimeProfile = options?.runtimeProfile ?? preflight?.profile ?? defaultRuntimeProfile;

  const touchItemActivity = (itemId: number): void => {
    db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(itemId);
  };

  const recoverySourceRun = (requestId: number, itemId: number): number | null => {
    const row = db.prepare(
      `SELECT a.run_id
       FROM activities a
       WHERE a.item_id=? AND a.kind='crash' AND a.run_id IS NOT NULL
         AND json_extract(a.payload, '$.dispatchRequestId')=?
         AND NOT EXISTS (
           SELECT 1 FROM checkpoints c
           WHERE c.idempotency_key LIKE 'run-recovered:' || a.run_id || ':%'
         )
       ORDER BY a.id DESC LIMIT 1`,
    ).get(itemId, requestId) as { run_id: number } | undefined;
    return row?.run_id ?? null;
  };

  const request = (input: DispatchRequestInput): number => {
    const item = getItem(db, input.itemId);
    if (!item) throw new Error(`item #${input.itemId} not found`);
    if (input.resumeFromRunId !== undefined) {
      const sourceRun = getRun(db, input.resumeFromRunId);
      if (!sourceRun) throw new Error(`resume source run #${input.resumeFromRunId} not found`);
      if (sourceRun.item_id !== input.itemId) {
        throw new Error(`resume source run #${input.resumeFromRunId} does not belong to item #${input.itemId}`);
      }
    }
    const instruction = input.instruction?.trim() || null;
    const existing = db.prepare("SELECT id FROM dispatch_requests WHERE idempotency_key=?")
      .get(input.idempotencyKey) as { id: number } | undefined;
    if (existing) return existing.id;
    // 核查请求没点名 runtime 时用这张工单的核查员（reviewer-choice.ts 的 reviewRequestRuntime，工单 09）：Lead 或用户选好的；
    // 没选时按选核查员的规则选，避开执行者的 runtime。不把选出来的写回工单：工单上的 runtime 是给执行者的。
    const reviewer = input.role === "reviewer";
    // 工单上记着的 runtime 被用户停用了（2026-10-19）：它多半是上一次选出来存下的，不是这次点名的，按没有固定处理，重新选。
    // 这次请求自己点名的 runtime（重试、恢复、核查）照写：执行请求由 claim 挂起并叫醒 Lead 改派，核查请求在 claim 时换核查员。
    const itemRuntime = item.requested_runtime && !isRuntimeDisabled(item.requested_runtime) ? item.requested_runtime : null;
    const declared = input.runtime
      ?? (reviewer ? reviewRequestRuntime(db, item.id, { profile: runtimeProfile }) : itemRuntime);
    // 不固定 runtime 时，选择跳过不健康的 profile（spec D2）。固定了 runtime 的请求不切换，由 claim 挂起。
    const picked = declared
      ? { runtime: declared, source: "requested" as const, fallbackFrom: null, reason: "declared runtime" }
      : selectChildRuntime({
          role: input.role === "reviewer" ? "reviewer" : "executor",
          unavailable: (candidate) => unavailableProfileIncident(db, runtimeProfile(candidate)) !== null,
        });
    const skippedDisabled = !declared && item.requested_runtime && item.requested_runtime !== picked.runtime
      ? item.requested_runtime : null;
    const selected = skippedDisabled
      ? { ...picked, fallbackFrom: skippedDisabled, reason: `${runtimeDisabledReason(skippedDisabled)}改用 ${picked.runtime}` }
      : picked;
    if (!declared) persistSelectedRuntime(db, input.itemId, selected);
    const runtime = selected.runtime;
    // 模型和 effort 按 run-choice.ts 的同一条规则选：核查不拿执行者的模型，续接的 session 沿用原来的模型。
    // 核查请求用工单选好的核查员（选好的那一行，不管现在能不能用）：不能用时由认领时的 switchReviewer 换，并记一条活动。
    const resumedFrom = input.resumeFromRunId ? getRun(db, input.resumeFromRunId) ?? null : null;
    const reviewerChoice = input.role === "reviewer" ? getReviewerSetting(db, item.id) : null;
    const model = runModelFor({
      explicit: input.model, role: input.role, runtime, item, resumedFrom, reviewer: reviewerChoice,
      choice: runProfileChoice(db, item.id, input.role),
    });
    const effort = runEffortFor(db, {
      explicit: input.effort, itemId: input.itemId, role: input.role, purpose: input.purpose, runtime, model, resumedFrom,
      reviewer: reviewerChoice,
    });
    const result = db.prepare(
      `INSERT INTO dispatch_requests
       (item_id, role, purpose, runtime, model, effort, resume_from_run_id, retry_of_run_id, instruction,
        plan_owner_item_id, plan_revision, trigger, idempotency_key, not_before, backoff_attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.itemId, input.role, input.purpose, runtime,
      model ?? null, effort ?? null, input.resumeFromRunId ?? null, input.retryOfRunId ?? null, instruction,
      input.planOwnerItemId ?? null,
      input.planRevision ?? null, input.trigger, input.idempotencyKey,
      input.notBefore ?? null, input.backoffAttempt ?? null,
    );
    const requestId = Number(result.lastInsertRowid);
    // reviewer 请求记下它为哪一次交付而建：当时最新的那次（review-authority.ts 的 staleReviewRequestReason）。
    // 有的请求的幂等键里没有交付（Lead 的 spawn-suspended、工单 agent 的 ticket-agent-continuation）。
    const reviewDelivery = input.role === "reviewer" || input.purpose === "review"
      ? latestDeliveryRunId(db, input.itemId)
      : null;
    addActivity(db, {
      itemId: input.itemId,
      actor: "system",
      kind: "decision",
      payload: {
        decision: "dispatch_requested",
        dispatchRequestId: requestId,
        ...(reviewDelivery === null ? {} : { reviewDeliveryRunId: reviewDelivery }),
        role: input.role,
        purpose: input.purpose,
        runtime,
        model: model ?? null,
        ...(effort ? { effort } : {}),
        resumeFromRunId: input.resumeFromRunId ?? null,
        instruction,
        ...(input.notBefore ? { notBefore: input.notBefore } : {}),
        trigger: input.trigger,
        idempotencyKey: input.idempotencyKey,
      },
    });
    touchItemActivity(input.itemId);
    return requestId;
  };

  const recordRelationBlock = (row: DispatchRequestRow, blockers: BlockingTicket[]): void => {
    const existing = db.prepare(
      `SELECT 1 FROM activities
       WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')='dispatch_blocked_by_ticket_relation'
         AND json_extract(payload, '$.dispatchRequestId')=?
       LIMIT 1`,
    ).get(row.item_id, row.id);
    if (existing) return;
    addActivity(db, {
      itemId: row.item_id,
      actor: "system",
      kind: "decision",
      payload: {
        decision: "dispatch_blocked_by_ticket_relation",
        dispatchRequestId: row.id,
        blockers: blockers.map((blocker) => ({
          ticketId: blocker.id,
          title: blocker.title,
          stage: blocker.stage,
        })),
        message: `dispatch request #${row.id} is blocked by depends_on relation(s)`,
      },
    });
    touchItemActivity(row.item_id);
  };

  const relationDependenciesReady = (row: DispatchRequestRow): boolean => {
    const blockers = listBlockingDependencies(db, row.item_id);
    if (!blockers.length) return true;
    recordRelationBlock(row, blockers);
    return false;
  };

  const dependenciesReady = (row: DispatchRequestRow): boolean => {
    if (row.plan_owner_item_id === null || row.plan_revision === null) return true;
    const revision = db.prepare(
      "SELECT state FROM item_plan_revisions WHERE parent_item_id=? AND revision=?",
    ).get(row.plan_owner_item_id, row.plan_revision) as { state: string } | undefined;
    if (revision?.state !== "sealed") return false;
    const member = db.prepare(
      `SELECT 1 FROM item_plan_memberships
       WHERE parent_item_id=? AND revision=? AND child_item_id=?`,
    ).get(row.plan_owner_item_id, row.plan_revision, row.item_id);
    if (!member) return false;
    const blocked = db.prepare(
      `SELECT 1 FROM item_dependencies d
       JOIN items prerequisite ON prerequisite.id=d.depends_on_item_id
       WHERE d.parent_item_id=? AND d.plan_revision=? AND d.item_id=?
         AND prerequisite.stage <> 'done' LIMIT 1`,
    ).get(row.plan_owner_item_id, row.plan_revision, row.item_id);
    return !blocked;
  };

  const purposeReady = (row: DispatchRequestRow): boolean => {
    const item = getItem(db, row.item_id);
    if (!item) return false;
    if (row.role === "reviewer" || row.purpose === "review") {
      // reviewer 请求只在 review 里、为当时最新的那次交付而建（review-authority.ts 的
      // staleReviewRequestReason）。所以请求本身就是核查这次交付的授权，不论是谁建的：用户、
      // 自动核查、Lead（含 spawn-suspended）、工单 agent，以及它们失败后的重试。过期的请求在
      // claimNext 里先作废了。以前这里只放行要求独立核查的工单和少数 trigger，其余请求在用户验收的
      // 工单上一直"排队中"。
      // 用户在工单里提问不算新一轮交付（delivery-run.ts），不能让已有的核查结论"过期"后再派一次。
      return item.stage === "review" && verificationState(db, item.id).current === null;
    }
    if (row.purpose === "integration") {
      return item.stage === "active" && item.plan_state === "integrating";
    }
    // draft 不在其中，这一行就是"建完先别跑"真正的落点：未确认的 item 永远不会被 claim。
    // 与 store/run-gate.ts 的 EXECUTOR_STAGES 同源——那里是硬闸门，这里是排队谓词。
    return ["ready", "active", "blocked"].includes(item.stage);
  };

  const rootUsage = (rootId: number) => db.prepare(
    `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(total_cost_usd), 0) AS cost
     FROM items WHERE root_item_id=?`,
  ).get(rootId) as { tokens: number; cost: number };

  const notifyBudget = (rootId: number, severity: "attention" | "blocker", summary: string) => {
    const exists = db.prepare(
      "SELECT 1 FROM inbox WHERE item_id=? AND summary=? AND state IN ('pending','delivered') LIMIT 1",
    ).get(rootId, summary);
    if (!exists) {
      db.transaction(() => {
        const inserted = db.prepare(
          `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary, payload)
           VALUES (?, ?, ?, 'structural', ?, ?)`,
        ).run(
          rootId,
          `item:${rootId}`, // 去抖分组键（spec §5.5）
          severity, summary, JSON.stringify({ kind: "orchestration_budget" }),
        );
        // 双写（Lead 事件主干，工单 01）：这一行不经过 addInbox，在同一个事务里补记它的事件。
        recordInboxEvent(db, Number(inserted.lastInsertRowid));
      })();
    }
  };

  const blockRoot = (rootId: number, summary: string) => {
    const root = getItem(db, rootId);
    if (!root) return;
    // 预算耗尽是编排机器做出的判断，不是 lead 的工具调用，故 actor 为 system。
    // draft 不在分支里：未确认的 item 从不被 claim，也就从不消耗预算。
    if (root.stage === "ready") {
      transition(db, { itemId: root.id, to: "active", actor: "system", reason: summary });
      transition(db, { itemId: root.id, to: "blocked", actor: "system", reason: summary });
    } else if (root.stage === "active") {
      transition(db, { itemId: root.id, to: "blocked", actor: "system", reason: summary });
    }
    db.prepare("UPDATE items SET plan_state='failed', updated_at=datetime('now') WHERE id=?")
      .run(root.id);
    const existing = db.prepare(
      `SELECT 1 FROM activities
       WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')='dispatch_blocked_by_budget'
         AND json_extract(payload, '$.summary')=?
       LIMIT 1`,
    ).get(root.id, summary);
    if (!existing) {
      addActivity(db, {
        itemId: root.id,
        actor: "system",
        kind: "decision",
        payload: { decision: "dispatch_blocked_by_budget", summary },
      });
      touchItemActivity(root.id);
    }
    notifyBudget(root.id, "blocker", summary);
  };

  const cancelRetryExhausted = (row: DispatchRequestRow): void => {
    const budget = executorRetryBudget(db, row.item_id);
    const message = retryExhaustedMessage(row.item_id, budget);
    const cancelled = db.prepare(
      "UPDATE dispatch_requests SET state='cancelled', updated_at=datetime('now') WHERE id=? AND state='pending'",
    ).run(row.id);
    if (cancelled.changes !== 1) return;
    const item = getItem(db, row.item_id);
    if (item?.stage === "active") {
      transition(db, {
        itemId: row.item_id,
        to: "blocked",
        actor: "system",
        reason: message,
      });
    }
    addActivity(db, {
      itemId: row.item_id,
      actor: "system",
      kind: "decision",
      payload: {
        decision: "dispatch_blocked_retry_exhausted",
        dispatchRequestId: row.id,
        trigger: row.trigger,
        failures: budget.failures,
        retryLimit: budget.retryLimit,
        message,
      },
    });
    touchItemActivity(row.item_id);
    addInbox(db, {
      itemId: row.item_id,
      severity: "blocker",
      source: "structural",
      summary: message,
    });
  };

  const budgetReady = (row: DispatchRequestRow): boolean => {
    const item = getItem(db, row.item_id);
    if (!item) return false;
    // root_item_id 可空（自根行 insert-then-update 的中间态、以及 reminder 恒为 NULL），
    // 空即"自己就是根"。
    const root = getItem(db, item.root_item_id ?? item.id) ?? item;
    const usage = rootUsage(root.id);
    if (root.token_budget !== null) {
      if (usage.tokens >= root.token_budget) {
        blockRoot(root.id, `工单 #${root.id} 已达到 token 预算上限 ${root.token_budget}`);
        return false;
      }
      if (usage.tokens >= root.token_budget * softBudgetRatio) {
        notifyBudget(root.id, "attention", `工单 #${root.id} token 预算接近上限（${usage.tokens}/${root.token_budget}）`);
      }
    }
    if (root.cost_budget_usd !== null) {
      const runtime = row.runtime ?? item.requested_runtime ?? selectChildRuntime({
        role: row.role === "reviewer" ? "reviewer" : "executor",
      }).runtime;
      if (!hasCostEstimator(runtime, row.model)) {
        blockRoot(root.id, `工单 #${root.id} 配置了 USD 预算，但 runtime ${runtime} 无成本估算器`);
        return false;
      }
      if (usage.cost >= root.cost_budget_usd) {
        blockRoot(root.id, `工单 #${root.id} 已达到 USD 预算上限 ${root.cost_budget_usd}`);
        return false;
      }
      if (usage.cost >= root.cost_budget_usd * softBudgetRatio) {
        notifyBudget(root.id, "attention", `工单 #${root.id} USD 预算接近上限（${usage.cost}/${root.cost_budget_usd}）`);
      }
    }
    return true;
  };

  const concurrencyReady = (row: DispatchRequestRow): boolean => {
    const item = getItem(db, row.item_id)!;
    const root = getItem(db, item.root_item_id ?? item.id) ?? item;
    const rootActive = (db.prepare(
      `SELECT COUNT(*) AS n FROM dispatch_claims c
       JOIN items t ON t.id=c.item_id WHERE t.root_item_id=?`,
    ).get(root.id) as { n: number }).n;
    const rootLimit = root.max_concurrency ?? Number(process.env.PLC_MAX_ROOT_CONCURRENCY ?? 4);
    if (rootActive >= rootLimit) return false;
    if (item.project_id !== null) {
      const project = db.prepare("SELECT max_concurrency FROM projects WHERE id=?")
        .get(item.project_id) as { max_concurrency: number | null } | undefined;
      const projectLimit = project?.max_concurrency ?? Number(process.env.PLC_MAX_PROJECT_CONCURRENCY ?? 8);
      const projectActive = (db.prepare(
        `SELECT COUNT(*) AS n FROM dispatch_claims c JOIN items t ON t.id=c.item_id
         WHERE t.project_id=?`,
      ).get(item.project_id) as { n: number }).n;
      if (projectActive >= projectLimit) return false;
    }
    return true;
  };

  // 这条请求会派到哪个 runtime 和模型。gate 和 claim 必须算出同一个目标。
  const dispatchTarget = (row: DispatchRequestRow): { runtime: RuntimeId; model: string | undefined; effort: string | undefined } => {
    const item = getItem(db, row.item_id)!;
    const runtime = row.runtime ?? item.requested_runtime ?? selectChildRuntime({
      role: row.role === "reviewer" ? "reviewer" : "executor",
    }).runtime;
    const resumedFrom = row.resume_from_run_id ? getRun(db, row.resume_from_run_id) ?? null : null;
    // 认领时用按能不能用换过的核查员（reviewer-choice.ts 的 reviewerProfileFor）：switchReviewer 清空了请求上的模型以后，
    // 这里不会再拿回那个不能用的模型。
    const reviewer = reviewerProfileFor(db, item.id, row.role, { profile: runtimeProfile });
    const model = runModelFor({
      explicit: row.model, role: row.role, runtime, item, resumedFrom, reviewer, choice: runProfileChoice(db, item.id, row.role),
    });
    const effort = runEffortFor(db, {
      explicit: row.effort, itemId: row.item_id, role: row.role, purpose: row.purpose, runtime, model, resumedFrom, reviewer,
    });
    return { runtime, model, effort };
  };

  // 内核的自动重试只是失败之后的默认续作。之后工单又跑过同一角色、同一用途的 Run，这个重试就过时了。
  // 例如用户或 lead 换了 runtime。放行过时的重试，会在恢复后多跑一次。
  // 用途也要相同：工单对话不是执行，不能让执行的重试作废。
  // 这个请求自己派出的 Run 不算（工单 06）：daemon 重启回收孤儿 Run、或者租约过期时，请求回到队列，
  // 那个被打断的 Run 带着 crash 活动，活动里记着这个请求的 id。少了这一条，请求会被自己的 Run 作废。
  // 没启动成的 Run（run_start_refused）也不算：它没有开始，不是一次新的尝试（发布评审 reliability-backlog）。
  const supersededRetry = (row: DispatchRequestRow): boolean => {
    if (row.retry_of_run_id === null) return false;
    const newer = db.prepare(
      `SELECT r.id FROM runs r
       WHERE r.item_id=? AND r.role=? AND r.purpose=? AND r.id>?
         AND r.error_code IS NOT 'run_start_refused'
         AND NOT EXISTS (
           SELECT 1 FROM activities a
           WHERE a.run_id=r.id AND a.kind='crash' AND json_extract(a.payload, '$.dispatchRequestId')=?
         )
       ORDER BY r.id LIMIT 1`,
    ).get(row.item_id, row.role, row.purpose, row.retry_of_run_id, row.id) as { id: number } | undefined;
    if (!newer) return false;
    const cancelled = db.prepare(
      "UPDATE dispatch_requests SET state='cancelled', updated_at=datetime('now') WHERE id=? AND state='pending'",
    ).run(row.id).changes === 1;
    if (cancelled) {
      addActivity(db, {
        itemId: row.item_id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "runtime_health_retry_superseded",
          dispatchRequestId: row.id,
          retryOfRunId: row.retry_of_run_id,
          supersededByRunId: newer.id,
        },
      });
    }
    return true;
  };

  // 被挂起以后谁能做什么。核查请求在 claim 时自动换核查员（switchReviewer），走到这里说明所有 runtime 都停用了。
  // 失败后的重试（retry_of_run_id）可以用 recover_ticket_run 在那个失败的 Run 上改派；别的请求没有改派的工具。
  const disabledNextStep = (row: DispatchRequestRow, runtime: RuntimeId): string => {
    if (row.role === "reviewer") {
      return `所有执行器都被用户停用了，核查派不出去。用户在设置 → 执行器里启用任何一个以后，这个请求自动换过去派发（现在点名的是 ${runtime}）。`
        + "告诉用户：在那之前委托给你验收的工单关不了，他可以亲自验收。";
    }
    if (row.retry_of_run_id !== null) {
      return `用 recover_ticket_run 在失败的 Run #${row.retry_of_run_id} 上改派到没有停用的 runtime，这个重试会自动作废；`
        + `或者请用户在设置 → 执行器里重新启用 ${runtime}。`;
    }
    return `请用户在设置 → 执行器里重新启用 ${runtime}，这个请求就自动放行；不用它的话，请用户取消这个工单或者告诉你怎样改。`;
  };

  // 用户停用的 runtime（2026-10-19）：点名它的请求保持 pending，写明原因，叫醒 Lead 一次。
  // 不自动换 runtime：换成哪一个是 Lead 的事（manager.ts 记着 2026-10-15 的用户决定）。用户重新启用后照常派发。
  // 原因只在变化时写一次，所以每个 tick 重复检查不会刷活动。
  const disabledHold = (row: DispatchRequestRow): boolean => {
    const { runtime } = dispatchTarget(row);
    if (!isRuntimeDisabled(runtime)) return false;
    const reason = `${runtimeDisabledReason(runtime)}派发请求 #${row.id} 挂起，等改派到别的 runtime，或者在设置里重新启用。`;
    if (row.suspended_reason === reason && row.suspended_incident_id === null) return true;
    db.transaction(() => {
      db.prepare(
        `UPDATE dispatch_requests SET suspended_reason=?, suspended_incident_id=NULL, updated_at=datetime('now')
         WHERE id=? AND state='pending'`,
      ).run(reason, row.id);
      addActivity(db, {
        itemId: row.item_id,
        actor: "system",
        kind: "decision",
        payload: { decision: "dispatch_suspended_runtime_disabled", dispatchRequestId: row.id, runtime, message: reason },
      });
      addInbox(db, {
        itemId: row.item_id,
        dedupScope: `runtime-disabled:request:${row.id}`,
        severity: "attention",
        source: "structural",
        summary: `工单 #${row.item_id} 的派发请求 #${row.id}（${row.role}）点名了被停用的 ${runtime}，已挂起。`,
        payload: {
          kind: "dispatch_runtime_disabled", wakeLead: true, needsUser: false,
          dispatchRequestId: row.id, runtime, role: row.role, purpose: row.purpose,
          nextStep: disabledNextStep(row, runtime),
        },
        lossless: true,
      });
      touchItemActivity(row.item_id);
    })();
    return true;
  };

  // 派发 gate（spec D2）：目标不可用时，请求保持 pending，并带上看得见的挂起原因。
  // 不创建 Run。原因只在变化时写一次，所以每个 tick 重复检查不会刷活动。
  // 目标上任何一次没关闭的故障都挂起（2026-10-20 起没有金丝雀：探针通过就关闭故障，请求随后放行）。
  // 核查请求走到这里时，switchReviewer 已经试过换核查员，说明没有能用的核查员。
  const healthReady = (row: DispatchRequestRow): boolean => {
    const target = dispatchTarget(row);
    const incident = unavailableIncident(db, { profile: runtimeProfile(target.runtime), model: target.model });
    if (!incident) {
      if (row.suspended_incident_id !== null) {
        db.prepare(
          `UPDATE dispatch_requests SET suspended_reason=NULL, suspended_incident_id=NULL, updated_at=datetime('now')
           WHERE id=? AND state='pending'`,
        ).run(row.id);
      }
      return true;
    }
    if (row.suspended_incident_id === incident.id) return false;
    const reason = row.role === "reviewer"
      ? `没有能用的核查员，核查请求挂起：${runtimeSuspensionReason(incident)}`
      : runtimeSuspensionReason(incident);
    db.transaction(() => {
      db.prepare(
        `UPDATE dispatch_requests SET suspended_reason=?, suspended_incident_id=?, updated_at=datetime('now')
         WHERE id=? AND state='pending'`,
      ).run(reason, incident.id, row.id);
      addActivity(db, {
        itemId: row.item_id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "dispatch_suspended_by_runtime_health",
          dispatchRequestId: row.id,
          incidentId: incident.id,
          runtime: target.runtime,
          model: target.model ?? null,
          message: reason,
        },
      });
      // 委托给 Lead 验收的工单靠这次核查收尾：核查挂起时要说出来，不能让工单静静停在 review。
      if (row.role === "reviewer" && row.purpose === "review") {
        noteDelegatedReviewBlocked(db, {
          itemId: row.item_id, incidentId: incident.id, runtime: target.runtime, reason,
          host: {
            ...(options?.runtimeProfile ? { profile: options.runtimeProfile } : {}),
            ...(options?.runtimeDisabledBy ? { runtimeDisabledBy: options.runtimeDisabledBy } : {}),
          },
        });
      }
      touchItemActivity(row.item_id);
    })();
    return false;
  };

  // 核查请求的核查员不能用了（被用户停用，或者目标上有没关闭的故障）：认领时换成下一个能用的核查员（2026-10-20）。
  // 换成谁按 reviewer-choice.ts 的 itemReviewer：按「runtime 加模型」判断（2026-10-22 审查 H1）。只是模型不能用时，
  // 换成同一个 runtime 的默认模型；runtime 也不能用时，系统选，避开执行者的 runtime（工单 09，D3）。
  // 以前核查请求点名的 runtime 不能用时就挂起等着，Lead 和用户都换不了（用户：「codex 标记不可用了你就换就行了」）。
  // 直接改这条请求的 runtime，清掉模型和 effort（它们属于原来的 runtime）和挂起原因，记一条活动，然后照常走后面的 gate。
  // 换不出能用的核查员时不换（例外：原来的被停用、新的没停用，换过去等它的故障恢复，用户不用重新启用），由后面的 gate 挂起。
  // 执行请求不在这里换：换哪个执行者是 Lead 的事（manager.ts 记着 2026-10-15 的用户决定）。
  const switchReviewer = (row: DispatchRequestRow): void => {
    if (row.role !== "reviewer") return;
    const { runtime, model } = dispatchTarget(row);
    const disabled = isRuntimeDisabled(runtime);
    const blocked = disabled
      ? runtimeDisabledReason(runtime).replace(/。$/, "")
      : (() => {
          let incident: ReturnType<typeof unavailableIncident>;
          try {
            incident = unavailableIncident(db, { profile: runtimeProfile(runtime), model });
          } catch {
            return null;
          }
          return incident ? reviewerIncidentReason(incident) : null;
        })();
    if (!blocked) return;
    const choice = { profile: runtimeProfile };
    const next = itemReviewer(db, row.item_id, choice);
    if (next.runtime === runtime) {
      // 同一个 runtime 只换模型：只在挡住的是工单选好的组合时（审查 H1）。别人为这一次点名的模型（Lead 的恢复、健康重试）
      // 不在这里换：内核不替 Lead 选模型（2026-10-15 用户决定），由 Lead 恢复。
      const setting = getReviewerSetting(db, row.item_id);
      const chosen = setting?.runtime === runtime && (setting.model ?? null) === (row.model ?? null);
      if (!chosen || (next.model ?? null) === (row.model ?? null)) return;
    }
    const usable = reviewerUnavailableReason(db, next.runtime, { ...choice, ...(next.model ? { model: next.model } : {}) }) === null;
    if (!usable && !(disabled && !isRuntimeDisabled(next.runtime))) return;
    const switched = db.transaction((): boolean => {
      const changed = db.prepare(
        `UPDATE dispatch_requests
         SET runtime=?, model=?, effort=?, suspended_reason=NULL, suspended_incident_id=NULL, updated_at=datetime('now')
         WHERE id=? AND state='pending'`,
      ).run(next.runtime, next.model, next.effort, row.id).changes === 1;
      if (!changed) return false;
      recordReviewerSwitch(db, {
        itemId: row.item_id, dispatchRequestId: row.id, from: runtime, to: next.runtime,
        fromModel: model ?? null, toModel: next.model, reason: blocked, actor: "system",
      });
      touchItemActivity(row.item_id);
      return true;
    })();
    if (!switched) return;
    row.runtime = next.runtime;
    row.model = next.model;
    row.effort = next.effort;
    row.suspended_reason = null;
    row.suspended_incident_id = null;
  };

  // run gate 拒绝的请求留在队列里，带上原因，然后跳过。不能让下面的 createRun 抛出去：
  // tick() 只 catch 了 onDispatch，一条派不出去的请求会让排在后面的请求都派不出去。
  // 请求保持 pending，不取消：宿主缺陷闸门在用户授权重试或重新登记成功后会放行。
  const gateRefusal = (row: DispatchRequestRow): string | null => {
    try {
      assertRunAllowed(db, { itemId: row.item_id, role: row.role, purpose: row.purpose });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // 原因只在变化时写一次，所以每个 tick 重复检查不会刷活动。
  const recordGateRefusal = (row: DispatchRequestRow, reason: string): void => {
    if (row.suspended_reason === reason && row.suspended_incident_id === null) return;
    db.transaction(() => {
      db.prepare(
        `UPDATE dispatch_requests SET suspended_reason=?, suspended_incident_id=NULL, updated_at=datetime('now')
         WHERE id=? AND state='pending'`,
      ).run(reason, row.id);
      addActivity(db, {
        itemId: row.item_id,
        actor: "system",
        kind: "decision",
        payload: { decision: "dispatch_refused_by_run_gate", dispatchRequestId: row.id, message: reason },
      });
      touchItemActivity(row.item_id);
    })();
  };

  // 修复回合的请求（工单 09）在排队期间可能过时。例如工单又跑了新的执行 Run，或者成果已经由别的途径登记。
  // 闸门因此不再放行。过时的请求不会再变得可以派发，所以取消它，不留在队列里。
  const cancelStaleOutcomeRepair = (row: DispatchRequestRow): boolean => {
    const item = getItem(db, row.item_id);
    const refusal = item
      ? outcomeRepairRefusal(db, {
          itemId: row.item_id, role: row.role, stage: item.stage, sourceRunId: row.resume_from_run_id,
        })
      : `item #${row.item_id} not found`;
    if (!refusal) return false;
    db.transaction(() => {
      const cancelled = db.prepare(
        "UPDATE dispatch_requests SET state='cancelled', updated_at=datetime('now') WHERE id=? AND state='pending'",
      ).run(row.id).changes === 1;
      if (!cancelled || !item) return;
      addActivity(db, {
        itemId: row.item_id,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "outcome_repair_cancelled",
          dispatchRequestId: row.id,
          sourceRunId: row.resume_from_run_id,
          message: refusal,
        },
      });
    })();
    return true;
  };

  // preflight（spec D2，工单 05）：确定会失败的 Run 不创建。检查没通过时，请求挂起并写明原因，
  // 安装和模型的失败写进健康账本。放在 run gate 之后：run gate 拒绝的请求不需要检查 runtime。
  const preflightReady = (row: DispatchRequestRow): boolean => {
    if (!preflight) return true;
    const { runtime, model } = dispatchTarget(row);
    return preflightAllowsClaim(db, preflight, {
      requestId: row.id, itemId: row.item_id, runtime, model,
      suspendedReason: row.suspended_reason, suspendedIncidentId: row.suspended_incident_id,
    }, now());
  };

  // 内核的退避重试（工单 06）带着绝对的"不早于"时间。时间没到，claim 跳过它，也不写任何东西。
  // 时间存成绝对值，所以 daemon 重启后只等剩下的时间。
  const notBeforeReady = (row: DispatchRequestRow): boolean => notBeforeReached(row.not_before, now());

  // 过期的核查请求（review-authority.ts 的 staleReviewRequestReason）不会再有被认领的那一天。
  // 作废它，免得下一次交付进 review 时它被认领成对新交付的核查。
  const cancelStaleReviewRequest = (row: DispatchRequestRow): boolean => {
    if (row.role !== "reviewer" && row.purpose !== "review") return false;
    const reason = staleReviewRequestReason(db, row);
    if (!reason) return false;
    expireReviewRequest(db, row, reason);
    return true;
  };

  // 工单被占着、跳过认领时记一行日志，每张工单一分钟最多一行（发布评审 reliability-backlog）。
  // 跳过本身不写库：没有这行日志，看不出请求为什么一直不派。
  const busySkipLoggedAt = new Map<number, number>();
  const noteItemBusy = (row: DispatchRequestRow): void => {
    if (!options?.log) return;
    const at = now().getTime();
    const last = busySkipLoggedAt.get(row.item_id);
    if (last !== undefined && at - last < 60_000) return;
    busySkipLoggedAt.set(row.item_id, at);
    options.log(`[dispatch] ticket #${row.item_id} still has a live run; request #${row.id} waits`);
  };

  const claimNext = (): DispatchClaim | null => {
    const rows = db.prepare(
      "SELECT * FROM dispatch_requests WHERE state='pending' ORDER BY id",
    ).all() as DispatchRequestRow[];
    for (const row of rows) {
      if (db.prepare("SELECT 1 FROM dispatch_claims WHERE item_id=?").get(row.item_id)) continue;
      if (db.prepare("SELECT 1 FROM runs WHERE item_id=? AND state IN ('starting','running') LIMIT 1")
        .get(row.item_id)) continue;
      if (options?.itemBusy?.(row.item_id)) {
        noteItemBusy(row);
        continue;
      }
      if (row.purpose === "outcome_repair" && cancelStaleOutcomeRepair(row)) continue;
      if (cancelStaleReviewRequest(row)) continue;
      if (!notBeforeReady(row)) continue;
      // 先换核查员，后面的 gate（预算要看 runtime 有没有成本估算器）按换过以后的 runtime 判断。
      switchReviewer(row);
      if (!purposeReady(row)
          || !relationDependenciesReady(row)
          || !dependenciesReady(row)
          || !concurrencyReady(row)
          || !budgetReady(row)) continue;
      // 执行重试预算耗尽的事项不再派发（run-gate）。必须在这里显式跳过并终结这条请求，
      // 不能指望下面的 createRun 去拦：它是**抛**的，而 tick() 只 catch 了 onDispatch——
      // 让它抛出去，一条永远派不出去的请求就会把整个编排循环卡死。终结成 cancelled 而不是
      // 留着 pending，是因为预算不会自己长回来，这条请求已经没有再被选中的那一天了。
      if (row.role === "executor" && row.purpose === "execution"
          && executorRetryBudget(db, row.item_id).exhausted) {
        cancelRetryExhausted(row);
        continue;
      }
      if (supersededRetry(row)) continue;
      if (disabledHold(row)) continue;
      if (!healthReady(row)) continue;
      const refusal = gateRefusal(row);
      if (refusal) {
        recordGateRefusal(row, refusal);
        continue;
      }
      if (!preflightReady(row)) continue;
      const claimed = db.transaction(() => {
        const current = db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(row.id) as { state: string };
        if (current.state !== "pending") return null;
        const item = getItem(db, row.item_id)!;
        const { runtime, model, effort } = dispatchTarget(row);
        // ready → active 由 system 走：确认（draft → ready）是 user 的事，开跑不是。
        if (row.role === "executor" && item.stage === "ready") {
          transition(db, { itemId: item.id, to: "active", actor: "system", reason: `dispatch:${row.trigger}` });
        }
        const runId = createRun(db, {
          itemId: item.id, role: row.role, runtime, purpose: row.purpose,
          model, effort, resumedFromRunId: row.resume_from_run_id ?? undefined,
          // 只绑可以直接用的工作区。编码工单要新建的隔离 worktree、PR 的临时检出由 runItem 准备（workspace-policy.ts）。
          workspaceId: dispatchWorkspaceId(db, item, { role: row.role, purpose: row.purpose }),
          runtimeProfileHash: runtimeProfileHash(runtimeProfile(runtime)),
        });
        const leaseToken = randomUUID();
        const expires = new Date(now().getTime() + leaseMs).toISOString();
        db.prepare(
          `INSERT INTO dispatch_claims
           (item_id, run_id, request_id, lease_token, lease_expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(item.id, runId, row.id, leaseToken, expires);
        db.prepare(
          `UPDATE dispatch_requests
           SET state='claimed', suspended_reason=NULL, suspended_incident_id=NULL, updated_at=datetime('now')
           WHERE id=?`,
        ).run(row.id);
        const recoveredFromRunId = recoverySourceRun(row.id, item.id);
        if (recoveredFromRunId !== null) {
          coordinator.recordSystemCheckpoint({
            itemId: item.id,
            runId,
            kind: "progress",
            title: "Run recovered after dispatch interruption",
            summary: `Run #${runId} resumed item #${item.id} after run #${recoveredFromRunId} was reclaimed.`,
            idempotencyKey: `run-recovered:${recoveredFromRunId}:${runId}`,
            leadVisible: true,
          });
        }
        return {
          requestId: row.id, itemId: item.id, runId, leaseToken,
          role: row.role, purpose: row.purpose, runtime, model: model ?? null, effort: effort ?? null,
          resumeFromRunId: row.resume_from_run_id,
          instruction: row.instruction,
          trigger: row.trigger, planOwnerItemId: row.plan_owner_item_id,
          planRevision: row.plan_revision,
          workflowKind: item.workflow_kind,
          workspaceId: getRun(db, runId)?.workspace_id ?? null,
        } satisfies DispatchClaim;
      })();
      if (claimed) return claimed;
    }
    return null;
  };

  // 启动被拒绝的原因多半很快过去（同一张工单上的 Run 在收尾）。退避一段时间再派，免得每一拍都认领一次、
  // 被拒绝一次、留下一个 stopped 的 Run（发布评审 run-resume F1）。
  // 一直被拒绝就不再排队：请求记成 failed，给 Lead 升起一个 blocker，由 Lead 决定怎么处理（发布评审 reliability-backlog）。
  const refusedStartBackoffMs = Number(process.env.PLC_DISPATCH_REFUSED_BACKOFF_MS ?? 30_000);
  const refusedStartLimit = (): number => {
    const raw = Number(process.env.PLC_DISPATCH_REFUSED_START_LIMIT);
    return Number.isInteger(raw) && raw > 0 ? raw : 5;
  };
  const requeueRefusedStart = (runId: number): void => {
    db.transaction(() => {
      const claim = db.prepare(
        "SELECT request_id, item_id FROM dispatch_claims WHERE run_id=?",
      ).get(runId) as { request_id: number; item_id: number } | undefined;
      if (!claim) return;
      db.prepare("DELETE FROM dispatch_claims WHERE run_id=?").run(runId);
      // 一个请求一旦启动成功就不会再回到这里，所以它被拒绝的次数就是连续被拒绝的次数。
      const refusals = 1 + (db.prepare(
        `SELECT COUNT(*) AS n FROM activities
         WHERE item_id=? AND json_extract(payload, '$.decision')='dispatch_start_refused_requeued'
           AND json_extract(payload, '$.dispatchRequestId')=?`,
      ).get(claim.item_id, claim.request_id) as { n: number }).n;
      const reason = getRun(db, runId)?.error_message ?? "run start refused";
      const limit = refusedStartLimit();
      if (refusals >= limit) {
        db.prepare("UPDATE dispatch_requests SET state='failed', updated_at=datetime('now') WHERE id=?")
          .run(claim.request_id);
        addInbox(db, {
          itemId: claim.item_id,
          severity: "blocker",
          source: "structural",
          summary: `工单 #${claim.item_id} 的派发请求连续 ${refusals} 次没有启动，已停止重新排队。最近一次的原因：${reason.slice(0, 200)}`,
          // 先交给 Lead（needsUser:false）：界面显示「Lead 处理中」，Lead 处理不了再升级给用户（和派发启动失败的 blocker 一样）。
          payload: {
            blockerCode: "dispatch_start_refused", dispatchRequestId: claim.request_id, runId, refusals, reason: reason.slice(0, 500),
            needsUser: false,
          },
        });
        touchItemActivity(claim.item_id);
        return;
      }
      const notBefore = new Date(now().getTime() + refusedStartBackoffMs).toISOString();
      db.prepare("UPDATE dispatch_requests SET state='pending', not_before=?, updated_at=datetime('now') WHERE id=?")
        .run(notBefore, claim.request_id);
      addActivity(db, {
        itemId: claim.item_id,
        runId,
        actor: "system",
        kind: "decision",
        payload: { decision: "dispatch_start_refused_requeued", dispatchRequestId: claim.request_id, refusals, limit, notBefore },
      });
    })();
  };

  const completeRun = (runId: number): void => {
    db.transaction(() => {
      const claim = db.prepare(
        "SELECT request_id FROM dispatch_claims WHERE run_id=?",
      ).get(runId) as { request_id: number } | undefined;
      if (!claim) return;
      const run = getRun(db, runId);
      const state = run?.state === "finished" ? "completed" : "failed";
      db.prepare("UPDATE dispatch_requests SET state=?, updated_at=datetime('now') WHERE id=?")
        .run(state, claim.request_id);
      db.prepare("DELETE FROM dispatch_claims WHERE run_id=?").run(runId);
    })();
  };

  return {
    request,
    claimNext,
    markStarted(claim): void {
      const leaseCutoff = now().toISOString();
      const started = db.transaction(() => db.prepare(
        `UPDATE dispatch_requests
         SET state='started', updated_at=datetime('now')
         WHERE id=? AND state='claimed'
           AND EXISTS (
             SELECT 1
             FROM dispatch_claims c
             JOIN runs a ON a.id=c.run_id
             WHERE c.request_id=dispatch_requests.id
               AND c.item_id=?
               AND c.run_id=?
               AND c.lease_token=?
               AND c.lease_expires_at>?
               AND a.state='starting'
           )`,
      ).run(
        claim.requestId,
        claim.itemId,
        claim.runId,
        claim.leaseToken,
        leaseCutoff,
      ).changes).immediate();
      if (started !== 1) throw new Error("stale or expired dispatch claim");
    },
    completeRun,
    requeueRefusedStart,
    reclaimExpired(): number {
      const leaseCutoff = now().toISOString();
      return db.transaction(() => {
        const expired = db.prepare(
          `SELECT c.run_id, c.request_id, c.item_id, c.lease_token
           FROM dispatch_claims c
           JOIN dispatch_requests r ON r.id=c.request_id
           JOIN runs a ON a.id=c.run_id
           WHERE c.lease_expires_at<=?
             AND r.state='claimed'
             AND a.state='starting'
           ORDER BY c.created_at`,
        ).all(leaseCutoff) as Array<{
          run_id: number;
          request_id: number;
          item_id: number;
          lease_token: string;
        }>;
        let reclaimed = 0;
        for (const claim of expired) {
          const ownership = db.prepare(
            `UPDATE dispatch_requests
             SET state='pending', updated_at=datetime('now')
             WHERE id=? AND state='claimed'
               AND EXISTS (
                 SELECT 1
                 FROM dispatch_claims c
                 JOIN runs a ON a.id=c.run_id
                 WHERE c.request_id=dispatch_requests.id
                   AND c.item_id=?
                   AND c.run_id=?
                   AND c.lease_token=?
                   AND c.lease_expires_at<=?
                   AND a.state='starting'
               )`,
          ).run(
            claim.request_id,
            claim.item_id,
            claim.run_id,
            claim.lease_token,
            leaseCutoff,
          );
          if (ownership.changes !== 1) continue;
          const run = getRun(db, claim.run_id);
          if (!run || run.state !== "starting") {
            throw new Error(`dispatch claim ownership changed for run #${claim.run_id}`);
          }
          // 宿主没能在租约内启动这次尝试（spec D1：attempt）。请求已经交回队列，不扣工单的重试额度。
          markRunFailed(db, claim.run_id, {
            errorCode: "lease_expired",
            errorMessage: "dispatch lease expired before runtime start",
            failure: typedFailure("run_interrupted", {
              errorCode: "lease_expired", message: "dispatch lease expired before runtime start",
            }),
          });
          addActivity(db, {
            itemId: run.item_id,
            runId: claim.run_id,
            actor: "system",
            kind: "crash",
            payload: {
              reason: "dispatch lease expired before runtime start",
              errorCode: "lease_expired",
              dispatchRequestId: claim.request_id,
            },
          });
          coordinator.recordSystemCheckpoint({
            itemId: run.item_id,
            runId: claim.run_id,
            kind: "blocked",
            title: "Dispatch lease expired",
            summary: `Run #${claim.run_id} did not start before its dispatch lease expired.`,
            nextStep: "Return the request to the dispatch queue and claim a replacement run.",
            idempotencyKey: `run-crash:${claim.run_id}`,
            leadVisible: true,
            precedingEvents: [runUpdatedEvent(run.item_id, claim.run_id)],
          });
          const deleted = db.prepare(
            `DELETE FROM dispatch_claims
             WHERE run_id=? AND request_id=? AND lease_token=?`,
          ).run(claim.run_id, claim.request_id, claim.lease_token);
          if (deleted.changes !== 1) {
            throw new Error(`failed to release dispatch claim for run #${claim.run_id}`);
          }
          reclaimed++;
        }
        return reclaimed;
      }).immediate();
    },
    submitReviewVerdict(input): void {
      db.transaction(() => {
        const run = getRun(db, input.runId);
        if (!run || run.role !== "reviewer") throw new Error("review verdict requires a reviewer run");
        // 和 reviewer agent 的对话（purpose=conversation）也是 reviewer 角色，但它不是核查。
        if (run.purpose !== "review") {
          throw new Error(`review verdict requires a review run (run #${run.id} is a ${run.purpose} run)`);
        }
        const details = normalizeReviewVerdict(db, run, input);
        // Replaying the exact same verdict after the completion callback is
        // idempotent. Validate the active/current authority only for a new write.
        const existing = db.prepare("SELECT verdict, evidence FROM review_verdicts WHERE run_id=?")
          .get(input.runId) as { verdict: string; evidence: string } | undefined;
        if (existing) {
          const stored = getReviewVerdictDetails(db, input.runId);
          if (existing.verdict !== input.verdict || existing.evidence !== input.evidence
              || (stored && !sameReviewVerdictDetails(stored, details))) {
            throw new Error("review verdict is immutable");
          }
          return;
        }
        // A verdict is an active reviewer Run's write, not a late message from a
        // process that has already failed/stopped. The item must still be in the
        // review stage, and no newer executor cycle may have superseded this Run.
        if (run.state !== "starting" && run.state !== "running") {
          throw new Error(`review verdict requires an active reviewer run (run #${run.id} is ${run.state})`);
        }
        const item = getItem(db, run.item_id);
        if (!item || item.stage !== "review") {
          throw new Error(`review verdict is stale: item #${run.item_id} is ${item?.stage ?? "missing"}`);
        }
        // 核查期间用户在工单里提问，不让这次核查的结论作废（delivery-run.ts）；
        // 对话改过工作区才算（review-currency.ts）。
        const boundary = verificationBoundaryRunId(db, run.item_id);
        if (boundary !== null && boundary > run.id) {
          throw new Error(
            `review verdict from run #${run.id} is stale; run #${boundary} is newer`,
          );
        }
        // The manager finalizes the check after the reviewer process exits. Until then the
        // proposed verdict is intentionally not authoritative.
        // 结构化的部分先写：review_verdicts 落定以后它就不能再改（触发器）。有工作区的核查要等 Run 结束才落定，
        // 之前核查员重交时整行换掉。
        writeReviewVerdictDetails(db, { ...details, now: now() });
        if (run.workspace_id === null) {
          db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence) VALUES (?, ?, ?, ?)")
            .run(input.runId, run.item_id, input.verdict, input.evidence);
          markRunFinished(db, input.runId);
        }
        if (run.workspace_id === null) {
          applyReviewAutomation(db, {
            run, verdict: input.verdict, evidence: input.evidence, now: now(),
            requestRework: (rework) => { request(rework); },
          });
          completeRun(input.runId);
        } else {
          db.prepare("UPDATE review_workspace_checks SET verdict=?, evidence=? WHERE run_id=?")
            .run(input.verdict, input.evidence, input.runId);
        }
      })();
    },
  };
}

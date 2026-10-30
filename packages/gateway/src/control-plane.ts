// ── 投影边界：内部 item/run → 线上 ticket/attempt ─────────────────────────────
// 本文件是 control plane 的 DTO 工厂：它产出的每个对象都由 packages/protocol 冻结，
// companion 直接消费。v16 之后 DB 与 src/** 讲 item / run / stage / finished / failed，
// 线上仍讲 ticket / attempt / status / settled / crashed。
// 下面所有 ticketId / attemptId / parentTicketId / status / activeTickets … 都是
// **有意的映射**，右侧的取值才是内部词汇。改动任一侧都必须同时改这里。
// 值层面的转换（Run 状态）走 src/wire-vocabulary.ts，不要在这里手写 switch。
import type {
  ActivityDto,
  AgendaItem,
  ApprovalDto,
  AttemptDto,
  ConversationTurn,
  KernelAttempt,
  KernelArtifact,
  KernelCapability,
  KernelCheckpoint,
  KernelCheckpointListResponse,
  KernelCheckpointV2,
  KernelCheckpointV2ListResponse,
  KernelConversationCard,
  KernelConversationCardListResponse,
  KernelIntervention,
  KernelInterventionRef,
  KernelLearningCandidate,
  KernelProject,
  KernelRuntimeEvent,
  KernelTicket,
  KernelTicketDependency,
  KernelTicketWorkbench,
  KernelTicketWorkbenchV2,
  KernelTicketWorkItem,
  KernelTicketWorkItemV2,
  LeadStatus,
  Overview,
  ProjectSummary,
  Scope,
  TicketDetail,
  TicketStatus,
  TicketSummary,
  TicketReviewerInfo,
  TimelineResponse,
} from "@pi-lead-child/protocol";
import { foldTurnSurfaces, foldTurnToolCalls, isSystemTurnOrigin, LEAD_ACTIVITY_DISPOSITIONS, ticketNeedsUser, ticketTurn, type InboxView, type LeadActivityItem, type LeadActivityView, type LeadInterrupt, type ProjectOverview, type TicketTurn, type TurnPlacement } from "@pi-lead-child/protocol";
import { toWireAttemptPurpose, toWireAttemptState } from "@pi-lead-child/core";
import { createCoordinator } from "@pi-lead-child/engine";
import { createWorkspaceActionService } from "@pi-lead-child/engine";
import {
  compareReviewFingerprints,
  deliveryRunBefore,
  latestDeliveryRunId,
  outcomeRecoveryFailure,
  anyReviewerUsable,
  REVIEW_ESCALATION_WORDS,
  reviewDeadlock,
  reviewEscalation,
  requiresIndependentReview,
  reviewerInfo,
  reviewerProgress,
  reworkExhaustion,
  unreviewedDelivery,
  verificationState,
  type ReviewVerdictRow,
} from "@pi-lead-child/engine";
import { activeDelegationPolicy, isLightTask, leadDisplayName } from "@pi-lead-child/store";
import { itemHasRun } from "@pi-lead-child/engine";
import type { Db } from "@pi-lead-child/store";
import { activeRun, getRun, latestSessionRun, listRuns, runTokenUsage } from "@pi-lead-child/store";
import { listActivitiesAfter } from "@pi-lead-child/store";
import { listChatImageRefs, ticketReplyActionsByTurn } from "@pi-lead-child/store";
import {
  listArtifacts,
  openArtifactContent,
  type ArtifactContent,
} from "@pi-lead-child/store";
import { pendingApprovals } from "@pi-lead-child/store";
import { MILESTONE_KIND_LABELS } from "@pi-lead-child/protocol";
import { leadOverridesOfUser, leadOwnStops, leadReminderOverridesOfUser, type ItemMilestone } from "@pi-lead-child/store";
import { buildTimeline } from "./timeline.js";
import { inboxSeenAt, latestBlockedReason, listLeadHandled } from "@pi-lead-child/store";
import { getCheckpoint, listCheckpoints } from "@pi-lead-child/store";
import { listConversationCardPage } from "@pi-lead-child/store";
import { acknowledgeInterruptEvent, latestTurnStartedPayloads, listTurns, listTurnSurfaceEvents, listTurnToolEvents, userMessageOutcomes, type PublishGatewayEventInput } from "@pi-lead-child/store";
import { buildLeadActivityView, createLeadActivityPublisher, leadInterruptOf } from "./lead-activity.js";
import { listChildren, listDependencies } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { listNotifications } from "@pi-lead-child/store";
import { reminderPolicyOf } from "@pi-lead-child/store";
import { failureCategory, runtimeDisplayName, runtimeFailureTitle, type RuntimeProfile } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { runFailure } from "@pi-lead-child/runtime";
import { TRANSIENT_RETRY_TRIGGER } from "@pi-lead-child/engine";
import { notBeforeReached } from "@pi-lead-child/engine";
import { localIso } from "@pi-lead-child/core";
import { isHostOutcomeRegistrationDefect, presentUserFacingCheckpoint } from "@pi-lead-child/store";
import { getTicketRelations, listBlockingDependencies } from "@pi-lead-child/store";
import type { Capability, LearningCandidate } from "@pi-lead-child/store";
import {
  getProject,
  listActiveProjectItemSummaries,
  type Project,
  type ProjectRepository,
} from "@pi-lead-child/store";
import { firedOccurrences, listTriggers, triggerOccurrences } from "@pi-lead-child/store";
import { getItem, listItems } from "@pi-lead-child/store";
import type { Run, Checkpoint, ConversationCard, Item } from "@pi-lead-child/core";

export interface RuntimeStatus {
  model: string;
  sessionId: string;
  busy: boolean;
  runningItemIds: number[];
  aish: { connected: boolean; bot: string | null } | null;
  // Lead 自己的模型调用健康。没有它的 runtime（测试、旧调用方）就不投。
  lead?: LeadStatus;
}

export interface ControlPlaneOptions {
  runtime: () => RuntimeStatus;
  now?: () => Date;
  staleMs?: number;
  dataDir?: string;
  // 健康账本按哪个 profile 查核查员能不能用。daemon 注入派发 gate 用的同一个；不注入时用 runtime 的默认 profile。
  runtimeProfile?: (runtime: RuntimeId) => RuntimeProfile;
}

function iso(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}.000Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

function recordPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

// trigger 的 action_payload 是一个 item 模板；agenda 只需要它里面能给人看的三个字段。
// 一次最多取这么长的日程：例行任务按 cron 展开，范围不能没有上限。
const TIMELINE_MAX_RANGE_MS = 120 * 24 * 60 * 60 * 1000;

function agendaTemplate(raw: string): { brief?: string; body?: string; project?: string } {
  const parsed = recordPayload(raw);
  const text = (key: string) => (typeof parsed[key] === "string" ? parsed[key] as string : undefined);
  return { brief: text("brief"), body: text("body"), project: text("project") };
}

function integerArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => Number.isSafeInteger(value) && value > 0)
      : [];
  } catch {
    return [];
  }
}

interface DispatchRequestProjectionRow {
  id: number;
  item_id: number;
  role: "executor" | "reviewer";
  purpose: string;
  trigger: string;
  state: "pending" | "claimed" | "started" | "completed" | "failed" | "cancelled";
  suspended_reason: string | null;
  not_before: string | null;
  updated_at: string;
}

// 摘要说的是任务本身：brief。body 是一路追加的记录（Lead 的补充、child 的 body_append、
// reviewer 的核查报告、用户的返工请求、重启说明），任务建单时从不写它。拿 body 的第一行当摘要，
// 工单 #66 的摘要就成了"【独立核查报告】"。只有 brief 为空时（提醒正文写在 body 里）才退回 body。
function summaryText(item: Item): string {
  const source = item.brief.trim() || item.body.trim();
  const first = source.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

export function createControlPlaneService(db: Db, options: ControlPlaneOptions) {
  const now = options.now ?? (() => new Date());
  const staleMs = options.staleMs ?? Number(process.env.PLC_STALL_MS ?? 15 * 60_000);
  const reviewerChoice = options.runtimeProfile ? { profile: options.runtimeProfile } : {};
  const coordinator = createCoordinator({ db, now });
  const workspaceActions = createWorkspaceActionService(db);
  // 「Lead 动态」的推送比较前后两份投影；建服务时先记下现在的样子（工单 06）。
  // 读不出来（库坏了）不影响建服务：第一次 sync 再记。
  const leadActivityPublisher = createLeadActivityPublisher(db);
  try {
    leadActivityPublisher.sync(() => {});
  } catch {
    // 下一次 sync 时再记下现在的样子。
  }

  // 最早的一条等用户回答的决定。说明取它的进展记录（Lead 的决定卡写的是 fallback_text，agent 写的是卡住的原因），
  // 没有记录时用提问本身。
  function oldestUserDecision(itemId: number): { reason: string; since: string } | null {
    const row = db.prepare(
      `SELECT d.prompt, d.created_at,
              (SELECT c.summary FROM checkpoints c
               WHERE c.action_type = 'decision_request' AND c.action_id = d.id ORDER BY c.id LIMIT 1) AS summary
       FROM decision_requests d
       WHERE d.item_id = ? AND d.state = 'pending' AND d.blocking = 1 AND d.audience IN ('user','lead_or_user')
       ORDER BY d.created_at, d.id LIMIT 1`,
    ).get(itemId) as { prompt: string; created_at: string; summary: string | null } | undefined;
    if (!row) return null;
    return { reason: row.summary?.trim() || row.prompt, since: iso(row.created_at) ?? row.created_at };
  }

  function attention(item: Item) {
    const pendingApprovalCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM approvals WHERE item_id = ? AND status = 'pending'",
    ).get(item.id) as { n: number }).n;
    // 阻塞的决策请求按决策表数，不按它的 inbox 行：Lead 的一轮会把那一行消化掉（consumed），
    // ensureAuthorityInbox 也不会重建它，可决策还没人回答（发布评审 2340cac 的发现 C）。
    // 它的 inbox 行不再另算一次。
    const terminal = item.stage === "done" || item.stage === "cancelled";
    // 只算要用户行动的 blocker：先交给 Lead 的（payload.needsUser=false）不算，Lead 处理不了、升级以后才算
    // （2026-10-15 用户决定：异常先交给 Lead，除非需要用户介入，UI 只给弱反馈）。
    const blockerCount = terminal
      ? 0
      : (db.prepare(
          `SELECT COUNT(*) AS n FROM inbox
           WHERE item_id = ? AND severity = 'blocker' AND state IN ('pending','delivered')
             AND COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.authorityType') END, '')
               <> 'decision_request'
             AND COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.needsUser') END, 1) <> 0`,
        ).get(item.id) as { n: number }).n
        + (db.prepare(
          "SELECT COUNT(*) AS n FROM decision_requests WHERE item_id = ? AND state = 'pending' AND blocking = 1",
        ).get(item.id) as { n: number }).n;
    // Lead 正在处理：这张工单上（或者首次出现在这张工单上的 runtime 故障）有先交给 Lead、还没处理完的事。
    // 例行的事（routine，例如 Run 完成）不算：那不是异常。Lead 给自己设的跟进也不算：那只是提醒
    // （2026-10-15 #66：跟进让工单一直显示「Lead 处理中」，用户却在等着三选一）。
    // 「交给 Lead」按 Lead 实际收到的算（工单 14）：这一行的事件里有作为消息交给 Lead 的（tell、interrupt 级，
    // daemon 的 lead-input.ts 的 leadEventRoute）。级别由常设指令定（inbox.wake_lead 和到时限升级），
    // 所以常设指令改了，这里跟着变。以前这里另写了一份叫醒条件（blocker，或者 payload.wakeLead=1），不跟常设指令走。
    const leadHandling = !terminal && (db.prepare(
      `SELECT 1 FROM inbox
       WHERE state IN ('pending','delivered') AND json_valid(payload)
         AND (item_id = ? OR json_extract(payload, '$.openedItemId') = ?)
         AND json_extract(payload, '$.needsUser') = 0
         AND COALESCE(json_extract(payload, '$.routine'), 0) = 0
         AND COALESCE(json_extract(payload, '$.kind'), '') <> 'lead_followup'
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.correlation_id = 'inbox:' || inbox.id AND e.level IN ('tell','interrupt')
         )
       LIMIT 1`,
    ).get(item.id, item.id) !== undefined);
    // 等用户回答的决定：阻塞、待处理、受众包含用户（user、lead_or_user）。只给 Lead 回答的不算。
    const pendingDecisionCount = terminal
      ? 0
      : (db.prepare(
          `SELECT COUNT(*) AS n FROM decision_requests
           WHERE item_id = ? AND state = 'pending' AND blocking = 1 AND audience IN ('user','lead_or_user')`,
        ).get(item.id) as { n: number }).n;
    return {
      pendingApprovalCount,
      blockerCount,
      ...(leadHandling ? { leadHandling: true as const } : {}),
      ...(pendingDecisionCount > 0 ? { pendingDecisionCount } : {}),
    };
  }

  // stage='review' 从来不是一种状态。这里把它拆成协议里那六个取值（工单 #66 复盘第一点）：
  // 判据是 reviewer 裁决 + delegation policy + 已用返工次数 + 自我恢复结果的组合，
  // 全部来自 coordinator/review-authority.ts——自动化决定还派不派发时读的是同一份事实，
  // 两边算出不同结论这种事不该再有第二次。
  function reviewState(item: Item): TicketSummary["reviewState"] | undefined {
    if (item.kind !== "task" || item.stage !== "review") return undefined;
    const policy = activeDelegationPolicy(db, item.id, now());
    const verification = verificationState(db, item.id);
    const exhaustion = reworkExhaustion(db, item, policy);
    const budget = {
      ...(exhaustion.maxCycles === null ? {} : { reworkCyclesUsed: exhaustion.cyclesUsed }),
      ...(exhaustion.maxCycles === null ? {} : { maxReworkCycles: exhaustion.maxCycles }),
    };
    const deadlock = reviewDeadlock(db, item, { verification, exhaustion });
    // 这张卡片说的是哪一次交付，以及它是不是"进了 review 却没人来核查"（工单 #66）。
    // 两个事实挂在每一种 review 语义上，判据来自 review-authority，与派发 reviewer 的动作同源。
    const deliveryRunId = latestDeliveryRunId(db, item.id);
    const gap = unreviewedDelivery(db, item, { liveItemIds: options.runtime().runningItemIds });
    // F9：作废的核查单独投影，不再冒充当前的核查。
    const superseded = !verification.current && verification.latest
      ? {
          reviewerAttemptId: verification.latest.run_id,
          verdict: verification.latest.verdict,
          reviewedRunId: deliveryRunBefore(db, item.id, verification.latest.run_id),
          supersededByRunId: verification.supersededByRunId,
        }
      : null;
    const progress = reviewerProgress(db, item.id);
    const delivery = {
      deliveryRunId,
      // 排着的核查被挂起时也能点：再点一次重新排（2026-10-20，user-actions.ts 的 requestReview）。以前挂起的核查让这个
      // 按钮一直不能点，用户动不了。但一个能用的核查员都没有时不给：点了必定被拒（2026-10-21 审查 M4）。
      canRequestReview: gap !== null
        || (progress?.state === "suspended" && anyReviewerUsable(db, reviewerChoice)),
      supersededReview: superseded,
      reviewProgress: progress?.state ?? null,
    };
    if (deadlock) {
      const budgetText = exhaustion.maxCycles === null
        ? "自动返工未获授权"
        : `返工 ${exhaustion.cyclesUsed}/${exhaustion.maxCycles} 已用尽`;
      const label = deadlock.reworkExhausted && deadlock.outcomeRecoveryFailed
        ? "返工已用尽且成果未登记，需要你决定"
        : deadlock.reworkExhausted
          ? "返工已用尽，自动化已停止"
          : "成果未登记，无法验收";
      const recovery = outcomeRecoveryFailure(db, item.id);
      return {
        state: "rework_exhausted",
        label,
        reviewerAttemptId: verification.current?.run_id ?? null,
        verdict: verification.current?.verdict ?? null,
        reason: [
          deadlock.reworkExhausted ? budgetText : null,
          deadlock.outcomeRecoveryFailed && recovery
            ? `Run #${recovery.runId} 结束后没有可登记的成果快照，自我恢复失败`
            : null,
          verification.current
            ? `独立核查 ${verification.current.verdict.toUpperCase()}（Run #${verification.current.run_id}）`
            : verification.latest
              ? `当前验证状态未知：Run #${verification.latest.run_id} 的`
                + `${verification.latest.verdict.toUpperCase()} 已被之后的执行作废`
              : "当前验证状态未知：从未产生过独立核查裁决",
        ].filter(Boolean).join("；"),
        ...budget,
        ...(deadlock.outcomeRecoveryFailed ? { outcomeRecoveryFailed: true } : {}),
        // 哈希描述的是某一次核查看到的工作区。作废的核查的哈希不是当前事实。
        ...reviewHashProjection(verification.current),
        ...delivery,
      };
    }
    const verdict = verification.current;
    if (!verdict) {
      const independent = requiresIndependentReview(item);
      // 由用户验收的工单，用户手动派了核查之后同样是"在核查"。
      const reviewing = independent || progress !== null;
      // "等待独立核查"只在核查确实会来时成立。交付结束了却没有核查在路上时照实说：
      // 系统不会自己派，要用户决定（工单 #66 就是这样停了 52 天）。排队、挂起、在跑分开说。
      return {
        state: reviewing ? "independent_review" : "waiting_user",
        label: !reviewing
          ? "等待用户验收"
          : progress?.state === "running"
            ? "独立核查中"
            : progress?.state === "queued"
              ? "独立核查排队中"
              : progress?.state === "suspended"
                ? "独立核查已暂停"
                : gap ? "独立核查未派发" : "等待独立核查",
        reviewerAttemptId: null,
        verdict: null,
        reason: !reviewing
          ? null
          : progress?.state === "running"
            ? "独立核查正在进行。"
            : progress?.state === "queued"
              ? "核查请求已排队，等待派发。"
              : progress?.state === "suspended"
                ? progress.reason ?? "核查请求已挂起，恢复后才会派发。"
                : gap
                  ? `Run #${gap.deliveryRunId} 的交付还没有被独立核查，系统不会自动派发。`
                  : "执行已结束，独立核查即将开始。",
        ...budget,
        ...reviewHashProjection(null),
        ...delivery,
      };
    }
    // 核查员声明要你决定（review_verdict 的 escalate，工单 10）。以前在证据文本里找 evidence_conflict 这个词。
    const escalate = reviewEscalation(db, verdict.run_id);
    const escalateWords = escalate ? `核查员要你决定：${REVIEW_ESCALATION_WORDS[escalate.reason]}` : null;
    if (verdict.verdict === "fail") {
      const conflict = escalate?.reason === "evidence_conflict";
      return {
        state: conflict ? "evidence_conflict" : "review_failed",
        // 自动化只在出结论那一刻跑一次；工单还在 review，说明它没有派返工，要用户决定。
        label: conflict ? "证据冲突，等待用户决策" : escalateWords ? `核查不通过，${escalateWords}` : "核查不通过，等你决定",
        reviewerAttemptId: verdict.run_id,
        verdict: "fail",
        reason: escalate ? `${verdict.evidence}\n${escalateWords}：${escalate.note}` : verdict.evidence,
        ...budget,
        ...reviewHashProjection(verdict),
        ...delivery,
      };
    }
    return {
      state: "review_passed",
      // 托管的 PASS 会在出结论的同一笔事务里直接结单；还停在 review，就是在等用户验收。
      label: escalateWords ? `核查通过，${escalateWords}` : "核查通过，等待验收",
      reviewerAttemptId: verdict.run_id,
      verdict: "pass",
      reason: escalate ? `${verdict.evidence}\n${escalateWords}：${escalate.note}` : verdict.evidence,
      ...budget,
      ...reviewHashProjection(verdict),
      ...delivery,
    };
  }

  function reviewHashProjection(verdict: ReviewVerdictRow | null): Pick<NonNullable<TicketSummary["reviewState"]>, "reviewerPreHash" | "reviewerPostHash" | "reviewerHashState"> {
    if (!verdict) return { reviewerHashState: "unknown" };
    if (!verdict.pre_hash || !verdict.post_hash) {
      return { reviewerPreHash: verdict.pre_hash, reviewerPostHash: verdict.post_hash, reviewerHashState: "missing" };
    }
    // 一边量不出来、或者前后用的不是同一种指纹时，说不出改没改（workspace-integrity.ts）。
    return {
      reviewerPreHash: verdict.pre_hash,
      reviewerPostHash: verdict.post_hash,
      reviewerHashState: compareReviewFingerprints(verdict.pre_hash, verdict.post_hash),
    };
  }

  function latestDispatchRequest(itemId: number): DispatchRequestProjectionRow | null {
    const row = db.prepare(
      `SELECT id, item_id, role, purpose, trigger, state, suspended_reason, not_before, updated_at
       FROM dispatch_requests
       WHERE item_id=? AND role='executor' AND state <> 'completed'
       ORDER BY id DESC LIMIT 1`,
    ).get(itemId) as DispatchRequestProjectionRow | undefined;
    return row ?? null;
  }

  function dispatchRunId(requestId: number, itemId: number): number | null {
    const claim = db.prepare(
      "SELECT run_id FROM dispatch_claims WHERE request_id=?",
    ).get(requestId) as { run_id: number } | undefined;
    if (claim) return claim.run_id;
    const failed = db.prepare(
      `SELECT id FROM runs
       WHERE item_id=? AND error_code='dispatch_start_failed'
       ORDER BY id DESC LIMIT 1`,
    ).get(itemId) as { id: number } | undefined;
    return failed?.id ?? null;
  }

  function dispatchReason(itemId: number, requestId: number): string | null {
    const failedRun = db.prepare(
      `SELECT * FROM runs
       WHERE item_id=? AND state='failed'
       ORDER BY id DESC LIMIT 1`,
    ).get(itemId) as Run | undefined;
    if (failedRun?.error_message?.trim()) {
      const model = failedRun.model ?? "默认模型";
      return `${runtimeDisplayName(failedRun.runtime)} · ${model} · Run #${failedRun.id} · `
        + failedRun.error_message.trim().replace(/^Error:\s*/i, "")
        + `（${failureCategory(runFailure(failedRun))}）`;
    }
    const row = db.prepare(
      `SELECT payload FROM activities
       WHERE item_id=? AND kind='decision'
         AND json_extract(payload, '$.dispatchRequestId')=?
       ORDER BY id DESC LIMIT 1`,
    ).get(itemId, requestId) as { payload: string } | undefined;
    if (!row) return null;
    const payload = recordPayload(row.payload);
    for (const key of ["message", "reason", "summary", "instruction"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function executionState(item: Item, run: Run | undefined): TicketSummary["executionState"] | undefined {
    if (item.stage === "done" || item.stage === "cancelled" || item.stage === "review") return undefined;
    const request = latestDispatchRequest(item.id);
    if (!request) return undefined;
    // 取消的修复请求已经过时（工单 09）。它不再描述工单现在的执行状态。
    if (request.purpose === "outcome_repair" && request.state === "cancelled") return undefined;
    const activeExecutionRun = run && (run.state === "starting" || run.state === "running")
      ? run
      : null;
    const latestFailedExecutor = db.prepare(
      `SELECT id, error_code, error_message
       FROM runs
       WHERE item_id=? AND role='executor' AND purpose='execution' AND state='failed'
       ORDER BY id DESC LIMIT 1`,
    ).get(item.id) as {
      id: number;
      error_code: string | null;
      error_message: string | null;
    } | undefined;
    // A manual restart after a failed dispatch does not create a new dispatch
    // request. The active Run is still the authoritative current state, and the
    // old failed request must not keep projecting its error forever.
    const restartedAfterFailure = Boolean(
      activeExecutionRun && latestFailedExecutor && latestFailedExecutor.id < activeExecutionRun.id,
    );
    // 内核的退避重试（工单 06）延续失败的那次尝试，所以也是一次恢复。
    const transientRetry = request.trigger === TRANSIENT_RETRY_TRIGGER;
    const runtimeRecovery = request.trigger === "runtime-recovery" || transientRetry || restartedAfterFailure;
    // 成果修复回合（工单 09）也是一次恢复：它补交上一个 Run 的成果，不是新的执行。工单的 stage 不变。
    const outcomeRepair = request.purpose === "outcome_repair";
    const kind = runtimeRecovery || outcomeRepair
      ? "recovery"
      : request.trigger === "user-rework" || request.trigger === "delegated-review-rework"
        ? "rework"
        : "execution";
    const attemptId = activeExecutionRun?.id ?? dispatchRunId(request.id, item.id) ?? run?.id ?? null;
    const blockedByRelation = request.state === "pending" && listBlockingDependencies(db, item.id).length > 0;
    // 健康账本让请求挂起（工单 03）：它在等用户修好 runtime，不是在排队等 agent。
    const suspended = request.state === "pending" && request.suspended_reason !== null;
    // 退避重试还没到"不早于"时间：它在等，不是受阻，也不是在排队等 agent。
    const waitingForBackoff = transientRetry && request.state === "pending" && !suspended
      && !notBeforeReached(request.not_before, now());
    const state: NonNullable<TicketSummary["executionState"]>["state"] =
      activeExecutionRun?.state === "running"
        ? "running"
        : activeExecutionRun?.state === "starting"
          ? "starting"
          : blockedByRelation || request.state === "cancelled" || suspended
        ? "blocked"
        : request.state === "pending"
          ? "waiting_dispatch"
          : request.state === "claimed"
            ? "starting"
            : request.state === "started"
              ? run?.state === "running" ? "running" : "starting"
              : "failed";
    const label = (() => {
      if (suspended && !activeExecutionRun) return "派发已挂起";
      if (waitingForBackoff && !activeExecutionRun) return "瞬时失败 · 等待自动重试";
      if (outcomeRepair) {
        if (state === "waiting_dispatch") return "成果修复 · 等待 agent";
        if (state === "starting") return "成果修复 · 启动中";
        if (state === "running") return "正在补交成果";
        if (state === "blocked") return "成果修复受阻";
        if (state === "failed") return "成果修复失败";
        return "成果修复";
      }
      if (runtimeRecovery) {
        if (state === "waiting_dispatch") return "正在恢复 · 等待 agent";
        if (state === "starting") return "正在恢复 · 启动中";
        // 新的 Run 跑起来，恢复就完成了：和 Run 行一样写「执行中」（2026-10-24 #117：Run 156 在跑，工单头还写「正在恢复」）。
        // kind 仍是 recovery，失败的 Run 留下的 blocker 仍然不算「需要你」（protocol 的 needs-user.ts）。
        if (state === "running") return "执行中";
        if (state === "blocked") return "恢复受阻";
        if (state === "failed") return "恢复失败";
        return "正在恢复";
      }
      if (kind === "rework") {
        if (state === "waiting_dispatch") return "返工已请求，等待 agent";
        if (state === "starting") return "返工 Run 正在启动";
        if (state === "running") return "返工 Run 已启动";
        if (state === "blocked") return "返工派发受阻";
        if (state === "failed") return "返工启动失败";
        return "返工已请求";
      }
      if (state === "waiting_dispatch") return "等待 agent 派发";
      if (state === "starting") return "Run 正在启动";
      if (state === "running") return "Run 已启动";
      if (state === "blocked") return "派发受阻";
      return "启动失败";
    })();
    return {
      kind,
      state,
      label,
      dispatchRequestId: request.id,
      attemptId,
      reason: activeExecutionRun
        ? null
        : blockedByRelation
        ? "等待 depends_on 依赖完成"
        : suspended
        ? request.suspended_reason
        : waitingForBackoff
        ? `瞬时失败，系统会在 ${localIso(new Date(request.not_before!))} 自动重试。`
        : dispatchReason(item.id, request.id),
      updatedAt: iso(activeExecutionRun?.started_at ?? request.updated_at) ?? request.updated_at,
    };
  }

  // 工单最近的一个未完成节点（阶段 3）。索引 item_milestones_item (item_id, at) 让它在列表里也便宜。
  const nextMilestoneStatement = db.prepare(
    "SELECT * FROM item_milestones WHERE item_id = ? AND state = 'planned' ORDER BY at, id LIMIT 1",
  );
  function nextMilestoneOf(itemId: number): TicketSummary["nextMilestone"] {
    const row = nextMilestoneStatement.get(itemId) as ItemMilestone | undefined;
    return row
      ? { id: row.id, kind: row.kind, label: row.label ?? MILESTONE_KIND_LABELS[row.kind], at: row.at, allDay: row.all_day === 1 }
      : undefined;
  }

  function itemSummary(item: Item): TicketSummary {
    const runtime = options.runtime();
    const run = activeRun(db, item.id);
    const lastActivityAt = iso(item.last_activity_at);
    let state: TicketSummary["runtime"]["state"] = "idle";
    if (item.stage === "blocked") state = "blocked";
    else if (run?.state === "starting") state = "starting";
    else if (run?.state === "running" || runtime.runningItemIds.includes(item.id)) {
      const last = lastActivityAt ? new Date(lastActivityAt).getTime() : now().getTime();
      state = now().getTime() - last > staleMs ? "stale" : "running";
    }
    const review = reviewState(item);
    const execution = executionState(item, run);
    const workspace = workspaceActions.controlForItem(item.id);
    const nextMilestone = item.kind === "task" ? nextMilestoneOf(item.id) : undefined;
    return {
      id: item.id,
      title: item.title,
      ...(nextMilestone ? { nextMilestone } : {}),
      ...(item.display_title ? { displayTitle: item.display_title } : {}),
      stageChangedAt: iso(item.stage_changed_at) ?? item.stage_changed_at,
      summary: summaryText(item),
      kind: item.kind,
      workflowKind: item.workflow_kind,
      // stage 与 status 值恒相同：status 是旧名字，留着只为不一次性打断 companion。
      // 新读端一律用 stage（spec §5 命名映射表）。
      stage: item.stage,
      status: item.stage,
      hasRun: itemHasRun(db, item.id),
      priority: item.priority,
      project: projectNameOf(item),
      dueAt: iso(item.due_at),
      deferUntil: iso(item.defer_until),
      updatedAt: iso(item.updated_at) ?? item.updated_at,
      parentTicketId: item.parent_item_id,
      rootTicketId: item.root_item_id,
      // 系统建的学习工单（「沉淀失败经验」）是 Lead 的后台工作，不排进用户的工作列表。通道派的代查（lookup）和 Lead 派的
      // 轻子 agent（lead-tools-and-routing spec D9）也是：结果由 Lead 告诉用户，工单本身不占用户的列表。
      worklistVisibility: (item.created_by === "system" && (item.purpose === "integration" || item.purpose === "learning"))
        || item.purpose === "lookup"
        || (item.created_by === "child" && item.parent_item_id === null)
        || isLightTask(db, item.id)
        ? "background"
        : "primary",
      verificationPolicy: item.verification_policy,
      acceptancePolicy: item.acceptance_policy,
      reworkPolicy: item.rework_policy,
      deliveryPolicy: item.delivery_policy,
      workflowState: workflowState(item),
      ...(review ? { reviewState: review } : {}),
      ...(execution ? { executionState: execution } : {}),
      ...(workspace ? { workspace } : {}),
      runtime: {
        state,
        lastActivityAt,
        activeAttemptId: run?.id ?? null,
      },
      attention: attention(item),
    };
  }

  function workflowState(item: Item): TicketSummary["workflowState"] {
    const continuation = db.prepare(
      `SELECT state FROM continuations
       WHERE item_id=? AND state IN ('pending','running','waiting_dependency','waiting_capability')
       ORDER BY id LIMIT 1`,
    ).get(item.id) as { state: string } | undefined;
    if (continuation?.state === "waiting_capability") return "waiting_capability";
    if (continuation?.state === "waiting_dependency") return "waiting_dependency";
    if (listBlockingDependencies(db, item.id).length > 0) return "waiting_dependency";
    if (continuation) return "continuing";
    return "idle";
  }

  // 工单对话交给执行 agent、又没有 Run 在跑时续接的会话（工单 08）：和 routeTicketMessageToAgentRun 选的是同一个
  // （最近启动过的、有会话的 Run）。lastTokens 是那个 Run 用的 token，输入框按它估算这次续接的成本。
  function chatResumeOf(itemId: number): TicketDetail["chatResume"] {
    const run = latestSessionRun(db, itemId);
    if (!run) return null;
    return { attemptId: run.id, role: run.role, runtime: run.runtime, lastTokens: runTokenUsage(db, run.id) };
  }

  function itemRelations(item: Item): NonNullable<TicketDetail["relations"]> {
    return getTicketRelations(db, item.id).map((relation) => ({
      ticketId: relation.relatedItemId,
      kind: relation.relationType,
      sourceTicketId: relation.sourceItemId,
      targetTicketId: relation.targetItemId,
      relationId: relation.relationId,
      source: relation.factSource,
      executionGate: relation.executionGate,
      active: relation.active,
      createdBy: relation.createdBy,
      createdByAttemptId: relation.createdByRunId,
      createdAt: relation.createdAt === null ? null : iso(relation.createdAt) ?? relation.createdAt,
      reason: relation.reason,
      revokedAt: relation.revokedAt === null ? null : iso(relation.revokedAt) ?? relation.revokedAt,
      revokedBy: relation.revokedBy,
      revokeReason: relation.revokeReason,
    }));
  }

  function kernelProject(project: Project): KernelProject {
    const repository = (row: ProjectRepository) => ({
      id: row.id,
      projectId: row.project_id,
      repoRoot: row.repo_root,
      remoteUrl: row.remote_url,
      repoName: row.repo_name,
      role: row.role,
      confidence: row.confidence,
      createdAt: iso(row.created_at) ?? row.created_at,
      updatedAt: iso(row.updated_at) ?? row.updated_at,
    });
    const repositories = db.prepare(
      "SELECT * FROM project_repositories WHERE project_id = ? ORDER BY id",
    ).all(project.id) as ProjectRepository[];
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      summary: project.summary,
      status: project.status,
      confidence: project.confidence,
      maxConcurrency: project.max_concurrency,
      mergedIntoProjectId: project.merged_into_project_id,
      createdBy: project.created_by,
      createdAt: iso(project.created_at) ?? project.created_at,
      updatedAt: iso(project.updated_at) ?? project.updated_at,
      repositories: repositories.map(repository),
    };
  }

  // 工单属于哪个项目（项目名）。子工单常常只有 project_id，或者什么都没有、跟着根工单走。
  // 工单 tab 按名字筛选、项目按名字计数，所以这里补齐，两边才是同一组工单。
  function projectNameOf(item: Item): string | null {
    const own = (candidate: Item) => candidate.project
      ?? (candidate.project_id === null ? null : getProject(db, candidate.project_id)?.name ?? null);
    const name = own(item);
    if (name !== null || item.root_item_id === null || item.root_item_id === item.id) return name;
    const root = getItem(db, item.root_item_id);
    return root ? own(root) : null;
  }

  function kernelTicket(item: Item): KernelTicket {
    return {
      id: item.id,
      title: item.title,
      brief: item.brief,
      body: item.body,
      status: item.stage,
      priority: item.priority,
      project: item.project,
      projectId: item.project_id,
      parentTicketId: item.parent_item_id,
      rootTicketId: item.root_item_id,
      createdByAttemptId: item.created_by_run_id,
      orchestrationState: item.plan_state,
      requestedRuntime: item.requested_runtime,
      requestedModel: item.requested_model,
      purpose: item.purpose === null ? null : toWireAttemptPurpose(item.purpose),
      // 已停用，只为旧客户端照发 null（protocol 的 KernelTicketSchema，工单 09）。
      reviewPolicy: null,
      verificationPolicy: item.verification_policy,
      acceptancePolicy: item.acceptance_policy,
      reworkPolicy: item.rework_policy,
      deliveryPolicy: item.delivery_policy,
      maxDepth: item.max_depth,
      maxChildren: item.max_children,
      maxConcurrency: item.max_concurrency,
      tokenBudget: item.token_budget,
      costBudgetUsd: item.cost_budget_usd,
      retryLimit: item.retry_limit,
      activePlanRevision: item.active_plan_revision,
      workdir: item.workdir,
      createdBy: item.created_by,
      createdAt: iso(item.created_at) ?? item.created_at,
      updatedAt: iso(item.updated_at) ?? item.updated_at,
      lastActivityAt: iso(item.last_activity_at),
      totalTokens: item.total_tokens,
      totalCostUsd: item.total_cost_usd,
      dueAt: iso(item.due_at),
      remindAt: iso(item.remind_at),
    };
  }

  function kernelAttempt(run: Run): KernelAttempt {
    return {
      id: run.id,
      ticketId: run.item_id,
      role: run.role,
      state: toWireAttemptState(run.state),
      runtime: run.runtime,
      purpose: toWireAttemptPurpose(run.purpose),
      model: run.model,
      runtimeVersion: run.runtime_version,
      externalSessionId: run.external_session_id,
      sessionId: run.session_id,
      sessionPath: run.session_path,
      pid: run.pid,
      eventCursor: run.event_cursor,
      lastEntryCursor: run.last_entry_cursor,
      exitCode: run.exit_code,
      errorCode: run.error_code,
      errorMessage: run.error_message,
      metadata: recordPayload(run.metadata),
      costKnown: Boolean(run.cost_known),
      eventLogDirty: Boolean(run.event_log_dirty),
      startedAt: iso(run.started_at) ?? run.started_at,
      endedAt: iso(run.ended_at),
    };
  }

  function kernelLearningCandidate(candidate: LearningCandidate): KernelLearningCandidate {
    return {
      id: candidate.id,
      projectId: candidate.project_id,
      scopeKey: candidate.scope_key,
      ticketId: candidate.item_id,
      attemptId: candidate.run_id,
      fingerprint: candidate.fingerprint,
      kind: candidate.kind,
      summary: candidate.summary,
      evidence: recordPayload(candidate.evidence),
      occurrenceCount: candidate.occurrence_count,
      confidence: candidate.confidence,
      status: candidate.status,
      createdAt: iso(candidate.created_at) ?? candidate.created_at,
      updatedAt: iso(candidate.updated_at) ?? candidate.updated_at,
    };
  }

  function kernelCapability(capability: Capability): KernelCapability {
    return {
      id: capability.id,
      projectId: capability.project_id,
      scopeKey: capability.scope_key,
      type: capability.type,
      slug: capability.slug,
      name: capability.name,
      version: capability.version,
      scope: capability.scope,
      status: capability.status,
      summary: capability.summary,
      assetPath: capability.asset_path,
      evaluatorPath: capability.evaluator_path,
      assetHash: capability.asset_hash,
      evaluatorHash: capability.evaluator_hash,
      implementationStatus: capability.implementation_status,
      deploymentStatus: capability.deployment_status,
      leadToolStatus: capability.lead_tool_status,
      sourceCandidates: integerArray(capability.source_candidates),
      provenance: recordPayload(capability.provenance),
      createdAt: iso(capability.created_at) ?? capability.created_at,
      updatedAt: iso(capability.updated_at) ?? capability.updated_at,
    };
  }

  function kernelCheckpoint(checkpoint: Checkpoint): KernelCheckpoint {
    const run = checkpoint.runId === null ? null : getRun(db, checkpoint.runId) ?? null;
    const hostDefect = run !== null && isHostOutcomeRegistrationDefect({
      errorCode: run.error_code,
      errorMessage: run.error_message,
    });
    const failure = checkpoint.kind === "blocked" && run?.error_message && !hostDefect
      ? runFailure(run)
      : null;
    const existingFactLabels = new Set(checkpoint.keyFacts.map((fact) => fact.label));
    const failureFacts = failure && run
      ? [
          ["Agent", runtimeDisplayName(run.runtime)],
          ["Runtime", run.runtime],
          ["Model", run.model ?? "默认模型"],
          ["Failure category", failureCategory(failure)],
          ["Error code", run.error_code ?? "unknown"],
        ].filter(([label]) => !existingFactLabels.has(label))
          .map(([label, value]) => ({ label, value }))
      : [];
    const presented = presentUserFacingCheckpoint({
      kind: checkpoint.kind,
      title: failure && run ? runtimeFailureTitle(run.runtime, failure) : checkpoint.title,
      summary: failure && run
        ? `${runtimeDisplayName(run.runtime)} · Run #${run.id} · ${checkpoint.summary}`
        : checkpoint.summary,
      nextStep: checkpoint.nextStep,
    });
    const base = {
      id: checkpoint.id,
      ticketId: checkpoint.itemId,
      attemptId: checkpoint.runId,
      author: checkpoint.author,
      source: checkpoint.source,
      stage: checkpoint.stage,
      title: presented.title,
      summary: presented.summary,
      keyFacts: [...checkpoint.keyFacts, ...failureFacts],
      artifactRefs: checkpoint.artifactRefs,
      relatedTicketIds: checkpoint.relatedItemIds,
      nextStep: presented.nextStep,
      actionRef: checkpoint.actionRef,
      createdAt: iso(checkpoint.createdAt) ?? checkpoint.createdAt,
    };
    if (checkpoint.kind === "delegation") {
      return { ...base, kind: "delegation", relatedTicketIds: checkpoint.relatedItemIds };
    }
    if (checkpoint.kind === "blocked") {
      return { ...base, kind: "blocked" } as KernelCheckpoint;
    }
    return { ...base, kind: checkpoint.kind };
  }

  function kernelConversationCard(card: ConversationCard): KernelConversationCard {
    const timestamps = {
      createdAt: iso(card.createdAt) ?? card.createdAt,
      updatedAt: iso(card.updatedAt) ?? card.updatedAt,
    };
    if (card.kind === "ticket_execution") {
      return {
        id: card.id,
        key: card.key,
        kind: "ticket_execution",
        turnId: card.turnId,
        ticketId: card.itemId,
        operations: card.operations,
        operationsTruncated: card.operationsTruncated,
        ...timestamps,
      };
    }
    if (card.kind === "checkpoint") {
      return {
        id: card.id,
        key: card.key,
        kind: "checkpoint",
        turnId: card.turnId,
        ticketId: card.itemId,
        checkpointId: card.checkpointId,
        ...timestamps,
      };
    }
    return {
      id: card.id,
      key: card.key,
      kind: "intervention",
      turnId: card.turnId,
      ticketId: card.itemId,
      checkpointId: card.checkpointId,
      interventionId: card.actionType === "approval"
        ? `approval:${card.actionId}`
        : `decision:${card.actionId}`,
      ...timestamps,
    };
  }

  return {
    // includeLead：调用方明确要 Lead 健康时才带 lead（GET /v1/overview?include=lead）。
    overview(query: { includeLead?: boolean } = {}): Overview {
      const runtime = options.runtime();
      const counts = db.prepare(
        `SELECT
          SUM(CASE WHEN stage = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN stage = 'review' THEN 1 ELSE 0 END) AS review,
          SUM(CASE WHEN stage = 'blocked' THEN 1 ELSE 0 END) AS blocked
         FROM items`,
      ).get() as { active: number | null; review: number | null; blocked: number | null };
      return {
        model: runtime.model,
        sessionId: runtime.sessionId,
        busy: runtime.busy,
        runningTicketIds: runtime.runningItemIds,
        counts: {
          activeTickets: counts.active ?? 0,
          reviewTickets: counts.review ?? 0,
          blockedTickets: counts.blocked ?? 0,
          pendingApprovals: pendingApprovals(db).length,
          unreadNotices: listNotifications(db, { state: ["pending", "delivered"] }).length,
        },
        aish: runtime.aish,
        ...(query.includeLead && runtime.lead ? { lead: runtime.lead } : {}),
      };
    },

    // 线上参数叫 status，store 读的是 stage —— 直接把 filter 透传过去，谓词会被静默丢掉，
    // GET /v1/tickets?status=active 会返回全部。这里显式翻译，别再合并成一次透传。
    listItems(filter?: {
      status?: TicketStatus[];
      kind?: "task" | "reminder";
      // store 的预设视图（spec §9）。
      view?: "tasks" | "drafts" | "reminders" | "all";
      project?: string;
      text?: string;
    }): TicketSummary[] {
      const { status, ...rest } = filter ?? {};
      return listItems(db, { ...rest, stage: status }).map(itemSummary);
    },

    // GET /v1/tickets/:id/reviewer（2026-10-20）：现在的核查员、所有候选能不能用、能不能换（engine 的 change-reviewer.ts）。
    // 健康账本按 daemon 注入的 profile 查（和派发 gate 一致）；没注入时按 runtime 的默认 profile 查。
    getReviewer(id: number): TicketReviewerInfo | undefined {
      const info = reviewerInfo(db, id, { liveItemIds: options.runtime().runningItemIds, ...reviewerChoice });
      if (!info) return undefined;
      return {
        reviewer: info.reviewer as TicketReviewerInfo["reviewer"],
        options: info.options.map((option) => ({
          runtime: option.runtime as TicketReviewerInfo["options"][number]["runtime"],
          displayName: option.displayName,
          available: option.available,
          ...(option.reason ? { reason: option.reason } : {}),
        })),
        canChange: info.canChange,
        progress: info.progress,
      };
    },

    getItem(id: number): TicketDetail | undefined {
      const item = getItem(db, id);
      if (!item) return undefined;
      return {
        ticket: itemSummary(item),
        brief: item.brief,
        body: item.body,
        workdir: item.workdir,
        createdAt: iso(item.created_at) ?? item.created_at,
        totalTokens: item.total_tokens,
        totalCostUsd: item.total_cost_usd,
        remindAt: iso(item.remind_at),
        createdBy: item.created_by,
        relations: itemRelations(item),
        chatResume: chatResumeOf(item.id),
        // 提醒的设置（工单 07）：会话里的提醒卡据此写「重要」，日程和「待你」托盘也读它。
        ...(item.kind === "reminder" ? { reminder: reminderPolicyOf(item) } : {}),
      };
    },

    getKernelProject(id: number): KernelProject | undefined {
      const project = getProject(db, id);
      return project ? kernelProject(project) : undefined;
    },

    getKernelTicket(id: number): KernelTicket | undefined {
      const item = getItem(db, id);
      return item ? kernelTicket(item) : undefined;
    },

    listKernelChildren(itemId: number): KernelTicket[] | undefined {
      if (!getItem(db, itemId)) return undefined;
      return listChildren(db, itemId).map(kernelTicket);
    },

    listKernelDependencies(itemId: number): KernelTicketDependency[] | undefined {
      if (!getItem(db, itemId)) return undefined;
      return listDependencies(db, itemId).map((dependency) => ({
        parentTicketId: dependency.parent_item_id,
        planRevision: dependency.plan_revision,
        ticketId: dependency.item_id,
        dependsOnTicketId: dependency.depends_on_item_id,
        kind: dependency.kind,
        createdByAttemptId: dependency.created_by_run_id,
        createdAt: iso(dependency.created_at) ?? dependency.created_at,
      }));
    },

    getKernelAttempt(id: number): KernelAttempt | undefined {
      const run = getRun(db, id);
      return run ? kernelAttempt(run) : undefined;
    },

    listKernelAttemptEvents(runId: number): KernelRuntimeEvent[] | undefined {
      if (!getRun(db, runId)) return undefined;
      const rows = db.prepare(
        "SELECT payload FROM runtime_events WHERE run_id = ? ORDER BY seq",
      ).all(runId) as Array<{ payload: string }>;
      // 存的是内部形态（runId），线上 KernelRuntimeEvent 要的是 attemptId——直接 cast 是
      // 撒谎，strict schema 会在校验时打回。在这里显式翻译，这就是那道映射边界。
      return rows.map((row) => {
        const { runId, ...rest } = JSON.parse(row.payload) as Record<string, unknown>;
        return { ...rest, attemptId: runId } as KernelRuntimeEvent;
      });
    },

    listKernelLearningCandidates(): KernelLearningCandidate[] {
      const rows = db.prepare(
        "SELECT * FROM learning_candidates ORDER BY updated_at DESC, id DESC",
      ).all() as LearningCandidate[];
      return rows.map(kernelLearningCandidate);
    },

    listKernelCapabilities(): KernelCapability[] {
      const rows = db.prepare(
        "SELECT * FROM capabilities ORDER BY scope_key, slug, version, id",
      ).all() as Capability[];
      return rows.map(kernelCapability);
    },

    listKernelCheckpoints(
      itemId: number,
      query?: { afterId?: number; beforeId?: number; limit?: number },
    ): KernelCheckpointListResponse | undefined {
      if (!getItem(db, itemId)) return undefined;
      const page = listCheckpoints(db, { itemId, ...query });
      return { ...page, items: page.items.map(kernelCheckpoint) };
    },

    listKernelCheckpointsV2(
      itemId: number,
      query?: { afterId?: number; beforeId?: number; limit?: number },
    ): KernelCheckpointV2ListResponse | undefined {
      return coordinator.listTicketCheckpointsV2(itemId, query) as
        | { items: KernelCheckpointV2[]; hasMore: boolean; nextBeforeId: number | null }
        | undefined;
    },

    listKernelWorkItems(itemIds?: number[]): KernelTicketWorkItem[] {
      return coordinator.listTicketWorkItems(itemIds ? { itemIds } : undefined);
    },

    listKernelWorkItemsV2(itemIds?: number[]): KernelTicketWorkItemV2[] {
      return coordinator.listTicketWorkItemsV2(itemIds ? { itemIds } : undefined);
    },

    getKernelTicketWorkbench(itemId: number): KernelTicketWorkbench | undefined {
      return coordinator.getTicketWorkbench(itemId);
    },

    getKernelTicketWorkbenchV2(itemId: number): KernelTicketWorkbenchV2 | undefined {
      return coordinator.getTicketWorkbenchV2(itemId);
    },

    listKernelArtifacts(itemId: number): KernelArtifact[] | undefined {
      if (!getItem(db, itemId)) return undefined;
      return listArtifacts(db, itemId).map(({ itemId: artifactItemId, runId, ...artifact }) => ({
        ...artifact,
        // 线上叫 ticketId / attemptId，内部叫 itemId / runId。
        ticketId: artifactItemId,
        attemptId: runId,
        createdAt: iso(artifact.createdAt) ?? artifact.createdAt,
      }));
    },

    openKernelArtifactContent(itemId: number, artifactId: number): ArtifactContent {
      if (!options.dataDir) throw new Error("artifact storage is unavailable");
      return openArtifactContent(db, options.dataDir, itemId, artifactId);
    },

    listKernelInterventionRefs(query?: {
      itemId?: number;
      state?: KernelInterventionRef["state"];
      ids?: string[];
    }): KernelInterventionRef[] {
      return coordinator.listInterventionRefs(query);
    },

    listKernelInterventions(query?: {
      itemId?: number;
      state?: KernelInterventionRef["state"];
      ids?: string[];
    }): KernelIntervention[] {
      return coordinator.listInterventions(query, { kind: "user" });
    },

    listKernelConversationCards(query?: {
      beforeId?: number;
      afterId?: number;
      limit?: number;
      itemIds?: number[];
      keys?: string[];
    }): KernelConversationCardListResponse {
      const page = listConversationCardPage(db, query);
      const checkpointIds = [...new Set(page.items.flatMap((card) =>
        card.kind === "ticket_execution" ? [] : [card.checkpointId]))].sort((left, right) => left - right);
      const checkpoints = checkpointIds.map((id) => {
        const checkpoint = getCheckpoint(db, id);
        if (!checkpoint) throw new Error(`conversation card checkpoint ${id} not found`);
        return kernelCheckpoint(checkpoint);
      });
      const interventionIds = page.items.flatMap((card) => {
        if (card.kind !== "intervention") return [];
        return [card.actionType === "approval"
          ? `approval:${card.actionId}`
          : `decision:${card.actionId}`];
      });
      return {
        ...page,
        items: page.items.map(kernelConversationCard),
        checkpoints,
        interventionRefs: coordinator.listInterventionRefs({ ids: interventionIds }),
      };
    },

    listActivities(itemId: number, opts?: { afterId?: number; limit?: number }): ActivityDto[] {
      return listActivitiesAfter(db, itemId, opts).map((activity) => ({
        id: activity.id,
        ticketId: activity.item_id,
        attemptId: activity.run_id,
        actor: activity.actor,
        kind: activity.kind,
        payload: recordPayload(activity.payload),
        sessionCursor: activity.session_cursor,
        createdAt: iso(activity.created_at) ?? activity.created_at,
      }));
    },

    listRuns(itemId: number): AttemptDto[] {
      return listRuns(db, itemId).map((run) => ({
        id: run.id,
        ticketId: run.item_id,
        role: run.role,
        state: toWireAttemptState(run.state),
        model: run.model,
        effort: run.effort,
        runtime: run.runtime,
        purpose: toWireAttemptPurpose(run.purpose),
        exitCode: run.exit_code,
        errorCode: run.error_code,
        errorMessage: run.error_message,
        startedAt: iso(run.started_at) ?? run.started_at,
        endedAt: iso(run.ended_at),
      }));
    },

    // 项目的数字和按项目筛选后的工单 tab 一样：同一组工单（根工单，加上需要你的子工单；提醒不算），
    // 同一条「现在轮到谁」的规则（protocol 的 ticketTurn）。以前这里是一段单独的 SQL：数子工单和
    // 已结束的工单，阻塞只看 stage，进行中只看 active。实例上项目写「17 工单 · 3 阻塞」，工单 tab
    // 在这个项目里是 16 张、4 张等你。
    // 字段名沿用线上协议：blockedCount 是「等你」，runningCount 是「在执行」，reviewCount 是停在 review、
    // 不等你的（核查在路上或还没派发）。工单按 TicketSummary.project 归到同名的项目，和 companion 按项目筛选一致。
    listProjects(): ProjectSummary[] {
      const active = listActiveProjectItemSummaries(db).filter((row) => row.id !== "unknown");
      const idByName = new Map(active.map((row) => [row.name, row.id]));
      const counts = new Map<string, Omit<ProjectSummary, "id" | "name">>();
      for (const item of listItems(db, { kind: "task" })) {
        const summary = itemSummary(item);
        const turn = ticketTurn(summary);
        if (summary.parentTicketId != null && turn !== "user") continue;
        const key = (summary.project !== null ? idByName.get(summary.project) : undefined) ?? "unknown";
        const entry = counts.get(key)
          ?? { ticketCount: 0, runningCount: 0, reviewCount: 0, blockedCount: 0, nearestDueAt: null };
        counts.set(key, entry);
        entry.ticketCount += 1;
        if (turn === "running") entry.runningCount += 1;
        if (turn === "user") entry.blockedCount += 1;
        if (summary.stage === "review" && turn !== "user") entry.reviewCount += 1;
        const dueAt = turn === "ended" ? null : iso(item.due_at);
        if (dueAt && (entry.nearestDueAt === null || dueAt < entry.nearestDueAt)) entry.nearestDueAt = dueAt;
      }
      const empty = { ticketCount: 0, runningCount: 0, reviewCount: 0, blockedCount: 0, nearestDueAt: null };
      const projects: ProjectSummary[] = active.map((row) => ({ id: row.id, name: row.name, ...(counts.get(row.id) ?? empty) }));
      const unknown = counts.get("unknown");
      return unknown ? [...projects, { id: "unknown", name: "unknown", ...unknown }] : projects;
    },

    // includeOverdue：再返回 from 之前还没结束的截止，和已经触发、没有确认的提醒（日程的「已过期」区）。
    // 返回形状不变，只多返回条目。
    // 日程（阶段 3）：节点、提醒、推迟开始、例行任务，带出处和风险。见 timeline.ts。
    timeline(range: { from: string; to: string; timezone: string }): TimelineResponse {
      const from = new Date(range.from);
      const to = new Date(range.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from
        || to.getTime() - from.getTime() > TIMELINE_MAX_RANGE_MS) {
        throw new Error("invalid timeline range");
      }
      return buildTimeline(db, {
        from, to, timezone: range.timezone, now: now(), summaryOf: itemSummary,
        routineDetail: (payload) => {
          const template = agendaTemplate(payload);
          return { description: template.brief ?? template.body ?? "", project: template.project ?? null };
        },
      });
    },

    agenda(range: { from: string; to: string; timezone: string; includeOverdue?: boolean }): AgendaItem[] {
      const from = new Date(range.from);
      const to = new Date(range.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
        throw new Error("invalid agenda range");
      }
      const fromIso = from.toISOString();
      const items: AgendaItem[] = [];
      for (const item of listItems(db)) {
        const dueAt = iso(item.due_at);
        const remindAt = iso(item.remind_at);
        if (range.includeOverdue) {
          const ended = item.stage === "done" || item.stage === "cancelled" || item.stage === "acked";
          if (item.kind === "reminder" && item.stage === "fired" && remindAt && remindAt < fromIso) {
            items.push({
              id: `ticket:${item.id}:reminder`, kind: "ticket_reminder", startsAt: remindAt,
              title: item.title, ticketId: item.id, scheduleId: null,
              status: item.stage, project: item.project,
            });
          }
          if (!ended && dueAt && dueAt < fromIso) {
            items.push({
              id: `ticket:${item.id}:due`, kind: "ticket_due", startsAt: dueAt,
              title: item.title, ticketId: item.id, scheduleId: null,
              status: item.stage, project: item.project,
            });
          }
        }
        if (remindAt && remindAt >= from.toISOString() && remindAt < to.toISOString()) {
          items.push({
            id: `ticket:${item.id}:reminder`, kind: "ticket_reminder", startsAt: remindAt,
            title: item.title, ticketId: item.id, scheduleId: null,
            status: item.stage, project: item.project,
          });
        }
        if (dueAt && dueAt >= from.toISOString() && dueAt < to.toISOString()) {
          items.push({
            id: `ticket:${item.id}:due`, kind: "ticket_due", startsAt: dueAt,
            title: item.title, ticketId: item.id, scheduleId: null,
            status: item.stage, project: item.project,
          });
        }
      }
      // 例行条目现在来自 triggers（schedules 已被它吸收，spec §5.6）。协议字段名仍叫
      // scheduleId / kind='schedule'：本期不改名（spec §14），改了会一路波及 protocol 与
      // companion，而这里贡献零行为。
      // 过去的 occurrence 只有真的触发过才列出来。以前按 cron 把整个范围都算出来：今天建的每日例行，
      // 本周一到周三也显示「09:00」，看起来像已经执行过（实例上 2026-10-15）。
      const nowIso = now().toISOString();
      for (const trigger of listTriggers(db, { enabledOnly: true })) {
        const template = agendaTemplate(trigger.action_payload);
        const fired = firedOccurrences(db, trigger.id, { from: fromIso, to: to.toISOString() });
        for (const startsAt of triggerOccurrences(trigger, { from, to, timezone: range.timezone })) {
          if (startsAt < nowIso && !fired.has(startsAt)) continue;
          items.push({
            id: `schedule:${trigger.id}:${startsAt}`, kind: "schedule", startsAt,
            title: trigger.label, description: template.brief ?? template.body ?? "",
            ticketId: null, scheduleId: trigger.id,
            status: null, project: template.project ?? null,
          });
        }
      }
      return items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    },

    // 项目卡片（左栏改版阶段 2）：每个项目（含归档的）的分布、Lead 的一句话、最近动静、最近的截止、累计花费。
    // 分布和 listProjects、工单 tab 是同一组工单、同一条规则：根工单，加上需要你的子工单；按 TicketSummary.project 归组。
    // 花费和最近动静算项目里所有工单，含子工单和已结束的。
    projectsOverview(): ProjectOverview[] {
      const projectRows = db.prepare(
        `SELECT id, name, status, summary, created_at FROM projects WHERE status IN ('active','archived')
         ORDER BY name COLLATE NOCASE, id`,
      ).all() as { id: number; name: string; status: "active" | "archived"; summary: string; created_at: string }[];
      const keyByName = new Map(projectRows.map((row) => [row.name, String(row.id)]));
      const zeroCounts = (): Record<Exclude<TicketTurn, never>, number> => ({ user: 0, running: 0, lead: 0, queued: 0, ended: 0 });
      type Acc = {
        counts: Record<TicketTurn, number>; costUsd: number; tokens: number;
        lastActivityAt: string | null; nextMilestone: ProjectOverview["nextMilestone"]; touched: boolean;
      };
      const accs = new Map<string, Acc>();
      const accOf = (key: string): Acc => {
        let acc = accs.get(key);
        if (!acc) {
          acc = { counts: zeroCounts(), costUsd: 0, tokens: 0, lastActivityAt: null, nextMilestone: null, touched: false };
          accs.set(key, acc);
        }
        return acc;
      };
      for (const item of listItems(db, { kind: "task" })) {
        const summary = itemSummary(item);
        const key = (summary.project !== null ? keyByName.get(summary.project) : undefined) ?? "unknown";
        const acc = accOf(key);
        acc.costUsd += item.total_cost_usd;
        acc.tokens += item.total_tokens;
        const activity = iso(item.last_activity_at);
        if (activity && (acc.lastActivityAt === null || activity > acc.lastActivityAt)) acc.lastActivityAt = activity;
        const turn = ticketTurn(summary);
        if (summary.parentTicketId != null && turn !== "user") continue;
        acc.touched = true;
        acc.counts[turn] += 1;
        const next = turn === "ended" ? undefined : summary.nextMilestone;
        if (next && (acc.nextMilestone === null || next.at < acc.nextMilestone.at)) {
          acc.nextMilestone = {
            ticketId: item.id, title: item.display_title ?? item.title,
            kind: next.kind, label: next.label, at: next.at, allDay: next.allDay,
          };
        }
      }
      const leadStatusOf = (projectId: number, text: string, createdAt: string): ProjectOverview["leadStatus"] => {
        if (!text.trim()) return null;
        // 一句话最后一次改写的时间：最近一次 summary 有变化的 project_changes。
        const changes = db.prepare(
          "SELECT before_state, after_state, created_at FROM project_changes WHERE project_id = ? ORDER BY id DESC",
        ).all(projectId) as { before_state: string | null; after_state: string | null; created_at: string }[];
        const changed = changes.find((change) => {
          const before = JSON.parse(change.before_state ?? "{}") as { summary?: string };
          const after = JSON.parse(change.after_state ?? "{}") as { summary?: string };
          return before.summary !== after.summary;
        });
        // 没有改写过：这句话是建项目时写的。
        return { text, at: iso(changed?.created_at ?? createdAt) ?? new Date(0).toISOString() };
      };
      const shape = (id: string, name: string, status: ProjectOverview["status"], acc: Acc | undefined, leadStatus: ProjectOverview["leadStatus"]): ProjectOverview => ({
        id, name, status,
        counts: acc?.counts ?? zeroCounts(),
        leadStatus,
        lastActivityAt: acc?.lastActivityAt ?? null,
        nextMilestone: acc?.nextMilestone ?? null,
        spend: { costUsd: Math.round((acc?.costUsd ?? 0) * 100) / 100, tokens: acc?.tokens ?? 0 },
      });
      const overview = projectRows.map((row) => shape(String(row.id), row.name, row.status, accs.get(String(row.id)), leadStatusOf(row.id, row.summary, row.created_at)));
      const unknown = accs.get("unknown");
      return unknown?.touched ? [...overview, shape("unknown", "unknown", "active", unknown, null)] : overview;
    },

    // 收件箱（阶段 1）：每张等你的工单为什么在等、从什么时候开始；Lead 最近 7 天自己处理掉的事；你上次看的时间。
    // 「等你」用 ticketNeedsUser，和角标、会话底栏、工单 tab 的「等你」是同一组。
    inboxView(): InboxView {
      const approvalsByItem = new Map<number, { action: string; created_at: string }>();
      for (const approval of pendingApprovals(db)) {
        if (approval.item_id !== null && !approvalsByItem.has(approval.item_id)) approvalsByItem.set(approval.item_id, approval);
      }
      const tickets: InboxView["tickets"] = [];
      for (const item of listItems(db, { kind: "task" })) {
        const summary = itemSummary(item);
        const needs = ticketNeedsUser(summary);
        if (needs === null) continue;
        const approval = approvalsByItem.get(item.id);
        const stageSince = iso(item.stage_changed_at) ?? item.stage_changed_at;
        // 等你回答的决定（attention.pendingDecisionCount）：原因写这条决定自己的说明，时间从它提出时算（2026-10-16）。
        const decision = needs === "decision" && summary.attention.pendingDecisionCount ? oldestUserDecision(item.id) : null;
        const reason = needs === "approval" && approval
          ? `等你批准：${approval.action}`
          : decision
            ? decision.reason
            : needs === "blocked"
            ? (summary.executionState?.reason ?? latestBlockedReason(db, item.id))
            : needs === "decision" || needs === "review_dispatch" || needs === "acceptance"
              ? (summary.reviewState?.reason ?? summary.reviewState?.label ?? null)
              : needs === "stalled"
                ? "Run 很久没有动静"
                : needs === "capability"
                  ? "续作在等一个还没部署的能力"
                  : `${leadDisplayName(db)} 建的草稿，等你确认才会开始`;
        const since = needs === "approval" && approval
          ? iso(approval.created_at) ?? approval.created_at
          : decision
            ? decision.since
            : needs === "stalled" && summary.runtime.lastActivityAt
            ? summary.runtime.lastActivityAt
            : stageSince;
        tickets.push({ ticketId: item.id, reason, since });
      }
      const weekAgo = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const dispositions = listLeadHandled(db, { since: weekAgo }).map((entry) => ({
        id: `inbox:${entry.eventIds[0]}`,
        ticketId: entry.itemId,
        problem: entry.problem,
        cause: entry.cause,
        action: entry.action ?? entry.reason,
        followUp: entry.followUp,
        eventCount: entry.eventIds.length,
        handledAt: entry.handledAt,
      }));
      // Lead 改了你定的日期（阶段 3）：可以改，但要告诉你，写在「Lead 已处理」里（透明度要求，不是权限限制）。
      const overrides = leadOverridesOfUser(db, weekAgo).map(({ change, milestone }) => {
        const label = milestone.label ?? MILESTONE_KIND_LABELS[milestone.kind];
        const verb = change.change === "moved" ? "改了日期" : change.change === "cancelled" ? "取消了它"
          : change.change === "completed" ? "标为完成" : change.change === "missed" ? "标为没赶上"
            : change.change === "relabeled" ? "改了名字" : "恢复了它";
        return {
          id: `milestone-change:${change.id}`,
          ticketId: milestone.item_id,
          problem: `#${milestone.item_id} 的「${label}」是你定的，${leadDisplayName(db)} ${verb}`,
          cause: null,
          action: change.reason ?? verb,
          followUp: null,
          eventCount: 1,
          handledAt: iso(change.created_at) ?? change.created_at,
        };
      });
      // Lead 自己改了你定的提醒时间（ui-action-parity P04）：同样写在「Lead 已处理」里。
      const reminderOverrides = leadReminderOverridesOfUser(db, weekAgo).map((override) => ({
        id: `reminder-reschedule:${override.eventId}`,
        ticketId: override.itemId,
        problem: `提醒「${override.title}」的时间是你定的，${leadDisplayName(db)} 改到了 ${localIso(new Date(override.to))}`,
        cause: null,
        action: override.reason,
        followUp: null,
        eventCount: 1,
        handledAt: override.at,
      }));
      // Lead 自己判断停下的工单（ui-action-parity P03：Lead 可以停，事后必须让用户知道）。
      const stops = leadOwnStops(db, weekAgo).map((stop) => ({
        id: `ticket-stop:${stop.eventId}`,
        ticketId: stop.itemId,
        problem: `${leadDisplayName(db)} 停下了工单 #${stop.itemId}「${stop.title}」，它回到了待开始`,
        cause: null,
        action: stop.reason,
        followUp: null,
        eventCount: 1,
        handledAt: stop.at,
      }));
      const leadHandled = [...dispositions, ...overrides, ...reminderOverrides, ...stops]
        .sort((left, right) => right.handledAt.localeCompare(left.handledAt));
      return { tickets, leadHandled, seenAt: inboxSeenAt(db) };
    },

    listApprovals(): ApprovalDto[] {
      return pendingApprovals(db).map((approval) => ({
        id: approval.id,
        ticketId: approval.item_id,
        requestedBy: approval.requested_by,
        tool: approval.tool,
        action: approval.action,
        payload: recordPayload(approval.payload),
        status: approval.status,
        expiresAt: iso(approval.expires_at) ?? approval.expires_at,
        createdAt: iso(approval.created_at) ?? approval.created_at,
      }));
    },

    // toolCallScopes：每一轮再带上它的工具调用，从账本里同一批事件折叠出来（foldTurnToolCalls），
    // 所以刷新以后的任务卡和实时看到的一样。只读调用方有 scope 的事件，和实时事件流一样。
    // 只在客户端要的时候才加，见 protocol 的 ConversationTurnSchema。
    // Lead 处理了、但没有对用户说的事，旧的在前（2026-10-15 方案 A「Lead 动态」）。取最近的 limit 件。
    listLeadActivity(opts?: { limit?: number }): LeadActivityItem[] {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
      const kinds = LEAD_ACTIVITY_DISPOSITIONS.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, item_id, summary, payload FROM inbox
         WHERE json_valid(payload) AND json_extract(payload, '$.disposition.kind') IN (${kinds})
         ORDER BY json_extract(payload, '$.disposition.at') DESC, id DESC
         LIMIT ?`,
      ).all(...LEAD_ACTIVITY_DISPOSITIONS, limit) as Array<{ id: number; item_id: number | null; summary: string; payload: string }>;
      return rows.reverse().map((row) => {
        const disposition = (JSON.parse(row.payload) as { disposition: { kind: LeadActivityItem["disposition"]; reason?: unknown; at?: unknown } }).disposition;
        return {
          id: row.id,
          at: typeof disposition.at === "string" ? disposition.at : "",
          disposition: disposition.kind,
          reason: typeof disposition.reason === "string" ? disposition.reason : "",
          summary: row.summary,
          ticketId: row.item_id,
        };
      });
    },

    // 工单 06：「Lead 动态」从事件日志算，一个对象一张卡，带依据和版本；还有输入框上方的 interrupt 横幅（./lead-activity.ts）。
    // 旧客户端仍用上面的 listLeadActivity（GET /v1/lead/activity 不带 include）。
    leadActivityView(opts?: { limit?: number; reminders?: boolean; setup?: boolean }): LeadActivityView {
      return buildLeadActivityView(db, opts);
    },

    // 把变了的卡和横幅推出去（daemon 在事件写进日志时、和每次轮询时调用；用户确认横幅以后网关也调用）。返回推了几条。
    syncLeadActivity(publish: (event: PublishGatewayEventInput) => unknown): number {
      return leadActivityPublisher.sync(publish);
    },

    // 用户点了横幅上的「知道了」：记一条确认事件，被确认的事件写回处置 interrupted_user（store 的 acknowledgeInterruptEvent）。
    acknowledgeInterrupt(seq: number, opts: { bindingId: number | null }): LeadInterrupt {
      const { event } = acknowledgeInterruptEvent(db, seq, { bindingId: opts.bindingId, at: now() });
      return leadInterruptOf(db, event);
    },

    listConversationTurns(opts?: {
      itemId?: number; limit?: number; toolCallScopes?: readonly Scope[]; surfaceScopes?: readonly Scope[];
      placement?: boolean;
      // 工单 agent 的轮次带上回复在问你要不要做的动作（2026-10-19，store 的 ticket-reply-actions.ts）。
      replyActions?: boolean;
      // 用户的轮次带上发的图片（protocol 的 chat-images.ts）。
      images?: boolean;
    }): ConversationTurn[] {
      const turns = listTurns(db, opts);
      const imageRefs = opts?.images ? listChatImageRefs(db, turns.map((turn) => turn.id)) : null;
      // 判断过的工单 agent 轮次才有；没有判断过的（还在判断、SmartModel 不可用、Lead 的轮次）不带这个字段。
      const replyActions = opts?.replyActions
        ? ticketReplyActionsByTurn(db, turns.filter((turn) => turn.origin_kind.endsWith(":ticket-agent")).map((turn) => turn.id))
        : null;
      // 用户的消息怎么放的（工单 04）：排着队、插进了正在跑的一轮，或者没有自己的回答、和另一条一起答了。
      const outcomes = opts?.placement ? userMessageOutcomes(db, turns.map((turn) => turn.id)) : null;
      // 插话赶不上这一轮、转为下一轮的输入（「下一轮回答」，工单 06）：daemon 发 lead.turn.started 时已经记在账本里，
      // 这里读每一轮最后的那一条。以前快照只看 channel_turns，刷新以后它变回「已插入」。
      const lastStarts = outcomes
        ? latestTurnStartedPayloads(db, turns.filter((turn) => turn.state === "steered" && !outcomes.has(turn.id)).map((turn) => turn.id))
        : null;
      const placementOf = (turn: (typeof turns)[number]): { placement?: TurnPlacement; answeredWith?: string } => {
        if (!outcomes || isSystemTurnOrigin(turn.origin_kind)) return {};
        if (turn.state === "queued" && turn.error === null) return { placement: "queued" };
        if (turn.state !== "steered") return {};
        const outcome = outcomes.get(turn.id);
        if (!outcome) return { placement: lastStarts?.get(turn.id)?.placement === "next_turn" ? "next_turn" : "steered" };
        // 用户取消了这一条排着的追问（store 的 settleTurnCancelled）：Lead 不回答它。
        if (outcome.outcome === "cancelled") return { placement: "cancelled" };
        return {
          placement: "answered_together",
          ...(typeof outcome.answeredWith === "string" ? { answeredWith: outcome.answeredWith } : {}),
        };
      };
      const toolEvents = opts?.toolCallScopes
        ? listTurnToolEvents(db, turns.map((turn) => turn.id), { scopes: opts.toolCallScopes })
        : null;
      const surfaceEvents = opts?.surfaceScopes
        ? listTurnSurfaceEvents(db, turns.map((turn) => turn.id), { scopes: opts.surfaceScopes })
        : null;
      return turns.map((turn) => ({
        id: turn.id,
        originBindingId: turn.origin_binding_id,
        originKind: turn.origin_kind,
        ticketId: turn.item_id,
        state: turn.state,
        userText: turn.user_text,
        assistantText: turn.assistant_text,
        error: turn.error,
        createdAt: turn.created_at,
        updatedAt: turn.updated_at,
        ...(toolEvents ? { toolCalls: foldTurnToolCalls(toolEvents.get(turn.id) ?? []) } : {}),
        ...(surfaceEvents ? { surfaces: foldTurnSurfaces(surfaceEvents.get(turn.id) ?? []) } : {}),
        ...placementOf(turn),
        ...(replyActions?.has(turn.id) ? { replyActions: replyActions.get(turn.id)! } : {}),
        ...(imageRefs?.has(turn.id) ? { images: imageRefs.get(turn.id)! } : {}),
      }));
    },
  };
}

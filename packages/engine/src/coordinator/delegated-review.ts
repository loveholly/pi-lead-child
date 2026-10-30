import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { enqueueContinuationEvent } from "@pi-lead-child/store";
import {
  activeDelegationPolicy,
  delegationAuthorityLabel,
  type DelegationPolicy,
} from "@pi-lead-child/store";
import { addInbox, leadDisplayName } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { addNotification } from "@pi-lead-child/store";
import {
  DEFAULT_REVIEW_REWORK_CYCLES,
  reworkExhaustion,
  verificationState,
  type ReworkCycle,
} from "./review-authority.js";
import type { Item, Run, RunPurpose, RuntimeDisabledBy, RuntimeId } from "@pi-lead-child/core";
import { isRuntimeDisabled, type RuntimeProfile } from "@pi-lead-child/runtime";
import { reviewerOptions, type ReviewerOption } from "./reviewer-choice.js";
import {
  REVIEW_ESCALATION_WORDS, criteriaChangedSinceReview, reviewEscalation, unmetCriteriaText,
} from "./review-verdict.js";

export type ReviewAutomationOutcome =
  | "accepted"
  | "rework_requested"
  | "waiting_user"
  | "escalated";

export interface ReviewAutomationResult {
  outcome: ReviewAutomationOutcome;
  reason: string;
  delegationPolicyId: number | null;
}

export interface ReviewDispatchRequest {
  itemId: number;
  role: "executor";
  purpose: RunPurpose;
  runtime?: RuntimeId;
  model?: string;
  resumeFromRunId?: number;
  instruction?: string;
  trigger: string;
  idempotencyKey: string;
}

type ReviewDecision =
  | "delegated_review_accept"
  | "delegated_review_rework"
  | "delegated_review_escalate"
  | "review_failure_auto_rework"
  | "review_failure_auto_escalate";

function notificationTitle(verdict: "pass" | "fail", item: Item): string {
  return verdict === "pass"
    ? `工单 #${item.id} review passed`
    : `工单 #${item.id} review failed`;
}

function notifyReview(
  db: Db,
  item: Item,
  input: {
    verdict: "pass" | "fail"; runId: number; evidence: string; bodySuffix?: string;
    // 用户要不要行动。不用（委托验收通过、自动返工）时只是知会：batchable，不立即打断（2026-10-15 用户决定）。
    needsUser?: boolean;
  },
): void {
  addNotification(db, {
    itemId: item.id,
    kind: input.verdict === "pass" ? "review_passed" : "review_failed",
    urgency: input.needsUser === false ? "batchable" : "immediate",
    title: notificationTitle(input.verdict, item),
    body: [
      `Reviewer run #${input.runId}: ${input.evidence}`,
      input.bodySuffix,
    ].filter(Boolean).join("\n"),
    dedupKey: `review:${input.verdict}:item:${item.id}:reviewer-run:${input.runId}`,
  });
}

function notifyAutomationBlocked(
  db: Db,
  item: Item,
  input: {
    kind: "automation_blocked" | "continuation_failed" | "rework_exhausted";
    title: string;
    body: string;
    dedupKey: string;
  },
): void {
  addNotification(db, {
    itemId: item.id,
    kind: input.kind,
    urgency: "immediate",
    title: input.title,
    body: input.body,
    dedupKey: input.dedupKey,
  });
}

// 要不要升级给你，只看核查员在 review_verdict 里声明的 escalate（工单 10，spec 5.9）。以前在证据文本里找 evidence_conflict
// 这类关键词：核查员的提示里没提这些词，那条路实际上不会触发；用关键词给自然语言分类也违反项目规则。
function declaredEscalation(db: Db, runId: number): string | null {
  const escalate = reviewEscalation(db, runId);
  return escalate ? `核查员要你决定：${REVIEW_ESCALATION_WORDS[escalate.reason]}（${escalate.reason}）：${escalate.note}` : null;
}

// 结论以后改过、删了或者新加的验收标准（05 的待决 1）：这个 PASS 说的不是现在的标准，不能让托管自动验收。
function criteriaChanged(db: Db, runId: number): string | null {
  const changed = criteriaChangedSinceReview(db, runId);
  return changed.length
    ? `验收标准在核查以后改过（id ${changed.join("、")}），这个核查结论不能用来自动验收`
    : null;
}

// 托管的用量上限到了：自动验收、自动返工、Lead 凭证据验收（D11）都停下，升级给你。
export function delegationUsageBlocked(item: Pick<Item, "total_tokens" | "total_cost_usd">, policy: DelegationPolicy): string | null {
  if (policy.budget_limit_tokens !== null && item.total_tokens >= policy.budget_limit_tokens) {
    return `delegation budget token limit reached (${item.total_tokens}/${policy.budget_limit_tokens})`;
  }
  if (policy.budget_limit_usd !== null && item.total_cost_usd >= policy.budget_limit_usd) {
    return `delegation budget USD limit reached (${item.total_cost_usd}/${policy.budget_limit_usd})`;
  }
  return null;
}

const VERIFICATION_LABEL = {
  pass: "PASS",
  fail: "FAIL",
  unknown: "未知",
} as const;

const REWORK_SOURCE_LABEL = {
  delegated_automation: "自动返工",
  user_authorized: "用户授权返工",
  legacy_automation: "系统自动返工",
} as const;

/**
 * 返工额度耗尽时给**人**看的那一条通知（工单 #66 复盘第三点）。
 *
 * 在此之前，这件事只以两种形态存在：一条写着"automation blocked"的通用通知，和散落在
 * activities 里的若干条 decision。用户要想知道"到底返了几次、每次为什么失败、现在这东西
 * 到底通没通过"，得自己去翻 L2/L3。这条通知的存在意义就是让那趟翻找不必发生，所以它
 * 必须自带三件事实：用掉的额度、每一轮的失败原因摘要、以及当前**真实**验证状态
 * （过期的 PASS/FAIL 一律记成未知，不能拿来充数）。
 */
function reworkExhaustedNotice(
  db: Db,
  item: Item,
  input: {
    cyclesUsed: number;
    maxCycles: number;
    cycles: ReworkCycle[];
    reviewerRunId: number;
    evidence: string;
    authority: string;
  },
): { title: string; body: string; dedupKey: string } {
  const verification = verificationState(db, item.id);
  const status = VERIFICATION_LABEL[verification.status];
  const verificationLine = verification.current
    ? `当前验证状态：${status}（reviewer Run #${verification.current.run_id}）`
    : verification.latest
      ? `当前验证状态：${status}（最后一次裁决 ${VERIFICATION_LABEL[verification.latest.verdict]}`
        + ` 来自 reviewer Run #${verification.latest.run_id}，已被 Run`
        + ` #${verification.supersededByRunId} 之后的执行作废）`
      : `当前验证状态：${status}（从未产生过独立核查裁决）`;
  const cycleLines = input.cycles.length === 0
    ? ["  （本次授权下没有已完成的返工轮次）"]
    : input.cycles.map((cycle) =>
        `  ${cycle.cycle}. [${REWORK_SOURCE_LABEL[cycle.source]}`
        + `${cycle.reviewerRunId === null ? "" : ` · reviewer Run #${cycle.reviewerRunId}`}]`
        + ` ${cycle.summary}`);
  return {
    title: `工单 #${item.id} 返工次数已用尽（${input.cyclesUsed}/${input.maxCycles}），自动化已停止`,
    body: [
      `已用返工次数：${input.cyclesUsed}/${input.maxCycles}`,
      verificationLine,
      "各轮失败原因：",
      ...cycleLines,
      `本轮 reviewer Run #${input.reviewerRunId}：${input.evidence}`,
      `授权来源：${input.authority}`,
      "下一步：自动派发已停止。请决定放宽返工额度、改变方案、亲自验收，还是取消这张工单——"
        + "系统不会再自行返工。",
    ].join("\n"),
    dedupKey: `rework-exhausted:item:${item.id}:reviewer-run:${input.reviewerRunId}`,
  };
}

function automationLabel(policy: DelegationPolicy | null): string {
  return policy ? delegationAuthorityLabel(policy) : "system automatic review rework policy";
}

function auditDecision(
  db: Db,
  item: Item,
  run: Run,
  policy: DelegationPolicy | null,
  input: {
    decision: ReviewDecision;
    reason: string;
    evidence: string;
    verdict: "pass" | "fail";
  },
): void {
  addActivity(db, {
    itemId: item.id,
    runId: run.id,
    actor: "system",
    kind: "decision",
    payload: {
      decision: input.decision,
      reason: input.reason,
      verdict: input.verdict,
      reviewerRunId: run.id,
      reviewerReport: input.evidence,
      ...(policy ? {
        delegationPolicyId: policy.id,
        policyVersion: policy.policy_version,
      } : {}),
      authority: automationLabel(policy),
    },
  });
}

function escalateAutomation(
  db: Db,
  item: Item,
  run: Run,
  policy: DelegationPolicy | null,
  input: {
    verdict: "pass" | "fail";
    evidence: string;
    reason: string;
    kind?: "automation_blocked" | "rework_exhausted";
    // 停手的理由不同，用户需要看到的东西就不同。返工用尽时这里带的是一份完整报告，
    // 而不是同一句 "automation blocked" 换个 kind。
    notice?: { title: string; body: string; dedupKey: string };
  },
): ReviewAutomationResult {
  auditDecision(db, item, run, policy, {
    decision: policy ? "delegated_review_escalate" : "review_failure_auto_escalate",
    verdict: input.verdict,
    evidence: input.evidence,
    reason: input.reason,
  });
  notifyReview(db, item, {
    verdict: input.verdict,
    runId: run.id,
    evidence: input.evidence,
    bodySuffix: input.reason,
  });
  notifyAutomationBlocked(db, item, {
    kind: input.kind ?? "automation_blocked",
    title: input.notice?.title ?? `工单 #${item.id} automation blocked`,
    body: input.notice?.body
      ?? `${input.reason}\n${automationLabel(policy)}\nReviewer run #${run.id}: ${input.evidence}`,
    dedupKey: input.notice?.dedupKey
      ?? `automation-blocked:item:${item.id}:reviewer-run:${run.id}`,
  });
  enqueueContinuationEvent(db, {
    itemId: item.id,
    eventType: "automation_blocked",
    payload: {
      reviewerRunId: run.id,
      verdict: input.verdict,
      reason: input.reason,
      ...(policy ? { policyId: policy.id } : {}),
    },
    idempotencyKey: `automation-blocked:item:${item.id}:reviewer-run:${run.id}`,
  });
  return { outcome: "escalated", reason: input.reason, delegationPolicyId: policy?.id ?? null };
}

function waitingUser(
  db: Db,
  item: Item,
  run: Run,
  input: { verdict: "pass" | "fail"; evidence: string; reason: string },
): ReviewAutomationResult {
  notifyReview(db, item, {
    verdict: input.verdict,
    runId: run.id,
    evidence: input.evidence,
    bodySuffix: input.reason,
  });
  addActivity(db, {
    itemId: item.id,
    runId: run.id,
    actor: "system",
    kind: "decision",
    payload: {
      decision: "review_verdict_waiting_user",
      verdict: input.verdict,
      reason: input.reason,
      reviewerRunId: run.id,
      reviewerReport: input.evidence,
    },
  });
  return { outcome: "waiting_user", reason: input.reason, delegationPolicyId: null };
}

/**
 * 委托给 Lead 验收的工单，独立核查因为 runtime 故障派不出去（2026-10-19，工单 #88、#89、#92、#93、#98）。
 * Lead 靠核查结论验收（ticket_action 的 complete），结论来不了，工单就一直停在 review。以前没有任何说明：
 * Lead 不知道为什么关不掉，用户以为 Lead 在处理，最后只能自己点通过。
 * 现在叫醒 Lead，并标成需要用户决定：亲自验收，或者等 runtime 恢复（恢复后挂起的核查请求自动派发）。
 * 派发 gate 挂起核查请求时调用（dispatch.ts 的 healthReady）。同一张工单、同一次故障只说一次。返回有没有写下。
 */
// D11 的托管范围要知道的两件事（宿主给）：健康账本按哪个 profile 查，停用的执行器是谁停用的。
export interface ReviewFallbackHost {
  profile?: (runtime: RuntimeId) => RuntimeProfile;
  // daemon 注入 RuntimeSettings.disabledByForDelegation：没有记录的当作用户停用的，读不出 config.json 时按 Lead 停用的算。
  runtimeDisabledBy?: (runtime: RuntimeId) => RuntimeDisabledBy | null;
}

// 一个核查员现在真的不能用：有故障，或者被用户停用了（审查 2026-10-22 第 1 条）。Lead 停用的按能用算：Lead 不能自己停用全部
// 执行器，造出「核查做不成」，再凭托管验收（之后还能再启用它们）。宿主没有说是谁停用的时候不知道，也按能用算。
function reviewerCannotRun(option: ReviewerOption, host: ReviewFallbackHost): boolean {
  if (option.available) return false;
  if (!isRuntimeDisabled(option.runtime)) return true;
  if (!host.runtimeDisabledBy) return false;
  return (host.runtimeDisabledBy(option.runtime)?.by ?? "user") === "user";
}

/**
 * D11 的托管范围：你授权托管时勾了「核查做不成时由 Lead 凭证据验收」，托管的用量上限还没到（和核查 PASS 以后的托管验收同一个
 * 检查，审查 2026-10-22 第 2 条），而且现在一个核查员都不能用（不算 Lead 自己停用的）。
 * 工单操作 accept_without_review 的托管范围（ticket-actions/review-failure.ts）和核查挂起时的通知（noteDelegatedReviewBlocked）
 * 都用它（复核 2026-10-23 第 2 条：以前通知自己判断，只看勾选和额度）。
 */
export function leadMayAcceptWithoutReview(db: Db, item: Item, host: ReviewFallbackHost = {}): boolean {
  if (item.acceptance_policy !== "delegated_to_lead") return false;
  const policy = activeDelegationPolicy(db, item.id);
  if (policy?.accept_without_review !== 1) return false;
  if (delegationUsageBlocked(item, policy) !== null) return false;
  return reviewerOptions(db, host.profile ? { profile: host.profile } : {}).every((option) => reviewerCannotRun(option, host));
}

export function noteDelegatedReviewBlocked(
  db: Db,
  input: { itemId: number; incidentId: number; runtime: RuntimeId; reason: string; host?: ReviewFallbackHost },
): boolean {
  const item = getItem(db, input.itemId);
  const policy = item ? activeDelegationPolicy(db, item.id) : null;
  if (!item || item.acceptance_policy !== "delegated_to_lead" || !policy) return false;
  const told = db.prepare(
    `SELECT 1 FROM inbox
     WHERE item_id=? AND json_extract(payload, '$.kind')='delegated_review_blocked'
       AND json_extract(payload, '$.incidentId')=?
     LIMIT 1`,
  ).get(item.id, input.incidentId);
  if (told) return false;
  // 这一条也给你看，所以用 Lead 的名字（设置 → 身份与风格）。
  // 你授权时勾了「核查做不成时由 Lead 凭证据验收」（D11，工单 11）：Lead 可以凭它读过的证据验收（工单操作
  // accept_without_review），账本标明没有独立核查；你不用做什么。没勾时工单等你验收。两种都只说一次。
  const lead = leadDisplayName(db);
  // 和 Lead 的托管范围同一个判断：用量上限到了、或者有的执行器是 Lead 自己停的，都按没勾处理。
  const leadMayAccept = leadMayAcceptWithoutReview(db, item, input.host ?? {});
  addInbox(db, {
    itemId: item.id,
    severity: "attention",
    source: "structural",
    summary: `工单 #${item.id}「${item.title}」委托给 ${lead} 验收，但独立核查派不出去：${input.reason}`
      + (leadMayAccept
        ? `你授权时勾选了「核查做不成时由 ${lead} 凭证据验收」：所有核查员都不能用时，${lead} 会凭它读过的证据验收，`
          + "账本标明没有独立核查。核查恢复以后，挂起的核查会自动派发。"
        : `${lead} 拿不到核查结论，不能替你验收。你可以亲自验收这张工单，或者等核查恢复，系统会自动派发挂起的核查。`),
    payload: {
      kind: "delegated_review_blocked", incidentId: input.incidentId, runtime: input.runtime,
      wakeLead: true, needsUser: !leadMayAccept, leadMayAcceptWithoutReview: leadMayAccept,
    },
    lossless: true,
  });
  return true;
}

export function applyReviewAutomation(
  db: Db,
  input: {
    run: Run;
    verdict: "pass" | "fail";
    evidence: string;
    now?: Date;
    requestRework: (request: ReviewDispatchRequest) => void;
  },
): ReviewAutomationResult {
  const item = getItem(db, input.run.item_id);
  if (!item) throw new Error(`item #${input.run.item_id} not found`);
  const policy = activeDelegationPolicy(db, item.id, input.now ?? new Date());

  if (input.verdict === "pass") {
    if (!policy) {
      return waitingUser(db, item, input.run, {
        verdict: input.verdict,
        evidence: input.evidence,
        reason: "No active delegated-to-Lead acceptance policy; user acceptance is required.",
      });
    }
    if (item.acceptance_policy !== "delegated_to_lead") {
      return waitingUser(db, item, input.run, {
        verdict: input.verdict,
        evidence: input.evidence,
        reason: `Item acceptance_policy=${item.acceptance_policy ?? "null"} is not delegated_to_lead.`,
      });
    }
    const escalation = declaredEscalation(db, input.run.id) ?? delegationUsageBlocked(item, policy) ?? criteriaChanged(db, input.run.id);
    if (escalation) {
      return escalateAutomation(db, item, input.run, policy, {
        verdict: input.verdict,
        evidence: input.evidence,
        reason: `Automation escalated: ${escalation}.`,
      });
    }
    notifyReview(db, item, {
      verdict: input.verdict,
      runId: input.run.id,
      evidence: input.evidence,
      bodySuffix: delegationAuthorityLabel(policy),
      needsUser: false,
    });
    const reason = `delegated review accepted under ${delegationAuthorityLabel(policy)}; reviewer run #${input.run.id}`;
    auditDecision(db, item, input.run, policy, {
      decision: "delegated_review_accept",
      verdict: input.verdict,
      evidence: input.evidence,
      reason,
    });
    transition(db, { itemId: item.id, to: "done", actor: "system", reason, runId: input.run.id, now: input.now });
    enqueueContinuationEvent(db, {
      itemId: item.id,
      eventType: "review_passed",
      payload: { reviewerRunId: input.run.id, evidence: input.evidence, policyId: policy.id },
      idempotencyKey: `review-passed:item:${item.id}:reviewer-run:${input.run.id}`,
    });
    return { outcome: "accepted", reason, delegationPolicyId: policy.id };
  }

  const escalation = declaredEscalation(db, input.run.id) ?? (policy ? delegationUsageBlocked(item, policy) : null);
  if (escalation) {
    return escalateAutomation(db, item, input.run, policy, {
      verdict: input.verdict,
      evidence: input.evidence,
      reason: `Automation escalated: ${escalation}.`,
    });
  }

  const reworkAuthority =
    policy && item.rework_policy === "automatic" && policy.rework_policy === "automatic"
      ? policy
      : null;
  if (reworkAuthority === null) {
    return waitingUser(db, item, input.run, {
      verdict: input.verdict,
      evidence: input.evidence,
      reason: "Automatic rework is not authorized for this ticket; user decision is required.",
    });
  }
  const exhaustion = reworkExhaustion(db, item, reworkAuthority);
  const maxCycles = exhaustion.maxCycles ?? DEFAULT_REVIEW_REWORK_CYCLES;
  const cycles = exhaustion.cyclesUsed;
  if (exhaustion.exhausted) {
    const reason = `Delegated rework cycles exhausted (${cycles}/${maxCycles}).`;
    const result = escalateAutomation(db, item, input.run, reworkAuthority, {
      verdict: input.verdict,
      evidence: input.evidence,
      reason,
      kind: "rework_exhausted",
      notice: reworkExhaustedNotice(db, item, {
        cyclesUsed: cycles,
        maxCycles,
        cycles: exhaustion.cycles,
        reviewerRunId: input.run.id,
        evidence: input.evidence,
        authority: delegationAuthorityLabel(reworkAuthority),
      }),
    });
    addInbox(db, {
      itemId: item.id,
      severity: "blocker",
      source: "structural",
      summary: `工单 #${item.id} review rework cycles exhausted (${cycles}/${maxCycles})`,
    });
    return result;
  }

  notifyReview(db, item, {
    verdict: input.verdict,
    runId: input.run.id,
    evidence: input.evidence,
    bodySuffix: automationLabel(reworkAuthority),
    needsUser: false,
  });
  const previousExecutor = db.prepare(
    `SELECT id FROM runs
     WHERE item_id=? AND role='executor' AND purpose='execution'
     ORDER BY id DESC LIMIT 1`,
  ).get(item.id) as { id: number } | undefined;
  const reason = `delegated review failed; automatic rework cycle ${cycles + 1}/${maxCycles} under ${delegationAuthorityLabel(reworkAuthority)}; reviewer run #${input.run.id}`;
  auditDecision(db, item, input.run, reworkAuthority, {
    decision: "delegated_review_rework",
    verdict: input.verdict,
    evidence: input.evidence,
    reason,
  });
  addActivity(db, {
    itemId: item.id,
    runId: input.run.id,
    actor: "system",
    kind: "comment",
    payload: {
      content: `Automatic rework requested from reviewer run #${input.run.id}: ${input.evidence}`,
      ...(reworkAuthority ? {
        delegationPolicyId: reworkAuthority.id,
        policyVersion: reworkAuthority.policy_version,
      } : {}),
    },
  });
  transition(db, { itemId: item.id, to: "active", actor: "system", reason, runId: input.run.id, now: input.now });
  input.requestRework({
    itemId: item.id,
    role: "executor",
    purpose: !item.purpose || item.purpose === "review" ? "execution" : item.purpose,
    // runtime 和模型不在这里点名：dispatcher 用工单上记着的 runtime（被用户停用时重新选），模型跟着 runtime 走（run-choice.ts）。
    resumeFromRunId: previousExecutor?.id,
    instruction: [
      `根据 reviewer Run #${input.run.id} 的失败证据修复当前工单：${input.evidence}`,
      unmetCriteriaText(db, input.run.id),
    ].filter(Boolean).join("\n"),
    trigger: "delegated-review-rework",
    idempotencyKey: `delegated-review-rework:${item.id}:policy:${reworkAuthority.id}:reviewer-run:${input.run.id}`,
  });
  enqueueContinuationEvent(db, {
    itemId: item.id,
    eventType: "review_failed",
    payload: {
      reviewerRunId: input.run.id,
      evidence: input.evidence,
      cycle: cycles + 1,
      ...(reworkAuthority ? { policyId: reworkAuthority.id } : {}),
    },
    idempotencyKey: `review-failed:item:${item.id}:reviewer-run:${input.run.id}`,
  });
  return { outcome: "rework_requested", reason, delegationPolicyId: reworkAuthority?.id ?? null };
}

// 核查结论（工单详情与验收 spec 5.7 第 7 点、5.9、D8，工单 10）。
// - normalizeReviewVerdict：核查员交的 review_verdict 和这次的核查包对得上：每一条标准一项，结论只能是 通过 / 不通过 /
//   无法核实，各附证据；有一条不通过时总结论不能是 PASS；escalate 的原因只能从固定的几种里选。对不上时拒绝，核查员可以改了重交。
// - reviewEscalation：托管的自动化（delegated-review.ts）要不要升级给你，只看核查员声明的 escalate 字段。
//   以前在证据文本里找 evidence_conflict 这类关键词（evidenceEscalation），核查员的提示里没提这些词，那条路实际上不会触发，
//   而且用关键词给自然语言分类违反项目规则。
// - criteriaChangedSinceReview：结论以后改过或删了的标准（05 的待决 1）。不为空时这个 PASS 不能让托管自动验收。
// - criterionVerdictsForDelivery、ticketReviews：给页面和 Lead 读。结论按交付存：第 2 次交付从头开始。
import type { Run } from "@pi-lead-child/core";
import {
  REVIEW_CRITERION_RESULTS, REVIEW_ESCALATION_REASONS, redactAndCap,
  type AcceptedWithoutReview, type CriterionVerdict, type ReviewCriterionResult, type ReviewCriterionVerdict, type ReviewEscalation,
  type ReviewEscalationReason, type ReviewVerdict, type TicketReviewAttempt, type TicketReviews,
} from "@pi-lead-child/protocol";
import {
  deliveryRunBefore, getDeliverySnapshotBySequence, latestDeliveryRunId, getLatestDeliverySnapshot, getReviewPacket,
  getReviewVerdictDetails, listAcceptanceCriteria,
  type Db, type ReviewVerdictDetails, type ReviewVerdictDetailsInput,
} from "@pi-lead-child/store";
import { verificationState } from "./review-authority.js";

export const REVIEW_EVIDENCE_MAX = 4_000;

const RESULT_WORDS: Record<ReviewCriterionResult, string> = { pass: "通过", fail: "不通过", unverifiable: "无法核实" };

export const REVIEW_ESCALATION_WORDS: Record<ReviewEscalationReason, string> = {
  evidence_conflict: "证据矛盾",
  requirement_change: "需求变了",
  irreversible_action: "有不可逆的操作",
  external_approval: "要外部批准",
};

// 核查员交的结论对不上核查包。工具把这句话原样给核查员，它改了以后可以重交。
export class ReviewVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewVerdictError";
  }
}

export interface ReviewVerdictSubmission {
  verdict: "pass" | "fail";
  evidence: string;
  criteria?: unknown;
  escalate?: unknown;
}

interface ExpectedCriterion {
  id: number;
  number: number;
  revision: number;
}

// 这次核查要回答的标准：核查包里的那些（核查员看到的版本），每一条都要回答（required）。
// 升级以前就开始的核查没有核查包，提示里也没有逐条的标准：按现在的标准核对它给了的那些，不要求每一条都回答。
function expectedCriteria(db: Db, run: Run): { criteria: ExpectedCriterion[]; required: boolean } {
  const packet = getReviewPacket(db, run.id);
  if (packet) return { criteria: packet.packet.criteria.map(({ id, number, revision }) => ({ id, number, revision })), required: true };
  return {
    criteria: listAcceptanceCriteria(db, run.item_id).map((criterion, index) => ({
      id: criterion.id, number: index + 1, revision: criterion.revision,
    })),
    required: false,
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewVerdictError(`${field} 要是一个对象。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewVerdictError(`${field} 要写一段证据，不能是空的。`);
  return value.trim().slice(0, REVIEW_EVIDENCE_MAX);
}

function escalationOf(value: unknown): ReviewEscalation | null {
  if (value === undefined || value === null) return null;
  const raw = record(value, "escalate");
  const reason = raw.reason;
  if (typeof reason !== "string" || !(REVIEW_ESCALATION_REASONS as readonly string[]).includes(reason)) {
    throw new ReviewVerdictError(`escalate.reason 只能是 ${REVIEW_ESCALATION_REASONS.join("、")} 之一。`);
  }
  return { reason: reason as ReviewEscalationReason, note: text(raw.note, "escalate.note").slice(0, 2_000) };
}

/**
 * 核对核查员交的结论，整理成要存的样子（store 的 writeReviewVerdictDetails）。对不上时抛 ReviewVerdictError。
 */
export function normalizeReviewVerdict(db: Db, run: Run, submission: ReviewVerdictSubmission): ReviewVerdictDetailsInput {
  const { criteria: expected, required } = expectedCriteria(db, run);
  const byId = new Map(expected.map((criterion) => [criterion.id, criterion]));
  const given = submission.criteria === undefined || submission.criteria === null ? [] : submission.criteria;
  if (!Array.isArray(given)) throw new ReviewVerdictError("criteria 要是一个数组：每一条验收标准一项 {id, result, evidence}。");
  const seen = new Map<number, ReviewCriterionVerdict>();
  for (const [index, entry] of given.entries()) {
    const raw = record(entry, `criteria[${index}]`);
    const id = raw.id;
    if (typeof id !== "number" || !byId.has(id)) {
      throw new ReviewVerdictError(
        `criteria[${index}].id=${JSON.stringify(id)} 不是核查包里的验收标准。核查包里的 id：${expected.map((criterion) => criterion.id).join("、") || "（没有）"}。`,
      );
    }
    if (seen.has(id)) throw new ReviewVerdictError(`验收标准 id ${id} 回答了两次，每一条只回答一次。`);
    const result = raw.result;
    if (typeof result !== "string" || !(REVIEW_CRITERION_RESULTS as readonly string[]).includes(result)) {
      throw new ReviewVerdictError(`criteria[${index}].result 只能是 pass（通过）、fail（不通过）或 unverifiable（无法核实）。`);
    }
    const criterion = byId.get(id)!;
    seen.set(id, {
      criterionId: id, number: criterion.number, revision: criterion.revision, result: result as ReviewCriterionResult,
      evidence: text(raw.evidence, `criteria[${index}].evidence`),
    });
  }
  const missing = expected.filter((criterion) => !seen.has(criterion.id));
  if (required && missing.length) {
    throw new ReviewVerdictError(
      `还有验收标准没有回答：${missing.map((criterion) => `第 ${criterion.number} 条（id ${criterion.id}）`).join("、")}。每一条都要给出结论和证据。`,
    );
  }
  const criteria = expected.filter((criterion) => seen.has(criterion.id)).map((criterion) => seen.get(criterion.id)!);
  const failed = criteria.filter((entry) => entry.result === "fail");
  if (submission.verdict === "pass" && failed.length) {
    throw new ReviewVerdictError(
      `总结论是 pass，但${failed.map((entry) => `第 ${entry.number} 条`).join("、")}不通过。有一条不通过时总结论只能是 fail。`,
    );
  }
  const packet = getReviewPacket(db, run.id);
  return {
    runId: run.id,
    itemId: run.item_id,
    executorRunId: packet?.executorRunId ?? deliveryRunBefore(db, run.item_id, run.id),
    escalate: escalationOf(submission.escalate),
    criteria,
  };
}

/** 核查员声明的 escalate。没有声明（或者 v57 以前的结论）时为 null。 */
export function reviewEscalation(db: Db, runId: number): ReviewEscalation | null {
  return getReviewVerdictDetails(db, runId)?.escalate ?? null;
}

/**
 * 结论以后改过、删了或者新加的验收标准（id）。核查员看到的是核查包里的那一版；v57 以前的核查没有核查包，不比较。
 */
export function criteriaChangedSinceReview(db: Db, runId: number): number[] {
  const packet = getReviewPacket(db, runId);
  if (!packet) return [];
  const seen = new Map(packet.packet.criteria.map((criterion) => [criterion.id, criterion.revision]));
  const current = listAcceptanceCriteria(db, packet.itemId);
  const changed = current.filter((criterion) => seen.get(criterion.id) !== criterion.revision).map((criterion) => criterion.id);
  const live = new Set(current.map((criterion) => criterion.id));
  const deleted = [...seen.keys()].filter((id) => !live.has(id));
  return [...changed, ...deleted];
}

/**
 * 返工指令和通知里附上的逐条结论：不通过和无法核实的那几条。没有时为空字符串。
 */
export function unmetCriteriaText(db: Db, runId: number): string {
  const unmet = (getReviewVerdictDetails(db, runId)?.criteria ?? []).filter((entry) => entry.result !== "pass");
  if (!unmet.length) return "";
  return [
    "没有通过的验收标准：",
    ...unmet.map((entry) => `- 第 ${entry.number} 条（id ${entry.criterionId}）${RESULT_WORDS[entry.result]}：${entry.evidence}`),
  ].join("\n");
}

// ── 读 ───────────────────────────────────────────────────────────────────────────

interface VerdictRow {
  run_id: number;
  verdict: "pass" | "fail";
  evidence: string;
  created_at: string;
}

function verdictRow(db: Db, runId: number): VerdictRow | undefined {
  return db.prepare("SELECT run_id, verdict, evidence, created_at FROM review_verdicts WHERE run_id=?").get(runId) as
    VerdictRow | undefined;
}

// 一次交付（执行 Run）的核查 Run，按时间排：它之后、下一次交付之前的核查 Run（purpose=review）。
function reviewRunsForDelivery(db: Db, itemId: number, executorRunId: number): Run[] {
  const runs = db.prepare(
    `SELECT * FROM runs WHERE item_id=? AND role='reviewer' AND purpose='review' AND id > ? ORDER BY id`,
  ).all(itemId, executorRunId) as Run[];
  return runs.filter((run) => deliveryRunBefore(db, itemId, run.id) === executorRunId);
}

function verdictOf(db: Db, itemId: number, runId: number, details: ReviewVerdictDetails | undefined): ReviewVerdict | null {
  const row = verdictRow(db, runId);
  if (!row) return null;
  return {
    verdict: row.verdict,
    evidence: row.evidence,
    escalate: details?.escalate ?? null,
    criteria: details?.criteria ?? [],
    submittedAt: details?.submittedAt ?? row.created_at,
    current: verificationState(db, itemId).current?.run_id === runId,
    criteriaChangedSince: criteriaChangedSinceReview(db, runId),
  };
}

function attemptOf(db: Db, itemId: number, run: Run): TicketReviewAttempt {
  const packet = getReviewPacket(db, run.id);
  return {
    attemptId: run.id,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort ?? null,
    state: run.state,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    packetSummary: packet?.summary ?? null,
    packet: packet?.packet ?? null,
    verdict: verdictOf(db, itemId, run.id, getReviewVerdictDetails(db, run.id)),
  };
}

// 不等核查直接验收的决定（ticket-actions/review-failure.ts 的 accept_without_review，工单 11）。
export const ACCEPTED_WITHOUT_REVIEW = "accepted_without_review";

/** 这次交付没有独立核查就验收的记录（给 reviews 接口）。没有时为 null。 */
export function acceptedWithoutReview(db: Db, itemId: number, deliveryRunId: number): AcceptedWithoutReview | null {
  const row = db.prepare(
    `SELECT actor, payload, created_at FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
       AND json_extract(payload, '$.deliveryRunId')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, ACCEPTED_WITHOUT_REVIEW, deliveryRunId) as { actor: "user" | "lead"; payload: string; created_at: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as {
    authority: AcceptedWithoutReview["authority"]; reason: string; reviewProblem: string | null; onBehalfOf?: "user";
  };
  return {
    by: row.actor,
    onBehalfOf: payload.onBehalfOf ?? null,
    authority: payload.authority,
    reason: payload.reason,
    reviewProblem: payload.reviewProblem ?? null,
    at: row.created_at,
  };
}

/**
 * 一次交付的核查（GET /v1/tickets/:id/reviews）：每一次核查员看到了什么、给了什么结论。
 * delivery 是第几次交付；不给时是最新一次交付。最新的交付 Run 还没有快照（快照还在后台存，或者存不成）时用那个 Run，
 * sequence 为 null（审查 2026-10-22 第 5 条：以前这时整个是空的，「没有独立核查」也读不到）。
 * 那次交付不存在时返回 null。还没有交付时 delivery 为 null，attempts 为空。
 */
export function ticketReviews(db: Db, itemId: number, options: { delivery?: number } = {}): TicketReviews | null {
  const latest = getLatestDeliverySnapshot(db, itemId);
  const latestRun = latestDeliveryRunId(db, itemId);
  let delivery: TicketReviews["delivery"] = null;
  if (options.delivery !== undefined) {
    const chosen = getDeliverySnapshotBySequence(db, itemId, options.delivery);
    if (!chosen) return null;
    delivery = { sequence: chosen.sequence, attemptId: chosen.executorRunId, latest: chosen.executorRunId === (latestRun ?? chosen.executorRunId) };
  } else if (latest && (latestRun === null || latest.executorRunId >= latestRun)) {
    delivery = { sequence: latest.sequence, attemptId: latest.executorRunId, latest: true };
  } else if (latestRun !== null) {
    delivery = { sequence: null, attemptId: latestRun, latest: true };
  }
  if (!delivery) return { ticketId: itemId, delivery: null, attempts: [], acceptedWithoutReview: null };
  return {
    ticketId: itemId,
    delivery,
    attempts: reviewRunsForDelivery(db, itemId, delivery.attemptId).map((run) => attemptOf(db, itemId, run)),
    acceptedWithoutReview: acceptedWithoutReview(db, itemId, delivery.attemptId),
  };
}

/**
 * 一次交付上每一条标准的结论：这次交付最新一次有结论的核查（D8：结论跟着各自那次交付，第 2 次交付从头开始）。
 */
export function criterionVerdictsForDelivery(db: Db, itemId: number, executorRunId: number): Map<number, CriterionVerdict> {
  const verdicts = new Map<number, CriterionVerdict>();
  const runs = reviewRunsForDelivery(db, itemId, executorRunId).reverse();
  const settled = runs.find((run) => verdictRow(db, run.id) && getReviewVerdictDetails(db, run.id));
  if (!settled) return verdicts;
  const current = verificationState(db, itemId).current?.run_id === settled.id;
  for (const entry of getReviewVerdictDetails(db, settled.id)!.criteria) {
    verdicts.set(entry.criterionId, {
      result: entry.result, evidence: entry.evidence, attemptId: settled.id, revision: entry.revision, current,
    });
  }
  return verdicts;
}

// 拼进 Lead 的结果，所以有总长度上限（和验收标准那一段一样）。
const REVIEWS_TEXT_MAX = 8_000;

/** 核查包摘要的一句话：「拿到 3 条验收标准、3 个文件（+94 −2）、1 个提交、2 项待核实的验证」。 */
export function reviewPacketSummaryText(summary: NonNullable<TicketReviewAttempt["packetSummary"]>): string {
  const recheck = summary.recheck
    ? `；复核：${summary.recheck.newCommits === null ? "新增的提交算不出来" : `只看 ${summary.recheck.newCommits} 个新提交`}`
      + `和 ${summary.recheck.focusCriteria} 条标准`
    : "";
  return `拿到 ${summary.criteria} 条验收标准、${summary.files} 个文件（+${summary.additions} −${summary.deletions}）、`
    + `${summary.commits} 个提交、${summary.validations} 项待核实的验证${recheck}`;
}

/**
 * Lead 的 get_ticket 里的「核查」一段：和页面同一份（ticketReviews，最新一次交付）。每一次核查一行摘要，有结论时逐条列出。
 */
export function ticketReviewsText(db: Db, itemId: number): string {
  const view = ticketReviews(db, itemId);
  if (!view?.delivery) return "还没有交付。";
  const which = view.delivery.sequence === null
    ? `最新一次交付（Run #${view.delivery.attemptId}，还没有交付快照）`
    : `第 ${view.delivery.sequence} 次交付（Run #${view.delivery.attemptId}）`;
  if (!view.attempts.length && !view.acceptedWithoutReview) return `${which}还没有核查。`;
  const out = [`${which}的核查：`];
  for (const attempt of view.attempts) {
    const who = [attempt.runtime, attempt.model].filter(Boolean).join(" ");
    const packet = attempt.packetSummary ? reviewPacketSummaryText(attempt.packetSummary) : "没有核查包（功能上线以前的核查）";
    out.push(`- 核查 Run #${attempt.attemptId}（${who}，${attempt.state}）：${packet}`);
    const verdict = attempt.verdict;
    if (!verdict) {
      out.push("  还没有结论。");
      continue;
    }
    out.push(`  总结论 ${verdict.verdict.toUpperCase()}（${verdict.current ? "还算数" : "已过期"}）：${JSON.stringify(verdict.evidence)}`);
    if (verdict.escalate) {
      out.push(`  核查员要用户决定：${REVIEW_ESCALATION_WORDS[verdict.escalate.reason]}：${JSON.stringify(verdict.escalate.note)}`);
    }
    for (const entry of verdict.criteria) {
      out.push(`  ${entry.number}. [${RESULT_WORDS[entry.result]}]（id ${entry.criterionId}，第 ${entry.revision} 版）${JSON.stringify(entry.evidence)}`);
    }
    if (verdict.criteriaChangedSince.length) {
      out.push(`  结论以后改过的标准：id ${verdict.criteriaChangedSince.join("、")}（这个结论不能用来自动验收）。`);
    }
  }
  if (view.acceptedWithoutReview) {
    const accepted = view.acceptedWithoutReview;
    const who = accepted.authority === "delegated" ? "你按托管授权" : accepted.authority === "on_behalf" ? "你代用户" : "用户";
    out.push(`- 没有独立核查就验收了（${who}，${accepted.at}）：${JSON.stringify(accepted.reason)}`
      + (accepted.reviewProblem ? `；当时：${accepted.reviewProblem}` : ""));
  }
  const text = out.join("\n");
  const capped = redactAndCap(text, REVIEWS_TEXT_MAX);
  return capped.truncated ? `${capped.text}…（截断，原文 ${text.length} 字）` : capped.text;
}

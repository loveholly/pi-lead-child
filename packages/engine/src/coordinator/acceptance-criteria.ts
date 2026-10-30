// 结构化验收标准的读取（工单详情与验收 spec 4.3、5.1、5.11、D5、D6，工单 05）。页面、Lead 和执行 agent 读的是同一份：
// - ticketAcceptanceCriteria：给页面的线上形状（protocol 的 acceptance-criteria.ts），GET /v1/tickets/:id/acceptance-criteria 用它。
// - acceptanceCriteriaText：同一份写成几行字，给 Lead 的 get_ticket。
// - acceptanceCriteriaPromptSection：执行者每次启动时提示里的一节（children/manager.ts 的 startRequest），同时记下执行者看到的版本。
// - confirmableDelivery：确认对着哪一次交付。工单操作 confirm_criterion、unconfirm_criterion 用它判断现在能不能做。
// 写入在 store 的 acceptance-criteria.ts，操作在 ticket-actions/acceptance-criteria.ts。
//
// 「哪一次交付」不另算一套，和 04 一样：最新一次交付是最新的成果快照的执行 Run；一次交付的快照是 04 的交付快照
// （一个 sequence），它的执行 Run 是确认的键。读取、确认和作废用同一个判断（审查 M1）：「现在这次交付」是最新一次交付，
// 它的快照存好了，而且工单停在待验收或已完成。最新一次交付还没有快照、或者工单在返工时，没有「现在这次交付」，
// 更早的交付都是历史：用 delivery=N 看，显示那次交付时的样子。
import type { Item } from "@pi-lead-child/core";
import { redactAndCap, type AcceptanceCriterion as WireCriterion, type TicketAcceptanceCriteria } from "@pi-lead-child/protocol";
import {
  getDeliverySnapshotBySequence, getExecutorCriteriaView, getLatestDeliverySnapshot, getLatestOutcomeSnapshot,
  getOutcomeSnapshotForRun, listAcceptanceCriteria, listCriterionConfirmations, listCriterionRevisions,
  recordExecutorCriteriaView,
  type AcceptanceCriterion, type CriterionConfirmation, type Db, type DeliverySnapshot, type ExecutorCriteriaView,
} from "@pi-lead-child/store";
import { deliveryCaptureFailureForRun } from "./delivery-snapshot.js";
import { criterionVerdictsForDelivery } from "./review-verdict.js";

export const NO_ACCEPTANCE_CRITERIA_TEXT = "（没有结构化的验收标准。）";
const SNAPSHOT_PENDING_TEXT = "这次交付的快照还没存好，稍后再确认。";

// 拼进 Lead 的结果，所以有总长度上限（工单 06 审查 M3 的同类问题）。标准最多 20 条、每条 500 字，加上状态有一万多字。
const CRITERIA_TEXT_MAX = 8_000;

const STAGE_WORDS: Record<string, string> = {
  draft: "草稿", ready: "待开始", active: "执行中", blocked: "受阻", review: "待验收", done: "已完成", cancelled: "已取消",
};

export interface CriteriaDeliveryRef {
  sequence: number;
  executorRunId: number;
  // 这次交付最新的一份快照：确认记下你看的是哪一份。
  snapshotId: number;
  // 执行者交付（登记成果）的时间（审查 M2）。没有成果快照时退回第一份交付快照的时间。
  deliveredAt: string;
  latest: boolean;
}

export interface PendingDelivery {
  attemptId: number;
  reason: string;
}

function deliveryRef(db: Db, itemId: number, snapshot: DeliverySnapshot, latest: boolean): CriteriaDeliveryRef {
  const outcome = getOutcomeSnapshotForRun(db, snapshot.executorRunId);
  const first = getDeliverySnapshotBySequence(db, itemId, snapshot.sequence, 1) ?? snapshot;
  return {
    sequence: snapshot.sequence, executorRunId: snapshot.executorRunId, snapshotId: snapshot.id,
    deliveredAt: outcome?.itemId === itemId ? outcome.createdAt : first.createdAt, latest,
  };
}

/**
 * 最新的交付快照，和最新一次交付是不是还没有快照（pending）。最新一次交付是最新的成果快照的执行 Run（04 的
 * ensureLatestDeliveryRecorded 也这样认）。它比最新的快照新时，快照还在后台存，或者存不成：原因用 04 记下的失败（审查 M5）。
 */
export function deliveryState(db: Db, itemId: number): { snapshot: DeliverySnapshot | null; pending: PendingDelivery | null } {
  const snapshot = getLatestDeliverySnapshot(db, itemId) ?? null;
  const outcome = getLatestOutcomeSnapshot(db, itemId);
  if (!outcome || (snapshot && snapshot.executorRunId >= outcome.executorRunId)) return { snapshot, pending: null };
  const failure = deliveryCaptureFailureForRun(db, itemId, outcome.executorRunId);
  return {
    snapshot,
    pending: {
      attemptId: outcome.executorRunId,
      reason: failure ? `这次交付存不成快照：${failure.text}没有快照，不能对照这次交付逐条确认。` : SNAPSHOT_PENDING_TEXT,
    },
  };
}

/**
 * 现在能对着哪一次交付确认。只有最新一次交付、它的快照存好了、而且工单停在待验收或已完成时能确认：
 * - 返工中（执行中、受阻）上一次交付已经过去，新的还没来。
 * - 最新一次交付还没有快照（04 在后台存，或者存不成）：不对着旧的交付确认。
 */
export function confirmableDelivery(db: Db, item: Item): { delivery: CriteriaDeliveryRef; reason: null } | { delivery: null; reason: string } {
  if (item.kind !== "task") return { delivery: null, reason: "提醒没有验收标准。" };
  if (listAcceptanceCriteria(db, item.id).length === 0) return { delivery: null, reason: "这张工单没有结构化的验收标准。" };
  if (item.stage === "cancelled") return { delivery: null, reason: "工单已经取消，不能再确认。" };
  const state = deliveryState(db, item.id);
  if (item.stage !== "review" && item.stage !== "done") {
    return state.snapshot || state.pending
      ? { delivery: null, reason: `工单现在是「${STAGE_WORDS[item.stage] ?? item.stage}」，等交付以后再确认。` }
      : { delivery: null, reason: "还没有交付，没有可以确认的。" };
  }
  if (state.pending) return { delivery: null, reason: state.pending.reason };
  if (!state.snapshot) return { delivery: null, reason: "还没有交付，没有可以确认的。" };
  return { delivery: deliveryRef(db, item.id, state.snapshot, true), reason: null };
}

// 你在这次交付上对这一条的确认：确认着的那一个；没有时，最近一个因为这一条被改了（看历史交付时也包括被删了）而作废的。
function confirmationFor(rows: CriterionConfirmation[], criterionId: number, history: boolean): WireCriterion["confirmation"] {
  const own = rows.filter((row) => row.criterionId === criterionId);
  const active = own.find((row) => row.endedAt === null);
  const last = own.at(-1);
  const voided = last?.endReason === "criterion_edited" || (history && last?.endReason === "criterion_deleted");
  const shown = active ?? (voided ? last : undefined);
  if (!shown) return null;
  return {
    state: shown.endedAt === null ? "confirmed" : "voided",
    by: shown.confirmedBy,
    onBehalfOf: shown.onBehalfOf,
    confirmedAt: shown.confirmedAt,
    voidedAt: shown.endedAt,
  };
}

// 执行者看到的版本（审查 M2）。v54 以前的 Run 没有记录，退回按交付时间比较。
function changedSince(
  criterion: AcceptanceCriterion, seen: Map<number, number> | null, deliveredAt: string,
): WireCriterion["changedAfterDelivery"] {
  if (seen) {
    const revision = seen.get(criterion.id);
    if (revision === undefined) return "added";
    return revision < criterion.revision ? "edited" : null;
  }
  if (criterion.createdAt > deliveredAt) return "added";
  if (criterion.editedAt !== null && criterion.editedAt > deliveredAt) return "edited";
  return null;
}

const seenMap = (view: ExecutorCriteriaView | undefined) =>
  view ? new Map(view.criteria.map((entry) => [entry.id, entry.revision])) : null;

// 最新一次交付（或者还没有交付）：现在的标准。
function currentCriteria(db: Db, itemId: number, delivery: CriteriaDeliveryRef | null): WireCriterion[] {
  const seen = delivery ? seenMap(getExecutorCriteriaView(db, delivery.executorRunId)) : null;
  const confirmations = delivery ? listCriterionConfirmations(db, { itemId, executorRunId: delivery.executorRunId }) : [];
  const verdicts = delivery ? criterionVerdictsForDelivery(db, itemId, delivery.executorRunId) : new Map();
  return listAcceptanceCriteria(db, itemId).map((criterion, index) => ({
    id: criterion.id,
    number: index + 1,
    text: criterion.text,
    revision: criterion.revision,
    writtenBy: criterion.createdBy,
    writtenAt: criterion.createdAt,
    editedBy: criterion.editedBy,
    editedAt: criterion.editedAt,
    changedAfterDelivery: delivery ? changedSince(criterion, seen, delivery.deliveredAt) : null,
    deleted: false,
    confirmation: delivery ? confirmationFor(confirmations, criterion.id, false) : null,
    verdict: verdicts.get(criterion.id) ?? null,
  }));
}

/**
 * 历史交付（审查 M4）：那次交付时的标准，文字是那次的那一版；后来删掉的也列出来（deleted），确认和条数和当时一样。
 * 「那次交付时的标准」：执行者看到的那些，加上交付时还在的，加上在那次交付上被确认过的（执行中加的标准也可能被确认）。
 * 那一版：执行者看到的版本；没有记录时取交付时有效的那一版；再没有时取确认时的那一版。
 */
function historicalCriteria(db: Db, itemId: number, delivery: CriteriaDeliveryRef): WireCriterion[] {
  const seen = seenMap(getExecutorCriteriaView(db, delivery.executorRunId));
  const confirmations = listCriterionConfirmations(db, { itemId, executorRunId: delivery.executorRunId });
  const verdicts = criterionVerdictsForDelivery(db, itemId, delivery.executorRunId);
  const at = delivery.deliveredAt;
  const all = listAcceptanceCriteria(db, itemId, { includeDeleted: true })
    .sort((a, b) => a.position - b.position || a.id - b.id);
  const shown: WireCriterion[] = [];
  for (const criterion of all) {
    const revisions = listCriterionRevisions(db, criterion.id);
    const atDelivery = criterion.createdAt <= at && (criterion.deletedAt === null || criterion.deletedAt > at)
      ? revisions.filter((row) => row.writtenAt <= at).at(-1)?.revision
      : undefined;
    const confirmedRevision = confirmations.filter((row) => row.criterionId === criterion.id).at(-1)?.criterionRevision;
    const revision = seen?.get(criterion.id) ?? atDelivery ?? confirmedRevision;
    if (revision === undefined) continue;
    const version = revisions.find((row) => row.revision === revision);
    shown.push({
      id: criterion.id,
      number: shown.length + 1,
      text: version?.text ?? criterion.text,
      revision,
      writtenBy: criterion.createdBy,
      writtenAt: criterion.createdAt,
      editedBy: version && revision > 1 ? (version.writtenBy === "user" || version.writtenBy === "lead" ? version.writtenBy : null) : null,
      editedAt: version && revision > 1 ? version.writtenAt : null,
      changedAfterDelivery: seen && !seen.has(criterion.id) ? "added" : criterion.revision > revision ? "edited" : null,
      deleted: criterion.deletedAt !== null,
      confirmation: confirmationFor(confirmations, criterion.id, true),
      verdict: verdicts.get(criterion.id) ?? null,
    });
  }
  return shown;
}

// 现在这次交付的快照（见文件开头）。没有时为 null。
function liveSnapshot(db: Db, itemId: number, state: ReturnType<typeof deliveryState>): DeliverySnapshot | null {
  const stage = (db.prepare("SELECT stage FROM items WHERE id=?").get(itemId) as { stage: string } | undefined)?.stage;
  return !state.pending && state.snapshot && (stage === "review" || stage === "done") ? state.snapshot : null;
}

/**
 * 页面读的验收标准和确认情况。delivery 是第几次交付（交付切换）。不给时：现在的标准，对照现在这次交付；没有现在这次交付时
 * （还没交付、返工中、最新一次交付的快照还没存好）delivery 是 null，后一种情况 deliveryPending 写明原因。
 * 给了而且不是现在这次交付时，是那次交付的历史样子（latest=false）。那次交付不存在时返回 null。
 */
export function ticketAcceptanceCriteria(db: Db, itemId: number, options: { delivery?: number } = {}): TicketAcceptanceCriteria | null {
  const state = deliveryState(db, itemId);
  const live = liveSnapshot(db, itemId, state);
  let delivery: CriteriaDeliveryRef | null = null;
  if (options.delivery !== undefined) {
    const chosen = getDeliverySnapshotBySequence(db, itemId, options.delivery);
    if (!chosen) return null;
    delivery = deliveryRef(db, itemId, chosen, chosen.sequence === live?.sequence);
  } else if (live) {
    delivery = deliveryRef(db, itemId, live, true);
  }
  const criteria = delivery && !delivery.latest ? historicalCriteria(db, itemId, delivery) : currentCriteria(db, itemId, delivery);
  return {
    ticketId: itemId,
    criteria,
    delivery: delivery
      ? { sequence: delivery.sequence, attemptId: delivery.executorRunId, deliveredAt: delivery.deliveredAt, latest: delivery.latest }
      : null,
    deliveryPending: state.pending,
    confirmed: criteria.filter((criterion) => criterion.confirmation?.state === "confirmed").length,
  };
}

// 状态写在标准的文字前面，文字加引号（JSON 字符串）：标准是 Lead、用户或执行 agent 写的，写在后面的状态能被文字伪造（审查 L3）。
function statusWords(criterion: WireCriterion): string | null {
  const { confirmation } = criterion;
  if (confirmation?.state === "confirmed") return confirmation.by === "lead" ? "你代用户确认了" : "用户确认了";
  if (confirmation?.state === "voided") return "后来改过：用户的确认已作废";
  if (criterion.changedAfterDelivery === "edited") return "执行者没按这一版做：后来改过";
  if (criterion.changedAfterDelivery === "added") return "执行者没看到这一条：后来加的";
  return null;
}

/**
 * Lead 的 get_ticket 里的「验收标准」一段：和页面同一份（不给 delivery 的那一份）：现在的标准，对照现在这次交付。
 * 每条带 id 和版本（改的时候带上版本）。
 */
export function acceptanceCriteriaText(db: Db, itemId: number): string {
  const view = ticketAcceptanceCriteria(db, itemId);
  if (!view || view.criteria.length === 0) return NO_ACCEPTANCE_CRITERIA_TEXT;
  const previous = deliveryState(db, itemId).snapshot;
  const head = view.deliveryPending
    ? `最新一次交付（Run #${view.deliveryPending.attemptId}）还不能对照：${view.deliveryPending.reason}`
    : view.delivery
      ? `对照第 ${view.delivery.sequence} 次交付（Run #${view.delivery.attemptId}，交付于 ${view.delivery.deliveredAt}）：`
        + `用户确认了 ${view.confirmed}/${view.criteria.length}。确认只是用户的记录，不是验收或合并的条件。`
      : previous
        ? `现在没有可以对照的交付（返工中）。第 ${previous.sequence} 次交付上的确认是历史，不随下面的改动变。`
        : "还没有交付。";
  const lines = view.criteria.map((criterion) => {
    const status = statusWords(criterion);
    return `${criterion.number}. ${status ? `[${status}]` : ""}（id ${criterion.id}，第 ${criterion.revision} 版）${JSON.stringify(criterion.text)}`;
  });
  const text = [head, ...lines].join("\n");
  const capped = redactAndCap(text, CRITERIA_TEXT_MAX);
  return capped.truncated ? `${capped.text}…（截断，原文 ${text.length} 字）` : capped.text;
}

/**
 * 执行者启动时（新会话、续接、换 runtime 都一样）提示里的验收标准，逐条编号。在启动的那一刻读：
 * Lead 或用户在两次 Run 之间改了标准，返工的 Run 看到的是改过的。工单没有结构化的验收标准时是空字符串。
 * 给了 runId 时，同时记下这个执行者看到的每一条和版本（审查 M2），没有标准时也记（空的），这样之后加的能认出来。
 */
export function acceptanceCriteriaPromptSection(db: Db, itemId: number, options: { runId?: number } = {}): string {
  const criteria = listAcceptanceCriteria(db, itemId);
  if (options.runId !== undefined) {
    recordExecutorCriteriaView(db, {
      itemId, runId: options.runId, criteria: criteria.map((criterion) => ({ id: criterion.id, revision: criterion.revision })),
    });
  }
  if (criteria.length === 0) return "";
  return [
    "## 验收标准（系统记录，逐条编号）",
    "交付要逐条做到这些标准，核查员会逐条对照它们。标准由 Lead 或用户写，你不能自己改，也不能跳过。"
      + "认为某一条有问题（做不到、互相矛盾、说得不清楚、和任务说明冲突）时，用 request_decision 提出："
      + "audience 用 lead_or_user，写明第几条和它的 id、问题在哪里、你的建议。",
    ...criteria.map((criterion, index) => `${index + 1}. （id ${criterion.id}）${JSON.stringify(criterion.text)}`),
  ].join("\n");
}

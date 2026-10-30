// 换核查员（2026-10-20）：工单操作层的 change_reviewer（engine 的 ticket-actions/）调它，页面（POST /v1/tickets/:id/actions/change_reviewer，
// 旧的 /request-review 带 runtime）和 Lead（ticket_action）共用。
//
// 以前核查请求点名的 runtime 不能用时，请求挂起等着：Lead 没有能改派核查的工具，用户派核查也不能选 runtime，
// 挂起的核查还让「派发独立核查」变灰（用户：「lead 也换不了，我也换不了，这不是给用户添堵吗？」）。现在：
//   - 有排队或挂起的核查请求：改它的 runtime，清掉挂起，记一条活动。
//   - 没有核查请求、最新的交付还没核查：用这个 runtime 新排一条。
//   - 核查正在跑：拒绝，说清楚要等它结束或先停掉。
//   - 点名的 runtime 被停用、或者有没关闭的故障：拒绝，说清楚原因（派发时它也会被自动换掉）。
//   - 换成功时，同时写进工单的核查员设置（store 的 reviewer-settings.ts，工单 09）：返工以后的下一次核查还用它。
//     换了 runtime 时，原来为别的 runtime 选的模型和推理强度清空。
//   - 还没有可换的核查（工单还在执行，2026-10-29）：工单操作 change_reviewer 只记下设置，下一次核查用它（whenNothingToReview）。
//     以前这时拒绝，用户在执行中说要换核查员，Lead 只好设了 4 个跟进来记这件事。
// GET /v1/tickets/:id/reviewer 读 reviewerInfo：现在的核查员、谁选的、是不是和执行者同一种 agent、所有候选能不能用、能不能换。
import type { Actor, RuntimeId } from "@pi-lead-child/core";
import type { Db, ReviewerChooser } from "@pi-lead-child/store";
import { addActivity, getItem, getReviewerSetting, leadDisplayName, setReviewerSetting } from "@pi-lead-child/store";
import { isRuntimeDisabled, isRuntimeId, runtimeDisabledReason, runtimeDisplayName, runtimeIds } from "@pi-lead-child/runtime";
import { createDispatcher } from "./dispatch.js";
import { reviewerProgress, staleReviewRequestReason, unreviewedDelivery } from "./review-authority.js";
import {
  executorRuntimeOf, itemReviewer, recordReviewerSwitch, reviewerOptions, reviewerUnavailableReason,
  type ReviewerChoiceOptions, type ReviewerOption,
} from "./reviewer-choice.js";
import { latestDeliveryRunId } from "../pipeline/delivery-run.js";

export type ReviewerChangeErrorCode =
  | "not_found" | "unknown_runtime" | "runtime_disabled" | "runtime_unavailable" | "review_running" | "no_delivery"
  | "no_reviewer";

// 换不了核查员的原因。网关按 code 映射 HTTP 状态（not_found → 404，unknown_runtime → 400，其余 409）。
export class ReviewerChangeError extends Error {
  constructor(readonly code: ReviewerChangeErrorCode, message: string) {
    super(message);
    this.name = "ReviewerChangeError";
  }
}

export interface ChangeReviewerResult {
  // 改的或新排的核查请求。只记下设置、没有动任何请求时（appliesTo=next_review）为 null。
  dispatchRequestId: number | null;
  // 这次核查针对的交付（最新的交付 Run）。工单还没有交付时为 null。
  deliveryRunId: number | null;
  // 原来的核查员。新排的请求没有原来的，为 null。
  from: RuntimeId | null;
  to: RuntimeId;
  // true：新排了一条核查请求；false：改了已有的请求，或者只记下了设置。
  created: boolean;
  // next_review：还没有可换的核查，只记下了核查员设置，下一次核查用它。改了或新排了请求时没有这一项。
  appliesTo?: "next_review";
  // 给人看的一句话：这次换核查员落在哪里。
  note?: string;
}

interface PendingReviewRow {
  id: number;
  item_id: number;
  runtime: RuntimeId | null;
  model: string | null;
  effort: string | null;
  idempotency_key: string | null;
  retry_of_run_id: number | null;
  suspended_reason: string | null;
}

// 工单上排着（含挂起）、还没过期的核查请求，最新的一条。过期的请求不会再被认领（dispatch.ts 下一次 claim 时作废它）。
function pendingReviewRequest(db: Db, itemId: number): PendingReviewRow | null {
  const rows = db.prepare(
    `SELECT id, item_id, runtime, model, effort, idempotency_key, retry_of_run_id, suspended_reason FROM dispatch_requests
     WHERE item_id=? AND role='reviewer' AND state='pending'
     ORDER BY id DESC`,
  ).all(itemId) as PendingReviewRow[];
  return rows.find((row) => staleReviewRequestReason(db, row) === null) ?? null;
}

export interface ChangeReviewerArgs extends ReviewerChoiceOptions {
  actor: Extract<Actor, "user" | "lead">;
  // 为什么换。写进活动；不给时按 actor 写一句默认的。
  reason?: string;
  // 还被一个 Run 占着的工单（宿主的 live 表）：交付的 child 还在收尾时不新排核查（review-authority.ts）。
  liveItemIds?: readonly number[];
  // 把这个核查员记成工单的核查员设置（缺省 true）。系统替人选的（挂起的核查重新排、没点名核查员）传 false：那不是谁的选择。
  remember?: boolean;
  // 没有排着的核查、也没有要核查的交付时怎么办。refuse（缺省）：拒绝（no_delivery）。remember：只记下设置，下一次核查用它。
  // 工单操作 change_reviewer 用 remember；「派发核查」（requestReview）要的是马上排一次核查，用缺省的 refuse。
  whenNothingToReview?: "refuse" | "remember";
}

export function changeReviewer(
  db: Db,
  itemId: number,
  runtime: string,
  args: ChangeReviewerArgs,
): ChangeReviewerResult {
  const item = getItem(db, itemId);
  if (!item) throw new ReviewerChangeError("not_found", `item #${itemId} not found`);
  if (!isRuntimeId(runtime)) {
    throw new ReviewerChangeError("unknown_runtime", `unknown runtime: ${String(runtime).slice(0, 40)} (${runtimeIds().join(" | ")})`);
  }
  const name = runtimeDisplayName(runtime);
  if (isRuntimeDisabled(runtime, args.env)) {
    throw new ReviewerChangeError("runtime_disabled", `${name} 不能当核查员：${runtimeDisabledReason(runtime)}`);
  }
  if (reviewerProgress(db, itemId)?.state === "running") {
    throw new ReviewerChangeError("review_running", `工单 #${itemId} 的核查正在进行，等它结束或先停掉，再换核查员。`);
  }
  const unavailable = reviewerUnavailableReason(db, runtime, args);
  if (unavailable) {
    throw new ReviewerChangeError(
      "runtime_unavailable",
      `${name} 现在不能当核查员：${unavailable}。请换一个能用的核查员。`,
    );
  }
  const reason = args.reason?.trim() || (args.actor === "user" ? "用户换了核查员" : `${leadDisplayName(db)} 换了核查员`);
  const deliveryRunId = latestDeliveryRunId(db, itemId);
  // 工单的核查员设置跟着换。同一个 runtime 时留着原来选的模型和推理强度。
  const remember = (): void => {
    if (args.remember === false) return;
    const previous = getReviewerSetting(db, itemId);
    const keep = previous?.runtime === runtime;
    setReviewerSetting(db, itemId, {
      runtime, model: keep ? previous.model : null, effort: keep ? previous.effort : null,
      chosenBy: args.actor, reason: args.reason?.trim() || null,
    });
  };
  return db.transaction((): ChangeReviewerResult => {
    const pending = pendingReviewRequest(db, itemId);
    if (pending) {
      const from = pending.runtime;
      const same = from === runtime;
      // 同一个 runtime 时留着请求上的模型和推理强度；那个模型不能用时（2026-10-22 审查 H1）清空，改用默认模型。
      const modelBroken = same && pending.model
        ? reviewerUnavailableReason(db, runtime, { ...args, model: pending.model })
        : null;
      const keep = same && modelBroken === null;
      db.prepare(
        `UPDATE dispatch_requests
         SET runtime=?, model=CASE WHEN ? THEN model ELSE NULL END, effort=CASE WHEN ? THEN effort ELSE NULL END,
             suspended_reason=NULL, suspended_incident_id=NULL, updated_at=datetime('now')
         WHERE id=? AND state='pending'`,
      ).run(runtime, keep ? 1 : 0, keep ? 1 : 0, pending.id);
      if (!same) {
        recordReviewerSwitch(db, {
          itemId, dispatchRequestId: pending.id, from: from ?? runtime, to: runtime, reason, actor: args.actor,
        });
      } else if (modelBroken !== null) {
        recordReviewerSwitch(db, {
          itemId, dispatchRequestId: pending.id, from: runtime, to: runtime, fromModel: pending.model, toModel: null,
          reason: modelBroken, actor: args.actor,
        });
      }
      remember();
      touchItem(db, itemId);
      return { dispatchRequestId: pending.id, deliveryRunId, from, to: runtime, created: false };
    }
    const gap = unreviewedDelivery(db, item, { liveItemIds: args.liveItemIds });
    if (!gap && args.whenNothingToReview === "remember" && args.remember !== false) {
      const previous = getReviewerSetting(db, itemId);
      remember();
      const setting = getReviewerSetting(db, itemId)!;
      addActivity(db, {
        itemId,
        actor: args.actor,
        kind: "decision",
        payload: {
          decision: "execution_profile_selected", role: "reviewer", runtime, model: setting.model, effort: setting.effort,
          source: "change_reviewer", appliesTo: "next_review", reason,
        },
      });
      touchItem(db, itemId);
      return {
        dispatchRequestId: null, deliveryRunId: null, from: previous?.runtime ?? null, to: runtime, created: false,
        appliesTo: "next_review",
        note: `工单 #${itemId} 现在没有排着的核查。核查员已经记成 ${name}，下一次核查用它。`,
      };
    }
    if (!gap) {
      throw new ReviewerChangeError(
        "no_delivery",
        `工单 #${itemId} 没有排着的核查，也没有要核查的交付（不在 review、已经有核查结论，或者还有 Run 在进行）。`,
      );
    }
    // 同一次交付允许再派：上一条请求失败或被取消后，缺口重新出现。用户的键和「派发独立核查」同一个格式
    // （review-authority.ts 的 userReviewDeliveryRunId 认它）。
    const prefix = `${args.actor === "user" ? "user-review" : "lead-review"}:${itemId}:delivery-run:${gap.deliveryRunId}:`;
    const prior = (db.prepare(
      "SELECT COUNT(*) AS n FROM dispatch_requests WHERE item_id=? AND idempotency_key LIKE ?",
    ).get(itemId, `${prefix}%`) as { n: number }).n;
    const dispatchRequestId = createDispatcher(db, args.profile ? { runtimeProfile: args.profile } : undefined).request({
      itemId, role: "reviewer", purpose: "review", runtime,
      trigger: args.actor === "user" ? "user-review" : "lead-review",
      idempotencyKey: `${prefix}${prior + 1}`,
    });
    addActivity(db, {
      itemId,
      actor: args.actor,
      kind: "decision",
      payload: {
        decision: args.actor === "user" ? "review_requested_by_user" : "review_requested_by_lead",
        dispatchRequestId, deliveryRunId: gap.deliveryRunId, runtime, reason,
      },
    });
    remember();
    touchItem(db, itemId);
    return { dispatchRequestId, deliveryRunId: gap.deliveryRunId, from: null, to: runtime, created: true };
  }).immediate();
}

// 现在有没有一个能用的核查员（没停用，profile 上没有故障）。挂起的核查只有这时才能重新排（control-plane 的 canRequestReview）。
export function anyReviewerUsable(db: Db, options: ReviewerChoiceOptions = {}): boolean {
  return reviewerOptions(db, options).some((option) => option.available);
}

// 挂起的核查重新排、用户没点名核查员时用哪个（2026-10-21 审查 M4）：
//   - 请求上的核查员（runtime 加请求上的模型）还能用（挂起的原因不是它的故障，或者故障已经关闭）：留着它，可能是用户或 Lead 选的。
//   - 只是请求上的模型不能用、这个 runtime 的默认模型能用：留着这个 runtime，模型换成默认模型（2026-10-22 审查 H1）。
//   - 不能用：工单的核查员（itemReviewer：选好的能用就用它，否则第一个能用的，避开执行者的 runtime，工单 09）。
//   - 一个能用的都没有：拒绝，写明每个为什么不能用。以前这时选到排序第一、有故障的那个，然后报「请换一个能用的核查员」，
//     可界面上没有选核查员的入口。
export function suspendedReviewRuntime(db: Db, itemId: number, options: ReviewerChoiceOptions = {}): RuntimeId {
  const pending = pendingReviewRequest(db, itemId);
  if (pending?.runtime && reviewerUnavailableReason(db, pending.runtime, {
    ...options, ...(pending.model ? { model: pending.model } : {}),
  }) === null) return pending.runtime;
  // 只是请求上的模型不能用：留着这个 runtime，changeReviewer 把模型换成默认模型（审查 H1）。
  if (pending?.runtime && pending.model && reviewerUnavailableReason(db, pending.runtime, options) === null) return pending.runtime;
  const all = reviewerOptions(db, options);
  // 有能用的时，itemReviewer 选到的就是能用的。
  if (all.some((option) => option.available)) return itemReviewer(db, itemId, options).runtime;
  const why = all.map((option) => `${option.displayName}：${option.reason ?? "可用"}`).join("；");
  throw new ReviewerChangeError(
    "no_reviewer",
    `没有能用的核查员（${why}）。在设置里启用一个执行器，或者等故障恢复以后，核查会自动开始。`,
  );
}

function touchItem(db: Db, itemId: number): void {
  db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(itemId);
}

export interface ReviewerInfo {
  // 排队、挂起或正在跑的核查用的核查员；没有时是下一次会用的核查员。工单不是任务（提醒）时为 null。
  //   - model、effort：这次核查的；还没定（派发时由 CLI 的配置决定）时为 null。
  //   - chosenBy：Lead 或用户选的（item_reviewer_settings），或者系统选的。
  //   - sameAsExecutor：和执行者是同一种 agent（D3：没有别的可用时允许，界面上写明）。
  reviewer: {
    runtime: RuntimeId; displayName: string; model: string | null; effort: string | null;
    chosenBy: ReviewerChooser | "system"; sameAsExecutor: boolean;
  } | null;
  // 所有登记的 runtime，按选核查员的顺序，标明能不能用、为什么。
  options: ReviewerOption[];
  // 现在能不能换核查员：工单在 review，核查没在跑，有排着的核查或者有要核查的交付。
  canChange: boolean;
  progress: "queued" | "suspended" | "running" | null;
}

interface InFlightReviewer {
  runtime: RuntimeId;
  model: string | null;
  effort: string | null;
}

// 正在跑的核查 Run 的核查员；没有时是排着（含挂起、已认领）的核查请求的核查员。
function inFlightReviewer(db: Db, itemId: number): InFlightReviewer | null {
  const run = db.prepare(
    `SELECT runtime, model, effort FROM runs
     WHERE item_id=? AND role='reviewer' AND purpose='review' AND state IN ('starting','running')
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as InFlightReviewer | undefined;
  if (run) return run;
  const claimed = db.prepare(
    `SELECT runtime, model, effort FROM dispatch_requests
     WHERE item_id=? AND role='reviewer' AND state IN ('claimed','started') AND runtime IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as InFlightReviewer | undefined;
  if (claimed) return claimed;
  const pending = pendingReviewRequest(db, itemId);
  return pending?.runtime ? { runtime: pending.runtime, model: pending.model, effort: pending.effort } : null;
}

export function reviewerInfo(
  db: Db,
  itemId: number,
  options: ReviewerChoiceOptions & { liveItemIds?: readonly number[] } = {},
): ReviewerInfo | null {
  const item = getItem(db, itemId);
  if (!item) return null;
  const progress = reviewerProgress(db, itemId)?.state ?? null;
  const all = reviewerOptions(db, options);
  if (item.kind !== "task") return { reviewer: null, options: all, canChange: false, progress };
  const inFlight = progress === null ? null : inFlightReviewer(db, itemId);
  const setting = inFlight ? getReviewerSetting(db, itemId) : null;
  const reviewer = inFlight
    ? {
        ...inFlight,
        chosenBy: setting?.runtime === inFlight.runtime ? setting.chosenBy : "system" as const,
        sameAsExecutor: inFlight.runtime === executorRuntimeOf(db, item),
      }
    : itemReviewer(db, itemId, options);
  const canChange = item.stage === "review" && progress !== "running"
    && (pendingReviewRequest(db, itemId) !== null || unreviewedDelivery(db, item, { liveItemIds: options.liveItemIds }) !== null);
  return {
    reviewer: {
      runtime: reviewer.runtime, displayName: runtimeDisplayName(reviewer.runtime), model: reviewer.model, effort: reviewer.effort,
      chosenBy: reviewer.chosenBy, sameAsExecutor: reviewer.sameAsExecutor,
    },
    options: all,
    canChange,
    progress,
  };
}

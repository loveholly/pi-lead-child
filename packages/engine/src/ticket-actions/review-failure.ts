// 核查没做成时的操作（工单详情与验收 spec 5.8 A、D11，工单 11）。核查没做成（runtime 不能用、崩溃、超时、没交结论）不是结论：
// 核查那一行写原因，给三个选择：换核查员（change_reviewer，catalog.ts）、重试、不等核查，自己验收。
//   - retry_review（lead_allowed）：用同一个核查员（runtime、模型、推理强度）再派一次。
//   - accept_without_review（delegated）：不等核查，直接验收。账本记「这次交付没有独立核查」。托管范围：你授权托管时预先勾选了
//     「核查做不成时由 Lead 凭证据验收」（D11），而且所有核查员都不能用；这时 Lead 凭它读过的证据验收，账本写明「没有独立核查，
//     Lead 代为验收」，只通知你一次。没勾时只有你能做（或者 Lead 在你这一轮里代你做）。
// 「没做成」不算返工次数：这里都不写返工的决定（review-authority.ts 的 reworkCycles 只数返工）。
import type { Item, Run } from "@pi-lead-child/core";
import { runtimeDisplayName } from "@pi-lead-child/runtime";
import {
  activeDelegationPolicy, addActivity, addNotification, delegationAuthorityLabel, getItem, isTerminalRunState, itemOwnerAction,
  leadDisplayName, transition, type Db,
} from "@pi-lead-child/store";
import { leadMayAcceptWithoutReview } from "../coordinator/delegated-review.js";
import { createDispatcher } from "../coordinator/dispatch.js";
import { reviewerProgress, verificationState } from "../coordinator/review-authority.js";
import { reviewerUnavailableReason } from "../coordinator/reviewer-choice.js";
import { ACCEPTED_WITHOUT_REVIEW } from "../coordinator/review-verdict.js";
import { latestDeliveryRunId } from "../pipeline/delivery-run.js";
import { behalfCursor, behalfFields } from "./attribution.js";
import { completeItem, stopItemRun } from "./lifecycle.js";
import { AVAILABLE, unavailable, type Availability, type TicketActionDefinition, type TicketActionEnv } from "./types.js";

const STAGE_WORDS: Record<string, string> = {
  draft: "草稿", ready: "待开始", active: "执行中", blocked: "受阻", review: "待验收", done: "已完成", cancelled: "已取消",
};

function reviewChoice(env: TicketActionEnv) {
  return env.host.runtimeProfile ? { profile: env.host.runtimeProfile } : {};
}

/**
 * 最新的交付上最近一次核查没做成：那个核查 Run 已经结束（失败、停了，或者结束时没交结论），没有结论。
 * 之后还没有别的核查 Run。没有时为 null。
 */
export function failedReviewAttempt(db: Db, itemId: number): Run | null {
  const delivery = latestDeliveryRunId(db, itemId);
  if (delivery === null) return null;
  const run = db.prepare(
    `SELECT * FROM runs WHERE item_id=? AND role='reviewer' AND purpose='review' AND id > ? ORDER BY id DESC LIMIT 1`,
  ).get(itemId, delivery) as Run | undefined;
  if (!run || !isTerminalRunState(run.state)) return null;
  if (db.prepare("SELECT 1 FROM review_verdicts WHERE run_id=?").get(run.id)) return null;
  return run;
}

function failureWords(run: Run): string {
  const detail = run.error_message ?? run.error_code;
  return `核查 Run #${run.id} 没做成（${run.state}${detail ? `：${detail.split(/\r?\n/)[0]!.slice(0, 200)}` : ""}）`;
}

// 现在为什么没有独立核查：挂起的原因、上一次没做成的核查。只是不想等时为 null。
function reviewProblem(db: Db, itemId: number): string | null {
  const progress = reviewerProgress(db, itemId);
  if (progress?.state === "suspended") return `核查挂起了：${progress.reason ?? "核查员现在不能用"}`;
  const failed = failedReviewAttempt(db, itemId);
  return failed ? failureWords(failed) : null;
}

function inReview(item: Item, what: string): Availability {
  if (item.kind !== "task") return unavailable("提醒没有核查。");
  return item.stage === "review"
    ? AVAILABLE
    : unavailable(`工单现在是「${STAGE_WORDS[item.stage] ?? item.stage}」，不在等验收，不能${what}。`);
}

export const REVIEW_FAILURE_ACTIONS = {
  retry_review: {
    id: "retry_review", label: "重试核查", area: "execution", scope: "tickets:create",
    permission: "lead_allowed", external: false, irreversible: false, ownerAction: null,
    hint: "最新交付的核查没做成（核查 Run 失败、停了、没交结论）时，用同一个核查员（runtime、模型、推理强度）再派一次。"
      + "不算返工次数。上次的核查员现在不能用时用 change_reviewer 换一个。",
    defaultReason: "用户点了「重试核查」",
    available(item, env) {
      const stage = inReview(item, "重试核查");
      if (!stage.available) return stage;
      const current = verificationState(env.db, item.id).current;
      if (current) return unavailable(`最新的交付已经有核查结论（${current.verdict.toUpperCase()}），不用重试。`);
      const progress = reviewerProgress(env.db, item.id);
      if (progress?.state === "suspended") {
        return unavailable(`核查挂起了：${progress.reason ?? "核查员现在不能用"}。换一个核查员，或者等它恢复以后自动派发。`);
      }
      if (progress) return unavailable("核查已经在路上，不用重试。");
      const failed = failedReviewAttempt(env.db, item.id);
      if (!failed) return unavailable("最新的交付没有没做成的核查。还没核查过时用「派发核查」。");
      const blocked = reviewerUnavailableReason(env.db, failed.runtime, {
        ...reviewChoice(env), ...(failed.model ? { model: failed.model } : {}),
      });
      if (blocked) {
        return unavailable(`上次的核查员 ${runtimeDisplayName(failed.runtime)} 现在不能用：${blocked}。请换一个核查员。`);
      }
      return AVAILABLE;
    },
    run: ({ db, item, by, reason }) => {
      const failed = failedReviewAttempt(db, item.id);
      if (!failed) throw new Error(`item #${item.id} has no failed review to retry`);
      const who = by.actor === "user" ? "user" : "lead";
      return db.transaction(() => {
        const dispatchRequestId = createDispatcher(db).request({
          itemId: item.id, role: "reviewer", purpose: "review", runtime: failed.runtime,
          ...(failed.model ? { model: failed.model } : {}), ...(failed.effort ? { effort: failed.effort } : {}),
          // 之后工单又跑了核查 Run，这个重试就作废（dispatch.ts）。
          retryOfRunId: failed.id,
          trigger: `${who}-review-retry`,
          idempotencyKey: `review-retry:${item.id}:run:${failed.id}`,
        });
        addActivity(db, {
          itemId: item.id, runId: failed.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
          payload: {
            decision: "review_retry_requested", dispatchRequestId, failedRunId: failed.id, failure: failureWords(failed),
            runtime: failed.runtime, model: failed.model, reason, ...behalfFields(by),
          },
        });
        return { dispatchRequestId, retryOfRunId: failed.id, runtime: failed.runtime, model: failed.model };
      }).immediate();
    },
  },

  accept_without_review: {
    id: "accept_without_review", label: "不等核查，直接验收", area: "delivery", scope: "tickets:create",
    permission: "delegated", external: false, irreversible: false, ownerAction: "ticket.complete",
    hint: "不等独立核查，直接验收最新的交付（review → done），账本记「这次交付没有独立核查」。最新的交付已经有核查结论时用 complete。"
      + "托管范围：用户授权托管时勾了「核查做不成时由 Lead 凭证据验收」，而且所有核查员都不能用；这时 reason 写你读过的证据"
      + "（交付快照、成果说明、你核对过的东西）。没勾时只有用户在这一轮明确要求时代他做。",
    defaultReason: "用户不等核查，直接验收",
    available(item, env) {
      const stage = inReview(item, "验收");
      if (!stage.available) return stage;
      const current = verificationState(env.db, item.id).current;
      if (current) return unavailable(`最新的交付已经有核查结论（${current.verdict.toUpperCase()}）：用「验收」。`);
      return AVAILABLE;
    },
    // 和核查挂起时的通知（delegated-review.ts 的 noteDelegatedReviewBlocked）是同一个判断。
    delegatedScope: (item, env) => leadMayAcceptWithoutReview(env.db, item, {
      ...(env.host.runtimeProfile ? { profile: env.host.runtimeProfile } : {}),
      ...(env.host.runtimeDisabledBy ? { runtimeDisabledBy: env.host.runtimeDisabledBy } : {}),
    }),
    run: async ({ db, item, by, authority, reason, reasonGiven }) => {
      const deliveryRunId = latestDeliveryRunId(db, item.id);
      const problem = reviewProblem(db, item.id);
      const policy = authority === "delegated" ? activeDelegationPolicy(db, item.id) : null;
      if (authority === "delegated" && !policy) throw new Error(`item #${item.id} has no active delegation policy`);
      // 还在跑的核查停掉：工单验收以后它的结论不会再被接受（dispatch.ts 的 submitReviewVerdict 要求工单在 review）。
      const open = db.prepare(
        "SELECT id FROM runs WHERE item_id=? AND role='reviewer' AND purpose='review' AND state IN ('starting','running','paused')",
      ).all(item.id) as Array<{ id: number }>;
      for (const run of open) await stopItemRun(db, run.id, "不等核查，直接验收", by);
      const lead = leadDisplayName(db);
      db.transaction(() => {
        addActivity(db, {
          itemId: item.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
          payload: {
            decision: ACCEPTED_WITHOUT_REVIEW,
            independentReview: false,
            deliveryRunId,
            authority,
            reason,
            reviewProblem: problem,
            ...(policy ? { delegationPolicyId: policy.id, policyVersion: policy.policy_version, authorityLabel: delegationAuthorityLabel(policy) } : {}),
            ...behalfFields(by),
          },
        });
        if (policy) {
          // 托管范围内是系统流程（和核查员 PASS 以后的托管验收一样，delegated-review.ts），stage 的边只给 system。
          transition(db, {
            itemId: item.id, to: "done", actor: "system",
            reason: `没有独立核查，${lead} 代为验收（${delegationAuthorityLabel(policy)}）：${reason}`,
          });
          addNotification(db, {
            itemId: item.id,
            kind: ACCEPTED_WITHOUT_REVIEW,
            urgency: "immediate",
            title: `工单 #${item.id} 没有独立核查，${lead} 代为验收`,
            body: [
              problem ?? "所有核查员都不能用。",
              `${lead} 的依据：${reason}`,
              "你授权托管时勾选了「核查做不成时由 Lead 凭证据验收」。不同意时可以打回返工。",
            ].join("\n"),
            dedupKey: `accepted-without-review:item:${item.id}:delivery-run:${deliveryRunId ?? "none"}`,
          });
        } else {
          completeItem(db, item.id, by,
            by.actor === "user" && !reasonGiven ? "用户不等核查，直接验收（没有独立核查）" : `${reason}（没有独立核查）`);
        }
      })();
      return { stage: getItem(db, item.id)!.stage, independentReview: false, stoppedReviewRuns: open.map((run) => run.id) };
    },
    ownerActionInput: ({ db, item }) => {
      const after = getItem(db, item.id);
      if (!after || after.stage === item.stage) return null;
      return itemOwnerAction(db, "complete", item, item.stage);
    },
  },
} satisfies {
  retry_review: TicketActionDefinition<"retry_review">;
  accept_without_review: TicketActionDefinition<"accept_without_review">;
};

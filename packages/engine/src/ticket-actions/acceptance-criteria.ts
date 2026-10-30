// 验收标准的三个工单操作（spec 4.3、5.1、5.11、D5、D6，工单 05）。定义在这一块里，catalog.ts 把它们并进清单。
//   - edit_acceptance_criteria：Lead 和你都能改（lead_allowed）。交付以后改了或删了某一条，你对它的确认作废。
//     执行 agent 没有这个入口：它有异议时用 request_decision 提出（D6）。
//   - confirm_criterion、unconfirm_criterion：只属于你（user_only）。Lead 只能凭你这一轮代你做，账本写 actor=lead、
//     onBehalfOf=user 和那一轮。确认按交付存，只对着最新一次交付做；确认不是验收或合并的条件（D5）。
// 规则和存储在 store 的 acceptance-criteria.ts，「对着哪一次交付」在 coordinator/acceptance-criteria.ts 的 confirmableDelivery。
import type { Item } from "@pi-lead-child/core";
import {
  AcceptanceCriteriaError, addActivity, confirmCriterion, editAcceptanceCriteria, getAcceptanceCriterion,
  listCriterionConfirmations, unconfirmCriterion, type Db,
} from "@pi-lead-child/store";
import { confirmableDelivery, type CriteriaDeliveryRef } from "../coordinator/acceptance-criteria.js";
import { behalfCursor, behalfFields } from "./attribution.js";
import {
  AVAILABLE, TicketActionError, unavailable,
  type Availability, type TicketActionDefinition,
} from "./types.js";

const STAGE_WORDS: Record<string, string> = {
  draft: "草稿", ready: "待开始", active: "执行中", blocked: "受阻", review: "待验收", done: "已完成", cancelled: "已取消",
};

// store 的拒绝换成操作层的拒绝：输入不对是 400，标准不在这张工单上是 404，页面过时了（别人改过、删了）是 409 stale。
function storeCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AcceptanceCriteriaError) throw new TicketActionError(error.code, error.message);
    throw error;
  }
}

// 确认和取消确认：对着最新一次交付。页面带上它看的那次交付（deliverySequence）时，要正好是最新一次。
// 页面过时了是 stale（审查 L6），和「快照还没存好」（unavailable）分得开。
function currentDelivery(db: Db, item: Item, deliverySequence: number | undefined): CriteriaDeliveryRef {
  const current = confirmableDelivery(db, item);
  if (!current.delivery) throw new TicketActionError("unavailable", current.reason);
  if (deliverySequence !== undefined && deliverySequence !== current.delivery.sequence) {
    throw new TicketActionError(
      "stale",
      `你看的是第 ${deliverySequence} 次交付，最新的是第 ${current.delivery.sequence} 次交付。刷新以后再确认。`,
    );
  }
  return current.delivery;
}

function hasActiveConfirmation(db: Db, itemId: number, delivery: CriteriaDeliveryRef): boolean {
  return listCriterionConfirmations(db, { itemId, executorRunId: delivery.executorRunId }).some((row) => row.endedAt === null);
}

type AcceptanceCriteriaActionId = "edit_acceptance_criteria" | "confirm_criterion" | "unconfirm_criterion";

export const ACCEPTANCE_CRITERIA_ACTIONS: { readonly [K in AcceptanceCriteriaActionId]: TicketActionDefinition<K> } = {
  edit_acceptance_criteria: {
    id: "edit_acceptance_criteria", label: "编辑验收标准", area: "ticket", scope: "tickets:create",
    permission: "lead_allowed", external: false, irreversible: false, ownerAction: null,
    hint: "改验收标准（D6：Lead 和用户能改，执行 agent 不能）。add 加在最后；update 改某一条的文字，"
      + "remove 删掉，两者都按 id，并带上 get_ticket「验收标准」里那一条的版本（revision），版本对不上（别人刚改过）时被拒；"
      + "order 是留下的各条的新顺序。每条一句、一行。工单待验收或已完成时改了或删了某一条，用户在这次交付上对它的确认作废；"
      + "返工中改的不动上一次交付上的确认。"
      + "改了标准不会自动重新核查，需要时用 request_review。执行 agent 用 request_decision 对标准提出异议时，和用户商量定了再改。",
    defaultReason: "acceptance criteria edited by user",
    available(item): Availability {
      if (item.kind !== "task") return unavailable("提醒没有验收标准。");
      if (item.stage === "done" || item.stage === "cancelled") {
        return unavailable(`工单现在是「${STAGE_WORDS[item.stage]}」，不能再改验收标准。`);
      }
      return AVAILABLE;
    },
    run: ({ db, env, item, input, by, reason }) => storeCall(() => db.transaction(() => {
      const edit = editAcceptanceCriteria(db, {
        itemId: item.id, by: by.actor, now: env.now,
        ...(input.add ? { add: input.add } : {}),
        ...(input.update ? { update: input.update } : {}),
        ...(input.remove ? { remove: input.remove } : {}),
        ...(input.order ? { order: input.order } : {}),
      });
      if (edit.changed) {
        addActivity(db, {
          itemId: item.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
          payload: {
            decision: "acceptance_criteria_edited",
            added: edit.added.map((id) => ({ id, text: getAcceptanceCriterion(db, id)!.text })),
            edited: edit.edited,
            removed: edit.removed,
            reordered: edit.reordered,
            voidedConfirmations: edit.voided.length,
            reason,
            ...behalfFields(by),
          },
        });
      }
      return {
        changed: edit.changed,
        added: edit.added,
        edited: edit.edited.map((entry) => entry.id),
        removed: edit.removed.map((entry) => entry.id),
        reordered: edit.reordered,
        voidedConfirmations: edit.voided.length,
      };
    })()),
  },

  confirm_criterion: {
    id: "confirm_criterion", label: "确认一条验收标准", area: "delivery", scope: "tickets:create",
    permission: "user_only", external: false, irreversible: false, ownerAction: null,
    hint: "用户确认最新一次交付做到了某一条验收标准（criterionId 是 get_ticket「验收标准」里的 id）。确认按交付记，"
      + "第 2 次交付从头开始。确认只是用户的记录，不是验收或合并的条件。",
    defaultReason: "confirmed by user",
    available: (item, env) => {
      const current = confirmableDelivery(env.db, item);
      return current.delivery ? AVAILABLE : unavailable(current.reason);
    },
    run: ({ db, env, item, input, by, reason }) => {
      const delivery = currentDelivery(db, item, input.deliverySequence);
      return storeCall(() => db.transaction(() => {
        const { confirmation, changed } = confirmCriterion(db, {
          itemId: item.id, criterionId: input.criterionId, executorRunId: delivery.executorRunId,
          deliverySnapshotId: delivery.snapshotId, by: by.actor, now: env.now,
          onBehalfOf: by.actor === "lead" && by.onBehalfOf ? { sourceTurnId: by.onBehalfOf.sourceTurnId } : null,
        });
        if (changed) {
          addActivity(db, {
            itemId: item.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
            payload: {
              decision: "criterion_confirmed", criterionId: input.criterionId, criterionRevision: confirmation.criterionRevision,
              text: getAcceptanceCriterion(db, input.criterionId)!.text,
              deliverySequence: delivery.sequence, executorRunId: delivery.executorRunId, reason, ...behalfFields(by),
            },
          });
        }
        return { changed, criterionId: input.criterionId, deliverySequence: delivery.sequence, attemptId: delivery.executorRunId };
      })());
    },
  },

  unconfirm_criterion: {
    id: "unconfirm_criterion", label: "取消确认", area: "delivery", scope: "tickets:create",
    permission: "user_only", external: false, irreversible: false, ownerAction: null,
    hint: "取消用户在最新一次交付上对某一条验收标准的确认（criterionId）。",
    defaultReason: "unconfirmed by user",
    available: (item, env) => {
      const current = confirmableDelivery(env.db, item);
      if (!current.delivery) return unavailable(current.reason);
      return hasActiveConfirmation(env.db, item.id, current.delivery) ? AVAILABLE : unavailable("这次交付上没有确认过的验收标准。");
    },
    run: ({ db, env, item, input, by, reason }) => {
      const delivery = currentDelivery(db, item, input.deliverySequence);
      return storeCall(() => db.transaction(() => {
        const { changed } = unconfirmCriterion(db, {
          itemId: item.id, criterionId: input.criterionId, executorRunId: delivery.executorRunId, by: by.actor, now: env.now,
        });
        if (changed) {
          addActivity(db, {
            itemId: item.id, actor: by.actor, kind: "decision", ...behalfCursor(by),
            payload: {
              decision: "criterion_unconfirmed", criterionId: input.criterionId,
              deliverySequence: delivery.sequence, executorRunId: delivery.executorRunId, reason, ...behalfFields(by),
            },
          });
        }
        return { changed, criterionId: input.criterionId, deliverySequence: delivery.sequence, attemptId: delivery.executorRunId };
      })());
    },
  },
};

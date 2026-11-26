// Undo a token budget raise that Lead made on its own (ticket #562, ticket-actions/budget-raise.ts).
// The undo button on the "Lead 动态" card (POST /v1/actions/budget_raise/<activity id>/undo) and Lead's perform_action
// call this one definition.
//   - lead_allowed and no rule change: it only puts the budget back to the user's earlier value.
//   - Refused when it was already undone, or when the budget changed again after the raise.
import { getItem } from "@pi-lead-child/store";
import {
  getLeadBudgetRaise, leadBudgetRaiseUndoBlocker, undoLeadBudgetRaise, type LeadBudgetRaise, type LeadBudgetRaiseUndone,
} from "../ticket-actions/budget-raise.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

export const BUDGET_RAISE_TARGET: UiActionTargetKind<LeadBudgetRaise> = {
  type: "budget_raise",
  label: "Lead 自己调高的预算",
  idHint: "那次调高在工单账本里的编号（set_budget 结果里 undo.target.id，Lead 动态卡上撤销按钮的编号）",
  load: (env, id) => (/^[1-9]\d{0,15}$/u.test(id) ? getLeadBudgetRaise(env.db, Number(id)) : null),
  name: (raise) => `工单 #${raise.ticketId} 的预算调整（${raise.from} → ${raise.to}）`,
  describe: (raise) => ({
    ticketId: raise.ticketId, from: raise.from, to: raise.to, reason: raise.reason, at: raise.at, undone: raise.undoneBy !== null,
  }),
};

export const BUDGET_RAISE_ACTIONS = {
  undo: {
    target: "budget_raise", id: "undo", label: "撤销预算调整", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: "Lead 动态里这次调整的卡，或者工单详情的预算",
    hint: "撤销你自己调高的一次 token 预算：预算改回调高以前的值。撤销过的、之后预算又改过的做不了。",
    defaultReason: "撤销了 Lead 调高的预算",
    available: (raise, env) => {
      const blocked = leadBudgetRaiseUndoBlocker(env.db, raise);
      return blocked ? unavailable(blocked) : AVAILABLE;
    },
    run: (run): LeadBudgetRaiseUndone => undoLeadBudgetRaise(run.db, run.target, {
      actor: run.by.actor === "user" ? "user" : "lead", reason: run.reason, now: run.env.now,
    }),
    forLead: (run, result) => {
      const undone = result as LeadBudgetRaiseUndone;
      return {
        result: "undone", ticketId: undone.ticketId, tokenBudget: undone.tokenBudget,
        stage: getItem(run.db, undone.ticketId)?.stage ?? null,
        next: "Lead 动态里那张卡已经更新。预算不够时，派发请求会挂起，等用户调高预算。",
      };
    },
    detail: (_run, result) => {
      const undone = result as LeadBudgetRaiseUndone;
      return { ticketId: undone.ticketId, tokenBudget: undone.tokenBudget, activityId: undone.activityId };
    },
  },
} satisfies Record<string, UiActionDefinition<LeadBudgetRaise, any>>;

// 授权托管（工单详情与验收 spec 5.8、5.11、D11，工单 11）：把技术验收和返工托管给 Lead。
// - 权限是 user_direct（AGENTS.md「UI Actions」：托管是给 Lead 授权）：Lead 能调用，总是被拒，拒绝里写明你去哪里点。
// - 「现在能不能做」和真正授权用同一个预检（store 的 delegationPreflight）：
//   - 不要求独立核查的工单不能托管：托管验收靠核查员的结论，这类工单没有核查员（例如 #101、#18）。
//   - 现在派不出独立核查时，只有你预先勾选了「核查做不成时由 Lead 凭证据验收」（acceptWithoutReview），托管才生效。
// - 两个页面入口调同一个函数 grantItemDelegation：工单操作（POST /v1/tickets/:id/actions/delegate），和设置页、工单详情一直在用的
//   POST /v1/lead/delegation（它要原样返回预检，所以先调 delegationPreflightFor，再调 grantItemDelegation）。
// - 撤回托管还在 POST /v1/lead/delegation（UI 操作对齐的 P07 把它登记成 lead_allowed 的操作）。
import type { Item } from "@pi-lead-child/core";
import type { TicketActionInputs } from "@pi-lead-child/protocol";
import {
  delegationOwnerAction, delegationPreflight, grantDelegationPolicy, leadDisplayName, recordDelegationPreflight,
  type Db, type DelegationCreatedVia, type DelegationPolicy, type DelegationPreflight, type DelegationVia,
} from "@pi-lead-child/store";
import { reviewerAvailability } from "../pipeline/automatic-review.js";
import type { ActionAttribution } from "./attribution.js";
import { reworkItem } from "./lifecycle.js";
import { AVAILABLE, TicketActionError, unavailable, type TicketActionDefinition } from "./types.js";

export type DelegateInput = TicketActionInputs["delegate"];

// 授权没过预检。网关的 POST /v1/lead/delegation 按它原样返回预检（409，delegation_preflight_failed）。
export class DelegationBlockedError extends TicketActionError {
  constructor(readonly preflight: DelegationPreflight) {
    super("unavailable", preflight.blockers.join(" ") || "托管不能让无人值守的流程闭环。");
    this.name = "DelegationBlockedError";
  }
}

function policyInput(input: DelegateInput) {
  return {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.maxReworkCycles !== undefined ? { maxReworkCycles: input.maxReworkCycles } : {}),
    ...(input.budgetLimitTokens !== undefined ? { budgetLimitTokens: input.budgetLimitTokens } : {}),
    ...(input.budgetLimitUsd !== undefined ? { budgetLimitUsd: input.budgetLimitUsd } : {}),
    ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
    acceptWithoutReview: input.acceptWithoutReview === true,
  };
}

/** 这次授权的预检（不写库）。和自动核查选同一个核查员（automatic-review.ts 的 reviewerAvailability）。 */
export function delegationPreflightFor(
  db: Db, itemId: number, input: DelegateInput, options: { createdVia: DelegationCreatedVia; now?: Date },
): DelegationPreflight {
  return delegationPreflight(db, {
    itemId,
    createdVia: options.createdVia,
    ...policyInput(input),
    requireContinuation: input.requireContinuation === true,
    ...(input.requiredCapabilityId !== undefined ? { requiredCapabilityId: input.requiredCapabilityId } : {}),
    reviewer: reviewerAvailability(db),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface DelegationGrant {
  ticketId: number;
  granted: true;
  policy: DelegationPolicy;
  preflight: DelegationPreflight;
  reworkStarted: boolean;
}

/**
 * 授权托管。先过预检：没过时记下没过的预检，抛 DelegationBlockedError，不授权。startRework：工单在等验收时，
 * 授权的同时打回返工一次（这次返工属于这份授权，计入它的额度）。
 */
export function grantItemDelegation(
  db: Db, item: Item, input: DelegateInput,
  options: { by: ActionAttribution; createdVia: DelegationVia; channel: DelegationVia | "lead_tool"; now?: Date },
): DelegationGrant {
  if (input.startRework === true && item.stage !== "review") {
    throw new TicketActionError("unavailable", `工单 #${item.id} 不在等验收，不能同时打回返工。`);
  }
  const preflight = delegationPreflightFor(db, item.id, input, options);
  const actor = options.by.actor;
  if (!preflight.canAccept) {
    recordDelegationPreflight(db, { itemId: item.id, preflight, actor, channel: options.channel, accepted: false });
    throw new DelegationBlockedError(preflight);
  }
  const policy = grantDelegationPolicy(db, { itemId: item.id, createdVia: options.createdVia, ...policyInput(input) });
  recordDelegationPreflight(db, { itemId: item.id, preflight, policyId: policy.id, actor, channel: options.channel, accepted: true });
  let reworkStarted = false;
  if (input.startRework === true) {
    reworkItem(db, item.id, `用户授权 ${leadDisplayName(db)} 自动返工并启动本次修复`, options.by, { delegationPolicyId: policy.id });
    reworkStarted = true;
  }
  return { ticketId: item.id, granted: true, policy, preflight, reworkStarted };
}

export const DELEGATION_ACTIONS = {
  delegate: {
    id: "delegate", label: "授权托管", area: "ticket", scope: "tickets:create",
    permission: "user_direct", external: false, irreversible: false, ownerAction: "lead.delegation",
    where: "工单详情的「授权托管」",
    hint: "把技术验收和返工托管给你（用户授权）。你不能代用户做：请用户在工单详情里点「授权托管」。",
    defaultReason: "用户授权托管",
    // 「现在能不能做」看预检里和这次怎么填无关的那几项：工单是不是任务、要不要求独立核查。核查员现在能不能用不在这里判断：
    // 你可以勾选「核查做不成时由 Lead 凭证据验收」，那时照样能托管。
    available(item, env) {
      if (item.kind !== "task") return unavailable("提醒不能托管。");
      if (item.stage === "done" || item.stage === "cancelled") return unavailable("工单已经结束，不用托管。");
      const preflight = delegationPreflightFor(env.db, item.id, {}, { createdVia: "control-plane", now: env.now });
      const blockers = preflight.checks
        .filter((check) => check.state === "failed" && (check.id === "target_task" || check.id === "verification_authority"))
        .map((check) => check.evidence);
      return blockers.length ? unavailable(blockers.join(" ")) : AVAILABLE;
    },
    run: ({ db, item, input, by }) => grantItemDelegation(db, item, input, { by, createdVia: "control-plane", channel: "control-plane" }),
    ownerActionInput: ({ db, item }, result) => {
      const grant = result as DelegationGrant;
      return delegationOwnerAction(db, item.id, { granted: true, policyId: grant.policy.id, reworkStarted: grant.reworkStarted });
    },
  },
} satisfies { delegate: TicketActionDefinition<"delegate"> };

// Lead 凭什么做一个工单操作（spec 5.11「Lead 代你做的规则」）。规则和工单以外的操作是同一份（ui-actions/authority.ts 的
// leadAuthorityFor）：
//   1. 只属于你的操作（user_only）：你在这一轮明确要求了，Lead 才能代你做。凭的是当前已认证的配对用户轮次
//      （store 的 activePairedUserTurn，authorize_retry 和已经删掉的 authorize_start 用的同一条规则）。Lead 只把你的话理解成
//      工单编号和参数，轮次由网关在认证过的配对连接上建，Lead 改不了。账本写「Lead 代你做」。
//   2. 托管范围内的操作（delegated）：Lead 按托管授权自己做，规则不变。不在托管范围内时同 1。
//   3. 对外的（external）和不可逆的（irreversible）：每次都要你在这一轮明确要求，托管也不能代替。
//   4. Lead 自己能做的（lead_allowed）：照做，账本写 actor=lead。
//   5. 授予 Lead 权力或带密钥的操作（user_direct，例如授权托管）：Lead 永远不能代做，拒绝里写明你去哪里点。
// 用户 2026-10-28：「工单操作让 Lead 自己判断」。上面 1、2、3 不再要用户这一轮：Lead 在哪一轮都能做，账本写 actor=lead；
// 在用户本人这一轮里做的记成代用户做（和工单以外的操作一样，ui-actions/authority.ts 第 4 条）。留下两条：
//   - 读过外部内容的一轮里，原来要用户这一轮的操作 Lead 做不了：外部的话不能替用户确认、验收、合并、丢弃。
//     用户本人正在说话的那一轮例外。别的轮次被拦时，系统存下这一个操作，给用户一张确认卡（lead 的 tools.ts）。
//   - 仍然只认用户这一轮的：
//     - 改预算（set_budget）：用户定的 token 底线。
//     - 放宽子 agent 的权限（widen_grant）：给 agent 授权（Slack 来的子 agent 会请求「给我 approve 权限」），和委托授权
//       一样是用户的事。
//     - 在用户的 Mac 上打开交付的文件（open_delivery_file）：用默认程序打开一个 .command、.app 就是在沙箱外执行（审查 H1）。
//     - 确认、撤回一条验收标准（confirm_criterion、unconfirm_criterion）：它记的是用户自己看过，Lead 替他记就是假记录。
import type { Item } from "@pi-lead-child/core";
import type { TicketActionPermission } from "@pi-lead-child/protocol";
import { UserTurnScopeError, type Db } from "@pi-lead-child/store";
import {
  activeUserTurnBlocker, isLiveUserTurn, leadAuthorityFor, userTurnAttribution, userTurnRefusalText, type LeadAuthorityMode,
} from "../ui-actions/authority.js";
import type { ActionAttribution } from "./attribution.js";

// store 的 activePairedUserTurn 在这一轮的凭证被作废时的说法。
const REVOKED_CREDENTIAL = "came from a credential that is no longer active";

// 仍然只认用户本人这一轮的工单操作（见文件头）。
const USER_TURN_ONLY_TICKET_ACTIONS: ReadonlySet<string> = new Set([
  "set_budget", "widen_grant", "open_delivery_file", "confirm_criterion", "unconfirm_criterion",
]);
import {
  TicketActionError, permissionOf,
  type TicketActionAuthority, type TicketActionCaller, type TicketActionDefinition, type TicketActionEnv,
} from "./types.js";

export type { LeadAuthorityMode } from "../ui-actions/authority.js";

/** 这个工单操作是不是仍然只认用户本人这一轮（见文件头）。 */
export function isUserTurnOnlyTicketAction(id: string): boolean {
  return USER_TURN_ONLY_TICKET_ACTIONS.has(id);
}

/** Lead 做这个操作要凭什么：自己的权限、托管授权、你这一轮的明确要求，还是只有你本人能做。 */
export function leadAuthorityMode(
  definition: TicketActionDefinition<never> | TicketActionDefinition, item: Item, env: TicketActionEnv,
): { mode: LeadAuthorityMode; permission: TicketActionPermission; why: string | null; forUser: boolean } {
  const permission = permissionOf(definition, item);
  const delegatedInScope = permission === "delegated" && Boolean(definition.delegatedScope?.(item, env));
  const { mode, why, forUser } = leadAuthorityFor({
    permission, external: definition.external, irreversible: definition.irreversible, delegatedInScope,
    userTurnOnly: USER_TURN_ONLY_TICKET_ACTIONS.has(definition.id),
    ...(definition.delegatedWhy ? { delegatedWhy: definition.delegatedWhy } : {}),
  });
  return { mode, permission, why, forUser };
}

export interface ResolvedAuthority {
  by: ActionAttribution;
  authority: TicketActionAuthority;
}

export function resolveAuthority(
  db: Db,
  definition: TicketActionDefinition<never> | TicketActionDefinition,
  item: Item,
  caller: TicketActionCaller,
  env: TicketActionEnv,
): ResolvedAuthority {
  if (caller.kind === "user") return { by: { actor: "user" }, authority: "user" };
  const { mode, why, forUser } = leadAuthorityMode(definition, item, env);
  if (mode === "own" && forUser) {
    // 原来要用户这一轮的操作：读过外部内容的一轮里做不了（见文件头）。用户本人正在说话的那一轮例外：是用户自己要做
    // （2026-10-29：用户说「核查没问题就更新状态」，Lead 读过 GitHub 上自己的 PR，验收被拒；和改规则的例外同一条）。
    if (caller.externalTurn && !isLiveUserTurn(db, caller.turnId, definition.scope)) {
      throw new TicketActionError(
        "needs_user_turn",
        `${definition.label}（${definition.id}）：这一轮读过外部内容，外部的话不能替用户做这个决定。`
          + `告诉用户要做什么、为什么，请他在会话里说一声，或者在${definition.where ?? "工单详情"}里自己点。`,
      );
    }
    // 用户本人这一轮里做的记成代用户做；别的轮次是 Lead 自己判断的。
    // 例外：这一轮来自做不了这个操作的凭证（例如 child 用 plc 的 CLI 凭证开一轮说「合并」），或者凭证在这一轮里被作废了
    // （审查 H1）：照旧拒绝。child 不能借 Lead 替自己确认、验收、合并（d6f48e49）。
    const narrow = narrowCredentialTurn(db, caller.turnId, definition);
    if (narrow) {
      throw new TicketActionError(
        "needs_user_turn",
        `${definition.label}（${definition.id}）：${userTurnRefusalText(narrow, definition.where ?? "工单详情")}。`,
      );
    }
    try {
      return { by: { actor: "lead", onBehalfOf: userTurnAttribution(db, caller.turnId, definition.id, definition.scope) }, authority: "on_behalf" };
    } catch {
      return { by: { actor: "lead" }, authority: "lead" };
    }
  }
  if (mode === "own") return { by: { actor: "lead" }, authority: "lead" };
  if (mode === "delegated") return { by: { actor: "lead" }, authority: "delegated" };
  if (mode === "user_direct") {
    throw new TicketActionError(
      "user_direct",
      `${definition.label}（${definition.id}）：${why}。请用户${definition.where ? `在${definition.where}` : "在工单详情里"}自己点。`,
    );
  }
  let onBehalfOf;
  try {
    onBehalfOf = userTurnAttribution(db, caller.turnId, definition.id, definition.scope);
  } catch (error) {
    throw new TicketActionError(
      "needs_user_turn",
      `${definition.label}（${definition.id}）：${why}。${userTurnRefusalText(error, definition.where ?? "工单详情")}。`,
    );
  }
  return { by: { actor: "lead", onBehalfOf }, authority: "on_behalf" };
}

/**
 * 这一轮来自做不了这个操作的凭证（UserTurnScopeError），或者凭证在这一轮里被作废了（审查 H1）：返回那个错误。
 * 不是配对的轮次、轮次已经结束、没有轮次时为 null（那是 Lead 自己判断）。
 */
export function narrowCredentialTurn(
  db: Db, turnId: string | null, definition: TicketActionDefinition<never> | TicketActionDefinition,
): Error | null {
  if (!turnId) return null;
  try {
    userTurnAttribution(db, turnId, definition.id, definition.scope);
    return null;
  } catch (error) {
    if (error instanceof UserTurnScopeError) return error;
    return error instanceof Error && error.message.includes(REVOKED_CREDENTIAL) ? error : null;
  }
}

/** 现在这一轮能不能当作用户对这个操作的明确要求（给 list_ticket_actions 看）。 */
export function activeUserTurnReason(
  db: Db, turnId: string | null, definition: TicketActionDefinition<never> | TicketActionDefinition,
): string | null {
  return activeUserTurnBlocker(db, turnId, definition.scope);
}

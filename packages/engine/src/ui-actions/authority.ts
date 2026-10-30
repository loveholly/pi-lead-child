// Lead 凭什么做一个操作（工单和别的目标共用，仓库 AGENTS.md「UI Actions」）：
//   1. 授予 Lead 权力或带密钥的操作（user_direct）：Lead 永远不能代做。工具总是返回结构化的拒绝，写明用户去哪里点。
//   2. Lead 自己能做的（lead_allowed）：照做，账本写 actor=lead。
//   3. 托管范围内的操作（delegated）：Lead 按托管授权自己做。
//   4. 只属于用户的（user_only）、对外的（external）、不可逆的（irreversible）、托管范围外的：Lead 在哪一轮都能做
//      （用户 2026-10-27：「我在 UI 上能做的操作，lead agent 都能执行」，定时器、Slack 事件叫醒的一轮也一样）。
//      在用户本人当前这一轮里做时记成代用户做：凭的是当前已认证的配对用户轮次（store 的 activePairedUserTurn），
//      账本写 actor=lead、onBehalfOf=user，用户能点「不是我」。别的时候账本写 actor=lead，是 Lead 自己做的。
//   5. 标了 userTurnOnly 的操作：仍然只有用户在这一轮明确要求了，Lead 才能代他做（2026-10-28 起 child 的审批和问用户的决定
//      不再标它：用户「lead agent 能自己审批吗」）。轮次由网关在认证过的配对连接上建，
//      Lead 改不了。这一轮的凭证还要有这个操作的 scope：Lead 代做的权限不能大过这一轮的凭证（child 用 plc 的凭证开一轮，Lead 不能凭它代批）。
//      加 userTurnOnly 之前先问用户（用户 2026-10-27：「以后你加限制前务必告诉我」）。
//   6. 改规则的操作（changesRules：授权表、投递规则、连接配置、设置页的选项）：这一轮带着外部内容（外部消息叫醒的，或者
//      用工具读过外部内容的）时，Lead 不能做，返回结构化的拒绝和确认卡要的数据（external-content.ts，spec D10）。
//      用户 2026-10-27 同意加这一条；它是第 4 条放开轮次限制以后唯一的例外。用户本人正在说话的那一轮不受它限制
//      （isLiveUserTurn，用户 2026-10-27）；用户设的跟进到点的一轮（timer:<编号>）仍然受限制：那时用户不在场。
//      user_direct 排在它前面，照旧总是拒绝。不改规则、但外部的一轮里也不能替用户做的操作（定义里的 externalTurnFloor，
//      例如批准 child 的动作）走同一条路：调用方把它当成 changesRules 传进来。
import { bindingOriginLabel, type ActionPermission, type Scope } from "@pi-lead-child/protocol";
import { activePairedUserTurn, UserTurnScopeError, type Db } from "@pi-lead-child/store";
import type { ActionAttribution, OnBehalfOfUser } from "../ticket-actions/attribution.js";

export type LeadAuthorityMode = "own" | "delegated" | "user_turn" | "user_direct" | "external_turn";

export interface AuthorityFacts {
  permission: ActionPermission;
  external: boolean;
  irreversible: boolean;
  // 只对 delegated：这一次在托管范围内。
  delegatedInScope?: boolean;
  // 只对 delegated：不在范围内时给 Lead 看的原因。不给时说「工单没有托管给你」。
  delegatedWhy?: string;
  // 只属于用户、对外、不可逆、托管范围外的操作仍然只认用户这一轮（见文件头第 5 条）。
  userTurnOnly?: boolean;
  // 改规则的操作，和这一轮带不带外部内容（见文件头第 6 条）。
  changesRules?: boolean;
  turnHasExternalContent?: boolean;
}

/**
 * Lead 做这个操作要凭什么，和为什么（不是 own、delegated 时给 Lead 看的一句话）。
 * forUser：mode 是 own 时，在用户本人这一轮里做要记成代用户做（只属于用户、对外、不可逆、托管范围外的操作）。
 */
export function leadAuthorityFor(facts: AuthorityFacts): { mode: LeadAuthorityMode; why: string | null; forUser: boolean } {
  if (facts.permission === "user_direct") {
    return { mode: "user_direct", why: "这个操作授予你权力或者带着密钥，只有用户本人能做，你不能代他做", forUser: false };
  }
  if (facts.changesRules && facts.turnHasExternalContent) {
    return { mode: "external_turn", why: "这是改规则的操作，这一轮带着外部内容，外部的话不能改系统的规则", forUser: false };
  }
  if (!facts.external && !facts.irreversible) {
    if (facts.permission === "lead_allowed") return { mode: "own", why: null, forUser: false };
    if (facts.permission === "delegated" && facts.delegatedInScope) return { mode: "delegated", why: null, forUser: false };
  }
  if (!facts.userTurnOnly) return { mode: "own", why: null, forUser: true };
  return {
    mode: "user_turn",
    why: facts.external ? "这是对外的操作，每次都要用户在这一轮明确要求，托管也不能代替"
      : facts.irreversible ? "这是不可逆的操作，每次都要用户在这一轮明确要求，托管也不能代替"
      : facts.permission === "delegated"
        ? facts.delegatedWhy ?? "这张工单没有托管给你，或者这一次不在托管范围内，只有用户在这一轮明确要求时你才能代他做"
        : "这是只属于用户的操作，只有用户在这一轮明确要求时你才能代他做",
    forUser: true,
  };
}

// 用户设的跟进到点、只为它开的一轮（store 的 activePairedUserTurn 对 timer:<编号> 返回的 origin_kind）。
const TIMER_TURN_ORIGIN = "paired:timer";

/**
 * 这一轮是不是用户本人正在说话的那一轮（第 6 条的例外）：用户的实时消息建的、还在进行、凭证有效而且有这个 scope 的配对轮次
 * （Companion、plc）。用户设的跟进到点的一轮不算。
 */
export function isLiveUserTurn(db: Db, turnId: string | null, scope: Scope): boolean {
  try {
    return activePairedUserTurn(db, turnId, "rule_change", scope).origin_kind !== TIMER_TURN_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * 这一轮能不能当作用户对这个操作的明确要求（scope：这个操作的页面入口要的 scope）。
 * 能时返回「代谁、凭哪一轮」，不能时抛错，错误说明原因。
 */
export function userTurnAttribution(db: Db, turnId: string | null, label: string, scope: Scope): OnBehalfOfUser {
  return activeUserTurn(db, turnId, label, scope).onBehalfOf;
}

/** 同上，另外给出这一轮开始的时间（毫秒；读不出时为 NaN，比较时一律不算早于它）。 */
export function activeUserTurn(
  db: Db, turnId: string | null, label: string, scope: Scope,
): { onBehalfOf: OnBehalfOfUser; startedAt: number } {
  const turn = activePairedUserTurn(db, turnId, label, scope);
  return {
    onBehalfOf: { actor: "user", sourceTurnId: turn.id, bindingId: turn.origin_binding_id },
    startedAt: Date.parse(turn.created_at),
  };
}

/**
 * 库里时间的最晚时刻（毫秒）。ISO 时间精确到毫秒，原样读。SQLite 的 datetime('now')（例如 approvals.created_at，
 * 「2026-10-22 10:00:00」，UTC）只到秒：读成那一秒的最后一毫秒，所以和这一轮开始落在同一秒的，一律不算更早。
 */
export function latestInstantOf(stored: string): number {
  if (stored.includes("T")) return Date.parse(stored);
  return Date.parse(`${stored.replace(" ", "T")}Z`) + 999;
}

/**
 * Lead 在用户本人当前这一轮里做的（用户在这一轮让它做）：返回那一轮的编号。你本人做的、Lead 被事件叫醒的一轮、
 * 这一轮不是用户的或者凭证不够时为 null。Lead 自己能做的操作（lead_allowed）不要求这一轮；这里只用来判断这件事算谁定的：
 * 提醒的时间是谁定的、收件箱里的「Lead 停下了工单」是不是 Lead 自己判断的。
 */
export function leadUserTurnOf(
  db: Db, by: ActionAttribution, turnId: string | null, label: string, scope: Scope,
): string | null {
  if (by.actor !== "lead") return null;
  try {
    return activeUserTurn(db, turnId, label, scope).onBehalfOf.sourceTurnId;
  } catch {
    return null;
  }
}

/** 现在这一轮能不能当作用户对这个 scope 的操作的明确要求（给清单看）。能时为 null。 */
export function activeUserTurnBlocker(db: Db, turnId: string | null, scope: Scope): string | null {
  try {
    activePairedUserTurn(db, turnId, "action", scope);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 这一轮被拒时给 Lead 看的原因（不带句号）。这一轮的凭证不够（store 的 UserTurnScopeError）时，写明是哪种凭证、
 * 用户去哪里点：用户这一轮里说了也不行，只能他自己点。其余照原样，加上「没要求时请他去哪里点」。
 */
export function userTurnRefusalText(error: unknown, where: string): string {
  if (error instanceof UserTurnScopeError) {
    return `这一轮来自${bindingOriginLabel(error.origin)}，这种凭证没有 ${error.scope}`
      + `（child 在这台机器上也拿得到它），不能凭它代用户做。请用户在 ${where} 里自己点`;
  }
  return `${error instanceof Error ? error.message : String(error)}。用户没有在这一轮这样要求时，请他在 ${where} 里自己点`;
}

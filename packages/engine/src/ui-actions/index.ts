// 工单以外的 UI 操作层（仓库 AGENTS.md「UI Actions」，.scratch/ui-action-parity/plan.md P01）：UI 上每一个调用后端的操作，
// 只有一份实现，两个入口。
//   - 页面：原来的 HTTP 路由（/v1/runtimes/settings、/v1/admin/bindings/:id/revoke……）转调 runUiAction，以你本人的名义。
//   - Lead：list_actions 和 perform_action 两个通用工具（packages/lead 的 ui-action-tools.ts）。
// 两个入口都走 runUiAction：同样的输入校验、同样的「现在能不能做」（定义里的 available）、同样的授权规则（authority.ts，
// 和工单操作共用）、同样的实现（定义里的 run）、同样的账本（一条 ui_action.performed，和主人操作）。账本里只有 actor 不同。
// Lead 的一轮带着外部内容时，改规则的操作被拒绝（external-content.ts，spec D10）。拒绝时系统存下这一个操作，
// 用户在确认卡上点「确认这一次」以后，凭这张卡以 Lead 代用户的名义执行它（rule-change-confirmations.ts，工单 09）。
// 工单的操作在 ticket-actions/，形状一样。
import {
  UI_ACTION_INPUT_SCHEMAS, UI_ACTION_PERFORMED_KIND, UI_ACTION_TARGET_TYPES, isUiActionTargetType,
  type ActionPermission, type OwnerActionSource, type UiActionPerformedPayload, type UiActionTargetType,
} from "@pi-lead-child/protocol";
import {
  activePairedUserTurn, appendEvent, getBinding, leadDisplayName, recordOwnerAction, UserTurnScopeError, type Db,
} from "@pi-lead-child/store";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ActionAttribution } from "../ticket-actions/attribution.js";
import type { OwnerCredential } from "../ticket-actions/types.js";
import {
  activeUserTurn, activeUserTurnBlocker, isLiveUserTurn, leadAuthorityFor, userTurnRefusalText, type LeadAuthorityMode,
} from "./authority.js";
import { UI_ACTIONS, UI_ACTION_TARGETS } from "./catalog.js";
import { externalTurnWhy, ruleChangeRefusalText, type ExternalContentSource, type RuleChangeConfirm } from "./external-content.js";
import { confirmedOperationProblem, requestRuleChangeConfirmation, ruleChangeEntityKey } from "./rule-change-confirmations.js";
import {
  UiActionError, uiIrreversibleOf, uiPermissionOf, uiWhereOf,
  type UiActionAuthority, type UiActionCaller, type UiActionDefinition, type UiActionEnv, type UiActionRefusal, type UiActionRun,
  type UiActionServices,
} from "./types.js";

export * from "./authority.js";
export * from "./external-content.js";
export * from "./rule-change-confirmations.js";
export * from "./host-commands.js";
export * from "./timers.js";
export * from "./types.js";
export * from "./card-actions.js";
export * from "./widgets.js";
export { UI_ACTIONS, UI_ACTION_TARGETS, runtimeEnablePermission, type RuntimeTarget } from "./catalog.js";

export interface UiActionTarget {
  type: string;
  id: string | number;
}

export function uiActionDefinition(type: string, id: string): UiActionDefinition | null {
  if (!isUiActionTargetType(type)) return null;
  return Object.hasOwn(UI_ACTIONS[type], id) ? UI_ACTIONS[type][id]! : null;
}

function createEnv(db: Db, options: { services?: UiActionServices; now?: Date }): UiActionEnv {
  return { db, services: options.services ?? {}, now: options.now ?? new Date() };
}

function requireTarget(env: UiActionEnv, target: UiActionTarget): { type: UiActionTargetType; id: string; value: unknown } {
  const id = String(target.id).trim();
  if (!isUiActionTargetType(target.type)) {
    throw new UiActionError("not_found", `没有这种目标：${target.type}（可以是 ${UI_ACTION_TARGET_TYPES.join("、")}）`);
  }
  const kind = UI_ACTION_TARGETS[target.type];
  const value = kind.load(env, id);
  if (value === null || value === undefined) {
    throw new UiActionError("not_found", `${kind.label} ${id} 不存在（编号是 ${kind.idHint}）`);
  }
  return { type: target.type, id, value };
}

export interface UiActionView {
  target: { type: UiActionTargetType; id: string };
  id: string;
  label: string;
  permission: ActionPermission;
  external: boolean;
  irreversible: boolean;
  // 用户自己去哪里点。
  where: string;
  // 要就地确认时，确认条上的那一句；不用确认时为 null。
  confirm: string | null;
  available: boolean;
  // 不能做的原因，用户能看懂的一句话。能做时为 null。
  reason: string | null;
}

export interface UiActionListOptions {
  services?: UiActionServices;
  now?: Date;
}

/** 这个目标的每个操作现在能不能做、为什么。和执行前的检查是同一个函数。 */
export async function listUiActions(db: Db, target: UiActionTarget, options: UiActionListOptions = {}): Promise<UiActionView[]> {
  const env = createEnv(db, options);
  const resolved = requireTarget(env, target);
  const views: UiActionView[] = [];
  for (const definition of Object.values(UI_ACTIONS[resolved.type])) {
    const availability = await definition.available(resolved.value, env);
    views.push({
      target: { type: resolved.type, id: resolved.id },
      id: definition.id,
      label: definition.label,
      permission: uiPermissionOf(definition, resolved.value, env),
      external: definition.external,
      irreversible: uiIrreversibleOf(definition, resolved.value),
      where: uiWhereOf(definition, resolved.value),
      confirm: definition.confirm?.(resolved.value) ?? null,
      available: availability.available,
      reason: availability.reason,
    });
  }
  return views;
}

export interface LeadUiActionView extends UiActionView {
  // 改规则的操作：这一轮带着外部内容时 Lead 做不了（external-content.ts）。
  changesRules: boolean;
  // Lead 凭什么做：own、delegated、user_turn（要用户在这一轮明确要求）、user_direct（只有用户本人能做）、
  // external_turn（改规则的操作，这一轮带着外部内容，做不了）。
  lead: LeadAuthorityMode;
  // 现在能不能做（available 且 Lead 有凭据）。不能时 leadReason 写明原因和用户去哪里点。
  leadReady: boolean;
  leadReason: string | null;
}

/**
 * 这一轮来自一个做不了这个操作的凭证（例如 child 用 plc 的 CLI 凭证开一轮，说「批准 #1」）时，返回那个错误（store 的
 * UserTurnScopeError）。只对外部的一轮里也不能替用户做的操作（externalTurnFloor）这样拦：child 不能借 Lead 批准自己
 * （d6f48e49）。2026-10-28 起 Lead 在别的轮次里能自己批，这一条照旧。
 */
function narrowCredentialTurn(db: Db, definition: UiActionDefinition, target: unknown, turnId: string | null): UserTurnScopeError | null {
  if (!turnId || !externalTurnFloorOf(definition, target)) return null;
  try {
    activePairedUserTurn(db, turnId, "action", definition.scope);
    return null;
  } catch (error) {
    return error instanceof UserTurnScopeError ? error : null;
  }
}

// 外部的一轮里不能替用户做的操作，这次说的那句话（定义里的 externalTurnFloor）。没有时为 null。
function externalTurnFloorOf(definition: UiActionDefinition, target: unknown): string | null {
  const floor = definition.externalTurnFloor;
  return typeof floor === "function" ? floor(target) : floor ?? null;
}

// 这一轮带着的外部内容对这个操作算不算数（authority.ts 第 6 条）：不改规则、也没有外部底线的操作不看它；
// 用户本人正在说话的那一轮不受限制。写进提示词的设置（promptSetting）没有这个例外。
function ruleCeilingOf(
  db: Db, definition: UiActionDefinition, target: unknown, turnId: string | null,
  externalContent: readonly ExternalContentSource[] | null,
): readonly ExternalContentSource[] | null {
  if (externalContent === null || !(definition.changesRules || externalTurnFloorOf(definition, target))) return null;
  if (definition.promptSetting || definition.externalRefusalNext) return externalContent;
  return isLiveUserTurn(db, turnId, definition.scope) ? null : externalContent;
}

// externalContent：Lead 这一轮带着的、对这个操作算数的外部内容（ruleCeilingOf），没有时为 null。
function authorityFacts(
  definition: UiActionDefinition, target: unknown, env: UiActionEnv, externalContent: readonly ExternalContentSource[] | null,
) {
  const permission = uiPermissionOf(definition, target, env);
  return {
    permission,
    ...leadAuthorityFor({
      permission, external: definition.external, irreversible: uiIrreversibleOf(definition, target),
      delegatedInScope: permission === "delegated" && Boolean(definition.delegatedScope?.(target, env)),
      userTurnOnly: definition.userTurnOnly === true,
      changesRules: definition.changesRules || externalTurnFloorOf(definition, target) !== null,
      turnHasExternalContent: externalContent !== null,
    }),
  };
}

/** Lead 看到的清单（list_actions）：和页面同一份判断，另外写明 Lead 现在凭什么能做、或者为什么不能、用户去哪里点。 */
export async function listLeadUiActions(
  db: Db, target: UiActionTarget,
  options: UiActionListOptions & { turnId: string | null; externalContent?: readonly ExternalContentSource[] | null },
): Promise<{ target: Record<string, unknown> & { type: UiActionTargetType }; actions: LeadUiActionView[] }> {
  const env = createEnv(db, options);
  const resolved = requireTarget(env, target);
  const views = await listUiActions(db, target, options);
  const externalContent = options.externalContent ?? null;
  const actions = views.map((view) => {
    const definition = uiActionDefinition(resolved.type, view.id)!;
    const { mode, why } = authorityFacts(
      definition, resolved.value, env, ruleCeilingOf(db, definition, resolved.value, options.turnId, externalContent),
    );
    // 这一轮能不能凭：还要看这一轮的凭证有没有这个操作的 scope。
    const turnBlocker = mode === "user_turn" ? activeUserTurnBlocker(db, options.turnId, definition.scope) : null;
    const narrow = mode === "own" ? narrowCredentialTurn(db, definition, resolved.value, options.turnId) : null;
    const leadReady = view.available && mode !== "user_direct" && mode !== "external_turn"
      && (mode !== "user_turn" || turnBlocker === null) && narrow === null;
    return {
      ...view,
      changesRules: definition.changesRules,
      lead: mode,
      leadReady,
      leadReason: !view.available ? view.reason
        : mode === "user_direct" ? `${why}。请用户在 ${view.where} 里自己点。`
        : mode === "external_turn"
          ? externalRefusalText(definition, view.label, null, externalContent ?? [], view.where, externalTurnFloorOf(definition, resolved.value))
        : mode === "user_turn" && turnBlocker !== null ? `${why}（${turnBlocker}）。或者请用户在 ${view.where} 里自己点。`
        : narrow ? `${userTurnRefusalText(narrow, view.where)}。`
        : null,
    };
  });
  const kind = UI_ACTION_TARGETS[resolved.type];
  return { target: { type: resolved.type, ...kind.describe(resolved.value) }, actions };
}

export interface UiActionRequest {
  target: UiActionTarget;
  action: string;
  input?: unknown;
  // 为什么做。Lead 必须给；你不给时用这个操作的默认说法。
  reason?: string | null;
  caller: UiActionCaller;
  services?: UiActionServices;
  now?: Date;
  // 账本、主人操作记不上时写日志（操作已经做了，不能因此报错）。
  log?: (line: string) => void;
}

export interface UiActionOutcome {
  target: { type: UiActionTargetType; id: string };
  action: string;
  // run 的结果，给页面入口。
  result: unknown;
  // 给 Lead 的结果（定义里的 forLead）：不带不该进 Lead 上下文的东西。Lead 的工具只用它。
  forLead: unknown;
  by: ActionAttribution;
  authority: UiActionAuthority;
  // 这次记下的账本（ui_action.performed 的事件编号）。记不上时为 null。
  eventId: string | null;
  // 这次记下的主人操作（事件编号）。没有记时为 null。
  ownerActionEventId: string | null;
}

function inputError(schema: TSchema, input: unknown): string {
  const first = [...Value.Errors(schema, input)][0];
  return first ? `${first.instancePath || "input"}: ${first.message}` : "input 不对";
}

function resolveUiAuthority(
  db: Db, definition: UiActionDefinition, target: { type: UiActionTargetType; id: string; value: unknown },
  caller: UiActionCaller, env: UiActionEnv, request: { input: unknown; reason: string },
): { by: ActionAttribution; authority: UiActionAuthority; turnStartedAt?: number } {
  if (caller.kind === "user") return { by: { actor: "user" }, authority: "user" };
  if (caller.confirmation) return confirmedAuthority(db, definition, target, caller.confirmation, env, request.input);
  const externalContent = ruleCeilingOf(db, definition, target.value, caller.turnId, caller.externalContent ?? null);
  const { permission, mode, why, forUser } = authorityFacts(definition, target.value, env, externalContent);
  const name = UI_ACTION_TARGETS[target.type].name(target.value);
  const where = uiWhereOf(definition, target.value);
  const refusal = (code: "user_direct" | "needs_user_turn" | "external_turn", message: string, extra: Partial<UiActionRefusal> = {}) =>
    new UiActionError(code, message, {
      code, target: { type: target.type, id: target.id }, action: definition.id, label: definition.label, permission,
      where, message, ...extra,
    });
  if (mode === "own" && forUser) {
    const narrow = narrowCredentialTurn(db, definition, target.value, caller.turnId);
    if (narrow) throw refusal("needs_user_turn", `${definition.label}（${name}）：${userTurnRefusalText(narrow, where)}。`);
    return onBehalfOrOwn(db, definition, target, caller);
  }
  if (mode === "own") return { by: { actor: "lead" }, authority: "lead" };
  if (mode === "delegated") return { by: { actor: "lead" }, authority: "delegated" };
  if (mode === "user_direct") {
    throw refusal("user_direct", `${definition.label}（${name}）：${why}。请用户在 ${where} 里自己点。`);
  }
  // 改规则的操作，这一轮带着外部内容：拒绝。系统存下这一个操作（参数和这次的一样），拒绝里带着确认卡的 user_action。
  // 只拒绝的操作（externalRefusalNext）不存、不带卡，拒绝里写明 Lead 下一步怎么做。
  if (mode === "external_turn") {
    const sources = externalContent ?? [];
    if (definition.externalRefusalNext) {
      throw refusal("external_turn", externalRefusalText(
        definition, definition.label, name, sources, where, externalTurnFloorOf(definition, target.value),
      ));
    }
    const confirm: RuleChangeConfirm = {
      operation: { kind: "ui_action", target: { type: target.type, id: target.id }, action: definition.id, input: request.input },
      reason: request.reason, why: externalTurnWhy(sources), externalContent: sources,
    };
    const floor = externalTurnFloorOf(definition, target.value);
    throw refusal("external_turn", ruleChangeRefusalText(definition.label, name, sources, where, floor), {
      ...confirmCard(db, confirm, { label: definition.label, name, where, now: env.now }),
    });
  }
  let turn;
  try {
    turn = activeUserTurn(db, caller.turnId, `${target.type}.${definition.id}`, definition.scope);
  } catch (error) {
    throw refusal("needs_user_turn", `${definition.label}（${name}）：${why}。${userTurnRefusalText(error, where)}。`);
  }
  // 插进用户这一轮的事件（例如 child 刚要的审批）也在这一轮里：用户说话时还没见过它，不能算他要求的。
  if (definition.appearedAt && !(definition.appearedAt(target.value) < turn.startedAt)) {
    throw refusal(
      "needs_user_turn",
      `${definition.label}（${name}）：它是用户这一轮开始以后才出现的，用户说话时还没见过它，不能算他要求的。`
        + `先把它告诉用户，等他下一句话；或者请他在 ${where} 里自己点。`,
    );
  }
  return { by: { actor: "lead", onBehalfOf: turn.onBehalfOf }, authority: "on_behalf", turnStartedAt: turn.startedAt };
}

/**
 * 外部的一轮里被拒时给 Lead 的说明（带句号）。只拒绝的操作（externalRefusalNext）说为什么和下一步，不提确认卡；
 * 别的按改规则的缺省说（带确认卡）。
 */
function externalRefusalText(
  definition: UiActionDefinition, label: string, name: string | null, sources: readonly ExternalContentSource[], where: string,
  floor: string | null,
): string {
  if (!definition.externalRefusalNext) return ruleChangeRefusalText(label, name, sources, where, floor);
  const what = floor ?? (definition.promptSetting ? "它会写进你的系统提示词" : "这是改规则的操作");
  return `${label}${name ? `（${name}）` : ""}：${what}。${externalTurnWhy(sources)}，外部的话不能改它，所以这一轮不能做，`
    + `用户本人的这一轮也一样。${definition.externalRefusalNext}。`;
}

/**
 * 存下被拦的操作，给出拒绝里确认卡的部分。存不下时（例如库出错）照样拒绝，只是没有确认卡：拒绝不能因此变成别的错误。
 */
function confirmCard(
  db: Db, confirm: RuleChangeConfirm, meta: { label: string; name: string | null; where: string; now: Date },
): Pick<UiActionRefusal, "confirm" | "userAction"> {
  try {
    const card = requestRuleChangeConfirmation(db, { confirm, ...meta });
    return { confirm: { ...confirm, id: card.id }, userAction: card.userAction };
  } catch {
    return { confirm };
  }
}

/**
 * 用户在确认卡上点了「确认这一次」（rule-change-confirmations.ts）：凭这张卡以 Lead 代用户的名义执行，账本写 actor=lead、
 * onBehalfOf=user，凭的是 rule_change:<编号> 和点它的那台设备。只认卡上存下的操作和参数、同一台设备、已经确认还没执行的卡。
 * 它只放开外部内容这一道闸：user_direct 照旧拒绝，操作自己对 Lead 的限制（例如授权表只能收紧）也照旧。
 */
function confirmedAuthority(
  db: Db, definition: UiActionDefinition, target: { type: UiActionTargetType; id: string; value: unknown },
  confirmation: { id: string; bindingId: number }, env: UiActionEnv, input: unknown,
): { by: ActionAttribution; authority: UiActionAuthority } {
  if (uiPermissionOf(definition, target.value, env) === "user_direct") {
    throw new UiActionError("user_direct", `${definition.label}只有用户本人能做，确认卡不能代替。`);
  }
  const problem = confirmedOperationProblem(db, confirmation, {
    kind: "ui_action", target: { type: target.type, id: target.id }, action: definition.id, input,
  });
  if (problem) throw new UiActionError("forbidden", `${definition.label}：${problem}。`);
  return {
    by: { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: ruleChangeEntityKey(confirmation.id), bindingId: confirmation.bindingId } },
    authority: "on_behalf",
  };
}

/**
 * 只属于用户、对外、不可逆的操作，Lead 在哪一轮都能做（用户 2026-10-27）。用户本人当前这一轮要它做的（凭证有这个 scope、
 * 目标在这一轮开始以前就有）记成代用户做；别的（定时器、Slack 事件叫醒的一轮）记成 Lead 自己做的。
 */
function onBehalfOrOwn(
  db: Db, definition: UiActionDefinition, target: { type: UiActionTargetType; id: string; value: unknown }, caller: UiActionCaller,
): { by: ActionAttribution; authority: UiActionAuthority; turnStartedAt?: number } {
  const turnId = caller.kind === "lead" ? caller.turnId : null;
  let turn;
  try {
    turn = activeUserTurn(db, turnId, `${target.type}.${definition.id}`, definition.scope);
  } catch {
    return { by: { actor: "lead" }, authority: "lead" };
  }
  if (definition.appearedAt && !(definition.appearedAt(target.value) < turn.startedAt)) {
    return { by: { actor: "lead" }, authority: "lead" };
  }
  return { by: { actor: "lead", onBehalfOf: turn.onBehalfOf }, authority: "on_behalf", turnStartedAt: turn.startedAt };
}

function ownerCredential(db: Db, caller: UiActionCaller, by: ActionAttribution): {
  credential: OwnerCredential; source: OwnerActionSource;
} | null {
  if (caller.kind === "user") {
    return caller.credential && caller.source ? { credential: caller.credential, source: caller.source } : null;
  }
  // Lead 代你做：凭证是那一轮来自的配对凭证（「不是我」作废的就是它）。Lead 在这台机器上做，所以一律推送给你。
  if (by.actor !== "lead" || !by.onBehalfOf) return null;
  const binding = getBinding(db, by.onBehalfOf.bindingId);
  if (!binding) return null;
  return {
    credential: binding,
    source: { client: "lead", deviceName: binding.display_name, loopback: false, fromThisMachine: true },
  };
}

/** 执行一个工单以外的操作。两个入口都调它。 */
export async function runUiAction(db: Db, request: UiActionRequest): Promise<UiActionOutcome> {
  const env = createEnv(db, request);
  if (!isUiActionTargetType(request.target.type)) {
    throw new UiActionError("not_found", `没有这种目标：${request.target.type}（可以是 ${UI_ACTION_TARGET_TYPES.join("、")}）`);
  }
  const definition = uiActionDefinition(request.target.type, request.action);
  if (!definition) {
    throw new UiActionError("not_found", `${UI_ACTION_TARGETS[request.target.type].label}没有这个操作：${request.action}`);
  }
  const key = `${definition.target}.${definition.id}`;
  const input = request.input ?? {};
  const schema = (UI_ACTION_INPUT_SCHEMAS[definition.target] as Record<string, TSchema>)[definition.id]!;
  if (!Value.Check(schema, input)) throw new UiActionError("invalid_input", `${key} 的输入不对：${inputError(schema, input)}`);
  const given = typeof request.reason === "string" ? request.reason.trim() : "";
  if (request.caller.kind === "lead" && !given) {
    throw new UiActionError("invalid_input", `${key}：要写 reason（凭什么做，例如「用户说……」）`);
  }
  const target = requireTarget(env, request.target);
  // 先认人，再查状态、再动手（和工单操作同一条规则）。
  const { by, authority, turnStartedAt } = resolveUiAuthority(db, definition, target, request.caller, env, { input, reason: given });
  const availability = await definition.available(target.value, env);
  if (!availability.available) {
    throw new UiActionError("unavailable", availability.reason ?? `${definition.label}现在不能做。`);
  }
  // 不可逆的操作要就地确认：没带 confirm: true 时什么都不做，告诉调用方会发生什么、怎样确认（两个入口一样）。
  const confirmWords = definition.confirm?.(target.value) ?? null;
  if (confirmWords && (input as { confirm?: unknown }).confirm !== true) {
    throw new UiActionError(
      "needs_confirmation",
      `${confirmWords}确认要做时，在 input 里带 confirm: true（页面在按钮上就地确认；Lead 只在用户这一轮明确确认以后带）。`,
    );
  }
  const owner = ownerCredential(db, request.caller, by);
  const run: UiActionRun<unknown, unknown> = {
    db, env, target: target.value, targetId: target.id, input,
    reason: given || definition.defaultReason,
    reasonGiven: given.length > 0,
    by, authority,
    turnId: request.caller.kind === "lead" ? request.caller.turnId : null,
    turnStartedAt: turnStartedAt ?? null,
    bindingId: owner?.credential.id ?? null,
    timerOrigin: request.caller.kind === "lead" ? request.caller.timerOrigin ?? null : null,
    externalContent: request.caller.kind === "lead" ? request.caller.externalContent ?? null : null,
  };
  const result = await definition.run(run);
  // 只读的操作什么都没改：不记账本。
  if (definition.readOnly) {
    return {
      target: { type: target.type, id: target.id }, action: definition.id, result, forLead: definition.forLead(run, result),
      by, authority, eventId: null, ownerActionEventId: null,
    };
  }

  let eventId: string | null = null;
  try {
    const payload: UiActionPerformedPayload = {
      target: { type: target.type, id: target.id },
      action: definition.id,
      label: definition.label,
      actor: by.actor,
      authority,
      ...(by.actor === "lead" && by.onBehalfOf ? { onBehalfOf: "user" as const, sourceTurnId: by.onBehalfOf.sourceTurnId } : {}),
      reason: run.reason,
      bindingId: run.bindingId,
      detail: definition.detail?.(run, result) ?? {},
    };
    // 事件日志只在事务里写（store 的 appendEvent）。
    eventId = db.transaction(() => appendEvent(db, {
      source: by.actor,
      kind: UI_ACTION_PERFORMED_KIND,
      entityKey: `${target.type}:${target.id}`,
      level: "record",
      payload,
      ...(request.now ? { occurredAt: request.now.toISOString() } : {}),
    }).event.eventId)();
  } catch (error) {
    request.log?.(`[ui-action] failed to record ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let ownerActionEventId: string | null = null;
  if (owner && definition.ownerActionInput) {
    try {
      const input = definition.ownerActionInput(run, result);
      if (input) {
        ownerActionEventId = recordOwnerAction(db, {
          ...input,
          summary: by.actor === "lead" ? `${leadDisplayName(db)} 代你${input.summary}` : input.summary,
          detail: { ...input.detail, ...(by.actor === "lead" && by.onBehalfOf ? { sourceTurnId: by.onBehalfOf.sourceTurnId } : {}) },
          undo: { ...input.undo },
          credential: owner.credential,
          source: owner.source,
          ...(request.now ? { now: request.now } : {}),
        }).event.eventId;
      }
    } catch (error) {
      request.log?.(`[ui-action] failed to record owner action for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    target: { type: target.type, id: target.id }, action: definition.id, result, forLead: definition.forLead(run, result),
    by, authority, eventId, ownerActionEventId,
  };
}

const PERMISSION_WORDS: Record<ActionPermission, string> = {
  user_only: "属于用户：你可以做，被定时器、事件叫醒的一轮也行；用户在这一轮要求时记成代他做",
  lead_allowed: "你可以自己判断",
  delegated: "托管或长期授权范围内你自己判断，否则只有用户在这一轮明确要求时代他做",
  user_direct: "只有用户本人能做：你调用总会被拒绝",
};

const RULE_CHANGE_WORDS = "改规则：外部消息叫醒的一轮、读过外部内容的一轮做不了（用户本人正在说话的那一轮除外），被拒时请用户确认";
const PROMPT_SETTING_WORDS = "写进提示词的设置：外部消息叫醒的一轮、读过外部内容的一轮都做不了，用户本人的一轮也一样，被拒时请用户确认";

// 输入的字段，给 Lead 看：固定值写成 name=值，几个固定值之一写成 name=a|b。整个输入有几种写法（anyOf）时用「或」连起来。
function inputText(schema: TSchema): string {
  type Field = { const?: unknown; anyOf?: Array<{ const?: unknown }> };
  const shape = schema as { properties?: Record<string, Field>; anyOf?: TSchema[] };
  if (shape.anyOf) return shape.anyOf.map(inputText).join(" 或 ");
  const fields = Object.entries(shape.properties ?? {}).map(([name, field]) => {
    if (field.const !== undefined) return `${name}=${String(field.const)}`;
    const values = field.anyOf?.map((option) => option.const);
    return values?.length && values.every((value) => value !== undefined) ? `${name}=${values.join("|")}` : name;
  });
  return fields.length ? `{${fields.join(", ")}}` : "{}";
}

/** perform_action 工具说明里的操作清单。从定义生成，不手写。 */
export function uiActionCatalogText(): string {
  return UI_ACTION_TARGET_TYPES.map((type) => {
    const kind = UI_ACTION_TARGETS[type];
    const lines = Object.values(UI_ACTIONS[type]).map((definition) => {
      const schema = (UI_ACTION_INPUT_SCHEMAS[type] as Record<string, TSchema>)[definition.id]!;
      const who = definition.permission === "user_direct" ? PERMISSION_WORDS.user_direct
        : definition.userTurnOnly ? definition.permissionNote ?? "只属于用户：只有用户在这一轮明确要求时代他做"
        : definition.external ? "对外的操作：你可以做，被定时器、事件叫醒的一轮也行；用户在这一轮要求时记成代他做"
        : definition.irreversible === true ? "不可逆的操作：你可以做，先想清楚；用户在这一轮要求时记成代他做"
        : typeof definition.permission === "string" && typeof definition.irreversible === "boolean"
          ? PERMISSION_WORDS[definition.permission]
          : definition.permissionNote ?? "看目标现在的状态";
      const where = typeof definition.where === "string" ? `用户自己点：${definition.where}。` : "";
      // 不改规则、只在外部的一轮里按目标拒绝的（例如事实失效：用户本人来源的）：permissionNote 写明哪些不能做。
      const floorWords = !definition.changesRules && definition.externalRefusalNext && definition.permissionNote
        ? `${definition.permissionNote}，被拒时不发确认卡。` : "";
      const rules = (definition.promptSetting ? `${PROMPT_SETTING_WORDS}。` : definition.changesRules ? `${RULE_CHANGE_WORDS}。` : floorWords)
        .replace("被拒时请用户确认", definition.externalRefusalNext ? "被拒时不发确认卡" : "被拒时请用户确认");
      return `  - ${definition.id}（${definition.label}）：${who}。${where}${rules}input：${inputText(schema)}。${definition.hint}`;
    });
    return `- ${type}（${kind.label}，target_id 是${kind.idHint}）：\n${lines.join("\n")}`;
  }).join("\n");
}

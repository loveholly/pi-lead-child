// 工单操作层（spec 5.11）：页面上每一个会改后端的操作，只有一份实现，两个入口。
//   - 页面：网关的 GET /v1/tickets/:id/actions 和 POST /v1/tickets/:id/actions/:action（paired-server.ts），
//     旧的路由（/confirm、/request-review、/delivery/merge、/runs/:id/pause……）也转调这里。
//   - Lead：list_ticket_actions 和 ticket_action 两个工具（packages/lead 的 tools.ts）。
// 两个入口都走 runTicketAction：同样的输入校验、同样的「现在能不能做」（定义里的 available）、同样的授权规则
// （authority.ts）、同样的实现（定义里的 run）、同样的线上事件和主人操作。账本里只有 actor 不同。
import type { Item } from "@pi-lead-child/core";
import {
  OWNER_ACTIONS, TICKET_ACTION_IDS, TICKET_ACTION_INPUT_SCHEMAS, isTicketActionId,
  type OwnerActionSource, type TicketAction, type TicketActionId,
} from "@pi-lead-child/protocol";
import type { TSchema } from "typebox";
import {
  getBinding, getItem, itemUpdatedEvent, leadDisplayName, publishGatewayEvent, recordOwnerAction, runUpdatedEvent, type Db,
} from "@pi-lead-child/store";
import { Value } from "typebox/value";
import { ticketDelivery, type PullRequestRunner, type TicketDelivery } from "../coordinator/delivery.js";
import type { ActionAttribution } from "./attribution.js";
import {
  activeUserTurnReason, isUserTurnOnlyTicketAction, leadAuthorityMode, narrowCredentialTurn, resolveAuthority, type LeadAuthorityMode,
} from "./authority.js";
import { userTurnRefusalText } from "../ui-actions/authority.js";
import { TICKET_ACTIONS } from "./catalog.js";
import { liveItemIdsOf, type TicketActionHost } from "./lifecycle.js";
import {
  TicketActionError, permissionOf,
  type OwnerCredential, type TicketActionAuthority, type TicketActionCaller, type TicketActionDefinition, type TicketActionEnv,
  type TicketActionRun,
} from "./types.js";

export * from "./attribution.js";
export * from "./authority.js";
export * from "./lifecycle.js";
export { changeExecutorRuntime, setRunProfile, type ExecutorRuntimeResult, type RunProfile, type RunProfileApplied, type RunProfileResult } from "./run-profile.js";
export * from "./types.js";
export { TICKET_ACTIONS, relationLinkResult, relationRevokeResult } from "./catalog.js";
export {
  DelegationBlockedError, delegationPreflightFor, grantItemDelegation, type DelegateInput, type DelegationGrant,
} from "./delegation.js";
export {
  ITEM_RESTORE_MODES, previewItemRestore, restoreItemTree,
  type ItemRestoreMode, type ItemRestorePreview, type ItemRestoreResult,
} from "./restore.js";
export { failedReviewAttempt } from "./review-failure.js";

const UNDOABLE = new Set(OWNER_ACTIONS.filter((action) => action.undo === "conditional").map((action) => action.id));

export function ticketActionDefinition(id: string): TicketActionDefinition | null {
  return isTicketActionId(id) ? TICKET_ACTIONS[id] as unknown as TicketActionDefinition : null;
}

function createEnv(
  db: Db, item: Item, options: { host?: TicketActionHost; pullRequestRunner?: PullRequestRunner; now?: Date; local: boolean },
): TicketActionEnv {
  const host = options.host ?? {};
  let delivery: Promise<TicketDelivery> | null = null;
  let live: number[] | null = null;
  return {
    db,
    host,
    now: options.now ?? new Date(),
    delivery: () => (delivery ??= ticketDelivery(db, item.id)),
    liveItemIds: () => (live ??= liveItemIdsOf(host)),
    local: options.local,
    ...(options.pullRequestRunner ? { pullRequestRunner: options.pullRequestRunner } : {}),
  };
}

function requireItem(db: Db, itemId: number): Item {
  const item = getItem(db, itemId);
  if (!item) throw new TicketActionError("not_found", `工单 #${itemId} 不存在`);
  return item;
}

export interface TicketActionListOptions {
  host?: TicketActionHost;
  pullRequestRunner?: PullRequestRunner;
  now?: Date;
  // 看清单的请求来自这台电脑（网关：socket 是回环地址）。不给时当作不是：只在本机生效的操作显示为不能做。
  local?: boolean;
}

/** 这张工单的每个操作现在能不能做、为什么（GET /v1/tickets/:id/actions）。和执行前的检查是同一个函数。 */
export async function listTicketActions(db: Db, itemId: number, options: TicketActionListOptions = {}): Promise<TicketAction[]> {
  const item = requireItem(db, itemId);
  const env = createEnv(db, item, { ...options, local: options.local ?? false });
  const actions: TicketAction[] = [];
  for (const id of TICKET_ACTION_IDS) {
    const definition = ticketActionDefinition(id)!;
    const availability = await definition.available(item, env);
    actions.push({
      id,
      label: definition.label,
      area: definition.area,
      permission: permissionOf(definition, item),
      external: definition.external,
      irreversible: definition.irreversible,
      undoable: definition.ownerAction !== null && UNDOABLE.has(definition.ownerAction),
      available: availability.available,
      reason: availability.reason,
    });
  }
  return actions;
}

export interface LeadTicketAction extends TicketAction {
  // Lead 凭什么做：own（自己的权限）、delegated（托管授权）、user_turn（要用户在这一轮明确要求）、
  // user_direct（只有用户本人能做，Lead 调用总是被拒）。
  lead: LeadAuthorityMode;
  // 现在能不能做（available 且 Lead 有凭据）。不能时 leadReason 写明原因。
  leadReady: boolean;
  leadReason: string | null;
}

/** Lead 看到的清单（list_ticket_actions）：和页面同一份，另外写明 Lead 现在凭什么能做、或者为什么不能。 */
export async function listLeadTicketActions(
  db: Db, itemId: number, options: TicketActionListOptions & { turnId: string | null },
): Promise<LeadTicketAction[]> {
  const item = requireItem(db, itemId);
  // Lead 是本机的 daemon：只在本机生效的操作对它可用。
  const env = createEnv(db, item, { ...options, local: true });
  const actions = await listTicketActions(db, itemId, { ...options, local: true });
  return actions.map((action) => {
    const definition = ticketActionDefinition(action.id)!;
    const { mode, why, forUser } = leadAuthorityMode(definition, item, env);
    // 这一轮能不能凭：还要看这一轮的凭证有没有这个操作的 scope。
    const turnBlocker = mode === "user_turn" ? activeUserTurnReason(db, options.turnId, definition) : null;
    // Lead 自己判断的操作：这一轮来自做不了它的凭证、或者凭证被作废时照旧不能做（authority.ts 的 narrowCredentialTurn）。
    const narrow = mode === "own" && forUser ? narrowCredentialTurn(db, options.turnId, definition) : null;
    const ready = action.available && mode !== "user_direct" && (mode !== "user_turn" || turnBlocker === null) && narrow === null;
    return {
      ...action,
      lead: mode,
      leadReady: ready,
      leadReason: !action.available ? action.reason
        : mode === "user_direct" ? `${why}。请用户${definition.where ? `在${definition.where}` : "在工单详情里"}自己点。`
        : mode === "user_turn" && turnBlocker !== null ? `${why}（${turnBlocker}）`
        : narrow ? `${userTurnRefusalText(narrow, definition.where ?? "工单详情")}。` : null,
    };
  });
}

export interface TicketActionRequest {
  itemId: number;
  action: string;
  input?: unknown;
  // 为什么做。Lead 必须给；你不给时用这个操作的默认说法。
  reason?: string | null;
  caller: TicketActionCaller;
  host?: TicketActionHost;
  pullRequestRunner?: PullRequestRunner;
  now?: Date;
  // 主人操作记不上时写日志（操作已经做了，不能因此报错）。
  log?: (line: string) => void;
}

export interface TicketActionOutcome {
  ticketId: number;
  action: TicketActionId;
  result: unknown;
  by: ActionAttribution;
  authority: TicketActionAuthority;
  // 这次记下的主人操作（事件编号）。没有记时为 null。
  ownerActionEventId: string | null;
}

function inputError(schema: TSchema, input: unknown): string {
  const first = [...Value.Errors(schema, input)][0];
  return first ? `${first.instancePath || "input"}: ${first.message}` : "input 不对";
}

function ownerCredential(db: Db, caller: TicketActionCaller, by: ActionAttribution): {
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

/** 执行一个工单操作。两个入口都调它。 */
export async function runTicketAction(db: Db, request: TicketActionRequest): Promise<TicketActionOutcome> {
  const definition = ticketActionDefinition(request.action);
  if (!definition) throw new TicketActionError("not_found", `没有这个工单操作：${request.action}`);
  const id = definition.id as TicketActionId;
  const item = requireItem(db, request.itemId);
  const input = request.input ?? {};
  const schema = TICKET_ACTION_INPUT_SCHEMAS[id];
  if (!Value.Check(schema, input)) {
    throw new TicketActionError("invalid_input", `${id} 的输入不对：${inputError(schema, input)}`);
  }
  const given = typeof request.reason === "string" ? request.reason.trim() : "";
  if (request.caller.kind === "lead" && !given) {
    throw new TicketActionError("invalid_input", `${id}：要写 reason（凭什么做，例如「用户说……」）`);
  }
  // 只在本机生效的操作（打开文件）：页面的请求要从回环地址来（网关按 socket 填 source.loopback）；Lead 是本机的 daemon。
  // 没有来源的调用不知道从哪里来，当作不是本机。已知的缺口（工单 07 审查 H1，留到以后）：Lead 代你做时凭的那一轮
  // 可能来自手机上的配对凭证，这里没有要求它来自本机的凭证。
  const local = request.caller.kind === "lead" || request.caller.source?.loopback === true;
  const env = createEnv(db, item, { ...request, local });
  // 先认人，再查状态、再动手：对外的操作在认人之前不碰任何东西（delivery.ts 的同一条规则）。
  const { by, authority } = resolveAuthority(db, definition, item, request.caller, env);
  const availability = await definition.available(item, env);
  if (!availability.available) {
    throw new TicketActionError("unavailable", availability.reason ?? `${definition.label}现在不能做。`);
  }
  const credential = ownerCredential(db, request.caller, by);
  const run: TicketActionRun<never> = {
    db, env, item, input: input as never,
    reason: given || definition.defaultReason,
    reasonGiven: given.length > 0,
    by, authority,
    turnId: request.caller.kind === "lead" ? request.caller.turnId : null,
    bindingId: credential?.credential.id ?? null,
  };
  const recordOwner = (result: unknown): string | null => {
    const owner = definition.ownerAction ? credential : null;
    if (!owner) return null;
    try {
      const input = definition.ownerActionInput?.(run, result) ?? null;
      if (!input) return null;
      return recordOwnerAction(db, {
        ...input,
        summary: by.actor === "lead" ? `${leadDisplayName(db)} 代你${input.summary}` : input.summary,
        detail: { ...input.detail, ...(by.actor === "lead" && by.onBehalfOf ? { sourceTurnId: by.onBehalfOf.sourceTurnId } : {}) },
        undo: { ...input.undo },
        credential: owner.credential,
        source: owner.source,
        ...(request.now ? { now: request.now } : {}),
      }).event.eventId;
    } catch (error) {
      request.log?.(`[ticket-action] failed to record owner action for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  let result: unknown;
  try {
    result = await definition.run(run);
  } catch (error) {
    // 做了一半就失败（审查 M2）：例如「验收并合并」先验收、合并才失败。工单的 stage 已经变了，
    // 客户端照样要刷新，「不是我」照样要能撤销这次验收。然后把原来的错误交给入口。
    if (getItem(db, item.id)?.stage !== item.stage) {
      publishGatewayEvent(db, itemUpdatedEvent(item.id));
      recordOwner(undefined);
    }
    throw error;
  }

  const effects = definition.effects?.(run, result) ?? {};
  if (effects.runs?.length) {
    for (const touched of effects.runs) publishGatewayEvent(db, runUpdatedEvent(touched.itemId, touched.runId));
  } else {
    for (const itemId of effects.itemIds ?? [item.id]) publishGatewayEvent(db, itemUpdatedEvent(itemId));
  }
  const ownerActionEventId = recordOwner(result);
  return { ticketId: item.id, action: id, result, by, authority, ownerActionEventId };
}

const PERMISSION_WORDS: Record<string, string> = {
  user_only: "只属于用户：只有用户在这一轮明确要求时代他做",
  lead_allowed: "你可以自己判断",
  delegated: "托管范围内你自己判断，否则只有用户在这一轮明确要求时代他做",
  user_direct: "只有用户本人能做：你调用总会被拒绝，请用户在工单详情里自己点",
};

/** ticket_action 工具说明里的操作清单。从定义生成，不手写。 */
export function ticketActionCatalogText(): string {
  return TICKET_ACTION_IDS.map((id) => {
    const definition = ticketActionDefinition(id)!;
    const schema = TICKET_ACTION_INPUT_SCHEMAS[id] as { properties?: Record<string, unknown> };
    const fields = Object.keys(schema.properties ?? {});
    // 2026-10-28：原来要用户这一轮的操作由 Lead 判断（authority.ts）；仍然只认用户这一轮的单独写明。
    const who = definition.permission === "user_direct" ? PERMISSION_WORDS.user_direct
      : isUserTurnOnlyTicketAction(id) ? "只属于用户：只有用户在这一轮明确要求时代他做"
      : definition.external ? "对外的操作：你自己判断；读过外部内容的一轮里不能做"
      : definition.irreversible ? "不可逆的操作：你自己判断，先想清楚；读过外部内容的一轮里不能做"
      : definition.permission === "lead_allowed" ? PERMISSION_WORDS.lead_allowed
      : "你自己判断；用户在这一轮要求时记成代他做；读过外部内容的一轮里不能做";
    return `- ${id}（${definition.label}）：${who}。input：${fields.length ? fields.join(", ") : "{}"}。${definition.hint}`;
  }).join("\n");
}

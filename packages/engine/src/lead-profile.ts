// 改 Lead 的名字、人格和互动风格（设置页「身份与风格」，2026-10-22）。一份实现，两个入口：
//   - 设置页：网关的 POST /v1/lead/profile（gateway 的 lead-profile-routes.ts）。
//   - Lead：update_lead_profile 工具（lead 的 profile-tools.ts）。用户在对话里说「以后叫你 Jarvis」「说话简短点」时用它。
// 权限是 user_only：Lead 只能在用户这一轮明确要求时代他改（store 的 activePairedUserTurn，和工单操作层同一条规则），
// 账本写 actor=lead、代谁、凭哪一轮。人格和互动风格进 Lead 的系统提示词，所以每次修改都记一次主人操作（lead.profile），
// 「不是我」/「撤销」恢复成改之前的样子。没有变化时什么也不写。
import {
  LEAD_PROFILE_RESOURCE, LeadProfileRequestSchema, leadProfileProblem, normalizeLeadProfileRequest,
  type LeadProfileDto, type LeadProfileFields, type LeadProfileRequest, type OwnerActionSource,
} from "@pi-lead-child/protocol";
import {
  activePairedUserTurn, getBinding, getLeadProfile, leadProfileFields, recordOwnerAction, writeLeadProfile, type Db,
} from "@pi-lead-child/store";
import { Value } from "typebox/value";
import type { ActionAttribution } from "./ticket-actions/attribution.js";
import type { OwnerCredential } from "./ticket-actions/types.js";

export type LeadProfileCaller =
  | { kind: "user"; credential?: OwnerCredential | null; source?: OwnerActionSource | null }
  // external：这一轮读进了外部来源的原文（lead 的 turn-origin.ts）。
  | { kind: "lead"; turnId: string | null; external?: boolean };

export class LeadProfileError extends Error {
  constructor(readonly code: "invalid_input" | "needs_user_turn", message: string) {
    super(message);
  }
}

export interface LeadProfileUpdateRequest {
  request: LeadProfileRequest;
  caller: LeadProfileCaller;
  now?: Date;
  // 改了以后调：网关发 snapshot.required（resource 是 lead-profile），客户端重新 GET。
  publish?: (resource: typeof LEAD_PROFILE_RESOURCE) => void;
  log?: (line: string) => void;
}

export interface LeadProfileUpdateOutcome {
  profile: LeadProfileDto;
  changed: boolean;
  by: ActionAttribution;
  // 记下的主人操作（owner_action.performed 的 event_id）。没有变化、或者记不上时为 null。
  ownerActionEventId: string | null;
}

const quote = (text: string) => `「${text}」`;

/** 主人操作的一句话：改了什么。 */
export function leadProfileChangeSummary(before: LeadProfileFields, after: LeadProfileFields): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`把助手的名字从${quote(before.name)}改成${quote(after.name)}`);
  if (before.persona !== after.persona) parts.push(after.persona ? `改了 ${after.name} 的人格` : `清空了 ${after.name} 的人格`);
  if (before.interactionStyle !== after.interactionStyle) {
    parts.push(after.interactionStyle ? `改了 ${after.name} 和你的互动风格` : `清空了 ${after.name} 和你的互动风格`);
  }
  return parts.join("，");
}

function sameFields(a: LeadProfileFields, b: LeadProfileFields): boolean {
  return a.name === b.name && a.persona === b.persona && a.interactionStyle === b.interactionStyle;
}

function authorize(db: Db, caller: LeadProfileCaller): ActionAttribution {
  if (caller.kind === "user") return { actor: "user" };
  // 这些设置写进 Lead 的系统提示词。用户 2026-10-27：「严禁 Lead 本身的行为模式存在可能被 slack 消息通过提示词注入的机制
  // 导致改写的可能性」。这一轮读过外部原文时，即使是用户本人的一轮也不能改。
  if (caller.external) {
    throw new LeadProfileError(
      "needs_user_turn",
      "名字、人格和互动风格会写进你的系统提示词，这一轮读过外部通道（例如 Slack）的消息，不能改。请用户在新的一条消息里再说一次。",
    );
  }
  try {
    const turn = activePairedUserTurn(db, caller.turnId, "update_lead_profile", "tickets:create");
    return { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: turn.id, bindingId: turn.origin_binding_id } };
  } catch (error) {
    throw new LeadProfileError(
      "needs_user_turn",
      "名字、人格和互动风格只有用户在这一轮明确要求时你才能改"
        + `（${error instanceof Error ? error.message : String(error)}）。用户没有这样要求时，请他在设置 → 身份与风格里改。`,
    );
  }
}

// 主人操作记在谁名下：页面是发出请求的凭证；Lead 代做的是那一轮来自的凭证，一律推送（工单操作层的同一条规则）。
function ownerOf(db: Db, caller: LeadProfileCaller, by: ActionAttribution): { credential: OwnerCredential; source: OwnerActionSource } | null {
  if (caller.kind === "user") {
    return caller.credential && caller.source ? { credential: caller.credential, source: caller.source } : null;
  }
  if (by.actor !== "lead" || !by.onBehalfOf) return null;
  const binding = getBinding(db, by.onBehalfOf.bindingId);
  if (!binding) return null;
  return { credential: binding, source: { client: "lead", deviceName: binding.display_name, loopback: false, fromThisMachine: true } };
}

/** 改名字、人格或互动风格。两个入口都调它。 */
export function updateLeadProfile(db: Db, update: LeadProfileUpdateRequest): LeadProfileUpdateOutcome {
  if (!Value.Check(LeadProfileRequestSchema, update.request)) {
    throw new LeadProfileError("invalid_input", "只能改 name、persona、interactionStyle，值是文字");
  }
  const patch = normalizeLeadProfileRequest(update.request);
  const problem = leadProfileProblem(patch);
  if (problem) throw new LeadProfileError("invalid_input", problem);
  // 先认人，再动手。
  const by = authorize(db, update.caller);
  const now = update.now ?? new Date();
  const current = getLeadProfile(db);
  const before = leadProfileFields(current);
  const after: LeadProfileFields = { ...before, ...patch };
  if (sameFields(before, after)) return { profile: current, changed: false, by, ownerActionEventId: null };

  const profile = db.transaction(() => writeLeadProfile(db, after, { by: by.actor, at: now })).immediate();
  update.log?.(`[lead-profile] updated by ${by.actor}${by.actor === "lead" && by.onBehalfOf ? " on behalf of the user" : ""}`);
  let ownerActionEventId: string | null = null;
  const owner = ownerOf(db, update.caller, by);
  if (owner) {
    const summary = leadProfileChangeSummary(before, after);
    try {
      ownerActionEventId = recordOwnerAction(db, {
        action: "lead.profile",
        target: { key: "lead:profile", label: `${after.name} 的身份与风格`, ticketId: null },
        summary: by.actor === "lead" ? `${after.name} 代你${summary}` : summary,
        detail: {
          fields: (["name", "persona", "interactionStyle"] as const).filter((field) => before[field] !== after[field]),
          ...(by.actor === "lead" && by.onBehalfOf ? { sourceTurnId: by.onBehalfOf.sourceTurnId } : {}),
        },
        undo: { kind: "lead_profile", before, after },
        credential: owner.credential,
        source: owner.source,
        now,
      }).event.eventId;
    } catch (error) {
      // 修改已经做了：记不上主人操作只写日志，不回错（网关 recordOwnerActionFor 的同一条规则）。
      update.log?.(`[lead-profile] failed to record the owner action: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  update.publish?.(LEAD_PROFILE_RESOURCE);
  return { profile, changed: true, by, ownerActionEventId };
}

/** 「不是我」/「撤销」：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不动。 */
export function revertLeadProfile(
  db: Db, undo: { before: LeadProfileFields; after: LeadProfileFields }, options: { now?: Date } = {},
): "reverted" | "changed_since" | "unchanged" {
  const current = leadProfileFields(getLeadProfile(db));
  if (sameFields(current, undo.before)) return "unchanged";
  if (!sameFields(current, undo.after)) return "changed_since";
  db.transaction(() => writeLeadProfile(db, undo.before, { by: "user", at: options.now ?? new Date() })).immediate();
  return "reverted";
}

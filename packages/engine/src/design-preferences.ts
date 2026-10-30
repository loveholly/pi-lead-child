// 改界面的外观偏好（设置页「外观」，2026-10-22）。一份实现，两个入口：
//   - 设置页：网关的 POST /v1/design/preferences（gateway 的 design-preferences-routes.ts）。
//   - Lead：update_design_preferences 工具（lead 的 design-tools.ts）。用户在对话里说「卡片太挤了」「圆角大一点」时用它。
// 权限和「身份与风格」一样是 user_only：Lead 只能在用户这一轮明确要求时代他改（store 的 activePairedUserTurn），
// 账本写 actor=lead、代谁、凭哪一轮。每次修改记一次主人操作（ui.design），「不是我」/「撤销」恢复成改之前的样子。
import {
  DENSITY_LEVEL_LABELS, DENSITY_ZONE_LABELS, DENSITY_ZONES, DESIGN_PREFERENCES_RESOURCE, DesignPreferencesRequestSchema,
  LINE_HEIGHT_LEVEL_LABELS, PALETTE_ROLE_LABELS, PALETTE_ROLES, RADIUS_LEVEL_LABELS, TEXT_SCALE_LEVEL_LABELS,
  applyDesignPreferencesRequest, designPreferencesFields, designPreferencesProblem, normalizeDesignPreferencesRequest,
  sameDesignPreferences,
  type DesignPreferencesDto, type DesignPreferencesFields, type DesignPreferencesRequest, type OwnerActionSource,
} from "@pi-lead-child/protocol";
import {
  activePairedUserTurn, getBinding, getDesignPreferences, recordOwnerAction, writeDesignPreferences, type Db,
} from "@pi-lead-child/store";
import { Value } from "typebox/value";
import type { ActionAttribution } from "./ticket-actions/attribution.js";
import type { OwnerCredential } from "./ticket-actions/types.js";

export type DesignPreferencesCaller =
  | { kind: "user"; credential?: OwnerCredential | null; source?: OwnerActionSource | null }
  // external：这一轮读进了外部来源的原文（lead 的 turn-origin.ts）。
  | { kind: "lead"; turnId: string | null; external?: boolean };

export class DesignPreferencesError extends Error {
  constructor(readonly code: "invalid_input" | "needs_user_turn", message: string) {
    super(message);
  }
}

export interface DesignPreferencesUpdateRequest {
  request: DesignPreferencesRequest;
  caller: DesignPreferencesCaller;
  now?: Date;
  publish?: (resource: typeof DESIGN_PREFERENCES_RESOURCE) => void;
  log?: (line: string) => void;
}

export interface DesignPreferencesUpdateOutcome {
  preferences: DesignPreferencesDto;
  changed: boolean;
  by: ActionAttribution;
  ownerActionEventId: string | null;
}

/** 主人操作的一句话：改了什么。 */
export function designPreferencesChangeSummary(before: DesignPreferencesFields, after: DesignPreferencesFields): string {
  const parts: string[] = [];
  for (const zone of DENSITY_ZONES) {
    if (before.density[zone] !== after.density[zone]) parts.push(`${DENSITY_ZONE_LABELS[zone]}的密度改成${DENSITY_LEVEL_LABELS[after.density[zone]]}`);
  }
  if (before.radius !== after.radius) parts.push(`圆角改成${RADIUS_LEVEL_LABELS[after.radius]}`);
  if (before.lineHeight !== after.lineHeight) parts.push(`行高改成${LINE_HEIGHT_LEVEL_LABELS[after.lineHeight]}`);
  if (before.textScale !== after.textScale) parts.push(`字号改成${TEXT_SCALE_LEVEL_LABELS[after.textScale]}`);
  for (const role of PALETTE_ROLES) {
    if (before.colors[role] !== after.colors[role]) parts.push(`${PALETTE_ROLE_LABELS[role]}改成 ${after.colors[role]}`);
  }
  if (before.notes !== after.notes) parts.push(after.notes ? "改了设计说明" : "清空了设计说明");
  return parts.join("，");
}

function authorize(db: Db, caller: DesignPreferencesCaller): ActionAttribution {
  if (caller.kind === "user") return { actor: "user" };
  // 这些设置写进 Lead 的系统提示词。用户 2026-10-27：「严禁 Lead 本身的行为模式存在可能被 slack 消息通过提示词注入的机制
  // 导致改写的可能性」。这一轮读过外部原文时，即使是用户本人的一轮也不能改。
  if (caller.external) {
    throw new DesignPreferencesError(
      "needs_user_turn",
      "界面的外观会写进你的系统提示词，这一轮读过外部通道（例如 Slack）的消息，不能改。请用户在新的一条消息里再说一次。",
    );
  }
  try {
    const turn = activePairedUserTurn(db, caller.turnId, "update_design_preferences", "tickets:create");
    return { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: turn.id, bindingId: turn.origin_binding_id } };
  } catch (error) {
    throw new DesignPreferencesError(
      "needs_user_turn",
      "界面的外观只有用户在这一轮明确要求时你才能改"
        + `（${error instanceof Error ? error.message : String(error)}）。用户没有这样要求时，先把建议说给他听，或者请他在设置 → 外观里改。`,
    );
  }
}

function ownerOf(db: Db, caller: DesignPreferencesCaller, by: ActionAttribution): { credential: OwnerCredential; source: OwnerActionSource } | null {
  if (caller.kind === "user") {
    return caller.credential && caller.source ? { credential: caller.credential, source: caller.source } : null;
  }
  if (by.actor !== "lead" || !by.onBehalfOf) return null;
  const binding = getBinding(db, by.onBehalfOf.bindingId);
  if (!binding) return null;
  return { credential: binding, source: { client: "lead", deviceName: binding.display_name, loopback: false, fromThisMachine: true } };
}

/** 改外观偏好。两个入口都调它。 */
export function updateDesignPreferences(db: Db, update: DesignPreferencesUpdateRequest): DesignPreferencesUpdateOutcome {
  if (!Value.Check(DesignPreferencesRequestSchema, update.request)) {
    throw new DesignPreferencesError("invalid_input", "只能改 density、radius、lineHeight、textScale、colors、notes，值要在各自的档位里");
  }
  const request = normalizeDesignPreferencesRequest(update.request);
  const problem = designPreferencesProblem(request);
  if (problem) throw new DesignPreferencesError("invalid_input", problem);
  const by = authorize(db, update.caller);
  const now = update.now ?? new Date();
  const current = getDesignPreferences(db);
  const before = designPreferencesFields(current);
  const after = applyDesignPreferencesRequest(before, request);
  if (sameDesignPreferences(before, after)) return { preferences: current, changed: false, by, ownerActionEventId: null };

  const preferences = db.transaction(() => writeDesignPreferences(db, after, { by: by.actor, at: now })).immediate();
  update.log?.(`[design-preferences] updated by ${by.actor}${by.actor === "lead" && by.onBehalfOf ? " on behalf of the user" : ""}`);
  let ownerActionEventId: string | null = null;
  const owner = ownerOf(db, update.caller, by);
  if (owner) {
    const summary = designPreferencesChangeSummary(before, after);
    try {
      ownerActionEventId = recordOwnerAction(db, {
        action: "ui.design",
        target: { key: "ui:design", label: "界面的外观", ticketId: null },
        summary: by.actor === "lead" ? `助手代你${summary}` : summary,
        detail: by.actor === "lead" && by.onBehalfOf ? { sourceTurnId: by.onBehalfOf.sourceTurnId } : {},
        undo: { kind: "design_preferences", before, after },
        credential: owner.credential,
        source: owner.source,
        now,
      }).event.eventId;
    } catch (error) {
      update.log?.(`[design-preferences] failed to record the owner action: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  update.publish?.(DESIGN_PREFERENCES_RESOURCE);
  return { preferences, changed: true, by, ownerActionEventId };
}

/** 「不是我」/「撤销」：现在还是那次改完的样子时，恢复成改之前的样子。之后又改过的不动。 */
export function revertDesignPreferences(
  db: Db, undo: { before: DesignPreferencesFields; after: DesignPreferencesFields }, options: { now?: Date } = {},
): "reverted" | "changed_since" | "unchanged" {
  const current = designPreferencesFields(getDesignPreferences(db));
  if (sameDesignPreferences(current, undo.before)) return "unchanged";
  if (!sameDesignPreferences(current, undo.after)) return "changed_since";
  db.transaction(() => writeDesignPreferences(db, undo.before, { by: "user", at: options.now ?? new Date() })).immediate();
  return "reverted";
}

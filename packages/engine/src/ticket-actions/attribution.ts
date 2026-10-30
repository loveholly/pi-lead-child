// 工单操作是谁做的（spec 5.11）。账本只写两种人：你（user），或者 Lead。Lead 代你做只属于你的操作时，
// 账本照样写 actor=lead，另外记下代谁（onBehalfOf: user）和凭哪一轮对话（sourceTurnId），不写成 actor=user。
import type { Actor } from "@pi-lead-child/core";

export interface OnBehalfOfUser {
  actor: "user";
  // 授权的那一轮（channel_turns.id）：当前已认证的配对用户轮次（store 的 activePairedUserTurn）。
  sourceTurnId: string;
  // 那一轮来自哪个配对凭证。「不是我」作废的就是它。
  bindingId: number;
}

export type ActionAttribution =
  | { actor: "user" }
  | { actor: "lead"; onBehalfOf?: OnBehalfOfUser };

export const BY_USER: ActionAttribution = Object.freeze({ actor: "user" });

export function attributionActor(by: ActionAttribution): Extract<Actor, "user" | "lead"> {
  return by.actor;
}

/** 写进活动 payload 的「代谁、凭哪一轮」。不是代做时为空。 */
export function behalfFields(by: ActionAttribution): { onBehalfOf?: "user"; sourceTurnId?: string } {
  return by.actor === "lead" && by.onBehalfOf
    ? { onBehalfOf: "user", sourceTurnId: by.onBehalfOf.sourceTurnId }
    : {};
}

/** transition() 的 actor 和 onBehalfOf。 */
export function transitionBy(by: ActionAttribution): {
  actor: Extract<Actor, "user" | "lead">;
  onBehalfOf?: { actor: "user"; sourceTurnId: string };
} {
  return by.actor === "lead" && by.onBehalfOf
    ? { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: by.onBehalfOf.sourceTurnId } }
    : { actor: by.actor };
}

/** 活动的 session_cursor：代做时指向授权的那一轮（和已经删掉的 authorize_start 的做法一样）。 */
export function behalfCursor(by: ActionAttribution): { sessionCursor?: string } {
  return by.actor === "lead" && by.onBehalfOf ? { sessionCursor: by.onBehalfOf.sourceTurnId } : {};
}

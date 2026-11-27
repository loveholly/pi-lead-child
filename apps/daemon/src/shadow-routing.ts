// 哪些后台事件交给 shadow（用户 2026-11-19，.scratch/lead-background-shadow/spec.md D2）。决策边界，纯函数。
//
// 写在代码里的规则（确定的事实，不靠提示词）：下面这些永远交给主会话。
//   - shadow 已经交回过的事。
//   - 到点的提醒、用户本人设的跟进、你在等的事有了结果、Lead 自己设的跟进到点：这是 Lead 接着做手上的事，要对话的上下文。
//   - interrupt 级的事、标了 mustTell 的事、带着要用户做什么（授权、确认）的事。
//   - 交接出去又交回来的结果，车道在 L1 以内（用户或在等的人的事，lead-scheduler spec D1）。
//   - 主会话这一轮正在处理的对象上的事（两个 Lead 不同时动一个对象）。
//   - 设置里没有交给 shadow 的来源。
// 剩下的交给 shadow。它在会话里再按 D2 的说法判断：要对话的上下文、用户在看而且要对用户说、要用户本人、拿不准，就交回来。
import {
  isUserActionRequest, messageEventSessionKey, shadowBucket, LEAD_WAIT_EXPIRED_KIND, LEAD_WAIT_SATISFIED_KIND, MESSAGE_EVENT_KIND,
  type LeadShadowDto, type LeadShadowSource, type UserActionRequest,
} from "@pi-lead-child/protocol";
import type { EventRecord } from "@pi-lead-child/store";

// 交给 Lead 的一条事件里还没做的「需要用户做什么」：等待超时（lead.wait_expired）里的，和 inbox 说明（例如连接授权失效，
// payload.payload.userAction）里的。等待了结（lead.wait_satisfied）里的那一件用户已经做完了，不算（2026-10-19 审查：
// 用户授权完成以后叫醒 Lead 的那一轮，没有控件的卡片被退回，还提示 Lead 再放一次授权按钮）。
export function pendingUserActionOfEvent(event: EventRecord): UserActionRequest | null {
  if (event.kind === LEAD_WAIT_EXPIRED_KIND) {
    return isUserActionRequest(event.payload.userAction) ? event.payload.userAction : null;
  }
  if (!event.kind.startsWith("inbox.")) return null;
  const inner = event.payload.payload;
  const nested = inner && typeof inner === "object" ? (inner as { userAction?: unknown }).userAction : undefined;
  return isUserActionRequest(nested) ? nested : null;
}

// 这条事件要不要告诉用户：写入方标了 mustTell（等待的 mustTell，store 的 lead-waits.ts；模型切换）。
export function eventMustBeTold(event: EventRecord): boolean {
  return event.payload.mustTell === true;
}

// 交给这一轮的事件里，交回的结果带着原来的车道：交接出去的工单（run-finished.ts 的 handoffLane）、转到后台的作业
// （resultLane）。没有时是 9（不提级）。
export function eventHandoffLane(event: EventRecord): number {
  const inner = event.payload.payload as Record<string, unknown> | undefined;
  const lane = typeof event.payload.handoffLane === "number" ? event.payload.handoffLane : inner?.handoffLane ?? inner?.resultLane;
  return typeof lane === "number" && Number.isInteger(lane) && lane >= 0 && lane <= 4 ? lane : 9;
}

export interface ShadowRouteFacts {
  settings: Pick<LeadShadowDto, "mode" | "shares">;
  escalatedByShadow: (seq: number) => boolean;
  isReminder: (event: EventRecord) => boolean;
  isUserFollowUp: (event: EventRecord) => boolean;
  mustTell: (event: EventRecord) => boolean;
  needsUserAction: (event: EventRecord) => boolean;
  handoffLane: (event: EventRecord) => number;
  // 主会话这一轮正在处理的对象（它这一轮拿着的事件的 entityKey，外部消息另加它的会话分组键）。
  leadEntities: ReadonlySet<string>;
}

export type ShadowRoute = { shadow: true; source: LeadShadowSource } | { shadow: false; why: string };

// 内部对象的键前缀：不是外部通道的对话。
const INTERNAL_KEY_PREFIXES = new Set([
  "ticket", "run", "item", "lead", "lead-job", "inbox", "notification", "reminder", "timer", "signal", "signal_source", "config",
  "connection", "connections", "daemon", "user", "workspace", "approval", "agenda", "widget",
]);

const ESCALATED_KIND = "event.escalated";

/**
 * 事件属于哪个来源（设置里的 sources）。channel 只认外部消息本身和它的升级：不认识的前缀不等于外部对话
 * （2026-11-20：清理扫描问「这个目录要不要删」，对象是 workspace-orphan:…，按 channel 分给了 shadow）。
 */
export function shadowSourceOf(event: Pick<EventRecord, "kind" | "entityKey">): LeadShadowSource {
  if (event.kind === MESSAGE_EVENT_KIND) return "channel";
  const prefix = /^([a-z][a-z0-9_-]*):/u.exec(event.entityKey)?.[1] ?? "";
  if (prefix === "ticket" || prefix === "run" || prefix === "item") return "ticket";
  // 外部通道里没人回的消息到时限升级（event.escalated，对象是 slack:… 这样的对话）。
  if (event.kind === ESCALATED_KIND && prefix && !INTERNAL_KEY_PREFIXES.has(prefix)) return "channel";
  return "other";
}

/** Lead 自己设的跟进到点（timer.fired，不是用户设的）。 */
function isLeadFollowUp(event: EventRecord): boolean {
  return event.kind === "timer.fired" && event.payload.setByUser !== true;
}

export function shadowRoute(event: EventRecord, facts: ShadowRouteFacts): ShadowRoute {
  if (facts.settings.mode === "off") return { shadow: false, why: "off" };
  if (facts.escalatedByShadow(event.seq)) return { shadow: false, why: "shadow_escalated" };
  if (facts.isReminder(event)) return { shadow: false, why: "reminder" };
  if (facts.isUserFollowUp(event)) return { shadow: false, why: "user_follow_up" };
  if (isLeadFollowUp(event)) return { shadow: false, why: "lead_follow_up" };
  if (event.kind === LEAD_WAIT_SATISFIED_KIND || event.kind === LEAD_WAIT_EXPIRED_KIND) return { shadow: false, why: "lead_wait" };
  if (event.level === "interrupt") return { shadow: false, why: "interrupt" };
  if (facts.mustTell(event)) return { shadow: false, why: "must_tell" };
  if (facts.needsUserAction(event)) return { shadow: false, why: "user_action" };
  if (facts.handoffLane(event) <= 1) return { shadow: false, why: "handoff_for_user" };
  if (facts.leadEntities.has(event.entityKey)) return { shadow: false, why: "lead_on_it" };
  // 外部消息按会话分组判断（工单 #588）：主会话在处理这段对话的另一条消息时（例如私信 thread 里的一条），这一条也留给它。
  const group = shadowSessionKey(event);
  if (group !== null && facts.leadEntities.has(group)) return { shadow: false, why: "lead_on_it" };
  const source = shadowSourceOf(event);
  const share = facts.settings.shares[source];
  if (share <= 0) return { shadow: false, why: "share_off" };
  if (share < 100 && shadowBucket(shadowObjectKey(event)) >= share) return { shadow: false, why: "share_lead" };
  return { shadow: true, source };
}

/**
 * 外部消息的会话分组键（工单 #588，通道适配器给的 session.key；旧事件按它所在的对话）。不是外部消息时是 null。
 * shadow 按它把同一段对话的消息放进同一个会话。
 */
export function shadowSessionKey(event: Pick<EventRecord, "kind" | "payload">): string | null {
  if (event.kind !== MESSAGE_EVENT_KIND) return null;
  return messageEventSessionKey(event.payload);
}

/**
 * 分流按哪个对象分（用户 2026-11-19：按比例分给 shadow，可以随时调）：工单的事按工单（Run 的事件也归到它的工单），
 * 外部消息按对话，别的按事件的对象。同一个对象永远落在同一边。
 */
export function shadowObjectKey(event: Pick<EventRecord, "kind" | "entityKey" | "payload">): string {
  // 外部消息按会话分组（工单 #588）：私信的主对话和私信里的 thread 是同一组，一定落在同一边、进同一个会话。
  const group = shadowSessionKey(event);
  if (group !== null) return group;
  const itemId = event.payload.itemId;
  if (typeof itemId === "number" && Number.isInteger(itemId) && itemId > 0) return `ticket:${itemId}`;
  return event.entityKey;
}

/** 用事件自己的字段能判断的那些规则（daemon 和回放共用）。escalatedByShadow、isReminder、leadEntities 由调用方给。 */
export function eventShadowFacts(input: Pick<ShadowRouteFacts, "settings" | "escalatedByShadow" | "isReminder" | "leadEntities">): ShadowRouteFacts {
  return {
    ...input,
    isUserFollowUp: (event) => event.kind === "timer.fired" && event.payload.setByUser === true,
    mustTell: eventMustBeTold,
    needsUserAction: (event) => pendingUserActionOfEvent(event) !== null,
    handoffLane: eventHandoffLane,
  };
}

/** 一批事件分成交给 shadow 的和留给主会话的，保持原来的顺序。 */
export function splitForShadow(events: readonly EventRecord[], facts: ShadowRouteFacts): { shadow: EventRecord[]; lead: EventRecord[] } {
  const shadow: EventRecord[] = [];
  const lead: EventRecord[] = [];
  for (const event of events) (shadowRoute(event, facts).shadow ? shadow : lead).push(event);
  return { shadow, lead };
}

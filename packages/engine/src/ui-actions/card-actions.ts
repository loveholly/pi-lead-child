// 「Lead 动态」卡上的按钮（2026-10-29）：Lead 自己改了东西时，卡上带一个撤销它的操作。
// 哪种事件带哪个操作写在这里；现在能不能做由操作层的 available 判断（和页面、Lead 的 list_actions 是同一个函数）。
// 做不了时卡上没有按钮。网关算卡时调它（gateway 的 lead-activity.ts）。
import {
  CHANNEL_MUTE_STARTED_KIND, CORE_MEMORY_CHANGED_KIND, LEAD_INSTALL_CHANGED_KIND, MEMORY_FACT_CHANGED_KIND, TICKET_BUDGET_CHANGED_KIND,
  type LeadActivityCardAction,
} from "@pi-lead-child/protocol";
import { getLocale, type Db, type EventRecord } from "@pi-lead-child/store";
import { channelMuteMessages } from "../channels/mute.messages.js";
import { budgetMessages } from "../ticket-actions/budget.messages.js";
import { UI_ACTIONS, UI_ACTION_TARGETS } from "./catalog.js";
import type { UiActionEnv } from "./types.js";

const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

// 这条事件报告的是 Lead 自己做的一件能撤销的事时，撤销它的操作。
function undoFor(db: Db, event: Pick<EventRecord, "kind" | "payload">): LeadActivityCardAction | null {
  const payload = event.payload;
  if (event.kind === CHANNEL_MUTE_STARTED_KIND && typeof payload.conversation === "string") {
    // 一个对话开始静音（工单 #533）：熔断的带「取消静音」，Lead 和你自己静音的带「撤销」。到点或者取消以后按钮消失（unmute 做不了）。
    const text = channelMuteMessages(getLocale(db));
    return { target: { type: "channel_conversation", id: payload.conversation }, action: "unmute", label: payload.by === "breaker" ? text.unmute : text.undo };
  }
  if (event.kind === CORE_MEMORY_CHANGED_KIND) {
    const changeId = idOf(payload.changeId);
    if (payload.actor !== "lead" || payload.undoOf !== null || changeId === null) return null;
    return { target: { type: "core_memory_change", id: String(changeId) }, action: "undo", label: "撤销" };
  }
  if (event.kind === MEMORY_FACT_CHANGED_KIND) {
    // Lead 让一条事实失效：撤销就是恢复它。
    if (payload.actor !== "lead" || payload.action !== "invalidated" || typeof payload.memoryId !== "string") return null;
    return { target: { type: "memory_fact", id: payload.memoryId }, action: "restore", label: "撤销" };
  }
  if (event.kind === TICKET_BUDGET_CHANGED_KIND) {
    // Lead 自己调高了工单的 token 预算（工单 #562）：撤销就是改回原来的预算。撤销以后最新一条是撤销，按钮消失。
    const activityId = idOf(payload.activityId);
    if (payload.actor !== "lead" || payload.action !== "raised" || activityId === null) return null;
    return { target: { type: "budget_raise", id: String(activityId) }, action: "undo", label: budgetMessages(getLocale(db)).undo };
  }
  if (event.kind === LEAD_INSTALL_CHANGED_KIND) {
    // Lead 装了一个能力（2026-11-02）：撤销就是断开这个连接，或者卸载这个 skill。
    const target = payload.target as { type?: unknown; id?: unknown } | undefined;
    if (payload.actor !== "lead" || payload.action !== "installed" || typeof target?.id !== "string") return null;
    if (target.type === "connection") return { target: { type: "connection", id: target.id }, action: "disconnect", label: "撤销" };
    if (target.type === "skill") return { target: { type: "skill", id: target.id }, action: "uninstall", label: "撤销" };
  }
  return null;
}

/** 卡里最新一条事件带的按钮。现在做不了（已经撤销过、之后又改过……）时为 null。 */
export function leadActivityCardAction(db: Db, event: Pick<EventRecord, "kind" | "payload">, now = new Date()): LeadActivityCardAction | null {
  const proposal = undoFor(db, event);
  if (!proposal) return null;
  const type = proposal.target.type as keyof typeof UI_ACTIONS;
  const definition = UI_ACTIONS[type]?.[proposal.action];
  if (!definition) return null;
  const env: UiActionEnv = { db, services: {}, now };
  const target = UI_ACTION_TARGETS[type].load(env, proposal.target.id);
  if (target === null || target === undefined) return null;
  const availability = definition.available(target, env);
  // 卡在一个读事务里同步地算：要等的判断（异步的 available）不放按钮。
  if (availability instanceof Promise || !availability.available) return null;
  return proposal;
}

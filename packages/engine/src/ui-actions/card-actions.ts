// 「Lead 动态」卡上的按钮（2026-10-29）：Lead 自己改了东西时，卡上带一个撤销它的操作。
// 哪种事件带哪个操作写在这里；现在能不能做由操作层的 available 判断（和页面、Lead 的 list_actions 是同一个函数）。
// 做不了时卡上没有按钮。网关算卡时调它（gateway 的 lead-activity.ts）。
import { CORE_MEMORY_CHANGED_KIND, MEMORY_FACT_CHANGED_KIND, type LeadActivityCardAction } from "@pi-lead-child/protocol";
import type { Db, EventRecord } from "@pi-lead-child/store";
import { UI_ACTIONS, UI_ACTION_TARGETS } from "./catalog.js";
import type { UiActionEnv } from "./types.js";

const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

// 这条事件报告的是 Lead 自己做的一件能撤销的事时，撤销它的操作。
function undoFor(event: Pick<EventRecord, "kind" | "payload">): LeadActivityCardAction | null {
  const payload = event.payload;
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
  return null;
}

/** 卡里最新一条事件带的按钮。现在做不了（已经撤销过、之后又改过……）时为 null。 */
export function leadActivityCardAction(db: Db, event: Pick<EventRecord, "kind" | "payload">, now = new Date()): LeadActivityCardAction | null {
  const proposal = undoFor(event);
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

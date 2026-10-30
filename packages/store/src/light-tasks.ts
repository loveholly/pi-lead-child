// 轻子 agent 的工单（lead-tools-and-routing spec D9）。用户 2026-10-27：「不是所有的事情都要进工单系统」。
// PR 评审、方案评估、调研这类要推理、要多次调用工具、但不改代码也不需要验收的活，Lead 派一个轻子 agent：
//   - 它照常是一张工单、一个 Run（执行者在沙箱里跑，重启以后能接着跑，账本里有审计记录）；
//   - 不进用户的工作列表（gateway 的 worklistVisibility 记成 background）；
//   - 不要验收：交付以后系统直接结单，结果随 Run 结束的通知交给 Lead（daemon 的 run-finished.ts）。
// 标记记成一条活动（和 ticket_dedupe_key 一样），不改 items 的列：item.purpose 也是 Run 的 purpose，
// 线上协议和数据库都认它，加一个新值牵动太大。
import type { Actor } from "@pi-lead-child/core";
import { addActivity } from "./activities.js";
import type { Db } from "./db.js";

export const LIGHT_TASK_DECISION = "light_task";

export function markLightTask(db: Db, itemId: number, actor: Actor = "lead"): void {
  addActivity(db, { itemId, actor, kind: "decision", payload: { decision: LIGHT_TASK_DECISION } });
}

export function isLightTask(db: Db, itemId: number): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM activities WHERE item_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = ? LIMIT 1",
  ).get(itemId, LIGHT_TASK_DECISION));
}

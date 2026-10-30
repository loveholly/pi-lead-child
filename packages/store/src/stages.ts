// 按 kind 分层的状态机与权限矩阵（spec §6.1/§6.2/§6.4）。
// 与旧实现的关键区别：不再有 lead: () => true —— lead 能建、能改、能取消、能代 ack，
// 但不能替用户确认开跑，也不能暂停/恢复。未列出的边一律拒绝（默认 deny）。
//
// 表本身已经搬到 packages/protocol/src/stages.ts：companion 要用同一份矩阵决定给用户
// 显示哪几个动作按钮，内核这边留一份拷贝就等于给漂移留了门（UI 上摆一个点下去 403 的
// 按钮，或者一条合法的边在界面上根本没有入口）。这里只保留内核侧的 API 形状与命名。
import type { Actor, ItemKind, ItemStage } from "@pi-lead-child/core";
import {
  allowedNextStages,
  canTransitionStage,
} from "@pi-lead-child/protocol";

export function canTransition(
  kind: ItemKind, from: ItemStage, to: ItemStage, actor: Actor,
): boolean {
  return canTransitionStage(kind, from, to, actor);
}

export function allowedNext(kind: ItemKind, from: ItemStage): ItemStage[] {
  return allowedNextStages(kind, from);
}

export const TASK_STAGES: ItemStage[] =
  ["draft", "ready", "active", "blocked", "review", "done", "cancelled"];
export const REMINDER_STAGES: ItemStage[] =
  ["scheduled", "fired", "acked", "cancelled"];
export const TERMINAL_STAGES: ItemStage[] = ["done", "acked", "cancelled"];

// 执行计划的读取（工单详情与验收 spec 4.4、5.2、5.11，工单 06）。页面、Lead 和执行 agent 读的是同一份：
// - ticketExecutionPlan：给页面的线上形状（protocol 的 execution-plan.ts），GET /v1/tickets/:id/plan 用它。
// - executionPlanText：同一份计划写成几行字，给 Lead 的 get_ticket。
// - executionPlanPromptSection：执行者每次启动时提示里的一节（children/manager.ts 的 startRequest）。
// 写入在 agent-tools 的 update_ticket_plan，规则在 store 的 execution-plans.ts。
import { redactAndCap, type TicketExecutionPlan } from "@pi-lead-child/protocol";
import { getExecutionPlan, type Db } from "@pi-lead-child/store";

export const NO_EXECUTION_PLAN_TEXT = "执行 agent 没有提交计划。";

// 拼进 Lead 的结果和执行 agent 的提示词，所以有总长度上限（审查 M3）。60 步写满时有几万字。
const PLAN_TEXT_MAX = 4_000;

export function ticketExecutionPlan(db: Db, itemId: number): TicketExecutionPlan | null {
  const plan = getExecutionPlan(db, itemId);
  if (!plan) return null;
  return {
    ticketId: plan.itemId,
    revision: plan.revision,
    attemptId: plan.runId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.steps.map((step) => ({ id: step.id, title: step.title, status: step.status, note: step.note })),
  };
}

// 标题和备注是 agent 写的字，加上引号（JSON 字符串），和系统写的字分得开（审查 M3）。
export function executionPlanText(db: Db, itemId: number): string {
  const plan = getExecutionPlan(db, itemId);
  if (!plan) return NO_EXECUTION_PLAN_TEXT;
  // 跳过的步骤不算没做完：分母不含它，「完成 n/m」只数要做的步骤。
  const planned = plan.steps.filter((step) => step.status !== "skipped");
  const done = planned.filter((step) => step.status === "done").length;
  const text = [
    `第 ${plan.revision} 版，Run #${plan.runId} 提交于 ${plan.updatedAt}（第一版 ${plan.createdAt}）· 完成 ${done}/${planned.length}`,
    ...plan.steps.map((step) =>
      `- [${step.status}] ${step.id}：${JSON.stringify(step.title)}${step.note ? `（备注：${JSON.stringify(step.note)}）` : ""}`),
  ].join("\n");
  const capped = redactAndCap(text, PLAN_TEXT_MAX);
  return capped.truncated ? `${capped.text}…（截断，原文 ${text.length} 字）` : capped.text;
}

// 执行者启动时（新会话、续接、换 runtime 都一样）提示里的计划（审查 H1）。开新会话的 agent 不记得原计划，
// 没有这一节它只能从报错里猜原来的步骤。工单还没有计划时是空字符串。
export function executionPlanPromptSection(db: Db, itemId: number): string {
  if (!getExecutionPlan(db, itemId)) return "";
  return [
    "## 执行计划（系统记录的当前版本）",
    "这张工单已经有执行计划，以这一版为准。用 update_ticket_plan 在它上面更新：保留每一步的 id，"
      + "只改状态、标题或备注变了的步骤，新的步骤加在后面。",
    executionPlanText(db, itemId),
  ].join("\n");
}

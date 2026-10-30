// 工单的执行计划的线上契约（工单详情与验收 spec 4.4、5.2，工单 06）。执行 agent 用 update_ticket_plan 维护它：
// 计划写「怎么做」，验收标准写「要达到什么」。执行中和待验收用同一个列表，只有状态不同。
// - 单独的资源，不放进 TicketSummary：客户端严格校验工单列表，多一个字段旧页面整张列表都加载不出来。
// - GET /v1/tickets/:id/plan 用 tickets:view。执行 agent 还没提交计划时 plan 是 null，界面写「执行 agent 没有提交计划」。
// - 线上用 ticket / attempt，库里是 item / run（wire-vocabulary）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 待做、进行中、完成、跳过、受阻。
export const PlanStepStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"),
  Type.Literal("skipped"), Type.Literal("blocked"),
]);
export type PlanStepStatus = Static<typeof PlanStepStatusSchema>;

// 上限和执行 agent 提交时的校验一致（store 的 PLAN_LIMITS）。
export const ExecutionPlanStepSchema = StrictObject({
  // 稳定的 id：同一步在每一版里 id 都一样，界面可以按它对齐前后两版。
  id: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }),
  // 标题和备注都只有一行：服务端拒绝标题里的换行，把备注里的换行压成空格。
  title: Type.String({ minLength: 1, maxLength: 120 }),
  status: PlanStepStatusSchema,
  // 例如跳过的原因、受阻在哪里。
  note: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
});
export type ExecutionPlanStep = Static<typeof ExecutionPlanStepSchema>;

export const TicketExecutionPlanSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  // 第几版。每次更新加 1；返工的 Run 在原计划上接着更新，不从 1 重新开始。
  revision: Type.Integer({ minimum: 1 }),
  // 提交这一版的 Run。
  attemptId: Type.Integer({ minimum: 1 }),
  // 第一次提交的时间、这一版的时间。
  createdAt: Type.String(),
  updatedAt: Type.String(),
  // 最多 60 步，其中没做完（不是 done、skipped）的最多 30 步。
  steps: Type.Array(ExecutionPlanStepSchema, { minItems: 1, maxItems: 60 }),
});
export type TicketExecutionPlan = Static<typeof TicketExecutionPlanSchema>;

export const TicketExecutionPlanResponseSchema = StrictObject({
  plan: Type.Union([TicketExecutionPlanSchema, Type.Null()]),
});
export type TicketExecutionPlanResponse = Static<typeof TicketExecutionPlanResponseSchema>;

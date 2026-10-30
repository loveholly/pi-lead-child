// 旧客户端的协议（master 04dd07d0，2026-10-22 部署）里的 KernelTicketSchema，原样冻结在这里。
// 工单 09 删掉 reviewPolicy 时，这个版本的 companion 和 plc 还在用：它把 reviewPolicy 当作必填字段，整个对象是严格的。
// kernel-protocol-contract.test.ts 用它核对：新 daemon 发的工单，旧客户端还能接受（审查 M1）。
// 用到的枚举（状态、优先级、编排状态、runtime、用途）这一期没有改，直接从现在的协议导入。删掉 reviewPolicy 的那一版发出以后，这个文件可以删。
import { Type, type TProperties } from "typebox";
import {
  KernelAttemptPurposeSchema, KernelOrchestrationStateSchema, KernelRuntimeIdSchema, TicketPrioritySchema, TicketStatusSchema,
} from "@pi-lead-child/protocol";

const StrictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const KernelTicketSchema04dd07d0 = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  brief: Type.String(),
  body: Type.String(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  project: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  parentTicketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  rootTicketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  createdByAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  orchestrationState: Type.Union([KernelOrchestrationStateSchema, Type.Null()]),
  requestedRuntime: Type.Union([KernelRuntimeIdSchema, Type.Null()]),
  requestedModel: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.Union([KernelAttemptPurposeSchema, Type.Null()]),
  reviewPolicy: Type.Union([
    Type.Literal("manual"), Type.Literal("automatic"), Type.Null(),
  ]),
  verificationPolicy: Type.Optional(Type.Union([
    Type.Literal("independent_reviewer"), Type.Literal("lead_static"), Type.Literal("user"), Type.Null(),
  ])),
  acceptancePolicy: Type.Optional(Type.Union([
    Type.Literal("user_only"), Type.Literal("delegated_to_lead"), Type.Null(),
  ])),
  reworkPolicy: Type.Optional(Type.Union([
    Type.Literal("ask_user"), Type.Literal("automatic"), Type.Null(),
  ])),
  deliveryPolicy: Type.Optional(Type.Union([
    Type.Literal("notify_only"), Type.Literal("continue_workflow"), Type.Null(),
  ])),
  maxDepth: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  maxChildren: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  maxConcurrency: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  tokenBudget: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  costBudgetUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  retryLimit: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  activePlanRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  workdir: Type.Union([Type.String(), Type.Null()]),
  createdBy: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  lastActivityAt: Type.Union([Type.String(), Type.Null()]),
  totalTokens: Type.Integer({ minimum: 0 }),
  totalCostUsd: Type.Number({ minimum: 0 }),
  dueAt: Type.Union([Type.String(), Type.Null()]),
  remindAt: Type.Union([Type.String(), Type.Null()]),
});

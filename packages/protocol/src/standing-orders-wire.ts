// 常设指令的线上契约（设置 → 常设指令，会话里的 StandingOrderChangeConfirm 卡；Lead 事件主干 spec D4，工单 10）。
// - 路由都是 GET 或 POST（网关的 CORS 只放行这两种）：
//   GET  /v1/standing-orders                             清单（每条的最新版本，停用的也列）和等你批准的提议。tickets:view。
//   GET  /v1/standing-orders/:id                         一条指令：最新版本、全部版本、最近的执行记录、它的提议。tickets:view。
//   POST /v1/standing-orders/:id/rollback                用户回滚到某一版：写一个新版本，作者 user，直接生效。tickets:create
//                                                        （「这台设备是主人」，和设置页的其他修改一样）。
//   GET  /v1/standing-order-proposals/:approvalId        Lead 的一个提议（包括已经处理过的）。tickets:view。
//   POST /v1/standing-order-proposals/:approvalId/decision  批准或拒绝。approvals:respond（和审批同一个 scope）。
//   Lead 的工具走不到这些路由，所以「更放开」的修改只能由用户批准。
// - 提议存在 approvals 表里（item_id 为空，tool 是 standing_order.change），用审批号 approvalId 标识。
// - 线上用词：事件的对象写成 ticketId、attemptId（存储层叫 item、run，见 core 的 wire-vocabulary 和 MEMORY 里的边界说明）。
//   事件类型 kind 是事件日志自己的词汇（spec D1），原样给出。
// - condition、action、limits、definition 原样给出（形状见 standing-orders.ts），这里不再校验：库里不合格的旧版本也要能显示。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(schema: T) =>
  Type.Union([schema, Type.Null()]);

const LevelSchema = Type.Union([
  Type.Literal("record"), Type.Literal("digest"), Type.Literal("auto"), Type.Literal("tell"), Type.Literal("interrupt"),
]);

export const StandingOrderIdSchema = Type.String({ pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*$", maxLength: 120 });

export const StandingOrderDtoSchema = StrictObject({
  id: StandingOrderIdSchema,
  // 0 表示库里读不到，用的是代码里的种子。
  version: Type.Integer({ minimum: 0 }),
  title: Type.String(),
  priority: Type.Integer(),
  status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
  author: Type.Union([Type.Literal("system"), Type.Literal("lead"), Type.Literal("user")]),
  approvedBy: Nullable(Type.String()),
  reason: Type.String(),
  createdAt: Type.String(),
  seedRevision: Nullable(Type.Integer()),
  condition: Type.Unknown(),
  action: Type.Unknown(),
  limits: Type.Unknown(),
  escalateTo: Type.Union([LevelSchema, Type.Null()]),
  // 这条指令定的级别（level 动作，或者规则带的 level）。不定级别时是 null。
  level: Type.Union([LevelSchema, Type.Null()]),
  // 规则类指令的规则名。定级别的指令是 null。
  rule: Nullable(Type.String()),
});
export type StandingOrderDto = Static<typeof StandingOrderDtoSchema>;

export const StandingOrderChangeFindingSchema = StrictObject({
  tier: Type.Union([Type.Literal("conservative"), Type.Literal("permissive"), Type.Literal("forbidden")]),
  aspect: Type.String(),
  detail: Type.String(),
  hardRule: Type.Optional(Type.String()),
});
export type StandingOrderChangeFindingDto = Static<typeof StandingOrderChangeFindingSchema>;

export const StandingOrderProposalDtoSchema = StrictObject({
  approvalId: Type.Integer({ minimum: 1 }),
  orderId: StandingOrderIdSchema,
  op: Type.Union([
    Type.Literal("create"), Type.Literal("update"), Type.Literal("disable"), Type.Literal("enable"), Type.Literal("rollback"),
  ]),
  // pending 等你决定；approved 已生效；rejected 你没有批准；expired 过期了，或者指令又变了（voidedReason）。
  state: Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("expired")]),
  // 系统作废的原因：superseded（指令在这之后又写了新版本）、hard_rule（批准时碰到硬性规则）。其余为 null。
  voidedReason: Nullable(Type.String()),
  // 一句话说明改了什么。
  summary: Type.String(),
  // Lead 写的原因。
  reason: Type.String(),
  // 提议里的标题。
  title: Type.String(),
  // 提议时这条指令的最新版本。新增时是 null。
  baseVersion: Nullable(Type.Integer({ minimum: 0 })),
  // 批准后写成的版本。
  appliedVersion: Nullable(Type.Integer({ minimum: 1 })),
  rollbackTo: Nullable(Type.Integer({ minimum: 1 })),
  proposedStatus: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
  definition: Type.Unknown(),
  findings: Type.Array(StandingOrderChangeFindingSchema),
  requestedAt: Type.String(),
  expiresAt: Type.String(),
  resolvedBy: Nullable(Type.String()),
  resolvedAt: Nullable(Type.String()),
});
export type StandingOrderProposalDto = Static<typeof StandingOrderProposalDtoSchema>;

// 一次执行记录：事件日志里分诊依据指向这条指令的一个事件。
export const StandingOrderExecutionDtoSchema = StrictObject({
  seq: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  level: Nullable(Type.String()),
  // 事件的对象：ticket:77、attempt:91、reminder:83、chat:main……（存储层的 run:<id> 在线上写成 attempt:<id>）。
  subject: Type.String(),
  ticketId: Nullable(Type.Integer({ minimum: 1 })),
  attemptId: Nullable(Type.Integer({ minimum: 1 })),
  summary: Type.String(),
  receivedAt: Type.String(),
  disposition: Nullable(Type.String()),
  // 依据的是这条指令的哪一版（0 是代码里的种子）。
  version: Type.Integer({ minimum: 0 }),
  // level：这条指令给它定的级别；其余是起作用的方式（inbox_merged、merged_root_cause、escalate_to_tell……）。
  effect: Type.String(),
});
export type StandingOrderExecutionDto = Static<typeof StandingOrderExecutionDtoSchema>;

export const StandingOrderListResponseSchema = StrictObject({
  items: Type.Array(StandingOrderDtoSchema),
  // 等你决定的提议。
  proposals: Type.Array(StandingOrderProposalDtoSchema),
});
export type StandingOrderListResponse = Static<typeof StandingOrderListResponseSchema>;

export const StandingOrderDetailResponseSchema = StrictObject({
  order: StandingOrderDtoSchema,
  // 全部版本，从旧到新。
  versions: Type.Array(StandingOrderDtoSchema),
  // 最近的执行记录，从新到旧。
  executions: Type.Array(StandingOrderExecutionDtoSchema),
  // 这条指令最近的提议，从新到旧。
  proposals: Type.Array(StandingOrderProposalDtoSchema),
});
export type StandingOrderDetailResponse = Static<typeof StandingOrderDetailResponseSchema>;

export const StandingOrderRollbackRequestSchema = StrictObject({ version: Type.Integer({ minimum: 1 }) });
export type StandingOrderRollbackRequest = Static<typeof StandingOrderRollbackRequestSchema>;

export const StandingOrderProposalResponseSchema = StrictObject({
  proposal: StandingOrderProposalDtoSchema,
  // 这条指令现在的最新版本。新增的指令还没批准时是 null。
  order: Type.Union([StandingOrderDtoSchema, Type.Null()]),
});
export type StandingOrderProposalResponse = Static<typeof StandingOrderProposalResponseSchema>;

export const StandingOrderProposalDecisionRequestSchema = StrictObject({ approve: Type.Boolean() });
export type StandingOrderProposalDecisionRequest = Static<typeof StandingOrderProposalDecisionRequestSchema>;

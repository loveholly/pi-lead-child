import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { KernelCheckpointSchema } from "./checkpoints.ts";
import { KernelInterventionRefSchema } from "./interventions.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const KERNEL_WORK_ITEM_GROUPS = [
  "needs_intervention",
  "running",
  "review",
  "completed",
] as const;

export const KernelWorkItemGroupSchema = Type.Union([
  Type.Literal("needs_intervention"),
  Type.Literal("running"),
  Type.Literal("review"),
  Type.Literal("completed"),
]);
export type KernelWorkItemGroup = Static<typeof KernelWorkItemGroupSchema>;

export const KernelTicketTimingSchema = StrictObject({
  firstStartedAt: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  statusChangedAt: Type.Union([Type.String(), Type.Null()]),
  computedAt: Type.String(),
  elapsedMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  activeExecutionMs: Type.Number({ minimum: 0 }),
  statusDurationMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
export type KernelTicketTiming = Static<typeof KernelTicketTimingSchema>;

export const KernelActiveExecutionSchema = StrictObject({
  attemptId: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("executor"), Type.Literal("reviewer")]),
  runtime: Type.Union([
    Type.Literal("pi"),
    Type.Literal("codex"),
    Type.Literal("claude"),
  ]),
  // 'paused' 是 Run 的状态，不是 item 的（kernel spec §3.2）：暂停中的 Run 仍是
  // 这张工作台的活跃执行，UI 需要看到它，否则暂停会表现成"执行凭空消失"。
  state: Type.Union([
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("settled"),
    Type.Literal("crashed"),
    Type.Literal("stopped"),
  ]),
  model: Type.Union([Type.String(), Type.Null()]),
  externalSessionId: Type.Union([Type.String(), Type.Null()]),
});
export type KernelActiveExecution = Static<typeof KernelActiveExecutionSchema>;

// timing 是**可选**的，而不是"没有就投一个全 null 的壳"（kernel spec §11）。
// 执行类面板的数据源是 Run：一个从没跑过的 item（提醒、draft、确认了还没开跑的任务）
// 根本不存在这段耗时。投空壳会被下游读成"有这类数据，只是现在为空"，于是 UI 照样把
// 一排空脚手架渲染出来——那正是本期要修掉的第 2 个诉求。字段缺席才表达得了"压根没有"。
export const KernelTicketWorkItemSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  timing: Type.Optional(KernelTicketTimingSchema),
  activeExecution: Type.Union([KernelActiveExecutionSchema, Type.Null()]),
  pendingInterventionCount: Type.Integer({ minimum: 0 }),
  latestCheckpointId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type KernelTicketWorkItem = Static<typeof KernelTicketWorkItemSchema>;

export const KernelTicketWorkItemListQuerySchema = StrictObject({
  ticket_id: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 200 })),
});
export type KernelTicketWorkItemListQuery = Static<typeof KernelTicketWorkItemListQuerySchema>;

export const KernelTicketWorkItemListResponseSchema = StrictObject({
  items: Type.Array(KernelTicketWorkItemSchema),
});
export type KernelTicketWorkItemListResponse = Static<typeof KernelTicketWorkItemListResponseSchema>;

export function createKernelTicketWorkbenchSchema<
  TTicket extends TSchema,
  TAttempt extends TSchema,
>(ticketSchema: TTicket, attemptSchema: TAttempt) {
  // timing / latestCheckpoints 同样可选，理由同 KernelTicketWorkItemSchema：
  // 没有 Run 就没有这两样东西，空数组会被读成"有但为空"。
  return StrictObject({
    ticket: ticketSchema,
    timing: Type.Optional(KernelTicketTimingSchema),
    activeAttempt: Type.Union([attemptSchema, Type.Null()]),
    children: Type.Array(ticketSchema),
    latestCheckpoints: Type.Optional(Type.Array(KernelCheckpointSchema, { maxItems: 50 })),
    interventionRefs: Type.Array(KernelInterventionRefSchema),
  });
}

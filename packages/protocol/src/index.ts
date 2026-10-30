import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { KernelCheckpointSchema } from "./checkpoints.ts";
import { KernelInterventionRefSchema } from "./interventions.ts";
import { PROTOCOL_VERSION } from "./version.ts";
import { createKernelTicketWorkbenchV2Schema } from "./prototype-fidelity.ts";
import { createKernelTicketWorkbenchSchema } from "./workbench.ts";
import { ConversationToolCallSchema } from "./conversation-tool-calls.ts";
import { UiSurfacePlacementSchema } from "./ui-surfaces.ts";
import {
  TICKET_REPLY_ACTIONS_OPT_IN, TICKET_REPLY_ACTIONS_RESOURCE, TicketChatAnswererSchema, TicketChatResumeSchema,
  TicketReplyActionIdSchema,
} from "./ticket-chat.ts";
import { LEAD_QUEUE_OPT_IN, LEAD_QUEUE_RESOURCE } from "./lead-queue.ts";
import { TurnPlacementSchema } from "./lead-follow-ups.ts";
import { LEAD_ACTIVITY_OPT_IN, LEAD_ACTIVITY_RESOURCE } from "./lead-activity.ts";
import { ReminderSettingsSchema } from "./reminders.ts";
import { UI_ACTION_INPUT_SCHEMAS } from "./ui-actions.ts";
import { ChatImageRefSchema, ChatImagesInputSchema } from "./chat-images.ts";

export { PROTOCOL_VERSION } from "./version.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

import { BindingDtoSchema, ScopeSchema } from "./scopes.ts";
import { KernelRuntimeIdSchema } from "./runtime-ids.ts";
export * from "./scopes.ts";
export * from "./runtime-ids.ts";

// kind 区分的不是标签而是「完成的定义」（kernel spec §3.1）：
// reminder 的完成 = 我确认了；task 的完成 = 有人/有 agent 把活干了。
// 由此推出两条硬约束：reminder 永远不能拥有 Run；两种 kind 各有独立状态机。kind 不可变。
export const TicketKindSchema = Type.Union([
  Type.Literal("task"), Type.Literal("reminder"),
]);
export type TicketKind = Static<typeof TicketKindSchema>;
export const TicketWorkflowKindSchema = Type.Union([
  Type.Literal("generic"), Type.Literal("coding"),
]);
export type TicketWorkflowKind = Static<typeof TicketWorkflowKindSchema>;

// stage 按 kind 分层（kernel spec §6.1/§6.2）。线上仍是一个 status 字段，
// 但两台状态机的取值互不重叠（'cancelled' 除外），所以 union 里不会出现歧义。
export const TaskStageSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("ready"), Type.Literal("active"),
  Type.Literal("blocked"), Type.Literal("review"), Type.Literal("done"),
  Type.Literal("cancelled"),
]);
export type TaskStage = Static<typeof TaskStageSchema>;

export const ReminderStageSchema = Type.Union([
  Type.Literal("scheduled"), Type.Literal("fired"), Type.Literal("acked"),
  Type.Literal("cancelled"),
]);
export type ReminderStage = Static<typeof ReminderStageSchema>;

export const TicketStatusSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("ready"), Type.Literal("active"),
  Type.Literal("blocked"), Type.Literal("review"), Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("scheduled"), Type.Literal("fired"), Type.Literal("acked"),
]);
export type TicketStatus = Static<typeof TicketStatusSchema>;

export const TicketPrioritySchema = Type.Union([
  Type.Literal("urgent"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low"),
]);
export type TicketPriority = Static<typeof TicketPrioritySchema>;

export const RuntimeStateSchema = Type.Union([
  Type.Literal("idle"), Type.Literal("starting"), Type.Literal("running"),
  Type.Literal("stale"), Type.Literal("blocked"),
]);

export const TicketWorkflowStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("waiting_dependency"),
  Type.Literal("waiting_capability"),
  Type.Literal("continuing"),
]);
export type TicketWorkflowState = Static<typeof TicketWorkflowStateSchema>;

// stage='review' 不是一种状态，而是至少六种（工单 #66 复盘）：核查中 / 等用户 /
// 核查通过待交付 / 核查不通过待返工 / 证据冲突 / 返工用尽或自我恢复失败的卡死态。
// 把它们压成一句"待验收"的代价在 #66 上是实测过的：一张返工额度已用尽、最新的交付从来
// 没被核查过的工单，界面上和一张干干净净等人点头的工单长得一模一样，而"验收通过"按钮就摆在
// 旁边。所以 rework_exhausted 是独立取值，不是 review_failed 的一种。
// （#66 后来查明不是"成果登记不上"：那是把两次对话 Run 误当成了交付，见 canRequestReview。）
export const TicketReviewStateSchema = StrictObject({
  state: Type.Union([
    Type.Literal("independent_review"),
    Type.Literal("waiting_user"),
    Type.Literal("review_passed"),
    Type.Literal("review_failed"),
    Type.Literal("evidence_conflict"),
    Type.Literal("rework_exhausted"),
  ]),
  label: Type.String(),
  // 当前**有效**的那次独立核查。最后一次核查已被之后的交付作废时为 null，作废的那次见 supersededReview。
  // （以前卡死态里这里放的是作废的核查，于是卡片一边写"独立核查：已产生"，一边写"验证状态未知"。）
  reviewerAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  // 当前**真实**验证状态：null 就是"未知"，不是"还没轮到"。一次过期的 PASS/FAIL
  // （之后又跑过 executor）在这里恒为 null，判断依据留在 reason 里。
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  // 可选而不是必填：既有读端（含 companion 的既有 fixture）不该因为多两个事实而全部失效。
  reworkCyclesUsed: Type.Optional(Type.Integer({ minimum: 0 })),
  maxReworkCycles: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  // "runtime 试着从最新一次交付的输出里恢复终态，但恢复本身失败了"。它与返工用尽是两件
  // 独立的事。对话 Run 不是交付，它没有成果不算恢复失败。
  outcomeRecoveryFailed: Type.Optional(Type.Boolean()),
  reviewerPreHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reviewerPostHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reviewerHashState: Type.Optional(Type.Union([
    Type.Literal("matching"), Type.Literal("drifted"), Type.Literal("missing"), Type.Literal("unknown"),
  ])),
  // 最后一次核查已被之后的交付作废：它是哪个 reviewer、结论是什么、核查的是哪次交付、
  // 被哪次交付作废。没有作废的核查时为 null 或缺省。
  supersededReview: Type.Optional(Type.Union([
    StrictObject({
      reviewerAttemptId: Type.Integer({ minimum: 1 }),
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      reviewedRunId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      supersededByRunId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    Type.Null(),
  ])),
  // 这张卡片说的是哪一次交付：最新的交付 Run（对话 Run 和修复回合不算交付）。
  deliveryRunId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  // 最新的交付已经结束、进了 review，却没有任何核查在路上。true 时用户可以手动派发独立核查：
  // POST /v1/tickets/:id/request-review。要求独立核查的工单出现它，说明工单卡住了（工单 #66）；
  // 由用户验收的工单出现它，只是多一个可选动作。
  // 2026-10-20 起排着的核查被挂起（没有能用的核查员）时也是 true：再点一次按现在能用的核查员重新选。
  canRequestReview: Type.Optional(Type.Boolean()),
  // 独立核查走到哪一步：排队（queued）、排队但被挂起（suspended，原因写在 reason）、
  // 正在跑（running）。null 表示没有核查在路上。
  reviewProgress: Type.Optional(Type.Union([
    Type.Literal("queued"), Type.Literal("suspended"), Type.Literal("running"), Type.Null(),
  ])),
});
export type TicketReviewState = Static<typeof TicketReviewStateSchema>;

export const TicketExecutionStateSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("execution"), Type.Literal("rework"), Type.Literal("recovery"),
  ]),
  state: Type.Union([
    Type.Literal("requested"),
    Type.Literal("waiting_dispatch"),
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
  ]),
  label: Type.String(),
  dispatchRequestId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
});
export type TicketExecutionState = Static<typeof TicketExecutionStateSchema>;

export const WorkspaceControlActionIdSchema = Type.Union([
  Type.Literal("release"), Type.Literal("cleanup"),
]);
export type WorkspaceControlActionId = Static<typeof WorkspaceControlActionIdSchema>;

export const WorkspaceModeSchema = Type.Union([Type.Literal("shared"), Type.Literal("isolated")]);
export const WorkspaceKindSchema = Type.Union([
  Type.Literal("primary"), Type.Literal("isolated_child"),
  Type.Literal("reviewer"), Type.Literal("experiment"),
]);
export const WorkspaceStateSchema = Type.Union([
  Type.Literal("requested"), Type.Literal("provisioning"), Type.Literal("active"),
  Type.Literal("idle"), Type.Literal("review_hold"), Type.Literal("pending_integration"),
  Type.Literal("released"), Type.Literal("cleaning"), Type.Literal("cleaned"),
  Type.Literal("archived"), Type.Literal("failed"), Type.Literal("blocked"),
]);

// 安全投影：Companion 只需要知道可执行的 action，不应凭 workspace/path 自己推断，
// 也不把服务器文件系统路径、repo root 或 branch 下发给远程 binding。
export const TicketWorkspaceControlSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ownerTicketId: Type.Integer({ minimum: 1 }),
  mode: WorkspaceModeSchema,
  kind: WorkspaceKindSchema,
  state: WorkspaceStateSchema,
  mergeStatus: Type.Optional(Type.Union([
    Type.Literal("n/a"), Type.Literal("pending"), Type.Literal("merged"),
    Type.Literal("conflict"), Type.Literal("abandoned"),
  ])),
  retainedUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  inherited: Type.Boolean(),
  availableActions: Type.Array(WorkspaceControlActionIdSchema),
});
export type TicketWorkspaceControl = Static<typeof TicketWorkspaceControlSchema>;

// 工单节点（左栏改版阶段 3）：截止、提测、发布、核查、自定义。
export const MilestoneKindSchema = Type.Union([
  Type.Literal("due"), Type.Literal("test_handoff"), Type.Literal("release"), Type.Literal("review"), Type.Literal("custom"),
]);
export type MilestoneKind = Static<typeof MilestoneKindSchema>;
export const MilestoneStateSchema = Type.Union([
  Type.Literal("planned"), Type.Literal("done"), Type.Literal("missed"), Type.Literal("cancelled"),
]);
export type MilestoneState = Static<typeof MilestoneStateSchema>;
export const MilestoneActorSchema = Type.Union([
  Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system"),
]);
export type MilestoneActor = Static<typeof MilestoneActorSchema>;
/** 节点类型的显示名。custom 节点有自己的显示名，这里的「节点」只是兜底。 */
export const MILESTONE_KIND_LABELS: Record<MilestoneKind, string> = {
  due: "截止", test_handoff: "提测", release: "发布", review: "核查", custom: "节点",
};
// 工单最近的一个未完成节点（任何类型）。工单行、项目卡片、收件箱都读它。
export const TicketNextMilestoneSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  kind: MilestoneKindSchema,
  label: Type.String(),
  at: Type.String(),
  allDay: Type.Boolean(),
});
export type TicketNextMilestone = Static<typeof TicketNextMilestoneSchema>;

export const TicketSummarySchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  // 最近的一个未完成节点（阶段 3）。没有节点时不出现。
  nextMilestone: Type.Optional(TicketNextMilestoneSchema),
  // 显示用的短标题（Lead 写，原标题不可读时）。列表和收件箱优先用它，详情同时显示原标题。
  displayTitle: Type.Optional(Type.String()),
  // 进入当前阶段的时间（items.stage_changed_at）：工单行右边的「停了多久」。
  stageChangedAt: Type.Optional(Type.String()),
  summary: Type.String(),
  // kind 决定"完成"的定义：reminder 是我确认一下就算完，task 要有人干完（kernel spec §3.1）。
  // 它是不可变的，UI 可以据此分流列表与详情页，不必再猜。
  kind: TicketKindSchema,
  workflowKind: Type.Optional(TicketWorkflowKindSchema),
  // stage 是 status 的新名字。两个字段值恒相同：status 留着是为了不一次性打断 companion，
  // **新代码一律读 stage**，status 视为 deprecated（kernel spec §5 的命名映射表）。
  stage: TicketStatusSchema,
  /** @deprecated 用 stage。两者恒等，保留只为兼容尚未迁移的读端。 */
  status: TicketStatusSchema,
  // 派生字段（kernel spec §11），不落库：该 item 是否至少存在过一个 Run。
  // 执行类面板（timing/checkpoints/artifacts/logs/cost）的数据源是 Run，UI 必须据此
  // 决定渲不渲染。判据刻意不是 kind==='task'——一个已确认但还没开跑的任务同样什么都没有。
  hasRun: Type.Boolean(),
  priority: TicketPrioritySchema,
  project: Type.Union([Type.String(), Type.Null()]),
  dueAt: Type.Union([Type.String(), Type.Null()]),
  // 仅 task：在此之前不浮现在默认视图里（kernel spec §7.3）。reminder 恒为 null。
  deferUntil: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
  parentTicketId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  // 与 KernelTicketSchema 同因：reminder 恒为 NULL，task 在 insert-then-update 两步之间也是。
  rootTicketId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  worklistVisibility: Type.Optional(Type.Union([
    Type.Literal("primary"),
    Type.Literal("background"),
  ])),
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
  workflowState: Type.Optional(TicketWorkflowStateSchema),
  reviewState: Type.Optional(TicketReviewStateSchema),
  executionState: Type.Optional(TicketExecutionStateSchema),
  runtime: StrictObject({
    state: RuntimeStateSchema,
    lastActivityAt: Type.Union([Type.String(), Type.Null()]),
    activeAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }),
  attention: StrictObject({
    pendingApprovalCount: Type.Integer({ minimum: 0 }),
    // 只算要用户行动的 blocker（2026-10-15 起，先交给 Lead 的不算，升级以后才算）。
    blockerCount: Type.Integer({ minimum: 0 }),
    // Lead 正在处理这张工单上的异常（先交给 Lead、还没处理完、也没升级）。只在为 true 时出现。
    leadHandling: Type.Optional(Type.Literal(true)),
    // 等用户回答的决策请求（阻塞、待处理、受众包含用户）有几条。只在大于 0 时出现。
    // 有它时轮到用户做的就是回答这条决定（ticketNeedsUser 的「待你决定」），各界面不再按阶段另推荐动作。
    pendingDecisionCount: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  workspace: Type.Optional(TicketWorkspaceControlSchema),
});
export type TicketSummary = Static<typeof TicketSummarySchema>;

// POST /v1/tickets/:id/request-review 的请求体（2026-10-20 加 runtime）。都可以不给，旧客户端发 {} 照旧。
// runtime：用户选的核查员。有排着（含挂起）的核查就改它的核查员，没有就用它新排一条；核查正在跑、
// 这个 runtime 被停用或者有没关闭的故障时，返回 409 和原因。
export const TicketReviewRequestSchema = StrictObject({
  actor: Type.Optional(Type.Literal("user")),
  runtime: Type.Optional(KernelRuntimeIdSchema),
});
export type TicketReviewRequest = Static<typeof TicketReviewRequestSchema>;

// GET /v1/tickets/:id/reviewer（tickets:view，2026-10-20）：这张工单的核查员和可选的核查员。
// 单独一个只读接口，不放进 TicketSummary：客户端严格校验整个工单列表，加一个字段旧页面就整张列表加载失败。
export const TicketReviewerOptionSchema = StrictObject({
  runtime: KernelRuntimeIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 60 }),
  // 现在能不能当核查员：没被用户停用，profile 上没有没关闭的故障。
  available: Type.Boolean(),
  // 不能用时的原因，例如「用户在设置里停用了 Codex（设置 → 执行器）。」「Codex 账号已停用（故障 #3）」。
  reason: Type.Optional(Type.String()),
});
export type TicketReviewerOption = Static<typeof TicketReviewerOptionSchema>;

export const TicketReviewerInfoSchema = StrictObject({
  // 排队、挂起或正在跑的核查用的核查员；没有时是下一次会用的核查员。提醒这类不是任务的工单为 null。
  // 工单 09 加了四个可选字段（旧的 daemon 不发）：
  //   - model、effort：这次核查的模型和推理强度；还没定（派发时由 CLI 的配置决定）时为 null。
  //   - chosenBy：Lead 或用户选的（建单时一起选，或者换过），还是系统选的。
  //   - sameAsExecutor：和执行者是同一种 agent。系统优先选和执行者不同的 runtime，没有别的可用时才相同，界面上要写明（D3）。
  reviewer: Type.Union([
    StrictObject({
      runtime: KernelRuntimeIdSchema,
      displayName: Type.String({ minLength: 1, maxLength: 60 }),
      model: Type.Optional(Type.Union([Type.String({ maxLength: 240 }), Type.Null()])),
      effort: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
      chosenBy: Type.Optional(Type.Union([Type.Literal("lead"), Type.Literal("user"), Type.Literal("system")])),
      sameAsExecutor: Type.Optional(Type.Boolean()),
    }),
    Type.Null(),
  ]),
  // 所有登记的 runtime，按选核查员的顺序：能跑命令的在前。
  options: Type.Array(TicketReviewerOptionSchema, { maxItems: 16 }),
  // 现在能不能换核查员（POST /v1/tickets/:id/request-review 带 runtime）：工单在 review，核查没在跑，
  // 有排着的核查或者有要核查的交付。
  canChange: Type.Boolean(),
  // 核查走到哪一步，和 reviewState.reviewProgress 同一个判断。null 表示没有核查在路上。
  progress: Type.Union([
    Type.Literal("queued"), Type.Literal("suspended"), Type.Literal("running"), Type.Null(),
  ]),
});
export type TicketReviewerInfo = Static<typeof TicketReviewerInfoSchema>;

// POST /v1/tickets/:id/request-review 的响应：派出的那条 reviewer 请求，以及它核查的是哪次交付。
export const TicketReviewRequestResultSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  dispatchRequestId: Type.Integer({ minimum: 1 }),
  deliveryRunId: Type.Integer({ minimum: 1 }),
  ticket: Type.Union([TicketSummarySchema, Type.Null()]),
});
export type TicketReviewRequestResult = Static<typeof TicketReviewRequestResultSchema>;

export const WorkspaceActionResultSchema = StrictObject({
  workspaceId: Type.Integer({ minimum: 1 }),
  ownerTicketId: Type.Integer({ minimum: 1 }),
  action: WorkspaceControlActionIdSchema,
  status: Type.Union([
    Type.Literal("released"), Type.Literal("pending_integration"),
    Type.Literal("already_released"), Type.Literal("cleaned"), Type.Literal("already_cleaned"),
  ]),
  ticket: Type.Union([TicketSummarySchema, Type.Null()]),
});
export type WorkspaceActionResult = Static<typeof WorkspaceActionResultSchema>;

export const TicketRelationKindSchema = Type.Union([
  Type.Literal("parent_of"), Type.Literal("child_of"),
  Type.Literal("depends_on"), Type.Literal("blocks"),
  Type.Literal("implements"), Type.Literal("implemented_by"),
  Type.Literal("duplicates"), Type.Literal("duplicated_by"),
  Type.Literal("supersedes"), Type.Literal("superseded_by"),
  Type.Literal("relates_to"),
]);
export type TicketRelationKind = Static<typeof TicketRelationKindSchema>;

export const TicketRelationExecutionGateSchema = Type.Union([
  Type.Literal("none"), Type.Literal("target_done"),
]);
export type TicketRelationExecutionGate = Static<typeof TicketRelationExecutionGateSchema>;

export const TicketRelationSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  kind: TicketRelationKindSchema,
  // 关系来自哪张工单的账本。它让 UI 可以引用别的工单，而不会把那张工单的事实
  // 伪装成当前工单的历史。
  sourceTicketId: Type.Integer({ minimum: 1 }),
  targetTicketId: Type.Optional(Type.Integer({ minimum: 1 })),
  relationId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  source: Type.Union([
    Type.Literal("tree"), Type.Literal("ticket_relations"),
  ]),
  executionGate: Type.Optional(Type.Union([TicketRelationExecutionGateSchema, Type.Null()])),
  active: Type.Optional(Type.Boolean()),
  createdBy: Type.Optional(Type.Union([
    Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system"),
    Type.Null(),
  ])),
  createdByAttemptId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  createdAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  revokedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  revokedBy: Type.Optional(Type.Union([
    Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system"),
    Type.Null(),
  ])),
  revokeReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type TicketRelation = Static<typeof TicketRelationSchema>;

export const LinkTicketRelationRequestSchema = StrictObject({
  targetTicketId: Type.Integer({ minimum: 1 }),
  relationType: TicketRelationKindSchema,
  executionGate: Type.Optional(TicketRelationExecutionGateSchema),
  reason: Type.String({ minLength: 1, maxLength: 20_000 }),
});
export type LinkTicketRelationRequest = Static<typeof LinkTicketRelationRequestSchema>;

export const TicketRelationMutationResultSchema = StrictObject({
  status: Type.Union([
    Type.Literal("created"), Type.Literal("existing"),
    Type.Literal("revoked"), Type.Literal("already_revoked"),
  ]),
  relationId: Type.Integer({ minimum: 1 }),
  sourceTicketId: Type.Integer({ minimum: 1 }),
  targetTicketId: Type.Integer({ minimum: 1 }),
  relationType: TicketRelationKindSchema,
  executionGate: Type.Optional(TicketRelationExecutionGateSchema),
  requestedRelationType: Type.Optional(TicketRelationKindSchema),
  active: Type.Boolean(),
  risks: Type.Array(Type.String()),
  schedulingImpact: Type.Union([Type.String(), Type.Null()]),
  canonicalImpact: Type.Union([Type.String(), Type.Null()]),
});
export type TicketRelationMutationResult = Static<typeof TicketRelationMutationResultSchema>;

export const RevokeTicketRelationRequestSchema = StrictObject({
  reason: Type.String({ minLength: 1, maxLength: 20_000 }),
});
export type RevokeTicketRelationRequest = Static<typeof RevokeTicketRelationRequestSchema>;

export const TicketDetailSchema = StrictObject({
  ticket: TicketSummarySchema,
  brief: Type.String(),
  body: Type.String(),
  workdir: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  totalTokens: Type.Integer({ minimum: 0 }),
  totalCostUsd: Type.Number({ minimum: 0 }),
  remindAt: Type.Union([Type.String(), Type.Null()]),
  createdBy: Type.Optional(Type.Union([
    Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system"),
  ])),
  relations: Type.Optional(Type.Array(TicketRelationSchema)),
  // 工单对话交给执行 agent、又没有 Run 在跑时，续接的是哪一个已结束的会话（工单 08）。没有可续接的会话时是 null。
  chatResume: Type.Optional(Type.Union([TicketChatResumeSchema, Type.Null()])),
  // 提醒的设置（工单 07）：级别、提前提醒、没确认时的重复推送、关联的工单。只有提醒有。
  reminder: Type.Optional(ReminderSettingsSchema),
});
export type TicketDetail = Static<typeof TicketDetailSchema>;

export const ActivitySchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system")]),
  kind: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
  sessionCursor: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type ActivityDto = Static<typeof ActivitySchema>;

// Run 的生命周期与 Item 的 stage 相互独立（kernel spec §3.2/§6.3）：'paused' 只描述 Run，
// item 在暂停期间仍停在 active，因此暂停不需要新增任何 stage。
export const AttemptStateSchema = Type.Union([
  Type.Literal("starting"), Type.Literal("running"), Type.Literal("paused"),
  Type.Literal("settled"), Type.Literal("crashed"), Type.Literal("stopped"),
]);
export type AttemptState = Static<typeof AttemptStateSchema>;

export const AttemptSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("executor"), Type.Literal("reviewer")]),
  state: AttemptStateSchema,
  model: Type.Union([Type.String(), Type.Null()]),
  // Lead 或内核给这次 Run 选的 effort（2026-10-15）。可选：旧服务端不发这个字段。
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  runtime: Type.Optional(Type.Union([
    Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude"),
  ])),
  purpose: Type.Optional(Type.Union([
    Type.Literal("execution"), Type.Literal("review"), Type.Literal("integration"),
    Type.Literal("learning"), Type.Literal("conversation"),
  ])),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  errorCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  startedAt: Type.String(),
  endedAt: Type.Union([Type.String(), Type.Null()]),
});
export type AttemptDto = Static<typeof AttemptSchema>;

// 项目的数字和按项目筛选后的工单 tab 一样：同一组工单（根工单，加上需要你的子工单；提醒不算），
// 同一条规则（ticketTurn）。字段名是早先定的，含义以这里为准。
export const ProjectSummarySchema = StrictObject({
  id: Type.String(),
  name: Type.String(),
  // 工单数，含已结束的。
  ticketCount: Type.Integer({ minimum: 0 }),
  // 在执行（ticketTurn = running）。
  runningCount: Type.Integer({ minimum: 0 }),
  // 停在 review、不等你的：核查在路上或还没派发。
  reviewCount: Type.Integer({ minimum: 0 }),
  // 等你（ticketTurn = user，和 ticketNeedsUser 一致），不只是 stage = blocked。
  blockedCount: Type.Integer({ minimum: 0 }),
  nearestDueAt: Type.Union([Type.String(), Type.Null()]),
});
export type ProjectSummary = Static<typeof ProjectSummarySchema>;

// 项目卡片（左栏改版阶段 2）。GET /v1/projects/overview。新 schema，不改 ProjectSummarySchema。
// counts 和按项目筛选后的工单 tab 是同一组工单（根工单，加上需要你的子工单）、同一条规则（ticketTurn）。
export const ProjectOverviewSchema = StrictObject({
  // 项目 id；没有项目的工单归在 "unknown"。
  id: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  counts: StrictObject({
    user: Type.Integer({ minimum: 0 }),
    running: Type.Integer({ minimum: 0 }),
    lead: Type.Integer({ minimum: 0 }),
    queued: Type.Integer({ minimum: 0 }),
    ended: Type.Integer({ minimum: 0 }),
  }),
  // Lead 对这个项目的一句话（projects.summary）和它最后一次改写的时间；没写过为 null。
  leadStatus: Type.Union([StrictObject({ text: Type.String(), at: Type.String() }), Type.Null()]),
  // 项目里任何工单（含子工单）最后一次有动静的时间；从来没有为 null。
  lastActivityAt: Type.Union([Type.String(), Type.Null()]),
  // 没结束的工单里最近的未完成节点（任何类型）。
  nextMilestone: Type.Union([StrictObject({
    ticketId: Type.Integer({ minimum: 1 }), title: Type.String(), kind: MilestoneKindSchema,
    label: Type.String(), at: Type.String(), allDay: Type.Boolean(),
  }), Type.Null()]),
  // 累计花费：项目里所有工单（含子工单、已结束的）。
  spend: StrictObject({ costUsd: Type.Number({ minimum: 0 }), tokens: Type.Integer({ minimum: 0 }) }),
});
export type ProjectOverview = Static<typeof ProjectOverviewSchema>;
export const ProjectOverviewListResponseSchema = StrictObject({ items: Type.Array(ProjectOverviewSchema) });

export const KernelAttemptPurposeSchema = Type.Union([
  Type.Literal("execution"), Type.Literal("review"), Type.Literal("integration"),
  Type.Literal("learning"), Type.Literal("conversation"),
]);
export type KernelAttemptPurpose = Static<typeof KernelAttemptPurposeSchema>;

export const KernelOrchestrationStateSchema = Type.Union([
  Type.Literal("none"), Type.Literal("planning"), Type.Literal("waiting"),
  Type.Literal("integrating"), Type.Literal("failed"),
]);
export type KernelOrchestrationState = Static<typeof KernelOrchestrationStateSchema>;

export const KernelProjectRepositorySchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  projectId: Type.Integer({ minimum: 1 }),
  repoRoot: Type.String(),
  remoteUrl: Type.Union([Type.String(), Type.Null()]),
  repoName: Type.String(),
  role: Type.Union([Type.String(), Type.Null()]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type KernelProjectRepository = Static<typeof KernelProjectRepositorySchema>;

export const KernelProjectSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  slug: Type.String(),
  name: Type.String(),
  summary: Type.String(),
  status: Type.Union([
    Type.Literal("active"), Type.Literal("merged"), Type.Literal("archived"),
  ]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  maxConcurrency: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  mergedIntoProjectId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  createdBy: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  repositories: Type.Array(KernelProjectRepositorySchema),
});
export type KernelProject = Static<typeof KernelProjectSchema>;

export const KernelTicketSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  brief: Type.String(),
  body: Type.String(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  project: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  parentTicketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  // 以下执行侧字段对 kind='reminder' 一律为 NULL（kernel schema 约束 C2），对 task 才有值。
  // rootTicketId 另有一条 task 也可能为 NULL 的路径：自根行走 insert-then-update，
  // 两步之间它就是 NULL。契约不该断言一条写入协议不保证的不变量。
  rootTicketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  createdByAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  orchestrationState: Type.Union([KernelOrchestrationStateSchema, Type.Null()]),
  requestedRuntime: Type.Union([KernelRuntimeIdSchema, Type.Null()]),
  requestedModel: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.Union([KernelAttemptPurposeSchema, Type.Null()]),
  // 已停用（工单 09）：只为旧客户端保留，下个版本删。旧的协议（master 04dd07d0 及以前）把它当作必填字段，并且整个对象是严格的，
  // 所以 daemon 照发 null。它的意思并进了 verificationPolicy，新客户端不读它。
  reviewPolicy: Type.Optional(Type.Null()),
  // 谁核查（以前的 manual / automatic 策略并进了这里）。
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
export type KernelTicket = Static<typeof KernelTicketSchema>;

export const KernelTicketDependencySchema = StrictObject({
  parentTicketId: Type.Integer({ minimum: 1 }),
  planRevision: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  dependsOnTicketId: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  createdByAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  createdAt: Type.String(),
});
export type KernelTicketDependency = Static<typeof KernelTicketDependencySchema>;

export const KernelAttemptSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("executor"), Type.Literal("reviewer")]),
  state: AttemptStateSchema,
  runtime: KernelRuntimeIdSchema,
  purpose: KernelAttemptPurposeSchema,
  model: Type.Union([Type.String(), Type.Null()]),
  runtimeVersion: Type.Union([Type.String(), Type.Null()]),
  externalSessionId: Type.Union([Type.String(), Type.Null()]),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  sessionPath: Type.Union([Type.String(), Type.Null()]),
  pid: Type.Union([Type.Integer(), Type.Null()]),
  eventCursor: Type.Union([Type.String(), Type.Null()]),
  lastEntryCursor: Type.Union([Type.String(), Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  errorCode: Type.Union([Type.String(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  costKnown: Type.Boolean(),
  eventLogDirty: Type.Boolean(),
  startedAt: Type.String(),
  endedAt: Type.Union([Type.String(), Type.Null()]),
});
export type KernelAttempt = Static<typeof KernelAttemptSchema>;

export const KernelTicketWorkbenchSchema = createKernelTicketWorkbenchSchema(
  KernelTicketSchema,
  KernelAttemptSchema,
);
export type KernelTicketWorkbench = Static<typeof KernelTicketWorkbenchSchema>;

export const KernelTicketWorkbenchV2Schema = createKernelTicketWorkbenchV2Schema(
  KernelTicketSchema,
  KernelAttemptSchema,
);
export type KernelTicketWorkbenchV2 = Static<typeof KernelTicketWorkbenchV2Schema>;

const KernelRuntimeEventBase = {
  attemptId: Type.Integer({ minimum: 1 }),
  seq: Type.Integer({ minimum: 1 }),
  occurredAt: Type.String(),
};

export const KernelRuntimeEventSchema = Type.Union([
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("run.started"),
    runtime: KernelRuntimeIdSchema,
    model: Type.Union([Type.String(), Type.Null()]),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("session.updated"),
    externalSessionId: Type.String(),
    runtimeVersion: Type.Optional(Type.String()),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("message.delta"),
    messageId: Type.String(),
    delta: Type.String(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("message.completed"),
    messageId: Type.String(),
    role: Type.Literal("assistant"),
    text: Type.String(),
    stopReason: Type.Optional(Type.String()),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("tool.started"),
    callId: Type.String(),
    name: Type.String(),
    args: Type.Unknown(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("tool.updated"),
    callId: Type.String(),
    name: Type.String(),
    update: Type.Unknown(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("tool.completed"),
    callId: Type.String(),
    name: Type.String(),
    result: Type.Unknown(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("tool.failed"),
    callId: Type.String(),
    name: Type.String(),
    error: Type.String(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("usage.updated"),
    mode: Type.Union([Type.Literal("delta"), Type.Literal("cumulative")]),
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("run.completed"),
    exitCode: Type.Integer(),
    reason: Type.Optional(Type.String()),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("run.failed"),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    errorCode: Type.String(),
    error: Type.String(),
  }),
  StrictObject({
    ...KernelRuntimeEventBase,
    type: Type.Literal("runtime.stderr"),
    text: Type.String(),
  }),
]);
export type KernelRuntimeEvent = Static<typeof KernelRuntimeEventSchema>;

export const KernelLearningCandidateSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  projectId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  scopeKey: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  fingerprint: Type.String(),
  kind: Type.String(),
  summary: Type.String(),
  evidence: Type.Record(Type.String(), Type.Unknown()),
  occurrenceCount: Type.Integer({ minimum: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  status: Type.Union([
    Type.Literal("candidate"), Type.Literal("drafted"), Type.Literal("promoted"),
    Type.Literal("dismissed"),
  ]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type KernelLearningCandidate = Static<typeof KernelLearningCandidateSchema>;

export const KernelCapabilitySchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  projectId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  scopeKey: Type.String(),
  type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  scope: Type.Union([Type.Literal("project"), Type.Literal("global")]),
  status: Type.Union([
    Type.Literal("draft"), Type.Literal("evaluating"), Type.Literal("active"),
    Type.Literal("deprecated"),
  ]),
  summary: Type.String(),
  assetPath: Type.Union([Type.String(), Type.Null()]),
  evaluatorPath: Type.Union([Type.String(), Type.Null()]),
  assetHash: Type.Union([Type.String(), Type.Null()]),
  evaluatorHash: Type.Union([Type.String(), Type.Null()]),
  implementationStatus: Type.Optional(Type.Union([
    Type.Literal("unknown"), Type.Literal("implementation_verified"),
  ])),
  deploymentStatus: Type.Optional(Type.Union([
    Type.Literal("not_deployed"), Type.Literal("deployed"),
  ])),
  leadToolStatus: Type.Optional(Type.Union([
    Type.Literal("not_loaded"), Type.Literal("loaded"),
  ])),
  sourceCandidates: Type.Array(Type.Integer({ minimum: 1 })),
  provenance: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type KernelCapability = Static<typeof KernelCapabilitySchema>;

export const CreateTicketRequestSchema = StrictObject({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  brief: Type.String({ minLength: 1, maxLength: 20_000 }),
  workdir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  workflowKind: Type.Optional(TicketWorkflowKindSchema),
  priority: Type.Optional(TicketPrioritySchema),
  project: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  projectId: Type.Optional(Type.Integer({ minimum: 1 })),
  runtime: Type.Optional(KernelRuntimeIdSchema),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  purpose: Type.Optional(KernelAttemptPurposeSchema),
  // 谁核查：独立核查、Lead 静态核对、用户核对。不给时是 lead_static。代替以前 manual / automatic 的旧字段（工单 09）。
  verificationPolicy: Type.Optional(Type.Union([
    Type.Literal("independent_reviewer"), Type.Literal("lead_static"), Type.Literal("user"),
  ])),
});
export type CreateTicketRequest = Static<typeof CreateTicketRequestSchema>;

export const KernelTicketListResponseSchema = StrictObject({ items: Type.Array(KernelTicketSchema) });
export const KernelTicketDependencyListResponseSchema = StrictObject({
  items: Type.Array(KernelTicketDependencySchema),
});
export const KernelRuntimeEventListResponseSchema = StrictObject({
  items: Type.Array(KernelRuntimeEventSchema),
});
export const KernelLearningCandidateListResponseSchema = StrictObject({
  items: Type.Array(KernelLearningCandidateSchema),
});
export const KernelCapabilityListResponseSchema = StrictObject({
  items: Type.Array(KernelCapabilitySchema),
});

export const AgendaItemSchema = StrictObject({
  id: Type.String(),
  kind: Type.Union([Type.Literal("ticket_due"), Type.Literal("ticket_reminder"), Type.Literal("schedule")]),
  startsAt: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  scheduleId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  status: Type.Union([TicketStatusSchema, Type.Null()]),
  project: Type.Union([Type.String(), Type.Null()]),
});
export type AgendaItem = Static<typeof AgendaItemSchema>;

// 日程（左栏改版阶段 3）：GET /v1/timeline?from&to&timezone。/v1/agenda 原样保留：AgendaItemSchema 是 StrictObject，
// 给它加字段，旧客户端会拒收整条。
export const TimelineEntrySchema = StrictObject({
  // "milestone:12" | "reminder:83" | "routine:3:<iso>" | "fire:41" | "defer:18"
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("milestone"), Type.Literal("reminder"), Type.Literal("routine"),
    Type.Literal("routine_fired"), Type.Literal("deferred_start"),
  ]),
  at: Type.String(),
  allDay: Type.Boolean(),
  // 工单的显示标题（有短标题时用短标题）、提醒的标题或例行任务的名字。
  title: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  project: Type.Union([Type.String(), Type.Null()]),
  milestone: Type.Optional(StrictObject({
    id: Type.Integer({ minimum: 1 }), kind: MilestoneKindSchema, label: Type.String(), state: MilestoneStateSchema,
  })),
  // 出处：最后一次改它的是谁、什么时候；抽取时引用的原话、对话轮次、Run 和置信度。
  provenance: Type.Optional(StrictObject({
    actor: MilestoneActorSchema,
    runId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    turnId: Type.Union([Type.String(), Type.Null()]),
    quote: Type.Union([Type.String(), Type.Null()]),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Null()]),
    at: Type.String(),
  })),
  status: Type.Union([
    Type.Literal("upcoming"), Type.Literal("overdue"), Type.Literal("done"), Type.Literal("unacked"), Type.Literal("failed"),
  ]),
  // 由 TicketSummary 派生：节点在 48 小时内（或已过），工单却阻塞、在等你或还没开始。
  risk: Type.Union([StrictObject({
    reason: Type.Union([Type.Literal("ticket_blocked"), Type.Literal("ticket_needs_user"), Type.Literal("not_started")]),
    label: Type.String(),
  }), Type.Null()]),
  editable: Type.Boolean(),
  // 例行任务的说明，或者触发结果（「已执行 · 生成 #85」「失败：…」）。
  detail: Type.Optional(Type.String()),
});
export type TimelineEntry = Static<typeof TimelineEntrySchema>;

export const TimelineResponseSchema = StrictObject({
  entries: Type.Array(TimelineEntrySchema),
  // 过期的：没结束的工单上过了时间的节点，触发 7 天以上还没确认的提醒。新的在前，最多 50 条。
  overdue: Type.Array(TimelineEntrySchema),
  generatedAt: Type.String(),
  // 日程顶部的一句话（Lead 写，只写事实和风险）和写下的时间。
  leadNote: Type.Union([StrictObject({ text: Type.String(), at: Type.String() }), Type.Null()]),
});
export type TimelineResponse = Static<typeof TimelineResponseSchema>;

// POST /v1/tickets/:id/milestones（出处是 user）。
export const MilestoneCreateRequestSchema = StrictObject({
  kind: MilestoneKindSchema,
  at: Type.String({ minLength: 1, maxLength: 64 }),
  allDay: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String({ maxLength: 40 })),
});
export type MilestoneCreateRequest = Static<typeof MilestoneCreateRequestSchema>;

// POST /v1/milestones/:id：只改给出的字段。没有 DELETE：取消就是 state = cancelled，可以恢复。
// 它是操作层的 milestone.update 的输入（ui-actions.ts），页面和 Lead 用同一份。
export const MilestonePatchRequestSchema = UI_ACTION_INPUT_SCHEMAS.milestone.update;
export type MilestonePatchRequest = Static<typeof MilestonePatchRequestSchema>;

export const MilestoneDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Integer({ minimum: 1 }),
  kind: MilestoneKindSchema,
  label: Type.String(),
  at: Type.String(),
  allDay: Type.Boolean(),
  state: MilestoneStateSchema,
});
export type MilestoneDto = Static<typeof MilestoneDtoSchema>;

export const ApprovalSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  requestedBy: Type.String(),
  tool: Type.String(),
  action: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("expired"),
  ]),
  expiresAt: Type.String(),
  createdAt: Type.String(),
});
export type ApprovalDto = Static<typeof ApprovalSchema>;

// toolCalls 只在客户端要的时候才有（GET /v1/conversation/turns?include=tool_calls）。
// 旧客户端按 StrictObject 校验整条记录，多一个字段就整页失败，所以服务端不主动加。
// 字段的含义和折叠规则见 conversation-tool-calls.ts。
// 用户的一条消息现在怎么放的（TurnPlacementSchema）定义在 lead-follow-ups.ts：排着的追问的操作也用它。

export const ConversationTurnSchema = StrictObject({
  id: Type.String(),
  originBindingId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  originKind: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  state: Type.Union([
    Type.Literal("queued"), Type.Literal("streaming"), Type.Literal("completed"),
    Type.Literal("failed"), Type.Literal("steered"),
  ]),
  userText: Type.String(),
  assistantText: Type.String(),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  toolCalls: Type.Optional(Type.Array(ConversationToolCallSchema)),
  // Lead 在这一轮生成的富交互卡片（include=surfaces，ui-surfaces.ts）。和 toolCalls 一样只在客户端要时才有。
  surfaces: Type.Optional(Type.Array(UiSurfacePlacementSchema)),
  // 用户的这条消息怎么放的（工单 04，spec D10；include=placement 才有，用户的轮次才有）：
  // queued 排着队等 Lead 答完这一轮；steered 插进了正在跑的一轮，还在路上；
  // answered_together 没有自己的回答，Lead 把它和 answeredWith 那一条一起答了（没有 answeredWith：在同一轮里答了）；
  // cancelled 用户取消了这一条排着的追问，Lead 不回答它（旧客户端严格校验这条记录，会拒绝这个值）。
  placement: Type.Optional(TurnPlacementSchema),
  answeredWith: Type.Optional(Type.String()),
  // 工单 agent 的这段回复在等你决定要不要做哪几个动作（include=reply_actions 才有，ticket-chat.ts）。
  // daemon 用 SmartModel 判断，判断过的轮次才有；空数组表示判断过、没有在问你。
  replyActions: Type.Optional(Type.Array(TicketReplyActionIdSchema)),
  // 用户的这条消息带的图片，按发送时的顺序（include=images 才有，带了图片的轮次才有；chat-images.ts）。
  images: Type.Optional(Type.Array(ChatImageRefSchema)),
});
export type ConversationTurn = Static<typeof ConversationTurnSchema>;

// Lead 自己的模型调用是否正常。顶栏的状态点读它，不再只看 WebSocket 连没连上
// （实例上每次 Lead 调模型都是 503，顶栏却一直亮着绿点）。离线由客户端按连接状态判断。
export const LeadStatusSchema = StrictObject({
  // online：最近一次模型调用成功（或还没有调用过）。degraded：模型连不上，系统会自己再试。
  state: Type.Union([Type.Literal("online"), Type.Literal("degraded")]),
  // 这一轮连续失败是从什么时候开始的。
  since: Type.Union([Type.String(), Type.Null()]),
  failures: Type.Integer({ minimum: 0 }),
  // 一句白话原因，例如"Lead 的模型服务暂时连不上"。
  reason: Type.Union([Type.String(), Type.Null()]),
  // 最近一次失败的原始错误，只给「技术详情」用。
  detail: Type.Union([Type.String(), Type.Null()]),
  // 系统下一次自己调用模型的时间（SDK 重试、通知重播、心跳巡检里最早的一个）。
  // null 表示没有排好的自动调用：用户下一次发消息时才会再试。
  nextAttemptAt: Type.Union([Type.String(), Type.Null()]),
  lastSuccessAt: Type.Union([Type.String(), Type.Null()]),
  // 最近一次心跳巡检完成的时间（巡检没有要说的话时，会话里不留消息，顶栏写"最近巡检 HH:MM"）。
  lastPatrolAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type LeadStatus = Static<typeof LeadStatusSchema>;

export const OverviewSchema = StrictObject({
  model: Type.String(),
  sessionId: Type.String(),
  busy: Type.Boolean(),
  runningTicketIds: Type.Array(Type.Integer({ minimum: 1 })),
  counts: StrictObject({
    activeTickets: Type.Integer({ minimum: 0 }),
    reviewTickets: Type.Integer({ minimum: 0 }),
    blockedTickets: Type.Integer({ minimum: 0 }),
    pendingApprovals: Type.Integer({ minimum: 0 }),
    unreadNotices: Type.Integer({ minimum: 0 }),
  }),
  aish: Type.Union([
    StrictObject({ connected: Type.Boolean(), bot: Type.Union([Type.String(), Type.Null()]) }),
    Type.Null(),
  ]),
  // 可选：只在 GET /v1/overview?include=lead 时带（旧客户端严格校验，不认识多出来的字段）。
  lead: Type.Optional(LeadStatusSchema),
});
export type Overview = Static<typeof OverviewSchema>;

export const NotificationStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("acked"),
]);
export const NotificationUrgencySchema = Type.Union([
  Type.Literal("immediate"), Type.Literal("batchable"),
]);
export const NotificationDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  kind: Type.String(),
  dedupKey: Type.Union([Type.String(), Type.Null()]),
  urgency: NotificationUrgencySchema,
  title: Type.String(),
  body: Type.String(),
  state: NotificationStateSchema,
  createdAt: Type.String(),
  deliveredAt: Type.Union([Type.String(), Type.Null()]),
  deliveredVia: Type.Union([Type.Literal("lead"), Type.Literal("fallback"), Type.Null()]),
  ackedAt: Type.Union([Type.String(), Type.Null()]),
});
export type NotificationDto = Static<typeof NotificationDtoSchema>;

// 收件箱（companion 左栏，阶段 1）。GET /v1/inbox。
// 「等你」的工单本身客户端已经有（TicketSummary，同一条 ticketNeedsUser 规则）；这里补列表里没有的两件事实：
// 为什么在等你（一句话）和从什么时候开始。另外是 Lead 自己处理掉的事（record_disposition = handled）。
export const InboxTicketFactSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  // 一句话：最新的阻塞记录、审批的内容、核查的状态……没有可说的时为 null。
  reason: Type.Union([Type.String(), Type.Null()]),
  // 从什么时候开始等你（ISO）：进入当前阶段的时间；审批是审批创建的时间。
  since: Type.String(),
});
export type InboxTicketFact = Static<typeof InboxTicketFactSchema>;

export const LeadHandledEntrySchema = StrictObject({
  // "inbox:<这次处置里最早的事件 id>"
  id: Type.String(),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  // 出了什么事。
  problem: Type.String(),
  // 根因；Lead 没写时为 null。
  cause: Type.Union([Type.String(), Type.Null()]),
  // Lead 做了什么；Lead 只写了理由时就是理由。
  action: Type.String(),
  // 以后会怎样；Lead 没写时为 null。
  followUp: Type.Union([Type.String(), Type.Null()]),
  // 这次处置合并了几件事（例如同一个故障重试了几次）。
  eventCount: Type.Integer({ minimum: 1 }),
  handledAt: Type.String(),
});
export type LeadHandledEntry = Static<typeof LeadHandledEntrySchema>;

export const InboxViewSchema = StrictObject({
  tickets: Type.Array(InboxTicketFactSchema),
  // 最近 7 天，新的在前。
  leadHandled: Type.Array(LeadHandledEntrySchema),
  // 你上次看收件箱的时间；没看过为 null。POST /v1/inbox/seen 更新它。
  seenAt: Type.Union([Type.String(), Type.Null()]),
});
export type InboxView = Static<typeof InboxViewSchema>;

export const NotificationListResponseSchema = StrictObject({
  items: Type.Array(NotificationDtoSchema),
});
export type NotificationListResponse = Static<typeof NotificationListResponseSchema>;

export const PairingRedeemResponseSchema = StrictObject({
  binding: BindingDtoSchema,
  access_token: Type.String({ minLength: 1 }),
});
export type PairingRedeemResponse = Static<typeof PairingRedeemResponseSchema>;

export const WsTicketResponseSchema = StrictObject({
  ws_ticket: Type.String({ minLength: 1 }),
  expires_at: Type.String(),
});
export type WsTicketResponse = Static<typeof WsTicketResponseSchema>;

export const HelloV2Schema = StrictObject({
  type: Type.Literal("hello.v2"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  serverTime: Type.String(),
  timezone: Type.String(),
  latestSeq: Type.Integer({ minimum: 0 }),
  capabilities: Type.Array(Type.String()),
  binding: BindingDtoSchema,
  daemon: StrictObject({
    model: Type.String(),
    sessionId: Type.String(),
    busy: Type.Boolean(),
  }),
});
export type HelloV2 = Static<typeof HelloV2Schema>;

const CommandBase = {
  id: Type.String({ minLength: 1 }),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
};

// 客户端发件箱给每条消息的稳定 id（连不上、超时、换 HTTP 兜底时都用它重发）。网关按 binding + 这个 id 去重：
// 同一条消息第二次到达时，回答第一次开的那一轮（data.duplicate 为 true），不再开一轮。
// 它是可选的：旧客户端不带它，照旧每条命令一轮。旧 daemon 严格校验命令、不认识这个字段，
// 所以客户端只在 hello.v2 的 capabilities 里有 CHAT_CLIENT_MESSAGE_ID_CAPABILITY 时才带它。
export const CHAT_CLIENT_MESSAGE_ID_CAPABILITY = "chat.client-message-id.v1";
export const ClientMessageIdSchema = Type.String({ minLength: 1, maxLength: 128 });

// 用户在 Lead 忙时发的消息怎么放（Lead 事件主干 spec D6，工单 04）：插话（steer，缺省）在当前这批工具调用结束后加进这一轮；
// 排队（followUp）等 Lead 答完这一轮再放进去，连着排队的几条一起答。Lead 空闲时两种都开新的一轮。
// 旧 daemon 严格校验命令、不认识这个字段，所以客户端只在 hello.v2 的 capabilities 里有 CHAT_PLACEMENT_CAPABILITY 时才带它。
export const CHAT_PLACEMENT_CAPABILITY = "chat.placement.v1";
export const ChatPlacementSchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
export type ChatPlacement = Static<typeof ChatPlacementSchema>;

// chat.send 的结果里这条消息怎么开始的：started 开了新的一轮；steered 插进了正在跑的一轮；queued 排着队，等 Lead 答完这一轮。
export type ChatSendMode = "started" | "steered" | "queued";

export const ChatSendCommandSchema = StrictObject({
  type: Type.Literal("chat.send"),
  ...CommandBase,
  // 用户写的话。只带图片的消息可以没有文字（chat-images.ts）；文字和图片都没有时 daemon 拒收。
  message: Type.String(),
  // answerer：工单 08 第一版里你选的回答者（ticket-chat.ts）。2026-10-19 起 daemon 不再宣布这个能力，也忽略这个字段：
  // 工单对话一律交给工单的 agent。schema 继续接受它，旧客户端带了也不报错。
  context: Type.Optional(StrictObject({
    ticketId: Type.Integer({ minimum: 1 }),
    answerer: Type.Optional(TicketChatAnswererSchema),
  })),
  clientMessageId: Type.Optional(ClientMessageIdSchema),
  mode: Type.Optional(ChatPlacementSchema),
  // 发给 Lead 的图片（chat-images.ts）。客户端只在 hello.v2 的 capabilities 里有 CHAT_IMAGES_CAPABILITY 时带它。
  images: Type.Optional(ChatImagesInputSchema),
});
export const StatusGetCommandSchema = StrictObject({
  type: Type.Literal("status.get"),
  ...CommandBase,
});
export const SyncResumeCommandSchema = StrictObject({
  type: Type.Literal("sync.resume"),
  ...CommandBase,
  afterSeq: Type.Integer({ minimum: 0 }),
});
// 客户端说明现在有没有人在看（companion：应用在前台并且最近有操作；plc chat：运行中并且最近有输入）。
// daemon 只把有人在看的连接算作"有人在听"：只有这时 lead 才播报即时通知，桌面通知才不弹。
// 什么都不报的连接不算。
// 客户端多久没有用户操作就不再算"有人在看"（companion：点按、键盘、触摸、滚动；plc chat：输入）。
export const PRESENCE_IDLE_MS = 5 * 60_000;

export const PresenceSetCommandSchema = StrictObject({
  type: Type.Literal("presence.set"),
  ...CommandBase,
  attended: Type.Boolean(),
});
export const WsCommandSchema = Type.Union([
  ChatSendCommandSchema, StatusGetCommandSchema, SyncResumeCommandSchema, PresenceSetCommandSchema,
]);
export type WsCommand = Static<typeof WsCommandSchema>;

export * from "./pairing.ts";
export * from "./stages.ts";
export * from "./checkpoints.ts";
export * from "./interventions.ts";
export * from "./workbench.ts";
export * from "./prototype-fidelity.ts";
export * from "./conversation-cards.ts";
export * from "./lead-activity.ts";
export * from "./ui-surfaces.ts";
export * from "./admin.ts";
export * from "./loopback-pairing.ts";
export * from "./connections.ts";
export * from "./channel-policy.ts";
export * from "./channel-confidence.ts";
export * from "./channel-handbook.ts";
export * from "./channels.ts";
export * from "./message-events.ts";
export * from "./lead-queue.ts";
export * from "./lead-follow-ups.ts";
export * from "./channel-lookup.ts";
export * from "./run-grants.ts";
export * from "./agent-tasks.ts";
export * from "./channel-settings.ts";
export * from "./memory.ts";
export * from "./memory-hindsight.ts";
export * from "./core-memory.ts";
export * from "./runtime-settings.ts";
export * from "./lead-profile.ts";
export * from "./lead-avatar.ts";
export * from "./design-preferences.ts";
export * from "./reply-style.ts";
export * from "./delivery.ts";
export * from "./delivery-snapshots.ts";
export * from "./execution-plan.ts";
export * from "./ticket-actions.ts";
export * from "./chat-images.ts";
export * from "./lead-models.ts";
export * from "./model-settings.ts";
export * from "./ui-actions.ts";
export * from "./rule-change-confirmations.ts";
export * from "./timer-origins.ts";
export * from "./acceptance-criteria.ts";
export * from "./reviews.ts";
export * from "./local-sockets.ts";
export * from "./system-turns.ts";
export * from "./conversation-tool-calls.ts";
export * from "./redaction.ts";
export * from "./service-url.ts";
export * from "./web-build.ts";
export * from "./needs-user.ts";
export * from "./inbox-notices.ts";
export * from "./lead-failure.ts";
export * from "./lead-outage.ts";
export * from "./events.ts";
export * from "./standing-orders.ts";
export * from "./system-usage.ts";
export * from "./standing-order-tiers.ts";
export * from "./standing-orders-wire.ts";
export * from "./ticket-chat.ts";
export * from "./owner-actions.ts";
export * from "./security-alerts.ts";
export * from "./reminders.ts";
export * from "./user-actions.ts";
export * from "./lead-waits.ts";
export * from "./setup.ts";
export * from "./widgets.ts";

export const ProtocolErrorSchema = StrictObject({
  code: Type.Union([
    Type.Literal("invalid_request"), Type.Literal("unauthorized"), Type.Literal("forbidden"),
    Type.Literal("not_found"), Type.Literal("conflict"),
    Type.Literal("protocol_version_unsupported"), Type.Literal("rate_limited"),
    Type.Literal("internal_error"),
  ]),
  message: Type.String(),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

export const HttpErrorResponseSchema = StrictObject({ error: ProtocolErrorSchema });
export type HttpErrorResponse = Static<typeof HttpErrorResponseSchema>;

export const CommandResultSchema = StrictObject({
  type: Type.Literal("command.result"),
  id: Type.String(),
  success: Type.Boolean(),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error: Type.Optional(ProtocolErrorSchema),
});
export type CommandResult = Static<typeof CommandResultSchema>;

export const GatewayEventTypeSchema = Type.Union([
  Type.Literal("lead.turn.started"), Type.Literal("lead.message.delta"),
  Type.Literal("lead.message.completed"), Type.Literal("lead.tool.started"),
  Type.Literal("lead.tool.updated"), Type.Literal("lead.tool.completed"),
  Type.Literal("lead.tool.failed"), Type.Literal("ticket.created"),
  Type.Literal("ticket.updated"), Type.Literal("attempt.started"),
  Type.Literal("attempt.updated"), Type.Literal("child.tool.started"),
  Type.Literal("child.tool.updated"), Type.Literal("child.tool.completed"),
  Type.Literal("child.tool.failed"), Type.Literal("approval.required"),
  Type.Literal("approval.resolved"), Type.Literal("notice.created"),
  Type.Literal("daemon.status.changed"), Type.Literal("snapshot.required"),
]);
export type GatewayEventType = Static<typeof GatewayEventTypeSchema>;


export const GatewayEventSchema = StrictObject({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  eventId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  type: GatewayEventTypeSchema,
  occurredAt: Type.String(),
  requiredScope: ScopeSchema,
  audienceBindingId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  turnId: Type.Union([Type.String(), Type.Null()]),
  ticketId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  payload: Type.Record(Type.String(), Type.Unknown()),
});
export type GatewayEvent = Static<typeof GatewayEventSchema>;

// 要客户端在事件流连接上声明 include=<值> 才会收到的事件；不需要声明时返回 null。
// 带 lead（Lead 的模型调用健康）的 daemon.status.changed 只发给声明了 include=lead_health 的连接：
// 旧客户端严格校验这个事件的 payload，多一个字段就报协议错误（发布评审 2340cac 的发现 B）。
// 事件类型表本身不变（kernel-protocol-contract 测试逐字节固定它）。
// 带 surface 的 Lead 工具事件（render_ui 生成的富交互卡片，ui-surfaces.ts）只发给声明了 include=ui_surfaces 的连接：
// 旧客户端不认识这个字段，也画不出来。
// 「Lead 动态」投影变化的推送（snapshot.required，resource 是 lead-activity，工单 06）只发给声明了 include=lead_activity 的连接：
// 旧客户端不认识这个 resource，会把它当成「全部重取」。
// 工单回复的动作按钮有了判断结果（snapshot.required，resource 是 ticket-reply-actions，ticket-chat.ts）只发给
// 声明了 include=reply_actions 的连接，理由同上。
// Lead 忙时排着的外部消息变了（snapshot.required，resource 是 lead-queue，工单 10）只发给声明了 include=lead_queue 的连接，理由同上。
export function gatewayEventOptIn(event: Pick<GatewayEvent, "type" | "payload">): string | null {
  if (event.type === "daemon.status.changed" && "lead" in event.payload) return "lead_health";
  if (event.type.startsWith("lead.tool.") && "surface" in event.payload) return "ui_surfaces";
  if (event.type === "snapshot.required" && event.payload.resource === LEAD_ACTIVITY_RESOURCE) return LEAD_ACTIVITY_OPT_IN;
  if (event.type === "snapshot.required" && event.payload.resource === TICKET_REPLY_ACTIONS_RESOURCE) return TICKET_REPLY_ACTIONS_OPT_IN;
  if (event.type === "snapshot.required" && event.payload.resource === LEAD_QUEUE_RESOURCE) return LEAD_QUEUE_OPT_IN;
  return null;
}

export function nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

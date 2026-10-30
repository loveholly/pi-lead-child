// 工单操作的线上契约（工单详情 spec 5.11，实现工单 03）。页面上每一个会改后端的操作都是一个「工单操作」：
// 一份实现（engine 的 ticket-actions/），两个入口（页面走 HTTP，Lead 走工具）。
//
// - GET /v1/tickets/:id/actions（tickets:view）：每个操作现在能不能做、为什么。页面按这份清单决定按钮能不能点，
//   不在前端另写一套判断。
// - POST /v1/tickets/:id/actions/:action（每个操作自己的 scope）：执行。请求体 { input?, reason? }。
// - 单独的资源，不放进 TicketSummary：客户端严格校验工单列表，多一个字段旧页面整张列表都加载不出来。
//
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。优先级和关系类型的取值在这里另写一份，
// test/ticket-actions.test.ts 核对它们和 index.ts 的 TicketPrioritySchema、TicketRelationKindSchema 一致。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { KernelRuntimeIdSchema } from "./runtime-ids.ts";
import { ACCEPTANCE_CRITERIA_ACTION_IDS, ACCEPTANCE_CRITERIA_ACTION_INPUT_SCHEMAS } from "./acceptance-criteria.ts";
import { ACTION_PERMISSIONS, ActionPermissionSchema, type ActionPermission } from "./ui-actions.ts";
import { GrantScopeSchema } from "./run-grants.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ── 清单 ──────────────────────────────────────────────────────────────────────────

// 顺序就是呈现顺序：工单级的在前，执行，交付与验收在后。
export const TICKET_ACTION_IDS = [
  // 生命周期（plan.md P03）：开始执行、停下、撤回确认、恢复。
  "confirm", "start", "stop", "unconfirm", "restore", "cancel", "set_priority", "set_project", "set_due", "set_budget", "delegate", "link", "unlink",
  "pause_run", "resume_run", "stop_run", "request_review", "change_reviewer", "retry_review", "widen_grant",
  // 换模型和推理强度、换执行 agent（工单 08，spec 5.3）。
  "set_run_profile", "change_executor_runtime",
  "complete", "accept_without_review", "rework", "merge", "set_auto_pr", "open_pr", "abandon",
  "open_delivery_file",
  // 验收标准（工单 05）：编辑、确认一条、取消确认。
  ...ACCEPTANCE_CRITERIA_ACTION_IDS,
] as const;
export type TicketActionId = typeof TICKET_ACTION_IDS[number];

export function isTicketActionId(value: string): value is TicketActionId {
  return (TICKET_ACTION_IDS as readonly string[]).includes(value);
}

// 谁能做（spec 5.11「Lead 代你做的规则」）：和工单以外的操作共用 ui-actions.ts 的四档（user_only、lead_allowed、delegated、
// user_direct）。delegated：你把工单托管给 Lead 时，Lead 按托管授权自己做；没有托管时同 user_only。
// user_direct：给 Lead 授权的操作（授权托管，工单 11）。Lead 能调用，但总是被拒，拒绝里写明你去哪里点。
// 对外（external）和不可逆（irreversible）的操作另有一条：每次都要你在这一轮明确要求，托管也不能代替。
export const TICKET_ACTION_PERMISSIONS = ACTION_PERMISSIONS;
export type TicketActionPermission = ActionPermission;

export const TICKET_ACTION_AREAS = ["ticket", "execution", "delivery"] as const;
export type TicketActionArea = typeof TICKET_ACTION_AREAS[number];

// ── 每个操作的输入 ────────────────────────────────────────────────────────────────
// reason 不在这里：它在请求体的顶层（两个入口都有）。返工的意见、取消的原因、关联的理由都用它。

const Empty = StrictObject({});
const RunTarget = StrictObject({
  // 不给时是这张工单当前的那个 Run（暂停：在跑的；继续：最近暂停的；停下：没结束的那个）。
  runId: Type.Optional(Type.Integer({ minimum: 1 })),
});
// 用户看到的交付（GET delivery 的 workspace.head、workspace.target）。给了就要和现在的一致，不给就不比。
const DeliveryExpectation = StrictObject({
  expectedHead: Type.Optional(Nullable(Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }))),
  expectedTarget: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 255 }))),
});

export const TICKET_ACTION_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const TICKET_ACTION_RELATION_KINDS = [
  "parent_of", "child_of", "depends_on", "blocks", "implements", "implemented_by",
  "duplicates", "duplicated_by", "supersedes", "superseded_by", "relates_to",
] as const;


export const TICKET_ACTION_INPUT_SCHEMAS = {
  confirm: Empty,
  // 开始执行：拉起执行 agent。runtime、model、effort 不给时由系统选（和派发一样）。
  start: StrictObject({
    runtime: Type.Optional(KernelRuntimeIdSchema),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    effort: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  }),
  // 停下：停掉没结束的 Run，工单回到待开始（active、blocked → ready）。
  stop: Empty,
  // 撤回确认：待开始的工单回到草稿（ready → draft）。
  unconfirm: Empty,
  // 恢复已取消的工单（cancelled → draft）或提醒（cancelled → scheduled）。
  //   mode  root_only 只恢复这一张（缺省）；review_tree 连同建议恢复的子任务一起恢复并确认；selected_children 恢复选中的子任务。
  //   childTicketIds  selected_children 时选中的子任务。
  restore: StrictObject({
    mode: Type.Optional(Type.Union([
      Type.Literal("root_only"), Type.Literal("review_tree"), Type.Literal("selected_children"),
    ])),
    childTicketIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 500 })),
  }),
  cancel: Empty,
  set_priority: StrictObject({
    priority: Type.Union([Type.Literal("urgent"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
  }),
  // 项目名或别名。没有这个项目时新建一个（和建单时一样）。null 清掉。
  set_project: StrictObject({ project: Nullable(Type.String({ minLength: 1, maxLength: 200 })) }),
  // 截止时间（ISO）。任务的截止是一个截止节点（v40）。null 清掉。
  set_due: StrictObject({ dueAt: Nullable(Type.String({ minLength: 1, maxLength: 64 })) }),
  // 只改给了的那一项；null 清掉那一项。至少给一项。
  set_budget: StrictObject({
    tokenBudget: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
    costBudgetUsd: Type.Optional(Nullable(Type.Number({ exclusiveMinimum: 0 }))),
  }),
  link: StrictObject({
    targetTicketId: Type.Integer({ minimum: 1 }),
    relationType: Type.Union([
      Type.Literal("parent_of"), Type.Literal("child_of"), Type.Literal("depends_on"), Type.Literal("blocks"),
      Type.Literal("implements"), Type.Literal("implemented_by"), Type.Literal("duplicates"), Type.Literal("duplicated_by"),
      Type.Literal("supersedes"), Type.Literal("superseded_by"), Type.Literal("relates_to"),
    ]),
    executionGate: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("target_done")])),
  }),
  unlink: StrictObject({ relationId: Type.Integer({ minimum: 1 }) }),
  // 授权托管（工单 11，spec 5.8、D11）：把技术验收和返工托管给 Lead。不要求独立核查的工单不能托管。
  //   acceptWithoutReview  核查做不成时（所有核查员都不能用），由 Lead 凭它读过的证据验收，账本标明没有独立核查。默认不勾。
  //   maxReworkCycles      自动返工的次数，默认 1。budgetLimitTokens、budgetLimitUsd 是用量上限，effectiveUntil 是到期时间（ISO）。
  //   startRework          工单在等验收时，授权的同时打回返工一次（这次返工属于这份授权）。
  //   requireContinuation、requiredCapabilityId：授权以后的后续动作要用到的（预检会核对）。
  delegate: StrictObject({
    acceptWithoutReview: Type.Optional(Type.Boolean()),
    maxReworkCycles: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    budgetLimitTokens: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    budgetLimitUsd: Type.Optional(Nullable(Type.Number({ minimum: 0 }))),
    effectiveUntil: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
    scope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    startRework: Type.Optional(Type.Boolean()),
    requireContinuation: Type.Optional(Type.Boolean()),
    requiredCapabilityId: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  pause_run: RunTarget,
  resume_run: RunTarget,
  stop_run: RunTarget,
  request_review: Empty,
  change_reviewer: StrictObject({ runtime: KernelRuntimeIdSchema }),
  // 核查没做成（核查 Run 失败、停了、没交结论）时，用同一个核查员再派一次（工单 11）。
  retry_review: Empty,
  // 放宽一个 Run 的权限清单（landing.md 第 5 节）。scope 只写要加的（protocol 的 GrantScope）；runId 不给时是这张工单
  // 最近一个带清单、还没结束的 Run。只属于用户：Lead 只能在用户这一轮明确要求时代他做。
  widen_grant: StrictObject({
    runId: Type.Optional(Type.Integer({ minimum: 1 })),
    scope: GrantScopeSchema,
  }),
  // 换执行者或核查员的模型和推理强度（工单 08，spec 5.3）。不给的一项不变，至少给一项。只能选模型目录里的。
  set_run_profile: StrictObject({
    role: Type.Union([Type.Literal("executor"), Type.Literal("reviewer")]),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    effort: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  }),
  // 换执行 agent（工单 08）：开新会话，带上工单的上下文。model、effort 是给新 runtime 的，不给时用它自己的默认。
  change_executor_runtime: StrictObject({
    runtime: KernelRuntimeIdSchema,
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    effort: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  }),
  complete: Empty,
  // 不等核查，直接验收（工单 11）：账本记「这次交付没有独立核查」。
  accept_without_review: Empty,
  rework: Empty,
  merge: DeliveryExpectation,
  // 交付后自动开草稿 PR 的开关（用户 2026-10-26）。缺省开。
  set_auto_pr: StrictObject({ enabled: Type.Boolean() }),
  open_pr: DeliveryExpectation,
  abandon: DeliveryExpectation,
  // 打开交付里的文件（工单 07，spec 5.4）：path 是交付快照文件列表里的相对路径，sequence 是第几次交付，不给时是最新一次。
  open_delivery_file: StrictObject({
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  // 验收标准（工单 05）。
  ...ACCEPTANCE_CRITERIA_ACTION_INPUT_SCHEMAS,
} as const satisfies Record<TicketActionId, TSchema>;

export type TicketActionInputs = { [K in TicketActionId]: Static<typeof TICKET_ACTION_INPUT_SCHEMAS[K]> };

// ── GET /v1/tickets/:id/actions ─────────────────────────────────────────────────────

// user_direct 是 2026-10-22 加的第四档（ui-actions.ts）。工单操作里授权托管（delegate，工单 11）用它。
export const TicketActionPermissionSchema = ActionPermissionSchema;
export const TicketActionAreaSchema = Type.Union([
  Type.Literal("ticket"), Type.Literal("execution"), Type.Literal("delivery"),
]);

export const TicketActionSchema = StrictObject({
  // 不用枚举：以后加了操作，旧客户端按严格的 schema 校验也不会整张清单失败。
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String(),
  area: TicketActionAreaSchema,
  permission: TicketActionPermissionSchema,
  // 对外（例如推到 GitHub）。
  external: Type.Boolean(),
  // 做了就收不回（例如放弃改动）。
  irreversible: Type.Boolean(),
  // 做完以后能在「不是我」里撤销（主人操作）。
  undoable: Type.Boolean(),
  available: Type.Boolean(),
  // 不能做的原因，用户能看懂的一句话。能做时为 null。
  reason: Nullable(Type.String()),
});
export type TicketAction = Static<typeof TicketActionSchema>;

export const TicketActionsResponseSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  actions: Type.Array(TicketActionSchema),
});
export type TicketActionsResponse = Static<typeof TicketActionsResponseSchema>;

// ── POST /v1/tickets/:id/actions/:action ───────────────────────────────────────────

export const TicketActionRunRequestSchema = StrictObject({
  // 这个操作的输入（TICKET_ACTION_INPUT_SCHEMAS）。没有输入的操作可以不给。
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // 为什么做。返工时是给执行 agent 的意见，取消时是原因，关联时是理由。不给时用一句默认的话。
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
});
export type TicketActionRunRequest = Static<typeof TicketActionRunRequestSchema>;

export const TicketActionRunResponseSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  action: Type.String({ minLength: 1, maxLength: 64 }),
  // 每个操作自己的结果，例如开 PR 的地址、新排的核查请求。
  result: Type.Unknown(),
  // 操作以后的工单（TicketSummary）。读不到时为 null。
  ticket: Type.Unknown(),
});
export type TicketActionRunResponse = Static<typeof TicketActionRunResponseSchema>;

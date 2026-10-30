// 改规则被拦下以后的一次性确认卡（统一的消息事件 spec D10 的「放行」，工单 09；用户 2026-10-27 定的缺省做法）。
//
// 外部消息叫醒的一轮、读过外部内容的一轮里，改规则的操作由代码拒绝（engine 的 ui-actions/external-content.ts，工单 07）。
// 拒绝的同时系统存下这一个操作（参数原样），拒绝里带着一份 user_action（kind=confirm_rule_change，target=rule_change:<编号>）。
// Lead 把它原样放进 UserAction 卡。卡片只带编号：要改什么、参数、为什么改（Lead 写的）、为什么被拦（这一轮读过的外部内容）
// 都从 GET /v1/rule-changes/:id 读，Lead 改不了卡上的内容。
// 用户点「确认这一次」或「不改」走 POST /v1/rule-changes/:id/resolve（approvals:respond）。它是操作层的 rule_change.resolve，
// 权限 user_direct：Lead 调它总是拿到结构化的拒绝。确认以后系统只执行存下的那一个操作，参数不能换，
// 账本记成 Lead 代用户做、用户确认过。有范围的临时授权以后再做。
//
// 状态记在事件日志里（对象键 rule_change:<编号>），不另建表：
//   rule_change.requested  存下被拦的操作（拒绝时写）；
//   rule_change.resolved   用户的决定（confirm 或 decline）。确认时先写它再执行，同一张卡只执行一次；
//   rule_change.executed   执行的结果（done 或 failed），写明 Lead 代用户做、凭哪张卡、哪台设备。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const RULE_CHANGE_CONFIRMATION_ID = /^rcc_[A-Za-z0-9_-]{8,40}$/;
const Id = Type.String({ pattern: "^rcc_[A-Za-z0-9_-]{8,40}$" });

// 没决定的确认卡过多久作废（和 Lead 提议的常设指令修改一样）。作废以后点不了，要改就让 Lead 在用户的一轮里再做一次。
export const RULE_CHANGE_CONFIRMATION_TTL_MS = 24 * 60 * 60_000;

// 卡上参数的上限：最多几项，每一项的值最多几个字。完整的参数在 rule_change.requested 的事件里。
export const RULE_CHANGE_CONFIRMATION_LIMITS = { params: 12, value: 400 } as const;

//   pending   等你确认；
//   running   你确认了，正在执行；
//   done      执行了（结果在 resultPreview）；
//   failed    执行失败（原因在 resultPreview）；
//   declined  你点了「不改」；
//   expired   没决定，过期作废了。
export const RuleChangeConfirmationStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"),
  Type.Literal("declined"), Type.Literal("expired"),
]);
export type RuleChangeConfirmationState = Static<typeof RuleChangeConfirmationStateSchema>;

export const RuleChangeDecisionSchema = Type.Union([Type.Literal("confirm"), Type.Literal("decline")]);
export type RuleChangeDecision = Static<typeof RuleChangeDecisionSchema>;

// 这一轮怎样带进了外部内容（engine 的 ExternalContentSource）。
const ExternalContentSourceSchema = Type.Union([
  StrictObject({ via: Type.Literal("message"), source: Type.String({ minLength: 1 }) }),
  StrictObject({ via: Type.Literal("tool"), tool: Type.String({ minLength: 1 }) }),
]);

// 被拦下的是哪一个操作。卡上只给它的名字，参数在 params 里。
const OperationRefSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("ui_action"),
    target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
    action: Type.String({ minLength: 1 }),
  }),
  StrictObject({ kind: Type.Literal("lead_tool"), tool: Type.String({ minLength: 1 }) }),
]);

export const RuleChangeConfirmationDtoSchema = StrictObject({
  id: Id,
  state: RuleChangeConfirmationStateSchema,
  // 操作的名字，例如「收紧自动代你处理」「改常设指令」。
  label: Type.String({ minLength: 1 }),
  // 改的是哪个对象，例如「slack 的自动代你处理」。没有时为 null。
  name: Nullable(Type.String()),
  operation: OperationRefSchema,
  // 参数：输入的每一项，值是 JSON（字符串原样）。最多 RULE_CHANGE_CONFIRMATION_LIMITS.params 项，长的值截断。
  params: Type.Array(StrictObject({ name: Type.String(), value: Type.String() })),
  // 为什么改：Lead 写的，原样显示。
  reason: Type.String(),
  // 为什么被拦：系统写的一句话。
  why: Type.String(),
  externalContent: Type.Array(ExternalContentSourceSchema),
  // 用户自己去哪里改。
  where: Type.String(),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  resolvedAt: Nullable(Type.String()),
  // 谁点的，例如「user via Mac 网页（binding 3）」。
  resolvedBy: Nullable(Type.String()),
  // 执行的结果，或者失败的原因（最多 500 个字）。
  resultPreview: Nullable(Type.String()),
});
export type RuleChangeConfirmationDto = Static<typeof RuleChangeConfirmationDtoSchema>;

export const RuleChangeConfirmationResponseSchema = StrictObject({ confirmation: RuleChangeConfirmationDtoSchema });
export type RuleChangeConfirmationResponse = Static<typeof RuleChangeConfirmationResponseSchema>;

export const ResolveRuleChangeConfirmationRequestSchema = StrictObject({ decision: RuleChangeDecisionSchema });
export type ResolveRuleChangeConfirmationRequest = Static<typeof ResolveRuleChangeConfirmationRequestSchema>;

// ── 事件 ──────────────────────────────────────────────────────────────────────────

export const RULE_CHANGE_REQUESTED_KIND = "rule_change.requested";
export const RULE_CHANGE_RESOLVED_KIND = "rule_change.resolved";
export const RULE_CHANGE_EXECUTED_KIND = "rule_change.executed";

// 存下的操作：和 engine 的 RuleChangeOperation 一样，input 是原样的参数。
const StoredOperationSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("ui_action"),
    target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
    action: Type.String({ minLength: 1 }),
    input: Type.Unknown(),
  }),
  StrictObject({ kind: Type.Literal("lead_tool"), tool: Type.String({ minLength: 1 }), input: Type.Unknown() }),
]);

export const RULE_CHANGE_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: RULE_CHANGE_REQUESTED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: Id,
      operation: StoredOperationSchema,
      label: Type.String({ minLength: 1 }),
      name: Nullable(Type.String()),
      where: Type.String(),
      reason: Type.String(),
      why: Type.String(),
      externalContent: Type.Array(ExternalContentSourceSchema),
      expiresAt: Type.String({ minLength: 1 }),
    }),
    description: "外部的一轮里改规则的操作被拦下，系统存下这一个操作，等用户在确认卡上决定。",
  },
  {
    kind: RULE_CHANGE_RESOLVED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: Id,
      decision: RuleChangeDecisionSchema,
      actor: Type.Literal("user"),
      resolvedBy: Type.String({ minLength: 1 }),
      bindingId: Nullable(Type.Integer()),
    }),
    description: "用户在改规则的确认卡上点了「确认这一次」或「不改」。",
  },
  {
    kind: RULE_CHANGE_EXECUTED_KIND,
    sources: ["system"],
    payload: Type.Object({
      id: Id,
      operation: StoredOperationSchema,
      // Lead 代用户做，凭这张确认卡（sourceTurnId 是 rule_change:<编号>）和点它的那台设备。
      actor: Type.Literal("lead"),
      onBehalfOf: Type.Literal("user"),
      sourceTurnId: Type.String({ minLength: 1 }),
      bindingId: Type.Integer(),
      state: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
      result: Type.String(),
    }),
    description: "用户确认以后，系统执行了确认卡上的那一个操作：Lead 代用户做、用户确认过。",
  },
];

for (const definition of RULE_CHANGE_EVENT_KINDS) registerEventKind(definition);

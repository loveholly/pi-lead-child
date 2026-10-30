// 结构化验收标准的线上契约（工单详情与验收 spec 4.3、5.1、5.7、D5、D6，工单 05）。
// - 读：GET /v1/tickets/:id/acceptance-criteria?delivery=<第几次交付>，用 tickets:view。不给 delivery 时对照最新一次交付。
//   单独的资源，不放进 TicketSummary：客户端严格校验工单列表，多一个字段旧页面整张列表都加载不出来。
// - 写：三个工单操作（ticket-actions.ts），一份实现两个入口（页面 POST /v1/tickets/:id/actions/:action，Lead 的 ticket_action）：
//   edit_acceptance_criteria（Lead 和你）、confirm_criterion 和 unconfirm_criterion（只属于你，Lead 凭你这一轮代你做）。
// - 确认按交付存（D5）：交付是 04 的交付快照（delivery-snapshots.ts 的 sequence、attemptId）。第 2 次交付从头开始。
//   确认不是验收或合并的条件。
// - 线上用 ticket / attempt，库里是 item / run（wire-vocabulary）。
//
// 这个文件不 import index.ts（ticket-actions.ts 从这里取输入 schema，index.ts 再 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// 上限和服务端的校验一致（store 的 ACCEPTANCE_CRITERIA_LIMITS）：最多 20 条，每条一行、最多 500 字。
const CriterionText = Type.String({ minLength: 1, maxLength: 500 });
const CriterionId = Type.Integer({ minimum: 1 });
// 页面看到的那一条的版本（AcceptanceCriterion.revision）。给了就要和现在的一样，不一样时拒绝（409，details.reason 是 stale）。
const SeenRevision = Type.Optional(Type.Integer({ minimum: 1 }));

// ── 三个操作的输入 ─────────────────────────────────────────────────────────────────

export const ACCEPTANCE_CRITERIA_ACTION_IDS = ["edit_acceptance_criteria", "confirm_criterion", "unconfirm_criterion"] as const;

export const ACCEPTANCE_CRITERIA_ACTION_INPUT_SCHEMAS = {
  // 至少给一项。add 加在最后；update 改某一条的文字；remove 删掉；order 是留下的各条（删除以后剩下的、不含新加的）的新顺序。
  // 交付以后改了或删了某一条，你在最新一次交付上对它的确认作废；更早的交付上的确认不动。
  // 页面过时了（revision 对不上、那一条已经被删了、order 列的不是现在留下的那些）时拒绝：409，details.reason 是 stale。
  edit_acceptance_criteria: StrictObject({
    add: Type.Optional(Type.Array(CriterionText, { maxItems: 20 })),
    update: Type.Optional(Type.Array(StrictObject({ id: CriterionId, text: CriterionText, revision: SeenRevision }), { maxItems: 20 })),
    remove: Type.Optional(Type.Array(StrictObject({ id: CriterionId, revision: SeenRevision }), { maxItems: 20 })),
    order: Type.Optional(Type.Array(CriterionId, { maxItems: 20 })),
  }),
  // 对照最新一次交付。deliverySequence 是页面上看的那次交付：给了就要是最新一次，不是时拒绝（409，details.reason 是 stale），
  // 不把确认记到别的交付上。最新一次交付的快照还没存好、或者存不成时也拒绝（409，details.reason 是 unavailable，原因写明）。
  confirm_criterion: StrictObject({ criterionId: CriterionId, deliverySequence: Type.Optional(Type.Integer({ minimum: 1 })) }),
  unconfirm_criterion: StrictObject({ criterionId: CriterionId, deliverySequence: Type.Optional(Type.Integer({ minimum: 1 })) }),
} as const;

// ── GET /v1/tickets/:id/acceptance-criteria ─────────────────────────────────────────

// 谁写的：你、Lead、执行 agent（child，拆子工单时）、系统（PR 评审模板抄入你的原话）。
export const CriterionWriterSchema = Type.Union([
  Type.Literal("user"), Type.Literal("lead"), Type.Literal("child"), Type.Literal("system"),
]);
export const CriterionEditorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);

// 你在这次交付上对这一条的确认。
// - confirmed：确认着。by=lead 时 onBehalfOf=user，是 Lead 在你的一轮对话里代你确认的。
// - voided：确认过，但交付以后这一条被改了，确认作废（界面上要能看出来）。按新的文字可以再确认。
// 没确认过、或者你取消了确认时，confirmation 是 null。
export const CriterionConfirmationSchema = StrictObject({
  state: Type.Union([Type.Literal("confirmed"), Type.Literal("voided")]),
  by: CriterionEditorSchema,
  onBehalfOf: Nullable(Type.Literal("user")),
  confirmedAt: Type.String({ minLength: 1 }),
  // state=voided 时是作废的时间。
  voidedAt: Nullable(Type.String({ minLength: 1 })),
});
export type CriterionConfirmation = Static<typeof CriterionConfirmationSchema>;

// 核查员对这一条的结论（工单 10，reviews.ts）：这次交付最新一次有结论的核查。结论按交付存（D8），第 2 次交付从头开始。
// 不限制多出来的字段（additionalProperties）：以后加字段不会让严格校验的旧客户端失败。
//   result    通过、不通过、无法核实。
//   evidence  核查员的证据。
//   attemptId 那次核查的 Run。
//   revision  核查员看到的那一版。和这一条现在的 revision 不一样时，结论说的是旧的那一版。
//   current   结论还算数：之后没有新的交付，工单对话也没有改过被核查的工作区。
export const CriterionVerdictSchema = Type.Object({
  result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unverifiable")]),
  evidence: Type.String(),
  attemptId: CriterionId,
  revision: Type.Integer({ minimum: 1 }),
  current: Type.Boolean(),
}, { additionalProperties: true });
export type CriterionVerdict = Static<typeof CriterionVerdictSchema>;

export const AcceptanceCriterionSchema = StrictObject({
  // 稳定的 id：改文字、挪顺序都不变。编辑和确认都按它。
  id: CriterionId,
  // 现在的编号，从 1 开始。删了一条以后后面的编号会变，所以操作用 id。
  number: Type.Integer({ minimum: 1 }),
  text: CriterionText,
  // 文字的版本：改一次加 1。
  revision: Type.Integer({ minimum: 1 }),
  writtenBy: CriterionWriterSchema,
  writtenAt: Type.String({ minLength: 1 }),
  // 最后一次改文字。没改过时都是 null。
  editedBy: Nullable(CriterionEditorSchema),
  editedAt: Nullable(Type.String({ minLength: 1 })),
  // 这次交付的执行者没有按这一版做（审查 M2）。没有交付时是 null。
  // - added：执行者开工时还没有这一条（开工以后、或者交付以后才加的）。
  // - edited：执行者开工时看到的是更早的一版（开工以后、或者交付以后改过文字）。
  // 判断依据是执行者启动时记下的版本；v54 以前的 Run 没有这份记录，按这次交付登记成果的时间比较。
  // 看历史交付（delivery.latest=false）时：text 和 revision 是那次交付时的那一版；edited 表示后来又改过。
  changedAfterDelivery: Nullable(Type.Union([Type.Literal("added"), Type.Literal("edited")])),
  // 已经删掉了。只在看历史交付时出现：那次交付时还在、后来删掉的那几条（审查 M4）。看最新一次交付时总是 false。
  deleted: Type.Boolean(),
  confirmation: Nullable(CriterionConfirmationSchema),
  // 核查员对这一条的结论（工单 10）。这次交付还没有核查结论、或者没有交付时为 null。
  verdict: Nullable(CriterionVerdictSchema),
});
export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;

// 确认对照的那次交付。sequence、attemptId 和 delivery-snapshots.ts 的 DeliverySummary 里的同名字段一样。
export const CriteriaDeliverySchema = StrictObject({
  sequence: Type.Integer({ minimum: 1 }),
  attemptId: Type.Integer({ minimum: 1 }),
  // 执行者交付（登记成果）的时间。和 DeliverySummary.deliveredAt（第一份快照存下的时间）可能差几秒：快照在交付以后才在后台存。
  deliveredAt: Type.String({ minLength: 1 }),
  // 是不是现在这次交付：最新一次交付，它的快照存好了，而且工单停在待验收或已完成。确认和取消确认只能对着它做。
  // false 时是历史：标准和确认都是那次交付时的样子，后来的改动不改它。
  latest: Type.Boolean(),
});
export type CriteriaDelivery = Static<typeof CriteriaDeliverySchema>;

export const TicketAcceptanceCriteriaSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  // 按现在的顺序。没有结构化的验收标准时是空数组（brief 里可能还写着，界面以这里为准）。
  criteria: Type.Array(AcceptanceCriterionSchema, { maxItems: 20 }),
  // 不给 ?delivery 时：现在这次交付。没有时（还没交付、返工中、最新一次交付的快照还没存好）是 null，这时 criteria 是现在的
  // 标准，每一条的 confirmation 和 changedAfterDelivery 都是 null。给了 ?delivery=N 时就是第 N 次交付。
  delivery: Nullable(CriteriaDeliverySchema),
  // 最新一次交付的快照还没存好、或者存不成（审查 M1）：这次交付还不能对照，reason 写明原因（例如「改动太大」）。
  // 没有这种情况时是 null。有的时候更早的交付是历史：用 ?delivery=N 看，latest 是 false。
  deliveryPending: Nullable(StrictObject({ attemptId: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1 }) })),
  // 这次交付上确认着的条数，给收起时的摘要「已确认 1/3」。
  confirmed: Type.Integer({ minimum: 0 }),
});
export type TicketAcceptanceCriteria = Static<typeof TicketAcceptanceCriteriaSchema>;

export const TicketAcceptanceCriteriaResponseSchema = StrictObject({ acceptanceCriteria: TicketAcceptanceCriteriaSchema });
export type TicketAcceptanceCriteriaResponse = Static<typeof TicketAcceptanceCriteriaResponseSchema>;

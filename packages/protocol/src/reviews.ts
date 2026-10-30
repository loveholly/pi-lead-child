// 核查包和逐条结论的线上契约（工单详情与验收 spec 4.5、5.7、5.8、D8，工单 10）。
// - 核查包：派发核查时由系统拼好（engine 的 review-packet.ts），不经过模型。核查员只拿到这些：编号的验收标准、brief 原文、
//   交付快照、执行 agent 的自述（标明待核实）；复核时再加上次的逐条结论和上次之后新增的提交。每个核查 Run 存一份。
// - 结论：review_verdict 逐条给出 通过 / 不通过 / 无法核实，各附证据，再给总结论；可选 escalate（原因从固定几种里选）。
//   结论按交付存（D8）：交付是 04 的交付快照（sequence、attemptId），第 2 次交付从头开始。
// - GET /v1/tickets/:id/reviews?delivery=<第几次交付>（tickets:view）：这次交付的每一次核查（「核查员看到了什么」和结论）。
//   单独的资源，不放进 TicketSummary：客户端严格校验工单列表，多一个字段旧页面整张列表都加载不出来。
// - 线上用 ticket / attempt，库里是 item / run（wire-vocabulary）。
//
// 这个文件不 import index.ts（index.ts 再 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Id = Type.Integer({ minimum: 1 });

// ── 结论的取值 ─────────────────────────────────────────────────────────────────────

// 每一条验收标准的结论：通过、不通过、无法核实（例如核查员不能运行命令，或者缺少可核对的东西）。
export const REVIEW_CRITERION_RESULTS = ["pass", "fail", "unverifiable"] as const;
export type ReviewCriterionResult = typeof REVIEW_CRITERION_RESULTS[number];
export const ReviewCriterionResultSchema = Type.Union([
  Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unverifiable"),
]);

// 核查员要你决定、不让托管自动处理的原因（spec 5.9：以前在证据文本里找关键词，现在核查员自己声明）。
//   evidence_conflict    证据互相矛盾（例如执行 agent 说测试通过，核查员跑出来失败，又说不清是谁错）
//   requirement_change   做的事和任务说明不一样，像是需求变了
//   irreversible_action  交付里有不可逆的操作（删数据、对外发布……）
//   external_approval    要外部的批准才能继续（法务、上线审批……）
export const REVIEW_ESCALATION_REASONS = [
  "evidence_conflict", "requirement_change", "irreversible_action", "external_approval",
] as const;
export type ReviewEscalationReason = typeof REVIEW_ESCALATION_REASONS[number];
export const ReviewEscalationReasonSchema = Type.Union([
  Type.Literal("evidence_conflict"), Type.Literal("requirement_change"),
  Type.Literal("irreversible_action"), Type.Literal("external_approval"),
]);

export const ReviewEscalationSchema = StrictObject({
  reason: ReviewEscalationReasonSchema,
  // 一句说明，给你看。
  note: Type.String({ minLength: 1, maxLength: 2_000 }),
});
export type ReviewEscalation = Static<typeof ReviewEscalationSchema>;

// ── 核查包 ───────────────────────────────────────────────────────────────────────

export const ReviewPacketCriterionSchema = StrictObject({
  id: Id,
  // 核查包里的编号，从 1 开始，核查员按它逐条回答。
  number: Id,
  // 核查员看到的那一版（05 的 revision）。之后改了，这次结论就不算这一版的。
  revision: Id,
  text: Type.String({ minLength: 1, maxLength: 500 }),
});
export type ReviewPacketCriterion = Static<typeof ReviewPacketCriterionSchema>;

export const ReviewPacketCommitSchema = StrictObject({
  sha: Type.String({ minLength: 1, maxLength: 64 }),
  subject: Type.String({ maxLength: 300 }),
});

export const ReviewPacketFileSchema = StrictObject({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  previousPath: Nullable(Type.String({ maxLength: 1024 })),
  status: Nullable(Type.Union([
    Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"),
    Type.Literal("renamed"), Type.Literal("unchanged"),
  ])),
  additions: Nullable(Type.Integer({ minimum: 0 })),
  deletions: Nullable(Type.Integer({ minimum: 0 })),
  binary: Type.Boolean(),
  // 执行 agent 对这个文件写的说明（成果里的 changes），没有时为 null。
  note: Nullable(Type.String({ maxLength: 2_000 })),
  generated: Nullable(Type.Union([Type.Literal("lock"), Type.Literal("generated")])),
});
export type ReviewPacketFile = Static<typeof ReviewPacketFileSchema>;

// 交付快照（04）：交付时由系统跑 git 存下的，不是执行 agent 报的（source=agent 时例外：不是隔离分支的工单）。
export const ReviewPacketSnapshotSchema = StrictObject({
  sequence: Id,
  revision: Id,
  source: Type.Union([Type.Literal("git"), Type.Literal("agent")]),
  baseSha: Nullable(Type.String({ maxLength: 64 })),
  headSha: Nullable(Type.String({ maxLength: 64 })),
  commits: Type.Array(ReviewPacketCommitSchema, { maxItems: 200 }),
  commitCount: Type.Integer({ minimum: 0 }),
  // 文件很多时只放前面的一部分（有说明的在前、lock 和生成的文件在后），omittedFiles 是没放进来的个数。
  files: Type.Array(ReviewPacketFileSchema, { maxItems: 2_000 }),
  omittedFiles: Type.Integer({ minimum: 0 }),
  totals: Nullable(StrictObject({
    files: Type.Integer({ minimum: 0 }),
    additions: Type.Integer({ minimum: 0 }),
    deletions: Type.Integer({ minimum: 0 }),
  })),
  // 存快照时文件太多，快照本身就截断了。
  truncated: Type.Boolean(),
  uncommittedFiles: Nullable(Type.Integer({ minimum: 0 })),
});
export type ReviewPacketSnapshot = Static<typeof ReviewPacketSnapshotSchema>;

// 执行 agent 的成果说明：做了什么、交付物、它报的验证。全部是待核实的自述。
export const ReviewPacketSelfReportSchema = StrictObject({
  summary: Type.String({ maxLength: 4_000 }),
  changes: Type.Array(StrictObject({
    kind: Type.String({ maxLength: 20 }), ref: Type.String({ maxLength: 1024 }), summary: Nullable(Type.String({ maxLength: 2_000 })),
  }), { maxItems: 50 }),
  deliverables: Type.Array(StrictObject({
    kind: Type.String({ maxLength: 20 }), ref: Type.String({ maxLength: 1024 }), label: Type.String({ maxLength: 2_000 }),
  }), { maxItems: 50 }),
  validations: Type.Array(StrictObject({
    command: Type.String({ maxLength: 2_000 }),
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
    summary: Type.String({ maxLength: 2_000 }),
  }), { maxItems: 50 }),
});
export type ReviewPacketSelfReport = Static<typeof ReviewPacketSelfReportSchema>;

export const ReviewPacketPreviousCriterionSchema = StrictObject({
  id: Id,
  number: Id,
  revision: Id,
  result: ReviewCriterionResultSchema,
  evidence: Type.String({ maxLength: 4_000 }),
});

// 复核：核查更早那次交付的、最近一次有结论的核查。只看上次之后新增的提交，和上次没通过的、新加的、改过的那几条。
// 同一次交付再核查一次（换个核查员再查、重试）不是复核：没有这一节，从头核查，新的核查员读不到上一个的结论。
export const ReviewPacketRecheckSchema = StrictObject({
  previousAttemptId: Id,
  // 上一次核查的是第几次交付（总是更早的那次）。那次交付没有快照时为 null。
  previousDeliverySequence: Nullable(Id),
  previousVerdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  previousEvidence: Type.String({ maxLength: 4_000 }),
  previousCriteria: Type.Array(ReviewPacketPreviousCriterionSchema, { maxItems: 20 }),
  // 上次之后新增的提交：上次的 head 到这次的 head。没有新提交时 commits 是空的。
  newCommits: Nullable(StrictObject({
    fromSha: Type.String({ maxLength: 64 }),
    toSha: Type.String({ maxLength: 64 }),
    commits: Type.Array(ReviewPacketCommitSchema, { maxItems: 200 }),
  })),
  // 算不出新增的提交时的原因（例如上次没有 git 快照，或者分支被改写过）。算出来时为 null。
  newCommitsUnknown: Nullable(Type.String({ maxLength: 500 })),
  // 这次要重点核查的标准：上次不通过或无法核实的、上次以后新加的、上次以后改过的。
  focusCriterionIds: Type.Array(Id, { maxItems: 20 }),
});
export type ReviewPacketRecheck = Static<typeof ReviewPacketRecheckSchema>;

export const ReviewPacketSchema = StrictObject({
  version: Type.Literal(1),
  ticketId: Id,
  // 这次核查的 Run。
  attemptId: Id,
  builtAt: Type.String({ minLength: 1 }),
  // 要核查的交付：最新一次交付的执行 Run，和它的快照是第几次交付。还没有快照时 sequence 为 null。
  delivery: Nullable(StrictObject({ attemptId: Id, sequence: Nullable(Id) })),
  criteria: Type.Array(ReviewPacketCriterionSchema, { maxItems: 20 }),
  brief: Type.String({ maxLength: 40_000 }),
  snapshot: Nullable(ReviewPacketSnapshotSchema),
  // 没有快照时的原因（例如「改动太大」、快照还没存好）。有快照时为 null。
  snapshotMissing: Nullable(Type.String({ maxLength: 500 })),
  selfReport: Nullable(ReviewPacketSelfReportSchema),
  recheck: Nullable(ReviewPacketRecheckSchema),
});
export type ReviewPacket = Static<typeof ReviewPacketSchema>;

// 收起时的一句摘要：「拿到 3 条验收标准、3 个文件（+94）、1 个提交、2 项待核实的验证」。
export const ReviewPacketSummarySchema = StrictObject({
  criteria: Type.Integer({ minimum: 0 }),
  files: Type.Integer({ minimum: 0 }),
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
  commits: Type.Integer({ minimum: 0 }),
  // 执行 agent 报的验证，都待核实。
  validations: Type.Integer({ minimum: 0 }),
  // 复核时：只看几个新提交、重点看几条。不是复核时为 null。新提交算不出来时 newCommits 为 null。
  recheck: Nullable(StrictObject({
    newCommits: Nullable(Type.Integer({ minimum: 0 })),
    focusCriteria: Type.Integer({ minimum: 0 }),
  })),
});
export type ReviewPacketSummary = Static<typeof ReviewPacketSummarySchema>;

// ── 结论 ─────────────────────────────────────────────────────────────────────────

export const ReviewCriterionVerdictSchema = StrictObject({
  criterionId: Id,
  // 核查包里的编号。
  number: Id,
  // 核查员看到的那一版。
  revision: Id,
  result: ReviewCriterionResultSchema,
  evidence: Type.String({ minLength: 1, maxLength: 4_000 }),
});
export type ReviewCriterionVerdict = Static<typeof ReviewCriterionVerdictSchema>;

export const ReviewVerdictSchema = StrictObject({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  // 总结论的证据。
  evidence: Type.String(),
  escalate: Nullable(ReviewEscalationSchema),
  criteria: Type.Array(ReviewCriterionVerdictSchema, { maxItems: 20 }),
  submittedAt: Type.String({ minLength: 1 }),
  // 这个结论现在还算数：之后没有新的交付、工单对话也没有改过被核查的工作区（engine 的 verificationState）。
  current: Type.Boolean(),
  // 结论以后，这些标准改过或删了（id）。不为空时托管不按这个结论自动验收。
  criteriaChangedSince: Type.Array(Id, { maxItems: 40 }),
});
export type ReviewVerdict = Static<typeof ReviewVerdictSchema>;

// 一次核查（一个核查 Run）。
export const TicketReviewAttemptSchema = StrictObject({
  attemptId: Id,
  runtime: Type.String({ minLength: 1, maxLength: 64 }),
  model: Nullable(Type.String({ maxLength: 200 })),
  effort: Nullable(Type.String({ maxLength: 40 })),
  // Run 的状态（starting、running、finished、failed、stopped……）。
  state: Type.String({ minLength: 1, maxLength: 40 }),
  startedAt: Nullable(Type.String()),
  endedAt: Nullable(Type.String()),
  // 核查员看到了什么。这个功能上线以前的核查没有核查包，两个都是 null。
  packetSummary: Nullable(ReviewPacketSummarySchema),
  packet: Nullable(ReviewPacketSchema),
  // 还没有结论（在跑，或者没做成）时为 null。
  verdict: Nullable(ReviewVerdictSchema),
});
export type TicketReviewAttempt = Static<typeof TicketReviewAttemptSchema>;

// 这次交付没有独立核查就验收了（工单 11，accept_without_review）。界面要写明「没有独立核查」。
//   by        你本人（user），或者 Lead（lead）。
//   onBehalfOf  Lead 在你这一轮里代你做时是 user。
//   authority  user 你本人；on_behalf Lead 代你；delegated Lead 按托管授权做（你授权时勾了「核查做不成时由 Lead 凭证据验收」，
//              而且当时所有核查员都不能用）。
//   reason    为什么不等核查：你写的，或者 Lead 读过的证据。
//   reviewProblem  当时核查为什么没做成。没有问题（只是不想等）时为 null。
export const AcceptedWithoutReviewSchema = StrictObject({
  by: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  onBehalfOf: Nullable(Type.Literal("user")),
  authority: Type.Union([Type.Literal("user"), Type.Literal("on_behalf"), Type.Literal("delegated")]),
  reason: Type.String(),
  reviewProblem: Nullable(Type.String()),
  at: Type.String({ minLength: 1 }),
});
export type AcceptedWithoutReview = Static<typeof AcceptedWithoutReviewSchema>;

export const TicketReviewsSchema = StrictObject({
  ticketId: Id,
  // 这次交付。不给 ?delivery 时是最新一次交付；还没有交付时为 null，attempts 为空。
  // 最新一次交付的快照还没存好、或者存不成时，sequence 为 null（快照才给交付编号），attemptId 照样是那次交付的执行 Run。
  delivery: Nullable(StrictObject({ sequence: Nullable(Id), attemptId: Id, latest: Type.Boolean() })),
  // 这次交付的每一次核查，按时间排，最新的在最后。
  attempts: Type.Array(TicketReviewAttemptSchema, { maxItems: 200 }),
  // 这次交付没有独立核查就验收了。没有这回事时为 null。
  acceptedWithoutReview: Nullable(AcceptedWithoutReviewSchema),
});
export type TicketReviews = Static<typeof TicketReviewsSchema>;

export const TicketReviewsResponseSchema = StrictObject({ reviews: TicketReviewsSchema });
export type TicketReviewsResponse = Static<typeof TicketReviewsResponseSchema>;

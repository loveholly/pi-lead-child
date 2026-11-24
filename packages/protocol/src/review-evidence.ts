// 核查证据（工单 #503，2026-11-24）：核查员在核查工作区里截的图，挂到工单上，标明对应哪几条验收标准。
//
// 以前核查员的截图只落在工作区的磁盘上，工单详情里看不到。现在：
//   · 核查员在核查时用 attach_review_evidence 把工作区里的图片挂上（engine 的 agent-tools/review-evidence.ts）。
//   · 已经结束的核查用操作层的 review_attempt.attach_evidence 补挂（页面入口和 Lead 的 perform_action 是同一个函数）：
//     只读那次核查的工作区，不重跑核查，不改交付和核查的结论，也不改工单的阶段。
//   · 文件和工单附件存在同一个地方（数据目录的 attachments/item-<工单号>/），类型和大小的限制也一样，只收图片。
//
// 线上契约（和附件一样单独两个接口，不放进 TicketSummary 和附件列表：旧客户端严格校验，加东西会整张列表失败）：
//   · GET /v1/tickets/:id/review-evidence（tickets:view）列出证据，不带文件内容。旧 daemon 没有这个接口（404），界面按没有证据画。
//   · GET /v1/tickets/:id/review-evidence/:evidenceId（tickets:view）取一张图的内容（base64），回答的形状和附件的一样。
import { Type, type Static } from "typebox";

import { TICKET_ATTACHMENT_MAX_PER_CALL, TICKET_ATTACHMENT_MAX_PER_TICKET } from "./ticket-attachments.ts";

export const REVIEW_EVIDENCE_ID_PATTERN = /^evd_[A-Za-z0-9_-]{1,64}$/;
// 一张工单最多挂几张证据（和附件一样）。
export const REVIEW_EVIDENCE_MAX_PER_TICKET = TICKET_ATTACHMENT_MAX_PER_TICKET;
// 一次最多挂几张（和附件一样）。
export const REVIEW_EVIDENCE_MAX_PER_CALL = TICKET_ATTACHMENT_MAX_PER_CALL;
// 一张证据的说明最多多少字。
export const REVIEW_EVIDENCE_CAPTION_MAX = 300;
// 工作区里的路径最长多少字。
export const REVIEW_EVIDENCE_PATH_MAX = 1024;
// 一张证据最多对应几条验收标准。
export const REVIEW_EVIDENCE_CRITERIA_MAX = 20;

// 谁挂的：核查员在核查时挂的（reviewer），或者核查结束以后经操作层补挂的（lead、user）。
export const REVIEW_EVIDENCE_ADDED_BY = ["reviewer", "lead", "user"] as const;
export type ReviewEvidenceAddedBy = typeof REVIEW_EVIDENCE_ADDED_BY[number];

export const ReviewEvidenceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  ticketId: Type.Integer({ minimum: 1 }),
  // 哪一次核查（核查员的执行记录编号）。
  attemptId: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  mimeType: Type.String({ minLength: 1, maxLength: 120 }),
  size: Type.Integer({ minimum: 0 }),
  // 对应的验收标准的 id（item_acceptance_criteria 的 id），按标准的顺序。工单没有验收标准时为空。
  criterionIds: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: REVIEW_EVIDENCE_CRITERIA_MAX }),
  // 核查员写的一句说明：这张图证明了什么。没写时为 null。
  caption: Type.Union([Type.String({ maxLength: REVIEW_EVIDENCE_CAPTION_MAX }), Type.Null()]),
  // 图片在核查工作区里的相对路径（只用来对账，不再去读）。
  path: Type.String({ minLength: 1, maxLength: REVIEW_EVIDENCE_PATH_MAX }),
  addedBy: Type.Union([Type.Literal("reviewer"), Type.Literal("lead"), Type.Literal("user")]),
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ReviewEvidence = Static<typeof ReviewEvidenceSchema>;

// GET /v1/tickets/:id/review-evidence 的回答。
export const ReviewEvidenceListSchema = Type.Object({
  items: Type.Array(ReviewEvidenceSchema, { maxItems: REVIEW_EVIDENCE_MAX_PER_TICKET }),
}, { additionalProperties: false });
export type ReviewEvidenceList = Static<typeof ReviewEvidenceListSchema>;

// 挂一张证据的输入：工作区里的路径、对应的验收标准、一句说明。核查员的工具和补挂的操作用同一个形状。
export const ReviewEvidenceFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: REVIEW_EVIDENCE_PATH_MAX }),
  criteria: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: REVIEW_EVIDENCE_CRITERIA_MAX }),
  caption: Type.Optional(Type.String({ maxLength: REVIEW_EVIDENCE_CAPTION_MAX })),
}, { additionalProperties: false });
export type ReviewEvidenceFile = Static<typeof ReviewEvidenceFileSchema>;

// 补挂（操作层 review_attempt.attach_evidence）的输入。
export const AttachReviewEvidenceRequestSchema = Type.Object({
  files: Type.Array(ReviewEvidenceFileSchema, { minItems: 1, maxItems: REVIEW_EVIDENCE_MAX_PER_CALL }),
}, { additionalProperties: false });
export type AttachReviewEvidenceRequest = Static<typeof AttachReviewEvidenceRequestSchema>;

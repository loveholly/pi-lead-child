// 工单的「这次交付」的线上契约（2026-10-20）。工单详情用它让用户验收：改了哪些文件、每个文件的全文或改动、
// 改动在哪个分支、能不能合并 / 开 PR / 放弃。
// - 单独的资源，不放进 TicketSummary：客户端严格校验工单列表，多一个字段旧页面整张列表都加载不出来。
// - GET /v1/tickets/:id/delivery 和 GET /v1/tickets/:id/delivery/file?path=&view=full|diff 用 tickets:view；
//   POST /v1/tickets/:id/delivery/(merge|open-pr|abandon) 用 tickets:create。
// - 这里会下发分支名（branch、target），但不下发仓库在服务器上的路径。文件路径都是仓库内的相对路径。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);

export const DeliveryFileViewSchema = Type.Union([Type.Literal("full"), Type.Literal("diff")]);
export type DeliveryFileView = Static<typeof DeliveryFileViewSchema>;

export const DeliveryFileSchema = StrictObject({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  previousPath: Nullable(Type.String({ maxLength: 1024 })),
  // 执行 agent 在成果里给这个文件起的名字和写的改动说明。
  label: Nullable(Type.String()),
  note: Nullable(Type.String()),
  status: Type.Union([
    Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"),
    Type.Literal("renamed"), Type.Literal("unchanged"),
  ]),
  additions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  deletions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  binary: Type.Boolean(),
  views: Type.Array(DeliveryFileViewSchema, { maxItems: 2 }),
  // 不能预览时的原因（可能含密钥、二进制、已删除）。
  hiddenReason: Nullable(Type.String()),
});
export type DeliveryFile = Static<typeof DeliveryFileSchema>;

export const DeliveryActionSchema = StrictObject({
  available: Type.Boolean(),
  reason: Nullable(Type.String()),
});
export type DeliveryAction = Static<typeof DeliveryActionSchema>;

export const TicketDeliverySchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  attemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  source: Type.Union([Type.Literal("isolated"), Type.Literal("shared"), Type.Literal("none")]),
  files: Type.Array(DeliveryFileSchema, { maxItems: 2000 }),
  // files 只列了前 2000 个（2026-10-21）。totals 照样算全部文件。
  truncated: Type.Boolean(),
  totals: Type.Union([
    StrictObject({
      files: Type.Integer({ minimum: 0 }),
      additions: Type.Integer({ minimum: 0 }),
      deletions: Type.Integer({ minimum: 0 }),
    }),
    Type.Null(),
  ]),
  workspace: Type.Union([
    StrictObject({
      workspaceId: Type.Integer({ minimum: 1 }),
      branch: Nullable(Type.String()),
      // 分支现在指向的提交。合并、开 PR、放弃时带回它（expectedHead），和 target（expectedTarget）一起：
      // 交付在用户看过以后变了，服务端返回 409，details.reason 是 stale。
      head: Nullable(Type.String()),
      target: Nullable(Type.String()),
      commits: Type.Integer({ minimum: 0 }),
      uncommittedFiles: Type.Integer({ minimum: 0 }),
      integration: Type.Union([
        Type.Literal("unmerged"), Type.Literal("merged"), Type.Literal("abandoned"),
        Type.Literal("conflict"), Type.Literal("no_changes"),
      ]),
      mergedInto: Nullable(Type.String()),
      pullRequestUrl: Nullable(Type.String()),
    }),
    Type.Null(),
  ]),
  actions: StrictObject({
    // acceptsTicket：工单还在 review，合并会先验收（界面上叫「验收并合并」）。
    merge: StrictObject({ available: Type.Boolean(), reason: Nullable(Type.String()), acceptsTicket: Type.Boolean() }),
    openPullRequest: DeliveryActionSchema,
    abandon: DeliveryActionSchema,
  }),
});
export type TicketDelivery = Static<typeof TicketDeliverySchema>;

export const TicketDeliveryResponseSchema = StrictObject({ delivery: TicketDeliverySchema });
export type TicketDeliveryResponse = Static<typeof TicketDeliveryResponseSchema>;

export const DeliveryFileContentSchema = StrictObject({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  view: DeliveryFileViewSchema,
  // markdown、diff、typescript……；不认识的扩展名是 text。
  language: Type.String({ minLength: 1, maxLength: 40 }),
  text: Type.String(),
  // 文件超过 400 KB 时只给前 400 KB。
  truncated: Type.Boolean(),
  byteLength: Type.Integer({ minimum: 0 }),
});
export type DeliveryFileContent = Static<typeof DeliveryFileContentSchema>;

export const DeliveryActionIdSchema = Type.Union([
  Type.Literal("merge"), Type.Literal("open-pr"), Type.Literal("abandon"),
]);
export type DeliveryActionId = Static<typeof DeliveryActionIdSchema>;

// POST /v1/tickets/:id/delivery/(merge|open-pr|abandon) 的请求体。都可以不给（不比较）。
export const DeliveryActionRequestSchema = StrictObject({
  expectedHead: Type.Optional(Nullable(Type.String({ minLength: 40, maxLength: 64 }))),
  expectedTarget: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 255 }))),
});
export type DeliveryActionRequest = Static<typeof DeliveryActionRequestSchema>;

export const DeliveryActionResultSchema = StrictObject({
  action: DeliveryActionIdSchema,
  delivery: TicketDeliverySchema,
  pullRequestUrl: Type.Optional(Type.String()),
});
export type DeliveryActionResult = Static<typeof DeliveryActionResultSchema>;

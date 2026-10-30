// 每一次交付的快照（工单 04，spec 5.5、D8）的线上契约。交付切换用：界面显示最新一次交付，带「第 1 次交付」切换。
// - 单独的资源，不改 delivery.ts 的 TicketDeliverySchema：客户端严格校验，多一个字段旧页面整个交付页都加载不出来。
// - GET /v1/tickets/:id/deliveries：每一次交付的摘要，按顺序。
// - GET /v1/tickets/:id/deliveries/:sequence?revision=：第 sequence 次交付的一份快照。不给 revision 时是最新一份。
//   都用 tickets:view。不下发仓库在服务器上的路径；文件路径都是仓库内的相对路径。
// - 存储叫 run，线上叫 attempt（attemptId、triggerAttemptId）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const NullableString = (options: Parameters<typeof Type.String>[0] = {}) => Type.Union([Type.String(options), Type.Null()]);

// delivered：交付时存的；workspace_changed：交付以后工作区又变了，同一次交付再存的一份。
export const DeliverySnapshotReasonSchema = Type.Union([Type.Literal("delivered"), Type.Literal("workspace_changed")]);
export type DeliverySnapshotReason = Static<typeof DeliverySnapshotReasonSchema>;

// git：系统跑 diff 得到的（隔离分支）；agent：执行 agent 自己报的文件（不是隔离分支的工单，或者分支已经找不到了）。
export const DeliverySnapshotSourceSchema = Type.Union([Type.Literal("git"), Type.Literal("agent")]);
export type DeliverySnapshotSource = Static<typeof DeliverySnapshotSourceSchema>;

export const DeliverySnapshotTotalsSchema = StrictObject({
  files: Type.Integer({ minimum: 0 }),
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
});

export const DeliverySnapshotFileSchema = StrictObject({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  previousPath: NullableString({ maxLength: 1024 }),
  // 执行 agent 在成果里给这个文件起的名字和写的说明。有说明的文件排在前面。
  label: NullableString(),
  note: NullableString(),
  // source=agent 时为 null：agent 只报了文件，没有报状态。
  status: Type.Union([
    Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"),
    Type.Literal("renamed"), Type.Literal("unchanged"), Type.Null(),
  ]),
  additions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  deletions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  binary: Type.Boolean(),
  // lock 文件和生成的文件（只按路径认），界面默认收起。排在最后。
  generated: Type.Union([Type.Literal("lock"), Type.Literal("generated"), Type.Null()]),
  // 不能显示的原因（可能含密钥、二进制、已删除、分支已经不在了）。能显示时为 null。
  hiddenReason: NullableString(),
});
export type DeliverySnapshotFile = Static<typeof DeliverySnapshotFileSchema>;

export const DeliverySnapshotCommitSchema = StrictObject({
  sha: Type.String({ minLength: 40, maxLength: 64 }),
  subject: Type.String({ maxLength: 300 }),
});
export type DeliverySnapshotCommit = Static<typeof DeliverySnapshotCommitSchema>;

export const DeliverySummarySchema = StrictObject({
  sequence: Type.Integer({ minimum: 1 }),
  attemptId: Type.Integer({ minimum: 1 }),
  // 这次交付存了几份。下面的字段是最新一份的。
  revisions: Type.Integer({ minimum: 1 }),
  reason: DeliverySnapshotReasonSchema,
  source: DeliverySnapshotSourceSchema,
  // 交付时没有存，打开工单时补存的（快照上线以前的交付）。
  backfilled: Type.Boolean(),
  head: NullableString({ maxLength: 64 }),
  commitCount: Type.Integer({ minimum: 0 }),
  totals: Type.Union([DeliverySnapshotTotalsSchema, Type.Null()]),
  deliveredAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
});
export type DeliverySummary = Static<typeof DeliverySummarySchema>;

export const TicketDeliveriesResponseSchema = StrictObject({
  deliveries: Type.Array(DeliverySummarySchema, { maxItems: 1000 }),
});
export type TicketDeliveriesResponse = Static<typeof TicketDeliveriesResponseSchema>;

export const TicketDeliverySnapshotSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  revisions: Type.Integer({ minimum: 1 }),
  attemptId: Type.Integer({ minimum: 1 }),
  reason: DeliverySnapshotReasonSchema,
  source: DeliverySnapshotSourceSchema,
  backfilled: Type.Boolean(),
  // 存这一份时刚结束的那个 Attempt，和它是做什么的：对话、核查、执行（返工中取消时是没交付的执行）、其他。
  // 打开工单时发现的，两个都是 null。
  triggerAttemptId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  triggerKind: Type.Union([
    Type.Literal("conversation"), Type.Literal("review"), Type.Literal("execution"), Type.Literal("other"), Type.Null(),
  ]),
  base: NullableString({ maxLength: 64 }),
  head: NullableString({ maxLength: 64 }),
  // 最多 200 个提交；commitCount 数全部。
  commits: Type.Array(DeliverySnapshotCommitSchema, { maxItems: 200 }),
  commitCount: Type.Integer({ minimum: 0 }),
  // 最多 2000 个文件，超过时 truncated 为 true；totals 算全部改动的文件。source=agent 时 totals 为 null。
  files: Type.Array(DeliverySnapshotFileSchema, { maxItems: 2000 }),
  truncated: Type.Boolean(),
  totals: Type.Union([DeliverySnapshotTotalsSchema, Type.Null()]),
  // 存的时候 worktree 里没提交的文件数。source=agent 时为 null。
  uncommittedFiles: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  capturedAt: Type.String({ minLength: 1 }),
});
export type TicketDeliverySnapshot = Static<typeof TicketDeliverySnapshotSchema>;

export const TicketDeliverySnapshotResponseSchema = StrictObject({ delivery: TicketDeliverySnapshotSchema });
export type TicketDeliverySnapshotResponse = Static<typeof TicketDeliverySnapshotResponseSchema>;

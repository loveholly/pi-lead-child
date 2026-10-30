// 网关上给 plc 用的路由：管理路由（admin scope）、runtime 重检、列表视图，以及对 lead 授权的查询。
// plc 和 companion 一样是 daemon 的客户端，这些路由就是它不再直接打开账本之后需要的那部分契约。
import { Type, type Static, type TProperties } from "typebox";
import { KernelRuntimeIdSchema } from "./runtime-ids.ts";
import { BindingDtoSchema, ScopeSchema, type Scope } from "./scopes.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 管理权限：配对、撤销 binding、查看和删除 aish 凭证、重检 runtime。配对码、loopback 自动配对和
// plc 存在文件里的凭证都不带它；只有 plc.sock 上换来的临时 admin token 带它（见 local-sockets.ts）。
export const ADMIN_SCOPE: Scope = "admin";

// GET /v1/tickets?view=…：视图的含义只在 store 里定义一次（spec §9），网关原样转交。
export const TICKET_LIST_VIEWS = ["tasks", "drafts", "reminders", "all"] as const;
export type TicketListView = typeof TICKET_LIST_VIEWS[number];

// GET /v1/paired/me：凭证证明自己是哪一个 binding。plc auth login 撤销旧凭证之前用它核对。
export const OwnBindingResponseSchema = StrictObject({ binding: BindingDtoSchema });
export type OwnBindingResponse = Static<typeof OwnBindingResponseSchema>;

export const PairingKindSchema = Type.Union([
  Type.Literal("desktop"), Type.Literal("companion"), Type.Literal("cli"),
]);
export type PairingKind = Static<typeof PairingKindSchema>;

// POST /v1/admin/pairings。没有 scopes 字段：配对码只能换到缺省的 scope。
export const CreatePairingRequestSchema = StrictObject({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  kind: PairingKindSchema,
  // 填了就生成扫码用的 socket 配对邀请（ws://局域网地址:端口）。
  endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
});
export type CreatePairingRequest = Static<typeof CreatePairingRequestSchema>;

export const CreatePairingResponseSchema = StrictObject({
  pairingId: Type.Integer({ minimum: 1 }),
  code: Type.String({ minLength: 1 }),
  expiresAt: Type.String(),
  uri: Type.Union([Type.String(), Type.Null()]),
});
export type CreatePairingResponse = Static<typeof CreatePairingResponseSchema>;

export const AdminBindingSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  name: Type.String(),
  status: Type.String(),
  scopes: Type.Array(ScopeSchema),
  lastSeenAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type AdminBinding = Static<typeof AdminBindingSchema>;

export const AdminBindingListResponseSchema = StrictObject({ items: Type.Array(AdminBindingSchema) });
export const RevokeBindingResponseSchema = StrictObject({ binding: AdminBindingSchema });

// daemon 进程环境里的 PLC_AISH_TOKEN 和已保存凭证的关系。只给结论，不给 token。
export const AishEnvTokenStateSchema = Type.Union([
  Type.Literal("unset"),
  Type.Literal("set"),
  Type.Literal("same_as_stored"),
  Type.Literal("different_from_stored"),
  Type.Literal("marked_failed"),
]);
export type AishEnvTokenState = Static<typeof AishEnvTokenStateSchema>;

export const AishCredentialStatusSchema = StrictObject({
  stored: Type.Boolean(),
  url: Type.Union([Type.String(), Type.Null()]),
  failure: Type.Union([StrictObject({ reason: Type.String(), at: Type.String() }), Type.Null()]),
  envToken: AishEnvTokenStateSchema,
});
export type AishCredentialStatus = Static<typeof AishCredentialStatusSchema>;

export const AishForgetResponseSchema = StrictObject({
  removed: Type.Boolean(),
  // daemon 环境里还有 PLC_AISH_TOKEN 时，下次启动会重新保存它。
  envTokenSet: Type.Boolean(),
});
export type AishForgetResponse = Static<typeof AishForgetResponseSchema>;

// POST /v1/runtimes/recheck：不写 runtime 就重检所有没关闭的故障。
export const RuntimeRecheckRequestSchema = StrictObject({
  runtime: Type.Optional(KernelRuntimeIdSchema),
});
export type RuntimeRecheckRequest = Static<typeof RuntimeRecheckRequestSchema>;

export const RuntimeRecheckResultSchema = StrictObject({
  incidentId: Type.Integer({ minimum: 1 }),
  runtime: KernelRuntimeIdSchema,
  outcome: Type.String(),
  // 给人看的一句话，plc recheck 原样打印。
  summary: Type.String(),
});
export const RuntimeRecheckResponseSchema = StrictObject({ results: Type.Array(RuntimeRecheckResultSchema) });
export type RuntimeRecheckResponse = Static<typeof RuntimeRecheckResponseSchema>;

// 键名沿用 lead_grants 表的列名：这条路由一直这样返回。
export const LeadGrantDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  capability: Type.Literal("confirm_item"),
  granted_at: Type.String(),
  granted_via: Type.String(),
  revoked_at: Type.Union([Type.String(), Type.Null()]),
  revoked_via: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
});
export type LeadGrantDto = Static<typeof LeadGrantDtoSchema>;

// GET /v1/lead/trust
export const LeadTrustStatusSchema = StrictObject({
  capability: Type.Literal("confirm_item"),
  grant: Type.Union([LeadGrantDtoSchema, Type.Null()]),
});
export type LeadTrustStatus = Static<typeof LeadTrustStatusSchema>;

// POST /v1/lead/trust
export const LeadTrustUpdateSchema = Type.Union([
  StrictObject({ capability: Type.Literal("confirm_item"), granted: Type.Literal(true), grant: LeadGrantDtoSchema }),
  StrictObject({
    capability: Type.Literal("confirm_item"), granted: Type.Literal(false),
    revoked: Type.Integer({ minimum: 0 }), grant: Type.Null(),
  }),
]);
export type LeadTrustUpdate = Static<typeof LeadTrustUpdateSchema>;

// GET /v1/lead/delegation?ticket_id=…。policy 的键名沿用 delegation_policies 表的列名。
const DelegationPolicyDtoSchema = Type.Record(Type.String(), Type.Unknown());
export const LeadDelegationStatusSchema = StrictObject({
  ticketId: Type.Integer({ minimum: 1 }),
  active: Type.Union([DelegationPolicyDtoSchema, Type.Null()]),
  history: Type.Array(DelegationPolicyDtoSchema),
});
export type LeadDelegationStatus = Static<typeof LeadDelegationStatusSchema>;

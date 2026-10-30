// 连接（设置页的「连接」）的线上契约。daemon 是唯一的 OAuth 客户端：客户端只看到状态和授权地址，
// 看不到任何令牌。路由都是 GET 或 POST（网关的 CORS 只放行这两种）。
//
// key 是一个连接在线上的名字：预设服务就是服务 id（"notion"），自定义 MCP 是 "custom-<id>"。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);

export const ConnectionProviderSchema = Type.Union([
  Type.Literal("atlassian"), Type.Literal("notion"), Type.Literal("github"),
  Type.Literal("slack"), Type.Literal("google"), Type.Literal("custom"),
]);
export type ConnectionProvider = Static<typeof ConnectionProviderSchema>;

// not_connected：可以一键连接。needs_setup：要先配置预注册客户端（Slack）或设备码的 client ID（GitHub 没有 gh 时）。
// unavailable：暂不支持（Google）。degraded：暂时连不上，daemon 在退避重试，不需要你做什么。
// needs_reauth：要你重新授权。
export const ConnectionStateSchema = Type.Union([
  Type.Literal("not_connected"), Type.Literal("connected"), Type.Literal("degraded"),
  Type.Literal("needs_reauth"), Type.Literal("needs_setup"), Type.Literal("unavailable"),
]);
export type ConnectionState = Static<typeof ConnectionStateSchema>;

export const ConnectionRoleSchema = Type.Union([Type.Literal("lead"), Type.Literal("executor"), Type.Literal("reviewer")]);
export type ConnectionRole = Static<typeof ConnectionRoleSchema>;

export const ConnectionWritePolicySchema = Type.Union([Type.Literal("confirm"), Type.Literal("direct")]);
export type ConnectionWritePolicy = Static<typeof ConnectionWritePolicySchema>;

export const ConnectionTokenSourceSchema = Type.Union([
  Type.Literal("oauth"), Type.Literal("gh_cli"), Type.Literal("device"), Type.Literal("pat"),
]);
export type ConnectionTokenSource = Static<typeof ConnectionTokenSourceSchema>;

export const ConnectionProblemKindSchema = Type.Union([
  Type.Literal("transient"), Type.Literal("invalid_grant"), Type.Literal("invalid_client"),
  Type.Literal("insufficient_scope"), Type.Literal("unavailable"), Type.Literal("expiring"),
]);
export type ConnectionProblemKind = Static<typeof ConnectionProblemKindSchema>;

export const ConnectionProblemSchema = StrictObject({
  kind: ConnectionProblemKindSchema,
  message: Type.String(),
  since: Nullable(Type.String()),
  nextAttemptAt: Nullable(Type.String()),
});
export type ConnectionProblem = Static<typeof ConnectionProblemSchema>;

export const ConnectionToolCountsSchema = StrictObject({
  total: Type.Integer({ minimum: 0 }),
  readOnly: Type.Integer({ minimum: 0 }),
  write: Type.Integer({ minimum: 0 }),
});

export const ConnectionDtoSchema = StrictObject({
  key: Type.String({ minLength: 1, maxLength: 40 }),
  provider: ConnectionProviderSchema,
  label: Type.String(),
  capability: Type.String(),
  serverUrl: Nullable(Type.String()),
  state: ConnectionStateSchema,
  account: Nullable(Type.String()),
  tokenSource: Type.Union([ConnectionTokenSourceSchema, Type.Null()]),
  connectedAt: Nullable(Type.String()),
  lastUsedAt: Nullable(Type.String()),
  lastRefreshAt: Nullable(Type.String()),
  accessExpiresAt: Nullable(Type.String()),
  grantExpiresAt: Nullable(Type.String()),
  // 要你处理或者要你知道的事。connected 且一切正常时为 null。
  problem: Type.Union([ConnectionProblemSchema, Type.Null()]),
  tools: Type.Union([ConnectionToolCountsSchema, Type.Null()]),
  roles: Type.Array(ConnectionRoleSchema),
  writePolicy: ConnectionWritePolicySchema,
  // needs_setup / unavailable 时的一句说明。
  setupHint: Nullable(Type.String()),
});
export type ConnectionDto = Static<typeof ConnectionDtoSchema>;

export const ConnectionListResponseSchema = StrictObject({
  items: Type.Array(ConnectionDtoSchema),
  // 要你处理的连接数（needs_reauth，以及快到期的授权）。设置入口的角标和健康条用它。
  attention: Type.Integer({ minimum: 0 }),
});
export type ConnectionListResponse = Static<typeof ConnectionListResponseSchema>;

// POST /v1/connections/:key/start 的请求体。都可以省略：token 只给 GitHub 的「粘贴 PAT」用。
export const StartConnectionRequestSchema = StrictObject({
  token: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

// POST /v1/connections/custom 的请求体。
export const AddCustomConnectionRequestSchema = StrictObject({
  serverUrl: Type.String({ minLength: 8, maxLength: 512 }),
});

export const StartConnectionResponseSchema = Type.Union([
  StrictObject({
    flow: Type.Literal("browser"),
    flowId: Type.String(),
    authorizeUrl: Type.String(),
    expiresAt: Type.String(),
  }),
  StrictObject({
    flow: Type.Literal("device"),
    flowId: Type.String(),
    userCode: Type.String(),
    verificationUri: Type.String(),
    expiresAt: Type.String(),
  }),
  StrictObject({
    flow: Type.Literal("connected"),
    connection: ConnectionDtoSchema,
  }),
]);
export type StartConnectionResponse = Static<typeof StartConnectionResponseSchema>;

export const ConnectionFlowStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("connected"), Type.Literal("failed"), Type.Literal("expired"),
]);

export const ConnectionFlowResponseSchema = StrictObject({
  flowId: Type.String(),
  state: ConnectionFlowStateSchema,
  message: Nullable(Type.String()),
  connection: Type.Union([ConnectionDtoSchema, Type.Null()]),
});
export type ConnectionFlowResponse = Static<typeof ConnectionFlowResponseSchema>;

export const ConnectionSettingsRequestSchema = StrictObject({
  roles: Type.Optional(Type.Array(ConnectionRoleSchema, { maxItems: 3 })),
  writePolicy: Type.Optional(ConnectionWritePolicySchema),
});
export type ConnectionSettingsRequest = Static<typeof ConnectionSettingsRequestSchema>;

// ——— 连接的权限设置：谁能用（roles）和写入策略（writePolicy）———
// 这两项决定 child 能不能不经确认就写外部服务（2026-10-19 审查：一个 child 用 sqlite3 把 GitHub 改成了 direct）。
// daemon 核对、网关的「不是我」撤销、事件都用下面这几个函数比较「更严」还是「更松」。

export const CONNECTION_ROLES: readonly ConnectionRole[] = ["lead", "executor", "reviewer"];

export interface ConnectionSettings {
  roles: ConnectionRole[];
  writePolicy: ConnectionWritePolicy;
}

// 缺省设置：三个角色都能用，写入先问我。和 store 的 insertConnection 一致。
export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = { roles: [...CONNECTION_ROLES], writePolicy: "confirm" };

/** 去掉不认识的角色和重复，按固定顺序排。写入策略不认识时按 confirm（更严）。 */
export function normalizeConnectionSettings(input: { roles: readonly unknown[]; writePolicy: unknown }): ConnectionSettings {
  return {
    roles: CONNECTION_ROLES.filter((role) => input.roles.includes(role)),
    writePolicy: input.writePolicy === "direct" ? "direct" : "confirm",
  };
}

export function sameConnectionSettings(a: ConnectionSettings, b: ConnectionSettings): boolean {
  return a.writePolicy === b.writePolicy && a.roles.length === b.roles.length && a.roles.every((role, i) => b.roles[i] === role);
}

/** 两份设置里更严的那一份：角色取交集，任一份是 confirm 就是 confirm。 */
export function stricterConnectionSettings(a: ConnectionSettings, b: ConnectionSettings): ConnectionSettings {
  return {
    roles: CONNECTION_ROLES.filter((role) => a.roles.includes(role) && b.roles.includes(role)),
    writePolicy: a.writePolicy === "confirm" || b.writePolicy === "confirm" ? "confirm" : "direct",
  };
}

/** after 比 before 多放开了什么：新加的角色，和写入策略从 confirm 变成 direct。 */
export function loosenedConnectionSettings(before: ConnectionSettings, after: ConnectionSettings): {
  addedRoles: ConnectionRole[]; writePolicy: boolean;
} {
  return {
    addedRoles: after.roles.filter((role) => !before.roles.includes(role)),
    writePolicy: before.writePolicy === "confirm" && after.writePolicy === "direct",
  };
}

export function connectionSettingsLoosened(before: ConnectionSettings, after: ConnectionSettings): boolean {
  const loosened = loosenedConnectionSettings(before, after);
  return loosened.writePolicy || loosened.addedRoles.length > 0;
}

const ROLE_WORDS: Record<ConnectionRole, string> = { lead: "Lead", executor: "执行工单的 agent", reviewer: "评审 agent" };

const whoWords = (settings: ConnectionSettings): string => (settings.roles.length ? settings.roles.map((role) => ROLE_WORDS[role]).join("、") : "谁都不能用");
const writeWords = (settings: ConnectionSettings): string => (settings.writePolicy === "direct" ? "直接执行" : "先问我");

/** 给人看的一句话，例如「Lead、执行工单的 agent 可以用；写入先问我」。 */
export function describeConnectionSettings(settings: ConnectionSettings): string {
  return `${settings.roles.length ? `${whoWords(settings)}可以用` : "谁都不能用"}；写入${writeWords(settings)}`;
}

/** 只写变了的那几项，例如「写入从「先问我」改成「直接执行」」。没有变化时是 null（2026-10-28：会话里的记录只占一行）。 */
export function describeConnectionSettingsChange(before: ConnectionSettings, after: ConnectionSettings): string | null {
  const parts: string[] = [];
  if (whoWords(before) !== whoWords(after)) parts.push(`可以用的从「${whoWords(before)}」改成「${whoWords(after)}」`);
  if (before.writePolicy !== after.writePolicy) parts.push(`写入从「${writeWords(before)}」改成「${writeWords(after)}」`);
  return parts.length ? parts.join("；") : null;
}

export const ConnectionResponseSchema = StrictObject({ connection: ConnectionDtoSchema });
export type ConnectionResponse = Static<typeof ConnectionResponseSchema>;

export const ConnectionTestResponseSchema = StrictObject({
  ok: Type.Boolean(),
  message: Type.String(),
  connection: ConnectionDtoSchema,
});
export type ConnectionTestResponse = Static<typeof ConnectionTestResponseSchema>;

export const ConnectionToolDtoSchema = StrictObject({
  name: Type.String(),
  title: Nullable(Type.String()),
  description: Nullable(Type.String()),
  readOnly: Type.Boolean(),
});
export type ConnectionToolDto = Static<typeof ConnectionToolDtoSchema>;

export const ConnectionToolListResponseSchema = StrictObject({ items: Type.Array(ConnectionToolDtoSchema) });
export type ConnectionToolListResponse = Static<typeof ConnectionToolListResponseSchema>;

// 写入确认（写入策略是「先问我」时）。Lead 调一个会写入的工具时，daemon 不执行，先存下这一次调用（参数原样），
// 给一个确认号。Lead 用 render_ui 发一张 ConnectionConfirm 卡；你点「允许」后 daemon 执行存下的那一次调用，
// 结果交给 Lead。确认只能经网关由你来点：Lead 的工具走不到这条路由。
export const ConnectionConfirmationStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"),
  Type.Literal("rejected"), Type.Literal("expired"),
]);
export type ConnectionConfirmationState = Static<typeof ConnectionConfirmationStateSchema>;

export const ConnectionConfirmationDtoSchema = StrictObject({
  id: Type.String({ pattern: "^cfm_[A-Za-z0-9_-]{8,40}$" }),
  key: Type.String(),
  label: Type.String(),
  tool: Type.String(),
  summary: Type.String(),
  // 参数的 JSON，最多 2000 个字符。给你核对 Lead 要写的到底是什么。
  argumentsPreview: Type.String(),
  state: ConnectionConfirmationStateSchema,
  createdAt: Type.String(),
  expiresAt: Type.String(),
  resolvedBy: Nullable(Type.String()),
  // 执行后的结果摘要（最多 500 个字符），或者失败的原因。
  resultPreview: Nullable(Type.String()),
});
export type ConnectionConfirmationDto = Static<typeof ConnectionConfirmationDtoSchema>;

export const ConnectionConfirmationResponseSchema = StrictObject({ confirmation: ConnectionConfirmationDtoSchema });
export type ConnectionConfirmationResponse = Static<typeof ConnectionConfirmationResponseSchema>;

export const ResolveConnectionConfirmationRequestSchema = StrictObject({ approve: Type.Boolean() });

// 连接状态变了以后，网关推一条 snapshot.required，payload 是这个。客户端据此重取 /v1/connections。
export const CONNECTIONS_SNAPSHOT_RESOURCE = "connections";

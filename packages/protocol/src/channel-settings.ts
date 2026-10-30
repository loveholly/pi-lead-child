// 外部通道的凭据设置（设置页「Slack 通道」，2026-10-20）的线上契约。这里不出现具体来源的名字：
// 来源插件声明自己要哪些密钥、怎么校验、应用清单是什么；daemon 和网关只按这里的形状转交。
// - GET /v1/channels/settings：每个来源一行，只有状态，不含任何密钥的值。读用 tickets:view。
// - POST /v1/channels/settings/:source/test：用请求里的密钥试一次（不保存）。
// - PUT /v1/channels/settings/:source：先试，全部检查通过才保存（daemon 的加密保险库）并马上重连；没通过回 400 带检查结果。
// - DELETE /v1/channels/settings/:source：删掉保险库里的密钥并断开。Keychain 或环境变量里的密钥不动（卡上说明）。
// test、PUT、DELETE 要 tickets:create，并且只接受本机网页（网关是明文 HTTP，密钥不能经过局域网）。
// PUT、DELETE 是主人操作（owner_action，id channel.credentials）：手机上有提醒，「不是我」删掉密钥并断开。
// 状态变了网关发 snapshot.required，payload 是 {resource: "channel-settings"}，客户端重新 GET。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));
const Nullable = <T extends TProperties[string]>(schema: T) => Type.Union([schema, Type.Null()]);

export const CHANNEL_SETTINGS_SNAPSHOT_RESOURCE = "channel-settings";

/** 密钥从哪里来。vault：设置页存的（加密保险库）；keychain：macOS Keychain；env：daemon 专用环境变量。 */
export const CHANNEL_SECRET_ORIGINS = ["vault", "keychain", "env"] as const;
export type ChannelSecretOrigin = typeof CHANNEL_SECRET_ORIGINS[number];

/** 来源的连接状态。 */
export const CHANNEL_SOURCE_STATUSES = ["not_configured", "connecting", "connected", "error"] as const;
export type ChannelSourceStatus = typeof CHANNEL_SOURCE_STATUSES[number];

export const ChannelSecretSettingSchema = StrictObject({
  // 密钥的名字（例如 PLC_SLACK_APP_TOKEN）。
  name: Type.String({ minLength: 1, maxLength: 100 }),
  // 给人看的名字（例如「App-Level Token」）。
  label: Type.String({ minLength: 1, maxLength: 100 }),
  // 这个密钥应该以什么开头（例如 xapp-），界面提示用；校验由来源插件做。
  prefix: Type.String({ maxLength: 20 }),
  // 在哪里生成它（给人看的一句话）。
  hint: Type.String({ maxLength: 300 }),
  present: Type.Boolean(),
  origin: Nullable(Literals(CHANNEL_SECRET_ORIGINS)),
});
export type ChannelSecretSetting = Static<typeof ChannelSecretSettingSchema>;

export const ChannelSourceAccountSchema = StrictObject({
  userId: Type.String({ maxLength: 100 }),
  userName: Type.String({ maxLength: 200 }),
  teamId: Type.String({ maxLength: 100 }),
  teamName: Type.String({ maxLength: 200 }),
});
export type ChannelSourceAccount = Static<typeof ChannelSourceAccountSchema>;

export const ChannelSourceSettingsDtoSchema = StrictObject({
  source: Type.String({ minLength: 1, maxLength: 60 }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  status: Literals(CHANNEL_SOURCE_STATUSES),
  // 连上的是谁（用户本人的账号和工作区）。没有连上时是 null。
  account: Nullable(ChannelSourceAccountSchema),
  // 令牌缺哪些权限（最近一次校验的结果）。
  missingScopes: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 }),
  // 最近一次出错的原因（不含密钥）。
  lastError: Nullable(Type.String({ maxLength: 500 })),
  lastConnectedAt: Nullable(Type.String()),
  secrets: Type.Array(ChannelSecretSettingSchema, { maxItems: 8 }),
  // 建应用用的清单（例如 Slack 的 YAML），给「复制」按钮。来源没有清单时是 null。
  manifest: Nullable(Type.String({ maxLength: 8_000 })),
  // 建应用的网页。
  setupUrl: Nullable(Type.String({ maxLength: 500 })),
  // 这个调用方能不能在这里改密钥：只有本机网页能改。
  editable: Type.Boolean(),
});
export type ChannelSourceSettingsDto = Static<typeof ChannelSourceSettingsDtoSchema>;

export const ChannelSettingsResponseSchema = StrictObject({
  sources: Type.Array(ChannelSourceSettingsDtoSchema, { maxItems: 16 }),
});
export type ChannelSettingsResponse = Static<typeof ChannelSettingsResponseSchema>;

/** test、PUT 的请求体：密钥名 → 值。只能是这个来源声明过的名字。 */
export const ChannelSecretsRequestSchema = StrictObject({
  secrets: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.String({ minLength: 1, maxLength: 1_000 })),
});
export type ChannelSecretsRequest = Static<typeof ChannelSecretsRequestSchema>;

export const ChannelSecretCheckSchema = StrictObject({
  // 检查的编号（例如 user_token_kind、scopes、socket_mode）。
  id: Type.String({ minLength: 1, maxLength: 60 }),
  label: Type.String({ minLength: 1, maxLength: 100 }),
  pass: Type.Boolean(),
  // 给人看的一句话（不含密钥）。
  detail: Type.String({ maxLength: 500 }),
});
export type ChannelSecretCheck = Static<typeof ChannelSecretCheckSchema>;

/** test 的结果；PUT 没通过时 400 的 details 也是这个形状。 */
export const ChannelSecretsTestResultSchema = StrictObject({
  ok: Type.Boolean(),
  checks: Type.Array(ChannelSecretCheckSchema, { maxItems: 20 }),
  account: Nullable(ChannelSourceAccountSchema),
  missingScopes: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 }),
});
export type ChannelSecretsTestResult = Static<typeof ChannelSecretsTestResultSchema>;

/** PUT、DELETE 的响应：这个来源现在的样子。 */
export const ChannelSourceSettingsResponseSchema = StrictObject({ source: ChannelSourceSettingsDtoSchema });
export type ChannelSourceSettingsResponse = Static<typeof ChannelSourceSettingsResponseSchema>;

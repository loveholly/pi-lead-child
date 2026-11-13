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

/**
 * 建应用的网页地址最长多少个字符。地址里可以带上整份清单（例如 Slack 的 new_app=1&manifest_yaml=…），来源插件超过时退回不带清单的地址。
 * 2000：比浏览器和代理常见的下限（2048）还小；RFC 9110 只建议至少支持 8000。
 */
export const CHANNEL_SETUP_URL_MAX = 2_000;

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
  // 存了令牌、连上了很久却一个事件都没收到时给人看的提醒（该查哪里、怎样验证，来源插件写的）。没有时是 null。
  noEventsWarning: Nullable(Type.String({ maxLength: 1_000 })),
  secrets: Type.Array(ChannelSecretSettingSchema, { maxItems: 8 }),
  // 建应用用的清单（例如 Slack 的 YAML），给「复制」按钮。来源没有清单时是 null。
  manifest: Nullable(Type.String({ maxLength: 8_000 })),
  // 建应用的网页（可以带上清单，最长 CHANNEL_SETUP_URL_MAX）。
  setupUrl: Nullable(Type.String({ maxLength: CHANNEL_SETUP_URL_MAX })),
  // 建应用的要点（来源插件写的，按界面语言）。没有时是 null。
  setupNote: Nullable(Type.String({ maxLength: 1_000 })),
  // 这个调用方能不能在这里改密钥：只有本机网页能改。
  editable: Type.Boolean(),
});
export type ChannelSourceSettingsDto = Static<typeof ChannelSourceSettingsDtoSchema>;

export const ChannelSettingsResponseSchema = StrictObject({
  sources: Type.Array(ChannelSourceSettingsDtoSchema, { maxItems: 16 }),
});
export type ChannelSettingsResponse = Static<typeof ChannelSettingsResponseSchema>;

/**
 * 一个密钥的值最多多少个字符：线上契约的上限，客户端、网关和设置页都按它查。浏览器会话的 cookie 比令牌长得多
 * （Slack 网页版的 d cookie 可能超过 1000 个字符，2026-11-04），所以按 16 KB 留足余量。来源插件可以给自己的密钥
 * 声明更小的上限（engine 的 ChannelSecretSpec.maxLength，daemon 查），应用令牌仍是 1000 个字符。
 */
export const CHANNEL_SECRET_MAX_LENGTH = 16_384;

/** test、PUT 的请求体：密钥名 → 值。只能是这个来源声明过的名字。test 可以是空的：用现在生效的密钥试。 */
export const ChannelSecretsRequestSchema = StrictObject({
  secrets: Type.Record(
    Type.String({ minLength: 1, maxLength: 100 }), Type.String({ minLength: 1, maxLength: CHANNEL_SECRET_MAX_LENGTH }),
  ),
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

// ── 连接方式（2026-11-02）──────────────────────────────────────────────────────────
// GET /v1/channels/settings/:source/connection：有几种连接方式的来源（例如 Slack 的 Slack 应用和浏览器会话）现在用哪种、
// 能选哪些、「代你往来源里写」开关、最近一次登录。只有一种方式的来源回 404。改动走通用的操作入口
// （POST /v1/actions/channel_connection/<来源>/<操作>），它的 result 也是这个形状。没有密钥。
// 单独一个路由，不加进上面的 DTO：DTO 是严格的，旧的客户端见到多出的字段会整个丢掉。

const ConnectionModeName = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" });

export const CHANNEL_SIGN_IN_FAILURES = ["cancelled", "window_closed", "timed_out", "no_browser", "checks_failed", "failed"] as const;

export const ChannelConnectionDtoSchema = StrictObject({
  source: Type.String({ minLength: 1, maxLength: 60 }),
  mode: ConnectionModeName,
  modes: Type.Array(StrictObject({ mode: ConnectionModeName, needsSignIn: Type.Boolean(), writesSwitch: Type.Boolean() }), { maxItems: 8 }),
  // 现在的方式要单独打开「代你往来源里写」时是开关的值，不需要时是 null。
  writes: Nullable(Type.Boolean()),
  signIn: Nullable(StrictObject({
    mode: ConnectionModeName,
    state: Type.Union([Type.Literal("waiting"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
    startedAt: Type.String({ maxLength: 40 }),
    expiresAt: Nullable(Type.String({ maxLength: 40 })),
    code: Nullable(Type.Union([
      Type.Literal("cancelled"), Type.Literal("window_closed"), Type.Literal("timed_out"), Type.Literal("no_browser"),
      Type.Literal("checks_failed"), Type.Literal("failed"),
    ])),
  })),
});
export type ChannelConnectionDto = Static<typeof ChannelConnectionDtoSchema>;

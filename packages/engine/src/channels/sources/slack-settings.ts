// Slack 通道的凭据设置（设置页「Slack 通道」，2026-10-20；protocol 的 channel-settings.ts，slack-settings 工单 S1）。
// 这里是 Slack 插件声明的 ChannelSettingsSpec：要哪两个令牌、建应用用的清单（YAML）、怎样检查一组令牌。
// 检查（test）不保存，也不建 WebSocket：
//   1. 格式：App-Level Token 以 xapp- 开头；User Token 以 xoxp- 开头。是 bot token（xoxb-）时明确说要的是你本人的 user token。
//   2. auth.test（User Token）：成功，并且结果里没有 bot_id（不是机器人）。取出用户编号、名字、工作区；users.info 取显示名。
//   3. 权限：auth.test 的结果里 response_metadata.scopes（WebClient 从 x-oauth-scopes 头取的）和要求的清单比，列出缺的。
//   4. apps.connections.open（App-Level Token）：成功即可（拿到的地址不用）。
// 结果里的文字不含令牌：先把这次的两个令牌原样换掉，再按通用的规则脱敏。
// 连上了却一直收不到事件时（daemon 判断），设置页显示 noEventsWarning：这段时间没人发消息可以忽略；否则查用户事件的订阅、
// User Token Scopes，别人也装了这个应用时还有 App-Level Token 的 authorizations:read（visibleToUser 要用它）。
// 浏览器会话方式（2026-11-02）另有一份：只要会话 cookie，检查见 createSlackSessionSettings。
import { SLACK_APP_TOKEN_ENV, SLACK_SESSION_COOKIE_ENV, SLACK_USER_TOKEN_ENV } from "@pi-lead-child/core";
import { CHANNEL_SETUP_URL_MAX, type ChannelSecretCheck, type ChannelSecretsTestResult, type ChannelSourceAccount } from "@pi-lead-child/protocol";
import type { ChannelSecretSpec, ChannelSettingsSpec } from "../types.js";
import { ASSISTANT_NAME_DEFAULT } from "../disclosure.js";
import { createGabrielCore, gabrielErrorOf, type SlackSessionNetwork } from "./slack-gabriel.js";
import { SLACK_SESSION_COOKIE_PREFIX } from "./slack-session.js";
import { slackSettingsMessages } from "./slack-settings.messages.js";
import { scrubSlackText, type SlackWebApi } from "./slack-web-api.js";

/** Slack 通道要的用户权限（user scopes）。清单和设置页的检查都用它。 */
export const SLACK_USER_SCOPES = [
  "channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read",
  "users:read", "chat:write",
  // 回表情（2026-10-22：对方道谢、附和时回个表情）。旧的令牌没有它时只是回不了表情，别的照常。
  "reactions:write",
] as const;

/**
 * 可选的用户权限：只写进建应用的清单，设置页的检查不要求它们（缺了不算失败）。
 * emoji:read：设置页「形象」预览署名 emoji 时查工作区的自定义 emoji（emoji.list，2026-10-28）。没有时只是看不到预览。
 * files:read：Lead 看消息附带的文件，例如别人发来的截图（files.info 和下载，2026-11-02）。没有时只是看不到文件。
 */
export const SLACK_OPTIONAL_USER_SCOPES = ["emoji:read", "files:read"] as const;

/** Slack 通道订阅的用户事件（清单的 event_subscriptions.user_events）。 */
export const SLACK_USER_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim"] as const;

/** 建 Slack 应用的网页。 */
export const SLACK_SETUP_URL = "https://api.slack.com/apps";

/**
 * 带上清单的建应用链接：打开就是从清单建应用，权限和用户事件都填好了（Slack 文档 app-manifests 的
 * 「new_app=1&manifest_yaml=<URL 编码的 YAML>」）。太长（超过 CHANNEL_SETUP_URL_MAX）时退回不带清单的网页，用户复制清单。
 */
export function slackSetupUrl(manifest: string): string {
  const url = `${SLACK_SETUP_URL}?new_app=1&manifest_yaml=${encodeURIComponent(manifest)}`;
  return url.length <= CHANNEL_SETUP_URL_MAX ? url : SLACK_SETUP_URL;
}

const SECRETS: readonly ChannelSecretSpec[] = [
  {
    name: SLACK_APP_TOKEN_ENV,
    label: "App-Level Token",
    prefix: "xapp-",
    hint: (locale) => slackSettingsMessages(locale).appTokenHint,
  },
  {
    name: SLACK_USER_TOKEN_ENV,
    label: "User OAuth Token",
    prefix: "xoxp-",
    hint: (locale) => slackSettingsMessages(locale).userTokenHint,
  },
];

// 主人名（配置的 channels.ownerName，用户写的）：去掉控制字符，最长 20 个字（Slack 的应用名最长 35 个字）。
function ownerOf(ownerName: string | null | undefined): string | null {
  const name = (ownerName ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
  return name || null;
}

/**
 * 建 Slack 应用用的清单（YAML，.scratch/slack-takeover/setup.md 的那一份）。应用名是助手名（缺省是 Lead 的名字，2026-10-22）：
 * Slack 在应用代用户发的消息下面写「Sent using @<应用名>」（用户 2026-10-21）。说明里写主人名，没有配置主人名时写「我」。
 * 名字和说明用 YAML 的双引号字符串（JSON 字符串也是合法的 YAML 双引号字符串），用户写的名字不会弄坏清单。
 */
export function slackAppManifest(ownerName?: string | null, assistantName?: string | null): string {
  const owner = ownerOf(ownerName);
  const name = ownerOf(assistantName) ?? ASSISTANT_NAME_DEFAULT;
  const description = `替${owner ? ` ${owner} ` : "我"}查资料、按把握程度代回消息（消息开头会标明是助手）`;
  return [
    "display_information:",
    `  name: ${JSON.stringify(name)}`,
    `  description: ${JSON.stringify(description)}`,
    "oauth_config:",
    "  scopes:",
    "    user:",
    ...[...SLACK_USER_SCOPES, ...SLACK_OPTIONAL_USER_SCOPES].map((scope) => `      - ${scope}`),
    "settings:",
    "  event_subscriptions:",
    "    user_events:",
    ...SLACK_USER_EVENTS.map((event) => `      - ${event}`),
    "  interactivity:",
    "    is_enabled: false",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: true",
    "  token_rotation_enabled: false",
    "",
  ].join("\n");
}

type TokenKind = "missing" | "app" | "user" | "bot" | "unknown";

function tokenKind(token: string): TokenKind {
  if (!token) return "missing";
  if (token.startsWith("xapp-")) return "app";
  if (token.startsWith("xoxp-") || token.startsWith("xoxe.xoxp-")) return "user";
  if (token.startsWith("xoxb-") || token.startsWith("xoxe.xoxb-")) return "bot";
  return "unknown";
}

const APP_KIND_DETAIL: Record<TokenKind, string> = {
  missing: "缺 App-Level Token：这次没有填，设置页、环境变量和 Keychain 里也没有。",
  app: "以 xapp- 开头。",
  bot: "这是 bot token，这里要的是 App-Level Token（xapp- 开头，在 Basic Information → App-Level Tokens）。",
  user: "这是 user token，这里要的是 App-Level Token（xapp- 开头，在 Basic Information → App-Level Tokens）。",
  unknown: "App-Level Token 应该以 xapp- 开头。",
};

const USER_KIND_DETAIL: Record<TokenKind, string> = {
  missing: "缺 User OAuth Token：这次没有填，设置页、环境变量和 Keychain 里也没有。",
  user: "以 xoxp- 开头。",
  bot: "这是 bot token，要的是你本人的 user token（xoxp- 开头，在 OAuth & Permissions 的 User OAuth Token）。",
  app: "这是 App-Level Token，这里要的是你本人的 user token（xoxp- 开头，在 OAuth & Permissions 的 User OAuth Token）。",
  unknown: "User Token 应该以 xoxp- 开头（在 OAuth & Permissions 的 User OAuth Token）。",
};

// auth.test 和 apps.connections.open 的错误码：令牌的问题说清楚，别的原样带上。
const AUTH_CODES = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "user_removed_from_team",
  "team_disabled"]);

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(result: Record<string, unknown>): string {
  return isString(result.error) ? result.error : "not ok";
}

/** Slack 插件的凭据设置。api：Web API（测试注入假的 Slack）；ownerName、assistantName：清单里的主人名和应用名。 */
// assistantName 可以是函数：每次读清单时取（缺省是 Lead 的名字，设置里改了以后清单跟着变）。
export function createSlackSettings(input: {
  api: SlackWebApi; ownerName?: string | null; assistantName?: string | null | (() => string | null);
}): ChannelSettingsSpec {
  const { api } = input;
  const assistantName = () => (typeof input.assistantName === "function" ? input.assistantName() : input.assistantName);

  async function test(secrets: Readonly<Record<string, string>>, context: { log(line: string): void }): Promise<ChannelSecretsTestResult> {
    const appToken = (secrets[SLACK_APP_TOKEN_ENV] ?? "").trim();
    const userToken = (secrets[SLACK_USER_TOKEN_ENV] ?? "").trim();
    const scrub = (text: string) => scrubSlackText(text, [appToken, userToken]);
    const check = (id: string, label: string, pass: boolean, detail: string): ChannelSecretCheck =>
      ({ id, label, pass, detail: scrub(detail).slice(0, 500) });
    const appKind = tokenKind(appToken);
    const userKind = tokenKind(userToken);
    const checks: ChannelSecretCheck[] = [
      check("app_token_kind", "App-Level Token 的格式", appKind === "app", APP_KIND_DETAIL[appKind]),
      check("user_token_kind", "User Token 的格式", userKind === "user", USER_KIND_DETAIL[userKind]),
    ];
    let account: ChannelSourceAccount | null = null;
    let missingScopes: string[] = [];

    // 用户本人和权限：auth.test（User Token），再用 users.info 取显示名。
    const whoAmI = async (): Promise<ChannelSecretCheck[]> => {
      const label = "User Token 是你本人的";
      const scopesLabel = "User Token 的权限";
      if (userKind !== "user") {
        return [
          check("user_token_auth", label, false, "没有检查：User Token 的格式不对。"),
          check("scopes", scopesLabel, false, "没有检查：User Token 的格式不对。"),
        ];
      }
      let auth: Record<string, unknown>;
      try {
        auth = await api.call("auth.test", {}, userToken);
      } catch (error) {
        context.log(`settings test: auth.test failed: ${scrub(errorText(error))}`);
        return [
          check("user_token_auth", label, false, `连不上 Slack：${errorText(error)}`),
          check("scopes", scopesLabel, false, "没有检查：连不上 Slack。"),
        ];
      }
      const skipped = check("scopes", scopesLabel, false, "没有检查：User Token 没有通过上一项。");
      if (auth.ok !== true) {
        const code = codeOf(auth);
        return [
          check("user_token_auth", label, false, AUTH_CODES.has(code)
            ? `Slack 不认这个 User Token（${code}）：令牌无效、过期或者被撤销。`
            : `Slack 回答 ${code}。`),
          skipped,
        ];
      }
      if (isString(auth.bot_id)) {
        return [check("user_token_auth", label, false, "这是 bot token，要的是你本人的 user token（auth.test 说它属于一个机器人）。"), skipped];
      }
      if (!isString(auth.user_id)) return [check("user_token_auth", label, false, "Slack 没有说这个令牌是谁的。"), skipped];
      let userName = isString(auth.user) ? auth.user : auth.user_id;
      try {
        const info = await api.call("users.info", { user: auth.user_id }, userToken);
        const user = info.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
        userName = [user?.profile?.display_name, user?.profile?.real_name, user?.real_name, user?.name].find(isString) ?? userName;
      } catch (error) {
        context.log(`settings test: users.info failed: ${scrub(errorText(error))}`);
      }
      const teamId = isString(auth.team_id) ? auth.team_id : "";
      const teamName = isString(auth.team) ? auth.team : teamId;
      account = {
        userId: scrub(auth.user_id).slice(0, 100), userName: scrub(userName).slice(0, 200),
        teamId: scrub(teamId).slice(0, 100), teamName: scrub(teamName).slice(0, 200),
      };
      const who = check("user_token_auth", label, true, `是 ${account.userName}${account.teamName ? `（${account.teamName}）` : ""}。`);
      const granted = (auth.response_metadata as { scopes?: unknown } | undefined)?.scopes;
      if (!Array.isArray(granted)) {
        return [who, check("scopes", scopesLabel, false, "Slack 没有告诉我们这个令牌有哪些权限，没法核对。")];
      }
      const have = new Set(granted.filter((scope): scope is string => typeof scope === "string").map((scope) => scope.trim()));
      missingScopes = SLACK_USER_SCOPES.filter((scope) => !have.has(scope));
      return [who, missingScopes.length
        ? check("scopes", scopesLabel, false,
          `缺 ${missingScopes.join("、")}。Slack 说这个令牌现在只有：${have.size ? [...have].sort().join("、") : "（没有）"}。`
          + "要加在 OAuth & Permissions 的 User Token Scopes 里（不是 Bot Token Scopes），再点 Reinstall to Workspace，"
          + "复制页面上新的 User OAuth Token。")
        : check("scopes", scopesLabel, true, `要的 ${SLACK_USER_SCOPES.length} 项权限都有。`)];
    };

    // Socket Mode：apps.connections.open（App-Level Token）。只问能不能开，不建连接。
    const socket = async (): Promise<ChannelSecretCheck> => {
      const label = "App-Level Token 能开 Socket 连接";
      if (appKind !== "app") return check("socket_mode", label, false, "没有检查：App-Level Token 的格式不对。");
      let result: Record<string, unknown>;
      try {
        result = await api.call("apps.connections.open", {}, appToken);
      } catch (error) {
        context.log(`settings test: apps.connections.open failed: ${scrub(errorText(error))}`);
        return check("socket_mode", label, false, `连不上 Slack：${errorText(error)}`);
      }
      if (result.ok === true) return check("socket_mode", label, true, "可以开 Socket Mode 的连接。");
      const code = codeOf(result);
      const detail = AUTH_CODES.has(code) ? `Slack 不认这个 App-Level Token（${code}）：令牌无效或者被撤销。`
        : code === "not_allowed_token_type" ? "这个令牌不能开 Socket 连接：这里要的是 App-Level Token。"
        : code === "missing_scope" ? "App-Level Token 缺 connections:write：在 Basic Information → App-Level Tokens 重新生成一个，加上 connections:write。"
        : `Slack 回答 ${code}（检查应用有没有打开 Socket Mode）。`;
      return check("socket_mode", label, false, detail);
    };

    const [identity, socketCheck] = await Promise.all([whoAmI(), socket()]);
    checks.push(...identity, socketCheck);
    return { ok: checks.every((item) => item.pass), checks, account, missingScopes };
  }

  return {
    secrets: SECRETS,
    get manifest() { return slackAppManifest(input.ownerName, assistantName()); },
    get setupUrl() { return slackSetupUrl(slackAppManifest(input.ownerName, assistantName())); },
    setupNote: (locale) => slackSettingsMessages(locale).setupNote(SLACK_USER_EVENTS),
    // 2026-11-02：手建应用时没有订阅用户事件、没有加 User Token Scopes，Socket 连上了却一个事件都收不到，哪里都没说。
    noEventsWarning: (locale) => slackSettingsMessages(locale).noEvents(SLACK_USER_EVENTS, SLACK_USER_SCOPES),
    test,
  };
}

// 浏览器会话方式（2026-11-02）要的密钥：会话 cookie。用户在设置页的登录窗口里登录以后，daemon 自己存进去（不提供粘贴的入口）。
const SESSION_SECRETS: readonly ChannelSecretSpec[] = [
  {
    name: SLACK_SESSION_COOKIE_ENV,
    label: "Slack 会话",
    prefix: SLACK_SESSION_COOKIE_PREFIX,
    hint: (locale) => slackSettingsMessages(locale).sessionCookieHint,
  },
];

// 检查会话时，等 WebSocket 连上（hello）最多多久。
const SESSION_SOCKET_WAIT_MS = 10_000;

/**
 * 浏览器会话方式的凭据设置。检查一个会话 cookie：
 *   1. 格式：以 xoxd- 开头。
 *   2. 能登录：用 cookie 换出会话（用户本人、工作区），users.info 取显示名。
 *   3. WebSocket 能连上：连一次，等到 hello 就断开。
 * 用一个临时的 GabrielCore，不动正在用的会话。结果里的文字不含 cookie 和会话令牌。
 */
export function createSlackSessionSettings(input: { network?: SlackSessionNetwork } = {}): ChannelSettingsSpec {
  async function test(secrets: Readonly<Record<string, string>>, context: { log(line: string): void }): Promise<ChannelSecretsTestResult> {
    const cookie = (secrets[SLACK_SESSION_COOKIE_ENV] ?? "").trim();
    let token: string | null = null;
    const scrub = (text: string) => scrubSlackText(text, [cookie, token]);
    const check = (id: string, label: string, pass: boolean, detail: string): ChannelSecretCheck =>
      ({ id, label, pass, detail: scrub(detail).slice(0, 500) });
    const signInLabel = "能登录 Slack";
    const socketLabel = "能连上 Slack 的实时消息";
    const kindOk = cookie.startsWith(SLACK_SESSION_COOKIE_PREFIX);
    const checks: ChannelSecretCheck[] = [
      check("session_cookie_kind", "Slack 会话的格式", kindOk, kindOk ? `以 ${SLACK_SESSION_COOKIE_PREFIX} 开头。`
        : cookie ? `会话应该以 ${SLACK_SESSION_COOKIE_PREFIX} 开头。` : "缺 Slack 会话：还没有登录。"),
    ];
    if (!kindOk) {
      checks.push(check("session_sign_in", signInLabel, false, "没有检查：会话的格式不对。"));
      checks.push(check("session_socket", socketLabel, false, "没有检查：会话的格式不对。"));
      return { ok: false, checks, account: null, missingScopes: [] };
    }
    const core = await createGabrielCore({ cookie, network: input.network ?? {}, log: (line) => context.log(`settings test: ${line}`) });
    let account: ChannelSourceAccount | null = null;
    try {
      const session = await core.initialize();
      token = session.token;
      let userName = session.userId;
      try {
        const info = await core.callWebApi("users.info", { user: session.userId });
        const user = info.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
        userName = [user?.profile?.display_name, user?.profile?.real_name, user?.real_name, user?.name].find(isString) ?? userName;
      } catch (error) {
        context.log(`settings test: users.info failed: ${scrub(errorText(error))}`);
      }
      account = {
        userId: scrub(session.userId).slice(0, 100), userName: scrub(userName).slice(0, 200),
        teamId: scrub(session.teamId).slice(0, 100), teamName: scrub(session.teamName || session.teamId).slice(0, 200),
      };
      checks.push(check("session_sign_in", signInLabel, true, `是 ${account.userName}${account.teamName ? `（${account.teamName}）` : ""}。`));
    } catch (error) {
      const dead = gabrielErrorOf(error).code === "AUTH_DEAD";
      checks.push(check("session_sign_in", signInLabel, false, dead
        ? "会话已失效：SSO 过期，或者你在 Slack 里登出了。请重新登录。"
        : `连不上 Slack：${errorText(error)}`));
      checks.push(check("session_socket", socketLabel, false, "没有检查：没有登录。"));
      return { ok: false, checks, account: null, missingScopes: [] };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hello = new Promise<boolean>((resolve) => {
        core.onHello(() => resolve(true));
        timer = setTimeout(() => resolve(false), SESSION_SOCKET_WAIT_MS);
        timer.unref?.();
      });
      await core.connect();
      const connected = await hello;
      checks.push(check("session_socket", socketLabel, connected, connected ? "连上了。" : "等了 10 秒还没有连上。"));
    } catch (error) {
      checks.push(check("session_socket", socketLabel, false, `连不上 Slack：${errorText(error)}`));
    } finally {
      clearTimeout(timer);
      core.disconnect();
    }
    return { ok: checks.every((item) => item.pass), checks, account, missingScopes: [] };
  }

  return { secrets: SESSION_SECRETS, manifest: null, setupUrl: null, test };
}

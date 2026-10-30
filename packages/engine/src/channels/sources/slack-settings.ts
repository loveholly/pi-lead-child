// Slack 通道的凭据设置（设置页「Slack 通道」，2026-10-20；protocol 的 channel-settings.ts，slack-settings 工单 S1）。
// 这里是 Slack 插件声明的 ChannelSettingsSpec：要哪两个令牌、建应用用的清单（YAML）、怎样检查一组令牌。
// 检查（test）不保存，也不建 WebSocket：
//   1. 格式：App-Level Token 以 xapp- 开头；User Token 以 xoxp- 开头。是 bot token（xoxb-）时明确说要的是你本人的 user token。
//   2. auth.test（User Token）：成功，并且结果里没有 bot_id（不是机器人）。取出用户编号、名字、工作区；users.info 取显示名。
//   3. 权限：auth.test 的结果里 response_metadata.scopes（WebClient 从 x-oauth-scopes 头取的）和要求的清单比，列出缺的。
//   4. apps.connections.open（App-Level Token）：成功即可（拿到的地址不用）。
// 结果里的文字不含令牌：先把这次的两个令牌原样换掉，再按通用的规则脱敏。
import { SLACK_APP_TOKEN_ENV, SLACK_USER_TOKEN_ENV } from "@pi-lead-child/core";
import type { ChannelSecretCheck, ChannelSecretsTestResult, ChannelSourceAccount } from "@pi-lead-child/protocol";
import type { ChannelSecretSpec, ChannelSettingsSpec } from "../types.js";
import { ASSISTANT_NAME_DEFAULT } from "../disclosure.js";
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
 */
export const SLACK_OPTIONAL_USER_SCOPES = ["emoji:read"] as const;

/** Slack 通道订阅的用户事件（清单的 event_subscriptions.user_events）。 */
export const SLACK_USER_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim"] as const;

/** 建 Slack 应用的网页。 */
export const SLACK_SETUP_URL = "https://api.slack.com/apps";

const SECRETS: readonly ChannelSecretSpec[] = [
  {
    name: SLACK_APP_TOKEN_ENV,
    label: "App-Level Token",
    prefix: "xapp-",
    hint: "在应用的 Basic Information → App-Level Tokens 点 Generate Token and Scopes，加 connections:write。",
  },
  {
    name: SLACK_USER_TOKEN_ENV,
    label: "User OAuth Token",
    prefix: "xoxp-",
    hint: "在应用的 OAuth & Permissions 点 Install to Workspace，授权以后复制 User OAuth Token（不是 Bot User OAuth Token）。",
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
    setupUrl: SLACK_SETUP_URL,
    test,
  };
}

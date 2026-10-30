// 连接的目录：预设的服务，加上用户自己添加的远程 MCP。目录是数据，不是代码分支：
// 新服务只要支持 MCP 授权规范，就能当作「自定义 MCP」接进来，不用改这里。
// 调研结论（2026-10-16，见 .scratch/settings-connections/spec.md）：Atlassian 和 Notion 支持 DCR，能一键连接；
// GitHub 的远程 MCP 不支持 DCR，先复用 gh 的登录；Slack 要一个预注册的 app；Google 还在预览期，先不做。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderId = "atlassian" | "notion" | "github" | "slack" | "google" | "custom";

// oauth：MCP 授权规范的一键 OAuth（发现 + 预注册客户端或 DCR）。
// github：先 gh auth token，再设备码，最后 PAT。
export type ProviderAuth = "oauth" | "github" | "none";

export interface CatalogEntry {
  id: Exclude<ProviderId, "custom">;
  label: string;
  // 一句话说明 Paimon 能用它做什么，设置页和 Lead 的提示词都用这一句。
  capability: string;
  serverUrl: string | null;
  auth: ProviderAuth;
  // 授权有固定期限时的天数（Notion：首次授权 180 天后一定失效），用来提前提醒。
  grantLifetimeDays?: number;
  // 必须用预注册客户端（不支持 DCR）。没有配置时，这个服务显示「需要额外设置」。
  requiresClient?: boolean;
  // 暂不支持时的原因。设置页显示「即将支持」。
  unavailableReason?: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "atlassian", label: "Jira & Confluence", capability: "查、建、改 Jira issue，搜索和读 Confluence 页面",
    serverUrl: "https://mcp.atlassian.com/v2/mcp", auth: "oauth",
  },
  {
    id: "github", label: "GitHub", capability: "读仓库、PR 和 issue，写评论",
    serverUrl: "https://api.githubcopilot.com/mcp/", auth: "github",
  },
  {
    id: "notion", label: "Notion", capability: "搜索、读和编辑 Notion 页面",
    serverUrl: "https://mcp.notion.com/mcp", auth: "oauth", grantLifetimeDays: 180,
  },
  {
    id: "slack", label: "Slack", capability: "搜索消息，读频道和私信，以你的身份发消息",
    serverUrl: "https://mcp.slack.com/mcp", auth: "oauth", requiresClient: true,
  },
  {
    id: "google", label: "Google", capability: "Gmail、日历和云端硬盘",
    serverUrl: null, auth: "none",
    unavailableReason: "Google 的 MCP 还在预览期，暂时不能一键连接",
  },
];

// 认得出的自定义 MCP（landing.md C5）：用户照常用「添加自定义 MCP」（hub 的 addCustom）接进来，连接中心按服务器地址认出它，
//   - 给它一个别名（权限清单和 Lead 按别名写，例如 cdp），和一句能力说明；
//   - readTools 不为空时只开放这几个只读工具：别的工具对谁都看不到、调不了（包括 Lead），服务器以后加了写工具也一样。
//     服务器没标 readOnlyHint 也按只读算：这几个是查过它的文档定下的只读工具。
// 加一个认得出的服务只要在这里加一行；中间的检查不按服务分支。
export interface KnownServer {
  url: string;
  alias: string;
  label: string;
  capability: string;
  readTools: readonly string[];
}

export const KNOWN_SERVERS: readonly KnownServer[] = [
  {
    // Acme 的客户数据平台。工具名照 using-cdp 技能的说明（9 个只读工具，没有写操作）。
    url: "https://mcp.acme.org/cdp/mcp", alias: "cdp", label: "CDP",
    capability: "只读查询客户数据：audience（联系人、公司、组织、店铺）、cohort、key action 和事件记录",
    readTools: [
      "get_audience_definitions", "search_audiences", "aggregate_audiences", "search_cohorts", "list_cohort_audiences",
      "search_key_actions", "get_key_action", "search_activities", "search_event_definitions",
    ],
  },
];

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** 按服务器地址认出的服务。地址末尾的 / 不算。 */
export function knownServer(serverUrl: string | null | undefined): KnownServer | null {
  if (!serverUrl) return null;
  const url = withoutTrailingSlash(serverUrl.trim());
  return KNOWN_SERVERS.find((entry) => withoutTrailingSlash(entry.url) === url) ?? null;
}

export function knownServerByAlias(alias: string): KnownServer | null {
  const wanted = alias.trim().toLowerCase();
  return KNOWN_SERVERS.find((entry) => entry.alias === wanted) ?? null;
}

export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

// 预注册的 OAuth 客户端。client ID 不是密钥，放在 config.json 或环境变量里；client secret 是密钥，
// 只从 Keychain 读（见 ConnectionSecrets），不进 config.json，也不进 process.env。
export interface PreregisteredClient {
  clientId: string;
  // 读 client secret 时用的名字（Keychain 里是 dev-secret:<name>）。只在 PKCE 走不通时才需要。
  secretName: string;
}

export interface ConnectionsConfig {
  clients: Partial<Record<"slack" | "github", PreregisteredClient>>;
}

const CLIENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

// 读 config.json 的 connections 一节：
//   { "connections": { "slack": { "clientId": "..." }, "github": { "clientId": "..." } } }
// 环境变量 PLC_SLACK_CLIENT_ID / PLC_GITHUB_CLIENT_ID 优先。
export function loadConnectionsConfig(dataDir: string, env: Record<string, string | undefined> = process.env): ConnectionsConfig {
  let section: Record<string, unknown> = {};
  const path = join(dataDir, "config.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { connections?: unknown };
      if (parsed.connections && typeof parsed.connections === "object" && !Array.isArray(parsed.connections)) {
        section = parsed.connections as Record<string, unknown>;
      }
    } catch {
      // config.json 坏了时别的模块会报错；这里当作没有配置。
    }
  }
  const clients: ConnectionsConfig["clients"] = {};
  for (const provider of ["slack", "github"] as const) {
    const fromFile = section[provider] && typeof section[provider] === "object"
      ? (section[provider] as { clientId?: unknown }).clientId
      : undefined;
    const clientId = env[`PLC_${provider.toUpperCase()}_CLIENT_ID`]?.trim() || (typeof fromFile === "string" ? fromFile.trim() : "");
    if (clientId && CLIENT_ID.test(clientId)) {
      clients[provider] = { clientId, secretName: `PLC_${provider.toUpperCase()}_CLIENT_SECRET` };
    }
  }
  return { clients };
}


// 一个自定义 MCP 地址：只接受 HTTPS，不带用户名密码和片段。返回规范化的地址。
export function normalizeCustomServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("请输入一个完整的地址，例如 https://mcp.example.com/mcp");
  }
  if (url.protocol !== "https:") throw new Error("远程 MCP 的地址必须以 https:// 开头");
  if (url.username || url.password) throw new Error("地址里不能带用户名或密码");
  url.hash = "";
  return url.toString();
}

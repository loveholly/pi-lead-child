// ConnectionHub：daemon 里唯一的 OAuth 客户端和远程 MCP 客户端。Lead 在进程里直接调它，child 经工具桥调它，
// 网关的 /v1/connections 路由也调它。令牌只在这里解密，不出这个模块。
//
// 不掉线靠这几件事（spec 的「Refresh」一节）：
// - 三层续期：快到期时提前续（tick），调用前检查一次（accessToken），收到 401 后续一次再重试一次（callTool）。
// - 同一个连接同时只有一个续期：进程内单飞，跨进程再加一道账本里的租约。刷新令牌轮换的服务（Notion）里，
//   同一个刷新令牌用两次会吊销整个授权。
// - 拿到新令牌后先在同一个同步事务里写库，再做别的事。
// - 没人用也每 7 天续一次（Notion、Slack 的刷新令牌 30 天不用就失效）。
// - 网络错误、5xx、429 都是暂时的：退避重试，状态是 degraded，旧的访问令牌没过期就继续用。
//   只有 invalid_grant / invalid_client 才要你重新授权，而且一次失效只通知一次。
//
// 带权限清单的 Run（landing.md 第 5 节，store 的 run_grants）：调用带上 runId，这里从库里读这个 Run 现在的清单，
// 按清单检查每一次调用的参数（protocol 的 checkGrantCall），不在清单里的拒绝并记审计（run_tool_calls）。
//   - 清单点名的写工具不再看连接的写入策略：清单由代码按授权表算出（授权表是用户的），这就是用户的确认。
//     连接的角色设置照样生效：用户不让执行 agent 用某个连接，带清单的 Run 也用不了它。
//   - 两条硬性底线和清单无关：本地读取过禁止名单（local-repo.ts），写操作的参数里有像凭据的文字时拒绝（guards.ts）。
//   - 本地仓库的读取（local 连接）只给带清单的 Run 用。
//   - 每个 Run 读到的内容记在内存里（runReads），交回结果时出处按它核实；Run 结束后 releaseRun。
// 工具守卫（guards.ts）对所有调用方生效，带不带清单都一样。
import { createHash, randomBytes } from "node:crypto";
import {
  addConnectionEvent,
  getRunGrant,
  recordRunToolCall,
  settleRunToolCall,
  type RunGrantRecord,
  CONNECTION_SETTINGS_CHANGED_EVENT,
  CONNECTION_SETTINGS_RESTORED_EVENT,
  connectionRoles,
  deleteOAuthClientsOf,
  findOAuthClient,
  getConnection,
  getConnectionByServer,
  getConnectionSettingsManifest,
  getConnectionSettingsSeal,
  setConnectionSettingsManifest,
  getOAuthClient,
  hasConnectionEventSince,
  insertConnection,
  listConnections,
  releaseConnectionLease,
  saveConnectionSecret,
  sealConnectionSettings,
  saveOAuthClient,
  setConnectionSettings,
  takeConnectionLease,
  updateConnection,
  type ConnectionRow,
  type Db,
} from "@pi-lead-child/store";
import {
  checkGrantCall,
  LOCAL_REPO_CONNECTION,
  DEFAULT_CONNECTION_SETTINGS,
  normalizeConnectionSettings,
  sameConnectionSettings,
  stricterConnectionSettings,
  type ConnectionSettings,
  type ConnectionSettingsSealState,
  type RunGrant,
} from "@pi-lead-child/protocol";
import type {
  ConnectionConfirmationDto,
  ConnectionDto,
  ConnectionFlowResponse,
  ConnectionProblem,
  ConnectionProvider,
  ConnectionRole,
  ConnectionSettingsRequest,
  ConnectionToolDto,
  StartConnectionResponse,
} from "@pi-lead-child/protocol";
import {
  CATALOG, catalogEntry, knownServer, knownServerByAlias, normalizeCustomServerUrl, type CatalogEntry, type ConnectionsConfig,
} from "./catalog.js";
import {
  authorizeUrl,
  createPkce,
  discover,
  exchangeCode,
  fetchAuthorizationServerMetadata,
  OAuthError,
  randomState,
  refreshTokens,
  registerClient,
  requestedScope,
  revokeToken,
  type AuthorizationServerMetadata,
  type ClientCredentials,
  type FetchLike,
  type TokenSet,
} from "./oauth.js";
import { contentText, McpAuthError, McpHttpClient, McpRpcError, McpTransportError, type McpTool } from "./mcp-client.js";
import {
  CONNECTION_SETTINGS_MANIFEST_AAD, connectionSecretAad, connectionSettingsAad, oauthClientSecretAad, type SecretVault,
} from "./vault.js";
import { findGh, githubLogin, pollDeviceFlow, startDeviceFlow, type DeviceCode, type GhTokenSource } from "./github.js";
import { credentialProblem, type ToolCallContext, type ToolGuard, type WriteDescription } from "./guards.js";
import { createGithubGuard } from "./github-guard.js";
import { callLocalRepoTool, localRepoToolDefinitions, LocalToolRefusal, type LocalRepoLimits } from "./local-repo.js";
import { RunReadLedger } from "./run-reads.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const FLOW_TTL_MS = 10 * MINUTE;
export const KEEP_ALIVE_MS = 7 * DAY;
export const TOOLS_STALE_MS = 6 * 60 * MINUTE;
const LEASE_MS = 30_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * MINUTE;
const EXPIRY_WARNINGS = [{ label: "7d", ms: 7 * DAY }, { label: "1d", ms: DAY }] as const;

export type ConnectionErrorCode =
  | "not_found" | "not_connected" | "needs_setup" | "unavailable" | "needs_reauth" | "temporarily_unavailable"
  | "forbidden" | "confirmation_required" | "unknown_tool" | "invalid_request" | "flow_not_found" | "authorization_failed"
  // 带清单的 Run：清单不允许，或者撞上了守卫和硬性底线。
  | "grant_denied";


// relaxWritePolicyOnce 做过的标记（kv）。
const WRITE_POLICY_RELAXED_KEY = "connection.write_policy_relaxed_2026_10_28";
export class ConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode, message: string, readonly key: string | null = null) {
    super(message);
  }
}

export interface ConnectionSecrets {
  // daemon 自己的密钥（例如 PLC_SLACK_CLIENT_SECRET），从 Keychain 读。没有时返回 null。
  get(name: string): string | null;
}

export interface ConnectionAttention {
  kind: "needs_reauth" | "expiring";
  key: string;
  label: string;
  message: string;
}

// 核对权限设置时发现的不一致（2026-10-19 审查：一个 child 用 sqlite3 把 GitHub 的写入策略改成了 direct）。
// hub 已经把设置恢复成更严的值；daemon 记一条安全报警并直接推给用户（protocol 的 security-alerts.ts）。
export interface ConnectionSettingsAlert {
  connectionId: number;
  key: string;
  label: string;
  // 最后一次经设置页（或者建连接时）定下的设置。
  expected: ConnectionSettings;
  // 账本里发现的设置。
  found: ConnectionSettings;
  // 恢复成的设置。
  restored: ConnectionSettings;
  seal: ConnectionSettingsSealState;
}

// 一次写入确认的结果。daemon 把它交给 Lead（Jarvis 模式），Lead 告诉你结果。
export interface ConnectionConfirmationOutcome {
  confirmation: ConnectionConfirmationDto;
  // 执行后的完整文本（最多 20000 个字符）。被拒绝或过期时为 null。
  resultText: string | null;
}

export interface ConnectionHubOptions {
  db: Db;
  vault: SecretVault;
  config: ConnectionsConfig;
  // 新连接的写入策略。daemon 传 direct（用户 2026-10-28：「这些操作不要再让我审批了」）：Lead 写外部账号是它自己的判断。
  // 不给时是 confirm。封印核对的缺省设置（DEFAULT_CONNECTION_SETTINGS）不受它影响，被直接改库时仍按更严的恢复。
  newConnectionWritePolicy?: "confirm" | "direct";
  // 本机回调地址：http://127.0.0.1:<网关端口>/oauth/callback。网关端口可能在启动后才确定，所以是函数。
  redirectUri: () => string;
  fetch?: FetchLike;
  now?: () => number;
  secrets?: ConnectionSecrets;
  gh?: GhTokenSource;
  ghInstalled?: () => boolean;
  log?: (line: string) => void;
  // 一个连接的状态变了。网关据此推一条 snapshot.required。
  onChange?: (key: string) => void;
  // 要告诉你的事：需要重新授权、授权快到期。daemon 交给 Lead（Jarvis 模式）。
  onAttention?: (event: ConnectionAttention) => void;
  // 一次写入确认有了结果（执行完、失败、被拒绝）。
  onConfirmation?: (outcome: ConnectionConfirmationOutcome) => void;
  // 权限设置被绕过设置页改了，已经恢复（见 ConnectionSettingsAlert）。
  onSettingsAlert?: (alert: ConnectionSettingsAlert) => void;
  // 带清单的 Run 经连接中心成功做了一次写操作（landing.md C3：daemon 记进动作层）。不能抛错（抛了只记日志）。
  onAgentWrite?: (write: AgentConnectionWrite) => void;
  // 工具守卫。缺省是 GitHub 的守卫（github-guard.ts）。
  guards?: readonly ToolGuard[];
  // 本地仓库读取不能碰的目录：助手自己的数据目录（daemon 传它的 dataDir）。
  localDeniedRoots?: readonly string[];
  localRepoLimits?: Partial<LocalRepoLimits>;
  clientName?: string;
}

// 带清单的 Run 经连接中心做的一次写操作（已经成功）。
export interface AgentConnectionWrite {
  runId: number;
  itemId: number;
  // run_tool_calls 的行号。
  callId: number;
  connection: string;
  label: string;
  tool: string;
  ruleId: string;
  description: WriteDescription;
  args: Record<string, unknown>;
}

interface PendingWrite {
  id: string;
  key: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
  expiresAt: number;
  state: ConnectionConfirmationDto["state"];
  resolvedBy: string | null;
  resultPreview: string | null;
}

export const CONFIRMATION_TTL_MS = 30 * 60_000;

// 权限设置封印的清单：v 每写一次加一，rows 是每个连接（id）当前封印的版本。
// epoch 在清单重建时换成新的随机值，封印的 AAD 带着它：上一代清单下的封印在这一代里解不开。
interface SettingsManifest {
  epoch: string;
  v: number;
  rows: Record<string, number>;
}

// kv 里的一份封印：epoch 和版本明文放在外面（它们也在 AAD 里，改了就解不开），密文在 cipher 里。
// 清单丢了的时候，靠外面这两个值还能打开这一行自己的封印：它是真的，只是可能是旧的，只用来收紧。
function encodeSeal(epoch: string, version: number, cipher: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ epoch, version, cipher: cipher.toString("base64") }), "utf8");
}

function decodeSeal(blob: Buffer | null): { epoch: string; version: number; cipher: Buffer } | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob.toString("utf8")) as { epoch?: unknown; version?: unknown; cipher?: unknown };
    if (typeof parsed.epoch !== "string" || typeof parsed.version !== "number" || typeof parsed.cipher !== "string") return null;
    return { epoch: parsed.epoch, version: parsed.version, cipher: Buffer.from(parsed.cipher, "base64") };
  } catch {
    return null;
  }
}

interface StoredSecret {
  accessToken: string | null;
  refreshToken: string | null;
}

interface CachedTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface ConnectionToolForAgent extends CachedTool {
  connection: string;
  // 带清单的 Run：放行这个工具的规则（给人看的一句话），agent 据此填参数。
  allowedBy?: string[];
}

export interface ConnectionCallResult {
  text: string;
  truncated: boolean;
  isError: boolean;
}

interface FlowBase {
  id: string;
  key: string;
  provider: ConnectionProvider;
  label: string;
  serverUrl: string;
  expiresAt: number;
  state: "pending" | "connected" | "failed" | "expired";
  message: string | null;
  connectionId: number | null;
}

interface BrowserFlow extends FlowBase {
  kind: "browser";
  stateHash: string;
  server: AuthorizationServerMetadata;
  client: ClientCredentials;
  verifier: string;
  redirectUri: string;
  scope: string | null;
}

interface DeviceFlow extends FlowBase {
  kind: "device";
  clientId: string;
  code: DeviceCode;
  interval: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type Flow = BrowserFlow | DeviceFlow;

const WHOAMI_TOOL = /(^|[_.-])(get[_-]?me|get[_-]?self|whoami|user[_-]?info|current[_-]?user|read[_-]?user[_-]?profile)$|^atlassianUserInfo$/i;

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// 访问令牌剩下多少时间时开始续：max(5 分钟, 有效期的 20%)。
function refreshSkewMs(row: Pick<ConnectionRow, "access_expires_at" | "last_refresh_at">): number {
  const expires = parseTime(row.access_expires_at);
  const issued = parseTime(row.last_refresh_at);
  const lifetime = expires !== null && issued !== null ? Math.max(0, expires - issued) : 0;
  return Math.max(5 * MINUTE, lifetime * 0.2);
}

export function backoffMs(failureCount: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1));
}

export function connectionKey(row: Pick<ConnectionRow, "id" | "provider">): string {
  return row.provider === "custom" ? `custom-${row.id}` : row.provider;
}

export class ConnectionHub {
  readonly #db: Db;
  readonly #vault: SecretVault;
  readonly #config: ConnectionsConfig;
  readonly #redirectUri: () => string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #secrets: ConnectionSecrets;
  readonly #gh: GhTokenSource | null;
  readonly #ghInstalled: () => boolean;
  readonly #newWritePolicy: "confirm" | "direct";
  readonly #log: (line: string) => void;
  readonly #onChange: (key: string) => void;
  readonly #onAttention: (event: ConnectionAttention) => void;
  readonly #onConfirmation: (outcome: ConnectionConfirmationOutcome) => void;
  readonly #onSettingsAlert: (alert: ConnectionSettingsAlert) => void;
  readonly #onAgentWrite: (write: AgentConnectionWrite) => void;
  readonly #guards: ReadonlyMap<string, ToolGuard>;
  readonly #localDeniedRoots: readonly string[];
  readonly #localRepoLimits: Partial<LocalRepoLimits>;
  // 带清单的 Run 读到的内容（出处核实用）。Run 结束后 releaseRun；超过上限时丢掉最早的。
  readonly #ledgers = new Map<number, RunReadLedger>();
  readonly #clientName: string;
  #sealUnavailableLogged = false;
  // 这个进程见过的最高清单版本：比它旧的清单是被复制回来的。
  #manifestHighWater = 0;
  readonly #writes = new Map<string, PendingWrite>();
  readonly #leaseOwner = `${process.pid}:${randomBytes(4).toString("hex")}`;
  readonly #flows = new Map<string, Flow>();
  readonly #flowByState = new Map<string, string>();
  readonly #refreshing = new Map<number, Promise<string | null>>();
  readonly #clients = new Map<number, McpHttpClient>();
  readonly #serverMetadata = new Map<string, { metadata: AuthorizationServerMetadata; at: number }>();
  readonly #ghToken = { value: null as string | null, at: 0 };
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(options: ConnectionHubOptions) {
    this.#db = options.db;
    this.#vault = options.vault;
    this.#config = options.config;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets ?? { get: () => null };
    this.#gh = options.gh ?? null;
    this.#ghInstalled = options.ghInstalled ?? (() => findGh() !== null);
    this.#newWritePolicy = options.newConnectionWritePolicy ?? "confirm";
    this.#log = options.log ?? (() => {});
    this.#onChange = options.onChange ?? (() => {});
    this.#onAttention = options.onAttention ?? (() => {});
    this.#onConfirmation = options.onConfirmation ?? (() => {});
    this.#onSettingsAlert = options.onSettingsAlert ?? (() => {});
    this.#onAgentWrite = options.onAgentWrite ?? (() => {});
    this.#guards = new Map((options.guards ?? [createGithubGuard()]).map((guard) => [guard.connection, guard]));
    this.#localDeniedRoots = options.localDeniedRoots ?? [];
    this.#localRepoLimits = options.localRepoLimits ?? {};
    this.#clientName = options.clientName ?? "Paimon (pi-lead-child)";
  }

  // ——— 生命周期 ———

  // 每 60 秒按墙钟扫一次。Mac 睡醒后第一轮就补上该续的。
  run(intervalMs = MINUTE): void {
    if (this.#tickTimer || this.#closed) return;
    this.#tickTimer = setInterval(() => { void this.tick(); }, intervalMs);
    this.#tickTimer.unref?.();
    void this.tick();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#tickTimer = null;
    for (const flow of this.#flows.values()) if (flow.kind === "device" && flow.timer) clearTimeout(flow.timer);
    await Promise.allSettled([...this.#refreshing.values()]);
    await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
    this.#clients.clear();
  }

  // ——— 目录和状态 ———

  list(): ConnectionDto[] {
    const rows = listConnections(this.#db).map((row) => this.#verified(row));
    const preset = CATALOG.map((entry) => this.#dto(entry, entry.serverUrl ? rows.find((row) => row.server_url === entry.serverUrl) ?? null : null));
    const custom = rows.filter((row) => row.provider === "custom" && row.status !== "disconnected")
      .map((row) => this.#dto(null, row));
    return [...preset, ...custom];
  }

  attentionCount(items = this.list()): number {
    return items.filter((item) => item.state === "needs_reauth" || item.problem?.kind === "expiring").length;
  }

  get(key: string): ConnectionDto {
    const { entry, row } = this.#resolve(key);
    return this.#dto(entry, row);
  }

  #resolve(key: string): { entry: CatalogEntry | null; row: ConnectionRow | null } {
    // 认得出的自定义 MCP 的别名（例如 cdp）：按服务器地址找这一行。
    const known = knownServerByAlias(key);
    if (known && !catalogEntry(key)) {
      const row = listConnections(this.#db).find((candidate) => candidate.provider === "custom" && knownServer(candidate.server_url) === known);
      if (!row) throw new ConnectionError("not_connected", `${known.label} 还没有连接：在设置 → 连接里添加自定义 MCP ${known.url}`, key);
      return { entry: null, row: this.#verified(row) };
    }
    const custom = /^custom-(\d+)$/.exec(key);
    if (custom) {
      const row = getConnection(this.#db, Number(custom[1]));
      if (!row || row.provider !== "custom") throw new ConnectionError("not_found", `没有这个连接：${key}`, key);
      return { entry: null, row: this.#verified(row) };
    }
    const entry = catalogEntry(key);
    if (!entry) throw new ConnectionError("not_found", `没有这个连接：${key}`, key);
    const row = entry.serverUrl ? getConnectionByServer(this.#db, entry.serverUrl) : null;
    return { entry, row: row ? this.#verified(row) : null };
  }

  #liveRow(key: string): ConnectionRow {
    const { row } = this.#resolve(key);
    if (!row || row.status === "disconnected") throw new ConnectionError("not_connected", `${this.#labelOf(key)} 还没有连接`, key);
    if (row.status === "needs_reauth") throw new ConnectionError("needs_reauth", `${row.label} 的授权失效了，需要重新授权`, key);
    return row;
  }

  #labelOf(key: string): string {
    try {
      const { entry, row } = this.#resolve(key);
      return row?.label ?? entry?.label ?? key;
    } catch {
      return key;
    }
  }

  #dto(entry: CatalogEntry | null, raw: ConnectionRow | null): ConnectionDto {
    const row = raw ? this.#verified(raw) : null;
    const now = this.#now();
    const provider = (entry?.id ?? "custom") as ConnectionProvider;
    const key = row ? connectionKey(row) : provider;
    const live = row && row.status !== "disconnected" ? row : null;
    let state: ConnectionDto["state"];
    let setupHint: string | null = null;
    if (entry?.unavailableReason) {
      state = "unavailable";
      setupHint = entry.unavailableReason;
    } else if (live) {
      state = live.status as Exclude<ConnectionRow["status"], "disconnected">;
    } else if (entry?.requiresClient && !this.#config.clients[entry.id as "slack"]) {
      state = "needs_setup";
      setupHint = "需要先在 daemon 上配置你们工作区的 Slack app（client ID）";
    } else if (entry?.auth === "github") {
      const gh = this.#ghInstalled();
      const device = Boolean(this.#config.clients.github);
      state = gh || device ? "not_connected" : "needs_setup";
      setupHint = gh ? "会使用这台 Mac 上 gh 的登录" : device ? "会显示一个设备码，在 GitHub 上输入即可" : "需要先安装并登录 gh，或者粘贴一个 PAT";
    } else {
      state = "not_connected";
    }
    const tools = live?.tools_json ? this.#shapeTools(live, this.#parseTools(live.tools_json)) : null;
    return {
      key,
      provider,
      label: row?.label ?? entry?.label ?? key,
      capability: entry?.capability ?? knownServer(row?.server_url)?.capability ?? "这个远程 MCP 服务器提供的工具",
      serverUrl: row?.server_url ?? entry?.serverUrl ?? null,
      state,
      account: live?.account_label ?? null,
      tokenSource: live?.token_source ?? null,
      connectedAt: live?.connected_at ?? null,
      lastUsedAt: live?.last_used_at ?? null,
      lastRefreshAt: live?.last_refresh_at ?? null,
      accessExpiresAt: live?.access_expires_at ?? null,
      grantExpiresAt: live?.grant_expires_at ?? null,
      problem: live ? this.#problem(live, now) : null,
      tools: tools ? { total: tools.length, readOnly: tools.filter((tool) => tool.readOnly).length, write: tools.filter((tool) => !tool.readOnly).length } : null,
      roles: row ? connectionRoles(row) : ["lead", "executor", "reviewer"],
      writePolicy: row?.write_policy ?? "confirm",
      setupHint,
    };
  }

  #problem(row: ConnectionRow, now: number): ConnectionProblem | null {
    if (row.status === "needs_reauth") {
      const message = row.failure_kind === "invalid_client"
        ? `${row.label} 不再认这个客户端，需要重新授权`
        : row.failure_kind === "insufficient_scope"
        ? `${row.label} 的授权缺少需要的权限，需要重新授权`
        : `${row.label} 的授权失效了（可能被撤销或已过期），需要重新授权`;
      return { kind: row.failure_kind ?? "invalid_grant", message, since: row.updated_at, nextAttemptAt: null };
    }
    if (row.status === "degraded") {
      return {
        kind: "transient", message: `暂时连不上 ${row.label}，daemon 会自动重试`,
        since: row.updated_at, nextAttemptAt: row.next_attempt_at,
      };
    }
    const grantEnds = parseTime(row.grant_expires_at);
    if (grantEnds !== null && grantEnds - now <= EXPIRY_WARNINGS[0].ms) {
      const days = Math.max(0, Math.ceil((grantEnds - now) / DAY));
      return {
        kind: "expiring",
        message: days > 0 ? `${row.label} 的授权 ${days} 天后到期，到期前重新授权不会打断正在跑的工作` : `${row.label} 的授权今天到期`,
        since: null, nextAttemptAt: null,
      };
    }
    return null;
  }

  // 认得出的只读服务（catalog.ts 的 KNOWN_SERVERS）：只留它的只读工具，并按只读算。别的服务原样返回。
  #shapeTools(row: Pick<ConnectionRow, "server_url">, tools: CachedTool[]): CachedTool[] {
    const known = knownServer(row.server_url);
    if (!known?.readTools.length) return tools;
    return tools.filter((tool) => known.readTools.includes(tool.name)).map((tool) => ({ ...tool, readOnly: true }));
  }

  #rowTools(row: ConnectionRow): CachedTool[] {
    return this.#shapeTools(row, this.#parseTools(row.tools_json ?? "[]"));
  }

  #parseTools(json: string): CachedTool[] {
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? parsed as CachedTool[] : [];
    } catch {
      return [];
    }
  }

  // ——— 连接 ———

  async start(key: string, input: { token?: string } = {}): Promise<StartConnectionResponse> {
    this.#sweepFlows();
    const { entry, row } = this.#resolve(key);
    if (entry?.unavailableReason) throw new ConnectionError("unavailable", entry.unavailableReason, key);
    const serverUrl = row?.server_url ?? entry?.serverUrl;
    if (!serverUrl) throw new ConnectionError("unavailable", "这个服务还没有地址", key);
    const label = row?.label ?? entry?.label ?? key;
    const provider = (entry?.id ?? "custom") as ConnectionProvider;
    if (entry?.auth === "github") return this.#startGithub(entry, serverUrl, input.token);
    if (input.token !== undefined) throw new ConnectionError("invalid_request", "只有 GitHub 支持粘贴令牌", key);
    return this.#startOAuth({ key, provider, label, serverUrl, entry });
  }

  // 添加一个自定义的远程 MCP。授权完成后才建行。
  async addCustom(serverUrl: string): Promise<StartConnectionResponse> {
    this.#sweepFlows();
    let url: string;
    try {
      url = normalizeCustomServerUrl(serverUrl);
    } catch (error) {
      throw new ConnectionError("invalid_request", error instanceof Error ? error.message : String(error));
    }
    if (CATALOG.some((entry) => entry.serverUrl === url)) {
      throw new ConnectionError("invalid_request", "这个地址已经在连接列表里了，请直接在列表里连接");
    }
    const existing = getConnectionByServer(this.#db, url);
    const key = existing ? connectionKey(existing) : "custom";
    const label = existing?.label ?? knownServer(url)?.label ?? new URL(url).host;
    return this.#startOAuth({ key, provider: "custom", label, serverUrl: url, entry: null });
  }

  async #startOAuth(input: { key: string; provider: ConnectionProvider; label: string; serverUrl: string; entry: CatalogEntry | null }): Promise<StartConnectionResponse> {
    if (input.entry?.requiresClient && !this.#config.clients[input.entry.id as "slack"]) {
      throw new ConnectionError("needs_setup", `${input.entry.label} 需要先在 daemon 上配置预注册的 app`, input.key);
    }
    let discovery;
    try {
      discovery = await discover(this.#fetch, input.serverUrl);
    } catch (error) {
      throw this.#authError(input.key, error, `读不到 ${input.label} 的授权信息`);
    }
    if (!discovery.server || !discovery.resource) {
      // 服务器不要授权：直接连上。
      const row = this.#saveConnected({ ...input, tokenSource: "oauth", tokens: null, server: null, client: null, scope: null });
      await this.#afterConnect(row);
      return { flow: "connected", connection: this.get(connectionKey(getConnection(this.#db, row.id)!)) };
    }
    const server = discovery.server;
    const redirectUri = this.#redirectUri();
    const scope = requestedScope(discovery);
    const client = await this.#clientFor(input.key, input.entry, server, redirectUri, scope);
    const pkce = createPkce();
    const state = randomState();
    const flow: BrowserFlow = {
      kind: "browser", id: `flow_${randomBytes(12).toString("base64url")}`, key: input.key, provider: input.provider,
      label: input.label, serverUrl: input.serverUrl, expiresAt: this.#now() + FLOW_TTL_MS, state: "pending",
      message: null, connectionId: null, stateHash: hashState(state), server, client, verifier: pkce.verifier,
      redirectUri, scope,
    };
    this.#flows.set(flow.id, flow);
    this.#flowByState.set(flow.stateHash, flow.id);
    return {
      flow: "browser",
      flowId: flow.id,
      authorizeUrl: authorizeUrl(server, {
        clientId: client.clientId, redirectUri, state, challenge: pkce.challenge, scope, resource: discovery.resource.resource,
      }),
      expiresAt: iso(flow.expiresAt),
    };
  }

  // 预注册的客户端优先；否则用账本里按 issuer 存的 DCR 客户端；都没有时注册一个。
  async #clientFor(key: string, entry: CatalogEntry | null, server: AuthorizationServerMetadata, redirectUri: string, scope: string | null): Promise<ClientCredentials> {
    const preregistered = entry && (entry.id === "slack" || entry.id === "github") ? this.#config.clients[entry.id] : undefined;
    if (preregistered) return { clientId: preregistered.clientId, clientSecret: this.#secrets.get(preregistered.secretName) };
    if (entry?.requiresClient) throw new ConnectionError("needs_setup", `${entry.label} 需要先在 daemon 上配置预注册的 app`, key);
    const stored = getOAuthClient(this.#db, server.issuer, redirectUri);
    if (stored) {
      return {
        clientId: stored.client_id,
        clientSecret: stored.secret_cipher ? this.#vault.open<string>(stored.secret_cipher, oauthClientSecretAad(server.issuer, redirectUri)) : null,
      };
    }
    let registered;
    try {
      registered = await registerClient(this.#fetch, server, { redirectUri, clientName: this.#clientName, scope });
    } catch (error) {
      throw this.#authError(key, error, "注册客户端失败");
    }
    saveOAuthClient(this.#db, {
      issuer: server.issuer, redirect_uri: redirectUri, client_id: registered.clientId, method: "dcr",
      secret_cipher: registered.clientSecret ? this.#vault.seal(registered.clientSecret, oauthClientSecretAad(server.issuer, redirectUri)) : null,
      registered_at: iso(this.#now()),
    });
    return registered;
  }

  #authError(key: string, error: unknown, prefix: string): ConnectionError {
    if (error instanceof ConnectionError) return error;
    if (error instanceof OAuthError && error.kind === "transient") {
      return new ConnectionError("temporarily_unavailable", `${prefix}：网络或服务暂时不可用，请稍后再试`, key);
    }
    return new ConnectionError("authorization_failed", `${prefix}：${error instanceof Error ? error.message : String(error)}`, key);
  }

  // 浏览器回到 /oauth/callback。state 只能用一次，10 分钟过期。
  async completeCallback(params: { state: string | null; code: string | null; iss: string | null; error: string | null; errorDescription: string | null }): Promise<{ flowId: string; label: string }> {
    this.#sweepFlows();
    const flowId = params.state ? this.#flowByState.get(hashState(params.state)) : undefined;
    const flow = flowId ? this.#flows.get(flowId) : undefined;
    if (!flow || flow.kind !== "browser") throw new ConnectionError("flow_not_found", "这个授权链接已经失效了，请回到 Paimon 重新连接");
    this.#flowByState.delete(flow.stateHash);
    if (flow.state !== "pending") throw new ConnectionError("flow_not_found", "这个授权链接已经用过了");
    if (flow.expiresAt <= this.#now()) {
      this.#failFlow(flow, "expired", "授权超时了，请重新连接");
      throw new ConnectionError("flow_not_found", "授权超时了，请回到 Paimon 重新连接", flow.key);
    }
    if (params.error) {
      const message = params.error === "access_denied" ? "你在授权页上拒绝了授权" : `授权失败：${params.errorDescription ?? params.error}`;
      this.#failFlow(flow, "failed", message);
      throw new ConnectionError("authorization_failed", message, flow.key);
    }
    // RFC 9207：有 iss 时必须是这个授权服务器；服务器声明支持 iss 时必须有。
    if ((params.iss !== null && params.iss !== flow.server.issuer)
      || (params.iss === null && flow.server.authorization_response_iss_parameter_supported)) {
      this.#failFlow(flow, "failed", "授权响应来自另一个授权服务器，已拒绝");
      throw new ConnectionError("authorization_failed", "授权响应来自另一个授权服务器，已拒绝", flow.key);
    }
    if (!params.code) {
      this.#failFlow(flow, "failed", "授权响应里没有授权码");
      throw new ConnectionError("authorization_failed", "授权响应里没有授权码", flow.key);
    }
    let tokens: TokenSet;
    try {
      tokens = await exchangeCode(this.#fetch, flow.server, flow.client, {
        code: params.code, verifier: flow.verifier, redirectUri: flow.redirectUri, resource: flow.serverUrl,
      });
    } catch (error) {
      const failure = this.#authError(flow.key, error, "换取令牌失败");
      this.#failFlow(flow, "failed", failure.message);
      throw failure;
    }
    const row = this.#saveConnected({
      key: flow.key, provider: flow.provider, label: flow.label, serverUrl: flow.serverUrl, entry: catalogEntry(flow.provider),
      tokenSource: "oauth", tokens, server: flow.server, client: flow.client, scope: tokens.scope ?? flow.scope,
    });
    flow.state = "connected";
    flow.connectionId = row.id;
    await this.#afterConnect(row);
    return { flowId: flow.id, label: row.label };
  }

  flowStatus(flowId: string): ConnectionFlowResponse {
    this.#sweepFlows();
    const flow = this.#flows.get(flowId);
    if (!flow) return { flowId, state: "expired", message: "授权已经结束或超时", connection: null };
    const row = flow.connectionId ? getConnection(this.#db, flow.connectionId) : null;
    return {
      flowId,
      state: flow.state,
      message: flow.message,
      connection: row ? this.#dto(catalogEntry(row.provider), row) : null,
    };
  }

  #failFlow(flow: Flow, state: "failed" | "expired", message: string): void {
    flow.state = state;
    flow.message = message;
    if (flow.kind === "device" && flow.timer) clearTimeout(flow.timer);
  }

  // 过期的流程标成 expired；结束超过 10 分钟的从内存里删掉。
  #sweepFlows(): void {
    const now = this.#now();
    for (const flow of this.#flows.values()) {
      if (flow.state === "pending" && flow.expiresAt <= now) this.#failFlow(flow, "expired", "授权超时了，请重新连接");
      if (flow.expiresAt + FLOW_TTL_MS <= now) {
        this.#flows.delete(flow.id);
        if (flow.kind === "browser") this.#flowByState.delete(flow.stateHash);
      }
    }
  }

  async #startGithub(entry: CatalogEntry, serverUrl: string, pat: string | undefined): Promise<StartConnectionResponse> {
    const key = entry.id;
    if (pat !== undefined) {
      const token = pat.trim();
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new ConnectionError("invalid_request", "这不像一个 GitHub 令牌", key);
      const account = await githubLogin(this.#fetch, token);
      if (!account) throw new ConnectionError("authorization_failed", "GitHub 不接受这个令牌", key);
      const row = this.#saveConnected({ key, provider: "github", label: entry.label, serverUrl, entry, tokenSource: "pat", tokens: { accessToken: token, refreshToken: null, expiresIn: null, scope: null }, server: null, client: null, scope: null });
      await this.#afterConnect(row, account);
      return { flow: "connected", connection: this.get(key) };
    }
    const ghToken = await this.#readGhToken(true);
    if (ghToken) {
      const account = await githubLogin(this.#fetch, ghToken);
      if (account) {
        const row = this.#saveConnected({ key, provider: "github", label: entry.label, serverUrl, entry, tokenSource: "gh_cli", tokens: null, server: null, client: null, scope: null });
        await this.#afterConnect(row, account);
        return { flow: "connected", connection: this.get(key) };
      }
    }
    const client = this.#config.clients.github;
    if (!client) {
      throw new ConnectionError("needs_setup", "这台 Mac 上没有登录过的 gh。请先运行 gh auth login，或者粘贴一个 GitHub 令牌", key);
    }
    let code: DeviceCode;
    try {
      code = await startDeviceFlow(this.#fetch, client.clientId);
    } catch (error) {
      throw new ConnectionError("temporarily_unavailable", error instanceof Error ? error.message : String(error), key);
    }
    const flow: DeviceFlow = {
      kind: "device", id: `flow_${randomBytes(12).toString("base64url")}`, key, provider: "github", label: entry.label,
      serverUrl, expiresAt: this.#now() + code.expiresIn * 1000, state: "pending", message: null, connectionId: null,
      clientId: client.clientId, code, interval: code.interval, timer: null,
    };
    this.#flows.set(flow.id, flow);
    this.#scheduleDevicePoll(flow, entry);
    return { flow: "device", flowId: flow.id, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: iso(flow.expiresAt) };
  }

  #scheduleDevicePoll(flow: DeviceFlow, entry: CatalogEntry): void {
    if (this.#closed) return;
    flow.timer = setTimeout(() => { void this.#pollDevice(flow, entry); }, flow.interval * 1000);
    flow.timer.unref?.();
  }

  async #pollDevice(flow: DeviceFlow, entry: CatalogEntry): Promise<void> {
    if (flow.state !== "pending") return;
    if (flow.expiresAt <= this.#now()) {
      this.#failFlow(flow, "expired", "设备码过期了，请重新连接");
      this.#onChange(flow.key);
      return;
    }
    const result = await pollDeviceFlow(this.#fetch, flow.clientId, flow.code, flow.interval);
    if (result.state === "pending") {
      flow.interval = result.interval;
      this.#scheduleDevicePoll(flow, entry);
      return;
    }
    if (result.state === "failed") {
      this.#failFlow(flow, result.reason === "expired" ? "expired" : "failed", result.message);
      this.#onChange(flow.key);
      return;
    }
    const account = await githubLogin(this.#fetch, result.accessToken);
    const row = this.#saveConnected({
      key: flow.key, provider: "github", label: entry.label, serverUrl: flow.serverUrl, entry, tokenSource: "device",
      tokens: { accessToken: result.accessToken, refreshToken: null, expiresIn: null, scope: result.scope },
      server: null, client: { clientId: flow.clientId, clientSecret: null }, scope: result.scope,
    });
    flow.state = "connected";
    flow.connectionId = row.id;
    await this.#afterConnect(row, account);
  }

  // 授权成功：建行或复用原来的行（设置保留），密文和状态在一个事务里写。
  #saveConnected(input: {
    key: string; provider: ConnectionProvider; label: string; serverUrl: string; entry: CatalogEntry | null;
    tokenSource: ConnectionRow["token_source"]; tokens: TokenSet | null;
    server: AuthorizationServerMetadata | null; client: ClientCredentials | null; scope: string | null;
  }): ConnectionRow {
    const now = this.#now();
    // 建新行之前先保证清单可读：清单不在时，已有的行先逐行核对，新行不替它们背书。
    this.#ensureManifest();
    const id = this.#db.transaction(() => {
      const found = getConnectionByServer(this.#db, input.serverUrl);
      const existing = found
        ?? insertConnection(this.#db, {
          provider: input.provider, label: input.label, serverUrl: input.serverUrl, tokenSource: input.tokenSource,
          writePolicy: this.#newWritePolicy,
        }, iso(now));
      if (!found) this.#sealNewRow(existing, iso(now));
      const secret: StoredSecret | null = input.tokens ? { accessToken: input.tokens.accessToken, refreshToken: input.tokens.refreshToken } : null;
      const cipher = secret ? this.#vault.seal(secret, connectionSecretAad(existing.id, existing.secret_version + 1)) : null;
      if (!saveConnectionSecret(this.#db, existing.id, cipher, existing.secret_version, iso(now))) {
        throw new Error("connection secret changed while saving");
      }
      const lifetime = input.entry?.grantLifetimeDays;
      updateConnection(this.#db, existing.id, {
        label: input.label,
        token_source: input.tokenSource,
        status: "connected",
        issuer: input.server?.issuer ?? null,
        token_endpoint: input.server?.token_endpoint ?? null,
        revocation_endpoint: input.server?.revocation_endpoint ?? null,
        client_id: input.client?.clientId ?? null,
        scopes: input.scope,
        access_expires_at: input.tokens?.expiresIn ? iso(now + input.tokens.expiresIn * 1000) : null,
        grant_expires_at: lifetime ? iso(now + lifetime * DAY) : null,
        last_refresh_at: iso(now),
        last_ok_at: iso(now),
        failure_kind: null, failure_detail: null, failure_count: 0, next_attempt_at: null,
        connected_at: iso(now),
      }, iso(now));
      addConnectionEvent(this.#db, existing.id, "connected", input.tokenSource, iso(now));
      return existing.id;
    })();
    this.#dropClient(id);
    return getConnection(this.#db, id)!;
  }

  // 连上以后：读一次工具列表和账号名。失败不影响连接本身。
  async #afterConnect(row: ConnectionRow, account?: string | null): Promise<void> {
    const key = connectionKey(row);
    try {
      const tools = await this.#refreshTools(row.id);
      const label = account ?? await this.#detectAccount(row.id, tools);
      if (label) updateConnection(this.#db, row.id, { account_label: label.slice(0, 120) });
    } catch (error) {
      this.#log(`[connections] ${key}: connected, but reading tools failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#log(`[connections] ${key}: connected (${row.token_source})`);
    this.#onChange(key);
  }

  async #detectAccount(id: number, tools: CachedTool[]): Promise<string | null> {
    const whoami = tools.find((tool) => tool.readOnly && WHOAMI_TOOL.test(tool.name))
      ?? tools.find((tool) => WHOAMI_TOOL.test(tool.name) && !Array.isArray((tool.inputSchema as { required?: unknown }).required));
    if (!whoami) return null;
    try {
      const result = await this.#client(id).callTool(whoami.name, {}, AbortSignal.timeout(10_000));
      const { text } = contentText(result, 20_000);
      return pickAccount(text);
    } catch {
      return null;
    }
  }

  // ——— 断开和设置 ———

  async disconnect(key: string): Promise<ConnectionDto> {
    const { entry, row } = this.#resolve(key);
    if (!row || row.status === "disconnected") return this.#dto(entry, row);
    const secret = this.#readSecret(row);
    if (row.revocation_endpoint && secret && row.client_id) {
      const client = await this.#clientCredentials(row);
      if (secret.refreshToken) await revokeToken(this.#fetch, row.revocation_endpoint, client, secret.refreshToken, "refresh_token");
      if (secret.accessToken) await revokeToken(this.#fetch, row.revocation_endpoint, client, secret.accessToken, "access_token");
    }
    const now = iso(this.#now());
    this.#db.transaction(() => {
      const current = getConnection(this.#db, row.id)!;
      saveConnectionSecret(this.#db, row.id, null, current.secret_version, now);
      updateConnection(this.#db, row.id, {
        status: "disconnected", account_label: null, access_expires_at: null, grant_expires_at: null,
        failure_kind: null, failure_detail: null, failure_count: 0, next_attempt_at: null,
        tools_json: null, tools_fetched_at: null, scopes: null, connected_at: null,
      }, now);
      addConnectionEvent(this.#db, row.id, "disconnected", null, now);
    })();
    this.#dropClient(row.id);
    this.#log(`[connections] ${key}: disconnected`);
    this.#onChange(key);
    return this.#dto(entry, getConnection(this.#db, row.id));
  }

  // 设置页改权限设置。设置、封印、清单和改动记录一起写（store 的 setConnectionSettings）。
  // 主人操作的事件（谁改的、从哪里改的、「不是我」）由网关的路由记。
  updateSettings(key: string, settings: ConnectionSettingsRequest): ConnectionDto {
    const { entry, row } = this.#resolve(key);
    if (!row) throw new ConnectionError("not_connected", `${entry?.label ?? key} 还没有连接`, key);
    const before = this.#rowSettings(row);
    const after = normalizeConnectionSettings({
      roles: settings.roles ?? before.roles, writePolicy: settings.writePolicy ?? before.writePolicy,
    });
    let sealed: { seal: Buffer; manifest: Buffer };
    try {
      const { manifest } = this.#readManifest();
      if (!manifest) throw new Error("the settings manifest is not readable");
      sealed = this.#sealNext(row.id, after, manifest);
    } catch (error) {
      throw new ConnectionError("temporarily_unavailable", `保险库暂时不可用，设置没有保存：${error instanceof Error ? error.message : String(error)}`, key);
    }
    setConnectionSettings(this.#db, row.id, {
      ...after, ...sealed, event: CONNECTION_SETTINGS_CHANGED_EVENT, detail: JSON.stringify(settings),
    }, iso(this.#now()));
    this.#onChange(key);
    return this.#dto(entry, getConnection(this.#db, row.id));
  }

  // ——— 权限设置的核对（2026-10-19 审查和复审）———
  // 一个 child 用 sqlite3 把 GitHub 的写入策略改成了 direct，之后的写入都不再出确认卡，也没有任何记录。
  // 现在每个连接的权限设置都有保险库的封印。封印的 AAD 绑定连接 id、清单的 epoch 和这一行的版本；
  // 清单（也加密）记着 epoch 和每行的版本（store 的 sealConnectionSettings）。hub 建一行时就封上它。
  // 每次用到一行、启动时和每一拍（auditSettings）都核对：
  //   - 清单里有这一行，封印按清单的版本解得开、和账本一致：照常用。
  //   - 封印解得开、和账本不一致：恢复成两者里更严的一份，报警。
  //   - 清单里没有这一行（不是 hub 建的），或者封印没有、解不开（被删、被换成旧封印）：
  //     按 stricter(账本, 缺省设置) 恢复，报警。改动记录（connection_events）能被伪造，不采信。
  //   - 清单没有、解不开，或者比这个进程见过的旧：所有行一律按 stricter(账本, 缺省设置) 恢复，逐行报警，
  //     再写一份包含所有行的新清单（新的 epoch）。不让第一行的重建替别的行背书。
  //     功能上线后的第一次核对也走这一条：每个已有的连接报一次警。
  // 保险库不可用时（读不到 Keychain），不写库、不报警，这一次按更严的设置用。
  // 还挡不住的：整套封印加清单在 daemon 重启前存下、重启后放回（这个进程见过的最高版本只在内存里）。

  #rowSettings(row: Pick<ConnectionRow, "roles" | "write_policy">): ConnectionSettings {
    return normalizeConnectionSettings({ roles: connectionRoles(row), writePolicy: row.write_policy });
  }

  #strictView(row: ConnectionRow): ConnectionRow {
    const restored = stricterConnectionSettings(normalizeConnectionSettings(DEFAULT_CONNECTION_SETTINGS), this.#rowSettings(row));
    return { ...row, roles: JSON.stringify(restored.roles), write_policy: restored.writePolicy };
  }

  #readManifest(): { manifest: SettingsManifest | null; state: "valid" | "missing" | "invalid" } {
    const blob = getConnectionSettingsManifest(this.#db);
    if (!blob) return { manifest: null, state: "missing" };
    try {
      const opened = this.#vault.open<{ epoch?: unknown; v?: unknown; rows?: unknown }>(blob, CONNECTION_SETTINGS_MANIFEST_AAD);
      const v = typeof opened.v === "number" && Number.isSafeInteger(opened.v) ? opened.v : -1;
      if (typeof opened.epoch !== "string" || !opened.epoch) return { manifest: null, state: "invalid" };
      const rows: Record<string, number> = {};
      if (opened.rows && typeof opened.rows === "object") {
        for (const [id, version] of Object.entries(opened.rows as Record<string, unknown>)) {
          if (typeof version === "number" && Number.isSafeInteger(version)) rows[id] = version;
        }
      }
      // 比这个进程见过的旧：有人把旧清单复制回来了。
      if (v < this.#manifestHighWater) return { manifest: null, state: "invalid" };
      this.#manifestHighWater = v;
      return { manifest: { epoch: opened.epoch, v, rows }, state: "valid" };
    } catch {
      return { manifest: null, state: "invalid" };
    }
  }

  // 给一行做下一版的封印和清单。
  #sealNext(connectionId: number, settings: ConnectionSettings, manifest: SettingsManifest): { seal: Buffer; manifest: Buffer } {
    const version = (manifest.rows[String(connectionId)] ?? 0) + 1;
    const next: SettingsManifest = {
      epoch: manifest.epoch,
      v: Math.max(manifest.v, this.#manifestHighWater) + 1,
      rows: { ...manifest.rows, [String(connectionId)]: version },
    };
    const seal = encodeSeal(manifest.epoch, version,
      this.#vault.seal({ ...settings, version }, connectionSettingsAad(connectionId, manifest.epoch, version)));
    const sealedManifest = this.#vault.seal(next, CONNECTION_SETTINGS_MANIFEST_AAD);
    this.#manifestHighWater = next.v;
    return { seal, manifest: sealedManifest };
  }

  // 打开一份封印。expect 给出时，epoch 和版本必须和它一致（清单说了算）；不给时用封印自己带的（只用来收紧）。
  #openSeal(connectionId: number, blob: Buffer | null, expect?: { epoch: string; version: number }): ConnectionSettings | null {
    const record = decodeSeal(blob);
    if (!record) return null;
    if (expect && (record.epoch !== expect.epoch || record.version !== expect.version)) return null;
    try {
      const opened = this.#vault.open<{ roles?: unknown; writePolicy?: unknown; version?: unknown }>(
        record.cipher, connectionSettingsAad(connectionId, record.epoch, record.version),
      );
      if (opened.version !== record.version) return null;
      return normalizeConnectionSettings({ roles: Array.isArray(opened.roles) ? opened.roles : [], writePolicy: opened.writePolicy });
    } catch {
      return null;
    }
  }

  // 清单没有或者解不开：所有行一律按 stricter(账本, 缺省设置, 这一行自己的真封印) 恢复并逐行报警，写一份新 epoch 的清单。
  // 这一行自己的封印可能是旧的（没有清单就核对不了版本），所以只拿它来收紧：例如用户限制过的角色不会因为清单丢了就放开。
  // 返回是否写成（保险库不可用时没写）。
  #resealAll(state: "missing" | "invalid"): boolean {
    const rows = listConnections(this.#db);
    const epoch = randomBytes(12).toString("base64url");
    const defaults = normalizeConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
    const plan = rows.map((row) => {
      const found = this.#rowSettings(row);
      const own = this.#openSeal(row.id, getConnectionSettingsSeal(this.#db, row.id));
      const expected = own ? stricterConnectionSettings(defaults, own) : defaults;
      return { row, found, expected, restored: stricterConnectionSettings(expected, found) };
    });
    const manifest: SettingsManifest = {
      epoch, v: this.#manifestHighWater + 1, rows: Object.fromEntries(rows.map((row) => [String(row.id), 1])),
    };
    let sealed: { manifest: Buffer; seals: Buffer[] };
    try {
      sealed = {
        manifest: this.#vault.seal(manifest, CONNECTION_SETTINGS_MANIFEST_AAD),
        seals: plan.map(({ row, restored }) =>
          encodeSeal(epoch, 1, this.#vault.seal({ ...restored, version: 1 }, connectionSettingsAad(row.id, epoch, 1)))),
      };
    } catch (error) {
      if (!this.#sealUnavailableLogged) {
        this.#sealUnavailableLogged = true;
        this.#log(`[connections] settings seal unavailable, using the stricter settings: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
    const now = iso(this.#now());
    this.#db.transaction(() => {
      plan.forEach(({ row, found, expected, restored }, i) => {
        setConnectionSettings(this.#db, row.id, {
          ...restored, seal: sealed.seals[i]!, manifest: sealed.manifest, event: CONNECTION_SETTINGS_RESTORED_EVENT,
          detail: JSON.stringify({ expected, found, restored, seal: state, manifest: state }),
        }, now);
      });
      if (!plan.length) setConnectionSettingsManifest(this.#db, sealed.manifest, now);
    })();
    this.#manifestHighWater = manifest.v;
    for (const { row, found, expected, restored } of plan) {
      const key = connectionKey(row);
      this.#log(`[connections] ${key}: settings manifest ${state}; resealed with the stricter settings`);
      this.#onSettingsAlert({ connectionId: row.id, key, label: row.label, expected, found, restored, seal: state });
      this.#onChange(key);
    }
    return true;
  }

  // 清单不在或者解不开时先重建（建新行之前调用：不让新行在没有清单时替别的行背书）。
  #ensureManifest(): void {
    const { state } = this.#readManifest();
    if (state !== "valid") this.#resealAll(state);
  }

  #verified(stale: ConnectionRow): ConnectionRow {
    // 重新读一次：list() 先取出所有行，第一行可能已经触发了全部重封，后面的行手里是旧值。
    const row = getConnection(this.#db, stale.id) ?? stale;
    const { manifest, state } = this.#readManifest();
    if (!manifest) {
      if (state !== "valid" && this.#resealAll(state)) return getConnection(this.#db, row.id) ?? this.#strictView(row);
      return this.#strictView(row);
    }
    const found = this.#rowSettings(row);
    const version = manifest.rows[String(row.id)];
    let sealed: ConnectionSettings | null = null;
    let seal: ConnectionSettingsSealState = "missing";
    const blob = getConnectionSettingsSeal(this.#db, row.id);
    if (version !== undefined && blob) {
      sealed = this.#openSeal(row.id, blob, { epoch: manifest.epoch, version });
      seal = sealed ? "valid" : "invalid";
    }
    if (sealed && sameConnectionSettings(sealed, found)) return row;
    // 走到这里都是被动过：封印和账本不一致，或者这一行没有封印、封印解不开、不在清单里（不是 hub 建的）。
    // 当前版本的封印对不上时，这一行自己带的旧封印如果是真的，也拿来收紧。
    const defaults = normalizeConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
    const own = sealed ? null : this.#openSeal(row.id, blob);
    const expected = sealed ?? (own ? stricterConnectionSettings(defaults, own) : defaults);
    const restored = stricterConnectionSettings(expected, found);
    let next: { seal: Buffer; manifest: Buffer };
    try {
      next = this.#sealNext(row.id, restored, manifest);
    } catch (error) {
      if (!this.#sealUnavailableLogged) {
        this.#sealUnavailableLogged = true;
        this.#log(`[connections] settings seal unavailable, using the stricter settings: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { ...row, roles: JSON.stringify(restored.roles), write_policy: restored.writePolicy };
    }
    setConnectionSettings(this.#db, row.id, {
      ...restored, ...next, event: CONNECTION_SETTINGS_RESTORED_EVENT,
      detail: JSON.stringify({ expected, found, restored, seal }),
    }, iso(this.#now()));
    const key = connectionKey(row);
    this.#log(`[connections] ${key}: settings changed outside the settings page (seal ${seal}); restored the stricter settings`);
    this.#onSettingsAlert({ connectionId: row.id, key, label: row.label, expected, found, restored, seal });
    this.#onChange(key);
    return getConnection(this.#db, row.id) ?? row;
  }

  // hub 建的新行：建的时候就封上（清单已经由 #ensureManifest 保证可读）。
  #sealNewRow(row: ConnectionRow, now: string): void {
    const { manifest } = this.#readManifest();
    if (!manifest) return;
    const next = this.#sealNext(row.id, this.#rowSettings(row), manifest);
    sealConnectionSettings(this.#db, row.id, next.seal, next.manifest, now);
  }

  /**
   * 把还是「先问我」的连接改成「直接写」，只做一次（kv 里记下做过）。用户 2026-10-28：「连提交 comments 都需要我审批，
   * 而且是逐条审批，这简直是灾难性的」「这些操作不要再让我审批了」。走设置页同一条路（updateSettings）：重新封印，
   * 改动记录写明是系统按用户的话改的。以后用户在设置页改回「先问我」，不会再被改掉。返回改了哪些连接。
   */
  relaxWritePolicyOnce(): string[] {
    if (this.#db.prepare("SELECT 1 FROM kv WHERE key = ?").get(WRITE_POLICY_RELAXED_KEY)) return [];
    this.auditSettings();
    const changed: string[] = [];
    for (const row of listConnections(this.#db)) {
      const key = connectionKey(row);
      try {
        if (this.#verified(row).write_policy !== "confirm") continue;
        this.updateSettings(key, { writePolicy: "direct" });
        // updateSettings 记了 settings_changed；这一条写明是谁、为什么改的。
        addConnectionEvent(this.#db, row.id, "write_policy_relaxed", JSON.stringify({
          by: "system", writePolicy: "direct", reason: "用户 2026-10-28：这些操作不要再让我审批了",
        }), iso(this.#now()));
        changed.push(key);
      } catch (error) {
        // 保险库不可用这类：这一次不改，下次启动再试（不记做过）。
        this.#log(`[connections] ${key}: could not switch to direct writes: ${error instanceof Error ? error.message : String(error)}`);
        return changed;
      }
    }
    this.#db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(WRITE_POLICY_RELAXED_KEY, JSON.stringify(changed), iso(this.#now()));
    return changed;
  }

  /** 核对所有连接的权限设置。启动时和每一拍调用。一行出错不影响别的行。 */
  auditSettings(): void {
    try {
      this.#ensureManifest();
    } catch (error) {
      this.#log(`[connections] settings manifest check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const row of listConnections(this.#db)) {
      try {
        this.#verified(row);
      } catch (error) {
        this.#log(`[connections] ${connectionKey(row)}: settings audit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async test(key: string): Promise<{ ok: boolean; message: string; connection: ConnectionDto }> {
    try {
      const row = this.#liveRow(key);
      const tools = this.#shapeTools(row, await this.#withAuthRetry(row.id, () => this.#refreshTools(row.id)));
      return { ok: true, message: `能用，${tools.length} 个工具`, connection: this.get(key) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), connection: this.get(key) };
    }
  }

  // ——— 工具 ———

  toolDtos(key: string): ConnectionToolDto[] {
    const row = this.#liveRow(key);
    return this.#rowTools(row).map((tool) => ({
      name: tool.name, title: tool.title, description: tool.description, readOnly: tool.readOnly,
    }));
  }

  // 已连接、并且这个角色可以用的连接。Lead 的提示词和工具说明用它。
  available(role: ConnectionRole): Array<{ key: string; label: string; capability: string; account: string | null; state: ConnectionDto["state"] }> {
    return this.list()
      .filter((item) => (item.state === "connected" || item.state === "degraded") && item.roles.includes(role))
      .map((item) => ({ key: item.key, label: item.label, capability: item.capability, account: item.account, state: item.state }));
  }

  // 给 agent 的工具列表：按角色和写入策略过滤，按关键词筛选。带清单的 Run（runId）只看得到清单允许的工具。
  async searchTools(
    role: ConnectionRole,
    input: { connection?: string; query?: string; limit?: number } = {},
    options: { runId?: number | null } = {},
  ): Promise<ConnectionToolForAgent[]> {
    const grant = options.runId ? getRunGrant(this.#db, options.runId) : null;
    if (grant) return this.#searchGranted(role, grant, input);
    const keys = input.connection ? [input.connection] : this.available(role).map((item) => item.key);
    const query = input.query?.trim().toLowerCase() ?? "";
    const out: ConnectionToolForAgent[] = [];
    for (const key of keys) {
      if (key === LOCAL_REPO_CONNECTION) throw new ConnectionError("forbidden", "本地仓库只给带权限清单的 Run 用", key);
      const row = this.#liveRow(key);
      this.#assertRole(row, key, role);
      const tools = await this.#toolsOf(row);
      for (const tool of tools) {
        if (!this.#toolVisible(row, tool, role)) continue;
        if (query && !`${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query)) continue;
        out.push({ ...tool, connection: key });
      }
    }
    return out.slice(0, Math.max(1, Math.min(input.limit ?? 30, 100)));
  }

  // 清单里点到的连接的工具，只留清单里有规则放行的（只看工具名和是否只读；参数在调用时检查）。
  // 每个工具带上放行它的规则（allowedBy），agent 据此知道参数要怎么填。
  async #searchGranted(
    role: ConnectionRole, record: RunGrantRecord, input: { connection?: string; query?: string; limit?: number },
  ): Promise<ConnectionToolForAgent[]> {
    const query = input.query?.trim().toLowerCase() ?? "";
    const wanted = input.connection?.trim().toLowerCase() ?? null;
    const out: ConnectionToolForAgent[] = [];
    const push = (tool: CachedTool, connection: string, aliases: readonly string[]) => {
      const names = new Set([connection, ...aliases].map((name) => name.toLowerCase()));
      const rules = record.grant.rules.filter((rule) => names.has(rule.connection.toLowerCase())
        && (rule.tools === "read" ? tool.readOnly : rule.tools.includes(tool.name)));
      if (!rules.length) return;
      if (query && !`${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query)) return;
      out.push({ ...tool, connection, allowedBy: rules.map((rule) => rule.label) });
    };
    const connections = [...new Set(record.grant.rules.map((rule) => rule.connection))];
    for (const name of connections) {
      if (wanted && name.toLowerCase() !== wanted) continue;
      if (name === LOCAL_REPO_CONNECTION) {
        for (const tool of localRepoToolDefinitions()) push({ ...tool }, LOCAL_REPO_CONNECTION, []);
        continue;
      }
      let row: ConnectionRow;
      try {
        row = this.#liveRow(name);
        this.#assertRole(row, name, role);
      } catch {
        // 没连上、或者用户的设置不让这个角色用：清单里有也看不到。调用时会报具体的原因。
        continue;
      }
      for (const tool of await this.#toolsOf(row)) push(tool, connectionKey(row), this.#aliasesOf(row));
    }
    return out.slice(0, Math.max(1, Math.min(input.limit ?? 30, 100)));
  }

  // 一个连接的别名（清单的规则和 Lead 可以按别名写）：按地址认出的服务（catalog.ts 的 KNOWN_SERVERS，例如 cdp）。
  #aliasesOf(row: ConnectionRow): string[] {
    const known = knownServer(row.server_url);
    return known ? [known.alias] : [];
  }

  // 写入工具在 confirm 策略下：Lead 要先拿到你的确认（confirmed: true），child 看不到它们。评审只能用只读工具。
  #toolVisible(row: ConnectionRow, tool: CachedTool, role: ConnectionRole): boolean {
    if (tool.readOnly) return true;
    if (role === "reviewer") return false;
    if (role === "executor") return row.write_policy === "direct";
    return true;
  }

  needsConfirmation(key: string, tool: string): boolean {
    const row = this.#liveRow(key);
    const found = this.#rowTools(row).find((entry) => entry.name === tool);
    return Boolean(found && !found.readOnly && row.write_policy === "confirm");
  }

  #assertRole(row: ConnectionRow, key: string, role: ConnectionRole): void {
    if (!connectionRoles(row).includes(role)) {
      throw new ConnectionError("forbidden", `${row.label} 的设置不允许${role === "lead" ? " Lead" : role === "executor" ? "执行工单的 agent" : "评审 agent"}使用`, key);
    }
  }

  // options.grant：没有 Run 的调用方（例如 daemon 自己发 review）给自己的收窄清单，按同一套规则检查（不记 Run 的审计）。
  // 它只能收窄：带清单的 Run 还要过库里的清单。
  async callTool(
    key: string, toolName: string, args: Record<string, unknown>,
    options: { role: ConnectionRole; confirmed?: boolean; signal?: AbortSignal; runId?: number | null; grant?: RunGrant },
  ): Promise<ConnectionCallResult> {
    const grant = options.runId ? getRunGrant(this.#db, options.runId) : null;
    if (options.grant) this.#checkCallerGrant(options.grant, key, toolName, args);
    if (grant) return this.#callGranted(grant, key, toolName, args, options);
    if (key === LOCAL_REPO_CONNECTION) throw new ConnectionError("forbidden", "本地仓库只给带权限清单的 Run 用", key);
    const row = this.#liveRow(key);
    this.#assertRole(row, key, options.role);
    const tools = await this.#toolsOf(row);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) throw new ConnectionError("unknown_tool", `${row.label} 没有工具 ${toolName}。先用 search_connection_tools 查一下`, key);
    if (!this.#toolVisible(row, tool, options.role)) {
      throw new ConnectionError("forbidden", `${toolName} 会写入 ${row.label}，这个角色不能用它`, key);
    }
    if (!tool.readOnly && row.write_policy === "confirm" && !options.confirmed) {
      throw new ConnectionError("confirmation_required", `${toolName} 会写入 ${row.label}，要先得到用户确认`, key);
    }
    const context = this.#callContext(row, key, tool, args, options, null);
    const problem = await this.#guardProblem(context);
    if (problem) throw new ConnectionError("forbidden", `${row.label} 拒绝了这次调用：${problem}`, key);
    const result = await this.#invoke(row, tool, args, options.signal);
    return { text: result.text, truncated: result.truncated, isError: result.isError };
  }

  #checkCallerGrant(grant: RunGrant, key: string, toolName: string, args: Record<string, unknown>): void {
    const row = key === LOCAL_REPO_CONNECTION ? null : this.#liveRow(key);
    const tool = row ? this.#rowTools(row).find((entry) => entry.name === toolName) : null;
    const guard = row ? this.#guards.get(connectionKey(row)) : null;
    const check = checkGrantCall(grant, {
      connection: row ? connectionKey(row) : key, aliases: row ? [key, ...this.#aliasesOf(row)] : [], tool: toolName,
      readOnly: key === LOCAL_REPO_CONNECTION || Boolean(tool?.readOnly),
      facts: { ...args, ...(guard?.facts?.(toolName, args) ?? {}) },
    });
    if (!check.ok) throw new ConnectionError("grant_denied", `拒绝：${check.reason}`, key);
  }

  // 带清单的 Run 的一次调用：清单 → 硬性底线 → 守卫 → 调用 → 记账。每一步拒绝都记一条审计。
  async #callGranted(
    record: RunGrantRecord, key: string, toolName: string, args: Record<string, unknown>,
    options: { role: ConnectionRole; signal?: AbortSignal; runId?: number | null },
  ): Promise<ConnectionCallResult> {
    const { runId, itemId, grant } = record;
    const ledger = this.runReads(runId);
    const audit = (input: Omit<Parameters<typeof recordRunToolCall>[1], "runId" | "itemId" | "tool" | "args" | "connection"> & { connection?: string }) =>
      recordRunToolCall(this.#db, { runId, itemId, connection: input.connection ?? key, tool: toolName, args, ...input, now: new Date(this.#now()) });
    const refuse = (access: "read" | "write", reason: string, target: string | null = null): never => {
      audit({ access, decision: "refused", reason, target });
      ledger.record({ tool: toolName, repo: target ?? key, bytes: 0, refused: reason });
      throw new ConnectionError("grant_denied", `拒绝：${reason}`, key);
    };

    if (key === LOCAL_REPO_CONNECTION) {
      if (!localRepoToolDefinitions().some((tool) => tool.name === toolName)) refuse("read", `本地仓库没有工具 ${toolName}`);
      const check = checkGrantCall(grant, { connection: key, tool: toolName, readOnly: true, facts: args });
      if (!check.ok) refuse("read", check.reason, typeof args.repo === "string" ? args.repo : null);
      const rule = (check as Extract<typeof check, { ok: true }>).rule;
      try {
        const result = await callLocalRepoTool({
          tool: toolName, args, repos: grant.localRepos, ledger, deniedRoots: this.#localDeniedRoots,
          limits: this.#localRepoLimits, ...(options.signal ? { signal: options.signal } : {}),
        });
        audit({ access: "read", decision: "allowed", outcome: "ok", ruleId: rule.id, target: result.target });
        return { text: result.text, truncated: result.truncated, isError: false };
      } catch (error) {
        if (error instanceof LocalToolRefusal) return refuse("read", error.reason, error.target);
        throw error;
      }
    }

    const row = this.#liveRow(key);
    const realKey = connectionKey(row);
    this.#assertRole(row, key, options.role);
    const tools = await this.#toolsOf(row);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) {
      audit({ access: "read", decision: "refused", reason: `没有工具 ${toolName}` });
      throw new ConnectionError("unknown_tool", `${row.label} 没有工具 ${toolName}。先用 search_connection_tools 查一下`, key);
    }
    const access = tool.readOnly ? "read" : "write";
    const guard = this.#guards.get(realKey) ?? this.#guards.get(key);
    const target = guard?.target?.(toolName, args) ?? null;
    const facts = { ...args, ...(guard?.facts?.(toolName, args) ?? {}) };
    const check = checkGrantCall(grant, { connection: realKey, aliases: [key, ...this.#aliasesOf(row)], tool: toolName, readOnly: tool.readOnly, facts });
    if (!check.ok) refuse(access, check.reason, target);
    const rule = (check as Extract<typeof check, { ok: true }>).rule;
    if (!tool.readOnly) {
      const leak = credentialProblem(args);
      if (leak) refuse(access, leak, target);
    }
    const context = this.#callContext(row, realKey, tool, args, options, { runId, ledger });
    const problem = await this.#guardProblem(context);
    if (problem) refuse(access, problem, target);
    const callId = audit({ access, decision: "allowed", ruleId: rule.id, target });
    let result: ConnectionCallResult;
    try {
      result = await this.#invoke(row, tool, args, options.signal);
    } catch (error) {
      settleRunToolCall(this.#db, callId, { outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (tool.readOnly) {
      guard?.observe?.(context, result);
      if (!guard?.observe) ledger.record({ tool: toolName, repo: target ?? realKey, bytes: Buffer.byteLength(result.text, "utf8") });
      // 原文留给出处核实（子 agent 引用连接的查询结果时，引用的原文要在这里找得到）。
      if (!result.isError) ledger.addText([key, realKey, ...this.#aliasesOf(row)], toolName, result.text);
      settleRunToolCall(this.#db, callId, { outcome: result.isError ? "error" : "ok" });
      return result;
    }
    // 没有守卫说明的写操作当作别人看得到（保守：记成主人操作，推给你）。
    const description: WriteDescription = guard?.describe?.(context, result)
      ?? { summary: `调用了 ${row.label} 的 ${toolName}`, target, url: null, visible: true };
    settleRunToolCall(this.#db, callId, {
      outcome: result.isError ? "error" : "ok", summary: description.summary, url: description.url, visible: description.visible,
      ...(result.isError ? { reason: result.text.slice(0, 300) } : {}),
    });
    if (!result.isError) {
      try {
        this.#onAgentWrite({ runId, itemId, callId, connection: realKey, label: row.label, tool: toolName, ruleId: rule.id, description, args });
      } catch (error) {
        this.#log(`[connections] ${realKey}: write by run #${runId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  #callContext(
    row: ConnectionRow, key: string, tool: CachedTool, args: Record<string, unknown>,
    options: { role: ConnectionRole; signal?: AbortSignal }, run: { runId: number; ledger: RunReadLedger } | null,
  ): ToolCallContext {
    return {
      key, tool: tool.name, args, readOnly: tool.readOnly, role: options.role,
      runId: run?.runId ?? null, ledger: run?.ledger ?? null,
      ...(options.signal ? { signal: options.signal } : {}),
      read: async (name, readArgs) => {
        const found = (await this.#toolsOf(row)).find((entry) => entry.name === name);
        if (!found?.readOnly) throw new ConnectionError("forbidden", `守卫只能读只读工具，${name} 不是`, key);
        const result = await this.#invoke(row, found, readArgs, options.signal);
        return { text: result.text, isError: result.isError };
      },
    };
  }

  async #guardProblem(context: ToolCallContext): Promise<string | null> {
    const guard = this.#guards.get(context.key);
    if (!guard?.check) return null;
    try {
      return await guard.check(context);
    } catch (error) {
      // 守卫自己出错（例如读不到 PR 的状态）：拒绝，不放过。
      return `检查没有做完：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async #invoke(row: ConnectionRow, tool: CachedTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectionCallResult> {
    const started = this.#now();
    try {
      const result = await this.#withAuthRetry(row.id, () => this.#client(row.id).callTool(tool.name, args, signal));
      const { text, truncated } = contentText(result);
      updateConnection(this.#db, row.id, { last_used_at: iso(this.#now()), last_ok_at: iso(this.#now()) });
      addConnectionEvent(this.#db, row.id, "tool_called", `${tool.name} ${tool.readOnly ? "read" : "write"} ${result.isError ? "error" : "ok"} ${this.#now() - started}ms`);
      return { text, truncated, isError: result.isError };
    } catch (error) {
      addConnectionEvent(this.#db, row.id, "tool_called", `${tool.name} ${tool.readOnly ? "read" : "write"} failed`);
      throw this.#callError(connectionKey(row), row, error);
    }
  }

  // ——— 带清单的 Run 读到的内容 ———

  /** 这个 Run 读到的内容和审计（出处核实用）。没有时新建一份。 */
  runReads(runId: number): RunReadLedger {
    let ledger = this.#ledgers.get(runId);
    if (!ledger) {
      ledger = new RunReadLedger(() => new Date(this.#now()));
      this.#ledgers.set(runId, ledger);
      // 只留最近的 64 个 Run：Run 结束时没有 releaseRun（例如进程崩了）也不会一直涨。
      while (this.#ledgers.size > 64) this.#ledgers.delete(this.#ledgers.keys().next().value!);
    }
    return ledger;
  }

  /** Run 结束了：丢掉它读到的内容。 */
  releaseRun(runId: number): void {
    this.#ledgers.delete(runId);
  }

  // ——— 写入确认 ———

  // 存下一次会写入的调用（参数原样），返回确认号。只在写入策略是「先问我」时需要。
  requestWrite(key: string, toolName: string, args: Record<string, unknown>, summary: string): ConnectionConfirmationDto {
    this.#sweepWrites();
    const row = this.#liveRow(key);
    this.#assertRole(row, key, "lead");
    const tool = this.#rowTools(row).find((entry) => entry.name === toolName);
    if (!tool) throw new ConnectionError("unknown_tool", `${row.label} 没有工具 ${toolName}`, key);
    if (tool.readOnly || row.write_policy !== "confirm") {
      throw new ConnectionError("invalid_request", `${toolName} 不需要确认，直接调用即可`, key);
    }
    const now = this.#now();
    const write: PendingWrite = {
      id: `cfm_${randomBytes(12).toString("base64url")}`, key, label: row.label, tool: toolName, args,
      summary: summary.trim().slice(0, 300) || `调用 ${toolName}`, createdAt: now, expiresAt: now + CONFIRMATION_TTL_MS,
      state: "pending", resolvedBy: null, resultPreview: null,
    };
    this.#writes.set(write.id, write);
    addConnectionEvent(this.#db, row.id, "write_requested", `${write.id} ${toolName}`, iso(now));
    return this.#confirmationDto(write);
  }

  confirmation(id: string): ConnectionConfirmationDto {
    this.#sweepWrites();
    const write = this.#writes.get(id);
    if (!write) throw new ConnectionError("not_found", "这个确认已经过期或不存在");
    return this.#confirmationDto(write);
  }

  // 你点了「允许」或「不要」。允许时 daemon 执行存下的那一次调用（不接受新的参数），结果交给 Lead。
  async resolveConfirmation(id: string, approve: boolean, resolvedBy: string): Promise<ConnectionConfirmationDto> {
    this.#sweepWrites();
    const write = this.#writes.get(id);
    if (!write) throw new ConnectionError("not_found", "这个确认已经过期或不存在");
    if (write.state !== "pending") return this.#confirmationDto(write);
    write.resolvedBy = resolvedBy;
    if (!approve) {
      write.state = "rejected";
      this.#onConfirmation({ confirmation: this.#confirmationDto(write), resultText: null });
      return this.#confirmationDto(write);
    }
    write.state = "running";
    let resultText: string | null = null;
    try {
      const result = await this.callTool(write.key, write.tool, write.args, { role: "lead", confirmed: true });
      write.state = result.isError ? "failed" : "done";
      resultText = result.text.slice(0, 20_000);
      write.resultPreview = result.text.slice(0, 500);
    } catch (error) {
      write.state = "failed";
      write.resultPreview = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      resultText = write.resultPreview;
    }
    this.#onConfirmation({ confirmation: this.#confirmationDto(write), resultText });
    return this.#confirmationDto(write);
  }

  #confirmationDto(write: PendingWrite): ConnectionConfirmationDto {
    const preview = JSON.stringify(write.args);
    return {
      id: write.id, key: write.key, label: write.label, tool: write.tool, summary: write.summary,
      argumentsPreview: preview.length > 2_000 ? `${preview.slice(0, 2_000)}…` : preview,
      state: write.state, createdAt: iso(write.createdAt), expiresAt: iso(write.expiresAt),
      resolvedBy: write.resolvedBy, resultPreview: write.resultPreview,
    };
  }

  // 过期的确认标成 expired；结束超过 30 分钟的从内存里删掉。daemon 重启后，没确认的写入都作废。
  // 过期也是这次确认的结果（2026-10-19）：交给 onConfirmation，daemon 记一条 user_request.expired，在等它的 Lead 被叫醒。
  #sweepWrites(): void {
    const now = this.#now();
    for (const write of this.#writes.values()) {
      if (write.state === "pending" && write.expiresAt <= now) {
        write.state = "expired";
        this.#onConfirmation({ confirmation: this.#confirmationDto(write), resultText: null });
      }
      if (write.expiresAt + CONFIRMATION_TTL_MS <= now) this.#writes.delete(write.id);
    }
  }

  #callError(key: string, row: ConnectionRow, error: unknown): ConnectionError {
    if (error instanceof ConnectionError) return error;
    if (error instanceof McpTransportError) {
      return new ConnectionError("temporarily_unavailable", `暂时连不上 ${row.label}：${error.message}`, key);
    }
    if (error instanceof McpRpcError) return new ConnectionError("invalid_request", `${row.label} 拒绝了这次调用：${error.message}`, key);
    if (error instanceof McpAuthError) return new ConnectionError("needs_reauth", `${row.label} 的授权失效了，需要重新授权`, key);
    return new ConnectionError("temporarily_unavailable", error instanceof Error ? error.message : String(error), key);
  }

  async #toolsOf(row: ConnectionRow): Promise<CachedTool[]> {
    const fetched = parseTime(row.tools_fetched_at);
    if (row.tools_json && fetched !== null && this.#now() - fetched < TOOLS_STALE_MS) return this.#rowTools(row);
    try {
      return this.#shapeTools(row, await this.#withAuthRetry(row.id, () => this.#refreshTools(row.id)));
    } catch (error) {
      // 刷新失败时，有旧的缓存就先用旧的。
      if (row.tools_json) return this.#rowTools(row);
      throw error;
    }
  }

  async #refreshTools(id: number): Promise<CachedTool[]> {
    const tools = (await this.#client(id).listTools()).map(toCachedTool);
    updateConnection(this.#db, id, { tools_json: JSON.stringify(tools), tools_fetched_at: iso(this.#now()) });
    return tools;
  }

  // 401：续期（或者重读 gh 的令牌）后重试一次。还是 401 就标成需要重新授权。
  // 403 insufficient_scope：权限不够，标出来，要你重新授权。
  async #withAuthRetry<T>(id: number, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      const row = getConnection(this.#db, id)!;
      if (error.status === 403 && /insufficient_scope/i.test(error.challenge ?? "")) {
        this.#markNeedsReauth(row, "insufficient_scope", "the token lacks a required scope");
        throw error;
      }
      if (row.token_source === "gh_cli") {
        await this.#readGhToken(true);
      } else if (row.token_source === "oauth") {
        await this.#refresh(id, { force: true });
      } else {
        this.#markNeedsReauth(row, "invalid_grant", "the server rejected the stored token");
        throw error;
      }
      this.#dropClient(id);
      try {
        return await run();
      } catch (retryError) {
        if (retryError instanceof McpAuthError) this.#markNeedsReauth(getConnection(this.#db, id)!, "invalid_grant", "the server rejected the refreshed token");
        throw retryError;
      }
    }
  }

  #client(id: number): McpHttpClient {
    let client = this.#clients.get(id);
    if (!client) {
      const row = getConnection(this.#db, id)!;
      client = new McpHttpClient({
        url: row.server_url, fetch: this.#fetch, clientName: "pi-lead-child",
        token: () => this.#tokenFor(id),
      });
      this.#clients.set(id, client);
    }
    return client;
  }

  #dropClient(id: number): void {
    const client = this.#clients.get(id);
    this.#clients.delete(id);
    void client?.close();
  }

  async #tokenFor(id: number): Promise<string | null> {
    const row = getConnection(this.#db, id);
    if (!row) return null;
    if (row.token_source === "gh_cli") return this.#readGhToken(false);
    return this.accessToken(id);
  }

  async #readGhToken(force: boolean): Promise<string | null> {
    if (!this.#gh) return null;
    if (!force && this.#ghToken.value && this.#now() - this.#ghToken.at < MINUTE) return this.#ghToken.value;
    this.#ghToken.value = await this.#gh.token();
    this.#ghToken.at = this.#now();
    return this.#ghToken.value;
  }

  // ——— 令牌和续期 ———

  #readSecret(row: ConnectionRow): StoredSecret | null {
    if (!row.secret_cipher) return null;
    return this.#vault.open<StoredSecret>(row.secret_cipher, connectionSecretAad(row.id, row.secret_version));
  }

  // 当前可用的访问令牌。快到期时先续（单飞）。
  async accessToken(id: number): Promise<string | null> {
    const row = getConnection(this.#db, id);
    if (!row) return null;
    const secret = this.#readSecret(row);
    if (!secret?.accessToken) return null;
    const expires = parseTime(row.access_expires_at);
    if (expires === null || expires - this.#now() > refreshSkewMs(row) || !secret.refreshToken) return secret.accessToken;
    return this.#refresh(id, { force: false });
  }

  // 同一个连接同时只有一个续期。force：不管有没有快到期都续（收到 401 时）。
  #refresh(id: number, options: { force: boolean; reason?: string }): Promise<string | null> {
    const running = this.#refreshing.get(id);
    if (running) return running;
    const promise = this.#doRefresh(id, options).finally(() => { this.#refreshing.delete(id); });
    this.#refreshing.set(id, promise);
    return promise;
  }

  async #doRefresh(id: number, options: { force: boolean; reason?: string }): Promise<string | null> {
    if (!await this.#takeLease(id)) {
      // 别的进程在续：它写完以后，读它写的。
      const row = getConnection(this.#db, id);
      return row ? this.#readSecret(row)?.accessToken ?? null : null;
    }
    try {
      const row = getConnection(this.#db, id);
      if (!row || row.status === "disconnected" || row.status === "needs_reauth") return null;
      const secret = this.#readSecret(row);
      if (!secret?.accessToken) return null;
      const expires = parseTime(row.access_expires_at);
      const fresh = expires === null || expires - this.#now() > refreshSkewMs(row);
      // 拿到租约以后重读：可能别处刚续过。
      if (!options.force && fresh && options.reason !== "keep_alive") return secret.accessToken;
      if (!secret.refreshToken || !row.token_endpoint || !row.client_id) {
        if (expires !== null && expires <= this.#now()) this.#markNeedsReauth(row, "invalid_grant", "the access token expired and there is no refresh token");
        return expires === null || expires > this.#now() ? secret.accessToken : null;
      }
      let tokens: TokenSet;
      try {
        const client = await this.#clientCredentials(row);
        const server = client.clientSecret ? await this.#metadataFor(row) : { token_endpoint: row.token_endpoint };
        tokens = await refreshTokens(this.#fetch, server, client, { refreshToken: secret.refreshToken, resource: row.server_url });
      } catch (error) {
        return this.#refreshFailed(row, secret, error);
      }
      const now = this.#now();
      const saved = this.#db.transaction(() => {
        const current = getConnection(this.#db, id)!;
        if (current.secret_version !== row.secret_version) return false;
        const next: StoredSecret = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? secret.refreshToken };
        const cipher = this.#vault.seal(next, connectionSecretAad(id, current.secret_version + 1));
        if (!saveConnectionSecret(this.#db, id, cipher, current.secret_version, iso(now))) return false;
        updateConnection(this.#db, id, {
          status: "connected",
          access_expires_at: tokens.expiresIn ? iso(now + tokens.expiresIn * 1000) : null,
          last_refresh_at: iso(now), last_ok_at: iso(now),
          failure_kind: null, failure_detail: null, failure_count: 0, next_attempt_at: null,
          ...(tokens.scope ? { scopes: tokens.scope } : {}),
        }, iso(now));
        addConnectionEvent(this.#db, id, "refreshed", options.reason ?? (options.force ? "after_401" : "expiring"), iso(now));
        return true;
      })();
      if (!saved) {
        const current = getConnection(this.#db, id);
        return current ? this.#readSecret(current)?.accessToken ?? null : null;
      }
      if (row.status !== "connected") this.#onChange(connectionKey(row));
      return tokens.accessToken;
    } finally {
      releaseConnectionLease(this.#db, id, this.#leaseOwner);
    }
  }

  // 等别的进程放开租约，最多等一个租约的时长。等待用真实的时钟（测试里 now 可能是假的）。
  async #takeLease(id: number): Promise<boolean> {
    const deadline = Date.now() + LEASE_MS;
    for (;;) {
      const now = this.#now();
      if (takeConnectionLease(this.#db, id, this.#leaseOwner, iso(now + LEASE_MS), iso(now))) return true;
      if (Date.now() >= deadline || this.#closed) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  #refreshFailed(row: ConnectionRow, secret: StoredSecret, error: unknown): string | null {
    const kind = error instanceof OAuthError ? error.kind : "transient";
    const detail = error instanceof Error ? error.message : String(error);
    if (kind === "invalid_grant" || kind === "invalid_client") {
      // 版本变了说明别处刚续过：用别处的新令牌，不算失效。
      const current = getConnection(this.#db, row.id)!;
      if (current.secret_version !== row.secret_version) return this.#readSecret(current)?.accessToken ?? null;
      if (kind === "invalid_client" && row.issuer) deleteOAuthClientsOf(this.#db, row.issuer);
      this.#markNeedsReauth(row, kind, detail);
      return null;
    }
    // 暂时的失败（包括服务器回了看不懂的错误）：退避，旧的访问令牌没过期就继续用。
    const count = row.failure_count + 1;
    const now = this.#now();
    updateConnection(this.#db, row.id, {
      status: "degraded", failure_kind: "transient", failure_detail: detail.slice(0, 500), failure_count: count,
      next_attempt_at: iso(now + backoffMs(count)),
    }, iso(now));
    addConnectionEvent(this.#db, row.id, "refresh_failed", detail.slice(0, 300), iso(now));
    if (row.status !== "degraded") this.#onChange(connectionKey(row));
    this.#log(`[connections] ${connectionKey(row)}: refresh failed (${count}), retrying in ${Math.round(backoffMs(count) / 1000)} s: ${detail}`);
    const expires = parseTime(row.access_expires_at);
    return expires === null || expires > now ? secret.accessToken : null;
  }

  #markNeedsReauth(row: ConnectionRow, kind: "invalid_grant" | "invalid_client" | "insufficient_scope", detail: string): void {
    const now = iso(this.#now());
    const wasBroken = row.status === "needs_reauth";
    updateConnection(this.#db, row.id, {
      status: "needs_reauth", failure_kind: kind, failure_detail: detail.slice(0, 500), next_attempt_at: null,
    }, now);
    if (wasBroken) return;
    addConnectionEvent(this.#db, row.id, "needs_reauth", kind, now);
    this.#dropClient(row.id);
    const key = connectionKey(row);
    this.#log(`[connections] ${key}: needs re-authorization (${kind})`);
    this.#onChange(key);
    // 一次失效只通知一次：只在从别的状态变成 needs_reauth 时通知。
    this.#onAttention({
      kind: "needs_reauth", key, label: row.label,
      message: this.#problem({ ...row, status: "needs_reauth", failure_kind: kind }, this.#now())?.message ?? `${row.label} 需要重新授权`,
    });
  }

  async #clientCredentials(row: ConnectionRow): Promise<ClientCredentials> {
    const clientId = row.client_id!;
    for (const provider of ["slack", "github"] as const) {
      const configured = this.#config.clients[provider];
      if (configured?.clientId === clientId) return { clientId, clientSecret: this.#secrets.get(configured.secretName) };
    }
    const stored = row.issuer ? findOAuthClient(this.#db, row.issuer, clientId) : null;
    return {
      clientId,
      clientSecret: stored?.secret_cipher ? this.#vault.open<string>(stored.secret_cipher, oauthClientSecretAad(stored.issuer, stored.redirect_uri)) : null,
    };
  }

  // 有 client secret 时要知道服务器接受哪种认证方式，所以读一次元数据（缓存 1 小时）。
  async #metadataFor(row: ConnectionRow): Promise<Pick<AuthorizationServerMetadata, "token_endpoint" | "token_endpoint_auth_methods_supported">> {
    if (!row.issuer) return { token_endpoint: row.token_endpoint! };
    const cached = this.#serverMetadata.get(row.issuer);
    if (cached && this.#now() - cached.at < 60 * MINUTE) return cached.metadata;
    const metadata = await fetchAuthorizationServerMetadata(this.#fetch, row.issuer);
    this.#serverMetadata.set(row.issuer, { metadata, at: this.#now() });
    return metadata;
  }

  // ——— 扫描 ———

  // 续快到期的令牌、保活、重试暂时失败的连接、提前提醒授权到期。每个连接互不影响。
  async tick(): Promise<void> {
    if (this.#closed) return;
    this.#sweepFlows();
    this.auditSettings();
    this.#sweepWrites();
    const now = this.#now();
    const work: Promise<unknown>[] = [];
    for (const row of listConnections(this.#db).map((raw) => this.#verified(raw))) {
      if (row.status !== "connected" && row.status !== "degraded") continue;
      this.#warnExpiry(row, now);
      if (row.token_source !== "oauth") continue;
      // 没有刷新令牌的连接（服务器不发，或者不要授权）没什么可续的：令牌过期后，下一次调用收到 401 时再处理。
      if (!this.#readSecret(row)?.refreshToken) continue;
      const expires = parseTime(row.access_expires_at);
      const lastRefresh = parseTime(row.last_refresh_at) ?? 0;
      const retryAt = parseTime(row.next_attempt_at);
      const due = expires !== null && expires - now <= refreshSkewMs(row);
      const keepAlive = now - lastRefresh >= KEEP_ALIVE_MS;
      if (row.status === "degraded" && retryAt !== null && retryAt > now) continue;
      if (!due && !keepAlive && row.status !== "degraded") continue;
      work.push(this.#refresh(row.id, { force: keepAlive || row.status === "degraded", reason: due ? "expiring" : keepAlive ? "keep_alive" : "retry" })
        .catch((error) => this.#log(`[connections] ${connectionKey(row)}: refresh crashed: ${error instanceof Error ? error.message : String(error)}`)));
    }
    await Promise.all(work);
  }

  // 授权有固定期限时（Notion 180 天），提前 7 天和 1 天各提醒一次。同一次授权里每个提醒只发一次。
  #warnExpiry(row: ConnectionRow, now: number): void {
    const ends = parseTime(row.grant_expires_at);
    if (ends === null || !row.connected_at) return;
    for (const warning of EXPIRY_WARNINGS) {
      if (ends - now > warning.ms) continue;
      if (hasConnectionEventSince(this.#db, row.id, "expiry_warning", warning.label, row.connected_at)) continue;
      // 1 天的提醒发了，7 天的就不用再补发。
      if (warning.label === "7d" && ends - now <= EXPIRY_WARNINGS[1].ms) {
        addConnectionEvent(this.#db, row.id, "expiry_warning", warning.label, iso(now));
        continue;
      }
      addConnectionEvent(this.#db, row.id, "expiry_warning", warning.label, iso(now));
      const key = connectionKey(row);
      const message = this.#problem(row, now)?.message ?? `${row.label} 的授权快到期了`;
      this.#onAttention({ kind: "expiring", key, label: row.label, message });
      this.#onChange(key);
      break;
    }
  }
}

function toCachedTool(tool: McpTool): CachedTool {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title ?? null,
    description: tool.description ? tool.description.slice(0, 2_000) : null,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
    // 只有服务器明确标了只读的工具才算只读。没标的一律当作会写入。
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

// 从 whoami 一类工具的结果里挑一个账号名：email、login、name 依次。
export function pickAccount(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(text);
    return email ? email[0] : null;
  }
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > 4 || !node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    const record = node as Record<string, unknown>;
    for (const field of ["email", "login", "name", "display_name", "real_name"]) {
      if (typeof record[field] === "string" && record[field]) return field === "login" ? `@${record[field]}` : record[field] as string;
    }
    for (const child of Object.values(record).slice(0, 20)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}

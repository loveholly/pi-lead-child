// 连接的 DAO（v42，表在 schema.ts 的 CONNECTIONS_SCHEMA）。
// 这里只存取行，不懂 OAuth，也不碰明文令牌：secret_cipher 是 packages/connections 加密好的密文。
// 状态（status）变了时，同一个事务里往事件日志写一条 connection.status_changed（2026-10-19）：
// 以前只写 connection_events，用户授权完成以后，在等授权的 Lead 收不到任何事件（工单 #98）。
import { CONNECTION_STATUS_CHANGED_KIND } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEventGuarded } from "./events.js";

export type ConnectionTokenSource = "oauth" | "gh_cli" | "device" | "pat";
export type ConnectionStatus = "connected" | "degraded" | "needs_reauth" | "disconnected";
export type ConnectionFailureKind =
  | "transient" | "invalid_grant" | "invalid_client" | "insufficient_scope" | "unavailable";
export type ConnectionRole = "lead" | "executor" | "reviewer";
export type ConnectionWritePolicy = "confirm" | "direct";

export interface ConnectionRow {
  id: number;
  provider: string;
  label: string;
  server_url: string;
  token_source: ConnectionTokenSource;
  status: ConnectionStatus;
  issuer: string | null;
  token_endpoint: string | null;
  revocation_endpoint: string | null;
  client_id: string | null;
  account_label: string | null;
  scopes: string | null;
  access_expires_at: string | null;
  grant_expires_at: string | null;
  last_refresh_at: string | null;
  last_used_at: string | null;
  last_ok_at: string | null;
  failure_kind: ConnectionFailureKind | null;
  failure_detail: string | null;
  failure_count: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  roles: string;
  write_policy: ConnectionWritePolicy;
  tools_json: string | null;
  tools_fetched_at: string | null;
  secret_cipher: Buffer | null;
  secret_version: number;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewConnection {
  provider: string;
  label: string;
  serverUrl: string;
  tokenSource: ConnectionTokenSource;
  roles?: ConnectionRole[];
  writePolicy?: ConnectionWritePolicy;
}

// 可以用 updateConnection 改的列。密文和版本号只能用 saveConnectionSecret 改（带版本比较），
// 租约只能用 takeConnectionLease / releaseConnectionLease 改。
// 权限设置（roles、write_policy）只能用 setConnectionSettings 改：它同时写封印和改动记录（2026-10-19 审查）。
export type ConnectionPatch = Partial<Pick<ConnectionRow,
  | "label" | "token_source" | "status" | "issuer" | "token_endpoint" | "revocation_endpoint" | "client_id"
  | "account_label" | "scopes" | "access_expires_at" | "grant_expires_at" | "last_refresh_at" | "last_used_at"
  | "last_ok_at" | "failure_kind" | "failure_detail" | "failure_count" | "next_attempt_at"
  | "tools_json" | "tools_fetched_at" | "connected_at"
>>;

const PATCH_COLUMNS = new Set<keyof ConnectionPatch>([
  "label", "token_source", "status", "issuer", "token_endpoint", "revocation_endpoint", "client_id",
  "account_label", "scopes", "access_expires_at", "grant_expires_at", "last_refresh_at", "last_used_at",
  "last_ok_at", "failure_kind", "failure_detail", "failure_count", "next_attempt_at",
  "tools_json", "tools_fetched_at", "connected_at",
]);

const DEFAULT_ROLES: ConnectionRole[] = ["lead", "executor", "reviewer"];

// 建一行。建的时候的权限设置记一条 created 审计记录。新行还没有封印：daemon 第一次核对时按
// stricter(账本里的设置, 缺省设置) 补上封印（packages/connections 的 hub）。
export function insertConnection(db: Db, input: NewConnection, now = new Date().toISOString()): ConnectionRow {
  const roles = input.roles ?? DEFAULT_ROLES;
  const writePolicy = input.writePolicy ?? "confirm";
  const id = db.transaction(() => {
    const inserted = Number(db.prepare(
      `INSERT INTO connections (provider, label, server_url, token_source, status, roles, write_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'disconnected', ?, ?, ?, ?)`,
    ).run(
      input.provider, input.label, input.serverUrl, input.tokenSource,
      JSON.stringify(roles), writePolicy, now, now,
    ).lastInsertRowid);
    addConnectionEvent(db, inserted, CONNECTION_CREATED_EVENT, JSON.stringify({ roles, writePolicy }), now);
    return inserted;
  })();
  return getConnection(db, id)!;
}

export function getConnection(db: Db, id: number): ConnectionRow | null {
  return (db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined) ?? null;
}

export function getConnectionByServer(db: Db, serverUrl: string): ConnectionRow | null {
  return (db.prepare("SELECT * FROM connections WHERE server_url = ?").get(serverUrl) as ConnectionRow | undefined) ?? null;
}

export function listConnections(db: Db): ConnectionRow[] {
  return db.prepare("SELECT * FROM connections ORDER BY id").all() as ConnectionRow[];
}

export function updateConnection(db: Db, id: number, patch: ConnectionPatch, now = new Date().toISOString()): void {
  const entries = Object.entries(patch).filter(([key]) => PATCH_COLUMNS.has(key as keyof ConnectionPatch));
  if (entries.length !== Object.keys(patch).length) throw new Error("connection patch has a column that cannot be patched");
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  db.transaction(() => {
    const before = patch.status === undefined ? null : getConnection(db, id);
    db.prepare(`UPDATE connections SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value ?? null), now, id);
    if (before && patch.status !== undefined && patch.status !== before.status) {
      recordConnectionStatusChanged(db, getConnection(db, id)!, before.status, now);
    }
  })();
}

/** 连接对外的 key（设置页、Lead 的连接工具、ConnectionConnect 卡用的那个）。和 packages/connections 的 hub 同一个规则。 */
export function connectionKeyOf(row: Pick<ConnectionRow, "id" | "provider">): string {
  return row.provider === "custom" ? `custom-${row.id}` : row.provider;
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: "已连接",
  degraded: "暂时连不上（daemon 在自动重试）",
  needs_reauth: "授权失效，要用户重新授权",
  disconnected: "已断开",
};

// 级别是 record：连接的状态变化本身只记日志；有人在等这个连接时，等待了结的那一条叫醒 Lead（lead-waits.ts）。
// 用 guarded（2026-10-19 审查）：事件本身出错（例如 key 写不成对象键）时改记一条 system.event_rejected，
// 连接状态的写入照常提交，不跟着回滚。
function recordConnectionStatusChanged(db: Db, row: ConnectionRow, from: ConnectionStatus | null, at: string): void {
  const key = connectionKeyOf(row);
  appendEventGuarded(db, () => ({
    source: "system",
    kind: CONNECTION_STATUS_CHANGED_KIND,
    entityKey: `connection:${key}`,
    occurredAt: at,
    level: "record",
    payload: {
      connectionId: row.id,
      key,
      label: row.label,
      from,
      to: row.status,
      tokenSource: row.token_source,
      summary: `${row.label}（${key}）${STATUS_LABELS[row.status] ?? row.status}`
        + (row.status === "connected" ? `，方式 ${row.token_source}` : "")
        + (row.failure_detail && row.status !== "connected" ? `：${row.failure_detail.slice(0, 160)}` : ""),
    },
  }));
}

// 写密文。只在版本号还是调用方读到的那个时才写，写完版本号加一。返回是否写成。
// 续期拿到新令牌后用它：如果别处已经换过令牌（版本变了），这里不覆盖。
export function saveConnectionSecret(
  db: Db, id: number, cipher: Buffer | null, expectedVersion: number, now = new Date().toISOString(),
): boolean {
  return db.prepare(
    `UPDATE connections SET secret_cipher = ?, secret_version = secret_version + 1, updated_at = ?
     WHERE id = ? AND secret_version = ?`,
  ).run(cipher, now, id, expectedVersion).changes === 1;
}

// 续期租约：没有租约、租约过期、或者租约本来就是自己的时，拿到租约。跨进程也成立，因为这是一条 UPDATE。
export function takeConnectionLease(db: Db, id: number, owner: string, untilIso: string, nowIso: string): boolean {
  return db.prepare(
    `UPDATE connections SET lease_owner = ?, lease_until = ?
     WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)`,
  ).run(owner, untilIso, id, nowIso, owner).changes === 1;
}

export function releaseConnectionLease(db: Db, id: number, owner: string): void {
  db.prepare("UPDATE connections SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?").run(id, owner);
}

export interface ConnectionEventRow {
  id: number;
  connection_id: number;
  kind: string;
  detail: string | null;
  at: string;
}

export function addConnectionEvent(db: Db, connectionId: number, kind: string, detail?: string | null, at = new Date().toISOString()): void {
  db.prepare("INSERT INTO connection_events (connection_id, kind, detail, at) VALUES (?, ?, ?, ?)")
    .run(connectionId, kind, detail ?? null, at);
}

// ——— 权限设置（roles、write_policy）的封印 ———
// 封印是 daemon 用保险库加密的 { roles, writePolicy, version }（packages/connections 的 hub），存在 kv 里。
// 没有保险库的密钥就做不出有效的封印，所以直接改库改不了封印。
// 清单（manifest）也是保险库加密的：{ v, rows: { 连接 id: 版本 } }。每次写封印，这一行的版本和清单的 v 都加一，
// 封印的 AAD 绑定连接 id 和版本：旧封印复制回来解不开，清单里记着封过的行，封印被删掉也看得出来。
// connection_events 里的 created、settings_changed、settings_restored 只是审计记录，核对时不采信（2026-10-19 审查：
// 它和封印一样能被直接改库伪造）。

export const CONNECTION_CREATED_EVENT = "created";
export const CONNECTION_SETTINGS_CHANGED_EVENT = "settings_changed";
export const CONNECTION_SETTINGS_RESTORED_EVENT = "settings_restored";

const sealKey = (connectionId: number) => `connection.settings_seal:${connectionId}`;
const MANIFEST_KEY = "connection.settings_manifest";

function readKv(db: Db, key: string): Buffer | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? Buffer.from(row.value, "base64") : null;
}

function writeKv(db: Db, key: string, value: Buffer, now: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value.toString("base64"), now);
}

export function getConnectionSettingsSeal(db: Db, connectionId: number): Buffer | null {
  return readKv(db, sealKey(connectionId));
}

export function getConnectionSettingsManifest(db: Db): Buffer | null {
  return readKv(db, MANIFEST_KEY);
}

/** 只写一行的封印（测试用它模拟篡改）。正常写封印用 sealConnectionSettings，它和清单一起写。 */
export function saveConnectionSettingsSeal(db: Db, connectionId: number, seal: Buffer, now = new Date().toISOString()): void {
  writeKv(db, sealKey(connectionId), seal, now);
}

/** 只写清单（还没有任何连接时，hub 先建一份空清单）。 */
export function setConnectionSettingsManifest(db: Db, manifest: Buffer, now = new Date().toISOString()): void {
  writeKv(db, MANIFEST_KEY, manifest, now);
}

/** 写一行的封印和新的清单，同一个事务。设置本身没变时用它（例如给 hub 刚建的行封上）。 */
export function sealConnectionSettings(
  db: Db, connectionId: number, seal: Buffer, manifest: Buffer, now = new Date().toISOString(),
): void {
  db.transaction(() => {
    writeKv(db, sealKey(connectionId), seal, now);
    writeKv(db, MANIFEST_KEY, manifest, now);
  })();
}

export interface ConnectionSettingsWrite {
  roles: ConnectionRole[];
  writePolicy: ConnectionWritePolicy;
  // 新设置的封印和新的清单。调用方用保险库做好。
  seal: Buffer;
  manifest: Buffer;
  // 记哪一种改动：settings_changed（经设置页）或 settings_restored（核对后恢复成更严的值）。
  event: typeof CONNECTION_SETTINGS_CHANGED_EVENT | typeof CONNECTION_SETTINGS_RESTORED_EVENT;
  // 改动记录的 detail（JSON）。settings_changed 时是请求里改了的那几项。
  detail: string;
}

/** 改一行的权限设置。设置、封印、清单和改动记录在同一个事务里写。 */
export function setConnectionSettings(db: Db, connectionId: number, input: ConnectionSettingsWrite, now = new Date().toISOString()): void {
  db.transaction(() => {
    db.prepare("UPDATE connections SET roles = ?, write_policy = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(input.roles), input.writePolicy, now, connectionId);
    writeKv(db, sealKey(connectionId), input.seal, now);
    writeKv(db, MANIFEST_KEY, input.manifest, now);
    addConnectionEvent(db, connectionId, input.event, input.detail, now);
  })();
}

export function listConnectionEvents(db: Db, connectionId: number, limit = 50): ConnectionEventRow[] {
  return db.prepare("SELECT * FROM connection_events WHERE connection_id = ? ORDER BY id DESC LIMIT ?")
    .all(connectionId, limit) as ConnectionEventRow[];
}

// 某个事件在某个时间之后有没有记过（例如同一次授权的到期提醒只发一次）。
export function hasConnectionEventSince(db: Db, connectionId: number, kind: string, detail: string | null, sinceIso: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM connection_events
     WHERE connection_id = ? AND kind = ? AND detail IS ? AND at >= ? LIMIT 1`,
  ).get(connectionId, kind, detail, sinceIso));
}

export interface OAuthClientRow {
  issuer: string;
  redirect_uri: string;
  client_id: string;
  method: "dcr" | "cimd";
  secret_cipher: Buffer | null;
  registered_at: string;
}

export function getOAuthClient(db: Db, issuer: string, redirectUri: string): OAuthClientRow | null {
  return (db.prepare("SELECT * FROM oauth_clients WHERE issuer = ? AND redirect_uri = ?").get(issuer, redirectUri) as OAuthClientRow | undefined) ?? null;
}

export function saveOAuthClient(db: Db, row: OAuthClientRow): void {
  db.prepare(
    `INSERT INTO oauth_clients (issuer, redirect_uri, client_id, method, secret_cipher, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (issuer, redirect_uri) DO UPDATE SET
       client_id = excluded.client_id, method = excluded.method,
       secret_cipher = excluded.secret_cipher, registered_at = excluded.registered_at`,
  ).run(row.issuer, row.redirect_uri, row.client_id, row.method, row.secret_cipher, row.registered_at);
}

export function findOAuthClient(db: Db, issuer: string, clientId: string): OAuthClientRow | null {
  return (db.prepare("SELECT * FROM oauth_clients WHERE issuer = ? AND client_id = ? ORDER BY registered_at DESC LIMIT 1")
    .get(issuer, clientId) as OAuthClientRow | undefined) ?? null;
}

export function deleteOAuthClientsOf(db: Db, issuer: string): void {
  db.prepare("DELETE FROM oauth_clients WHERE issuer = ?").run(issuer);
}

export function deleteOAuthClient(db: Db, issuer: string, redirectUri: string): void {
  db.prepare("DELETE FROM oauth_clients WHERE issuer = ? AND redirect_uri = ?").run(issuer, redirectUri);
}

export function connectionRoles(row: Pick<ConnectionRow, "roles">): ConnectionRole[] {
  try {
    const parsed = JSON.parse(row.roles) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((role): role is ConnectionRole => role === "lead" || role === "executor" || role === "reviewer");
  } catch {
    return [];
  }
}

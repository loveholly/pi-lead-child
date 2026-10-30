// paired 平面的配对与凭证（DESIGN-GATEWAY §2，AiSH-X 同构）：
// 配对码与 token 均只存 SHA-256，token 单次下发。
import { createHash, randomBytes } from "node:crypto";
import {
  ALL_SCOPES,
  bindingOriginOf,
  bytesToHex,
  createPairingKeyPair,
  hexToBytes,
  originMayDecide,
  pairedBindingOrigin,
  type BindingOrigin,
  type PairingKeyPair,
  type PairingOrigin,
  type Scope,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去易混字符
const CODE_TTL_MS = 15 * 60_000;
// scope 名是线上契约（protocol 的 ScopeSchema），不随内部 item 改名走。
// 缺省不含 admin：配对码和 loopback 自动配对都换不到管理权限。
export const DEFAULT_SCOPES: Scope[] = ["chat", "tickets:view", "tickets:create", "approvals:respond", "notices"];
// plc 在 plc.sock 上换到、存进数据目录的凭证。同一个用户的任何进程（包括 child）都读得到那个文件，
// 所以它不带 admin，也不带用户的决定（approvals:respond，见 bindingScopes）。plc 没有批审批的命令。
// 管理命令用 plc.sock 上换来的临时 admin token（不落盘）。
export const CLI_CREDENTIAL_SCOPES: Scope[] = DEFAULT_SCOPES.filter((scope) => scope !== "approvals:respond");
// 本机网页 Companion 就是坐在这台机器前的人。自动配对只限制来源必须是允许的
// loopback origin，不把网页降成只读旁观者。
export const LOOPBACK_AUTO_PAIR_SCOPES: Scope[] = [...DEFAULT_SCOPES];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Binding {
  id: number; kind: string; display_name: string; external_subject: string | null;
  token_hash: string | null; scopes: string; status: string;
  last_seen_at: string | null; created_at: string;
  conn_url: string | null; conn_secret: string | null;
  // 凭证是怎么来的（v47，工单 15）。v47 之前建的是 null，用 protocol 的 bindingOriginOf 读。
  origin?: string | null;
}

export interface PendingPairing {
  id: number;
  kind: "desktop" | "companion" | "cli";
  name: string;
  codeHash: string;
  socketSecretHash: string;
  scopes: string;
  status: "pending";
  expiresAt: string;
  origin: PairingOrigin | null;
}

const GATEWAY_IDENTITY_KEY = "gateway_x25519_secret_v1";

export function getOrCreateGatewayIdentity(db: Db): PairingKeyPair {
  return db.transaction(() => {
    const existing = db.prepare("SELECT value FROM kv WHERE key = ?")
      .get(GATEWAY_IDENTITY_KEY) as { value: string } | undefined;
    if (existing && /^[0-9a-f]{64}$/.test(existing.value)) {
      return createPairingKeyPair(hexToBytes(existing.value));
    }

    const candidate = randomBytes(32);
    db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    ).run(GATEWAY_IDENTITY_KEY, bytesToHex(candidate));
    const stored = db.prepare("SELECT value FROM kv WHERE key = ?")
      .get(GATEWAY_IDENTITY_KEY) as { value: string };
    return createPairingKeyPair(hexToBytes(stored.value));
  })();
}

// origin：谁建的配对。缺省 admin（临时 admin token 的管理路由）：兑换出来的凭证做主人操作时推送给用户。
// 只有本机网页的扫码邀请写 web_invitation（见 protocol 的 pairedBindingOrigin）。
export function createPairing(
  db: Db,
  args: { name: string; kind: "desktop" | "companion" | "cli"; scopes?: string[]; origin?: PairingOrigin },
): { pairingId: number; code: string; socketSecret: string; expiresAt: string } {
  let code = "PLC-";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  const socketSecret = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const r = db.prepare(
    "INSERT INTO pairings (code_hash, socket_secret_hash, kind, name, scopes, expires_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    sha256(code), sha256(socketSecret), args.kind, args.name, JSON.stringify(args.scopes ?? DEFAULT_SCOPES), expiresAt,
    args.origin ?? "admin",
  );
  return { pairingId: Number(r.lastInsertRowid), code, socketSecret, expiresAt };
}

export function redeemPairing(
  db: Db,
  code: string,
): { binding: Binding; accessToken: string } {
  return db.transaction(() => {
    const p = db.prepare(
      "SELECT * FROM pairings WHERE code_hash = ? AND status = 'pending'",
    ).get(sha256(code)) as any;
    if (!p) throw new Error("invalid or already redeemed pairing code");
    if (new Date(p.expires_at).getTime() < Date.now()) {
      db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ?").run(p.id);
      throw new Error("pairing code expired");
    }
    // 配对码兑换不知道对端是谁，按不是手机算。
    return redeemPendingPairing(db, p, pairedBindingOrigin(pairingOriginOf(p.origin), { via: "code", peerIsThisMachine: true }));
  })();
}

function pairingOriginOf(value: unknown): PairingOrigin | null {
  return value === "web_invitation" || value === "admin" ? value : null;
}

function redeemPendingPairing(
  db: Db,
  pairing: { id: number; kind: string; name: string; scopes: string },
  origin: BindingOrigin,
): { binding: Binding; accessToken: string } {
  const token = randomBytes(24).toString("base64url");
  const result = db.prepare(
    "INSERT INTO bindings (kind, display_name, token_hash, scopes, origin) VALUES (?, ?, ?, ?, ?)",
  ).run(pairing.kind, pairing.name, sha256(token), pairing.scopes, origin);
  const updated = db.prepare(
    "UPDATE pairings SET status = 'redeemed' WHERE id = ? AND status = 'pending'",
  ).run(pairing.id);
  if (updated.changes !== 1) throw new Error("invalid or already redeemed pairing code");
  const binding = db.prepare("SELECT * FROM bindings WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Binding;
  return { binding, accessToken: token };
}

export function getPendingPairingById(db: Db, id: number): PendingPairing | null {
  const row = db.prepare(
    "SELECT id, kind, name, code_hash, socket_secret_hash, scopes, status, expires_at, origin FROM pairings WHERE id = ? AND status = 'pending'",
  ).get(id) as {
    id: number; kind: "desktop" | "companion" | "cli"; name: string; code_hash: string; socket_secret_hash: string | null;
    scopes: string; status: "pending"; expires_at: string; origin: string | null;
  } | undefined;
  if (!row || !row.socket_secret_hash) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id);
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    codeHash: row.code_hash,
    socketSecretHash: row.socket_secret_hash,
    scopes: row.scopes,
    status: row.status,
    expiresAt: row.expires_at,
    origin: pairingOriginOf(row.origin),
  };
}

export interface PairingStatus {
  id: number;
  kind: "desktop" | "companion" | "cli";
  state: "pending" | "redeemed" | "expired" | "revoked";
  expiresAt: string;
}

// 一个配对现在的状态（本机网页轮询它，看手机扫码以后有没有兑换）。只读：不读哈希，也不改行。
// 过了期还没兑换的 pending 行按 expired 报。
export function getPairingStatus(db: Db, id: number): PairingStatus | null {
  const row = db.prepare("SELECT id, kind, status, expires_at FROM pairings WHERE id = ?").get(id) as {
    id: number; kind: PairingStatus["kind"]; status: PairingStatus["state"]; expires_at: string;
  } | undefined;
  if (!row) return null;
  const lapsed = row.status === "pending" && new Date(row.expires_at).getTime() < Date.now();
  return { id: row.id, kind: row.kind, state: lapsed ? "expired" : row.status, expiresAt: row.expires_at };
}

// 作废一个还没兑换的配对（本机网页关掉二维码、或者重新生成时）。只改 pending 的行：
// 兑换在同一个事务里用 UPDATE … AND status = 'pending' 认领这一行，两边只有一边能成功。
// 已经兑换、过期或作废的行不动，兑换出来的 binding 也不动。返回这次有没有作废。
export function cancelPendingPairing(db: Db, id: number): boolean {
  return db.prepare("UPDATE pairings SET status = 'revoked' WHERE id = ? AND status = 'pending'").run(id).changes === 1;
}

// socket 配对（扫码）。peerIsThisMachine：对端是不是这台机器（网关按对端地址判断）。缺省按是算：
// 只有本机网页的邀请被另一台设备兑换，才算扫码配对的手机。
export function redeemPairingById(
  db: Db,
  pairingId: number,
  redeem: { peerIsThisMachine?: boolean } = {},
): { binding: Binding; accessToken: string } {
  return db.transaction(() => {
    const pending = getPendingPairingById(db, pairingId);
    if (!pending) throw new Error("invalid or already redeemed pairing code");
    return redeemPendingPairing(db, pending, pairedBindingOrigin(pending.origin, {
      via: "socket", peerIsThisMachine: redeem.peerIsThisMachine ?? true,
    }));
  })();
}

export function createLoopbackBinding(
  db: Db,
  args: { name: string; scopes?: Scope[] },
): { binding: Binding; accessToken: string } {
  const token = randomBytes(24).toString("base64url");
  const result = db.prepare(
    "INSERT INTO bindings (kind, display_name, token_hash, scopes, origin) VALUES ('companion', ?, ?, ?, 'loopback_web')",
  ).run(args.name, sha256(token), JSON.stringify(args.scopes ?? LOOPBACK_AUTO_PAIR_SCOPES));
  const binding = db.prepare("SELECT * FROM bindings WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Binding;
  return { binding, accessToken: token };
}

// plc.sock 上的凭证交换（kind=cli，CLI_CREDENTIAL_SCOPES）。每次调用都签一个新的 binding；plc auth login 撤销旧的。
export function createCliBinding(
  db: Db,
  args: { name: string },
): { binding: Binding; accessToken: string } {
  const token = randomBytes(24).toString("base64url");
  const result = db.prepare(
    "INSERT INTO bindings (kind, display_name, token_hash, scopes, origin) VALUES ('cli', ?, ?, ?, 'cli')",
  ).run(args.name, sha256(token), JSON.stringify(CLI_CREDENTIAL_SCOPES));
  const binding = db.prepare("SELECT * FROM bindings WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Binding;
  return { binding, accessToken: token };
}

export function authenticateToken(db: Db, token: string): Binding | null {
  const hash = sha256(token);
  const r = db.prepare(
    "UPDATE bindings SET last_seen_at = datetime('now') WHERE token_hash = ? AND status = 'active'",
  ).run(hash);
  if (r.changes === 0) return null;
  return db.prepare("SELECT * FROM bindings WHERE token_hash = ?").get(hash) as Binding;
}

export function getBinding(db: Db, id: number): Binding | null {
  return (db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Binding | undefined) ?? null;
}

// 有效 scope：账本里存的 scope，去掉凭证的来历不允许的。用户的决定（approvals:respond）只给 protocol 的
// originMayDecide 允许的来历。认证、WebSocket 的事件和命令、/v1/paired/me 都用它，
// 所以账本里存着旧 scope 的凭证（例如以前签发的 plc 凭证）马上按新规则算，不用迁移。
export function bindingScopes(binding: Pick<Binding, "scopes" | "kind" | "origin">): Scope[] {
  let stored: Scope[];
  try {
    const parsed = JSON.parse(binding.scopes);
    if (!Array.isArray(parsed)) return [];
    stored = parsed.filter((scope): scope is Scope => ALL_SCOPES.includes(scope));
  } catch {
    return [];
  }
  return originMayDecide(bindingOriginOf(binding)) ? stored : stored.filter((scope) => scope !== "approvals:respond");
}

export function listBindings(db: Db): Binding[] {
  return db.prepare("SELECT * FROM bindings ORDER BY id").all() as Binding[];
}

export function revokeBinding(db: Db, id: number): void {
  db.prepare("UPDATE bindings SET status = 'revoked' WHERE id = ?").run(id);
}

// 外部通道里用户本人写给 Lead 的入口（用户 2026-10-30：Slack 里发给自己的私信「只要确认是我本人，就跟 companion 的权限保持一致」）。
// 一个来源的一个账号一张凭证（subject 例如 slack:U0123）：kind companion、DEFAULT_SCOPES，权限和 Companion 一样；
// origin channel_owner；没有令牌，网关认不了它，只有 daemon 凭通道的凭据认出用户本人以后用它开一轮。
// 设置里的设备列表看得到它，用户可以撤销。撤销以后不再自动恢复：返回 null，这个入口的话照旧只当用户本人在通道里说的话。
export function channelOwnerBinding(db: Db, args: { subject: string; name: string }): Binding | null {
  return db.transaction((): Binding | null => {
    const existing = db.prepare(
      "SELECT * FROM bindings WHERE kind = 'companion' AND origin = 'channel_owner' AND external_subject = ? ORDER BY id DESC LIMIT 1",
    ).get(args.subject) as Binding | undefined;
    if (existing?.status === "revoked") return null;
    if (existing) {
      db.prepare("UPDATE bindings SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
      return getBinding(db, existing.id);
    }
    const result = db.prepare(
      "INSERT INTO bindings (kind, display_name, external_subject, scopes, origin, last_seen_at) VALUES ('companion', ?, ?, ?, 'channel_owner', datetime('now'))",
    ).run(args.name, args.subject, JSON.stringify(DEFAULT_SCOPES));
    return getBinding(db, Number(result.lastInsertRowid));
  })();
}

export function upsertAishBinding(db: Db, botId: string, botName: string): void {
  const existing = db.prepare(
    "SELECT id FROM bindings WHERE kind = 'aish-slack' AND external_subject = ?",
  ).get(botId) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE bindings SET display_name = ?, last_seen_at = datetime('now'), status = 'active' WHERE id = ?")
      .run(botName, existing.id);
  } else {
    db.prepare(
      "INSERT INTO bindings (kind, display_name, external_subject, scopes, origin) VALUES ('aish-slack', ?, ?, ?, 'aish')",
    ).run(botName, botId, JSON.stringify(["chat", "notices", "approvals:respond"]));
  }
}

// 持久化 aish 连接凭证（url+token），供 daemon 重启/自愈拉起时自动重连。
// 一个 plc 实例只配一个 aish 上游：用固定 external_subject 占位，connected 后再由 upsert 补 bot 信息。
const AISH_CONN_SUBJECT = "aish:primary";
export function saveAishConn(db: Db, url: string, token: string): void {
  db.transaction(() => {
    const existing = db.prepare(
      "SELECT id FROM bindings WHERE kind = 'aish-slack' AND external_subject = ?",
    ).get(AISH_CONN_SUBJECT) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE bindings SET conn_url = ?, conn_secret = ?, status = 'active' WHERE id = ?")
        .run(url, token, existing.id);
    } else {
      db.prepare(
        "INSERT INTO bindings (kind, display_name, external_subject, scopes, conn_url, conn_secret, origin) VALUES ('aish-slack', 'aish upstream', ?, ?, ?, ?, 'aish')",
      ).run(AISH_CONN_SUBJECT, JSON.stringify(["chat", "notices", "approvals:respond"]), url, token);
    }
    // 换了 token，旧 token 的失败标记就没有用了。同一个 token 再存一次（env 里还是旧值）时保留标记。
    const failure = readAishAuthFailure(db);
    if (failure && failure.fingerprint !== sha256(token)) clearAishAuthFailure(db);
  })();
}
export function loadAishConn(db: Db): { url: string; token: string } | null {
  const r = db.prepare(
    "SELECT conn_url, conn_secret FROM bindings WHERE kind = 'aish-slack' AND external_subject = ? AND status = 'active'",
  ).get(AISH_CONN_SUBJECT) as { conn_url: string | null; conn_secret: string | null } | undefined;
  return r?.conn_url && r.conn_secret ? { url: r.conn_url, token: r.conn_secret } : null;
}

// aish 鉴权失败标记：上游对某个 token 回过 AUTH_FAILED，daemon 下次启动就不再拿它重连、也不再弹通知。
// 只存 token 的 SHA-256 指纹，不存 token 本身。换 token 后指纹对不上，标记自然失效。
const AISH_AUTH_FAILURE_KEY = "aish_auth_failure";
export interface AishAuthFailure { reason: string; at: string }

function readAishAuthFailure(db: Db): (AishAuthFailure & { fingerprint: string }) | null {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(AISH_AUTH_FAILURE_KEY) as { value: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}

function clearAishAuthFailure(db: Db): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(AISH_AUTH_FAILURE_KEY);
}

export function markAishAuthFailed(db: Db, token: string, reason: string): void {
  const value = JSON.stringify({ fingerprint: sha256(token), reason, at: new Date().toISOString() });
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(AISH_AUTH_FAILURE_KEY, value);
}

export function getAishAuthFailure(db: Db, token: string): AishAuthFailure | null {
  const failure = readAishAuthFailure(db);
  if (!failure || failure.fingerprint !== sha256(token)) return null;
  return { reason: failure.reason, at: failure.at };
}

// 给 plc aish status 用：只报有没有、连哪里、是否已判失败，从不带出 token。
export interface AishConnStatus { stored: boolean; url: string | null; failure: AishAuthFailure | null }
export function getAishConnStatus(db: Db): AishConnStatus {
  const conn = loadAishConn(db);
  if (!conn) return { stored: false, url: null, failure: null };
  return { stored: true, url: conn.url, failure: getAishAuthFailure(db, conn.token) };
}

// 删掉持久化的 aish 凭证（url 和 token 一起置空）和失败标记。行本身留着，saveAishConn 会复用它。
// 返回 false 表示本来就没有存凭证。
export function forgetAishConn(db: Db): boolean {
  return db.transaction(() => {
    const r = db.prepare(
      `UPDATE bindings SET conn_url = NULL, conn_secret = NULL, status = 'revoked'
       WHERE kind = 'aish-slack' AND external_subject = ? AND conn_secret IS NOT NULL`,
    ).run(AISH_CONN_SUBJECT);
    clearAishAuthFailure(db);
    return r.changes > 0;
  })();
}

// 通知回程目标（spec §C2）：daemon 重启后 child 完成通知不丢投递目标（连接恢复靠 conn 凭证，目标靠这里）
const LAST_ORIGIN_KEY = "last_aish_origin";
export interface AishOrigin { channelId: string; threadTs?: string }

export function saveLastAishOrigin(db: Db, origin: AishOrigin): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_ORIGIN_KEY, JSON.stringify(origin));
}

export function loadLastAishOrigin(db: Db): AishOrigin | null {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(LAST_ORIGIN_KEY) as { value: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.value) as AishOrigin; } catch { return null; }
}

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import {
  authenticateToken, bindingScopes, createCliBinding, createLoopbackBinding, createPairing, DEFAULT_SCOPES, forgetAishConn, getAishAuthFailure, getAishConnStatus,
  getOrCreateGatewayIdentity, getPendingPairingById, listBindings, loadAishConn, loadLastAishOrigin,
  markAishAuthFailed, redeemPairing, redeemPairingById, revokeBinding, saveAishConn, saveLastAishOrigin,
  upsertAishBinding,
} from "../src/gateway.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("pairing store", () => {
  it("persists the daemon socket identity and atomically redeems a pending pairing by id", () => {
    const firstIdentity = getOrCreateGatewayIdentity(db);
    const secondIdentity = getOrCreateGatewayIdentity(db);
    expect(firstIdentity).toEqual(secondIdentity);
    expect(firstIdentity.publicKey).toHaveLength(32);
    expect(firstIdentity.secretKey).toHaveLength(32);

    const { pairingId, socketSecret } = createPairing(db, { name: "Android phone", kind: "companion" });
    expect(socketSecret).toMatch(/^[0-9a-f]{48}$/);
    const pending = getPendingPairingById(db, pairingId);
    expect(pending).toMatchObject({
      id: pairingId,
      kind: "companion",
      name: "Android phone",
      status: "pending",
    });
    expect(pending?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending?.socketSecretHash).toMatch(/^[0-9a-f]{64}$/);

    const paired = redeemPairingById(db, pairingId);
    expect(paired.binding).toMatchObject({ kind: "companion", display_name: "Android phone" });
    expect(paired.accessToken).toBeTruthy();
    expect(() => redeemPairingById(db, pairingId)).toThrow(/invalid or already redeemed/);
  });

  it("full flow: code → redeem → token auth → revoke → 401", () => {
    const { code } = createPairing(db, { name: "iPhone", kind: "companion" });
    expect(code).toMatch(/^PLC-[A-Z2-9]{4}$/);
    const { binding, accessToken } = redeemPairing(db, code);
    expect(binding.kind).toBe("companion");
    expect(binding.token_hash).not.toBe(accessToken); // 只存哈希
    const authed = authenticateToken(db, accessToken)!;
    expect(authed.id).toBe(binding.id);
    expect(authed.last_seen_at).not.toBeNull();
    revokeBinding(db, binding.id);
    expect(authenticateToken(db, accessToken)).toBeNull();
  });

  it("rejects reuse and unknown codes", () => {
    const { code } = createPairing(db, { name: "d", kind: "desktop" });
    redeemPairing(db, code);
    expect(() => redeemPairing(db, code)).toThrow(/invalid or already redeemed/);
    expect(() => redeemPairing(db, "PLC-XXXX")).toThrow(/invalid/);
  });

  it("rejects expired codes", () => {
    const { code, pairingId } = createPairing(db, { name: "d", kind: "desktop" });
    // expires_at 在产品代码里永远是 toISOString() 的 ISO+Z 字符串（无歧义、任何时区都能正确解析）。
    // 这里造过期数据要用同样的格式——之前用 SQLite 的 datetime('now', ...)（无 "Z"、空格分隔）
    // 写回该列，redeemPairing 里 new Date(p.expires_at) 在非 UTC 主机时区下会被当成本地时间解析，
    // 与 SQLite 实际写入的 UTC 墙钟值对不上，是测试自己的时区假设 bug，不是产品逻辑的问题。
    db.prepare("UPDATE pairings SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), pairingId);
    expect(() => redeemPairing(db, code)).toThrow(/expired/);
  });

  it("rejects bad tokens", () => {
    expect(authenticateToken(db, "not-a-token")).toBeNull();
  });

  it("persists and restores aish connection credentials (auto-reconnect)", () => {
    expect(loadAishConn(db)).toBeNull();
    saveAishConn(db, "wss://aish.example.com/ws/agent", "bf_secret");
    expect(loadAishConn(db)).toEqual({ url: "wss://aish.example.com/ws/agent", token: "bf_secret" });
    // 覆盖更新（换 token）
    saveAishConn(db, "wss://aish.example.com/ws/agent", "bf_new");
    expect(loadAishConn(db)!.token).toBe("bf_new");
    // 不重复建行
    expect(listBindings(db).filter((b) => b.external_subject === "aish:primary").length).toBe(1);
  });

  it("remembers an auth failure per token fingerprint, without storing the token", () => {
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked");
    expect(getAishAuthFailure(db, "bf_revoked")).toBeNull();
    markAishAuthFailed(db, "bf_revoked", "AUTH_FAILED: Invalid token");
    expect(getAishAuthFailure(db, "bf_revoked")).toMatchObject({ reason: "AUTH_FAILED: Invalid token" });
    expect(getAishAuthFailure(db, "bf_other")).toBeNull();
    const raw = db.prepare("SELECT value FROM kv WHERE key = 'aish_auth_failure'").get() as { value: string };
    expect(raw.value).not.toContain("bf_revoked");

    // 再存同一个 token（例如 env 里还是旧值）：标记保留。
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked");
    expect(getAishAuthFailure(db, "bf_revoked")).not.toBeNull();
    // 存入新 token：标记清除，旧 token 也不再算失败。
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_fresh");
    expect(getAishAuthFailure(db, "bf_fresh")).toBeNull();
    expect(getAishAuthFailure(db, "bf_revoked")).toBeNull();
  });

  it("reports the stored aish credential status without the token", () => {
    expect(getAishConnStatus(db)).toEqual({ stored: false, url: null, failure: null });
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked");
    expect(getAishConnStatus(db)).toEqual({ stored: true, url: "wss://aish.example/ws/agent", failure: null });
    markAishAuthFailed(db, "bf_revoked", "AUTH_FAILED: Invalid token");
    const status = getAishConnStatus(db);
    expect(status).toMatchObject({ stored: true, failure: { reason: "AUTH_FAILED: Invalid token" } });
    expect(JSON.stringify(status)).not.toContain("bf_revoked");
  });

  it("forgets the stored aish credential and its failure mark", () => {
    expect(forgetAishConn(db)).toBe(false);
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_revoked");
    markAishAuthFailed(db, "bf_revoked", "AUTH_FAILED: Invalid token");
    expect(forgetAishConn(db)).toBe(true);
    expect(loadAishConn(db)).toBeNull();
    expect(getAishConnStatus(db)).toEqual({ stored: false, url: null, failure: null });
    const row = db.prepare("SELECT conn_url, conn_secret FROM bindings WHERE external_subject = 'aish:primary'").get();
    expect(row).toEqual({ conn_url: null, conn_secret: null });
    expect(forgetAishConn(db)).toBe(false);
    // 忘掉之后可以重新保存。
    saveAishConn(db, "wss://aish.example/ws/agent", "bf_fresh");
    expect(loadAishConn(db)).toEqual({ url: "wss://aish.example/ws/agent", token: "bf_fresh" });
  });

  it("upserts aish binding idempotently", () => {
    upsertAishBinding(db, "bot_1", "plc-lead");
    upsertAishBinding(db, "bot_1", "plc-lead-renamed");
    const rows = listBindings(db).filter((b) => b.kind === "aish-slack");
    expect(rows.length).toBe(1);
    expect(rows[0].display_name).toBe("plc-lead-renamed");
  });
});

describe("the admin scope", () => {
  it("is not granted by a pairing code or by loopback auto-pair", () => {
    const { code } = createPairing(db, { name: "phone", kind: "companion" });
    const paired = redeemPairing(db, code).binding;
    const loopback = createLoopbackBinding(db, { name: "localhost-web" }).binding;
    expect(DEFAULT_SCOPES).not.toContain("admin");
    expect(bindingScopes(paired)).not.toContain("admin");
    expect(bindingScopes(loopback)).toEqual(DEFAULT_SCOPES);
  });

  // plc 的凭证存在数据目录的文件里，同一个用户的任何进程（包括 child agent）都读得到。
  // 所以它不带 admin；管理命令每次在 plc.sock 上换一个不落盘的临时 admin token。
  it("is not granted to the stored plc credential either", () => {
    const { binding, accessToken } = createCliBinding(db, { name: "plc" });
    expect(binding.kind).toBe("cli");
    expect(bindingScopes(binding)).not.toContain("admin");
    expect(authenticateToken(db, accessToken)?.id).toBe(binding.id);
    // 只存 token 的哈希。
    expect(JSON.stringify(listBindings(db))).not.toContain(accessToken);
  });

  it("keeps the scopes of a binding created before the admin scope existed", () => {
    // 迁移前的 binding：scopes 列里只有缺省的 5 个。读出来不会多出 admin。
    db.prepare("INSERT INTO bindings (kind, display_name, token_hash, scopes) VALUES ('companion', 'old', 'h', ?)")
      .run(JSON.stringify(["chat", "tickets:view", "tickets:create", "approvals:respond", "notices"]));
    const old = listBindings(db).find((row) => row.display_name === "old")!;
    expect(bindingScopes(old)).toEqual(DEFAULT_SCOPES);
  });
});

// 用户的决定（approvals:respond，.scratch/child-self-approve/options.md 方案 A）：child 在这台机器上不伪造任何东西
// 就能拿到的凭证，有效 scope 里没有它。账本里存的 scope 不变，按凭证的来历算，所以以前签发的凭证马上按新规则算。
describe("the decision scope", () => {
  const WITHOUT_DECISIONS = ["chat", "tickets:view", "tickets:create", "notices"];

  it("is not issued to a new plc credential", () => {
    const { binding } = createCliBinding(db, { name: "plc" });
    expect(JSON.parse(binding.scopes)).toEqual(WITHOUT_DECISIONS);
    expect(bindingScopes(binding)).toEqual(WITHOUT_DECISIONS);
  });

  it("is dropped from every credential a child can mint on this machine, whatever the ledger stored", () => {
    db.prepare("INSERT INTO bindings (kind, display_name, token_hash, scopes) VALUES ('cli', 'legacy plc', 'h1', ?)")
      .run(JSON.stringify(DEFAULT_SCOPES));
    const legacy = listBindings(db).find((row) => row.display_name === "legacy plc")!;
    const coded = redeemPairing(db, createPairing(db, { name: "plc pair new", kind: "companion" }).code).binding;
    const invited = redeemPairingById(db,
      createPairing(db, { name: "local invitation", kind: "companion", origin: "web_invitation" }).pairingId,
      { peerIsThisMachine: true }).binding;
    for (const binding of [legacy, coded, invited]) {
      expect(JSON.parse(binding.scopes), binding.display_name).toContain("approvals:respond");
      expect(bindingScopes(binding), binding.display_name).toEqual(WITHOUT_DECISIONS);
    }
  });

  it("stays with the local web page, the scanned phone and credentials older than the origin column", () => {
    const page = createLoopbackBinding(db, { name: "localhost-web" }).binding;
    const phone = redeemPairingById(db,
      createPairing(db, { name: "iPhone", kind: "companion", origin: "web_invitation" }).pairingId,
      { peerIsThisMachine: false }).binding;
    db.prepare("INSERT INTO bindings (kind, display_name, token_hash, scopes) VALUES ('companion', 'old web', 'h2', ?)")
      .run(JSON.stringify(DEFAULT_SCOPES));
    const old = listBindings(db).find((row) => row.display_name === "old web")!;
    for (const binding of [page, phone, old]) expect(bindingScopes(binding), binding.display_name).toEqual(DEFAULT_SCOPES);
  });
});

describe("lastAishOrigin 持久化", () => {
  it("往返一致，daemon 重启后可恢复投递目标", () => {
    expect(loadLastAishOrigin(db)).toBeNull();
    saveLastAishOrigin(db, { channelId: "D09XXX", threadTs: "1721.001" });
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "D09XXX", threadTs: "1721.001" });
    saveLastAishOrigin(db, { channelId: "C08YYY" }); // 覆盖 + 可无 threadTs
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "C08YYY" });
  });
});

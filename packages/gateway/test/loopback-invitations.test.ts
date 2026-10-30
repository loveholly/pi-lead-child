// 本机网页给手机发扫码配对邀请（设置 → 设备 → 添加手机）。
// 检查和回环自动配对一样（回环 socket、允许的回环 Origin），另外要有效的凭证。它不放宽 /v1/admin/*，
// 邀请兑换后只有缺省的 scope，地址只能是网关给出的局域网地址，日志里没有邀请 URI 和配对码。
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  LoopbackInvitationSchema,
  LoopbackInvitationStatusSchema,
  PROTOCOL_VERSION,
  bytesToHex,
  createPairingKeyPair,
  derivePairingSessionKey,
  hashPairingSecret,
  openPairingPayload,
  parseSocketPairingUri,
  sealPairingPayload,
  type LoopbackInvitation,
} from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  DEFAULT_SCOPES, createPairing, getPendingPairingById, listBindings, openDb, revokeBinding, type Db,
} from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { isThisMachineAddress, lanIPv4Addresses, lanPairingEndpoints } from "../src/lan-endpoints.js";
import { encodeQrMatrix } from "../src/pairing-invitation.js";
import { startPairedServer } from "../src/paired-server.js";

const INVITATIONS = "/v1/paired/loopback/invitations";

let db: Db;
let webRoot: string;
let logs: string[];
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  const root = tempDir("plc-loopback-invite-");
  db = openDb(join(root, "plc.db"));
  webRoot = join(root, "web");
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<html>companion</html>");
  logs = [];
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

function iface(address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo {
  return family === "IPv4"
    ? { address, family, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` }
    : { address, family, internal, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", cidr: `${address}/64`, scopeid: 0 };
}

// 一台 Mac 常见的网卡：回环、Tailscale、Wi-Fi（带 IPv6）、一个没拿到 DHCP 的有线网卡。
const fakeInterfaces = () => ({
  lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
  utun4: [iface("100.101.102.103")],
  en0: [iface("fe80::1", "IPv6"), iface("192.168.1.20")],
  en5: [iface("169.254.10.10")],
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start(opts: {
  host?: string;
  allowLoopbackAutoPair?: boolean;
  loopbackAutoPairOrigins?: string[];
  web?: boolean;
  // 工单 15：模拟扫码的是局域网上的另一台设备。测试的连接都从 127.0.0.1 来。
  peerIsThisMachine?: () => boolean;
} = {}) {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: (line) => logs.push(line),
  }, {
    port: 0,
    host: opts.host ?? "0.0.0.0",
    allowLoopbackAutoPair: opts.allowLoopbackAutoPair ?? true,
    ...(opts.loopbackAutoPairOrigins ? { loopbackAutoPairOrigins: opts.loopbackAutoPairOrigins } : {}),
    ...(opts.web === false ? {} : { webRoot }),
    lanInterfaces: fakeInterfaces,
    ...(opts.peerIsThisMachine ? { peerIsThisMachine: opts.peerIsThisMachine } : {}),
  });
  servers.push(server);
  return { ...server, base: `http://127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}` };
}

type Started = Awaited<ReturnType<typeof start>>;

// 网页的凭证：和真实的网页一样，从回环自动配对拿。
async function webToken(server: Started): Promise<string> {
  const response = await fetch(`${server.base}/v1/paired/loopback`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ name: "localhost-web" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { access_token: string }).access_token;
}

function post(server: Started, path: string, init: { token?: string | null; origin?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const origin = init.origin === undefined ? server.origin : init.origin;
  if (origin !== null) headers.origin = origin;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return fetch(`${server.base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? {}),
  });
}

async function createInvitation(server: Started, token: string, body: unknown = { name: "手机" }) {
  const response = await post(server, INVITATIONS, { token, body });
  expect(response.status).toBe(201);
  const invitation = await response.json() as LoopbackInvitation;
  expect(Value.Check(LoopbackInvitationSchema, invitation)).toBe(true);
  return invitation;
}

// 手机扫码以后做的事：用邀请里的 pairing id 和 secret 走一遍加密握手，拿到凭证。
// 邀请里的地址是假的局域网地址，这里连回环上的同一个网关。
async function redeemOverSocket(server: Started, uri: string): Promise<{ binding: { scopes: string[] }; access_token: string }> {
  const invitation = parseSocketPairingUri(uri);
  const clientPair = createPairingKeyPair(new Uint8Array(32).fill(5));
  const sessionKey = derivePairingSessionKey(
    clientPair.secretKey, invitation.daemonPublicKey, hashPairingSecret(invitation.pairingSecret),
  );
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  try {
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({
      type: "pair.hello", protocolVersion: PROTOCOL_VERSION,
      pairingId: invitation.pairingId, clientPublicKey: bytesToHex(clientPair.publicKey),
    }));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    const challenge = openPairingPayload(messages[0].envelope, sessionKey) as { challenge: string };
    ws.send(JSON.stringify({
      type: "pair.confirm", protocolVersion: PROTOCOL_VERSION,
      envelope: sealPairingPayload({
        type: "pair.confirm", pairingId: invitation.pairingId, challenge: challenge.challenge,
      }, sessionKey, new Uint8Array(24).fill(9)),
    }));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(1));
    return openPairingPayload(messages[1].envelope, sessionKey) as { binding: { scopes: string[] }; access_token: string };
  } finally {
    ws.close();
  }
}

function realLanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return undefined;
}

describe("creating a phone pairing invitation from the local web UI", () => {
  it("returns a companion invitation, its QR matrix, and the gateway's LAN addresses", async () => {
    const server = await start();
    const token = await webToken(server);
    const invitation = await createInvitation(server, token, { name: "  我的手机  " });

    expect(invitation.endpoints).toEqual([
      `ws://192.168.1.20:${server.port}`,
      `ws://100.101.102.103:${server.port}`,
    ]);
    expect(invitation.endpoint).toBe(`ws://192.168.1.20:${server.port}`);
    expect(invitation.uri.startsWith("plc-pair://")).toBe(true);
    expect(parseSocketPairingUri(invitation.uri)).toMatchObject({
      endpoint: `ws://192.168.1.20:${server.port}/v1/paired/connect`,
      pairingId: invitation.pairingId,
    });
    expect(invitation.qr).toEqual(encodeQrMatrix(invitation.uri));
    expect(getPendingPairingById(db, invitation.pairingId)).toMatchObject({
      name: "我的手机", kind: "companion", scopes: JSON.stringify(DEFAULT_SCOPES),
    });
    expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("uses an endpoint the page picked from the list", async () => {
    const server = await start();
    const token = await webToken(server);
    const picked = `ws://100.101.102.103:${server.port}`;
    const invitation = await createInvitation(server, token, { name: "手机", endpoint: picked });
    expect(invitation.endpoint).toBe(picked);
    expect(parseSocketPairingUri(invitation.uri).endpoint).toBe(`${picked}/v1/paired/connect`);
  });

  it("refuses an endpoint that the gateway did not offer", async () => {
    const server = await start();
    const token = await webToken(server);
    for (const endpoint of [
      "ws://evil.example:47130",
      `ws://192.168.1.21:${server.port}`,
      `ws://192.168.1.20:${server.port + 1}`,
      `ws://169.254.10.10:${server.port}`,
      `ws://127.0.0.1:${server.port}`,
      `wss://192.168.1.20:${server.port}`,
      ` ws://192.168.1.20:${server.port}`,
    ]) {
      const response = await post(server, INVITATIONS, { token, body: { name: "手机", endpoint } });
      expect(response.status, endpoint).toBe(400);
    }
    expect(listPairingIds()).toEqual([]);
  });

  it("validates the device name and refuses any field beyond name and endpoint", async () => {
    const server = await start();
    const token = await webToken(server);
    for (const body of [
      {},
      { name: "" },
      { name: "   " },
      { name: "长".repeat(81) },
      { name: "手机\n[gateway] forged line" },
      { name: "手机\u0007" },
      { name: 42 },
      { name: "手机", scopes: ["admin"] },
      { name: "手机", kind: "cli" },
    ]) {
      const response = await post(server, INVITATIONS, { token, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(server, INVITATIONS, { token, body: { name: "长".repeat(80) } })).status).toBe(201);
  });

  it("says so when the gateway listens on loopback only", async () => {
    const server = await start({ host: "127.0.0.1" });
    const token = await webToken(server);
    const response = await post(server, INVITATIONS, { token, body: { name: "手机" } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("conflict");
    expect(listPairingIds()).toEqual([]);
  });
});

describe("who may create or read an invitation", () => {
  it("needs a valid bearer credential", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    const revoked = await webToken(server);
    revokeBinding(db, listBindings(db).at(-1)!.id);

    for (const candidate of [null, "not-a-token", revoked, server.issueAdminToken().accessToken]) {
      const create = await post(server, INVITATIONS, { token: candidate, body: { name: "手机" } });
      const status = await post(server, `${INVITATIONS}/${pairingId}/status`, { token: candidate });
      // 临时 admin token 只开 /v1/admin/*：这里是 403，别的是 401。
      const expected = candidate?.startsWith("adm_") ? 403 : 401;
      expect(create.status, String(candidate)).toBe(expected);
      expect(status.status, String(candidate)).toBe(expected);
    }
    expect(listPairingIds()).toEqual([pairingId]);
  });

  it("refuses requests without an allowed loopback Origin", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    for (const origin of [
      null,
      "http://localhost:8081",
      `http://127.0.0.1:${server.port + 1}`,
      `https://127.0.0.1:${server.port}`,
      `http://evil.example:${server.port}`,
      `http://192.168.1.20:${server.port}`,
    ]) {
      const create = await post(server, INVITATIONS, { token, origin, body: { name: "手机" } });
      const status = await post(server, `${INVITATIONS}/${pairingId}/status`, { token, origin });
      expect(create.status, String(origin)).toBe(403);
      expect(status.status, String(origin)).toBe(403);
    }
    expect(listPairingIds()).toEqual([pairingId]);
  });

  it("accepts an allowlisted loopback origin, such as the dev web server", async () => {
    const server = await start({ loopbackAutoPairOrigins: ["http://localhost:8081"] });
    const token = await webToken(server);
    const response = await post(server, INVITATIONS, { token, origin: "http://localhost:8081", body: { name: "手机" } });
    expect(response.status).toBe(201);
  });

  it("does not trust its own origin when it serves no web UI", async () => {
    const server = await start({ web: false, loopbackAutoPairOrigins: ["http://localhost:8081"] });
    const token = await webToken({ ...server, origin: "http://localhost:8081" });
    const response = await post(server, INVITATIONS, { token, body: { name: "手机" } });
    expect(response.status).toBe(403);
  });

  it("does not exist while loopback auto-pair is disabled", async () => {
    const server = await start({ allowLoopbackAutoPair: false });
    const { code } = createPairing(db, { name: "web", kind: "companion" });
    const redeem = await fetch(`${server.base}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
    });
    const { access_token: token } = await redeem.json() as { access_token: string };
    expect((await post(server, INVITATIONS, { token, body: { name: "手机" } })).status).toBe(404);
    expect((await post(server, `${INVITATIONS}/1/status`, { token })).status).toBe(404);
  });

  const lan = realLanAddress();
  it.skipIf(!lan)("refuses a non-loopback caller that sends the gateway's own origin", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    for (const path of [INVITATIONS, `${INVITATIONS}/${pairingId}/status`]) {
      const response = await fetch(`http://${lan}:${server.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.origin, authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "手机" }),
      });
      expect(response.status, path).toBe(403);
    }
    expect(listPairingIds()).toEqual([pairingId]);
  });

  it("does not open the admin routes to the web credential", async () => {
    const server = await start();
    const token = await webToken(server);
    for (const path of ["/v1/admin/pairings", "/v1/admin/bindings"]) {
      const response = await fetch(`${server.base}${path}`, {
        method: path.endsWith("pairings") ? "POST" : "GET",
        headers: { "content-type": "application/json", origin: server.origin, authorization: `Bearer ${token}` },
        ...(path.endsWith("pairings") ? { body: JSON.stringify({ name: "手机", kind: "companion" }) } : {}),
      });
      expect(response.status, path).toBe(403);
    }
  });
});

describe("redeeming the invitation and reading its status", () => {
  it("gives the phone only the default scopes, and reports the invitation as redeemed", async () => {
    // 手机在另一台设备上兑换。在这台机器上兑换的拿不到用户的决定（下一条测试）。
    const server = await start({ peerIsThisMachine: () => false });
    const token = await webToken(server);
    const invitation = await createInvitation(server, token);

    const pending = await post(server, `${INVITATIONS}/${invitation.pairingId}/status`, { token });
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(Value.Check(LoopbackInvitationStatusSchema, pendingBody)).toBe(true);
    expect(pendingBody).toEqual({ pairingId: invitation.pairingId, state: "pending", expiresAt: invitation.expiresAt });

    const accepted = await redeemOverSocket(server, invitation.uri);
    expect(accepted.binding.scopes).toEqual(DEFAULT_SCOPES);
    expect(accepted.binding.scopes).not.toContain("admin");
    const me = await fetch(`${server.base}/v1/paired/me`, { headers: { authorization: `Bearer ${accepted.access_token}` } });
    expect(((await me.json()) as { binding: { kind: string; name: string } }).binding).toMatchObject({ kind: "companion", name: "手机" });
    const adminList = await fetch(`${server.base}/v1/admin/bindings`, { headers: { authorization: `Bearer ${accepted.access_token}` } });
    expect(adminList.status).toBe(403);

    const redeemed = await post(server, `${INVITATIONS}/${invitation.pairingId}/status`, { token });
    expect(await redeemed.json()).toEqual({ pairingId: invitation.pairingId, state: "redeemed", expiresAt: invitation.expiresAt });
  });

  // 工单 15：只有本机网页的邀请被另一台设备兑换，才算扫码配对的手机（它做的主人操作只记录）。
  // child 能伪造回环网页要到邀请，但它在这台机器上兑换，就被认出来，不算手机。
  it("counts the redeemed binding as the scanned phone only when another device redeemed it", async () => {
    const local = await start();
    const localInvitation = await createInvitation(local, await webToken(local), { name: "本机兑换" });
    const locallyRedeemed = await redeemOverSocket(local, localInvitation.uri);
    expect(listBindings(db).find((binding) => binding.display_name === "本机兑换")?.origin).toBe("local_invitation");
    // child 不伪造任何东西就能做到这一步，所以它做不了用户的决定（.scratch/child-self-approve/options.md）。
    expect(locallyRedeemed.binding.scopes).toEqual(DEFAULT_SCOPES.filter((scope) => scope !== "approvals:respond"));

    const lan = await start({ peerIsThisMachine: () => false });
    const lanInvitation = await createInvitation(lan, await webToken(lan), { name: "手机" });
    await redeemOverSocket(lan, lanInvitation.uri);
    expect(listBindings(db).find((binding) => binding.display_name === "手机")?.origin).toBe("phone_qr");
    expect(listBindings(db).find((binding) => binding.display_name === "localhost-web")?.origin).toBe("loopback_web");
  });

  it("reports an invitation past its expiry as expired", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    const past = new Date(Date.now() - 1_000).toISOString();
    db.prepare("UPDATE pairings SET expires_at = ? WHERE id = ?").run(past, pairingId);
    const response = await post(server, `${INVITATIONS}/${pairingId}/status`, { token });
    expect(await response.json()).toEqual({ pairingId, state: "expired", expiresAt: past });
  });

  it("knows only companion invitations", async () => {
    const server = await start();
    const token = await webToken(server);
    const cli = createPairing(db, { name: "plc", kind: "cli" });
    for (const path of [`${INVITATIONS}/${cli.pairingId}/status`, `${INVITATIONS}/9999/status`, `${INVITATIONS}/99999999999999999999/status`]) {
      expect((await post(server, path, { token })).status, path).toBe(404);
    }
  });
});

describe("cancelling an invitation", () => {
  const cancel = (server: Started, pairingId: number, init: Parameters<typeof post>[2] = {}) =>
    post(server, `${INVITATIONS}/${pairingId}/cancel`, init);

  async function helloFails(server: Started, pairingId: number): Promise<string> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`);
    const messages: string[] = [];
    ws.on("message", (raw) => messages.push(String(raw)));
    try {
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({
        type: "pair.hello", protocolVersion: PROTOCOL_VERSION,
        pairingId, clientPublicKey: bytesToHex(createPairingKeyPair(new Uint8Array(32).fill(7)).publicKey),
      }));
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      return messages[0]!;
    } finally {
      ws.close();
    }
  }

  it("revokes a pending invitation, so the phone cannot redeem it over the pairing socket", async () => {
    const server = await start();
    const token = await webToken(server);
    const invitation = await createInvitation(server, token);

    const response = await cancel(server, invitation.pairingId, { token });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Value.Check(LoopbackInvitationStatusSchema, body)).toBe(true);
    expect(body).toEqual({ pairingId: invitation.pairingId, state: "revoked", expiresAt: invitation.expiresAt });
    expect(await (await post(server, `${INVITATIONS}/${invitation.pairingId}/status`, { token })).json())
      .toMatchObject({ state: "revoked" });

    expect(JSON.parse(await helloFails(server, invitation.pairingId))).toMatchObject({ error: { code: "invalid_pairing" } });
    expect(listBindings(db).filter((binding) => binding.display_name === "手机")).toEqual([]);
  });

  it("revokes a pending companion pairing code, so HTTP redemption fails too", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId, code } = createPairing(db, { name: "手机", kind: "companion" });
    expect((await cancel(server, pairingId, { token })).status).toBe(200);
    const redeem = await fetch(`${server.base}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
    });
    expect(redeem.status).toBe(400);
    expect(await redeem.text()).not.toContain(code);
  });

  it("leaves a redeemed invitation and its binding alone", async () => {
    const server = await start();
    const token = await webToken(server);
    const invitation = await createInvitation(server, token);
    const accepted = await redeemOverSocket(server, invitation.uri);

    const response = await cancel(server, invitation.pairingId, { token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "redeemed" });
    const phone = listBindings(db).find((binding) => binding.display_name === "手机")!;
    expect(phone.status).toBe("active");
    const me = await fetch(`${server.base}/v1/paired/me`, { headers: { authorization: `Bearer ${accepted.access_token}` } });
    expect(me.status).toBe(200);
  });

  it("is safe to repeat, and leaves an expired invitation as it is", async () => {
    const server = await start();
    const token = await webToken(server);
    const first = await createInvitation(server, token);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await cancel(server, first.pairingId, { token });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "revoked" });
    }
    expect(logs.filter((line) => line.includes(`#${first.pairingId} cancelled`))).toHaveLength(1);

    const second = await createInvitation(server, token);
    db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ?").run(second.pairingId);
    expect(await (await cancel(server, second.pairingId, { token })).json()).toMatchObject({ state: "expired" });
    expect((db.prepare("SELECT status FROM pairings WHERE id = ?").get(second.pairingId) as { status: string }).status)
      .toBe("expired");
  });

  it("refuses callers the other invitation routes refuse, and knows only companion invitations", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    for (const init of [
      { token: null },
      { token: "not-a-token" },
      { token, origin: null },
      { token, origin: "http://localhost:8081" },
      { token, origin: `http://evil.example:${server.port}` },
    ]) {
      const response = await cancel(server, pairingId, init);
      expect([401, 403], JSON.stringify(init)).toContain(response.status);
    }
    const cli = createPairing(db, { name: "plc", kind: "cli" });
    expect((await cancel(server, cli.pairingId, { token })).status).toBe(404);
    expect((await cancel(server, 9999, { token })).status).toBe(404);
    expect((db.prepare("SELECT status FROM pairings WHERE id = ?").get(cli.pairingId) as { status: string }).status)
      .toBe("pending");
    expect(await (await post(server, `${INVITATIONS}/${pairingId}/status`, { token })).json())
      .toMatchObject({ state: "pending" });

    const disabled = await start({ allowLoopbackAutoPair: false });
    expect((await cancel(disabled, pairingId, { token })).status).toBe(404);
  });

  const lan = realLanAddress();
  it.skipIf(!lan)("refuses a non-loopback caller", async () => {
    const server = await start();
    const token = await webToken(server);
    const { pairingId } = await createInvitation(server, token);
    const response = await fetch(`http://${lan}:${server.port}${INVITATIONS}/${pairingId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.origin, authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await (await post(server, `${INVITATIONS}/${pairingId}/status`, { token })).json())
      .toMatchObject({ state: "pending" });
  });
});

describe("the invitation is a credential", () => {
  it("never writes the invitation URI, its secret or a pairing code into the log", async () => {
    const server = await start();
    const token = await webToken(server);
    const invitation = await createInvitation(server, token);
    await post(server, `${INVITATIONS}/${invitation.pairingId}/status`, { token });
    await redeemOverSocket(server, invitation.uri);
    const cancelled = await createInvitation(server, token);
    await post(server, `${INVITATIONS}/${cancelled.pairingId}/cancel`, { token });

    const { pairingSecret } = parseSocketPairingUri(invitation.uri);
    const log = logs.join("\n");
    expect(log).toContain("pairing invitation created by the local web UI: 手机 (companion)");
    expect(log).toContain(`pairing invitation #${cancelled.pairingId} cancelled by the local web UI`);
    expect(log).not.toContain(cancelled.uri);
    expect(log).not.toContain(parseSocketPairingUri(cancelled.uri).pairingSecret);
    expect(log).not.toContain(invitation.uri);
    expect(log).not.toContain(pairingSecret);
    expect(log).not.toContain("plc-pair://");
    expect(log).not.toMatch(/PLC-[A-Z2-9]{4}/);
  });

  it("keeps the invitation out of every refusal, over HTTP and over the pairing socket", async () => {
    const server = await start();
    const token = await webToken(server);
    const invitation = await createInvitation(server, token);
    const { pairingId, pairingSecret } = parseSocketPairingUri(invitation.uri);
    await redeemOverSocket(server, invitation.uri);

    const refusals = [
      await post(server, INVITATIONS, { token, body: { name: "手机", endpoint: "ws://evil.example:47130" } }),
      await post(server, INVITATIONS, { token, body: { name: "" } }),
      await post(server, INVITATIONS, { token, body: { name: "手机", scopes: ["admin"] } }),
      await post(server, INVITATIONS, { token: null, body: { name: "手机" } }),
      await post(server, INVITATIONS, { token, origin: "http://evil.example", body: { name: "手机" } }),
      await post(server, `${INVITATIONS}/${pairingId}/status`, { token: null }),
      await post(server, `${INVITATIONS}/9999/status`, { token }),
      await post(server, `${INVITATIONS}/${pairingId}/cancel`, { token: null }),
      await post(server, `${INVITATIONS}/${pairingId}/cancel`, { token, origin: "http://evil.example" }),
      await post(server, `${INVITATIONS}/9999/cancel`, { token }),
    ];
    const texts: string[] = [];
    for (const response of refusals) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      texts.push(await response.text());
    }

    // 同一份邀请再兑换一次：pairing socket 回错误，错误里也没有邀请。
    const replay = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`);
    const replayed: string[] = [];
    replay.on("message", (raw) => replayed.push(String(raw)));
    try {
      await new Promise<void>((resolve) => replay.once("open", () => resolve()));
      replay.send(JSON.stringify({
        type: "pair.hello", protocolVersion: PROTOCOL_VERSION,
        pairingId, clientPublicKey: bytesToHex(createPairingKeyPair(new Uint8Array(32).fill(6)).publicKey),
      }));
      await vi.waitFor(() => expect(replayed.length).toBeGreaterThan(0));
    } finally {
      replay.close();
    }
    texts.push(...replayed);
    expect(replayed[0]).toContain("invalid_pairing");

    for (const text of texts) {
      expect(text).not.toContain("plc-pair://");
      expect(text).not.toContain(pairingSecret);
      expect(text).not.toMatch(/PLC-[A-Z2-9]{4}/);
    }
  });
});

describe("lanPairingEndpoints", () => {
  it("lists every LAN address for a wildcard listener, private ranges first", () => {
    expect(lanIPv4Addresses(fakeInterfaces)).toEqual(["192.168.1.20", "100.101.102.103"]);
    expect(lanPairingEndpoints([{ address: "0.0.0.0", port: 47130 }], fakeInterfaces))
      .toEqual(["ws://192.168.1.20:47130", "ws://100.101.102.103:47130"]);
    expect(lanPairingEndpoints([{ address: "::", port: 47130 }], fakeInterfaces))
      .toEqual(["ws://192.168.1.20:47130", "ws://100.101.102.103:47130"]);
  });

  it("lists only the address of a specific listener, and nothing for loopback", () => {
    expect(lanPairingEndpoints([
      { address: "127.0.0.1", port: 47130 },
      { address: "100.101.102.103", port: 47130 },
    ], fakeInterfaces)).toEqual(["ws://100.101.102.103:47130"]);
    expect(lanPairingEndpoints([{ address: "::ffff:192.168.1.20", port: 47130 }], fakeInterfaces))
      .toEqual(["ws://192.168.1.20:47130"]);
    expect(lanPairingEndpoints([{ address: "127.0.0.1", port: 47130 }, { address: "::1", port: 47130 }], fakeInterfaces))
      .toEqual([]);
    // 监听的地址已经不在网卡上（网卡断开）：手机连不上，不列出来。
    expect(lanPairingEndpoints([{ address: "10.0.0.9", port: 47130 }], fakeInterfaces)).toEqual([]);
  });
});

describe("isThisMachineAddress", () => {
  it("knows loopback, this connection's own address and every address on this machine's interfaces", () => {
    expect(isThisMachineAddress("127.0.0.1", "127.0.0.1", fakeInterfaces)).toBe(true);
    expect(isThisMachineAddress("::ffff:127.0.0.1", undefined, fakeInterfaces)).toBe(true);
    expect(isThisMachineAddress("::1", undefined, fakeInterfaces)).toBe(true);
    // 连本机的局域网地址：对端就是那个地址。
    expect(isThisMachineAddress("::ffff:192.168.1.20", "::ffff:192.168.1.20", fakeInterfaces)).toBe(true);
    // 绑在另一块本机网卡上发起连接。
    expect(isThisMachineAddress("100.101.102.103", "192.168.1.20", fakeInterfaces)).toBe(true);
    expect(isThisMachineAddress("fe80::1%en0", "192.168.1.20", fakeInterfaces)).toBe(true);
    // 局域网上的另一台设备。
    expect(isThisMachineAddress("192.168.1.31", "192.168.1.20", fakeInterfaces)).toBe(false);
    // 不知道对端是谁：按这台机器算（不当成手机）。
    expect(isThisMachineAddress(undefined, "192.168.1.20", fakeInterfaces)).toBe(true);
  });
});

describe("encodeQrMatrix", () => {
  it("returns a square matrix with the three finder patterns", () => {
    const matrix = encodeQrMatrix("plc-pair://connect?v=2");
    expect(matrix.rows).toHaveLength(matrix.size);
    for (const row of matrix.rows) expect(row).toHaveLength(matrix.size);
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    const end = matrix.size - 7;
    expect(matrix.rows.slice(0, 7).map((row) => row.slice(0, 7))).toEqual(finder);
    expect(matrix.rows.slice(0, 7).map((row) => row.slice(end))).toEqual(finder);
    expect(matrix.rows.slice(end).map((row) => row.slice(0, 7))).toEqual(finder);
  });
});

function listPairingIds(): number[] {
  return (db.prepare("SELECT id FROM pairings ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
}

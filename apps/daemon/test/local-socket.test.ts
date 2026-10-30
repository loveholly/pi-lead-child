// plc.sock 只做本机自举和运维：plc 在这里换一个 kind=cli 的网关凭证，supervisor 用它探活和停机。
// 权限是 0600，只有同一个系统用户能连。child 也是这个用户，所以签出的凭证不带 admin，也做不了用户的决定。
import { statSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AdminTokenResponseSchema, CliCredentialResponseSchema, DaemonLocalStatusSchema, type LocalSocketResponse,
} from "@pi-lead-child/protocol";
import { ControlPlaneClient } from "@pi-lead-child/client";
import { createItem, getItem, listBindings, openDb, type Db } from "@pi-lead-child/store";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

beforeEach(async () => {
  dir = tempDir("plc-local-socket-");
  daemon = await startDaemon({ dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, log: () => {} });
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

function request<T>(command: object): Promise<LocalSocketResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.sockPath);
    socket.once("error", reject);
    attachJsonlReader(socket, (line) => {
      const message = JSON.parse(line) as LocalSocketResponse<T>;
      if (message.type !== "response") return;
      socket.end();
      resolve(message);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

describe("plc.sock", () => {
  it("is readable and writable by the owner only", () => {
    expect(statSync(daemon!.sockPath).mode & 0o777).toBe(0o600);
  });

  it("reports the gateway URL in its status, so a client always knows where the gateway listens", async () => {
    const status = await request<{ gatewayUrl: string }>({ type: "status", id: "s" });
    expect(status.success).toBe(true);
    expect(Value.Check(DaemonLocalStatusSchema, status.data)).toBe(true);
    expect(status.data!.gatewayUrl).toBe(`http://127.0.0.1:${daemon!.pairedPort}`);
  });

  it("issues a kind=cli credential without the user's decisions that works on the gateway", async () => {
    const response = await request<{ accessToken: string; binding: { id: number; scopes: string[] }; gatewayUrl: string }>(
      { type: "cli_credential", id: "c", name: "plc" },
    );
    expect(response.success).toBe(true);
    expect(Value.Check(CliCredentialResponseSchema, response.data)).toBe(true);
    const { accessToken, binding, gatewayUrl } = response.data!;
    expect(binding).toMatchObject({ kind: "cli", name: "plc" });
    // 没有 approvals:respond：child 也连得上 plc.sock（child-self-approve-daemon.test.ts）。
    expect(binding.scopes).toEqual(["chat", "tickets:view", "tickets:create", "notices"]);
    const ledger = openDb(join(dir, "plc.db"));
    try {
      // 账本里只有 token 的哈希。
      expect(listBindings(ledger).find((row) => row.id === binding.id)?.token_hash).not.toBe(accessToken);
    } finally {
      ledger.close();
    }
    const me = await fetch(`${gatewayUrl}/v1/paired/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect((await me.json() as { binding: { id: number } }).binding.id).toBe(binding.id);
    const admin = await fetch(`${gatewayUrl}/v1/admin/bindings`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(admin.status).toBe(403);
  });

  it("issues a temporary admin token that is never written to the ledger", async () => {
    const before = openLedgerOnce().prepare("SELECT COUNT(*) AS n FROM bindings").get();
    const response = await request<{ accessToken: string; expiresAt: string; gatewayUrl: string }>({ type: "admin_token", id: "a" });
    expect(response.success).toBe(true);
    expect(Value.Check(AdminTokenResponseSchema, response.data)).toBe(true);
    const { accessToken, expiresAt, gatewayUrl } = response.data!;
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(openLedgerOnce().prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual(before);
    const listed = await fetch(`${gatewayUrl}/v1/admin/bindings`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(listed.status).toBe(200);
  });

  it("refuses the client commands that moved to the gateway", async () => {
    const itemId = createItem(openLedgerOnce(), { title: "t", brief: "b", createdBy: "lead", hold: true });
    for (const command of [
      { type: "chat", id: "c", message: "你好" },
      { type: "user_action", id: "a", target: "item", action: "confirm", target_id: itemId },
      { type: "lead_trust", id: "t", action: "grant", capability: "confirm_item" },
      { type: "runtime_recheck", id: "r" },
    ]) {
      const response = await request(command);
      expect(response, command.type).toMatchObject({ success: false, error: `unknown command: ${command.type}` });
    }
    // 事项没有被确认：plc.sock 上没有用户控制面。
    expect(getItem(openLedgerOnce(), itemId)?.stage).toBe("draft");
  });

  it("does not greet a connection or treat it as a listening client", async () => {
    const socket = connect(daemon!.sockPath);
    const received: string[] = [];
    socket.setEncoding("utf8").on("data", (chunk: string) => received.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const status = await request<{ clients: number }>({ type: "status" });
    socket.end();
    expect(received).toEqual([]);
    expect(status.data!.clients).toBe(0);
  });

  it("answers a ledger error during the credential exchange with an error, and keeps running", async () => {
    // 让签发 binding 的 INSERT 失败（模拟磁盘满之类的账本错误），不影响 daemon 的其他写入。
    openLedgerOnce().exec(
      "CREATE TRIGGER test_fail_bindings BEFORE INSERT ON bindings BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;",
    );
    const response = await request({ type: "cli_credential", id: "broken", name: "plc" });
    expect(response).toMatchObject({ type: "response", id: "broken", success: false });
    expect(response.error).toContain("disk full (test)");
    // daemon 还在。
    expect((await request<{ pid: number }>({ type: "status", id: "alive" })).data!.pid).toBe(process.pid);
  });

  it("answers an unknown or malformed command with an error, not silence", async () => {
    const unknown = await request({ type: "reboot", id: "u" });
    expect(unknown).toMatchObject({ type: "response", id: "u", success: false });
  });
});

let ledger: Db | null = null;
function openLedgerOnce(): Db {
  ledger ??= openDb(join(dir, "plc.db"));
  return ledger;
}
afterEach(() => { ledger?.close(); ledger = null; });

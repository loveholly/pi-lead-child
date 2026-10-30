import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { openDb, type Db } from "@pi-lead-child/store";
import { createApproval, getApproval } from "@pi-lead-child/store";
import { createPairing, redeemPairingById } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createGatewayPairingInvitation } from "@pi-lead-child/gateway";
import {
  ControlPlaneClient,
  type ConnectionState,
  type ControlPlaneSocket,
} from "@pi-lead-child/client";
import { createJsonCredentialStore, type KeyValueStorage } from "@pi-lead-child/client";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-companion-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(dbPath);
});

function sessionFactory() {
  const listeners: ((event: any) => void)[] = [];
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到，继续处理。" } });
          listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "收到，继续处理。" }] } });
        }
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

describe("Companion client against a real daemon", () => {
  it("redeems an encrypted socket invitation and uses the resulting control-plane credentials", async () => {
    const itemId = createItem(db, { title: "局域网配对", brief: "二维码联调", createdBy: "lead" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: sessionFactory() as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      gatewayPort: 0, log: () => {},
    });
    const invitation = createGatewayPairingInvitation(db, {
      endpoint: `ws://127.0.0.1:${daemon.pairedPort}`,
      name: "android-expo-go",
      kind: "companion",
    });
    const values = new Map<string, string>();
    const credentials = createJsonCredentialStore({
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { values.set(key, value); },
      async removeItem(key) { values.delete(key); },
    });
    const client = new ControlPlaneClient({
      credentials,
      createWebSocket: (url) => new WebSocket(url) as unknown as ControlPlaneSocket,
      randomBytes: async (length) => new Uint8Array(randomBytes(length)),
    });

    try {
      const paired = await client.pairSocket(invitation.uri);
      expect(paired).toMatchObject({
        baseUrl: `http://127.0.0.1:${daemon.pairedPort}`,
        binding: { name: "android-expo-go", kind: "companion" },
      });
      expect(await client.getTickets()).toEqual([
        expect.objectContaining({ id: itemId, title: "局域网配对" }),
      ]);
    } finally {
      client.disconnect();
      await daemon.close();
    }
  }, 15_000);

  it("pairs, snapshots, streams a ticket turn, and resolves an approval", async () => {
    const itemId = createItem(db, { title: "协议联调", brief: "端到端", createdBy: "lead" });
    const approvalId = createApproval(db, {
      itemId, requestedBy: "child", tool: "deploy", action: "发布控制面",
    });
    const { code } = createPairing(db, { name: "test-phone", kind: "companion" });
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: sessionFactory() as any,
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
      gatewayPort: 0, log: () => {},
    });
    const values = new Map<string, string>();
    const storage: KeyValueStorage = {
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { values.set(key, value); },
      async removeItem(key) { values.delete(key); },
    };
    const credentials = createJsonCredentialStore(storage);
    const states: ConnectionState[] = [];
    const events: any[] = [];
    const client = new ControlPlaneClient({
      credentials,
      createWebSocket: (url) => new WebSocket(url) as unknown as ControlPlaneSocket,
      createCommandId: () => "cmd-integration",
    });

    try {
      const paired = await client.pair(`http://127.0.0.1:${daemon.pairedPort}`, code);
      expect(paired.binding).toMatchObject({ name: "test-phone", scopes: expect.arrayContaining(["chat", "tickets:view"]) });
      // 配对码兑换的设备做不了用户的决定：child 用 plc.sock 的临时 admin token 也建得出配对码
      // （.scratch/child-self-approve/options.md）。客户端从网关拿到的 scope 和网关执行的一致。
      expect(paired.binding.scopes).not.toContain("approvals:respond");
      expect(await client.getTickets()).toEqual([expect.objectContaining({ id: itemId, title: "协议联调" })]);

      await client.connect({
        onStateChange: (state) => states.push(state),
        onEvent: (event) => events.push(event),
      });
      await vi.waitFor(() => expect(states).toContain("connected"));

      const sent = await client.sendChat("继续", itemId);
      expect(sent).toMatchObject({ mode: "started" });
      await vi.waitFor(() => expect(events.some((event) => event.type === "lead.message.completed" && event.turnId === sent.turnId)).toBe(true));
      // 这一轮工单对话的事件都带着工单号。（启动修复补的审批 blocker 会马上叫醒 Lead，工单 04：那是 Lead 自己的一轮，不算在这里。）
      const ticketTurnEvents = events.filter((event) => event.type.startsWith("lead.") && event.turnId === sent.turnId);
      expect(ticketTurnEvents.length).toBeGreaterThan(0);
      expect(ticketTurnEvents.every((event) => event.ticketId === itemId)).toBe(true);
      expect(await client.getConversationTurns(itemId)).toEqual([expect.objectContaining({
        ticketId: itemId, userText: "继续", assistantText: expect.stringContaining("done:"), state: "completed",
      })]);

      await expect(client.resolveApproval(approvalId, "approve")).rejects.toMatchObject({ status: 403 });
      expect(getApproval(db, approvalId)).toMatchObject({ status: "pending", resolved_by: null });

      // 扫码配对的手机（本机网页的邀请，被另一台设备兑换）能批。
      const { pairingId } = createPairing(db, { name: "scanned-phone", kind: "companion", origin: "web_invitation" });
      const scanned = redeemPairingById(db, pairingId, { peerIsThisMachine: false });
      const phoneStorage = new Map<string, string>();
      const phoneCredentials = createJsonCredentialStore({
        async getItem(key) { return phoneStorage.get(key) ?? null; },
        async setItem(key, value) { phoneStorage.set(key, value); },
        async removeItem(key) { phoneStorage.delete(key); },
      });
      await phoneCredentials.save({
        baseUrl: `http://127.0.0.1:${daemon.pairedPort}`, accessToken: scanned.accessToken, lastSeq: 0,
        binding: { id: scanned.binding.id, kind: "companion", name: "scanned-phone", scopes: ["chat", "tickets:view", "tickets:create", "approvals:respond", "notices"] },
      });
      const phone = new ControlPlaneClient({
        credentials: phoneCredentials,
        createWebSocket: (url) => new WebSocket(url) as unknown as ControlPlaneSocket,
      });
      await phone.resolveApproval(approvalId, "approve");
      expect(getApproval(db, approvalId)).toMatchObject({
        status: "approved",
        resolved_by: `user via paired binding:${scanned.binding.id}`,
      });
    } finally {
      client.disconnect();
      await daemon.close();
    }
  }, 15_000);
});

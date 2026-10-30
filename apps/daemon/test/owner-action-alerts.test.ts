// 高风险的主人操作走完落库的每一跳（工单 15 第一步）：
//   child 拿 plc.sock 换来的 CLI 凭证验收一张工单 → 网关记一条 owner_action.performed（interrupt）和一条推送用的通知 →
//   daemon 马上推送（会话里一张卡、桌面通知），不请 Lead 播报 → 用户在扫码配对的手机上点「不是我」 →
//   工单回到待验收（review），CLI 凭证作废，之后用它的请求都是 401。
// daemon、网关、store 都是真的；Lead 的会话是替身，只记下收到的输入。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { OWNER_ACTION_NOTIFICATION_KIND, ownerActionTurnId, SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import {
  createItem, createPairing, createRun, getBinding, getEvent, getItem, itemOwnerAction, listEvents, listNotifications, openDb,
  recordOwnerAction, redeemPairingById, transition, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { requestCliCredential } from "./plc-client.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-owner-action-daemon-");
  dbPath = join(dir, "plc.db");
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

function stubLead() {
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt(message: string) { prompts.push(message); },
      async steer(message: string) { prompts.push(message); },
      async followUp(message: string) { prompts.push(message); },
      dispose() {},
    },
  });
  return { factory, prompts };
}

describe("an owner action from the CLI credential, end to end", () => {
  it("pushes the acceptance, and 「不是我」 on the phone puts the ticket back in review and kills the credential", async () => {
    const lead = stubLead();
    const desktop: string[] = [];
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, gatewayPort: 0, log: () => {},
      notifyDesktop: (text) => { desktop.push(text); },
    });
    // child 和用户是同一个系统用户：它连得上 plc.sock，换一个 kind=cli 的凭证。
    const credential = await requestCliCredential(daemon.sockPath);
    const asChild = (method: "GET" | "POST", path: string) => fetch(`${credential.gatewayUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential.accessToken}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

    const id = createItem(db, { title: "登录页", brief: "b", createdBy: "user" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "start" });
    createRun(db, { itemId: id, role: "executor", purpose: "execution" });
    transition(db, { itemId: id, to: "review", actor: "system", reason: "delivered" });

    // 1. child 用 CLI 凭证验收：照常成功（第一步不收紧权限），网关记下这次操作。
    const accepted = await asChild("POST", `/v1/tickets/${id}/complete`);
    expect(accepted.status).toBe(200);
    expect(getItem(db, id)!.stage).toBe("done");
    const event = listEvents(db, { kind: "owner_action.performed" })[0]!;
    expect(event).toMatchObject({
      level: "interrupt", entityKey: `ticket:${id}`,
      payload: {
        action: "ticket.complete", summary: `验收了工单 #${id}「登录页」`, delivery: "push",
        credential: { bindingId: credential.binding.id, kind: "cli", origin: "cli" },
        source: { client: "cli", fromThisMachine: true },
      },
    });
    const notificationId = event.payload.notificationId as number;

    // 2. daemon 推送：通知记成系统直接送达，会话里一张主人操作卡，没人在看会话时弹桌面通知。不经过 Lead。
    await vi.waitFor(() => {
      const alert = listNotifications(db, { state: ["delivered"] }).find((row) => row.id === notificationId);
      expect(alert).toMatchObject({ kind: OWNER_ACTION_NOTIFICATION_KIND, delivered_via: "fallback" });
    }, { timeout: 5_000, interval: 20 });
    const card = db.prepare("SELECT origin_kind, state, assistant_text FROM channel_turns WHERE id = ?")
      .get(ownerActionTurnId(event.eventId, credential.binding.id)) as { origin_kind: string; state: string; assistant_text: string };
    expect(card).toMatchObject({ origin_kind: SYSTEM_TURN_ORIGINS.ownerAction, state: "completed" });
    expect(card.assistant_text).toContain(`验收了工单 #${id}「登录页」`);
    expect(card.assistant_text).toContain(`#${credential.binding.id}`);
    expect(card.assistant_text).toContain("不是我");
    expect(desktop).toContain(`验收了工单 #${id}「登录页」`);
    expect(getEvent(db, event.seq)!.disposition).toBe("told_user");
    expect(lead.prompts.some((prompt) => prompt.includes("验收了工单"))).toBe(false);

    // 3. 用户在扫码配对的手机上点「不是我」。
    const { pairingId } = createPairing(db, { name: "我的手机", kind: "companion", origin: "web_invitation" });
    const phone = redeemPairingById(db, pairingId, { peerIsThisMachine: false });
    const disowned = await fetch(`${credential.gatewayUrl}/v1/owner-actions/${event.eventId}/disown`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.accessToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(disowned.status).toBe(200);
    expect(((await disowned.json()) as any).ownerAction.disowned).toMatchObject({
      byName: "我的手机",
      revert: { status: "reverted" },
      credential: { bindingId: credential.binding.id, revoked: true },
    });

    // 4. 工单回到待验收。
    expect(getItem(db, id)!.stage).toBe("review");
    expect(listEvents(db, { kind: "stage.changed", entityKey: `ticket:${id}`, order: "desc", limit: 1 })[0]!.payload)
      .toMatchObject({ from: "done", to: "review", actor: "system" });

    // 5. 凭证作废：之后用它的请求都是 401，它也不能再验收。
    expect(getBinding(db, credential.binding.id)!.status).toBe("revoked");
    expect((await asChild("GET", "/v1/paired/me")).status).toBe(401);
    expect((await asChild("GET", `/v1/tickets/${id}`)).status).toBe(401);
    expect((await asChild("POST", `/v1/tickets/${id}/complete`)).status).toBe(401);
    expect(getItem(db, id)!.stage).toBe("review");

    // 账本：原事件由用户处理了，「不是我」的结果记一条，推送的通知已确认。手机的凭证照常可用。
    expect(getEvent(db, event.seq)!.disposition).toBe("handled");
    expect(listEvents(db, { kind: "owner_action.disowned" })).toEqual([
      expect.objectContaining({ causationId: event.eventId, level: "record" }),
    ]);
    expect(listNotifications(db, { state: ["acked"] }).map((row) => row.id)).toContain(notificationId);
    expect(getBinding(db, phone.binding.id)!.status).toBe("active");
  });
});

// 2026-10-27 画布「代你操作」状态 7：扫码配对的手机（从别的设备上）做的高风险操作只记录（record），不推送、没有「不是我」。
// 以前它只写进账本，会话里什么也没有；现在 daemon 在会话里贴一行记录。启动以前的记录不补贴（启动修复要有界）。
// 测试里的请求都来自本机（本机来的照样推送），所以这里用 store 记下一次来自别的设备的操作，账本以后的每一跳是真的。
describe("an owner action from the phone paired by QR code, end to end", () => {
  function phoneCompletes(phone: { binding: Parameters<typeof recordOwnerAction>[1]["credential"] }, title: string) {
    const id = createItem(db, { title, brief: "b", createdBy: "user" });
    const item = getItem(db, id)!;
    const input = itemOwnerAction(db, "complete", item, item.stage)!;
    const recorded = recordOwnerAction(db, {
      ...input, credential: phone.binding,
      source: { client: "phone", deviceName: "iPhone", loopback: false, fromThisMachine: false },
    });
    expect(recorded.delivery).toBe("record");
    return { id, eventId: recorded.event.eventId };
  }
  const startWith = async (desktop: string[] = []) => {
    const lead = stubLead();
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, gatewayPort: 0, log: () => {},
      notifyDesktop: (text) => { desktop.push(text); },
    });
    return lead;
  };
  const pairPhone = () => {
    const { pairingId } = createPairing(db, { name: "iPhone", kind: "companion", origin: "web_invitation" });
    return redeemPairingById(db, pairingId, { peerIsThisMachine: false });
  };

  it("puts one quiet line in the conversation, with no push and no 「不是我」", async () => {
    const phone = pairPhone();
    const desktop: string[] = [];
    const lead = await startWith(desktop);
    const { id, eventId } = phoneCompletes(phone, "登录页");
    const turnId = ownerActionTurnId(eventId, phone.binding.id);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT 1 FROM channel_turns WHERE id = ?").get(turnId)).toBeTruthy();
    }, { timeout: 5_000, interval: 20 });
    const line = db.prepare("SELECT origin_kind, state, assistant_text FROM channel_turns WHERE id = ?")
      .get(turnId) as { origin_kind: string; state: string; assistant_text: string };
    expect(line).toMatchObject({ origin_kind: SYSTEM_TURN_ORIGINS.ownerAction, state: "completed" });
    expect(line.assistant_text).toBe(`验收了工单 #${id}「登录页」\n在 iPhone 上做的（扫码配对的手机）。只记录，不推送。`);
    expect(line.assistant_text).not.toContain("不是我");
    // 不推送：没有通知、没有桌面通知，也不请 Lead 播报。贴一次，不重复。
    expect(listNotifications(db, {}).filter((row) => row.kind.startsWith("owner_action"))).toEqual([]);
    expect(desktop).toEqual([]);
    expect(lead.prompts.some((prompt) => prompt.includes("登录页"))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE id = ?").get(turnId) as { n: number }).n).toBe(1);
  });

  it("does not post records that were in the ledger before the daemon started", async () => {
    const phone = pairPhone();
    const { eventId } = phoneCompletes(phone, "启动以前");
    await startWith();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(db.prepare("SELECT 1 FROM channel_turns WHERE id = ?").get(ownerActionTurnId(eventId, phone.binding.id))).toBeUndefined();
  });
});

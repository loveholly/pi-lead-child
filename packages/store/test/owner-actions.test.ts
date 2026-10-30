// 主人操作的写库（工单 15 第一步）：凭证的来历、事件和推送用的通知、「不是我」的记录。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { OWNER_ACTION_NOTIFICATION_KIND, ownerActionNotificationDedupKey, type OwnerActionSource } from "@pi-lead-child/protocol";
import {
  appendEvent, createCliBinding, createLoopbackBinding, createPairing, getBinding, getEvent, getNotification, getOwnerAction,
  listInterruptEvents,
  listEvents, listNotifications, markNotificationDelivered, openDb, ownerActionView, recordOwnerAction,
  recordOwnerActionDisowned, redeemPairing, redeemPairingById, type Binding, type Db,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-owner-actions-"), "plc.db"));
});

const fromCli: OwnerActionSource = { client: "cli", deviceName: "plc", loopback: true, fromThisMachine: true };
const fromPhone: OwnerActionSource = { client: "phone", deviceName: "我的手机", loopback: false, fromThisMachine: false };

function phone(): Binding {
  const { pairingId } = createPairing(db, { name: "我的手机", kind: "companion", origin: "web_invitation" });
  return redeemPairingById(db, pairingId, { peerIsThisMachine: false }).binding;
}

function complete(credential: Binding, source: OwnerActionSource = fromCli) {
  return recordOwnerAction(db, {
    action: "ticket.complete",
    target: { key: "ticket:5", label: "工单 #5「登录页」", ticketId: 5 },
    summary: "验收了工单 #5「登录页」",
    detail: { from: "review", to: "done" },
    undo: { kind: "item", itemId: 5, from: "review", to: "done" },
    credential,
    source,
  });
}

// 工单 06 的打断横幅和工单 15 的主人操作合并后：主人操作是 interrupt 级，但它有自己的会话卡和「不是我」，
// 横幅不再放它（不然发起操作的那个网页又会弹一次）。
describe("the interrupt banner and owner actions", () => {
  it("leaves owner action alerts out of the banner's interrupt events", () => {
    const recorded = complete(createCliBinding(db, { name: "plc" }).binding);
    expect(getEvent(db, recorded.event.seq)?.level).toBe("interrupt");
    db.transaction(() => appendEvent(db, {
      source: "system", sourceRef: "banner-test", kind: "system.event_rejected", entityKey: "ticket:5", level: "interrupt",
      rootCause: { code: "test", scope: "attempt", needs: "user", next_step: "看一下", message: "测试" },
      payload: { error: "测试用的打断事件" },
    }))();
    const kinds = listInterruptEvents(db, { afterSeq: 0, limit: 50 }).map((event) => event.kind);
    expect(kinds).not.toContain("owner_action.performed");
    expect(kinds).toContain("system.event_rejected");
  });
});

describe("where a binding came from", () => {
  it("records the origin of every way a credential is issued", () => {
    expect(createCliBinding(db, { name: "plc" }).binding.origin).toBe("cli");
    expect(createLoopbackBinding(db, { name: "本机网页" }).binding.origin).toBe("loopback_web");
    expect(phone().origin).toBe("phone_qr");
    // 本机网页的邀请在这台机器上兑换：不是手机。
    const local = createPairing(db, { name: "伪装的手机", kind: "companion", origin: "web_invitation" });
    expect(redeemPairingById(db, local.pairingId, { peerIsThisMachine: true }).binding.origin).toBe("local_invitation");
    // 缺省按这台机器算。
    const unspecified = createPairing(db, { name: "x", kind: "companion", origin: "web_invitation" });
    expect(redeemPairingById(db, unspecified.pairingId).binding.origin).toBe("local_invitation");
    // 用配对码兑换本机网页的邀请：不是手机。
    const byCode = createPairing(db, { name: "y", kind: "companion", origin: "web_invitation" });
    expect(redeemPairing(db, byCode.code).binding.origin).toBe("local_invitation");
    // 临时 admin 建的配对（缺省的 origin）。
    const admin = createPairing(db, { name: "z", kind: "companion" });
    expect(redeemPairingById(db, admin.pairingId, { peerIsThisMachine: false }).binding.origin).toBe("admin_pairing");
  });
});

describe("recording an owner action", () => {
  it("pushes an action from the CLI credential: an immediate notification and an interrupt event that points at it", () => {
    const cli = createCliBinding(db, { name: "plc" }).binding;
    const recorded = complete(cli);
    expect(recorded.delivery).toBe("push");
    const notification = getNotification(db, recorded.notificationId!)!;
    expect(notification).toMatchObject({
      kind: OWNER_ACTION_NOTIFICATION_KIND, urgency: "immediate", item_id: null, state: "pending",
      title: "验收了工单 #5「登录页」", dedup_key: ownerActionNotificationDedupKey(recorded.event.eventId, cli.id),
    });
    expect(notification.body).toContain(`凭证：plc（plc 的 CLI 凭证，#${cli.id}）· CLI · 来自这台电脑`);
    expect(recorded.event).toMatchObject({
      source: "system", kind: "owner_action.performed", entityKey: "ticket:5", level: "interrupt",
      correlationId: `notification:${notification.id}`, disposition: null,
    });
    expect(recorded.event.payload).toMatchObject({
      action: "ticket.complete", label: "验收工单", delivery: "push", notificationId: notification.id,
      credential: { bindingId: cli.id, kind: "cli", name: "plc", origin: "cli" },
      source: fromCli,
      undo: { kind: "item", itemId: 5, from: "review", to: "done" },
    });
    // daemon 推送以后通知记成已送达，事件的处置随之是「告诉了用户」。
    markNotificationDelivered(db, notification.id, "fallback");
    expect(getEvent(db, recorded.event.seq)!.disposition).toBe("told_user");
  });

  it("only records an action from the scanned phone: no notification, a record-level event", () => {
    const recorded = complete(phone(), fromPhone);
    expect(recorded).toMatchObject({ delivery: "record", notificationId: null });
    expect(recorded.event.level).toBe("record");
    expect(recorded.event.correlationId).toBeNull();
    expect(listNotifications(db, { state: ["pending", "delivered", "acked"] })).toEqual([]);
  });

  it("pushes the phone's credential when it is used from this machine", () => {
    expect(complete(phone(), { ...fromPhone, fromThisMachine: true }).delivery).toBe("push");
  });

  it("refuses an action that is not in the table", () => {
    const cli = createCliBinding(db, { name: "plc" }).binding;
    expect(() => recordOwnerAction(db, {
      action: "ticket.create" as never, target: { key: "ticket:1", label: "x" }, summary: "x", credential: cli, source: fromCli,
    })).toThrow(/unknown owner action/);
    expect(listEvents(db, { kind: "owner_action.performed" })).toEqual([]);
  });
});

describe("「不是我」", () => {
  it("records the outcome once, marks the original handled and acks the alert", () => {
    const cli = createCliBinding(db, { name: "plc" }).binding;
    const caller = createLoopbackBinding(db, { name: "本机网页" }).binding;
    const recorded = complete(cli);
    const view = ownerActionView(db, recorded.event.eventId)!;
    expect(view).toMatchObject({
      eventId: recorded.event.eventId, action: "ticket.complete", delivery: "push", disownable: true, disowned: null,
      credential: { bindingId: cli.id, active: true }, undo: { possible: "conditional" },
    });

    const first = recordOwnerActionDisowned(db, {
      performed: recorded.event, by: caller,
      revert: { status: "reverted", message: "工单 #5 回到待验收（review）。" },
      credential: { bindingId: cli.id, revoked: true, message: "作废了凭证 plc。" },
    });
    expect(first.inserted).toBe(true);
    expect(first.event).toMatchObject({ kind: "owner_action.disowned", level: "record", causationId: recorded.event.eventId });
    expect(getEvent(db, recorded.event.seq)).toMatchObject({ disposition: "handled" });
    expect(getNotification(db, recorded.notificationId!)!.state).toBe("acked");

    const again = recordOwnerActionDisowned(db, {
      performed: recorded.event, by: caller,
      revert: { status: "not_revertible", message: "第二次" },
      credential: { bindingId: cli.id, revoked: true, message: "第二次" },
    });
    expect(again).toMatchObject({ inserted: false, event: { seq: first.event.seq } });
    expect(getOwnerAction(db, recorded.event.eventId)!.disowned!.seq).toBe(first.event.seq);
    expect(ownerActionView(db, recorded.event.eventId)).toMatchObject({
      disownable: false,
      disowned: {
        byName: "本机网页",
        revert: { status: "reverted", message: "工单 #5 回到待验收（review）。" },
        credential: { bindingId: cli.id, revoked: true },
      },
    });
  });

  it("says a recorded phone action is not disownable, and finds nothing for an event that is not an owner action", () => {
    const owner = phone();
    const recorded = complete(owner, fromPhone);
    expect(ownerActionView(db, recorded.event.eventId)).toMatchObject({
      delivery: "record", disownable: false, credential: { bindingId: owner.id, origin: "phone_qr", active: true },
    });
    expect(ownerActionView(db, "0199f1a2-3b4c-7d5e-8f60-718293a4b5c6")).toBeNull();
    const stageEvent = listEvents(db, { order: "desc", limit: 1 })[0]!;
    expect(stageEvent.kind).toBe("owner_action.performed");
    expect(getOwnerAction(db, stageEvent.eventId)).not.toBeNull();
    expect(getBinding(db, owner.id)?.status).toBe("active");
  });
});

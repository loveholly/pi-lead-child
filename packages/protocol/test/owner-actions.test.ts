// 高风险的主人操作（工单 15 第一步）：清单是一份代码里的表。这里核对它自己是完整的、和工单动作是一一对应的，
// 以及「只记录还是推送」「谁能点不是我」这几条规则。网关的每条路由真的会记事件，由 gateway/test/owner-actions-http.test.ts 核对。
import { describe, expect, it } from "vitest";

import {
  bindingOriginOf, canDisownOwnerAction, ITEM_ACTION_RISK, isOwnerActionEventId, listEventKinds,
  OWNER_ACTION_DISOWNED_KIND, OWNER_ACTION_IDS, OWNER_ACTION_NOTIFICATION_KIND, OWNER_ACTION_PERFORMED_KIND, OWNER_ACTIONS,
  ownerActionAlertText, ownerActionDefinition, ownerActionDelivery, ownerActionEventIdOfNotification, ownerActionEventIdOfTurn,
  ownerActionLevel, ownerActionNotificationDedupKey, ownerActionRefOfNotification, ownerActionRefOfTurn, ownerActionTurnId,
  originMayDecide, pairedBindingOrigin, USER_ITEM_ACTION_IDS,
  validateEventEnvelope, type BindingOrigin,
} from "../src/index.ts";

const EVENT_ID = "0199f1a2-3b4c-7d5e-8f60-718293a4b5c6";

describe("the owner action table", () => {
  it("has exactly one entry per owner action id, each with a scope, a route and an undo note", () => {
    expect(OWNER_ACTIONS.map((definition) => definition.id)).toEqual([...OWNER_ACTION_IDS]);
    for (const definition of OWNER_ACTIONS) {
      expect(["approvals:respond", "tickets:create"]).toContain(definition.scope);
      // 子 agent 经连接中心做的写操作没有路由（daemon 在连接中心报告写操作时记它），其余每个都有。
      if (definition.byAgent) expect(definition.routes).toEqual([]);
      else expect(definition.routes.length).toBeGreaterThan(0);
      for (const route of definition.routes) expect(route).toMatch(/^(POST|PUT|DELETE) \/v1\//);
      expect(definition.label).not.toBe("");
      expect(definition.undoNote).not.toBe("");
      expect(ownerActionDefinition(definition.id)).toBe(definition);
    }
    expect(ownerActionDefinition("ticket.create")).toBeUndefined();
  });

  it("covers the two groups the user decided on: approvals:respond decisions and tickets:create owner actions", () => {
    const byScope = (scope: string) => OWNER_ACTIONS.filter((definition) => definition.scope === scope).map((definition) => definition.id);
    expect(byScope("approvals:respond")).toEqual([
      "approval.resolve", "decision.resolve", "connection.confirm", "memory.switch_confirm", "standing_order.proposal_decide",
    ]);
    expect(byScope("tickets:create")).toEqual([
      "ticket.confirm", "ticket.complete", "ticket.stop", "ticket.cancel", "lead.trust", "lead.delegation",
      "connection.settings", "channel.credentials", "run.pause", "run.stop", "run.grant", "connection.agent_write",
      "workspace.release", "workspace.cleanup", "standing_order.rollback", "lead.profile", "ui.design", "channel.reply_style",
      "memory.preferences",
    ]);
    // 建工单、加里程碑这类低风险操作不在里面。
    const routes = OWNER_ACTIONS.flatMap((definition) => definition.routes);
    expect(routes).not.toContain("POST /v1/tickets");
    expect(routes.some((route) => route.includes("milestones"))).toBe(false);
  });

  it("classifies every ticket action, and only confirm, complete, stop and cancel are owner actions", () => {
    expect(Object.keys(ITEM_ACTION_RISK).sort()).toEqual([...USER_ITEM_ACTION_IDS].sort());
    const risky = USER_ITEM_ACTION_IDS.filter((id) => ITEM_ACTION_RISK[id].ownerAction !== null);
    expect(risky.sort()).toEqual(["cancel", "complete", "confirm", "stop"]);
    for (const id of USER_ITEM_ACTION_IDS) {
      const risk = ITEM_ACTION_RISK[id];
      expect(risk.reason).not.toBe("");
      if (risk.ownerAction) {
        expect(ownerActionDefinition(risk.ownerAction)?.routes).toEqual([`POST /v1/tickets/:id/${id}`]);
      }
    }
  });
});

describe("where a credential came from", () => {
  it("counts only a web invitation redeemed over the socket by another device as the scanned phone", () => {
    expect(pairedBindingOrigin("web_invitation", { via: "socket", peerIsThisMachine: false })).toBe("phone_qr");
    // child 伪造回环网页要到邀请，在这台机器上兑换：不是手机。
    expect(pairedBindingOrigin("web_invitation", { via: "socket", peerIsThisMachine: true })).toBe("local_invitation");
    expect(pairedBindingOrigin("web_invitation", { via: "code", peerIsThisMachine: false })).toBe("local_invitation");
    // 临时 admin token 建的配对，不管怎么兑换，都不是手机。
    expect(pairedBindingOrigin("admin", { via: "socket", peerIsThisMachine: false })).toBe("admin_pairing");
    expect(pairedBindingOrigin(null, { via: "socket", peerIsThisMachine: false })).toBe("admin_pairing");
  });

  it("infers the origin of a binding created before v47 from its kind", () => {
    expect(bindingOriginOf({ kind: "cli", origin: null })).toBe("cli");
    expect(bindingOriginOf({ kind: "aish-slack" })).toBe("aish");
    expect(bindingOriginOf({ kind: "companion", origin: null })).toBe("unknown");
    expect(bindingOriginOf({ kind: "companion", origin: "phone_qr" })).toBe("phone_qr");
    expect(bindingOriginOf({ kind: "companion", origin: "made-up" })).toBe("unknown");
  });
});

describe("record or push", () => {
  const origins: BindingOrigin[] = ["cli", "loopback_web", "phone_qr", "admin_pairing", "local_invitation", "aish", "unknown"];

  it("only records an action from the scanned phone, and pushes everything else", () => {
    for (const origin of origins) {
      expect(ownerActionDelivery(origin, { fromThisMachine: false })).toBe(origin === "phone_qr" ? "record" : "push");
    }
  });

  it("pushes the phone's own credential when it is used from this machine", () => {
    expect(ownerActionDelivery("phone_qr", { fromThisMachine: true })).toBe("push");
  });

  it("uses the interrupt level for a push and the record level otherwise", () => {
    expect(ownerActionLevel("push")).toBe("interrupt");
    expect(ownerActionLevel("record")).toBe("record");
  });
});

describe("who may say 「不是我」", () => {
  it("allows the phone and the web session, and refuses the CLI, Slack and what a child can mint on this machine", () => {
    expect(canDisownOwnerAction({ kind: "companion", origin: "phone_qr" })).toBe(true);
    expect(canDisownOwnerAction({ kind: "companion", origin: "loopback_web" })).toBe(true);
    expect(canDisownOwnerAction({ kind: "companion", origin: "unknown" })).toBe(true);
    expect(canDisownOwnerAction({ kind: "companion", origin: "admin_pairing" })).toBe(false);
    expect(canDisownOwnerAction({ kind: "companion", origin: "local_invitation" })).toBe(false);
    expect(canDisownOwnerAction({ kind: "cli", origin: "cli" })).toBe(false);
    expect(canDisownOwnerAction({ kind: "cli", origin: "admin_pairing" })).toBe(false);
    expect(canDisownOwnerAction({ kind: "aish-slack", origin: "aish" })).toBe(false);
  });
});

// child 以用户身份批准自己的审批（.scratch/child-self-approve/options.md 方案 A）。
describe("who may make the user's decisions", () => {
  it("refuses the credentials a child can mint on this machine without forging anything, and allows the rest", () => {
    const allowed: Record<BindingOrigin, boolean> = {
      cli: false, admin_pairing: false, local_invitation: false,
      loopback_web: true, phone_qr: true, aish: true, channel_owner: true, unknown: true,
    };
    for (const [origin, expected] of Object.entries(allowed)) expect(originMayDecide(origin as BindingOrigin), origin).toBe(expected);
  });
});

describe("the alert and the conversation card carry the event id", () => {
  it("round-trips the event id and the credential id through the notification and the turn id", () => {
    expect(isOwnerActionEventId(EVENT_ID)).toBe(true);
    expect(isOwnerActionEventId("../etc")).toBe(false);
    const dedupKey = ownerActionNotificationDedupKey(EVENT_ID, 12);
    expect(ownerActionRefOfNotification({ kind: OWNER_ACTION_NOTIFICATION_KIND, dedupKey })).toEqual({ eventId: EVENT_ID, bindingId: 12 });
    expect(ownerActionEventIdOfNotification({ kind: OWNER_ACTION_NOTIFICATION_KIND, dedupKey })).toBe(EVENT_ID);
    expect(ownerActionEventIdOfNotification({ kind: "lead_notice", dedupKey })).toBeNull();
    expect(ownerActionEventIdOfNotification({ kind: OWNER_ACTION_NOTIFICATION_KIND, dedupKey: "owner_action:nope" })).toBeNull();
    expect(ownerActionEventIdOfNotification({ kind: OWNER_ACTION_NOTIFICATION_KIND, dedupKey: `owner_action:${EVENT_ID}` })).toBeNull();
    expect(ownerActionRefOfTurn(ownerActionTurnId(EVENT_ID, 12))).toEqual({ eventId: EVENT_ID, bindingId: 12 });
    expect(ownerActionEventIdOfTurn(ownerActionTurnId(EVENT_ID, 0))).toBe(EVENT_ID);
    expect(ownerActionEventIdOfTurn("turn_outage_1")).toBeNull();
    expect(ownerActionEventIdOfTurn(null)).toBeNull();
  });

  it("says what was done, with which credential and from where, and what 「不是我」 does", () => {
    const text = ownerActionAlertText({
      summary: "验收了工单 #5「登录页」",
      credential: { bindingId: 12, name: "plc", origin: "cli" },
      source: { client: "cli", fromThisMachine: true },
    });
    expect(text.title).toBe("验收了工单 #5「登录页」");
    expect(text.body).toContain("凭证：plc（plc 的 CLI 凭证，#12）· CLI · 来自这台电脑");
    expect(text.body).toContain("不是我");
  });
});

describe("the owner action events", () => {
  it("registers both kinds and validates their payloads", () => {
    const kinds = listEventKinds().map((definition) => definition.kind);
    expect(kinds).toContain(OWNER_ACTION_PERFORMED_KIND);
    expect(kinds).toContain(OWNER_ACTION_DISOWNED_KIND);
    const performed = {
      source: "system" as const,
      kind: OWNER_ACTION_PERFORMED_KIND,
      entityKey: "ticket:5",
      payload: {
        action: "ticket.complete", label: "验收工单", summary: "验收了工单 #5",
        target: { key: "ticket:5", label: "工单 #5", ticketId: 5 },
        detail: { from: "review", to: "done" },
        credential: { bindingId: 12, kind: "cli", name: "plc", origin: "cli" },
        source: { client: "cli", deviceName: "plc", loopback: true, fromThisMachine: true },
        delivery: "push", notificationId: 3, undo: { kind: "item", itemId: 5, from: "review", to: "done" },
      },
    };
    expect(validateEventEnvelope(performed, "interrupt")).toEqual([]);
    expect(validateEventEnvelope({ ...performed, source: "user" as const }, "interrupt").join("\n")).toMatch(/source/);
    expect(validateEventEnvelope({ ...performed, payload: { ...performed.payload, delivery: "maybe" } }, "interrupt").join("\n"))
      .toMatch(/payload/);
  });
});

// 工单 03 审查 M5：Lead 在对话里代你做的操作。提醒给「撤销」（只撤销、不作废凭证），是另一种通知。
describe("an owner action Lead did for the user", () => {
  it("explains 「撤销」 and where to revoke the device, instead of 「不是我」", async () => {
    const { ownerActionAlertText } = await import("../src/owner-actions.ts");
    const text = ownerActionAlertText({
      summary: "Lead 代你确认了工单 #5「登录页」",
      credential: { bindingId: 30, name: "我的电脑", origin: "loopback_web" },
      source: { client: "lead", fromThisMachine: true },
    });
    expect(text.body).toContain("Paimon 在对话里代你做的");
    expect(text.body).toContain("点「撤销」：撤销这次操作，不作废凭证");
    expect(text.body).toContain("「设置 → 已配对设备」");
    expect(text.body).not.toContain("不是我");
  });

  it("words a sub-agent's write as done under the ticket's grant, with the link, and undoable without revoking anything", async () => {
    const { isOnBehalfOwnerActionSource, ownerActionAlertText } = await import("../src/owner-actions.ts");
    expect(isOnBehalfOwnerActionSource({ client: "agent" })).toBe(true);
    const text = ownerActionAlertText({
      summary: "Jarvis 派的子 agent 代你在 Acme/x#101 上提交了 review（COMMENT）",
      credential: { bindingId: 0, name: "工单 #12「slack 代码 review」", origin: "unknown" },
      source: { client: "agent", fromThisMachine: true },
      note: "链接：https://github.com/Acme/x/pull/101",
      leadName: "Jarvis",
    });
    expect(text.body).toContain("Jarvis 派的子 agent 按工单 #12「slack 代码 review」的权限清单做的。");
    expect(text.body).toContain("链接：https://github.com/Acme/x/pull/101");
    expect(text.body).toContain("点「撤销」");
    expect(text.body).not.toContain("不是我");
  });

  // 2026-10-22：称呼 Lead 用用户起的名字（设置 → 身份与风格），不写死 Lead 或 Paimon。
  it("calls Lead by the name the user gave it", async () => {
    const { ownerActionAlertText, ownerActionClientLabel, ownerActionDefinition, ownerActionText } = await import("../src/owner-actions.ts");
    const text = ownerActionAlertText({
      summary: "Jarvis 代你确认了工单 #5「登录页」",
      credential: { bindingId: 30, name: "我的电脑", origin: "loopback_web" },
      source: { client: "lead", fromThisMachine: true },
      leadName: "Jarvis",
    });
    expect(text.body).toContain("Jarvis 在对话里代你做的");
    expect(text.body).toContain("Jarvis 理解错了？");
    expect(text.body).not.toMatch(/Lead|Paimon/);
    expect(ownerActionClientLabel("lead", "Jarvis")).toBe("Jarvis 在对话里代你做");
    expect(ownerActionClientLabel("agent", "Jarvis")).toBe("Jarvis 派的子 agent 按权限清单做");
    expect(ownerActionText(ownerActionDefinition("lead.trust")!.label, "Jarvis")).toBe("改 Jarvis 的授权");
    expect(ownerActionText(ownerActionDefinition("lead.trust")!.label)).toBe("改 Paimon 的授权");
  });

  it("is a notification of its own kind that still names the event and the credential", async () => {
    const {
      isOnBehalfOwnerActionNotification, ownerActionNotificationDedupKey, ownerActionRefOfNotification,
    } = await import("../src/owner-actions.ts");
    const eventId = "0199f1a2-3b4c-7d5e-8f60-718293a4b5c6";
    const notice = { kind: "owner_action_on_behalf", dedupKey: ownerActionNotificationDedupKey(eventId, 30) };
    expect(ownerActionRefOfNotification(notice)).toEqual({ eventId, bindingId: 30 });
    expect(isOnBehalfOwnerActionNotification(notice)).toBe(true);
    expect(isOnBehalfOwnerActionNotification({ kind: "owner_action" })).toBe(false);
  });
});


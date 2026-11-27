// 哪些后台事件交给 shadow（shadow-routing.ts）：代码里的规则，不靠提示词。
import { describe, expect, it } from "vitest";
import type { EventRecord } from "@pi-lead-child/store";
import { holdForRunningShadow, shadowObjectKey, shadowRoute, shadowSourceOf, eventShadowFacts, splitForShadow } from "../src/shadow-routing.js";
import { shadowBucket } from "@pi-lead-child/protocol";
import { isReminderFireEvent } from "../src/lead-input.js";

let seq = 0;
function event(over: Partial<EventRecord> & { payload?: Record<string, unknown> }): EventRecord {
  seq += 1;
  return {
    seq, eventId: `e${seq}`, source: "system", sourceRef: null, kind: "inbox.blocker", entityKey: "ticket:7", entityVersion: null,
    occurredAt: "2026-11-19T03:00:00.000Z", receivedAt: "2026-11-19T03:00:00.000Z", causationId: null, correlationId: null,
    payload: {}, rootCause: null, level: "tell", disposition: null, dispositionDetail: null, disposedAt: null, triage: null,
    ...over,
  } as EventRecord;
}

type Shares = { channel: number; ticket: number; other: number };
const facts = (over: { mode?: "off" | "trial" | "on"; shares?: Partial<Shares>; escalated?: number[]; lead?: string[] } = {}) =>
  eventShadowFacts({
    settings: { mode: over.mode ?? "on", shares: { channel: 100, ticket: 100, other: 100, ...over.shares } },
    escalatedByShadow: (value) => (over.escalated ?? []).includes(value),
    isReminder: isReminderFireEvent,
    leadEntities: new Set(over.lead ?? []),
  });

describe("shadowSourceOf", () => {
  it("sorts events into channel, ticket and other", () => {
    expect(shadowSourceOf({ kind: "message.received", entityKey: "slack:C1:main" })).toBe("channel");
    expect(shadowSourceOf({ kind: "event.escalated", entityKey: "slack:C1" })).toBe("channel");
    expect(shadowSourceOf({ kind: "inbox.blocker", entityKey: "ticket:7" })).toBe("ticket");
    expect(shadowSourceOf({ kind: "run.failed", entityKey: "run:3" })).toBe("ticket");
    expect(shadowSourceOf({ kind: "inbox.attention", entityKey: "lead-job:job_1" })).toBe("other");
    expect(shadowSourceOf({ kind: "signal.received", entityKey: "signal:google" })).toBe("other");
    // 2026-11-20：清理扫描的「这个目录要不要删」（inbox.attention，对象 workspace-orphan:…）按外部对话分给了 shadow。
    // 不认识的前缀不是外部对话：只有消息事件和对话的升级算 channel。
    expect(shadowSourceOf({ kind: "inbox.attention", entityKey: "workspace-orphan:0123456789abcdef" })).toBe("other");
    expect(shadowSourceOf({ kind: "inbox.attention", entityKey: "slack:C1:main" })).toBe("other");
  });
});

describe("shadowRoute", () => {
  it("hands an ordinary background event to the shadow when it is on", () => {
    expect(shadowRoute(event({}), facts())).toEqual({ shadow: true, source: "ticket" });
    expect(shadowRoute(event({}), facts({ mode: "off" }))).toEqual({ shadow: false, why: "off" });
  });

  it("keeps to the main session what continues Lead's own work or needs the user", () => {
    const reminder = event({ kind: "timer.fired", entityKey: "reminder:3", level: "interrupt", payload: { timer: "reminder", itemId: 3 } });
    expect(shadowRoute(reminder, facts()).shadow).toBe(false);
    expect(shadowRoute(event({ kind: "timer.fired", entityKey: "inbox:9", payload: { setByUser: true } }), facts())).toEqual({ shadow: false, why: "user_follow_up" });
    expect(shadowRoute(event({ kind: "timer.fired", entityKey: "inbox:9", payload: {} }), facts())).toEqual({ shadow: false, why: "lead_follow_up" });
    expect(shadowRoute(event({ kind: "lead.wait_satisfied", entityKey: "connection:x" }), facts())).toEqual({ shadow: false, why: "lead_wait" });
    expect(shadowRoute(event({ level: "interrupt" }), facts())).toEqual({ shadow: false, why: "interrupt" });
    expect(shadowRoute(event({ payload: { mustTell: true } }), facts())).toEqual({ shadow: false, why: "must_tell" });
    const authorize = { kind: "authorize", target: "connection:x", title: "连接", reason: "r" };
    expect(shadowRoute(event({ kind: "inbox.attention", payload: { payload: { userAction: authorize } } }), facts())).toEqual({ shadow: false, why: "user_action" });
    expect(shadowRoute(event({ payload: { payload: { handoffLane: 0 } } }), facts())).toEqual({ shadow: false, why: "handoff_for_user" });
    expect(shadowRoute(event({ payload: { payload: { handoffLane: 3 } } }), facts()).shadow).toBe(true);
  });

  it("does not take back what it handed back, what Lead is on, or a source the settings leave out", () => {
    const handedBack = event({});
    expect(shadowRoute(handedBack, facts({ escalated: [handedBack.seq] }))).toEqual({ shadow: false, why: "shadow_escalated" });
    expect(shadowRoute(event({ entityKey: "ticket:7" }), facts({ lead: ["ticket:7"] }))).toEqual({ shadow: false, why: "lead_on_it" });
    expect(shadowRoute(event({}), facts({ shares: { ticket: 0 } }))).toEqual({ shadow: false, why: "share_off" });
    const orphan = event({ kind: "inbox.attention", entityKey: "workspace-orphan:abc", payload: { needsUser: true } });
    expect(shadowRoute(orphan, facts({ shares: { channel: 50, other: 0 } }))).toEqual({ shadow: false, why: "share_off" });
  });

  it("splits a source by object: one conversation or ticket always lands on the same side, and a larger share only adds", () => {
    const keys = Array.from({ length: 400 }, (_, index) => `slack:C${index}:main`);
    const onShadow = (share: number) => keys.filter((key) => shadowRoute(
      event({ kind: "message.received", entityKey: key }), facts({ shares: { channel: share } }),
    ).shadow);
    const half = onShadow(50);
    expect(half.length).toBeGreaterThan(150);
    expect(half.length).toBeLessThan(250);
    expect(onShadow(50)).toEqual(half);
    const more = new Set(onShadow(80));
    expect(half.every((key) => more.has(key))).toBe(true);
    expect(onShadow(0)).toEqual([]);
    expect(onShadow(100)).toHaveLength(400);
    // Run 的事件跟着它的工单走。
    expect(shadowObjectKey(event({ kind: "run.failed", entityKey: "run:3", payload: { itemId: 7 } }))).toBe("ticket:7");
    expect(shadowBucket("ticket:7")).toBe(shadowBucket("ticket:7"));
  });

  it("splits a batch and keeps the order", () => {
    const a = event({});
    const b = event({ level: "interrupt" });
    const c = event({ kind: "message.received", entityKey: "slack:C1:main" });
    expect(splitForShadow([a, b, c], facts())).toEqual({ shadow: [a, c], lead: [b] });
  });
});

// 工单 #584：11-27 同一个私信里，对方先发截图、再发一句话，两条消息分到两批 shadow；65 对相邻消息的后一批在前一批结束前就开始了。
describe("holdForRunningShadow", () => {
  it("holds new events on an object that a running batch is handling, and lets other objects through", () => {
    const words = event({ kind: "message.received", entityKey: "slack:D0ETHAN:main" });
    const other = event({ kind: "message.received", entityKey: "slack:D0NINA:main" });
    const ticket = event({ entityKey: "run:9", payload: { itemId: 7 } });
    expect(holdForRunningShadow([words, other, ticket], new Set(["slack:D0ETHAN:main", "ticket:7"]))).toEqual([other]);
    expect(holdForRunningShadow([words, other], new Set())).toEqual([words, other]);
  });
});

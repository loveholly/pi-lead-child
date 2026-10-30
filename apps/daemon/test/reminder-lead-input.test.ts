// 到点的提醒交给 Lead 的决策边界（工单 07，spec D11）：纯函数，不起 daemon。
import { describe, expect, it } from "vitest";
import { SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import { busyPlacement, isReminderFireEvent, leadEventRoute, reminderStillForLead } from "../src/lead-input.js";

const fire = { kind: "timer.fired", entityKey: "reminder:83", payload: { timer: "reminder", itemId: 83 }, level: "interrupt", source: "timer" } as const;
const noCheck = { ticketId: null, check: null };

describe("a reminder that fired, on its way to Lead", () => {
  it("is a reminder firing only for timer.fired with timer=reminder", () => {
    expect(isReminderFireEvent(fire)).toBe(true);
    expect(isReminderFireEvent({ ...fire, payload: { timer: "lead_followup" } })).toBe(false);
    expect(isReminderFireEvent({ ...fire, kind: "reminder.pushed" })).toBe(false);
    // tell 和 interrupt 级都作为一条消息交给 Lead。
    expect(leadEventRoute(fire)).toBe("message");
    expect(leadEventRoute({ ...fire, level: "tell" })).toBe("message");
    expect(leadEventRoute({ kind: "lead.turn_responding", level: "record" })).toBe("skip");
  });

  it("goes to Lead while the user has not dealt with it, or when there is something for Lead to check", () => {
    expect(reminderStillForLead({ state: "fired", policy: noCheck })).toBe(true);
    for (const state of ["acked", "snoozed", "cancelled"]) {
      expect(reminderStillForLead({ state, policy: noCheck })).toBe(false);
      expect(reminderStillForLead({ state, policy: { ticketId: 12, check: null } })).toBe(true);
      expect(reminderStillForLead({ state, policy: { ticketId: null, check: "PR86 合并了没有" } })).toBe(true);
    }
  });

  it("steers into a busy turn when it is interrupt level, but not into another reminder's own turn", () => {
    expect(busyPlacement(fire, { origin: null })).toBe("steer");
    expect(busyPlacement(fire, { origin: SYSTEM_TURN_ORIGINS.blocker })).toBe("steer");
    expect(busyPlacement({ ...fire, level: "tell" }, { origin: null })).toBe("queue");
    expect(busyPlacement(fire, { origin: SYSTEM_TURN_ORIGINS.reminder })).toBe("queue");
    expect(busyPlacement(fire, { origin: SYSTEM_TURN_ORIGINS.precipitate })).toBe("queue");
  });
});

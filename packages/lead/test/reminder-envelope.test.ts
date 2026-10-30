// 到点的提醒交给 Lead 时的文字（工单 07，spec D11）：卡片的状态（已推送、是否已确认、关联的工单）和处理规则。
import { describe, expect, it } from "vitest";
import { leadReminderEventBlock, type LeadReminderCardState } from "../src/envelope.js";

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);
const card = (overrides: Partial<LeadReminderCardState> = {}): LeadReminderCardState => ({
  reminderId: 83, title: "抢票", remindAt: "2026-10-18T01:00:00.000Z", level: "interrupt", state: "fired",
  closedAt: null, closedBy: null, nextAt: null,
  pushes: { count: 2, planned: 6, lastAt: "2026-10-18T01:02:00.000Z", nextAt: "2026-10-18T01:04:00.000Z", exhausted: false, earlyAt: "2026-10-18T00:55:00.000Z" },
  ticket: null, check: null, ...overrides,
});
const event = { seq: 412, source: "timer", level: "interrupt" };

describe("the reminder Lead receives", () => {
  it("says what the card shows and how to handle it, in its own turn", () => {
    const text = leadReminderEventBlock(event, card(), { placement: "dedicated", clock });
    expect(text).toMatch(/^<system_event kind="event" source="daemon" level="interrupt" origin="timer" topic="reminder">/);
    for (const part of [
      "事件 #412：提醒 #83「抢票」到点，提醒时刻 01:00（重要，interrupt）",
      "系统已经推了 2 次（最近一次 01:02）；没确认时 01:04 再推，这次到点一共推 6 次；00:55 提前推过一次",
      "确认：用户还没确认",
      "不要用 notify_user 再推一遍",
      "用户已确认：一般不说话（回复 NO_REPLY）",
      "没确认：补一句有用的话，不要重复提醒的内容",
      "关联了要查的事：先查，再把结果写到卡上",
      "你说的话会显示在这张提醒卡下面",
    ]) expect(text).toContain(part);
  });

  it("tells Lead to write to the card instead of answering when it was steered into another turn", () => {
    const text = leadReminderEventBlock(event, card(), { placement: "steered", clock });
    expect(text).toContain("插进了你正在做的那一轮。不要在那一轮的回答里说它");
    expect(text).toContain("record_disposition（event_ids 填 412");
    expect(text).not.toContain("显示在这张提醒卡下面");
  });

  it("says the user confirmed it, and lists the linked ticket and what to check", () => {
    const text = leadReminderEventBlock(event, card({
      state: "acked", closedAt: "2026-10-18T01:01:00.000Z", closedBy: "user",
      ticket: { id: 12, title: "买票", stage: "active" }, check: "余票还有没有",
    }), { placement: "dedicated", clock });
    expect(text).toContain("确认：用户 01:01 确认了");
    expect(text).toContain("关联的工单：#12「买票」（现在 active）");
    expect(text).toContain("到点要先查：余票还有没有");
  });
});

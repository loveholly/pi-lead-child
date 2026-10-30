// Lead 建提醒、改提醒（工单 07，spec D11）：级别、提前提醒、没确认时的重复推送、关联的工单都存进提醒；
// 提示词写明有时效的事定为 interrupt、拿不准时问用户，到点时不再推一遍、不重复提醒的内容。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createLoopbackBinding, createTurn, fireReminder, getItem, leadReminderOverridesOfUser, listEvents, openDb,
  reminderPolicyOf, transition, type Db,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadSkillText } from "./lead-skill-text.js";

let db: Db;
let deps: LeadDeps;
const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;

beforeEach(() => {
  const dir = tempDir("plc-reminder-tools-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
});

describe("create_reminder", () => {
  it("stores the level, the early push and the repeat that Lead set", async () => {
    const result = await tool("create_reminder").execute("t", {
      title: "抢票", remind_at: "2026-10-18T09:00:00+08:00", level: "interrupt",
      early_minutes: 5, repeat_every_minutes: 2, repeat_max: 5,
    });
    const id = Number(/#(\d+)/.exec(result.content[0].text)![1]);
    expect(reminderPolicyOf(getItem(db, id)!)).toEqual({
      level: "interrupt", earlyMs: 5 * 60_000, repeat: { everyMs: 2 * 60_000, max: 5 }, ticketId: null, check: null,
    });
    expect(result.content[0].text).toContain("重要（interrupt）");
    expect(result.content[0].text).toContain("提前 5 分钟");
  });

  it("defaults to tell with no early push and no repeat, links a ticket, and refuses half a repeat", async () => {
    const task = createItem(db, { title: "aish PR86", brief: "b", createdBy: "user" });
    const result = await tool("create_reminder").execute("t", {
      title: "看 PR86 合并了没有", remind_at: "2026-10-18T09:00:00+08:00", ticket_id: task, check: "PR86 合并了没有",
    });
    const id = Number(/#(\d+)/.exec(result.content[0].text)![1]);
    expect(reminderPolicyOf(getItem(db, id)!)).toEqual({ level: "tell", earlyMs: null, repeat: null, ticketId: task, check: "PR86 合并了没有" });
    await expect(tool("create_reminder").execute("t", { title: "x", remind_at: "2026-10-18T09:00:00+08:00", repeat_every_minutes: 2 }))
      .rejects.toThrow(/go together/);
    await expect(tool("create_reminder").execute("t", { title: "x", remind_at: "2026-10-18T09:00:00+08:00", ticket_id: 999 }))
      .rejects.toThrow(/not found/);
  });

  it("has the new parameters in its schema and says to ask the user when unsure", () => {
    const definition = tool("create_reminder");
    expect(Object.keys(definition.parameters.properties)).toEqual(expect.arrayContaining([
      "level", "early_minutes", "repeat_every_minutes", "repeat_max", "ticket_id", "check",
    ]));
    expect(definition.description).toContain("interrupt");
    expect(definition.description).toContain("拿不准时先问用户");
  });
});

describe("reschedule_reminder", () => {
  it("re-arms a reminder that already fired, and refuses one the user confirmed", async () => {
    const id = createItem(db, { kind: "reminder", title: "抢票", brief: "", createdBy: "lead", remindAt: new Date(Date.now() - 1_000).toISOString() });
    fireReminder(db, getItem(db, id)!, new Date(), { push: true });
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    await tool("reschedule_reminder").execute("t", { ticket_id: id, remind_at: later, reason: "用户说晚点" });
    expect(getItem(db, id)).toMatchObject({ stage: "scheduled", remind_at: later });
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${id}`, order: "desc", limit: 1 })[0]!.payload)
      .toMatchObject({ from: "fired", to: "scheduled", requestedBy: "lead" });
    fireReminder(db, getItem(db, id)!, new Date(), { push: true });
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "acked by user" });
    await expect(tool("reschedule_reminder").execute("t", { ticket_id: id, remind_at: later, reason: "用户说晚点" })).rejects.toThrow(/已确认/);
    // 任务没有 remind_at：错误说清楚该用什么。
    const task = createItem(db, { title: "任务", brief: "b", createdBy: "user" });
    await expect(tool("reschedule_reminder").execute("t", { ticket_id: task, remind_at: later, reason: "用户说晚点" })).rejects.toThrow(/create_reminder/);
  });
});

// 提醒卡上的「知道了」和 ack_reminder 是同一个操作（ui-action-parity P03）。Lead 在哪一轮都能确认（用户 2026-10-27）：
// 被事件叫醒的一轮记成 Lead 自己确认的，用户这一轮里的记成代用户确认。
describe("ack_reminder", () => {
  it("acks as Lead in a turn Lead was woken for, and for the user in the user's own turn", async () => {
    const own = createItem(db, { kind: "reminder", title: "喝水", brief: "", createdBy: "lead", remindAt: new Date(Date.now() - 60_000).toISOString() });
    fireReminder(db, getItem(db, own)!, new Date(Date.now() - 30_000), { push: true });
    const woken = await tool("ack_reminder").execute("t", { ticket_id: own, reason: "这条是我给自己设的，已经处理了" });
    expect(JSON.parse(woken.content[0].text)).toMatchObject({ authority: "lead" });
    expect(woken.isError).toBeUndefined();
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${own}`, order: "desc", limit: 1 })[0]!.payload)
      .toMatchObject({ from: "fired", to: "acked", actor: "lead" });

    const id = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "user", remindAt: new Date(Date.now() - 60_000).toISOString() });
    fireReminder(db, getItem(db, id)!, new Date(Date.now() - 30_000), { push: true });

    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "交了", state: "streaming" });
    deps.currentTurnId = () => "turn-user";
    const acked = await tool("ack_reminder").execute("t", { ticket_id: id, reason: "用户说交了" });
    expect(JSON.parse(acked.content[0].text)).toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-user" });
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${id}`, order: "desc", limit: 1 })[0]!.payload)
      .toMatchObject({ from: "fired", to: "acked", actor: "lead", onBehalfOf: "user", sourceTurnId: "turn-user" });
  });
});

// 审查 2026-10-26 第 4 条：时间算谁定的，看定下它的那一刻。用户在这一轮里让 Lead 建的、让 Lead 改的，算用户定的；
// Lead 自己决定改的才算覆盖，收件箱才告诉用户。以前只看建它的人和 ui_action 的 authority（lead_allowed 永远是 lead）。
describe("who set a reminder's time", () => {
  function userTurn(id: string) {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
    return id;
  }
  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const reminderId = (result: any) => Number(/#(\d+)/.exec(result.content[0].text)![1]);

  it("counts a reminder Lead created in the user's turn as the user's time, so Lead's own later change is reported", async () => {
    deps.currentTurnId = () => userTurn("turn-create");
    const id = reminderId(await tool("create_reminder").execute("t", { title: "体检", remind_at: later(24) }));
    deps.currentTurnId = () => null;
    const moved = JSON.parse((await tool("reschedule_reminder").execute("t", {
      ticket_id: id, remind_at: later(48), reason: "医院那天不开门",
    })).content[0].text);
    expect(moved.result.note).toContain("用户定的");
    expect(leadReminderOverridesOfUser(db, "2000-01-01T00:00:00.000Z")).toMatchObject([{ itemId: id, reason: "医院那天不开门" }]);
  });

  it("does not report a change the user asked for in their own turn, nor Lead changing a time Lead set itself", async () => {
    const id = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "user", remindAt: later(24) });
    deps.currentTurnId = () => userTurn("turn-move");
    const asked = JSON.parse((await tool("reschedule_reminder").execute("t", {
      ticket_id: id, remind_at: later(30), reason: "用户说改到明天",
    })).content[0].text);
    expect(asked.result).not.toHaveProperty("note");
    deps.currentTurnId = () => null;
    const own = reminderId(await tool("create_reminder").execute("t", { title: "喝水", remind_at: later(2) }));
    await tool("reschedule_reminder").execute("t", { ticket_id: own, remind_at: later(3), reason: "顺延" });
    expect(leadReminderOverridesOfUser(db, "2000-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("the prompt", () => {
  // 2026-10-28：时间和提醒的做法拆进 skill scheduling，系统提示词只留指向它的一条。
  it("tells Lead how to set the level, and how to handle a reminder that fired", () => {
    const skill = leadSkillText("scheduling");
    for (const phrase of [
      "level=interrupt", "拿不准时先问用户", "early_minutes", "repeat_every_minutes",
      "系统已经准时推送", "不要重复提醒的内容", "先查，再把结果写到卡上", "record_disposition",
    ]) expect(skill).toContain(phrase);
    expect(LEAD_SYSTEM_PROMPT).toContain("skill scheduling");
    // 以前提示词让 Lead 自己把到点的提醒推给用户；现在 daemon 推，Lead 不再推一遍。
    for (const text of [LEAD_SYSTEM_PROMPT, skill]) expect(text).not.toContain("他自己设的提醒到点要推给他");
  });
});

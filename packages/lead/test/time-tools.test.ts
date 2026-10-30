import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { listTriggers } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadSkillText } from "./lead-skill-text.js";

let db: Db;
let deps: LeadDeps;
function tool(name: string) {
  return createLeadTools(deps).find((t: any) => t.name === name) as any;
}
beforeEach(() => {
  const dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
});

describe("time tools", () => {
  // set_ticket_schedule 已删除（spec §8）：due_at 是建单时就该落的字段，remind_at 则是
  // reminder 这类 item 自己的字段，不再作为一个时间戳挂到任务上（约束 C3）。
  // 这条断言的内容（自然语言时刻归一到 ISO UTC）原样保留，只换到 create_task 的 due_at 上。
  it("create_task normalizes due_at to ISO UTC", async () => {
    await tool("create_task").execute("t", {
      title: "交房租", brief: "b", due_at: "2026-07-25T18:00:00+08:00",
    });
    expect(getItem(db, 1)!.due_at).toBe("2026-07-25T10:00:00.000Z");
  });

  it("create_reminder normalizes remind_at to ISO UTC", async () => {
    await tool("create_reminder").execute("t", {
      title: "三点开会", remind_at: "2026-07-25T15:00:00+08:00",
    });
    expect(getItem(db, 1)!.remind_at).toBe("2026-07-25T07:00:00.000Z");
  });

  // 原名 "create_schedule + list_schedules"，工具按 spec §8 改名为 trigger 词汇。
  // 原断言里的 spawn=1（到点自动开跑）刻意不再保留：那条能力挂在 (C5) 上，只有 user 建的
  // trigger 才有，而 lead 建的一律 created_by='lead'。旧实现是靠把 createdBy 写成 'user'
  // 冒名换来的，本期把它关掉了。
  it("create_cron_trigger + list_triggers", async () => {
    const res = await tool("create_cron_trigger").execute("t", {
      label: "每周汇总", cron: "0 1 * * 1", kind: "task", title: "每周汇总", brief: "汇总工单",
    });
    expect(res.content[0].text).toContain("created cron trigger");
    expect(listTriggers(db).length).toBe(1);
    expect(listTriggers(db)[0].created_by).toBe("lead");
    expect(listTriggers(db)[0].action_type).toBe("create_item");
    const list = await tool("list_triggers").execute("t", {});
    expect(list.content[0].text).toContain("每周汇总");
    expect(list.content[0].text).toContain("产出=task");
  });

  it("agenda aggregates dated tasks, reminders and schedules within window", async () => {
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
    await tool("create_task").execute("t", { title: "报告", brief: "b", due_at: soon });
    await tool("create_reminder").execute("t", { title: "体检", remind_at: soon });
    await tool("create_cron_trigger").execute("t", {
      label: "日报", cron: "0 1 * * *", kind: "reminder", title: "日报",
    });
    const res = await tool("agenda").execute("t", { days: 7 });
    expect(res.content[0].text).toContain("报告");
    expect(res.content[0].text).toContain("体检");
    expect(res.content[0].text).toContain("日报");
  });

  it("agenda empty window", async () => {
    const res = await tool("agenda").execute("t", { days: 1 });
    expect(res.content[0].text).toContain("没有带时间的安排");
  });
});

describe("time discipline in prompt", () => {
  // 锚点跟着工具改名走。"提醒不是执行"这个锚点删掉了——它是 prompt.ts:38 那条约定的措辞，
  // 而那条约定存在的唯一理由是当时没有 reminder 这个 kind，只能靠提示词让 lead 自律区分。
  // 现在区分由 create_task / create_reminder 两个签名承担，约定本身是要被删的东西。
  // 2026-10-28：每种时间说法落到哪个工具，拆进 skill scheduling；系统提示词留「落成字段」这条纪律和指路。
  it("has time-to-field anchors", () => {
    const skill = leadSkillText("scheduling");
    for (const a of ["时间语义必须落字段", "create_task", "create_reminder", "create_cron_trigger", "agenda"]) {
      expect(skill).toContain(a);
    }
    expect(LEAD_SYSTEM_PROMPT).toContain("时间说法要落成字段");
    expect(LEAD_SYSTEM_PROMPT).toContain("skill scheduling");
  });

  it("no longer instructs the lead to hand-build reminders as tickets", () => {
    for (const text of [LEAD_SYSTEM_PROMPT, leadSkillText("scheduling")]) {
      expect(text).not.toContain("这是提醒不是执行");
      for (const gone of ["set_ticket_schedule", "create_schedule", "transition_ticket", "create_ticket"]) {
        expect(text).not.toContain(gone);
      }
    }
  });

  // 诉求 3：lead 要能向用户解释"我建了单但它没跑"，并且知道自己推不动它。
  it("tells the lead that a new task waits in draft for the user", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("draft");
    expect(LEAD_SYSTEM_PROMPT).toMatch(/没有确认它的权限|不能替用户确认|无权确认/);
  });

  // 诉求 4：暂停是用户的动作，lead 要知道暂停期间工单仍是 active。
  it("tells the lead that the user may pause a run", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("暂停");
  });

  // spec §4：两个收件箱的动词不同，lead 必须知道 notifications 不能吞。
  it("distinguishes the lead inbox from user notifications", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("read_notifications");
    expect(LEAD_SYSTEM_PROMPT).toContain("read_inbox");
  });
});

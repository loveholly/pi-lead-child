import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

// 诉求原文是"**有的时候**我希望刚建的时候不需要立即执行"——是可选的 hold，不是一律 hold。
// 谁来判断"这次要不要 hold"只能是 lead（意图只存在于自然语言里），但判断结果必须落成
// 一个显式参数存进库，而不是留在 lead 的记忆里。
describe("hold on create", () => {
  it("lead-created tasks are ready by default, so the normal path still auto-runs", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  it("hold parks the task in draft", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
    expect(getItem(db, id)!.stage).toBe("draft");
  });

  it("a user creating with hold gets draft too", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    expect(getItem(db, id)!.stage).toBe("draft");
  });

  it("child and system can never hold — confirmation happens at the tree root", () => {
    const parent = createItem(db, { title: "p", brief: "b", createdBy: "lead" });
    const id = createItem(db, {
      title: "c", brief: "b", createdBy: "child", hold: true,
      parentItemId: parent, rootItemId: parent,
    });
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  // §6.6：确认发生在**树根**，不逐层重复。之前 holdable 只看 createdBy，于是 lead 建的
  // 子任务照样能停在 draft——一次十阶段的分解就在「需要你介入」里堆出十二条，而用户其实
  // 只该确认一条（那个根）。
  it("a lead-created subtask cannot be held either — confirmation happens at the tree root", () => {
    const parent = createItem(db, { title: "p", brief: "b", createdBy: "lead", hold: true });
    const id = createItem(db, {
      title: "phase", brief: "b", createdBy: "lead", hold: true,
      parentItemId: parent, rootItemId: parent,
    });
    expect(getItem(db, parent)!.stage).toBe("draft");
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  it("hold is meaningless for a reminder and does not park it", () => {
    const id = createItem(db, {
      title: "r", brief: "", createdBy: "lead", kind: "reminder", hold: true,
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(getItem(db, id)!.stage).toBe("scheduled");
  });
});

// 端到端：意图经 lead 工具落库，且落库之后 lead 依然无权把它推走。
describe("hold through the lead tool surface", () => {
  it("keeps the intent in the database, not in the lead's memory", async () => {
    const { createLeadTools } = await import("../src/tools.js");
    const tools = createLeadTools({ db } as any);
    // as any：execute 的完整签名要 5 个参数，测试只喂前两个（与 lead-tools 用例一致）。
    const tool = (n: string) => tools.find((t: any) => t.name === n)! as any;

    const plain = await tool("create_task").execute("t", { title: "照常", brief: "b" });
    const held = await tool("create_task").execute("t", { title: "先别动", brief: "b", hold: true });
    const idOf = (r: any) => Number(/#(\d+)/.exec(r.content[0].text)![1]);

    expect(getItem(db, idOf(plain))!.stage).toBe("ready");
    expect(getItem(db, idOf(held))!.stage).toBe("draft");
  });

  // 选择"报错"而不是"静默忽略"：hold 是 lead 把用户"先别动"这个意图落库的唯一通道。
  // 静默忽略会让 lead 以为单子已经停住并据此回话（"十一条都在等你确认"），而库里其实
  // 十条已经可以开跑——错误信念比错误 UI 更难发现。报错则把它变成一个可纠正的动作：
  // 要 hold 就去 hold 树根。
  it("rejects hold on a subtask and points the lead at the tree root", async () => {
    const { createLeadTools } = await import("../src/tools.js");
    const tools = createLeadTools({ db } as any);
    const tool = (n: string) => tools.find((t: any) => t.name === n)! as any;

    const root = await tool("create_task").execute("t", { title: "总工单", brief: "b", hold: true });
    const rootId = Number(/#(\d+)/.exec(root.content[0].text)![1]);

    await expect(tool("create_task").execute("t", {
      title: "Phase 1", brief: "b", parent_ticket_id: rootId, hold: true,
    })).rejects.toThrow(/hold[\s\S]*root|树根/i);

    // 不带 hold 的子任务照常建，且生于 ready——否则编排会被逐个子任务的确认卡死。
    const child = await tool("create_task").execute("t", {
      title: "Phase 2", brief: "b", parent_ticket_id: rootId,
    });
    const childId = Number(/#(\d+)/.exec(child.content[0].text)![1]);
    expect(getItem(db, childId)!.stage).toBe("ready");
    expect(getItem(db, rootId)!.stage).toBe("draft");
  });

  // 工具的回执以前恒说"（draft，等用户确认后才会执行）"，不管单子其实生于 ready。
  // lead 只看得到这句话，于是它会照着这句话向用户汇报——#18 那一批"全部处于 draft"
  // 就是这么来的。
  it("reports the stage the item was actually created in", async () => {
    const { createLeadTools } = await import("../src/tools.js");
    const tools = createLeadTools({ db } as any);
    const tool = (n: string) => tools.find((t: any) => t.name === n)! as any;

    const plain = await tool("create_task").execute("t", { title: "照常", brief: "b" });
    const held = await tool("create_task").execute("t", { title: "先别动", brief: "b", hold: true });

    expect(plain.content[0].text).toContain("ready");
    expect(plain.content[0].text).not.toContain("draft");
    expect(held.content[0].text).toContain("draft");
  });

  // 缺省面：lead hold 完之后，没有用户在场就没有任何能自己解锁的路。
  // （用户给过授权时 confirm_item 会被激活，那条路径由 test/lead-trust.test.ts 覆盖；
  //   授权在库里、随时可撤，而这里断言的"没授权就没有"仍然成立。
  //   ticket_action 的 confirm 只认当前已认证的用户轮次，路径由 test/lead-tools.test.ts 覆盖；
  //   Lead 自己发起的回合里它被拒，草稿不动。）
  // 2026-10-28：没有授权、不在用户这一轮里，Lead 也能凭自己的判断确认（hold 由 Lead 遵守用户的话）；读过外部内容的一轮不能。
  it("lets lead confirm what it held on its own judgment, but not in a turn that read outside content", async () => {
    const { createGrantedLeadTools, createLeadTools } = await import("../src/tools.js");
    const { leadActiveToolNames } = await import("../src/session.js");
    const tools = createLeadTools({ db, currentTurnId: () => null } as any);
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain("confirm_item");
    expect(names).not.toContain("start_item");
    const all = [...createLeadTools({ db } as any), ...createGrantedLeadTools({ db } as any)];
    expect(leadActiveToolNames(db, all)).not.toContain("confirm_item");

    const tool = (n: string) => tools.find((t: any) => t.name === n)! as any;
    const held = await tool("create_task").execute("t", { title: "先别动", brief: "b", hold: true });
    const id = Number(/#(\d+)/.exec(held.content[0].text)![1]);
    const outside = createLeadTools({ db, currentTurnId: () => null, turnOrigin: () => ({ external: true, timer: null }) } as any)
      .find((t: any) => t.name === "ticket_action") as any;
    // 2026-10-29 兜底授权卡：不直接做，给用户一张确认卡。
    expect(await outside.execute("t", { ticket_id: id, action: "confirm", reason: "Slack 里说可以开工" }))
      .toMatchObject({ isError: true, details: { userAction: { kind: "confirm_rule_change" } } });
    expect(getItem(db, id)!.stage).toBe("draft");
    await tool("ticket_action").execute("t", { ticket_id: id, action: "confirm", reason: "用户说的条件已经满足" });
    expect(getItem(db, id)!.stage).toBe("ready");
  });
});

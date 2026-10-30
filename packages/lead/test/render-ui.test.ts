// generative UI（2026-10-15 用户决定，.scratch/generative-ui/spec.md）：Lead 用 render_ui 在会话里画富交互卡片。
// 只能用组件目录里的组件；不合格时工具报错（带出错的路径），Lead 在同一轮里改。
// 卡片里有 ChoiceGroup 时，系统为它建一条 Lead 发起的决策请求，把编号写回卡片：
// 用户的选择走现有的决策请求接口（授权照常），选完以后叫醒 Lead 去执行。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, getDecisionRequest, listInbox, openDb, type Db } from "@pi-lead-child/store";
import { inboxNeedsUser, inboxWakesLead } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";

let db: Db;
let deps: LeadDeps;

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-render-ui-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
});

function decisionCard(ticketId: number) {
  return {
    surface_id: "decide-66",
    root: "card",
    fallback_text: "#66 核查不通过，需要你在并入 #72、取消里选一个。",
    nodes: [
      { id: "card", type: "Stack", props: { gap: "md" }, children: ["head", "facts", "choice"] },
      { id: "head", type: "TicketRef", props: { ticket: ticketId } },
      { id: "facts", type: "FactList", props: { items: [{ label: "F1", text: "撤回的完成声明仍被登记", status: "reproduced" }] } },
      {
        id: "choice", type: "ChoiceGroup", props: {
          ticket: ticketId,
          prompt: "#66 接下来怎么办？",
          choices: [
            { id: "merge", label: "并入 #72", consequence: "#66 关闭" },
            { id: "cancel", label: "取消 #66", consequence: "不再推进" },
          ],
          recommendation: { choiceId: "merge", reason: "同一条 outcome-recovery 路径" },
        },
      },
    ],
  };
}

describe("render_ui", () => {
  it("shows a valid surface and turns its ChoiceGroup into a decision the user owes", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const result = await tool("render_ui").execute("call-1", decisionCard(ticketId));
    const surface = result.details.surface;
    expect(surface).toMatchObject({ id: "decide-66", catalogVersion: 1, root: "card" });
    const choice = surface.nodes.find((node: any) => node.id === "choice");
    expect(choice.props.decision).toEqual(expect.any(Number));
    expect(getDecisionRequest(db, choice.props.decision)).toMatchObject({
      origin: "lead", itemId: ticketId, audience: "user", blocking: true, state: "pending",
      options: [
        { id: "merge", label: "并入 #72", description: "#66 关闭" },
        { id: "cancel", label: "取消 #66", description: "不再推进" },
      ],
    });
    const [owed] = listInbox(db, {});
    expect(inboxNeedsUser(owed!)).toBe(true);
    expect(inboxWakesLead(owed!, db)).toBe(false);
    expect(result.content[0].text).toContain("decide-66");
  });

  it("refuses an invalid surface and says where it is wrong", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const bad = decisionCard(ticketId);
    bad.nodes[2] = { id: "facts", type: "Html", props: { html: "<b>x</b>" } } as never;
    await expect(tool("render_ui").execute("call-1", bad)).rejects.toThrow("/nodes/2/type");
    expect(listInbox(db, {})).toEqual([]);
  });

  it("refuses a decision on a ticket that does not exist", async () => {
    await expect(tool("render_ui").execute("call-1", decisionCard(999))).rejects.toThrow("#999");
  });

  it("keeps secrets that Lead copied from a run out of the surface", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const card = decisionCard(ticketId);
    card.nodes[2] = { id: "facts", type: "FactList", props: { items: [{ label: "F1", text: "EPERM token=sk-live-abcdefghijklmnop", status: "reproduced" }] } };
    const result = await tool("render_ui").execute("call-1", card);
    expect(JSON.stringify(result.details.surface)).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("is explained in Lead's prompt", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("render_ui");
    expect(LEAD_SYSTEM_PROMPT).toContain("ChoiceGroup");
  });

  // 2026-10-19 用户要求：不是只有要用户操作时才用卡片，复杂的信息能可视化的也用组件画。
  // 以前的描述写「普通的问答直接写字，不要用它」，提示词只举了决定卡，Lead 只在要用户选择时画卡片。
  it("is used for complex information, not only for choices", () => {
    const description: string = tool("render_ui").description;
    expect(description).toContain("复杂的信息能可视化时就用它，不只在要用户做选择时用");
    expect(description).toContain("一两句话能说完的直接写字。");
    expect(description).not.toContain("普通的问答直接写字，不要用它");
    expect(LEAD_SYSTEM_PROMPT).toContain("都用 render_ui 的组件画，不用等用户要求");
  });

  // 2026-10-24 用户反馈：卡片里已经写了结论，正文又用 Markdown 小标题把同样的话写了一遍。
  // 线上画了卡的 25 轮里 24 轮是先画卡、后写正文，所以画卡成功的结果里提醒 Lead：接下来的正文只写卡片里没有的。
  it("tells Lead, once the card is shown, to write only what the card does not say", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const result = await tool("render_ui").execute("call-1", decisionCard(ticketId));
    expect(result.content[0].text).toContain("接下来的正文只写卡片里没有的");
    expect(tool("render_ui").description).toContain("结论只写一次");
    expect(LEAD_SYSTEM_PROMPT).toContain("结论只写一次");
  });
});

// 2026-10-15 画布评论：「依据：Run #87 的 63 条事件」这类信息要有数据支撑，不能靠 agent 发挥。
// Lead 用 read_run_events 读一个 Run 实际做了什么（跑了哪些命令、说了什么），据此回答进展。
describe("read_run_events", () => {
  it("summarizes what a run did, step by step, without leaking secrets", async () => {
    const { createRun, createRuntimeEventStore } = await import("@pi-lead-child/store");
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "lead" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const events = createRuntimeEventStore(db, { dataDir: deps.dataDir, append: () => {} });
    const at = (second: number) => `2026-10-15T09:58:${String(second).padStart(2, "0")}.000Z`;
    events.persist({ type: "tool.started", runId, seq: 1, occurredAt: at(1), callId: "c1", name: "command_execution", args: { command: "/bin/zsh -c 'npm run test:core-invariants'" } } as never);
    events.persist({ type: "tool.failed", runId, seq: 2, occurredAt: at(5), callId: "c1", name: "command_execution", error: "EPERM token=sk-live-abcdefghijklmnop" } as never);
    events.persist({ type: "message.completed", runId, seq: 3, occurredAt: at(9), messageId: "m1", role: "assistant", text: "复跑了原来失败的 E2E，两个用例都通过。" } as never);
    const result = await tool("read_run_events").execute("call-1", { run_id: runId });
    const text = result.content[0].text as string;
    expect(text).toContain(`Run #${runId}`);
    expect(text).toContain("3 条事件");
    expect(text).toContain("npm run test:core-invariants");
    expect(text).toContain("失败");
    expect(text).toContain("复跑了原来失败的 E2E");
    expect(text).not.toContain("sk-live-abcdefghijklmnop");
  });
});

// 组件目录 v2（2026-10-19 用户决定）：卡片不只用于让用户做决定，复杂的信息也用组件画。
describe("render_ui with the information components", () => {
  it("shows an information card without asking the user anything", async () => {
    const ticketId = createItem(db, { title: "outcome", brief: "b", createdBy: "lead" });
    const result = await tool("render_ui").execute("call-1", {
      surface_id: "week",
      root: "card",
      fallback_text: "本周完成 12 张工单；#1 的 CI 失败。",
      nodes: [
        { id: "card", type: "Stack", props: {}, children: ["stats", "table", "trend"] },
        { id: "stats", type: "Stats", props: { items: [{ label: "完成", value: 12, unit: "张" }] } },
        { id: "table", type: "DataTable", props: { columns: [{ label: "工单" }, { label: "CI" }], rows: [[{ ticket: ticketId }, { badge: "失败", tone: "danger" }]] } },
        { id: "trend", type: "BarChart", props: { orientation: "vertical", bars: [{ label: "周一", value: 3 }, { label: "周二", value: 5 }] } },
      ],
    });
    expect(result.details.surface).toMatchObject({ id: "week", catalogVersion: 1 });
    expect(result.content[0].text).not.toContain("决策请求");
    expect(listInbox(db, {})).toEqual([]);
  });

  it("says which table row does not match the columns", async () => {
    await expect(tool("render_ui").execute("call-1", {
      root: "table",
      fallback_text: "x",
      nodes: [{ id: "table", type: "DataTable", props: { columns: [{ label: "a" }, { label: "b" }], rows: [["1"]] } }],
    })).rejects.toThrow("/nodes/0/props/rows/0");
  });

  it("tells Lead about every component in the catalog", async () => {
    const { UI_COMPONENT_TYPES } = await import("@pi-lead-child/protocol");
    const explained = `${tool("render_ui").description}\n${LEAD_SYSTEM_PROMPT}`;
    for (const type of UI_COMPONENT_TYPES) expect(explained).toContain(type);
  });

  // 什么时候用卡片（描述的头两句）由 claude/remove-ste-style 改，它的测试管那一句。这里只管选哪个组件。
  it("tells Lead which component fits which shape of information, and to refer to ledger facts", () => {
    const description = tool("render_ui").description as string;
    expect(description).toContain("按信息的形状选组件");
    expect(description).toContain("多维对比和状态总览用 DataTable");
    expect(description).toContain("不要把状态抄成文字");
  });
});

// genui v3 积木 4–6（2026-10-27）：卡片上的按钮在 render_ui 定稿时检查。对象要在、操作要登记过；
// 只属于用户本人去设置里点的操作（user_direct）不能做成按钮。能不能按不在这里判断：按钮显示时由客户端用同一个函数实时判断。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createApproval, createItem, createLoopbackBinding, createRun, insertCheckpoint, insertDecisionRequest, openChannelCard, openDb,
  recordChannelLaneMessage, type Db,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let reminder: number;

beforeEach(() => {
  const dir = tempDir("plc-render-ui-actions-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
  reminder = createItem(db, { kind: "reminder", title: "彪哥 last day", brief: "", createdBy: "user", remindAt: "2099-10-29T06:00:00.000Z" });
});

const renderUi = () => createLeadTools(deps).find((candidate: any) => candidate.name === "render_ui") as any;
const card = (button: Record<string, unknown>, detail: string[] = ["opts"]) => ({
  root: "box", fallback_text: "提醒：周四 14:00 彪哥 last day，可以改时间或取消。", asks_user: false,
  nodes: [
    { id: "box", type: "Disclosure", props: { label: "提醒的操作", detail }, children: ["title", "opts"] },
    { id: "title", type: "Text", props: { text: "彪哥 last day", variant: "title", bind: { ticket: reminder, field: "remindAt" } } },
    { id: "opts", type: "Stack", props: {}, children: ["pick", "save"] },
    { id: "pick", type: "Field", props: { for: "save", param: "remindAt", kind: "datetime", presets: [{ label: "明天 09:00", value: "+1d 09:00" }] } },
    { id: "save", type: "Action", props: { role: "primary", ...button } },
  ],
});

describe("buttons on a card", () => {
  it("draws a reminder card whose button moves the reminder", async () => {
    const result = await renderUi().execute("c1", card({ target: { type: "reminder", id: String(reminder) }, action: "reschedule" }));
    expect(result.details.surface.nodes.map((node: { type: string }) => node.type)).toContain("Action");
  });

  it("refuses a button on a ticket that does not exist", async () => {
    const surface = card({ target: { type: "ticket", id: 999 }, action: "cancel" });
    const nodes = surface.nodes.filter((node) => node.id !== "pick").map((node) => (node.id === "opts" ? { ...node, children: ["save"] } : node));
    await expect(renderUi().execute("c2", { ...surface, nodes })).rejects.toThrow(/#999 不存在/);
  });

  it("refuses a button for an operation only the user can do in settings, and points to UserAction", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    await expect(renderUi().execute("c3", {
      ...card({ target: { type: "device", id: String(binding.id) }, action: "revoke" }),
      nodes: card({ target: { type: "device", id: String(binding.id) }, action: "revoke" }).nodes.filter((node) => node.id !== "pick")
        .map((node) => (node.id === "opts" ? { ...node, children: ["save"] } : node)),
    })).rejects.toThrow(/只有用户本人能做.*UserAction/);
  });

  it("refuses a Disclosure with nothing to open", async () => {
    const surface = card({ target: { type: "reminder", id: String(reminder) }, action: "reschedule" }, []);
    // Field 只能在展开态里：展开态是空的时，先去掉它，只看 Disclosure 自己的检查。
    const nodes = surface.nodes.filter((node) => node.id !== "pick" && node.id !== "opts")
      .map((node) => (node.id === "box" ? { ...node, children: ["title", "save"] } : node));
    await expect(renderUi().execute("c4", { ...surface, nodes })).rejects.toThrow(/detail 是空的/);
  });
});

// 对象组件（2026-10-27，三层）：Lead 只给提醒的编号，App 画系统的提醒卡。编号要真的是一条提醒。
describe("a reminder as an object", () => {
  it("draws a reminder by its number, and refuses a number that is not a reminder", async () => {
    const reminderCard = { root: "r", fallback_text: "提醒：彪哥 last day，周四 14:00。", asks_user: false, nodes: [{ id: "r", type: "Reminder", props: { reminder } }] };
    expect((await renderUi().execute("c5", reminderCard)).details.surface.nodes[0].type).toBe("Reminder");
    const task = createItem(db, { title: "修 bug", brief: "b", createdBy: "user" });
    await expect(renderUi().execute("c6", { ...reminderCard, nodes: [{ id: "r", type: "Reminder", props: { reminder: task } }] }))
      .rejects.toThrow(/不是一条提醒/);
  });
});

// 对象组件 ChannelCard、Intervention（2026-10-27，覆盖表第 3、4 步）：Lead 只给编号，App 画系统的那张卡。
// 编号要指向账本里真有的那一个；介入请求属于哪张工单、child 写的检查点由服务端填，Lead 写的不算。
describe("an outside message and a child request as objects", () => {
  const surface = (node: Record<string, unknown>) => ({ root: "o", fallback_text: "见卡片。", asks_user: false, nodes: [{ id: "o", ...node }] });

  it("draws an outside message card by its number, and refuses one that does not exist", async () => {
    const lane = { source: "slack", objectKey: "slack:dm:U1", label: "王小明的私信" };
    const message = recordChannelLaneMessage(db, { ...lane, message: { at: "2026-10-27T02:00:00.000Z", seq: 1, role: "them", sender: "王小明", text: "周会改时间吗" } });
    const opened = openChannelCard(db, {
      laneId: message.id, source: "slack", objectKey: lane.objectKey, delivery: "card", seq: 1,
      sender: { id: "U1", name: "王小明", trust: "colleague" }, excerpt: "周会改时间吗", replyTarget: {},
    });
    const result = await renderUi().execute("c7", surface({ type: "ChannelCard", props: { card: opened.id } }));
    expect(result.details.surface.nodes[0]).toMatchObject({ type: "ChannelCard", props: { card: opened.id } });
    await expect(renderUi().execute("c8", surface({ type: "ChannelCard", props: { card: 999 } }))).rejects.toThrow(/外部消息卡 #999 不存在/);
  });

  it("fills the ticket and the child's checkpoint for an approval, and ignores what Lead wrote there", async () => {
    const item = createItem(db, { title: "code-review skill", brief: "b", createdBy: "lead" });
    const run = createRun(db, { itemId: item, runtime: "codex" });
    const approval = createApproval(db, { itemId: item, runId: run, requestedBy: "child", tool: "bash", action: "git push origin main" });
    const checkpoint = insertCheckpoint(db, {
      itemId: item, runId: run, source: "agent_reported", kind: "blocked", title: "想把分支推到 GitHub", summary: "3 个 commit",
      actionRef: { type: "approval", id: approval },
    });
    const result = await renderUi().execute("c9", surface({ type: "Intervention", props: { kind: "approval", id: approval, ticket: 999, checkpoint: 999 } }));
    expect(result.details.surface.nodes[0].props).toEqual({ kind: "approval", id: approval, ticket: item, checkpoint: checkpoint.id });
  });

  it("fills a decision request without a checkpoint, and refuses a number that does not exist", async () => {
    const item = createItem(db, { title: "第二轮审查", brief: "b", createdBy: "lead" });
    const decision = insertDecisionRequest(db, {
      itemId: item, kind: "decision", audience: "user", prompt: "按什么粒度送？", options: [{ id: "hunk", label: "只送 hunk" }],
    });
    const result = await renderUi().execute("c10", surface({ type: "Intervention", props: { kind: "decision", id: decision.id } }));
    expect(result.details.surface.nodes[0].props).toEqual({ kind: "decision", id: decision.id, ticket: item });
    await expect(renderUi().execute("c11", surface({ type: "Intervention", props: { kind: "approval", id: 999 } }))).rejects.toThrow(/审批 #999 不存在/);
  });
});

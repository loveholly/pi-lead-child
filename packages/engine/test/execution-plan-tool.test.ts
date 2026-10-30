// 执行计划（工单详情与验收 spec 5.2、D2，工单 06）：执行 agent 用 update_ticket_plan 维护一张步骤列表。
// - 每次提交整张列表；存最新的一份，每次更新记一行账本，不进工单活动（「经过」不显示）。
// - 返工时在原计划上更新：原来的步骤都要留着，不做的标成 skipped。
// - proof_items 并进计划（D2）：checkpoint 不再接受它，验证结果只走 outcome.validations。
// - Pi（扩展）、Codex 和 Claude（plc MCP 服务器）都从 AGENT_TOOL_DEFINITIONS 拿到同一个工具。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { TicketExecutionPlanSchema } from "@pi-lead-child/protocol";
import {
  createItem, createRun, getExecutionPlan, getItem, listActivities, listExecutionPlanRevisions, openDb, transition, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { AGENT_TOOL_DEFINITIONS, createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import registerExtension from "../src/extension/ticket-tools.js";
import { expiredSessionContext } from "../src/pipeline/expired-session.js";
import { executionPlanText, ticketExecutionPlan } from "../src/coordinator/execution-plan.js";

let dbPath: string;
let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  dbPath = join(tempDir("plc-plan-tool-"), "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "修复空输入", brief: "b", createdBy: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "running" });
});
afterEach(() => db.close());

const handlers = (run = runId) => createAgentToolHandlers({ db, itemId, runId: run });
const outbox = () => (db.prepare("SELECT COUNT(*) AS n FROM gateway_events WHERE event_type = 'ticket.updated'").get() as { n: number }).n;

describe("the update_ticket_plan agent tool", () => {
  it("is defined once for every runtime, with five statuses and the limits in its schema", () => {
    const tool = AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === "update_ticket_plan");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as any;
    expect(schema.required).toEqual(["items"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.items).toMatchObject({ type: "array", minItems: 1, maxItems: 60 });
    expect(schema.properties.items.items.required).toEqual(["id", "title", "status"]);
    expect(schema.properties.items.items.properties.status.enum)
      .toEqual(["pending", "in_progress", "done", "skipped", "blocked"]);
  });

  // 审查 M1：SoL-Pi 的 onlineContextCompact 也注册 update_plan，pi 保留先注册的那个；Codex 也有内置的 update_plan。
  // 所以工具名带上 ticket，和 ticket_update、activate_ticket_run 一致。
  it("does not take a name that SoL-Pi or Codex already uses", () => {
    expect(AGENT_TOOL_DEFINITIONS.map((definition) => definition.name)).not.toContain("update_plan");
  });

  it("records a submitted plan, updates it, and keeps it across a rework run", async () => {
    const first = await handlers().call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "in_progress" },
        { id: "fix", title: "修复空输入", status: "pending" },
        { id: "test", title: "补回归测试", status: "pending" },
      ],
    });
    expect(first).toEqual({ ticket_id: itemId, revision: 1, changed: true });
    expect(outbox()).toBe(1);

    await handlers().call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "done" },
        { id: "test", title: "补回归测试", status: "blocked", note: "测试数据库起不来" },
      ],
    });
    // 原样再交一次：不记新的一版，也不通知界面。
    const same = await handlers().call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "done" },
        { id: "test", title: "补回归测试", status: "blocked", note: "测试数据库起不来" },
      ],
    });
    expect(same).toEqual({ ticket_id: itemId, revision: 2, changed: false });
    expect(outbox()).toBe(2);

    // 交付、被打回，返工的 Run 在原计划上接着更新。
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const rework = createRun(db, { itemId, runtime: "claude", resumedFromRunId: runId });
    updateRun(db, rework, { state: "running" });
    await expect(handlers(rework).call("update_ticket_plan", {
      items: [{ id: "redo", title: "重新做", status: "in_progress" }],
    })).rejects.toThrow(/read, fix, test.*skipped/);
    await handlers(rework).call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "done" },
        { id: "test", title: "补回归测试", status: "done" },
        { id: "review-fix", title: "按核查意见补空数组的处理", status: "in_progress" },
      ],
    });

    const plan = getExecutionPlan(db, itemId)!;
    expect(plan).toMatchObject({ revision: 3, runId: rework });
    expect(plan.steps.map((step) => [step.id, step.status])).toEqual([
      ["read", "done"], ["fix", "done"], ["test", "done"], ["review-fix", "in_progress"],
    ]);
    expect(listExecutionPlanRevisions(db, itemId).map((row) => row.runId)).toEqual([runId, runId, rework]);
    // 账本里每次更新一行；工单活动（「经过」、Lead 的最近活动）里没有计划。
    expect(listActivities(db, itemId).some((activity) => activity.payload.includes("update_ticket_plan"))).toBe(false);
    expect(listActivities(db, itemId).filter((activity) => activity.kind !== "transition")).toEqual([]);
  });

  it("rejects invalid input and writes nothing", async () => {
    const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `步骤 ${id}`, status: "pending", ...extra });
    const reject = (args: Record<string, unknown>, pattern: RegExp) =>
      expect(handlers().call("update_ticket_plan", args)).rejects.toThrow(pattern);

    await reject({ items: [step("a"), step("a")] }, /duplicate step id 'a'/);
    await reject({ items: Array.from({ length: 31 }, (_, index) => step(`s${index}`)) }, /at most 30/);
    await reject({ items: [step("a", { status: "finished" })] }, /status must be one of/);
    await reject({ items: [step("a", { title: "长".repeat(121) })] }, /title/);
    await reject({ items: [step("a", { note: "长".repeat(501) })] }, /note/);
    await reject({ items: [] }, /at least one/);
    await reject({}, /items/);
    await reject({ items: [step("a")], ticket_id: itemId + 1 }, /unknown property/);
    // 审查 L3：报错说明是哪一步的哪个字段，不说「checkpoint text」。两套规则都查：协议的脱敏规则和工具的密钥规则。
    for (const note of ["API_TOKEN=secret-value", "Bearer abcdefghijklmnop", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"]) {
      const error = await handlers().call("update_ticket_plan", { items: [step("a"), step("b", { note })] })
        .then(() => null, (caught: Error) => caught.message);
      expect(error).toMatch(/items\[1\]\.note .*secret/);
      expect(error).not.toMatch(/checkpoint/);
    }
    expect(getExecutionPlan(db, itemId)).toBeNull();
    expect(outbox()).toBe(0);
  });

  it("is only for the ticket's own executor while the ticket is open", async () => {
    transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
    const reviewer = createRun(db, { itemId, role: "reviewer", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    await expect(handlers(reviewer).call("update_ticket_plan", {
      items: [{ id: "a", title: "核查", status: "pending" }],
    })).rejects.toThrow(/reviewer/);

    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
    await expect(handlers().call("update_ticket_plan", {
      items: [{ id: "a", title: "第一步", status: "done" }],
    })).rejects.toThrow(/terminal/);
    expect(getItem(db, itemId)?.stage).toBe("done");
    expect(getExecutionPlan(db, itemId)).toBeNull();
  });

  it("is registered by the Pi extension and works through it", async () => {
    process.env.PLC_DB = dbPath;
    process.env.PLC_TICKET_ID = String(itemId);
    process.env.PLC_ATTEMPT_ID = String(runId);
    try {
      const tools: any[] = [];
      registerExtension({ registerTool: (tool: any) => tools.push(tool), on: () => {} } as any);
      const tool = tools.find((candidate) => candidate.name === "update_ticket_plan");
      expect(tool).toBeDefined();
      expect(tools.map((candidate) => candidate.name)).not.toContain("update_plan");
      await tool.execute("call-1", { items: [{ id: "a", title: "第一步", status: "in_progress" }] });
      expect(getExecutionPlan(db, itemId)?.steps).toEqual([{ id: "a", title: "第一步", status: "in_progress", note: null }]);
    } finally {
      delete process.env.PLC_DB; delete process.env.PLC_TICKET_ID; delete process.env.PLC_ATTEMPT_ID;
    }
  });
});

describe("proof_items after D2", () => {
  const checkpoint = {
    kind: "milestone", title: "协议核对", summary: "通过了 1 项",
    proof_items: [{ id: "auth", label: "授权边界", state: "passed", evidence: "测试通过" }],
  };

  it("is no longer part of the checkpoint schema", () => {
    for (const name of ["submit_checkpoint", "ticket_update"]) {
      const schema = AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === name)!.inputSchema as any;
      const properties = name === "ticket_update" ? schema.properties.checkpoint.properties : schema.properties;
      expect(properties).not.toHaveProperty("proof_items");
      expect(properties).toHaveProperty("outcome");
    }
  });

  it("is rejected by submit_checkpoint and ticket_update, with a pointer to the plan and to outcome.validations", async () => {
    await expect(handlers().call("submit_checkpoint", checkpoint)).rejects.toThrow(/proof_items.*update_ticket_plan.*outcome\.validations/);
    await expect(handlers().call("ticket_update", { checkpoint })).rejects.toThrow(/proof_items/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_proof_items").get()).toEqual({ n: 0 });
  });
});

describe("reading the plan", () => {
  it("gives the page the same plan in the wire shape, and null before the agent submits one", async () => {
    expect(ticketExecutionPlan(db, itemId)).toBeNull();
    await handlers().call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "skipped", note: "上游已经修了" },
      ],
    });
    const plan = ticketExecutionPlan(db, itemId)!;
    expect(Value.Check(TicketExecutionPlanSchema, plan)).toBe(true);
    expect(plan).toMatchObject({
      ticketId: itemId, revision: 1, attemptId: runId,
      steps: [
        { id: "read", title: "读现有的解析器", status: "done", note: null },
        { id: "fix", title: "修复空输入", status: "skipped", note: "上游已经修了" },
      ],
    });
  });

  it("gives Lead the same plan as text, with quoted titles", async () => {
    expect(executionPlanText(db, itemId)).toBe("执行 agent 没有提交计划。");
    await handlers().call("update_ticket_plan", {
      items: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "test", title: "补回归测试", status: "blocked", note: "测试数据库起不来" },
      ],
    });
    const text = executionPlanText(db, itemId);
    expect(text).toContain(`第 1 版，Run #${runId} 提交`);
    expect(text).toContain("完成 1/2");
    // 审查 M3：标题和备注加引号，看得出哪里是 agent 写的字。
    expect(text).toContain('- [done] read："读现有的解析器"');
    expect(text).toContain('- [blocked] test："补回归测试"（备注："测试数据库起不来"）');
  });

  // 审查 M3：给 Lead 和提示词的文字有总长度上限。60 步、每步写满时不能把几万字塞进提示词。
  it("caps the text of a long plan and says that it is cut", async () => {
    await handlers().call("update_ticket_plan", {
      items: Array.from({ length: 60 }, (_, index) => ({
        id: `s${index}`, title: "长".repeat(120), status: index < 30 ? "pending" : "done", note: "长".repeat(500),
      })),
    });
    const text = executionPlanText(db, itemId);
    expect(text.length).toBeLessThan(4_100);
    expect(text).toMatch(/…（截断，原文 \d+ 字）$/);
  });

  // 审查 L1：核查员对照验收标准，不对照计划。会话不存在时给核查员的上下文里没有计划；执行者的计划由启动请求带上
  // （manager.ts 的 startRequest，见 manager-multiruntime.test.ts）。
  it("leaves the plan out of the fresh-session context, which a reviewer also gets", async () => {
    await handlers().call("update_ticket_plan", { items: [{ id: "read", title: "读现有的解析器", status: "done" }] });
    expect(expiredSessionContext(db, itemId)).not.toContain("读现有的解析器");
    expect(expiredSessionContext(db, itemId)).not.toContain("执行计划");
  });
});

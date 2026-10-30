// 2026-10-15 用户决定：不写死模型；Lead 按任务从模型目录选 runtime、模型和 effort；运行故障自己处理，事后报告。
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import { createDispatcher, setModelCatalogForTesting, type ModelCatalog } from "@pi-lead-child/engine";
import { RuntimeRegistry, type AgentRuntime, type RuntimeEvent, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { addActivity, addInbox, addNotification, createItem, createRun, getItem, getReviewerSetting, getRun, listActivities, listInbox, listLeadBacklog, openDb, setReviewerSetting, transition, updateRun, type Db } from "@pi-lead-child/store";
import { agendaNote, createProject, getProject } from "@pi-lead-child/store";

import { createLeadTools, runningChildren, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadSkillText } from "./lead-skill-text.js";

// 刷新时间必须是现在：get_model_catalog 读到超过 6 小时的目录会去问真实的 CLI（以前写死的时间过了 6 小时，
// 这个测试就开始读本机的 Codex 目录）。
const NOW = new Date().toISOString();
const CATALOG: ModelCatalog = {
  refreshedAt: NOW,
  runtimes: [
    {
      runtime: "codex", state: "known", source: "codex debug models", account: "Codex 内置的订阅账号", freeformModelPattern: null,
      refreshedAt: NOW, error: null, cliDefaultModel: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh"],
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", note: null },
        { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "low", note: null },
      ],
    },
    {
      runtime: "claude", state: "known", source: "claude --help", account: "Claude Code 内置的订阅账号",
      freeformModelPattern: "^claude-[a-z0-9][a-z0-9.-]*$", refreshedAt: NOW, error: null,
      cliDefaultModel: null, efforts: ["low", "medium", "high", "xhigh", "max"],
      models: [{ id: "opus", label: "opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, note: "别名" }],
    },
    {
      runtime: "pi", state: "unknown", source: "pi --list-models", account: null, freeformModelPattern: null,
      refreshedAt: null, error: "pi executable not found", cliDefaultModel: null, efforts: [], models: [],
    },
  ],
};

class CapturingCodex implements AgentRuntime {
  readonly id: RuntimeId = "codex";
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true, approvals: false, mcp: true, executableReadOnlyReview: true,
  };
  readonly requests: RuntimeStartRequest[] = [];
  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const events: RuntimeEvent[] = [
      { runId: request.runId, seq: 1, occurredAt: "2026-10-15T02:00:00.000Z", type: "run.started", runtime: "codex", model: request.model ?? null },
      { runId: request.runId, seq: 2, occurredAt: "2026-10-15T02:00:01.000Z", type: "run.completed", exitCode: 0 },
    ];
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
    };
  }
}

let db: Db;
let deps: LeadDeps;
let codex: CapturingCodex;

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-lead-model-choice-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  codex = new CapturingCodex();
  deps = { db, dbPath, dataDir: dir, runtimeRegistry: new RuntimeRegistry([codex]) };
  setModelCatalogForTesting(CATALOG);
});

afterEach(() => {
  setModelCatalogForTesting(null);
  vi.unstubAllEnvs();
});

describe("Lead's model choice", () => {
  it("shows the discovered catalog instead of a hardcoded menu", () => {
    const description = tool("spawn_child").description as string;
    expect(description).toContain("gpt-6.1-sol（CLI 默认");
    expect(description).toContain("Claude Code 内置的订阅账号");
    expect(description).toContain("pi（目录未知");
    // 以前写死的菜单。
    expect(description).not.toContain("openai/gpt-5.5（缺省）");
  });

  it("refuses a model that is not in the catalog and lists the choices", async () => {
    const itemId = createItem(db, { title: "code", brief: "b", createdBy: "lead", runtime: "codex" });
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId, runtime: "codex", model: "gpt-5.5" }))
      .rejects.toThrow(/codex 的模型目录（codex debug models）里没有 gpt-5.5。可选：gpt-6.1-sol、gpt-6-luna/);
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId, runtime: "codex", model: "gpt-6-luna", effort: "xhigh" }))
      .rejects.toThrow(/gpt-6-luna 不认 effort=xhigh。可选：low、medium/);
    expect(codex.requests).toEqual([]);
  });

  it("runs the chosen model with the chosen effort and records both on the run", async () => {
    const itemId = createItem(db, { title: "code", brief: "b", createdBy: "lead", runtime: "codex" });
    const reply = await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId, runtime: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(reply.content[0].text).toContain("runtime=codex, model=gpt-6.1-sol, effort=high");
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
    expect(codex.requests[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(db.prepare("SELECT model, effort FROM runs WHERE item_id=?").get(itemId)).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    // 工单时间线的「Run #N 开始启动」读这条活动，写出 runtime、模型和 effort。
    expect(JSON.parse((db.prepare("SELECT payload FROM activities WHERE item_id=? AND kind='attempt_start'").get(itemId) as { payload: string }).payload))
      .toEqual({ runtime: "codex", model: "gpt-6.1-sol", effort: "high" });
  });

  it("keeps the effort Lead chose at creation for the first dispatch", async () => {
    await tool("create_task").execute("t", { title: "hard work", brief: "b", runtime: "codex", model: "gpt-6.1-sol", effort: "xhigh", hold: true });
    const itemId = (db.prepare("SELECT id FROM items ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
    const requestId = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "first",
    });
    expect(db.prepare("SELECT model, effort FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    // Lead 读工单时，排队中的派发请求写出 runtime、模型和 effort。
    const ticket = await tool("get_ticket").execute("t", { id: itemId });
    expect(ticket.content[0].text).toContain(`派发请求 #${requestId} executor pending runtime=codex model=gpt-6.1-sol effort=xhigh trigger=test`);
  });

  it("reads the full catalog from the catalog tool", async () => {
    const result = await tool("get_model_catalog").execute("t", { runtime: "codex" });
    expect(result.content[0].text).toContain("- gpt-6-luna（GPT-6-Luna）：effort low/medium；默认 low");
  });
});

// 一个恢复能力（2026-10-15 用户决定）：失败、停下或卡住的 Run，任何用途，Lead 都能换 runtime、模型、
// effort 或指令再跑一次。
describe("Lead's recovery of a run", () => {
  it("stops a stuck run and reruns it on the chosen model and effort", async () => {
    const itemId = createItem(db, { title: "stuck", brief: "b", createdBy: "lead", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const stuck = createRun(db, { itemId, runtime: "codex", model: "gpt-6.1-sol" });
    updateRun(db, stuck, { state: "running" });

    const result = await tool("recover_ticket_run").execute("t", {
      ticket_id: itemId, run_id: stuck, action: "retry", model: "gpt-6-luna", effort: "low",
      instruction: "上一次卡住了，先确认测试命令能跑完。", authority_ref: "lead:stuck-run",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "queued", runtime: "codex", model: "gpt-6-luna", effort: "low" });
    expect(getRun(db, stuck)?.state).toBe("stopped");
    expect(db.prepare("SELECT model, effort, trigger FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ model: "gpt-6-luna", effort: "low", trigger: "runtime-recovery" });
  });

  it("resends a failed ticket chat on another model", async () => {
    const itemId = createItem(db, { title: "chat", brief: "b", createdBy: "lead", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const chat = createRun(db, { itemId, purpose: "conversation", runtime: "codex", model: "gpt-6-luna" });
    updateRun(db, chat, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "model is overloaded" });
    addActivity(db, { itemId, runId: chat, actor: "user", kind: "comment", payload: { content: "测试为什么失败？", route: "ticket_agent_start" } });

    const result = await tool("recover_ticket_run").execute("t", {
      ticket_id: itemId, run_id: chat, action: "next_model", model: "gpt-6.1-sol", authority_ref: "lead:chat-retry",
    });
    const recovery = JSON.parse(result.content[0].text);
    expect(recovery).toMatchObject({ status: "started", model: "gpt-6.1-sol", dispatchRequestId: null });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
    expect(getRun(db, recovery.runId)).toMatchObject({ purpose: "conversation", runtime: "codex", model: "gpt-6.1-sol", state: "finished" });
    expect(codex.requests.at(-1)?.prompt).toContain("测试为什么失败？");
    // 账本里写着是 Lead 重发的。
    expect(db.prepare("SELECT actor FROM activities WHERE run_id=? AND kind='comment'").get(recovery.runId)).toEqual({ actor: "lead" });
  });
});

// 改进工单不再是专用工具（2026-10-15 用户决定：能力要通用）。create_task 在任何项目里建单；
// dedupe_key 让同一件事只开一张：还没完成或取消的工单带着同一个键时，返回那一张。
// 工单 09（spec 5.6、5.9、D3、D12）：Lead 建单时一起选执行者和核查员，并选谁核查（verification）。review_policy 删掉了。
// brief 里「严禁调用 codex」这类话由 Lead 读懂，再落成 reviewer；代码只核对目录和停用这类硬约束。
describe("Lead chooses the reviewer with the executor", () => {
  const lastTicket = () => (db.prepare("SELECT id FROM items ORDER BY id DESC LIMIT 1").get() as { id: number }).id;

  // 审查 M3：Lead 选一个系统不会选的核查员（执行者是 codex 时系统选 claude），才能看出 Lead 的选择生效了。
  it("stores the chosen reviewer, asks for an independent review, and dispatches the reviewer with its model and effort", async () => {
    await tool("create_task").execute("t", {
      title: "fix", brief: "修好登录。严禁调用 codex 和 claude 做核查。", runtime: "codex", model: "gpt-6.1-sol", hold: true,
      reviewer: { runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high", reason: "brief 不许 codex 和 claude 核查" },
    });
    const itemId = lastTicket();
    expect(getItem(db, itemId)).toMatchObject({ verification_policy: "independent_reviewer", requested_runtime: "codex" });
    expect(getReviewerSetting(db, itemId)).toMatchObject({
      runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high", chosenBy: "lead", reason: "brief 不许 codex 和 claude 核查",
    });
    const requestId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", trigger: "test", idempotencyKey: `review:${itemId}`,
    });
    expect(db.prepare("SELECT runtime, model, effort FROM dispatch_requests WHERE id=?").get(requestId))
      .toEqual({ runtime: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high" });
    const ticket = (await tool("get_ticket").execute("t", { id: itemId })).content[0].text as string;
    expect(ticket).toContain("verification: independent_reviewer | 核查员: pi model=anthropic/claude-sonnet-4-5 effort=high（Lead 选的）");
  });

  it("lets Lead choose who verifies, and keeps Lead's static check as the default", async () => {
    await tool("create_task").execute("t", { title: "a", brief: "b", hold: true, verification: "user" });
    expect(getItem(db, lastTicket())?.verification_policy).toBe("user");
    await tool("create_task").execute("t", { title: "b", brief: "b", hold: true });
    expect(getItem(db, lastTicket())?.verification_policy).toBe("lead_static");
    expect(getReviewerSetting(db, lastTicket())).toBeNull();
    await tool("create_task").execute("t", {
      title: "c", brief: "b", hold: true, verification: "lead_static", reviewer: { runtime: "claude" },
    });
    expect(getItem(db, lastTicket())?.verification_policy).toBe("lead_static");
    expect(getReviewerSetting(db, lastTicket())).toMatchObject({ runtime: "claude", model: null, effort: null });
    // review_policy 不再是 create_task 的参数。
    expect(JSON.stringify(tool("create_task").parameters)).not.toContain("review_policy");
  });

  // 审查 L4：reviewer 不起作用的两种情况，回执要说出来。
  it("says when the chosen reviewer will not be dispatched automatically, or was not used at all", async () => {
    const created = (await tool("create_task").execute("t", {
      title: "a", brief: "b", hold: true, verification: "lead_static", reviewer: { runtime: "claude" },
    })).content[0].text as string;
    expect(created).toContain("verification=lead_static，系统不会自动派核查");
    const plain = (await tool("create_task").execute("t", { title: "b", brief: "b", hold: true, reviewer: { runtime: "claude" } }))
      .content[0].text as string;
    expect(plain).not.toContain("不会自动派核查");

    await tool("create_task").execute("t", { title: "c", brief: "b", hold: true, dedupe_key: "same-thing" });
    const deduped = (await tool("create_task").execute("t", {
      title: "c again", brief: "b", dedupe_key: "same-thing", reviewer: { runtime: "pi" },
    })).content[0].text as string;
    expect(deduped).toContain("这次给的 reviewer 和 verification 没有用到那张工单上");
    expect(getReviewerSetting(db, lastTicket())).toBeNull();
    expect(JSON.stringify(tool("create_task").parameters)).toContain("一定要给 reviewer");
  });

  // 审查 L3：Lead 用 spawn_child 派核查员时，选好的核查员不能用被换掉，要在工单上记一条，和派发认领时换人一样。
  it("records the switch when spawn_child replaces an unusable chosen reviewer", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", runtime: "pi", verificationPolicy: "independent_reviewer" });
    setReviewerSetting(db, itemId, { runtime: "claude", chosenBy: "lead" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const delivery = createRun(db, { itemId, runtime: "pi" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });

    await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId, role: "reviewer" });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false));
    expect(db.prepare("SELECT runtime FROM runs WHERE item_id=? AND role='reviewer'").all(itemId)).toEqual([{ runtime: "codex" }]);
    const switched = db.prepare(
      "SELECT actor, payload FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')='reviewer_runtime_switched'",
    ).all(itemId) as { actor: string; payload: string }[];
    expect(switched.map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) }))).toEqual([expect.objectContaining({
      actor: "system", dispatchRequestId: null, from: "claude", to: "codex", reason: expect.stringContaining("停用"),
    })]);
  });

  it("refuses a reviewer the user disabled or a model outside the catalog", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
    await expect(tool("create_task").execute("t", { title: "a", brief: "b", reviewer: { runtime: "claude" } }))
      .rejects.toThrow(/停用/);
    vi.unstubAllEnvs();
    await expect(tool("create_task").execute("t", { title: "a", brief: "b", reviewer: { runtime: "codex", model: "gpt-5.5" } }))
      .rejects.toThrow(/codex 的模型目录（codex debug models）里没有 gpt-5.5/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });

  it("says when the system had to pick the executor's own runtime as the reviewer", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude,pi");
    await tool("create_task").execute("t", { title: "a", brief: "b", runtime: "codex", hold: true, verification: "independent_reviewer" });
    const ticket = (await tool("get_ticket").execute("t", { id: lastTicket() })).content[0].text as string;
    expect(ticket).toContain("verification: independent_reviewer | 核查员: codex（系统选的；和执行者是同一种 agent）");
  });
});

describe("one ticket per dedupe key", () => {
  it("returns the open ticket for the same key, and opens a new one after that ticket ends", async () => {
    const related = createItem(db, { title: "#66", brief: "b", createdBy: "user" });
    const first = await tool("create_task").execute("t", {
      title: "Do not hardcode the Codex model", brief: "root cause …", project: "pi-lead-child", workflow_kind: "coding",
      hold: true, dedupe_key: "codex-hardcoded-default-model",
      relations: [{ target_ticket_id: related, relation_type: "relates_to", reason: "found while fixing #66" }],
    });
    const ticketId = Number(/#(\d+)/.exec(first.content[0].text)![1]);
    expect(getItem(db, ticketId)).toMatchObject({ stage: "draft", project: "pi-lead-child" });

    const again = await tool("create_task").execute("t", {
      title: "Same root cause", brief: "…", dedupe_key: "codex-hardcoded-default-model",
    });
    expect(again.content[0].text).toContain(`已有工单 #${ticketId}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 2 });

    transition(db, { itemId: ticketId, to: "cancelled", actor: "user", reason: "won't fix" });
    const later = await tool("create_task").execute("t", { title: "t", brief: "b", dedupe_key: "codex-hardcoded-default-model" });
    expect(later.content[0].text).toContain("created task #");
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 3 });
  });

  it("has no special tool for improvement tickets", () => {
    expect(() => tool("open_improvement_ticket")).toThrow(/not found/);
  });
});

// 需要用户行动时 Lead 用 notify_user 找用户（2026-10-15 用户决定：除非需要用户介入，UI 只给弱反馈）。
describe("telling the user something needs them", () => {
  it("records a user notification written by Lead", async () => {
    const itemId = createItem(db, { title: "deploy", brief: "b", createdBy: "user" });
    await tool("notify_user").execute("t", { ticket_id: itemId, title: "Claude Code 需要你重新登录", body: "我已经把 #12 换到 Codex 继续。" });
    expect(db.prepare("SELECT item_id, kind, urgency, title, body, state FROM notifications").all()).toEqual([{
      item_id: itemId, kind: "lead_notice", urgency: "immediate", title: "Claude Code 需要你重新登录",
      body: "我已经把 #12 换到 Codex 继续。", state: "pending",
    }]);
  });
});

// Jarvis 模式（2026-10-15 用户决定）：事件都先到 Lead，Lead 决定怎样告诉用户、要不要盯着，并且每个处置都落账。
describe("Lead as the user's assistant", () => {
  it("passes system notifications and an approval on to the user in one notice", async () => {
    const itemId = createItem(db, { title: "deploy", brief: "b", createdBy: "user" });
    const reminder = addNotification(db, { kind: "reminder", urgency: "immediate", title: "提醒：交周报" });
    await tool("notify_user").execute("t", {
      title: "该交周报了，另外 #12 要你批准删除临时资源", notification_ids: [reminder], approval_id: 7, ticket_id: itemId,
    });
    expect(db.prepare("SELECT state, delivered_via FROM notifications WHERE id=?").get(reminder)).toEqual({ state: "delivered", delivered_via: "lead" });
    expect(db.prepare("SELECT kind, dedup_key FROM notifications WHERE kind='lead_notice'").get())
      .toEqual({ kind: "lead_notice", dedup_key: "approval:7:lead-notice" });
  });

  // 收件箱的「Lead 已处理」按问题、原因、我做了、以后四行写（2026-10-15 用户选的方向 A + B 的两处）。
  it("records the cause, the action and the follow-up of something it handled", async () => {
    const itemId = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "user" });
    const event = addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "核查连续失败", lossless: true }).id!;
    await tool("record_disposition").execute("t", {
      event_ids: [event], disposition: "handled", reason: "核查换成 Claude Code",
      cause: "Codex 账号不支持 gpt-5.5", action: "用 Claude Code 重派核查 Run #85", follow_up: "模型目录自动发现",
    });
    expect(JSON.parse(listInbox(db, {})[0]!.payload).disposition).toMatchObject({
      kind: "handled", reason: "核查换成 Claude Code",
      cause: "Codex 账号不支持 gpt-5.5", action: "用 Claude Code 重派核查 Run #85", followUp: "模型目录自动发现",
    });
  });

  // 左栏改版阶段 2：E2E 脚本生成的标题不可读，Lead 给它写一个显示用的短标题，原标题保留；空字符串清掉。
  it("gives an unreadable ticket a short display title and can clear it", async () => {
    const title = "[E2E #51 T48-E2E-51-20260817061106] FINAL #45 implementation - outcome snapshot and registry mechanism";
    const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
    await tool("set_display_title").execute("t", { ticket_id: itemId, title: "成果快照与登记机制" });
    expect(getItem(db, itemId)).toMatchObject({ title, display_title: "成果快照与登记机制" });
    await tool("set_display_title").execute("t", { ticket_id: itemId, title: "" });
    expect(getItem(db, itemId)?.display_title).toBeNull();
  });

  // 项目卡片上的一句话就是项目的 summary：Lead 用 update_project_summary 写。
  it("writes the project's one-line status that the project card shows", async () => {
    createProject(db, { name: "pi-lead-child", createdBy: "lead" });
    await tool("update_project_summary").execute("t", {
      project: "pi-lead-child", summary: "卡在 #72 的 review 投影；#66 正在重新核查。", reason: "#66 换了 runtime",
    });
    expect(getProject(db, 1)?.summary).toBe("卡在 #72 的 review 投影；#66 正在重新核查。");
  });

  // 实机检查（2026-10-15）：这两个工具写完库不发事件，客户端要等别的事件才重取，短标题和项目的一句话迟迟不出现。
  it("tells the app when it writes a short title or a project's line", async () => {
    const events = () => db.prepare("SELECT event_type AS type, item_id AS itemId, payload FROM gateway_events ORDER BY seq").all() as
      { type: string; itemId: number | null; payload: string }[];
    const itemId = createItem(db, { title: "[E2E #51 T48] FINAL #45 implementation", brief: "b", createdBy: "user" });
    const before = events().length;
    await tool("set_display_title").execute("t", { ticket_id: itemId, title: "成果快照与登记机制" });
    expect(events().slice(before)).toEqual([expect.objectContaining({ type: "ticket.updated", itemId })]);

    createProject(db, { name: "pi-lead-child", createdBy: "lead" });
    const afterTitle = events().length;
    await tool("update_project_summary").execute("t", { project: "pi-lead-child", summary: "卡在 #72", reason: "r" });
    const [published] = events().slice(afterTitle);
    expect(published).toMatchObject({ type: "snapshot.required" });
    expect(JSON.parse(published!.payload)).toMatchObject({ resource: "projects" });
  });

  // 左栏改版阶段 3：Lead 记节点时带原话；同类型的未完成节点只有一个，改它要用 update_milestone 并写理由。
  it("writes down a milestone once, lists it, and writes the agenda note", async () => {
    const itemId = createItem(db, { title: "review 状态投影", brief: "b", createdBy: "user" });
    await tool("set_milestone").execute("t", { ticket_id: itemId, kind: "test_handoff", at: "2026-10-16T10:00:00+00:00", quote: "明天下午提测" });
    await expect(tool("set_milestone").execute("t", { ticket_id: itemId, kind: "test_handoff", at: "2026-10-17T10:00:00+00:00", quote: "后天" }))
      .rejects.toThrow(/update_milestone/);
    const listed = await tool("list_milestones").execute("t", { ticket_id: itemId }) as { content: { text: string }[] };
    expect(listed.content[0]!.text).toContain("提测 · 2026-10-16T10:00:00.000Z · planned · 由 lead 记下 · 原话「明天下午提测」");

    await tool("update_agenda_note").execute("t", { text: "今天还剩 1 件：16:30 看 #66 的核查结论。" });
    expect(agendaNote(db)?.text).toBe("今天还剩 1 件：16:30 看 #66 的核查结论。");
  });

  it("sets a follow-up for itself and records what it did with an event", async () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "user" });
    await tool("follow_up").execute("t", { at: "2099-01-01T00:00:00+08:00", note: "看 #66 的核查恢复了没有", ticket_id: itemId });
    const [followUp] = listInbox(db, {});
    expect(JSON.parse(followUp!.payload)).toMatchObject({ kind: "lead_followup", wakeLead: true });

    await tool("record_disposition").execute("t", { event_ids: [followUp!.id], disposition: "deferred", reason: "等核查跑完" });
    const shown = await tool("read_inbox").execute("t", {});
    expect(shown.content[0].text).toContain(`#${followUp!.id}`);
    expect(shown.content[0].text).toContain("deferred：等核查跑完");
  });
});

// 2026-10-15 live（#66）：Lead 设了 19:10 的跟进，15 分钟后事情就办完了，跟进却取消不掉：
// 到点 Lead 还会为一件办完的事再被叫醒一次。
describe("cancelling a follow-up", () => {
  it("closes the reminder, records why, and it never wakes Lead", async () => {
    const itemId = createItem(db, { title: "review", brief: "b", createdBy: "user" });
    await tool("follow_up").execute("t", { at: "2020-01-01T00:00:00+08:00", note: "看 #66 的最终报告", ticket_id: itemId });
    const [followUp] = listInbox(db, {});
    const result = await tool("cancel_follow_up").execute("t", { follow_up_id: followUp!.id, reason: "最终报告已经出来，已告诉用户" });
    expect(result.content[0].text).toContain(`#${followUp!.id}`);
    const [after] = listInbox(db, {});
    expect(after!.state).toBe("consumed");
    expect(JSON.parse(after!.payload).disposition).toMatchObject({ kind: "cancelled", reason: "最终报告已经出来，已告诉用户" });
    expect(listLeadBacklog(db, new Date("2030-01-01T00:00:00.000Z")).map((row) => row.id)).not.toContain(followUp!.id);
  });

  it("refuses anything that is not a follow-up", async () => {
    const id = addInbox(db, { severity: "blocker", source: "structural", summary: "异常", dedupScope: "x", lossless: true }).id!;
    await expect(tool("cancel_follow_up").execute("t", { follow_up_id: id, reason: "r" })).rejects.toThrow("不是跟进");
  });
});

describe("Lead's prompt", () => {
  // 以前：「如实转告用户即可，不要主动调用 recover_ticket_run。用户明确要求……你才调用它」。
  // 2026-10-28：Run 出问题时的做法拆进 skill run-supervision，选型指导拆进 skill ticket-planning；
  // 「两个收件箱」（Jarvis 模式）留在系统提示词里。
  it("tells Lead to fix runtime failures itself and report afterwards", () => {
    const run = leadSkillText("run-supervision");
    expect(run).toContain("Run 出了问题，你自己处理，处理完再告诉用户");
    // 判断写成带例子的指导，不是按失败类别列的规则；工具是一个通用的恢复能力。
    expect(run).toContain("判断的例子（不是穷举）");
    expect(run).toContain("失败、停下或卡住的 Run，任何用途");
    expect(LEAD_SYSTEM_PROMPT).toContain("skill run-supervision");
    for (const text of [LEAD_SYSTEM_PROMPT, run]) expect(text).not.toContain("系统会在同一个 runtime 里按模型目录自动换");
    // 异常先交给 Lead：系统马上叫醒它；需要用户行动时它用 notify_user 找用户。
    // 工单 03：只承诺代码做得到的事。哪些会叫醒、哪些要自己查，写在「两个收件箱」一节。
    expect(run).toContain("系统发现的异常大多会马上叫醒你");
    expect(LEAD_SYSTEM_PROMPT).toContain("notify_user");
    // Jarvis 模式：所有事都先到 Lead，由它决定怎样告诉用户；它可以给自己设跟进，每个处置都落账。
    expect(LEAD_SYSTEM_PROMPT).toContain("由你决定告诉用户什么、什么时候说、怎么说");
    expect(LEAD_SYSTEM_PROMPT).toContain("follow_up");
    expect(LEAD_SYSTEM_PROMPT).toContain("cancel_follow_up");
    // 2026-10-15 方案 A：发往工单的消息送不到时由 Lead 接手。
    expect(run).toContain("ticket_message_undelivered");
    expect(LEAD_SYSTEM_PROMPT).toContain("read_run_events");
    expect(LEAD_SYSTEM_PROMPT).toContain("record_disposition");
    expect(run).toContain("dedupe_key");
    for (const text of [LEAD_SYSTEM_PROMPT, run]) {
      expect(text).not.toContain("不能决定不说");
      expect(text).not.toContain("open_improvement_ticket");
      expect(text).not.toContain("不要主动调用");
    }
    expect(leadSkillText("ticket-planning")).toContain("编码交给 Claude Code");
  });
});

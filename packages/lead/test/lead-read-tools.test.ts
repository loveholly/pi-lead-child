// Lead 的读取工具和根因（工单 03，spec D8）。2026-10-16 的会话审计和 10-17 的信号调查发现：
//   · get_ticket 取最早 1000 条 activity 里的最后 20 条：活跃的工单显示的是旧记录；
//   · 崩溃 activity 的 payload 里 reason 排在错误码前面，200 字截断把错误码截掉；
//   · query_tickets 只给 stage，看不到 Run 的状态和失败；
//   · read_notifications 的说明写「缺省只列还没送达的」，代码却连已送达的历史一起返回（Lead 读到了 7 月的通知）；
//   · 没有工具能读 runs 的失败根因、checkpoint、派发请求的挂起原因，也没有工具能读 Lead 自己的回合。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  addActivity, addNotification, completeTurn, createItem, createRun, createTurn, failTurn, insertCheckpoint,
  markNotificationDelivered, openDb, raiseBlocker, recordExecutionPlan, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import type { LeadStatus, TicketSummary } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_QUIET_TOOLS } from "../src/session.js";

let db: Db;
let dir: string;
let deps: LeadDeps;

beforeEach(() => {
  dir = tempDir("plc-read-tools-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = { db, dbPath, dataDir: dir };
});

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const result = await tool(name).execute("call", params);
  return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

function activeTask(title = "迁移"): number {
  const itemId = createItem(db, { title, brief: title, createdBy: "user", runtime: "codex" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  return itemId;
}

function failedRun(
  itemId: number,
  args: { errorCode: string; message: string; code: string; scope?: "task" | "account"; needs?: "none" | "login" },
): number {
  const runId = createRun(db, { itemId, runtime: "codex", model: "gpt-5.4" });
  updateRun(db, runId, {
    state: "failed", endedAt: true, exitCode: 1, errorCode: args.errorCode, errorMessage: args.message,
    failure: { scope: args.scope ?? "task", retry: "never", needs: args.needs ?? "none", code: args.code, evidence: args.message },
  });
  return runId;
}

describe("get_ticket", () => {
  // 回归：以前 ORDER BY id LIMIT 1000 再 slice(-20)。第 1001 条以后的记录永远看不到。
  it("shows the newest 20 activities when the ticket has more than 1000", async () => {
    const itemId = activeTask();
    db.transaction(() => {
      for (let i = 0; i < 1_050; i += 1) {
        addActivity(db, { itemId, actor: "system", kind: "comment", payload: { note: `旧记录 ${i}` } });
      }
    })();
    const runId = createRun(db, { itemId, runtime: "codex" });
    addActivity(db, { itemId, runId, actor: "child", kind: "comment", payload: { note: "最新的一条" } });

    const output = await call("get_ticket", { id: itemId });
    const activities = output.split("--- 最近 activities ---")[1]!;
    expect(activities).toContain("最新的一条");
    expect(activities).toContain("旧记录 1049");
    expect(activities).not.toContain("旧记录 999\"");
    expect(activities.trim().split("\n")).toHaveLength(20);
    // 每条带上它属于哪个 Run。
    expect(activities).toMatch(new RegExp(`Run #${runId} .*最新的一条`));
  });

  // 回归：旧的崩溃 activity 把 reason 放在最前面，截断后看不到错误码。
  it("keeps the error codes of a crash activity when its reason is long", async () => {
    const itemId = activeTask();
    const runId = createRun(db, { itemId, runtime: "codex" });
    addActivity(db, {
      itemId, runId, actor: "system", kind: "crash",
      payload: {
        exitCode: 1, reason: `stack trace ${"x".repeat(600)}`, errorCode: "codex_error",
        failureScope: "account", failureCode: "auth_expired",
      },
    });

    const line = (await call("get_ticket", { id: itemId })).split("\n").find((candidate) => candidate.includes("/crash"))!;
    expect(line).toContain("codex_error");
    expect(line).toContain("auth_expired");
    expect(line).toContain("account");
    expect(line).toContain("…");
  });

  // 执行计划（工单 06，spec 5.11：只读的数据 Lead 也要能读到，内容和页面看到的一样）。
  it("shows the execution plan the agent keeps, or says that it has none", async () => {
    const itemId = activeTask();
    expect((await call("get_ticket", { id: itemId })).split("--- 执行计划 ---")[1]).toContain("执行 agent 没有提交计划。");

    const runId = createRun(db, { itemId, runtime: "claude" });
    recordExecutionPlan(db, {
      itemId, runId,
      steps: [
        { id: "read", title: "读现有的解析器", status: "done" },
        { id: "fix", title: "修复空输入", status: "in_progress", note: "先补测试" },
      ],
    });
    const plan = (await call("get_ticket", { id: itemId })).split("--- 执行计划 ---")[1]!.split("\n---")[0]!;
    expect(plan).toContain(`第 1 版，Run #${runId} 提交`);
    expect(plan).toContain('- [done] read："读现有的解析器"');
    expect(plan).toContain('- [in_progress] fix："修复空输入"（备注："先补测试"）');
  });
});

describe("query_tickets", () => {
  it("shows each ticket's current run state and the error code of its latest failure", async () => {
    const itemId = activeTask("部署");
    const failed = failedRun(itemId, { errorCode: "codex_error", message: "unsupported model", code: "model_unsupported" });
    const running = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, running, { state: "running" });
    const idle = createItem(db, { title: "还没跑", brief: "b", createdBy: "user" });

    const lines = (await call("query_tickets", {})).split("\n");
    const busy = lines.find((line) => line.startsWith(`#${itemId} `))!;
    expect(busy).toContain(`run=#${running}(running)`);
    expect(busy).toContain(`last_failure=#${failed}(code=model_unsupported`);
    expect(lines.find((line) => line.startsWith(`#${idle} `))).toContain("run=-");
  });

  it("shows the latest run when no run is current", async () => {
    const itemId = activeTask();
    const failed = failedRun(itemId, { errorCode: "process_exit", message: "exit 1", code: "process_exit" });
    const line = (await call("query_tickets", {})).split("\n").find((candidate) => candidate.startsWith(`#${itemId} `))!;
    expect(line).toContain(`run=#${failed}(failed)`);
    expect(line).toContain(`last_failure=#${failed}(code=process_exit`);
  });
});

describe("read_notifications", () => {
  // 回归：说明写「缺省只列还没送达的」，代码却缺省列 pending 和 delivered。10-16 Lead 读到了 7 月的通知。
  it("lists only pending notifications by default, newest first", async () => {
    const old = addNotification(db, { kind: "reminder", urgency: "immediate", title: "七月的提醒", createdAt: "2026-07-01T00:00:00.000Z" });
    markNotificationDelivered(db, old, "lead");
    addNotification(db, { kind: "reminder", urgency: "batchable", title: "较早的待播报", createdAt: "2026-10-16T08:00:00.000Z" });
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "最新的待播报", createdAt: "2026-10-17T08:00:00.000Z" });

    const output = await call("read_notifications", {});
    expect(output).not.toContain("七月的提醒");
    expect(output.indexOf("最新的待播报")).toBeLessThan(output.indexOf("较早的待播报"));
  });

  it("filters by since and caps the list with limit, saying that more exist", async () => {
    for (let day = 1; day <= 25; day += 1) {
      addNotification(db, {
        kind: "reminder", urgency: "immediate", title: `通知 ${day}`,
        createdAt: `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    const capped = await call("read_notifications", {});
    expect(capped.match(/^#\d+ /gm)).toHaveLength(20);
    expect(capped).toContain("通知 25");
    expect(capped).not.toContain("通知 5\n");
    expect(capped).toContain("更早");

    const since = await call("read_notifications", { since: "2026-10-23T00:00:00.000Z", limit: 2 });
    expect(since.match(/^#\d+ /gm)).toHaveLength(2);
    expect(since).toContain("通知 25");
    expect(since).toContain("通知 24");
    expect(since).not.toContain("通知 23");

    const history = await call("read_notifications", { state: ["delivered"] });
    expect(history).toContain("没有");
    await expect(call("read_notifications", { since: "not a time" })).rejects.toThrow(/since/);
  });

  it("describes what it does", () => {
    const description = tool("read_notifications").description as string;
    expect(description).toContain("缺省只列还没送达的（pending）");
    expect(description).toContain("从新到旧");
    expect(Object.keys(tool("read_notifications").parameters.properties)).toEqual(["state", "since", "limit"]);
  });
});

function summaryFor(itemId: number, stage: TicketSummary["stage"]): TicketSummary {
  return {
    id: itemId, title: "部署", summary: "", kind: "task", stage, status: stage, hasRun: true, priority: "normal",
    project: null, dueAt: null, deferUntil: null, updatedAt: "2026-10-17T00:00:00.000Z",
    runtime: { state: "blocked", lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0, leadHandling: true },
  };
}

describe("get_ticket_status", () => {
  it("returns the gateway's ticket summary with the runs, the root cause, the dispatch requests and the latest checkpoint", async () => {
    const itemId = activeTask("部署");
    transition(db, { itemId, to: "blocked", actor: "system", reason: "run crashed" });
    const runId = failedRun(itemId, {
      errorCode: "codex_error", message: "401 Unauthorized: token expired", code: "auth_expired", scope: "account", needs: "login",
    });
    raiseBlocker(db, {
      needsUser: false, itemId, runId, code: "codex_error", title: "Codex 认证失败",
      summary: "认证失败", impact: "这张工单停住了", nextStep: "请用户重新登录 Codex", source: "structural",
    });
    db.prepare(
      `INSERT INTO dispatch_requests (item_id, role, purpose, runtime, trigger, idempotency_key, state, suspended_reason)
       VALUES (?, 'executor', 'execution', 'codex', 'runtime-recovery', 'k1', 'pending', ?)`,
    ).run(itemId, "Codex 认证失败，派发已挂起");
    insertCheckpoint(db, {
      itemId, runId, source: "system_derived", kind: "blocked", title: "Codex 认证失败", summary: "Run 没有跑完",
      keyFacts: [{ label: "影响", value: "停住了" }], nextStep: "重新登录", idempotencyKey: `run-crash:${runId}`,
    });
    const seen: number[] = [];
    deps.ticketSummary = (id) => { seen.push(id); return summaryFor(id, "blocked"); };

    const status = JSON.parse(await call("get_ticket_status", { ticket_id: itemId }));
    expect(seen).toEqual([itemId]);
    expect(status.ticket).toEqual(summaryFor(itemId, "blocked"));
    expect(status.runs_total).toBe(1);
    expect(status.runs[0]).toMatchObject({ id: runId, state: "failed", runtime: "codex", error_code: "codex_error" });
    expect(status.last_failure).toMatchObject({
      run_id: runId, code: "auth_expired", scope: "account", needs: "login", error_code: "codex_error",
      impact: "这张工单停住了", next_step: "请用户重新登录 Codex",
    });
    expect(status.last_failure.error_message).toContain("401 Unauthorized");
    expect(status.dispatch_requests).toEqual([expect.objectContaining({
      role: "executor", state: "pending", suspended_reason: "Codex 认证失败，派发已挂起",
    })]);
    expect(status.latest_checkpoint).toMatchObject({
      kind: "blocked", title: "Codex 认证失败", next_step: "重新登录", key_facts: [{ label: "影响", value: "停住了" }],
    });
  });

  it("reports no failure and no checkpoint for a fresh ticket", async () => {
    const itemId = createItem(db, { title: "新的", brief: "b", createdBy: "user" });
    deps.ticketSummary = (id) => summaryFor(id, "ready");
    const status = JSON.parse(await call("get_ticket_status", { ticket_id: itemId }));
    expect(status).toMatchObject({ runs_total: 0, runs: [], last_failure: null, dispatch_requests: [], latest_checkpoint: null });
  });

  it("refuses without the gateway's summary, and for a missing ticket", async () => {
    const itemId = createItem(db, { title: "新的", brief: "b", createdBy: "user" });
    await expect(call("get_ticket_status", { ticket_id: itemId })).rejects.toThrow(/工单摘要/);
    deps.ticketSummary = () => undefined;
    await expect(call("get_ticket_status", { ticket_id: 999 })).rejects.toThrow(/#999/);
  });
});

describe("read_lead_turns", () => {
  const degraded: LeadStatus = {
    state: "degraded", since: "2026-10-17T01:00:00.000Z", failures: 2, reason: "Lead 的模型服务限流了",
    detail: "429 Too Many Requests", nextAttemptAt: null, lastSuccessAt: "2026-10-17T00:50:00.000Z", lastPatrolAt: null,
  };

  it("lists Lead's own recent turns, newest first, with their results and Lead's health", async () => {
    const asked = createTurn(db, {
      originKind: "paired:companion", userText: "#66 现在怎样了", now: new Date("2026-10-17T01:00:00.000Z"),
    });
    failTurn(db, asked.id, "429 Too Many Requests", new Date("2026-10-17T01:00:30.000Z"));
    const heartbeat = createTurn(db, { originKind: "system:heartbeat", userText: "", now: new Date("2026-10-17T01:10:00.000Z") });
    completeTurn(db, heartbeat.id, new Date("2026-10-17T01:10:05.000Z"));
    // 不是 Lead 的回合：工单 agent 回答的、daemon 自己写的通知。
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    createTurn(db, { originKind: "paired:companion:ticket-agent", itemId, userText: "问 agent", now: new Date("2026-10-17T01:20:00.000Z") });
    createTurn(db, { originKind: "system:blocker-notice", userText: "", now: new Date("2026-10-17T01:21:00.000Z") });
    deps.leadHealth = () => degraded;

    const result = JSON.parse(await call("read_lead_turns", {}));
    expect(result.health).toEqual(degraded);
    expect(result.turns.map((turn: { id: string }) => turn.id)).toEqual([heartbeat.id, asked.id]);
    expect(result.turns[1]).toMatchObject({
      id: asked.id, by: "user", origin: "paired:companion", state: "failed", error: "429 Too Many Requests",
      started_at: "2026-10-17T01:00:00.000Z", ended_at: "2026-10-17T01:00:30.000Z", duration_s: 30, user_text: "#66 现在怎样了",
    });
    expect(result.turns[0]).toMatchObject({ by: "system", origin: "system:heartbeat", state: "completed", duration_s: 5 });
  });

  it("keeps a turn that is still running open, honours limit, and says when the health is not available", async () => {
    for (let i = 0; i < 3; i += 1) {
      createTurn(db, { originKind: "paired:companion", userText: `问题 ${i}`, now: new Date(Date.UTC(2026, 9, 17, 1, i)) });
    }
    const result = JSON.parse(await call("read_lead_turns", { limit: 2 }));
    expect(result.health).toMatch(/不可用/);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({ user_text: "问题 2", state: "streaming", ended_at: null, duration_s: null });
  });
});

describe("Lead's prompt matches what the code can do", () => {
  it("points Lead at the tools that read current state, root cause and its own turns", () => {
    // :21、:23 现查状态：一张工单的真实进展和根因用 get_ticket_status。
    expect(LEAD_SYSTEM_PROMPT).toContain("get_ticket_status");
    expect(LEAD_SYSTEM_PROMPT).toContain("和 App 同一份工单摘要");
    // :81 结构化原因：系统交给你的事带着结构化字段。
    expect(LEAD_SYSTEM_PROMPT).toContain("Run 号、影响、下一步、根因（scope、needs、code）和证据");
    // :77 哪些会叫醒、哪些要自己查。
    expect(LEAD_SYSTEM_PROMPT).toContain("马上叫醒你的");
    expect(LEAD_SYSTEM_PROMPT).toContain("系统不会主动告诉你、要你自己查的");
    expect(LEAD_SYSTEM_PROMPT).toContain("可批量的通知");
    // :82 和 read_notifications 的行为一致。
    expect(LEAD_SYSTEM_PROMPT).toContain("缺省只列还没送达的");
    // 先查再回答，不凭记忆说没有这个能力。
    expect(LEAD_SYSTEM_PROMPT).toContain("read_lead_turns");
    expect(LEAD_SYSTEM_PROMPT).toContain("先查再回答");
    expect(LEAD_SYSTEM_PROMPT).toContain("不要凭记忆说「我没有这个能力」");
    // 两个新工具只读：Lead 自己发起的一轮只调了它们、又没话说时，会话里不留这一轮。
    expect(LEAD_QUIET_TOOLS.has("get_ticket_status")).toBe(true);
    expect(LEAD_QUIET_TOOLS.has("read_lead_turns")).toBe(true);
    // 旧的承诺不再出现。
    expect(LEAD_SYSTEM_PROMPT).not.toContain("系统发现异常会马上叫醒你，没人在看也一样");
  });
});

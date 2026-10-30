// 工单生命周期的其余操作，和提醒、工作区、日程节点，走完持久化的整条路（.scratch/ui-action-parity/plan.md P03、P04）。
// 页面经过真的 daemon 和网关（HTTP 路由），Lead 用自己的工具；两边经过同一个操作层，账本只差 actor。最后关掉 daemon、
// 重新打开数据库，读回落盘的结果。
//
// 以前：stop_child（2026-10-28 删掉，现在是 ticket_action 的 stop）把工单转 blocked（页面的「停下」回 ready）；ack_reminder 直接以 lead 确认，被事件叫醒的一轮也能确认；
// Lead 改了用户定的提醒时间，收件箱里没有说明；工作区、节点、提醒改时间各走各的路由，不在操作层。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren, provisionWorkspace, releaseWorkspace } from "@pi-lead-child/engine";
import { createLeadTools, runningChildren } from "@pi-lead-child/lead";
import { expectNoTestProcesses, testProcesses } from "@pi-lead-child/runtime/testing";
import { OWNER_ACTION_PERFORMED_KIND, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createMilestone, createRun, createTurn, createWorkspace, openDb, transition, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  // 开始执行拉起的假 child 答完就退出，不留着等下一条指令。
  process.env.PLC_CHILD_LINGER_MS = "0";
  dir = tempDir("plc-lifecycle-actions-daemon-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

// daemon 停机时不停止正在执行的 child（留给下一个 daemon 接管）。开始执行的用例拉起过垫片：删掉数据目录，垫片停止 CLI
// 并退出，再检查进程都退出了（同 daemon.test.ts）。
afterEach(async () => {
  await daemon?.close();
  daemon = null;
  const launched = existsSync(join(dir, "launches"));
  const leftovers = launched ? testProcesses([dir]) : [];
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (launched) await expectNoTestProcesses([dir], { tracked: leftovers });
}, 30_000);

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
  },
});

// 用 tsx 跑的假 pi：开始执行真的拉起一个 child，不碰真的 CLI。
const childPi = { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] };

async function boot(options: { sessionFactory?: unknown } = {}) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: (options.sessionFactory ?? sessionFactory) as any, gatewayPort: 0, log: () => {}, childPi,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { owner, call };
}

// Lead 的工具，当前这一轮由 daemon 给（这里直接给）。
const leadTool = (name: string, turnId: string | null) =>
  createLeadTools({ db, dbPath, dataDir: dir, currentTurnId: () => turnId, childPi }).find((tool: any) => tool.name === name) as any;

function userTurn(bindingId: number, id: string) {
  createTurn(db, { id, originBindingId: bindingId, originKind: "paired:companion", userText: "…", state: "streaming" });
  return id;
}

// 一个真的隔离 worktree，放弃改动以后已经释放：清理会删掉它的目录。
let repos = 0;
function releasedWorktree(): { itemId: number; workspaceId: number; path: string } {
  const repo = join(dir, `repo-${++repos}`);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "plc@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "PLC Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const itemId = createItem(db, { title: "写代码", brief: "b", createdBy: "user", workflowKind: "coding", workdir: repo });
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
  provisionWorkspace(db, { itemId, mode: "shared" });
  const isolated = provisionWorkspace(db, { itemId, mode: "isolated" });
  releaseWorkspace(db, isolated.id, { mergeStatus: "abandoned" });
  return { itemId, workspaceId: isolated.id, path: isolated.path };
}
const resultOf = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
const reader = (row: unknown) => (row ? JSON.parse((row as { payload: string }).payload) as { operations: unknown[] } : null);

function activeTicket(title: string): { itemId: number; runId: number } {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running", sessionId: "s" });
  return { itemId, runId };
}

function firedReminder(title: string): number {
  const itemId = createItem(db, { kind: "reminder", title, brief: "", createdBy: "user", remindAt: new Date(Date.now() - 120_000).toISOString() });
  transition(db, { itemId, to: "fired", actor: "system", reason: "remind_at reached", now: new Date(Date.now() - 120_000) });
  return itemId;
}

function doneWorkspace(title: string): { itemId: number; workspaceId: number } {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user", workdir: join(dir, "shared") });
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
  const workspace = createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: join(dir, "shared"), state: "active" });
  return { itemId, workspaceId: workspace.id };
}

// 落盘的账：工单或提醒的 stage、最后一次 stage 变化、主人操作、操作层的账本。
function ledgerOf(reader: Db, entityKey: string, itemId: number) {
  const json = (row: { payload: string } | undefined) => (row ? JSON.parse(row.payload) : null);
  const stage = (reader.prepare("SELECT stage FROM items WHERE id=?").get(itemId) as { stage: string }).stage;
  const changed = reader.prepare("SELECT payload FROM events WHERE kind='stage.changed' AND json_extract(payload, '$.itemId')=? ORDER BY seq DESC LIMIT 1")
    .get(itemId) as { payload: string } | undefined;
  const owner = reader.prepare("SELECT payload FROM events WHERE kind=? AND json_extract(payload, '$.target.ticketId')=?")
    .all(OWNER_ACTION_PERFORMED_KIND, itemId).map((row: any) => JSON.parse(row.payload).action);
  const performed = reader.prepare("SELECT source, payload FROM events WHERE kind=? AND entity_key=? ORDER BY seq")
    .all(UI_ACTION_PERFORMED_KIND, entityKey).map((row: any) => ({ source: row.source, ...JSON.parse(row.payload) }));
  return { stage, changed: json(changed), owner, performed };
}

describe("lifecycle, reminder, workspace and milestone actions through the daemon", () => {
  it("stops a ticket from the page and from Lead on its own the same way: back to ready, only the actor differs", async () => {
    const { call } = await boot();
    const clicked = activeTicket("页面上停下");
    const stopped = activeTicket("Lead 停下");
    expect((await call("POST", `/v1/tickets/${clicked.itemId}/stop`, {})).status).toBe(200);
    const result = await leadTool("ticket_action", null).execute("t", { ticket_id: stopped.itemId, action: "stop", reason: "Run 卡死了" });
    expect(result.content[0].text).toContain("ready");
    // 审查 2026-10-26 第 7 条：Lead 自己停下的工单一定让用户看到（收件箱的「Lead 已处理」），页面上用户自己停的不进。
    const handled = (await call("GET", "/v1/inbox")).body.leadHandled as Array<{ ticketId: number; action: string; problem: string }>;
    expect(handled.filter((entry) => entry.problem.includes("停下了工单"))).toEqual([
      expect.objectContaining({ ticketId: stopped.itemId, action: "Run 卡死了" }),
    ]);

    await daemon!.close();
    daemon = null;
    db.close();
    const reader = openDb(dbPath);
    for (const { itemId, runId } of [clicked, stopped]) {
      expect((reader.prepare("SELECT state FROM runs WHERE id=?").get(runId) as { state: string }).state).toBe("stopped");
    }
    const page = ledgerOf(reader, `ticket:${clicked.itemId}`, clicked.itemId);
    const lead = ledgerOf(reader, `ticket:${stopped.itemId}`, stopped.itemId);
    expect(page).toMatchObject({ stage: "ready", changed: { from: "active", to: "ready", actor: "user" }, owner: ["ticket.stop"] });
    expect(lead).toMatchObject({ stage: "ready", changed: { from: "active", to: "ready", actor: "lead", reason: "Run 卡死了" }, owner: [] });
    reader.close();
  });

  it("acks a reminder in any turn, and tells the user in the inbox when Lead moved the time they set", async () => {
    const { owner, call } = await boot();
    const relayed = firedReminder("交周报");
    const clicked = firedReminder("取快递");
    const own = firedReminder("喝水");
    // 1. Lead 被事件叫醒（这一轮不是用户的）：也能确认（用户 2026-10-27），记成 Lead 自己确认的。
    expect(resultOf(await leadTool("ack_reminder", null).execute("t", { ticket_id: own, reason: "这条是我给自己设的，已经处理了" })))
      .toMatchObject({ authority: "lead" });
    // 2. 用户在页面上点「知道了」；用户在这一轮里说了另一条，Lead 代他确认。
    expect((await call("POST", `/v1/tickets/${clicked}/ack`, {})).status).toBe(200);
    createTurn(db, { id: "turn-user", originBindingId: owner.binding.id, originKind: "paired:companion", userText: "周报交了", state: "streaming" });
    expect(resultOf(await leadTool("ack_reminder", "turn-user").execute("t", { ticket_id: relayed, reason: "用户说周报交了" })))
      .toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-user" });

    // 3. 用户在页面上改了一条提醒的时间；Lead 自己又改了它：收件箱的「Lead 已处理」写明。
    const moved = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2099-10-26T01:00:00.000Z" });
    expect((await call("POST", `/v1/reminders/${moved}/reschedule`, { remindAt: "2099-10-27T01:00:00.000Z" })).body)
      .toMatchObject({ ticketId: moved, remindAt: "2099-10-27T01:00:00.000Z" });
    expect(resultOf(await leadTool("reschedule_reminder", null).execute("t", {
      ticket_id: moved, remind_at: "2099-10-28T01:00:00.000Z", reason: "那天医院不开门",
    }))).toMatchObject({ authority: "lead", result: { note: expect.stringContaining("用户定的") } });
    const inbox = await call("GET", "/v1/inbox");
    expect(inbox.body.leadHandled).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: moved, action: "那天医院不开门", problem: expect.stringContaining("体检") }),
    ]));

    await daemon!.close();
    daemon = null;
    db.close();
    const reader = openDb(dbPath);
    const page = ledgerOf(reader, `reminder:${clicked}`, clicked);
    const lead = ledgerOf(reader, `reminder:${relayed}`, relayed);
    expect(page).toMatchObject({
      stage: "acked", changed: { from: "fired", to: "acked", actor: "user" },
      performed: [{ source: "user", action: "ack", actor: "user", authority: "user", detail: { from: "fired", to: "acked" } }],
    });
    expect(lead).toMatchObject({
      stage: "acked", changed: { from: "fired", to: "acked", actor: "lead", onBehalfOf: "user", sourceTurnId: "turn-user" },
      performed: [{ source: "lead", action: "ack", actor: "lead", authority: "on_behalf", sourceTurnId: "turn-user", detail: { from: "fired", to: "acked" } }],
    });
    expect(ledgerOf(reader, `reminder:${moved}`, moved).performed).toMatchObject([
      { action: "reschedule", actor: "user", detail: { overrodeUser: false } },
      { action: "reschedule", actor: "lead", reason: "那天医院不开门", detail: { overrodeUser: true } },
    ]);
    reader.close();
  });

  it("restores, releases a workspace and moves a milestone from both entries through the same operations", async () => {
    const { owner, call } = await boot();
    // 恢复：页面，Lead 在用户这一轮里（代用户做），Lead 被事件叫醒的一轮（2026-10-28 起由 Lead 判断，记成它自己做的）。
    const clicked = createItem(db, { title: "页面上恢复", brief: "b", createdBy: "user" });
    const relayed = createItem(db, { title: "Lead 恢复", brief: "b", createdBy: "user" });
    const own = createItem(db, { title: "Lead 自己恢复", brief: "b", createdBy: "user" });
    for (const itemId of [clicked, relayed, own]) transition(db, { itemId, to: "cancelled", actor: "user", reason: "x" });
    expect((await call("POST", `/v1/tickets/${clicked}/restore`, { mode: "root_only" })).status).toBe(200);
    expect(resultOf(await leadTool("ticket_action", null).execute("t", { ticket_id: own, action: "restore", reason: "取消错了" })))
      .toMatchObject({ authority: "lead", result: { stage: "draft" } });
    createTurn(db, { id: "turn-user", originBindingId: owner.binding.id, originKind: "paired:companion", userText: "把它恢复", state: "streaming" });
    expect(resultOf(await leadTool("ticket_action", "turn-user").execute("t", { ticket_id: relayed, action: "restore", reason: "用户说把它恢复" })))
      .toMatchObject({ authority: "on_behalf", result: { stage: "draft" } });

    // 释放工作区：页面，和 Lead 自己。
    const pageWorkspace = doneWorkspace("页面上释放");
    const leadWorkspace = doneWorkspace("Lead 释放");
    expect((await call("POST", `/v1/workspaces/${pageWorkspace.workspaceId}/release`, {})).body)
      .toMatchObject({ workspaceId: pageWorkspace.workspaceId, status: "released" });
    expect(resultOf(await leadTool("release_workspace", null).execute("t", { item_id: leadWorkspace.itemId, reason: "工单做完了" })))
      .toMatchObject({ authority: "lead", result: { status: "released" } });

    // 改节点：用户在日程里改，Lead 又改了它（收件箱写明）。
    const due = createItem(db, { title: "有截止的工单", brief: "b", createdBy: "user" });
    const milestone = createMilestone(db, due, { kind: "due", at: "2099-11-01T09:00:00.000Z" }, { actor: "user" });
    expect((await call("POST", `/v1/milestones/${milestone.id}`, { at: "2099-11-02T09:00:00.000Z" })).body)
      .toMatchObject({ id: milestone.id, at: "2099-11-02T09:00:00.000Z" });
    expect(resultOf(await leadTool("update_milestone", null).execute("t", {
      milestone_id: milestone.id, at: "2099-11-03T09:00:00.000Z", reason: "客户推迟了一天",
    }))).toMatchObject({ authority: "lead", result: { change: "moved" } });
    expect((await call("GET", "/v1/inbox")).body.leadHandled).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: due, action: "客户推迟了一天" }),
    ]));

    await daemon!.close();
    daemon = null;
    db.close();
    const reader = openDb(dbPath);
    expect(ledgerOf(reader, `ticket:${clicked}`, clicked)).toMatchObject({ stage: "draft", changed: { from: "cancelled", to: "draft", actor: "user" } });
    expect(ledgerOf(reader, `ticket:${relayed}`, relayed)).toMatchObject({
      stage: "draft", changed: { from: "cancelled", to: "draft", actor: "lead", onBehalfOf: "user", sourceTurnId: "turn-user" },
    });
    const workspaceState = (id: number) => (reader.prepare("SELECT state FROM workspaces WHERE id=?").get(id) as { state: string }).state;
    expect([workspaceState(pageWorkspace.workspaceId), workspaceState(leadWorkspace.workspaceId)]).toEqual(["released", "released"]);
    expect(ledgerOf(reader, `workspace:${pageWorkspace.workspaceId}`, pageWorkspace.itemId)).toMatchObject({
      owner: ["workspace.release"], performed: [{ source: "user", action: "release", actor: "user", detail: { status: "released" } }],
    });
    expect(ledgerOf(reader, `workspace:${leadWorkspace.workspaceId}`, leadWorkspace.itemId)).toMatchObject({
      owner: [], performed: [{ source: "lead", action: "release", actor: "lead", authority: "lead", detail: { status: "released" } }],
    });
    expect(ledgerOf(reader, `milestone:${milestone.id}`, due).performed).toMatchObject([
      { action: "update", actor: "user", detail: { change: "moved", overrodeUser: false } },
      { action: "update", actor: "lead", detail: { change: "moved", overrodeUser: true } },
    ]);
    expect((reader.prepare("SELECT at FROM item_milestones WHERE id=?").get(milestone.id) as { at: string }).at).toBe("2099-11-03T09:00:00.000Z");
    reader.close();
  }, 30_000);

  it("starts, unconfirms and cleans an isolated worktree from both entries through the same operations", async () => {
    const { owner, call } = await boot();
    // 开始执行：页面和 Lead（spawn_child 的执行者）都调宿主的 startRun，真的拉起一个 child。
    const clicked = createItem(db, { title: "页面上开始", brief: "b", createdBy: "user" });
    const spawned = createItem(db, { title: "Lead 开始", brief: "b", createdBy: "user" });
    expect((await call("POST", `/v1/tickets/${clicked}/start`, {})).status).toBe(200);
    expect((await leadTool("spawn_child", null).execute("t", { ticket_id: spawned, reason: "用户昨天说今天开始做" })).isError).not.toBe(true);
    // 两边各拉起一个 Run；等它们跑完，进程退出，再往下。
    for (const itemId of [clicked, spawned]) {
      await vi.waitFor(() => expect(db.prepare("SELECT state FROM runs WHERE item_id=?").all(itemId))
        .toEqual([{ state: expect.stringMatching(/^(finished|failed)$/) }]), { timeout: 20_000 });
    }

    await vi.waitFor(() => expect([...liveChildren().keys(), ...runningChildren().keys()]).toEqual([]), { timeout: 20_000 });
    // 撤回确认：页面，和 Lead 在用户这一轮里。
    const pageReady = createItem(db, { title: "页面上撤回", brief: "b", createdBy: "user" });
    const leadReady = createItem(db, { title: "Lead 撤回", brief: "b", createdBy: "user" });
    expect((await call("POST", `/v1/tickets/${pageReady}/unconfirm`, {})).status).toBe(200);
    const turn = userTurn(owner.binding.id, "turn-user");
    expect(resultOf(await leadTool("ticket_action", turn).execute("t", { ticket_id: leadReady, action: "unconfirm", reason: "用户说先别跑" })))
      .toMatchObject({ authority: "on_behalf" });

    // 清理隔离 worktree：没确认就拒绝（什么都不删），确认以后才删。
    const pageTree = releasedWorktree();
    const refused = await call("POST", `/v1/workspaces/${pageTree.workspaceId}/cleanup`, {});
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict", message: expect.stringContaining("confirm: true") } } });
    expect(existsSync(pageTree.path)).toBe(true);
    expect((await call("POST", `/v1/workspaces/${pageTree.workspaceId}/cleanup`, { confirm: true })).body)
      .toMatchObject({ workspaceId: pageTree.workspaceId, status: "cleaned" });
    const leadTree = releasedWorktree();
    await expect(leadTool("cleanup_workspace", turn).execute("t", { item_id: leadTree.itemId, reason: "用户说删掉它" }))
      .rejects.toThrow(/confirm: true/);
    expect(resultOf(await leadTool("cleanup_workspace", turn).execute("t", { item_id: leadTree.itemId, reason: "用户说删掉它", confirm: true })))
      .toMatchObject({ authority: "on_behalf", result: { status: "cleaned" } });

    await daemon!.close();
    daemon = null;
    db.close();
    const reader = openDb(dbPath);
    const started = (itemId: number) => reader.prepare(
      "SELECT actor FROM activities WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='开始执行'",
    ).all(itemId);
    expect([started(clicked), started(spawned)]).toEqual([[{ actor: "user" }], [{ actor: "lead" }]]);
    expect(ledgerOf(reader, `ticket:${pageReady}`, pageReady)).toMatchObject({ stage: "draft", changed: { from: "ready", to: "draft", actor: "user" } });
    expect(ledgerOf(reader, `ticket:${leadReady}`, leadReady)).toMatchObject({
      stage: "draft", changed: { from: "ready", to: "draft", actor: "lead", onBehalfOf: "user", sourceTurnId: "turn-user" },
    });
    for (const tree of [pageTree, leadTree]) {
      expect((reader.prepare("SELECT state FROM workspaces WHERE id=?").get(tree.workspaceId) as { state: string }).state).toBe("archived");
      expect(existsSync(tree.path)).toBe(false);
    }
    expect(ledgerOf(reader, `workspace:${pageTree.workspaceId}`, pageTree.itemId)).toMatchObject({
      owner: ["workspace.cleanup"], performed: [{ action: "cleanup", actor: "user", detail: { status: "cleaned" } }],
    });
    expect(ledgerOf(reader, `workspace:${leadTree.workspaceId}`, leadTree.itemId)).toMatchObject({
      owner: ["workspace.cleanup"],
      performed: [{ action: "cleanup", actor: "lead", authority: "on_behalf", sourceTurnId: "turn-user", detail: { status: "cleaned" } }],
    });
    reader.close();
  }, 60_000);

  // 审查 2026-10-26 第 1 条：被拒的操作以前记成做完的工具调用，会话卡片写成做完了，工单其实没动。
  // 以前用「知道了」、后来用「撤回确认」测；2026-10-28 起它们在哪一轮都能做，改用仍然只认用户这一轮的改预算。
  it("records a refused action as a failed call, so the conversation card does not say it was done", async () => {
    const listeners: Array<(event: any) => void> = [];
    let ticket = 0;
    // 假的 Lead 会话：被事件叫醒的一轮（没有用户轮次），Lead 想撤回确认，真的调 ticket_action，再像 pi 一样把结果交给 daemon
    // （pi 的 agent-loop：工具结果带 isError 时，tool_execution_end 的 isError 是 true）。
    const factory = async (opts: { db: Db; dbPath: string; dataDir: string; currentTurnId: () => string | null }) => ({
      modelName: "stub/model",
      session: {
        sessionId: "stub-ack-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt() {
          const emit = (event: any) => listeners.forEach((listener) => listener(event));
          emit({ type: "agent_start" });
          const args = { ticket_id: ticket, action: "set_budget", input: { tokenBudget: 1_000_000 }, reason: "加预算" };
          emit({ type: "tool_execution_start", toolCallId: "unconfirm-call", toolName: "ticket_action", args });
          // 工单操作被拒时工具抛错，pi 把抛错的工具调用记成 isError。
          let result: unknown;
          let isError = false;
          try {
            result = await createLeadTools({ db: opts.db, dbPath: opts.dbPath, dataDir: opts.dataDir, currentTurnId: () => null })
              .find((tool: any) => tool.name === "ticket_action")!
              .execute("unconfirm-call", args as never, undefined, undefined, undefined as never);
            isError = (result as { isError?: boolean }).isError === true;
          } catch (error) {
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
            isError = true;
          }
          emit({ type: "tool_execution_end", toolCallId: "unconfirm-call", toolName: "ticket_action", result, isError });
          emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } });
          emit({ type: "turn_end", message: {}, toolResults: [] });
          emit({ type: "agent_end", messages: [] });
        },
        async steer() {}, async followUp() {}, dispose() {},
      },
    });
    const { call } = await boot({ sessionFactory: factory });
    ticket = createItem(db, { title: "写周报", brief: "b", createdBy: "user" });
    expect((await call("POST", "/v1/chat/send", { id: "unconfirm-chat", message: "看看周报那张" })).status).toBe(200);
    const card = () => reader(db.prepare("SELECT payload FROM conversation_cards WHERE item_id=? AND kind='ticket_execution'").get(ticket));
    await vi.waitFor(() => expect(card()?.operations).toEqual([expect.objectContaining({ name: "ticket_action", state: "failed" })]));
    expect((db.prepare("SELECT stage FROM items WHERE id=?").get(ticket) as { stage: string }).stage).toBe("ready");
    expect(db.prepare("SELECT event_type FROM gateway_events WHERE event_type LIKE 'lead.tool.%' AND json_extract(payload, '$.toolName')='ticket_action' ORDER BY seq")
      .all().map((row: any) => row.event_type)).toEqual(["lead.tool.started", "lead.tool.failed"]);
  }, 30_000);
});

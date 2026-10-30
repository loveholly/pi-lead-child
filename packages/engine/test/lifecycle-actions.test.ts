// 工单生命周期的其余操作，和提醒、工作区、日程节点（.scratch/ui-action-parity/plan.md P03、P04）。每个操作两个入口：
// 页面以你的名义调，Lead 用工具调，都经过操作层的同一个函数（runTicketAction、runUiAction）。这里测决策边界：
//   - 每个操作的权限档：停下、开始执行、改提醒时间、释放工作区、改节点 Lead 可以自己做；撤回确认、恢复、提醒的「知道了」、
//     隔离 worktree 的清理只在你这一轮里代你做；确认开跑在 plc trust 的长期授权范围内 Lead 自己做，并写明凭哪一份授权。
//   - 两个入口记同样的账，只是 actor 不同；主人操作只记在你的凭证（或者你那一轮的凭证）名下。
// 走完 daemon 和网关的那一段在 apps/daemon/test/lifecycle-actions-daemon.test.ts。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { OWNER_ACTION_PERFORMED_KIND, UI_ACTION_PERFORMED_KIND, type OwnerActionSource } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createMilestone, createRun, createTurn, createWorkspace, getItem, getMilestone, getRun,
  getWorkspace, grantLeadCapability, leadOwnStops, leadReminderOverridesOfUser, listActivities, listEvents, openDb, revokeLeadCapability,
  transition, updateRun, type Binding, type Db,
} from "@pi-lead-child/store";
import { liveChildren } from "../src/children/manager.js";
import { createWorkspaceActionService } from "../src/coordinator/workspace-actions.js";
import {
  listLeadTicketActions, listTicketActions, runTicketAction, TicketActionError,
  type StartRunOptions, type TicketActionCaller,
} from "../src/ticket-actions/index.js";
import { listLeadUiActions, listUiActions, runUiAction, UiActionError, type UiActionCaller } from "../src/ui-actions/index.js";

let db: Db;
let page: Binding;

const SOURCE: OwnerActionSource = { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true };

beforeEach(() => {
  db = openDb(join(tempDir("plc-lifecycle-actions-"), "plc.db"));
  liveChildren().clear();
  page = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
});

// 页面入口：你本人，带上发出请求的凭证（主人操作记在它名下）。
const user = (): TicketActionCaller & UiActionCaller => ({ kind: "user", credential: page, source: SOURCE });
const lead = (turnId: string | null = null): TicketActionCaller & UiActionCaller => ({ kind: "lead", turnId });

// 你本人当前这一轮。startedAt 是这一轮开始的时间（插进来的事件晚于它）。
function userTurn(id = "turn-user", startedAt?: string) {
  createTurn(db, { id, originBindingId: page.id, originKind: "paired:companion", userText: "…", state: "streaming" });
  if (startedAt) db.prepare("UPDATE channel_turns SET created_at=? WHERE id=?").run(startedAt, id);
  return id;
}

async function refused(promise: Promise<unknown>): Promise<TicketActionError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TicketActionError);
  return error as TicketActionError;
}

function ready(): number {
  return createItem(db, { title: "待开始", brief: "b", createdBy: "lead" });
}

function running(): { itemId: number; runId: number } {
  const itemId = ready();
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running", sessionId: "s" });
  return { itemId, runId };
}

function cancelled(): number {
  const itemId = ready();
  transition(db, { itemId, to: "cancelled", actor: "user", reason: "x" });
  return itemId;
}

function firedReminder(): number {
  const itemId = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "user", remindAt: "2026-10-26T01:00:00.000Z" });
  transition(db, { itemId, to: "fired", actor: "system", reason: "remind_at reached", now: new Date("2026-10-26T01:00:00.000Z") });
  return itemId;
}

const stageEvents = (itemId: number) => listEvents(db, { kind: "stage.changed", entityKey: `ticket:${itemId}` }).map((event) => event.payload);
const ownerActions = () => listEvents(db, { kind: OWNER_ACTION_PERFORMED_KIND }).map((event) => event.payload as Record<string, any>);
const performed = (entityKey: string) => listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, entityKey }).map((event) => event.payload as Record<string, any>);

describe("start (P03)", () => {
  it("calls the same host.startRun from the page and from Lead, and Lead may start on its own", async () => {
    const calls: Array<[number, StartRunOptions | undefined]> = [];
    const host = { startRun: (itemId: number, options?: StartRunOptions) => { calls.push([itemId, options]); return `started #${itemId}`; } };
    const clicked = ready();
    const spawned = ready();
    await runTicketAction(db, { itemId: clicked, action: "start", caller: user(), host });
    const outcome = await runTicketAction(db, {
      itemId: spawned, action: "start", input: { runtime: "codex", effort: "high" }, caller: lead(), reason: "spawn_child", host,
    });
    expect(outcome).toMatchObject({ authority: "lead", result: { note: `started #${spawned}` } });
    expect(calls).toEqual([[clicked, {}], [spawned, { runtime: "codex", effort: "high" }]]);
    const started = (itemId: number) => listActivities(db, itemId).filter((row) => row.kind === "decision")
      .map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) }));
    expect(started(clicked)).toEqual([{ actor: "user", decision: "开始执行" }]);
    expect(started(spawned)).toEqual([{ actor: "lead", decision: "开始执行", runtime: "codex", effort: "high" }]);
  });

  it("refuses a draft, a ticket with a live executor and a queued dispatch the same way on both entries", async () => {
    const host = { startRun: () => { throw new Error("must not start"); } };
    const held = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    const live = ready();
    liveChildren().set(live, { runId: 1 } as never);
    for (const caller of [user(), lead()]) {
      for (const itemId of [held, live]) {
        const listed = (await listTicketActions(db, itemId, { host })).find((action) => action.id === "start")!;
        const error = await refused(runTicketAction(db, { itemId, action: "start", caller, reason: "开工", host }));
        expect({ code: error.code, message: error.message }).toEqual({ code: "unavailable", message: listed.reason });
      }
    }
  });
});

describe("stop (P03)", () => {
  it("lets Lead stop a whole ticket on its own: the run stops and the ticket goes back to ready, not blocked", async () => {
    const { itemId, runId } = running();
    const outcome = await runTicketAction(db, { itemId, action: "stop", caller: lead(), reason: "Run 卡死了，白白消耗 token" });
    expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" }, result: { stoppedRuns: 1, stage: "ready" } });
    expect(getRun(db, runId)!.state).toBe("stopped");
    expect(stageEvents(itemId).at(-1)).toMatchObject({ from: "active", to: "ready", actor: "lead", reason: "Run 卡死了，白白消耗 token" });
    expect(stageEvents(itemId).at(-1)).not.toHaveProperty("onBehalfOf");
    // Lead 自己的权限：不记主人操作（没有凭证可以作废），由 Lead 告诉你。
    expect(ownerActions()).toEqual([]);
  });

  it("does the same from the page, and records the owner action under the page's credential", async () => {
    const { itemId, runId } = running();
    await runTicketAction(db, { itemId, action: "stop", caller: user() });
    expect(getRun(db, runId)!.state).toBe("stopped");
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(stageEvents(itemId).at(-1)).toMatchObject({ from: "active", to: "ready", actor: "user", reason: "stopped by user" });
    expect(ownerActions()).toMatchObject([{ action: "ticket.stop", credential: { bindingId: page.id } }]);
  });
});

// 复审 2026-10-27 A：收件箱的「Lead 停下了工单」只给 Lead 自己判断停下的。用户在自己这一轮里说「停下 #5」，
// Lead 照做（stop 是 lead_allowed，账本里没有 onBehalfOf），不能写成 Lead 自己停的（和「提醒时间是谁定的」同一个判断）。
describe("which stops the inbox reports as Lead's own (P03)", () => {
  it("reports a stop in a turn Lead was woken for, and not a stop the user asked for in their own turn", async () => {
    const woken = running();
    const asked = running();
    await runTicketAction(db, { itemId: woken.itemId, action: "stop", caller: lead(), reason: "Run 卡死了" });
    const turnId = userTurn("turn-stop");
    const outcome = await runTicketAction(db, { itemId: asked.itemId, action: "stop", caller: lead(turnId), reason: "用户说停下 #2" });
    expect(outcome).toMatchObject({ authority: "lead", result: { stage: "ready" } });
    expect(leadOwnStops(db, "2000-01-01T00:00:00.000Z").map((stop) => stop.itemId)).toEqual([woken.itemId]);
    expect(stageEvents(asked.itemId).at(-1)).toMatchObject({ to: "ready", actor: "lead", requestedInTurn: turnId });
  });
});

// 复审 2026-10-27 D：Lead 必须写 reason，操作层不替它编。
describe("Lead must give a reason", () => {
  it("is refused by both operation layers without one", async () => {
    const itemId = running().itemId;
    for (const reason of [undefined, "  "]) {
      expect((await refused(runTicketAction(db, { itemId, action: "stop", caller: lead(), ...(reason === undefined ? {} : { reason }) }))).code)
        .toBe("invalid_input");
      const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2099-10-26T01:00:00.000Z" });
      const error = await runUiAction(db, {
        target: { type: "reminder", id: reminder }, action: "reschedule", input: { snoozeMinutes: 30 }, caller: lead(),
        ...(reason === undefined ? {} : { reason }),
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("reason") });
      expect(getItem(db, reminder)!.remind_at).toBe("2099-10-26T01:00:00.000Z");
    }
    expect(getItem(db, itemId)!.stage).toBe("active");
  });
});

describe("unconfirm and restore (P03)", () => {
  // 用户 2026-10-28：「工单操作让 Lead 自己判断」。Lead 被事件叫醒的一轮也能做，账本写 Lead 自己做的。
  it("are Lead's call: Lead woken by an event does them as Lead", async () => {
    const readyItem = ready();
    const gone = cancelled();
    const listed = await listLeadTicketActions(db, readyItem, { turnId: null });
    expect(listed.find((action) => action.id === "unconfirm")).toMatchObject({ permission: "user_only", leadReady: true });
    for (const [itemId, action] of [[readyItem, "unconfirm"], [gone, "restore"]] as const) {
      expect(await runTicketAction(db, { itemId, action, caller: lead(), reason: "工单说明里写了先别跑" }))
        .toMatchObject({ authority: "lead", by: { actor: "lead" } });
    }
    expect([getItem(db, readyItem)!.stage, getItem(db, gone)!.stage]).toEqual(["draft", "draft"]);
  });

  it("let Lead act in the user's turn, recorded as Lead on behalf of the user", async () => {
    const turnId = userTurn();
    const readyItem = ready();
    const gone = cancelled();
    await runTicketAction(db, { itemId: readyItem, action: "unconfirm", caller: lead(turnId), reason: "用户说先别跑" });
    const restored = await runTicketAction(db, { itemId: gone, action: "restore", caller: lead(turnId), reason: "用户说恢复它" });
    expect(restored.result).toMatchObject({ stage: "draft", restore: { mode: "root_only", restoredItemIds: [gone] } });
    for (const itemId of [readyItem, gone]) {
      expect(stageEvents(itemId).at(-1)).toMatchObject({ to: "draft", actor: "lead", onBehalfOf: "user", sourceTurnId: turnId });
    }
    const decision = listActivities(db, gone).find((row) => row.kind === "decision")!;
    expect({ actor: decision.actor, ...JSON.parse(decision.payload) }).toMatchObject({
      actor: "lead", decision: "恢复任务", requestedBy: `lead for user via turn:${turnId}`, onBehalfOf: "user", sourceTurnId: turnId,
    });
  });

  // 复审 2026-10-27 C：树根已经恢复成草稿时，root_only 再恢复一次被拒（说明原因），review_tree 照样能接着恢复子任务。
  it("refuses root_only on a root already restored to draft, and still restores its children with review_tree", async () => {
    const root = createItem(db, { title: "Root", brief: "b", createdBy: "lead" });
    const child = createItem(db, { title: "A", brief: "b", createdBy: "lead", parentItemId: root, rootItemId: root });
    for (const itemId of [child, root]) transition(db, { itemId, to: "cancelled", actor: "lead", reason: "stop" });
    await runTicketAction(db, { itemId: root, action: "restore", caller: user() });
    expect([getItem(db, root)!.stage, getItem(db, child)!.stage]).toEqual(["draft", "cancelled"]);
    const again = await refused(runTicketAction(db, { itemId: root, action: "restore", caller: user() }));
    expect(again).toMatchObject({ code: "unavailable", message: expect.stringContaining("review_tree") });
    const tree = await runTicketAction(db, { itemId: root, action: "restore", input: { mode: "review_tree" }, caller: user() });
    expect(tree.result).toMatchObject({ stage: "ready", restore: { mode: "review_tree", restoredItemIds: [root, child] } });
    expect(getItem(db, child)!.stage).toBe("ready");
  });

  it("restores a cancelled reminder to scheduled, and names the page's credential for a ticket restored from the page", async () => {
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2026-11-01T01:00:00.000Z" });
    transition(db, { itemId: reminder, to: "cancelled", actor: "user", reason: "x" });
    await runTicketAction(db, { itemId: reminder, action: "restore", caller: user() });
    expect(getItem(db, reminder)!.stage).toBe("scheduled");
    const gone = cancelled();
    await runTicketAction(db, { itemId: gone, action: "restore", caller: user() });
    const decision = listActivities(db, gone).find((row) => row.kind === "decision")!;
    expect(JSON.parse(decision.payload)).toMatchObject({ requestedBy: `user via paired binding:${page.id}` });
    expect(JSON.parse(decision.payload)).not.toHaveProperty("sourceTurnId");
    expect((await refused(runTicketAction(db, {
      itemId: cancelled(), action: "restore", input: { mode: "selected_children" }, caller: user(),
    }))).code).toBe("invalid_input");
  });
});

// 审查 2026-10-26 第 3 条：Lead 代用户做时，这一轮的凭证要有这个操作页面入口的 scope（fd0f6b1a）。
// 工单操作（unconfirm、restore）从 2026-10-28 起 Lead 自己判断，但这一轮来自做不了它的凭证时照旧拒绝（child 不能借 Lead
// 替自己做）；工单以外的（ack、清理隔离 worktree）从 2026-10-27 起 Lead 自己能做，这一轮的凭证不够时不记成代用户做。
describe("Lead acting for the user needs the turn's credential to carry the action's scope", () => {
  it("refuses unconfirm and restore, and records ack as Lead's own, in a turn from a credential without tickets:create", async () => {
    const viewer = createLoopbackBinding(db, { name: "只读的网页", scopes: ["chat", "tickets:view"] }).binding;
    createTurn(db, {
      id: "turn-viewer", originBindingId: viewer.id, originKind: "paired:companion", userText: "…", state: "streaming",
      now: new Date("2026-10-26T02:00:00.000Z"),
    });
    const readyItem = ready();
    const gone = cancelled();
    const reminder = firedReminder();
    const owner = ready();
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(owner);
    const worktree = createWorkspace(db, {
      ownerItemId: owner, mode: "isolated", kind: "isolated_child", path: "/tmp/lifecycle-actions-scope", repoRoot: "/tmp/repo",
      branch: "plc/scope", baseRef: "abc", gitWorktree: true, mergeStatus: "abandoned", state: "released",
    });
    for (const [itemId, action] of [[readyItem, "unconfirm"], [gone, "restore"]] as const) {
      const error = await refused(runTicketAction(db, { itemId, action, caller: lead("turn-viewer"), reason: "用户说的" }));
      expect({ action, code: error.code }).toEqual({ action, code: "needs_user_turn" });
      expect(error.message).toContain("tickets:create");
    }
    const acked = await runUiAction(db, { target: { type: "reminder", id: reminder }, action: "ack", caller: lead("turn-viewer"), reason: "用户说的" });
    expect(acked).toMatchObject({ authority: "lead", by: { actor: "lead" } });
    const cleanup = await listLeadUiActions(db, { type: "workspace", id: worktree.id }, { turnId: "turn-viewer" });
    expect(cleanup.actions.find((action) => action.id === "cleanup")).toMatchObject({ lead: "own", leadReady: true });
    expect([getItem(db, readyItem)!.stage, getItem(db, gone)!.stage, getItem(db, reminder)!.stage, getWorkspace(db, worktree.id)!.state])
      .toEqual(["ready", "cancelled", "acked", "released"]);
    const listed = await listLeadTicketActions(db, readyItem, { turnId: "turn-viewer" });
    expect(listed.find((action) => action.id === "unconfirm")).toMatchObject({ leadReady: false, leadReason: expect.stringContaining("tickets:create") });
  });
});

describe("confirm under the user's standing grant (P03)", () => {
  it("is delegated: Lead confirms as Lead and names the grant, without the user's turn", async () => {
    const grant = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const held = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    const listed = await listLeadTicketActions(db, held, { turnId: null });
    expect(listed.find((action) => action.id === "confirm")).toMatchObject({ permission: "delegated", lead: "delegated", leadReady: true });
    const outcome = await runTicketAction(db, { itemId: held, action: "confirm", caller: lead(), reason: "用户说你确认即可" });
    expect(outcome).toMatchObject({ authority: "delegated", by: { actor: "lead" }, result: { stage: "ready", grantId: grant.id } });
    expect(stageEvents(held).at(-1)).toMatchObject({
      from: "draft", to: "ready", actor: "lead", onBehalfOf: "user", underGrant: { grantId: grant.id, capability: "confirm_item" },
    });
    const decision = listActivities(db, held).find((row) => row.kind === "decision")!;
    expect({ actor: decision.actor, ...JSON.parse(decision.payload) }).toMatchObject({
      actor: "lead", decision: "代用户确认开跑（draft → ready）", grantId: grant.id, reason: "用户说你确认即可",
    });
    expect(ownerActions()).toEqual([]);
  });

  // 2026-10-28：授权撤销以后，确认开跑是 Lead 自己的判断，账本写 Lead 自己做的，不写凭哪一份授权。
  it("is Lead's own call once the grant is revoked, and the store refuses a grant that is no longer active", async () => {
    const grant = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    revokeLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const held = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    expect(() => transition(db, {
      itemId: held, to: "ready", actor: "lead", underGrant: { grantId: grant.id, capability: "confirm_item" }, reason: "x",
    })).toThrow(/not active/);
    expect(getItem(db, held)!.stage).toBe("draft");
    const outcome = await runTicketAction(db, { itemId: held, action: "confirm", caller: lead(), reason: "用户说你确认即可" });
    expect(outcome).toMatchObject({ authority: "lead", by: { actor: "lead" } });
    expect(stageEvents(held).at(-1)).toMatchObject({ from: "draft", to: "ready", actor: "lead" });
    expect(stageEvents(held).at(-1)).not.toHaveProperty("underGrant");
  });
});

describe("reminders (P03, P04)", () => {
  it("ack works in any turn; only a fire the user saw before the turn began counts as done for the user", async () => {
    // Lead 被响铃叫醒的一轮：Lead 自己确认（用户 2026-10-27），账本写 Lead。
    const woken = firedReminder();
    expect(await runUiAction(db, { target: { type: "reminder", id: woken }, action: "ack", caller: lead(), reason: "日历上这件事已经结束" }))
      .toMatchObject({ authority: "lead", forLead: { reminderId: woken, stage: "acked" } });
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${woken}` }).at(-1)!.payload)
      .toMatchObject({ from: "fired", to: "acked", actor: "lead" });
    const early = firedReminder();
    // 这一轮开始以后才响的：用户说话时还没见过它，确认了也记成 Lead 自己做的。
    const turnId = userTurn("turn-user", "2026-10-26T01:02:00.000Z");
    const late = createItem(db, { kind: "reminder", title: "取快递", brief: "", createdBy: "user", remindAt: "2026-10-26T01:05:00.000Z" });
    transition(db, { itemId: late, to: "fired", actor: "system", reason: "remind_at reached", now: new Date("2026-10-26T01:05:00.000Z") });
    expect(await runUiAction(db, { target: { type: "reminder", id: late }, action: "ack", caller: lead(turnId), reason: "用户说做了" }))
      .toMatchObject({ authority: "lead" });
    expect([getItem(db, early)!.stage, getItem(db, late)!.stage]).toEqual(["fired", "acked"]);
    // 响在这一轮开始以前的：代用户确认。
    const relayed = await runUiAction(db, { target: { type: "reminder", id: early }, action: "ack", caller: lead(turnId), reason: "用户说交了" });
    expect(relayed).toMatchObject({ authority: "on_behalf", forLead: { reminderId: early, stage: "acked" } });
    expect(listEvents(db, { kind: "stage.changed", entityKey: `reminder:${early}` }).at(-1)!.payload)
      .toMatchObject({ from: "fired", to: "acked", actor: "lead", onBehalfOf: "user", sourceTurnId: turnId });
  });

  it("ack from the page and from Lead in the user's turn record the same ledger, only the actor differs", async () => {
    const turnId = userTurn("turn-user", "2026-10-26T02:00:00.000Z");
    const clicked = firedReminder();
    const relayed = firedReminder();
    await runUiAction(db, { target: { type: "reminder", id: clicked }, action: "ack", caller: user() });
    await runUiAction(db, { target: { type: "reminder", id: relayed }, action: "ack", caller: lead(turnId), reason: "用户说交了" });
    const [page] = performed(`reminder:${clicked}`);
    const [behalf] = performed(`reminder:${relayed}`);
    expect(page).toMatchObject({ action: "ack", actor: "user", authority: "user", bindingId: expect.any(Number), detail: { from: "fired", to: "acked" } });
    expect(behalf).toMatchObject({ action: "ack", actor: "lead", authority: "on_behalf", onBehalfOf: "user", sourceTurnId: turnId, detail: { from: "fired", to: "acked" } });
  });

  it("reschedule is Lead's to do, and Lead changing the user's time shows in the inbox", async () => {
    const reminder = createItem(db, { kind: "reminder", title: "交周报", brief: "", createdBy: "user", remindAt: "2099-10-26T01:00:00.000Z" });
    // 用户在页面上改过一次：时间是用户定的。
    await runUiAction(db, { target: { type: "reminder", id: reminder }, action: "reschedule", input: { remindAt: "2099-10-27T01:00:00.000Z" }, caller: user() });
    const moved = await runUiAction(db, {
      target: { type: "reminder", id: reminder }, action: "reschedule", input: { remindAt: "2099-10-28T01:00:00.000Z" },
      caller: lead(), reason: "那天用户在出差",
    });
    expect(moved).toMatchObject({ authority: "lead", forLead: { remindAt: "2099-10-28T01:00:00.000Z", note: expect.stringContaining("用户定的") } });
    expect(getItem(db, reminder)!.remind_at).toBe("2099-10-28T01:00:00.000Z");
    expect(leadReminderOverridesOfUser(db, "2000-01-01T00:00:00.000Z")).toMatchObject([
      { itemId: reminder, from: "2099-10-27T01:00:00.000Z", to: "2099-10-28T01:00:00.000Z", reason: "那天用户在出差" },
    ]);
    // Lead 再改它自己定的时间、Lead 建的提醒：不算改了用户定的。
    await runUiAction(db, { target: { type: "reminder", id: reminder }, action: "reschedule", input: { snoozeMinutes: 30 }, caller: lead(), reason: "再推迟" });
    const leadMade = createItem(db, { kind: "reminder", title: "喝水", brief: "", createdBy: "lead", remindAt: "2099-10-26T01:00:00.000Z" });
    await runUiAction(db, { target: { type: "reminder", id: leadMade }, action: "reschedule", input: { remindAt: "2099-10-26T02:00:00.000Z" }, caller: lead(), reason: "顺延" });
    expect(leadReminderOverridesOfUser(db, "2000-01-01T00:00:00.000Z")).toHaveLength(1);
    // 已确认的不能改：两个入口一样的判断。
    const acked = firedReminder();
    await runUiAction(db, { target: { type: "reminder", id: acked }, action: "ack", caller: user() });
    const listed = (await listUiActions(db, { type: "reminder", id: acked })).find((action) => action.id === "reschedule")!;
    for (const caller of [user(), lead()]) {
      const error = await runUiAction(db, {
        target: { type: "reminder", id: acked }, action: "reschedule", input: { snoozeMinutes: 10 }, caller, reason: "改",
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "unavailable", message: listed.reason });
    }
  });
});

describe("workspaces (P04)", () => {
  function doneTicketWorkspace(options: { isolated?: boolean } = {}) {
    const itemId = createItem(db, { title: "做完的工单", brief: "b", createdBy: "user", workdir: "/tmp/lifecycle-actions-workspace" });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
    const workspace = options.isolated
      ? createWorkspace(db, {
        ownerItemId: itemId, mode: "isolated", kind: "isolated_child", path: "/tmp/lifecycle-actions-isolated",
        repoRoot: "/tmp/repo", branch: "plc/test", baseRef: "abc", gitWorktree: true, mergeStatus: "abandoned", state: "released",
      })
      : createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: "/tmp/lifecycle-actions-workspace", state: "active" });
    return { itemId, workspaceId: workspace.id };
  }

  it("releases a shared workspace from the page and from Lead on its own, with the same ledger and the page's owner action", async () => {
    const clicked = doneTicketWorkspace();
    const asked = doneTicketWorkspace();
    await runUiAction(db, { target: { type: "workspace", id: clicked.workspaceId }, action: "release", caller: user() });
    const outcome = await runUiAction(db, { target: { type: "workspace", id: asked.workspaceId }, action: "release", caller: lead(), reason: "工单做完了" });
    expect(outcome).toMatchObject({ authority: "lead", forLead: { status: "released", workspace: { state: "released" } } });
    expect(performed(`workspace:${clicked.workspaceId}`)).toMatchObject([{ actor: "user", detail: { from: "active", status: "released" } }]);
    expect(performed(`workspace:${asked.workspaceId}`)).toMatchObject([{ actor: "lead", authority: "lead", detail: { from: "active", status: "released" } }]);
    expect(ownerActions()).toMatchObject([{ action: "workspace.release", target: { key: `workspace:${clicked.workspaceId}` } }]);
    // 再释放一次什么都不改：回 already_released，不再记主人操作。
    const again = await runUiAction(db, { target: { type: "workspace", id: clicked.workspaceId }, action: "release", caller: user() });
    expect(again.result).toMatchObject({ status: "already_released" });
    expect(ownerActions()).toHaveLength(1);
  });

  it("makes cleaning an isolated worktree irreversible, Lead's to do with a confirmation, and agrees with the page's buttons", async () => {
    const isolated = doneTicketWorkspace({ isolated: true });
    const listed = await listLeadUiActions(db, { type: "workspace", id: isolated.workspaceId }, { turnId: null });
    expect(listed.actions.find((action) => action.id === "cleanup")).toMatchObject({
      permission: "user_only", irreversible: true, available: true, lead: "own", leadReady: true,
    });
    // 不可逆：没带 confirm 时什么都不做（两个入口一样）。
    const error = await runUiAction(db, { target: { type: "workspace", id: isolated.workspaceId }, action: "cleanup", caller: lead(), reason: "清掉" })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "needs_confirmation" });
    expect(getWorkspace(db, isolated.workspaceId)!.state).toBe("released");
    // 页面的按钮读同一个判断（controlForItem 的 availableActions）。
    const shared = doneTicketWorkspace();
    const buttons = createWorkspaceActionService(db).controlForItem(shared.itemId)!.availableActions;
    const actions = await listUiActions(db, { type: "workspace", id: shared.workspaceId });
    expect(buttons).toEqual(actions.filter((action) => action.available).map((action) => action.id));
    expect(buttons).toEqual(["release"]);
  });
});

describe("milestones (P04)", () => {
  it("lets Lead change a date the user set, and both entries write the same change history", async () => {
    const itemId = ready();
    const milestone = createMilestone(db, itemId, { kind: "due", at: "2099-11-01T09:00:00.000Z" }, { actor: "user" });
    await runUiAction(db, { target: { type: "milestone", id: milestone.id }, action: "update", input: { at: "2099-11-02T09:00:00.000Z" }, caller: user() });
    const moved = await runUiAction(db, {
      target: { type: "milestone", id: milestone.id }, action: "update", input: { at: "2099-11-03T09:00:00.000Z" },
      caller: lead("turn-lead"), reason: "客户把提测推了一天",
    });
    expect(moved).toMatchObject({ authority: "lead", forLead: { change: "moved", note: expect.stringContaining("用户定的") } });
    expect(getMilestone(db, milestone.id)!.at).toBe("2099-11-03T09:00:00.000Z");
    expect(performed(`milestone:${milestone.id}`)).toMatchObject([
      { actor: "user", detail: { change: "moved", overrodeUser: false } },
      { actor: "lead", authority: "lead", reason: "客户把提测推了一天", detail: { change: "moved", overrodeUser: true } },
    ]);
    const error = await runUiAction(db, { target: { type: "milestone", id: milestone.id }, action: "update", input: { at: "不是时间" }, caller: user() })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_input" });
  });
});

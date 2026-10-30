// 委派出去的工作一完成就马上告诉 Lead（2026-10-15 用户：「是的，完成后，马上通知 lead」）。
// 以前完成只攒到 Lead 的下一轮（最晚 30 分钟的心跳），还会直接推到 Slack。
// 工单对话的回答不算：用户在工单对话里直接看到它，失败另有说明叫醒 Lead。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, listInbox, openDb, raiseBlocker, transition, updateRun, type Db } from "@pi-lead-child/store";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";

import { createLeadInput } from "../src/lead-input.js";
import { recordRunFinished } from "../src/run-finished.js";

describe("a finished run", () => {
  it("wakes Lead at once with what finished and where the ticket is now, without marking the ticket as handled", async () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "claude", model: "opus" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff", runId });

    expect(recordRunFinished(db, { itemId })).toMatchObject({ woke: true });
    const [row] = listInbox(db, {});
    expect(row!.summary).toBe(`工单 #${itemId}「迁移脚本」的 Run #${runId}（执行）结束了，工单现在是 review`);
    expect(JSON.parse(row!.payload)).toMatchObject({ kind: "run_finished", runId, wakeLead: true, routine: true });
    // 完成不是异常：工单不显示「Lead 处理中」。
    const ticket = (await readGatewayTickets(db)).find((candidate) => candidate.id === itemId)!;
    expect(ticket.attention.leadHandling).toBeUndefined();
    db.close();
  });

  it("names the error when the run ended with one", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "failed", endedAt: true, exitCode: 1 });
    recordRunFinished(db, { itemId, error: new Error("unhandled run exception") });
    expect(listInbox(db, {})[0]!.summary).toBe(`工单 #${itemId}「部署」的 Run #${runId}（执行）出错结束：unhandled run exception`);
    db.close();
  });

  // 2026-10-19：Run 一结束就说一次（onChildEvent），pi 的进程停留 5 分钟以后退出时（onChildDone）不再说第二次。
  // daemon 重启接管同一个 Run 时也不再说（Run #106 在 07:12:45 又说了一次「工单现在是 done」）。
  it("tells Lead once per run, whichever of the two moments comes second", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const itemId = createItem(db, { title: "交付", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "pi" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });

    expect(recordRunFinished(db, { itemId, runId })).toMatchObject({ woke: true });
    expect(recordRunFinished(db, { itemId })).toMatchObject({ woke: false });
    expect(recordRunFinished(db, { itemId, runId })).toMatchObject({ woke: false });
    expect(listInbox(db, {})).toHaveLength(1);
    // 出错结束是另一件事：先说了「结束了」，宿主之后出错时仍然要说。
    expect(recordRunFinished(db, { itemId, error: new Error("unhandled run exception") })).toMatchObject({ woke: true });
    expect(listInbox(db, {})).toHaveLength(2);
    db.close();
  });

  it("says nothing for a run that has not ended, such as a paused one whose process exited", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const itemId = createItem(db, { title: "暂停", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "pi" });
    updateRun(db, runId, { state: "paused" });
    expect(recordRunFinished(db, { itemId, runId })).toMatchObject({ woke: false });
    expect(listInbox(db, {})).toEqual([]);
    db.close();
  });

  it("does not wake Lead for a ticket chat", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const itemId = createItem(db, { title: "问答", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, purpose: "conversation", runtime: "codex" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    expect(recordRunFinished(db, { itemId })).toMatchObject({ woke: false });
    expect(listInbox(db, {})).toEqual([]);
    db.close();
  });
});

// 2026-10-28、10-29：child 用 ticket_update 报阻塞，然后结束这一轮。阻塞（#369、#385）和 Run 结束（#370、#386）各一条，
// Lead 两条都要处置，第二条只能写「已知并已处理的事」。工单还停在 blocked 时，Run 结束的说明跟着同一个 Run 的 blocker 走。
describe("a run that ended after its blocker", () => {
  function blockedRun(db: Db): { itemId: number; runId: number; blockerId: number } {
    const itemId = createItem(db, { title: "升级 Pillow", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    transition(db, { itemId, to: "blocked", actor: "child", reason: "推送被沙箱拦住", runId });
    const blocker = raiseBlocker(db, {
      needsUser: false, itemId, runId, code: "blocked_checkpoint", title: "推送被沙箱拦住", summary: "分支没推",
      source: "semantic", dedupKey: `checkpoint:${runId}`,
    });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    return { itemId, runId, blockerId: blocker.inboxId! };
  }

  it("folds into the blocker when Lead has not taken it yet, so Lead handles one notice once", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const input = createLeadInput({ db });
    const { itemId, runId, blockerId } = blockedRun(db);

    expect(recordRunFinished(db, { itemId, runId })).toMatchObject({ woke: true });
    // 进程退出时（onChildDone）再调用一次：不再说第二次。
    expect(recordRunFinished(db, { itemId })).toMatchObject({ woke: false });
    expect(listInbox(db, {}).map((row) => row.id)).toEqual([blockerId]);

    input.beginRun("events");
    const taken = input.takeMessages();
    expect(taken.inboxIds).toEqual([blockerId]);
    expect(taken.text).toContain("推送被沙箱拦住");
    expect(taken.text).toContain(`Run #${runId}（执行）结束了，工单现在是 blocked`);
    input.endRun("succeeded");
    expect(input.pendingMessages()).toEqual([]);
    expect(listInbox(db, {}).map((row) => row.state)).toEqual(["consumed"]);
    db.close();
  });

  // Lead 已经拿到了 blocker（线上 #369 一升起就交给了 Lead，15 秒后 Run 才结束）：并进那一行会让它再交一次，
  // 所以 Run 结束照常记一行，但不叫醒 Lead，写进当前局面。
  it("does not wake Lead again when the blocker already reached Lead", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const input = createLeadInput({ db });
    const { itemId, runId, blockerId } = blockedRun(db);
    input.beginRun("events");
    expect(input.takeMessages().inboxIds).toEqual([blockerId]);

    recordRunFinished(db, { itemId, runId });
    input.endRun("succeeded");
    expect(input.pendingMessages()).toEqual([]);
    const finished = listInbox(db, {}).find((row) => row.id !== blockerId)!;
    expect(JSON.parse(finished.payload)).toMatchObject({ kind: "run_finished", runId, wakeLead: false, blockerInboxId: blockerId });
    input.beginRun("user");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain(`Run #${runId}（执行）结束了`);
    db.close();
  });

  it("still wakes Lead on its own once the ticket left blocked", () => {
    const db = openDb(join(tempDir("plc-run-finished-"), "plc.db"));
    const { itemId, runId } = blockedRun(db);
    transition(db, { itemId, to: "active", actor: "user", reason: "用户给了凭证" });

    recordRunFinished(db, { itemId, runId });
    const finished = listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "run_finished");
    expect(finished).toHaveLength(1);
    expect(JSON.parse(finished[0]!.payload)).toMatchObject({ wakeLead: true });
    db.close();
  });
});

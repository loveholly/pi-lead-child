// 新旧两条通路的对照（Lead 事件主干 spec D15，工单 04 第 5 项）。旧通路是 server.ts 里每一轮开头的 drainNotices
// 前缀和内存里的 childNotices（工单对话 Run 结束的说明）；新通路是事件游标：tell 级的事作为消息交给 Lead，
// 其余的进当前局面（每一轮输入开头的 situation 信封）。旧通路已经删掉，这里留着它的原样（oracle）：同样一组事件，旧通路给 Lead 的每一件事，
// 新通路都要给到。交给 Lead 处理的事（blocker、叫醒 Lead 的说明、到点的跟进）文字和旧通路一模一样。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leadInboxEvents, leadSystemEvent } from "@pi-lead-child/lead";
import {
  addInbox, addLeadFollowUp, addNotification, createItem, createRun, getItem, inboxDue, listInbox, openDb,
  recordDueLeadFollowUps, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import type { TicketSummary } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { recordRunFinished } from "../src/run-finished.js";
import { createLeadInput } from "../src/lead-input.js";

// ── 旧通路的原样（删掉之前 server.ts 的 drainNotices 和 onChildDone）────────────────────────────
function oldDrainNotices(db: Db, childNotices: string[], now: Date): string {
  const rows = listInbox(db, { state: ["pending", "delivered"] }).filter((row) => inboxDue(row, now));
  return [
    ...childNotices.map((note) => leadSystemEvent("child", note)),
    ...rows.flatMap(leadInboxEvents),
  ].join("\n");
}

function oldChildDone(db: Db, childNotices: string[], itemId: number): void {
  const t = getItem(db, itemId);
  const finished = recordRunFinished(db, { itemId });
  if (!finished.woke) childNotices.push(`[child] item #${itemId} 运行结束，状态: ${t?.stage}`);
}

function task(db: Db, title: string): number {
  return createItem(db, { title, brief: title, createdBy: "user", runtime: "codex" });
}

// 一组覆盖旧通路各种情况的事件。
function fixture(db: Db, childNotices: string[]) {
  // 1. 要用户或 Lead 决定的 blocker。
  const blocked = task(db, "部署");
  addInbox(db, {
    itemId: blocked, severity: "blocker", source: "structural", summary: `工单 #${blocked} 交接失败`,
    payload: { blockerCode: "handoff_failed", impact: "交付没有进待验收", nextStep: "重新交接", needsUser: false },
  });
  // 2. 执行 Run 结束：叫醒 Lead 的说明（recordRunFinished）。
  const executed = task(db, "整理周报");
  transition(db, { itemId: executed, to: "active", actor: "system", reason: "run started" });
  const execRun = createRun(db, { itemId: executed, runtime: "codex" });
  updateRun(db, execRun, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId: executed, to: "review", actor: "system", reason: "delivered" });
  oldChildDone(db, childNotices, executed);
  // 3. 不叫醒 Lead 的进展，同一个 scope 连着三条（合并成一行）。
  const progress = task(db, "迁移数据");
  for (const step of ["第一批迁完", "第二批迁完", "第三批迁完"]) {
    addInbox(db, { itemId: progress, severity: "attention", source: "structural", summary: `工单 #${progress} ${step}` });
  }
  // 4. 一小时里同一张工单多次 blocker：前两条各一行，第三条起熔断折叠。
  const noisy = task(db, "不稳定的测试");
  for (const attempt of [1, 2, 3, 4]) {
    addInbox(db, { itemId: noisy, severity: "blocker", source: "structural", summary: `工单 #${noisy} 第 ${attempt} 次崩溃` });
  }
  // 5. Lead 给自己设的跟进：一条到点了，一条还没到点。
  const followed = task(db, "等核查");
  addLeadFollowUp(db, { at: new Date(Date.now() - 60_000), note: "看核查恢复了没有", itemId: followed });
  addLeadFollowUp(db, { at: new Date(Date.now() + 3_600_000), note: "明天再看", itemId: followed });
  recordDueLeadFollowUps(db, new Date());
  // 6. 工单对话的 Run 结束：旧通路只放进内存里的 childNotices。
  const chatted = task(db, "问进展");
  transition(db, { itemId: chatted, to: "active", actor: "system", reason: "run started" });
  const chatRun = createRun(db, { itemId: chatted, runtime: "codex", purpose: "conversation" });
  updateRun(db, chatRun, { state: "finished", endedAt: true, exitCode: 0 });
  oldChildDone(db, childNotices, chatted);
  // 7. 可批量的通知：旧通路从来不给 Lead（spec Problem Statement），新通路放进当前局面。
  addNotification(db, { kind: "budget", urgency: "batchable", title: "本周预算用了 80%", createdAt: new Date().toISOString() });
  return { blocked, executed, progress, noisy, followed, chatted };
}

const NOTICE_ID = /通知 #(\d+)/gu;

describe("the cursor path against the old drainNotices and childNotices", () => {
  it("gives Lead every thing the old path gave it, with the same text for what Lead must act on", async () => {
    const db = openDb(join(tempDir("plc-lead-input-parity-"), "plc.db"));
    let tickets: TicketSummary[] = [];
    // 新通路先起来（游标落在空的日志上），之后的事件都在游标后面：和 daemon 运行中收到它们一样。
    const input = createLeadInput({ db, tickets: () => tickets });
    const childNotices: string[] = [];
    const ids = fixture(db, childNotices);
    tickets = await readGatewayTickets(db);

    const old = oldDrainNotices(db, childNotices, new Date());
    input.beginRun("events");
    const messages = input.takeMessages();
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    const fresh = `${messages.text}\n${situation}`;

    // 旧通路交给 Lead 的每一行 inbox（按编号），新通路都给了。
    const oldIds = new Set([...old.matchAll(NOTICE_ID)].map((match) => match[1]));
    const newIds = new Set([...fresh.matchAll(NOTICE_ID)].map((match) => match[1]));
    expect(oldIds.size).toBeGreaterThan(0);
    for (const id of oldIds) expect(newIds, `通知 #${id}`).toContain(id);
    // 每一条摘要（合并、熔断进来的也算）都在。
    for (const row of listInbox(db)) {
      if (!old.includes(row.summary)) continue;
      expect(fresh, row.summary).toContain(row.summary);
    }
    for (const step of ["第一批迁完", "第二批迁完", "第三批迁完", "第 1 次崩溃", "第 2 次崩溃", "第 3 次崩溃"]) {
      expect(fresh).toContain(step);
    }
    // 要 Lead 处理的事（tell 级）：新通路作为消息给，文字和旧通路的同一行一模一样。
    for (const row of listInbox(db).filter((candidate) => messages.inboxIds.includes(candidate.id))) {
      for (const block of leadInboxEvents(row)) expect(messages.text).toContain(block);
    }
    expect(messages.text).toContain("交接失败");
    expect(messages.text).toContain("影响：交付没有进待验收");
    expect(messages.text).toContain("看核查恢复了没有");
    // childNotices 说的事（工单对话 Run 结束、工单现在的阶段）新通路也说了。
    expect(childNotices).toEqual([`[child] item #${ids.chatted} 运行结束，状态: active`]);
    expect(situation).toMatch(new RegExp(`#${ids.chatted}[^\\n]*Run #\\d+[^\\n]*结束`, "u"));
    expect(situation).toMatch(new RegExp(`#${ids.chatted}[^\\n]*active`, "u"));
    // 新通路多给的：可批量的通知（旧通路从来不给 Lead），没到点的跟进不当成要处理的事。
    expect(old).not.toContain("本周预算用了 80%");
    expect(situation).toContain("本周预算用了 80%");
    expect(messages.text).not.toContain("明天再看");
    db.close();
  });
});

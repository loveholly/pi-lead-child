// 「需要你」只有一条规则（protocol 的 ticketNeedsUser）。用户在 App 里看到的数（GET /v1/tickets
// 投出来的 TicketSummary 过这条规则）和 Lead 回答"现在有什么要我处理"时用的工具，必须是同一组工单。
// 实例上 Lead 自己查 review 和 blocked，说"5 张"；App 的底栏是 3，收件箱是 4。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { ticketNeedsUser, ticketNeedsUserLabel, ticketsNeedingUser } from "@pi-lead-child/protocol";
import { createItem, createRun, listInbox, markInbox, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";
import { createCoordinator } from "@pi-lead-child/engine";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-needs-user-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
});

function task(title: string, extra: Partial<Parameters<typeof createItem>[1]> = {}): number {
  return createItem(db, { title, brief: title, createdBy: "user", runtime: "claude", ...extra });
}

function blocked(itemId: number): number {
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  transition(db, { itemId, to: "blocked", actor: "system", reason: "run crashed" });
  return itemId;
}

// 像 #66：交付 Run 结束、进了 review，没有任何核查在路上。
function strandedInReview(): number {
  const itemId = task("stranded delivery", { verificationPolicy: "independent_reviewer" });
  transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
  const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "system", runId, reason: "delivered" });
  return itemId;
}

function seedLikeTheLiveInstance() {
  const stuckReview = strandedInReview();
  const blockedRoot = blocked(task("blocked root"));
  const doneParent = task("finished parent");
  transition(db, { itemId: doneParent, to: "active", actor: "system", reason: "run started" });
  transition(db, { itemId: doneParent, to: "review", actor: "system", reason: "delivered" });
  transition(db, { itemId: doneParent, to: "done", actor: "user", reason: "accepted" });
  const blockedChild = blocked(createItem(db, {
    title: "blocked child", brief: "child", createdBy: "lead", parentItemId: doneParent, runtime: "claude",
  }));
  const draft = task("draft", { createdBy: "lead", hold: true });
  task("ready, not started");
  const reminder = createItem(db, {
    title: "a reminder that went off", brief: "", createdBy: "user", kind: "reminder",
    remindAt: new Date(Date.now() - 60_000).toISOString(),
  });
  transition(db, { itemId: reminder, to: "fired", actor: "system", reason: "remind_at reached" });
  return { stuckReview, blockedRoot, blockedChild, draft };
}

describe("what needs the user", () => {
  it("is the same set of tickets for the app and for Lead's list_needs_user tool", async () => {
    const seeded = seedLikeTheLiveInstance();
    let tools: ReturnType<typeof createLeadTools> = [];
    const factory = async (args: LeadDeps) => {
      tools = createLeadTools({ ...args, db, dbPath, dataDir: dir });
      return {
        modelName: "stub/model",
        session: {
          sessionId: "stub-session",
          subscribe: () => () => {},
          prompt: async () => {},
          steer: async () => {},
          followUp: async () => {},
          dispose: () => {},
        },
      };
    };
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: factory as never, log: () => {} });

    const appTickets = ticketsNeedingUser(await readGatewayTickets(db));
    const appIds = appTickets.map((ticket) => ticket.id).sort((a, b) => a - b);
    expect(appIds).toEqual(
      [seeded.stuckReview, seeded.blockedRoot, seeded.blockedChild, seeded.draft].sort((a, b) => a - b),
    );

    const tool = tools.find((candidate) => candidate.name === "list_needs_user");
    expect(tool, "Lead has a tool for 'what needs me'").toBeDefined();
    const result = await tool!.execute("call-1", {}, undefined, undefined, undefined as never);
    const text = result.content.map((part: { type: string; text?: string }) => part.text ?? "").join("\n");
    const leadIds = [...text.matchAll(/^#(\d+)/gm)].map((match) => Number(match[1])).sort((a, b) => a - b);
    expect(leadIds).toEqual(appIds);
    // 每张工单的原因也和 App 一样。
    for (const ticket of appTickets) {
      const line = text.split("\n").find((candidate) => candidate.startsWith(`#${ticket.id} `));
      expect(line).toContain(`— ${ticketNeedsUserLabel(ticketNeedsUser(ticket)!)}`);
    }
  });
});

describe("a pending blocking decision", () => {
  // 发布评审 2340cac 的发现 C：blockerCount 只数 pending、delivered 的 inbox 行，ensureAuthorityInbox 也不会重建
  // 已消费的行。child 的 request_decision(blocking) 在 Lead 的那一轮消费掉它的 inbox 行以后，就从"需要你"里消失了，
  // 15 分钟后才以"停滞"回来。没回答之前，它一直算"需要你"。
  it("counts as needing you until it is answered, also after Lead consumed its inbox row", async () => {
    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({ title: "迁移方案", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "running" });
    const request = coordinator.requestDecision({
      itemId, runId, kind: "decision", audience: "lead_or_user", blocking: true, allowCustom: false,
      prompt: "用哪种兼容模式？", options: [{ id: "strict", label: "严格" }, { id: "additive", label: "增量" }],
      checkpoint: { title: "需要决定兼容模式", summary: "实现卡在兼容策略上。", nextStep: "按选定的模式继续。" },
    });
    const summary = async () => (await readGatewayTickets(db)).find((ticket) => ticket.id === itemId)!;
    // 2026-10-16 起原因是「待你决定」（attention.pendingDecisionCount），不再是笼统的「需介入」。
    expect(ticketNeedsUser(await summary())).toBe("decision");

    // Lead 的一轮把这条 inbox 行消化掉了（drainNotices → consumed），决策还没有人回答。
    markInbox(db, listInbox(db, {}).filter((row) => row.item_id === itemId).map((row) => row.id), "consumed");
    expect((await summary()).attention).toMatchObject({ blockerCount: 1, pendingDecisionCount: 1 });
    expect(ticketNeedsUser(await summary())).toBe("decision");

    coordinator.resolveDecision({
      requestId: request.requestId, decision: "select", optionId: "strict",
      actor: { kind: "lead", resolvedBy: "lead" },
    });
    expect((await summary()).attention.blockerCount).toBe(0);
    expect((await summary()).attention).not.toHaveProperty("pendingDecisionCount");
  });
});

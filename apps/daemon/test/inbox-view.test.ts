// 收件箱（阶段 1）走完整的持久化路径：工单、阻塞记录、Lead 的处置写进库，经 gateway 的 GET /v1/inbox 读出来。
// 用户看到的是这一跳：每张等你的工单说清为什么在等、从什么时候开始；Lead 自己处理掉的事按一次处置合成一条。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ticketsNeedingUser } from "@pi-lead-child/protocol";
import { addInbox, createItem, insertCheckpoint, markInbox, openDb, recordInboxDisposition, transition, type Db } from "@pi-lead-child/store";
import { markGatewayInboxSeen, readGatewayInbox, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-inbox-view-"), "plc.db"));
});

describe("the inbox through the gateway", () => {
  it("explains every ticket that waits for you and lists what Lead handled", async () => {
    const blocked = createItem(db, { title: "修复 review 状态投影", brief: "b", createdBy: "user", runtime: "claude" });
    transition(db, { itemId: blocked, to: "active", actor: "system", reason: "run started" });
    transition(db, { itemId: blocked, to: "blocked", actor: "system", reason: "run crashed" });
    insertCheckpoint(db, {
      itemId: blocked, runId: null, source: "system_derived", kind: "blocked", title: "Agent Run 未捕获异常",
      summary: "Run #54 交付的成果格式不合法", nextStep: "修好后重跑", idempotencyKey: "inbox-view:72",
    });
    createItem(db, { title: "还在排队", brief: "b", createdBy: "user", runtime: "claude" });

    const fixed = createItem(db, { title: "成果快照与登记机制", brief: "b", createdBy: "user", runtime: "claude" });
    const events = [1, 2, 3].map(() => addInbox(db, {
      itemId: fixed, severity: "blocker", source: "structural", summary: "核查失败：Codex 不支持 gpt-5.5", lossless: true,
    }).id!);
    recordInboxDisposition(db, events, {
      disposition: "handled", reason: "核查换成 Claude Code",
      cause: "Codex（ChatGPT 账号）不支持 gpt-5.5", action: "用 Claude Code 重派核查", followUp: "模型目录自动发现",
    });
    // Lead 那一轮把这些事消化掉了（和真实流程一样），它们不再算这张工单的 blocker。
    markInbox(db, events, "consumed");

    const inbox = await readGatewayInbox(db);
    const needsYou = ticketsNeedingUser(await readGatewayTickets(db)).map((ticket) => ticket.id);

    // 和角标同一组工单，每张都有原因。
    expect(inbox.tickets.map((fact) => fact.ticketId)).toEqual(needsYou);
    expect(inbox.tickets).toEqual([expect.objectContaining({ ticketId: blocked, reason: "Run #54 交付的成果格式不合法" })]);
    expect(inbox.leadHandled).toEqual([expect.objectContaining({
      ticketId: fixed, problem: "核查失败：Codex 不支持 gpt-5.5", cause: "Codex（ChatGPT 账号）不支持 gpt-5.5",
      action: "用 Claude Code 重派核查", followUp: "模型目录自动发现", eventCount: 3,
    })]);
  });

  it("remembers when you last looked, so only what Lead handled after that shows as new", async () => {
    expect((await readGatewayInbox(db)).seenAt).toBeNull();
    const seenAt = await markGatewayInboxSeen(db);
    expect((await readGatewayInbox(db)).seenAt).toBe(seenAt);
  });
});

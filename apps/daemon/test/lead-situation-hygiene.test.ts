// Lead 的上下文卫生（2026-10-19）：审查期间 Lead 的当前局面里每一轮都列着 8 月的旧工单，10 分钟内上下文压缩了 3 次。
//   · 长期没有动静的工单折叠成一行，只列编号（阈值可以配置，缺省 3 天）。等用户、有 blocker、在跑的工单不折叠。
//   · 你在等的用户操作（lead_waits）列在当前局面里，Lead 不用自己记。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import type { TicketSummary } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, openDb, registerLeadWait } from "@pi-lead-child/store";
import { createLeadInput, DEFAULT_IDLE_TICKET_MS, ticketIsIdle } from "../src/lead-input.js";

const DAY = 86_400_000;

function aged(ticket: TicketSummary, ms: number): TicketSummary {
  const at = new Date(Date.now() - ms).toISOString();
  return { ...ticket, updatedAt: at, stageChangedAt: at, runtime: { ...ticket.runtime, lastActivityAt: null } };
}

describe("tickets with no activity for a long time", () => {
  it("are idle after the threshold unless they need the user, have a blocker, or have a run going", () => {
    const now = new Date();
    const base = {
      updatedAt: new Date(now.getTime() - 5 * DAY).toISOString(), stage: "ready",
      runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    } as unknown as TicketSummary;
    expect(ticketIsIdle(base, now, DEFAULT_IDLE_TICKET_MS)).toBe(true);
    expect(ticketIsIdle(base, now, 7 * DAY)).toBe(false);
    expect(ticketIsIdle({ ...base, runtime: { ...base.runtime, lastActivityAt: now.toISOString() } }, now, DEFAULT_IDLE_TICKET_MS)).toBe(false);
    expect(ticketIsIdle({ ...base, runtime: { ...base.runtime, activeAttemptId: 3 } }, now, DEFAULT_IDLE_TICKET_MS)).toBe(false);
    expect(ticketIsIdle({ ...base, attention: { ...base.attention, blockerCount: 1 } }, now, DEFAULT_IDLE_TICKET_MS)).toBe(false);
  });

  it("fold into one line of ticket numbers in Lead's situation, which stays the same from turn to turn", async () => {
    const db = openDb(join(tempDir("plc-situation-hygiene-"), "plc.db"));
    const fresh = createItem(db, { title: "今天的工单", brief: "b", createdBy: "user" });
    const old1 = createItem(db, { title: "八月的旧工单甲", brief: "b", createdBy: "user" });
    const old2 = createItem(db, { title: "八月的旧工单乙", brief: "b", createdBy: "user" });
    const read = await readGatewayTickets(db);
    const tickets = read.map((ticket) => (ticket.id === fresh ? ticket : aged(ticket, 60 * DAY)));
    const input = createLeadInput({ db, tickets: () => tickets, idleTicketMs: 7 * DAY });

    input.beginRun("events");
    const first = input.renderSituation({ queuedUserMessages: 0 });
    input.endRun("succeeded");
    expect(first).toContain(`#${fresh}「今天的工单」`);
    expect(first).not.toContain("八月的旧工单");
    expect(first).toContain(`另有 2 张超过 7 天没有动静的工单，折叠成这一行：#${old1}、#${old2}`);

    // 下一轮什么都没变：只写一行「没有变化」，折叠的那一行不让它每一轮都变。
    input.beginRun("events");
    expect(input.renderSituation({ queuedUserMessages: 0 })).toContain("和上一次的当前局面一样，没有变化");
    input.endRun("succeeded");
  });
});

describe("the waits Lead has open", () => {
  it("are listed in the situation with their notes and timeouts", () => {
    const db = openDb(join(tempDir("plc-situation-waits-"), "plc.db"));
    const { wait } = registerLeadWait(db, { entityKey: "connection:github", note: "授权完成后发 PR #101 的行内评论", origin: "tool:call_connection_tool" });
    const input = createLeadInput({ db });
    input.beginRun("events");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain("你在等的用户操作");
    expect(situation).toContain(`等待 #${wait.id}：connection:github，授权完成后发 PR #101 的行内评论`);
  });
});

// 项目卡片（左栏改版阶段 2）走完整的持久化路径：项目、工单、Lead 的一句话写进库，经 gateway 的 HTTP 接口读出来；
// 归档也走 HTTP。卡片的分布和按项目筛选后的工单 tab 是同一组工单（ticketTurn）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ticketTurn } from "@pi-lead-child/protocol";
import { createItem, createProject, openDb, updateProjectSummary, type Db } from "@pi-lead-child/store";
import { archiveGatewayProject, readGatewayProjectsOverview, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-project-overview-"), "plc.db"));
});

describe("the project cards through the gateway", () => {
  it("count the same tickets as the ticket tab, show Lead's line, and archive a project", async () => {
    const projectId = createProject(db, { name: "pi-lead-child", createdBy: "lead" });
    const blocked = createItem(db, { title: "修复 review 状态投影", brief: "b", createdBy: "user", project: "pi-lead-child", projectId });
    db.prepare("UPDATE items SET stage = 'blocked' WHERE id = ?").run(blocked);
    createItem(db, { title: "排队", brief: "b", createdBy: "user", project: "pi-lead-child", projectId });
    updateProjectSummary(db, projectId, { summary: "卡在 #72 的 review 投影", actor: "lead", reason: "r" });
    const e2e = createProject(db, { name: "pi-lead-child-e2e", createdBy: "lead" });

    const [main] = await readGatewayProjectsOverview(db);
    const tickets = (await readGatewayTickets(db)).filter((ticket) => ticket.project === "pi-lead-child");
    const byTurn = (turn: string) => tickets.filter((ticket) => ticketTurn(ticket) === turn).length;
    expect(main).toMatchObject({ name: "pi-lead-child", leadStatus: { text: "卡在 #72 的 review 投影" } });
    expect(main!.counts).toEqual({
      user: byTurn("user"), running: byTurn("running"), lead: byTurn("lead"), queued: byTurn("queued"), ended: byTurn("ended"),
    });

    await archiveGatewayProject(db, e2e);
    expect((await readGatewayProjectsOverview(db)).find((project) => project.id === String(e2e))?.status).toBe("archived");
  });
});

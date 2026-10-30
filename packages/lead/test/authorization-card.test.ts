// 兜底授权卡（用户 2026-10-29：「你起码要让 lead agent 有能力处理，最差最差没考虑到的场景应该弹一个授权卡给我授权 lead 处理」）。
// 以前工单操作被拦下就是死路，Lead 只能请用户去工单详情里点；沙箱里做不了的事只能把命令发给用户粘到终端里。
// 现在系统存下这一个操作，Lead 拿到确认卡的 user_action。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getRuleChangeConfirmation } from "@pi-lead-child/engine";
import { createItem, getItem, openDb, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

let db: Db;
let deps: LeadDeps;
let dir: string;
const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
// Slack 消息叫醒的一轮。
const slackTurn: LeadTurnOrigin = { external: true, timer: null, externalBy: [{ via: "message", source: "slack" }], externalEvents: [3] };

beforeEach(() => {
  dir = tempDir("plc-authorization-card-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => null, turnOrigin: () => slackTurn };
});

describe("a ticket action Lead cannot do in this turn", () => {
  it("comes back with a confirm card for exactly that action, and changes nothing yet", async () => {
    const itemId = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    const result = await tool("ticket_action").execute("t", { ticket_id: itemId, action: "confirm", reason: "Slack 里说可以开工" });
    expect(result.isError).toBe(true);
    expect(result.details.userAction).toMatchObject({ kind: "confirm_rule_change", target: expect.stringMatching(/^rule_change:/) });
    const id = String(result.details.userAction.target).slice("rule_change:".length);
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({
      state: "pending", operation: { kind: "lead_tool", tool: "ticket_action" },
      params: expect.arrayContaining([{ name: "ticket_id", value: String(itemId) }, { name: "action", value: "confirm" }]),
    });
    expect(getItem(db, itemId)!.stage).toBe("draft");
  });
});

describe("run_on_host", () => {
  it("only asks: nothing runs until the user confirms the card", async () => {
    const marker = join(dir, "ran.txt");
    const result = await tool("run_on_host").execute("t", { command: `touch ${marker}`, cwd: dir, reason: "沙箱里没有权限" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ refused: true, kind: "needs_authorization", user_action: { kind: "confirm_rule_change" } });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("list_processes", () => {
  it("reads the process table outside the sandbox and keeps the full list in Lead's scratch dir", async () => {
    const result = await tool("list_processes").execute("t", { match: "node", limit: 5 });
    const text = result.content[0].text as string;
    expect(text).toMatch(/共 \d+ 个进程/);
    const path = /全文在 (\S+?)。/.exec(text)?.[1];
    expect(path && existsSync(path)).toBe(true);
  });
});

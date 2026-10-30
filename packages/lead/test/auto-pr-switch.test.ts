// 「先别提 PR」落库（用户 2026-10-26）：交付以后系统缺省自动开草稿 PR。用户说先别提时，Lead 在建单时传 draft_pr=false，
// 或者之后用 ticket_action(action='set_auto_pr') 关掉；这两条路和系统读的是同一个开关（engine 的 autoPullRequestEnabled）。
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { autoPullRequestEnabled } from "@pi-lead-child/engine";
import { getItem, isLightTask, openDb, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;

function tool(name: string): any {
  return createLeadTools(deps).find((candidate: any) => candidate.name === name);
}

function createdId(text: string): number {
  return Number(/created task #(\d+)/.exec(text)![1]);
}

beforeEach(() => {
  const dir = tempDir("plc-auto-pr-switch-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
});

describe("the auto draft PR switch", () => {
  it("is on by default and off when Lead creates the ticket with draft_pr=false", async () => {
    const plain = createdId((await tool("create_task").execute("t", { title: "改代码", brief: "b" })).content[0].text);
    const local = createdId((await tool("create_task").execute("t", { title: "只在本地看", brief: "b", draft_pr: false })).content[0].text);
    expect(autoPullRequestEnabled(db, plain)).toBe(true);
    expect(autoPullRequestEnabled(db, local)).toBe(false);
  });

  it("can be turned off and on again with ticket_action set_auto_pr", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改代码", brief: "b" })).content[0].text);
    const set = async (enabled: boolean) => JSON.parse((await tool("ticket_action").execute("t", {
      ticket_id: id, action: "set_auto_pr", input: { enabled }, reason: enabled ? "用户说可以提了" : "用户说先别提 PR",
    })).content[0].text);
    expect((await set(false)).result).toEqual({ enabled: false, changed: true });
    expect(autoPullRequestEnabled(db, id)).toBe(false);
    expect((await set(false)).result).toEqual({ enabled: false, changed: false });
    expect((await set(true)).result).toEqual({ enabled: true, changed: true });
    expect(autoPullRequestEnabled(db, id)).toBe(true);
  });
});

// lead-tools-and-routing spec D9：轻子 agent 不改代码、不需要验收：不开 PR，Lead 读结果（lead_static），不能 hold。
describe("a light sub-agent ticket", () => {
  it("is marked light, opens no PR and is checked by Lead from its result", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "评审 PR #217", brief: "b", light: true })).content[0].text);
    expect(isLightTask(db, id)).toBe(true);
    expect(autoPullRequestEnabled(db, id)).toBe(false);
    expect(getItem(db, id)!.verification_policy).toBe("lead_static");
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  // 没给 workdir 时不在 daemon 的当前目录（部署用的主 checkout）里跑：系统给它一个自己的目录。
  it("gets a directory of its own under the data dir when Lead gives no workdir, and keeps a given one", async () => {
    const own = createdId((await tool("create_task").execute("t", { title: "市场调查", brief: "b", light: true })).content[0].text);
    const workdir = getItem(db, own)!.workdir!;
    expect(workdir.startsWith(join(deps.dataDir, "light-tasks"))).toBe(true);
    expect(existsSync(workdir)).toBe(true);
    const repo = tempDir("plc-light-repo-");
    const given = createdId((await tool("create_task").execute("t", { title: "评审", brief: "b", light: true, workdir: repo })).content[0].text);
    expect(getItem(db, given)!.workdir).toBe(repo);
  });

  it("cannot be held: it is dispatched as soon as it is created", async () => {
    await expect(tool("create_task").execute("t", { title: "调研", brief: "b", light: true, hold: true }))
      .rejects.toThrow(/不能和 hold 一起用/);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getRun, listRuns } from "@pi-lead-child/store";
import { liveChildren } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, runningChildren, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let itemId: number;

function tool(name: string) {
  return createLeadTools(deps).find((t: any) => t.name === name) as any;
}

beforeEach(() => {
  const dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "1200"; // 短 linger 供测试
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
  };
});

afterEach(async () => {
  await liveChildren().get(itemId)?.handle?.interrupt("test cleanup");
  await Promise.allSettled([...runningChildren().values()]);
  db.close();
});

// linger 期间的 child：这一轮已经结束，Run 记为 finished，进程只是在停留。
async function lingeringChild(): Promise<number> {
  await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId });
  await vi.waitFor(() => expect(liveChildren().get(itemId)?.settled).toBe(true), { timeout: 10_000 });
  const runId = liveChildren().get(itemId)!.runId;
  expect(getRun(db, runId)!.state).toBe("finished");
  return runId;
}

function messageTexts(runId: number): string[] {
  return (db.prepare(
    "SELECT payload FROM runtime_events WHERE run_id=? AND event_type='message.completed' ORDER BY seq",
  ).all(runId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload).text as string);
}

describe("child linger (M4)", () => {
  it("keeps child alive after agent_end, then reaps on timeout", async () => {
    const done = vi.fn();
    deps.onChildDone = done;
    await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId });
    // fake-pi happy 场景立即 agent_end，工单留在 active → 应 linger 而非退出
    await vi.waitFor(() => expect(liveChildren().get(itemId)?.settled).toBe(true), { timeout: 5000 });
    expect(liveChildren().get(itemId)!.streaming).toBe(false);
    expect(done).not.toHaveBeenCalled();

    // linger 到期，child 退出
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(liveChildren().has(itemId)).toBe(false);
  }, 15000);
});

// 工单 #93 的 Run #106（2026-10-19）：Run 的这一轮结束后，Lead 用 continue_ticket_agent 把一条指令发进还在停留的进程。
// 那个 Run 已经结束：新一轮的事件不再落库，agent 的交接工具因为「Run 已结束」被拒，agent 就直接改了数据库。
// 现在：这一轮已经结束的 child 不再接收新指令。系统先停止它，再开一个新的 Run 续接它的会话。
describe("a new instruction after the turn ended", () => {
  beforeEach(() => {
    process.env.PLC_CHILD_LINGER_MS = "60000";
  });

  it("continue_ticket_agent starts a new run on the same session instead of prompting the finished one", async () => {
    const firstRunId = await lingeringChild();

    const result = JSON.parse((await tool("continue_ticket_agent").execute("t", {
      ticket_id: itemId, instruction: "按要求重新提交交接",
    })).content[0].text);

    expect(result.mode).not.toBe("live");
    expect(result.runId).not.toBe(firstRunId);
    expect(result.resumedFromRunId).toBe(firstRunId);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });

    // 第一个 Run 保持结束，没有被新的一轮改写；新的一轮有自己的 Run，它的回答落了库。
    expect(getRun(db, firstRunId)).toMatchObject({ state: "finished" });
    expect(listRuns(db, itemId).map((run) => [run.id, run.purpose, run.state, run.resumed_from_run_id])).toEqual([
      [firstRunId, "execution", "finished", null],
      [result.runId, "conversation", "finished", firstRunId],
    ]);
    expect(messageTexts(result.runId)).toEqual([expect.stringMatching(/^done: /)]);
    expect(messageTexts(firstRunId)).toHaveLength(1);
  }, 30_000);

  it("steer_child does the same for a child whose turn already ended", async () => {
    const firstRunId = await lingeringChild();

    const res = await tool("steer_child").execute("t", { ticket_id: itemId, instruction: "再补充一点" });

    const newRun = listRuns(db, itemId).find((run) => run.id !== firstRunId);
    expect(newRun).toMatchObject({ purpose: "conversation", resumed_from_run_id: firstRunId });
    expect(res.content[0].text).toContain(`Run #${newRun!.id}`);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 15_000 });
    expect(getRun(db, firstRunId)).toMatchObject({ state: "finished" });
    expect(messageTexts(newRun!.id)).toEqual([expect.stringMatching(/^done: /)]);
  }, 30_000);
});

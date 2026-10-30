import { describe, it, expect, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { liveChildren } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, runningChildren, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;
let deps: LeadDeps;

function tool(name: string) {
  return createLeadTools(deps).find((t: any) => t.name === name) as any;
}

beforeEach(() => {
  dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    env: { FAKE_SCENARIO: "slow" },
  };
});

async function spawnSlow(itemId: number, done: any) {
  deps.onChildDone = done;
  // slow 场景经 childPi 传递：runItem 的 env 通过 deps 注入。
  // 必须等到 agent_start（streaming=true）——仅等注册会在 steer 时踩到"尚未开跑"的窗口
  await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: itemId });
  await vi.waitFor(
    () => expect(liveChildren().get(itemId)?.streaming).toBe(true),
    { timeout: 10_000 },
  );
}

// stop_child 在 2026-10-28 删掉了：停下整张工单是 ticket_action 的 stop，同一个操作。
describe("steer_child / ticket_action stop", () => {
  it("steers a live child and records activity", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const done = vi.fn();
    await spawnSlow(id, done);
    const res = await tool("steer_child").execute("t", { ticket_id: id, instruction: "换个方向" });
    expect(res.content[0].text).toContain("注入指令");
    expect(listActivities(db, id).some((a) => a.kind === "comment" && a.payload.includes("换个方向"))).toBe(true);
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
  });

  // 用户 2026-10-22（ui-action-parity P03）：Lead 的停下和页面的「停下」是同一个操作，工单回到 ready，不再转 blocked。
  it("stops a live child: run=stopped (not failed), item back to ready like the page's stop", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const done = vi.fn();
    await spawnSlow(id, done);
    const runId = liveChildren().get(id)!.runId;
    await tool("ticket_action").execute("t", { ticket_id: id, action: "stop", reason: "方向错误" });
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(getRun(db, runId)!.state).toBe("stopped");
    expect(getItem(db, id)!.stage).toBe("ready");
    expect(listActivities(db, id).some((a) => a.kind === "decision")).toBe(true);
    expect(listActivities(db, id).filter((a) => a.kind === "transition").at(-1)).toMatchObject({ actor: "lead" });
    expect(listActivities(db, id).some((a) => a.kind === "crash")).toBe(false);
  });

  it("both error when no live child", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    await expect(tool("steer_child").execute("t", { ticket_id: id, instruction: "x" }))
      .rejects.toThrow(/没有存活的 child/);
    await expect(tool("ticket_action").execute("t", { ticket_id: id, action: "stop", reason: "x" }))
      .rejects.toThrow(/没有在执行/);
  });
});

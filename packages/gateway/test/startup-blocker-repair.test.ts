// 启动修复 repairMissingBlockerAlerts 给停在 blocked、却没收到 blocker 的工单补发一条。
// 崩溃、交接失败、登记待处理这几条路径，检查点和它的 blocker 用同一个键（例如 run-crash:<runId>）。
// 修复却按 checkpoint:<id> 去重，所以每次重启都给这些工单多发一条 blocker 和通知（最终审计，高影响 2）。
// 重启现在是常规操作（工单 15），这个重复会反复出现。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentToolHandlers, runItem } from "@pi-lead-child/engine";
import { createRun, raiseBlockerFromCheckpoint, repairMissingBlockerAlerts, transition, updateRun } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createItem, getItem } from "@pi-lead-child/store";
import { insertCheckpoint } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { readGatewayNotifications } from "../testing/gateway-reader.js";
import { ReplayRuntime, type RecordedRun } from "@pi-lead-child/runtime/testing";

const crash: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "run.failed", exitCode: 1, errorCode: "process_exit", error: "Codex exited with code 1" },
  ],
};
// 正常结束，但没有调用 ticket_update：运行结束，交接失败。
const handoffMissed: RecordedRun = {
  runtime: "codex",
  events: [
    { type: "run.started", runtime: "codex", model: "gpt-5.5" },
    { type: "message.completed", messageId: "m-1", role: "assistant", text: "done" },
    { type: "run.completed", exitCode: 0 },
  ],
};

let db: Db;
let dir: string;
beforeEach(() => {
  dir = tempDir("plc-startup-blocker-");
  db = openDb(join(dir, "plc.db"));
  // 只看交接失败本身的 blocker，不让修复回合（工单 09）参与。
  vi.stubEnv("PLC_OUTCOME_REPAIR_LIMIT", "0");
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

async function blockedBy(recording: RecordedRun): Promise<number> {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
  await runItem(db, itemId, {
    dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
    prompt: "work", runtime: new ReplayRuntime(recording), lingerMs: 0,
  });
  expect(getItem(db, itemId)?.stage).toBe("blocked");
  return itemId;
}

const blockerCount = (itemId: number): number =>
  listInbox(db, { severity: "blocker" }).filter((row) => row.item_id === itemId).length;
const noticeCount = async (itemId: number): Promise<number> =>
  (await readGatewayNotifications(db)).filter((notice) => notice.ticketId === itemId).length;

describe("startup repair of blocker alerts", () => {
  it.each([
    ["a crash", crash],
    ["a missed handoff", handoffMissed],
  ])("adds no second blocker for a ticket blocked by %s", async (_label, recording) => {
    const itemId = await blockedBy(recording);
    const blockers = blockerCount(itemId);
    const notices = await noticeCount(itemId);
    expect(blockers).toBe(1);

    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(blockerCount(itemId)).toBe(blockers);
    expect(await noticeCount(itemId)).toBe(notices);
  });

  // 修复原本的用途保持不变：没有 blocker 的 blocked 检查点照样补发一条。
  it("still raises a blocker for a blocked checkpoint that never got one", () => {
    const itemId = createItem(db, { title: "legacy", brief: "b", createdBy: "user" });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(itemId);
    insertCheckpoint(db, {
      itemId, runId: null, source: "system_derived", kind: "blocked",
      title: "legacy blocked", summary: "blocked before blockers existed", nextStep: "请用户确认下一步。",
      idempotencyKey: "legacy:1",
    });
    expect(repairMissingBlockerAlerts(db)).toBe(1);
    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(blockerCount(itemId)).toBe(1);
  });

  // 2026-10-28 21:31 和 10-29 12:16 两次重启后，#154、#156、#159 的旧阻塞又交给了 Lead 一次（#366、#367、#433）。
  // child 用 ticket_update 报阻塞时，blocker 的键是 ticket-update:<检查点 id>；修复按 checkpoint:<检查点 id> 去重，认不出它。
  it("adds no second blocker for a ticket that a child blocked with ticket_update", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user", workdir: dir });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const tools = createAgentToolHandlers({ db, itemId, runId, dataDir: dir });
    await tools.call("ticket_update", {
      status: "blocked",
      checkpoint: {
        kind: "blocked", stage: "implementation", title: "拿不到最新 master", summary: "rebase 卡住",
        key_facts: [], artifact_refs: [], related_ticket_ids: [], next_step: "给沙箱 GitHub 凭证。",
      },
    });
    expect(getItem(db, itemId)?.stage).toBe("blocked");
    expect(blockerCount(itemId)).toBe(1);

    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(blockerCount(itemId)).toBe(1);
  });

  // 上线前已经写下的 blocker 还带着旧的 ticket-update:<id> 键：重启时同样认得它。
  it("recognises a blocker raised before the fix under the old ticket-update key", () => {
    const itemId = createItem(db, { title: "legacy", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(itemId);
    const checkpoint = insertCheckpoint(db, {
      itemId, runId, source: "agent_reported", kind: "blocked",
      title: "推送被沙箱拦住", summary: "分支没推", nextStep: "给沙箱 GitHub 凭证。",
      idempotencyKey: `item-update:${runId}:abc`,
    });
    raiseBlockerFromCheckpoint(db, checkpoint, { dedupKey: `ticket-update:${checkpoint.id}` });
    db.prepare("UPDATE inbox SET state='consumed'").run();

    expect(repairMissingBlockerAlerts(db)).toBe(0);
    expect(blockerCount(itemId)).toBe(1);
  });
});

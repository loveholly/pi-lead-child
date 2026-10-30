// 工作区 TTL 清扫：真实的 daemon，清扫跑在它的通知轮询里（主线程）。
// 2026-10-15，在 live DB 的副本上启动的测试 daemon 一启动就停摆：迁移从历史 workdir 回填出共享工作区，
// created_at 很早，清扫释放它们时同步遍历、读完用户的整个 checkout（含 node_modules）。
// 以前释放一个工作区失败也会让清扫抛错，这个错一直抛出轮询的回调。daemon 没有 uncaughtException 处理，进程退出。
// 读不了的目录让「释放时读这棵树」在测试里看得见：读了就以 EACCES 失败。
// 以前通知轮询每 PLC_NOTICE_POLL_MS（3 秒）一轮，每一轮都清扫。TTL 是 7 天和 14 天，用不着这么密；
// 释放不了的工作区也每 3 秒重试一次。现在启动后的第一轮清扫一次，之后每 PLC_WORKSPACE_SWEEP_MS 一次。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { createItem, createWorkspace, getWorkspace, openDb, type Db } from "@pi-lead-child/store";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-workspace-sweep-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "50");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

// 不调用模型的 lead session。
const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

// 和迁移回填出来的一样：已完成工单的共享工作区，很久以前建的，从没用过。
function staleSharedWorkspace(path: string): number {
  const itemId = createItem(db, { title: `old ${path}`, brief: "b", createdBy: "user", workdir: path });
  db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId);
  const workspace = createWorkspace(db, {
    ownerItemId: itemId, mode: "shared", kind: "primary", path, state: "active", sourceItemId: itemId,
  });
  db.prepare("UPDATE workspaces SET created_at='2026-01-01 00:00:00', last_used_at=NULL WHERE id=?").run(workspace.id);
  return workspace.id;
}

describe("the workspace TTL sweep in a running daemon", () => {
  it("releases a stale shared checkout without reading it, and survives one it cannot release", async () => {
    // 清扫间隔和通知轮询一样短：测试里要跑好几轮清扫。
    vi.stubEnv("PLC_WORKSPACE_SWEEP_MS", "50");
    const checkout = join(dir, "checkout");
    const locked = join(checkout, "node_modules-like");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "large.bin"), "content the sweep must not read\n");
    chmodSync(locked, 0o000);
    // 路径是一个普通文件：释放这个工作区一定失败。它先建，清扫先处理它，后面的工作区照样要被清扫。
    const notADirectory = join(dir, "not-a-directory");
    writeFileSync(notADirectory, "x\n");
    const brokenId = staleSharedWorkspace(notADirectory);
    const staleId = staleSharedWorkspace(checkout);

    const lines: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: sessionFactory as never, log: (line) => lines.push(line),
    });
    try {
      await vi.waitFor(() => expect(getWorkspace(db, staleId)?.state).toBe("released"), { timeout: 5_000, interval: 50 });
      // 后面的清扫照常在跑：第一轮之后才建的工作区也被释放。
      mkdirSync(join(dir, "later"));
      const laterId = staleSharedWorkspace(join(dir, "later"));
      await vi.waitFor(() => expect(getWorkspace(db, laterId)?.state).toBe("released"), { timeout: 5_000, interval: 50 });
      // 再过几轮清扫：daemon 照常应答，释放不了的工作区原样留着，只记一行日志。
      await delay(500);
      expect((await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/health`)).status).toBe(200);
      expect(getWorkspace(db, brokenId)?.state).toBe("active");
      expect(lines.filter((line) => line.includes(`could not handle workspace #${brokenId}`))).toHaveLength(1);
    } finally {
      await daemon.close();
      chmodSync(locked, 0o755);
    }
  });

  it("sweeps on the first poll, then not again until PLC_WORKSPACE_SWEEP_MS has passed", async () => {
    // 不设 PLC_WORKSPACE_SWEEP_MS：缺省一小时。通知轮询照样每 50 ms 一轮。
    mkdirSync(join(dir, "first"));
    const firstId = staleSharedWorkspace(join(dir, "first"));
    const daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: sessionFactory as never, log: () => {} });
    try {
      await vi.waitFor(() => expect(getWorkspace(db, firstId)?.state).toBe("released"), { timeout: 5_000, interval: 50 });
      mkdirSync(join(dir, "second"));
      const secondId = staleSharedWorkspace(join(dir, "second"));
      // 十来轮通知轮询过去了，还不到下一次清扫。
      await delay(500);
      expect(getWorkspace(db, secondId)?.state).toBe("active");
    } finally {
      await daemon.close();
    }
  });
});

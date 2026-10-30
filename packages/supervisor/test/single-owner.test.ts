// 同一个数据目录只能有一个 supervisor 管 daemon。第二个 supervisor（launchd 的 KeepAlive 每 30 秒拉起一次，
// 或者 plc 自动拉起）发现已经有活着的 supervisor 时让开：不删 supervisor.sock，不写状态文件，不拉起 daemon。
import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { SupervisorPersistentState } from "../src/protocol.js";
import { startSupervisor, type SupervisorOptions } from "../src/server.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 卡住的 daemon：内核接下 plc.sock 上的连接，但它永远不回答（事件循环不动）。
async function hungDaemon(dir: string): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(dir, "plc.sock"), resolve);
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

// 卡住的 daemon 进程还活着，所以它还持有 daemon.lock（SQLite 的文件锁，进程退出时内核放掉它）。
function holdDaemonLock(dir: string): () => void {
  const db = new Database(join(dir, "daemon.lock"), { timeout: 0 });
  db.exec("BEGIN EXCLUSIVE");
  return () => db.close();
}

// 一个只留下标记文件就退出的 daemon 命令：标记文件在，说明 supervisor 拉起过 daemon。
const markingDaemon = (marker: string) => ({
  bin: process.execPath,
  args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`],
});

const options = (
  dir: string,
  daemonCommand: SupervisorOptions["daemonCommand"],
  extra: Partial<SupervisorOptions> = {},
): SupervisorOptions => ({
  dataDir: dir, dbPath: join(dir, "plc.db"), daemonCommand, cwd: process.cwd(), env: { PLC_DATA_DIR: dir }, log: () => {}, ...extra,
});

const readState = (dir: string): SupervisorPersistentState =>
  JSON.parse(readFileSync(join(dir, "supervisor-state.json"), "utf8")) as SupervisorPersistentState;

describe("one supervisor per data directory", () => {
  // 2026-10-15 09:24:56Z：daemon 卡住时，活着的 supervisor 要先问 daemon（最多 1.5 秒）才回答 status。
  // launchd 拉起的第二个 supervisor 只等 750 毫秒，超时后把 supervisor.sock 当成陈旧的删掉并接管。
  // 之后两个 supervisor 都在管 daemon。
  it("stands down while the live supervisor is slow to answer status", async () => {
    const dir = tempDir("plc-supervisor-owner-");
    cleanups.push(await hungDaemon(dir));
    cleanups.push(holdDaemonLock(dir));
    const first = await startSupervisor(options(dir, { bin: process.execPath, args: ["-e", ""] }));
    cleanups.push(() => first.close());
    const sockPath = join(dir, "supervisor.sock");
    const inode = statSync(sockPath).ino;

    const marker = join(dir, "second-supervisor-started-a-daemon");
    const second = await startSupervisor(options(dir, markingDaemon(marker))).catch((error: Error) => error);
    if (!(second instanceof Error)) cleanups.push(() => second.close());

    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/already running/);
    // 第二个什么都没碰：supervisor.sock 还是第一个的那一个，它也没有拉起 daemon。
    expect(statSync(sockPath).ino).toBe(inode);
    await delay(2_000);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("lets the next supervisor in once the owner has closed", async () => {
    const dir = tempDir("plc-supervisor-next-");
    const opts = options(dir, { bin: process.execPath, args: ["-e", ""] });
    await (await startSupervisor(opts)).close();
    const next = await startSupervisor(opts);
    cleanups.push(() => next.close());
    expect(existsSync(next.sockPath)).toBe(true);
  }, 15_000);
});

describe("a daemon that does not answer status", () => {
  // 2026-10-15 09:56:01Z：supervisor 没有自己拉起的 child，daemon 又没在 1.5 秒内回答 status，它就再拉起一个 daemon。
  // 新 daemon 被拒绝后以退出码 0 退出，supervisor 却记成一次崩溃（crashCount 1），Lead 把它当成 daemon 退出告诉了用户。
  // plc.sock 还接受连接时，socket 检查已经够了（supervisor.test.ts 的 busy socket 用例）。这里的 daemon 连 plc.sock
  // 都不接受连接：卡住的 daemon 的 accept 队列满了（02:14:27Z），或者 daemon 正在启动、正在退出。只有锁能看出它还活着。
  it("is waited for, not duplicated, while it holds daemon.lock but plc.sock refuses connections", async () => {
    const dir = tempDir("plc-supervisor-hung-daemon-");
    const releaseLock = holdDaemonLock(dir);
    const marker = join(dir, "daemon-started");
    const handle = await startSupervisor(options(dir, markingDaemon(marker), { restartBaseMs: 50, restartMaxMs: 200 }));
    cleanups.push(() => handle.close());

    await delay(4_000);
    expect(existsSync(marker)).toBe(false);
    expect(readState(dir).crashCount).toBe(0);

    // 卡住的 daemon 退出了（内核放掉了它的锁）：supervisor 照常拉起新的 daemon。
    releaseLock();
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 100 });
  }, 30_000);
});

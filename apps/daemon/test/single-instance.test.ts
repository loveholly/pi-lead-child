// 同一个数据目录只能有一个 daemon。daemon 先拿到 daemon.lock（有了它才拥有 plc.sock），再打开账本、跑启动修复、
// 绑定网关。拿不到就以 DaemonAlreadyRunningError 退出，什么都不碰。
// 2026-10-15 的两次事故：
// - 02:14:27Z：旧 daemon 卡住了，plc.sock 拒绝连接。新 daemon 把 plc.sock 当成陈旧的，跑了启动修复
//   （把旧 daemon 的 Run 当成孤儿）。旧 daemon 还占着 0.0.0.0:47130，新 daemon 只好退回回环。
// - 13:56:08Z：两个 supervisor 同时拉起 daemon。两个都通过了 plc.sock 检查，都打开了账本；
//   第二个绑定了 127.0.0.1:47130，然后在 plc.sock 上 EADDRINUSE 退出。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DaemonAlreadyRunningError, startDaemon } from "../src/server.js";

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub", subscribe() { return () => {}; }, async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
  },
});

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 另一个还活着的进程持有 daemon.lock：一个卡住的 daemon，它的 plc.sock 已经不接受连接了。
async function holdLockInAnotherProcess(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `
    const Database = require("better-sqlite3");
    const db = new Database(${JSON.stringify(path)}, { timeout: 0 });
    db.exec("BEGIN EXCLUSIVE");
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1 << 30);
  `], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`the lock holder exited with ${code}`)));
  });
  return child;
}

function start(dir: string, lines: string[]) {
  return startDaemon({
    dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, gatewayPort: 0,
    log: (line) => lines.push(line),
  });
}

describe("one daemon per data directory", () => {
  it("refuses while another live process holds daemon.lock, before it opens the ledger or binds a gateway", async () => {
    const dir = tempDir("plc-daemon-owner-");
    await holdLockInAnotherProcess(join(dir, "daemon.lock"));
    const lines: string[] = [];

    const outcome = await start(dir, lines).catch((error: Error) => error);
    if (!(outcome instanceof Error)) cleanups.push(() => outcome.close());

    expect(outcome).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(existsSync(join(dir, "plc.db"))).toBe(false);
    expect(existsSync(join(dir, "plc.sock"))).toBe(false);
    expect(lines.join("\n")).not.toMatch(/listening/);
  }, 20_000);

  it("of two daemons started together, serves one and stops the other before its gateway", async () => {
    const dir = tempDir("plc-daemon-race-");
    const linesA: string[] = [];
    const linesB: string[] = [];

    const [a, b] = await Promise.allSettled([start(dir, linesA), start(dir, linesB)]);
    for (const result of [a, b]) {
      if (result.status === "fulfilled") cleanups.push(() => result.value.close());
    }

    const served = [a, b].filter((result) => result.status === "fulfilled");
    const refused = [a, b].flatMap((result, index) =>
      result.status === "rejected" ? [{ reason: result.reason, lines: index === 0 ? linesA : linesB }] : []);
    expect(served).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(refused[0]!.lines.join("\n")).not.toMatch(/listening/);
  }, 30_000);

  it("lets the next daemon in once the owner has closed", async () => {
    const dir = tempDir("plc-daemon-next-");
    await (await start(dir, [])).close();
    const next = await start(dir, []);
    cleanups.push(() => next.close());
    expect(existsSync(next.sockPath)).toBe(true);
  }, 30_000);
});

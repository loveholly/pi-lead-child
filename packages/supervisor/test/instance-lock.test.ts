// 决策边界：另一个实例还活着吗？只看锁：活着的进程（哪怕卡住了）持有它，退出的进程（哪怕是 kill -9）不持有它。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { claimInstanceLock, daemonLockPath, instanceLockHeld, supervisorLockPath } from "../src/instance-lock.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

// 另一个进程拿着锁，然后什么都不做（像一个卡住的 daemon）。
async function holdInAnotherProcess(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `
    const Database = require("better-sqlite3");
    const db = new Database(${JSON.stringify(path)}, { timeout: 0 });
    db.exec("BEGIN EXCLUSIVE");
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1 << 30);
  `], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`the lock holder exited with ${code}`)));
  });
  return child;
}

describe("instance lock", () => {
  it("has one owner at a time and passes to the next one after release", () => {
    const path = supervisorLockPath(tempDir("plc-lock-"));
    const first = claimInstanceLock(path);
    expect(first).not.toBeNull();
    expect(claimInstanceLock(path)).toBeNull();
    expect(instanceLockHeld(path)).toBe(true);

    first!.release();
    first!.release(); // 重复 release 无害
    expect(instanceLockHeld(path)).toBe(false);
    const second = claimInstanceLock(path);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("is held by a live process that does nothing, and freed when that process is killed", async () => {
    const path = daemonLockPath(tempDir("plc-lock-process-"));
    const holder = await holdInAnotherProcess(path);
    expect(claimInstanceLock(path)).toBeNull();
    expect(instanceLockHeld(path)).toBe(true);

    // kill -9：进程没有机会清理，内核照样放掉锁，不留陈旧的锁。
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    holder.kill("SIGKILL");
    await exited;
    expect(instanceLockHeld(path)).toBe(false);
    const next = claimInstanceLock(path);
    expect(next).not.toBeNull();
    next!.release();
  });

  it("is not held when no lock file exists, and probing does not create one", () => {
    const path = join(tempDir("plc-lock-missing-"), "daemon.lock");
    expect(instanceLockHeld(path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

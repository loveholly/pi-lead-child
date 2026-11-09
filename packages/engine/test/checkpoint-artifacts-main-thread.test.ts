// 登记交付产物不占住 daemon 的主线程（lead-scheduler P0b，2026-11-09 审计第 1 项）。
//
// Codex、Claude 的子 agent 经工具桥登记产物时，submit_checkpoint 在 daemon 进程里跑。以前它同步地读、哈希、复制、fsync
// 每个文件（一个最大 25 MB），提交事务里还把每个文件整个再读一遍算哈希。本机实测：
//   · 10 个 25 MB 的产物：daemon 的主线程停 0.73–1.12 秒；
//   · pi 子进程在自己的进程里登记同样的产物：提交事务拿着写锁 164–184 毫秒，daemon 的写语句在主线程上等这么久。
// 现在读写文件内容是异步的，一次只占一个线程池线程；提交事务里只核对文件的身份（dev、ino、大小、mtime、ctime），不再读内容。
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { mainThreadBusyMonitor, tempDir } from "@pi-lead-child/core/testing";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { createItem, createRun, listArtifacts, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";

const MIB = 1024 * 1024;
// 8 个接近上限的产物，合计 200 MB（一张工单的上限是 250 MB）。旧代码上主线程会连续停几百毫秒。
const COUNT = 8;
const SIZE = 25 * MIB - 64;

let db: Db;
let dataDir: string;
let workdir: string;
let itemId: number;
let runId: number;

beforeEach(() => {
  dataDir = tempDir("plc-artifacts-main-thread-");
  workdir = join(dataDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  db = openDb(join(dataDir, "plc.db"));
  itemId = createItem(db, { title: "artifacts", brief: "main thread", createdBy: "system", workdir });
  transition(db, { itemId, to: "active", actor: "system", reason: "started" });
  runId = createRun(db, { itemId, runtime: "codex" });
  updateRun(db, runId, { state: "running" });
});

describe("registering checkpoint artifacts in the daemon (lead-scheduler P0b item 1)", () => {
  it("never holds the main thread for long, including inside the commit transaction", async () => {
    const expected: string[] = [];
    // 一块 1 MB 的缓冲反复写：测试进程里不留几百 MB 的垃圾，免得垃圾回收落在测量的窗口里。
    const block = Buffer.alloc(MIB);
    const artifacts = Array.from({ length: COUNT }, (_, index) => {
      block.fill(index + 1);
      block.write(`artifact ${index}`, 0);
      const hash = createHash("sha256");
      const fd = openSync(join(workdir, `out-${index}.bin`), "w");
      for (let written = 0; written < SIZE; written += MIB) {
        const chunk = block.subarray(0, Math.min(MIB, SIZE - written));
        writeSync(fd, chunk);
        hash.update(chunk);
      }
      closeSync(fd);
      expected.push(hash.digest("hex"));
      return {
        ref: `out-${index}`, name: `out-${index}.bin`, kind: "report",
        media_type: "application/octet-stream", description: null, relative_path: `out-${index}.bin`,
      };
    });
    const handlers = createAgentToolHandlers({ db, itemId, runId, dataDir });

    const monitor = mainThreadBusyMonitor();
    // 先让定时器跑起来，再开始登记。
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.call("submit_checkpoint", {
      kind: "milestone", title: "Deliverables", summary: "Eight large deliverables", artifacts,
    });
    const busy = monitor.stop();

    const registered = listArtifacts(db, itemId);
    expect(registered.map((artifact) => artifact.sha256)).toEqual(expected);
    expect(registered.every((artifact) => artifact.availability === "available")).toBe(true);
    // 旧代码：同步做完全部 200 MB 的读、写、哈希和提交时的重算，主线程连续忙 0.5 秒以上。
    expect(busy.maxBusyMs, JSON.stringify(busy)).toBeLessThan(100);
  }, 60_000);
});

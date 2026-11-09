// 列代查的候选仓库不在调用方的线程上扫目录（lead-scheduler P0b，2026-11-09 审计第 2 项）。
//
// daemon 处理 Slack 代查的请求 A、派工单找本地仓库时，同步调 listLookupCandidates：它用 readdirSync、statSync、
// readFileSync 扫配置的根目录（缺省 ~/Workspace）两层。本机实测：真实的 ~/Workspace 70–116 毫秒，450 个仓库的目录
// 冷启动 462 毫秒，这段时间 daemon 的主线程什么都做不了。现在扫目录是异步的、在后台做，listLookupCandidates 只读缓存。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mainThreadBusyMonitor, tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { listLookupCandidates, listLookupCandidatesAsync, refreshLookupCandidates } from "../src/lookup/candidates.js";

// 450 个仓库，3,000 个普通目录。
function bigWorkspace(): string {
  const root = join(tempDir("plc-lookup-main-thread-"), "Workspace");
  const repo = (path: string, index: number) => {
    mkdirSync(join(path, ".git"), { recursive: true });
    writeFileSync(join(path, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:acme/repo-${index}.git\n`);
  };
  let index = 0;
  for (let n = 0; n < 200; n++) repo(join(root, `repo-${n}`), index++);
  for (let group = 0; group < 50; group++) for (let n = 0; n < 5; n++) repo(join(root, `group-${group}`, `repo-${n}`), index++);
  for (let folder = 0; folder < 300; folder++) for (let sub = 0; sub < 10; sub++) mkdirSync(join(root, `folder-${folder}`, `sub-${sub}`), { recursive: true });
  return root;
}

describe("lookup candidates off the caller's thread (lead-scheduler P0b item 2)", () => {
  it("answers from the cache and scans the roots in the background", async () => {
    const workspace = bigWorkspace();
    const db = openDb(join(workspace, "..", "plc.db"));
    const lines: string[] = [];

    const monitor = mainThreadBusyMonitor();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 第一次：缓存是空的，马上返回（这里没有登记的项目，所以是空列表），后台开始扫。
    const first = listLookupCandidates({ db, roots: [workspace], log: (line) => lines.push(line) });
    const scanned = await refreshLookupCandidates({ db, roots: [workspace] });
    const busy = monitor.stop();

    expect(first).toEqual([]);
    expect(scanned).toHaveLength(200);
    // 扫完以后，同步的调用直接拿到扫描结果。
    expect(listLookupCandidates({ db, roots: [workspace] }).map((candidate) => candidate.repo))
      .toEqual(scanned.map((candidate) => candidate.repo));
    expect(lines.some((line) => line.startsWith("[sched] lookup.scan ") && line.includes("candidates=200"))).toBe(true);
    // 旧代码：第一次调用就同步扫完 3,500 个目录，主线程连续忙 100 毫秒以上。
    expect(busy.maxBusyMs, JSON.stringify(busy)).toBeLessThan(30);
    db.close();
  }, 60_000);

  it("lists the same candidates through the asynchronous path", async () => {
    const workspace = bigWorkspace();
    const db = openDb(join(workspace, "..", "plc.db"));
    const all = await listLookupCandidatesAsync({ db, roots: [workspace], limit: 1_000 });
    expect(all).toHaveLength(450);
    // 目录按名字排序：group-0/repo-0（编号 200）在最前。
    expect(all[0]).toMatchObject({ repo: "acme/repo-200", source: "local", github: { owner: "acme", repo: "repo-200" } });
    db.close();
  }, 60_000);
});

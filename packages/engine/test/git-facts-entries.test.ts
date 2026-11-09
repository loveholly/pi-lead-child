// 不预热的入口（lead-scheduler spec P0）。拉起和恢复 Run 时，宿主（daemon 的 spawnItemChild、resumeItemChild）同步判定工作区。
// 以前「开始执行」按钮和恢复走到那里时，git 事实不在缓存里，git-facts 只好在 daemon 的主线程上同步跑 git
// （日志 "[git-facts] not warmed, running git synchronously"）。负载高时一个 git 要几秒，daemon 停住。
// 现在这两个入口先异步备好事实，宿主的判定只读缓存。
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, getItem, openDb, updateRun, type Db } from "@pi-lead-child/store";
import { forgetGitFacts, setGitFactsLog } from "../src/coordinator/git-facts.js";
import { planRunWorkspace } from "../src/coordinator/workspace-policy.js";
import { liveChildren } from "../src/children/manager.js";
import { resumeItemRun } from "../src/ticket-actions/lifecycle.js";
import { runTicketAction, type TicketActionHost } from "../src/ticket-actions/index.js";

let db: Db;
let repo: string;
let logs: string[];

beforeEach(() => {
  const dir = tempDir("plc-git-facts-entries-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" },
  });
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
  forgetGitFacts();
  logs = [];
  setGitFactsLog((line) => logs.push(line));
});
afterEach(() => {
  setGitFactsLog(null);
  forgetGitFacts();
  db.close();
});

// 和 daemon 的宿主一样：在拉起或恢复的那一刻同步判定工作区（缺省的 git 事实来源：缓存优先，缺了同步查）。
function decidingHost(decided: string[]): TicketActionHost {
  return {
    startRun: (itemId) => {
      decided.push(planRunWorkspace(db, getItem(db, itemId)!, { role: "executor", purpose: "execution" }).mode);
    },
    resumeRun: ({ itemId, runId }) => {
      const run = db.prepare("SELECT role, purpose FROM runs WHERE id=?").get(runId) as { role: "executor" | "reviewer"; purpose: "execution" };
      decided.push(planRunWorkspace(db, getItem(db, itemId)!, run).mode);
    },
  };
}

describe("entries that start or resume a run", () => {
  it("warm the git facts before the Start button's host decides the workspace", async () => {
    const itemId = createItem(db, { title: "改一个文件", brief: "b", createdBy: "lead", workdir: repo });
    const decided: string[] = [];

    await runTicketAction(db, { itemId, action: "start", caller: { kind: "user" }, host: decidingHost(decided) });

    expect(decided).toEqual(["isolated"]);
    expect(logs.filter((line) => line.includes("not warmed"))).toEqual([]);
  });

  it("warm the git facts before a paused run is resumed", async () => {
    const itemId = createItem(db, { title: "改一个文件", brief: "b", createdBy: "lead", workdir: repo });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running", sessionId: "s" });
    updateRun(db, runId, { state: "paused" });
    const decided: string[] = [];

    await resumeItemRun(db, decidingHost(decided), runId, { actor: "user" });

    expect(decided).toEqual(["isolated"]);
    expect(logs.filter((line) => line.includes("not warmed"))).toEqual([]);
  });
});

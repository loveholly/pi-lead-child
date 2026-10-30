// child 的 git_fetch（2026-10-29）：沙箱里没有 git 的凭证，#159 返工要 rebase 到刚合进 master 的改动，fetch 不了，卡成阻塞。
// daemon 在沙箱外替它 fetch；不经工具桥（child 进程里）时照样没有凭证，拒绝。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, openDb } from "@pi-lead-child/store";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { setAgentConnectionHost } from "../src/agent-tools/connection-host.js";
import { resetFetchThrottleForTests } from "../src/coordinator/workspace-remote.js";

afterEach(() => {
  setAgentConnectionHost(null);
  resetFetchThrottleForTests();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
}

function setup() {
  const dir = tempDir("plc-git-fetch-tool-");
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "master", seed]);
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "a");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const user = join(dir, "user");
  execFileSync("git", ["clone", "-q", origin, user]);
  git(seed, "remote", "add", "origin", origin);
  writeFileSync(join(seed, "b.txt"), "b\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "b");
  git(seed, "push", "-q", "origin", "master");
  const db = openDb(join(dir, "plc.db"));
  const itemId = createItem(db, { title: "返工", brief: "b", createdBy: "lead", workdir: user });
  const runId = createRun(db, { itemId, runtime: "claude" });
  return { db, itemId, runId, user, latest: git(seed, "rev-parse", "HEAD") };
}

describe("git_fetch for a sandboxed child", () => {
  it("fetches origin in the daemon so the child sees commits pushed after it started", async () => {
    const { db, itemId, runId, user, latest } = setup();
    setAgentConnectionHost({ search: async () => ({}), call: async () => ({}) } as never);
    expect(git(user, "rev-parse", "origin/master")).not.toBe(latest);
    const result = await createAgentToolHandlers({ db, itemId, runId }).call("git_fetch", {});
    expect(result).toMatchObject({ fetched: true });
    expect(git(user, "rev-parse", "origin/master")).toBe(latest);
  });

  it("refuses outside the daemon's tool bridge, where there are no git credentials", async () => {
    const { db, itemId, runId } = setup();
    await expect(createAgentToolHandlers({ db, itemId, runId }).call("git_fetch", {})).rejects.toThrow(/tool bridge/);
  });
});

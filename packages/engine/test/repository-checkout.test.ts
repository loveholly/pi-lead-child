// 工单要改的仓库（2026-10-29）：本机有 checkout 就用，没有时 daemon 在沙箱外 clone。#161 要改 returns-skills，本机没有，
// 执行者在沙箱里 clone 不了，卡了两次。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { ensureRepositoryCheckout, parseRepositorySpec } from "../src/coordinator/repository-checkout.js";

let db: Db;
let home: string;
let savedGlobal: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  home = tempDir("plc-repo-checkout-");
  db = openDb(join(home, "plc.db"));
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  db.close();
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
});

// 一个本地的 bare 仓库，假装是 https://github.com/acme/<name>：git 的 insteadOf 把地址换成它。
function fakeGithub(name: string): string {
  const seed = join(home, "seed");
  execFileSync("git", ["init", "-q", "-b", "master", seed]);
  writeFileSync(join(seed, "SKILL.md"), "old skill\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  const bare = join(home, "github", "acme", `${name}.git`);
  mkdirSync(join(home, "github", "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  const config = join(home, "gitconfig");
  writeFileSync(config, `[url "${join(home, "github", "acme")}/"]\n\tinsteadOf = https://github.com/acme/\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  return bare;
}

describe("parseRepositorySpec", () => {
  it("reads owner/name and the usual remote addresses the same way", () => {
    for (const spec of ["Acme/returns-skills", "github.com/Acme/returns-skills", "https://github.com/Acme/returns-skills.git",
      "git@github.com:Acme/returns-skills.git"]) {
      expect(parseRepositorySpec(spec), spec).toMatchObject({ host: "github.com", owner: "Acme", name: "returns-skills", key: "github.com/acme/returns-skills" });
    }
    expect(parseRepositorySpec("returns-skills")).toBeNull();
    expect(parseRepositorySpec("a/b/c/d")).toBeNull();
  });
});

describe("ensureRepositoryCheckout", () => {
  it("uses a checkout already under ~/Workspace whose origin is that repository", async () => {
    const existing = join(home, "Workspace", "Acme", "demo");
    mkdirSync(existing, { recursive: true });
    execFileSync("git", ["init", "-q", existing]);
    git(existing, "remote", "add", "origin", "git@github.com:acme/demo.git");
    expect(await ensureRepositoryCheckout(db, parseRepositorySpec("acme/demo")!, { home })).toEqual({ path: existing, cloned: false });
  });

  it("clones a repository that is not on this Mac into ~/Workspace/<owner>/<name>", async () => {
    fakeGithub("returns-skills");
    const result = await ensureRepositoryCheckout(db, parseRepositorySpec("acme/returns-skills")!, { home });
    expect(result).toEqual({ path: join(home, "Workspace", "acme", "returns-skills"), cloned: true });
    expect(existsSync(join(result.path, "SKILL.md"))).toBe(true);
    // 第二次找到刚 clone 的这份，不再 clone。
    expect(await ensureRepositoryCheckout(db, parseRepositorySpec("acme/returns-skills")!, { home })).toEqual({ path: result.path, cloned: false });
  });

  it("says why when the clone fails", async () => {
    fakeGithub("present");
    await expect(ensureRepositoryCheckout(db, parseRepositorySpec("acme/missing")!, { home })).rejects.toThrow(/clone acme\/missing 失败/);
  });
});

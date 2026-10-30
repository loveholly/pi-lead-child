// 建隔离 worktree 时准备依赖（lead-tools-and-routing spec D15，#137 第 6 条）：真的 git 仓库、真的 worktree、真的克隆。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  awaitWorktreeDependencies, findNodeModulesDirs, forgetWorktreeDependenciesForTests, startWorktreeDependencies,
} from "../src/coordinator/worktree-dependencies.js";

const supported = process.platform === "darwin" || process.platform === "linux";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 一个像这个仓库的 Node 单仓：根目录和一个工作区包各有 node_modules，工作区包的链接是相对路径。
function monorepo(): { repo: string; worktree: string } {
  const base = tempDir("plc-deps-");
  const repo = join(base, "repo");
  mkdirSync(join(repo, "packages", "lib", "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  writeFileSync(join(repo, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
  writeFileSync(join(repo, "packages", "lib", "src", "index.js"), "export const where = 'repo';\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(base, "init", "-q", repo);
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  symlinkSync("../packages/lib", join(repo, "node_modules", "lib"));
  mkdirSync(join(repo, "packages", "lib", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "packages", "lib", "node_modules", "dep", "index.js"), "module.exports = 2;\n");
  const worktree = join(base, "repo.plc-workspaces", "item-1");
  mkdirSync(join(base, "repo.plc-workspaces"));
  git(repo, "worktree", "add", "-q", "-b", "plc/item-1", worktree, "HEAD");
  return { repo, worktree };
}

afterEach(() => forgetWorktreeDependenciesForTests());

describe("findNodeModulesDirs", () => {
  it("finds the root and workspace packages' node_modules, not nested ones", () => {
    const { repo } = monorepo();
    expect(findNodeModulesDirs(repo)).toEqual(["node_modules", join("packages", "lib", "node_modules")]);
  });
});

describe.runIf(supported)("startWorktreeDependencies", () => {
  it("clones the user's installed dependencies into a new worktree, keeping workspace links pointing at the worktree", async () => {
    const { repo, worktree } = monorepo();
    const seen: unknown[] = [];
    void startWorktreeDependencies(repo, worktree, (result) => seen.push(result));
    // 执行者从 worktree 里的子目录启动，也要等到。
    const result = await awaitWorktreeDependencies(join(worktree, "packages", "lib"));
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(seen).toEqual([result]);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
    // 工作区包的链接还是相对路径，指向 worktree 自己的包，不是用户 checkout 的。
    expect(lstatSync(join(worktree, "node_modules", "lib")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(worktree, "node_modules", "lib"))).toBe("../packages/lib");
    // 克隆出来的东西被 git 忽略，不会进提交。
    expect(git(worktree, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("skips a worktree that is not a Node project or already has dependencies", async () => {
    const { repo, worktree } = monorepo();
    mkdirSync(join(worktree, "node_modules"));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.skipped).toMatch(/已经有 node_modules/);
    expect(await awaitWorktreeDependencies(tempDir("plc-deps-other-"))).toBeNull();
  }, 60_000);

  it("does not clone a node_modules that git would not ignore", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, ".gitignore"), "\n");
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  }, 60_000);
});

// 2026-10-29：#185 克隆 一个大的前端仓库 的 node_modules 用了 19 分钟，被当成卡死停掉。pnpm 的仓库先用 pnpm 按 lockfile 装。
const pnpm = [process.env.HOME ? join(process.env.HOME, "Library", "pnpm", "pnpm") : "", ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, "pnpm"))]
  .find((path) => path && existsSync(path));
describe.runIf(Boolean(pnpm))("startWorktreeDependencies in a pnpm repository", () => {
  it("installs with pnpm from the lockfile instead of cloning the user's node_modules", async () => {
    const source = tempDir("plc-deps-pnpm-source-");
    const worktree = tempDir("plc-deps-pnpm-worktree-");
    for (const dir of [source, worktree]) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", private: true }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
    }
    mkdirSync(join(source, "node_modules", "from-user-checkout"), { recursive: true });
    const result = await startWorktreeDependencies(source, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("pnpm install --frozen-lockfile") });
    expect(existsSync(join(worktree, "node_modules", "from-user-checkout"))).toBe(false);
  }, 120_000);
});

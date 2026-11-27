// 建隔离 worktree 时准备依赖（lead-tools-and-routing spec D15，#137 第 6 条）：真的 git 仓库、真的 worktree、真的克隆。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { dependenciesNote } from "../src/children/manager.js";
import {
  awaitWorktreeDependencies, DEPENDENCY_STATUS_FILE, findNodeModulesDirs, forgetWorktreeDependenciesForTests,
  peekWorktreeDependencies, readDependencyStatus, setSystemBinDirsForTests, startWorktreeDependencies,
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

describe.runIf(supported)("readDependencyStatus", () => {
  it("reads the status line from the worktree's git directory, and is null when there is none", () => {
    const { worktree } = monorepo();
    expect(readDependencyStatus(worktree)).toBeNull();
    writeFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "ready: installed with npm ci\n");
    expect(readDependencyStatus(worktree)).toBe("ready: installed with npm ci");
    expect(readDependencyStatus(tempDir("plc-deps-not-a-worktree-"))).toBeNull();
  });
});

describe("findNodeModulesDirs", () => {
  it("finds the root and workspace packages' node_modules, not nested ones", async () => {
    const { repo } = monorepo();
    expect(await findNodeModulesDirs(repo)).toEqual(["node_modules", join("packages", "lib", "node_modules")]);
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

// 2026-11-25：#465 给一个 bun 仓库建 worktree，克隆 node_modules/.bun 跑了 6 分钟以上。bun 的仓库先用 bun install 装，装不上再克隆。
// 用一个假的 bun（脚本）代替真的：它记下参数，按退出码和是否留下装了一半的 node_modules 表现。
function fakeBun(body: string): string {
  const home = tempDir("plc-deps-bun-home-");
  mkdirSync(join(home, "bin"));
  const script = join(home, "bin", "bun");
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return home;
}

describe.runIf(supported)("startWorktreeDependencies in a bun repository", () => {
  const savedBunInstall = process.env.BUN_INSTALL;
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
  });

  it("installs with bun install --frozen-lockfile instead of cloning the user's node_modules", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    const argsFile = join(tempDir("plc-deps-bun-args-"), "args");
    process.env.BUN_INSTALL = fakeBun(`echo "$@" > ${argsFile}\nmkdir -p node_modules/from-bun`);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("bun install --frozen-lockfile") });
    expect(readFileSync(argsFile, "utf8")).toContain("install --frozen-lockfile");
    expect(existsSync(join(worktree, "node_modules", "from-bun"))).toBe(true);
    // 没有克隆用户 checkout 的依赖。
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
  }, 60_000);

  it("also treats a bun.lockb lockfile as a bun repository", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lockb"), "");
    process.env.BUN_INSTALL = fakeBun("mkdir -p node_modules/from-bun");
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toContain("bun install --frozen-lockfile");
  }, 60_000);

  it("falls back to cloning when bun install fails, and drops the half-installed node_modules first", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    process.env.BUN_INSTALL = fakeBun("mkdir -p node_modules/half-installed\nexit 1");
    const result = await startWorktreeDependencies(repo, worktree);
    // 行为和以前一样（克隆、先删装了一半的）；2026-11-25 起结果里多了退回的原因。
    expect(result).toEqual({
      cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null, fallbackReason: "bun install 失败：退出码 1",
    });
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
  }, 60_000);

  it("writes a status file in the worktree's git directory when preparation ends, and peek shows the state", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    const gate = join(tempDir("plc-deps-bun-gate-"), "go");
    process.env.BUN_INSTALL = fakeBun(`while [ ! -e ${gate} ]; do sleep 0.05; done\nmkdir -p node_modules/from-bun`);
    const done = startWorktreeDependencies(repo, worktree);
    const statusFile = join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(peekWorktreeDependencies(join(worktree, "packages", "lib"))).toEqual({ state: "preparing" });
    expect(existsSync(statusFile)).toBe(false);
    writeFileSync(gate, "");
    const result = await done;
    expect(peekWorktreeDependencies(worktree)).toEqual({ state: "done", result });
    expect(readFileSync(statusFile, "utf8")).toMatch(/^ready: installed with bun install --frozen-lockfile/);
    // 状态文件在 git 目录里，不会进提交。
    expect(git(worktree, "status", "--porcelain")).toBe("?? bun.lock");
    expect(peekWorktreeDependencies(tempDir("plc-deps-other-"))).toBeNull();
  }, 60_000);
});

// #493：npm 的仓库（有 package-lock.json）在 pnpm、bun 之后、克隆之前用 npm ci 装；#473 拷 3 份 node_modules 花了约 11 分钟。
// 用假的 npm（脚本）代替真的：它记下参数和 PATH，按退出码和是否留下装了一半的 node_modules 表现。
function fakeBin(name: string, body: string, dir = tempDir(`plc-deps-${name}-bin-`)): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return dir;
}
const fakeNpmBin = (body: string, dir?: string): string => fakeBin("npm", body, dir);

// 一个找不到 npm、yarn、corepack 的环境：PATH 只有 git 和系统的 /usr/bin:/bin，没有 nvm、volta，也没有 Homebrew 的固定目录。
function withoutPackageManagers(): void {
  const gitDir = tempDir("plc-deps-git-bin-");
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(gitDir, "git"));
  process.env.PATH = `${gitDir}:/usr/bin:/bin`;
  process.env.HOME = tempDir("plc-deps-home-");
  for (const key of ["NVM_BIN", "NVM_DIR", "VOLTA_HOME"]) delete process.env[key];
  setSystemBinDirsForTests([]);
}

describe.runIf(supported)("startWorktreeDependencies in an npm repository", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  it("installs once at the root with npm ci instead of cloning any node_modules, workspace packages included", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-npm-out-");
    const bin = fakeNpmBin(`echo "$@" > ${out}/args\necho "$PATH" > ${out}/path\npwd >> ${out}/calls\nmkdir -p node_modules/from-npm`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null, installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("ci --prefer-offline --ignore-scripts --no-audit --no-fund --loglevel=error");
    // monorepo 只在根目录跑一次，npm 所在的目录在 PATH 最前面（脚本是 env node，要找得到 node）。
    expect(readFileSync(join(out, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(out, "path"), "utf8").startsWith(`${bin}:`)).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "from-npm"))).toBe(true);
    // 没有拷用户 checkout 的依赖：不管是根的还是工作区包的。
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
    expect(existsSync(join(worktree, "packages", "lib", "node_modules"))).toBe(false);
  }, 60_000);

  it("skips npm and clones when npm cannot be found, and says why", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/找不到 npm/);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toMatch(/^ready: cloned node_modules.*\(installing with the package manager did not work: 找不到 npm/);
  }, 60_000);

  it("falls back to cloning when npm ci fails, drops the half-installed node_modules and says why", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    process.env.PATH = `${fakeNpmBin("mkdir -p node_modules/half-installed\necho 'npm error code EUSAGE' >&2\necho 'npm error lock file is out of sync' >&2\nexit 1")}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/^npm ci 失败：npm error code EUSAGE npm error lock file is out of sync$/);
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
  }, 60_000);

  it("does not use npm in a repository without package-lock.json, and leaves no fallback reason", async () => {
    const { repo, worktree } = monorepo();
    withoutPackageManagers();
    const out = tempDir("plc-deps-npm-out-");
    process.env.PATH = `${fakeNpmBin(`echo called > ${out}/called`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(existsSync(join(out, "called"))).toBe(false);
  }, 60_000);

  it("finds npm in the newest nvm node version and in a fixed system directory when PATH has none", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-npm-out-");
    for (const version of ["v18.19.0", "v20.9.0", "v9.0.0"]) {
      fakeNpmBin(`echo ${version} > ${out}/version\nmkdir -p node_modules/from-npm`, (() => {
        const dir = join(process.env.HOME as string, ".nvm", "versions", "node", version, "bin");
        mkdirSync(dir, { recursive: true });
        return dir;
      })());
    }
    const nvm = await startWorktreeDependencies(repo, worktree);
    expect(nvm.installedWith).toContain("npm ci");
    expect(readFileSync(join(out, "version"), "utf8").trim()).toBe("v20.9.0");

    forgetWorktreeDependenciesForTests();
    rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
    withoutPackageManagers();
    setSystemBinDirsForTests([fakeNpmBin("mkdir -p node_modules/from-system")]);
    const system = await startWorktreeDependencies(repo, worktree);
    expect(system.installedWith).toContain("npm ci");
    expect(existsSync(join(worktree, "node_modules", "from-system"))).toBe(true);
  }, 60_000);
});

// #499：--ignore-scripts 装完以后 better-sqlite3 没有原生程序（build/Release/better_sqlite3.node），测试一开始全部失败。
// PR #85 评审第 3 条：daemon 在沙箱外，不能跑 `<包管理器> rebuild`（它会执行 node_modules 里那个包的 install 脚本，执行者写得到）。
// 所以装完只检查：缺原生程序时，结果和状态文件写明缺了什么和沙箱里要跑的命令，daemon 一条 rebuild 也不运行。
// 假的包管理器：install / ci 装出 better-sqlite3（可以带或不带原生程序），rebuild 记下参数再装出原生程序——
// 测试靠 rebuild-calls 文件证明 daemon 没有调用它。
const SQLITE = "node_modules/better-sqlite3";
const fakeInstaller = (installCommand: string, out: string, opts: { builtAtInstall?: boolean } = {}): string => [
  `case "$1" in`,
  `  ${installCommand}) mkdir -p ${SQLITE}/build/Release; echo '{"name":"better-sqlite3"}' > ${SQLITE}/package.json`,
  opts.builtAtInstall ? `    : > ${SQLITE}/build/Release/better_sqlite3.node` : `    rmdir ${SQLITE}/build/Release ${SQLITE}/build`,
  `    ;;`,
  `  rebuild) echo "$@" >> ${out}/rebuild-calls`,
  `    mkdir -p ${SQLITE}/build/Release; : > ${SQLITE}/build/Release/better_sqlite3.node ;;`,
  `esac`,
].join("\n");

const statusOf = (worktree: string): string =>
  readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8");

describe.runIf(supported)("native packages after an install without scripts", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  it("npm: does not run npm rebuild after npm ci; the result, the status file and the prompt carry the command for the sandbox", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null,
      installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
      rebuildError: expect.stringMatching(/better-sqlite3.*缺原生程序/),
      rebuildCommand: "npm rebuild better-sqlite3",
    });
    // daemon 没有运行 rebuild，原生程序还是没有；node_modules 留着，状态仍是 ready:。
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(false);
    expect(statusOf(worktree)).toBe(
      "ready: installed with npm ci --prefer-offline --ignore-scripts --no-audit --no-fund"
      + " (native packages not built: better-sqlite3 缺原生程序，系统不在沙箱外补编译，在沙箱里补; run `npm rebuild better-sqlite3` in the sandbox before you run tests)\n",
    );
    expect(dependenciesNote(worktree)).toContain("run `npm rebuild better-sqlite3` in the sandbox before you run tests.");
  }, 60_000);

  it("npm: reports nothing when the native binary is already there", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out, { builtAtInstall: true }))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null, installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
    expect(dependenciesNote(worktree)).not.toContain("native package is not built");
  }, 60_000);

  it("pnpm: does not run pnpm rebuild; the command for the sandbox is pnpm rebuild better-sqlite3", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", fakeInstaller("install", out));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({
      cloned: [], error: null, installedWith: expect.stringContaining("pnpm install"), rebuildCommand: "pnpm rebuild better-sqlite3",
    });
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
  }, 60_000);

  it("bun: has no rebuild command, so it reports the missing native binary and gives no command", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    const home = tempDir("plc-deps-bun-home-");
    fakeBin("bun", fakeInstaller("install", out), join(home, "bin"));
    process.env.BUN_INSTALL = home;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("bun install") });
    expect(result.rebuildCommand).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*bun.*没有补编译的命令/);
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
    expect(dependenciesNote(worktree)).toContain("rebuild it yourself in the sandbox before you run tests.");
  }, 60_000);
});

// #502：#499 之前建的工作区已经有 node_modules（npm ci --ignore-scripts 装的，better-sqlite3 没有原生程序）。
// PR #85 评审第 3 条：复用工作区时 node_modules 可能被执行者在沙箱里写过，daemon 不运行 rebuild（也不运行任何包管理器命令），
// 只发现缺原生程序，把沙箱里要跑的命令写进状态文件和给执行者的提示。
describe.runIf(supported)("a worktree that already has node_modules without the native binary (#502)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  // 旧工作区：装好了 better-sqlite3 的包，没有 build/Release/*.node。
  function oldWorktree(opts: { built?: boolean; lockfile?: string | null } = {}): { repo: string; worktree: string } {
    const { repo, worktree } = monorepo();
    if (opts.lockfile !== null) writeFileSync(join(worktree, opts.lockfile ?? "package-lock.json"), "{}\n");
    mkdirSync(join(worktree, SQLITE, "build", "Release"), { recursive: true });
    writeFileSync(join(worktree, SQLITE, "package.json"), '{"name":"better-sqlite3"}\n');
    if (opts.built) writeFileSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"), "");
    else rmSync(join(worktree, SQLITE, "build"), { recursive: true });
    return { repo, worktree };
  }

  it("runs no package manager command at all, and tells the executor which rebuild command to run in the sandbox", async () => {
    const { repo, worktree } = oldWorktree();
    // 执行者在沙箱里留下的 install 脚本：daemon 一旦运行 `npm rebuild`，它就会在沙箱外执行。
    writeFileSync(join(worktree, SQLITE, "package.json"), JSON.stringify({ name: "better-sqlite3", scripts: { install: "echo planted" } }));
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PATH = `${fakeNpmBin(`echo "$@" >> ${out}/all-calls\n${fakeInstaller("ci", out)}`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({
      cloned: [], error: null, skipped: expect.stringMatching(/已经有 node_modules/), rebuildCommand: "npm rebuild better-sqlite3",
    });
    expect(result.rebuildError).toMatch(/better-sqlite3.*缺原生程序/);
    // npm 一次也没被调用：没有 rebuild、没有 ci，也没有克隆用户的 node_modules。
    expect(existsSync(join(out, "all-calls"))).toBe(false);
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(false);
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
    expect(statusOf(worktree)).toBe(
      "ready: node_modules was already in the worktree"
      + " (native packages not built: better-sqlite3 缺原生程序，系统不在沙箱外补编译，在沙箱里补; run `npm rebuild better-sqlite3` in the sandbox before you run tests)\n",
    );
    // 执行者收到的提示：依赖是好的，缺原生程序，要在沙箱里跑这条命令。
    const note = dependenciesNote(worktree);
    expect(note).toContain("Dependencies are ready (node_modules was already in this worktree).");
    expect(note).toContain("run `npm rebuild better-sqlite3` in the sandbox before you run tests.");
  }, 60_000);

  it("does nothing when the native binary is already there, and the status says the dependencies are ready", async () => {
    const { repo, worktree } = oldWorktree({ built: true });
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PATH = `${fakeNpmBin(`echo "$@" >> ${out}/all-calls`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.skipped).toMatch(/已经有 node_modules/);
    expect(result.rebuildError).toBeUndefined();
    expect(result.rebuildCommand).toBeUndefined();
    expect(existsSync(join(out, "all-calls"))).toBe(false);
    // 执行者看到的状态不是「none:」（那会让它自己重装一遍）。
    expect(statusOf(worktree)).toBe("ready: node_modules was already in the worktree\n");
    expect(dependenciesNote(worktree)).not.toContain("native package is not built");
  }, 60_000);

  it("gives the pnpm command in a pnpm repository and does not run pnpm", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: "pnpm-lock.yaml" });
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", `echo "$@" >> ${out}/all-calls\n${fakeInstaller("install", out)}`);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, rebuildCommand: "pnpm rebuild better-sqlite3" });
    expect(existsSync(join(out, "all-calls"))).toBe(false);
    expect(dependenciesNote(worktree)).toContain("run `pnpm rebuild better-sqlite3` in the sandbox before you run tests.");
  }, 60_000);

  it("also gives the sandbox command, and runs nothing, when the repository has .pnpmfile.cjs", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: "pnpm-lock.yaml" });
    writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", `echo "$@" >> ${out}/all-calls\n${fakeInstaller("install", out)}`);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.rebuildCommand).toBe("pnpm rebuild better-sqlite3");
    expect(existsSync(join(out, "all-calls"))).toBe(false);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(false);
  }, 60_000);

  it("says what is missing when the repository has no lockfile, so no package manager is known", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: null });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.rebuildCommand).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*没有锁文件/);
  }, 60_000);
});

// 2026-11-25：包管理器按锁文件认（PACKAGE_MANAGERS），加了 yarn：1（classic）和 2 及以上（berry）分开，PnP 没有 node_modules 可拷。
// 假的 yarn 记下参数和 YARN_ENABLE_SCRIPTS，再装出一个 node_modules。
describe.runIf(supported)("startWorktreeDependencies in a yarn repository", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  const YARN1_LOCK = "# yarn lockfile v1\n";
  const BERRY_LOCK = "__metadata:\n  version: 8\n";
  const LEFT_PAD_CLONED = { cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null };

  // worktree 里放锁文件、package.json（可带 packageManager）和 .yarnrc.yml，PATH 里放一个假的 yarn。返回它记录的目录。
  function yarnRepo(options: { lock: string; packageManager?: string; yarnrc?: string; yarnBody?: string; extraLocks?: Record<string, string> }): {
    repo: string; worktree: string; out: string;
  } {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "yarn.lock"), options.lock);
    for (const [name, content] of Object.entries(options.extraLocks ?? {})) writeFileSync(join(worktree, name), content);
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"], ...(options.packageManager ? { packageManager: options.packageManager } : {}) }));
    if (options.yarnrc !== undefined) writeFileSync(join(worktree, ".yarnrc.yml"), options.yarnrc);
    withoutPackageManagers();
    const out = tempDir("plc-deps-yarn-out-");
    const body = options.yarnBody ?? `echo "$@" > ${out}/args\necho "$YARN_ENABLE_SCRIPTS" > ${out}/scripts\necho "$YARN_IGNORE_PATH" > ${out}/ignorepath\nmkdir -p node_modules/from-yarn`;
    process.env.PATH = `${fakeBin("yarn", body)}:${process.env.PATH}`;
    return { repo, worktree, out };
  }

  it("installs a yarn 1 (classic) repository with the classic command and no clone", async () => {
    const { repo, worktree, out } = yarnRepo({ lock: YARN1_LOCK });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null,
      installedWith: "YARN_IGNORE_PATH=1 yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive",
    });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
    expect(readFileSync(join(out, "scripts"), "utf8").trim()).toBe("");
    // yarn 1 不读 .yarnrc 的 yarn-path：安装时带 YARN_IGNORE_PATH=1（PR #85 二次复审，#516）。
    expect(readFileSync(join(out, "ignorepath"), "utf8").trim()).toBe("1");
    expect(existsSync(join(worktree, "node_modules", "from-yarn"))).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
  }, 60_000);

  it.each([
    ["there is a .yarnrc.yml", { lock: YARN1_LOCK, yarnrc: "nodeLinker: node-modules\n" }],
    ["yarn.lock has __metadata", { lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\n" }],
  ])("installs a yarn berry repository with yarn install --immutable and scripts off when %s", async (_why, options) => {
    const { repo, worktree, out } = yarnRepo(options);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: [], skipped: null, error: null, installedWith: "YARN_ENABLE_SCRIPTS=false yarn install --immutable" });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --immutable");
    expect(readFileSync(join(out, "scripts"), "utf8").trim()).toBe("false");
  }, 60_000);

  it("a yarn 1 packageManager field wins over a stray .yarnrc.yml", async () => {
    const { repo, worktree, out } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19", yarnrc: "nodeLinker: node-modules\n" });
    await startWorktreeDependencies(repo, worktree);
    expect(readFileSync(join(out, "args"), "utf8")).toContain("--frozen-lockfile");
  }, 60_000);

  it("says a PnP repository cannot fall back to copying when yarn install fails, and does not pretend it worked", async () => {
    // nodeLinker 没写：berry 默认就是 PnP。
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnBody: "echo 'YN0028: lockfile would have been modified' >&2\nexit 1" });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.installedWith).toBeUndefined();
    expect(result.error).toMatch(/^PnP 仓库，不能退回拷贝：yarn install（berry） 失败：YN0028/);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8")).toMatch(/^failed: PnP 仓库，不能退回拷贝/);
  }, 60_000);

  it("also treats nodeLinker: pnp as PnP, and a missing yarn in a PnP repository as an error, not a skip", async () => {
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: pnp\n" });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: expect.stringMatching(/^PnP 仓库，不能退回拷贝：找不到 yarn/) });
  }, 60_000);

  it("keeps a successful PnP install as a success", async () => {
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: pnp\n", yarnBody: "echo '' > .pnp.cjs" });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: "YARN_ENABLE_SCRIPTS=false yarn install --immutable" });
  }, 60_000);

  it("falls back to cloning when yarn install fails in a node-modules repository, and says why", async () => {
    const { repo, worktree } = yarnRepo({
      lock: YARN1_LOCK, yarnBody: "mkdir -p node_modules/half-installed\necho 'error An unexpected error occurred' >&2\nexit 1",
    });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject(LEFT_PAD_CLONED);
    expect(result.fallbackReason).toBe("yarn install（classic） 失败：error An unexpected error occurred");
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
  }, 60_000);

  it("skips yarn and clones when yarn cannot be found, and says why", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject(LEFT_PAD_CLONED);
    expect(result.fallbackReason).toMatch(/^找不到 yarn/);
  }, 60_000);

  it("runs yarn through corepack when packageManager names yarn and no yarn command exists", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19" });
    withoutPackageManagers();
    const out = tempDir("plc-deps-corepack-out-");
    process.env.PATH = `${fakeBin("corepack", `echo "$@" > ${out}/args\nmkdir -p node_modules/from-corepack`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toBe("YARN_IGNORE_PATH=1 yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
  }, 60_000);

  it("finds yarn in ~/.yarn/bin when PATH has none", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    fakeBin("yarn", "mkdir -p node_modules/from-home-yarn", join(process.env.HOME as string, ".yarn", "bin"));
    expect((await startWorktreeDependencies(repo, worktree)).installedWith).toContain("yarn install");
    expect(existsSync(join(worktree, "node_modules", "from-home-yarn"))).toBe(true);
  }, 60_000);

  // PR #85 评审第 4 条：~/.yarn/bin 里只有 yarn 没有 node。yarn 是 `#!/usr/bin/env node` 的脚本，PATH 里没有 node 就跑不起来，
  // 所以要从 nvm、volta、Homebrew 这些目录里再找一个有 node 的放到 PATH 前面。假的 yarn 在找不到 node 时失败，真装不出来。
  it("puts a directory that has node on PATH when yarn comes from ~/.yarn/bin, which has no node", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    const nodeDir = fakeBin("node", "exit 0");
    setSystemBinDirsForTests([nodeDir]);
    fakeBin(
      "yarn",
      `[ "$(command -v node)" = "${nodeDir}/node" ] || { echo "env: node: No such file or directory" >&2; exit 127; }\nmkdir -p node_modules/from-home-yarn`,
      join(process.env.HOME as string, ".yarn", "bin"),
    );
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toContain("yarn install");
    expect(result.fallbackReason).toBeUndefined();
    expect(existsSync(join(worktree, "node_modules", "from-home-yarn"))).toBe(true);
  }, 60_000);

  // PR #85 评审第 2 条（2026-11-26）：berry 的 yarnPath 和插件、pnpm 的 .pnpmfile.cjs 是仓库自带的 JS，安装时会被运行。
  // daemon 在沙箱外装，所以碰到它们就不装也不克隆，状态写成 none:，提示让执行者在沙箱里自己装。
  describe("a repository that carries its own install-time JavaScript", () => {
    const NOT_RUN = "install-was-run";

    async function expectSkipped(repo: string, worktree: string, out: string, reason: RegExp): Promise<void> {
      const result = await startWorktreeDependencies(repo, worktree);
      expect(existsSync(join(out, NOT_RUN))).toBe(false);
      expect(result).toMatchObject({ cloned: [], error: null, skipped: expect.stringMatching(reason) });
      expect(result.installedWith).toBeUndefined();
      expect(existsSync(join(worktree, "node_modules"))).toBe(false);
      const line = readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8");
      expect(line).toMatch(/^none: /);
      // 执行者看到的提示：没准备，让它自己装。
      const note = dependenciesNote(worktree);
      expect(note).toContain("Dependencies were not prepared");
      expect(note).toContain("install them here yourself");
      expect(note).toMatch(reason);
    }

    const calledBody = (out: string): string => `echo run > ${out}/${NOT_RUN}\nmkdir -p node_modules/from-yarn`;

    it("does not install a yarn berry repository whose .yarnrc.yml sets yarnPath", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.1.0.cjs\n" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /yarnPath/);
    }, 60_000);

    it("does not install a yarn berry repository whose .yarnrc.yml lists plugins", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\nplugins:\n  - path: .yarn/plugins/x.cjs\n" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /plugins/);
    }, 60_000);

    it("does not install when package.json packageManager says yarn 2 or later", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, packageManager: "yarn@4.1.0+sha224.abc" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /packageManager/);
    }, 60_000);

    it("ignores yarnPath and plugins that are only in a comment", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\n# yarnPath: x.cjs\n# plugins:\n" });
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toBe("YARN_ENABLE_SCRIPTS=false yarn install --immutable");
      expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --immutable");
    }, 60_000);

    it("does not install a pnpm repository that has .pnpmfile.cjs", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME; // 找 pnpm 先看它，不然会用到本机真装的
      process.env.PATH = `${fakeBin("pnpm", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /\.pnpmfile\.cjs/);
    }, 60_000);

    it("still installs a pnpm repository without .pnpmfile.cjs", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME; // 找 pnpm 先看它，不然会用到本机真装的
      process.env.PATH = `${fakeBin("pnpm", `echo "$@" > ${out}/args\nmkdir -p node_modules/from-pnpm`)}:${process.env.PATH}`;
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.fallbackReason).toBeUndefined();
      expect(result.installedWith).toBe("pnpm install --frozen-lockfile --prefer-offline --ignore-scripts");
      expect(readFileSync(join(out, "args"), "utf8")).toContain("--frozen-lockfile");
    }, 60_000);

    // PR #85 再评审（#509）：yarn 1 的 .yarnrc 里 yarn-path 指向仓库里的 JS，yarn 一启动就会运行它，和 berry 的 yarnPath 一样。
    it("does not install a yarn 1 repository whose .yarnrc sets yarn-path", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19" });
      writeFileSync(join(worktree, ".yarnrc"), '# comment\nyarn-path ".yarn/releases/yarn-1.22.19.cjs"\n');
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /yarn-path/);
    }, 60_000);

    it("still installs yarn 1 when .yarnrc only has other settings or a commented yarn-path", async () => {
      const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
      writeFileSync(join(worktree, ".yarnrc"), '# yarn-path "x.cjs"\nyarn-offline-mirror "./mirror"\n');
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toContain("yarn install --frozen-lockfile");
    }, 60_000);

    // pnpm 的 pnpmfile 位置可以在 .npmrc 里改（pnpmfile、global-pnpmfile）：不在默认位置，也是仓库自带的 JS。
    it("does not install a pnpm repository whose .npmrc points pnpmfile at another script", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(worktree, ".npmrc"), "# registry stuff\npnpmfile=tools/custom-pnpmfile.cjs\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME;
      process.env.PATH = `${fakeBin("pnpm", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /pnpmfile/);
    }, 60_000);

    // PR #85 二次复审（#516）：pnpm 10 会加载 pnpm-workspace.yaml 里的 pnpmfile、globalPnpmfile，和 .npmrc 里的一样。
    it.each([
      ["pnpmfile", "packages:\n  - 'packages/*'\npnpmfile: tools/custom-pnpmfile.cjs\n", /pnpmfile/],
      ["globalPnpmfile", "packages:\n  - 'packages/*'\nglobalPnpmfile: ~/hooks.cjs\n", /globalPnpmfile/],
    ])("does not install a pnpm repository whose pnpm-workspace.yaml sets %s", async (_key, yaml, reason) => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(worktree, "pnpm-workspace.yaml"), yaml);
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME;
      process.env.PATH = `${fakeBin("pnpm", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, reason);
    }, 60_000);

    it("still installs a pnpm repository whose pnpm-workspace.yaml only lists packages or has a commented pnpmfile", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(worktree, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n# pnpmfile: x.cjs\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME;
      process.env.PATH = `${fakeBin("pnpm", `echo "$@" > ${out}/args\nmkdir -p node_modules/from-pnpm`)}:${process.env.PATH}`;
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toBe("pnpm install --frozen-lockfile --prefer-offline --ignore-scripts");
    }, 60_000);

    it("keeps installing yarn 1 even when it has a .pnpmfile.cjs, since only pnpm runs that file", async () => {
      const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19" });
      writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = {};\n");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toContain("yarn install --frozen-lockfile");
    }, 60_000);
  });

  describe("when a repository has several lockfiles", () => {
    // npm 和 yarn 都是假的，各记下自己被叫过。
    function both(packageManager?: string): { repo: string; worktree: string; out: string } {
      const made = yarnRepo({ lock: YARN1_LOCK, ...(packageManager ? { packageManager } : {}), extraLocks: { "package-lock.json": "{}\n" } });
      process.env.PATH = `${fakeNpmBin(`echo npm > ${made.out}/called\nmkdir -p node_modules/from-npm`)}:${process.env.PATH}`;
      process.env.PATH = `${fakeBin("yarn", `echo yarn > ${made.out}/called\nmkdir -p node_modules/from-yarn`)}:${process.env.PATH}`;
      return made;
    }

    it("follows the packageManager field and says so", async () => {
      const { repo, worktree, out } = both("yarn@1.22.19");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("yarn");
      expect(result.selectionNote).toBe("有几种锁文件（npm、yarn），package.json 的 packageManager 字段写的是 yarn，选了 yarn");
      expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8")).toContain("选了 yarn");
    }, 60_000);

    it("uses the fixed order when there is no packageManager field, and says so", async () => {
      const { repo, worktree, out } = both();
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("npm");
      expect(result.selectionNote).toBe("有几种锁文件（npm、yarn），package.json 没有 packageManager 字段，按固定顺序（pnpm、bun、npm、yarn）选了 npm");
    }, 60_000);

    it("uses the fixed order when the packageManager field names a manager whose lockfile is missing", async () => {
      const { repo, worktree, out } = both("pnpm@9.0.0");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("npm");
      expect(result.selectionNote).toContain("packageManager 字段写的是 pnpm，但它的锁文件不在其中");
    }, 60_000);

    it("only tries the chosen manager: when it fails the repository is cloned, the other one is not tried", async () => {
      const { repo, worktree, out } = both("yarn@1.22.19");
      process.env.PATH = `${fakeBin("yarn", `echo yarn > ${out}/called\nexit 1`)}:${process.env.PATH}`;
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("yarn");
      expect(result).toMatchObject(LEFT_PAD_CLONED);
      expect(result.fallbackReason).toMatch(/^yarn install（classic） 失败/);
      expect(result.selectionNote).toContain("选了 yarn");
    }, 60_000);
  });
});

// PR #85 二次复审（#516）：复用的工作区（返工、续接、daemon 重启后）里，执行者在沙箱里可能改过 .npmrc。
// `git=<脚本>` 加一个 git 依赖，npm ci --ignore-scripts 也会运行那个脚本。所以复用的工作区没有 node_modules 时，daemon 一律不装、不克隆。
describe.runIf(supported)("a reused worktree without node_modules (#516)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  const INSTALL_RAN = "install-was-run";

  function reusedNpmRepo(): { repo: string; worktree: string; out: string } {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    // 执行者改过的配置：npm 的 git 可执行文件指向仓库里的脚本。
    writeFileSync(join(worktree, ".npmrc"), "git=./tools/fake-git.sh\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-reused-out-");
    process.env.PATH = `${fakeNpmBin(`echo run > ${out}/${INSTALL_RAN}\nmkdir -p node_modules/from-npm`)}:${process.env.PATH}`;
    return { repo, worktree, out };
  }

  it("runs no install and does not clone, and tells the executor the command to run in the sandbox", async () => {
    const { repo, worktree, out } = reusedNpmRepo();
    const result = await startWorktreeDependencies(repo, worktree, undefined, { reused: true });
    expect(existsSync(join(out, INSTALL_RAN))).toBe(false);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false); // 用户的 checkout 里有 node_modules，也不克隆
    expect(result).toEqual({
      cloned: [], error: null, skipped: expect.stringMatching(/复用的工作区没有 node_modules/),
      reinstallCommand: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    const line = readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8");
    expect(line).toMatch(/^none: /);
    expect(line).toContain("`npm ci --prefer-offline --ignore-scripts --no-audit --no-fund`");
    const note = dependenciesNote(worktree);
    expect(note).toContain("Dependencies were not prepared");
    expect(note).toContain("install them here yourself with `npm ci --prefer-offline --ignore-scripts --no-audit --no-fund`");
  }, 60_000);

  it("still installs a newly created worktree (the same repository, not reused)", async () => {
    const { repo, worktree, out } = reusedNpmRepo();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(existsSync(join(out, INSTALL_RAN))).toBe(true);
    expect(result.installedWith).toContain("npm ci");
  }, 60_000);

  it("leaves a reused worktree that already has node_modules as ready", async () => {
    const { repo, worktree, out } = reusedNpmRepo();
    mkdirSync(join(worktree, "node_modules"));
    const result = await startWorktreeDependencies(repo, worktree, undefined, { reused: true });
    expect(existsSync(join(out, INSTALL_RAN))).toBe(false);
    expect(result).toMatchObject({ cloned: [], error: null, skipped: expect.stringMatching(/已经有 node_modules/) });
    expect(result.reinstallCommand).toBeUndefined();
    expect(readDependencyStatus(worktree)).toMatch(/^ready: node_modules was already in the worktree/);
  }, 60_000);

  it("writes none: without a command when the repository has no lockfile", async () => {
    const { repo, worktree } = monorepo();
    const result = await startWorktreeDependencies(repo, worktree, undefined, { reused: true });
    expect(result.reinstallCommand).toBeUndefined();
    expect(readDependencyStatus(worktree)).toMatch(/^none: 复用的工作区没有 node_modules[^`]*$/);
  }, 60_000);
});

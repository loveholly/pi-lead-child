// 部署闸门的判断（deploy/readiness.ts）。#89、#92、#93、#95 的 child 在主 checkout 里改代码、构建，随后的重启就把
// 没提交的代码部署上线了。supervisor 的维护入口按这里的判断拒绝（supervisor.test.ts 测入口本身）。
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  buildDaemonDist, deployReadiness, gitFailureKind, promoteStagedBuild, stagedCliDir, stagingDistDir, writeBuildProvenance,
  type GitExec,
} from "../src/deploy/readiness.js";

let checkout: string;
let dist: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", checkout, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
}

const readiness = () => deployReadiness(checkout, dist);
const reasons = () => readiness().reasons.join("\n");

beforeEach(() => {
  checkout = join(tempDir("plc-deploy-readiness-"), "checkout");
  dist = join(checkout, "apps", "daemon", "dist");
  mkdirSync(join(checkout, "packages", "engine", "src"), { recursive: true });
  mkdirSync(join(checkout, "packages", "engine", "test"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  writeFileSync(join(checkout, ".gitignore"), "dist/\n");
  writeFileSync(join(checkout, "package.json"), "{}\n");
  writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(checkout, "packages", "engine", "test", "index.test.ts"), "// test\n");
  mkdirSync(join(checkout, "artifacts"));
  writeFileSync(join(checkout, "artifacts", "evidence.json"), "{}\n");
  git("add", ".");
  git("commit", "-qm", "base");
  mkdirSync(dist, { recursive: true });
});

describe("deploy readiness", () => {
  it("passes a clean checkout with a clean build of a commit in its history", () => {
    const built = writeBuildProvenance(checkout, dist);
    expect(readiness()).toMatchObject({ ready: true, reasons: [], head: built.commit, build: { commit: built.commit, dirty: false } });
  });

  it("refuses an uncommitted change to code, and names the file", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 2;\n");
    expect(readiness().ready).toBe(false);
    expect(reasons()).toContain("packages/engine/src/index.ts");
  });

  it("counts a new file under packages/ and a change to the root package.json", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "packages", "engine", "src", "new.ts"), "export {};\n");
    expect(reasons()).toContain("packages/engine/src/new.ts");
    git("add", "packages/engine/src/new.ts");
    git("commit", "-qm", "new");
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "package.json"), "{\"dependencies\":{}}\n");
    expect(reasons()).toContain("package.json");
  });

  it("does not count notes, test evidence under artifacts/, or test files", () => {
    writeBuildProvenance(checkout, dist);
    mkdirSync(join(checkout, ".scratch"));
    writeFileSync(join(checkout, ".scratch", "notes.md"), "notes\n");
    // 有个测试每次跑都会改写 artifacts/ 里的证据文件。
    writeFileSync(join(checkout, "artifacts", "evidence.json"), "{\"rewritten\":true}\n");
    writeFileSync(join(checkout, "packages", "engine", "test", "index.test.ts"), "// changed test\n");
    writeFileSync(join(checkout, "packages", "engine", "src", "extra.spec.ts"), "// new spec\n");
    expect(readiness()).toMatchObject({ ready: true, reasons: [] });
  });

  it("refuses a dist without a build record, or one built from uncommitted code", () => {
    expect(reasons()).toContain("build-info.json");
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 3;\n");
    writeBuildProvenance(checkout, dist);
    git("checkout", "--", ".");
    expect(reasons()).toContain("不是从一个已提交的 commit 构建的");
  });

  it("refuses a build of a commit that is not in the current branch's history", () => {
    git("checkout", "-qb", "side");
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 4;\n");
    git("commit", "-qam", "side");
    const side = writeBuildProvenance(checkout, dist);
    git("checkout", "-q", "main");
    expect(reasons()).toContain(`${side.commit} 不在主 checkout 当前分支的历史里`);
  });

  it("passes when HEAD moved on after the build: the build is still a committed ancestor", () => {
    const built = writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "README.md"), "later\n");
    git("add", "README.md");
    git("commit", "-qm", "later");
    expect(readiness()).toMatchObject({ ready: true, build: { commit: built.commit } });
  });

  // 2026-11-02：dist 落后于 HEAD 时闸门照样放行，重启跑的还是旧代码。rebuild 告诉维护先从 HEAD 构建。
  it("asks for a rebuild when the checkout is clean but dist is not a clean build of HEAD", () => {
    expect(readiness()).toMatchObject({ ready: false, rebuild: true });
    const built = writeBuildProvenance(checkout, dist);
    expect(readiness()).toMatchObject({ ready: true, rebuild: false, head: built.commit });
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 5;\n");
    git("commit", "-qam", "the fix");
    expect(readiness()).toMatchObject({ ready: true, rebuild: true });
  });

  it("does not ask for a rebuild of a checkout with uncommitted code", () => {
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 6;\n");
    expect(readiness()).toMatchObject({ ready: false, rebuild: false });
  });

  it("asks for a rebuild of a dist built from uncommitted code once the checkout is clean again", () => {
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 7;\n");
    writeBuildProvenance(checkout, dist);
    git("checkout", "--", ".");
    expect(readiness()).toMatchObject({ ready: false, rebuild: true });
  });

  // 审查 2026-11-02：只有 HEAD 往前走了才自动构建。dist 来自别的分支、commit 不在仓库里，照旧拒绝，不构建。
  it("does not ask for a rebuild of a build from another branch or a commit missing from the repository", () => {
    git("checkout", "-qb", "side");
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 8;\n");
    git("commit", "-qam", "side");
    writeBuildProvenance(checkout, dist);
    git("checkout", "-q", "main");
    expect(readiness()).toMatchObject({ ready: false, rebuild: false });
    writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false }));
    expect(readiness()).toMatchObject({ ready: false, rebuild: false });
  });

  // 审查 2026-11-02：构建期间 HEAD 变了，dist 里可能混着两个 commit 的代码。
  it("marks a build dirty when HEAD changed while it ran", () => {
    const start = git("rev-parse", "HEAD");
    writeFileSync(join(checkout, "README.md"), "during the build\n");
    git("add", "README.md");
    git("commit", "-qm", "during");
    const built = writeBuildProvenance(checkout, dist, start);
    expect(built).toMatchObject({ dirty: true, dirtyFiles: [expect.stringContaining(start)] });
    expect(readiness()).toMatchObject({ ready: false, rebuild: true });
  });
});

// 2026-11-02：系统负载高时 git 超时，闸门把 cat-file 的超时报成「不在这个仓库里」，把 merge-base 的超时报成
// 「不在当前分支的历史里」，用户照着去重建，其实 commit 好好的。超时只能说「无法判断」，但照样拒绝部署。
describe("deploy readiness when git fails", () => {
  const timeoutError = () => Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM" });
  // 真的跑 git，只让 args[0] 是 subcommand 的那一次超时。
  const timingOut = (subcommand: string): GitExec => (root, args, timeoutMs) => {
    if (args[0] === subcommand) throw timeoutError();
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  };

  it("says it cannot tell, not that the commit is missing, when cat-file times out", () => {
    writeBuildProvenance(checkout, dist);
    const result = deployReadiness(checkout, dist, { execGit: timingOut("cat-file") });
    expect(result.ready).toBe(false);
    const text = result.reasons.join("\n");
    expect(text).toContain("git 超时");
    expect(text).not.toContain("不在这个仓库里");
  });

  it("says it cannot tell, not that the commit is off the branch, when merge-base times out", () => {
    writeBuildProvenance(checkout, dist);
    const result = deployReadiness(checkout, dist, { execGit: timingOut("merge-base") });
    expect(result.ready).toBe(false);
    const text = result.reasons.join("\n");
    expect(text).toContain("git 超时");
    expect(text).not.toContain("不在主 checkout 当前分支的历史里");
  });

  // 审查 2026-11-02：git 说不清 dist 的 commit 在不在历史里时，照旧拒绝，不自动构建。
  it("does not ask for a rebuild when git cannot tell where the build commit is", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "README.md"), "later\n");
    git("add", "README.md");
    git("commit", "-qm", "later");
    expect(readiness()).toMatchObject({ ready: true, rebuild: true });
    for (const subcommand of ["cat-file", "merge-base"]) {
      expect(deployReadiness(checkout, dist, { execGit: timingOut(subcommand) })).toMatchObject({ ready: false, rebuild: false });
    }
  });

  it("still says a commit is not in the repository when git really cannot find it", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false }));
    expect(reasons()).toContain("0123456789abcdef0123456789abcdef01234567 不在这个仓库里");
  });

  it("passes the timeout to every git call", () => {
    writeBuildProvenance(checkout, dist);
    const seen: number[] = [];
    const execGit: GitExec = (root, args, timeoutMs) => {
      seen.push(timeoutMs);
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    expect(deployReadiness(checkout, dist, { execGit, timeoutMs: 42_000 }).ready).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([42_000]));
  });
});

describe("gitFailureKind", () => {
  it("tells a timeout or a signal from a missing object, a non-ancestor, and anything else", () => {
    expect(gitFailureKind(Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM" }))).toBe("timeout");
    expect(gitFailureKind(Object.assign(new Error("killed"), { status: null, signal: "SIGKILL" }))).toBe("killed");
    expect(gitFailureKind(Object.assign(new Error("Command failed"), {
      status: 128, signal: null, stderr: "fatal: Not a valid object name 0123abc^{commit}\n",
    }))).toBe("missing");
    expect(gitFailureKind(Object.assign(new Error("Command failed"), { status: 1, signal: null, stderr: "" }))).toBe("not_ancestor");
    expect(gitFailureKind(Object.assign(new Error("Command failed"), { status: 128, signal: null, stderr: "fatal: not a git repository\n" }))).toBe("other");
    expect(gitFailureKind("boom")).toBe("other");
  });
});

// 维护时 supervisor 用它从 HEAD 构建（server.ts 的 executeMaintenance）。这里用假的构建脚本，不跑真的构建。
describe("building dist for maintenance", () => {
  // 假的 checkout：apps/cli 和 apps/daemon 各有一个 scripts/build.ts。node_modules 指向本仓库，--import tsx 才找得到。
  function fakeRoot(scripts: { cli?: string; daemon: string }): string {
    const root = tempDir("plc-build-dist-");
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    for (const [app, body] of Object.entries({ cli: "", ...scripts })) {
      mkdirSync(join(root, "apps", app, "scripts"), { recursive: true });
      writeFileSync(join(root, "apps", app, "scripts", "build.ts"), body);
    }
    return root;
  }

  it("builds the cli, then the daemon", async () => {
    const root = fakeRoot({
      cli: `import { writeFileSync } from "node:fs"; writeFileSync("../../order.txt", "cli\\n", { flag: "a" });`,
      daemon: `import { writeFileSync } from "node:fs"; writeFileSync("../../order.txt", "daemon\\n", { flag: "a" });`,
    });
    await buildDaemonDist(root);
    expect(readFileSync(join(root, "order.txt"), "utf8")).toBe("cli\ndaemon\n");
  }, 60_000);

  it("rejects with the last lines of the output when the build fails", async () => {
    const root = fakeRoot({ daemon: `console.error("Could not resolve ./missing.js"); process.exit(3);` });
    await expect(buildDaemonDist(root)).rejects.toThrow(/退出码 3.*Could not resolve/);
  }, 60_000);

  // 审查 2026-11-02：supervisor 的环境里有从钥匙串读进来的密钥（main.ts），构建不需要它们。
  it("does not hand the supervisor's secrets to the build", async () => {
    process.env.PLC_TEST_FAKE_SECRET = "fake-secret-value";
    try {
      const root = fakeRoot({ daemon: `console.error("seen:" + (process.env.PLC_TEST_FAKE_SECRET ?? "none")); process.exit(1);` });
      await expect(buildDaemonDist(root)).rejects.toThrow("seen:none");
    } finally {
      delete process.env.PLC_TEST_FAKE_SECRET;
    }
  }, 60_000);

  // 审查 2026-11-02：以前到时只发 SIGTERM，不理 SIGTERM 的构建一直不结束，维护一直卡在 running。
  it("kills a build that ignores SIGTERM, and always settles", async () => {
    const root = fakeRoot({ daemon: `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);` });
    const started = Date.now();
    // 时限 3 秒：假脚本早就装好了 SIGTERM 处理。
    await expect(buildDaemonDist(root, { timeoutMs: 3_000, killGraceMs: 500 })).rejects.toThrow(/SIGKILL|时限/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  // 二审 2026-11-02：维护时构建到暂存目录，备份成功以后才换进 dist。
  // 三审 2026-11-03：cli 也是。以前 cli 直接写进 apps/cli/dist，daemon 构建失败时 cli 已经是新的、daemon 还是旧的。
  it("builds the daemon and the cli into the given outdirs", async () => {
    const recordArgv = (app: string) => `import { writeFileSync } from "node:fs"; writeFileSync("../../${app}-argv.json", JSON.stringify(process.argv.slice(2)));`;
    const root = fakeRoot({ cli: recordArgv("cli"), daemon: recordArgv("daemon") });
    await buildDaemonDist(root, { outdir: "/tmp/plc-staged-example", cliOutdir: "/tmp/plc-staged-example/cli" });
    expect(JSON.parse(readFileSync(join(root, "daemon-argv.json"), "utf8"))).toEqual(["--outdir", "/tmp/plc-staged-example"]);
    expect(JSON.parse(readFileSync(join(root, "cli-argv.json"), "utf8"))).toEqual(["--outdir", "/tmp/plc-staged-example/cli"]);
  }, 60_000);

  it("stops at once when it is cancelled", async () => {
    const root = fakeRoot({ daemon: `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);` });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1_500);
    const started = Date.now();
    await expect(buildDaemonDist(root, { signal: abort.signal, killGraceMs: 500 })).rejects.toThrow("取消");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

// 维护时把暂存的构建换进去（server.ts 的 executeMaintenance，备份成功、停机之前）。
describe("swapping the staged build in", () => {
  function staged(): { distDir: string; cliDir: string } {
    const root = tempDir("plc-promote-");
    const distDir = join(root, "apps", "daemon", "dist");
    const cliDir = join(root, "apps", "cli", "dist");
    mkdirSync(join(distDir, "web"), { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(distDir, "coordinatord.mjs"), "// old daemon\n");
    writeFileSync(join(distDir, "build-info.json"), "old\n");
    writeFileSync(join(distDir, "web", "index.html"), "web\n");
    writeFileSync(join(cliDir, "cli.mjs"), "// old cli\n");
    mkdirSync(stagedCliDir(distDir), { recursive: true });
    writeFileSync(join(stagingDistDir(distDir), "coordinatord.mjs"), "// new daemon\n");
    writeFileSync(join(stagingDistDir(distDir), "build-info.json"), "new\n");
    writeFileSync(join(stagedCliDir(distDir), "cli.mjs"), "// new cli\n");
    return { distDir, cliDir };
  }

  it("swaps the daemon and the cli in together, and leaves dist/web alone", () => {
    const { distDir, cliDir } = staged();
    promoteStagedBuild(distDir, cliDir);
    expect(readFileSync(join(distDir, "coordinatord.mjs"), "utf8")).toBe("// new daemon\n");
    expect(readFileSync(join(distDir, "build-info.json"), "utf8")).toBe("new\n");
    expect(readFileSync(join(cliDir, "cli.mjs"), "utf8")).toBe("// new cli\n");
    expect(readFileSync(join(distDir, "web", "index.html"), "utf8")).toBe("web\n");
    expect(readdirSync(distDir).sort()).toEqual(["build-info.json", "coordinatord.mjs", "web"]);
  });

  // 三审 2026-11-03：换到一半出错（这里是 cli 的目录不让写：daemon 已经换进去了），旧 cli 和旧 daemon 都要留在原处。
  it("puts the old daemon and the old cli back when the swap fails halfway", () => {
    const { distDir, cliDir } = staged();
    chmodSync(cliDir, 0o555);
    try {
      expect(() => promoteStagedBuild(distDir, cliDir)).toThrow("已经换回原来的构建");
    } finally {
      chmodSync(cliDir, 0o755);
    }
    expect(readFileSync(join(distDir, "coordinatord.mjs"), "utf8")).toBe("// old daemon\n");
    expect(readFileSync(join(distDir, "build-info.json"), "utf8")).toBe("old\n");
    expect(readFileSync(join(cliDir, "cli.mjs"), "utf8")).toBe("// old cli\n");
    expect(readdirSync(distDir).filter((name) => name.startsWith(".prev-"))).toEqual([]);
    // 暂存的构建还在，调用方（refuseBeforeStop）丢掉它。
    expect(existsSync(join(stagingDistDir(distDir), "coordinatord.mjs"))).toBe(true);
  });
});

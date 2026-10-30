// 临时目录工具（testing/temp-dirs.ts）的决策边界：哪些目录算作测试文件新建、没有删除的目录，哪些不算。
// 还有根 vitest 配置的 setup 文件（vitest.setup.ts）在测试文件结束时怎样处理这些目录：
// 用 fixture 配置另起一个 vitest，跑 fixtures/temp-dirs 里的测试文件，再看结果和磁盘。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { expectTempDirsRemoved, removeTempDirs, tempDir, watchTempDirs, type TempDirWatch } from "../testing/temp-dirs.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURES = join(ROOT, "packages/core/test/fixtures/temp-dirs");

// 测试自己用 mkdtemp 或 mkdir 新建的目录。测试结束时删除，所以根 setup 文件的检查不会报告它们。
const made: string[] = [];
const watches: TempDirWatch[] = [];

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function own(path: string): string {
  made.push(path);
  return path;
}

function watch(): TempDirWatch {
  const started = watchTempDirs();
  watches.push(started);
  return started;
}

function leftPaths(watched: TempDirWatch): string[] {
  return watched.left().map((dir) => dir.path).sort();
}

// 名字唯一、还不存在的 plc-* 路径，给 mkdir 用。
function freshPath(label: string): string {
  return join(tmpdir(), `plc-temp-dirs-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("tempDir", () => {
  it("makes a new plc-* folder directly under os.tmpdir(), and removeTempDirs removes it", () => {
    const dir = tempDir("plc-temp-dirs-");
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toMatch(/^plc-temp-dirs-[\w-]{6}$/);
    expect(existsSync(dir)).toBe(true);
    mkdirSync(join(dir, "nested", "deeper"), { recursive: true });

    removeTempDirs();
    expect(existsSync(dir)).toBe(false);
  });

  it("uses plc- as the default prefix", () => {
    const dir = tempDir();
    expect(basename(dir)).toMatch(/^plc-[\w-]{6}$/);
    removeTempDirs();
    expect(existsSync(dir)).toBe(false);
  });

  it("accepts only a plc- prefix that names one folder", () => {
    expect(() => tempDir("findup-")).toThrow(/plc-/);
    expect(() => tempDir("plc-a/b-")).toThrow(/plc-/);
    expect(() => tempDir("plc-../escape-")).toThrow(/plc-/);
  });
});

describe("watchTempDirs", () => {
  it("records the plc-* folders that this process makes directly under os.tmpdir() and does not remove", async () => {
    const watched = watch();
    const sync = own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-sync-")));
    const promised = own(await mkdtemp(join(tmpdir(), "plc-temp-dirs-promise-")));
    const recursive = own(freshPath("mkdir"));
    mkdirSync(join(recursive, "a", "b"), { recursive: true });
    const single = own(freshPath("mkdir-promise"));
    await mkdir(single);

    expect(leftPaths(watched)).toEqual([sync, promised, recursive, single].sort());
    const where = watched.left().find((dir) => dir.path === sync)?.createdAt;
    expect(where).toContain("temp-dirs.test.ts");
  });

  it("forgets a folder after the test removes it", () => {
    const watched = watch();
    const dir = own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-removed-")));
    rmSync(dir, { recursive: true });
    expect(leftPaths(watched)).toEqual([]);
  });

  it("ignores folders that are not plc-* or not directly under os.tmpdir()", () => {
    const watched = watch();
    const other = own(mkdtempSync(join(tmpdir(), "temp-dirs-other-")));
    mkdtempSync(join(other, "plc-nested-"));
    mkdirSync(join(other, "plc-nested-mkdir"));
    expect(leftPaths(watched)).toEqual([]);
  });

  it("ignores folders made before the watch started or after it stopped", () => {
    own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-before-")));
    const watched = watch();
    watched.stop();
    own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-after-")));
    expect(leftPaths(watched)).toEqual([]);
  });

  it("does not count a folder that another process makes", () => {
    const watched = watch();
    const foreign = own(execFileSync(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'plc-temp-dirs-foreign-')))",
    ], { encoding: "utf8" }));
    expect(existsSync(foreign)).toBe(true);
    expect(leftPaths(watched)).toEqual([]);
  });
});

describe("expectTempDirsRemoved", () => {
  it("passes when every recorded folder is gone", () => {
    const watched = watch();
    rmSync(mkdtempSync(join(tmpdir(), "plc-temp-dirs-gone-")), { recursive: true });
    expect(() => expectTempDirsRemoved(watched)).not.toThrow();
  });

  it("lists every folder left and where it was made, and does not delete it", () => {
    const watched = watch();
    const left = own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-left-")));
    let message = "";
    try {
      expectTempDirsRemoved(watched, { owner: "this test" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("this test left 1 plc-* temp folder");
    expect(message).toContain(left);
    expect(message).toContain("temp-dirs.test.ts");
    expect(existsSync(left)).toBe(true);
  });
});

interface FileResult {
  name: string;
  status: string;
  message: string;
}

// 用 fixture 配置另起一个 vitest。它的 setup 文件就是根 vitest.setup.ts。
async function runFixtures(out: string): Promise<FileResult[]> {
  const report = join(out, "report.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")));
  const child = spawn(process.execPath, [
    join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", join(FIXTURES, "vitest.config.ts"),
  ], { cwd: ROOT, env: { ...env, PLC_TEMP_DIRS_FIXTURE_OUT: out, PLC_TEMP_DIRS_FIXTURE_REPORT: report }, stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const parsed = JSON.parse(readFileSync(report, "utf8")) as { testResults: FileResult[] };
  return parsed.testResults;
}

// fixture 写下的目录和进程。fixture 没有运行到写文件时，返回 out 里一个不存在的路径，断言会失败。
function fixtureRecord(out: string, name: string): { dir: string; pid?: number } {
  const path = join(out, `${name}.json`);
  if (!existsSync(path)) return { dir: join(out, `${name}-did-not-run`) };
  return JSON.parse(readFileSync(path, "utf8")) as { dir: string; pid?: number };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the root vitest setup file", () => {
  it("removes tempDir folders after a file, fails a file that leaves a plc-* folder, and keeps folders while processes still run", async () => {
    const out = own(mkdtempSync(join(tmpdir(), "plc-temp-dirs-fixture-out-")));
    const results = await runFixtures(out);
    const result = (name: string) => results.find((file) => basename(file.name) === `${name}.fixture.ts`);
    // 先登记 fixture 的目录和进程，断言失败时也能清理。
    const [tidy, leaky, busy] = ["tidy", "leaky", "busy"].map((name) => fixtureRecord(out, name));
    for (const record of [tidy!, leaky!, busy!]) own(record.dir);
    try {
      // tempDir 新建的目录：测试文件结束时删除，文件通过。
      expect(result("tidy")?.status).toBe("passed");
      expect(existsSync(tidy!.dir)).toBe(false);

      // 测试自己用 mkdtempSync 新建、没有删除的目录：文件失败，报告列出目录和新建它的位置，目录还在。
      expect(result("leaky")?.status).toBe("failed");
      expect(result("leaky")?.message).toContain(leaky!.dir);
      expect(result("leaky")?.message).toContain("leaky.fixture.ts");
      expect(existsSync(leaky!.dir)).toBe(true);

      // 测试启动的进程在文件结束时还在：文件失败，tempDir 新建的目录不删除，因为进程可能还在用它。
      expect(result("busy")?.status).toBe("failed");
      expect(result("busy")?.message).toContain("left 1 process");
      expect(result("busy")?.message).toContain(`${busy!.dir} (kept`);
      expect(existsSync(busy!.dir)).toBe(true);
    } finally {
      if (busy?.pid && alive(busy.pid)) process.kill(busy.pid, "SIGKILL");
    }
  }, 60_000);
});

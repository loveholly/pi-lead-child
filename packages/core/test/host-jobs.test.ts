// 删目录树交给子进程（lead-scheduler spec P0）：core 的 removeTree 和后台作业的登记。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemovableTree, describeHostJobs, removeTree, removeTreeCommand, runningHostJobs, schedLine, setHostJobLog, trackHostJob,
} from "../src/index.js";
import { tempDir } from "../testing/index.js";

// vitest.setup.ts 让测试里的后台删除用 utility；这里的用例按需改，结束时还原。
const SETUP_DELETE_IO = process.env.PLC_BACKGROUND_DELETE_IO;
afterEach(() => {
  setHostJobLog(null);
  if (SETUP_DELETE_IO === undefined) delete process.env.PLC_BACKGROUND_DELETE_IO;
  else process.env.PLC_BACKGROUND_DELETE_IO = SETUP_DELETE_IO;
});

function tree(root: string, files: number): string {
  const path = join(root, "worktree");
  for (let index = 0; index < files; index += 1) {
    const dir = join(path, "node_modules", `pkg${index % 7}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${index}.js`), "module.exports = 1;\n");
  }
  return path;
}

describe("removeTree", () => {
  it("deletes a tree in a child process and logs the job's start and end", async () => {
    const lines: string[] = [];
    setHostJobLog((line) => lines.push(line));
    const path = tree(tempDir("plc-host-jobs-"), 200);

    const deleting = removeTree(path, { kind: "worktree-delete", label: "workspace #7" });
    const [job] = runningHostJobs();
    expect(job).toMatchObject({ kind: "worktree-delete", label: "workspace #7", pid: expect.any(Number) });
    expect(describeHostJobs()).toContain("worktree-delete#");
    await deleting;

    expect(existsSync(path)).toBe(false);
    expect(runningHostJobs()).toEqual([]);
    expect(lines[0]).toMatch(/^\[sched\] job\.start id=\d+ kind=worktree-delete label="workspace #7" pid=\d+ io=(utility|default)$/);
    expect(lines[1]).toMatch(/^\[sched\] job\.end id=\d+ kind=worktree-delete label="workspace #7" pid=\d+ ms=\d+ exit=0$/);
  });

  it("succeeds when the directory is already gone", async () => {
    await expect(removeTree(join(tempDir("plc-host-jobs-"), "missing"))).resolves.toBeUndefined();
  });

  it("refuses targets that are not one concrete directory", () => {
    expect(() => assertRemovableTree("relative/path")).toThrow(/not an absolute path/);
    expect(() => assertRemovableTree("/")).toThrow(/too close to the root/);
    expect(() => assertRemovableTree("/Users/alice")).toThrow(/too close to the root/);
    expect(() => assertRemovableTree(homedir())).toThrow(/refusing to remove/);
    expect(() => assertRemovableTree(join(homedir(), ".."))).toThrow();
    expect(() => assertRemovableTree("/tmp/a\0b/c")).toThrow(/invalid/);
    expect(assertRemovableTree("/tmp/x/../y/worktree")).toBe("/tmp/y/worktree");
  });

  it("runs rm at background I/O priority unless someone waits for it", () => {
    delete process.env.PLC_BACKGROUND_DELETE_IO;
    const target = "/tmp/plc-x/worktree";
    if (process.platform !== "darwin") {
      expect(removeTreeCommand(target)).toEqual({ command: "/bin/rm", args: ["-rf", "--", target], io: "default" });
      return;
    }
    expect(removeTreeCommand(target))
      .toEqual({ command: "/usr/sbin/taskpolicy", args: ["-b", "/bin/rm", "-rf", "--", target], io: "background" });
    expect(removeTreeCommand(target, "utility"))
      .toEqual({ command: "/usr/sbin/taskpolicy", args: ["-d", "utility", "/bin/rm", "-rf", "--", target], io: "utility" });
    process.env.PLC_BACKGROUND_DELETE_IO = "utility";
    expect(removeTreeCommand(target).args.slice(0, 2)).toEqual(["-d", "utility"]);
  });
});

describe("the job registry", () => {
  it("lists a tracked job while it runs and forgets it when it fails", async () => {
    const lines: string[] = [];
    setHostJobLog((line) => lines.push(line));
    let release!: () => void;
    const running = trackHostJob("index-rebuild", "memory", () => new Promise<void>((_, reject) => {
      release = () => reject(new Error("disk full"));
    }));
    expect(runningHostJobs().map((job) => job.kind)).toEqual(["index-rebuild"]);
    release();
    await expect(running).rejects.toThrow("disk full");
    expect(runningHostJobs()).toEqual([]);
    expect(lines.at(-1)).toMatch(/job\.end .*ok=false error="disk full"/);
  });

  it("writes [sched] lines with quoted values only where needed", () => {
    expect(schedLine("step", { unit: 3, stage: "A", reason: "pool busy", none: null, skipped: undefined }))
      .toBe('[sched] step unit=3 stage=A reason="pool busy" none=null');
  });
});

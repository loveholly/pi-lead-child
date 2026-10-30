// 沙箱里的 bash（lead-tools-and-routing spec D2）：用真的沙箱跑，只在 macOS 和 Linux 上跑。
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxPolicy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { resetSandboxForTests, sandboxedBashOperations } from "../src/sandbox/bash.js";

const supported = process.platform === "darwin" || process.platform === "linux";

async function run(ops: ReturnType<typeof sandboxedBashOperations>, command: string, cwd: string) {
  let output = "";
  const result = await ops.exec(command, cwd, { onData: (data) => { output += data.toString(); }, timeout: 30 });
  return { exitCode: result.exitCode, output: output.trim() };
}

describe.runIf(supported)("sandboxedBashOperations", () => {
  // 能写的目录放在 home 下面（不在系统临时目录里），这样才看得出「临时目录以外」被拦。沙箱的 home 是这里的一个假目录
  // （2026-10-28 起整个 home 能写）：other 不在假 home 里，私钥、启动文件也都是假的，挡不住时也不碰用户真的文件。
  const base = mkdtempSync(join(homedir(), ".plc-sandbox-test-"));
  const writable = join(base, "writable");
  const other = join(base, "other");
  const fakeHome = join(base, "home");
  mkdirSync(writable);
  mkdirSync(other);
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  mkdirSync(join(fakeHome, ".config", "clime"), { recursive: true });
  mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
  writeFileSync(join(fakeHome, ".ssh", "id_test"), "dummy private key\n");
  writeFileSync(join(fakeHome, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n");
  writeFileSync(join(fakeHome, ".config", "clime", "credentials.json"), "{\"token\":\"dummy\"}\n");
  const policyFor = (env: Record<string, string> = {}) =>
    sandboxPolicy({ role: "executor", writable: [writable], env, home: fakeHome, dataDir: join(fakeHome, ".pi-lead-child") });
  const ops = sandboxedBashOperations(() => policyFor());

  afterAll(async () => {
    await resetSandboxForTests();
    const { rmSync } = await import("node:fs");
    rmSync(base, { recursive: true, force: true });
  });

  it("writes inside the run's directory and the temp dir", async () => {
    // 系统临时目录里的目录用 tempDir() 建：测试结束时由 vitest.setup 清掉。
    const temp = tempDir("plc-sbx-");
    const result = await run(ops, `echo inside > ${writable}/a.txt && echo temp > ${temp}/b.txt && echo ok`, writable);
    expect(result.output).toContain("ok");
    expect(readFileSync(join(writable, "a.txt"), "utf8").trim()).toBe("inside");
    expect(readFileSync(join(temp, "b.txt"), "utf8").trim()).toBe("temp");
  }, 60_000);

  it("cannot write outside home and the run's directories", async () => {
    const result = await run(ops, `echo outside > ${other}/c.txt`, writable);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(other, "c.txt"))).toBe(false);
  }, 60_000);

  // 2026-10-28 用户：「能读各个 CLI 自己的登录文件，只挡……私钥」。
  it("reads a CLI's own login and ssh's known_hosts, but not a private key", async () => {
    const login = await run(ops, `cat ${fakeHome}/.config/clime/credentials.json && cat ${fakeHome}/.ssh/known_hosts`, writable);
    expect(login.exitCode).toBe(0);
    expect(login.output).toContain("dummy");
    expect(login.output).toContain("github.com");
    const key = await run(ops, `cat ${fakeHome}/.ssh/id_test`, writable);
    expect(key.exitCode).not.toBe(0);
    expect(key.output).not.toContain("dummy private key");
  }, 60_000);

  // 2026-10-28 用户：「能写整个 home……只挡绕出沙箱的路径」。
  it("writes a CLI's login in home, but not shell startup files, PATH dirs or plc's own config", async () => {
    const withPath = sandboxedBashOperations(() => policyFor({ PATH: `${fakeHome}/.local/bin:/usr/bin:/bin` }));
    const saved = await run(withPath, `echo '{"token":"new"}' > ${fakeHome}/.config/clime/credentials.json && echo saved`, writable);
    expect(saved.output).toContain("saved");
    for (const target of [
      `${fakeHome}/.zshenv`, `${fakeHome}/.zshrc`, `${fakeHome}/.local/bin/git`, `${fakeHome}/Library/LaunchAgents/x.plist`,
      `${fakeHome}/.pi-lead-child/config.json`, `${fakeHome}/.claude/settings.json`,
    ]) {
      const result = await run(withPath, `mkdir -p "$(dirname ${target})" 2>/dev/null; echo evil > ${target}`, writable);
      expect({ target, written: existsSync(target) && readFileSync(target, "utf8").includes("evil") }).toEqual({ target, written: false });
      expect(result.exitCode, target).not.toBe(0);
    }
  }, 90_000);

  it("does not pass secret-named variables to the command", async () => {
    process.env.PLC_SANDBOX_TEST_TOKEN = "should-not-leak";
    try {
      const result = await run(ops, "echo \"value=${PLC_SANDBOX_TEST_TOKEN:-none}\"", writable);
      expect(result.output).toBe("value=none");
    } finally {
      delete process.env.PLC_SANDBOX_TEST_TOKEN;
    }
  }, 60_000);
});

// 2026-10-28：在隔离 worktree 里 git commit 要写仓库的 .git（worktree 外面）。放开它，但不放开 hooks 和 config：
// 沙箱里写的钩子会在用户下次在沙箱外跑 git 时执行。
describe.runIf(supported)("git inside the sandbox", () => {
  it("commits in a linked worktree but cannot plant a hook or change the repository config", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const base = mkdtempSync(join(homedir(), ".plc-sandbox-git-"));
    try {
      const repo = join(base, "repo");
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
      execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
      const worktree = join(base, "repo.plc-workspaces", "item-1");
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "plc/item-1", worktree]);
      const ops = sandboxedBashOperations(() => sandboxPolicy({ role: "executor", writable: [worktree], env: {} }));
      const commit = await run(ops, "echo b > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm work && git log --oneline | wc -l", worktree);
      expect(commit.exitCode).toBe(0);
      expect(commit.output.trim()).toBe("2");
      const hook = await run(ops, `echo evil > ${join(repo, ".git", "hooks", "post-checkout")}`, worktree);
      expect(hook.exitCode).not.toBe(0);
      expect(existsSync(join(repo, ".git", "hooks", "post-checkout"))).toBe(false);
      const config = await run(ops, `git config --file ${join(repo, ".git", "config")} core.hooksPath /tmp/evil`, worktree);
      expect(config.exitCode).not.toBe(0);
      expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("hooksPath");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(base, { recursive: true, force: true });
    }
  }, 90_000);
});

// bin/plc 作为独立进程运行。bin/plc 先运行 apps/cli/dist 里的构建产物，PLC_DEV=1 时运行 src 里的源码。
// 这里固定用 PLC_DEV=1，所以结果不取决于有没有构建。这些用例都不需要 daemon，也不会拉起 daemon：
// 参数检查发生在连接 daemon 之前。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { workspaceDir } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";

let dir: string;
beforeEach(() => { dir = tempDir("plc-cli-"); });

function plc(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(join(workspaceDir("cli"), "bin", "plc"), args, {
      env: { ...process.env, PLC_DEV: "1", PLC_DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("bin/plc", () => {
  it("runs the CLI that lives in apps/cli", async () => {
    const result = await plc(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: plc");
    expect(result.stdout).not.toMatch(/^\s+work\b/m);
  }, 30_000);

  it("checks arguments before it contacts or starts the daemon", async () => {
    const unknown = await plc(["recheck", "gemini"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("pi | codex | claude");
    const unconfirmed = await plc(["aish", "forget"]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");
    expect(existsSync(join(dir, "supervisor.log"))).toBe(false);
    expect(existsSync(join(dir, "cli-credential.json"))).toBe(false);
  }, 30_000);
});

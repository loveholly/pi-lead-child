// daemon 的运维入口（构建后是 dist/ops.mjs）。plc 按 distDir() 运行它，把输出原样转给用户。
// 安装、卸载、首次启动、doctor 和 lead 模型配置都在这里：它们要用 daemon 这一侧的包，
// plc 只依赖 client、protocol 和 core。这里只测没有副作用的命令。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "@pi-lead-child/store";
import { beforeEach, describe, expect, it } from "vitest";
import { packageSource } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";

let dir: string;
beforeEach(() => { dir = tempDir("plc-ops-"); });

function ops(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", packageSource("daemon", "ops.ts"), ...args], {
      env: { ...process.env, PLC_DATA_DIR: dir, PLC_LEAD_MODEL: "" },
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

describe("the ops entry", () => {
  it("shows the lead model and providers without printing an API key", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: {
        providers: { local: { baseUrl: "http://127.0.0.1:9000/v1", apiKey: { value: "sk-local-secret" } } },
        models: ["local/qwen"],
      },
    }));
    const result = await ops(["lead-model"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("selected: local/qwen");
    expect(result.stdout).toContain("apiKey: configured");
    expect(result.stdout).not.toContain("sk-local-secret");
  }, 30_000);

  it("writes the lead model into config.json", async () => {
    const result = await ops(["lead-use", "local/qwen"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("selected = local/qwen");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models).toEqual(["local/qwen"]);
  }, 30_000);

  // 审查发现 4：daemon 在运行时，plc lead use 经 plc.sock 让 daemon 写 config.json，daemon 的 config 核对才认得出它。
  it("asks the running daemon to write the lead model instead of writing config.json itself", async () => {
    const received: unknown[] = [];
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        const command = JSON.parse(chunk.trim()) as { type: string; spec: string };
        received.push(command);
        sock.end(`${JSON.stringify({ type: "response", success: true, data: { path: join(dir, "config.json"), models: [command.spec] } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "plc.sock"), resolve));
    try {
      const result = await ops(["lead-use", "local/qwen"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("selected = local/qwen");
      expect(received).toEqual([{ type: "set_lead_model", spec: "local/qwen" }]);
      expect(existsSync(join(dir, "config.json"))).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);

  // 审查发现 1：只回滚代码之前，用新代码卸掉账本的写入守卫。
  it("uninstalls the ledger guard when no daemon runs, so old code can write again", async () => {
    openDb(join(dir, "plc.db")).close();
    const status = await ops(["ledger-guard", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/ledger guard: [1-9]\d* triggers on \d+ tables, 0 missing/);
    const result = await ops(["ledger-guard", "uninstall"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("卸掉了");
    const old = new Database(join(dir, "plc.db"));
    old.prepare("INSERT INTO kv (key, value) VALUES ('old-code', 'wrote')").run();
    old.close();
  }, 30_000);

  it("refuses to uninstall the ledger guard while the daemon runs", async () => {
    openDb(join(dir, "plc.db")).close();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(join(dir, "plc.sock"), resolve));
    try {
      const result = await ops(["ledger-guard", "uninstall"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("先停 daemon");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);

  it("runs the read-only doctor", async () => {
    const result = await ops(["doctor"]);
    expect(result.stdout).toContain("daemon");
    expect([0, 1]).toContain(result.code);
  }, 30_000);

  // 没有 supervisor 时 plc daemon stop 也要记下"用户停的"，否则下一次自动拉起会把一切又拉起来。
  it("records a stop even when no supervisor is running", async () => {
    const result = await ops(["stop"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("不会自动启动");
    const state = JSON.parse(readFileSync(join(dir, "supervisor-state.json"), "utf8"));
    expect(state).toMatchObject({ version: 1, desiredState: "stopped" });
  }, 30_000);

  it("refuses an unknown command with its usage", async () => {
    const result = await ops(["work", "3"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: ops.mjs");
  }, 30_000);
});

// 工单 04 的 Seam 2：每个 adapter 的健康探针，经过真实的进程边界。
// fake CLI 把每一次调用的 argv 追加写进 FAKE_PROBE_LOG。测试据此断言探针只跑了不花钱的命令：
// 版本命令和登录状态命令。命令按已安装的 CLI 核实过（2026-10-10）：
//   codex-cli 0.153.3：`codex --version`、`codex login status`（已登录退出码 0，未登录 1）。
//   Claude Code 2.1.258：`claude --version`、`claude auth status --json`（loggedIn 字段，未登录退出码 1）。
//   pi 1.1.0：`pi --version`、`pi auth check --model <m> --json`（status 为 ready 时退出码 0）。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ClaudeRuntime } from "../src/claude.js";
import { CodexRuntime } from "../src/codex.js";
import { PiRuntime } from "../src/pi.js";
import { packageSource } from "@pi-lead-child/core";

const TSX = resolve("node_modules/.bin/tsx");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function probeLog(): { path: string; calls: () => string[][] } {
  const dir = tempDir("plc-probe-");
  tempDirs.push(dir);
  const path = join(dir, "argv.jsonl");
  return {
    path,
    calls: () => existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [],
  };
}

const codex = (env: Record<string, string>) => new CodexRuntime({
  bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")], env,
});
const claude = (env: Record<string, string>) => new ClaudeRuntime({
  bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-claude.ts")], env,
});
const pi = (env: Record<string, string>) => new PiRuntime({ bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env });

describe("the Codex probe", () => {
  it("passes with only the version and login status commands", async () => {
    const log = probeLog();
    const result = await codex({ FAKE_PROBE_LOG: log.path }).probe({ model: "gpt-5.5" });
    expect(result).toEqual({ ok: true, checks: ["codex --version", "codex login status"] });
    expect(log.calls()).toEqual([["--version"], ["login", "status"]]);
  });

  it("reports a login failure when the account is logged out", async () => {
    const log = probeLog();
    const result = await codex({ FAKE_PROBE_LOG: log.path, FAKE_CODEX_LOGIN: "logged-out" }).probe({ model: null });
    expect(result).toMatchObject({
      ok: false,
      failure: { scope: "account", needs: "login", code: "auth_required" },
    });
    expect(log.calls()).toEqual([["--version"], ["login", "status"]]);
  });

  it("reports a missing executable without running anything", async () => {
    const result = await new CodexRuntime({ bin: join(tmpdir(), "plc-no-such-dir", "codex") }).probe({ model: null });
    expect(result).toMatchObject({
      ok: false, checks: ["codex --version"],
      failure: { scope: "runtime", needs: "config", code: "executable_missing" },
    });
  });
});

describe("the Claude probe", () => {
  it("passes with only the version and auth status commands", async () => {
    const log = probeLog();
    const result = await claude({ FAKE_PROBE_LOG: log.path }).probe({ model: null });
    expect(result).toEqual({ ok: true, checks: ["claude --version", "claude auth status"] });
    expect(log.calls()).toEqual([["--version"], ["auth", "status", "--json"]]);
  });

  it("reports a login failure without copying the status output", async () => {
    const result = await claude({ FAKE_CLAUDE_AUTH: "logged-out" }).probe({ model: null });
    expect(result).toMatchObject({
      ok: false,
      failure: { scope: "account", needs: "login", code: "auth_required" },
    });
    // 状态命令的输出可能带账号信息，不能进证据。
    expect(JSON.stringify(result)).not.toContain("authMethod");
  });

  it("leaves a third-party provider to the canary", async () => {
    // Bedrock、Vertex 这类 provider 用自己的凭据。auth status 只报告 Anthropic 账号，看不出它们是否可用。
    const result = await claude({ FAKE_CLAUDE_AUTH: "third-party" }).probe({ model: null });
    expect(result).toEqual({ ok: true, checks: ["claude --version", "claude auth status"] });
  });
});

describe("the Pi probe", () => {
  it("passes with only the version and auth check commands for the model", async () => {
    const log = probeLog();
    const result = await pi({ FAKE_PROBE_LOG: log.path }).probe({ model: "openai/gpt-5.5" });
    // 工单 05：探针和 preflight 共用安装检查。fake pi 由 tsx 启动。
    // tsx 是 `#!/usr/bin/env node` 的脚本，并且声明了 engines，所以探针先检查 child 的 PATH 上的 node。
    // 这一步不经过 fake CLI，所以不进 argv 日志。
    expect(result).toEqual({ ok: true, checks: ["node --version", "pi --version", "pi auth check"] });
    expect(log.calls()).toEqual([["--version"], ["auth", "check", "--model", "openai/gpt-5.5", "--json"]]);
  });

  it("reports a login failure when the provider is not ready", async () => {
    const result = await pi({ FAKE_PI_AUTH: "not-ready" }).probe({ model: "openai/gpt-5.5" });
    expect(result).toMatchObject({
      ok: false,
      failure: { scope: "account", needs: "login", code: "auth_required" },
    });
  });

  it("reports a missing extension without running Pi", async () => {
    const log = probeLog();
    const result = await new PiRuntime({
      bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_PROBE_LOG: log.path },
      ticketToolsExtension: packageSource("engine", "extension", "missing-tools.ts"),
    }).probe({ model: null });
    expect(result).toMatchObject({
      ok: false, failure: { scope: "runtime", needs: "config", code: "extension_missing" },
    });
    expect(log.calls()).toEqual([]);
  });

  it("never passes an option-like model to the CLI", async () => {
    const log = probeLog();
    const result = await pi({ FAKE_PROBE_LOG: log.path }).probe({ model: "--credentials" });
    expect(result.ok).toBe(true);
    expect(log.calls()).toEqual([["--version"]]);
  });
});

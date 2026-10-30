// 工单 05 的决策边界：preflight 的每一项判断。
// 版本要求和模型归属是纯函数。解释器解析和 adapter 的 preflight 经过真实的文件和进程边界（Seam 2）。
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { daemonNodeLaunch, resolveInterpreter, satisfiesRange } from "@pi-lead-child/runtime";
import { modelOwnershipProblem, runtimeProfileHash, runtimeProfileKey } from "@pi-lead-child/runtime";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { PiRuntime } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";
import { createItem } from "../src/items.js";
import { createRun, getRun, recordRunProfileHash } from "../src/runs.js";

describe("an engines range", () => {
  it.each([
    ["v22.14.0", ">=22.19.0", false], // run 52、59：pi-coding-agent 1.1.0 跑在 Node 22.14 上
    ["v22.19.0", ">=22.19.0", true],
    ["v24.21.0", ">=22.19.0", true],
    ["v18.20.4", ">=18", true],
    ["v19.0.0", "^18.17.0 || >=20.5.0", false],
    ["v18.20.0", "^18.17.0 || >=20.5.0", true],
    ["v20.5.0", "^18.17.0 || >=20.5.0", true],
    ["v20.1.0", ">= 20.1 < 21", true],
    ["v21.0.0", ">= 20.1 < 21", false],
    ["v20.9.1", "~20.9.0", true],
    ["v20.10.0", "~20.9.0", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it("cannot judge a range it does not understand", () => {
    expect(satisfiesRange("v22.14.0", "22.x")).toBeNull();
    expect(satisfiesRange("not a version", ">=22")).toBeNull();
  });
});

describe("which models belong to a runtime", () => {
  const claude = new ClaudeRuntime({ bin: process.execPath }).profile;
  const codex = new CodexRuntime({ bin: process.execPath }).profile;
  const pi = new PiRuntime({ bin: process.execPath }).profile;

  it.each([
    [claude, "openai/gpt-5.4-mini", true], // run 63
    [claude, "claude-opus-5", false],
    [claude, "opus", false],
    // Bedrock 的 ARN 带斜杠，但第一段带冒号，不是 provider 前缀。
    [claude, "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc", false],
    [codex, "openai/gpt-5.5", false],
    [codex, "gpt-5.5", false],
    [codex, "anthropic/claude-opus-5", true],
    [pi, "openai/gpt-5.5", false],
    [pi, "anthropic/claude-opus-5", false],
    [claude, null, false],
  ])("%#: %s is foreign: %s", (profile, model, foreign) => {
    expect(modelOwnershipProblem(profile, model) !== null).toBe(foreign);
  });
});

// 一个脚本形式的 CLI。入口文件在包里，包声明 engines。PATH 上的假解释器只会报版本。
// shebang 里的 {node} 换成这个假解释器的绝对路径。
function scriptCli(options: { shebang: string; engines?: Record<string, string>; nodeVersion?: string }) {
  const root = tempDir("plc-interp-");
  const pkg = join(root, "cli-package");
  const bin = join(root, "bin");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "cli-package", engines: options.engines }));
  const node = join(bin, "node");
  writeFileSync(node, `#!/bin/sh\necho ${options.nodeVersion ?? "v22.14.0"}\n`);
  chmodSync(node, 0o755);
  const entry = join(pkg, "dist", "cli.js");
  writeFileSync(entry, `${options.shebang.replace("{node}", node)}\nconsole.log("1.1.0");\n`);
  chmodSync(entry, 0o755);
  return { entry, node, path: `${bin}:/usr/bin:/bin` };
}

describe("which interpreter the child will use", () => {
  it("resolves `#!/usr/bin/env node` on the child's PATH, not the daemon's Node", () => {
    const cli = scriptCli({ shebang: "#!/usr/bin/env node", engines: { node: ">=22.19.0" } });
    expect(resolveInterpreter(cli.entry, { PATH: cli.path }))
      .toEqual({ command: "node", path: cli.node, engines: ">=22.19.0" });
  });

  it("reports a missing interpreter when the child's PATH has no node", () => {
    const cli = scriptCli({ shebang: "#!/usr/bin/env -S node --no-warnings", engines: { node: ">=22.19.0" } });
    expect(resolveInterpreter(cli.entry, { PATH: "/nonexistent-dir" }))
      .toEqual({ command: "node", path: null, engines: ">=22.19.0" });
  });

  it("uses an absolute shebang as written", () => {
    const cli = scriptCli({ shebang: `#!${process.execPath}` });
    expect(resolveInterpreter(cli.entry, { PATH: "" }))
      .toEqual({ command: "node", path: process.execPath, engines: null });
  });

  it("has no interpreter for a native executable", () => {
    expect(resolveInterpreter(process.execPath, { PATH: process.env.PATH })).toBeNull();
    expect(resolveInterpreter(join(tmpdir(), "plc-no-such-file"), {})).toBeNull();
  });
});

// 工单 10：node 脚本形式的 CLI 入口由 daemon 自己的 Node 运行，shebang 里给 node 的参数保留。
describe("running a node script entry on the daemon's Node", () => {
  it("passes the shebang's node flags, then the entry's real path", () => {
    const cli = scriptCli({ shebang: "#!/usr/bin/env -S node --no-warnings", engines: { node: ">=22.19.0" } });
    expect(daemonNodeLaunch(cli.entry)).toEqual({
      command: process.execPath,
      args: ["--no-warnings", realpathSync(cli.entry)],
      interpreter: { command: "node", path: process.execPath, engines: ">=22.19.0" },
    });
  });

  it("leaves a native executable and a script for another interpreter alone", () => {
    expect(daemonNodeLaunch(process.execPath)).toBeNull();
    expect(daemonNodeLaunch(scriptCli({ shebang: "#!/bin/sh" }).entry)).toBeNull();
    expect(daemonNodeLaunch(join(tmpdir(), "plc-no-such-file"))).toBeNull();
  });
});

describe("an adapter preflight at the process boundary", () => {
  // 一个不是 pi 的 node 脚本 CLI，shebang 写死一个旧的 node。它的解释器仍按 shebang 解析。
  it("fails on the child's old Node before it runs the CLI", async () => {
    const cli = scriptCli({ shebang: "#!{node}", engines: { node: ">=22.19.0" }, nodeVersion: "v22.14.0" });
    const result = await new CodexRuntime({ bin: cli.entry }).preflight({});
    expect(result).toMatchObject({
      ok: false, checks: ["node --version"],
      failure: { scope: "runtime", retry: "never", needs: "config", code: "interpreter_mismatch" },
    });
    expect(!result.ok && result.failure.evidence).toContain(`${cli.node} 是 v22.14.0，不满足要求 >=22.19.0`);
  });

  // 回归（runs 52、59）：PATH 上第一个 node 是 22.14，旧代码的 pi 用它，preflight 报解释器不符。
  it("checks and runs pi on the daemon's Node, whatever node comes first on PATH", async () => {
    const cli = scriptCli({ shebang: "#!/usr/bin/env node", engines: { node: ">=22.19.0" }, nodeVersion: "v22.14.0" });
    const pi = new PiRuntime({ bin: cli.entry, env: { PATH: cli.path } });
    expect(pi.profile.interpreter).toEqual({ command: "node", path: process.execPath, engines: ">=22.19.0" });
    expect(await pi.preflight({})).toEqual({ ok: true, checks: ["node --version", "pi --version"] });
  });

  it("never runs the account checks", async () => {
    const dir = tempDir("plc-preflight-log-");
    const log = join(dir, "argv.jsonl");
    const pi = new PiRuntime({
      bin: resolve("node_modules/.bin/tsx"), prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: { FAKE_PROBE_LOG: log },
    });
    const claude = new ClaudeRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-claude.ts")], env: { FAKE_PROBE_LOG: log },
    });
    expect((await pi.preflight({})).ok).toBe(true);
    expect(await claude.preflight({})).toEqual({ ok: true, checks: ["claude --version"] });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    expect(calls).toEqual([["--version"], ["--version"]]);
  });
});

describe("the profile hash", () => {
  it("changes with the profile content while the ledger key keeps the identity", () => {
    const old = scriptCli({ shebang: "#!/usr/bin/env node", engines: { node: ">=22.19.0" } });
    const fixedPath = scriptCli({ shebang: "#!/usr/bin/env node", engines: { node: ">=22.19.0" } });
    const before = new PiRuntime({ bin: old.entry, env: { PATH: old.path } }).profile;
    // 用户改了 PATH：child 的环境变了（工单 10）。可执行文件和配置目录没变，所以账本上的故障还是同一个。
    const after = new PiRuntime({ bin: old.entry, env: { PATH: fixedPath.path } }).profile;
    expect(runtimeProfileKey(after)).toBe(runtimeProfileKey(before));
    expect(runtimeProfileHash(after)).not.toBe(runtimeProfileHash(before));
    expect(runtimeProfileHash(new PiRuntime({ bin: old.entry, env: { PATH: old.path } }).profile))
      .toBe(runtimeProfileHash(before));
  });

  // 工单 11：adapter 加的许可是 profile 的内容。Claude 的清单进 hash，Codex 不加许可。
  it("records the permissions an adapter adds, and the hash covers them", () => {
    const claude = new ClaudeRuntime({ bin: process.execPath }).profile;
    const codex = new CodexRuntime({ bin: process.execPath }).profile;
    expect(claude.allowedTools).toContain("Bash(npm run typecheck*)");
    expect(codex.allowedTools).toEqual([]);
    const changed = { ...claude, allowedTools: [...claude.allowedTools, "Bash(make check)"] };
    expect(runtimeProfileKey(changed)).toBe(runtimeProfileKey(claude));
    expect(runtimeProfileHash(changed)).not.toBe(runtimeProfileHash(claude));
  });

  it("is filled in once on an existing Run and never overwritten", () => {
    const db = openDb(join(tempDir("plc-profile-hash-"), "plc.db"));
    const itemId = createItem(db, { title: "hash", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    recordRunProfileHash(db, runId, "aaaaaaaaaaaaaaaa");
    recordRunProfileHash(db, runId, "bbbbbbbbbbbbbbbb");
    expect(getRun(db, runId)?.runtime_profile_hash).toBe("aaaaaaaaaaaaaaaa");
    db.close();
  });
});

// 冒烟脚本的完整流程：假的运行包。bin/lead-agent 是测试用的 Node 的硬链接（或副本），
// supervisor.mjs 和 daemon.mjs 是假的：daemon 按同样的 socket 协议回答 status，supervisor 收到 SIGTERM 时先停 daemon 再退出。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { PLC_WRAPPER, RUNTIME_ASSET_FILES } from "../lib/pack.js";
import { commandName, keychainWrites, smokeEnv, smokeRuntime, stubScript } from "../lib/smoke.js";

const FAKE_SUPERVISOR = `
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const runtime = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mode = readFileSync(join(runtime, "mode"), "utf8").trim();
const data = process.env.PLC_DATA_DIR;
writeFileSync(join(runtime, "seen-env.json"), JSON.stringify({
  HOME: process.env.HOME, PLC_DATA_DIR: data, PLC_DEV: process.env.PLC_DEV ?? null, PLC_MEMORY_BACKEND: process.env.PLC_MEMORY_BACKEND,
  PLC_VAULT_KEY_SOURCE: process.env.PLC_VAULT_KEY_SOURCE, NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? null,
}));
// 和真的 daemon 一样按名字调用 launchctl：冒烟环境里拿到的应该是假命令。
try { execFileSync("launchctl", ["bootout", "gui/0/com.example.hindsight"], { stdio: "ignore" }); } catch {}
const bin = mode === "wrong-name" ? join(runtime, "bin", "other-node") : process.execPath;
const daemon = spawn(bin, [join(runtime, "apps", "daemon", "dist", "daemon.mjs")], { stdio: "inherit" });
writeFileSync(join(runtime, "pids.json"), JSON.stringify({ supervisor: process.pid, daemon: daemon.pid }));
writeFileSync(join(data, "supervisor-state.json"), JSON.stringify({ daemonPid: daemon.pid }));
// 和真的 supervisor 一样：SIGTERM 时先停 daemon，再退出。
process.on("SIGTERM", () => {
  daemon.once("exit", () => process.exit(0));
  daemon.kill("SIGTERM");
});
setInterval(() => {}, 1_000);
`;

const FAKE_DAEMON = `
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const runtime = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mode = readFileSync(join(runtime, "mode"), "utf8").trim();
// 按名字往钥匙串里写一个密钥，和以前的保险库一样走 security -i 的标准输入：冒烟环境里拿到的是假命令，冒烟要判失败。
if (mode === "keychain-write") {
  try { execFileSync("security", ["-i"], { input: "add-generic-password -a alice -s plc:test -w 00\\n", stdio: ["pipe", "ignore", "ignore"] }); } catch {}
}
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (line) => {
    const command = JSON.parse(line.trim());
    if (command.type === "status" && mode !== "silent") {
      socket.end(JSON.stringify({ type: "response", id: command.id, success: true, data: { pid: process.pid } }) + "\\n");
    }
  });
});
server.listen(join(process.env.PLC_DATA_DIR, "plc.sock"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

// 假的 pi：照 pi 1.1.0 的行为，-e 的扩展加载不了时报错退出，不回答；RPC 的 get_commands 列出 --skill 目录里的 skill。
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.1.0"); process.exit(0); }
const mode = fs.readFileSync(path.join(__dirname, "..", "..", "mode"), "utf8").trim();
const values = (flag) => args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
for (const extension of values("-e")) {
  if (!fs.existsSync(extension) || mode === "pi-extension-error") {
    console.error('Error: Failed to load extension "' + extension + '": Extension path does not exist');
    process.exit(1);
  }
}
const commands = mode === "pi-no-skills" ? [] : values("--skill").flatMap((dir) => fs.readdirSync(dir)
  .filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md")))
  .map((name) => ({ name: "skill:" + name, source: "skill", sourceInfo: { path: path.join(dir, name, "SKILL.md") } })));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands } }) + "\\n");
  }
});
`;

// 假的运维入口：只回答 selfcheck。
const FAKE_OPS = `
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const runtime = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mode = readFileSync(join(runtime, "mode"), "utf8").trim();
if (process.argv[2] !== "selfcheck") process.exit(2);
const ok = mode !== "selfcheck-fails";
console.log(JSON.stringify({ ok, checks: [
  { name: "better-sqlite3", ok: true, detail: "loaded" },
  { name: "runtime assets", ok, detail: ok ? "8 found in dist" : "missing: ticket-tools.js" },
] }));
process.exit(ok ? 0 : 1);
`;

function write(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function linkNode(target: string): void {
  try { linkSync(process.execPath, target); } catch { copyFileSync(process.execPath, target); chmodSync(target, 0o755); }
}

// 有的沙箱不允许监听 Unix socket（listen EPERM，例如 PLC 的执行器）。那里跳过要起 socket 的用例。
async function canListenOnUnixSocket(): Promise<boolean> {
  const path = join(tempDir("plc-dsm-probe-"), "p.sock");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(path, () => server.close(() => resolve(true)));
  });
}
const sockets = await canListenOnUnixSocket();
// 冒烟按 ps -o comm= 认进程名。macOS 上它是可执行文件的路径，硬链接 bin/lead-agent 就叫 lead-agent。Linux 上它是内核里的
// 线程名，Node 把主线程叫 MainThread（2026-11-09，PR #17 在 ubuntu 上的 CI）。冒烟只在发版的 Mac 上跑，所以查进程名的用例只在 macOS 上跑。
const processNames = sockets && process.platform === "darwin";

let runtime: string;

beforeAll(() => {
  runtime = tempDir("plc-dsm-rt-");
  mkdirSync(join(runtime, "bin"), { recursive: true });
  linkNode(join(runtime, "bin", "lead-agent"));
  linkNode(join(runtime, "bin", "other-node"));
  write(join(runtime, "bin", "plc"), PLC_WRAPPER);
  chmodSync(join(runtime, "bin", "plc"), 0o755);
  write(join(runtime, "release.json"), JSON.stringify({ product: "bytezard-lead", version: "1.3.0" }));
  write(join(runtime, "apps/cli/dist/cli.mjs"), "if (!process.argv.includes('--help')) process.exit(3); console.log('Usage: plc');\n");
  write(join(runtime, "apps/daemon/dist/supervisor.mjs"), FAKE_SUPERVISOR);
  write(join(runtime, "apps/daemon/dist/daemon.mjs"), FAKE_DAEMON);
  write(join(runtime, "apps/daemon/dist/ops.mjs"), FAKE_OPS);
  for (const file of RUNTIME_ASSET_FILES) {
    if (file.endsWith("/child-skills")) write(join(runtime, file, "executor/skills/plc-diagnosing-bugs/SKILL.md"), "---\nname: plc-diagnosing-bugs\n---\n");
    else if (file.endsWith("/lead-skills")) write(join(runtime, file, "genui-cards/SKILL.md"), "---\nname: genui-cards\n---\n");
    else write(join(runtime, file), `// ${file}\n`);
  }
  write(join(runtime, "node_modules/fake-pi/cli.js"), FAKE_PI);
  mkdirSync(join(runtime, "node_modules/.bin"), { recursive: true });
  symlinkSync("../fake-pi/cli.js", join(runtime, "node_modules/.bin/pi"));
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const savedDev = process.env.PLC_DEV;
afterEach(() => {
  if (savedDev === undefined) delete process.env.PLC_DEV;
  else process.env.PLC_DEV = savedDev;
  // 失败的用例也不能留下假的 supervisor 和 daemon。
  if (existsSync(join(runtime, "pids.json"))) {
    for (const pid of Object.values(JSON.parse(readFileSync(join(runtime, "pids.json"), "utf8")) as number[])) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }
});

describe("smokeEnv", () => {
  it("drops the caller's PLC_* variables, isolates HOME and the data dir, and puts the stubs first on PATH", () => {
    const env = smokeEnv(
      {
        PATH: `/usr/bin${delimiter}/bin`, HOME: "/Users/alice", PLC_DEV: "1", PLC_GATEWAY_PORT: "47130", PLC_VAULT_KEY_SOURCE: "keychain",
        NODE_OPTIONS: "--import tsx", NODE_USE_SYSTEM_CA: "1", LANG: "en_US.UTF-8",
      },
      { home: "/tmp/s/home", dataDir: "/tmp/s/data", stubBin: "/tmp/s/stub-bin", stubLog: "/tmp/s/stub.log" },
    );
    expect(env).toMatchObject({
      HOME: "/tmp/s/home", PLC_DATA_DIR: "/tmp/s/data", PLC_GATEWAY_PORT: "0", PLC_DESKTOP_NOTIFY: "off", PLC_OPEN_FILES: "off",
      PLC_MEMORY_BACKEND: "sqlite", LANG: "en_US.UTF-8", PATH: `/tmp/s/stub-bin${delimiter}/usr/bin${delimiter}/bin`,
    });
    expect(env.PLC_DEV).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  // 工单 #243：冒烟进程不能碰真钥匙串。保险库用文件密钥；Node 不读系统钥匙串里的根证书。
  it("keeps the smoke processes away from the real Keychain", () => {
    const env = smokeEnv(
      { PATH: "/usr/bin", HOME: "/Users/alice", PLC_VAULT_KEY_SOURCE: "keychain", NODE_USE_SYSTEM_CA: "1" },
      { home: "/tmp/s/home", dataDir: "/tmp/s/data", stubBin: "/tmp/s/stub-bin", stubLog: "/tmp/s/stub.log" },
    );
    expect(env.PLC_VAULT_KEY_SOURCE).toBe("file");
    expect("NODE_USE_SYSTEM_CA" in env).toBe(false);
  });

  it("finds Keychain writes in the stub calls, also when they come through security -i", () => {
    expect(keychainWrites([
      "launchctl bootout gui/0/com.example.hindsight",
      "security find-generic-password -a alice -s plc:test -w",
      "security -i",
      "security -i add-generic-password",
    ])).toEqual(["security -i add-generic-password"]);
    expect(keychainWrites(["security add-generic-password -a alice -s plc:test -w 00"])).toHaveLength(1);
    expect(keychainWrites(["security find-generic-password -a alice"])).toEqual([]);
  });

  it("records the commands that the fake security reads from stdin, without their arguments", () => {
    const dir = tempDir("plc-dsm-stub-");
    const stub = join(dir, "security");
    const log = join(dir, "stub.log");
    writeFileSync(stub, stubScript("security", 44));
    chmodSync(stub, 0o755);
    const result = spawnSync(stub, ["-i"], {
      input: "add-generic-password -a alice -s plc:test -w 00\n", env: { ...process.env, PLC_SMOKE_STUB_LOG: log },
    });
    expect(result.status).toBe(44);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual(["security -i", "security -i add-generic-password"]);
    expect(keychainWrites(lines)).toEqual(["security -i add-generic-password"]);
  });

  it("reads process names from ps and writes stubs that only record their arguments", () => {
    expect(commandName("/Users/alice/Library/Application Support/Bytezard Lead/runtime/current/bin/lead-agent\n")).toBe("lead-agent");
    expect(commandName("lead-agent\n")).toBe("lead-agent");
    expect(stubScript("launchctl", 1)).toBe(`#!/bin/sh\nprintf '%s %s\\n' launchctl "$*" >> "$PLC_SMOKE_STUB_LOG"\nexit 1\n`);
  });
});

describe("smokeRuntime", () => {
  it.skipIf(!processNames)("starts the supervisor, waits for status on plc.sock, checks both process names and stops both", async () => {
    write(join(runtime, "mode"), "ok");
    process.env.PLC_DEV = "1";
    const result = await smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") });
    expect(result).toMatchObject({ ok: true, version: "1.3.0", piVersion: "1.1.0", processNames: { supervisor: "lead-agent", daemon: "lead-agent" } });
    // pi 执行器和 Lead 的扩展、child-skills、Lead 的 skill 都在包里，pi 真的加载了它们（工单 #260）。
    expect(result.runtimeAssets).toBe("8 found in dist");
    expect(result.piLoad.extensions.sort()).toEqual(["sandbox.js", "sol-pi-executor.js", "sol-pi-lead.js", "ticket-tools.js", "web-tools.js"]);
    expect(result.piLoad.skills.sort()).toEqual(["skill:genui-cards", "skill:plc-diagnosing-bugs"]);
    const pids = JSON.parse(readFileSync(join(runtime, "pids.json"), "utf8")) as { supervisor: number; daemon: number };
    expect(result.supervisorPid).toBe(pids.supervisor);
    expect(result.daemonPid).toBe(pids.daemon);
    expect(alive(pids.supervisor)).toBe(false);
    expect(alive(pids.daemon)).toBe(false);
    // launchctl 被假命令接住了；HOME 和数据目录是临时的；调用者的 PLC_DEV 没有传进去。
    expect(result.stubCalls).toEqual(["launchctl bootout gui/0/com.example.hindsight"]);
    const seen = JSON.parse(readFileSync(join(runtime, "seen-env.json"), "utf8"));
    expect(seen.HOME).not.toBe(homedir());
    expect(seen.HOME).toMatch(/bl-smoke-.*\/home$/);
    expect(seen.PLC_DATA_DIR).toMatch(/bl-smoke-.*\/data$/);
    expect(seen.PLC_DEV).toBeNull();
    expect(seen.PLC_MEMORY_BACKEND).toBe("sqlite");
    expect(seen.PLC_VAULT_KEY_SOURCE).toBe("file");
    expect(seen.NODE_USE_SYSTEM_CA).toBeNull();
    expect(existsSync(dirname(seen.HOME))).toBe(false);
  });

  it.skipIf(!processNames)("fails when a smoke process writes a key to the Keychain, and stops both anyway", async () => {
    write(join(runtime, "mode"), "keychain-write");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") }))
      .rejects.toThrow(/冒烟进程想往钥匙串里写密钥：security -i add-generic-password/);
    const pids = JSON.parse(readFileSync(join(runtime, "pids.json"), "utf8")) as { supervisor: number; daemon: number };
    await expect.poll(() => alive(pids.supervisor) || alive(pids.daemon), { timeout: 5_000 }).toBe(false);
  });

  it.skipIf(!processNames)("fails when the daemon process is not called lead-agent, and stops it anyway", async () => {
    write(join(runtime, "mode"), "wrong-name");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") })).rejects.toThrow(/daemon 的进程名是 other-node，不是 lead-agent/);
    const pids = JSON.parse(readFileSync(join(runtime, "pids.json"), "utf8")) as { supervisor: number; daemon: number };
    await expect.poll(() => alive(pids.supervisor) || alive(pids.daemon), { timeout: 5_000 }).toBe(false);
  });

  it.skipIf(!sockets)("fails with the supervisor output when plc.sock never answers status in time", async () => {
    write(join(runtime, "mode"), "silent");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-"), timeoutMs: 1_500 }))
      .rejects.toThrow(/2 秒内没有等到 plc\.sock 回答 status[\s\S]*supervisor 输出/);
    const pids = JSON.parse(readFileSync(join(runtime, "pids.json"), "utf8")) as { supervisor: number; daemon: number };
    await expect.poll(() => alive(pids.supervisor) || alive(pids.daemon), { timeout: 5_000 }).toBe(false);
  });

  // 工单 #260：1.1.1、1.1.2 的运行包里没有 pi 扩展，pi 执行器启动时报 "Pi extension path does not exist"。冒烟要拦住。
  // 这几项在启动 supervisor 以前检查，不用 socket。
  it("fails when a pi extension is missing from the bundle", async () => {
    write(join(runtime, "mode"), "ok");
    const file = join(runtime, "apps/daemon/dist/assets/extensions/ticket-tools.js");
    renameSync(file, `${file}.away`);
    try {
      await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") }))
        .rejects.toThrow(/运行包里缺少 .*apps\/daemon\/dist\/assets\/extensions\/ticket-tools\.js/);
    } finally {
      renameSync(`${file}.away`, file);
    }
  });

  it("fails when pi cannot load the extensions", async () => {
    write(join(runtime, "mode"), "pi-extension-error");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") }))
      .rejects.toThrow(/pi 在回答 get_commands 以前退出了（1）：Error: Failed to load extension/);
  });

  it("fails when pi loads no skill from the child-skills or the Lead skills", async () => {
    write(join(runtime, "mode"), "pi-no-skills");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") }))
      .rejects.toThrow(/pi 没有从这些目录加载到 skill：.*child-skills\/executor\/skills、.*lead-skills/);
  });

  it("fails when the bundle's own selfcheck does not find the runtime assets", async () => {
    write(join(runtime, "mode"), "selfcheck-fails");
    await expect(smokeRuntime({ runtimeDir: runtime, workDir: tempDir("plc-dsm-") }))
      .rejects.toThrow(/ops selfcheck 没有通过：.*runtime assets 失败（missing: ticket-tools\.js）/);
  });

  it("refuses a directory that is not a runtime bundle", async () => {
    await expect(smokeRuntime({ runtimeDir: tempDir("plc-dsm-") })).rejects.toThrow(/不是运行包：没有 release\.json/);
  });
});

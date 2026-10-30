// spec D6：child 的环境。工单 10 把它改成白名单。2026-10-11 用户撤回了白名单（工单 11）：
// child 继承 daemon 的全部环境，和用户独立运行 CLI 时一样。PATH 仍由 profile 构造，token 仍不进 argv。
// Seam 2：三个 adapter 用各自的 fake CLI 启动，fake CLI 记下它收到的 argv 和变量名。
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, runtimeEnvironment } from "@pi-lead-child/runtime";
import { runItem } from "../src/children/manager.js";
import { openDb } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { CodexRuntime } from "@pi-lead-child/runtime";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { PiRuntime } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeStartRequest } from "@pi-lead-child/runtime";

const TSX = resolve("node_modules/.bin/tsx");
const tempDirs: string[] = [];

// child 继承测试进程的环境。测试不让 fake CLI 读到开发者真实的配置：三个配置目录都指向空目录。
beforeEach(() => {
  const empty = tempDir();
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) vi.stubEnv(name, empty);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plc-child-env-"));
  tempDirs.push(dir);
  return dir;
}

// sessionDir 指向临时目录：pi 没有它时，会在当前目录下建 .pi-sessions。
function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    itemId: 1, runId: 5, role: "executor", purpose: "execution",
    prompt: "do it", workdir: process.cwd(), sessionDir: tempDir(), env: {}, ...overrides,
  };
}

interface Captured {
  args: string[];
  envNames: string[];
  values: Record<string, string | null>;
  execPath?: string;
  mcpConfig?: unknown;
  mcpConfigPath?: string | null;
  mcpConfigMode?: string | null;
}

async function drain(runtime: AgentRuntime, start: RuntimeStartRequest): Promise<RuntimeEvent[]> {
  const handle = await runtime.start(start);
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    // fake pi 在 agent_end 之后不退出，和真实的 pi 一样。
    if (event.type === "run.completed" || event.type === "run.failed") break;
  }
  await handle.interrupt("test complete");
  await handle.wait();
  return events;
}

interface Launched {
  captured: Captured;
  runtime: AgentRuntime;
  // adapter 自己设置的变量（fake CLI 的场景和捕获文件）。
  adapterEnv: Record<string, string>;
}

type Launch = (options: { env?: Record<string, string>; start?: Partial<RuntimeStartRequest> }) => Promise<Launched>;

// 每个 adapter 一个启动方式：fake CLI、它记下的内容在哪里。
const adapters: Record<string, Launch> = {
  async codex({ env = {}, start = {} }) {
    const file = join(tempDir(), "capture.json");
    const adapterEnv = { FAKE_CODEX_SCENARIO: "happy", FAKE_CODEX_CAPTURE: file, ...env };
    const runtime = new CodexRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")], env: adapterEnv,
    });
    await drain(runtime, request(start));
    return { captured: JSON.parse(readFileSync(file, "utf8")), runtime, adapterEnv };
  },
  async claude({ env = {}, start = {} }) {
    const adapterEnv = { FAKE_CLAUDE_SCENARIO: "inspect", ...env };
    const runtime = new ClaudeRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-claude.ts")], env: adapterEnv,
    });
    const events = await drain(runtime, request(start));
    const message = events.find((event) => event.type === "message.completed");
    if (!message || message.type !== "message.completed") throw new Error("fake claude did not report");
    const inspected = JSON.parse(message.text);
    return { captured: { ...inspected, args: inspected.argv }, runtime, adapterEnv };
  },
  async pi({ env = {}, start = {} }) {
    const file = join(tempDir(), "capture.json");
    const adapterEnv = { FAKE_PI_CAPTURE: file, ...env };
    const runtime = new PiRuntime({ bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-pi.ts")], env: adapterEnv });
    await drain(runtime, request(start));
    return { captured: JSON.parse(readFileSync(file, "utf8")), runtime, adapterEnv };
  },
};

const TOKEN = "t10-bridge-token-6f1d2c";
// manager 给 child 和 plc 的 MCP 服务器的变量（src/children/manager.ts）：两边的取值相同。
const BRIDGE_ENV = { PLC_AGENT_TOOL_SOCKET: "/tmp/plc-t10.sock", PLC_AGENT_TOOL_TOKEN: TOKEN, PLC_TICKET_ID: "1" };
const MCP_SERVER = { command: process.execPath, args: ["/opt/plc/mcp-server.mjs"], env: BRIDGE_ENV };

// 决策边界：child 的环境怎样由 daemon 的环境、adapter 和请求的变量组成，PATH 怎样构造。
describe("the child environment builder", () => {
  const daemon = {
    HOME: "/Users/someone", LANG: "zh_CN.UTF-8", PATH: "/old/node/bin:/usr/bin",
    SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "gh-token", JAVA_HOME: "/opt/java",
  };

  it("passes every variable of the daemon environment, with the PATH the profile builds", () => {
    const environment = runtimeEnvironment({}, daemon);
    expect(environment.inherit).toBe("all");
    expect(childEnvironment(environment, {}, {}, daemon)).toEqual({ ...daemon, PATH: environment.path });
  });

  it("puts the daemon's Node first on the PATH it builds", () => {
    const environment = runtimeEnvironment({}, daemon);
    const dirs = environment.path.split(delimiter);
    expect(dirs[0]).toBe(dirname(process.execPath));
    expect(dirs).toContain("/old/node/bin");
    expect(dirs.indexOf("/old/node/bin")).toBeGreaterThan(0);
  });

  it("builds the PATH from the adapter's PATH when the adapter sets one", () => {
    const environment = runtimeEnvironment({ PATH: "/adapter/bin" }, daemon);
    expect(environment.path.split(delimiter)).toContain("/adapter/bin");
    expect(environment.path.split(delimiter)).not.toContain("/old/node/bin");
  });

  it("lets the adapter's variables override the daemon's, and the request's override both", () => {
    const adapterEnv = { FAKE_SCENARIO: "adapter", JAVA_HOME: "/adapter/java" };
    const environment = runtimeEnvironment(adapterEnv, daemon);
    const env = childEnvironment(environment, adapterEnv, {
      FAKE_SCENARIO: "request", PLC_TICKET_ID: "7", PATH: "/request/bin",
    }, daemon);
    expect(env).toMatchObject({ FAKE_SCENARIO: "request", JAVA_HOME: "/adapter/java", PLC_TICKET_ID: "7" });
    // child 的 PATH 总是 profile 构造出的那一个，preflight 检查的也是它。
    expect(env.PATH).toBe(environment.path);
    expect(environment.adapterVariables).toEqual(["FAKE_SCENARIO", "JAVA_HOME"]);
  });
});

// 每个 adapter 的 child 环境（继承 daemon 的变量、adapter 和请求的变量、PATH、argv 里没有 token）
// 现在是共享合约测试的用例（工单 13）：test/runtime-adapter-contract.ts 的
// "environment, as when the user runs the CLI standalone"。

// Seam 1：经过 runItem 和真实 SQLite。manager 给 child 和 MCP 服务器的同名变量取值必须相同，
// 否则 Codex adapter 拒绝启动（forwardMcpEnv）。这里用 manager 真正生成的工具桥 token 走完整个 Run。
describe("a Run with the plc tool channel, through runItem", () => {
  function setup() {
    const dir = tempDir();
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t10", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    // 和 agentMcpServer() 一样不带 env：MCP 服务器的变量全部由 manager 填。
    const mcpServer = { command: MCP_SERVER.command, args: MCP_SERVER.args };
    const runOpts = { dbPath, dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "work", lingerMs: 0, mcpServer };
    return { db, dir, itemId, runOpts };
  }
  const runState = (db: ReturnType<typeof openDb>, runId: number) =>
    db.prepare("SELECT state, error_code FROM runs WHERE id=?").get(runId);

  it("gives Codex the token by name only, and the Run finishes", async () => {
    const { db, dir, itemId, runOpts } = setup();
    const file = join(dir, "codex-capture.json");
    const codex = new CodexRuntime({
      bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
      env: { FAKE_CODEX_SCENARIO: "happy", FAKE_CODEX_CAPTURE: file, FAKE_CAPTURE_ENV: "PLC_AGENT_TOOL_TOKEN" },
    });
    const { runId } = await runItem(db, itemId, { ...runOpts, runtime: codex, runtimeId: "codex", model: "gpt-5.5" });
    const captured = JSON.parse(readFileSync(file, "utf8")) as Captured;
    const token = captured.values.PLC_AGENT_TOOL_TOKEN!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(captured.args.filter((arg) => arg.includes(token))).toEqual([]);
    expect(captured.args.find((arg) => arg.startsWith("mcp_servers.plc.env_vars="))).toContain('"PLC_AGENT_TOOL_TOKEN"');
    expect(runState(db, runId)).toEqual({ state: "finished", error_code: null });
    db.close();
  });

  it("gives Claude the token in a private config file, and the Run finishes", async () => {
    const { db, dir, itemId, runOpts } = setup();
    const file = join(dir, "claude-capture.json");
    const claude = new ClaudeRuntime({
      bin: TSX, prefixArgs: [resolve("packages/runtime/testing/fake-claude.ts")],
      env: { FAKE_CLAUDE_SCENARIO: "inspect", FAKE_CLAUDE_CAPTURE: file, FAKE_CAPTURE_ENV: "PLC_AGENT_TOOL_TOKEN" },
    });
    const { runId } = await runItem(db, itemId, { ...runOpts, runtime: claude, runtimeId: "claude", model: "claude-opus-5" });
    const captured = JSON.parse(readFileSync(file, "utf8")) as Captured & { argv: string[] };
    const config = captured.mcpConfig as { mcpServers: { plc: { env: Record<string, string> } } };
    const token = config.mcpServers.plc.env.PLC_AGENT_TOOL_TOKEN!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(captured.argv.filter((arg) => arg.includes(token))).toEqual([]);
    expect(captured.mcpConfigMode).toBe("600");
    expect(existsSync(captured.mcpConfigPath!)).toBe(false);
    expect(runState(db, runId)).toEqual({ state: "finished", error_code: null });
    db.close();
  });
});

// CLI 自己的配置会引用认证变量：Codex 的 model_providers.<名字>.env_key，pi 的 models.json 里的 $NAME。
// 工单 10 审查时发现：真实的 Codex 配置用 env_key 引用 daemon 从钥匙串载入的变量。
// child 继承全部环境以后，这类认证来源不需要再从配置文件里找变量名。
describe("the auth sources in the CLI's own config", () => {
  it("reach a Codex child: its CODEX_HOME and the variable that env_key names", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), [
      'model_provider = "proxy"',
      "[model_providers.proxy]",
      'base_url = "http://127.0.0.1:9/v1"',
      'env_key = "T11_PROVIDER_KEY"',
    ].join("\n"));
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("T11_PROVIDER_KEY", "provider-key");
    const { captured } = await adapters.codex!({ env: { FAKE_CAPTURE_ENV: "T11_PROVIDER_KEY,CODEX_HOME" } });
    expect(captured.values).toEqual({ T11_PROVIDER_KEY: "provider-key", CODEX_HOME: home });
  });

  it("reach a pi child: the variable that models.json references", async () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { proxy: { apiKey: "${T11_PI_KEY}" } } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("T11_PI_KEY", "pi-key");
    const { captured } = await adapters.pi!({ env: { FAKE_CAPTURE_ENV: "T11_PI_KEY,PI_CODING_AGENT_DIR" } });
    expect(captured.values).toEqual({ T11_PI_KEY: "pi-key", PI_CODING_AGENT_DIR: agentDir });
  });
});

// spec D6、用户故事 19：pi 用 daemon 自己的 Node 运行 CLI 入口。历史上 daemon 继承了一个旧的 PATH，
// PATH 上的第一个 node 是 22.14，pi 1.1.0 因此崩溃（runs 52、59）。
describe("the Node that runs pi", () => {
  // PATH 上排在最前的 node：一个只记下"我被用过"再转交给真正 node 的垫片。
  function oldNodeFirstOnPath(): { marker: string } {
    const dir = tempDir();
    const marker = join(dir, "used");
    writeFileSync(join(dir, "node"), `#!/bin/sh\necho used >> "${marker}"\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(dir, "node"), 0o755);
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
    return { marker };
  }

  it("is the daemon's Node, whatever node comes first on the daemon's PATH", async () => {
    const { marker } = oldNodeFirstOnPath();
    const { captured, runtime } = await adapters.pi!({});
    expect(captured.execPath).toBe(process.execPath);
    expect(existsSync(marker)).toBe(false);
    // preflight 检查的解释器就是这个 Node（工单 05 的解释器检查）。
    expect(runtime.profile!.interpreter).toMatchObject({ command: "node", path: process.execPath });
    expect(await runtime.preflight!({})).toEqual({ ok: true, checks: ["node --version", "pi --version"] });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("how the tool bridge token reaches the plc MCP server", () => {
  it("Codex forwards it by name from its own environment", async () => {
    const { captured } = await adapters.codex!({
      env: { FAKE_CAPTURE_ENV: "PLC_AGENT_TOOL_TOKEN,PLC_AGENT_TOOL_SOCKET" },
      start: { env: { PLC_TICKET_ID: "1" }, mcpServer: MCP_SERVER },
    });
    expect(captured.args).toContain('mcp_servers.plc.env_vars=["PLC_AGENT_TOOL_SOCKET","PLC_AGENT_TOOL_TOKEN","PLC_TICKET_ID"]');
    expect(captured.args.some((arg) => arg.startsWith("mcp_servers.plc.env="))).toBe(false);
    expect(captured.values).toEqual({ PLC_AGENT_TOOL_TOKEN: TOKEN, PLC_AGENT_TOOL_SOCKET: "/tmp/plc-t10.sock" });
  });

  it("Codex refuses to start when the server and the child disagree on a value", async () => {
    const runtime = new CodexRuntime({ bin: process.execPath, prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")] });
    await expect(runtime.start(request({
      env: { PLC_TICKET_ID: "2" }, mcpServer: MCP_SERVER,
    }))).rejects.toThrow("MCP 服务器的变量 PLC_TICKET_ID 和 Codex 进程的同名变量取值不同");
  });

  it("Claude reads it from a config file that only the current user can read, removed after exit", async () => {
    const { captured } = await adapters.claude!({ start: { mcpServer: MCP_SERVER } });
    expect(captured.mcpConfigMode).toBe("600");
    expect(captured.mcpConfig).toEqual({
      mcpServers: { plc: { ...MCP_SERVER, alwaysLoad: true } },
    });
    expect(captured.args[captured.args.indexOf("--mcp-config") + 1]).toBe(captured.mcpConfigPath);
    expect(existsSync(captured.mcpConfigPath!)).toBe(false);
    expect(existsSync(dirname(captured.mcpConfigPath!))).toBe(false);
  });
});

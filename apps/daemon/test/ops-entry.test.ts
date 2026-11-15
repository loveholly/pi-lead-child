// daemon 的运维入口（构建后是 dist/ops.mjs）。plc 按 distDir() 运行它，把输出原样转给用户。
// 安装、卸载、首次启动、doctor 和 lead 模型配置都在这里：它们要用 daemon 这一侧的包，
// plc 只依赖 client、protocol 和 core。这里只测没有副作用的命令。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "@pi-lead-child/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageSource } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";

// 每条测试的超时按它运行 ops 的次数算。每次运行 ops 都要用 tsx 加载 daemon 一侧的全部包：机器忙时一次要 12 到 30 秒，
// master 上也一样（2026-11-03 对比过）。原来每条 30 秒，运行两次 ops 的测试在沙箱外也稳定超时。
const OPS_RUN_MS = 60_000;

let dir: string;
beforeEach(() => { dir = tempDir("plc-ops-"); });

function ops(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", packageSource("daemon", "ops.ts"), ...args], {
      env: { ...process.env, PLC_DATA_DIR: dir, PLC_LEAD_MODEL: "", ...env },
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
  }, OPS_RUN_MS);

  it("writes the lead model into config.json", async () => {
    const result = await ops(["lead-use", "local/qwen"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("selected = local/qwen");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models).toEqual(["local/qwen"]);
  }, OPS_RUN_MS);

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
  }, OPS_RUN_MS);

  // 审查发现 1：只回滚代码之前，用新代码卸掉账本的写入守卫。
  // 运行两次 ops（status 和 uninstall）。
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
  }, 2 * OPS_RUN_MS);

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
  }, OPS_RUN_MS);

  it("runs the read-only doctor", async () => {
    const result = await ops(["doctor"]);
    expect(result.stdout).toContain("daemon");
    expect([0, 1]).toContain(result.code);
  }, OPS_RUN_MS);

  // 没有 supervisor 时 plc daemon stop 也要记下"用户停的"，否则下一次自动拉起会把一切又拉起来。
  it("records a stop even when no supervisor is running", async () => {
    const result = await ops(["stop"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("不会自动启动");
    const state = JSON.parse(readFileSync(join(dir, "supervisor-state.json"), "utf8"));
    expect(state).toMatchObject({ version: 1, desiredState: "stopped" });
  }, OPS_RUN_MS);

  // 桌面版的安装（docs/desktop/macos-desktop-design.md 第 4.2 节）。这里只测在碰 launchd 之前就停下的情况：测试不动这台机器的 launchd 任务。
  it("refuses desktop-install without --root", async () => {
    expect((await ops(["desktop-install"])).code).toBe(2);
  }, OPS_RUN_MS);

  it("refuses desktop-install with an unknown locale", async () => {
    expect((await ops(["desktop-install", "--root", join(dir, "runtime", "current"), "--locale", "fr"])).code).toBe(2);
  }, OPS_RUN_MS);

  it("stops desktop-install in the first step when the root is not <install root>/current, and says so in JSON", async () => {
    const result = await ops(["desktop-install", "--root", join(dir, "somewhere else"), "--progress-json"]);
    expect(result.code).toBe(1);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { step: string; state: string; code?: string });
    expect(events.at(-1)).toMatchObject({ step: "preflight", state: "failed", code: "root_invalid" });
    expect(JSON.parse(readFileSync(join(dir, "runtime", "install-state.json"), "utf8")).lastError).toMatchObject({ code: "root_invalid" });
  }, OPS_RUN_MS);

  it("selfcheck loads better-sqlite3, finds the runtime assets in the source and reports that a checkout has no release.json", async () => {
    const result = await ops(["selfcheck"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "better-sqlite3", ok: true }),
      expect.objectContaining({ name: "release.json", ok: false }),
      expect.objectContaining({ name: "runtime assets", ok: true, detail: expect.stringContaining("found in source") }),
    ]);
  }, OPS_RUN_MS);

  // 2026-11-03 10:1xZ：负载 35–90，daemon 忙着。supervisor 的 status 要先问 daemon（最多 1.5 秒），运维入口只给它 1 秒，
  // 就当它没在跑：start 等了 20 秒后报「supervisor 启动失败」，plc daemon restart 跟着失败；stop 则绕过 supervisor，
  // 自己写它的状态文件。现在只要 supervisor.sock 连得上，就把请求交给这个 supervisor。
  describe("with a supervisor that is busy", () => {
    // 连接马上接受，status 3 秒后才回答，别的命令马上回答。
    async function busySupervisor(): Promise<{ commands: string[]; close(): Promise<void> }> {
      const commands: string[] = [];
      const sockets = new Set<Socket>();
      const server = createServer((sock) => {
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
        sock.on("error", () => {});
        let buffer = "";
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => {
          buffer += chunk;
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const command = JSON.parse(buffer.slice(0, newline)) as { type: string; id?: string };
            buffer = buffer.slice(newline + 1);
            commands.push(command.type);
            const reply = () => {
              if (!sock.destroyed) sock.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: {} })}\n`);
            };
            if (command.type === "status") setTimeout(reply, 3_000);
            else reply();
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(join(dir, "supervisor.sock"), resolve));
      return {
        commands,
        close: async () => {
          for (const sock of sockets) sock.destroy();
          await new Promise((resolve) => server.close(resolve));
        },
      };
    }

    it("sends start to it, instead of failing with 'supervisor 启动失败'", async () => {
      const supervisor = await busySupervisor();
      try {
        const result = await ops(["start"]);
        expect(result.stderr).not.toContain("supervisor 启动失败");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Supervisor 与 daemon 已启动");
        expect(supervisor.commands).toContain("ensure_running");
      } finally {
        await supervisor.close();
      }
    }, 40_000);

    it("sends stop to it, and does not write its state file", async () => {
      const supervisor = await busySupervisor();
      try {
        const result = await ops(["stop"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("daemon 已停止，Supervisor 保持运行");
        expect(supervisor.commands).toContain("stop_daemon");
        expect(existsSync(join(dir, "supervisor-state.json"))).toBe(false);
      } finally {
        await supervisor.close();
      }
    }, 40_000);
  });

  it("refuses an unknown command with its usage", async () => {
    const result = await ops(["work", "3"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: ops.mjs");
  }, OPS_RUN_MS);
});

// 2026-11-02：负载高时 daemon 3 分钟才就绪。supervisor 自己等 daemon 120 秒（PLC_DAEMON_READY_TIMEOUT_MS），
// plc daemon start 却只等 ensure_running 35 秒，超时就打印 supervisor request timed out、退出码 1，CLI 报「启动失败」。
describe("plc daemon start while the daemon is still starting", () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  });
  // 假 supervisor：answer 决定回答哪些命令，别的命令一直不回答（supervisor 还在等 daemon 就绪）。
  async function fakeSupervisor(answer: (type: string) => boolean): Promise<void> {
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        const command = JSON.parse(chunk.trim()) as { type: string };
        if (answer(command.type)) socket.write(`${JSON.stringify({ type: "response", success: true, data: {} })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(dir, "supervisor.sock"), resolve));
  }

  it("says the daemon is still starting, with its own exit code, when ensure_running outlasts the wait", async () => {
    await fakeSupervisor((type) => type === "status");
    // 等 ensure_running 的期限跟着 PLC_DAEMON_READY_TIMEOUT_MS 走（再加一点余量），这里把它调短。
    const result = await ops(["start"], { PLC_DAEMON_READY_TIMEOUT_MS: "100" });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("daemon 仍在启动");
    expect(result.stderr).toContain("plc daemon status");
    expect(result.stderr).not.toContain("timed out");
  }, 90_000);
});

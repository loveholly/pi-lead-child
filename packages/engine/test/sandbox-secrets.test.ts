// 沙箱里的密钥和本机端口（2026-10-28）：用真的沙箱跑，只在 macOS 和 Linux 上跑。
// 用户：「让它读不到真正的内容，但是当他调用某些工具要用到环境变量却又可以」。绑定了主机的密钥，沙箱里只是占位值
// （发往那个主机时沙箱的代理换成真值，这一步要连外网，在本机用 Claude Code 和 postman-echo.com 核实过）；
// 没绑定主机的，沙箱里没有。
import { afterEach, describe, expect, it } from "vitest";
import { sandboxPolicy, SANDBOX_SECRET_HOSTS_ENV } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { resetSandboxForTests, sandboxedBashOperations } from "../src/sandbox/bash.js";

const supported = process.platform === "darwin" || process.platform === "linux";

async function run(ops: ReturnType<typeof sandboxedBashOperations>, command: string, cwd: string) {
  let output = "";
  const result = await ops.exec(command, cwd, { onData: (data) => { output += data.toString(); }, timeout: 30 });
  return { exitCode: result.exitCode, output: output.trim() };
}

describe.runIf(supported)("secrets and local ports in the sandbox", () => {
  afterEach(async () => {
    await resetSandboxForTests();
    delete process.env.PLC_SBX_DEMO_TOKEN;
    delete process.env.PLC_SBX_LOOSE_TOKEN;
  });

  it("shows a placeholder for a secret bound to a host and nothing for an unbound one", async () => {
    // sandbox-runtime 从本进程的环境读真值。
    process.env.PLC_SBX_DEMO_TOKEN = "real-demo-value-0123456789abcdef";
    process.env.PLC_SBX_LOOSE_TOKEN = "loose-demo-value-0123456789abcdef";
    const env = { ...process.env, [SANDBOX_SECRET_HOSTS_ENV]: "PLC_SBX_DEMO_TOKEN=example.com" };
    const dir = tempDir("plc-sbx-secret-");
    const ops = sandboxedBashOperations(() => sandboxPolicy({ role: "executor", writable: [dir], env }));
    const result = await run(ops, "echo \"bound=${PLC_SBX_DEMO_TOKEN:-none} loose=${PLC_SBX_LOOSE_TOKEN:-none}\"", dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("real-demo-value");
    expect(result.output).not.toContain("bound=none");
    expect(result.output).toContain("loose=none");
  }, 90_000);

  it("lets an executor serve on a local port", async () => {
    const dir = tempDir("plc-sbx-port-");
    const ops = sandboxedBashOperations(() => sandboxPolicy({ role: "executor", writable: [dir], env: {} }));
    const result = await run(ops, LISTEN_AND_CONNECT, dir);
    expect(result.output).toContain("connected");
  }, 90_000);

  // 网关在本机端口上，本机网页能自动配对：Lead 的命令连不了本机端口。
  it("keeps Lead's commands off local ports", async () => {
    const dir = tempDir("plc-sbx-port-");
    const ops = sandboxedBashOperations(() => sandboxPolicy({ role: "lead", writable: [dir], env: {} }));
    const result = await run(ops, LISTEN_AND_CONNECT, dir);
    expect(result.output).not.toContain("connected");
  }, 90_000);
});

// 在本机端口上监听，再连上去。成功时打印 connected。
const LISTEN_AND_CONNECT = `node -e '
const net = require("net");
const server = net.createServer((socket) => socket.end());
server.on("error", (error) => { console.log("listen failed: " + error.code); process.exit(0); });
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => { console.log("connected"); client.end(); server.close(); });
  client.on("error", (error) => { console.log("connect failed: " + error.code); server.close(); });
});'`;

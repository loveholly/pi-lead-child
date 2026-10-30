// 工单 14 的 Seam 3：一个持有 child 的宿主进程，代替 daemon。它经启动垫片启动一个 CLI，
// 在 stdout 打印一行身份（CLI 的 pid、垫片的 pid、启动目录），然后按 HOST_MODE 行事：
//   wait：一直运行，等测试杀掉它。宿主没有自己的信号处理函数，和 plc work 一样。
//   exit：正常退出（process.exit），测试据此检查宿主退出时 child 也被停止。
// HOST_RUNTIME=claude 时启动 Claude adapter（fake Claude CLI 的 linger 场景，带 plc 的 MCP 配置）；
// 否则启动一个一直运行的 node 脚本。HOST_RUN_ID 给出这个 Run 的 id（默认 42）。
// 工单 15：身份里还有控制 socket 的路径和 token，测试用它们模拟重启后的身份核对。
import { resolve } from "node:path";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { launchProcess } from "@pi-lead-child/runtime";

const launchDir = process.env.HOST_LAUNCH_DIR;
if (!launchDir) throw new Error("HOST_LAUNCH_DIR is required");

async function start(): Promise<{ childPid: number | null; shimPid: number; dir: string; token: string; controlPath: string }> {
  if (process.env.HOST_RUNTIME === "claude") {
    const runtime = new ClaudeRuntime({
      bin: process.execPath,
      prefixArgs: ["--import", "tsx", resolve("packages/runtime/testing/fake-claude.ts")],
      env: { FAKE_CLAUDE_SCENARIO: "linger", FAKE_CLAUDE_CAPTURE: process.env.FAKE_CLAUDE_CAPTURE ?? "" },
    });
    const handle = await runtime.start({
      itemId: 1, runId: 41, role: "executor", purpose: "execution", prompt: "linger",
      workdir: process.cwd(), env: {}, launchDir,
      mcpServer: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: { PLC_TOKEN_FOR_TEST: "t" } },
    });
    void (async () => { for await (const _event of handle.events) { /* 读完事件 */ } })();
    const launcher = handle.process!.launcher!;
    return {
      childPid: handle.pid, shimPid: launcher.pid, dir: launcher.dir, token: launcher.token, controlPath: launcher.controlPath,
    };
  }
  // HOST_CLI_IGNORES_SIGTERM=1：CLI 忽略 SIGTERM，只有 SIGKILL 能停止它。
  const ignoreTerm = process.env.HOST_CLI_IGNORES_SIGTERM === "1" ? "process.on('SIGTERM', () => {});" : "";
  const child = await launchProcess({
    runId: Number(process.env.HOST_RUN_ID ?? 42),
    command: process.execPath,
    args: ["-e", `${ignoreTerm}process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`],
    env: { PATH: process.env.PATH ?? "" },
    baseDir: launchDir,
    killGraceMs: process.env.HOST_KILL_GRACE_MS ? Number(process.env.HOST_KILL_GRACE_MS) : undefined,
  });
  child.stdout.resume();
  child.stderr.resume();
  return {
    childPid: child.pid ?? null, shimPid: child.launcher.pid, dir: child.launcher.dir,
    token: child.launcher.token, controlPath: child.launcher.controlPath,
  };
}

const identity = await start();
process.stdout.write(`${JSON.stringify(identity)}\n`, () => {
  if (process.env.HOST_MODE === "exit") process.exit(0);
});
setInterval(() => {}, 1_000);

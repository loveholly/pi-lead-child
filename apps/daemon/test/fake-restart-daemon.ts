// 工单 15 的 Seam 3：一个真实的 daemon 进程。它用 fake Codex CLI 的 gated 场景执行派发队列里的工单。
// 测试先杀掉或正常停止这个进程，再在同一个数据目录上启动一个新的进程，看新进程怎样接管 child。
// 闸门文件由 FAKE_CODEX_GATE_FILE 给出。崩溃循环额度读 daemon 的 PLC_CRASH_LOOP_* 变量。
// FAKE_DAEMON_HOLD_START=1：runtime 启动 CLI 以后不返回。daemon 停在"垫片和 CLI 已经起来、身份还没有记进库"这一步，
// 测试据此模拟 daemon 在启动 Run 的途中被杀掉。
import { join, resolve } from "node:path";
import { startDaemon } from "../src/server.js";
import { CodexRuntime, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { RuntimeRegistry } from "@pi-lead-child/runtime";

const dataDir = process.env.PLC_DATA_DIR;
if (!dataDir) throw new Error("PLC_DATA_DIR is required");

// 不调用模型的 lead session。
const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

class HeldStartCodexRuntime extends CodexRuntime {
  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    await super.start(request);
    return new Promise<RuntimeHandle>(() => {});
  }
}

const codexOptions = {
  bin: process.execPath,
  prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
  env: {
    FAKE_CODEX_SCENARIO: "gated",
    FAKE_CODEX_GATE_FILE: process.env.FAKE_CODEX_GATE_FILE ?? "",
  },
};
const codex = process.env.FAKE_DAEMON_HOLD_START === "1"
  ? new HeldStartCodexRuntime(codexOptions)
  : new CodexRuntime(codexOptions);

const daemon = await startDaemon({
  dataDir,
  dbPath: join(dataDir, "plc.db"),
  sessionFactory: sessionFactory as never,
  runtimeRegistry: new RuntimeRegistry([codex]),
  log: (line) => process.stderr.write(`${line}\n`),
});
// 测试读这一行，确认启动修复已经做完。
process.stdout.write("ready\n");

const stop = () => { void daemon.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

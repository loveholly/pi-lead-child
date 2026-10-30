// 工单 14 的 Seam 3：一个真实的 daemon 进程。它用 fake Codex CLI 执行派发队列里的工单。
// 测试用 SIGKILL 杀掉这个进程，再看 child 是否还活着。
// 心跳场景由 FAKE_CODEX_HEARTBEAT_FILE 和 FAKE_CODEX_HEARTBEAT_MS 配置。
import { join, resolve } from "node:path";
import { startDaemon } from "../src/server.js";
import { CodexRuntime } from "@pi-lead-child/runtime";
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

const codex = new CodexRuntime({
  bin: process.execPath,
  prefixArgs: ["--import=tsx", resolve("packages/runtime/testing/fake-codex.ts")],
  env: {
    FAKE_CODEX_SCENARIO: "heartbeat",
    FAKE_CODEX_HEARTBEAT_FILE: process.env.FAKE_CODEX_HEARTBEAT_FILE ?? "",
    FAKE_CODEX_HEARTBEAT_MS: process.env.FAKE_CODEX_HEARTBEAT_MS ?? "20000",
  },
});

const daemon = await startDaemon({
  dataDir,
  dbPath: join(dataDir, "plc.db"),
  sessionFactory: sessionFactory as never,
  runtimeRegistry: new RuntimeRegistry([codex]),
  log: () => {},
});

const stop = () => { void daemon.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

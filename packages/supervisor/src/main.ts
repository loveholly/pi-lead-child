import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir, dbPath, distDir, loadEnvConfig, packageSource, projectRoot } from "@pi-lead-child/core";
import { loadKeychainEnv } from "./deploy/keychain.js";
import { startSupervisor, SupervisorAlreadyRunningError, type SupervisorHandle } from "./server.js";
import { runtimeSearchPath } from "@pi-lead-child/runtime";

const root = projectRoot();
process.env.PATH = runtimeSearchPath(process.env.PATH);
const keychainKeys = loadKeychainEnv();
if (keychainKeys.length) console.log(`[config] keychain env keys applied: ${keychainKeys.join(", ")}`);
const applied = loadEnvConfig();
if (applied.length) console.log(`[config] env keys applied: ${applied.join(", ")}`);

// daemon 从 dist 启动时，部署闸门检查的就是这个 checkout 和这个 dist。直接跑源码（PLC_DEV）时没有 dist 可查。
function runsFromDist(): boolean {
  return existsSync(join(distDir(), "coordinatord.mjs")) && !process.env.PLC_DEV;
}

function daemonCommand(): { bin: string; args: string[] } {
  const dist = join(distDir(), "coordinatord.mjs");
  if (runsFromDist()) return { bin: process.execPath, args: [dist] };
  return {
    bin: join(root, "node_modules", ".bin", "tsx"),
    args: [packageSource("daemon", "main.ts")],
  };
}

// PLC_DAEMON_READY_TIMEOUT_MS：daemon 启动以后最多等多久它回答 status（毫秒）。不是正整数时用缺省值。
function daemonReadyTimeoutMs(): number | undefined {
  const configured = Number(process.env.PLC_DAEMON_READY_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : undefined;
}

let supervisor: SupervisorHandle;
try {
  supervisor = await startSupervisor({
    dataDir: dataDir(),
    dbPath: dbPath(),
    daemonCommand: daemonCommand(),
    cwd: root,
    daemonReadyTimeoutMs: daemonReadyTimeoutMs(),
    deployment: runsFromDist() ? { root, distDir: distDir() } : null,
  });
} catch (error) {
  // 这个数据目录已经有 supervisor 了：让开，正常退出。launchd 的 KeepAlive 之后还会拉起本进程，
  // 每次都会再检查一次；持锁的 supervisor 退出以后，下一次拉起的进程接管。
  if (error instanceof SupervisorAlreadyRunningError) {
    console.log(`[${new Date().toISOString()}] ${error.message}`);
    process.exit(0);
  }
  throw error;
}

const stop = () => { void supervisor.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

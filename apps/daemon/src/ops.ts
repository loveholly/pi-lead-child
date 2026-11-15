// daemon 的运维入口。构建后是 apps/daemon/dist/ops.mjs，plc 按 distDir() 运行它，输出原样转给用户。
// plc 是 daemon 的客户端，只依赖 client、protocol 和 core。下面这些动作要用 daemon 这一侧的包
// （supervisor 的 launchd 和 doctor、lead 的模型配置），所以由 daemon 自己提供：
//   start [--auto] 启动：没有 supervisor 就后台拉起它，再让它拉起 daemon。--auto 是客户端的自动拉起：
//                  用户 plc daemon stop 过、或者维护进行中时，supervisor 拒绝，退出码 3。
//                  显式启动在维护进行中也被拒绝（退出码 3）。等到期限 daemon 还没就绪：退出码 4（仍在启动，不是失败）
//   stop           没有 supervisor 时停 daemon，并在 supervisor-state.json 里记下"用户停的"
//   install        安装 launchd 常驻 supervisor（开发安装；运行包里运行时不查 AM_API_KEY）
//   desktop-install --root <安装根>/current [--locale en|zh] [--progress-json]
//                  桌面版：一条命令装好 launchd 服务并等到健康，按行输出 JSON 进度（supervisor 的 desktop-install.ts）。
//                  遇到存量安装时自动迁移、接管（设计第 12 节）；PLC_KEEP_DEV_INSTALL=1 时保留开发安装
//   login-shell-path  读登录 shell 的 PATH，写进 <数据目录>/login-shell-path.json。App 每次打开时运行
//   selfcheck      运行包自检：能加载 better-sqlite3，能读 release.json。换版本以前对新版本运行
//   migrate-data-dir [--locale en|zh] [--follow]
//                  开发机从改名以前的数据目录和 launchd 任务迁到新名字（supervisor 的 data-dir-migration.ts，P0-8）。
//                  迁移在自己的会话里运行，进度写进 ~/Library/Logs/Bytezard Lead/ 下的日志；--follow 时在这里跟着输出
//   uninstall      卸载 launchd 常驻
//   doctor         只读诊断
//   lead-model     显示 Lead 模型与 provider
//   lead-use SPEC  把 Lead 默认模型写入 config.json
//   sched-trace ID [--log FILE]...
//                  一个工作单元（unit_…）或一轮（turn_…）的调度时间线（lead-scheduler spec D12）：daemon 日志、Lead 的会话文件和
//                  events 表里的 scheduler.* 合在一起。只读文件、只读打开账本，daemon 卡住时照样能查。缺省读
//                  <数据目录>/logs/coordinatord.{out,err}.log 和 <数据目录>/daemon.log（开发 daemon）
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, statfsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DAEMON_ONLY_ENV_NAMES,
  captureLoginShellPath, dataDir, dbPath, defaultDataDir, distDir, envConfigPath, isPreRenameDataDir, loadEnvConfig,
  isReleaseRuntime, packageSource, preRenameDataDir, projectRoot, runtimeAssetPaths, saveLoginShellPath, workspaceDir,
} from "@pi-lead-child/core";
import {
  activeLaunchdLabel, AGENT_BINARY, agentStatus, autoStartRefusal, bootstrapAgent, installAgentBinary, itemsBlockingMaintenance,
  launchAgentsDir, launchctl, runDataDirMigration, socketListening, SUPERVISOR_WAIT_MS, buildsFreshReal, ensureRunningTimeoutMs, hasReleaseManifest, plistPath as launchdPlistPath,
  KEEP_DEV_INSTALL_ENV, preRenamePlistPaths, readReleaseManifest, runDesktopInstall, loadSupervisorState, saveSupervisorState, dbProbesReal, distFreshReal, formatChecks, installAgent, keychainSecretExists, keychainSetCommand,
  plistContent, plistPath, resolveDaemonOnlyKey, resolveKeyReal, runDoctor, SUPERVISOR_REQUEST_TIMEOUT, supervisorListening, supervisorRequest, supervisorSockPath,
  uninstallAgent, uninstallHindsightService, type BuildOutput, type DoctorProbes, type SupervisorStatus,
} from "@pi-lead-child/supervisor";
import {
  loadLeadModelConfig, resolveLeadApiKey, selectedLeadModelSpec, setLeadModelInConfig,
} from "@pi-lead-child/lead";
import { defaultWebRoot } from "@pi-lead-child/gateway";
import { isLocale, type DaemonLocalStatus, type LocalSocketCommand } from "@pi-lead-child/protocol";
import {
  dropLedgerGuards, ledgerGuardedTables, ledgerGuardDropSql, ledgerGuardTriggers, missingLedgerGuards, openExistingDb,
  schedulerEventsOfUnit, schedulerUnitsOfTurn, type EventRecord,
} from "@pi-lead-child/store";
import { formatSchedTrace, readTraceLogLines, readTraceSessionEntries, SCHED_TRACE_ID, schedTrace, unitsOf } from "./sched-trace.js";

const PROJECT_ROOT = projectRoot();
const USAGE = "usage: ops.mjs start [--auto] | stop | install | desktop-install --root <dir> [--locale en|zh] [--progress-json] | login-shell-path | selfcheck | migrate-data-dir [--locale en|zh] [--follow] | uninstall | doctor | lead-model | lead-use <provider/model> | ledger-guard status|uninstall | sched-trace <unit_…|turn_…> [--log <file>]...";
const SCHED_TRACE_USAGE = "usage: plc sched trace <unit_…|turn_…> [--log <file>]...";
// start --auto 被 supervisor 拒绝（plc 的 daemon-link.ts 认这个退出码）。
const AUTO_START_REFUSED = 3;
// ensure_running 等到期限还没回答：supervisor 还在等 daemon 就绪，daemon 仍在启动（plc 的 daemon-link.ts 认这个退出码）。
const DAEMON_STILL_STARTING = 4;

// 构建产物和它打包进去的源码。doctor 用源码的修改时间判断构建是否过期。
// daemon 的构建打包全部后端包；plc 的构建只打包 client、protocol 和 core。
const DAEMON_PACKAGES = ["protocol", "core", "runtime", "store", "engine", "supervisor", "gateway", "lead", "daemon"];
const CLI_PACKAGES = ["protocol", "client", "core", "cli"];
function appBuild(app: string, packages: string[], distFile: string): BuildOutput {
  return { distFile, srcDirs: [...packages.map((pkg) => packageSource(pkg)), join(workspaceDir(app), "scripts")] };
}

// supervisor 启动命令：dist 构建产物优先（与 launchd 同一入口），PLC_DEV=1 或未构建时回退 tsx 源码。
function supervisorCommand(): { bin: string; args: string[] } {
  const dist = join(distDir(), "supervisor.mjs");
  if (existsSync(dist) && !process.env.PLC_DEV) return { bin: process.execPath, args: [dist] };
  return {
    bin: join(PROJECT_ROOT, "node_modules", ".bin", "tsx"),
    args: [packageSource("supervisor", "main.ts")],
  };
}

function spawnSupervisorDetached(): void {
  const logFd = openSync(join(dataDir(), "supervisor.log"), "a");
  const { bin, args } = supervisorCommand();
  const proc = spawn(bin, args, { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  proc.unref();
}

// 有没有 supervisor 在跑，只看 supervisor.sock 连不连得上（supervisorListening）。2026-11-03 负载 35–90：supervisor 的
// status 先问忙着的 daemon（最多 1.5 秒），这里以前只给它 1 秒，就当它没在跑：start 等满 20 秒报「supervisor 启动失败」，
// stop 绕过它自己写它的状态文件。连得上就把请求交给它，请求有自己的时限。
async function waitForSupervisor(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await supervisorListening()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // socket 在监听：supervisor 活着，只是忙得没回答（例如负载高），不是没起来。
  if (await supervisorListening()) {
    throw new Error(`supervisor 在运行但还没回答（等了 ${timeoutMs / 1_000} 秒）。稍后用 plc daemon status 看进度；日志: ${join(dataDir(), "supervisor.log")}`);
  }
  throw new Error(`supervisor 启动失败，查看日志: ${join(dataDir(), "supervisor.log")}`);
}

async function waitForSupervisorStopped(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await supervisorListening())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("旧 Supervisor 未能在安装前完整退出");
}

// daemon 自己的 plc.sock：只用它探活和停机。
const daemonSockPath = (dir: string = dataDir()) => join(dir, "plc.sock");
function daemonReachable(dir?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(daemonSockPath(dir));
    sock.once("connect", () => { sock.end(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

// plc.sock 的 status（daemon 没在运行时为 null）。只读：doctor 用它看网关对外地址的状态。
function daemonLocalStatus(dir?: string): Promise<DaemonLocalStatus | null> {
  return new Promise((resolve) => {
    const sock = connect(daemonSockPath(dir));
    let buffer = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 3_000);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as { success?: boolean; data?: DaemonLocalStatus };
        resolve(message.success ? message.data ?? null : null);
      } catch {
        resolve(null);
      }
    });
    sock.once("error", () => { clearTimeout(timer); resolve(null); });
    sock.once("connect", () => sock.write(`${JSON.stringify({ type: "status" })}\n`));
  });
}

// 在 plc.sock 上发一条命令，等一行回答。daemon 没在运行时返回 null。
function daemonCommand<T>(command: LocalSocketCommand, timeoutMs = 10_000): Promise<{ success: boolean; data?: T; error?: string } | null> {
  return new Promise((resolve) => {
    const sock = connect(daemonSockPath());
    let buffer = "";
    let connected = false;
    const timer = setTimeout(() => { sock.destroy(); resolve(connected ? { success: false, error: "daemon 没有及时回答" } : null); }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as { success: boolean; data?: T; error?: string });
      } catch {
        resolve({ success: false, error: "daemon 的回答不是 JSON" });
      }
    });
    sock.once("error", () => { clearTimeout(timer); resolve(null); });
    sock.once("connect", () => { connected = true; sock.write(`${JSON.stringify(command)}\n`); });
  });
}

async function shutdownUnsupervisedDaemon(dir?: string): Promise<void> {
  const sock = connect(daemonSockPath(dir));
  await new Promise<void>((resolve) => {
    sock.once("connect", () => {
      sock.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      sock.end();
      resolve();
    });
    sock.once("error", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function start(auto: boolean, force = false): Promise<number> {
  // supervisor 在忙（socket 能连上，只是没及时回答）时不再起第二个（2026-10-15 live），也不等它先回答 status（2026-11-03）。
  if (!(await supervisorListening())) {
    spawnSupervisorDetached();
    await waitForSupervisor();
  }
  if (auto) {
    // 用户 plc daemon stop 过、或者维护进行中：不自动拉起。supervisor 收到 auto 时也会再检查一次。
    const status = await supervisorRequest<SupervisorStatus>({ type: "status" });
    const refusal = autoStartRefusal(status.supervisor, status.maintenanceActive);
    if (refusal) {
      console.error(refusal);
      return AUTO_START_REFUSED;
    }
  }
  try {
    const started = await supervisorRequest<{ forcedPastDeployGate?: string[] }>({
      type: "ensure_running", ...(auto ? { auto: true } : {}), ...(force ? { force: true } : {}),
    }, { timeoutMs: ensureRunningTimeoutMs() });
    if (started?.forcedPastDeployGate?.length) {
      console.error(`已用 --force 越过部署闸门启动，supervisor 日志里有记录：\n- ${started.forcedPastDeployGate.join("\n- ")}`);
    }
  } catch (error: any) {
    // supervisor 拒绝了（自动拉起赶上了 stop 或维护，或者显式启动赶上了维护）：它的回答就是给人看的原因。
    if (error?.code === "auto_start_refused" || error?.code === "maintenance_in_progress") {
      console.error(error.message);
      return AUTO_START_REFUSED;
    }
    // 等 ensure_running 的期限比 supervisor 等 daemon 的期限（PLC_DAEMON_READY_TIMEOUT_MS）长。到期还没回答，
    // 是 supervisor 还在等一个启动慢的 daemon：不算启动失败（2026-11-02：负载高时 daemon 3 分钟才就绪）。
    if (error?.code === SUPERVISOR_REQUEST_TIMEOUT) {
      console.error("daemon 仍在启动，用 plc daemon status 看进度。");
      return DAEMON_STILL_STARTING;
    }
    // 部署闸门：主 checkout 有没提交的代码，或者 dist 不是从干净的 commit 构建的。
    if (error?.code === "deploy_refused") {
      console.error(`${error.message}\n先提交并重新构建；确实要启动现在的 dist 时，用 plc daemon start --force（会记进 supervisor 日志）。`);
      return 1;
    }
    throw error;
  }
  console.log(`Supervisor 与 daemon 已启动，Supervisor socket: ${supervisorSockPath()}`);
  return 0;
}

// 没有 supervisor 时的 plc daemon stop。和 supervisor 的 stop_daemon 一样把 desiredState 记成 stopped
// （同一个状态文件，同一套读写），这样之后的自动拉起不会把 daemon 又拉起来。
async function stop(): Promise<number> {
  if (await supervisorListening()) {
    await supervisorRequest({ type: "stop_daemon" }, { timeoutMs: 35_000 });
    console.log("daemon 已停止，Supervisor 保持运行");
    return 0;
  }
  const statePath = join(dataDir(), "supervisor-state.json");
  const state = loadSupervisorState(statePath);
  state.desiredState = "stopped";
  state.phase = "stopped";
  saveSupervisorState(statePath, state);
  if (await daemonReachable()) {
    await shutdownUnsupervisedDaemon();
    console.log("daemon 正在停止（没有 supervisor）。之后不会自动启动；要启动，运行 plc daemon start。");
  } else {
    console.log("daemon 未运行。已记下：之后不会自动启动；要启动，运行 plc daemon start。");
  }
  return 0;
}

// 停掉正在跑的 supervisor 和 daemon：launchd 管的先 bootout，自己起的发 shutdown。install 和 desktop-install 共用。
async function stopRunningService(): Promise<void> {
  if ((await agentStatus()) !== null) {
    await uninstallAgent(plistPath());
    await waitForSupervisorStopped();
  }
  if (await supervisorListening()) {
    await supervisorRequest({ type: "shutdown" }, { timeoutMs: 35_000 }).catch(() => {});
    await waitForSupervisorStopped();
  } else if (await daemonReachable()) {
    await shutdownUnsupervisedDaemon();
  }
}

// 开发机的 Node 复制成 <数据目录>/bin/lead-agent 并重签，建软链接 <数据目录>/bin/Bytezard Lead（设计第 8.7 节，P0-8）：
// 「登录项与扩展」显示 Bytezard Lead，不显示 node。每次安装都重新复制，开发机换了 Node 版本以后跟着换。
async function placeDevAgent(dir: string): Promise<{ binary: string; launcher: string }> {
  return installAgentBinary({
    root: dir,
    placeBinary: (dest) => {
      copyFileSync(process.execPath, dest);
      chmodSync(dest, 0o755);
    },
  });
}

async function install(): Promise<number> {
  const entry = join(distDir(), "supervisor.mjs");
  if (!existsSync(entry)) { console.error("先构建: npm run build"); return 1; }
  // 还没迁移的开发机：不在旧目录旁边另装一个新任务。
  if (isPreRenameDataDir(dataDir(), homedir())) {
    console.error("这台机器还在用改名以前的数据目录和 launchd 任务。先迁移：node apps/daemon/dist/ops.mjs migrate-data-dir");
    return 1;
  }
  // AM_API_KEY 是开发环境的要求。运行包（根目录有 release.json）里不查它。
  const configuredKey = resolveKeyReal(dataDir(), {}, "AM_API_KEY") === "config";
  if (!hasReleaseManifest(PROJECT_ROOT) && !configuredKey && !keychainSecretExists("AM_API_KEY")) {
    console.error(
      `无法安装：launchd 后台没有可持久读取的 AM_API_KEY。请先运行 ${keychainSetCommand("AM_API_KEY")}`,
    );
    return 1;
  }
  await stopRunningService();
  const logDir = join(dataDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const { launcher } = await placeDevAgent(dataDir());
  const p = await installAgent(plistPath(), plistContent({
    nodeBin: launcher, entry, cwd: PROJECT_ROOT, logDir,
  }));
  await waitForSupervisor(60_000);
  await supervisorRequest({ type: "ensure_running" }, { timeoutMs: 35_000 });
  console.log(`已安装并启动 Supervisor: ${p}\n日志: ${logDir}/supervisor.{out,err}.log`);
  return 0;
}

async function waitUntil<T>(timeoutMs: number, probe: () => Promise<T | null | false>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

// 桌面版的安装（设计第 4.2 节）。进度按行输出 JSON 到 stdout，App 逐行读。--progress-json 是 App 的写法，输出总是 JSON。
// 数据目录和壳的规则一样（desktop/src/paths.ts）：PLC_DATA_DIR，缺省是新名字的目录。不用 dataDir()：还没迁移的开发机上
// 它是旧目录，而 App 装在新目录里（设计第 12.2 节）。--root 不在 <安装根>/current 时，preflight 拒绝。
async function desktopInstall(args: string[]): Promise<number> {
  const root = flagValue(args, "--root");
  const locale = flagValue(args, "--locale") ?? "en";
  if (!root || !isLocale(locale)) { console.error(USAGE); return 2; }
  // 接管途中 App 退出时，读进度的管道断了，写 stdout 会出 EPIPE：不能因此停在一半（设计第 12.6 节）。
  process.stdout.on("error", () => {});
  const home = homedir();
  const appDataDir = process.env.PLC_DATA_DIR ?? defaultDataDir(home);
  const appInstallRoot = join(appDataDir, "runtime");
  const result = await runDesktopInstall({
    root,
    installRoot: appInstallRoot,
    dataDir: appDataDir,
    dbPath: join(appDataDir, "plc.db"),
    plistPath: launchdPlistPath(),
    preRenamePlistPaths: preRenamePlistPaths(),
    // 改名以前的安装只在数据目录是缺省位置时接管：设了别的 PLC_DATA_DIR 时，旧目录和它无关。
    preRenameDataDir: resolve(appDataDir) === resolve(defaultDataDir(home)) ? preRenameDataDir(home) : null,
    keepDevInstall: process.env[KEEP_DEV_INSTALL_ENV] === "1",
    takeover: {
      launchAgentsDir: launchAgentsDir(),
      uid: process.getuid!(),
      launchctl,
      freeBytes,
      drain: drainForMigration,
      waitStopped: waitServicesStopped,
      health: newServiceHealthy,
    },
    locale,
    emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    captureLoginShellPath: () => captureLoginShellPath(),
    launchd: {
      loaded: async () => (await agentStatus()) !== null,
      stopRunning: stopRunningService,
      bootstrap: async (plist) => { await bootstrapAgent(plist); },
    },
    supervisor: {
      // 只看 supervisor.sock 能不能连上：忙着的 supervisor 回答 status 要几秒，按回答判断会把在跑的服务停掉重装。
      waitUntilAvailable: async (timeoutMs) => (await waitUntil(timeoutMs, async () => await supervisorListening(appDataDir) || null)) !== null,
      // supervisor 等 daemon 就绪最多 10 分钟（daemonReadyTimeoutMs），这里比它多等 30 秒，机器忙时不把还在启动报成失败。
      ensureRunning: async () => {
        await supervisorRequest({ type: "ensure_running" }, { dataDir: appDataDir, timeoutMs: ensureRunningTimeoutMs() });
      },
    },
    daemon: {
      waitForStatus: (timeoutMs, dir = appDataDir) => waitUntil(timeoutMs, async () => {
        const status = await daemonLocalStatus(dir);
        return status ? { gatewayUrl: status.gatewayUrl } : null;
      }),
    },
  });
  return result.ok ? 0 : 1;
}

async function loginShellPath(): Promise<number> {
  const result = await captureLoginShellPath();
  const saved = saveLoginShellPath(dataDir(), result);
  // 只输出状态和目录个数，不输出目录本身。
  process.stdout.write(`${JSON.stringify({ state: result.state, saved, ...(result.state === "ok" ? { directories: result.path.length } : {}) })}\n`);
  return 0;
}

// 运行包自检（设计第 7.3 节）：换到新版本以前，用新版本自己的 lead-agent 运行它，不停服务。
function selfcheck(): number {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    const db = new Database(":memory:");
    try {
      db.prepare("SELECT 1").get();
    } finally {
      db.close();
    }
    checks.push({ name: "better-sqlite3", ok: true, detail: "loaded" });
  } catch (error) {
    checks.push({ name: "better-sqlite3", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const manifest = readReleaseManifest(PROJECT_ROOT);
    checks.push({ name: "release.json", ok: true, detail: `${manifest.version} ${manifest.arch}` });
  } catch (error) {
    checks.push({ name: "release.json", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  // pi 扩展、skill 目录和辅助脚本（工单 #260）：按这份代码运行时的解析检查，运行包里是 dist/assets/ 下的路径。
  const release = isReleaseRuntime(PROJECT_ROOT);
  const assets = runtimeAssetPaths(release);
  const missing = assets.filter((asset) => !existsSync(asset.path));
  checks.push({
    name: "runtime assets", ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.map((asset) => asset.path).join(", ")}` : `${assets.length} found in ${release ? "dist" : "source"}`,
  });
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, root: PROJECT_ROOT, checks })}\n`);
  return ok ? 0 : 1;
}

// 排空最多等多久：Lead 一轮或者一个接管不了的执行，通常几分钟内结束。
const MIGRATION_DRAIN_TIMEOUT_MS = 30 * 60_000;
const MIGRATION_STOP_TIMEOUT_MS = 60_000;

// 等 dir 下的 supervisor 和 daemon 都退出。bootout 以后 supervisor 先排空、再停 daemon；20 秒后还在的，直接请它们停。
async function waitServicesStopped(dir: string): Promise<void> {
  const started = Date.now();
  let asked = false;
  for (;;) {
    const supervisorUp = await socketListening(join(dir, "supervisor.sock"), 1_000);
    const daemonUp = await daemonReachable(dir);
    if (!supervisorUp && !daemonUp) return;
    const waited = Date.now() - started;
    if (waited > MIGRATION_STOP_TIMEOUT_MS) {
      throw new Error(`${dir} 下的 supervisor 或 daemon 在 ${MIGRATION_STOP_TIMEOUT_MS / 1000} 秒内没有退出`);
    }
    if (!asked && waited > 20_000) {
      asked = true;
      if (supervisorUp) await supervisorRequest({ type: "shutdown" }, { dataDir: dir, timeoutMs: 35_000 }).catch(() => {});
      else await shutdownUnsupervisedDaemon(dir);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// 和 supervisor 的维护用同一个判断（server.ts 的 maintenanceTick）：Lead 不忙，在跑的执行都能在重启后接管。
async function drainForMigration(dir: string): Promise<void> {
  const drained = await waitUntil(MIGRATION_DRAIN_TIMEOUT_MS, async () => {
    const status = await daemonLocalStatus(dir);
    if (!status) return true;
    return !status.busy && !itemsBlockingMaintenance(join(dir, "plc.db"), status.runningItemIds).length;
  });
  if (!drained) throw new Error(`Lead 或执行在 ${MIGRATION_DRAIN_TIMEOUT_MS / 60_000} 分钟内没有空下来`);
}

async function newServiceHealthy(dir: string): Promise<void> {
  const up = await waitUntil(SUPERVISOR_WAIT_MS, async () => await socketListening(join(dir, "supervisor.sock"), 1_000) || null);
  if (!up) throw new Error(`新的 supervisor 在 ${SUPERVISOR_WAIT_MS / 1000} 秒内没有开始监听`);
  await supervisorRequest({ type: "ensure_running" }, { dataDir: dir, timeoutMs: ensureRunningTimeoutMs() });
  const status = await waitUntil(ensureRunningTimeoutMs(), () => daemonLocalStatus(dir));
  if (!status) throw new Error("新的 daemon 没有回答 status");
}

function freeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function startDetachedMigration(locale: string, follow: boolean): Promise<number> {
  const logDir = join(homedir(), "Library", "Logs", "Bytezard Lead");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `migrate-data-dir-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [process.argv[1]!, "migrate-data-dir", "--locale", locale, MIGRATION_RUN_FLAG], {
    detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({ started: true, pid: child.pid, log })}\n`);
  if (!follow) return 0;
  const exit = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  let offset = 0;
  let code: number | null = null;
  void exit.then((value) => { code = value; });
  for (;;) {
    // 先看它结束了没有，再读日志：结束以前写的最后几行也会输出。
    const done = code;
    const text = readFileSync(log, "utf8");
    if (text.length > offset) {
      process.stdout.write(text.slice(offset));
      offset = text.length;
    }
    if (done !== null) return done;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// 开发机从改名以前的名字迁到新名字（supervisor 的 data-dir-migration.ts）。进度按行输出 JSON。
// 迁移会停掉 supervisor 的 launchd 任务。launchd 停一个任务时连同它的进程组一起停：从 daemon 里启动的命令
// （Lead 的 run_on_host）在这个进程组里，跟着被杀，迁移就停在一半。daemon 停了以后，接着它输出的管道也断了。
// 所以真正的迁移在自己的会话里运行（detached），输出写进日志文件；这里只启动它。
// 也不等它结束：Lead 用 run_on_host 启动时，Lead 这一轮要先结束，迁移的排空才等得到。--follow 时跟着日志输出，在终端里用。
const MIGRATION_RUN_FLAG = "--run";

async function migrateDataDir(args: string[]): Promise<number> {
  const locale = flagValue(args, "--locale") ?? "en";
  if (!isLocale(locale)) { console.error(USAGE); return 2; }
  if (process.env.PLC_DATA_DIR) {
    console.error("设了 PLC_DATA_DIR：迁移只处理缺省的数据目录。去掉 PLC_DATA_DIR 再运行。");
    return 2;
  }
  const entry = join(distDir(), "supervisor.mjs");
  if (!existsSync(entry)) { console.error("先构建: npm run build"); return 1; }
  if (!args.includes(MIGRATION_RUN_FLAG)) return startDetachedMigration(locale, args.includes("--follow"));
  // 管道那头的 daemon 停了以后，写 stdout 会出 EPIPE：不能因此中断迁移。
  process.stdout.on("error", () => {});
  const home = homedir();
  const result = await runDataDirMigration({
    oldDir: preRenameDataDir(home),
    newDir: defaultDataDir(home),
    launchAgentsDir: launchAgentsDir(),
    service: { kind: "dev", checkout: PROJECT_ROOT, entry, placeAgent: placeDevAgent },
    uid: process.getuid!(),
    locale,
    launchctl,
    freeBytes,
    drain: drainForMigration,
    waitStopped: waitServicesStopped,
    health: newServiceHealthy,
    emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  return result.ok ? 0 : 1;
}

async function uninstall(): Promise<void> {
  const label = activeLaunchdLabel();
  await uninstallAgent(join(launchAgentsDir(), `${label}.plist`), label);
  // Hindsight 记忆服务是独立的 launchd 任务，一起停掉。它的数据（Postgres 里的库或者 ~/.pg0）留着。
  await uninstallHindsightService();
  console.log("已卸载（Supervisor、daemon 和 Hindsight 记忆服务随 bootout 停止；记忆数据保留）");
}

async function doctor(): Promise<number> {
  const probes: DoctorProbes = {
    ...dbProbesReal(dbPath()),
    daemonAlive: daemonReachable,
    configParses: () => {
      try {
        loadEnvConfig(dataDir(), { ...process.env });
        return true;
      } catch (e: any) {
        return e.message;
      }
    },
    resolveKey: (key) => DAEMON_ONLY_ENV_NAMES.includes(key)
      ? resolveDaemonOnlyKey(dataDir(), dbPath(), process.env, key, keychainSecretExists)
      : resolveKeyReal(dataDir(), process.env, key) ?? (keychainSecretExists(key) ? "keychain" : null),
    configPerms: () => {
      try {
        return (statSync(envConfigPath()).mode & 0o777).toString(8).padStart(3, "0");
      } catch {
        return null;
      }
    },
    launchdLoaded: async () => {
      try {
        return (await agentStatus()) !== null;
      } catch {
        return false;
      }
    },
    // daemon 和 plc 各有一份构建产物，两份都要新于源码。
    distFresh: () => buildsFreshReal([
      appBuild("daemon", DAEMON_PACKAGES, join(distDir(), "supervisor.mjs")),
      appBuild("cli", CLI_PACKAGES, join(workspaceDir("cli"), "dist", "cli.mjs")),
    ]),
    // web UI 还引用 protocol、client 和 components 三个包的源码，它们变了也要重新导出。
    webFresh: () => distFreshReal(
      join(defaultWebRoot(), "index.html"),
      [join(PROJECT_ROOT, "apps", "companion", "src"), ...["protocol", "client", "components"].map((pkg) => packageSource(pkg))],
      [".ts", ".tsx"],
    ),
    nodeVersion: () => process.version,
    agentNodeVersion: () => {
      const agent = join(dataDir(), AGENT_BINARY);
      if (!existsSync(agent)) return null;
      try {
        return execFileSync(agent, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
      } catch (error) {
        return `无法运行（${error instanceof Error ? error.message : String(error)}）`;
      }
    },
    releaseMode: () => hasReleaseManifest(PROJECT_ROOT),
    gatewayExposure: async () => (await daemonLocalStatus())?.gatewayExposure ?? null,
  };
  const checks = await runDoctor(probes);
  console.log(formatChecks(checks));
  return checks.some((c) => c.ok === false) ? 1 : 0;
}

function leadModel(): void {
  const config = loadLeadModelConfig();
  const selected = selectedLeadModelSpec(config);
  console.log(`selected: ${selected}`);
  const names = Object.keys(config.providers);
  if (!names.length) {
    console.log("providers: (none in config.json; ModelRuntime still sees ~/.pi/agent/models.json)");
    return;
  }
  for (const name of names) {
    const provider = config.providers[name];
    if (!provider) continue;
    const key = resolveLeadApiKey(provider);
    console.log(`provider ${name}:`);
    console.log(`  api: ${provider.api ?? "openai-completions"}`);
    console.log(`  baseUrl: ${provider.baseUrl}`);
    console.log(`  discover: ${provider.discover === true ? "yes" : provider.discover === false ? "no" : "auto"}`);
    console.log(`  apiKey: ${key ? "configured" : "none"}`);
    if (provider.models?.length) {
      console.log(`  models: ${provider.models.map((model) => model.id).join(", ")}`);
    }
  }
  if (config.models.length) console.log(`lead.models: ${config.models.join(", ")}`);
}

// daemon 在运行时经它写 config.json：daemon 核对 config.json 时，只认它自己写下的内容（config-watch.ts）。
// daemon 没在运行时直接写：下次启动时 daemon 以那时的内容为起点。
async function leadUse(spec: string | undefined): Promise<number> {
  if (!spec) { console.error(USAGE); return 2; }
  const viaDaemon = await daemonCommand<{ path: string; models: string[] }>({ type: "set_lead_model", spec });
  if (viaDaemon && !viaDaemon.success) {
    console.error(viaDaemon.error ?? "daemon 没有写入");
    return 1;
  }
  const path = viaDaemon?.data?.path ?? setLeadModelInConfig(spec);
  const models = viaDaemon?.data?.models ?? loadLeadModelConfig().models;
  console.log(`已写入 ${path}: selected = ${models[0] ?? spec}`);
  if (models.length > 1) console.log(`lead.models: ${models.join(", ")}`);
  console.log('重启 daemon 后生效：plc daemon restart --reason "switch lead model"');
  return 0;
}

// 账本的写入守卫（store 的 ledger-guard.ts）。uninstall 只在 daemon 停着时做：只回滚代码之前用它，
// 旧代码打开装过守卫的库会失败。daemon 在运行时，它下次核对就会补装并报警。
async function ledgerGuard(action: string | undefined): Promise<number> {
  if (action !== "status" && action !== "uninstall") { console.error(USAGE); return 2; }
  const path = dbPath();
  if (!existsSync(path)) { console.error(`没有账本：${path}`); return 1; }
  if (action === "status") {
    const db = openExistingDb(path, { readonly: true });
    try {
      const installed = ledgerGuardTriggers(db).length;
      const missing = missingLedgerGuards(db);
      console.log(`ledger guard: ${installed} triggers on ${ledgerGuardedTables(db).length} tables, ${missing.length} missing`);
      for (const name of missing.slice(0, 20)) console.log(`  missing ${name}`);
    } finally {
      db.close();
    }
    return 0;
  }
  if (await daemonReachable()) {
    console.error("daemon 还在运行。先停 daemon（plc daemon stop），再卸守卫：运行中的 daemon 会补装守卫并报警。");
    return 1;
  }
  const db = openExistingDb(path);
  try {
    const dropped = dropLedgerGuards(db);
    console.log(`卸掉了 ${dropped} 个守卫触发器。现在可以部署旧代码。新代码下次打开账本时会重新装上；不想装时，在 daemon 的启动环境里设 PLC_LEDGER_GUARD=off。`);
    if (ledgerGuardDropSql(db)) console.error("还有没卸掉的触发器，请重试。");
  } finally {
    db.close();
  }
  return 0;
}

// 一个单元（或一轮）的调度时间线（lead-scheduler spec D12）。
async function schedTraceCommand(args: string[]): Promise<number> {
  const [id, ...rest] = args;
  if (!id || !SCHED_TRACE_ID.test(id)) {
    console.error(SCHED_TRACE_USAGE);
    return 2;
  }
  const logs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const path = rest[index + 1];
    if (rest[index] !== "--log" || !path) {
      console.error(SCHED_TRACE_USAGE);
      return 2;
    }
    logs.push(resolve(path));
    index += 1;
  }
  const data = dataDir();
  const logPaths = logs.length ? logs
    : [join(data, "logs", "coordinatord.out.log"), join(data, "logs", "coordinatord.err.log"), join(data, "daemon.log")];
  const logLines = await readTraceLogLines(logPaths, id);
  const sessionEntries = await readTraceSessionEntries(join(data, "lead-sessions"));
  let units = unitsOf(id, { logLines, sessionEntries, events: [] });
  let events: EventRecord[] = [];
  if (existsSync(dbPath())) {
    const db = openExistingDb(dbPath(), { readonly: true });
    try {
      if (id.startsWith("turn_")) units = unitsOf(id, { logLines, sessionEntries, events: [] }, schedulerUnitsOfTurn(db, id));
      events = units.flatMap((unit) => schedulerEventsOfUnit(db, unit));
    } finally {
      db.close();
    }
  }
  const entries = schedTrace(id, units, { logLines, sessionEntries, events });
  if (!entries.length) {
    console.error(`没有找到 ${id} 的调度记录（读了 ${logPaths.filter((path) => existsSync(path)).length} 个日志文件、会话文件和账本）。`);
    return 1;
  }
  console.log(`units: ${units.join(", ") || "-"}`);
  for (const line of formatSchedTrace(entries)) console.log(line);
  return 0;
}

// config.json 损坏不该让运维命令（包括 doctor 本身）连带崩溃：退化为纯进程环境变量，
// 真正的诊断由 doctor 的"config.json 可解析"检查项负责。
try {
  loadEnvConfig();
} catch (e: any) {
  console.error(`[config] ${e.message}（本次以进程环境变量继续）`);
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "start": process.exitCode = await start(args.includes("--auto"), args.includes("--force")); break;
    case "stop": process.exitCode = await stop(); break;
    case "install": process.exitCode = await install(); break;
    case "desktop-install": process.exitCode = await desktopInstall(args); break;
    case "login-shell-path": process.exitCode = await loginShellPath(); break;
    case "selfcheck": process.exitCode = selfcheck(); break;
    case "migrate-data-dir": process.exitCode = await migrateDataDir(args); break;
    case "uninstall": await uninstall(); break;
    case "doctor": process.exitCode = await doctor(); break;
    case "lead-model": leadModel(); break;
    case "lead-use": process.exitCode = await leadUse(args[0]); break;
    case "ledger-guard": process.exitCode = await ledgerGuard(args[0]); break;
    case "sched-trace": process.exitCode = await schedTraceCommand(args); break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
} catch (error: any) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}

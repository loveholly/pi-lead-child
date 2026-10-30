// daemon 的运维入口。构建后是 apps/daemon/dist/ops.mjs，plc 按 distDir() 运行它，输出原样转给用户。
// plc 是 daemon 的客户端，只依赖 client、protocol 和 core。下面这些动作要用 daemon 这一侧的包
// （supervisor 的 launchd 和 doctor、lead 的模型配置），所以由 daemon 自己提供：
//   start [--auto] 启动：没有 supervisor 就后台拉起它，再让它拉起 daemon。--auto 是客户端的自动拉起：
//                  用户 plc daemon stop 过、或者维护进行中时，supervisor 拒绝，退出码 3。
//                  显式启动在维护进行中也被拒绝（退出码 3）
//   stop           没有 supervisor 时停 daemon，并在 supervisor-state.json 里记下"用户停的"
//   install        安装 launchd 常驻 supervisor
//   uninstall      卸载 launchd 常驻
//   doctor         只读诊断
//   lead-model     显示 Lead 模型与 provider
//   lead-use SPEC  把 Lead 默认模型写入 config.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  DAEMON_ONLY_ENV_NAMES,
  dataDir, dbPath, distDir, envConfigPath, loadEnvConfig, packageSource, projectRoot, workspaceDir,
} from "@pi-lead-child/core";
import {
  agentStatus, autoStartRefusal, buildsFreshReal, loadSupervisorState, saveSupervisorState, dbProbesReal, distFreshReal, formatChecks, installAgent, keychainSecretExists,
  plistContent, plistPath, resolveDaemonOnlyKey, resolveKeyReal, runDoctor, supervisorAvailable, supervisorListening, supervisorRequest, supervisorSockPath,
  uninstallAgent, uninstallHindsightService, type BuildOutput, type DoctorProbes, type SupervisorStatus,
} from "@pi-lead-child/supervisor";
import {
  loadLeadModelConfig, resolveLeadApiKey, selectedLeadModelSpec, setLeadModelInConfig,
} from "@pi-lead-child/lead";
import { defaultWebRoot } from "@pi-lead-child/gateway";
import type { DaemonLocalStatus, LocalSocketCommand } from "@pi-lead-child/protocol";
import {
  dropLedgerGuards, ledgerGuardedTables, ledgerGuardDropSql, ledgerGuardTriggers, missingLedgerGuards, openExistingDb,
} from "@pi-lead-child/store";

const PROJECT_ROOT = projectRoot();
const USAGE = "usage: ops.mjs start [--auto] | stop | install | uninstall | doctor | lead-model | lead-use <provider/model> | ledger-guard status|uninstall";
// start --auto 被 supervisor 拒绝（plc 的 daemon-link.ts 认这个退出码）。
const AUTO_START_REFUSED = 3;

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

async function waitForSupervisor(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await supervisorAvailable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`supervisor 启动失败，查看日志: ${join(dataDir(), "supervisor.log")}`);
}

async function waitForSupervisorStopped(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await supervisorAvailable())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("旧 Supervisor 未能在安装前完整退出");
}

// daemon 自己的 plc.sock：只用它探活和停机。
const daemonSockPath = () => join(dataDir(), "plc.sock");
function daemonReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(daemonSockPath());
    sock.once("connect", () => { sock.end(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

// plc.sock 的 status（daemon 没在运行时为 null）。只读：doctor 用它看网关对外地址的状态。
function daemonLocalStatus(): Promise<DaemonLocalStatus | null> {
  return new Promise((resolve) => {
    const sock = connect(daemonSockPath());
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

async function shutdownUnsupervisedDaemon(): Promise<void> {
  const sock = connect(daemonSockPath());
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
  if (!(await supervisorAvailable())) {
    // supervisor 在忙（socket 能连上，只是没及时回答）时只等它，不再起第二个（2026-10-15 live）。
    if (!(await supervisorListening())) spawnSupervisorDetached();
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
    }, { timeoutMs: 35_000 });
    if (started?.forcedPastDeployGate?.length) {
      console.error(`已用 --force 越过部署闸门启动，supervisor 日志里有记录：\n- ${started.forcedPastDeployGate.join("\n- ")}`);
    }
  } catch (error: any) {
    // supervisor 拒绝了（自动拉起赶上了 stop 或维护，或者显式启动赶上了维护）：它的回答就是给人看的原因。
    if (error?.code === "auto_start_refused" || error?.code === "maintenance_in_progress") {
      console.error(error.message);
      return AUTO_START_REFUSED;
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
  if (await supervisorAvailable()) {
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

async function install(): Promise<number> {
  const entry = join(distDir(), "supervisor.mjs");
  if (!existsSync(entry)) { console.error("先构建: npm run build"); return 1; }
  const configuredKey = resolveKeyReal(dataDir(), {}, "AM_API_KEY") === "config";
  if (!configuredKey && !keychainSecretExists("AM_API_KEY")) {
    console.error(
      "无法安装：launchd 后台没有可持久读取的 AM_API_KEY。请先运行 "
      + "bash ~/.agents/skills/keychain-secrets/keychain-secrets.sh set AM_API_KEY",
    );
    return 1;
  }
  if ((await agentStatus()) !== null) {
    await uninstallAgent(plistPath());
    await waitForSupervisorStopped();
  }
  if (await supervisorAvailable()) {
    await supervisorRequest({ type: "shutdown" }, { timeoutMs: 35_000 }).catch(() => {});
    await waitForSupervisorStopped();
  } else if (await daemonReachable()) {
    await shutdownUnsupervisedDaemon();
  }
  const logDir = join(dataDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const p = await installAgent(plistPath(), plistContent({
    nodeBin: process.execPath, entry, cwd: PROJECT_ROOT, logDir,
  }));
  await waitForSupervisor(60_000);
  await supervisorRequest({ type: "ensure_running" }, { timeoutMs: 35_000 });
  console.log(`已安装并启动 Supervisor: ${p}\n日志: ${logDir}/supervisor.{out,err}.log`);
  return 0;
}

async function uninstall(): Promise<void> {
  await uninstallAgent(plistPath());
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
    case "uninstall": await uninstall(); break;
    case "doctor": process.exitCode = await doctor(); break;
    case "lead-model": leadModel(); break;
    case "lead-use": process.exitCode = await leadUse(args[0]); break;
    case "ledger-guard": process.exitCode = await ledgerGuard(args[0]); break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
} catch (error: any) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}

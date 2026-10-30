// coordinatord 入口：plc daemon start（或 plc chat 自动拉起）经 tsx 运行本文件。
import { join } from "node:path";
import { dataDir, dbPath, loadEnvConfig, loginShellEnv, mergeLoginShellEnv } from "@pi-lead-child/core";
import { solPiPackage } from "@pi-lead-child/engine";
import { userSkillDirs } from "@pi-lead-child/lead";
import { DaemonAlreadyRunningError, startDaemon } from "./server.js";

const applied = loadEnvConfig();
if (applied.length) console.log(`[config] env keys applied: ${applied.join(", ")}`);

// 用户登录 shell 的 PATH 和工具目录变量（core 的 login-shell.ts）：Lead 的 bash 和 child 都要能调到用户本机的 CLI。
// 在建任何会话、起任何 child 之前补。只记名字，不记值。只在这个入口做：测试里起的 daemon 不读用户的 shell。
const login = loginShellEnv();
if (login) {
  const merged = mergeLoginShellEnv(process.env, login);
  if (merged.length) console.log(`[config] from the login shell: ${merged.join(", ")}`);
} else {
  console.error("[config] could not read the login shell's environment; commands use the daemon's PATH");
}

// 内置的 SoL-Pi（engine 的 extension/sol-pi-package.ts）：pi 的包管理器把它装进 Lead 的 pi agentDir。
// 已经装好时，建 Lead 会话之前就设置好入口；安装和对齐 ref 在 daemon 起来之后在后台做。
// 后台这一步才加载上（第一次装好，或者升级 commit 后对齐好）时，把它加载进正在运行的 Lead，不重启 daemon。
// pi 执行器不用做什么：每个 Run 新起一个 pi 进程，从下一个 Run 起读到 PLC_SOL_PI_ENTRY。
// 只在这个入口做：测试里起的 daemon 不安装，也不加载 SoL-Pi。
const solPi = solPiPackage({ agentDir: join(dataDir(), "agent"), cwd: dataDir() });
await solPi.activate();

try {
  // manageMemory：托管 Hindsight 记忆服务（memory-controller.ts）。它是独立的 launchd 任务，daemon 重启不会重启它；
  // 用户在设置页选了 embedding 之后才启动它。测试里起的 daemon 不托管。
  // channels.live：密钥都有的内置通道来源用真实的传输接上（slack-takeover 工单 02）；缺密钥的不接，plc doctor 说明缺什么。
  // 测试里起的 daemon 不给 live，不会连真实的服务。
  // skillDirs：用户给 agent 装的 skill（~/.agents/skills 这类），Lead 也加载。
  const d = await startDaemon({
    dataDir: dataDir(), dbPath: dbPath(), manageMemory: true, channels: { live: true }, skillDirs: userSkillDirs(),
    relaxConnectionWrites: true,
  });
  void solPi.sync().then((activated) => {
    if (activated) d.reloadLeadExtensions("SoL-Pi installed");
  });
  const stop = () => { void d.close().then(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (e) {
  // launchd KeepAlive={SuccessfulExit:false}：只有非零退出才拉起。已有实例在跑时正常退出，避免 30s 循环重试。
  // 用 instanceof 而非正则匹配 message——message 是人话文案，不该是控制流契约。
  if (e instanceof DaemonAlreadyRunningError) { console.log(e.message); process.exit(0); }
  throw e;
}

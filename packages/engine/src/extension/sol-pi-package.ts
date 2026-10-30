// SoL-Pi 的安装和更新，交给 pi 自己的包管理器（pi install 用的同一套 DefaultPackageManager）。
// 装进 pi-lead-child 自己的 pi agentDir（Lead 的隔离 agentDir），固定在 SOL_PI_SOURCE 的 commit 上。
// 不写进 settings.json：装好的包不会被自动加载，由 sol-pi-lead.ts / sol-pi-executor.ts 按角色加载。
// 只在 daemon 进程里用：执行器子进程只读 PLC_SOL_PI_ENTRY。
import { execFileSync } from "node:child_process";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SOL_PI_ENTRY_ENV, solPiSettings } from "./sol-pi.js";

// 升级：上游合并 pi 1.x 的修复（issue #94）后，把 ref 换成新的 commit，跑 sol-pi 的测试，重启 daemon。
// pi 的包管理器会把已有的 checkout 对齐到新的 ref。那时删掉 sol-pi.ts 里的 correctThenRunFailure。
export const SOL_PI_SOURCE = "git:github.com/NVlabs/SoL-Pi@41fa7e0e230bedc5e639aed2e7b9cc5698726db1";

// 来源必须是固定到完整 commit 的 git 仓库（安全评审 L1）。SoL-Pi 的代码在 daemon 进程里运行，拿得到全部环境变量：
// - tag 和分支会移动，装到的代码可能不是评审过的那一份；
// - npm 包安装时会跑生命周期脚本，同样拿得到 daemon 的全部环境变量。
const SOURCE = /^git:([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)@([0-9a-f]{40})$/;

// PLC_SOL_PI_SOURCE 覆盖固定的来源，例如换到上游一个更新的 commit。
export function solPiSource(env: Record<string, string | undefined> = process.env): string {
  const override = env.PLC_SOL_PI_SOURCE?.trim();
  if (!override) return SOL_PI_SOURCE;
  if (!SOURCE.test(override) || override.split(/[/@]/).includes("..")) {
    throw new Error(`PLC_SOL_PI_SOURCE=${override}: expected git:<host>/<owner>/<repo>@<40-hex commit>`);
  }
  return override;
}

// 来源固定的 commit。
export function solPiPinnedCommit(source: string): string {
  const commit = SOURCE.exec(source)?.[2];
  if (!commit) throw new Error(`${source} is not pinned to a full commit`);
  return commit;
}

// 一个 checkout 的 HEAD。只读本地仓库，不联网；读不到时返回 null。
function gitHead(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export interface SolPiPackageOptions {
  // pi-lead-child 的 pi agentDir。包装在它的 git/ 下。
  agentDir: string;
  // 包管理器的工作目录。只有项目范围的包用到它，这里装的是用户范围。
  cwd: string;
  // 读配置、写 PLC_SOL_PI_ENTRY 的环境。缺省是 daemon 的 process.env：执行器子进程继承它，Lead 也读它。
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  // 测试注入。缺省用 pi 的 DefaultPackageManager。
  packageManager?: Pick<DefaultPackageManager, "install" | "getInstalledPath" | "resolveExtensionSources">;
  // 测试注入。缺省用 git rev-parse HEAD。
  headOf?: (dir: string) => string | null;
}

export interface SolPiPackage {
  // 不联网：已经装好（或者 PLC_SOL_PI_ENTRY 已经设置）时，设置 PLC_SOL_PI_ENTRY，返回 true。
  // daemon 在建 Lead 会话之前调它，Lead 和之后启动的 Run 都用装好的这份。
  activate(): Promise<boolean>;
  // 后台任务：没装时安装，装好后设置 PLC_SOL_PI_ENTRY；已经装好时让 pi 对齐到固定的 ref
  // （ref 没变时 pi 只 fetch，不改文件）。失败（离线、GitHub 不可达）只记一行日志，不抛错。
  // 这一次才加载上（第一次装好，或者升级 commit 后对齐好）时返回 true：daemon 据此把它加载进正在运行的 Lead。
  sync(): Promise<boolean>;
}

// daemon 启动时：先 activate()，再起 daemon，最后在后台 sync()，不阻塞启动。
// 第一次安装发生在 sync() 里：之后启动的 Run 用它，Lead 下次建会话时用它。
// PLC_SOL_PI_ENTRY 已经设置（例如指向本地 checkout）时，两步都不安装、不改它。
export function solPiPackage(opts: SolPiPackageOptions): SolPiPackage {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.error(line));
  const preset = Boolean(env[SOL_PI_ENTRY_ENV]?.trim());
  // 两个角色都关掉时不安装：PLC_SOL_PI=off 加 PLC_LEAD_SOL_PI=off 不该触发联网的 clone。
  const wanted = (["lead", "executor"] as const).some((role) => {
    try {
      return solPiSettings(role, env).features.length > 0;
    } catch {
      return false;
    }
  });
  let source: string | null = null;
  try {
    if (wanted) source = solPiSource(env);
  } catch (error) {
    if (!preset) log(`[sol-pi] ${error instanceof Error ? error.message : String(error)}; SoL-Pi is off`);
  }
  let manager: SolPiPackageOptions["packageManager"] | null = null;
  const packageManager = () => (manager ??= opts.packageManager ?? new DefaultPackageManager({
    cwd: opts.cwd, agentDir: opts.agentDir, settingsManager: SettingsManager.create(opts.cwd, opts.agentDir),
  }));
  // 入口由 pi 的包管理器按包的 manifest 解析，和 pi install 之后 pi 自己加载它的方式一样。
  // 先确认已经装好：没装时解析会触发安装，那要联网，属于 sync()。
  // 再确认 checkout 停在固定的 commit 上（安全评审 M1）：pi 第一次安装时先 git clone（默认分支），
  // 再 git checkout 固定的 commit，是两步。daemon 在两步之间停掉时，留下的 checkout 在默认分支上。
  // 这时不加载它，由 sync() 对齐到固定的 commit，对齐之后再加载。
  const activate = async (): Promise<boolean> => {
    if (preset) return true;
    if (!source) return false;
    const manager = packageManager();
    const dir = manager.getInstalledPath(source, "user");
    if (!dir) return false;
    const pinned = solPiPinnedCommit(source);
    const head = (opts.headOf ?? gitHead)(dir);
    if (head !== pinned) {
      log(`[sol-pi] ${dir} is at ${head ?? "an unknown commit"}, not the pinned ${pinned}; not loading it until sync aligns it`);
      return false;
    }
    try {
      const { extensions } = await manager.resolveExtensionSources([source]);
      const entry = extensions.find((extension) => extension.enabled)?.path;
      if (!entry) throw new Error(`${source} declares no extension`);
      env[SOL_PI_ENTRY_ENV] = entry;
      // 部署时据此确认 daemon 用的是哪一个 commit。
      log(`[sol-pi] active at ${pinned.slice(0, 7)}`);
      return true;
    } catch (error) {
      log(`[sol-pi] ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return {
    activate,
    async sync() {
      if (preset || !source) return false;
      const installed = Boolean(env[SOL_PI_ENTRY_ENV]);
      try {
        await packageManager().install(source);
        if (!installed && await activate()) {
          log(`[sol-pi] installed ${source}`);
          return true;
        }
      } catch (error) {
        log(`[sol-pi] could not ${installed ? "update" : "install"} ${source}: `
          + `${error instanceof Error ? error.message : String(error)}`
          + `${installed ? "; keeping the installed copy" : "; SoL-Pi is off"}`);
      }
      return false;
    },
  };
}

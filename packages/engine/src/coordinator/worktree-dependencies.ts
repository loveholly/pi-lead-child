// 建隔离 worktree 时准备好依赖（lead-tools-and-routing spec D15，#137 第 6 条）。新建的 worktree 没有 node_modules：
// #125 的执行者装不了依赖，类型检查和测试一次都没跑。现在系统在建好 worktree 以后在后台准备依赖（执行者不等它，见下）：
// pnpm 的仓库先用 pnpm 按 lockfile 装（pnpmInstall，2026-10-29）；别的、或者装不上时，把用户 checkout 里的 node_modules
// 按原样克隆过去（macOS 用 APFS 的 clonefile，cp -c；Linux 用 cp --reflink=auto）。
//
// 为什么克隆、不建符号链接：node_modules 里工作区包的链接是相对路径（@pi-lead-child/engine -> ../../packages/engine）。
// 克隆过去以后它们指向 worktree 自己的包；链接到用户 checkout 的 node_modules 则会让测试跑用户 checkout 的代码。
// 另外一个指向目录的符号链接不被 `node_modules/` 这条忽略规则覆盖，曾经被提交进 master（fbb54a7b）。
//
// bun 的仓库（有 bun.lock 或 bun.lockb）同样先用 bun install --frozen-lockfile 装（2026-11-25）：#465 给一个 bun 仓库建
// worktree，克隆 node_modules/.bun 跑了 6 分钟以上还没完，执行者一直在等。bun 有全局缓存，通常快得多；装不上时回到克隆。
//
// 包管理器按锁文件认，做成一张对照表（PACKAGE_MANAGERS，#493）：pnpm-lock.yaml→pnpm；bun.lock / bun.lockb→bun；
// package-lock.json→npm；yarn.lock→yarn。以后加一种包管理器只加一行（锁文件、找可执行文件的办法、安装命令）。
// 表里每一种走同一条路：找得到可执行文件就在根目录装一次（10 分钟超时，都带 --ignore-scripts 或同等的开关，
// 因为 daemon 在沙箱外装），装好就返回、不再克隆；找不到、装失败或超时，就回到克隆，并把原因写进结果的 fallbackReason
// （状态文件和活动记录里能看到），装了一半的 node_modules 先删掉。各自的命令：
//   pnpm  pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
//   bun   bun install --frozen-lockfile --ignore-scripts
//   npm   npm ci --prefer-offline --ignore-scripts --no-audit --no-fund（#473 一次拷 3 份 node_modules 花了约 11 分钟，本机有杀毒软件）。
//         npm workspaces 的单仓只在根目录装一次：npm ci 把依赖提升到根 node_modules，工作区包的链接也由它建，不再对子包克隆。
//   yarn  1（classic）：yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive；
//         2 及以上（berry）：yarn install --immutable，用环境变量 YARN_ENABLE_SCRIPTS=false 关安装脚本。版本看 package.json 的
//         packageManager 字段，没有就看 .yarnrc.yml、yarn.lock 里的 __metadata。berry 默认是 PnP（.yarnrc.yml 里 nodeLinker
//         不是 node-modules 或 pnpm），没有 node_modules 可克隆：装不上时结果的 error 写「PnP 仓库，不能退回拷贝」，不假装成功。
// 仓库自带安装时会运行的 JS 时，daemon 不装（PR #85 评审第 2 条，2026-11-26）：yarn berry 的 yarnPath 和插件（.yarnrc.yml 里有 yarnPath
// 或 plugins，或 packageManager 是 yarn@2 及以上；yarn 1 的 .yarnrc 里有 yarn-path），pnpm 仓库根目录的 .pnpmfile.cjs
// 或 .npmrc 里的 pnpmfile、global-pnpmfile（#509 再评审补）。命中时不运行任何安装命令，也不克隆，
// 状态写成 none: 加原因，提示让执行者在沙箱里自己装。只认这几种，别的情况照旧。
// pnpm 还认 pnpm-workspace.yaml 里的 pnpmfile、globalPnpmfile（pnpm 10 会加载），一样算（PR #85 二次复审，#516）。yarn 1 装依赖时带
// YARN_IGNORE_PATH=1，不读 .yarnrc 的 yarn-path，作兜底。
// 复用的工作区（返工、续接、daemon 重启后，workspace.ts 传 reused）：执行者在沙箱里改过 .npmrc 之类的配置也有可能，
// `git=<脚本>` 加一个 git 依赖，npm ci --ignore-scripts 也会运行那个脚本。所以复用的工作区没有 node_modules 时，daemon 一律不装、
// 不克隆，状态写成 none: 加 reinstallCommand，让执行者在沙箱里自己装。只有新建的工作区（建好时仓库里的配置没被执行者动过）才在沙箱外装。
// 一个仓库有几种锁文件时只选一种：package.json 的 packageManager 字段点名了其中一种就用它，没有就按表里的顺序选；
// 结果的 selectionNote 写明选了哪一种、为什么。找 npm、yarn 的办法见 findBinary 一带：daemon 的 PATH 来自 launchd，
// 常常没有用户装的 node，所以会看 nvm、volta、Homebrew、corepack 等常见位置。
//
// 原生程序（#499）：--ignore-scripts 不跑安装脚本，better-sqlite3 的 .node 文件就没有编出来，测试一开始全部失败。
// daemon 只检查、不补编译（PR #85 评审第 3 条，2026-11-26）：`<包管理器> rebuild <包名>` 会运行那个包 package.json 里的 install 脚本，
// 而 daemon 在沙箱外。node_modules 执行者在沙箱里写得到：复用旧工作区时它已经写过；新建的工作区里执行者不等依赖就开工，
// 装依赖的这段时间里也能写 node_modules/better-sqlite3 和根目录的 npm 配置文件。所以不论新装还是复用，daemon 都不跑 rebuild，
// 也不跑别的会执行 node_modules 里脚本的命令。
// 装好、或发现旧工作区缺原生程序时，只看 NATIVE_PACKAGES 这张表里「装了、但缺原生程序」的包：结果的 rebuildError 写缺了什么，
// rebuildCommand 写要在沙箱里跑的命令（npm、pnpm：`<包管理器> rebuild <包名>`；bun、yarn 没有 rebuild 命令，没有这条命令，只写缺了什么）。
// 状态文件和给执行者的提示（children/manager.ts）都带这条命令。缺原生程序不算依赖没准备好：node_modules 留着，状态仍是 ready:。
// 表里只放「原生程序只靠安装脚本产生」的包；esbuild、fsevents、unrs-resolver 的程序来自可选依赖包，不需要。要加一个包，加一行。
// 另一个同时发现的现象（缺 @anthropic-ai/claude-agent-sdk）不是安装的问题：依赖是按 worktree 的起点（origin 的默认分支）的锁文件装的，
// 执行者后来合并了别的分支、锁文件变了，node_modules 就旧了。提示里告诉执行者：锁文件变了要重新装（见 children/manager.ts）。
//
// 执行者不等依赖（2026-11-25）：建好 worktree 就启动，依赖在后台准备。准备做完时写一个状态文件（worktree 的 git 目录里，
// 不在工作区里，不会进提交），提示里给执行者一条等它的命令；准备还在做时也可以查 peekWorktreeDependencies。
// 同一时间只有 daemon 写 node_modules：准备没做完时，等待命令让执行者再等，不让它自己装（见 children/manager.ts）。
// 写不了状态文件时执行者会一直看到 waiting，等够轮数后报阻塞，不会自己去装。
//
// 克隆在后台异步做：大仓库在本机要几分钟（有 Sophos 时更久），同步做会卡住 daemon（2026-10-14 的停摆）。
// 只克隆 git 忽略的 node_modules；克隆失败不影响 Run，执行者可以在沙箱里自己装。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { removeTree } from "@pi-lead-child/core";

export interface DependencyPreparation {
  // 克隆过去的 node_modules（相对仓库根目录）。
  cloned: string[];
  // 没有做的原因（不是 Node 项目、已经有依赖、这个系统不支持写时复制……）。做了时为 null。
  skipped: string | null;
  // 出错时的原因。
  error: string | null;
  // 用包管理器装的（例如 pnpm install），没有克隆时写明。克隆的为 undefined。
  installedWith?: string;
  // 先试了包管理器、没成功才回到克隆（或没有可克隆的）时，写明为什么没成功。每种包管理器装不上时都会写。
  fallbackReason?: string;
  // 仓库有几种锁文件时，写明选了哪一种包管理器、为什么。只有一种锁文件时为 undefined。
  selectionNote?: string;
  // 装好了、但缺原生程序（NATIVE_PACKAGES）时的说明：缺了哪些包，为什么 daemon 没有补。依赖本身仍算装好了。没有缺时为 undefined。
  rebuildError?: string;
  // 执行者要在沙箱里跑的补编译命令（例如 `npm rebuild better-sqlite3`）。包管理器没有 rebuild 命令、或认不出包管理器时为 undefined。
  rebuildCommand?: string;
  // 复用的工作区没有 node_modules、daemon 不装时（REUSED_WORKTREE_NOT_INSTALLED），执行者要在沙箱里跑的完整安装命令。认不出包管理器时为 undefined。
  reinstallCommand?: string;
}

const pending = new Map<string, Promise<DependencyPreparation>>();
// 已经做完的准备结果（同一个 daemon 进程里）。提示要写依赖现在是什么状态时查它。
const settled = new Map<string, DependencyPreparation>();

/** 状态文件的名字：放在 worktree 的 git 目录里，执行者用 `git rev-parse --git-path` 找到它。 */
export const DEPENDENCY_STATUS_FILE = "plc-deps-status";

// 不往下找的目录：依赖本身、git 的数据、plc 的 worktree 目录。
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-sessions", "dist", "build", ".next", ".turbo", ".cache"]);

/**
 * 仓库里的 node_modules 目录（相对 root），最多往下找 maxDepth 层。异步读目录：用户的 checkout 目录很多时，
 * 以前同步遍历会占住 daemon 的主线程（2026-11-03）。
 */
export async function findNodeModulesDirs(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        found.push(relative(root, path));
        continue;
      }
      if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || entry.name.endsWith(".plc-workspaces")) continue;
      await walk(path, depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort();
}

function run(
  command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output: output.slice(-2_000), timedOut });
    });
  });
}

function cloneArgs(source: string, target: string): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "cp", args: ["-cR", source, target] };
  if (process.platform === "linux") return { command: "cp", args: ["-R", "--reflink=auto", source, target] };
  return null;
}

// 装了一半的 node_modules 要删掉，不然克隆会因为目标已存在而跳过它们。只删 git 忽略的：装出来的 node_modules 是忽略的，别的东西不碰。
async function removeInstalledNodeModules(worktree: string): Promise<void> {
  for (const dir of await findNodeModulesDirs(worktree)) {
    const ignored = await run("git", ["-C", worktree, "check-ignore", "-q", dir], worktree, 30_000);
    // 在子进程里删（core 的 removeTree），不在 daemon 的线程池里删整棵 node_modules（lead-scheduler spec P0）。
    // 克隆在等这次删除，用 utility 优先级。
    if (ignored.code === 0) {
      await removeTree(resolve(worktree, dir), { kind: "node-modules-delete", label: dir, priority: "utility" });
    }
  }
}

// 系统里装 npm、yarn 的固定位置：Homebrew（Apple 芯片、Intel）。测试可以换掉它，免得测到本机真装的包管理器。
const DEFAULT_SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
let systemBinDirs = DEFAULT_SYSTEM_BIN_DIRS;

/** 测试用：换掉固定的目录（不传就恢复）。 */
export function setSystemBinDirsForTests(dirs?: string[]): void {
  systemBinDirs = dirs ?? DEFAULT_SYSTEM_BIN_DIRS;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(":").filter(Boolean);
}

function versionParts(name: string): number[] {
  return name.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

// nvm 装的 node 版本目录，新的在前。
function nvmNodeBinDirs(env: NodeJS.ProcessEnv): string[] {
  const root = env.NVM_DIR ?? (env.HOME ? join(env.HOME, ".nvm") : null);
  if (!root) return [];
  try {
    return readdirSync(join(root, "versions", "node"))
      .sort((a, b) => {
        const [pa, pb] = [versionParts(a), versionParts(b)];
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
        }
        return 0;
      })
      .map((version) => join(root, "versions", "node", version, "bin"));
  } catch {
    return [];
  }
}

// node 工具（npm、yarn、corepack）常见的目录：当前 nvm 的 NVM_BIN、nvm 装的各版本、volta、Homebrew。
function nodeToolDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.NVM_BIN ? [env.NVM_BIN] : []),
    ...nvmNodeBinDirs(env),
    ...(env.VOLTA_HOME ? [join(env.VOLTA_HOME, "bin")] : env.HOME ? [join(env.HOME, ".volta", "bin")] : []),
    ...systemBinDirs,
  ];
}

function findIn(dirs: Array<string | undefined>, name: string): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// 可执行文件：command 加上放在安装参数前面的 prefix（corepack 的 yarn 是 `corepack yarn ...`）。
interface Binary { command: string; prefix: string[] }

// 一次安装：参数、额外的环境变量、写进 installedWith 的完整命令、出错信息里叫它的名字。
interface InstallPlan { args: string[]; env?: Record<string, string>; installedWith: string; label: string }

interface PackageManager {
  name: string;
  // 这种包管理器的锁文件（相对仓库根目录）。有其中任何一个就算用这种。
  lockfiles: string[];
  // 找不到可执行文件时，写进原因里的「找过哪里」。
  searched: string;
  // npm、yarn 是 `#!/usr/bin/env node` 的脚本：daemon 的 PATH 里没有 node 时跑不起来，所以把它所在的目录放到 PATH 最前面
  // （nvm、volta、Homebrew 里 node 和它们在同一个目录；~/.yarn/bin 这类没有 node 的目录，见 nodeDirsFor，会再加一个有 node 的目录）。
  needsNodeOnPath?: boolean;
  binary(worktree: string, env: NodeJS.ProcessEnv): Binary | null;
  plan(worktree: string): InstallPlan;
  // 只为点名的包跑安装脚本的命令（原生包补编译）。没有这种命令的包管理器不写。
  rebuildArgs?(packages: string[]): string[];
  // 装不上时不能退回克隆的原因（yarn 的 PnP 仓库没有 node_modules 可克隆）；能克隆时为 null。
  noCopyFallback?(worktree: string): string | null;
  // 这个仓库自带会在安装时运行的 JS（berry 的 yarnPath 和插件、pnpm 的 .pnpmfile.cjs）：daemon 在沙箱外装，不运行它们。
  // 返回跳过的原因（daemon 不装、也不克隆，让执行者在沙箱里自己装）；没有这类文件时为 null。PR #85 评审第 2 条（2026-11-26）。
  skipInstall?(worktree: string): string | null;
}

function readPackageJson(worktree: string): { packageManager?: unknown } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as { packageManager?: unknown }) : {};
  } catch {
    return {};
  }
}

// package.json 的 packageManager 字段（例如 "yarn@4.1.0+sha224.abc"）：名字和版本。没写或格式不对时为 null。
function declaredPackageManager(worktree: string): { name: string; version: string } | null {
  const field = readPackageJson(worktree).packageManager;
  if (typeof field !== "string") return null;
  const match = /^([a-z]+)@([^\s+]+)/.exec(field.trim());
  return match ? { name: match[1]!, version: match[2]! } : null;
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// yarn 1 还是 2 及以上（berry）：先看 packageManager 字段；没有就看 .yarnrc.yml（只有 berry 用它），再看 yarn.lock 里的 __metadata（berry 的格式）。
function isYarnBerry(worktree: string): boolean {
  const declared = declaredPackageManager(worktree);
  if (declared?.name === "yarn") return versionParts(declared.version)[0]! >= 2;
  if (existsSync(join(worktree, ".yarnrc.yml"))) return true;
  return /^__metadata:/m.test(readFileOrEmpty(join(worktree, "yarn.lock")));
}

// berry 开着 PnP 时没有 node_modules：.yarnrc.yml 里 nodeLinker 不是 node-modules（pnpm 的链接方式也有 node_modules）；没写就是默认的 PnP。
function isYarnPnp(worktree: string): boolean {
  const linker = /^nodeLinker:\s*["']?([\w-]+)["']?\s*(?:#.*)?$/m.exec(readFileOrEmpty(join(worktree, ".yarnrc.yml")))?.[1];
  return linker !== "node-modules" && linker !== "pnpm";
}

// 为什么 daemon 不装：yarn berry 的 yarnPath 指向仓库里的 JS，插件也是仓库里的 JS，yarn install 会运行它们。
// 只认这几种（.yarnrc.yml 顶层的 yarnPath、plugins，package.json 的 packageManager 是 yarn@2 及以上，yarn 1 的 .yarnrc 里的 yarn-path），别的情况保持原样。
function yarnBerrySkipReason(worktree: string): string | null {
  const declared = declaredPackageManager(worktree);
  const yarnrc = readFileOrEmpty(join(worktree, ".yarnrc.yml"));
  const key = /^(yarnPath|plugins)\s*:/m.exec(yarnrc)?.[1];
  const found = key
    ? `.yarnrc.yml 里有 ${key}`
    : declared?.name === "yarn" && versionParts(declared.version)[0]! >= 2 ? `package.json 的 packageManager 是 yarn@${declared.version}` : null;
  if (found) return `yarn berry 仓库（${found}），安装时会运行仓库自带的 JS：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖`;
  // yarn 1（classic）：.yarnrc 里的 yarn-path 指向仓库里的 JS，yarn 一启动就运行它（PR #85 再评审，#509）。
  const classicKey = /^(yarn-path|yarnPath)\s/m.exec(readFileOrEmpty(join(worktree, ".yarnrc")))?.[1];
  return classicKey ? `yarn 仓库（.yarnrc 里有 ${classicKey}），yarn 会运行仓库自带的 JS：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖` : null;
}

// pnpmfile 默认是根目录的 .pnpmfile.cjs；.npmrc 里的 pnpmfile、global-pnpmfile 可以把它指到别处（PR #85 再评审，#509）。
// pnpm 10 还会读 pnpm-workspace.yaml 里的 pnpmfile、globalPnpmfile（也认 global-pnpmfile），一样要拦（PR #85 二次复审，#516）。
function pnpmfileSkipReason(worktree: string): string | null {
  const custom = /^\s*(pnpmfile|global-pnpmfile)\s*=/m.exec(readFileOrEmpty(join(worktree, ".npmrc")))?.[1];
  if (custom) return `仓库的 .npmrc 设了 ${custom}，pnpm install 会运行它指向的 JS：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖`;
  const inWorkspaceYaml = /^\s*["']?(pnpmfile|globalPnpmfile|global-pnpmfile)["']?\s*:/m.exec(readFileOrEmpty(join(worktree, "pnpm-workspace.yaml")))?.[1];
  if (inWorkspaceYaml) return `仓库的 pnpm-workspace.yaml 设了 ${inWorkspaceYaml}，pnpm install 会运行它指向的 JS：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖`;
  return existsSync(join(worktree, ".pnpmfile.cjs"))
    ? "仓库有 .pnpmfile.cjs，pnpm install 会运行它：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖"
    : null;
}

function yarnBinary(worktree: string, env: NodeJS.ProcessEnv): Binary | null {
  const dirs = [
    ...pathDirs(env), env.HOME ? join(env.HOME, ".yarn", "bin") : undefined,
    env.HOME ? join(env.HOME, ".config", "yarn", "global", "node_modules", ".bin") : undefined, ...nodeToolDirs(env),
  ];
  const yarn = findIn(dirs, "yarn");
  if (yarn) return { command: yarn, prefix: [] };
  // 没有直接装的 yarn：package.json 的 packageManager 点名了 yarn 时，让 corepack 按这个版本取（corepack 随 node 装，没 `corepack enable` 就没有 yarn 命令）。
  if (declaredPackageManager(worktree)?.name !== "yarn") return null;
  const corepack = findIn(dirs, "corepack");
  return corepack ? { command: corepack, prefix: ["yarn"] } : null;
}

// 这张表的顺序也是仓库有几种锁文件、又没写 packageManager 时的选择顺序。pnpm、bun 的命令和找法原样搬来，没有改。
const PACKAGE_MANAGERS: PackageManager[] = [
  {
    // pnpm 的仓库先用 pnpm 装（2026-10-29）：一个大的前端仓库 的 node_modules 有十几万个文件，开着 Sophos 克隆了 19 分钟，
    // Run #185 一直停在启动前，被当成卡死停掉；克隆来的还是用户 checkout 那个分支的依赖，执行者又自己装了一遍。
    // pnpm 按 lockfile 从本机的仓库硬链接，通常一两分钟。daemon 在沙箱外装，能写 pnpm 的仓库、能用 .npmrc 的凭证。
    // --ignore-scripts：依赖的安装脚本不在沙箱外跑；要跑时执行者在沙箱里 pnpm rebuild。daemon 的 PATH 常常没有用户装的 pnpm（~/Library/pnpm）。
    name: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    searched: "daemon 的 PATH、PNPM_HOME、~/Library/pnpm 里都没有",
    binary: (_worktree, env) => {
      const pnpm = findIn([env.PNPM_HOME, env.HOME ? join(env.HOME, "Library", "pnpm") : undefined, ...pathDirs(env)], "pnpm");
      return pnpm ? { command: pnpm, prefix: [] } : null;
    },
    plan: () => ({
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--reporter=silent"],
      installedWith: "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts", label: "pnpm install",
    }),
    skipInstall: pnpmfileSkipReason,
    rebuildArgs: (packages) => ["rebuild", ...packages],
  },
  {
    // bun 的仓库用 bun 装（2026-11-25）：#465 给一个 bun 仓库建 worktree，克隆 node_modules/.bun 跑了 6 分钟以上还没完。
    // daemon 的 PATH 常常没有用户装的 bun（~/.bun/bin）。
    name: "bun",
    lockfiles: ["bun.lock", "bun.lockb"],
    searched: "daemon 的 PATH、BUN_INSTALL、~/.bun/bin 里都没有",
    binary: (_worktree, env) => {
      const bun = findIn([env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin") : undefined, env.HOME ? join(env.HOME, ".bun", "bin") : undefined, ...pathDirs(env)], "bun");
      return bun ? { command: bun, prefix: [] } : null;
    },
    plan: () => ({
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
      installedWith: "bun install --frozen-lockfile --ignore-scripts", label: "bun install",
    }),
  },
  {
    name: "npm",
    lockfiles: ["package-lock.json"],
    searched: "daemon 的 PATH 里没有，nvm、volta、Homebrew 的常见位置也没有",
    needsNodeOnPath: true,
    binary: (_worktree, env) => {
      const npm = findIn([...pathDirs(env), ...nodeToolDirs(env)], "npm");
      return npm ? { command: npm, prefix: [] } : null;
    },
    plan: () => ({
      args: ["ci", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund", label: "npm ci",
    }),
    rebuildArgs: (packages) => ["rebuild", ...packages],
  },
  {
    name: "yarn",
    lockfiles: ["yarn.lock"],
    searched: "daemon 的 PATH、~/.yarn/bin、nvm、volta、Homebrew 的常见位置里都没有，也没有可用的 corepack",
    needsNodeOnPath: true,
    binary: yarnBinary,
    plan: (worktree): InstallPlan => isYarnBerry(worktree)
      ? { args: ["install", "--immutable"], env: { YARN_ENABLE_SCRIPTS: "false" }, installedWith: "YARN_ENABLE_SCRIPTS=false yarn install --immutable", label: "yarn install（berry）" }
      : {
        // YARN_IGNORE_PATH=1：yarn 1 不去读 .yarnrc 的 yarn-path，不运行它指向的仓库里的 JS（skipInstall 只认已知写法，这是兜底；PR #85 二次复审，#516）。
        args: ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--non-interactive"], env: { YARN_IGNORE_PATH: "1" },
        installedWith: "YARN_IGNORE_PATH=1 yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive", label: "yarn install（classic）",
      },
    noCopyFallback: (worktree) => (isYarnBerry(worktree) && isYarnPnp(worktree) ? "PnP 仓库，不能退回拷贝" : null),
    skipInstall: yarnBerrySkipReason,
  },
];

/**
 * 按锁文件选这个仓库的包管理器。没有锁文件时返回 null（这个仓库不用包管理器装，直接克隆）。
 * 只有一种锁文件时就是它；有几种时，package.json 的 packageManager 字段点名了其中一种就用它，没有就按表里的顺序，note 里写明为什么。
 */
function selectPackageManager(worktree: string): { manager: PackageManager; note?: string } | null {
  const present = PACKAGE_MANAGERS.filter((manager) => manager.lockfiles.some((file) => existsSync(join(worktree, file))));
  const [first] = present;
  if (!first) return null;
  if (present.length === 1) return { manager: first };
  const found = present.map((manager) => manager.name).join("、");
  const declared = declaredPackageManager(worktree);
  const named = declared ? present.find((manager) => manager.name === declared.name) : undefined;
  if (named) return { manager: named, note: `有几种锁文件（${found}），package.json 的 packageManager 字段写的是 ${declared!.name}，选了 ${named.name}` };
  const order = PACKAGE_MANAGERS.map((manager) => manager.name).join("、");
  const why = declared
    ? `packageManager 字段写的是 ${declared.name}，但它的锁文件不在其中`
    : "package.json 没有 packageManager 字段";
  return { manager: first, note: `有几种锁文件（${found}），${why}，按固定顺序（${order}）选了 ${first.name}` };
}

// prepare 在工作区已经有 node_modules 时的 skipped 原文；状态文件按它认出「依赖早就在」。
export const EXISTING_NODE_MODULES = "worktree 里已经有 node_modules";

// 原因写进一行状态文件，所以压成一行、截短。
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `...${flat.slice(-max)}` : flat;
}

// 放到 PATH 最前面的目录：可执行文件所在的目录；那里没有 node（~/.yarn/bin、~/.config/yarn/global/node_modules/.bin 就是这样）时，
// 再加一个有 node 的目录（nvm、volta、Homebrew），不然 `#!/usr/bin/env node` 的脚本启动不了。
function nodeDirsFor(binary: Binary, env: NodeJS.ProcessEnv): string[] {
  const own = dirname(binary.command);
  if (existsSync(join(own, "node"))) return [own];
  const nodeDir = findIn(nodeToolDirs(env), "node");
  return nodeDir ? [own, dirname(nodeDir)] : [own];
}

/**
 * 用选中的包管理器装一次依赖（根目录）。{ installed }：装好了；{ fallback }：没成功，附原因，调用方回到克隆。
 * 装不上时先删掉装了一半的 node_modules。
 */
async function installWith(manager: PackageManager, worktree: string): Promise<{ installed: DependencyPreparation } | { fallback: string }> {
  const binary = manager.binary(worktree, process.env);
  if (!binary) return { fallback: `找不到 ${manager.name}（${manager.searched}）` };
  const plan = manager.plan(worktree);
  const timeoutMs = 10 * 60_000;
  const env = {
    ...process.env,
    ...(manager.needsNodeOnPath ? { PATH: [...nodeDirsFor(binary, process.env), process.env.PATH].filter(Boolean).join(":") } : {}),
    ...plan.env,
  };
  const result = await run(binary.command, [...binary.prefix, ...plan.args], worktree, timeoutMs, env);
  if (result.code === 0) return { installed: { cloned: [], skipped: null, error: null, installedWith: plan.installedWith } };
  await removeInstalledNodeModules(worktree);
  if (result.timedOut) return { fallback: `${plan.label} 超过 ${timeoutMs / 60_000} 分钟，已停掉` };
  return { fallback: `${plan.label} 失败：${oneLine(result.output) || `退出码 ${result.code}`}` };
}

// 装好以后需要补编译的原生包（#499）：原生程序只靠安装脚本产生的包。built 是它的原生程序（相对包目录）。
const NATIVE_PACKAGES = [{ name: "better-sqlite3", built: join("build", "Release", "better_sqlite3.node") }];

// 装了、但缺原生程序的包。根和工作区包的 node_modules 都看（pnpm 把直接依赖链接在用到它的那个包里）。
async function missingNativePackages(worktree: string): Promise<string[]> {
  const dirs = await findNodeModulesDirs(worktree);
  return NATIVE_PACKAGES
    .filter(({ name, built }) => dirs.some((dir) => existsSync(join(worktree, dir, name, "package.json")) && !existsSync(join(worktree, dir, name, built))))
    .map(({ name }) => name);
}

/**
 * 为缺原生程序的包写说明，不运行任何命令（PR #85 评审第 3 条）：rebuild 会跑 node_modules 里那个包的 install 脚本，
 * 而 node_modules 执行者在沙箱里写得到。没有缺的返回 {}；缺了返回 rebuildError，包管理器有 rebuild 命令时再加 rebuildCommand。
 */
async function reportMissingNativePackages(manager: PackageManager, worktree: string): Promise<Pick<DependencyPreparation, "rebuildError" | "rebuildCommand">> {
  const missing = await missingNativePackages(worktree);
  if (!missing.length) return {};
  const names = missing.join("、");
  if (!manager.rebuildArgs) return { rebuildError: `${names} 缺原生程序，${manager.name} 没有补编译的命令，在沙箱里自己补` };
  return {
    rebuildError: `${names} 缺原生程序，系统不在沙箱外补编译，在沙箱里补`,
    rebuildCommand: `${manager.name} ${manager.rebuildArgs(missing).join(" ")}`,
  };
}

/**
 * 执行者自己重装依赖时用的一条完整命令（#502）：按锁文件认出包管理器，按锁文件装、不跑安装脚本，
 * 再为这个仓库用到的原生包（NATIVE_PACKAGES）补编译。写进执行者的提示，免得它只照 `npm ci --ignore-scripts` 装完、
 * 忘了补 better-sqlite3，测试一开始全部失败。认不出包管理器（没有锁文件）时返回 null；
 * 包管理器没有 rebuild 命令（bun、yarn）时只有安装的那一半。
 */
export function reinstallCommand(worktree: string): string | null {
  const selected = selectPackageManager(worktree);
  if (!selected) return null;
  const { manager } = selected;
  const install = manager.plan(worktree).installedWith;
  if (!manager.rebuildArgs) return install;
  // 这个仓库用到哪些原生包：锁文件里写了它，或者 node_modules 里装着它。
  const lockfile = manager.lockfiles.map((file) => readFileOrEmpty(join(worktree, file))).join("\n");
  const used = NATIVE_PACKAGES
    .filter(({ name }) => lockfile.includes(name) || existsSync(join(worktree, "node_modules", name, "package.json")))
    .map(({ name }) => name);
  return used.length ? `${install} && ${manager.name} ${manager.rebuildArgs(used).join(" ")}` : install;
}

// 已经有 node_modules 的工作区（#502）：#499 之前建的工作区是 npm ci --ignore-scripts 装的，better-sqlite3 没有原生程序。
// 不重装，也不补编译：node_modules 可能被执行者在沙箱里写过，补编译会在沙箱外跑里面的 install 脚本（PR #85 评审第 3 条）。
// 缺原生程序时只按锁文件认出包管理器，把沙箱里要跑的命令写进结果（派发时按需检查，不去批量改旧工作区）。
// 判断「加载不了」用的是和新装之后同一个办法：包在、build/Release 里的 .node 文件不在。
async function prepareExisting(worktree: string): Promise<DependencyPreparation> {
  const base: DependencyPreparation = { cloned: [], skipped: EXISTING_NODE_MODULES, error: null };
  const missing = await missingNativePackages(worktree);
  if (!missing.length) return base;
  const selected = selectPackageManager(worktree);
  if (!selected) return { ...base, rebuildError: `${missing.join("、")} 缺原生程序，但仓库没有锁文件，认不出包管理器，在沙箱里自己补` };
  return { ...base, ...(await reportMissingNativePackages(selected.manager, worktree)) };
}

// 复用的工作区（返工、续接、daemon 重启后）没有 node_modules 时的 skipped 原文：daemon 不装。
// 执行者在沙箱里能改 .npmrc、.yarnrc 这类配置，`git=<脚本>` 加一个 git 依赖，npm ci --ignore-scripts 也会运行那个脚本
// （PR #85 二次复审，#516）。所以复用的工作区一律不在沙箱外装、也不克隆，让执行者在沙箱里自己装。
export const REUSED_WORKTREE_NOT_INSTALLED = "复用的工作区没有 node_modules，它的配置文件（.npmrc 等）可能被执行者改过：daemon 不在沙箱外装，请执行者在沙箱里自己装依赖";

async function prepare(source: string, worktree: string, reused: boolean): Promise<DependencyPreparation> {
  if (!existsSync(join(worktree, "package.json"))) return { cloned: [], skipped: "不是 Node 项目（没有 package.json）", error: null };
  if (existsSync(join(worktree, "node_modules"))) return prepareExisting(worktree);
  if (reused) {
    const command = reinstallCommand(worktree);
    return { cloned: [], skipped: REUSED_WORKTREE_NOT_INSTALLED, error: null, ...(command ? { reinstallCommand: command } : {}) };
  }
  const selected = selectPackageManager(worktree);
  const note = selected?.note ? { selectionNote: selected.note } : {};
  let because = {};
  if (selected) {
    // 仓库自带安装时运行的 JS：什么都不运行，状态写成跳过。克隆也不做，执行者在沙箱里装。
    const skipReason = selected.manager.skipInstall?.(worktree);
    if (skipReason) return { cloned: [], skipped: skipReason, error: null, ...note };
    const attempt = await installWith(selected.manager, worktree);
    if ("installed" in attempt) return { ...attempt.installed, ...(await reportMissingNativePackages(selected.manager, worktree)), ...note };
    // 没有 node_modules 可克隆的仓库（yarn 的 PnP），退回拷贝没有意义：把失败如实写在 error 里，不假装成功。
    const noCopy = selected.manager.noCopyFallback?.(worktree);
    if (noCopy) return { cloned: [], skipped: null, error: `${noCopy}：${attempt.fallback}`, fallbackReason: attempt.fallback, ...note };
    because = { fallbackReason: attempt.fallback };
  }
  because = { ...because, ...note };
  const dirs = (await findNodeModulesDirs(source)).filter((dir) => existsSync(join(worktree, dirname(dir), "package.json")));
  if (!dirs.length) return { cloned: [], skipped: "用户的 checkout 里没有装好的依赖", error: null, ...because };
  const cloned: string[] = [];
  for (const dir of dirs) {
    const target = join(worktree, dir);
    if (existsSync(target)) continue;
    // 只克隆 git 忽略的路径：克隆出来的东西不能进提交。
    const ignored = await run("git", ["-C", worktree, "check-ignore", "-q", dir], worktree, 30_000);
    if (ignored.code !== 0) continue;
    const clone = cloneArgs(join(source, dir), target);
    if (!clone) return { cloned, skipped: `这个系统（${process.platform}）不支持写时复制的克隆`, error: null, ...because };
    const result = await run(clone.command, clone.args, worktree, 20 * 60_000);
    if (result.code !== 0) return { cloned, skipped: null, error: `克隆 ${dir} 失败：${result.output.trim() || `退出码 ${result.code}`}`, ...because };
    cloned.push(dir);
  }
  return { cloned, skipped: null, error: null, ...because };
}

function statusLine(result: DependencyPreparation): string {
  const because = result.fallbackReason ? ` (installing with the package manager did not work: ${oneLine(result.fallbackReason)})` : "";
  const chosen = result.selectionNote ? ` (${oneLine(result.selectionNote)})` : "";
  if (result.error) return `failed: ${result.error}${chosen}`;
  // 缺原生程序：写明缺了什么和沙箱里要跑的命令（daemon 自己不补，见文件开头）。
  const native = result.rebuildError
    ? ` (native packages not built: ${oneLine(result.rebuildError)}${result.rebuildCommand ? `; run \`${result.rebuildCommand}\` in the sandbox before you run tests` : ""})`
    : "";
  if (result.installedWith) return `ready: installed with ${result.installedWith}${native}${chosen}`;
  // 工作区里早就有 node_modules：依赖是好的，不要写成 none:（提示会让执行者自己重装一遍）。
  if (!result.cloned.length && result.skipped === EXISTING_NODE_MODULES) return `ready: node_modules was already in the worktree${native}${chosen}`;
  if (result.cloned.length) return `ready: cloned ${result.cloned.join(", ")} from the user's checkout${because}${chosen}`;
  const reinstall = result.reinstallCommand ? ` (install them yourself in the sandbox with \`${result.reinstallCommand}\`)` : "";
  return `none: ${result.skipped ?? "nothing to prepare"}${because}${chosen}${reinstall}`;
}

// 准备做完时写状态文件；开始时先删掉旧的（同一个 worktree 再准备一次时，不能让执行者读到上一次的结果）。
async function statusFilePath(worktree: string): Promise<string | null> {
  const dir = await run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], worktree, 30_000);
  return dir.code === 0 && dir.output.trim() ? join(dir.output.trim(), DEPENDENCY_STATUS_FILE) : null;
}

/**
 * 在后台开始准备一个 worktree 的依赖（source 是用户的 checkout）。同一个 worktree 只做一次。
 * onDone 在做完时调用（记活动、打日志），它出错不影响结果。
 * options.reused：这是复用的工作区（执行者可能已经在里面改过配置文件），没有 node_modules 时不装、不克隆，见 REUSED_WORKTREE_NOT_INSTALLED。
 */
export function startWorktreeDependencies(
  source: string, worktree: string, onDone?: (result: DependencyPreparation, info: { durationMs: number }) => void,
  options: { reused?: boolean } = {},
): Promise<DependencyPreparation> {
  const key = resolve(worktree);
  const existing = pending.get(key);
  if (existing) return existing;
  settled.delete(key);
  const startedAt = Date.now();
  const statusPath = statusFilePath(key);
  const promise = statusPath
    .then((path) => (path ? rm(path, { force: true }) : undefined))
    .catch(() => undefined)
    .then(() => prepare(resolve(source), key, options.reused === true))
    .catch((error: unknown): DependencyPreparation => ({
      cloned: [], skipped: null, error: error instanceof Error ? error.message : String(error),
    }))
    .then(async (result) => {
      settled.set(key, result);
      try {
        const path = await statusPath;
        if (path) await writeFile(path, `${statusLine(result)}\n`);
      } catch {
        // 写不了状态文件时，执行者的等待命令一直输出 waiting，等够轮数后报阻塞（不会自己去装，免得和这里同时写）。
      }
      try {
        onDone?.(result, { durationMs: Date.now() - startedAt });
      } catch {
        // 记录失败不影响依赖本身。
      }
      return result;
    });
  pending.set(key, promise);
  return promise;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type WorktreeDependencyState =
  | { state: "preparing" }
  | { state: "done"; result: DependencyPreparation };

/**
 * worktree 的状态文件里记着的那一行（同步读）。daemon 重启后内存里没有准备记录，用它告诉执行者上一次准备的结果。
 * 没有状态文件（没准备过、或这次还没做完）、不是 worktree 时返回 null。
 */
export function readDependencyStatus(worktree: string): string | null {
  try {
    const dotGit = join(resolve(worktree), ".git");
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = resolve(dirname(dotGit), pointer);
    }
    const line = readFileSync(join(gitDir, DEPENDENCY_STATUS_FILE), "utf8").split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** 工作目录所在 worktree 的依赖现在是什么状态（不等）。这个 daemon 没有准备过它时返回 null。 */
export function peekWorktreeDependencies(workdir: string): WorktreeDependencyState | null {
  const target = resolve(workdir);
  for (const [worktree] of pending) {
    if (!within(target, worktree)) continue;
    const result = settled.get(worktree);
    return result ? { state: "done", result } : { state: "preparing" };
  }
  return null;
}

/**
 * 等工作目录所在 worktree 的依赖准备完（工作目录可以是 worktree 里的子目录）。执行者启动不再用它（2026-11-25，见文件开头）；
 * 要等结果的调用方和测试用。没有在准备的时返回 null。等太久（timeoutMs）时返回 null。
 */
export async function awaitWorktreeDependencies(workdir: string, timeoutMs = 20 * 60_000): Promise<DependencyPreparation | null> {
  const target = resolve(workdir);
  for (const [worktree, promise] of pending) {
    if (!within(target, worktree)) continue;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), timeoutMs); });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}

/** 测试用：忘掉记下的准备。 */
export function forgetWorktreeDependenciesForTests(): void {
  pending.clear();
  settled.clear();
}

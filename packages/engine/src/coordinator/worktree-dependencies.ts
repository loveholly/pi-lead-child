// 建隔离 worktree 时准备好依赖（lead-tools-and-routing spec D15，#137 第 6 条）。新建的 worktree 没有 node_modules：
// #125 的执行者装不了依赖，类型检查和测试一次都没跑。现在系统在建好 worktree 以后准备依赖，执行者启动前等它做完：
// pnpm 的仓库先用 pnpm 按 lockfile 装（pnpmInstall，2026-10-29）；别的、或者装不上时，把用户 checkout 里的 node_modules
// 按原样克隆过去（macOS 用 APFS 的 clonefile，cp -c；Linux 用 cp --reflink=auto）。
//
// 为什么克隆、不建符号链接：node_modules 里工作区包的链接是相对路径（@pi-lead-child/engine -> ../../packages/engine）。
// 克隆过去以后它们指向 worktree 自己的包；链接到用户 checkout 的 node_modules 则会让测试跑用户 checkout 的代码。
// 另外一个指向目录的符号链接不被 `node_modules/` 这条忽略规则覆盖，曾经被提交进 master（fbb54a7b）。
//
// 克隆在后台异步做：大仓库在本机要几分钟（有 Sophos 时更久），同步做会卡住 daemon（2026-10-14 的停摆）。
// 只克隆 git 忽略的 node_modules；克隆失败不影响 Run，执行者可以在沙箱里自己装。
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface DependencyPreparation {
  // 克隆过去的 node_modules（相对仓库根目录）。
  cloned: string[];
  // 没有做的原因（不是 Node 项目、已经有依赖、这个系统不支持写时复制……）。做了时为 null。
  skipped: string | null;
  // 出错时的原因。
  error: string | null;
  // 用包管理器装的（例如 pnpm install），没有克隆时写明。克隆的为 undefined。
  installedWith?: string;
}

const pending = new Map<string, Promise<DependencyPreparation>>();

// 不往下找的目录：依赖本身、git 的数据、plc 的 worktree 目录。
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-sessions", "dist", "build", ".next", ".turbo", ".cache"]);

/** 仓库里的 node_modules 目录（相对 root），最多往下找 maxDepth 层。 */
export function findNodeModulesDirs(root: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
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
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output: output.slice(-2_000) });
    });
  });
}

function cloneArgs(source: string, target: string): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "cp", args: ["-cR", source, target] };
  if (process.platform === "linux") return { command: "cp", args: ["-R", "--reflink=auto", source, target] };
  return null;
}

// pnpm 的可执行文件：daemon 的 PATH 是 launchd 给的，常常没有用户装的 pnpm（~/Library/pnpm）。找不到时为 null。
function pnpmBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.PNPM_HOME ? join(env.PNPM_HOME, "pnpm") : null,
    env.HOME ? join(env.HOME, "Library", "pnpm", "pnpm") : null,
    ...(env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "pnpm")),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

// pnpm 的仓库先用 pnpm 装（2026-10-29）：一个大的前端仓库 的 node_modules 有十几万个文件，开着 Sophos 克隆了 19 分钟，
// Run #185 一直停在启动前，被当成卡死停掉；克隆来的还是用户 checkout 那个分支的依赖，执行者又自己装了一遍。
// pnpm 按 lockfile 从本机的仓库硬链接，通常一两分钟。daemon 在沙箱外装，能写 pnpm 的仓库、能用 .npmrc 的凭证。
// --ignore-scripts：依赖的安装脚本不在沙箱外跑；要跑时执行者在沙箱里 pnpm rebuild。装不上时回到克隆。
async function pnpmInstall(worktree: string): Promise<DependencyPreparation | null> {
  if (!existsSync(join(worktree, "pnpm-lock.yaml"))) return null;
  const pnpm = pnpmBinary();
  if (!pnpm) return null;
  const result = await run(pnpm, ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--reporter=silent"], worktree, 10 * 60_000);
  if (result.code !== 0) return null;
  return { cloned: [], skipped: null, error: null, installedWith: "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts" };
}

async function prepare(source: string, worktree: string): Promise<DependencyPreparation> {
  if (!existsSync(join(worktree, "package.json"))) return { cloned: [], skipped: "不是 Node 项目（没有 package.json）", error: null };
  if (existsSync(join(worktree, "node_modules"))) return { cloned: [], skipped: "worktree 里已经有 node_modules", error: null };
  const installed = await pnpmInstall(worktree);
  if (installed) return installed;
  const dirs = findNodeModulesDirs(source).filter((dir) => existsSync(join(worktree, dirname(dir), "package.json")));
  if (!dirs.length) return { cloned: [], skipped: "用户的 checkout 里没有装好的依赖", error: null };
  const cloned: string[] = [];
  for (const dir of dirs) {
    const target = join(worktree, dir);
    if (existsSync(target)) continue;
    // 只克隆 git 忽略的路径：克隆出来的东西不能进提交。
    const ignored = await run("git", ["-C", worktree, "check-ignore", "-q", dir], worktree, 30_000);
    if (ignored.code !== 0) continue;
    const clone = cloneArgs(join(source, dir), target);
    if (!clone) return { cloned, skipped: `这个系统（${process.platform}）不支持写时复制的克隆`, error: null };
    const result = await run(clone.command, clone.args, worktree, 20 * 60_000);
    if (result.code !== 0) return { cloned, skipped: null, error: `克隆 ${dir} 失败：${result.output.trim() || `退出码 ${result.code}`}` };
    cloned.push(dir);
  }
  return { cloned, skipped: null, error: null };
}

/**
 * 在后台开始准备一个 worktree 的依赖（source 是用户的 checkout）。同一个 worktree 只做一次。
 * onDone 在做完时调用（记活动、打日志），它出错不影响结果。
 */
export function startWorktreeDependencies(
  source: string, worktree: string, onDone?: (result: DependencyPreparation) => void,
): Promise<DependencyPreparation> {
  const key = resolve(worktree);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = prepare(resolve(source), key)
    .catch((error: unknown): DependencyPreparation => ({
      cloned: [], skipped: null, error: error instanceof Error ? error.message : String(error),
    }))
    .then((result) => {
      try {
        onDone?.(result);
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

/**
 * Run 启动前等它的工作目录所在 worktree 的依赖准备完（工作目录可以是 worktree 里的子目录）。
 * 没有在准备的时返回 null。等太久（timeoutMs）时不再等，Run 照常启动。
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
}

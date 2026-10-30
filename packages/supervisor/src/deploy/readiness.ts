// 部署闸门（2026-10-19 用户决定）：只部署已提交的代码。
// supervisor 重启时运行主 checkout 里 apps/daemon/dist 的构建产物。#89、#92、#93、#95 的 child 直接在主 checkout 里
// 改代码、构建，Lead 随后请求重启，没有提交过的代码就上线了。现在：
//   · 构建时（apps/daemon/scripts/build.ts）在 dist 里写 build-info.json：从哪个 commit 构建、构建时源码有没有改动；
//   · supervisor 的维护入口（每条重启路径：Lead 的 request_runtime_maintenance、换 Lead 模型后的重启、
//     plc daemon restart/upgrade）检查下面几件事，有一件不满足就拒绝，并说明原因：
//     主 checkout 没有没提交的改动；dist 是从一个已提交、构建时没有改动、在当前分支历史里的 commit 构建的。
//     崩溃后的自动拉起不拦截，只记警告（supervisor 的 spawnDaemon）。
// 「没提交的改动」只看会进构建的代码：packages/、apps/ 下的改动和没被忽略的新文件，以及仓库根目录下的文件
// （package.json、package-lock.json、tsconfig.json 这类）。不算的：docs/、artifacts/、.scratch/、.claude/（它们不进 dist，
// 而且有的测试会改写 artifacts/ 里的证据文件），以及测试文件（test/ 目录下的、*.test.* 和 *.spec.*）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const BUILD_INFO_FILE = "build-info.json";

export interface BuildProvenance {
  version: 1;
  commit: string;
  // 构建时源码有没有没提交的改动。为 true 的构建不能部署。
  dirty: boolean;
  dirtyFiles: string[];
  builtAt: string;
}

export interface DeployReadiness {
  ready: boolean;
  // 不能部署的原因，每条一句。ready 时为空。
  reasons: string[];
  head: string | null;
  build: BuildProvenance | null;
}

const SOURCE_DIRS = ["packages/", "apps/"];
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

// 测试文件不进 dist：只改了测试的 checkout 照样可以部署。
function isTestFile(path: string): boolean {
  if (path.split("/").slice(0, -1).some((segment) => TEST_DIRS.has(segment))) return true;
  const name = basename(path);
  return name.includes(".test.") || name.includes(".spec.");
}

function gitRaw(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(root: string, args: string[]): string {
  return gitRaw(root, args).trim();
}

/** 主 checkout 里没提交的改动（按上面的口径），最多列 limit 个。 */
export function uncommittedSourceChanges(root: string, limit = 20): string[] {
  // 不能 trim：porcelain 每行的前两个字符是状态，第一个可能是空格。
  const lines = gitRaw(root, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
  const changed = lines.filter((line) => {
    // 改名写成「旧 -> 新」，两边都算。
    const paths = line.slice(3).split(" -> ").map((path) => path.replace(/^"|"$/g, ""));
    return paths.some((path) => !isTestFile(path) && (SOURCE_DIRS.some((dir) => path.startsWith(dir))
      || (!line.startsWith("??") && !path.includes("/"))));
  });
  return changed.slice(0, limit).map((line) => line.slice(3));
}

export function buildProvenance(root: string, now = new Date()): BuildProvenance {
  const dirtyFiles = uncommittedSourceChanges(root);
  return { version: 1, commit: git(root, ["rev-parse", "HEAD"]), dirty: dirtyFiles.length > 0, dirtyFiles, builtAt: now.toISOString() };
}

/** 构建开始时调用：构建中途失败时，dist 里不能留着上一次构建的记录，否则闸门会把半新半旧的 dist 当成干净的。 */
export function clearBuildProvenance(distDir: string): void {
  rmSync(join(distDir, BUILD_INFO_FILE), { force: true });
}

export function writeBuildProvenance(root: string, distDir: string): BuildProvenance {
  const provenance = buildProvenance(root);
  writeFileSync(join(distDir, BUILD_INFO_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

export function readBuildProvenance(distDir: string): BuildProvenance | null {
  const path = join(distDir, BUILD_INFO_FILE);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildProvenance>;
    if (value.version !== 1 || typeof value.commit !== "string" || typeof value.dirty !== "boolean") return null;
    return { version: 1, commit: value.commit, dirty: value.dirty, dirtyFiles: value.dirtyFiles ?? [], builtAt: value.builtAt ?? "" };
  } catch {
    return null;
  }
}

/** 现在能不能从 root 的 dist 部署。只读：不改 checkout，不构建。 */
export function deployReadiness(root: string, distDir: string): DeployReadiness {
  const reasons: string[] = [];
  let head: string | null = null;
  try {
    head = git(root, ["rev-parse", "HEAD"]);
    const changes = uncommittedSourceChanges(root);
    if (changes.length) {
      reasons.push(`主 checkout ${root} 有没提交的改动：${changes.join("、")}。先提交（或者撤销）这些改动，再重新构建。`);
    }
  } catch (error) {
    reasons.push(`读不了主 checkout ${root} 的 git 状态：${error instanceof Error ? error.message : String(error)}`);
  }
  const build = readBuildProvenance(distDir);
  if (!build) {
    reasons.push(`${join(distDir, BUILD_INFO_FILE)} 不存在：无法确认 dist 来自哪个 commit。在干净的 checkout 上重新运行 npm run build。`);
  } else {
    if (build.dirty) {
      reasons.push(`dist 构建时源码有没提交的改动（${build.dirtyFiles.join("、") || "未列出"}），不是从一个已提交的 commit 构建的。提交以后重新构建。`);
    }
    try {
      git(root, ["cat-file", "-e", `${build.commit}^{commit}`]);
      try {
        git(root, ["merge-base", "--is-ancestor", build.commit, "HEAD"]);
      } catch {
        reasons.push(`dist 的构建 commit ${build.commit} 不在主 checkout 当前分支的历史里（HEAD 是 ${head ?? "未知"}）。在当前分支上重新构建。`);
      }
    } catch {
      reasons.push(`dist 的构建 commit ${build.commit} 不在这个仓库里。`);
    }
  }
  return { ready: reasons.length === 0, reasons, head, build };
}

// 读本地 git 仓库的两样东西：origin 远端（解析出 GitHub 的 owner/repo）和 HEAD 的 sha。
// 只读文件，不启动 git 进程（代查跑在 daemon 进程里）。这里解析的都是 git 自己写的机器文本。
import { existsSync, readFileSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function readTextAsync(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function gitDirFromPointer(root: string, dotGitText: string | null): string | null {
  const pointer = /^gitdir:\s*(.+)$/m.exec(dotGitText ?? "")?.[1]?.trim();
  if (!pointer) return null;
  return isAbsolute(pointer) ? pointer : resolve(root, pointer);
}

function commonDirOf(gitDir: string, commondirText: string | null): string {
  const common = commondirText?.trim();
  return common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
}

/** 仓库的 git 目录和公共目录。worktree 的 .git 是一个文件，指向 gitdir，公共目录在 commondir 里。 */
export function gitDirsOf(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(root, ".git");
  let gitDir: string | null;
  try {
    const entry = statSync(dotGit);
    if (entry.isDirectory()) gitDir = dotGit;
    else if (entry.isFile()) gitDir = gitDirFromPointer(root, readText(dotGit));
    else return null;
  } catch {
    return null;
  }
  if (!gitDir) return null;
  return { gitDir, commonDir: commonDirOf(gitDir, readText(join(gitDir, "commondir"))) };
}

/** gitDirsOf 的异步版：不在调用方的线程上读盘（lead-scheduler P0b）。 */
export async function gitDirsOfAsync(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(root, ".git");
  let gitDir: string | null;
  try {
    const entry = await stat(dotGit);
    if (entry.isDirectory()) gitDir = dotGit;
    else if (entry.isFile()) gitDir = gitDirFromPointer(root, await readTextAsync(dotGit));
    else return null;
  } catch {
    return null;
  }
  if (!gitDir) return null;
  return { gitDir, commonDir: commonDirOf(gitDir, await readTextAsync(join(gitDir, "commondir"))) };
}

/** 目录是不是一个 git 仓库的根目录（有 .git 目录或 .git 文件）。 */
export function isGitRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/** isGitRoot 的异步版。 */
export async function isGitRootAsync(path: string): Promise<boolean> {
  return access(join(path, ".git")).then(() => true, () => false);
}

/** origin 远端的地址。没有时为 null。 */
export function originRemoteUrl(root: string): string | null {
  const dirs = gitDirsOf(root);
  if (!dirs) return null;
  return originUrlFromConfig(readText(join(dirs.commonDir, "config")));
}

/** originRemoteUrl 的异步版。 */
export async function originRemoteUrlAsync(root: string): Promise<string | null> {
  const dirs = await gitDirsOfAsync(root);
  if (!dirs) return null;
  return originUrlFromConfig(await readTextAsync(join(dirs.commonDir, "config")));
}

function originUrlFromConfig(config: string | null): string | null {
  if (!config) return null;
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    if (url) return url;
  }
  return null;
}

// GitHub 远端的三种写法：git@github.com:o/r(.git)、https://github.com/o/r(.git)、ssh://git@github.com/o/r(.git)。
// https 地址里可能带凭据（https://token@github.com/...）：只取 owner/repo，不保留原地址。
const GITHUB_REMOTE = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** 从远端地址解析 GitHub 的 owner/repo。不是 GitHub 时为 null。 */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/** HEAD 指向的 sha。读不到时为 null。 */
export function headSha(root: string): string | null {
  const dirs = gitDirsOf(root);
  if (!dirs) return null;
  const head = readText(join(dirs.gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return null;
  for (const dir of [dirs.gitDir, dirs.commonDir]) {
    const loose = readText(join(dir, ref))?.trim();
    if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  }
  const packed = readText(join(dirs.commonDir, "packed-refs")) ?? "";
  for (const line of packed.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return null;
}

/** 仓库的显示名：GitHub 的 owner/repo，没有时用目录名。 */
export function repoDisplayName(root: string, github: GithubRepoRef | null): string {
  return github ? `${github.owner}/${github.repo}` : (root.split(/[\\/]/).filter(Boolean).pop() ?? root);
}


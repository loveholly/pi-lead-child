// 读本地 git 仓库的两样东西：origin 远端（解析出 GitHub 的 owner/repo）和 HEAD 的 sha。
// 只读文件，不启动 git 进程（代查跑在 daemon 进程里）。这里解析的都是 git 自己写的机器文本。
import { existsSync, readFileSync, statSync } from "node:fs";
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

/** 仓库的 git 目录和公共目录。worktree 的 .git 是一个文件，指向 gitdir，公共目录在 commondir 里。 */
export function gitDirsOf(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(root, ".git");
  let gitDir: string;
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const common = readText(join(gitDir, "commondir"))?.trim();
  const commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
  return { gitDir, commonDir };
}

/** 目录是不是一个 git 仓库的根目录（有 .git 目录或 .git 文件）。 */
export function isGitRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/** origin 远端的地址。没有时为 null。 */
export function originRemoteUrl(root: string): string | null {
  const dirs = gitDirsOf(root);
  if (!dirs) return null;
  const config = readText(join(dirs.commonDir, "config"));
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


// 代查的候选仓库（slack-takeover spec D5）：hub 的请求 A 用它出 target_repo 的选项（工单 04 由 daemon 注入）。
// 来源有两个：
//   - project_repositories 里登记过的仓库；
//   - 配置的根目录（缺省 ~/Workspace）下两层以内的 git 仓库。
// 每个候选带解析出的 GitHub owner/repo（origin 远端）。不建项目和频道的关联（用户 2026-10-19 的决定）。
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "@pi-lead-child/store";
import { isGitRoot, originRemoteUrl, parseGithubRemote, repoDisplayName, type GithubRepoRef } from "./git.js";

export interface LookupCandidate {
  // owner/name；没有 GitHub 远端时是目录名。和 LookupScope.local[].repo 同一个写法。
  repo: string;
  // 本地仓库的根目录（realpath 以后的绝对路径）。
  root: string;
  github: GithubRepoRef | null;
  source: "project" | "local";
  // project_repositories 里的项目编号和仓库角色。本地扫描到的为 null。
  projectId: number | null;
  role: string | null;
}

export const DEFAULT_LOOKUP_ROOTS = (): string[] => [join(homedir(), "Workspace")];
const MAX_DEPTH = 2;
const DEFAULT_LIMIT = 200;
// 扫描时跳过的目录：隐藏目录和依赖目录里的仓库不是用户的项目。
const SKIPPED = new Set(["node_modules"]);

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// root 下 depth 层以内的 git 仓库根目录。一个目录是仓库时不再往下找。
function scanGitRoots(root: string, depth: number, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= limit) return;
    if (name.startsWith(".") || SKIPPED.has(name)) continue;
    const path = join(root, name);
    if (!isDirectory(path)) continue;
    if (isGitRoot(path)) {
      out.push(path);
    } else if (depth > 1) {
      scanGitRoots(path, depth - 1, out, limit);
    }
  }
}

/**
 * 候选仓库：先列 project_repositories 里的（目录还在的），再列 roots 下两层以内的 git 仓库，按 realpath 去重。
 * roots 不给时用 ~/Workspace。最多 limit 个。
 */
export function listLookupCandidates(input: { db: Db; roots?: readonly string[]; limit?: number }): LookupCandidate[] {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const seen = new Set<string>();
  const candidates: LookupCandidate[] = [];
  const add = (path: string, source: LookupCandidate["source"], extra: { projectId: number | null; role: string | null; remote?: string | null }): void => {
    if (candidates.length >= limit) return;
    const root = canonical(path);
    if (!root || seen.has(root) || !isDirectory(root)) return;
    seen.add(root);
    const remote = extra.remote ?? originRemoteUrl(root);
    const github = remote ? parseGithubRemote(remote) : null;
    candidates.push({ repo: repoDisplayName(root, github), root, github, source, projectId: extra.projectId, role: extra.role });
  };
  const rows = input.db.prepare(
    "SELECT repo_root, remote_url, project_id, role FROM project_repositories ORDER BY project_id, id",
  ).all() as Array<{ repo_root: string; remote_url: string | null; project_id: number; role: string | null }>;
  for (const row of rows) {
    add(row.repo_root, "project", { projectId: row.project_id, role: row.role, remote: row.remote_url ?? undefined });
  }
  const roots = input.roots ?? DEFAULT_LOOKUP_ROOTS();
  for (const root of roots) {
    const found: string[] = [];
    scanGitRoots(root, MAX_DEPTH, found, limit * 4);
    for (const path of found) add(path, "local", { projectId: null, role: null });
  }
  return candidates;
}

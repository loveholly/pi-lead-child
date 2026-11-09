// 代查的候选仓库（slack-takeover spec D5）：hub 的请求 A 用它出 target_repo 的选项（工单 04 由 daemon 注入）。
// 来源有两个：
//   - project_repositories 里登记过的仓库；
//   - 配置的根目录（缺省 ~/Workspace）下两层以内的 git 仓库。
// 每个候选带解析出的 GitHub owner/repo（origin 远端）。不建项目和频道的关联（用户 2026-10-19 的决定）。
//
// 扫目录不在调用方的线程上做（lead-scheduler P0b，2026-11-09 审计第 2 项）。以前 daemon 同步扫：本机实测真实的
// ~/Workspace 要 70–116 毫秒，450 个仓库的目录冷启动要 462 毫秒，这段时间 daemon 的主线程什么都做不了。现在：
//   - listLookupCandidatesAsync：异步地列一遍，一次只有一个文件操作在等（不挤占线程池）；
//   - listLookupCandidates：同步的调用方（请求 A、派工单找本地仓库）用它。它只读缓存，缓存过期（5 分钟）或者还没有时，
//     在后台重列一遍，这次先返回旧的结果；一次都没列过时，只返回登记过的项目（不扫目录）。
import { readdir, realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { schedLine } from "@pi-lead-child/core";
import type { Db } from "@pi-lead-child/store";
import { isGitRootAsync, originRemoteUrl, originRemoteUrlAsync, parseGithubRemote, repoDisplayName, type GithubRepoRef } from "./git.js";

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

export interface LookupCandidateInput {
  db: Db;
  roots?: readonly string[];
  limit?: number;
}

export const DEFAULT_LOOKUP_ROOTS = (): string[] => [join(homedir(), "Workspace")];
const MAX_DEPTH = 2;
const DEFAULT_LIMIT = 200;
// 缓存多久以后在后台重列。
export const LOOKUP_CANDIDATE_TTL_MS = 5 * 60_000;
// 扫描时跳过的目录：隐藏目录和依赖目录里的仓库不是用户的项目。
const SKIPPED = new Set(["node_modules"]);

interface ProjectRow {
  repo_root: string;
  remote_url: string | null;
  project_id: number;
  role: string | null;
}

function projectRows(db: Db): ProjectRow[] {
  return db.prepare(
    "SELECT repo_root, remote_url, project_id, role FROM project_repositories ORDER BY project_id, id",
  ).all() as ProjectRow[];
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isDirectory(), () => false);
}

// root 下 depth 层以内的 git 仓库根目录。一个目录是仓库时不再往下找。一个一个地等，不并发。
async function scanGitRoots(root: string, depth: number, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= limit) return;
    if (name.startsWith(".") || SKIPPED.has(name)) continue;
    const path = join(root, name);
    if (!(await isDirectory(path))) continue;
    if (await isGitRootAsync(path)) {
      out.push(path);
    } else if (depth > 1) {
      await scanGitRoots(path, depth - 1, out, limit);
    }
  }
}

/**
 * 候选仓库：先列 project_repositories 里的（目录还在的），再列 roots 下两层以内的 git 仓库，按 realpath 去重。
 * roots 不给时用 ~/Workspace。最多 limit 个。读盘都是异步的。
 */
export async function listLookupCandidatesAsync(input: LookupCandidateInput): Promise<LookupCandidate[]> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const seen = new Set<string>();
  const candidates: LookupCandidate[] = [];
  const add = async (path: string, source: LookupCandidate["source"], extra: { projectId: number | null; role: string | null; remote?: string | null }): Promise<void> => {
    if (candidates.length >= limit) return;
    const root = await realpath(path).catch(() => null);
    if (!root || seen.has(root) || !(await isDirectory(root))) return;
    seen.add(root);
    const remote = extra.remote ?? await originRemoteUrlAsync(root);
    const github = remote ? parseGithubRemote(remote) : null;
    candidates.push({ repo: repoDisplayName(root, github), root, github, source, projectId: extra.projectId, role: extra.role });
  };
  for (const row of projectRows(input.db)) {
    await add(row.repo_root, "project", { projectId: row.project_id, role: row.role, remote: row.remote_url ?? undefined });
  }
  for (const root of input.roots ?? DEFAULT_LOOKUP_ROOTS()) {
    const found: string[] = [];
    await scanGitRoots(root, MAX_DEPTH, found, limit * 4);
    for (const path of found) await add(path, "local", { projectId: null, role: null });
  }
  return candidates;
}

// ── 同步调用方用的缓存 ───────────────────────────────────────────────────────────

interface CacheEntry {
  at: number;
  value: LookupCandidate[] | null;
  refreshing: Promise<LookupCandidate[]> | null;
  log: ((line: string) => void) | null;
}

// 每个账本、每组根目录一份。账本关掉以后跟着回收。
const caches = new WeakMap<Db, Map<string, CacheEntry>>();

function cacheEntry(input: LookupCandidateInput): CacheEntry {
  let byKey = caches.get(input.db);
  if (!byKey) caches.set(input.db, byKey = new Map());
  const key = JSON.stringify([input.roots ?? null, input.limit ?? DEFAULT_LIMIT]);
  let entry = byKey.get(key);
  if (!entry) byKey.set(key, entry = { at: 0, value: null, refreshing: null, log: null });
  return entry;
}

/** 在后台重列一遍并更新缓存。正在重列时返回同一个 promise。 */
export function refreshLookupCandidates(input: LookupCandidateInput & { log?: (line: string) => void }): Promise<LookupCandidate[]> {
  const entry = cacheEntry(input);
  if (input.log) entry.log = input.log;
  if (entry.refreshing) return entry.refreshing;
  const started = Date.now();
  const roots = input.roots ?? DEFAULT_LOOKUP_ROOTS();
  entry.refreshing = listLookupCandidatesAsync(input).then((value) => {
    entry.value = value;
    entry.at = Date.now();
    entry.log?.(schedLine("lookup.scan", { ms: Date.now() - started, roots: roots.length, candidates: value.length }));
    return value;
  }, (error: unknown) => {
    entry.log?.(schedLine("lookup.scan_failed", { ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    throw error;
  }).finally(() => {
    entry.refreshing = null;
  });
  return entry.refreshing;
}

// 一次都没列过时：只列登记过的项目，不扫目录（几个仓库，各读一两个小文件）。
function projectCandidatesNow(db: Db, limit: number): LookupCandidate[] {
  const seen = new Set<string>();
  const candidates: LookupCandidate[] = [];
  for (const row of projectRows(db)) {
    if (candidates.length >= limit) break;
    let root: string;
    try {
      root = realpathSync(row.repo_root);
      if (seen.has(root) || !statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(root);
    const remote = row.remote_url ?? originRemoteUrl(root);
    const github = remote ? parseGithubRemote(remote) : null;
    candidates.push({ repo: repoDisplayName(root, github), root, github, source: "project", projectId: row.project_id, role: row.role });
  }
  return candidates;
}

/**
 * 候选仓库，给同步的调用方用：只读缓存，不在调用方的线程上扫目录。缓存过期或者还没有时在后台重列，
 * 这次先返回旧的结果；一次都没列过时，只返回登记过的项目。log 收后台重列的 [sched] 日志。
 */
export function listLookupCandidates(input: LookupCandidateInput & { log?: (line: string) => void }): LookupCandidate[] {
  const entry = cacheEntry(input);
  if (!entry.value || Date.now() - entry.at >= LOOKUP_CANDIDATE_TTL_MS) {
    // 失败已经记过日志；下一次调用再试。
    refreshLookupCandidates(input).catch(() => undefined);
  }
  return entry.value ?? projectCandidatesNow(input.db, input.limit ?? DEFAULT_LIMIT);
}

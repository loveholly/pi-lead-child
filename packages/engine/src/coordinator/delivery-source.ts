// 交付从哪里来：交付属于哪个工作区、分支现在指向哪个提交、git diff 的文件列表，和路径的安全规则（2026-10-20）。
// 交付视图（delivery.ts）和交付快照（delivery-snapshot.ts）共用这一层。2026-10-21 从 delivery.ts 搬出来，代码没有改；
// 只新加了 worktreePresent 和 uncommittedFileCount，是 delivery.ts 里原有的两段判断。工单 04 审查以后加了 git 失败的种类
// （GitCommandError）、超时参数，git status 失败时没提交的文件数是 null。
//
// 读 git 都用异步的 execFile：同步的 git 会卡住 daemon 的主线程（2026-10-14 的 sweep 冻结）。
// 参数全部按数组传给 git，不经过 shell。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@pi-lead-child/store";
import { listWorkspaces } from "@pi-lead-child/store";
import type { Workspace } from "@pi-lead-child/core";

export const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 15_000;
export const NETWORK_TIMEOUT_MS = 90_000;

export type DeliveryFileStatus = "added" | "modified" | "deleted" | "renamed" | "unchanged";

// ── git ──────────────────────────────────────────────────────────────────────────

// git 失败的种类（工单 04 审查 M4）：输出超过上限（改动太大）、超时、其他错误。交付快照按它给用户写原因。
export type GitFailureKind = "too_large" | "timeout" | "error";

export interface GitResult { stdout: string; ok: boolean; stderr: string; failure?: GitFailureKind }

export class GitCommandError extends Error {
  constructor(message: string, readonly kind: GitFailureKind) {
    super(message);
    this.name = "GitCommandError";
  }
}

export async function gitRun(
  args: string[], cwd: string, opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  try {
    // --literal-pathspecs：交付里的文件名（agent 写的）当成字面路径。名字是 * 的文件不能让 git diff -- * 带出所有文件，
    // 包括隐藏的文件（2026-10-21 审查 M6）。
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, "--literal-pathspecs", "-c", "core.quotepath=false", ...args], {
      encoding: "utf8", timeout: opts.timeout ?? GIT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { stdout, stderr, ok: true };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string; code?: unknown; killed?: boolean };
    // 输出超过 maxBuffer 时 node 也会杀掉进程（killed=true），所以先认它。
    const failure: GitFailureKind = failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too_large"
      : failed.killed ? "timeout" : "error";
    // stderr 为空时不换成 message：message 是「Command failed: git -C <仓库路径> …」，不能给用户看（2026-10-21 审查 L2）。
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message ?? String(error), ok: false, failure };
  }
}

export async function git(args: string[], cwd: string, opts?: Parameters<typeof gitRun>[2]): Promise<string> {
  const result = await gitRun(args, cwd, opts);
  if (!result.ok) throw new GitCommandError(redact(firstLine(result.stderr)) || `git ${args[0]} failed`, result.failure ?? "error");
  return result.stdout;
}

export function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

// git push 和 gh 的报错里可能带着 https://user:token@host、ssh://user:token@host 这类地址。给用户看之前去掉用户信息。
// 任何 scheme 都算（2026-10-21 审查 L2：以前只处理 http 和 https）。
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1");
}

// ── 交付属于哪个工作区 ─────────────────────────────────────────────────────────────

export function deliveryWorkspace(db: Db, itemId: number): Workspace | null {
  return listWorkspaces(db, { ownerItemId: itemId })
    .filter((workspace) => workspace.kind === "isolated_child" && workspace.git_worktree && workspace.repo_root && workspace.branch)
    .sort((left, right) => right.id - left.id)[0] ?? null;
}

interface DecisionPayload { decision?: string; workspaceId?: number; head?: string | null; target?: string; url?: string }

// 在 SQL 里按 decision 和工作区过滤，不先取最近 N 条再在代码里找（工单 07 审查 M4）：以前取最近 200 条 decision，
// 打开文件的记录（delivery_file_opened）多了以后，合并和开 PR 的记录被挤出这个窗口，交付视图上的「合并到哪里」和 PR 链接就没了。
// 不是 JSON 的历史记录（json_valid 为假）跳过，不让整条查询报错。
export function latestDecision(db: Db, itemId: number, decision: string, workspaceId: number): DecisionPayload | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND kind='decision'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.decision') END = ?
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.workspaceId') END = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, decision, workspaceId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as DecisionPayload : null;
}

export function activeRuns(db: Db, workspaceId: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND state IN ('starting','running','paused')",
  ).get(workspaceId) as { n: number }).n;
}

// worktree 还在（没有清理、目录也在）。
export function worktreePresent(workspace: Workspace): boolean {
  return !["cleaned", "archived"].includes(workspace.state) && existsSync(workspace.path);
}

// 分支现在指向的提交。worktree 还在时读 worktree 的 HEAD；合并以后读合并时记下的提交；放弃以后读保留的分支。
// timeout：交付时钉住分支头只给几秒（delivery-snapshot.ts 的 HANDOFF_PIN_BUDGET_MS）。
export async function workspaceHead(db: Db, workspace: Workspace, opts: { timeout?: number } = {}): Promise<string | null> {
  if (worktreePresent(workspace)) {
    const head = await gitRun(["rev-parse", "HEAD"], workspace.path, opts);
    if (head.ok) return head.stdout.trim();
  }
  if (workspace.merge_status === "merged") {
    const integrated = latestDecision(db, workspace.owner_item_id, "workspace_integrated", workspace.id);
    if (integrated?.head) return integrated.head;
  }
  const branch = await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}^{commit}`], workspace.repo_root!, opts);
  return branch.ok ? branch.stdout.trim() || null : null;
}

// worktree 里没提交的文件数。worktree 不在时为 0。git status 失败或超时时为 null：不知道，不能拿来比较
// （工单 04 审查 L9：以前当成 0，计数在 0 和 N 之间跳，每跳一次多存一份快照）。
export async function uncommittedFileCount(workspace: Workspace, opts: { timeout?: number } = {}): Promise<number | null> {
  if (!worktreePresent(workspace)) return 0;
  const status = await gitRun(["status", "--porcelain", "--untracked-files=normal"], workspace.path, opts);
  return status.ok ? status.stdout.split("\n").filter(Boolean).length : null;
}

// ── 路径的安全规则 ─────────────────────────────────────────────────────────────────

const SENSITIVE_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);

// 和组织的安全规则一致：这些文件可能含密钥，列出来但不显示内容。
export function deliveryFileHiddenReason(path: string): string | null {
  const name = posix.basename(path).toLowerCase();
  if (SENSITIVE_ALLOWED.has(name)) return null;
  if (name === ".env" || name.startsWith(".env.")
    || /\.(pem|key|p12|pfx)$/.test(name)
    || ["id_rsa", "id_ed25519", "id_ecdsa"].includes(name)
    || name.startsWith("credentials") || name.startsWith("secrets.")) {
    return "这个文件可能含密钥，不在这里显示。";
  }
  return null;
}

// 交付里的路径都是仓库内的相对路径。拒绝绝对路径、反斜杠、..、空段和控制字符。
// 也拒绝 .git 目录里的路径：.git/config 的 remote 地址里可能带 token。macOS 的文件系统不分大小写，所以按小写比
// （2026-10-21 审查 M6）。
export function normalizeDeliveryPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^\.\//, "");
  if (!trimmed || trimmed.length > 1024 || /[\u0000-\u001f\\]/.test(trimmed)) return null;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return null;
  const normalized = posix.normalize(trimmed);
  if (normalized !== trimmed || normalized.split("/").some((segment) => segment === ".." || segment === "." || !segment)) return null;
  if (hasGitSegment(normalized)) return null;
  return normalized;
}

export function hasGitSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}

// ── 文件列表 ───────────────────────────────────────────────────────────────────────

export interface DiffEntry { path: string; previousPath: string | null; status: DeliveryFileStatus; additions: number | null; deletions: number | null; binary: boolean }

// git diff -z --numstat 和 --name-status 的输出合在一起。改名时两种输出都把旧路径和新路径分成两个字段。
// 出错时抛 GitCommandError（kind 说明是改动太大、超时还是别的错误）。
export async function diffEntries(repo: string, base: string, head: string): Promise<DiffEntry[]> {
  const [numstat, names] = await Promise.all([
    git(["diff", "-z", "-M", "--numstat", base, head], repo),
    git(["diff", "-z", "-M", "--name-status", base, head], repo),
  ]);
  const counts = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const numFields = numstat.split("\0");
  for (let index = 0; index < numFields.length; index++) {
    const field = numFields[index];
    if (!field) continue;
    const [added, deleted, path] = field.split("\t");
    const binary = added === "-" && deleted === "-";
    const entry = { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary };
    if (path) {
      counts.set(path, entry);
    } else {
      // 改名：这一段是「加\t删\t」，后面两段是旧路径和新路径。
      const renamedTo = numFields[index + 2];
      if (renamedTo) counts.set(renamedTo, entry);
      index += 2;
    }
  }
  const entries: DiffEntry[] = [];
  const nameFields = names.split("\0");
  for (let index = 0; index < nameFields.length; index++) {
    const code = nameFields[index];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const previousPath = nameFields[index + 1] ?? null;
      const path = nameFields[index + 2] ?? "";
      index += 2;
      const count = counts.get(path);
      entries.push({ path, previousPath, status: "renamed", additions: count?.additions ?? null, deletions: count?.deletions ?? null, binary: count?.binary ?? false });
      continue;
    }
    const path = nameFields[index + 1] ?? "";
    index += 1;
    const count = counts.get(path);
    const status: DeliveryFileStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    entries.push({ path, previousPath: null, status, additions: count?.additions ?? null, deletions: count?.deletions ?? null, binary: count?.binary ?? false });
  }
  return entries;
}

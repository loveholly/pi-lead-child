// 工单要改的仓库（2026-10-29）。Lead 建单时写明仓库（owner/name），本机找得到它的 checkout 就用，找不到时 daemon 在沙箱外
// clone 一份（用户自己的 git 凭证）。
//
// 起因：#161 要把 skill 迁到 Acme/returns-skills，本机没有这个仓库，工单只好挂在 aish 仓库下。执行者在沙箱里 clone 不了，
// 两次卡成阻塞，Lead 又开了一张工单用连接工具一个个取文件，用了约半小时；交付以后系统还按 aish 仓库自动开了 PR（#126，
// 推了 4275 行到错的仓库）。
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Db } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { gitRun } from "./delivery-source.js";
import { normalizeRemoteUrl } from "./project-resolver.js";

const CLONE_TIMEOUT_MS = 10 * 60_000;

export interface RepositorySpec {
  host: string;
  owner: string;
  name: string;
  // 规范化的写法（host/owner/name），和 project_repositories.remote_url 一样。
  key: string;
}

/** 认 owner/name、host/owner/name、https 地址和 git@host:owner/name.git。认不出时为 null。 */
export function parseRepositorySpec(spec: string): RepositorySpec | null {
  const raw = spec.trim();
  if (!raw) return null;
  const normalized = /^[\w.-]+\/[\w.-]+$/.test(raw) ? `github.com/${raw}` : normalizeRemoteUrl(raw);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 3 || !parts.every((part) => /^[\w.-]+$/.test(part)) || !parts[0]!.includes(".")) return null;
  const [host, owner, name] = parts as [string, string, string];
  return { host: host.toLowerCase(), owner, name, key: `${host.toLowerCase()}/${owner}/${name}`.toLowerCase() };
}

// 写在配置里的原样地址：remote get-url 会套用 insteadOf 改写，认不出本来是哪个仓库。
async function originOf(dir: string): Promise<string | null> {
  const result = await gitRun(["config", "--get", "remote.origin.url"], dir);
  return result.ok ? result.stdout.trim() : null;
}

async function matches(dir: string, spec: RepositorySpec): Promise<boolean> {
  const origin = await originOf(dir);
  return origin !== null && normalizeRemoteUrl(origin).toLowerCase() === spec.key;
}

// 账本里登记过的仓库（project_repositories），按规范化的远端地址。
function registeredRepos(db: Db): Array<{ repoRoot: string; remoteUrl: string | null }> {
  try {
    return (db.prepare("SELECT repo_root AS repoRoot, remote_url AS remoteUrl FROM project_repositories").all() as Array<{
      repoRoot: string; remoteUrl: string | null;
    }>).filter((row) => existsSync(row.repoRoot));
  } catch {
    return [];
  }
}

// 找本机的 checkout：先看账本登记的，再看 ~/Workspace 下两层以内同名的目录。
async function findCheckout(db: Db, spec: RepositorySpec, roots: readonly string[]): Promise<string | null> {
  for (const row of registeredRepos(db)) {
    if (row.remoteUrl?.toLowerCase() === spec.key && await matches(row.repoRoot, spec)) return row.repoRoot;
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const candidates = [join(root, spec.name)];
    for (const entry of safeList(root)) candidates.push(join(root, entry, spec.name));
    for (const candidate of candidates) {
      if (existsSync(join(candidate, ".git")) && await matches(candidate, spec)) return candidate;
    }
  }
  return null;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith(".") && statSync(join(dir, entry)).isDirectory());
  } catch {
    return [];
  }
}

// clone 到哪里、用哪种地址：放在同一个 owner 的别的仓库旁边，地址的写法（SSH 还是 HTTPS）跟它一样。
// 没有同一个 owner 的仓库时放在 ~/Workspace/<owner>，用 HTTPS。
async function clonePlan(db: Db, spec: RepositorySpec, home: string): Promise<{ parent: string; url: string }> {
  for (const row of registeredRepos(db)) {
    if (!row.remoteUrl?.toLowerCase().startsWith(`${spec.host}/${spec.owner}/`.toLowerCase())) continue;
    const origin = await originOf(row.repoRoot);
    const ssh = origin !== null && (/^[^@/]+@[^:]+:/.test(origin) || origin.startsWith("ssh://"));
    return {
      parent: dirname(row.repoRoot),
      url: ssh ? `git@${spec.host}:${spec.owner}/${spec.name}.git` : `https://${spec.host}/${spec.owner}/${spec.name}.git`,
    };
  }
  return { parent: join(home, "Workspace", spec.owner), url: `https://${spec.host}/${spec.owner}/${spec.name}.git` };
}

export interface RepositoryCheckout {
  path: string;
  cloned: boolean;
}

/**
 * 这个仓库在本机的 checkout：有就用，没有就 clone（沙箱外，用户的 git 凭证）。clone 失败时抛错，写明 git 的原因。
 * roots：找现成 checkout 的目录，缺省是 ~/Workspace。
 */
export async function ensureRepositoryCheckout(
  db: Db, spec: RepositorySpec, options: { home?: string; roots?: readonly string[] } = {},
): Promise<RepositoryCheckout> {
  const home = options.home ?? homedir();
  const found = await findCheckout(db, spec, options.roots ?? [join(home, "Workspace")]);
  if (found) return { path: found, cloned: false };
  const plan = await clonePlan(db, spec, home);
  const target = join(plan.parent, spec.name);
  if (existsSync(target)) throw new Error(`${target} 已经存在，但不是 ${spec.owner}/${spec.name} 的 checkout，没有 clone`);
  mkdirSync(plan.parent, { recursive: true });
  const cloned = await gitRun(["clone", "--quiet", plan.url, target], plan.parent, {
    timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!cloned.ok) {
    throw new Error(`clone ${spec.owner}/${spec.name} 失败：${cloned.stderr.trim().split("\n")[0] || "git 没有说原因"}`);
  }
  return { path: target, cloned: true };
}

/** 记下工单要改的仓库：交付以后自动开 PR 时核对（auto-pull-request.ts）。 */
export function recordTicketRepository(db: Db, itemId: number, spec: RepositorySpec, checkout: RepositoryCheckout): void {
  addActivity(db, {
    itemId, actor: "lead", kind: "decision",
    payload: { decision: "ticket_repository", repository: spec.key, path: checkout.path, cloned: checkout.cloned },
  });
}

/** 工单写明要改的仓库（规范化的 host/owner/name）。没写时为 null。 */
export function ticketRepository(db: Db, itemId: number): string | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.repository') AS repository FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='ticket_repository'
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as { repository: string | null } | undefined;
  return row?.repository ?? null;
}

/** 工作区所在仓库的规范化远端地址。没有 origin 时为 null。 */
export async function workspaceRepository(repoRoot: string): Promise<string | null> {
  const origin = await originOf(repoRoot);
  return origin ? normalizeRemoteUrl(origin).toLowerCase() : null;
}


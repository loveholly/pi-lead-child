// 工单要改的仓库（2026-10-29）。Lead 建单时写明仓库（owner/name），本机找得到它的 checkout 就用，找不到时 daemon 在沙箱外
// clone 一份（用户自己的 git 凭证）。
//
// 起因：#161 要把 skill 迁到 Acme/returns-skills，本机没有这个仓库，工单只好挂在 aish 仓库下。执行者在沙箱里 clone 不了，
// 两次卡成阻塞，Lead 又开了一张工单用连接工具一个个取文件，用了约半小时；交付以后系统还按 aish 仓库自动开了 PR（#126，
// 推了 4275 行到错的仓库）。
//
// clone 不在建单时等（2026-11-03）：四张工单一张张建，三次 clone 各等了 13–17 秒，Lead 那一轮多等了 45 秒。
// 现在建单只用 ls-remote 确认仓库连得上（写错名字、没有权限当场就知道），clone 在后台跑；执行者的 Run 开跑前等它
// （workspace-policy.ts）。daemon 重启丢了后台的 clone 时，Run 开跑前再 clone 一次。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { removeTree, type Item } from "@pi-lead-child/core";
import type { Db } from "@pi-lead-child/store";
import { addActivity, getItem } from "@pi-lead-child/store";
import { gitRun, NETWORK_TIMEOUT_MS } from "./delivery-source.js";
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

export interface RepositoryCheckoutOptions {
  home?: string;
  // 找现成 checkout 的目录，缺省是 ~/Workspace。
  roots?: readonly string[];
}

// 正在 clone 的仓库（按规范化的写法）：同一个仓库只 clone 一次，后来的调用等同一个结果。
const clones = new Map<string, Promise<StartedClone>>();

interface StartedClone {
  path: string;
  done: Promise<RepositoryCheckout>;
}

/** 本机现成的 checkout。没有时为 null。 */
export async function findRepositoryCheckout(
  db: Db, spec: RepositorySpec, options: RepositoryCheckoutOptions = {},
): Promise<string | null> {
  const home = options.home ?? homedir();
  return findCheckout(db, spec, options.roots ?? [join(home, "Workspace")]);
}

/**
 * 这个仓库在本机的 checkout：有就用，没有就 clone（沙箱外，用户的 git 凭证）。clone 失败时抛错，写明 git 的原因。
 * 正在 clone 时等那一次的结果，不再 clone 一份。
 */
export async function ensureRepositoryCheckout(
  db: Db, spec: RepositorySpec, options: RepositoryCheckoutOptions = {},
): Promise<RepositoryCheckout> {
  const pending = clones.get(spec.key);
  if (pending) return (await pending).done;
  const found = await findRepositoryCheckout(db, spec, options);
  if (found) return { path: found, cloned: false };
  return (await startRepositoryClone(db, spec, options)).done;
}

/** 确认仓库连得上、有权限读：git ls-remote，不下载内容。连不上时抛错，写明 git 的原因。 */
export async function checkRepositoryAccess(db: Db, spec: RepositorySpec, options: RepositoryCheckoutOptions = {}): Promise<void> {
  const home = options.home ?? homedir();
  const plan = await clonePlan(db, spec, home);
  const listed = await gitRun(["ls-remote", "--quiet", plan.url, "HEAD"], existsSync(plan.parent) ? plan.parent : home, {
    timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!listed.ok) {
    throw new Error(`连不上 ${spec.owner}/${spec.name}，或者没有读它的权限：${firstLine(listed.stderr) || "git 没有说原因"}`);
  }
}

/**
 * 在后台 clone：定下 clone 到哪个目录就返回，done 在 clone 完成时兑现。先 clone 进旁边的临时目录、成功了再改名，
 * 所以中途停掉（例如 daemon 重启）不会留下半个 checkout 让 findRepositoryCheckout 当成现成的。
 */
export function startRepositoryClone(
  db: Db, spec: RepositorySpec, options: RepositoryCheckoutOptions = {},
): Promise<StartedClone> {
  const pending = clones.get(spec.key);
  if (pending) return pending;
  const started = clonePlan(db, spec, options.home ?? homedir()).then((plan) => {
    const path = join(plan.parent, spec.name);
    const done = cloneInto(spec, plan, path);
    done.then(forget, forget);
    return { path, done };
  });
  const forget = (): void => { if (clones.get(spec.key) === started) clones.delete(spec.key); };
  started.catch(forget);
  clones.set(spec.key, started);
  return started;
}

async function cloneInto(spec: RepositorySpec, plan: { parent: string; url: string }, target: string): Promise<RepositoryCheckout> {
  if (existsSync(target)) throw new Error(`${target} 已经存在，但不是 ${spec.owner}/${spec.name} 的 checkout，没有 clone`);
  mkdirSync(plan.parent, { recursive: true });
  const temporary = `${target}.plc-clone-${randomUUID().slice(0, 8)}`;
  const cloned = await gitRun(["clone", "--quiet", plan.url, temporary], plan.parent, {
    timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  // 删一半的 clone 在子进程里删（core 的 removeTree），不占 daemon 的线程池（lead-scheduler spec P0）。
  if (!cloned.ok) {
    await removeTree(temporary, { kind: "clone-delete", label: `${spec.owner}/${spec.name}`, priority: "utility" }).catch(() => undefined);
    throw new Error(`clone ${spec.owner}/${spec.name} 失败：${firstLine(cloned.stderr) || "git 没有说原因"}`);
  }
  if (existsSync(target)) {
    await removeTree(temporary, { kind: "clone-delete", label: `${spec.owner}/${spec.name}`, priority: "utility" }).catch(() => undefined);
    throw new Error(`${target} 在 clone 的时候出现了，没有覆盖它`);
  }
  renameSync(temporary, target);
  return { path: target, cloned: true };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** 记下工单要改的仓库：交付以后自动开 PR 时核对（auto-pull-request.ts）。cloning：还在后台 clone。 */
export function recordTicketRepository(
  db: Db, itemId: number, spec: RepositorySpec, checkout: RepositoryCheckout & { cloning?: boolean },
): void {
  addActivity(db, {
    itemId, actor: "lead", kind: "decision",
    payload: {
      decision: "ticket_repository", repository: spec.key, path: checkout.path, cloned: checkout.cloned,
      ...(checkout.cloning ? { cloning: true, spec: `${spec.host}/${spec.owner}/${spec.name}` } : {}),
    },
  });
}

/** 后台 clone 的结果记到工单上：成功或者失败的原因。 */
export function recordTicketRepositoryClone(db: Db, itemId: number, spec: RepositorySpec, done: Promise<RepositoryCheckout>): void {
  done.then(
    (checkout) => addActivity(db, {
      itemId, actor: "system", kind: "decision",
      payload: { decision: "ticket_repository_cloned", repository: spec.key, path: checkout.path },
    }),
    (error: unknown) => addActivity(db, {
      itemId, actor: "system", kind: "decision",
      payload: {
        decision: "ticket_repository_clone_failed", repository: spec.key,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    }),
  ).catch(() => { /* 工单可能已经删了：记不下也不影响 clone 本身 */ });
}

/**
 * Run 开跑前把工单写明的仓库准备好：在后台 clone 的等它，没有在 clone 的（例如 daemon 重启丢了那次 clone）现在 clone。
 * 用户在这期间自己 clone 到了别处时用那一份，工单的工作目录跟着改。返回更新后的工单。
 */
export async function cloneTicketRepository(db: Db, item: Item, spec: RepositorySpec): Promise<Item> {
  const checkout = await ensureRepositoryCheckout(db, spec);
  if (checkout.path !== item.workdir) {
    db.prepare("UPDATE items SET workdir=?, updated_at=datetime('now') WHERE id=?").run(checkout.path, item.id);
    recordTicketRepository(db, item.id, spec, checkout);
  }
  return getItem(db, item.id) ?? item;
}

/**
 * 工单写明的仓库还没有 checkout（工作目录不在）：返回它的写法，Run 开跑前要先 clone。已经有 checkout、或者工单没写仓库时为 null。
 */
export function ticketRepositoryToClone(db: Db, item: { id: number; workdir: string | null }): RepositorySpec | null {
  if (!item.workdir || existsSync(item.workdir)) return null;
  const row = db.prepare(
    `SELECT json_extract(payload, '$.spec') AS spec, json_extract(payload, '$.repository') AS repository,
            json_extract(payload, '$.path') AS path FROM activities
     WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='ticket_repository'
     ORDER BY id DESC LIMIT 1`,
  ).get(item.id) as { spec: string | null; repository: string | null; path: string | null } | undefined;
  if (!row || row.path !== item.workdir) return null;
  return parseRepositorySpec(row.spec ?? row.repository ?? "");
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


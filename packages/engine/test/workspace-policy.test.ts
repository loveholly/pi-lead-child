// 编码工单默认用隔离 worktree（2026-10-19 用户决定）。
// 以前 52 个 workspace 全是 shared/primary：Lead 不把工单标成 coding、也不调 provision_workspace，
// child 就直接在用户的 checkout 里改代码（#89、#92、#93、#95 改的是线上部署目录）。
// 现在由系统按事实判定：工作目录在 git 仓库里，并且这次 Run 会写文件。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, createRun, getItem, getRun, getWorkspace, listActivities, listWorkspaces } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { AgentRuntime, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import {
  prepareRunWorkspace, requestSharedWorkspace, setDeploymentRepositoriesForTesting, setPullRequestReviewTarget,
} from "../src/coordinator/workspace-policy.js";
import { sweepWorkspaces } from "../src/coordinator/workspace.js";

let db: Db;
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(path: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "test@example.test");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "source.txt"), "base\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
}

beforeEach(() => {
  dir = tempDir("plc-workspace-policy-");
  repo = join(dir, "repo");
  initRepo(repo);
  db = openDb(join(dir, "plc.db"));
});
afterEach(() => {
  setDeploymentRepositoriesForTesting(null);
  db.close();
});

// 记下 runtime 收到的工作目录，并在里面写一个文件，就像 child 改代码。
function writingRuntime(seen: Array<RuntimeStartRequest & { head: string }>, options: { fail?: boolean } = {}): AgentRuntime {
  return {
    id: "codex",
    capabilities: { streaming: true, steering: false, resume: false, interrupt: true,
      approvals: false, mcp: false, executableReadOnlyReview: true },
    async start(request) {
      let head = "";
      try { head = git(request.workdir, "rev-parse", "HEAD"); } catch { /* not a git checkout */ }
      seen.push({ ...request, head });
      return {
        pid: null,
        events: (async function*() {
          yield { runId: request.runId, seq: 1, occurredAt: new Date().toISOString(),
            type: "run.started" as const, runtime: "codex" as const, model: null };
          writeFileSync(join(request.workdir, "source.txt"), "child change\n");
          // 失败的 Run：进程退出时没有终止事件，内核按退出码补一个 run.failed。
          if (options.fail) return;
          yield { runId: request.runId, seq: 2, occurredAt: new Date().toISOString(),
            type: "run.completed" as const, exitCode: 0 };
        })(),
        async interrupt() {},
        async wait() {
          return { ok: !options.fail, exitCode: options.fail ? 1 : 0, signal: null, externalSessionId: null,
            errorCode: options.fail ? "exit_nonzero" : null, errorMessage: options.fail ? "boom" : null };
        },
      };
    },
  };
}

function genericTicket(workdir = repo): number {
  // Lead 建单时不给 workflow_kind，缺省是 generic（#89–#101 都是这样）。
  return createItem(db, { title: "fix it", brief: "change source.txt", createdBy: "lead", workdir });
}

function decisions(itemId: number): Array<Record<string, unknown>> {
  return listActivities(db, itemId)
    .filter((activity) => activity.kind === "decision")
    .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
    .filter((payload) => payload.decision === "workspace_policy");
}

async function run(itemId: number, opts: { runId?: number; purpose?: "execution" | "conversation"; fail?: boolean } = {}) {
  const seen: Array<RuntimeStartRequest & { head: string }> = [];
  const result = await runItem(db, itemId, {
    dbPath: join(dir, "plc.db"), dataDir: dir, prompt: "do it", sessionDir: join(dir, "sessions", `item-${itemId}`),
    runtime: writingRuntime(seen, { fail: opts.fail }),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  });
  return { ...result, request: seen[0]! };
}

describe("the system decides that a ticket is a coding ticket", () => {
  it("runs a generic ticket in a git checkout in an isolated worktree, not in the user's checkout", async () => {
    const itemId = genericTicket();
    const { runId, request } = await run(itemId);

    expect(request.workdir).not.toBe(repo);
    expect(request.workdir.startsWith(`${realpathSync(repo)}.plc-workspaces`)).toBe(true);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    const workspace = getWorkspace(db, getRun(db, runId)!.workspace_id!)!;
    expect(workspace).toMatchObject({ mode: "isolated", kind: "isolated_child", git_worktree: 1, path: request.workdir });
    expect(request.env.PLC_WORKSPACE_MODE).toBe("isolated");
    expect(request.prompt).toContain(`an isolated git worktree at ${workspace.path} on branch ${workspace.branch}`);
    // 判定结果和依据记进工单。
    expect(getItem(db, itemId)?.workflow_kind).toBe("coding");
    expect(decisions(itemId).at(-1)).toMatchObject({
      coding: true, mode: "isolated", workspaceId: workspace.id,
      facts: { gitRepository: realpathSync(repo), writes: true, purpose: "execution", role: "executor" },
    });
  });

  it("does not bind a dispatched run to the user's checkout", async () => {
    const itemId = genericTicket();
    const dispatcher = createDispatcher(db);
    dispatcher.request({ itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "k" });
    const claim = dispatcher.claimNext()!;
    const bound = getRun(db, claim.runId)!.workspace_id;
    expect(bound === null || getWorkspace(db, bound)!.mode === "isolated").toBe(true);

    const { request } = await run(itemId, { runId: claim.runId });
    expect(request.workdir).not.toBe(repo);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
  });

  it("isolates the first ticket chat too, because a chat run can write files", async () => {
    const itemId = genericTicket();
    const { request } = await run(itemId, { purpose: "conversation" });
    expect(request.workdir).not.toBe(repo);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
  });

  it("reuses the same worktree for the next run of the ticket", async () => {
    const itemId = genericTicket();
    const first = await run(itemId);
    db.prepare("UPDATE items SET stage='active' WHERE id=?").run(itemId);
    const second = await run(itemId);
    expect(second.request.workdir).toBe(first.request.workdir);
    expect(listWorkspaces(db, { ownerItemId: itemId }).filter((w) => w.mode === "isolated")).toHaveLength(1);
  });

  it("starts in the matching subdirectory of the worktree when the workdir is inside the repository", async () => {
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    writeFileSync(join(repo, "packages", "app", "index.ts"), "export {};\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "app");
    const itemId = genericTicket(join(repo, "packages", "app"));
    const { runId, request } = await run(itemId);
    const workspace = getWorkspace(db, getRun(db, runId)!.workspace_id!)!;
    expect(request.workdir).toBe(join(workspace.path, "packages", "app"));
    expect(readFileSync(join(request.workdir, "source.txt"), "utf8")).toBe("child change\n");
    expect(existsSync(join(repo, "packages", "app", "source.txt"))).toBe(false);
  });

  it("tries again with a new worktree after the first one could not be created", async () => {
    const itemId = genericTicket();
    // <repo>.plc-workspaces 不能写：git 建了分支，却建不了 worktree 的目录。
    const container = `${realpathSync(repo)}.plc-workspaces`;
    mkdirSync(container);
    chmodSync(container, 0o500);
    try {
      await expect(run(itemId)).rejects.toThrow(/workspace provisioning failed/);
    } finally {
      chmodSync(container, 0o700);
    }
    const failed = listWorkspaces(db, { ownerItemId: itemId }).find((w) => w.mode === "isolated")!;
    expect(failed.state).toBe("failed");
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");

    db.prepare("UPDATE items SET stage='ready' WHERE id=?").run(itemId);
    const { request } = await run(itemId);
    expect(request.workdir.startsWith(container)).toBe(true);
    expect(getWorkspace(db, failed.id)?.state).toBe("archived");
    expect(git(repo, "branch", "--list", failed.branch!)).toBe("");
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
  });

  // 审查 2026-10-19 第 1 条：workdir 是仓库里没有跟踪的目录时，worktree 里只建出一个空目录。
  it("refuses a workdir that is an untracked directory with files, and leaves the user's checkout alone", async () => {
    const sandbox = join(repo, ".scratch", "task");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "input.md"), "material the Lead put here\n");
    const itemId = genericTicket(sandbox);
    await expect(run(itemId)).rejects.toThrow(/not in its HEAD/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
    expect(listWorkspaces(db, { ownerItemId: itemId }).filter((w) => w.mode === "isolated")).toHaveLength(0);
    expect(readFileSync(join(sandbox, "input.md"), "utf8")).toBe("material the Lead put here\n");
    expect(decisions(itemId).at(-1)).toMatchObject({ mode: "unavailable", refusal: expect.stringContaining(".scratch/task") });
  });

  it("isolates a workdir that does not exist yet: the child creates it in the worktree", async () => {
    const itemId = genericTicket(join(repo, "packages", "new-package"));
    const { request } = await run(itemId);
    expect(request.workdir.startsWith(`${realpathSync(repo)}.plc-workspaces`)).toBe(true);
    expect(request.workdir.endsWith(join("packages", "new-package"))).toBe(true);
    expect(existsSync(join(repo, "packages", "new-package"))).toBe(false);
  });

  it("keeps a directory that is not a git repository shared, and records why", async () => {
    const plain = tempDir("plc-not-git-");
    const itemId = genericTicket(plain);
    const { request } = await run(itemId);
    expect(request.workdir).toBe(plain);
    expect(getItem(db, itemId)?.workflow_kind).toBe("generic");
    expect(decisions(itemId).at(-1)).toMatchObject({ coding: false, mode: "shared", facts: { gitRepository: null } });
  });
});

describe("Lead asks for the shared checkout", () => {
  it("needs a reason, and the reason stays on the ticket", async () => {
    const itemId = genericTicket();
    expect(() => requestSharedWorkspace(db, { itemId, reason: "  ", actor: "lead" })).toThrow(/reason/);
    const workspace = requestSharedWorkspace(db, {
      itemId, reason: "the fix must build on the user's uncommitted change in source.txt", actor: "lead",
    });
    expect(workspace).toMatchObject({ mode: "shared", path: repo });
    const { request } = await run(itemId);
    expect(request.workdir).toBe(repo);
    expect(decisions(itemId).at(-1)).toMatchObject({
      coding: true, mode: "shared", workspaceId: workspace.id,
      sharedReason: "the fix must build on the user's uncommitted change in source.txt",
    });
  });

  it("is refused for the repository the daemon itself is deployed from", async () => {
    setDeploymentRepositoriesForTesting([repo]);
    const itemId = genericTicket();
    expect(() => requestSharedWorkspace(db, { itemId, reason: "uses local edits", actor: "lead" }))
      .toThrow(/deploy/);
    const { request } = await run(itemId);
    expect(request.workdir).not.toBe(repo);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
  });
});

describe("pull request review", () => {
  let origin: string;
  let prHead: string;

  beforeEach(() => {
    // 远端仓库带一个 GitHub 形式的 PR 引用 refs/pull/7/head。用户的工作副本是它的 clone，停在 main 上，有一处没提交的改动。
    const upstream = join(dir, "upstream");
    initRepo(upstream);
    git(upstream, "checkout", "-qb", "feature");
    writeFileSync(join(upstream, "source.txt"), "pr change\n");
    git(upstream, "commit", "-qam", "pr");
    prHead = git(upstream, "rev-parse", "HEAD");
    git(upstream, "update-ref", "refs/pull/7/head", prHead);
    git(upstream, "checkout", "-q", "main");
    origin = join(dir, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", upstream, origin]);
    git(origin, "update-ref", "refs/pull/7/head", prHead);
    repo = join(dir, "working-copy");
    execFileSync("git", ["clone", "-q", origin, repo]);
    git(repo, "config", "user.email", "test@example.test");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "notes.txt"), "the user's own work in progress\n");
  });

  function assertWorkingCopyUntouched(): void {
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("the user's own work in progress\n");
    expect(git(repo, "branch", "--list")).toBe("* main");
    expect(git(repo, "for-each-ref", "refs/plc")).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  }

  for (const fail of [false, true]) it(`checks out the PR head in a temporary worktree and removes it when the run ${fail ? "fails" : "ends"}`, async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, actor: "lead" });
    const { runId, request } = await run(itemId, { fail });

    expect(request.workdir).not.toBe(repo);
    expect(request.head).toBe(prHead);
    expect(existsSync(request.workdir)).toBe(false);
    const workspace = getWorkspace(db, getRun(db, runId)!.workspace_id!)!;
    expect(workspace).toMatchObject({ kind: "experiment", state: "archived" });
    assertWorkingCopyUntouched();
    expect(decisions(itemId).at(-1)).toMatchObject({ mode: "pull_request", pullRequest: { number: 7, remote: "origin" } });
  });

  // 审查 2026-10-19 第 3 条：以前检出完成后才绑定 Run，这段时间里清理扫描会把检出删掉。daemon 启动后的第一拍就扫描。
  it("keeps a checkout that is still being prepared when the sweep runs in the middle", async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, actor: "lead" });
    const preparation = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" });
    const runId = createRun(db, { itemId, role: "executor", runtime: "codex", purpose: "execution" });
    const pending = preparation.checkout!(runId);
    // fetch 还没完成：行已经建好，并且绑在这个 Run 上。
    expect(getRun(db, runId)!.workspace_id).not.toBeNull();
    expect(sweepWorkspaces(db, new Date())).toMatchObject({ cleaned: 0, failed: [] });
    const workspace = await pending;
    expect(workspace.state).toBe("active");
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(prHead);
  });

  it("removes refs/plc/review refs that no checkout owns, as after a crash between the fetch and the checkout", async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, actor: "lead" });
    await run(itemId);
    git(repo, "update-ref", "refs/plc/review/item-9-dead", "HEAD");
    expect(sweepWorkspaces(db, new Date())).toMatchObject({ failed: [] });
    expect(git(repo, "for-each-ref", "refs/plc")).toBe("");
  });

  // 审查 2026-10-19 第 6 条：PR 工单的核查者以前看的是用户的 checkout，结论针对 main，不针对 PR head。
  it("gives the reviewer of a pull request ticket its own checkout of the PR head", async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, actor: "lead" });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const seen: Array<RuntimeStartRequest & { head: string }> = [];
    const { runId } = await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, prompt: "review", sessionDir: join(dir, "sessions", "review"),
      role: "reviewer", runtime: writingRuntime(seen),
    });
    expect(seen[0]!.workdir).not.toBe(repo);
    expect(seen[0]!.head).toBe(prHead);
    expect(getWorkspace(db, getRun(db, runId)!.workspace_id!)).toMatchObject({ kind: "experiment", state: "archived" });
    assertWorkingCopyUntouched();
  });
});

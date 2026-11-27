// 编码工单默认用隔离 worktree（2026-10-19 用户决定）。
// 以前 52 个 workspace 全是 shared/primary：Lead 不把工单标成 coding、也不调 provision_workspace，
// child 就直接在用户的 checkout 里改代码（#89、#92、#93、#95 改的是线上部署目录）。
// 现在由系统按事实判定：工作目录在 git 仓库里，并且这次 Run 会写文件。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { addActivity, createItem, createRun, getItem, getRun, getWorkspace, listActivities, listWorkspaces } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { AgentRuntime, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { runItem } from "../src/children/manager.js";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import {
  prepareRunWorkspace, requestSharedWorkspace, setDeploymentRepositoriesForTesting, setPullRequestReviewTarget,
} from "../src/coordinator/workspace-policy.js";
import { sweepWorkspaces } from "../src/coordinator/workspace.js";
import { awaitWorktreeDependencies, forgetWorktreeDependenciesForTests } from "../src/coordinator/worktree-dependencies.js";
import { forgetGitFacts, setGitFactsLog } from "../src/coordinator/git-facts.js";
import { parseRepositorySpec, recordTicketRepository, startRepositoryClone } from "../src/coordinator/repository-checkout.js";

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

  // 回归 2026-11-03：认领在 SQLite 事务里同步跑 git（工作区判定），负载高时一个 git 几秒，daemon 停住、网页断线。
  it("does not run git while claiming: it looks the facts up in the background and claims on a later tick", async () => {
    const itemId = genericTicket();
    forgetGitFacts();
    const synchronous: string[] = [];
    setGitFactsLog((line) => synchronous.push(line));
    try {
      const dispatcher = createDispatcher(db, { asyncWorkspaceFacts: true });
      dispatcher.request({ itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "k" });
      expect(dispatcher.claimNext()).toBeNull();
      let claim: ReturnType<typeof dispatcher.claimNext> = null;
      await vi.waitFor(() => {
        claim ??= dispatcher.claimNext();
        expect(claim).not.toBeNull();
      }, { timeout: 10_000 });
      expect(synchronous).toEqual([]);
      const bound = getRun(db, claim!.runId)!.workspace_id;
      expect(bound === null || getWorkspace(db, bound)!.mode === "isolated").toBe(true);
    } finally {
      setGitFactsLog(null);
    }
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

// 2026-11-03：一张大仓库（6,863 个文件）工单开跑时，git worktree add 在 daemon 的主线程上同步跑了约 19 秒。
// 这段时间 Slack 收不到 pong，判定连接已断；Companion 网页端也掉线重连；Lead 的 spawn_child 一直等着。
// 2026-11-25：#465 的执行者等了 6 分钟以上的依赖克隆，一行都没开始做。现在建好 worktree 就启动，提示里写依赖状态。
describe("the executor does not wait for dependencies", () => {
  const savedBunInstall = process.env.BUN_INSTALL;
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
    forgetWorktreeDependenciesForTests();
  });

  function bunRepo(body: string): string {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", private: true }));
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "bun project");
    const home = join(dir, "bun-home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "bun"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(home, "bin", "bun"), 0o755);
    process.env.BUN_INSTALL = home;
    return home;
  }

  it("starts the runtime while bun install is still running, and tells the executor how to wait", async () => {
    const gate = join(dir, "gate");
    bunRepo(`while [ ! -e ${gate} ]; do sleep 0.05; done\nmkdir -p node_modules/from-bun`);
    const itemId = genericTicket();
    // 以前 runItem 会等依赖准备完才启动 runtime：bun 在等 gate，这一行就永远不返回。
    const { request } = await run(itemId);
    expect(request.prompt).toContain("still being prepared in the background");
    expect(request.prompt).toContain("git rev-parse --git-path plc-deps-status");
    expect(request.prompt).toContain("install them here yourself");
    expect(request.prompt).not.toContain("are not installed in this worktree");
    writeFileSync(gate, "");
    const result = await awaitWorktreeDependencies(request.workdir);
    expect(result?.installedWith).toContain("bun install --frozen-lockfile");
    const statusFile = join(git(request.workdir, "rev-parse", "--absolute-git-dir"), "plc-deps-status");
    expect(readFileSync(statusFile, "utf8")).toMatch(/^ready: installed with bun install/);
  }, 30_000);

  // #499：依赖按 worktree 起点的锁文件装；执行者合并别的分支后锁文件变了，node_modules 就旧了（#498 缺 claude-agent-sdk）。
  it("tells the executor to install again from the lockfile after a merge changes it, rather than patching single packages", async () => {
    bunRepo("mkdir -p node_modules/from-bun");
    const itemId = genericTicket();
    const first = await run(itemId);
    await awaitWorktreeDependencies(first.request.workdir);
    const second = await run(itemId);
    expect(second.request.prompt).toContain("Dependencies are ready (installed with `bun install");
    expect(second.request.prompt).toContain("If you merge or rebase and the lockfile changes");
    // bun 没有 rebuild 命令：给的是它自己的安装命令，不是 npm 的。
    expect(second.request.prompt).toContain("run `bun install --frozen-lockfile --ignore-scripts` again");
    expect(second.request.prompt).not.toContain("npm rebuild");
  }, 30_000);

  // #502：执行者照提示重装以后 better-sqlite3 也要能用。提示给的是一条完整命令（安装加补编译），
  // 而且在「还在准备」「装失败」「没准备」这些要自己装的地方都一样，不只在锁文件变了的那一句里。
  describe("the reinstall command in an npm repository that uses better-sqlite3", () => {
    const savedPath = process.env.PATH;
    afterEach(() => { process.env.PATH = savedPath; });
    const COMMAND = "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund && npm rebuild better-sqlite3";

    function npmRepo(npmBody: string): void {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", private: true }));
      writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/better-sqlite3": { version: "1.0.0" } } }));
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "npm project");
      const bin = join(dir, "npm-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "npm"), `#!/bin/sh\n${npmBody}\n`);
      chmodSync(join(bin, "npm"), 0o755);
      process.env.PATH = `${bin}:${process.env.PATH}`;
    }

    it("gives one command that installs and rebuilds while the dependencies are still being prepared", async () => {
      const gate = join(dir, "npm-gate");
      npmRepo(`while [ ! -e ${gate} ]; do sleep 0.05; done\nmkdir -p node_modules/from-npm`);
      const itemId = genericTicket();
      const { request } = await run(itemId);
      expect(request.prompt).toContain("still being prepared in the background");
      // 只在 failed:/none: 时才自己装；daemon 还在写 node_modules，所以这时不提「锁文件变了就重装」（PR #85 评审第 1 条）。
      expect(request.prompt).toContain(`If it starts with "failed:" or "none:", install them here yourself with \`${COMMAND}\``);
      expect(request.prompt).not.toContain("If you merge or rebase and the lockfile changes");
      writeFileSync(gate, "");
      await awaitWorktreeDependencies(request.workdir);
      // daemon 装完以后才给重装的建议，用同一条完整命令。
      const after = await run(itemId);
      expect(after.request.prompt).toContain("Dependencies are ready");
      expect(after.request.prompt).toContain(`run \`${COMMAND}\` again`);
    }, 30_000);

    it("gives the same command when the background preparation failed", async () => {
      npmRepo("exit 1");
      const itemId = genericTicket();
      const first = await run(itemId);
      await awaitWorktreeDependencies(first.request.workdir);
      const { request } = await run(itemId);
      expect(request.prompt).toContain(`install them here yourself with \`${COMMAND}\``);
    }, 30_000);
  });

  it("tells the executor to install the dependencies itself when the preparation already failed", async () => {
    bunRepo("exit 1");
    const itemId = genericTicket();
    const first = await run(itemId);
    await awaitWorktreeDependencies(first.request.workdir);
    // 同一张工单的下一个 Run 复用 worktree，这时准备已经做完：提示写结果，不再写「还在准备」。
    const second = await run(itemId);
    expect(second.request.prompt).toContain("Dependencies were not prepared");
    expect(second.request.prompt).toContain("install them here yourself");
    expect(second.request.prompt).not.toContain("still being prepared");
  }, 30_000);

  // PR #85 评审第 1 条（2026-11-26）：等待命令超时就让执行者自己装，daemon 却还在往同一个 node_modules 里写。
  // 现在只有 daemon 写：准备没做完时，等待命令输出的是「再等一轮」，只有 failed:/none: 才让执行者自己装。
  it("never tells the executor to install while the daemon is still writing node_modules", async () => {
    const gate = join(dir, "gate");
    bunRepo(`while [ ! -e ${gate} ]; do sleep 0.05; done\nmkdir -p node_modules/from-bun`);
    const itemId = genericTicket();
    const { request } = await run(itemId);
    const prompt = request.prompt;
    // 提示里的等待命令，只把等的时间缩短。
    const command = /wait for them with this command: `([^`]+)`/.exec(prompt)?.[1];
    expect(command).toBeTruthy();
    const quick = command!.replace("seq 1 300", "seq 1 2").replace("sleep 2", "sleep 0.1");
    const wait = (): string => execFileSync("bash", ["-c", quick], { cwd: request.workdir, encoding: "utf8" }).trim();

    // bun 还在装（卡在 gate 上）：等待命令超时。它的输出不能是让执行者自己装的那几种。
    const stillRunning = wait();
    expect(stillRunning).toMatch(/^waiting:/);
    expect(stillRunning).toMatch(/Run this same command again/);
    expect(stillRunning).not.toMatch(/^(failed|none|timed out):/);
    expect(existsSync(join(request.workdir, "node_modules", "from-bun"))).toBe(false);
    // 提示只在 failed:/none: 时让执行者自己装；waiting 时让它再等，等了很久就报阻塞，不去装。
    expect(prompt).toMatch(/If it starts with "failed:" or "none:", install them here yourself/);
    expect(prompt).toMatch(/If it starts with "waiting:".*do not install/s);
    expect(prompt).toContain("ticket_update");
    expect(prompt).not.toMatch(/"timed out:"/);

    writeFileSync(gate, "");
    await awaitWorktreeDependencies(request.workdir);
    expect(wait()).toMatch(/^ready: installed with bun install/);
  }, 30_000);

  // PR #85 评审第 3 条：daemon 重启后内存里没有记录，但状态文件还在，提示要照它写。
  it("tells the executor the dependencies are ready after a daemon restart, from the status file", async () => {
    bunRepo("mkdir -p node_modules/from-bun");
    const itemId = genericTicket();
    const first = await run(itemId);
    await awaitWorktreeDependencies(first.request.workdir);
    forgetWorktreeDependenciesForTests(); // daemon 重启：pending / settled 都空了
    const second = await run(itemId);
    expect(second.request.prompt).toContain("Dependencies are ready");
    expect(second.request.prompt).toContain("installed with bun install");
    expect(second.request.prompt).not.toContain("are not installed in this worktree");
  }, 30_000);

  // PR #85 评审第 3 条：没有可克隆的依赖时，提示要带包管理器装失败的原因。
  it("gives the reason the package manager failed when nothing could be prepared", async () => {
    bunRepo("echo 'registry unreachable' >&2\nexit 1");
    const itemId = genericTicket();
    const first = await run(itemId);
    await awaitWorktreeDependencies(first.request.workdir);
    const second = await run(itemId);
    expect(second.request.prompt).toContain("Dependencies were not prepared");
    expect(second.request.prompt).toContain("installing with the package manager did not work");
    expect(second.request.prompt).toContain("registry unreachable");
  }, 30_000);
});

describe("preparing a new worktree does not stop the daemon", () => {
  let savedPath: string | undefined;
  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
  });

  // PATH 上放一个 git 替身：git worktree add 先等一下，像大仓库的检出；别的命令直接交给真的 git。
  // wait 是秒数，或者一个文件：等到测试写出这个文件（最多 10 秒）。
  function slowWorktreeAdd(wait: number | string): void {
    const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(dir, "slow-git-bin");
    mkdirSync(bin, { recursive: true });
    const pause = typeof wait === "number"
      ? `sleep ${wait}`
      : `n=0; while [ ! -f "${wait}" ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done`;
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      `case " $* " in *" worktree add "*) ${pause} ;; esac`,
      `exec "${real}" "$@"`,
      "",
    ].join("\n"));
    chmodSync(join(bin, "git"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  }

  it("creates the Run at once and builds the worktree while the daemon keeps working", async () => {
    // 检出等一个文件，文件由这个进程的定时器写：事件循环停住时（以前的同步检出）它写不出来，检出要等满 10 秒。
    const release = join(dir, "release-worktree-add");
    slowWorktreeAdd(release);
    const itemId = genericTicket();
    const pending = run(itemId);
    // runItem 同步做完的部分（spawn_child 等的就是它）里已经有 Run，还没有检出。
    const [created] = db.prepare("SELECT id FROM runs WHERE item_id=?").all(itemId) as Array<{ id: number }>;
    expect(created).toBeDefined();
    expect(listWorkspaces(db, { ownerItemId: itemId }).some((w) => w.mode === "isolated" && w.state === "active")).toBe(false);
    setTimeout(() => writeFileSync(release, ""), 50);
    const { runId, request } = await pending;
    expect(runId).toBe(created!.id);
    const workspace = getWorkspace(db, getRun(db, runId)!.workspace_id!)!;
    expect(workspace).toMatchObject({ mode: "isolated", state: "active", path: request.workdir });
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("base\n");
  });

  // 子工单和父工单的 workdir 相同时用同一个 worktree（设计 §4 第 2 行）。检出不再挡住别的事以后，Lead 一口气派出的两张
  // 工单会同时准备它：后一个不能把前一个正在建的 worktree 当成失败。
  it("lets two tickets that share one worktree start together", async () => {
    slowWorktreeAdd(0.8);
    const parent = genericTicket();
    const child = createItem(db, { title: "part", brief: "b", createdBy: "lead", workdir: repo, parentItemId: parent });
    const [first, second] = await Promise.all([run(parent), run(child)]);
    expect(second.request.workdir).toBe(first.request.workdir);
    const isolated = listWorkspaces(db, { ownerItemId: parent }).filter((w) => w.mode === "isolated");
    expect(isolated).toHaveLength(1);
    expect(isolated[0]!.state).not.toBe("failed");
  });
});

// 2026-11-03：建单不再等 clone。工单写明的仓库本机还没有时，执行者的 Run 开跑前等后台的 clone，再从它切隔离 worktree。
describe("a ticket whose repository is not on this Mac yet", () => {
  let home: string;
  let saved: { home?: string; gitConfig?: string };
  beforeEach(() => {
    home = join(dir, "home");
    saved = { home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL };
    process.env.HOME = home;
  });
  afterEach(() => {
    for (const [key, value] of [["HOME", saved.home], ["GIT_CONFIG_GLOBAL", saved.gitConfig]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // 一个本地的 bare 仓库，假装是 https://github.com/acme/demo：git 的 insteadOf 把地址换成它。
  function fakeGithub(): void {
    const bare = join(dir, "github", "acme", "demo.git");
    mkdirSync(join(dir, "github", "acme"), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
    const config = join(dir, "gitconfig");
    writeFileSync(config, `[url "${join(dir, "github", "acme")}/"]\n\tinsteadOf = https://github.com/acme/\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
  }

  function ticketFor(path: string): number {
    const itemId = createItem(db, { title: "bump the base image", brief: "b", createdBy: "lead", workdir: path });
    recordTicketRepository(db, itemId, parseRepositorySpec("acme/demo")!, { path, cloned: true, cloning: true });
    return itemId;
  }

  it("starts the run after the background clone, in a worktree of the clone", async () => {
    fakeGithub();
    const started = await startRepositoryClone(db, parseRepositorySpec("acme/demo")!);
    const itemId = ticketFor(started.path);
    const { request } = await run(itemId);
    expect(started.path).toBe(join(home, "Workspace", "acme", "demo"));
    expect(request.workdir.startsWith(`${realpathSync(started.path)}.plc-workspaces`)).toBe(true);
    expect(readFileSync(join(started.path, "source.txt"), "utf8")).toBe("base\n");
    expect(decisions(itemId).at(-1)).toMatchObject({ coding: true, mode: "isolated", facts: { gitRepository: realpathSync(started.path) } });
  });

  it("clones again before the run when the background clone was lost, as after a daemon restart", async () => {
    fakeGithub();
    const path = join(home, "Workspace", "acme", "demo");
    const itemId = ticketFor(path);
    const { request } = await run(itemId);
    expect(existsSync(join(path, "source.txt"))).toBe(true);
    expect(request.workdir.startsWith(`${realpathSync(path)}.plc-workspaces`)).toBe(true);
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
    expect(await sweepWorkspaces(db, new Date())).toMatchObject({ cleaned: 0, failed: [] });
    const workspace = await pending;
    expect(workspace.state).toBe("active");
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(prHead);
  });

  it("removes refs/plc/review refs that no checkout owns, as after a crash between the fetch and the checkout", async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, actor: "lead" });
    await run(itemId);
    git(repo, "update-ref", "refs/plc/review/item-9-dead", "HEAD");
    expect(await sweepWorkspaces(db, new Date())).toMatchObject({ failed: [] });
    expect(git(repo, "for-each-ref", "refs/plc")).toBe("");
  });

  // 工单 #212：fetch 写死了 origin。用户的仓库里 PR 所在的远端不叫 origin（公开仓库只推快照，远端另有名字），
  // 三张评审单一开跑就记成了宿主的未捕获异常。远端的地址写成 GitHub 的样子，insteadOf 把它改写到本地的裸仓库。
  function renameOriginTo(name: string, address: string): void {
    git(repo, "remote", "rename", "origin", name);
    git(repo, "remote", "set-url", name, address);
    git(repo, "config", `url.${origin}.insteadOf`, address);
  }

  function addDecoyRemote(name: string, address: string): void {
    const decoy = join(dir, `${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", decoy]);
    git(repo, "remote", "add", name, address);
    git(repo, "config", `url.${decoy}.insteadOf`, address);
  }

  function blockers(itemId: number): Array<Record<string, unknown>> {
    return (db.prepare("SELECT payload FROM inbox WHERE item_id=?").all(itemId) as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  }

  it("fetches from the remote that points at the PR's repository when it is not named origin, as for #208", async () => {
    renameOriginTo("public", "https://github.com/acme/x.git");
    addDecoyRemote("fork", "https://github.com/alice/x.git");
    const itemId = genericTicket(repo);
    // 和 #208 一样的记录：PR 评审模板记下 acme/x#7，以前的建单在没指定远端时也记成 origin。
    addActivity(db, { itemId, actor: "lead", kind: "decision", payload: { decision: "ticket_template", template: "pr_review", pr: "acme/x#7" } });
    addActivity(db, { itemId, actor: "lead", kind: "decision", payload: { decision: "workspace_pull_request_target", number: 7, remote: "origin" } });

    const { runId, request } = await run(itemId);

    expect(request.head).toBe(prHead);
    expect(getRun(db, runId)).toMatchObject({ state: "finished", error_code: null });
    assertWorkingCopyUntouched();
    expect(decisions(itemId).at(-1)).toMatchObject({ mode: "pull_request", pullRequest: { number: 7, remote: "public" } });
  });

  it("uses the remote that the ticket names in pull_request_remote", async () => {
    renameOriginTo("public", "https://github.com/acme/x.git");
    addDecoyRemote("upstream", "https://github.com/acme/x-mirror.git");
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, remote: "public", actor: "lead" });

    const { request } = await run(itemId);

    expect(request.head).toBe(prHead);
    expect(decisions(itemId).at(-1)).toMatchObject({ pullRequest: { number: 7, remote: "public" } });
  });

  it("fails the run with a reason a person can act on when no remote points at the PR's repository", async () => {
    renameOriginTo("public", "https://github.com/acme/snapshot.git");
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, repository: "acme/x", actor: "lead" });
    const seen: Array<RuntimeStartRequest & { head: string }> = [];

    await expect(runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, prompt: "do it", sessionDir: join(dir, "sessions", "missing-remote"),
      runtime: writingRuntime(seen),
    })).rejects.toThrow(/没有指向 github\.com\/acme\/x 的 git 远端/);

    expect(seen).toHaveLength(0);
    const failed = db.prepare("SELECT * FROM runs WHERE item_id=?").get(itemId) as Record<string, unknown>;
    expect(failed).toMatchObject({ state: "failed", error_code: "workspace_setup_failed", failure_code: "workspace_setup_failed" });
    expect(String(failed.error_message)).toContain("现有的远端：public（github.com/acme/snapshot）");
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    const [blocker] = blockers(itemId);
    expect(blocker).toMatchObject({ blockerCode: "workspace_setup_failed", title: "PR #7 检出失败：没有指向 github.com/acme/x 的远端" });
    expect(String(blocker!.nextStep)).toContain(`git -C ${realpathSync(repo)} remote add <远端名> https://github.com/acme/x.git`);
    expect(blockers(itemId).some((payload) => payload.blockerCode === "unhandled_run_exception")).toBe(false);
    assertWorkingCopyUntouched();
  });

  it("names the missing remote when pull_request_remote names one the repository does not have", async () => {
    const itemId = genericTicket(repo);
    setPullRequestReviewTarget(db, { itemId, number: 7, remote: "public", actor: "lead" });

    await expect(run(itemId)).rejects.toThrow(/没有名为 public 的 git 远端/);

    expect(db.prepare("SELECT error_code FROM runs WHERE item_id=?").get(itemId)).toEqual({ error_code: "workspace_setup_failed" });
    expect(blockers(itemId)[0]).toMatchObject({ title: "PR #7 检出失败：没有远端 public" });
    assertWorkingCopyUntouched();
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

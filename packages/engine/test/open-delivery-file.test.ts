// 打开交付里的文件（工单 07，spec 5.4、D7）：网页从 http://localhost 打开，浏览器拦住 file:// 链接，所以由 daemon 在这台 Mac 上
// 用默认程序打开。这里用真的 git 仓库和假的 opener 测操作 open_delivery_file 的边界：
//   - 路径要在交付快照里，拒绝 ..、绝对路径、反斜杠、控制字符和 .git；指到工作区外面的符号链接、可能含密钥的文件不打开。
//   - 先找工作区，合并并清理以后找仓库里合并后的那份，两处都没有时说清楚。
//   - 交给 opener 的是 realpath 以后的绝对路径。只有白名单里的文档、图片、源码用默认程序打开，其余用文本编辑器打开；
//     agent 自己报的文件列表、还有 Run 在跑的工作区，也一律用文本编辑器打开。家目录这么大的根目录不打开。
//   - 只在这台电脑上：页面要从回环地址来。不是 macOS 时说不支持。
//   - 只属于你（审查 H1）：Lead 只能在你这一轮里代你打开，不能被事件叫醒以后自己打开。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createLoopbackBinding, createRun, createTurn, getItem, insertOutcomeSnapshot, listActivities,
  normalizeOutcomePayload, openDb, updateRun, type Db,
} from "@pi-lead-child/store";
import { liveChildren } from "../src/children/manager.js";
import {
  DeliveryError, mergeDelivery, openDeliveryPullRequest, ticketDelivery, type PullRequestRunner,
} from "../src/coordinator/delivery.js";
import type { FileOpenApp, FileOpener } from "../src/coordinator/file-opener.js";
import { prepareRunWorkspace } from "../src/coordinator/workspace-policy.js";
import {
  listLeadTicketActions, listTicketActions, runTicketAction, TicketActionError, type TicketActionCaller,
} from "../src/ticket-actions/index.js";

let db: Db;
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = tempDir("plc-open-file-");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, ".env.local"), "TOKEN=do-not-open\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

// 页面上点的：你本人，从这台电脑的回环地址来。
const HERE: TicketActionCaller = {
  kind: "user", source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true },
};
// 手机上点的：同一个你，请求不是从回环地址来的。
const PHONE: TicketActionCaller = {
  kind: "user", source: { client: "phone", deviceName: "手机", loopback: false, fromThisMachine: false },
};

function fakeOpener(supported = true) {
  const calls: Array<{ path: string; app: FileOpenApp }> = [];
  const opener: FileOpener = {
    supported,
    async open(path, app) { calls.push({ path, app }); },
  };
  return { calls, host: { openFile: opener } };
}

// 一张交付了的写代码工单。write 在隔离 worktree 里写文件，然后提交，登记成果，工单进 review。
function deliveredCode(write: (worktree: string) => void = () => {}): { itemId: number; worktree: string } {
  const itemId = createItem(db, { title: "写方案", brief: "b", createdBy: "lead", workdir: repo });
  const workspace = prepareRunWorkspace(db, itemId, { role: "executor", purpose: "execution" }).workspace!;
  mkdirSync(join(workspace.path, "docs"));
  writeFileSync(join(workspace.path, "docs", "plan.md"), "# 方案\n");
  write(workspace.path);
  // --force：机器上全局的 gitignore 可能忽略 .env 一类的文件，这里要它们真的进交付。
  git(workspace.path, "add", "-A", "--force");
  git(workspace.path, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", "plan");
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "a".repeat(64),
    outcome: normalizeOutcomePayload({
      summary: "写了方案。", changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增" }], deliverables: [], validations: [],
    }, { workdir: workspace.path }),
    now: new Date(),
  });
  db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
  return { itemId, worktree: workspace.path };
}

function open(itemId: number, input: Record<string, unknown>, caller: TicketActionCaller, host: { openFile?: FileOpener }) {
  return runTicketAction(db, {
    itemId, action: "open_delivery_file", input, caller, host,
    ...(caller.kind === "lead" ? { reason: "用户说帮我打开方案" } : {}),
  });
}

async function refusal(promise: Promise<unknown>): Promise<Error & { code: string }> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error === null ? "opened" : "refused").toBe("refused");
  expect(error instanceof TicketActionError || error instanceof DeliveryError).toBe(true);
  return error as Error & { code: string };
}

async function listed(itemId: number, host: { openFile?: FileOpener }, local: boolean) {
  return (await listTicketActions(db, itemId, { host, local })).find((action) => action.id === "open_delivery_file")!;
}

describe("opening a delivered file on this computer", () => {
  it("opens the copy in the workspace with its real absolute path, and records who opened it", async () => {
    const { itemId, worktree } = deliveredCode();
    const { calls, host } = fakeOpener();

    expect(await listed(itemId, host, true)).toMatchObject({
      available: true, reason: null, permission: "user_only", area: "delivery", external: false, irreversible: false,
    });
    const outcome = await open(itemId, { path: "docs/plan.md" }, HERE, host);

    expect(calls).toEqual([{ path: realpathSync(join(worktree, "docs", "plan.md")), app: "default" }]);
    expect(isAbsolute(calls[0]!.path)).toBe(true);
    expect(outcome.result).toEqual({ path: "docs/plan.md", sequence: 1, location: "workspace", app: "default" });
    const opened = listActivities(db, itemId).filter((activity) => JSON.parse(activity.payload).decision === "delivery_file_opened");
    expect(opened.map((activity) => ({ actor: activity.actor, payload: JSON.parse(activity.payload) }))).toEqual([{
      actor: "user",
      payload: {
        decision: "delivery_file_opened", path: "docs/plan.md", sequence: 1, location: "workspace", app: "default",
        reason: "用户在工单详情里点了这个文件",
      },
    }]);
  });

  it("refuses a path that is not in the delivery snapshot", async () => {
    const { itemId, worktree } = deliveredCode();
    writeFileSync(join(worktree, "later.md"), "交付以后才写的\n");
    const { calls, host } = fakeOpener();

    expect((await refusal(open(itemId, { path: "later.md" }, HERE, host))).message).toBe("这个文件不在这次交付里。");
    // README.md 在仓库里，但这次交付没有改它。
    expect((await refusal(open(itemId, { path: "README.md" }, HERE, host))).message).toBe("这个文件不在这次交付里。");
    expect((await refusal(open(itemId, { path: "docs/plan.md", sequence: 2 }, HERE, host))).code).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("refuses .., absolute paths, backslashes, control characters and .git before looking anywhere", async () => {
    const { itemId } = deliveredCode();
    const { calls, host } = fakeOpener();
    for (const path of [
      "../repo/README.md", "docs/../docs/plan.md", "docs/..", "/etc/passwd", join(repo, "README.md"), "docs\\plan.md",
      "docs/plan.md\u0000", "docs/\nplan.md", ".git/config", "docs/.GIT/config", "",
    ]) {
      const error = await refusal(open(itemId, { path }, HERE, host));
      expect({ path, code: error.code }).toEqual({ path, code: path ? "invalid_request" : "invalid_input" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a delivered symbolic link that points outside the workspace", async () => {
    writeFileSync(join(dir, "outside.txt"), "不属于这张工单\n");
    const { itemId } = deliveredCode((worktree) => {
      symlinkSync(join(dir, "outside.txt"), join(worktree, "docs", "absolute-link.md"));
      symlinkSync(relative(join(worktree, "docs"), join(dir, "outside.txt")), join(worktree, "docs", "relative-link.md"));
    });
    const { calls, host } = fakeOpener();

    expect((await ticketDelivery(db, itemId)).files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["docs/absolute-link.md", "docs/relative-link.md"]),
    );
    for (const path of ["docs/absolute-link.md", "docs/relative-link.md"]) {
      expect((await refusal(open(itemId, { path }, HERE, host))).message).toBe("这个文件是指到工作区外面的链接，不打开。");
    }
    expect(calls).toEqual([]);
  });

  it("does not open files that may hold secrets: by name, by the name before a rename, and by the file a link points to", async () => {
    const { itemId } = deliveredCode((worktree) => {
      writeFileSync(join(worktree, ".env"), "SECRET=1\n");
      mkdirSync(join(worktree, "keys"));
      writeFileSync(join(worktree, "keys", "deploy.pem"), "-----BEGIN-----\n");
      writeFileSync(join(worktree, "credentials.json"), "{}\n");
      git(worktree, "mv", ".env.local", "settings.txt");
      symlinkSync("../.env", join(worktree, "docs", "notes.md"));
    });
    const { calls, host } = fakeOpener();
    const files = (await ticketDelivery(db, itemId)).files;
    expect(files.find((file) => file.path === "settings.txt")).toMatchObject({ previousPath: ".env.local", status: "renamed" });

    for (const path of [".env", "keys/deploy.pem", "credentials.json", "settings.txt", "docs/notes.md"]) {
      expect({ path, message: (await refusal(open(itemId, { path }, HERE, host))).message })
        .toEqual({ path, message: "这个文件可能含密钥，不打开。" });
    }
    expect(calls).toEqual([]);
  });

  // 审查 M2：以前按黑名单认「会被当成程序运行的文件」，名单外的类型（.html 里的脚本、新的启动器）照样用默认程序打开。
  // 现在反过来：只有白名单里的类型用默认程序，其余一律用文本编辑器。有执行权限的文件不管扩展名，也用文本编辑器。
  it("opens only allow-listed types with the default program, and everything else with the text editor", async () => {
    const names = [
      "docs/plan.md", "src/app.ts", "assets/logo.png", "docs/report.pdf",
      "docs/page.html", "docs/page.htm", "assets/icon.svg", "tools/fetch.py", "tools/run.sh", "tools/launch.command",
      "docs/site.webloc", "Makefile", "tools/deploy.ts",
    ];
    const { itemId, worktree } = deliveredCode((worktree) => {
      for (const name of names) {
        mkdirSync(dirname(join(worktree, name)), { recursive: true });
        writeFileSync(join(worktree, name), "x\n");
      }
      // 白名单里的扩展名，但有执行权限。
      chmodSync(join(worktree, "tools", "deploy.ts"), 0o755);
    });
    const { calls, host } = fakeOpener();

    for (const path of names) await open(itemId, { path }, HERE, host);
    expect(calls.map((call) => [relative(realpathSync(worktree), call.path), call.app])).toEqual([
      ["docs/plan.md", "default"], ["src/app.ts", "default"], ["assets/logo.png", "default"], ["docs/report.pdf", "default"],
      ["docs/page.html", "text_editor"], ["docs/page.htm", "text_editor"], ["assets/icon.svg", "text_editor"],
      ["tools/fetch.py", "text_editor"], ["tools/run.sh", "text_editor"], ["tools/launch.command", "text_editor"],
      ["docs/site.webloc", "text_editor"], ["Makefile", "text_editor"], ["tools/deploy.ts", "text_editor"],
    ]);
  });

  // 审查 M1：执行 agent 还在工作区里跑时，检查和打开之间文件可能被换掉。这时一律用文本编辑器打开。
  it("opens with the text editor while a Run is still working in the workspace", async () => {
    const { itemId, worktree } = deliveredCode();
    const workspaceId = (db.prepare("SELECT id FROM workspaces WHERE owner_item_id=? AND kind='isolated_child'").get(itemId) as { id: number }).id;
    const { calls, host } = fakeOpener();
    await open(itemId, { path: "docs/plan.md" }, HERE, host);
    // 例如工单对话的 Run 还在这个工作区里跑。
    const running = createRun(db, { itemId, runtime: "claude", purpose: "conversation" });
    db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspaceId, running);
    updateRun(db, running, { state: "running" });
    await open(itemId, { path: "docs/plan.md" }, HERE, host);
    expect(calls).toEqual([
      { path: realpathSync(join(worktree, "docs", "plan.md")), app: "default" },
      { path: realpathSync(join(worktree, "docs", "plan.md")), app: "text_editor" },
    ]);
  });

  it("opens the merged copy in the repository after the workspace is cleaned", async () => {
    const { itemId, worktree } = deliveredCode();
    await mergeDelivery(db, itemId, {
      accept: () => { db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId); },
      reason: "用户在工单详情里点了「验收并合并」",
    });
    expect(existsSync(worktree)).toBe(false);
    const { calls, host } = fakeOpener();

    const outcome = await open(itemId, { path: "docs/plan.md" }, HERE, host);
    expect(calls).toEqual([{ path: realpathSync(join(repo, "docs", "plan.md")), app: "default" }]);
    expect(outcome.result).toMatchObject({ location: "repository" });

    // 合并以后你又把它删了：仓库里也没有，说清楚。
    rmSync(join(repo, "docs", "plan.md"));
    expect((await refusal(open(itemId, { path: "docs/plan.md" }, HERE, host))).message)
      .toBe("工作区已清理，仓库里也找不到合并后的这个文件，可能合并以后又改名或删掉了。");
    expect(calls).toHaveLength(1);
  });

  it("says the workspace was cleaned when the changes were never merged", async () => {
    const { itemId, worktree } = deliveredCode();
    await ticketDelivery(db, itemId);
    const workspaceId = (db.prepare("SELECT id FROM workspaces WHERE owner_item_id=? AND kind='isolated_child'").get(itemId) as { id: number }).id;
    git(repo, "worktree", "remove", "--force", worktree);
    db.prepare("UPDATE workspaces SET state='archived' WHERE id=?").run(workspaceId);
    const { calls, host } = fakeOpener();

    const reason = "工作区已清理，改动也没有合并进你的仓库，电脑上没有这些文件。";
    expect(await listed(itemId, host, true)).toMatchObject({ available: false, reason });
    const error = await refusal(open(itemId, { path: "docs/plan.md" }, HERE, host));
    expect({ code: error.code, message: error.message }).toEqual({ code: "unavailable", message: reason });
    expect(calls).toEqual([]);
  });

  it("opens the file in the user's own directory for a ticket without an isolated branch", async () => {
    const workdir = join(dir, "notes");
    mkdirSync(workdir);
    writeFileSync(join(workdir, "summary.md"), "# 总结\n");
    const itemId = createItem(db, { title: "整理笔记", brief: "b", createdBy: "lead", workdir });
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    insertOutcomeSnapshot(db, {
      itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "b".repeat(64),
      outcome: normalizeOutcomePayload({
        summary: "整理了。", changes: [{ kind: "file", ref: "summary.md", summary: "新增" }], deliverables: [], validations: [],
      }, { workdir }),
      now: new Date(),
    });
    db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
    const { calls, host } = fakeOpener();

    const outcome = await open(itemId, { path: "summary.md" }, HERE, host);
    // 文件列表是 agent 自己报的（source=agent），不是系统跑的 git diff：一律用文本编辑器打开（审查 M3）。
    expect(calls).toEqual([{ path: realpathSync(join(workdir, "summary.md")), app: "text_editor" }]);
    expect(outcome.result).toMatchObject({ location: "workdir", app: "text_editor" });
  });

  // 审查 M3：工单的目录是家目录（或者更上层）时，agent 报的任何路径都在「目录里面」，包含检查等于没有。这时不打开。
  it("refuses a root as wide as the home directory or above it", async () => {
    const home = join(dir, "home", "me");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "notes.md"), "# 笔记\n");
    vi.stubEnv("HOME", home);
    const { calls, host } = fakeOpener();
    const reason = "这张工单的目录是家目录或者更上层的目录，范围太大，不在这里打开文件。";
    for (const workdir of [home, join(dir, "home")]) {
      const itemId = createItem(db, { title: "整理笔记", brief: "b", createdBy: "lead", workdir });
      const runId = createRun(db, { itemId, runtime: "claude" });
      updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
      insertOutcomeSnapshot(db, {
        itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "c".repeat(64),
        outcome: normalizeOutcomePayload({
          summary: "整理了。", changes: [{ kind: "file", ref: "notes.md", summary: "改了" }], deliverables: [], validations: [],
        }, { workdir }),
        now: new Date(),
      });
      db.prepare("UPDATE items SET stage='review' WHERE id=?").run(itemId);
      expect(await listed(itemId, host, true)).toMatchObject({ available: false, reason });
      expect((await refusal(open(itemId, { path: "notes.md" }, HERE, host))).message).toBe(reason);
    }
    expect(calls).toEqual([]);
  });

  // 审查 M4：交付视图按「最近 200 条 decision」找合并和开 PR 的记录。每次打开文件都写一条 decision，
  // 打开 200 次以后，合并到哪里、PR 的链接就从交付视图上消失了。
  it("keeps where the change was merged and the PR link after the file is opened more than 200 times", async () => {
    execFileSync("git", ["init", "-q", "--bare", join(dir, "remote.git")]);
    git(repo, "remote", "add", "origin", join(dir, "remote.git"));
    git(repo, "push", "-q", "origin", "main");
    const { itemId } = deliveredCode();
    const gh: PullRequestRunner = { async gh() { return { ok: true, stdout: "https://github.com/acme/repo/pull/7\n", stderr: "" }; } };
    await openDeliveryPullRequest(db, itemId, { actor: "user", reason: "开 PR", runner: gh });
    await mergeDelivery(db, itemId, {
      accept: () => { db.prepare("UPDATE items SET stage='done' WHERE id=?").run(itemId); },
      reason: "用户在工单详情里点了「验收并合并」",
    });
    const { calls, host } = fakeOpener();

    for (let index = 0; index < 205; index += 1) await open(itemId, { path: "docs/plan.md" }, HERE, host);
    expect(calls).toHaveLength(205);
    expect((await ticketDelivery(db, itemId)).workspace).toMatchObject({
      integration: "merged", mergedInto: "main", pullRequestUrl: "https://github.com/acme/repo/pull/7",
    });
  });
});

describe("where opening a file is possible", () => {
  it("is only on this computer: a request that is not from loopback is refused with the same reason the listing gives", async () => {
    const { itemId } = deliveredCode();
    const { calls, host } = fakeOpener();

    const reason = "手机上不能打开文件，请在电脑上打开。";
    expect(await listed(itemId, host, false)).toMatchObject({ available: false, reason });
    expect((await refusal(open(itemId, { path: "docs/plan.md" }, PHONE, host))).message).toBe(reason);
    // 没有来源的调用（不知道从哪里来）同样拒绝。
    expect((await refusal(open(itemId, { path: "docs/plan.md" }, { kind: "user" }, host))).message).toBe(reason);
    expect(calls).toEqual([]);
  });

  it("says this computer is not supported when it is not macOS, and when nothing can open files here", async () => {
    const { itemId } = deliveredCode();
    const { calls, host } = fakeOpener(false);

    const reason = "这台电脑不支持用默认程序打开文件，只有 macOS 支持。";
    expect(await listed(itemId, host, true)).toMatchObject({ available: false, reason });
    expect((await refusal(open(itemId, { path: "docs/plan.md" }, HERE, host))).message).toBe(reason);
    expect(calls).toEqual([]);
    expect(await listed(itemId, {}, true)).toMatchObject({ available: false, reason: "这里没有接打开文件的程序，不能打开文件。" });
  });

  it("is not offered before anything is delivered", async () => {
    const itemId = createItem(db, { title: "待开始", brief: "b", createdBy: "lead" });
    const { host } = fakeOpener();
    expect(await listed(itemId, host, true)).toMatchObject({ available: false, reason: "还没有交付的文件。" });
  });

  it("does not hand the server's paths back when opening fails", async () => {
    const { itemId, worktree } = deliveredCode();
    const host = {
      openFile: {
        supported: true,
        async open(path: string) { throw new Error(`LSOpenURLsWithRole() failed for the file ${path}`); },
      } satisfies FileOpener,
    };
    const error = await refusal(open(itemId, { path: "docs/plan.md" }, HERE, host));
    expect(error.code).toBe("failed");
    expect(error.message).not.toContain(worktree);
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain("/");
  });

  // 审查 H1：内容可以经过事件进入 Lead 的上下文（例如 child 的成果说明）。Lead 被叫醒以后不能自己在你的 Mac 上打开文件。
  it("is the user's: Lead without the user's current turn is refused, and nothing is opened", async () => {
    const { itemId } = deliveredCode();
    const { calls, host } = fakeOpener();

    const actions = await listLeadTicketActions(db, itemId, { host, turnId: null });
    expect(actions.find((action) => action.id === "open_delivery_file")).toMatchObject({
      available: true, permission: "user_only", lead: "user_turn", leadReady: false,
    });
    const error = await refusal(open(itemId, { path: "docs/plan.md" }, { kind: "lead", turnId: null }, host));
    expect(error.code).toBe("needs_user_turn");
    expect(calls).toEqual([]);
    expect(listActivities(db, itemId).some((activity) => JSON.parse(activity.payload).decision === "delivery_file_opened")).toBe(false);
  });

  it("lets Lead open a file for the user in the user's current turn, recorded as Lead on the user's behalf", async () => {
    const { itemId, worktree } = deliveredCode();
    const { calls, host } = fakeOpener();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "turn-open", originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });

    const outcome = await open(itemId, { path: "docs/plan.md" }, { kind: "lead", turnId: turn.id }, host);
    expect(outcome).toMatchObject({ authority: "on_behalf", by: { actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: turn.id } } });
    expect(calls).toEqual([{ path: realpathSync(join(worktree, "docs", "plan.md")), app: "default" }]);
    const row = listActivities(db, itemId).find((activity) => JSON.parse(activity.payload).decision === "delivery_file_opened")!;
    expect(row.actor).toBe("lead");
    expect(JSON.parse(row.payload)).toMatchObject({ reason: "用户说帮我打开方案", onBehalfOf: "user", sourceTurnId: turn.id });
    expect(getItem(db, itemId)!.stage).toBe("review");
  });
});

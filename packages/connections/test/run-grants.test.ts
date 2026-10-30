// 连接中心按 Run 的权限清单放行（landing.md 第 5 节，C1）：带清单的 Run 只看得到、只调得动清单里的工具；
// 每次调用按参数检查，不在清单里的拒绝并记审计；本地仓库只能读清单里的仓库，并过禁止名单；
// 清单点名的写工具不看写入策略；写操作的参数里有凭据时拒绝。GitHub 是假的 MCP 服务器（testing/fake-github.ts）。
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { computeRunGrant, widenRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, type GrantLocalRepo, type GrantScope, type GrantIntent } from "@pi-lead-child/protocol";
import {
  applyRunGrantChange, createItem, createRun, getRunGrant, insertRunGrant, listRunToolCalls, openDb, type Db,
} from "@pi-lead-child/store";
import { ConnectionHub, type AgentConnectionWrite } from "../src/hub.js";
import { Vault } from "../src/vault.js";
import { FAKE_GH_TOKEN, FakeGithub } from "../testing/fake-github.js";

const PR = { owner: "Acme", repo: "x", number: 101 };
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " export { a };",
].join("\n");

let db: Db;
let gh: FakeGithub;
let repoRoot: string;
let dataDir: string;
let writes: AgentConnectionWrite[];

beforeEach(() => {
  const dir = tempDir("plc-grant-hub-");
  db = openDb(join(dir, "plc.db"));
  gh = new FakeGithub();
  gh.addPullRequest({ ...PR, title: "t", body: "b", headSha: "a".repeat(40), diff: DIFF });
  gh.addFile("Acme", "x", "src/a.ts", "const a = 1;\nconst b = 2;\nexport { a };");
  gh.addFile("Acme", "secret-repo", "README.md", "nope");
  repoRoot = join(dir, "repos", "x");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "a.ts"), "export const answer = 42;\n");
  writeFileSync(join(repoRoot, ".env"), "TOKEN=secret\n");
  writeFileSync(join(repoRoot, "server.log"), "request token\n");
  dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "notes.txt"), "private\n");
  symlinkSync(dataDir, join(repoRoot, "data-link"));
  writes = [];
});

async function connectedHub(): Promise<ConnectionHub> {
  const hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:1/oauth/callback",
    fetch: gh.fetch, gh: { token: async () => FAKE_GH_TOKEN }, ghInstalled: () => true,
    localDeniedRoots: [dataDir], onAgentWrite: (write) => writes.push(write),
  });
  await hub.start("github");
  return hub;
}

const LOCAL = (): GrantLocalRepo => ({ name: "x", root: repoRoot, github: "Acme/x" });

function grantedRun(intent: GrantIntent, scope: GrantScope): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "通道的工单", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  const { grant, dropped } = computeRunGrant({ intent, scope, resolveLocalRepo: (name) => name === "x" ? LOCAL() : null });
  insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS[intent], scope, dropped });
  return { itemId, runId };
}

const asRun = (runId: number) => ({ role: "executor" as const, runId });

describe("a run with a grant sees and calls only what the grant allows", () => {
  it("lists only the tools a rule allows, with the rule that allows each", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR, localRepos: ["x"] });
    const tools = await hub.searchTools("executor", {}, { runId });
    const names = tools.map((tool) => `${tool.connection}.${tool.name}`).sort();
    expect(names).toEqual([
      "github.add_comment_to_pending_review", "github.get_file_contents", "github.pull_request_read",
      "github.pull_request_review_write", "github.search_code",
      "local.list_dir", "local.read_file", "local.search",
    ]);
    expect(names).not.toContain("github.merge_pull_request");
    expect(tools.find((tool) => tool.name === "pull_request_review_write")?.allowedBy).toEqual(["只在 Acme/x#101 上发 COMMENT"]);
  });

  it("checks the arguments of every call and records refusals", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    const ok = await hub.callTool("github", "get_file_contents", { owner: "Acme", repo: "x", path: "src/a.ts" }, asRun(runId));
    expect(ok.text).toContain("const b = 2;");
    await expect(hub.callTool("github", "get_file_contents", { owner: "Acme", repo: "secret-repo", path: "README.md" }, asRun(runId)))
      .rejects.toMatchObject({ code: "grant_denied", message: expect.stringContaining("只能是 x") });
    await expect(hub.callTool("github", "merge_pull_request", { owner: "Acme", repo: "x", pullNumber: 101 }, asRun(runId)))
      .rejects.toMatchObject({ code: "grant_denied" });
    await expect(hub.callTool("github", "pull_request_review_write", { ...prArgs(), method: "create", event: "APPROVE", body: "lgtm" }, asRun(runId)))
      .rejects.toMatchObject({ code: "grant_denied", message: expect.stringContaining("event") });
    expect(gh.calls.map((call) => call.tool)).toEqual(["get_file_contents"]);
    const audit = listRunToolCalls(db, runId);
    expect(audit.map((call) => [call.tool, call.decision])).toEqual([
      ["get_file_contents", "allowed"], ["get_file_contents", "refused"], ["merge_pull_request", "refused"], ["pull_request_review_write", "refused"],
    ]);
    expect(audit[2]).toMatchObject({ access: "write", reason: "merge_pull_request 会写入 github，清单里没有这个写操作" });
  });

  it("scopes code search by the single repo: qualifier in the query", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    await expect(hub.callTool("github", "search_code", { query: "const repo:Acme/x" }, asRun(runId))).resolves.toMatchObject({ isError: false });
    for (const query of ["const", "const repo:Acme/secret-repo", "const repo:Acme/x org:Acme", "const repo:Acme/x repo:Acme/y"]) {
      await expect(hub.callTool("github", "search_code", { query }, asRun(runId))).rejects.toMatchObject({ code: "grant_denied" });
    }
  });

  it("posts a COMMENT review on the PR without asking, although the write policy is confirm", async () => {
    const hub = await connectedHub();
    expect(hub.get("github").writePolicy).toBe("confirm");
    const { runId, itemId } = grantedRun("code_review", { pullRequest: PR });
    await hub.callTool("github", "pull_request_review_write", { ...prArgs(), method: "create" }, asRun(runId));
    await hub.callTool("github", "add_comment_to_pending_review", { ...prArgs(), path: "src/a.ts", line: 2, side: "RIGHT", subjectType: "LINE", body: "nit" }, asRun(runId));
    await hub.callTool("github", "pull_request_review_write", { ...prArgs(), method: "submit_pending", event: "COMMENT", body: "看过了" }, asRun(runId));
    expect(gh.submitted("Acme", "x", 101)).toMatchObject([{ state: "COMMENTED", comments: [{ path: "src/a.ts", line: 2 }] }]);
    expect(writes.map((write) => write.description.summary)).toEqual([
      "在 Acme/x#101 上建了一个没提交的 review",
      "在 Acme/x#101 的 review 里加了一条行内评论（src/a.ts:2）",
      "在 Acme/x#101 上提交了 review（COMMENT）",
    ]);
    expect(writes[2]).toMatchObject({ runId, itemId, connection: "github", ruleId: "review:acme/x#101:comment", description: { url: "https://github.com/Acme/x/pull/101" } });
  });

  it("refuses a write that carries a credential, whatever the grant says", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    await hub.callTool("github", "pull_request_review_write", { ...prArgs(), method: "create" }, asRun(runId));
    await expect(hub.callTool("github", "pull_request_review_write", {
      ...prArgs(), method: "submit_pending", event: "COMMENT", body: `token ghp_${"a".repeat(36)}`,
    }, asRun(runId))).rejects.toMatchObject({ code: "grant_denied", message: expect.stringContaining("凭据") });
    expect(gh.submitted("Acme", "x", 101)).toEqual([]);
  });

  it("applies a widening on the next call, without restarting the run", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    const approveArgs = { ...prArgs(), method: "create", event: "APPROVE", body: "lgtm" };
    await expect(hub.callTool("github", "pull_request_review_write", approveArgs, asRun(runId))).rejects.toMatchObject({ code: "grant_denied" });
    const record = getRunGrant(db, runId)!;
    const widened = widenRunGrant(record.grant, { pullRequest: PR, reviewEvents: ["APPROVE"] }, () => null);
    applyRunGrantChange(db, { runId, expectedRevision: record.revision, grant: widened.grant, change: "widened", rules: widened.added, actor: "user" });
    // C2 的守卫要先读一次 PR（review 的是哪个提交）；这里只看清单放不放行。
    await hub.callTool("github", "pull_request_read", { ...prArgs(), method: "get" }, asRun(runId));
    const result = await hub.callTool("github", "pull_request_review_write", approveArgs, asRun(runId)).catch((error: Error) => error);
    expect(result instanceof Error ? result.message : "").not.toMatch(/清单/);
  });

  it("keeps the user's per-connection role settings", async () => {
    const hub = await connectedHub();
    hub.updateSettings("github", { roles: ["lead"] });
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    await expect(hub.callTool("github", "pull_request_read", { ...prArgs(), method: "get" }, asRun(runId))).rejects.toMatchObject({ code: "forbidden" });
    expect(await hub.searchTools("executor", {}, { runId })).toEqual([]);
  });

  it("leaves runs without a grant on the old rules", async () => {
    const hub = await connectedHub();
    const itemId = createItem(db, { title: "普通工单", brief: "b", createdBy: "user" });
    const runId = createRun(db, { itemId });
    await expect(hub.callTool("github", "merge_pull_request", prArgs(), asRun(runId))).rejects.toMatchObject({ code: "forbidden" });
    await expect(hub.callTool("local", "read_file", { repo: "x", path: "src/a.ts" }, asRun(runId))).rejects.toMatchObject({ code: "forbidden" });
    expect(listRunToolCalls(db, runId)).toEqual([]);
  });
});

describe("reading local repos through the hub", () => {
  it("reads only repos in the grant, and never the deny list, logs, or the assistant's data directory", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("knowledge", { localRepos: ["x"] });
    const read = await hub.callTool("local", "read_file", { repo: "x", path: "src/a.ts" }, asRun(runId));
    expect(read.text).toContain("export const answer = 42;");
    const listing = await hub.callTool("local", "list_dir", { repo: "x" }, asRun(runId));
    expect(listing.text).not.toMatch(/\.env|server\.log/);
    for (const path of [".env", "server.log", "data-link/notes.txt", "../x/src/a.ts", "/etc/passwd"]) {
      await expect(hub.callTool("local", "read_file", { repo: "x", path }, asRun(runId))).rejects.toMatchObject({ code: "grant_denied" });
    }
    await expect(hub.callTool("local", "read_file", { repo: "other", path: "a" }, asRun(runId))).rejects.toMatchObject({ code: "grant_denied" });
    // 读到的行记进这个 Run 的读取记录，出处按它核实。
    expect(hub.runReads(runId).content().files).toMatchObject([{ via: "local", repo: "x", path: "src/a.ts", lines: { 1: "export const answer = 42;" } }]);
    hub.releaseRun(runId);
    expect(hub.runReads(runId).content().files).toEqual([]);
  });

  it("records what a review read from GitHub: file lines, the PR head and the diff", async () => {
    const hub = await connectedHub();
    const { runId } = grantedRun("code_review", { pullRequest: PR });
    await hub.callTool("github", "pull_request_read", { ...prArgs(), method: "get" }, asRun(runId));
    await hub.callTool("github", "pull_request_read", { ...prArgs(), method: "get_diff" }, asRun(runId));
    const reads = hub.runReads(runId);
    expect(reads.records().map((record) => [record.tool, record.path, record.ref])).toEqual([
      ["pull_request_read", "pull/101/get", "a".repeat(40)],
      ["pull_request_read", "pull/101/get_diff", undefined],
    ]);
    expect(reads.content().diffLines).toContainEqual({ repo: "Acme/x", path: "src/a.ts", side: "RIGHT", line: 2 });
  });
});

function prArgs() {
  return { owner: PR.owner, repo: PR.repo, pullNumber: PR.number };
}

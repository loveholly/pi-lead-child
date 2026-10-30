// 可信度检查的决策边界（credibility/）。整条路径（真实的 daemon 和 Lead 会话）在 apps/daemon/test/lead-credibility-daemon.test.ts。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createProject, getItem, linkProjectRepository, openDb, transition, type Db } from "@pi-lead-child/store";
import type { SmartModel } from "@pi-lead-child/engine";
import { extractCodeRefs, failedChecks, verifyCodeRefs } from "../src/credibility/code-refs.js";
import { createCredibilityExtension, outgoingCheckFor } from "../src/credibility/extension.js";
import { evidenceTarget, TurnEvidence } from "../src/credibility/evidence.js";
import { judgeVerificationClaim, VERIFICATION_CLAIM_THRESHOLD } from "../src/credibility/verification-claim.js";
import { isLeadEvidenceTool } from "../src/session.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

function repoDir(): string {
  const dir = tempDir("plc-credibility-");
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "identity.ts"), "a\nb\nc\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  return dir;
}

describe("extractCodeRefs", () => {
  it("reads directory paths with a known extension and optional lines, and nothing else", () => {
    const refs = extractCodeRefs([
      "见 `packages/lead/src/tools.ts:1976` 和 src/auth/session.ts:12-30，以及 apps/daemon/package.json。",
      "不算：https://github.com/a/b/blob/main/src/x.ts:3、vibeproxy/gemini-3.8-flash-high、tools.ts:12、openai/gpt-5.4-mini、git@github.com:a/b.ts",
    ].join("\n"));
    expect(refs.map((ref) => [ref.path, ref.line, ref.endLine])).toEqual([
      ["packages/lead/src/tools.ts", 1976, null],
      ["src/auth/session.ts", 12, 30],
      ["apps/daemon/package.json", null, null],
    ]);
  });
});

describe("verifyCodeRefs", () => {
  it("finds files in any root, checks the line range, and stays inside the roots", () => {
    const root = repoDir();
    const checks = verifyCodeRefs(extractCodeRefs(
      "src/auth/identity.ts:3 src/auth/identity.ts:4 src/auth/session.ts ../../etc/hosts.txt",
    ), [tempDir("plc-credibility-empty-"), root]);
    expect(checks.map((check) => [check.ref.raw, check.status])).toEqual([
      ["src/auth/identity.ts:3", "ok"],
      ["src/auth/identity.ts:4", "line_out_of_range"],
      ["src/auth/session.ts", "missing"],
      ["../../etc/hosts.txt", "unverifiable"],
    ]);
    expect(checks[1]!.detail).toContain("只有 3 行");
  });

  it("does not open credential files, and cannot check without roots", () => {
    const root = repoDir();
    expect(verifyCodeRefs([{ raw: "x/.env", path: ".env", line: 1, endLine: null }], [root])[0]!.status).toBe("unverifiable");
    expect(verifyCodeRefs(extractCodeRefs("src/auth/session.ts"), [])[0]!.status).toBe("unverifiable");
  });

  it("checks the file at a GitHub comment's commit, and gives up when the commit is not local", () => {
    const root = repoDir();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "c");
    writeFileSync(join(root, "src", "later.ts"), "x\n");
    const commit = git("rev-parse", "HEAD");
    const at = (text: string, sha: string) => verifyCodeRefs(extractCodeRefs(text), [root], { commit: sha })[0]!.status;
    expect(at("src/auth/identity.ts:2", commit)).toBe("ok");
    // 工作区里有、那个提交里没有：按提交算。
    expect(at("src/later.ts", commit)).toBe("missing");
    expect(at("src/nowhere.ts", "0123456789abcdef0123456789abcdef01234567")).toBe("unverifiable");
    // 2026-10-19 发布评审：本地没有那个提交时，以前改用工作区的文件数行数，PR 新增的行就被拦了。
    expect(at("src/auth/identity.ts:9", "0123456789abcdef0123456789abcdef01234567")).toBe("unverifiable");
  });

  it("treats a file missing from the fallback roots only as unverifiable", () => {
    const root = repoDir();
    expect(verifyCodeRefs(extractCodeRefs("src/other/repo.ts"), [root], { fallbackOnly: true })[0]!.status).toBe("unverifiable");
    expect(verifyCodeRefs(extractCodeRefs("src/auth/identity.ts:9"), [root], { fallbackOnly: true })[0]!.status).toBe("line_out_of_range");
  });
});

function ledger(): { db: Db; root: string; ticket: number } {
  const root = repoDir();
  const db = openDb(join(tempDir("plc-credibility-db-"), "plc.db"));
  const project = createProject(db, { name: "p", createdBy: "user" });
  linkProjectRepository(db, project, { repoRoot: root, repoName: "r", remoteUrl: "https://github.com/Acme/demo-repo.git" });
  const ticket = createItem(db, { title: "t", brief: "b", createdBy: "user", projectId: project });
  return { db, root, ticket };
}

describe("which outgoing calls are checked, and where", () => {
  it("checks GitHub inline comments in the repository the call names, and skips read-only connection tools", () => {
    const { db, root } = ledger();
    const write = outgoingCheckFor(db, "call_connection_tool", {
      connection: "github", tool: "create_pull_request_review",
      arguments: { owner: "acme", repo: "demo-repo", body: "总评", comments: [{ path: "src/auth/identity.ts", start_line: 2, line: 9, body: "x" }] },
    }, () => false)!;
    expect(write.roots).toEqual([root]);
    expect(failedChecks(verifyCodeRefs(write.refs, write.roots)).map((check) => check.ref.raw)).toEqual(["src/auth/identity.ts:2-9"]);
    expect(outgoingCheckFor(db, "call_connection_tool", {
      connection: "github", tool: "get_file_contents", arguments: { owner: "acme", repo: "demo-repo", path: "src/x.ts" },
    }, () => true)).toBeNull();
    expect(outgoingCheckFor(db, "get_ticket", { ticket_id: 1 })).toBeNull();
  });
});

// 只取扩展注册的处理函数，用假的事件调用它们。
function harness(db: Db) {
  const handlers = new Map<string, (event: any) => any>();
  const evidence = new TurnEvidence();
  createCredibilityExtension({ db, evidence, isEvidenceTool: (name) => name === "read" })({
    on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler); return () => {}; },
  } as never);
  return { evidence, fire: (name: string, event: object) => handlers.get(name)?.(event) };
}

describe("the credibility extension", () => {
  // 2026-10-29：内部的工单批注、记录、通知不拦，只记下没核对上；写到外部账号的（GitHub 评审）照旧先拦一次。
  it("lets an internal comment through and records the unverified refs; blocks a GitHub write once", () => {
    const { db, ticket } = ledger();
    const { fire } = harness(db);
    const event = { type: "tool_call", toolCallId: "1", toolName: "add_comment", input: { ticket_id: ticket, content: "见 src/auth/session.ts:3" } };
    expect(fire("tool_call", event)).toBeUndefined();
    expect(db.prepare("SELECT payload FROM activities WHERE item_id=? AND kind='decision'").all(ticket).map((row: any) => JSON.parse(row.payload)))
      .toEqual([{ decision: "code_refs_sent_unverified", tool: "add_comment", refs: ["src/auth/session.ts:3"] }]);
    const review = {
      type: "tool_call", toolCallId: "2", toolName: "call_connection_tool",
      input: {
        connection: "github", tool: "create_pull_request_review",
        arguments: { owner: "acme", repo: "demo-repo", body: "总评", comments: [{ path: "src/auth/session.ts", line: 3, body: "x" }] },
      },
    };
    expect(fire("tool_call", review)).toMatchObject({ block: true, reason: expect.stringContaining("原样再调用一次") });
    expect(fire("tool_call", review)).toBeUndefined();
  });

  it("does not check what a SourceQuote locates, nor paths the user wrote in this turn", () => {
    const { db } = ledger();
    const { fire } = harness(db);
    expect(fire("tool_call", {
      type: "tool_call", toolCallId: "q", toolName: "render_ui",
      input: { root: "q", fallback_text: "见原文", nodes: [{ id: "q", type: "SourceQuote", props: { ticket: 1, source: "body", contains: "src/pr-only.ts:9 有问题" } }] },
    })).toBeUndefined();
    fire("before_agent_start", { prompt: "src/auth/session.ts 还在不在？" });
    fire("message_end", { message: { role: "assistant", content: "src/auth/session.ts 不存在。" } });
    expect(fire("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
  });

  // 2026-10-19 发布评审：没有相关工单时，没有登记的仓库里的相对路径以前被算成「不存在」。
  it("does not block a reference when no related ticket or repository says where to look", () => {
    const { db, ticket } = ledger();
    const { fire } = harness(db);
    expect(fire("tool_call", {
      type: "tool_call", toolCallId: "n", toolName: "notify_user", input: { title: "别的仓库的 src/other/repo.ts 有问题" },
    })).toBeUndefined();
    expect(fire("tool_call", {
      type: "tool_call", toolCallId: "t", toolName: "notify_user", input: { title: "#" + ticket + " 的 src/other/repo.ts 有问题" },
    })).toBeUndefined();
  });

  it("records successful evidence reads and clears them when the run settles", () => {
    const { db } = ledger();
    const { fire, evidence } = harness(db);
    fire("tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: "/r/src/a.ts" } });
    fire("tool_execution_end", { toolCallId: "a", toolName: "read", result: {}, isError: false });
    fire("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "/r/missing.ts" } });
    fire("tool_execution_end", { toolCallId: "b", toolName: "read", result: {}, isError: true });
    expect(evidence.list()).toEqual([{ tool: "read", target: "/r/src/a.ts" }]);
    fire("agent_settled", { aborted: false });
    expect(evidence.list()).toEqual([]);
  });

  it("asks for one correction of a reply per run, in the tickets the run worked on", () => {
    const { db, ticket } = ledger();
    const { fire } = harness(db);
    fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "问题在 src/auth/session.ts:3" }] } });
    // 这一轮没有碰过任何工单：只有登记的仓库兜底，不要求更正。
    expect(fire("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
    fire("tool_execution_start", { toolCallId: "g", toolName: "get_ticket_status", args: { ticket_id: ticket } });
    const first = fire("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
    expect(first).toMatchObject({ continue: true, entries: [{ type: "custom_message", display: false }] });
    expect(first.entries[0].content).toContain("`src/auth/session.ts:3`：文件不存在");
    expect(fire("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
    fire("agent_settled", { aborted: false });
    fire("message_end", { message: { role: "assistant", content: "NO_REPLY" } });
    expect(fire("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
  });
});

describe("evidence targets", () => {
  it("names what each read looked at", () => {
    expect(evidenceTarget("grep", { pattern: "foo", path: "/r" })).toBe("foo in /r");
    expect(evidenceTarget("get_ticket_status", { ticket_id: 98 })).toBe("#98");
    expect(evidenceTarget("read_run_events", { run_id: 111 })).toBe("Run #111");
    expect(evidenceTarget("call_connection_tool", { connection: "github", tool: "get_pull_request" })).toBe("github/get_pull_request");
  });
});

function smart(probability: number | Error): SmartModel {
  return {
    backend: "jev",
    async decide(_state, questions) {
      if (probability instanceof Error) throw probability;
      return {
        answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability }])),
        backend: "jev", model: "jev-latest", fallbackFrom: null, latencyMs: 1,
      } as never;
    },
  };
}

describe("record_decision's evidence", () => {
  function recordDecision(evidence: TurnEvidence, model: SmartModel | null) {
    const { db, ticket } = ledger();
    const deps: LeadDeps = { db, dbPath: "", dataDir: tempDir("plc-credibility-data-"), turnEvidence: () => evidence.list(), smartModel: model };
    const tool = createLeadTools(deps).find((entry) => entry.name === "record_decision")!;
    const run = (reason: string) => tool.execute("t", { ticket_id: ticket, decision: "pass", reason } as never, undefined as never, undefined as never, undefined as never);
    const rows = () => (db.prepare("SELECT payload FROM activities WHERE item_id=? AND actor='lead'").all(ticket) as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload));
    return { run, rows };
  }

  // 2026-10-29：不再拒绝，记下这一轮没有读证据，按转述算。
  it("records an own-check claim with no reads as relayed instead of refusing it", async () => {
    const { run, rows } = recordDecision(new TurnEvidence(), smart(0.95));
    await run("实地只读核验，测试通过");
    expect(rows()[0]).toMatchObject({ evidence: [], evidenceCheck: { by: "smart_model", unsupported: true } });
    expect(rows()[0].evidenceSummary).toContain("按转述记");
  });

  it("does not block when the fast model is unavailable, and says so in the record", async () => {
    const { run, rows } = recordDecision(new TurnEvidence(), smart(new Error("down")));
    await run("实地只读核验，测试通过");
    expect(rows()[0]).toMatchObject({ evidence: [], evidenceCheck: { by: "unavailable", reason: "down" } });
  });

  it("does not ask the fast model when Lead read something this run", async () => {
    const evidence = new TurnEvidence();
    evidence.record("read", { path: "/r/a.ts" });
    const { run, rows } = recordDecision(evidence, smart(new Error("must not be called")));
    await run("读了 /r/a.ts");
    expect(rows()[0]).toMatchObject({ evidence: [{ tool: "read", target: "/r/a.ts" }], evidenceSummary: "read /r/a.ts" });
    expect(rows()[0].evidenceCheck).toBeUndefined();
  });

  it("treats a missing fast model as unavailable", async () => {
    expect(await judgeVerificationClaim("实地核验", null)).toEqual({ by: "unavailable", reason: "no SmartModel" });
  });
});

// 2026-10-28 删掉了 accept_review、request_rework：验收只走 ticket_action 的 complete。accept_review 附的依据和
// 「没读过却说核验过」的拒绝跟着搬到这里；理由里的代码引用照样核对。
describe("ticket_action's acceptance evidence", () => {
  function accept(evidence: TurnEvidence, model: SmartModel | null) {
    const { db, ticket } = ledger();
    transition(db, { itemId: ticket, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId: ticket, to: "review", actor: "child", reason: "delivered" });
    const deps: LeadDeps = { db, dbPath: "", dataDir: tempDir("plc-credibility-data-"), turnEvidence: () => evidence.list(), smartModel: model };
    const tool = createLeadTools(deps).find((entry) => entry.name === "ticket_action")!;
    const run = (reason: string) => tool.execute(
      "t", { ticket_id: ticket, action: "complete", reason } as never, undefined as never, undefined as never, undefined as never,
    );
    const ledgerText = () => (db.prepare("SELECT payload FROM activities WHERE item_id=?").all(ticket) as Array<{ payload: string }>)
      .map((row) => row.payload).join("\n");
    return { db, ticket, run, ledgerText };
  }

  it("accepts with an own-check claim and no reads, and marks the basis as relayed", async () => {
    const { db, ticket, run, ledgerText } = accept(new TurnEvidence(), smart(0.95));
    await run("实地只读核验，测试通过");
    expect(getItem(db, ticket)!.stage).toBe("done");
    expect(ledgerText()).toContain("按转述记");
  });

  it("attaches what Lead read this run to the acceptance", async () => {
    const evidence = new TurnEvidence();
    evidence.record("read", { path: "/r/a.ts" });
    const { db, ticket, run, ledgerText } = accept(evidence, smart(new Error("must not be called")));
    const result = JSON.parse(((await run("读了 /r/a.ts，改动符合验收标准")).content[0] as { text: string }).text);
    expect(result.evidence).toContain("read /r/a.ts");
    expect(getItem(db, ticket)!.stage).toBe("done");
    expect(ledgerText()).toContain("lead_evidence: read /r/a.ts");
  });

  it("checks code references in the reason", () => {
    const { db, ticket } = ledger();
    expect(outgoingCheckFor(db, "ticket_action", { ticket_id: ticket, action: "complete", reason: "见 src/auth/identity.ts:2" })?.refs
      .map((ref) => ref.raw)).toEqual(["src/auth/identity.ts:2"]);
  });
});

describe("what counts as evidence, and the claim threshold", () => {
  // 2026-10-19 发布评审：拒绝提示让 Lead 用 read_run_events 取证，它却不算证据，Lead 照做仍被拒。
  it("counts read_run_events and other read-only queries, not notes", () => {
    for (const tool of ["read", "grep", "read_run_events", "get_ticket_status", "query_events", "call_connection_tool"]) {
      expect(isLeadEvidenceTool(tool), tool).toBe(true);
    }
    for (const tool of ["save_note", "search_notes", "update_note", "add_comment", "spawn_child"]) {
      expect(isLeadEvidenceTool(tool), tool).toBe(false);
    }
  });

  // LLM 兜底的「是」合成为 0.8（engine 的 llm.ts）：阈值是 0.8，所以 LLM 明确说「是」时拦，Jev 要至少这么有把握。
  it("refuses at exactly the threshold and lets just below it through", async () => {
    expect(VERIFICATION_CLAIM_THRESHOLD).toBe(0.8);
    expect(await judgeVerificationClaim("实地核验", smart(0.8))).toMatchObject({ by: "smart_model", claims: true });
    expect(await judgeVerificationClaim("实地核验", smart(0.79))).toMatchObject({ by: "smart_model", claims: false });
  });
});

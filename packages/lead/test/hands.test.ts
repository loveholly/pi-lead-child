// Lead 的动手工具（lead-tools-and-routing spec D5、D8）：真实的 pi 会话，加载 Lead 的凭证防护、hands 扩展和 pi 内置的
// codemode，模型是 pi-ai 的假模型，按脚本调用工具。沙箱是真的，只在 macOS 和 Linux 上跑。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sandboxPolicy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, openDb } from "@pi-lead-child/store";
import { resetSandboxForTests } from "@pi-lead-child/engine";
import { credentialGuardExtension } from "../src/credential-guard.js";
import {
  EXTERNAL_TURN_HANDS_REFUSAL, handsBlockedInTurn, leadHandsExtension, leadScratchDir, leadWritableRoots, leadWriteRefusal,
} from "../src/hands.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

const supported = process.platform === "darwin" || process.platform === "linux";
type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const call = (name: string, args: Record<string, unknown>): Step =>
  fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

interface ToolEvent { type: string; toolName: string; parentToolCallId?: string; isError?: boolean; text: string }

async function leadLikeSession(dataDir: string, steps: Step[], origin: () => LeadTurnOrigin) {
  const faux = fauxProvider({ provider: "plc-hands-test", api: "plc-hands-test-api" });
  faux.setResponses([...steps, fauxAssistantMessage("好了。")]);
  const agentDir = join(dataDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const db = openDb(join(dataDir, "plc.db"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dataDir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "test",
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension() },
      { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      { name: "plc-credential-guard", factory: credentialGuardExtension({ cwd: dataDir, secretValues: () => [] }) },
      { name: "plc-hands", factory: leadHandsExtension({ db, dataDir, turnOrigin: origin }) },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dataDir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
    resourceLoader: loader, sessionManager: SessionManager.inMemory(dataDir), settingsManager,
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "codemode"],
  });
  await session.bindExtensions({});
  // 和 Lead 一样：codemode 注册时不激活，按名单激活（session.ts 的 syncToolAccess）。
  session.setActiveToolsByName(["read", "grep", "find", "ls", "bash", "edit", "write", "codemode"]);
  const events: ToolEvent[] = [];
  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      events.push({ type: "start", toolName: event.toolName, parentToolCallId: event.parentToolCallId, text: "" });
    }
    if (event.type === "tool_execution_end") {
      const text = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      events.push({ type: "end", toolName: event.toolName, parentToolCallId: event.parentToolCallId, isError: event.isError, text });
    }
  });
  await session.prompt("go", { expandPromptTemplates: false });
  session.dispose();
  db.close();
  return events;
}

const userTurn = () => ({ external: false, timer: null });
// Slack 这类外部消息叫醒的一轮。
const externalTurn = (): LeadTurnOrigin => ({
  external: true, timer: null, externalBy: [{ via: "message", source: "slack" }], externalEvents: [7],
});
// 只读了连接结果（例如用户自己 PR 的 CI 状态）的一轮。
const connectionReadTurn = (): LeadTurnOrigin => ({
  external: true, timer: null, externalBy: [{ via: "tool", tool: "call_connection_tool" }],
});
const topLevelEnd = (events: ToolEvent[], name: string) => events.find((e) => e.type === "end" && e.toolName === name && !e.parentToolCallId);

// 2026-10-28 用户：「Fairy 和执行者的命令能写整个 home……只挡绕出沙箱的路径、私钥和 plc 自己的账本密钥」。
describe("leadWriteRefusal", () => {
  const home = "/Users/someone";
  const policy = sandboxPolicy({
    role: "lead", writable: ["/data/lead-scratch", "/repo.plc-workspaces/item-7"], home, dataDir: "/data",
    env: { PATH: "/usr/bin:/Users/someone/.local/bin" },
  });
  const refusal = (path: string) => leadWriteRefusal(path, { cwd: "/data", home, policy });

  it("lets Lead write in home, its scratch dir and plc's isolated worktrees", () => {
    expect(refusal("/data/lead-scratch/a.py")).toBeNull();
    expect(refusal("lead-scratch/b.md")).toBeNull();
    expect(refusal("/repo.plc-workspaces/item-7/src/x.ts")).toBeNull();
    expect(refusal("~/.config/clime/settings.json")).toBeNull();
    expect(refusal("~/Workspace/app/src/x.ts")).toBeNull();
  });

  it("refuses places that run outside the sandbox, plc's own files and credential files", () => {
    expect(refusal("/repo/src/x.ts")).toMatch(/不在能写的范围里/);
    expect(refusal("/data/config.json")).toMatch(/不在能写的范围里|plc 的账本和配置/);
    expect(refusal("/data/plc.db")).toMatch(/底线/);
    expect(refusal("~/.zshenv")).toMatch(/沙箱外执行/);
    expect(refusal("~/.zshrc")).toMatch(/沙箱外执行/);
    expect(refusal("~/.local/bin/git")).toMatch(/沙箱外执行/);
    expect(refusal("~/.claude/settings.json")).toMatch(/沙箱外执行/);
    expect(refusal("~/Workspace/app/.git/hooks/pre-commit")).toMatch(/沙箱外执行/);
    expect(refusal("~/.ssh/config")).toMatch(/不能写凭证.*底线/);
    expect(refusal("/data/lead-scratch/.env")).toMatch(/不能写凭证/);
  });
});

describe("leadWritableRoots", () => {
  it("adds isolated worktrees that are still in use, not shared checkouts or cleaned ones", () => {
    const dir = tempDir("plc-hands-roots-");
    const db = openDb(join(dir, "plc.db"));
    const statement = db.prepare(
      "INSERT INTO workspaces (owner_item_id, mode, kind, repo_root, path, state, created_at, cleaned_at, git_worktree)"
        + " VALUES (?, ?, ?, '/repo', ?, ?, datetime('now'), ?, 1)",
    );
    // 每张工单每种工作区只有一个：每行用一张新工单。
    const insert = { run: (...args: unknown[]) => statement.run(createItem(db, { title: "t", brief: "b", createdBy: "user" }), ...args) };
    try {
      insert.run("isolated", "isolated_child", "/repo.plc-workspaces/a", "active", null);
      insert.run("isolated", "isolated_child", "/repo.plc-workspaces/b", "archived", null);
      insert.run("isolated", "isolated_child", "/repo.plc-workspaces/c", "idle", "2026-10-27");
      insert.run("shared", "primary", "/repo", "active", null);
    } catch (error) {
      // 工作区表的必填列变了：这个测试要跟着改。
      throw new Error(`workspaces schema changed: ${(error as Error).message}`);
    }
    expect(leadWritableRoots(db, dir)).toEqual([leadScratchDir(dir), "/repo.plc-workspaces/a"]);
    db.close();
  });
});

// 2026-10-29 用户：「起码要让 lead agent 有能力处理」。读了自己 PR 的 CI 状态就不能跑 sleep，是一刀切；沙箱才是边界。
describe("handsBlockedInTurn", () => {
  it("blocks only a turn that an external message woke, and never the user's own live turn", () => {
    expect(handsBlockedInTurn(userTurn(), false)).toBe(false);
    expect(handsBlockedInTurn(connectionReadTurn(), false)).toBe(false);
    expect(handsBlockedInTurn(externalTurn(), false)).toBe(true);
    expect(handsBlockedInTurn(externalTurn(), true)).toBe(false);
    // 只知道是外部的一轮、不知道来源：按外部消息算。
    expect(handsBlockedInTurn({ external: true, timer: null }, false)).toBe(true);
  });
});

describe.runIf(supported)("Lead's hands in a pi session", () => {
  afterAll(async () => {
    await resetSandboxForTests();
  });

  it("runs bash in the sandbox: writes in the scratch dir, cannot write plc's own config", async () => {
    const dir = tempDir("plc-hands-");
    const scratch = leadScratchDir(dir);
    // plc 自己的配置不能写（数据目录是这个测试的临时目录，不碰用户真的文件）。
    const outside = join(dir, "config.json");
    const events = await leadLikeSession(dir, [
      call("bash", { command: `echo hi > ${scratch}/a.txt && cat ${scratch}/a.txt` }),
      call("bash", { command: `echo no > ${outside}` }),
    ], userTurn);
    const ends = events.filter((e) => e.type === "end" && e.toolName === "bash");
    expect(ends[0]?.text).toContain("hi");
    expect(readFileSync(join(scratch, "a.txt"), "utf8").trim()).toBe("hi");
    expect(ends[1]?.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
  }, 90_000);

  it("runs bash in a turn that only read connection results", async () => {
    const dir = tempDir("plc-hands-");
    const events = await leadLikeSession(dir, [call("bash", { command: "echo after-ci-read" })], connectionReadTurn);
    const end = topLevelEnd(events, "bash");
    expect(end?.isError).toBeFalsy();
    expect(end?.text).toContain("after-ci-read");
  }, 90_000);

  it("refuses bash, edit and write in a turn that an external message woke, and names the next path", async () => {
    const dir = tempDir("plc-hands-");
    const events = await leadLikeSession(dir, [
      call("bash", { command: "echo should-not-run" }),
      call("write", { path: join(leadScratchDir(dir), "w.txt"), content: "x" }),
    ], externalTurn);
    for (const name of ["bash", "write"]) {
      const end = topLevelEnd(events, name);
      expect(end?.isError, name).toBe(true);
      expect(end?.text, name).toContain(EXTERNAL_TURN_HANDS_REFUSAL);
    }
    expect(existsSync(join(leadScratchDir(dir), "w.txt"))).toBe(false);
  }, 90_000);

  it("writes inside the scratch dir and refuses plc's own config", async () => {
    const dir = tempDir("plc-hands-");
    const inside = join(leadScratchDir(dir), "note.md");
    const elsewhere = join(dir, "config.json");
    const events = await leadLikeSession(dir, [
      call("write", { path: inside, content: "ok" }),
      call("write", { path: elsewhere, content: "no" }),
    ], userTurn);
    expect(readFileSync(inside, "utf8")).toBe("ok");
    expect(existsSync(elsewhere)).toBe(false);
    const ends = events.filter((e) => e.type === "end" && e.toolName === "write");
    expect(ends[1]?.text).toMatch(/plc 的账本和配置/);
  }, 90_000);

  it("runs codemode scripts whose nested calls still go through the credential guard and emit their own events", async () => {
    const dir = tempDir("plc-hands-");
    mkdirSync(leadScratchDir(dir), { recursive: true });
    writeFileSync(join(leadScratchDir(dir), "fine.txt"), "fine-content");
    const script = [
      `const fine = await tools.read({ path: ${JSON.stringify(join(leadScratchDir(dir), "fine.txt"))} });`,
      "let blocked = 'not blocked';",
      "try { await tools.read({ path: '~/.ssh/config' }); } catch (error) { blocked = String(error.message ?? error); }",
      "return { fine, blocked };",
    ].join("\n");
    const events = await leadLikeSession(dir, [call("codemode", { code: script })], userTurn);
    const result = topLevelEnd(events, "codemode");
    expect(result?.text).toContain("fine-content");
    expect(result?.text).toContain("不能读凭证");
    // 嵌套的调用各自发事件，带着父调用的编号：daemon 按 tool_execution_start 记外部内容，所以脚本里读对话也会被记上。
    const nested = events.filter((e) => e.type === "start" && e.toolName === "read");
    expect(nested.length).toBe(2);
    expect(nested.every((e) => typeof e.parentToolCallId === "string")).toBe(true);
  }, 90_000);
});

// 用户给 agent 装的 skill（2026-10-28，用户：「我预期 Fairy 能正常调用……各种给它安装的 skills」）。
describe("userSkillDirs", () => {
  it("lists the user's skill dirs that exist", async () => {
    const { mkdirSync } = await import("node:fs");
    const { userSkillDirs } = await import("../src/session.js");
    const home = tempDir("plc-skill-home-");
    expect(userSkillDirs(home)).toEqual([]);
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    expect(userSkillDirs(home)).toEqual([join(home, ".agents", "skills"), join(home, ".claude", "skills")]);
  });
});

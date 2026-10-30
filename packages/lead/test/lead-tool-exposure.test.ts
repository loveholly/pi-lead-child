// 工具和 skill 按需加载（2026-10-28，文档「按需加载方案」，用户定的）：
//   - 不常用的工具放进 codemode：不声明给模型，在 codemode 脚本里照样能调；要授权的工具不放进去，没授权时脚本也调不到。
//   - 用户装的 skill 不列进系统提示词，Lead 自带的照常列出；find_skill 在用户装的 skill 里找。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, defineTool, formatSkillsForPrompt, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { hideUserSkillsFromPrompt, LEAD_SKILLS_DIR, leadActiveToolNames } from "../src/session.js";
import { createSkillTools, type UserSkillInfo } from "../src/skill-tools.js";
import { applyLeadToolExposure, LEAD_CODEMODE_INLINE_BUDGET, LEAD_CODEMODE_TOOLS } from "../src/tool-exposure.js";
import { createLeadToolset, GRANT_GATED_LEAD_TOOLS, type LeadDeps } from "../src/tools.js";

// 通道、操作服务和连接都给替身，这样它们的工具也会建出来。
const stub: any = new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : stub), apply: () => stub });

function fullToolset() {
  const dir = tempDir("plc-exposure-");
  const db = openDb(join(dir, "plc.db"));
  const tools = createLeadToolset({ db, dbPath: join(dir, "plc.db"), dataDir: dir, channelCards: stub, uiActionServices: stub, connections: stub } as LeadDeps) as any[];
  return { db, tools };
}

describe("the codemode tool list", () => {
  it("names only tools that exist, never a grant-gated one, and marks exactly those as codemode", () => {
    const { db, tools } = fullToolset();
    const names = new Set(tools.map((tool) => tool.name));
    expect([...LEAD_CODEMODE_TOOLS].filter((name) => !names.has(name))).toEqual([]);
    expect([...LEAD_CODEMODE_TOOLS].filter((name) => name in GRANT_GATED_LEAD_TOOLS)).toEqual([]);
    for (const tool of tools) expect(tool.exposure === "codemode").toBe(LEAD_CODEMODE_TOOLS.has(tool.name));
    db.close();
  });

  it("keeps codemode tools out of the active set, which is what the model is declared", () => {
    const { db, tools } = fullToolset();
    const active = leadActiveToolNames(db, tools);
    for (const name of LEAD_CODEMODE_TOOLS) expect(active).not.toContain(name);
    for (const name of ["create_task", "record_disposition", "render_ui", "find_skill", "read_notifications", "codemode"]) {
      expect(active).toContain(name);
    }
    // 没有授权时，要授权的工具也不在里面。
    expect(active).not.toContain("confirm_item");
    db.close();
  });

  it("lists every codemode tool by name in the system prompt, and lists no signatures in codemode's own description", () => {
    for (const name of LEAD_CODEMODE_TOOLS) expect(LEAD_SYSTEM_PROMPT).toContain(name);
    expect(LEAD_SYSTEM_PROMPT).toContain("## 不常用的工具在 codemode 里");
    expect(LEAD_CODEMODE_INLINE_BUDGET).toBe(0);
  });
});

// 真实的 pi 会话（假模型按脚本调工具）：codemode 工具不声明，但脚本能调；没授权的工具脚本也调不到。
describe("codemode exposure in a real pi session", () => {
  it("calls a codemode tool from a script, and refuses a grant-gated tool that is not active", async () => {
    const dataDir = tempDir("plc-exposure-session-");
    const agentDir = join(dataDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const db = openDb(join(dataDir, "plc.db"));
    const ran: string[] = [];
    const fake = (name: string) => defineTool({
      name, label: name, description: `fake ${name}`, parameters: Type.Object({}),
      execute: async () => { ran.push(name); return { content: [{ type: "text" as const, text: `${name} ran` }], details: {} }; },
    });
    // list_triggers 在 codemode 名单里；confirm_item 要授权；create_task 常驻。
    const customTools = applyLeadToolExposure([fake("list_triggers"), fake("confirm_item"), fake("create_task")]);
    const script = [
      "const listed = await tools.list_triggers({});",
      "let gated = 'callable';",
      "try { await tools.confirm_item({}); } catch (error) { gated = 'refused: ' + String(error.message ?? error); }",
      "return { listed, gated };",
    ].join("\n");
    const faux = fauxProvider({ provider: "plc-exposure-test", api: "plc-exposure-test-api" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: script } as never)], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了。"),
    ]);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dataDir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "test",
      extensionFactories: [
        { name: "codemode", factory: createCodemodeExtension({ inlineBudget: LEAD_CODEMODE_INLINE_BUDGET }) },
        { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dataDir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dataDir), settingsManager,
      tools: [...customTools.map((tool) => tool.name), "codemode"], customTools,
    });
    await session.bindExtensions({});
    session.setActiveToolsByName(leadActiveToolNames(db, customTools).filter((name) => name === "codemode" || customTools.some((t) => t.name === name)));
    const declared = session.getActiveToolNames();
    expect(declared).toContain("create_task");
    expect(declared).toContain("codemode");
    expect(declared).not.toContain("list_triggers");
    expect(declared).not.toContain("confirm_item");
    let result = "";
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end" && event.toolName === "codemode" && !event.parentToolCallId) {
        result = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      }
    });
    await session.prompt("go", { expandPromptTemplates: false });
    session.dispose();
    db.close();
    expect(ran).toEqual(["list_triggers"]);
    expect(result).toContain("list_triggers ran");
    expect(result).toContain("refused");
  }, 60_000);
});

describe("user skills", () => {
  it("are loaded but left out of the system prompt; Lead's own skills stay listed", async () => {
    const dir = tempDir("plc-user-skills-");
    const userDir = join(dir, "user-skills");
    mkdirSync(join(userDir, "deploy-notes"), { recursive: true });
    writeFileSync(join(userDir, "deploy-notes", "SKILL.md"), "---\nname: deploy-notes\ndescription: Write deploy notes for a release.\n---\n\n# Deploy notes\n");
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir, additionalSkillPaths: [LEAD_SKILLS_DIR, userDir], skillsOverride: hideUserSkillsFromPrompt,
    });
    await loader.reload();
    const skills = loader.getSkills().skills;
    const user = skills.find((skill) => skill.name === "deploy-notes");
    expect(user?.disableModelInvocation).toBe(true);
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).not.toContain("deploy-notes");
    for (const own of ["ticket-planning", "channel-replies", "pr-review", "genui-cards"]) expect(prompt).toContain(own);
  });
});

describe("find_skill", () => {
  const skills: UserSkillInfo[] = [
    { name: "tdd", description: "Test-driven development. Use when the user wants to build features test-first.", filePath: "/s/tdd/SKILL.md" },
    { name: "research", description: "Investigate a question against primary sources. Use when a topic needs research.", filePath: "/s/research/SKILL.md" },
    { name: "pdf", description: "Read, merge and split PDF files.", filePath: "/s/pdf/SKILL.md" },
  ];
  const run = async (deps: Parameters<typeof createSkillTools>[0], params: Record<string, unknown>) => {
    const tool = createSkillTools(deps)[0] as any;
    const result = await tool.execute("call", params, undefined, undefined, {} as never);
    return result.content[0].text as string;
  };

  it("says when there are no user skills, and lists them all without a query", async () => {
    expect(await run({}, {})).toContain("没有用户装的 skill");
    const list = await run({ userSkills: () => skills }, {});
    for (const skill of skills) {
      expect(list).toContain(skill.name);
      expect(list).toContain(skill.filePath);
    }
  });

  it("ranks with the decision model, records the purpose, and leaves out weak matches", async () => {
    const calls: unknown[] = [];
    const smartModel = {
      backend: "jev",
      decide: async (_state: string, questions: any, opts: any) => {
        calls.push(opts.purpose);
        expect(questions.skill.options).toContain("（都不合适）");
        return {
          answers: { skill: { type: "choice", choice: "research", confidence: 0.7, probabilities: { tdd: 0.02, research: 0.8, pdf: 0.1, "（都不合适）": 0.08 } } },
          backend: "jev", model: "jev-latest", latencyMs: 5, fallbackFrom: null,
        };
      },
    };
    const text = await run({ userSkills: () => skills, smartModel: smartModel as never }, { query: "帮我调研一下这个库" });
    expect(calls).toEqual(["find_skill"]);
    expect(text.indexOf("research")).toBeLessThan(text.indexOf("pdf"));
    expect(text).toContain("/s/research/SKILL.md");
    expect(text).not.toContain("tdd");
  });

  it("falls back to the full list when there is no decision model or it fails", async () => {
    const none = await run({ userSkills: () => skills }, { query: "写测试" });
    expect(none).toContain("没有决策模型");
    expect(none).toContain("tdd");
    const failing = { backend: "jev", decide: async () => { throw new Error("timeout"); } };
    const failed = await run({ userSkills: () => skills, smartModel: failing as never }, { query: "写测试" });
    expect(failed).toContain("排序失败（timeout）");
    expect(failed).toContain("pdf");
  });
});

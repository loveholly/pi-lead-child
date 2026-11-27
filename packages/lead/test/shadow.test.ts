// shadow 的规则（shadow/shadow.ts）和会话（shadow/session.ts）。会话用 pi-ai 的假模型（faux），走真的隔离会话。
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createShadowFinishTool, createShadowToolset, SHADOW_CORE_TOOLS, SHADOW_MORE_TOOL, SHADOW_SKILL_TOOL, createShadowSkillTool, createIsolatedLookupSession, SHADOW_FINISH_TOOL, SHADOW_LEAD_TOOL_NAMES, SHADOW_OPENING, ShadowRecorder,
  shadowBatchText, shadowFilesRead, shadowHandoffText, shadowOpeningMessages, shadowRefusal, renderShadowSystemPrompt, resolveShadowOutcome, runShadowSession, wrapShadowTools,
  type ShadowSessionFactory, type LookupSession,
} from "../src/index.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

const sessions: LookupSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    try { session.dispose(); } catch { /* already gone */ }
  }
});

function leadTool(name: string, calls: string[], result = "ok"): ToolDefinition<any> {
  return defineTool({
    name, label: name, description: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      calls.push(name);
      return { content: [{ type: "text" as const, text: result }], details: {} };
    },
  });
}

describe("resolveShadowOutcome", () => {
  const always = () => true;
  it("puts every id into done or escalated", () => {
    const outcome = resolveShadowOutcome({
      ids: [1, 2, 3],
      report: { done: [{ ids: [1], line: "Slack 压测协调，不是找用户的，no_action" }], escalate: [{ ids: [2], why: "要用户的上下文" }] },
      needsDisposition: always, disposed: (id) => id === 1,
    });
    expect(outcome.done).toEqual([{ ids: [1], line: "Slack 压测协调，不是找用户的，no_action" }]);
    expect(outcome.escalated.flatMap((entry) => entry.ids).sort()).toEqual([2, 3]);
    expect(outcome.escalated.find((entry) => entry.ids.includes(2))?.note).toContain("要用户的上下文");
    expect(outcome.escalated.find((entry) => entry.ids.includes(3))?.note).toContain("没有给这件事结论");
  });

  it("escalates an id that the shadow called done but never disposed", () => {
    const outcome = resolveShadowOutcome({
      ids: [7], report: { done: [{ ids: [7], line: "处理了" }], escalate: [] },
      needsDisposition: always, disposed: () => false,
    });
    expect(outcome.done).toEqual([]);
    expect(outcome.escalated[0]?.note).toContain("没有记下处置");
  });

  it("accepts done without a disposition for events that have nowhere to record one", () => {
    const outcome = resolveShadowOutcome({
      ids: [9], report: { done: [{ ids: [9], line: "等的事到了，没有要做的" }], escalate: [] },
      needsDisposition: () => false, disposed: () => false,
    });
    expect(outcome.done[0]?.ids).toEqual([9]);
  });

  it("escalates when an id is both done and escalated", () => {
    const outcome = resolveShadowOutcome({
      ids: [4], report: { done: [{ ids: [4], line: "x" }], escalate: [{ ids: [4], why: "不确定" }] },
      needsDisposition: always, disposed: always,
    });
    expect(outcome.done).toEqual([]);
    expect(outcome.escalated[0]?.ids).toEqual([4]);
  });

  it("escalates everything on an error, a missing report, or a tool that needs the user", () => {
    const base = { ids: [1, 2], needsDisposition: always, disposed: always };
    expect(resolveShadowOutcome({ ...base, report: null }).escalated[0]?.ids).toEqual([1, 2]);
    expect(resolveShadowOutcome({ ...base, report: { done: [{ ids: [1, 2], line: "x" }], escalate: [] }, error: "timeout" }).done).toEqual([]);
    const carded = resolveShadowOutcome({
      ...base, report: { done: [{ ids: [1, 2], line: "x" }], escalate: [] }, userActions: ["ticket_action：授权"],
    });
    expect(carded.done).toEqual([]);
    expect(carded.escalated[0]?.note).toContain("授权");
  });

  it("ignores ids that are not in the batch", () => {
    const outcome = resolveShadowOutcome({
      ids: [1], report: { done: [{ ids: [1, 99], line: "x" }], escalate: [{ ids: [98], why: "y" }] },
      needsDisposition: always, disposed: always,
    });
    expect(outcome.done).toEqual([{ ids: [1], line: "x" }]);
    expect(outcome.escalated).toEqual([]);
  });
});

describe("shadowRefusal", () => {
  const options = (watching: boolean, notified = 0) => ({ userWatching: () => watching, messageIds: new Set([50]), notified });
  it("refuses to push or tell while the user watches the conversation", () => {
    expect(shadowRefusal("notify_user", { title: "x" }, options(true))).toContain("交给主会话");
    expect(shadowRefusal("record_disposition", { event_ids: [50], disposition: "told_user", draft: "d" }, options(true))).toContain("交给主会话");
    expect(shadowRefusal("record_disposition", { event_ids: [1], disposition: "no_action" }, options(true))).toBeNull();
  });

  it("needs a push before told_user on an inbox event while the user is away", () => {
    expect(shadowRefusal("record_disposition", { event_ids: [1], disposition: "told_user" }, options(false))).toContain("notify_user");
    expect(shadowRefusal("record_disposition", { event_ids: [1], disposition: "told_user" }, options(false, 1))).toBeNull();
    // 外部消息记 told_user：卡留给用户，不用推。
    expect(shadowRefusal("record_disposition", { event_ids: [50], disposition: "told_user", draft: "d" }, options(false))).toBeNull();
  });
});

describe("createShadowToolset", () => {
  const base = () => ({ recorder: new ShadowRecorder(), dryRun: false, userWatching: () => false, messageIds: new Set<number>(), skillsDir: tempDir("plc-shadow-skills-") });

  it("declares the core tools, puts the rare ones behind more_tools, and runs them through the same rules", async () => {
    const calls: string[] = [];
    const inner: string[] = [];
    const tools = createShadowToolset(
      [leadTool("get_ticket_status", calls), leadTool("dispatch_agent_task", calls), leadTool("perform_action", calls)],
      { ...base(), onInnerToolStart: (name) => inner.push(name) },
    );
    expect(tools.map((tool) => tool.name)).toEqual(["get_ticket_status", SHADOW_SKILL_TOOL, SHADOW_MORE_TOOL, SHADOW_FINISH_TOOL]);
    const more = tools.find((tool) => tool.name === SHADOW_MORE_TOOL)!;
    const described = await more.execute("c", { name: "dispatch_agent_task" }, undefined, undefined, {} as never);
    expect((described.content[0] as { text: string }).text).toContain("参数");
    expect(calls).toEqual([]);
    await more.execute("c", { name: "dispatch_agent_task", arguments: { event: 1 } }, undefined, undefined, {} as never);
    expect(calls).toEqual(["dispatch_agent_task"]);
    expect(inner).toEqual(["dispatch_agent_task"]);
    // perform_action 只放行白名单里的操作。
    const refused = await more.execute("c", { name: "perform_action", arguments: { target_type: "core_memory", action: "update" } }, undefined, undefined, {} as never);
    expect((refused.content[0] as { text: string }).text).toContain("交给主会话");
    await more.execute("c", { name: "perform_action", arguments: { target_type: "runtime", action: "disable" } }, undefined, undefined, {} as never);
    expect(calls).toEqual(["dispatch_agent_task", "perform_action"]);
  });

  it("lets call_connection_tool through only for read-only tools", async () => {
    const calls: string[] = [];
    const tools = createShadowToolset([leadTool("call_connection_tool", calls)], {
      ...base(), connectionReadOnly: (connection, tool) => connection === "github" && tool === "get_pull_request",
    });
    const call = tools.find((tool) => tool.name === "call_connection_tool")!;
    await call.execute("c", { connection: "github", tool: "get_pull_request", arguments: {} }, undefined, undefined, {} as never);
    const write = await call.execute("c", { connection: "github", tool: "create_pull_request_review", arguments: {} }, undefined, undefined, {} as never);
    expect(calls).toEqual(["call_connection_tool"]);
    expect((write.content[0] as { text: string }).text).toContain("只读");
    expect(SHADOW_CORE_TOOLS).toContain("read_agenda_entries");
  });
});

describe("wrapShadowTools", () => {
  it("keeps only the shadow's tools and drops the codemode exposure", () => {
    const calls: string[] = [];
    const tools = [leadTool("get_ticket_status", calls), leadTool("bash", calls), leadTool("render_ui", calls), leadTool("save_note", calls)]
      .map((tool) => ({ ...tool, exposure: "codemode" as const }));
    const wrapped = wrapShadowTools(tools, { recorder: new ShadowRecorder(), dryRun: false, userWatching: () => false, messageIds: new Set() });
    expect(wrapped.map((tool) => tool.name)).toEqual(["get_ticket_status"]);
    expect((wrapped[0] as { exposure?: string }).exposure).toBeUndefined();
    expect(SHADOW_LEAD_TOOL_NAMES).not.toContain("bash");
    expect(SHADOW_LEAD_TOOL_NAMES).not.toContain("render_ui");
  });

  it("does not run write tools in a dry run, and records what they would do", async () => {
    const calls: string[] = [];
    const recorder = new ShadowRecorder();
    const [disposition, read] = wrapShadowTools(
      [leadTool("record_disposition", calls), leadTool("get_ticket_status", calls)],
      { recorder, dryRun: true, userWatching: () => false, messageIds: new Set() },
    );
    await disposition!.execute("c1", { event_ids: [3], disposition: "no_action", reason: "r" }, undefined, undefined, {} as never);
    await read!.execute("c2", { ticket_id: 1 }, undefined, undefined, {} as never);
    expect(calls).toEqual(["get_ticket_status"]);
    expect(recorder.disposed.get(3)).toBe("no_action");
    expect(recorder.calls.map((call) => [call.name, call.dry])).toEqual([["record_disposition", true], ["get_ticket_status", false]]);
  });
});

describe("createShadowSkillTool", () => {
  it("reads only Lead's own skills by directory name", async () => {
    const dir = tempDir("plc-shadow-skills-");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(`${dir}/channel-replies`);
    writeFileSync(`${dir}/channel-replies/SKILL.md`, "how to reply");
    const tool = createShadowSkillTool(dir);
    const read = await tool.execute("c", { name: "channel-replies" }, undefined, undefined, {} as never);
    expect(read.content[0]).toMatchObject({ text: "how to reply" });
    const missing = await tool.execute("c", { name: "pr-review" }, undefined, undefined, {} as never);
    expect((missing.content[0] as { text: string }).text).toContain("没有这个 skill");
  });
});

describe("shadow prompt and opening", () => {
  it("puts the shadow section after Lead's prompt and keeps the opening fixed", () => {
    const prompt = renderShadowSystemPrompt({ lead: "LEAD", identity: "ID", replyStyle: null });
    expect(prompt.startsWith("LEAD\n\nID\n\n## 你现在是 shadow（你的分身）")).toBe(true);
    const messages = shadowOpeningMessages({ api: "a", provider: "p", id: "m" }) as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(messages.map((message) => [message.role, message.content[0]!.text])).toEqual([
      ["user", SHADOW_OPENING.user], ["assistant", SHADOW_OPENING.assistant],
    ]);
    expect(shadowBatchText({ clock: "C", presence: "P", events: "E", ids: [5, 6] })).toContain("#5、#6");
  });
});

describe("runShadowSession", () => {
  function fauxShadow(steps: Step[]): { factory: ShadowSessionFactory; contexts: unknown[][] } {
    const faux = fauxProvider({ provider: "plc-shadow-test", api: "plc-shadow-test-api" });
    const contexts: unknown[][] = [];
    faux.setResponses(steps.map((step) => (context: { messages: unknown[] }) => {
      contexts.push(structuredClone(context.messages));
      return typeof step === "function" ? (step as (c: unknown) => unknown)(context) : step;
    }) as never);
    const workDir = tempDir("plc-shadow-session-");
    return {
      contexts,
      factory: async (request) => {
        const model = faux.getModel() as { api: string; provider: string; id: string };
        const session = await createIsolatedLookupSession({
          workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: model as never,
          thinkingLevel: "off", retry: false, seedMessages: shadowOpeningMessages(model),
          extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
        });
        sessions.push(session);
        return { session, model: "plc-shadow-test/faux", note: null };
      },
    };
  }

  it("starts every session with the fixed opening, then the batch, and ends on finish_shadow", async () => {
    const calls: string[] = [];
    const recorder = new ShadowRecorder();
    const tools = [
      ...wrapShadowTools([leadTool("record_disposition", calls)], { recorder, dryRun: false, userWatching: () => false, messageIds: new Set() }),
      createShadowFinishTool(recorder),
    ];
    const { factory, contexts } = fauxShadow([
      fauxAssistantMessage([fauxToolCall("record_disposition", { event_ids: [11], disposition: "no_action", reason: "不是找用户的" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(SHADOW_FINISH_TOOL, { done: [{ ids: [11], line: "频道里的压测协调，不是找用户的" }], escalate: [] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    const result = await runShadowSession({
      factory, request: { systemPrompt: "SYS", tools, model: "plc-shadow-test/faux" },
      text: shadowBatchText({ clock: "C", presence: "P", events: "E", ids: [11] }), finished: () => recorder.report !== null,
    });
    expect(result.error).toBeNull();
    expect(result.usage.calls).toBe(3);
    expect(calls).toEqual(["record_disposition"]);
    expect(recorder.report?.done[0]?.ids).toEqual([11]);
    const first = (contexts[0] as Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>)
      .filter((message) => message.role !== "system");
    const texts = first.map((message) => [message.role, typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")]);
    expect(texts[0]).toEqual(["user", SHADOW_OPENING.user]);
    expect(texts[1]).toEqual(["assistant", SHADOW_OPENING.assistant]);
    expect(texts[2]?.[1]).toContain("#11");
  });

  it("nudges once when the model stops without finish_shadow", async () => {
    const recorder = new ShadowRecorder();
    const { factory } = fauxShadow([
      fauxAssistantMessage("我看完了"),
      fauxAssistantMessage([fauxToolCall(SHADOW_FINISH_TOOL, { done: [], escalate: [{ ids: [2], why: "拿不准" }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("完"),
    ]);
    const result = await runShadowSession({
      factory, request: { systemPrompt: "SYS", tools: [createShadowFinishTool(recorder)], model: "plc-shadow-test/faux" },
      text: "batch", finished: () => recorder.report !== null,
    });
    expect(result.error).toBeNull();
    expect(recorder.report?.escalate[0]?.ids).toEqual([2]);
  });

  it("reports a factory failure as an error", async () => {
    const result = await runShadowSession({
      factory: async () => { throw new Error("model not found"); },
      request: { systemPrompt: "SYS", tools: [], model: "x/y" }, text: "batch", finished: () => false,
    });
    expect(result.error).toContain("model not found");
  });
});

// 工单 #584：shadow 每批是新会话。shadow-56 看了对方的截图，shadow-57 接着处理对方的那句话时看不到图，只从卡的备注里看到截短的结论。
describe("handing over to the next batch on the same object", () => {
  it("lists the earlier batches' conclusions and the files they read, and asks to read the files again", () => {
    const text = shadowHandoffText([
      { object: "slack:D0NINA:main", batch: "shadow-56", at: "14:46", lines: ["Nina 发了登录页报错的截图，错误码 403"], files: ["slack:F0SHOT1"] },
      { object: "ticket:7", batch: "shadow-55", at: "14:40", lines: [], files: [] },
    ]);
    expect(text).toContain("slack:D0NINA:main：14:46 shadow-56 结论：Nina 发了登录页报错的截图，错误码 403");
    expect(text).toContain("它看过的文件：slack:F0SHOT1");
    expect(text).toContain("先用 read_channel_file 再看一次");
    expect(text).not.toContain("ticket:7");
    expect(shadowHandoffText([])).toBe("");
  });

  it("puts the handover after the events in the batch text", () => {
    const text = shadowBatchText({ clock: "c", presence: "p", events: "事件", ids: [3], handoff: "交接" });
    expect(text.indexOf("交接")).toBeGreaterThan(text.indexOf("事件"));
    expect(text.indexOf("交接")).toBeLessThan(text.indexOf("#3"));
  });

  it("records the files a batch read, but not refused or dry-run calls", () => {
    const recorder = new ShadowRecorder();
    recorder.calls.push(
      { name: "read_channel_file", args: { file: "slack:F0A" }, dry: false },
      { name: "read_channel_file", args: { file: "slack:F0A" }, dry: false },
      { name: "read_channel_file", args: { file: "slack:F0B" }, dry: false, refused: "no" },
      { name: "read_channel_file", args: { file: "slack:F0C" }, dry: true },
      { name: "read_channel_conversation", args: { conversation: "x" }, dry: false },
    );
    expect(shadowFilesRead(recorder)).toEqual(["slack:F0A"]);
  });
});

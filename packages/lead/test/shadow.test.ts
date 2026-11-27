// shadow 的规则（shadow/shadow.ts）和会话（shadow/session.ts）。会话用 pi-ai 的假模型（faux），走真的隔离会话。
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createShadowFinishTool, createShadowToolset, SHADOW_CORE_TOOLS, SHADOW_MORE_TOOL, SHADOW_SKILL_TOOL, createShadowSkillTool, createIsolatedLookupSession, SHADOW_FINISH_TOOL, SHADOW_LEAD_TOOL_NAMES, SHADOW_OPENING, ShadowRecorder,
  shadowBatchText, shadowOpeningMessages, shadowRefusal, renderShadowSystemPrompt, resolveShadowOutcome, runShadowSession, wrapShadowTools,
  type ShadowSessionFactory, type LookupSession,
  planShadowConversation, renderShadowWorkRecord, ShadowConversationPool, SHADOW_CONVERSATION_REOPEN_MS, SHADOW_SECTION,
  SHADOW_WORK_READ_TOOL, SHADOW_WORK_UPDATE_TOOL, type LoadedShadowConversation, type ShadowWorkEntryLike,
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
  it("refuses to push or tell about a non-message event while the user watches the conversation", () => {
    expect(shadowRefusal("notify_user", { title: "x" }, options(true))).toContain("交给主会话");
    expect(shadowRefusal("record_disposition", { event_ids: [1], disposition: "told_user" }, options(true))).toContain("交给主会话");
    expect(shadowRefusal("record_disposition", { event_ids: [1, 50], disposition: "told_user", draft: "d" }, options(true))).toContain("交给主会话");
    expect(shadowRefusal("record_disposition", { event_ids: [1], disposition: "no_action" }, options(true))).toBeNull();
  });

  // 工单 #588：以前用户在看会话时，外部消息带草稿记 told_user 也被拒绝，只能交回主会话（11-27 至少 4 条白跑一遍 shadow）。
  it("lets an external message event be told_user with a draft while the user watches, without handing it back", () => {
    expect(shadowRefusal("record_disposition", { event_ids: [50], disposition: "told_user", draft: "d" }, options(true))).toBeNull();
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


// ── 按对话复用会话（工单 #588）──────────────────────────────────────────────────────────

describe("planShadowConversation", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const row = (change: Partial<{ sessionFile: string | null; configVersion: string | null; lastMessageAt: string | null }> = {}) => ({
    sessionFile: "/data/shadow/sessions/a.jsonl", configVersion: "v1", lastMessageAt: "2026-11-27T09:00:00Z", ...change,
  });
  const exists = () => true;

  it("reuses the session file of the same configuration within 24 hours", () => {
    expect(planShadowConversation({ row: row(), configVersion: "v1", now, fileExists: exists }))
      .toEqual({ kind: "reuse", file: "/data/shadow/sessions/a.jsonl" });
  });

  it("starts a new session only when the configuration changed, after 24 hours without messages, or with no file", () => {
    expect(planShadowConversation({ row: null, configVersion: "v1", now, fileExists: exists })).toEqual({ kind: "new", reason: "first" });
    expect(planShadowConversation({ row: row(), configVersion: "v2", now, fileExists: exists })).toEqual({ kind: "new", reason: "config" });
    const stale = new Date(now - SHADOW_CONVERSATION_REOPEN_MS - 1).toISOString();
    expect(planShadowConversation({ row: row({ lastMessageAt: stale }), configVersion: "v1", now, fileExists: exists }))
      .toEqual({ kind: "new", reason: "stale" });
    const recent = new Date(now - SHADOW_CONVERSATION_REOPEN_MS + 60_000).toISOString();
    expect(planShadowConversation({ row: row({ lastMessageAt: recent }), configVersion: "v1", now, fileExists: exists }).kind).toBe("reuse");
    expect(planShadowConversation({ row: row({ sessionFile: null }), configVersion: "v1", now, fileExists: exists }))
      .toEqual({ kind: "new", reason: "no_file" });
    expect(planShadowConversation({ row: row(), configVersion: "v1", now, fileExists: () => false })).toEqual({ kind: "new", reason: "no_file" });
  });
});

describe("ShadowConversationPool", () => {
  const fake = (name: string, log: string[]): LoadedShadowConversation => ({
    session: { subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => { log.push(`dispose ${name}`); } },
    configVersion: "v1", model: "m", modelNote: null, file: null,
  });
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("runs one batch at a time for a group, keeps the session between batches, and runs other groups in parallel up to the cap", async () => {
    const log: string[] = [];
    const pool = new ShadowConversationPool({ maxRuns: 2, idleMs: 60_000 });
    const first = gate();
    const seen: Array<LoadedShadowConversation | null> = [];
    const session = fake("a", log);
    const a1 = pool.run("a", async (loaded) => { seen.push(loaded); log.push("a1 start"); await first.promise; log.push("a1 end"); return { result: 1, keep: session }; });
    const a2 = pool.run("a", async (loaded) => { seen.push(loaded); log.push("a2"); return { result: 2, keep: loaded }; });
    const second = gate();
    const b1 = pool.run("b", async () => { log.push("b1 start"); await second.promise; return { result: 3, keep: null }; });
    const c1 = pool.run("c", async () => { log.push("c1"); return { result: 4, keep: null }; });
    await tick();
    // a2 等 a1；c1 等并行名额（a1 和 b1 占着两个）。
    expect(log).toEqual(["a1 start", "b1 start"]);
    expect(pool.busy("a")).toBe(true);
    expect(pool.running()).toBe(2);
    first.open();
    expect(await a1).toBe(1);
    expect(await a2).toBe(2);
    expect(seen).toEqual([null, session]);
    second.open();
    expect(await b1).toBe(3);
    expect(await c1).toBe(4);
    expect(log.indexOf("a2")).toBeGreaterThan(log.indexOf("a1 end"));
    expect(pool.loaded("a")).toBe(session);
    expect(log).not.toContain("dispose a");
    pool.disposeAll();
  });

  it("unloads a session after it was idle, never while a batch is queued, and drops a session that failed", async () => {
    const log: string[] = [];
    const pool = new ShadowConversationPool({ idleMs: 40 });
    const session = fake("a", log);
    await pool.run("a", async () => ({ result: null, keep: session }));
    expect(pool.loadedCount()).toBe(1);
    // 闲置还没到时又来一批：不卸载，接着用同一个会话。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const hold = gate();
    const running = pool.run("a", async (loaded) => { await hold.promise; return { result: loaded, keep: loaded }; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(log).not.toContain("dispose a");
    hold.open();
    expect(await running).toBe(session);
    // 闲置到了：卸载（关掉会话，文件留着）。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(log).toContain("dispose a");
    expect(pool.loaded("a")).toBeNull();
    // 出错：会话关掉，不留在内存里。
    const broken = fake("b", log);
    await pool.run("b", async () => ({ result: null, keep: broken }));
    await expect(pool.run("b", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(log).toContain("dispose b");
    expect(pool.loaded("b")).toBeNull();
    pool.disposeAll();
  });
});

describe("renderShadowWorkRecord", () => {
  const entry = (id: number, kind: ShadowWorkEntryLike["kind"], text: string, ref: string | null = null): ShadowWorkEntryLike => ({
    id, kind, ref, text, eventSeq: null, createdAt: "2026-11-27T10:00:00.000Z",
  });
  const entries = [
    entry(1, "attachment", "截图里写着：账号已被冻结", "slack:F0001"),
    entry(2, "open", "等对方发账号"),
    entry(3, "open", "确认冻结原因"),
    entry(4, "resolved", "对方发了", "#2"),
  ];

  it("gives the full record with only the open items still open, inside an external tag", () => {
    const text = renderShadowWorkRecord(entries, { sessionKey: "slack:D0LEILEI", mode: "full" })!;
    expect(text).toContain("slack:F0001 → 截图里写着：账号已被冻结");
    expect(text).toContain("确认冻结原因");
    expect(text).not.toContain("等对方发账号");
    expect(text).toContain('part="work_record"');
  });

  it("gives only the given new entries in mode new", () => {
    const text = renderShadowWorkRecord(entries.slice(3), { sessionKey: "slack:D0LEILEI", mode: "new", audience: "lead" })!;
    expect(text).toContain("新增的部分");
    expect(text).toContain("#2 对方发了");
    expect(text).not.toContain("截图里写着");
    expect(renderShadowWorkRecord([], { sessionKey: "k", mode: "full" })).toBeNull();
  });
});

describe("conversation sessions in the shadow's tools and prompt", () => {
  it("adds the work record tools only for a conversation session, and reads the batch's recorder at call time", async () => {
    const recorded: unknown[] = [];
    const holder = { recorder: new ShadowRecorder() };
    const options = {
      get recorder() { return holder.recorder; }, dryRun: false, userWatching: () => false, messageIds: new Set<number>(),
      skillsDir: tempDir("plc-shadow-skills-"),
    };
    const plain = createShadowToolset([], options).map((tool) => tool.name);
    expect(plain).not.toContain(SHADOW_WORK_UPDATE_TOOL);
    const tools = createShadowToolset([], {
      ...options, get recorder() { return holder.recorder; },
      workRecord: { append: (items) => { recorded.push(...items); return items.length; }, read: () => "record" },
    });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([SHADOW_WORK_UPDATE_TOOL, SHADOW_WORK_READ_TOOL]));
    const update = tools.find((tool) => tool.name === SHADOW_WORK_UPDATE_TOOL)!;
    await update.execute("1", { attachments: [{ file: "slack:F1", content: "账号被冻结" }], open: ["等对方回"], resolved: [{ entry: 3 }] } as never, undefined, undefined, {} as never);
    expect(recorded).toEqual([
      { kind: "attachment", ref: "slack:F1", text: "账号被冻结" },
      { kind: "open", text: "等对方回" },
      { kind: "resolved", ref: "#3", text: "处理完了" },
    ]);
    // 下一批换了记账：finish_shadow 记在新的那一份上。
    const finish = tools.find((tool) => tool.name === SHADOW_FINISH_TOOL)!;
    const first = holder.recorder;
    holder.recorder = new ShadowRecorder();
    await finish.execute("2", { done: [{ ids: [7], line: "x" }], escalate: [] } as never, undefined, undefined, {} as never);
    expect(first.report).toBeNull();
    expect(holder.recorder.report).toEqual({ done: [{ ids: [7], line: "x" }], escalate: [] });
  });

  it("tells the shadow to land each reply on its own message and that conversations share one session", () => {
    expect(SHADOW_SECTION).toContain("落到那条消息自己的卡和回复位置");
    expect(SHADOW_SECTION).toContain("外部消息按对话进同一个会话");
    expect(SHADOW_SECTION).toContain("用户在不在看会话都一样");
  });
});

// 回归（2026-11-10，.scratch/tool-occupancy/spec.md）：一个不理中止信号的工具占住了 Lead 的一步。红线到点中止，
// 5 秒后 abort.stuck，用户的插话排了十几分钟。这里用真实的 pi 会话（隔离的设置，pi-ai 的假模型）复现：模型调一个
// 不理 signal、迟迟不返回的工具，然后中止会话。修好以前 prompt 和 abort 都挂住；修好以后宽限一过这一步就结束，
// 工具给 pi 的结果说它转到了后台，工具真正的结果之后交回 Lead。
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIsolatedLookupSession, type LookupSession } from "../src/lookup/session.js";
import type { LeadBackgroundJob, LeadBackgroundJobs } from "../src/background-jobs.js";
import { isAbortGuarded, LEAD_TOOL_ABORT_GRACE_MS_ENV } from "../src/tool-abort-guard.js";

const sessions: LookupSession[] = [];
const savedGrace = process.env[LEAD_TOOL_ABORT_GRACE_MS_ENV];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  if (savedGrace === undefined) delete process.env[LEAD_TOOL_ABORT_GRACE_MS_ENV];
  else process.env[LEAD_TOOL_ABORT_GRACE_MS_ENV] = savedGrace;
});

const delay = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

describe("the Lead session's tool list", () => {
  // 兜底装在 agent.state.tools 上：Lead 的自定义工具、hands 的 bash/edit/write、pi 的内置工具、SoL-Pi 和扩展的工具
  // 都要包上，换过工具表（syncToolAccess）以后也是。
  it("guards every tool pi can call, also after the tool list is synced again", async () => {
    const dataDir = tempDir("plc-abort-guard-lead-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: {
          stub: {
            api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: { value: "test" }, discover: false,
            models: [{ id: "m", contextWindow: 64_000, maxTokens: 2_000 }],
          },
        },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db, log: () => {} });
    try {
      const agent = (lead.session as unknown as { agent: { state: { tools: Array<{ name: string }> } } }).agent;
      const names = agent.state.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["bash", "run_on_host", "get_runtime_health"]));
      expect(agent.state.tools.filter((tool) => !isAbortGuarded(tool)).map((tool) => tool.name)).toEqual([]);
      lead.syncToolAccess();
      expect(agent.state.tools.filter((tool) => !isAbortGuarded(tool)).map((tool) => tool.name)).toEqual([]);
    } finally {
      (lead.session as unknown as { dispose(): void }).dispose();
      db.close();
    }
  }, 60_000);
});

describe("a tool that ignores the abort signal inside a real pi session", () => {
  it("cannot hold the step after the session is aborted, and its late result still comes back", async () => {
    process.env[LEAD_TOOL_ABORT_GRACE_MS_ENV] = "300";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    // 像 2026-11-10 的 run_on_host：不接收 signal，命令跑完才返回。
    const download = defineTool({
      name: "slow_download",
      label: "Slow Download",
      description: "下载一个很大的文件。",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        markStarted();
        await released;
        return { content: [{ type: "text" as const, text: "下载完了" }], details: {} };
      },
    });
    const faux = fauxProvider({ provider: "plc-abort-guard-test", api: "plc-abort-guard-test-api" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slow_download", { command: "softwareupdate -d x" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好的。"),
    ]);
    const finished: Array<LeadBackgroundJob & { text: string; isError: boolean }> = [];
    const jobs: LeadBackgroundJobs = { started: () => {}, finished: (job) => { finished.push(job); } };
    const session = await createIsolatedLookupSession({
      workDir: tempDir("plc-abort-guard-session-"), systemPrompt: "你是测试助手。", tools: [download],
      model: faux.getModel() as never, thinkingLevel: "off", retry: false, backgroundJobs: jobs,
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
    });
    sessions.push(session);
    const events: any[] = [];
    session.subscribe((event: any) => events.push(event));

    const prompt = session.prompt("下载一下").then(() => "settled" as const, () => "settled" as const);
    await started;
    const aborting = session.abort().then(() => "settled" as const);

    // 宽限 300 毫秒；给 3 秒足够。修好以前两个都是 timeout。
    expect(await Promise.race([prompt, delay(3_000)])).toBe("settled");
    expect(await Promise.race([aborting, delay(3_000)])).toBe("settled");
    const end = events.find((event) => event.type === "tool_execution_end" && event.toolName === "slow_download");
    const text = JSON.stringify(end?.result ?? null);
    expect(text).toContain("转到后台");
    expect(text).toMatch(/作业 job_/);

    // 工具之后才真正返回：结果经后台作业交回。
    release();
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]).toMatchObject({ tool: "slow_download", text: "下载完了", isError: false, command: "softwareupdate -d x" });
  }, 20_000);
});

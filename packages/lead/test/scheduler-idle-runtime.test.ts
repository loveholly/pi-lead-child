// 空闲车道的运行层和 pi 扩展，接在一个真的 pi 会话上（lead-scheduler spec D8，P4）。模型是 faux，写摘要的子进程换成替身
// （summarize）。pi 的压缩流程（session.compact、阈值检查、session_before_compact、compaction_end）都是真的。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { compactionChunksExtension } from "../src/compaction-chunks.js";
import {
  DEFAULT_IDLE_LANE_LIMITS, IDLE_APPLY_INSTRUCTIONS, idleLaneExtension, IdleLaneRuntime,
  type IdleCompactRequest, type IdleLaneHost, type SummarizeInChildOptions, type SummarizeInChildResult,
} from "../src/scheduler/index.js";

// 窗口 8000，预留 2000：pi 的压缩线是 6000 token。一条 4000 字的消息约 1000 token。
const WINDOW = 8_000;
const big = (tokens: number, tag: string) => `${tag} ${"x".repeat(tokens * 4)}`;

interface Harness {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  runtime: IdleLaneRuntime;
  logs: string[];
  records: Array<Record<string, unknown>>;
  requests: IdleCompactRequest[];
  inlineSummaries: number;
  // 写摘要的替身：每次调用一个，测试决定什么时候写完。
  pending: Array<{ resolve: (summary: string) => void; fail: (error: string) => void; signal: AbortSignal | undefined }>;
  host: { unit: string | null; ratio: number | null };
  close: () => void;
}

let harness: Harness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

async function boot(limits: Partial<typeof DEFAULT_IDLE_LANE_LIMITS> = {}): Promise<Harness> {
  const dataDir = tempDir("plc-idle-runtime-");
  const agentDir = join(dataDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const logs: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const requests: IdleCompactRequest[] = [];
  const pending: Harness["pending"] = [];
  const state = { unit: null as string | null, ratio: null as number | null };
  let session: Harness["session"] | null = null;
  const host: IdleLaneHost = {
    log: (line) => logs.push(line),
    record: (payload) => records.push(payload),
    currentUnit: () => state.unit,
    starting: () => false,
    pendingInput: () => false,
    contextRatio: () => state.ratio,
    // 整理笔记那一轮：和 daemon 一样开一个 L4 单元，结束时告诉空闲车道。
    runPrecipitation: async () => {
      runtime.unitOpened("unit_notes", 4);
      await new Promise((resolve) => setTimeout(resolve, 5));
      runtime.unitClosed();
      return "done";
    },
    writeInFlight: () => null,
    yieldUnit: () => {},
    compact: (instructions) => session!.compact(instructions),
  };
  const summarize = (request: IdleCompactRequest, options: SummarizeInChildOptions) => {
    requests.push(request);
    return new Promise<SummarizeInChildResult>((resolve) => {
      pending.push({
        resolve: (summary) => resolve({ response: { ok: true, summary, details: { chunks: 1 }, chunks: 1, level: "normal" }, ms: 5 }),
        fail: (error) => resolve({ response: { ok: false, error }, ms: 5 }),
        signal: options.signal,
      });
      options.signal?.addEventListener("abort", () => resolve({ response: { ok: false, error: "cancelled" }, ms: 5 }), { once: true });
    });
  };
  const runtime = new IdleLaneRuntime({ host, limits: { ...DEFAULT_IDLE_LANE_LIMITS, graceMs: 0, ...limits }, summarize });
  const counters = { inline: 0 };
  const faux = fauxProvider({ provider: "plc-idle-test", api: "plc-idle-test-api", models: [{ id: "faux-small", contextWindow: WINDOW, maxTokens: 500 }] });
  faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("ok")));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_200 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dataDir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "test",
    extensionFactories: [
      { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      // 和 session.ts 一样：空闲车道排在分段压缩之前，分段压缩认 skip。
      { name: "plc-idle-lane", factory: idleLaneExtension(runtime) },
      {
        name: "plc-compaction-chunks",
        factory: compactionChunksExtension({
          instructions: "keep what matters",
          skip: (event) => runtime.claims(event),
          summarize: (async () => {
            counters.inline += 1;
            return { text: "INLINE SUMMARY", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          }) as never,
        }),
      },
    ],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: dataDir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
    resourceLoader: loader, sessionManager: SessionManager.inMemory(dataDir), settingsManager, tools: [],
  });
  session = created.session;
  await session.bindExtensions({});
  // daemon 在 compaction_end 时告诉空闲车道（server.ts 的会话事件）。
  session.subscribe((event: any) => {
    if (event.type === "compaction_end") runtime.compactionEnded(event);
  });
  const result: Harness = {
    session, runtime, logs, records, requests, pending, host: state,
    get inlineSummaries() { return counters.inline; },
    close: () => { runtime.stop(); session!.dispose(); },
  };
  return result;
}

const compactions = (h: Harness) => h.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction") as Array<{ summary: string; details?: any; firstKeptEntryId: string }>;
const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("idle lane on a real pi session", () => {
  it("writes the summary off the session while Lead is idle, then applies it in one step", async () => {
    harness = await boot();
    const h = harness;
    for (const tag of ["one", "two", "three"]) await h.session.prompt(big(1_200, tag), { expandPromptTemplates: false });
    expect(compactions(h)).toHaveLength(0);
    // Lead 空闲，上下文过了空闲车道的线（0.8）：开始。
    h.host.ratio = 0.82;
    h.runtime.check();
    await until(() => h.pending.length === 1);
    // 子进程拿到的是 pi 算好的 preparation，能写进 JSON（fileOps 是数组）。
    const request = h.requests[0]!;
    expect(request.preparation.messagesToSummarize.length).toBeGreaterThan(0);
    expect(Array.isArray(request.preparation.fileOps.read)).toBe(true);
    expect(JSON.parse(JSON.stringify(request)).preparation.firstKeptEntryId).toBe(request.preparation.firstKeptEntryId);
    // 取对话时会话没有被压缩（pi 取消了那一次），也没有就地写摘要。
    expect(compactions(h)).toHaveLength(0);
    expect(h.runtime.state.compact.phase).toBe("summarizing");
    h.pending[0]!.resolve("IDLE SUMMARY");
    await until(() => compactions(h).length === 1);
    await h.runtime.sessionFree();
    const [entry] = compactions(h);
    expect(entry!.summary).toBe("IDLE SUMMARY");
    expect(entry!.details).toMatchObject({ idleLane: expect.stringMatching(/^idle_compact_/) });
    expect(entry!.firstKeptEntryId).toBe(request.preparation.firstKeptEntryId);
    expect(h.inlineSummaries).toBe(0);
    expect(h.runtime.state.compact.phase).toBe("idle");
    // 先整理笔记（压缩以后没存的细节只剩摘要），再压缩。
    const events = h.logs.map((line) => `${line.split(" ")[1]}${/ job=(\w+)/.exec(line)?.[1] ? `:${/ job=(\w+)/.exec(line)![1]}` : ""}`);
    expect(events).toEqual([
      "idle.start:precipitate", "idle.done:precipitate",
      "idle.start:compact", "idle.compact.summarizing", "idle.done:compact", "idle.apply:compact", "idle.applied:compact",
    ]);
    expect(h.records.map((record) => `${record.job}:${record.event}`)).toEqual([
      "precipitate:started", "precipitate:done", "compact:started", "compact:summarized", "compact:applied",
    ]);
    // 会话照常能用。
    await h.session.prompt("after", { expandPromptTemplates: false });
  }, 30_000);

  it("defers pi's compaction in the middle of a unit, then uses the summary the child wrote", async () => {
    harness = await boot();
    const h = harness;
    h.runtime.unitOpened("unit_user", 0);
    h.host.unit = "unit_user";
    for (const tag of ["one", "two", "three", "four", "five"]) await h.session.prompt(big(1_200, tag), { expandPromptTemplates: false });
    // pi 到了压缩线（6000），想就地压缩：推迟，同时子进程开始写（提级）。
    expect(h.pending).toHaveLength(1);
    expect(compactions(h)).toHaveLength(0);
    expect(h.inlineSummaries).toBe(0);
    expect(h.logs.some((line) => /idle\.defer job=compact .*reason=threshold unit=unit_user lane=L0 deferrals=1 .*promoted=true/.test(line))).toBe(true);
    h.pending[0]!.resolve("PROMOTED SUMMARY");
    await until(() => h.runtime.state.compact.phase === "ready");
    // 还在单元里：pi 下一次检查时直接用写好的摘要（几毫秒），不就地写。
    await h.session.prompt("small", { expandPromptTemplates: false });
    expect(compactions(h).map((entry) => entry.summary)).toEqual(["PROMOTED SUMMARY"]);
    expect(h.inlineSummaries).toBe(0);
    expect(h.logs.some((line) => /idle\.inline job=compact id=idle_compact_\w+ reason=threshold action=supply unit=unit_user/.test(line))).toBe(true);
    expect(h.logs.at(-1)).toMatch(/idle\.applied job=compact .*unit=unit_user lane=L0/);
  }, 30_000);

  it("on overflow, waits for the summary the child is writing instead of writing another one in place", async () => {
    harness = await boot();
    const h = harness;
    h.runtime.unitOpened("unit_user", 0);
    h.host.unit = "unit_user";
    for (const tag of ["one", "two", "three", "four", "five"]) await h.session.prompt(big(1_200, tag), { expandPromptTemplates: false });
    expect(h.pending).toHaveLength(1);
    // pi 溢出时调扩展（这里直接调，preparation 和会话里的一样）；子进程 50 毫秒后写完。
    const branchEntries = h.session.sessionManager.getBranch();
    const event = {
      type: "session_before_compact", reason: "overflow", willRetry: true, customInstructions: undefined,
      preparation: { ...h.requests[0]!.preparation, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
      branchEntries, signal: new AbortController().signal,
    } as never;
    setTimeout(() => h.pending[0]!.resolve("WAITED SUMMARY"), 50);
    const result = await h.runtime.beforeCompact(event, { model: undefined, modelRegistry: undefined } as never);
    expect(result).toMatchObject({ compaction: { summary: "WAITED SUMMARY", firstKeptEntryId: h.requests[0]!.preparation.firstKeptEntryId } });
    expect(h.logs.some((line) => /^\[sched\] idle\.overflow_wait job=compact id=idle_compact_\w+ waitedMs=\d+ ready=true unit=unit_user$/.test(line))).toBe(true);
    expect(h.logs.some((line) => /idle\.inline job=compact .*reason=overflow action=supply/.test(line))).toBe(true);
    expect(h.inlineSummaries).toBe(0);
  }, 30_000);

  it("compacts in place after the deadline when the summary is not ready (the fallback), and stops the child", async () => {
    harness = await boot({ deferMaxMs: 0 });
    const h = harness;
    h.runtime.unitOpened("unit_busy", 2);
    h.host.unit = "unit_busy";
    for (const tag of ["one", "two", "three", "four", "five", "six"]) await h.session.prompt(big(1_200, tag), { expandPromptTemplates: false });
    expect(h.logs.some((line) => line.includes("idle.compact.forced unit=unit_busy lane=L2 reason=threshold"))).toBe(true);
    expect(compactions(h).at(-1)?.summary).toContain("INLINE SUMMARY");
    expect(h.inlineSummaries).toBeGreaterThan(0);
    // 别处压缩成了：还在写的摘要用不上，子进程被叫停。
    expect(h.pending[0]?.signal?.aborted).toBe(true);
    expect(h.logs.some((line) => /idle\.discard job=compact .*why=compacted_by_threshold/.test(line))).toBe(true);
  }, 30_000);

  it("drops a ready summary that no longer fits the session", async () => {
    harness = await boot();
    const h = harness;
    for (const tag of ["one", "two", "three"]) await h.session.prompt(big(1_200, tag), { expandPromptTemplates: false });
    h.runtime.unitOpened("unit_user", 0);
    h.host.unit = "unit_user";
    h.host.ratio = 0.82;
    // 单元开着：空闲车道不开始；单元结束后开始，写摘要期间用户又开了一个单元。
    h.runtime.unitClosed();
    h.host.unit = null;
    h.runtime.check();
    await until(() => h.pending.length === 1);
    h.runtime.unitOpened("unit_next", 0);
    h.host.unit = "unit_next";
    // 这期间会话被别处压缩了（例如 daemon 的恢复压缩）。
    await h.session.compact("manual compaction elsewhere");
    expect(compactions(h)).toHaveLength(1);
    h.pending[0]!.resolve("STALE SUMMARY");
    await until(() => h.logs.some((line) => line.includes("idle.discard")));
    h.runtime.unitClosed();
    h.host.unit = null;
    h.runtime.check();
    await h.runtime.sessionFree();
    expect(compactions(h).map((entry) => entry.summary)).not.toContain("STALE SUMMARY");
    // 有人直接要接上一份无效的摘要时，pi 被要求取消，不留压缩。
    for (const tag of ["six", "seven"]) await h.session.prompt(big(1_000, tag), { expandPromptTemplates: false });
    await expect(h.session.compact(IDLE_APPLY_INSTRUCTIONS)).rejects.toThrow(/cancelled/i);
    expect(compactions(h)).toHaveLength(1);
    expect(h.logs.some((line) => /idle\.discard job=compact .*why=compacted_by_manual/.test(line))).toBe(true);
    expect(h.pending[0]!.signal?.aborted).toBe(true);
  }, 30_000);
});

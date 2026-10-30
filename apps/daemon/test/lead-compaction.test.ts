// Lead 的上下文压缩（pi 的 auto-compaction）失败时，daemon 要知道。
// 2026-10-16：GitHub 连接的大结果把上下文推到约 15 万 token，溢出压缩从 11:04 跑到 12:14，五次 compaction_end 都没留下压缩记录，
// daemon 的日志却每次都写「compaction done」，顶栏一直是绿点（server.ts 的 compaction_end 只是重新武装整理笔记）。
// 现在：compaction_end 读 aborted 和 errorMessage。失败时日志写明失败和原因，Lead 的健康状态变成降级（顶栏看得到），
// Lead 的下一轮也知道。压缩有超时（PLC_LEAD_COMPACTION_TIMEOUT_MS）：超时后 daemon 用 pi 的 abortCompaction 中止它，按失败处理。
// 成功的压缩照常重新武装整理笔记。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addInbox, createItem, createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { compactionEndOutcome, createLeadHealthTracker } from "../src/lead-health.js";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-compaction-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_DRAIN_MS", "50");
  vi.stubEnv("PLC_LEAD_ABORT_GRACE_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 用户的一轮之后 pi 做的压缩：ok 成功，fail 失败（带 pi 的 errorMessage），hang 一直不结束，直到 abortCompaction。
type Compaction = { kind: "ok" } | { kind: "fail"; errorMessage: string } | { kind: "hang" };

// 不调用模型的 Lead。每一轮先回答一句话，再按 plan 的下一项做一次压缩（整理笔记那一轮只回 NO_REPLY，不压缩）。
function stubLead(plan: Array<Compaction | null>, options: { contextFull?: boolean } = {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const say = (text: string) => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
  };
  let endCompaction: (() => void) | null = null;
  const aborts: number[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      ...(options.contextFull ? {
        model: { contextWindow: 100 },
        agent: { state: { messages: [{ role: "assistant", usage: { input: 90, output: 0, cacheRead: 0 } }] } },
      } : {}),
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      abortCompaction() {
        aborts.push(Date.now());
        endCompaction?.();
      },
      async prompt(message: string) {
        prompts.push(message);
        if (message.includes("沉淀检查")) {
          say("NO_REPLY");
          return;
        }
        say("好的。");
        const step = plan.shift() ?? null;
        if (!step) return;
        emit({ type: "compaction_start", reason: "threshold" });
        if (step.kind === "ok") {
          emit({
            type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
            result: { summary: "摘要", firstKeptEntryId: "entry-1", tokensBefore: 90_000 },
          });
        } else if (step.kind === "fail") {
          emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: step.errorMessage });
        } else {
          await new Promise<void>((resolve) => { endCompaction = resolve; });
          endCompaction = null;
          emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts, aborts };
}

async function start(lead: ReturnType<typeof stubLead>) {
  const logs: string[] = [];
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: (line) => logs.push(line) });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" };
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, { headers })).json()) as
    { lead?: Record<string, any> };
  let sent = 0;
  const chat = async (message: string) => {
    sent += 1;
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers, body: JSON.stringify({ id: `cmd-${sent}`, message }),
    });
    expect(response.ok).toBe(true);
  };
  return { logs, overview, chat };
}

const userPrompts = (prompts: string[]) => prompts.filter((prompt) => !prompt.includes("沉淀检查"));

describe("a failed compaction", () => {
  it("is logged as a failure with its reason, turns Lead degraded, and is told to Lead in the next turn", async () => {
    const lead = stubLead([{ kind: "fail", errorMessage: "Auto-compaction failed: 503 upstream connect error" }]);
    const { logs, overview, chat } = await start(lead);

    await chat("看一下 #77");
    await vi.waitFor(async () => expect((await overview()).lead).toMatchObject({
      state: "degraded", reason: "Paimon 的上下文压缩失败",
    }));
    expect((await overview()).lead!.detail).toContain("Auto-compaction failed: 503 upstream connect error");
    expect(logs.some((line) => line.includes("compaction failed") && line.includes("Auto-compaction failed"))).toBe(true);
    expect(logs.some((line) => line.includes("compaction done"))).toBe(false);

    await chat("再看一下");
    await vi.waitFor(() => expect(userPrompts(lead.prompts)).toHaveLength(2));
    expect(userPrompts(lead.prompts)[1]).toContain("上下文压缩失败");
    expect(userPrompts(lead.prompts)[1]).toContain("Auto-compaction failed");
    // 这一轮模型调用成功：Lead 又能工作了。
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("online"));
  });

  // 工单 14 第 6 项：以前「告诉 Lead」靠 daemon 内存里的 leadSelfNotes，daemon 重启就丢了。
  // 现在压缩失败是一条事件（lead.compaction_failed），按 Lead 的事件游标交给它：重启以后的第一轮照样知道，只说一次。
  it("is still told to Lead after a daemon restart, once, because it is an event in the log", async () => {
    const lead = stubLead([{ kind: "fail", errorMessage: "Auto-compaction failed: 503 upstream connect error" }]);
    const first = await start(lead);
    await first.chat("看一下 #77");
    await vi.waitFor(async () => expect((await first.overview()).lead?.state).toBe("degraded"));
    await daemon!.close();
    daemon = null;

    expect(listEvents(db, { kind: "lead.compaction_failed" })).toMatchObject([{
      source: "lead", entityKey: "lead:main", level: "record",
      rootCause: { code: "lead_compaction_failed", message: expect.stringContaining("Auto-compaction failed") },
      payload: { reason: "threshold", timedOut: false },
    }]);

    const next = stubLead([]);
    const second = await start(next);
    await second.chat("再看一下");
    await vi.waitFor(() => expect(userPrompts(next.prompts)).toHaveLength(1));
    expect(userPrompts(next.prompts)[0]).toContain("上下文压缩失败");
    expect(userPrompts(next.prompts)[0]).toContain("Auto-compaction failed");
    // 这一轮成功了，算告诉过：下一轮不再说。
    await second.chat("第三条");
    await vi.waitFor(() => expect(userPrompts(next.prompts)).toHaveLength(2));
    expect(userPrompts(next.prompts)[1]).not.toContain("Auto-compaction failed");
  });

  it("does not count as Lead being unable to work: new work still goes to Lead, not to the fallback summary", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "50");
    const lead = stubLead([{ kind: "fail", errorMessage: "Auto-compaction failed: 503 upstream connect error" }]);
    const { overview, chat } = await start(lead);

    await chat("看一下 #77");
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("degraded"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "system" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "Run #7 crashed", lossless: true });

    await vi.waitFor(() => expect(lead.prompts.some((prompt) => prompt.includes("Run #7 crashed"))).toBe(true));
    expect(db.prepare("SELECT count(*) AS n FROM notifications WHERE kind = 'lead_unavailable'").get()).toEqual({ n: 0 });
  });

  it("is aborted when it runs past the timeout, and counts as failed", async () => {
    vi.stubEnv("PLC_LEAD_COMPACTION_TIMEOUT_MS", "100");
    const lead = stubLead([{ kind: "hang" }]);
    const { logs, overview, chat } = await start(lead);

    await chat("看一下 #77");
    await vi.waitFor(() => expect(lead.aborts).toHaveLength(1), { timeout: 2_000 });
    await vi.waitFor(async () => expect((await overview()).lead).toMatchObject({
      state: "degraded", reason: "Paimon 的上下文压缩失败",
    }));
    expect((await overview()).lead!.detail).toContain("超时");
    expect(logs.some((line) => line.includes("compaction failed"))).toBe(true);
  });
});

describe("a compaction that succeeds", () => {
  it("re-arms note keeping and leaves Lead online; a failed one does not re-arm it", async () => {
    // 上下文一直在 90%：第一轮之后整理一次笔记。第二轮压缩成功：之后可以再整理一次。第三轮压缩失败：不再整理。
    const lead = stubLead([null, { kind: "ok" }, { kind: "fail", errorMessage: "Auto-compaction failed: boom" }], { contextFull: true });
    const { logs, overview, chat } = await start(lead);
    const notes = () => lead.prompts.filter((prompt) => prompt.includes("沉淀检查")).length;

    await chat("第一轮");
    await vi.waitFor(() => expect(notes()).toBe(1));
    await chat("第二轮");
    await vi.waitFor(() => expect(notes()).toBe(2));
    expect(logs.some((line) => line.includes("compaction done"))).toBe(true);
    expect((await overview()).lead?.state).toBe("online");

    await chat("第三轮");
    await vi.waitFor(() => expect(userPrompts(lead.prompts)).toHaveLength(3));
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("degraded"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notes()).toBe(2);
  });
});

describe("compactionEndOutcome", () => {
  it("reads pi's aborted and errorMessage fields", () => {
    expect(compactionEndOutcome({ result: { summary: "s" }, aborted: false }, { timedOut: false, timeoutMs: 600_000 }))
      .toEqual({ kind: "succeeded" });
    expect(compactionEndOutcome({ result: undefined, aborted: false, errorMessage: "Auto-compaction failed: x" }, { timedOut: false, timeoutMs: 600_000 }))
      .toEqual({ kind: "failed", detail: "上下文压缩失败：Auto-compaction failed: x" });
    expect(compactionEndOutcome({ result: undefined, aborted: true }, { timedOut: true, timeoutMs: 600_000 }))
      .toEqual({ kind: "failed", detail: "上下文压缩超时：10 分钟没有完成，daemon 中止了它。" });
    // 被别的原因中止（daemon 停机、用户停止）：不是模型的问题。
    expect(compactionEndOutcome({ result: undefined, aborted: true }, { timedOut: false, timeoutMs: 600_000 }))
      .toEqual({ kind: "aborted" });
    expect(compactionEndOutcome({ result: undefined, aborted: false }, { timedOut: false, timeoutMs: 600_000 }))
      .toEqual({ kind: "failed", detail: "上下文压缩失败：没有得到压缩结果。" });
  });
});

describe("the Lead health tracker", () => {
  it("shows a compaction failure as its own reason until the next successful model call", () => {
    const changes: string[] = [];
    const health = createLeadHealthTracker({ nextScheduledAttempt: () => null, onChange: (status) => changes.push(status.state) });
    // 压缩失败不算模型调用的失败（failures 不变）：停摆兜底只看模型调用的失败。
    health.compactionFailed("上下文压缩失败：Auto-compaction failed: 503");
    expect(health.status()).toMatchObject({
      state: "degraded", failures: 0, reason: "Paimon 的上下文压缩失败", detail: "上下文压缩失败：Auto-compaction failed: 503",
    });
    expect(health.status().since).not.toBeNull();
    // 之后的模型调用失败：顶栏写最近的那一种。
    health.failed("503 Service Unavailable");
    expect(health.status()).toMatchObject({ failures: 1, reason: "Paimon 的模型服务暂时连不上", detail: "503 Service Unavailable" });
    // 溢出以后压缩又失败（2026-10-16 那一次）：写压缩失败，模型调用的失败次数照记。
    health.compactionFailed("上下文压缩超时：10 分钟没有完成，daemon 中止了它。");
    expect(health.status()).toMatchObject({ failures: 1, reason: "Paimon 的上下文压缩失败" });
    health.succeeded();
    expect(health.status()).toMatchObject({ state: "online", reason: null, detail: null });
    expect(changes).toEqual(["degraded", "degraded", "degraded", "online"]);
  });
});

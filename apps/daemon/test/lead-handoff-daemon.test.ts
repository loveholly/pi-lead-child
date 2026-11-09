// 交接的完整流程（lead-scheduler spec P2「测试」的集成测试，H1–H10）。daemon、网关、store、child manager 都是真的；
// Lead 的会话是按 pi 规则写的替身（fake-pi-session.ts），它像真的调度器 extension 一样叫 daemon 的钩子（做过的步骤、
// 每一步的预算状态、让出点），hand_off 和 resume_unit 用真的工具实现。子 agent 是回放的 Claude Run：最后一条消息带着成果信封，
// Run 结束时系统登记成果，轻子 agent 的工单直接结单。人名、仓库和原文都是编造的。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadToolset, runningChildren } from "@pi-lead-child/lead";
import { ClaudeRuntime, RuntimeRegistry, type AgentRuntime, type RuntimeCapabilities, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { addInbox, createItem, createLoopbackBinding, getItem, isLightTask, itemHandoff, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-handoff-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
  vi.stubEnv("PLC_LEAD_RED_LINE_MS", "600000");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_WRITE_GRACE_MS", "5000");
  vi.stubEnv("PLC_LEAD_HANDOFF_MS", "3000");
  vi.stubEnv("PLC_LEAD_STEP_P90_MS", "0");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  while (runningChildren().size > 0) await Promise.allSettled(runningChildren().values());
  db.close();
  vi.unstubAllEnvs();
  delete process.env.PLC_CHILD_LINGER_MS;
});

const never = new Promise<void>(() => {});
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const RED = 'kind="red_line"';

// 轻子 agent：调了 ticket_update（回执丢了），最后一条消息带着成果信封。系统登记成果，工单进 review，轻子 agent 的工单直接结单。
function lightChildDelivers(summary: string): RecordedEvent[] {
  const envelope = `PLC_OUTCOME_V1 ${JSON.stringify({
    summary, changes: [], deliverables: [],
    validations: [{ command: "对比最近 20 次的耗时", outcome: "passed", exitCode: null, summary: "看过了", evidenceRef: null }],
  })}`;
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: "light-child", runtimeVersion: "test" },
    { type: "tool.started", callId: "c-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "c-1", name: "mcp__plc__ticket_update", error: "socket closed" },
    { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: `${summary}\n\n${envelope}` },
    { type: "run.completed", exitCode: 0 },
  ];
}

// 回放的子 agent。hand_off 不点名 runtime，系统按本机的目录和健康度选：三种都登记成同一个回放，共用录制和收到的说明。
class ChildRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities = { ...new ClaudeRuntime().capabilities, resume: true };
  constructor(readonly id: "claude" | "codex" | "pi", private readonly shared: { recordings: RecordedEvent[][]; briefs: string[] }) {}
  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.shared.briefs.push(request.prompt);
    const events = this.shared.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events: events.map((event) => event.type === "run.started" ? { ...event, runtime: this.id } : event) }).start(request);
  }
}

// 真的 hand_off、resume_unit（lead 的 hand-off-tool.ts）：用 daemon 交给会话工厂的依赖建 Lead 的工具。
async function realTool(name: string, args: Record<string, unknown>, deps: any) {
  const tool = createLeadToolset(deps).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  try {
    return await tool.execute(`call-${name}`, args as never, undefined, undefined, undefined as never) as {
      content: Array<{ type: "text"; text: string }>; details?: unknown;
    };
  } catch (error) {
    if (process.env.HANDOFF_TEST_DEBUG) console.log(`TOOL ${name} FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    throw error;
  }
}

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>, recordings: RecordedEvent[][] = []) {
  const logs: string[] = [];
  const runtime = { recordings, briefs: [] as string[] };
  const lead = fakePiLead(script, {
    hooks: true,
    tools: {
      hand_off: (args, deps) => realTool("hand_off", args, deps),
      resume_unit: (args, deps) => realTool("resume_unit", args, deps),
    },
  });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); if (process.env.HANDOFF_TEST_DEBUG) console.log(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
    runtimeRegistry: new RuntimeRegistry((["claude", "codex", "pi"] as const).map((id) => new ChildRuntime(id, runtime))),
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const say = async (id: string, message: string): Promise<{ turnId: string; mode: string }> => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message }),
    });
    const body = await response.json() as { turnId: string; mode: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  const turn = (id: string) => db.prepare("SELECT state, assistant_text FROM channel_turns WHERE id = ?").get(id) as
    { state: string; assistant_text: string };
  return { say, lead, logs, turn, runtime };
}

function handoffTicket(): number {
  const row = db.prepare(
    "SELECT item_id FROM activities WHERE kind='decision' AND json_extract(payload, '$.decision')='lead_handoff' ORDER BY id DESC LIMIT 1",
  ).get() as { item_id: number } | undefined;
  return row?.item_id ?? 0;
}

function storedPackage(id: string): any {
  return JSON.parse(readFileSync(join(dir, "lead-handoffs", id, "package.json"), "utf8"));
}

function storedState(id: string): any {
  return JSON.parse(readFileSync(join(dir, "lead-handoffs", id, "state.json"), "utf8"));
}

describe("a hand-off, from the user's request to the relayed result", () => {
  // S5、S6：用户的请求，Lead 就地做了 2 步，发现比预估大，hand_off 一次交出去。
  it("hands off midway in one call, confirms within 10 s, and relays the result in the user's lane", async () => {
    const RESULT = "根因：集成测试每次都重新拉起数据库，占了 6 分钟里的 4 分钟。";
    let handOffStarted = 0;
    const { say, lead, logs, turn, runtime } = await boot((call) => {
      // 结果交回的那一轮先认：说明里有工单的标题（「交接：查清 …」）。
      if (has(call, "用户在等：写一条回复转告结果")) return { say: `后台 agent 查完了。${RESULT}` };
      if (has(call, "查清 acme/a 的发版为什么变慢了")) return { tools: [{ name: "read", args: { path: "/Users/alice/acme/a/ci.yml" } }] };
      if (call.index === 1) return { tools: [{ name: "grep", args: { pattern: "timeout", path: "/Users/alice/acme/a" } }] };
      if (call.index === 2) {
        handOffStarted = Date.now();
        return { tools: [{ name: "hand_off", args: { note: "CI 配置看过了，慢在集成测试；还要对比最近 20 次的耗时。" } }] };
      }
      if (call.index === 3) return { say: "交给了后台 agent，大约 3–5 分钟有结果，你可以接着说别的。" };
      return { say: "好的。" };
    }, [lightChildDelivers(RESULT)]);

    const sent = await say("h1", "查清 acme/a 的发版为什么变慢了");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] handoff "))).toBe(true), { timeout: 10_000 });
    const ticketId = handoffTicket();

    // 交接包进了账本（工单上的一条决定）和数据目录；子 agent 的说明就是交接包。
    const recorded = itemHandoff(db, ticketId)!;
    expect(recorded).toMatchObject({ entry: "lead_midway", lane: 0, steps: 2, committed: 0, external: false });
    expect(isLightTask(db, ticketId)).toBe(true);
    const pkg = storedPackage(recorded.packageId);
    expect(pkg.goal).toMatchObject({ text: "查清 acme/a 的发版为什么变慢了", source: "user", lane: 0 });
    expect(pkg.steps.map((step: any) => step.tool)).toEqual(["read", "grep"]);
    expect(pkg.note).toContain("慢在集成测试");
    expect(pkg.touched).toEqual(expect.arrayContaining([{ kind: "path", ref: "/Users/alice/acme/a/ci.yml" }]));
    expect(getItem(db, ticketId)!.brief).toContain("## 已经做过的步骤");

    // 10 秒内出确认：交接一次调用，会话里这一轮的回答说了交给后台 agent。
    const handoffLine = logs.find((line) => line.startsWith("[sched] handoff ") && line.includes(`ticket=${ticketId}`))!;
    expect(handoffLine).toContain("entry=lead_midway");
    expect(Number(/ ms=(\d+)/u.exec(handoffLine)![1])).toBeLessThan(10_000);
    await vi.waitFor(() => expect(turn(sent.turnId).assistant_text).toContain("交给了后台 agent"), { timeout: 5_000 });
    expect(Date.now() - handOffStarted).toBeLessThan(30_000);

    // 每一步的预算状态附在工具结果后面。
    expect(lead.calls[1]!.inputs.some((input) => input.includes('kind="budget"') && input.includes("L0 · 已用"))).toBe(true);

    // 轻子 agent 起来了，拿到的说明是交接包；它交回以后系统结单。
    await vi.waitFor(() => expect(runtime.briefs.length).toBe(1), { timeout: 10_000 });
    expect(runtime.briefs[0]).toContain("CI 配置看过了");
    await vi.waitFor(() => expect(getItem(db, ticketId)!.stage).toBe("done"), { timeout: 10_000 });

    // 结果以 L0 交回 Lead，Lead 写一条回复转告。
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "用户在等：写一条回复转告结果"))).toBe(true), { timeout: 10_000 });
    const relay = lead.calls.find((call) => has(call, "用户在等：写一条回复转告结果"))!;
    expect(relay.inputs.join("\n")).toContain(RESULT);
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] lane ") && line.includes("to=L0") && line.includes("why=handoff_result"))).toBe(true), { timeout: 5_000 });
    // 交回的结果写明它是从哪个单元交出去的（plc sched trace 据此从用户的单元一路查到结果）。
    const userUnit = /unit=(unit_\S+)/u.exec(handoffLine)![1]!;
    expect(logs.some((line) => line.startsWith("[sched] result ") && line.includes(`of=${userUnit}`) && line.includes(`ticket=${ticketId}`))).toBe(true);
    if (process.env.HANDOFF_TEST_DEBUG) setTimeout(() => console.log(JSON.stringify(db.prepare("SELECT origin_kind, state, substr(assistant_text,1,60) AS t FROM channel_turns").all())), 2_000);
    await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM channel_turns WHERE assistant_text LIKE ?").get(`%${RESULT}%`)).toBeTruthy(), { timeout: 5_000 });

    // events 表里有交接的记录（D12）。
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'scheduler.handed_off'").get()).toEqual({ n: 1 });
  }, 40_000);

  // S7：Lead 无视预算继续做。到了就地预算，调度器停下这一轮；Lead 在交接窗口里 hand_off；已经提交的写操作不再做。
  it("forces a hand-off at the budget; the package marks the pushed branch as committed and the system confirms", async () => {
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "400");
    const { say, lead, logs, turn, runtime } = await boot((call) => {
      if (has(call, RED)) return { tools: [{ name: "hand_off", args: {} }] };
      if (has(call, "把 acme/b 的分支推上去，再整理一下 changelog")) return { tools: [{ name: "bash", args: { command: "git push origin feature" } }] };
      if (call.index === 1) return { say: [never] };
      return { say: "" };
    }, [lightChildDelivers("changelog 整理好了。")]);

    const sent = await say("f1", "把 acme/b 的分支推上去，再整理一下 changelog");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] handoff "))).toBe(true), { timeout: 10_000 });
    const ticketId = handoffTicket();
    const recorded = itemHandoff(db, ticketId)!;
    expect(recorded).toMatchObject({ entry: "forced", lane: 0, committed: 1 });
    expect(lead.aborts()).toBe(1);
    // 交接窗口里没有再跑 bash：已经提交的写操作没有重做。
    const afterStop = lead.calls.slice(lead.calls.findIndex((call) => has(call, RED)));
    expect(afterStop.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(runtime.briefs.length).toBe(1), { timeout: 10_000 });
    expect(runtime.briefs[0]).toMatch(/## 已经提交的写操作：不要再做\n- 第 1 步 bash/u);
    // Lead 交出去以后一句话都没说：系统用模板写确认。
    // 界面文字缺省是英文（docs/i18n.md）。
    await vi.waitFor(() => expect(turn(sent.turnId).assistant_text).toContain(`This went to a background agent (#${ticketId})`), { timeout: 5_000 });
    expect(logs.some((line) => line.startsWith("[sched] decide ") && line.includes("decision=handed_off") && line.includes("redLine=handoff"))).toBe(true);
    expect(logs.some((line) => line.startsWith("[sched] confirm ") && line.includes("by=template"))).toBe(true);
    expect(logs.some((line) => line.startsWith("[sched] suspend "))).toBe(false);
  }, 40_000);

  // S7 的另一半：Lead 在交接窗口里不交。单元挂起，交接包存下来；Lead 空下来以后系统为它叫醒 Lead 一次，当前局面里列着它，
  // Lead 决定接着做（resume_unit），就地预算重新算。系统不替 Lead 派出子 agent。
  it("suspends the unit when Lead does not hand off in the window, and lets Lead resume it next turn", async () => {
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "400");
    vi.stubEnv("PLC_LEAD_HANDOFF_MS", "300");
    let suspendedId: string | null = null;
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, RED)) return { say: [never] };
      if (call.situation?.includes("挂起的单元") && (has(call, "有被打断的工作挂起了") || has(call, "acme/d 的 CI 红了"))) {
        suspendedId = /(hof_[a-z0-9]+)/u.exec(call.situation!)?.[1] ?? null;
        return { tools: [{ name: "resume_unit", args: { id: suspendedId, action: "resume" } }] };
      }
      if (has(call, "接着做挂起的单元")) return { say: "接着做完了：changelog 整理好了。" };
      if (has(call, "整理一下 acme/c 的 changelog")) return { tools: [{ name: "read", args: { path: "/Users/alice/acme/c/CHANGELOG.md" } }] };
      if (call.index === 1) return { say: [never] };
      return { say: "好的。" };
    });

    const sent = await say("s1", "整理一下 acme/c 的 changelog");
    // 用户的这一轮在跑时来了一件系统的事（L2）：它排着，这一轮结束后先开一轮。Lead 在那一轮的当前局面里看到挂起的单元，接着做。
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    addInbox(db, { itemId: createItem(db, { title: "acme/d 的 CI 红了", brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary: "acme/d 的 CI 红了", lossless: true });
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] suspend ") && line.includes("reason=handoff_timeout"))).toBe(true), { timeout: 10_000 });
    // 用户在等的这一轮：系统写一句挂起了。
    await vi.waitFor(() => expect(turn(sent.turnId).assistant_text).toContain("worked on this for the full in-place budget and paused it"), { timeout: 5_000 });
    expect(handoffTicket()).toBe(0);

    await vi.waitFor(() => expect(suspendedId).not.toBeNull(), { timeout: 10_000 });
    const pkg = storedPackage(suspendedId!);
    expect(pkg).toMatchObject({ entry: "suspended", goal: { text: "整理一下 acme/c 的 changelog", lane: 0 } });
    expect(pkg.steps.map((step: any) => step.tool)).toEqual(["read"]);
    await vi.waitFor(() => expect(storedState(suspendedId!).state).toBe("resumed"), { timeout: 5_000 });
    expect(logs.some((line) => line.startsWith("[sched] lane ") || line.includes("lane=L0"))).toBe(true);
    expect(logs.some((line) => line.includes("decision=budget_restart") && line.includes("why=resume"))).toBe(true);
    // 恢复的是用户的事（L0）：叫醒它的单元是系统回合（L2），恢复以后车道跟着这件事提到 L0。
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] lane ") && line.includes("from=L2") && line.includes("to=L0") && line.includes("why=resume"))).toBe(true), { timeout: 5_000 });
    // 系统没有派出子 agent。
    expect(existsSync(join(dir, "light-tasks"))).toBe(false);
    expect(lead.calls.some((call) => has(call, "接着做挂起的单元"))).toBe(true);
  }, 40_000);
});

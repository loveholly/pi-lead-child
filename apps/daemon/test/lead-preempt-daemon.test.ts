// 抢占和长工具的完整流程（lead-scheduler spec P3：D4、D5、D6、D10、H10）。daemon、网关、store 都是真的；Lead 的会话是按 pi
// 规则写的替身（fake-pi-session.ts），它像真的调度器 extension 一样叫 daemon 的钩子，resume_unit 用真的工具实现。
// 人名、仓库和原文都是编造的。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadToolset } from "@pi-lead-child/lead";
import { addInbox, createItem, createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-preempt-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
  vi.stubEnv("PLC_LEAD_RED_LINE_MS", "600000");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_STEP_P90_MS", "0");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const never = new Promise<void>(() => {});
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));

async function realTool(name: string, args: Record<string, unknown>, deps: any) {
  const tool = createLeadToolset(deps).find((candidate) => candidate.name === name)!;
  return await tool.execute(`call-${name}`, args as never, undefined, undefined, undefined as never) as {
    content: Array<{ type: "text"; text: string }>;
  };
}

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>) {
  const logs: string[] = [];
  const lead = fakePiLead(script, {
    hooks: true,
    tools: { resume_unit: (args, deps) => realTool("resume_unit", args, deps) },
  });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const say = async (id: string, message: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message }),
    });
    const body = await response.json() as { turnId: string; mode: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return { ...body, sentAt: Date.now() };
  };
  const turn = (id: string) => db.prepare("SELECT state, assistant_text, updated_at FROM channel_turns WHERE id = ?").get(id) as
    { state: string; assistant_text: string; updated_at: string };
  return { say, lead, logs, turn };
}

// 叫醒 Lead 的一件系统的事（L2）。
function blocker(title: string): void {
  addInbox(db, { itemId: createItem(db, { title, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary: title, lossless: true });
}

const pkgOf = (logs: string[], reason: string) => /pkg=(hof_[a-z0-9]+)/u.exec(logs.find((line) => line.startsWith("[sched] suspend ") && line.includes(`reason=${reason}`)) ?? "")?.[1] ?? null;

describe("the user's own message preempts a unit that is not the user's (P3)", () => {
  // S2：Lead 在做系统的事、正在等模型时，用户发消息：中止这一步，马上回应用户，被打断的单元挂起；之后 Lead 自己决定接着做。
  it("stops the waiting step, answers the user in a unit of its own, and lets Lead resume the suspended unit", async () => {
    let suspendedId: string | null = null;
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, "有被打断的工作挂起了") && call.situation?.includes("挂起的单元")) {
        suspendedId = /(hof_[a-z0-9]+)/u.exec(call.situation)?.[1] ?? null;
        return { tools: [{ name: "resume_unit", args: { id: suspendedId, action: "resume" } }] };
      }
      if (has(call, "接着做挂起的单元")) return { say: "CI 的事接着处理完了。" };
      // 用户的话先认：当前局面里挂起单元的摘要也带着系统那件事的第一句。
      if (has(call, "今天下午三点有会吗")) return { say: "有，三点和 Nina 的评审会。" };
      if (has(call, "acme/a 的 CI 又红了")) return { say: [never] };
      return { say: "好的。" };
    });

    blocker("acme/a 的 CI 又红了");
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "acme/a 的 CI 又红了"))).toBe(true), { timeout: 5_000 });
    const sent = await say("p1", "今天下午三点有会吗");
    expect(sent.mode).toBe("queued");
    await vi.waitFor(() => expect(turn(sent.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(sent.turnId).assistant_text).toContain("三点和 Nina 的评审会");
    // 首次可见回应的目标是 10 秒（L0）；替身里只差调度的开销。
    expect(Date.parse(turn(sent.turnId).updated_at) - sent.sentAt).toBeLessThan(10_000);

    expect(lead.aborts()).toBe(1);
    const decision = logs.find((line) => line.startsWith("[sched] decide ") && line.includes("decision=preempt "))!;
    expect(decision).toContain("lane=L2");
    expect(decision).toContain(`by=${sent.turnId}`);
    expect(decision).toContain("at=model");
    expect(logs.some((line) => line.startsWith("[sched] input ") && line.includes(`turn=${sent.turnId}`) && line.includes("placement=preempt"))).toBe(true);
    expect(logs.some((line) => line.startsWith("[sched] unit.end ") && line.includes("lane=L2") && line.includes("outcome=suspended"))).toBe(true);
    const pkg = pkgOf(logs, "preempt");
    expect(pkg).not.toBeNull();
    const stored = JSON.parse(readFileSync(join(dir, "lead-handoffs", pkg!, "package.json"), "utf8"));
    expect(stored.goal.text).toContain("acme/a 的 CI 又红了");

    // 用户的事处理完，系统为挂起的单元叫醒 Lead 一次，Lead 接着做（resume_unit）。
    await vi.waitFor(() => expect(suspendedId).toBe(pkg), { timeout: 10_000 });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dir, "lead-handoffs", pkg!, "state.json"), "utf8")).state).toBe("resumed"), { timeout: 5_000 });
    expect(lead.calls.some((call) => has(call, "接着做挂起的单元"))).toBe(true);
    // 系统没有派出子 agent。
    expect(existsSync(join(dir, "light-tasks"))).toBe(false);
  }, 30_000);

  // S3：Lead 正在跑一个写操作时，用户发消息：写操作不被打断，到下一个让出点才中止、挂起。写操作只做了一次。
  it("lets a running write finish, then preempts at the next yield point", async () => {
    const pushed = deferred();
    let bashCalls = 0;
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, "现在几点")) return { say: "十点一刻。" };
      if (has(call, "有被打断的工作挂起了")) return { say: "先放着。" };
      if (has(call, "acme/b 的发布分支要推上去")) {
        bashCalls += 1;
        return { tools: [{ name: "bash", args: { command: "git push origin release" }, until: pushed.promise }] };
      }
      if (call.index === 1) return { say: "推完了。" };
      return { say: "好的。" };
    });

    blocker("acme/b 的发布分支要推上去");
    await vi.waitFor(() => expect(lead.calls.length).toBe(1), { timeout: 5_000 });
    const sent = await say("p2", "现在几点");
    await vi.waitFor(() => expect(logs.some((line) => line.includes("decision=preempt_wait") && line.includes("tool=bash"))).toBe(true), { timeout: 5_000 });
    expect(lead.aborts()).toBe(0);
    expect(turn(sent.turnId).state).not.toBe("completed");

    pushed.resolve();
    await vi.waitFor(() => expect(turn(sent.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(sent.turnId).assistant_text).toContain("十点一刻");
    expect(logs.find((line) => line.includes("decision=preempt "))).toContain("at=yield_point");
    expect(bashCalls).toBe(1);
    expect(pkgOf(logs, "preempt")).not.toBeNull();
    const stored = JSON.parse(readFileSync(join(dir, "lead-handoffs", pkgOf(logs, "preempt")!, "package.json"), "utf8"));
    // 推送做完了：交接包里记成已经提交的写操作，接手的人不会再推一次。
    expect(stored.steps.map((step: any) => [step.tool, step.write, step.state])).toEqual([["bash", true, "done"]]);
  }, 30_000);

  // 用户自己的事不被抢占：同一会话的新消息按忙时的放置方式（缺省排队）。
  it("does not preempt the user's own unit", async () => {
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, "整理一下周报")) return { say: ["正在整理……", new Promise((resolve) => setTimeout(resolve, 600)), "整理好了。"] };
      return { say: "好的。" };
    });
    const first = await say("u1", "整理一下周报");
    await vi.waitFor(() => expect(lead.calls.length).toBe(1), { timeout: 5_000 });
    const second = await say("u2", "顺便加上下周的计划");
    expect(second.mode).toBe("queued");
    await vi.waitFor(() => expect(turn(second.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(lead.aborts()).toBe(0);
    expect(turn(first.turnId).state).toBe("completed");
    expect(logs.some((line) => line.includes("decision=preempt"))).toBe(false);
  }, 30_000);
});

describe("a read-only command that moved to the background (D6)", () => {
  // 作业结束：输出作为一件事交给 Lead，车道是作业开始时那个单元的车道（用户的事是 L0）。
  it("wakes Lead with the job's output in the lane of the unit that started it", async () => {
    let started = false;
    const job = { id: "job_test0001", tool: "bash", command: "npm test", toolCallId: "call-1", softMs: 20_000 };
    const { say, lead, logs } = await boot((call) => {
      if (has(call, "你转到后台的作业")) return { say: "测试跑完了：412 个通过。" };
      if (has(call, "跑一遍 acme/c 的测试")) {
        // 这一步里 bash 过了软时限、转到后台（hands.ts 叫 started）。
        lead.deps().backgroundJobs.started(job);
        started = true;
        return { say: "测试转到后台了，跑完告诉你。" };
      }
      return { say: "好的。" };
    });
    const sent = await say("j1", "跑一遍 acme/c 的测试");
    await vi.waitFor(() => expect(lead.calls.length).toBe(1), { timeout: 5_000 });
    const jobs = lead.deps().backgroundJobs;
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] unit.end ") && line.includes(`turn=${sent.turnId}`))).toBe(true), { timeout: 5_000 });
    jobs.finished({ ...job, text: "412 passed", isError: false, ms: 64_000 });
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "你转到后台的作业 job_test0001"))).toBe(true), { timeout: 5_000 });
    const woke = lead.calls.find((call) => has(call, "你转到后台的作业 job_test0001"))!;
    expect(woke.inputs.join("\n")).toContain("412 passed");
    expect(started).toBe(true);
    expect(logs.find((line) => line.startsWith("[sched] job.bg_start "))).toContain("lane=L0");
    expect(logs.find((line) => line.startsWith("[sched] job.bg_end "))).toContain("ms=64000");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] lane ") && line.includes("to=L0"))).toBe(true), { timeout: 5_000 });
    // 结果写明它来自哪个单元的作业（plc sched trace 据此查到这里）。
    const origin = /unit=(unit_\S+)/u.exec(logs.find((line) => line.startsWith("[sched] job.bg_start "))!)![1]!;
    expect(logs.some((line) => line.startsWith("[sched] result ") && line.includes(`of=${origin}`) && line.includes("job=job_test0001"))).toBe(true);
  }, 30_000);
});

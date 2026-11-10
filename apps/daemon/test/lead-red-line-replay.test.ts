// 2026-11-03 一次 9 分钟排队的回放（人、仓库和原文都换成编造的）。用户在 Lead 读 GitHub 的那一轮里接连发了几条消息，
// 其中两条是对手上那件事的纠正。当时：这一轮读过连接的结果，用户的话一律等这一轮结束（D16），Lead 照旧计划派了执行者；
// 下一轮就地查了 6 分多钟，三条消息排了 6–9 分钟。
// 现在（用户 2026-11-03）：
//   · 用户本人开的一轮只读了连接、对话的结果时，用户的话照常插进去或排队（user-placement.ts）；
//   · 黄灯 2 分钟提醒；红灯 2 分半，有人在等时停下这一轮（正在跑的写操作先做完），在同一轮里马上叫 Lead 交接
//     （lead 的 red-line.ts）。没有人在等时只再提醒一次。
// daemon、网关、store 都是真的；Lead 的会话是按 pi 规则写的替身（fake-pi-session.ts），时间按比例缩短。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addInbox, createItem, createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, type FakeCall, type FakePiLeadOptions, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-red-line-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_WRITE_GRACE_MS", "5000");
  vi.stubEnv("PLC_LEAD_HANDOFF_MS", "5000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 黄灯和红灯（毫秒）。
function lights(yellow: number, red: number): void {
  vi.stubEnv("PLC_LEAD_OVERFLOW_MS", String(yellow));
  vi.stubEnv("PLC_LEAD_RED_LINE_MS", String(red));
}

const never = new Promise<void>(() => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const RED = 'kind="red_line"';

async function boot(script: (call: FakeCall, deps: () => any) => FakeReply | Promise<FakeReply>, options: FakePiLeadOptions = {}) {
  const logs: string[] = [];
  let lead!: ReturnType<typeof fakePiLead>;
  lead = fakePiLead((call) => script(call, () => lead.deps()), options);
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  // mode：不带时 daemon 按「Lead 忙时你发的消息」的设置放，缺省排队。那天的 App 不带 mode 就是插话，所以重放时写明插话。
  const say = async (id: string, message: string, mode?: "steer" | "followUp"): Promise<{ turnId: string; mode: string }> => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message, ...(mode ? { mode } : {}) }),
    });
    const body = await response.json() as { turnId: string; mode: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  const turn = (id: string) => db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(id) as
    { state: string; error: string | null };
  return { say, lead, logs, turn };
}

const github = { name: "call_connection_tool", args: { connection: "github", tool: "search_pull_requests" } };

describe("the 2026-11-03 queue, replayed", () => {
  // 回归：用户本人的一轮读了 GitHub，纠正等到这一轮结束才送到，Lead 已经照旧计划派了执行者。
  it("lets the user's correction into the user's own turn that read GitHub, before Lead dispatches", async () => {
    lights(600_000, 600_000);
    const correctionSent = deferred();
    let sawCorrectionBeforeDispatch: boolean | null = null;
    const { say, lead } = await boot((call) => {
      if (has(call, "各提一个 PR")) return { tools: [github] };
      if (call.index === 1) return { say: [correctionSent.promise], tools: ["codemode"] };
      if (call.index === 2) {
        sawCorrectionBeforeDispatch = has(call, "已经有 DevOps 提的 PR");
        return { tools: ["create_task", "spawn_child"] };
      }
      return { say: "好的。" };
    });

    await say("a1", "给 acme/a、acme/b、acme/c、acme/d 各提一个 PR，把 lodash 升到 4.17.21");
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    const sent = await say("a2", "acme/b、acme/c、acme/d 已经有 DevOps 提的 PR 了", "steer");
    expect(sent.mode).toBe("steered");
    correctionSent.resolve();

    await vi.waitFor(() => expect(sawCorrectionBeforeDispatch).not.toBeNull(), { timeout: 5_000 });
    expect(sawCorrectionBeforeDispatch).toBe(true);
  }, 20_000);

  // 回归：第二轮就地查了 6 分多钟，排着的消息一直等到它做完。
  it("stops the turn at the red line when the user is waiting, and asks Lead to hand off before anything else", async () => {
    lights(150, 300);
    const gates: Array<ReadonlySet<string> | null> = [];
    const { say, lead, turn } = await boot((call, deps) => {
      if (has(call, RED)) {
        gates.push(deps().toolGate?.() ?? null);
        return { tools: ["create_task", "spawn_child"] };
      }
      if (has(call, "核对一下 acme/a")) return { tools: [github] };
      if (call.index === 1) return { say: [never] };
      if (has(call, "顺便看一下 acme/b")) {
        gates.push(deps().toolGate?.() ?? null);
        return { say: "acme/b 也看了。" };
      }
      return { say: "派给轻子 agent 了，大约 5 分钟有结果。" };
    });

    const first = await say("b1", "核对一下 acme/a 的修复对不对");
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    const queued = await say("b2", "顺便看一下 acme/b", "followUp");
    expect(queued.mode).toBe("queued");

    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(turn(queued.turnId).state).toBe("completed"), { timeout: 5_000 });
    // 停下不是失败：这一轮没有「回复被中断」。
    expect(turn(first.turnId)).toEqual({ state: "completed", error: null });

    // 红线消息在同一轮里先送到，排在排队的消息前面，带着在等的那一句。
    const red = lead.calls.findIndex((call) => has(call, RED));
    const answered = lead.calls.findIndex((call) => has(call, "顺便看一下 acme/b") && !has(call, RED));
    expect(red).toBeGreaterThan(1);
    expect(answered).toBeGreaterThan(red);
    expect(lead.calls[red]!.inputs[0]).toContain(RED);
    expect(lead.calls[red]!.inputs[0]).toContain("顺便看一下 acme/b");

    // 交接时只能用交接的工具；交接完，答排队的消息时限制已经解除。
    expect(gates[0]?.has("create_task")).toBe(true);
    expect(gates[0]?.has("spawn_child")).toBe(true);
    expect(gates[0]?.has("bash")).toBe(false);
    expect(gates[1]).toBeNull();
  }, 20_000);

  // 回归 2026-11-03：中断落在准备请求那一步时，pi-ai 的 lazyStream 记成 stopReason=error、「This operation was aborted」。每次红线都记成
  // 模型调用失败，Lead 被判停摆，积压的事推给了用户；这次 prompt 也以这个错误失败时，这一轮报错，没有交接。
  for (const abortedAs of ["error", "throws"] as const) {
    it(`does not count the red-line stop as a failed model call when the abort ends as ${abortedAs}`, async () => {
      lights(150, 300);
      const { say, lead, turn, logs } = await boot((call) => {
        if (has(call, RED)) return { tools: ["create_task", "spawn_child"] };
        if (has(call, "核对一下 acme/a")) return { tools: [github] };
        if (call.index === 1) return { say: [never] };
        return { say: "派给轻子 agent 了，大约 5 分钟有结果。" };
      }, { abortedAs });

      const first = await say("c1", "核对一下 acme/a 的修复对不对");
      await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
      const queued = await say("c2", "顺便看一下 acme/b", "followUp");

      await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
      await vi.waitFor(() => expect(turn(queued.turnId).state).toBe("completed"), { timeout: 5_000 });
      expect(turn(first.turnId)).toEqual({ state: "completed", error: null });
      expect(lead.calls.some((call) => has(call, RED))).toBe(true);
      expect(logs.filter((line) => line.startsWith("lead model error") || line.startsWith("turn error"))).toEqual([]);
    }, 20_000);
  }

  // 回归 2026-11-09（人和原文换成编造的）：用户发了一个小请求，Lead 在用户自己的这一轮里卡了将近 10 分钟。红线判断
  // 「没有人在等」，只提醒，不停；可是用户就是这一轮在回答的人，也正看着会话。10 分钟后一位同事的两个词闲聊 DM 到了，
  // 红线才停下这一轮。这一轮正在回答的用户也算在等。
  it("counts the user whose message the turn answers as waiting, and stops the turn at the red line", async () => {
    lights(150, 300);
    const { say, lead, turn, logs } = await boot((call) => {
      if (has(call, RED)) return { say: "清理交给轻子 agent 了，好了告诉你。" };
      if (has(call, "删掉 #42 的 worktree")) return { tools: [github] };
      if (call.index === 1) return { say: [never] };
      return { say: "好的。" };
    });

    const first = await say("e1", "删掉 #42 的 worktree，顺便看看有没有自动清理的机制");
    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("completed"), { timeout: 5_000 });

    expect(logs.some((line) => line.includes("nobody is waiting"))).toBe(false);
    expect(logs.some((line) => /lead red line: \d+s with 1 conversation\(s\) waiting/.test(line))).toBe(true);
    const red = lead.calls.find((call) => has(call, RED));
    expect(red?.inputs[0]).toContain("用户");
  }, 20_000);

  // P2（lead-scheduler spec 待定 9，用户 2026-11-09 的决定 10）：到了就地预算，没有人在等也停下，请 Lead 交接。
  // 以前这里只再提醒一次（overflow），不停。
  it("stops for a hand-off even when nobody is waiting", async () => {
    lights(150, 300);
    const { lead } = await boot((call) => {
      if (has(call, RED)) return { say: "交出去了。" };
      if (call.index === 0 && has(call, "整理依赖的提醒")) return { tools: [github] };
      if (call.index === 1) return { say: [sleep(700), "整理完了。"] };
      return { say: "好的。" };
    });

    // 系统事件叫醒的一轮：没有人在等这一轮的回答。
    addInbox(db, {
      itemId: createItem(db, { title: "整理依赖的提醒", brief: "b", createdBy: "system" }),
      severity: "blocker", source: "structural", summary: "整理依赖的提醒", lossless: true,
    });
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, RED))).toBe(true), { timeout: 5_000 });

    expect(lead.aborts()).toBe(1);
    const red = lead.calls.flatMap((call) => call.inputs).find((input) => input.includes(RED))!;
    expect(red).toContain("现在没有人在等你");
    expect(red).toContain("hand_off");
  }, 20_000);

  // 回归（2026-11-10 开发模式）：交接完以后 pi 在同一次运行里接着答排着的追问，追问又做到了预算。以前第二次停下没有交接，
  // 这一轮直接收尾，追问记成「Lead 未生成回复」。现在再交接一段，追问有回答。
  it("hands off again when the queued follow-up runs past the budget in the same unit", async () => {
    lights(600_000, 400);
    let red = 0;
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, RED)) {
        red += 1;
        return { say: red === 1 ? "A 交出去了。" : "B 也交出去了。" };
      }
      if (has(call, "先整理 acme/a 的发布说明")) return { tools: [github] };
      if (has(call, "再整理 acme/b 的发布说明")) return { tools: [github] };
      return { say: [never] };
    });
    await say("r1", "先整理 acme/a 的发布说明");
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    const follow = await say("r2", "再整理 acme/b 的发布说明", "followUp");
    await vi.waitFor(() => expect(turn(follow.turnId).state).toBe("completed"), { timeout: 10_000 });
    expect(red).toBe(2);
    expect(lead.aborts()).toBe(2);
    expect(logs.some((line) => line.includes("decision=handoff_again"))).toBe(true);
  }, 20_000);

  it("lets a running bash command finish before it stops the turn", async () => {
    lights(150, 300);
    const pushed = deferred();
    const { say, lead, logs, turn } = await boot((call) => {
      if (has(call, RED)) return { say: "推送做完了，剩下的派出去了。" };
      if (has(call, "把 acme/a 的分支推上去")) return { tools: [github] };
      if (call.index === 1) return { tools: [{ name: "bash", args: { command: "git push" }, until: pushed.promise }] };
      if (call.index === 2) return { say: [never] };
      return { say: "好的。" };
    });

    await say("d1", "把 acme/a 的分支推上去");
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    const queued = await say("d2", "推完告诉我", "followUp");
    await sleep(700);

    // 过了红线，有人在等，但 bash 还在跑：先不停。
    expect(lead.aborts()).toBe(0);
    expect(logs.some((line) => line.includes("lead red line") && line.includes("bash"))).toBe(true);

    pushed.resolve();
    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(turn(queued.turnId).state).toBe("completed"), { timeout: 5_000 });
  }, 20_000);
});

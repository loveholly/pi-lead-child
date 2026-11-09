// 2026-11-09 的优先级反转，回放（人和原文都换成编造的；lead-scheduler spec「背景」和「用户的决定」第 2 条）。
// 那天：用户的小请求，Lead 在用户自己的这一轮里卡了将近 10 分钟。红线判断「没有人在等」，只提醒；一位同事的两个词的
// 闲聊 DM 到了，只等了 2 秒，红线就停下了用户的这一轮，交接消息里写的是同事在等。
// 现在（P1）：调度器按车道做决定。用户本人的单元是 L0；外部的人的消息是 L1，只排队：
//   · 不让 Lead 先去回同事（排队说明不提同事）；
//   · 红线在就地预算到期时停下这一轮，依据是用户本人；交接消息里只写用户；
//   · 这个单元结束以后，同事的消息照常交给 Lead。
// 系统事件叫醒的单元（L2）里，同事照样算在等：这一处和以前一样。
// daemon、网关、store、通道 hub、Slack 来源插件都是真的；Slack、SmartModel、Lead 的会话是替身，时间按比例缩短。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, createItem, createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-scheduler-replay-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
  vi.stubEnv("PLC_LEAD_RED_LINE_MS", "600");
  vi.stubEnv("PLC_LEAD_WRITE_GRACE_MS", "5000");
  vi.stubEnv("PLC_LEAD_HANDOFF_MS", "5000");
  // 外部的人排队 100 毫秒就算等久了（缺省 5 分钟）：同事的消息在红线之前就过了这个阈值。
  vi.stubEnv("PLC_LEAD_QUEUE_NOTICE_MS", "100");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const never = new Promise<void>(() => {});
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const RED = 'kind="red_line"';
const QUEUE = 'kind="queue"';
const github = { name: "call_connection_tool", args: { connection: "github", tool: "search_pull_requests" } };

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>, slack: FakeSlack) {
  const logs: string[] = [];
  const lead = fakePiLead(script, { smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const say = async (id: string, message: string) => {
    const sent = await http("/v1/chat/send", { id, message });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    return sent.body as { turnId: string; mode: string };
  };
  const dm = async (user: string, text: string) => {
    await daemon!.channels!.receive("slack", slack.dm(user, text));
    await daemon!.channels!.idle();
  };
  const turn = (id: string) => db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(id) as { state: string; error: string | null };
  return { lead, logs, http, say, dm, turn };
}

describe("the 2026-11-09 priority inversion, replayed", () => {
  // 回归：同事的闲聊 DM 不能让用户的这一轮停下或让 Lead 先去回同事。
  it("keeps a colleague's DM queued during the user's unit, and stops the unit at the budget because of the user", async () => {
    const slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
    let unitSnapshot: any = null;
    const { lead, logs, http, say, dm, turn } = await boot((call) => {
      if (has(call, RED)) return { say: "清理交给轻子 agent 了，好了告诉你。" };
      if (has(call, "删掉 #42 的 worktree")) return { tools: [github] };
      if (call.index === 1) return { say: [never] };
      return { say: "收到。" };
    }, slack);

    const first = await say("i1", "删掉 #42 的 worktree，顺便看看有没有自动清理的机制");
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    await dm("U0NINA", "在吗");
    // 调度器的样子：用户的单元在 L0，同事在 L1 排队。
    await vi.waitFor(async () => {
      unitSnapshot = (await http("/v1/lead/scheduler")).body;
      expect(unitSnapshot.lanes[1].waiting.map((entry: any) => entry.who)).toEqual(["Nina"]);
    }, { timeout: 5_000 });
    expect(unitSnapshot.unit).toMatchObject({ lane: "L0", source: "user", turnId: first.turnId, redLine: null });

    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("completed"), { timeout: 5_000 });

    // 两个输入都有记录：用户的消息是 L0、新开一个单元；同事的消息是 L1，是在用户的单元跑的时候到的。
    const unitId = unitSnapshot.unit.id as string;
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^\\[sched\\] input unit=- kind=user lane=L0 how=source turn=${first.turnId} placement=start`, "u")),
      expect.stringMatching(new RegExp(`^\\[sched\\] input unit=${unitId} kind=external lane=L1 how=external_default seq=\\d+ .*running=L0`, "u")),
    ]));
    // 没有劝 Lead 先去回同事。
    expect(lead.calls.some((call) => has(call, QUEUE))).toBe(false);
    expect(logs.some((line) => /\[sched\] decide unit=unit_\w+ lane=L0 .*decision=queue_hold reason=user_unit queued=L1:external:1:/u.test(line))).toBe(true);
    // 红线的依据是用户本人，同事只排队；交接消息里只写用户。
    const decision = logs.find((line) => line.includes("decision=red_line_stop"))!;
    expect(decision).toMatch(new RegExp(`lane=L0 turn=${first.turnId} decision=red_line_stop .*waiting=L0:user:1:\\d+s queued=L1:external:1:\\d+s`, "u"));
    const red = lead.calls.find((call) => has(call, RED))!;
    expect(red.inputs[0]).toContain("用户");
    expect(red.inputs[0]).not.toContain("Nina");
    // 中止经过控制层：原因先记下，日志写明中止花了多久。
    expect(logs.some((line) => /^\[sched\] abort unit=unit_\w+ lane=L0 .*reason=budget/u.test(line))).toBe(true);
    await vi.waitFor(() => expect(logs.some((line) => /^\[sched\] abort\.done unit=unit_\w+ seg=1 reason=budget settled=true/u.test(line))).toBe(true));

    // 这个单元结束以后，同事的消息照常交给 Lead。
    await vi.waitFor(() => expect(lead.calls.some((call) => call.inputs.join("\n").includes("在吗"))).toBe(true), { timeout: 10_000 });
    const recorded = db.prepare("SELECT kind, json_extract(payload, '$.decision') AS decision FROM events WHERE kind LIKE 'scheduler.%' ORDER BY seq")
      .all() as Array<{ kind: string; decision: string | null }>;
    expect(recorded).toEqual(expect.arrayContaining([
      { kind: "scheduler.decided", decision: "red_line_stop" },
      { kind: "scheduler.aborted", decision: null },
      { kind: "scheduler.unit_ended", decision: null },
    ]));
  }, 30_000);

  // 不变的部分：系统事件叫醒的单元里，同事照样算在等。
  it("still tells Lead about the colleague, and stops for the colleague, in a unit a system event woke", async () => {
    const slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
    const { lead, logs, dm } = await boot((call) => {
      if (has(call, RED)) return { say: "交出去了。" };
      if (call.index === 0 && has(call, "整理依赖的提醒")) return { tools: [github] };
      if (call.index === 1) return { say: [never] };
      return { say: "收到。" };
    }, slack);

    addInbox(db, {
      itemId: createItem(db, { title: "整理依赖的提醒", brief: "b", createdBy: "system" }),
      severity: "blocker", source: "structural", summary: "整理依赖的提醒", lossless: true,
    });
    await vi.waitFor(() => expect(lead.calls.length).toBe(2), { timeout: 5_000 });
    await dm("U0NINA", "在吗");

    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, QUEUE) && call.inputs.join("\n").includes("Nina"))).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    const decision = logs.find((line) => line.includes("decision=red_line_stop"))!;
    expect(decision).toMatch(/lane=L2 .*decision=red_line_stop .*waiting=L1:external:1:\d+s/u);
    expect(lead.calls.find((call) => has(call, RED))!.inputs[0]).toContain("Nina");
  }, 30_000);
});

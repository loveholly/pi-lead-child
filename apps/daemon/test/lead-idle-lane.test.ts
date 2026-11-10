// 空闲车道（lead-scheduler spec D1、D8，P4）：整理笔记是 Lead 的一个 L4 单元，新输入到达时它让路。持久化的完整流程：
// daemon、网关、store、调度器、空闲车道都是真的；Lead 的会话是替身（fake-pi-session.ts），时间按比例缩短。
//
// 以前：整理笔记那一轮里用户发来的消息排进 pi 的队列（followUp），等整理做完才答。那一轮在等模型时，用户就一直等。
// 现在：用户的消息不插进那一轮；那一轮在让出点停下（idle_yield），用户的话马上单独开一轮；整理这个周期重新武装，
// 下一次空闲接着做（断点续做）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, createItem, createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-idle-lane-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // Lead 空闲 50 毫秒就开始 L4 的活（缺省 15 秒）。上下文 75%：过了整理笔记的线（70%），没到空闲压缩的线。
  vi.stubEnv("PLC_LEAD_IDLE_GRACE_MS", "50");
  vi.stubEnv("PLC_LEAD_IDLE_COMPACT_RATIO", "0.95");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const never = new Promise<void>(() => {});
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const NOTES = "沉淀检查";

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>, options: { noAbort?: boolean } = {}) {
  const logs: string[] = [];
  const lead = fakePiLead(script, {
    smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }),
    contextUsage: { window: 1_000, tokens: 750 },
  });
  // noAbort：会话不能中断（老的会话端口没有 abort）。
  const factory = options.noAbort
    ? async (args: unknown) => {
      const made = await lead.factory(args);
      const { abort: _abort, ...session } = made.session;
      return { ...made, session };
    }
    : lead.factory;
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: factory as never,
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
  const turn = (id: string) => db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(id) as { state: string; error: string | null };
  const idleRecords = () => db.prepare(
    "SELECT json_extract(payload, '$.job') AS job, json_extract(payload, '$.event') AS event FROM events WHERE kind = 'scheduler.idle_job' ORDER BY seq",
  ).all() as Array<{ job: string; event: string }>;
  return { lead, logs, http, say, turn, idleRecords };
}

describe("the idle lane: Lead's notes turn yields to new input", () => {
  it("stops the notes turn when the user speaks, answers the user at once, and resumes the notes later", async () => {
    // 整理笔记的模型一直在想，直到测试放行（notesMayFinish）。
    let notesMayFinish = false;
    const notesCalls = () => lead.calls.filter((call) => has(call, NOTES)).length;
    const { lead, logs, http, say, turn, idleRecords } = await boot((call) => {
      if (has(call, NOTES)) return notesMayFinish ? { say: "NO_REPLY" } : { say: [never] };
      if (has(call, "现在几点")) return { say: "十点。" };
      return { say: "你好！" };
    });

    const first = await say("t1", "你好");
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("completed"), { timeout: 5_000 });
    // Lead 空闲满 50 毫秒：整理笔记的 L4 单元开始，模型在想。
    await vi.waitFor(async () => {
      expect(notesCalls()).toBeGreaterThan(0);
      expect((await http("/v1/lead/scheduler")).body.unit).toMatchObject({ lane: "L4", source: "system", origin: "system:precipitate" });
    }, { timeout: 5_000 });
    const runningSnapshot = (await http("/v1/lead/scheduler")).body;
    const abortsBefore = lead.aborts();

    const askedAt = Date.now();
    const second = await say("t2", "现在几点");
    // 不插进整理笔记那一轮：它停下，用户的话单独开一轮。
    await vi.waitFor(() => expect(turn(second.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(Date.now() - askedAt).toBeLessThan(3_000);
    expect(second.mode).toBe("queued");
    expect(lead.aborts()).toBe(abortsBefore + 1);
    const answer = lead.calls.find((call) => has(call, "现在几点"))!;
    expect(answer.inputs.some((input) => input.includes(NOTES))).toBe(false);

    // GET /v1/lead/scheduler 里看得到空闲车道在做什么。
    expect(runningSnapshot.idle.precipitate).toMatchObject({ phase: "running", done: false });

    // 下一次空闲：接着整理（断点续做），这次做完。
    notesMayFinish = true;
    await vi.waitFor(() => expect(logs.some((line) => /\[sched\] idle\.done job=precipitate .*outcome=done/u.test(line))).toBe(true), { timeout: 5_000 });

    // 只看日志就能说清：谁让谁让路、怎么让、结局是什么。
    expect(logs.some((line) => /^\[sched\] idle\.yield job=precipitate id=idle_precipitate_\w+ unit=unit_\w+ by=L0 what=user turn=\S+ action=abort_at_yield_point runMs=\d+$/u.test(line))).toBe(true);
    expect(logs.some((line) => /^\[sched\] decide unit=unit_\w+ lane=L4 turn=\S+ decision=idle_yield by=L0 steps=\d+$/u.test(line))).toBe(true);
    expect(logs.some((line) => /^\[sched\] abort unit=unit_\w+ lane=L4 .*reason=idle_yield:L0/u.test(line))).toBe(true);
    expect(logs.some((line) => /^\[sched\] unit\.end unit=unit_\w+ lane=L4 .*outcome=yielded .*aborts=idle_yield:L0/u.test(line))).toBe(true);
    expect(logs.some((line) => /^\[sched\] idle\.start job=precipitate id=idle_precipitate_\w+ ratio=0\.75 line=0\.7 idleMs=\d+ yields=[1-9]$/u.test(line))).toBe(true);
    // 让路不是失败：不记模型错误，用户的那一轮也没有失败卡片。
    expect(logs.some((line) => line.includes("lead model error"))).toBe(false);
    expect(turn(second.turnId).error).toBeNull();
    // events 表里的记录（scheduler.idle_job、scheduler.unit_ended）：开始、要它让路、让了、再开始、做完。
    const events = idleRecords().filter((record) => record.job === "precipitate").map((record) => record.event);
    const order = ["started", "yield_requested", "yielded", "started", "done"];
    let at = 0;
    for (const event of events) if (event === order[at]) at += 1;
    expect(at, events.join(",")).toBe(order.length);
    expect(events.at(-1)).toBe("done");
    const ended = db.prepare(
      "SELECT json_extract(payload, '$.outcome') AS outcome, json_extract(payload, '$.lane') AS lane FROM events WHERE kind = 'scheduler.unit_ended' ORDER BY seq",
    ).all() as Array<{ outcome: string; lane: string }>;
    expect(ended).toEqual(expect.arrayContaining([{ outcome: "yielded", lane: "L4" }, { outcome: "answered", lane: "L4" }]));
  }, 30_000);

  // 会话不能中断时，空闲车道让不了路：不记 idle_yield 的决定，那一轮也不算让过路（结局照实是 answered），
  // 用户的话等它做完再单独开一轮（和以前一样）。以前（P4 的第一版）照样记「让路」并把那一轮记成 yielded，
  // 整理笔记其实一直在跑。
  it("does not claim a yield the session cannot do, and answers the user after the notes turn", async () => {
    let finishNotes!: () => void;
    const notesDone = new Promise<void>((resolve) => { finishNotes = resolve; });
    let notesCalls = 0;
    const { logs, say, turn } = await boot((call) => {
      if (has(call, NOTES)) {
        notesCalls += 1;
        return notesCalls === 1 ? { say: [notesDone, "NO_REPLY"] } : { say: "NO_REPLY" };
      }
      return { say: "十点。" };
    }, { noAbort: true });
    await vi.waitFor(() => expect(notesCalls).toBe(1), { timeout: 5_000 });
    const asked = await say("t1", "现在几点");
    expect(asked.mode).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turn(asked.turnId).state).toBe("queued");
    expect(logs.some((line) => /^\[sched\] idle\.yield_skipped unit=unit_\w+ reason=cannot_abort$/u.test(line))).toBe(true);
    expect(logs.some((line) => line.includes("decision=idle_yield"))).toBe(false);
    finishNotes();
    await vi.waitFor(() => expect(turn(asked.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(logs.some((line) => /\[sched\] unit\.end unit=unit_\w+ lane=L4 .*outcome=answered/u.test(line))).toBe(true);
    expect(logs.some((line) => /\[sched\] unit\.end .*outcome=yielded/u.test(line))).toBe(false);
  }, 30_000);

  it("also yields to an event Lead must handle, which then gets a turn of its own", async () => {
    let notesCalls = 0;
    const { lead, logs } = await boot((call) => {
      if (has(call, NOTES)) {
        notesCalls += 1;
        return notesCalls === 1 ? { say: [never] } : { say: "NO_REPLY" };
      }
      return { say: "处理了。" };
    });
    // Lead 空闲：直接开始整理笔记。
    await vi.waitFor(() => expect(notesCalls).toBe(1), { timeout: 5_000 });
    addInbox(db, {
      itemId: createItem(db, { title: "依赖升级卡住了", brief: "b", createdBy: "system" }),
      severity: "blocker", source: "structural", summary: "依赖升级卡住了", lossless: true,
    });
    await vi.waitFor(() => expect(lead.aborts()).toBe(1), { timeout: 5_000 });
    // 事件没有插进整理笔记那一轮，而是单独一轮。
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "依赖升级卡住了") && !has(call, NOTES))).toBe(true), { timeout: 5_000 });
    expect(lead.calls.filter((call) => has(call, NOTES)).every((call) => !has(call, "依赖升级卡住了"))).toBe(true);
    expect(logs.some((line) => /\[sched\] idle\.yield job=precipitate .*by=L2 what=event/u.test(line))).toBe(true);
    await vi.waitFor(() => expect(notesCalls).toBe(2), { timeout: 5_000 });
  }, 30_000);
});

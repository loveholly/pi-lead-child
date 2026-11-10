// 派发按车道（lead-scheduler spec D1、D2；P1 报告「发现的问题」第 3 条，2026-11-09）。
// 那次：用户的单元结束以后，daemon 先为用户设的跟进开了一轮（L2），又为一个 blocker 开了一轮（L2），同事的私信（L1）
// 到第三个单元才交给 Lead，等了 92–98 秒。原因是派发顺序「排队的用户消息 → 重试 → 用户的跟进单独一轮 → 其余事件」
// 不看车道。
// 现在：用户的单元结束以后，外部的人的消息（L1）先单独开一个 L1 单元，然后才是提醒、跟进和别的系统事件（L2、L3）。
// L1 的时限从用户的单元结束时算（L1 不能抢占 L0，用户的单元在跑的时间不算）。
// daemon、网关、store、通道 hub、Slack 来源插件都是真的；Slack、SmartModel、Lead 的会话是替身。人和原文都是编造的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, addLeadFollowUp, createItem, createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-lane-order-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
  vi.stubEnv("PLC_LEAD_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const text = (call: FakeCall) => call.inputs.join("\n");
const firstCallWith = (calls: FakeCall[], needle: string) => calls.findIndex((call) => text(call).includes(needle));

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
  const dm = async (user: string, body: string) => {
    await daemon!.channels!.receive("slack", slack.dm(user, body));
    await daemon!.channels!.idle();
  };
  return { lead, logs, http, say, dm, owner };
}

describe("dispatch after the user's unit follows the lanes", () => {
  // 回归 P1 报告第 3 条：同事的私信排在用户设的跟进和 blocker 后面。
  it("gives a colleague's DM (L1) the first unit after the user's unit, ahead of the user's follow-up and a blocker (L2)", async () => {
    const slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
    const release = deferred();
    const { lead, logs, http, say, dm, owner } = await boot((call) => {
      if (text(call).includes("整理 #42 的发布说明")) return { say: [release.promise, "整理好了。"] };
      return { say: "收到。" };
    }, slack);

    const first = await say("i1", "整理 #42 的发布说明");
    await vi.waitFor(() => expect(firstCallWith(lead.calls, "整理 #42 的发布说明")).toBeGreaterThanOrEqual(0), { timeout: 5_000 });

    // 用户的单元在跑：用户设的跟进到点、一个 blocker、同事 Nina 的私信，先后到达。
    addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "看一下 #42 的 CI",
      setBy: { turnId: first.turnId, bindingId: owner.binding.id, startedAt: new Date().toISOString() },
    });
    addInbox(db, {
      itemId: createItem(db, { title: "迁移脚本", brief: "b", createdBy: "system" }),
      severity: "blocker", source: "structural", summary: "迁移脚本卡住了", lossless: true,
    });
    await vi.waitFor(() => expect(listEvents(db, { kind: "timer.fired" })).toHaveLength(1), { timeout: 5_000 });
    await dm("U0NINA", "在吗，发布的时间定了没有");
    await vi.waitFor(async () => {
      const snapshot = (await http("/v1/lead/scheduler")).body;
      expect(snapshot.lanes[1].waiting.map((entry: any) => entry.who)).toEqual(["Nina"]);
      // 用户的单元在跑：L1 的时限还没开始算。
      expect(snapshot.lanes[1].waiting[0]).toMatchObject({ countedMs: 0, overdue: false });
    }, { timeout: 5_000 });
    // 用户的单元还没结束，这三件事都还没交给 Lead。
    expect(firstCallWith(lead.calls, "在吗")).toBe(-1);

    const endedAt = Date.now();
    release.resolve();
    await vi.waitFor(() => {
      expect(firstCallWith(lead.calls, "在吗")).toBeGreaterThanOrEqual(0);
      expect(firstCallWith(lead.calls, "看一下 #42 的 CI")).toBeGreaterThanOrEqual(0);
      expect(firstCallWith(lead.calls, "迁移脚本卡住了")).toBeGreaterThanOrEqual(0);
    }, { timeout: 10_000 });

    // 用户的单元之后，第一个单元是 Nina 的（L1），里面只有她的消息；跟进和 blocker 在它后面。
    const nina = firstCallWith(lead.calls, "在吗");
    expect(nina).toBeLessThan(firstCallWith(lead.calls, "看一下 #42 的 CI"));
    expect(nina).toBeLessThan(firstCallWith(lead.calls, "迁移脚本卡住了"));
    expect(text(lead.calls[nina]!)).not.toContain("看一下 #42 的 CI");
    expect(text(lead.calls[nina]!)).not.toContain("迁移脚本卡住了");

    // 日志说清这个决定：按车道派了 L1，等了多久、按时限算了多久、后面还排着几件 L2、L3 的事。
    const dispatch = logs.find((line) => line.startsWith("[sched] dispatch lane=L1"));
    expect(dispatch, logs.filter((line) => line.startsWith("[sched]")).join("\n")).toBeDefined();
    expect(dispatch).toMatch(/^\[sched\] dispatch lane=L1 events=1 waitedMs=\d+ countedMs=\d+ deadlineMs=120000 overdue=false behind=2$/u);
    const counted = Number(/countedMs=(\d+)/u.exec(dispatch!)![1]);
    expect(counted).toBeLessThanOrEqual(Date.now() - endedAt);
    // 这个单元一开始就是 L1。
    const starts = logs.filter((line) => line.startsWith("[sched] unit.start"));
    const userStart = starts.findIndex((line) => line.includes(`turn=${first.turnId}`));
    expect(starts[userStart + 1]).toMatch(/lane=L1 /u);
  }, 30_000);

  // 不变的部分：没有外部的人在等时，顺序和以前一样（用户设的跟进单独一轮，在别的事件前面）。
  it("keeps the old order when nobody outside is waiting", async () => {
    const slack = new FakeSlack({ users: {} });
    const release = deferred();
    const { lead, logs, say, owner } = await boot((call) => {
      if (text(call).includes("整理 #42 的发布说明")) return { say: [release.promise, "整理好了。"] };
      return { say: "收到。" };
    }, slack);
    const first = await say("i1", "整理 #42 的发布说明");
    await vi.waitFor(() => expect(firstCallWith(lead.calls, "整理 #42 的发布说明")).toBeGreaterThanOrEqual(0), { timeout: 5_000 });
    addInbox(db, {
      itemId: createItem(db, { title: "迁移脚本", brief: "b", createdBy: "system" }),
      severity: "blocker", source: "structural", summary: "迁移脚本卡住了", lossless: true,
    });
    addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "看一下 #42 的 CI",
      setBy: { turnId: first.turnId, bindingId: owner.binding.id, startedAt: new Date().toISOString() },
    });
    await vi.waitFor(() => expect(listEvents(db, { kind: "timer.fired" })).toHaveLength(1), { timeout: 5_000 });
    release.resolve();
    await vi.waitFor(() => expect(firstCallWith(lead.calls, "迁移脚本卡住了")).toBeGreaterThanOrEqual(0), { timeout: 10_000 });
    expect(firstCallWith(lead.calls, "看一下 #42 的 CI")).toBeLessThan(firstCallWith(lead.calls, "迁移脚本卡住了"));
    expect(logs.some((line) => line.startsWith("[sched] dispatch lane=L1"))).toBe(false);
  }, 30_000);
});

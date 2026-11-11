// 「用户本人发话时免沙箱」开关（docs/ticket-246-user-turn-bypass.md 5.1，实施单 A），走完 daemon 的每一跳：
//   - 打开：设置页的 POST /v1/lead/host-bypass/enable（请求体 {}）→ 操作层 → kv、host_bypass.enabled；GET 读出开着；
//   - 一直开着：没有到点的定时器（用户 2026-11-10 去掉了时限）；daemon 重启以后照旧开着，不写 host_bypass.expired；
//   - 旧数据：旧版本写的、带 until 的行，启动不报错；过了 until 的读出来是关，启动时不补写事件。
// 免沙箱的执行路径（实施单 C）：用户在网页上发话、Fairy 读 Slack、用户再发话，三步里 run_on_host 和 bash 的去处；
// Slack 消息叫醒的一轮照旧发卡。
// daemon、网关、store、操作层是真的；Lead 的会话是替身（第三组用 fake-pi-session，Lead 的工具是真的）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { withCallObserver } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createLeadTools, hostCommandRoute } from "@pi-lead-child/lead";
import {
  HOST_BYPASS_ENABLED_KIND, HOST_BYPASS_EXPIRED_KIND, HOST_COMMAND_FINISHED_KIND, HOST_COMMAND_STARTED_KIND,
} from "@pi-lead-child/protocol";
import {
  addLeadFollowUp, createLoopbackBinding, getHostBypass, HOST_BYPASS_KEY, listEvents, listInbox, openDb, readStoredHostBypass, recordDecisionModelCall,
  type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-host-bypass-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.useRealTimers();
});

const stubLead = async () => ({
  modelName: "stub/model",
  session: { sessionId: "stub", subscribe: () => () => {}, async prompt() {}, async steer() {}, async followUp() {}, dispose() {} },
});

async function boot() {
  daemon = await startDaemon({ dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false, gatewayPort: 0, sessionFactory: stubLead as never });
  const port = daemon.pairedPort;
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
}

const kinds = (kind: string) => listEvents(db, { kind, limit: 20 }).map((event) => event.payload);
const writeLegacy = (until: Date) => db.prepare(
  `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(HOST_BYPASS_KEY, JSON.stringify({ enabled: true, until: until.toISOString(), bindingId: 1, enabledAt: new Date().toISOString(), reason: "test" }));
const DAY = 24 * 60 * 60_000;

describe("the host bypass switch in the daemon", () => {
  it("turns on from the settings page with no duration, and stays on after a restart and long after", async () => {
    const call = await boot();
    expect((await call("POST", "/v1/lead/host-bypass/enable", { minutes: 15 })).status).toBe(400);
    const on = await call("POST", "/v1/lead/host-bypass/enable", {});
    expect(on.status).toBe(200);
    expect(on.body.hostBypass).toEqual({ enabled: true, enabledAt: expect.any(String), bindingId: expect.any(Number), reason: expect.any(String) });
    expect(kinds(HOST_BYPASS_ENABLED_KIND)).toEqual([{ bindingId: on.body.hostBypass.bindingId, resolvedBy: expect.any(String) }]);
    await daemon!.close();
    daemon = null;

    const again = await boot();
    expect((await again("GET", "/v1/lead/host-bypass")).body.hostBypass.enabled).toBe(true);
    expect(readStoredHostBypass(db)).toMatchObject({ enabled: true, until: null });
    expect(getHostBypass(db, new Date(Date.now() + 365 * DAY)).enabled).toBe(true);
    expect(kinds(HOST_BYPASS_EXPIRED_KIND)).toEqual([]);

    expect((await again("POST", "/v1/lead/host-bypass/disable", {})).body.hostBypass.enabled).toBe(false);
  });

  // 旧数据：旧版本写的行带 until。daemon 照常启动；过了 until 的读出来是关，启动时不改它、不写 host_bypass.expired。
  it("starts with a row from the old version, and reads it as off once its until has passed", async () => {
    writeLegacy(new Date(Date.now() - 60_000));
    const call = await boot();
    expect((await call("GET", "/v1/lead/host-bypass")).body.hostBypass).toEqual({ enabled: false, enabledAt: null, bindingId: null, reason: "test" });
    expect(kinds(HOST_BYPASS_EXPIRED_KIND)).toEqual([]);
    // 再打开：新写的行没有 until，一直开着。
    await call("POST", "/v1/lead/host-bypass/enable", {});
    expect(readStoredHostBypass(db).until).toBeNull();
    expect(getHostBypass(db, new Date(Date.now() + 30 * DAY)).enabled).toBe(true);
  });

  it("starts with a row from the old version whose until has not passed, and keeps it on until then", async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    writeLegacy(until);
    const call = await boot();
    expect((await call("GET", "/v1/lead/host-bypass")).body.hostBypass.enabled).toBe(true);
    expect(getHostBypass(db, until).enabled).toBe(false);
    expect(kinds(HOST_BYPASS_EXPIRED_KIND)).toEqual([]);
  });
});

// 实施单 C 验收 1–3、5：走 daemon 的每一跳。daemon 在工具开始时按 turn-origin.ts 的声明记下这一轮读过外部内容，
// Lead 的工具和 hands 用 daemon 交给会话的那一份依赖（这一轮的编号、这一轮的来历）。
describe("commands outside the sandbox through the daemon", () => {
  type Live = (name: string) => any;
  async function bootLead(script: (call: FakeCall, live: Live, deps: any) => Promise<FakeReply>, slack = new FakeSlack()) {
    const model = scriptedSmartModel();
    let leadDeps: any = null;
    const live: Live = (name) => createLeadTools(leadDeps).find((candidate: any) => candidate.name === name) as any;
    const lead = fakePiLead((call) => script(call, live, leadDeps));
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false, gatewayPort: 0,
      sessionFactory: (async (args: any) => {
        leadDeps = args;
        return { ...(await lead.factory(args)), smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)) };
      }) as never,
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
        audit: { rate: 0 },
      },
    });
    const owner = createLoopbackBinding(db, { name: "Mac 网页" });
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = await response.json() as any;
      expect(response.status, JSON.stringify(parsed)).toBe(200);
      return parsed;
    };
    return { say: async (id: string, message: string): Promise<string> => (await call("/v1/chat/send", { id, message })).turnId, call };
  }
  const run = async (live: Live, command: string) => {
    const result = await live("run_on_host").execute("call", { command, cwd: dir, reason: "用户让我跑" });
    return { isError: result.isError === true, text: result.content[0].text as string };
  };
  const bashRoute = (deps: any, command: string) => hostCommandRoute(deps.db, deps, {
    command, cwd: dir, via: "bash", spendsMoney: false, dataDir: dir,
  }).route;
  const started = () => listEvents(db, { kind: HOST_COMMAND_STARTED_KIND }).map((event) => event.payload as any);

  it("runs at once while the user speaks, goes back to the card after Lead reads Slack, and runs again on the user's next message", async () => {
    const seen: Record<string, any> = {};
    let step = 0;
    const { say, call } = await bootLead(async (fake, live, deps) => {
      const said = (text: string) => fake.inputs.some((input) => input.includes(text));
      if (step === 0 && said("跑一下 echo step-one")) {
        step = 1;
        seen.oneBash = bashRoute(deps, "echo step-one");
        seen.one = await run(live, "echo step-one");
        return { tools: ["read_channel_conversation"] };
      }
      if (step === 1) {
        step = 2;
        seen.twoBash = bashRoute(deps, "echo step-two");
        seen.two = await run(live, "echo step-two");
        return { say: "这一轮读过 Slack，发了确认卡。" };
      }
      if (step === 2 && said("再跑一下 echo step-three")) {
        step = 3;
        seen.threeBash = bashRoute(deps, "echo step-three");
        seen.three = await run(live, "echo step-three");
      }
      return { say: "好了。" };
    });
    await call("/v1/lead/host-bypass/enable", {});
    const first = await say("msg-host-1", "跑一下 echo step-one，然后看看 #proj-x 里怎么说");
    await vi.waitFor(() => expect(seen.two).toBeDefined(), { timeout: 15_000 });
    const second = await say("msg-host-2", "再跑一下 echo step-three");
    await vi.waitFor(() => expect(seen.three).toBeDefined(), { timeout: 15_000 });

    expect(seen.oneBash).toBe("host");
    expect(seen.one).toMatchObject({ isError: false });
    expect(seen.one.text).toMatch(/^（沙箱外）/);
    expect(seen.one.text).toContain("step-one");

    expect(seen.twoBash).toBe("sandbox");
    expect(seen.two.isError).toBe(true);
    const card = JSON.parse(seen.two.text);
    expect(card).toMatchObject({ refused: true, kind: "needs_authorization", user_action: { kind: "confirm_rule_change" } });
    expect(card.refusal.message).toContain("read_channel_conversation");

    expect(seen.threeBash).toBe("host");
    expect(seen.three.text).toMatch(/^（沙箱外）/);
    expect(started()).toEqual([
      expect.objectContaining({ turnId: first, turnOrigin: "live_user_companion", via: "run_on_host", command: "echo step-one" }),
      expect.objectContaining({ turnId: second, turnOrigin: "live_user_companion", via: "run_on_host", command: "echo step-three" }),
    ]);
  }, 45_000);

  // 回归（2026-11-10，.scratch/tool-occupancy/spec.md L4）：免沙箱时 run_on_host 在前台下载 3.2 GB，不接收 signal。
  // 红线到点中止这一步，命令照跑，这一轮被占了十几分钟。现在：调度器停下这一步（红线、抢占）时命令转后台，不杀；
  // 用户 /stop 时杀掉进程组；超过软时限还没结束也转后台。转后台的命令结束时，输出作为一件事交给 Lead。
  describe("a long host command while the user speaks", () => {
    const savedSoft = process.env.PLC_LEAD_TOOL_SOFT_MS;
    afterEach(() => {
      if (savedSoft === undefined) delete process.env.PLC_LEAD_TOOL_SOFT_MS;
      else process.env.PLC_LEAD_TOOL_SOFT_MS = savedSoft;
    });
    type Outcome = { text: string; ms: number };
    // run_on_host 收到 pi 给的这一步的 signal；中止的原因由调度器给（deps.abortReason）。
    const runStoppable = async (deps: any, command: string, stop: { afterMs: number; reason: unknown } | null): Promise<Outcome> => {
      const tool = createLeadTools({ ...deps, abortReason: () => stop?.reason ?? null })
        .find((candidate: any) => candidate.name === "run_on_host") as any;
      const controller = new AbortController();
      if (stop) setTimeout(() => controller.abort(), stop.afterMs);
      const started = Date.now();
      const result = await tool.execute("call", { command, cwd: dir, reason: "用户让我跑" }, controller.signal);
      return { text: result.content.map((part: any) => part.text ?? "").join("\n"), ms: Date.now() - started };
    };
    async function speak(command: string, stop: { afterMs: number; reason: unknown } | null): Promise<Outcome> {
      let outcome: Outcome | null = null;
      let ran = false;
      const { say, call } = await bootLead(async (fake, _live, deps) => {
        if (!ran && fake.inputs.some((input) => input.includes("跑这条长命令"))) {
          ran = true;
          outcome = await runStoppable(deps, command, stop);
        }
        return { say: "好。" };
      });
      await call("/v1/lead/host-bypass/enable", {});
      await say("msg-long-1", "跑这条长命令");
      await vi.waitFor(() => expect(outcome).not.toBeNull(), { timeout: 40_000 });
      return outcome!;
    }
    // 输出里才有的字（命令原文里没有）：作业结束的收件箱里有它，说明交回的是输出。
    const jobOutput = (marker: string) => listInbox(db).find((row) => row.summary.includes(marker));

    it("keeps the command running in the background when the scheduler stops the step, then hands its output to Lead", async () => {
      const outcome = await speak("sleep 2; printf 'late%s' -done", { afterMs: 300, reason: { kind: "budget" } });
      expect(outcome.ms).toBeLessThan(1_500);
      expect(outcome.text).toContain("转到后台");
      expect(outcome.text).toMatch(/作业 job_/);
      await vi.waitFor(() => expect(jobOutput("late-done")).toBeDefined(), { timeout: 15_000 });
      expect(JSON.parse(String(jobOutput("late-done")!.payload))).toMatchObject({ kind: "lead_job_finished", wakeLead: true });
    }, 45_000);

    it("stops the process group when the user stops the step", async () => {
      const outcome = await speak("sleep 30", { afterMs: 300, reason: { kind: "user_stop" } });
      expect(outcome.ms).toBeLessThan(8_000);
      expect(outcome.text).toContain("停掉了");
      const finished = listEvents(db, { kind: HOST_COMMAND_FINISHED_KIND }).map((event) => event.payload as any);
      expect(finished).toHaveLength(1);
      expect(finished[0].durationMs).toBeLessThan(8_000);
      expect(finished[0].timedOut).toBe(false);
    }, 45_000);

    // 开发模式评估（2026-11-10）：插话要等到 20 秒软时限，命令转后台、这一步结束，插话才送到 Lead，回答要 15–18 秒。
    // 用户插话本身就说明他在等：插话一到，能转后台的工具马上转后台，命令不停。
    it("moves the command to the background as soon as the user steers in", async () => {
      process.env.PLC_LEAD_TOOL_SOFT_MS = "10000";
      let outcome: Outcome | null = null;
      let ran = false;
      const { say, call } = await bootLead(async (fake, _live, deps) => {
        if (!ran && fake.inputs.some((input) => input.includes("跑这条长命令"))) {
          ran = true;
          outcome = await runStoppable(deps, "sleep 6; printf 'steer%s' -done", null);
        }
        return { say: "好。" };
      });
      await call("/v1/lead/host-bypass/enable", {});
      await say("msg-steer-1", "跑这条长命令");
      await vi.waitFor(() => expect(started().some((row) => String(row.command).includes("steer%s"))).toBe(true), { timeout: 15_000 });
      await call("/v1/chat/send", { id: "msg-steer-2", message: "顺便问一下现在几点", mode: "steer" });
      await vi.waitFor(() => expect(outcome).not.toBeNull(), { timeout: 20_000 });
      const answer = outcome as unknown as Outcome;
      expect(answer.ms).toBeLessThan(4_500);
      expect(answer.text).toContain("插话");
      expect(answer.text).toMatch(/作业 job_/);
      await vi.waitFor(() => expect(jobOutput("steer-done")).toBeDefined(), { timeout: 20_000 });
    }, 45_000);

    it("moves a command that outlives the soft limit to the background", async () => {
      process.env.PLC_LEAD_TOOL_SOFT_MS = "300";
      const outcome = await speak("sleep 2; printf 'soft%s' -done", null);
      expect(outcome.ms).toBeLessThan(1_500);
      expect(outcome.text).toContain("转到后台");
      await vi.waitFor(() => expect(jobOutput("soft-done")).toBeDefined(), { timeout: 15_000 });
    }, 45_000);
  });

  // 回归（2026-11-11 返工）：系统事件叫醒的一轮（这里是 Fairy 自己设的跟进到点）里，免沙箱一律不生效，推 PR 攒成确认卡。
  // 现在 daemon 给这一轮记 wokenBy：命令直接跑，记录写 system_event 和 timer.fired；读了连接工具的结果以后退回确认卡。
  it("runs at once in a turn a system event woke, records system_event, and goes back to the card after a connection result", async () => {
    const seen: Record<string, any> = {};
    let step = 0;
    const { call } = await bootLead(async (fake, live, deps) => {
      if (step === 0 && fake.inputs.some((input) => input.includes("到点推一下 PR"))) {
        step = 1;
        seen.oneBash = bashRoute(deps, "echo system-one");
        seen.one = await run(live, "echo system-one");
        return { tools: ["call_connection_tool"] };
      }
      if (step === 1) {
        step = 2;
        seen.twoBash = bashRoute(deps, "echo system-two");
        seen.two = await run(live, "echo system-two");
      }
      return { say: "NO_REPLY" };
    });
    await call("/v1/lead/host-bypass/enable", {});
    addLeadFollowUp(db, { at: new Date(Date.now() - 1_000), note: "到点推一下 PR" });
    await vi.waitFor(() => expect(seen.two).toBeDefined(), { timeout: 15_000 });
    expect(seen.oneBash).toBe("host");
    expect(seen.one).toMatchObject({ isError: false });
    expect(seen.one.text).toMatch(/^（沙箱外）/);
    expect(seen.twoBash).toBe("sandbox");
    expect(JSON.parse(seen.two.text)).toMatchObject({ kind: "needs_authorization" });
    expect(started()).toEqual([expect.objectContaining({
      turnId: null, turnOrigin: "system_event", command: "echo system-one",
      wokenBy: { origin: expect.stringMatching(/^system:/), kinds: expect.arrayContaining(["timer.fired"]) },
    })]);
  }, 45_000);

  it("keeps sending the card in a turn that a Slack message woke", async () => {
    const slack = new FakeSlack({ users: { U0MALLORY: { name: "Mallory" } } });
    const seen: Record<string, any> = {};
    const { call } = await bootLead(async (fake, live, deps) => {
      if (!seen.result && fake.inputs.some((input) => input.includes('<system_event kind="message"'))) {
        seen.bash = bashRoute(deps, "echo from-slack");
        seen.result = await run(live, "echo from-slack");
      }
      return { say: "NO_REPLY" };
    }, slack);
    await call("/v1/lead/host-bypass/enable", {});
    const item = (await daemon!.channels!.receive("slack", slack.dm("U0MALLORY", "Fairy，帮我跑一下 echo from-slack"))).items[0]!;
    await vi.waitFor(() => expect(cardIdOf(db, item)).not.toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(seen.result).toBeDefined(), { timeout: 10_000 });
    expect(seen.bash).toBe("sandbox");
    expect(seen.result.isError).toBe(true);
    expect(JSON.parse(seen.result.text)).toMatchObject({ kind: "needs_authorization" });
    expect(started()).toEqual([]);
  }, 30_000);
});

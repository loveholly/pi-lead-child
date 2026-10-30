// 用户的消息不并进带着外部内容的一轮（lead-tools-and-routing spec D16），走完 daemon 的每一跳。
// 2026-10-27 21:05 的原样：Lead 在一个读了 Slack 的跟进轮次里，用户说「1 分钟后提醒我」。消息被插进那一轮，
// 按 pi 的一次运行记的外部标记让用户本人的话也算外部的一轮，设提醒被拒，Lead 请用户「随便再发一条」。
// 现在：那一轮带着外部内容时，用户的消息排队，等它结束后单独开一轮；那一轮是用户本人的一轮，设提醒照常。
// daemon、网关、store、通道 hub、Lead 的工具都是真的；Slack、SmartModel 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "@pi-lead-child/lead";
import { withCallObserver } from "@pi-lead-child/engine";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addLeadFollowUp, createLoopbackBinding, openDb, recordDecisionModelCall, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-user-external-turn-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function boot(script: (call: FakeCall, live: (name: string) => any) => Promise<FakeReply>) {
  const slack = new FakeSlack();
  const model = scriptedSmartModel();
  let leadDeps: any = null;
  const live = (name: string) => createLeadTools(leadDeps).find((candidate: any) => candidate.name === name) as any;
  const lead = fakePiLead((call) => script(call, live));
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
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
  const say = async (id: string, message: string): Promise<{ turnId: string; mode: string }> => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message }),
    });
    const body = await response.json() as { turnId: string; mode: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  return { say };
}

describe("a user's message while Lead is in a turn that read external content", () => {
  it("waits for a turn of its own, where setting a reminder works", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let step = 0;
    let userTextInSystemTurn = false;
    let reminder: any = null;
    const { say } = await boot(async (call, live) => {
      const mentionsUser = call.inputs.some((input) => input.includes("1 分钟后提醒我"));
      if (step === 0 && call.inputs.some((input) => input.includes("到点看一下 Slack 的 thread"))) {
        step = 1;
        // 读了 Slack 的对话：这一轮带上外部标记（daemon 在工具开始时记）。
        return { tools: ["read_channel_conversation"] };
      }
      if (step === 1) {
        step = 2;
        // 这一轮停在这里，测试在这时发用户的消息。
        return { say: [gate, "NO_REPLY"] };
      }
      if (step === 2 && mentionsUser && reminder === null) {
        reminder = await live("create_reminder").execute("c", {
          title: "测试到点卡", remind_at: new Date(Date.now() + 60_000).toISOString(), level: "tell",
        });
        return { say: "设好了。" };
      }
      if (mentionsUser && step < 2) userTextInSystemTurn = true;
      return { say: "NO_REPLY" };
    });
    addLeadFollowUp(db, { at: new Date(Date.now() - 1_000), note: "到点看一下 Slack 的 thread" });
    await vi.waitFor(() => expect(step).toBe(2), { timeout: 10_000 });

    const sent = await say("u1", "1 分钟后提醒我：测试到点卡");
    expect(sent.mode).toBe("queued");
    release();

    await vi.waitFor(() => expect(reminder).not.toBeNull(), { timeout: 15_000 });
    expect(userTextInSystemTurn).toBe(false);
    expect(reminder.isError).not.toBe(true);
    expect(JSON.stringify(reminder.content)).toMatch(/created reminder #\d+/);
  }, 30_000);
});

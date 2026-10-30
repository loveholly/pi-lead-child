// 代价信号走完 daemon 的路径（.scratch/lead-self-routing/spec.md C）：
//   - 每一轮的当前局面里，「关于你自己」一节写上下文用了多少；
//   - Lead 在一轮里时，一条外部消息排队超过阈值（PLC_LEAD_QUEUE_NOTICE_MS，缺省 5 分钟），系统插一条说明，同一轮只插一次。
// 2026-10-28：Lead 在主会话里发评审的那些轮里，两条 Slack 消息排着队，Lead 不知道，卡上一直写「排队中」。
// daemon、store、通道 hub、Slack 来源插件是真的；Slack、SmartModel 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { withCallObserver } from "@pi-lead-child/engine";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, createItem, openDb, recordDecisionModelCall, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-cost-signals-");
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

async function boot(
  slack: FakeSlack, script: (call: FakeCall) => Promise<FakeReply>, options: Parameters<typeof fakePiLead>[1] = {},
) {
  const model = scriptedSmartModel({});
  const lead = fakePiLead(script, options);
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async (args: any) => ({
      ...(await lead.factory(args)), smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)),
    })) as never,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  return lead;
}

const blocker = (summary: string) => addInbox(db, {
  itemId: createItem(db, { title: summary, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary, lossless: true,
});

describe("Lead sees how full its context is", () => {
  it("in every turn's situation", async () => {
    const calls: FakeCall[] = [];
    await boot(new FakeSlack(), async (call) => { calls.push(call); return { say: "NO_REPLY" }; }, {
      contextUsage: { window: 500_000, tokens: 300_000 },
    });
    blocker("Run #7 crashed");
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(calls[0]!.situation).toContain("你的上下文：约 30 万 / 50 万 token（60%）");
  }, 30_000);
});

describe("someone waits while Lead works in place", () => {
  it("is told to Lead once in the running turn, with who waits and for how long", async () => {
    vi.stubEnv("PLC_LEAD_QUEUE_NOTICE_MS", "300");
    const slack = new FakeSlack({ users: { U0OWEN: { name: "Owen" } } });
    const calls: FakeCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await boot(slack, async (call) => {
      calls.push(call);
      // 第一轮停住：Owen 的私信在这期间排队。
      if (calls.length === 1) return { say: ["在看。", gate] };
      return { say: "NO_REPLY" };
    });
    blocker("Run #7 crashed");
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    await daemon!.channels!.receive("slack", slack.dm("U0OWEN", "明哥的 fairy 可以体验了吗"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    release();

    // 停住的那一轮结束时，插进来的说明送到模型（pi 的插话在这次回答之后送）。
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const notices = calls.flatMap((call) => call.inputs).filter((input) => input.includes('kind="queue"'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Owen");
    expect(notices[0]).toMatch(/排了 \d+ (秒|分钟)/u);
  }, 30_000);
});

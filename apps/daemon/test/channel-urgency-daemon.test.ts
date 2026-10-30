// 别人发来的消息紧不紧急由通道内核问 SmartModel 定（用户 2026-10-19：自然语言不用正则），走完 daemon 的每一跳：
//   假 Slack 投递一条私信 → 通道内核问 Lead 会话的 SmartModel（替身，经会话工厂交给 daemon，和真的 createLeadSession 一样）
//   → 事件落库，带 urgent 和依据 → 投递结果（推送 + 会话卡）落库 → 推送发出去 → 客户端从 /v1/channels/cards 读到；
//   每次调用按用途 channel_urgency 记成 decision_model.called，get_system_usage 的统计里有它。
// daemon、网关、store、通道 hub 和 Slack 来源插件都是真的；Slack、SmartModel 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoopbackBinding, getChannelCard, getEvent, listEvents, openDb, recordDecisionModelCall, summarizeSystemUsage, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { withCallObserver, type SmartDecideOptions, type SmartModel } from "@pi-lead-child/engine";
import type { ChannelDelivery } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack } from "@pi-lead-child/engine/testing";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

// 别人发来的消息：先判断要不要用户回，再开卡（hub 的 settlePendingCard，用户 2026-10-21）。要开卡的等卡开出来，把卡号填回去。
async function receiveMessage(delivery: ChannelDelivery) {
  const item = (await daemon!.channels!.receive("slack", delivery)).items[0]!;
  if (item.role === "message" && (item.delivery === "card" || item.delivery === "push_card")) {
    await vi.waitFor(() => expect(cardIdOf(db, item)).not.toBeNull(), { timeout: 10_000 });
  }
  return { ...item, cardId: cardIdOf(db, item) };
}

beforeEach(() => {
  dir = tempDir("plc-channel-urgency-daemon-");
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

describe("channel urgency through the daemon", () => {
  it("asks Lead's SmartModel, stores urgent with its basis, pushes and opens a card the client can read", async () => {
    const slack = new FakeSlack({ users: { U0VIP: { name: "老板" }, U0OPS: { name: "值班的人" } } });
    // SmartModel 的替身：「客户在等」的那条需要马上看到，别的可以等。
    const asked: Array<{ state: string; opts: SmartDecideOptions | undefined }> = [];
    const stub: SmartModel = {
      backend: "fake-jev",
      async decide(state, questions, opts) {
        asked.push({ state, opts });
        const probability = state.includes("客户在等") ? 0.95 : 0.05;
        const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability }]));
        return { answers: answers as never, backend: "fake-jev", model: "jev-test", latencyMs: 3, fallbackFrom: null };
      },
    };
    const lead = fakePiLead(async () => ({ say: "好的。" }));
    const desktop: string[] = [];
    // 推送由 Lead 决定（落地计划 B）；Lead 不能工作时，系统按投递方式推送（统一消息事件工单 06）。这里让 Lead 的模型连不上，
    // 看投递方式：推送加会话卡的弹通知，会话卡不弹。
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "60");
    vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: (text) => desktop.push(text), triageShadow: false,
      networkProbe: async () => "getaddrinfo ENOTFOUND api.anthropic.com",
      // Lead 的会话把自己的 SmartModel 交给 daemon；createLeadSession 给它套上调用记录（decision_model.called），这里照做。
      sessionFactory: (async (args: any) => ({
        ...(await lead.factory(args)),
        smartModel: withCallObserver(stub, (call) => recordDecisionModelCall(args.db, call)),
      })) as never,
      channels: {
        sources: { slack: { api: slack.api, trust: { trusted: ["U0VIP", "U0OPS"] } } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      },
    });
    const owner = createLoopbackBinding(db, { name: "test-web" });
    const cards = async () => {
      const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/channels/cards`, {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: any[] }).items;
    };

    // 你信任的人发来私信，没有「紧急」二字，模型判断需要你马上看到：推送加会话卡。
    const urgent = (await receiveMessage(slack.dm("U0OPS", "服务挂了，客户在等你")));
    expect(urgent).toMatchObject({ inserted: true, delivery: "push_card" });
    expect(getEvent(db, urgent.seq!)!.payload).toMatchObject({
      urgent: true, channelDelivery: "push_card",
      urgency: { by: "smart_model", backend: "fake-jev", model: "jev-test", probability: 0.95, reason: null },
    });
    expect(getChannelCard(db, urgent.cardId!)).toMatchObject({ delivery: "push_card", state: "open" });
    // 没有客户端在看：推送弹成桌面通知（Lead 不能工作，系统按投递方式推送）。
    await vi.waitFor(() => expect(desktop).toEqual(["Slack · 值班的人：服务挂了，客户在等你"]), { timeout: 5_000 });

    // 带着「asap」但说了不急：只开会话卡，不推送。
    const calm = (await receiveMessage(slack.dm("U0VIP", "这个不急，不用 asap")));
    expect(calm).toMatchObject({ inserted: true, delivery: "card" });
    expect(getEvent(db, calm.seq!)!.payload).toMatchObject({ urgent: false, urgency: { by: "smart_model", probability: 0.05 } });
    // 不急的卡不弹通知，留在卡片列表里。
    await vi.waitFor(() => expect(listEvents(db, { kind: "message.received" }).some((event) => event.payload.cardId === calm.cardId)).toBe(true), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(desktop).toHaveLength(1);

    // 客户端从会话卡接口读到两张卡和各自的投递方式。
    const listed = await cards();
    expect(listed.find((card) => card.id === urgent.cardId)).toMatchObject({
      delivery: "push_card", state: "open", sender: { name: "值班的人", trust: "trusted" }, excerpt: "服务挂了，客户在等你",
    });
    expect(listed.find((card) => card.id === calm.cardId)).toMatchObject({ delivery: "card", state: "open" });

    // 每次调用带用途 channel_urgency，进了 get_system_usage 的统计。
    // 请求 A（channel_intake，工单 04）也问同一个 SmartModel，在后台问，不在这里数。
    expect(asked.filter((call) => call.opts?.purpose === "channel_urgency")).toHaveLength(2);
    const usage = summarizeSystemUsage(db).components.find((component) => component.component === "decision_model")!;
    expect(usage.byPurpose).toEqual(expect.arrayContaining([{ name: "channel_urgency", calls: 2, failures: 0 }]));
  }, 30_000);
});

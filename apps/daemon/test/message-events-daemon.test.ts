// 统一的消息事件（unified-message-events spec D1、D2、D6，工单 03）在 daemon 里走一遍。
// daemon、网关、store、通道 hub、Slack 来源插件、Lead 的输入（游标、排队）、记忆沉淀都是真的；Slack、SmartModel、Lead 的会话是替身。
//   1. 10-26 李雷的情况：Lead 正在一轮里时对方发来一条、又改了两次 → Lead 只收到一次输入，是改以后的话，包在外部标签里；
//   2. spec 场景 15：订阅频道里没提到用户的消息只记录、沉淀到记忆，不进 Lead；同一个频道里提到用户的消息带着原文进 Lead；
//   3. 你本人的入口（Companion）也产生同一个结构的消息事件：只做身份校验，不分诊，行为不变。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import type { SmartTextComplete } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createLoopbackBinding, listEvents, notesWithTag, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeScript } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-message-events-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 像真的模型那样「整理」：每条消息变成一条事实。只认记忆沉淀自己的提示格式（[n] 谁: 什么）。
function echoFacts(prompt: string): string {
  const facts = [...prompt.matchAll(/^\[\d+\] (.+?): (.+)$/gmu)].map((match) => `${match[1]} 说 ${match[2]}`);
  return JSON.stringify({ topic: "讨论", facts });
}

async function start(script: FakeScript, options: { complete?: SmartTextComplete; slack: FakeSlack; memory?: boolean }) {
  // 原话里问「上线」的是问进度（要干活）。状态文本的第一段是对方的原话（intake.ts 的 channelIntakeState）。
  const model = scriptedSmartModel({ answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("上线") ? "progress" : "other") } });
  const lead = fakePiLead(script, { smartModel: model, ...(options.complete ? { complete: options.complete } : {}) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    channels: {
      sources: { slack: { api: options.slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? options.slack.credential : null) },
      audit: { rate: 0 },
      ...(options.memory ? { memory: { quietMs: 100, maxWaitMs: 60_000, intervalMs: 0 } } : {}),
    },
  });
  return lead;
}

// 用户在网关上和 Lead 说一句话（Companion 的入口）。
async function say(text: string): Promise<void> {
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${owner.accessToken}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const events: Array<{ type?: string }> = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "chat.send", id: `cmd-${text.length}`, protocolVersion: 2, message: text }));
}

const inputsOf = (lead: ReturnType<typeof fakePiLead>) => lead.calls.flatMap((call) => call.inputs).join("\n");
// Lead 收到的外部消息（包在外部标签里的正文），按发信人。
const externalBlocks = (text: string, sender: string) =>
  [...text.matchAll(/<untrusted_external_text from="external"[^>]*>\n([\s\S]*?)\n<\/untrusted_external_text>/gu)]
    .filter((match) => match[0].includes(`sender="${sender}"`)).map((match) => match[1]!);

const V1 = "明哥，orders 和 billing 都上线了吗？";
const V2 = "明哥，orders、billing 和 ledger 都上线了吗？";
const V3 = "明哥，orders、billing 和 ledger 三个仓库今天都上线了吗？";

describe("message events in the daemon (unified-message-events 03)", () => {
  it("gives Lead one input with the last words when a message is edited twice while Lead is busy (10-26 李雷)", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    const lead = await start((call) => (call.inputs.join("\n").includes("先帮我看下日程")
      ? { say: ["好的，", busy, "看完了。"] } : { say: "收到。" }), { slack });
    // 用户先和 Lead 说话，这一轮停住：Lead 正在一轮里，外部消息排队（10-17 定的：不插话）。
    await say("先帮我看下日程");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("先帮我看下日程"), { timeout: 5_000 });

    const hub = daemon!.channels!;
    const dm = slack.dm("U0LILEI", V1);
    const item = (await hub.receive("slack", dm)).items[0]!;
    await hub.idle();
    await vi.waitFor(() => expect(listEvents(db, { kind: MESSAGE_EVENT_KIND })).toHaveLength(1), { timeout: 5_000 });
    await hub.receive("slack", slack.edit(dm, V2));
    await hub.idle();
    await hub.receive("slack", slack.edit(dm, V3));
    await hub.idle();
    const cardId = cardIdOf(db, item)!;
    expect(cardId).not.toBeNull();

    release();
    await vi.waitFor(() => expect(externalBlocks(inputsOf(lead), "李雷")).toHaveLength(1), { timeout: 10_000 });
    // 再等几拍：排着的别的版本也不会再交给 Lead。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seen = inputsOf(lead);
    expect(externalBlocks(seen, "李雷")).toEqual([V3]);
    expect(seen).not.toContain(V1);
    expect(seen).not.toContain(V2);
    // 给 Lead 的说明只有一份（这一条消息事件），写明卡号和编辑过几次。
    expect(seen.split(`通道卡 #${cardId}：`).length - 1).toBe(1);
    expect(seen).toContain("编辑过 2 次");
    // 只问了一次 Jev；交给 Lead 的请求就是那一条消息事件，不再另记通道请求（工单 05）。
    expect(listEvents(db, { kind: "channel.intake.decided" })).toHaveLength(1);
    expect(listEvents(db, { kind: "channel.lead.requested" })).toEqual([]);
  }, 30_000);

  it("only records a subscribed channel's message that does not mention the user, and remembers it; a mention reaches Lead with its words (scenario 15)", async () => {
    const slack = new FakeSlack({ users: { U0ZHANG: { name: "张三" }, U0LI: { name: "李四" } } });
    const complete: SmartTextComplete = async (prompt) => echoFacts(prompt);
    const lead = await start(() => ({ say: "收到。" }), { slack, complete, memory: true });
    const hub = daemon!.channels!;

    // 提到用户：开了道（这个频道从此算订阅），消息带着原文交给 Lead。
    await hub.receive("slack", slack.mention("U0ZHANG", "帮忙看下 orders 的发布单"));
    await hub.idle();
    await vi.waitFor(() => expect(externalBlocks(inputsOf(lead), "张三")).toEqual(["@我 帮忙看下 orders 的发布单"]), { timeout: 10_000 });

    // 订阅频道里没提到用户的消息：只记录，不开卡，没有消息事件，沉淀成笔记。
    const chatter = (await hub.receive("slack", slack.chatter("U0LI", "v2 周五发布，李四负责"))).items[0]!;
    expect(chatter).toMatchObject({ kind: "slack.channel.message", delivery: "record", cardId: null });
    await hub.idle();
    await vi.waitFor(() => expect(notesWithTag(db, chatter.objectKey)).toHaveLength(1), { timeout: 5_000 });
    expect(notesWithTag(db, chatter.objectKey)[0]!.content).toContain("李四 说 v2 周五发布，李四负责");
    expect(listEvents(db, { kind: MESSAGE_EVENT_KIND }).map((event) => event.payload.sender)).toEqual([
      expect.objectContaining({ name: "张三" }),
    ]);

    // 用户再和 Lead 说话：Lead 的输入（包括当前局面）里没有这条频道消息。
    await say("最近有什么事？");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("最近有什么事？"), { timeout: 5_000 });
    expect(inputsOf(lead)).not.toContain("周五发布");
  }, 30_000);

  it("gives the user's own message the same message structure, with identity only and no triage", async () => {
    const slack = new FakeSlack();
    const lead = await start(() => ({ say: "下午三点有个会。" }), { slack });
    await say("今天下午有什么安排？");
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThan(0), { timeout: 5_000 });
    const [event] = listEvents(db, { kind: "user.message" });
    expect(event).toMatchObject({
      source: "user", entityKey: "chat:main",
      payload: {
        text: "今天下午有什么安排？",
        message: {
          version: 1, entry: "user", source: "companion", conversation: { key: "chat:main" },
          sender: { trust: "self" }, text: "今天下午有什么安排？", external: false,
          inbound: null, ceiling: null, context: null, messages: [], edits: 0,
        },
      },
    });
    // 用户的话照旧包在 <user_message> 里交给 Lead，不进外部标签，也不写消息事件（message.received）。
    expect(inputsOf(lead)).toContain("今天下午有什么安排？");
    expect(inputsOf(lead)).not.toContain("<untrusted_external_text");
    expect(listEvents(db, { kind: MESSAGE_EVENT_KIND })).toEqual([]);
  }, 30_000);
});

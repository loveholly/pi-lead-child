// Lead 忙时的排队状态栏（统一消息事件 spec D6、D12，工单 10）在 daemon 里走一遍。
// daemon、网关、store、通道 hub、Slack 来源插件、Lead 的输入（游标、排队）都是真的；Slack、SmartModel、Lead 的会话是替身。
//   1. spec 场景 13：用户和 Lead 正在对话时进来一条 Slack 私信 → 卡马上显示；排队的推送和接口显示排队 1 条、是谁发的；
//      这一轮结束以后 Lead 处理它，排队空了（状态栏消失）；
//   2. 移出队列：卡结束（和「我自己回」一样），Lead 不再处理这一条；
//   3. 两个人的私信排着：Lead 一轮处理一个对话，用户排到下一个的先处理；同一个对话里排着的几条合成一次处理。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { LEAD_QUEUE_OPT_IN, LEAD_QUEUE_RESOURCE, MESSAGE_EVENT_KIND, type LeadQueue } from "@pi-lead-child/protocol";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createLoopbackBinding, getChannelCard, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeScript } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-queue-daemon-");
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

async function start(script: FakeScript, slack: FakeSlack) {
  const lead = fakePiLead(script, { smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  return lead;
}

// Companion 的连接：声明 include=lead_queue，收排队变化的推送。用户在这个连接上和 Lead 说话。
async function connect() {
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${owner.accessToken}&protocol=2&after_seq=-1&include=${LEAD_QUEUE_OPT_IN}`,
  );
  sockets.push(socket);
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const http = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return {
    events,
    say: (text: string) => socket.send(JSON.stringify({ type: "chat.send", id: `cmd-${text.length}`, protocolVersion: 2, message: text })),
    queue: async () => (await http("/v1/lead/queue")).body as LeadQueue,
    act: (action: "move_next" | "remove", key: string) => http(`/v1/lead/queue/${action}`, { method: "POST", body: { key } }),
    // 推送里最新的一份排队（snapshot.required，resource 是 lead-queue，带着整份快照）。
    pushed: () => events.filter((event) => event.type === "snapshot.required" && event.payload?.resource === LEAD_QUEUE_RESOURCE)
      .map((event) => event.payload!.queue as LeadQueue).at(-1) ?? null,
  };
}

const inputsOf = (lead: ReturnType<typeof fakePiLead>) => lead.calls.flatMap((call) => call.inputs).join("\n");
// Lead 收到的外部消息（包在外部标签里的正文），按发信人。
const externalBlocks = (text: string, sender: string) =>
  [...text.matchAll(/<untrusted_external_text from="external"[^>]*>\n([\s\S]*?)\n<\/untrusted_external_text>/gu)]
    .filter((match) => match[0].includes(`sender="${sender}"`)).map((match) => match[1]!);

// Lead 的一轮停住，直到 release()：用户正在和 Lead 对话。
function heldTurn(trigger: string) {
  let release!: () => void;
  const busy = new Promise<void>((resolve) => { release = resolve; });
  const script: FakeScript = (call) => (call.inputs.join("\n").includes(trigger) ? { say: ["好的，", busy, "看完了。"] } : { say: "收到。" });
  return { script, release: () => release() };
}

describe("the queue status bar above the composer (ticket 10)", () => {
  it("shows a Slack DM that arrives while the user talks with Lead as queued, and Lead handles it after the turn (scenario 13)", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    const turn = heldTurn("先帮我看下日程");
    const lead = await start(turn.script, slack);
    const client = await connect();
    client.say("先帮我看下日程");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("先帮我看下日程"), { timeout: 5_000 });

    const item = (await daemon!.channels!.receive("slack", slack.dm("U0LILEI", "明哥，orders 今天上线了吗？"))).items[0]!;
    await daemon!.channels!.idle();
    // 卡马上显示，不等 Lead。
    const cardId = cardIdOf(db, item)!;
    expect(getChannelCard(db, cardId)).toMatchObject({ state: "open" });
    // 状态栏：排队 1 条，李雷。接口和推送是同一份。
    await vi.waitFor(async () => expect(await client.queue()).toMatchObject({
      busy: true, entries: [{ key: item.objectKey, senders: ["李雷"], count: 1, cardIds: [cardId], next: true }],
    }), { timeout: 5_000 });
    await vi.waitFor(() => expect(client.pushed()).toMatchObject({ busy: true, entries: [{ senders: ["李雷"], count: 1 }] }), { timeout: 5_000 });
    // 不插话：这一轮还没有看到它。
    expect(externalBlocks(inputsOf(lead), "李雷")).toEqual([]);

    turn.release();
    await vi.waitFor(() => expect(externalBlocks(inputsOf(lead), "李雷")).toEqual(["明哥，orders 今天上线了吗？"]), { timeout: 10_000 });
    // 这一轮结束以后排队空了，状态栏消失。
    await vi.waitFor(async () => expect((await client.queue()).entries).toEqual([]), { timeout: 5_000 });
    await vi.waitFor(() => expect(client.pushed()?.entries).toEqual([]), { timeout: 5_000 });
  }, 30_000);

  it("ends the card when the user removes it from the queue, and Lead never handles it", async () => {
    const slack = new FakeSlack({ users: { U0KENT: { name: "Kent" } } });
    const turn = heldTurn("先帮我看下日程");
    const lead = await start(turn.script, slack);
    const client = await connect();
    client.say("先帮我看下日程");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("先帮我看下日程"), { timeout: 5_000 });

    const item = (await daemon!.channels!.receive("slack", slack.dm("U0KENT", "你这项目啥时候给我玩"))).items[0]!;
    await daemon!.channels!.idle();
    const cardId = cardIdOf(db, item)!;
    await vi.waitFor(async () => expect((await client.queue()).entries.map((entry) => entry.key)).toEqual([item.objectKey]), { timeout: 5_000 });

    const removed = await client.act("remove", item.objectKey);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ busy: true, entries: [] });
    // 卡结束，和卡上的「我自己回」一样；账本记的是你本人。
    expect(getChannelCard(db, cardId)).toMatchObject({ state: "left_to_user" });
    expect(listEvents(db, { kind: MESSAGE_EVENT_KIND })).toMatchObject([{ disposition: "handled" }]);
    expect(listEvents(db, { kind: "ui_action.performed" }).map((event) => event.payload)).toMatchObject([
      { target: { type: "lead_queue", id: item.objectKey }, action: "remove", actor: "user" },
    ]);

    turn.release();
    // 这一轮结束以后再等几拍：Lead 不会为它开一轮。
    await vi.waitFor(async () => expect((await client.queue()).busy).toBe(false), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(externalBlocks(inputsOf(lead), "Kent")).toEqual([]);
    expect(inputsOf(lead)).not.toContain(`通道卡 #${cardId}`);
    // 已经不在排队里的不能再移出。
    expect((await client.act("remove", item.objectKey)).status).toBe(404);
  }, 30_000);

  it("hands Lead one conversation per turn, the one the user moved to the front first, with all its queued messages", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" }, U0KENT: { name: "Kent" } } });
    const turn = heldTurn("先帮我看下日程");
    const lead = await start(turn.script, slack);
    const client = await connect();
    client.say("先帮我看下日程");
    await vi.waitFor(() => expect(inputsOf(lead)).toContain("先帮我看下日程"), { timeout: 5_000 });

    const hub = daemon!.channels!;
    const lilei = (await hub.receive("slack", slack.dm("U0LILEI", "orders 上线了吗？"))).items[0]!;
    await hub.idle();
    const kent = (await hub.receive("slack", slack.dm("U0KENT", "你这项目啥时候给我玩"))).items[0]!;
    await hub.idle();
    await hub.receive("slack", slack.dm("U0KENT", "那个机器人 不好用"));
    await hub.idle();
    await vi.waitFor(async () => expect((await client.queue()).entries.map((entry) => [entry.key, entry.count])).toEqual([
      [lilei.objectKey, 1], [kent.objectKey, 2],
    ]), { timeout: 5_000 });

    const moved = await client.act("move_next", kent.objectKey);
    expect(moved.status).toBe(200);
    expect(moved.body.entries.map((entry: { key: string }) => entry.key)).toEqual([kent.objectKey, lilei.objectKey]);
    // 已经是下一个：现在不能做（P5.8）。
    expect((await client.act("move_next", kent.objectKey)).status).toBe(409);

    const before = lead.calls.length;
    turn.release();
    await vi.waitFor(() => expect(externalBlocks(inputsOf(lead), "李雷")).toHaveLength(1), { timeout: 10_000 });
    const rounds = lead.calls.slice(before).map((call) => call.inputs.join("\n")).filter((text) => text.includes("<untrusted_external_text"));
    // 先是 Kent 的两条（一次处理），再是李雷的。
    expect(rounds.map((text) => [externalBlocks(text, "Kent"), externalBlocks(text, "李雷")])).toEqual([
      [["你这项目啥时候给我玩", "那个机器人 不好用"], []],
      [[], ["orders 上线了吗？"]],
    ]);
  }, 30_000);
});

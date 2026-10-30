// 外部消息的上下文包（unified-message-events spec D5，工单 04）在 daemon 里走一遍：断言在 Lead 实际收到的输入上。
// daemon、store、通道 hub、Slack 来源插件、Lead 的输入都是真的；Slack、SmartModel、Lead 的会话是替身。
//   1. 10-26 Ethan：只说「这个 pr 记得再帮我看看」，链接在三天前的消息里 → Lead 处理这条消息的那一轮里有这个链接，
//      在外部标签里；
//   2. 10-26 李雷：用户 30 分钟内在和 Ivy 的私信里问过同一个仓库 → Lead 处理李雷这条的那一轮里有用户的这句话，在外部标签里。
//   3. 工单 11 回放的问题 B：Lead 正忙时李雷改了消息、补了一个仓库 → Lead 收到的上下文包按改后的话拼（有这个仓库）。
//   4. 工单 11 回放的问题 C：只和话题有关、没提发信人的笔记也召回 → Lead 收到的上下文包里有这条笔记。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createLoopbackBinding, listEvents, openDb, saveNote, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeScript } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-message-context-daemon-");
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
  const model = scriptedSmartModel({
    answers: {
      ask_kind: (state) => {
        const words = state.split("\n\n")[0]!.toLowerCase();
        return words.includes("review") || words.includes("pr") ? "code_review" : words.includes("上线") ? "progress" : "other";
      },
    },
  });
  const lead = fakePiLead(script, { smartModel: model });
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    lookups: {
      candidates: () => [
        { repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } },
        { repo: "acme/ledger", root: "/work/ledger", github: { owner: "acme", repo: "ledger" } },
      ],
    },
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
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

// Lead 处理某一条消息的那一轮的输入。
const turnWith = (lead: ReturnType<typeof fakePiLead>, words: string) =>
  lead.calls.map((call) => call.inputs.join("\n")).find((inputs) => inputs.includes(words)) ?? null;
// 外部标签里的内容，按 part（上下文包的哪一段）。
const parts = (text: string, part: string) =>
  [...text.matchAll(/<untrusted_external_text from="external"[^>]*>\n([\s\S]*?)\n<\/untrusted_external_text>/gu)]
    .filter((match) => match[0].includes(`part="${part}"`)).map((match) => match[1]!);

const PR = "https://github.com/acme/orders/pull/112";
const HOUR = 60 * 60_000;

describe("the context pack in Lead's input (unified-message-events 04)", () => {
  it("gives Lead the PR link from three days back when Ethan only says 'this pr' (10-26 Ethan)", async () => {
    const slack = new FakeSlack({ users: { U0ETHAN: { name: "Ethan" } } });
    const lead = await start(() => ({ say: "收到。" }), slack);
    const hub = daemon!.channels!;
    const first = (await hub.receive("slack", slack.dm("U0ETHAN", `明哥，帮我 review 一下这个 PR：${PR}`))).items[0]!;
    await hub.idle();
    await vi.waitFor(() => expect(turnWith(lead, "帮我 review 一下这个 PR")).not.toBeNull(), { timeout: 10_000 });
    await hub.act(cardIdOf(db, first)!, "reply_myself", { by: "user" });
    await hub.receive("slack", slack.selfReply("D0ETHAN", "好的，我晚点看"));
    await hub.idle();

    slack.later(3 * 24 * HOUR - 4 * HOUR);
    await hub.receive("slack", slack.dm("U0ETHAN", "明哥，这个 pr 记得再帮我看看"));
    await hub.idle();
    await vi.waitFor(() => expect(turnWith(lead, "这个 pr 记得再帮我看看")).not.toBeNull(), { timeout: 10_000 });

    const turn = turnWith(lead, "这个 pr 记得再帮我看看")!;
    const conversation = parts(turn, "conversation");
    expect(conversation).toHaveLength(1);
    expect(conversation[0]).toContain(PR);
    expect(conversation[0]).toContain("好的，我晚点看");
    // 链接只在外部标签里。
    const outside = turn.replace(/<untrusted_external_text from="external"[^>]*>[\s\S]*?<\/untrusted_external_text>/gu, "");
    expect(outside).not.toContain(PR);
    expect(outside).toMatch(/上下文包：\d+ 条，\d+ 字/u);
  }, 30_000);

  it("gives Lead the user's question to Ivy from the last 30 minutes when 李雷 asks about the same repo (10-26 李雷)", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" }, U0IVY: { name: "Ivy" } } });
    const lead = await start(() => ({ say: "收到。" }), slack);
    const hub = daemon!.channels!;
    await hub.receive("slack", slack.dm("U0IVY", "今天下午的发布我这边准备好了"));
    await hub.idle();
    await hub.receive("slack", slack.selfReply("D0IVY", "orders 今天上线了吗？李雷那边在等"));
    await hub.idle();
    slack.later(10 * 60_000);
    await hub.receive("slack", slack.dm("U0LILEI", "明哥，orders、billing 和 ledger 三个仓库今天都上线了吗？"));
    await hub.idle();
    await vi.waitFor(() => expect(turnWith(lead, "三个仓库今天都上线了吗")).not.toBeNull(), { timeout: 10_000 });

    const related = parts(turnWith(lead, "三个仓库今天都上线了吗")!, "related");
    expect(related).toHaveLength(1);
    expect(related[0]).toContain("orders 今天上线了吗？李雷那边在等");
  }, 30_000);
  it("gives Lead the pack built from the edited words when the message is edited while Lead is busy (replay finding B)", async () => {
    const slack = new FakeSlack({ users: { U0LILEI: { name: "李雷" } } });
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    const lead = await start((call) => (call.inputs.join("\n").includes("先帮我看下日程")
      ? { say: ["好的，", busy, "看完了。"] } : { say: "收到。" }), slack);
    // 用户先和 Lead 说话，这一轮停住：外部消息排队，编辑并进排着的消息事件。
    await say("先帮我看下日程");
    await vi.waitFor(() => expect(turnWith(lead, "先帮我看下日程")).not.toBeNull(), { timeout: 5_000 });
    const hub = daemon!.channels!;
    const dm = slack.dm("U0LILEI", "明哥，orders 和 billing 都上线了吗？");
    await hub.receive("slack", dm);
    await hub.idle();
    await vi.waitFor(() => expect(listEvents(db, { kind: MESSAGE_EVENT_KIND })).toHaveLength(1), { timeout: 5_000 });
    await hub.receive("slack", slack.edit(dm, "明哥，orders、billing 和 ledger 都上线了吗？"));
    await hub.idle();

    release();
    await vi.waitFor(() => expect(turnWith(lead, "ledger 都上线了吗")).not.toBeNull(), { timeout: 10_000 });
    const objects = parts(turnWith(lead, "ledger 都上线了吗")!, "objects");
    expect(objects).toHaveLength(1);
    expect(objects[0]).toContain("仓库 acme/ledger");
  }, 30_000);

  it("gives Lead a note about the topic that does not name the sender (replay finding C, 10-26 Lucas)", async () => {
    saveNote(db, { title: "Fairy 是用户的个人助理", content: "fairy 现在可以在 Slack 里用，私信 Fairy 就行", tags: [], kind: "note" });
    const slack = new FakeSlack({ users: { U0LUCAS: { name: "Lucas Chen" } } });
    const lead = await start(() => ({ say: "收到。" }), slack);
    const hub = daemon!.channels!;
    await hub.receive("slack", slack.dm("U0LUCAS", "fairy"));
    await hub.idle();
    await vi.waitFor(() => expect(turnWith(lead, "fairy")).not.toBeNull(), { timeout: 10_000 });

    const memory = parts(turnWith(lead, "fairy")!, "memory");
    expect(memory).toHaveLength(1);
    expect(memory[0]).toContain("Fairy 是用户的个人助理");
  }, 30_000);
});

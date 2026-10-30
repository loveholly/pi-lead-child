// slack-takeover 工单 07（spec D12）：订阅频道里的对话整理成事实笔记，走完整的 daemon。
// daemon、网关、store、通道 hub、Slack 插件、记忆沉淀和 NotesMemory 都是真的；Slack、Lead 的会话和它交出来的模型是替身。
//   1. config.json 的 channels.slack.memory.exclude 接到 Slack 插件：排除的频道不订阅，也不沉淀；
//   2. 轮询每一拍调记忆沉淀：线程安静下来以后，用 Lead 会话的便宜模型（purpose channel_memory）整理成一条 fact 笔记；
//   3. 这些消息和笔记都不进 Lead 的输入（当前局面里没有）；Lead 用 search_notes 召回得到；
//   4. Slack 里删光了线程的消息：笔记删掉。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLoopbackBinding, notesWithTag, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "@pi-lead-child/lead";
import type { SmartTextComplete } from "@pi-lead-child/engine";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-channel-memory-daemon-");
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

describe("channel memory in the daemon (spec D12)", () => {
  it("remembers a subscribed thread as a fact note that Lead can only recall, honours the configured exclusion, and forgets a deleted thread", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ channels: { slack: { memory: { exclude: ["#ops"] } } } }));
    const slack = new FakeSlack({ channels: { C0OPS: "ops" } });
    const asked: Array<{ prompt: string; purpose: string }> = [];
    const complete: SmartTextComplete = async (prompt, opts) => {
      asked.push({ prompt, purpose: opts.purpose });
      return echoFacts(prompt);
    };
    const lead = fakePiLead(() => ({ say: "好的。" }), { complete });
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {},
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
        memory: { quietMs: 100, maxWaitMs: 60_000, intervalMs: 0 },
      },
    });
    const hub = daemon.channels!;

    await hub.receive("slack", slack.mention("U0ZHANG", "请看一下"));
    await hub.receive("slack", slack.mention("U0ZHANG", "运维这边也看一下", { channel: "C0OPS" }));
    const root = slack.chatter("U0LI", "v2 周五发布，李四负责");
    const thread = (await hub.receive("slack", root)).items[0]!;
    expect(thread).toMatchObject({ kind: "slack.channel.message", delivery: "record", cardId: null });
    // 排除的频道：普通消息不订阅。
    expect((await hub.receive("slack", slack.chatter("U0LI", "运维的普通消息", "C0OPS"))).items).toEqual([]);

    await vi.waitFor(() => expect(notesWithTag(db, thread.objectKey)).toHaveLength(1), { timeout: 5_000 });
    const note = notesWithTag(db, thread.objectKey)[0]!;
    expect(note).toMatchObject({ kind: "fact", title: "Slack #proj-x：讨论" });
    expect(note.content).toContain("- 李四 说 v2 周五发布，李四负责");
    const remembering = asked.filter((call) => call.purpose === "channel_memory");
    expect(remembering.length).toBeGreaterThan(0);
    // 别的补全只有按对话起草卡上的回复（用户 2026-10-21）：被提到的两个线程开了卡。这个 daemon 没有决策模型，
    // 收件判断也由便宜模型做（issue 10，用户 2026-10-30）。
    expect(asked.every((call) => ["channel_memory", "channel_draft", "channel_intake_llm"].includes(call.purpose))).toBe(true);
    // 排除的频道里被提到的那个线程也不沉淀。
    expect(remembering.map((call) => call.prompt).join("\n")).not.toContain("运维");

    // 用户在网关上和 Lead 说话：Lead 的输入（包括当前局面）里没有订阅频道的消息，也没有笔记。
    const owner = createLoopbackBinding(db, { name: "test-web" });
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${owner.accessToken}&protocol=2&after_seq=-1`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    socket.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "最近有什么事？" }));
    // 线程里的那条消息先交给了 Lead（落地计划 B：单独一轮，只有结构化的事实）；用户的话是后面的一轮。
    await vi.waitFor(() => expect(lead.calls.flatMap((call) => call.inputs).join("\n")).toContain("最近有什么事？"), { timeout: 5_000 });
    const seen = lead.calls.flatMap((call) => call.inputs).join("\n");
    expect(seen).not.toContain("周五发布");

    // Lead 用 search_notes 召回得到。
    const search = createLeadTools({ db, dbPath, dataDir: dir, memory: lead.deps().memory })
      .find((tool: any) => tool.name === "search_notes") as any;
    const found = (await search.execute("call", { query: "周五发布" })).content[0].text as string;
    expect(found).toContain(`note #${note.id} [fact]`);

    // Slack 里删掉这条消息（线程删空了）：笔记删掉。
    await hub.receive("slack", slack.remove(root));
    await vi.waitFor(() => expect(notesWithTag(db, thread.objectKey)).toEqual([]), { timeout: 5_000 });
  });
});

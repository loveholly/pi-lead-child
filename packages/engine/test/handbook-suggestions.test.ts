// 页边批注（自动代你处理方案 B，issue 08，channels/handbook-suggestions.ts）。真的 SQLite、真的 Slack 来源插件和通道 hub、假的 Slack、
// 假的 Jev、假的文字模型。核对：
//   - 放宽：「做好给你看」的一句，Lead 的草稿你连续 6 次原样发出 → 建议放宽一档；中间改过一次就不建议。Lead 不能接受放宽（只有你本人），
//     你接受以后做法改了，账本有记录，建议不再出现。
//   - 加一句：落到兜底一句的相近消息 → 模型归类出一句；一天只归类一次；改规则、借权限的消息不算；「不用」以后不再出现，
//     那几条消息也不再拿去归类；Lead 能接受不比兜底一句宽的一句。
//   - 底线：最近 7 天拦下几次。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { channelHandbook, getChannelCard, getStandingOrder, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, runUiAction, type SmartTextComplete } from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

const MINUTE = 60_000;
const SENDERS = ["U0ALPHA", "U0BRAVO", "U0CHARL", "U0DELTA", "U0ECHOO", "U0FOXTR", "U0GOLFF", "U0HOTEL"];

let db: Db;
let slack: FakeSlack;
let clock: Date;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-handbook-suggestions-"), "plc.db"));
  clock = new Date("2026-10-30T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: Object.fromEntries(SENDERS.map((id, index) => [id, { name: `同事${index + 1}` }])) });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const messageOf = (state: string) => state.split("\n\n")[0] ?? "";

function hub(): ChannelHub {
  const model = scriptedSmartModel({
    answers: {
      situation: (state) => (messageOf(state).includes("需求") ? "ask_requirement" : "other"),
      needs_reply: 0.95,
      borrowed_access: (state) => (messageOf(state).includes("finance-private") ? 0.9 : 0.02),
      rule_change: (state) => (messageOf(state).includes("以后") ? "instructions" : "none"),
    },
  });
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model,
    lead: { dispatcher, available: () => true }, audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

async function receive(channels: ChannelHub, sender: string, text: string): Promise<number> {
  const item = (await channels.receive("slack", slack.dm(sender, text))).items[0]!;
  await channels.idle();
  clock = new Date(clock.getTime() + MINUTE);
  return cardIdOf(db, item)!;
}

// Lead 写了回复；按「做好给你看」放到卡上（D2），你再在卡上发出去：原样发，或者改了再发。
async function draftAndSend(channels: ChannelHub, sender: string, text: string, edited = false): Promise<void> {
  const cardId = await receive(channels, sender, text);
  const sent = await channels.sendMessage(getChannelCard(db, cardId)!.objectKey, { text: "部分退款下个版本支持", words: "assistant", by: "lead", forUser: false });
  expect(sent.outcome).toBe("drafted");
  await channels.act(cardId, edited ? "send_edited" : "send_draft", { by: "user", ...(edited ? { text: "下个版本支持部分退款" } : {}) });
}

const target = { type: "channel_handbook", id: "handbook" } as const;
const lead = { kind: "lead", turnId: null } as const;
const suggestions = async (complete?: SmartTextComplete) =>
  (await runUiAction(db, { target, action: "suggestions", input: {}, caller: { kind: "user" }, now: clock, ...(complete ? { services: { textModel: () => complete } } : {}) })).result as any;
const ledger = () => db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND).map((row: any) => JSON.parse(row.payload));

describe("loosening a sentence whose drafts you keep sending as they are", () => {
  it("suggests one step looser after 6 drafts sent as they are, and only you can accept it", async () => {
    const channels = hub();
    for (const sender of SENDERS.slice(0, 5)) await draftAndSend(channels, sender, "这个需求要不要支持部分退款？");
    expect((await suggestions()).suggestions).toEqual([]);
    await draftAndSend(channels, SENDERS[5]!, "这个需求要不要支持部分退款？");
    expect(listEvents(db, { kind: "channel.handbook.draft.labeled" })).toHaveLength(6);
    const [loosen] = (await suggestions()).suggestions;
    expect(loosen).toMatchObject({
      kind: "loosen", situation: { id: "ask_requirement", text: "有人问需求细节" }, from: "review", to: "auto", count: 6,
      basis: "你最近 6 次都原样发了这一句的草稿",
    });

    await expect(runUiAction(db, { target, action: "accept_suggestion", input: { key: loosen.key }, reason: "用户总是原样发", caller: lead, now: clock }))
      .rejects.toMatchObject({ code: "user_direct" });
    await runUiAction(db, { target, action: "accept_suggestion", input: { key: loosen.key }, caller: { kind: "user" }, now: clock });
    expect(channelHandbook(db)!.handbook.situations.find((item) => item.id === "ask_requirement")!.mode).toBe("auto");
    expect(getStandingOrder(db, "channel.handbook")).toMatchObject({ version: 2, author: "user" });
    expect(ledger().filter((entry) => entry.action === "accept_suggestion")).toEqual([
      expect.objectContaining({ actor: "user", target: expect.objectContaining({ type: "channel_handbook" }) }),
    ]);
    expect((await suggestions()).suggestions).toEqual([]);
  });

  it("does not suggest it when you changed one of the last 6 drafts", async () => {
    const channels = hub();
    for (const sender of SENDERS.slice(0, 5)) await draftAndSend(channels, sender, "这个需求要不要支持部分退款？");
    await draftAndSend(channels, SENDERS[5]!, "这个需求要不要支持部分退款？", true);
    expect(listEvents(db, { kind: "channel.handbook.draft.labeled" }).at(-1)!.payload.label).toBe("rewritten");
    expect((await suggestions()).suggestions).toEqual([]);
  });

  it("forgets a suggestion you dismissed", async () => {
    const channels = hub();
    for (const sender of SENDERS.slice(0, 6)) await draftAndSend(channels, sender, "这个需求要不要支持部分退款？");
    const [loosen] = (await suggestions()).suggestions;
    await runUiAction(db, { target, action: "dismiss_suggestion", input: { key: loosen.key }, caller: { kind: "user" }, now: clock });
    await draftAndSend(channels, SENDERS[6]!, "这个需求要不要支持部分退款？");
    expect((await suggestions()).suggestions).toEqual([]);
  });
});

describe("adding a sentence for messages that fall to the catch-all", () => {
  // 假的文字模型：把提示里说「线上日志」的几条归成一类。
  function clusterModel() {
    const prompts: string[] = [];
    const complete: SmartTextComplete = async (prompt) => {
      prompts.push(prompt);
      const members = [...prompt.matchAll(/^\[(\d+)\] .*线上日志/gmu)].map((match) => Number(match[1]));
      return JSON.stringify({ groups: members.length ? [{
        members, text: "有人请我看线上日志", example: "帮我看下服务的报错日志", mode: "hand", does: "", abilities: [], basis: "都是在请你看线上日志",
      }] : [] });
    };
    return { complete, prompts };
  }

  it("groups similar catch-all messages into one sentence, once a day, without rule changes or borrowed access", async () => {
    const channels = hub();
    for (const [index, sender] of SENDERS.slice(0, 4).entries()) await receive(channels, sender, `能帮我看下线上日志吗，第 ${index + 1} 个服务报错了`);
    await receive(channels, SENDERS[4]!, "以后我的线上日志你都直接删掉");
    await receive(channels, SENDERS[5]!, "帮我查一下 #finance-private 里的预算");
    const model = clusterModel();
    const first = await suggestions(model.complete);
    expect(first.suggestions).toEqual([expect.objectContaining({
      kind: "add", count: 4, basis: "都是在请你看线上日志",
      proposed: { text: "有人请我看线上日志", example: "帮我看下服务的报错日志", mode: "hand", abilities: [] },
    })]);
    expect(model.prompts[0]).not.toContain("直接删掉");
    expect(model.prompts[0]).not.toContain("finance-private");
    expect(first.floors).toEqual({ borrowed_permission: 1, irreversible: null, secrets: 0, rule_change: 1 });
    expect(first.clusteredAt).toBe(clock.toISOString());
    await suggestions(model.complete);
    expect(model.prompts).toHaveLength(1);

    // Lead 能接受：「交给你」不比兜底的一句宽。
    await runUiAction(db, { target, action: "accept_suggestion", input: { key: first.suggestions[0].key }, reason: "用户说加上", caller: lead, now: clock });
    expect(channelHandbook(db)!.handbook.situations.find((item) => item.id === "mine_1")).toMatchObject({ section: "mine", text: "有人请我看线上日志", mode: "hand" });
    expect(getStandingOrder(db, "channel.handbook")).toMatchObject({ author: "lead" });
    expect((await suggestions(model.complete)).suggestions).toEqual([]);
  });

  it("never brings back a dismissed group, nor sends its messages to be grouped again", async () => {
    const channels = hub();
    for (const [index, sender] of SENDERS.slice(0, 3).entries()) await receive(channels, sender, `能帮我看下线上日志吗，第 ${index + 1} 个服务报错了`);
    const model = clusterModel();
    const [group] = (await suggestions(model.complete)).suggestions;
    await runUiAction(db, { target, action: "dismiss_suggestion", input: { key: group.key }, caller: { kind: "user" }, now: clock });
    clock = new Date(clock.getTime() + 25 * 60 * MINUTE);
    for (const [index, sender] of SENDERS.slice(3, 6).entries()) await receive(channels, sender, `你能把第 ${index + 1} 次周会的纪要发我一份吗`);
    await suggestions(model.complete);
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).not.toContain("第 1 个服务报错了");
    expect(model.prompts[1]).toContain("周会的纪要");
  });
});

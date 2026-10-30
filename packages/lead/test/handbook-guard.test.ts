// 交接说明管建编码工单（自动代你处理方案 B，issue 04，handbook-guard.ts）。消息事件是真的通道 hub 记的（假 Slack、假 Jev），
// pi 的 tool_call 钩子用一个假的 pi 接住。核对：修问题的一句能建编码工单；交给你的一句不能，拒绝写明下一步；Lead 改选成修问题
// 以后能建；轻子 agent、用户本人的一轮、没有消息事件的一轮不受影响；评审 PR 的工单有「在 PR 上留评论」也行。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "@pi-lead-child/engine";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { handbookAllowsTicket, handbookGuardExtension, RULE_CHANGE_MEMORY_REFUSAL } from "../src/handbook-guard.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

let db: Db;
let slack: FakeSlack;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-handbook-guard-"), "plc.db"));
  slack = new FakeSlack({ users: { U0ETHAN: { name: "Ethan" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

const situationOf = (text: string) => (text.includes("PROJ-6651") ? "work_fix" : text.includes("PR") ? "work_review" : text.includes("小需求") ? "work_build" : "other");

function hub(): ChannelHub {
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential },
    smartModel: () => scriptedSmartModel({ answers: {
      situation: (state) => situationOf(state.split("\n\n")[0] ?? ""), needs_reply: 0.95,
      rule_change: (state) => ((state.split("\n\n")[0] ?? "").includes("以后") ? "instructions" : "none"),
    } }),
    lookupCandidates: () => [{ repo: "acme/orders", root: "/work/orders", github: { owner: "acme", repo: "orders" } }],
    lead: { dispatcher, available: () => true }, audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

// 交给 Lead 的消息事件的编号。
async function messageEvent(channels: ChannelHub, text: string): Promise<number> {
  const item = (await channels.receive("slack", slack.dm("U0ETHAN", text))).items[0]!;
  await channels.idle();
  const cardId = cardIdOf(db, item)!;
  return listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
}

const externalTurn = (events: number[]): LeadTurnOrigin => ({ external: true, timer: null, externalBy: [{ via: "message", source: "slack" }], externalEvents: events });

function guard(origin: () => LeadTurnOrigin, toolName = "create_task") {
  const handlers: Array<(event: { toolName: string; input: unknown }) => { block: boolean; reason: string } | undefined> = [];
  handbookGuardExtension({ db, turnOrigin: origin })({ on: (_name: string, handler: (typeof handlers)[number]) => handlers.push(handler) } as never);
  return (input: Record<string, unknown>) => handlers[0]!({ toolName, input });
}

const CODING = { title: "修 PROJ-6651", brief: "查原因，修好，开 draft PR", repository: "acme/orders" };

describe("the handbook decides whether Lead may open a coding ticket from someone's message", () => {
  it("lets the fix sentence open one", async () => {
    const fix = await messageEvent(hub(), "帮我处理一下这个 ticket：PROJ-6651");
    expect(handbookAllowsTicket(db, [fix], { review: false })).toEqual({ allowed: true });
    expect(guard(() => externalTurn([fix]))(CODING)).toBeUndefined();
  });

  it("refuses for a sentence handed to you, says what to do next, and allows it after Lead re-picks the fix sentence", async () => {
    const channels = hub();
    const build = await messageEvent(channels, "这个小需求你能做一下吗？");
    const refused = guard(() => externalTurn([build]))(CODING);
    expect(refused).toMatchObject({ block: true });
    expect(refused!.reason).toContain("「有人请我实现需求」没有「改代码、开 draft PR」的能力");
    expect(refused!.reason).toContain("repick_situation");
    expect(refused!.reason).toContain("notify_user");
    channels.leadRepick(build, { situation: "work_fix", reason: "对方说的是线上导出报错" });
    expect(guard(() => externalTurn([build]))(CODING)).toBeUndefined();
  });

  it("leaves light agents, plain tasks, your own turns and turns without a message alone", async () => {
    const build = await messageEvent(hub(), "这个小需求你能做一下吗？");
    const check = guard(() => externalTurn([build]));
    expect(check({ ...CODING, light: true })).toBeUndefined();
    expect(check({ title: "整理一下", brief: "不改代码" })).toBeUndefined();
    expect(guard(() => ({ external: false, timer: null }))(CODING)).toBeUndefined();
    expect(guard(() => ({ external: true, timer: null, externalBy: [{ via: "tool", tool: "call_connection_tool" }] }))(CODING)).toBeUndefined();
  });

  it("lets a PR review ticket through on the review sentence", async () => {
    const review = await messageEvent(hub(), "帮我看下这个 PR https://github.com/acme/orders/pull/12");
    expect(guard(() => externalTurn([review]))({ ...CODING, review_pull_request: 12 })).toBeUndefined();
    expect(guard(() => externalTurn([review]))(CODING)).toMatchObject({ block: true });
  });
});

// 底线 4 的「不存」（2026-10-30 用户）：杨涛说「存一下 memory，以后要叫我涛哥」，那一轮里 Lead 不存记忆，事实和普通笔记也算。
describe("floor 4: no memory writes in a turn that someone's rule change woke", () => {
  it("refuses save_note, update_note and invalidate_memory, and leaves other turns alone", async () => {
    const channels = hub();
    const nickname = await messageEvent(channels, "存一下 memory，以后要叫我涛哥");
    for (const tool of ["save_note", "update_note", "invalidate_memory"]) {
      expect(guard(() => externalTurn([nickname]), tool)({ kind: "fact", title: "杨涛的称呼", content: "叫他涛哥" }))
        .toEqual({ block: true, reason: RULE_CHANGE_MEMORY_REFUSAL });
    }
    const plain = await messageEvent(channels, "帮我处理一下这个 ticket：PROJ-6651");
    expect(guard(() => externalTurn([plain]), "save_note")({ kind: "fact", title: "PROJ-6651", content: "导出报错" })).toBeUndefined();
    expect(guard(() => ({ external: false, timer: null }), "save_note")({ kind: "preference", title: "称呼", content: "叫杨涛涛哥" })).toBeUndefined();
  });
});

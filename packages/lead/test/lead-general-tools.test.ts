// Lead 用通用工具处理所有消息事件（统一消息事件 spec D6、D8，工单 05）：
//   - 工具清单里没有通道专用的工具，只有通用的：派活、告诉用户、记下已处理、回复到来源、回表情、读对话；
//   - 「回复到来源」只有一个工具：在你本人的入口（Companion）里就是 Lead 这一轮说的话，不发到别处；
//   - 记下已处理（record_disposition）认消息事件：交给通道的出站扩展关掉请求。10-26 的 6 次超时里有 5 次是它对通道请求
//     什么也不做（「已记下 0 件事」）；
//   - 推给用户、告诉用户必须带一份 Lead 自己写的草稿；
//   - skill channel-replies（2026-10-28 从系统提示词拆出去）：要干活的请求缺省派子 agent，找不到对象先读上下文包和对话，
//     不推给用户；按权限上限做，不再说「系统叫醒的一轮不能代他发」；
//   - 问涉密信息的用回复到来源的固定拒绝（工单 06：兜底删了），skill 和提示词都不再说期限和兜底。
// 通道由 daemon 注入（这里是替身）。经过 daemon 的完整流程在 apps/daemon/test/lead-general-tools-replay.test.ts。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { AUTHORITY_REFUSAL_TEXT } from "@pi-lead-child/engine";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { appendEvent, openDb, type Db } from "@pi-lead-child/store";
import type { LeadChannelCards } from "../src/channel-tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_SKILLS_DIR } from "../src/session.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const CHANNEL_SKILL = readFileSync(join(LEAD_SKILLS_DIR, "channel-replies", "SKILL.md"), "utf8");

let db: Db;
let deps: LeadDeps;
let calls: Array<[string, unknown[]]>;

// 通道的替身：记下每次调用。
function channelCards(): LeadChannelCards {
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return { cardId: 3, state: "handled", note: null } as never;
  };
  return {
    read: () => null,
    dispatch: async (...args: unknown[]) => { calls.push(["dispatch", args]); return { itemId: 1, runId: 1, grant: [], dropped: [] }; },
    notify: record("notify"),
    dispose: async (...args: unknown[]) => { calls.push(["dispose", args]); return { cardId: 3, state: "handled", note: null }; },
    findConversations: async () => [],
    readConversation: async () => ({ conversation: "slack:@U0IVY", label: "Ivy", objectKey: "slack:D0IVY:main", messages: [] }),
    recentConversations: () => [],
  };
}

beforeEach(() => {
  const dir = tempDir("plc-lead-general-tools-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  calls = [];
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => null, channelCards: channelCards() };
});

const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
const textOf = async (name: string, params: Record<string, unknown>) => (await tool(name).execute("call", params)).content[0].text as string;

// 一条外部通道的消息事件（hub 记的 message.received）。
function externalMessage(): number {
  return db.transaction(() => appendEvent(db, {
    source: "system", kind: MESSAGE_EVENT_KIND, entityKey: "slack:D0IVY:main", correlationId: "channel:slack:D0IVY:main", level: "tell",
    payload: {
      version: 1, entry: "external", source: "slack", sourceLabel: "Slack", conversation: { key: "slack:D0IVY:main", label: "Ivy 的私信" },
      sender: { id: "U0IVY", name: "Ivy", trust: "colleague" }, text: "按映射发消息", external: true,
      inbound: null, ceiling: { authority: "ask", bound: null }, context: null,
      replyTo: { conversation: "slack:D0IVY:main", message: "1.000100" }, messages: [1], edits: 0, cardId: 3, summary: "通道卡 #3",
    },
  }).event.seq)();
}

describe("Lead's general tools (unified-message-events 05)", () => {
  it("has no channel-only tools left, and has the general ones", () => {
    const names = createLeadTools(deps).map((candidate: any) => candidate.name as string);
    for (const gone of [
      "dispatch_channel_task", "answer_channel_request", "push_channel_card", "mark_channel_request_told", "settle_channel_request",
      "update_channel_card_draft", "get_channel_card",
    ]) expect(names).not.toContain(gone);
    for (const general of [
      "dispatch_agent_task", "notify_user", "record_disposition", "reply_to_source", "react_channel_message", "read_channel_conversation",
    ]) expect(names).toContain(general);
  });

  it("closes a message event's request through record_disposition, instead of recording nothing", async () => {
    const event = externalMessage();
    const text = await textOf("record_disposition", { event_ids: [event], disposition: "no_action", reason: "对方只是说一声，不用回" });
    expect(text).not.toContain("已记下 0 件事");
    expect(calls).toEqual([["dispose", [event, { disposition: "no_action", reason: "对方只是说一声，不用回" }]]]);
  });

  it("requires Lead's own draft when it tells the user about a message event", async () => {
    const event = externalMessage();
    await expect(textOf("record_disposition", { event_ids: [event], disposition: "told_user", reason: "告诉用户了" })).rejects.toThrow(/草稿/u);
    await expect(textOf("notify_user", { event, title: "Ivy 让你发消息" })).rejects.toThrow(/草稿/u);
    expect(calls).toEqual([]);

    await textOf("notify_user", { event, title: "Ivy 让你发消息", draft: "好的，我这就发。" });
    expect(calls).toEqual([["notify", [event, { note: "Ivy 让你发消息", draft: "好的，我这就发。" }]]]);
  });

  it("replies to the user's own entry by just saying it in the turn: nothing goes anywhere else", async () => {
    const own = db.transaction(() => appendEvent(db, {
      source: "user", kind: "user.message", entityKey: "chat:main", correlationId: "chat:main",
      payload: { text: "今天下午有什么安排？", turnId: "turn-1", originKind: "paired:companion", message: {
        version: 1, entry: "user", source: "companion", sourceLabel: "Companion", conversation: { key: "chat:main", label: "会话" },
        sender: { id: "user", name: "我", trust: "self" }, text: "今天下午有什么安排？", external: false, inbound: null, ceiling: null,
        context: null, replyTo: null, messages: [], edits: 0,
      } },
    }).event.seq)();
    const text = await textOf("reply_to_source", { event: own, text: "下午三点有个会。" });
    expect(text).toContain("这一轮的回答");
    expect(calls).toEqual([]);
  });

  // 工单 06：兜底删了以后，问涉密信息的由 Lead 用固定的话拒绝（用户 10-22）。工具只交固定的话，Lead 不能自己写拒绝的内容；
  // 别的内容由出站扩展（hub）拒绝，这里原样交过去。
  it("refuses with the fixed words through reply_to_source: the tool supplies the words, and passes anything else on to be refused", async () => {
    const sends: unknown[] = [];
    deps.uiActionServices = {
      channelMessages: {
        canSend: () => true,
        send: async (conversation, input) => {
          sends.push([conversation, input]);
          return { conversation, label: "Ivy 的私信", objectKey: conversation, text: input.text, card: null, outcome: "auto_sent" };
        },
        react: async () => { throw new Error("不该回表情"); },
        openCards: () => [],
      },
    };
    const event = externalMessage();
    await textOf("reply_to_source", { event, refusal: true, reason: "Ivy 在要 staging 的密码" });
    await textOf("reply_to_source", { event, refusal: true, text: "密码不能给你。" });
    expect(sends).toMatchObject([
      ["slack:D0IVY:main", { text: AUTHORITY_REFUSAL_TEXT, words: "assistant", event, refusal: true, forUser: false }],
      ["slack:D0IVY:main", { text: "密码不能给你。", refusal: true }],
    ]);
    // 不是固定拒绝时要写回复。
    await expect(textOf("reply_to_source", { event })).rejects.toThrow(/text/u);
    expect(CHANNEL_SKILL).toMatch(/refusal=true/u);
    for (const text of [LEAD_SYSTEM_PROMPT, CHANNEL_SKILL]) {
      expect(text).not.toMatch(/不要回，用 notify_user 告诉用户/u);
      expect(text).not.toMatch(/过了期限|系统按授权表兜底/u);
    }
  });

  it("tells Lead to dispatch work by default, to read the context first, and to always bring a draft", () => {
    for (const gone of [
      "dispatch_channel_task", "answer_channel_request", "push_channel_card", "mark_channel_request_told", "settle_channel_request",
      "update_channel_card_draft", "get_channel_card",
    ]) {
      expect(LEAD_SYSTEM_PROMPT).not.toContain(gone);
      expect(CHANNEL_SKILL).not.toContain(gone);
    }
    expect(CHANNEL_SKILL).toContain("reply_to_source");
    expect(CHANNEL_SKILL).toContain("dispatch_agent_task");
    expect(CHANNEL_SKILL).toMatch(/缺省派子 agent/u);
    expect(CHANNEL_SKILL).toMatch(/闲聊也/u);
    expect(CHANNEL_SKILL).toMatch(/权限上限/u);
    expect(LEAD_SYSTEM_PROMPT).toMatch(/权限上限/u);
    for (const text of [LEAD_SYSTEM_PROMPT, CHANNEL_SKILL]) expect(text).not.toMatch(/系统叫醒的一轮[^。]*不能代/u);
  });
});

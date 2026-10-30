// 授权表（落地计划 A5，engine 的 channels/authority.ts）：按请求 A 认出的意图，决定通道做什么。用户 2026-10-22 的原则：
// 收尾回表情或者代你说一句；会议只提醒你；涉密的用固定的话拒绝；代码 review、approve、咨询、进度要干活；别的问你。
// 底线：外部客户、外部共享的对话（问不到也算），什么都不代你发。
// 2026-10-27（spec D3）：先看要不要回，再看是不是要干活；对方在接着回答你最近 30 分钟里说的话时，告诉你，不派活。
import { describe, expect, it } from "vitest";
import { CHANNEL_AUTHORITY_DEFAULTS } from "@pi-lead-child/protocol";
import { decideChannelAuthority, type AuthorityInput } from "../src/index.js";

const base: AuthorityInput = {
  intent: "other", closing: null, reaction: null, needsReply: 0.9, sensitive: {},
  sender: { trust: "colleague", bot: false }, externalShared: false, audience: "direct",
  capabilities: { reply: true, react: true }, reactable: true,
};
const decide = (patch: Partial<AuthorityInput>) => decideChannelAuthority({ ...base, ...patch });

describe("closing", () => {
  // 2026-10-21 R17：「诶 我看到验收反馈已经有结论啦～ 谢谢明哥！」对方在道谢，在他的消息上回个表情。
  it("reacts when they thank you, or when they only remark, with the emoji request A picked", () => {
    expect(decide({ intent: "closing", closing: "they_thank_you", reaction: "pray" })).toMatchObject({ kind: "react", emoji: "pray" });
    // R08：「:laughing: 确实很便宜」附和：回表情，不发文字（用户 2026-10-22 确认）。
    expect(decide({ intent: "closing", closing: "remark", reaction: "laughing", audience: "channel" }))
      .toMatchObject({ kind: "react", emoji: "laughing" });
    // 请求 A 没给表情时按收尾的种类。
    expect(decide({ intent: "closing", closing: "they_thank_you" })).toMatchObject({ kind: "react", emoji: "pray" });
  });

  it("says a line for you in a DM or a group when you should thank them or they say goodbye, and only reacts in a channel", () => {
    expect(decide({ intent: "closing", closing: "you_thank_them" })).toMatchObject({ kind: "closing_reply", closing: "you_thank_them" });
    expect(decide({ intent: "closing", closing: "farewell", audience: "group" })).toMatchObject({ kind: "closing_reply", closing: "farewell" });
    expect(decide({ intent: "closing", closing: "you_thank_them", audience: "channel" })).toMatchObject({ kind: "react" });
    expect(decide({ intent: "closing", closing: "farewell", audience: null })).toMatchObject({ kind: "react" });
  });

  it("does nothing when the source cannot react, and never reacts in an external conversation", () => {
    expect(decide({ intent: "closing", closing: "remark", capabilities: { reply: true, react: false } })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "closing", closing: "remark", reactable: false })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "closing", closing: "they_thank_you", externalShared: true })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "closing", closing: "you_thank_them", externalShared: null })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "closing", closing: "farewell", sender: { trust: "customer", bot: false } })).toMatchObject({ kind: "skip" });
  });
});

describe("secrets", () => {
  it("refuses with the fixed words when the intent is secret or a sensitive query is likely", () => {
    expect(decide({ intent: "secret" })).toMatchObject({ kind: "refuse" });
    // 用户 2026-10-22：问薪资、职级的，即使看起来是咨询，也直接拒绝。
    const salary = decide({ intent: "knowledge", sensitive: { query_hr_compensation: 0.9, query_customer_pii: 0.02 } });
    expect(salary).toMatchObject({ kind: "refuse" });
    expect(salary.reason).toContain("query_hr_compensation 90%");
    // 公司的经营数据（例如 CDP 能查到的）不算敏感：概率低的不拒绝。
    expect(decide({ intent: "knowledge", sensitive: { query_hr_compensation: 0.1 } })).toMatchObject({ kind: "work", intent: "knowledge" });
  });

  it("asks you instead when the conversation is external, or the source cannot reply", () => {
    expect(decide({ intent: "secret", externalShared: true })).toMatchObject({ kind: "ask" });
    expect(decide({ intent: "secret", sender: { trust: "customer", bot: false } })).toMatchObject({ kind: "ask" });
    expect(decide({ intent: "secret", capabilities: { reply: false, react: true } })).toMatchObject({ kind: "ask" });
  });
});

describe("work, meetings and the rest", () => {
  it("sends review, approve, questions and progress to work, unless the floor is hit", () => {
    for (const intent of ["code_review", "approve", "knowledge", "progress"] as const) {
      expect(decide({ intent })).toMatchObject({ kind: "work", intent });
      expect(decide({ intent, externalShared: null })).toMatchObject({ kind: "ask" });
    }
    // 先看要不要回，再看是不是要干活（spec D3，2026-10-27）：要回的概率低于门槛的，意图是 review 也不派活。
    expect(decide({ intent: "code_review", needsReply: 0.1 })).toMatchObject({ kind: "skip" });
  });

  it("reminds you of meetings, never replies to them", () => {
    expect(decide({ intent: "meeting" })).toMatchObject({ kind: "remind" });
    expect(decide({ intent: "meeting", externalShared: true })).toMatchObject({ kind: "remind" });
  });

  it("skips what needs no reply, asks you about the rest, and only records bots", () => {
    expect(decide({ intent: "other", needsReply: 0.1 })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "other", needsReply: 0.4 })).toMatchObject({ kind: "ask" });
    expect(decide({ intent: "other", needsReply: 0.4, noReplyBelow: 0.5 })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: null, needsReply: null })).toMatchObject({ kind: "ask" });
    expect(decide({ intent: "secret", sender: { trust: "colleague", bot: true } })).toMatchObject({ kind: "skip" });
  });

  it("only records a message that needs no reply, even when it reads like a work request", () => {
    for (const intent of ["code_review", "approve", "knowledge", "progress"] as const) {
      const action = decide({ intent, needsReply: 0.2 });
      expect(action).toMatchObject({ kind: "skip" });
      expect(action.reason).toContain("不当成要干活");
    }
    // 门槛照 hub 的 noReplyBelow：调高以后，原来够得上的也只记录。
    expect(decide({ intent: "knowledge", needsReply: 0.4, noReplyBelow: 0.5 })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "knowledge", needsReply: 0.3 })).toMatchObject({ kind: "work" });
  });

  it("tells you, without work, when they are answering what you said in the last 30 minutes", () => {
    const told = decide({ intent: "knowledge", needsReply: 0.2, ownMessageAgoMs: 5 * 60_000 });
    expect(told).toMatchObject({ kind: "tell" });
    expect(told.reason).toContain("5 分钟前");
    expect(decide({ intent: "other", needsReply: 0.1, ownMessageAgoMs: 30 * 60_000 })).toMatchObject({ kind: "tell" });
    // 超过 30 分钟、没说过话（null）、或者时间不合格的，按不用回只记录。
    expect(decide({ intent: "knowledge", needsReply: 0.2, ownMessageAgoMs: 30 * 60_000 + 1 })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "knowledge", needsReply: 0.2, ownMessageAgoMs: null })).toMatchObject({ kind: "skip" });
    expect(decide({ intent: "knowledge", needsReply: 0.2, ownMessageAgoMs: -1 })).toMatchObject({ kind: "skip" });
    // 外部共享的对话也告诉你：告诉你不往外发任何东西。
    expect(decide({ intent: "knowledge", needsReply: 0.2, externalShared: true, ownMessageAgoMs: 60_000 })).toMatchObject({ kind: "tell" });
    // 要回的概率够的，例外不管：照常按意图走。
    expect(decide({ intent: "knowledge", needsReply: 0.9, ownMessageAgoMs: 60_000 })).toMatchObject({ kind: "work" });
    // 收尾、涉密、会议、机器人排在前面，例外不改它们。
    expect(decide({ intent: "closing", closing: "they_thank_you", needsReply: 0.1, ownMessageAgoMs: 60_000 })).toMatchObject({ kind: "react" });
    expect(decide({ intent: "meeting", needsReply: 0.1, ownMessageAgoMs: 60_000 })).toMatchObject({ kind: "remind" });
    expect(decide({ intent: "knowledge", needsReply: 0.1, ownMessageAgoMs: 60_000, sender: { trust: "colleague", bot: true } }))
      .toMatchObject({ kind: "skip" });
  });

  it("follows a narrower table: an intent the table does not open is asked", () => {
    const table = { ...CHANNEL_AUTHORITY_DEFAULTS, approve: { action: "ask" as const }, meeting: { action: "ask" as const } };
    expect(decideChannelAuthority({ ...base, intent: "approve" }, table)).toMatchObject({ kind: "ask" });
    expect(decideChannelAuthority({ ...base, intent: "meeting" }, table)).toMatchObject({ kind: "ask" });
  });
});

// 2026-10-26 的真实数据（工单 #126，spec D3）：请求 A 的意图和把握、要回的概率，都是当天线上库里收件判断的结果。
// 三个人都是同事，对话不和外部共享。
describe("reply first, then work: 2026-10-26", () => {
  it("李雷「那我更新一下修复情况」（progress 0.47，要回 16%）：不是要干活", () => {
    const action = decide({ intent: "progress", needsReply: 0.16 });
    expect(action.kind).not.toBe("work");
    expect(action).toMatchObject({ kind: "skip" });
    expect(action.reason).toContain("要回 16%");
  });

  it("Kent「不是对外的，是 内部服务」（knowledge 0.41，要回 24%，你 8 分钟前在这个对话里说过话）：交给 Lead 告诉你，不是要干活", () => {
    const action = decide({ intent: "knowledge", needsReply: 0.24, ownMessageAgoMs: 8 * 60_000 });
    expect(action.kind).not.toBe("work");
    expect(action).toMatchObject({ kind: "tell" });
    expect(action.reason).toBe("对方多半在接着回答你 8 分钟前在这个对话里说的话（要回 24%）：告诉你，不派活");
  });

  it("Ethan「明哥，这个 pr 记得再帮我看看」（code_review 1.0，要回 95%）：仍然是要干活", () => {
    expect(decide({ intent: "code_review", needsReply: 0.95 })).toMatchObject({ kind: "work", intent: "code_review" });
  });
});

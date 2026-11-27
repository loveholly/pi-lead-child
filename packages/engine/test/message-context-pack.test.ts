// 上下文包第 1 项的上限（unified-message-events spec D5，工单 04）：这个对话最近的消息最多 20 条或 4000 字，
// 更早的用对话摘要代替；thread 的根消息总在最前面，不删。这里测决策边界（纯函数）：哪些原样放，哪些交给摘要。
import { describe, expect, it } from "vitest";
import { MESSAGE_CONTEXT_LIMITS } from "@pi-lead-child/protocol";
import { fitConversation, packConversation } from "../src/index.js";

type Message = { at: string; role: "them" | "me" | "assistant"; sender: string; text: string; root?: boolean };

const message = (index: number, text = `第 ${index} 条`, extra: Partial<Message> = {}): Message => ({
  at: new Date(Date.UTC(2026, 9, 26, 1, index)).toISOString(), role: index % 2 ? "them" : "me", sender: index % 2 ? "Ethan" : "我", text, ...extra,
});
const range = (count: number, make: (index: number) => Message = (index) => message(index)) =>
  Array.from({ length: count }, (_, index) => make(index + 1));

describe("the limit on a conversation's recent messages", () => {
  it("is 20 messages or 4000 characters", () => {
    expect(MESSAGE_CONTEXT_LIMITS).toEqual({ messages: 20, chars: 4_000 });
  });

  it("replaces the earliest messages with the conversation summary when there are more than 20", async () => {
    const messages = range(25);
    const asked: Message[][] = [];
    const packed = await packConversation(messages, async (older) => {
      asked.push([...older]);
      return "Ethan 请用户 review orders#112";
    });
    // 最早的 5 条交给整理器，换成它写的摘要；最近的 20 条原样放，从旧到新。
    expect(asked).toEqual([messages.slice(0, 5)]);
    expect(packed).toEqual({ messages: messages.slice(5), omitted: 5, summary: "Ethan 请用户 review orders#112" });
  });

  it("replaces the earliest messages when the recent ones pass 4000 characters", () => {
    const messages = range(10, (index) => message(index, `${index}`.padEnd(500, "字")));
    const { kept, older } = fitConversation(messages);
    expect(kept).toEqual(messages.slice(2));
    expect(older).toEqual(messages.slice(0, 2));
    expect(kept.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(4_000);
  });

  it("keeps the thread root in front even when it is the oldest", () => {
    const roots = [message(0, "根消息：orders 的发布单", { root: true })];
    const rest = range(30);
    const { kept, older } = fitConversation([...roots, ...rest]);
    expect(kept[0]).toEqual(roots[0]);
    expect(kept).toHaveLength(20);
    expect(kept.slice(1)).toEqual(rest.slice(-19));
    expect(older).toEqual(rest.slice(0, 11));
  });

  it("asks for no summary when the conversation fits", async () => {
    const messages = range(20);
    let asked = 0;
    const packed = await packConversation(messages, async () => { asked += 1; return "不该用到"; });
    expect(asked).toBe(0);
    expect(packed).toEqual({ messages, omitted: 0, summary: null });
  });

  // 工单 #584：摘要没写成时（模型要 10 到 17 秒，拼包只等 5 秒），以前只放最近的 20 条，更早的全丢了。
  it("puts the latest of the earlier messages back as they are when the summary could not be written", async () => {
    const short = await packConversation(range(22), async () => null);
    expect(short).toEqual({ messages: range(22), omitted: 0, summary: null });
    const long = range(50);
    const packed = await packConversation(long, async () => null);
    // 再放一份上限（20 条或 4000 字），更早的 10 条才算没放进来。
    expect(packed).toEqual({ messages: long.slice(10), omitted: 10, summary: null });
  });

  it("uses a summary of the first earlier messages and puts the rest back as they are", async () => {
    const messages = range(25);
    const packed = await packConversation(messages, async () => ({ text: "前 3 条的摘要", covered: 3 }));
    expect(packed).toEqual({ messages: messages.slice(3), omitted: 3, summary: "前 3 条的摘要" });
  });

  it("keeps the thread root in front when earlier messages come back", async () => {
    const roots = [message(0, "根消息", { root: true })];
    const rest = range(30);
    const packed = await packConversation([...roots, ...rest], async () => null);
    expect(packed.messages[0]).toEqual(roots[0]);
    expect(packed.messages.slice(1)).toEqual(rest);
    expect(packed.omitted).toBe(0);
  });
});

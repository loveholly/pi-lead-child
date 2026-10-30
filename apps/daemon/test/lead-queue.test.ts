// Lead 忙时排着的外部消息（统一消息事件 spec D6、D12，工单 10）在决策边界上的单元测试（lead-input.ts）：
//   · 排着的外部消息按对话分组，按先后排；用户「排到下一个」的那一组排到最前面；
//   · Lead 下一轮只拿一组：同一个对话里排着的几条合成一次处理，取 Lead 开始处理时排着的全部，不额外等；
//     系统事件（工单的异常这类）照旧合成一组，按它最早的一条排；
//   · 消息事件有了处置（卡结束了，或者移出了队列）就不再交给 Lead，也不在排队里，游标照常越过它；
//   · 同一个对话合成一次处理时，每条消息事件都带着一份上下文包（工单 04），内容大半重复：只给最新的那一份。
// 走完整流程的测试在 lead-queue-daemon.test.ts。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addInbox, appendEvent, createItem, listEvents, openDb, type Db, type EventRecord } from "@pi-lead-child/store";
import { MESSAGE_EVENT_KIND, type MessageContext } from "@pi-lead-child/protocol";
import { externalMessageEvent } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadInput, leadQueueUnits } from "../src/lead-input.js";

const fresh = (): Db => openDb(join(tempDir("plc-lead-queue-unit-"), "plc.db"));

let cardIds = 0;

// 代码拼好的上下文包（工单 04 的 context-pack.ts 拼的那种）。marker 写进对话最近的消息里，用来认出是哪一份。
function contextPack(key: string, sender: string, marker: string): MessageContext {
  return {
    version: 1, external: true, source: "slack", sourceLabel: "Slack", sender: { id: `U-${sender}`, name: sender },
    conversation: {
      key, label: `${sender}的私信`, omitted: 0, summary: null,
      messages: [{ at: "2026-10-27T01:00:00.000Z", role: "them", sender, text: marker }],
    },
    related: [], objects: [], history: [], memory: [], missing: [], size: { items: 1, chars: marker.length },
  } as MessageContext;
}

// 共用入站层交给 Lead 的一条外部消息（hub 的 appendMessageEvent 写的那种）。
function message(
  db: Db, input: { key: string; label: string; sender: string; text: string; cardId?: number; context?: MessageContext },
): EventRecord {
  const cardId = input.cardId ?? ++cardIds;
  return db.transaction(() => appendEvent(db, {
    source: "system", kind: MESSAGE_EVENT_KIND, entityKey: input.key, correlationId: `channel:${input.key}`, level: "tell",
    payload: externalMessageEvent({
      source: "slack", sourceLabel: "Slack", conversation: { key: input.key, label: input.label },
      sender: { id: `U-${input.sender}`, name: input.sender, trust: "colleague" }, text: input.text,
      intake: null, urgent: null, authority: "ask", intent: "other", messageId: null, messages: [cardId * 100], cardId,
      summary: `通道卡 #${cardId}：${input.sender}找用户`, ...(input.context ? { context: input.context } : {}),
    }),
  }).event)();
}

const seqs = (events: readonly EventRecord[]) => events.map((event) => event.seq);

describe("the queue of external messages while Lead is busy (ticket 10)", () => {
  it("groups the queued messages by conversation, in the order they came, with the senders and the count", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    message(db, { key: "slack:@U1", label: "李雷的私信", sender: "李雷", text: "orders 上线了吗？" });
    message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "你这项目啥时候给我玩" });
    message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "那个机器人 不好用" });
    expect(input.queue()).toMatchObject([
      { key: "slack:@U1", conversation: "李雷的私信", source: "slack", sourceLabel: "Slack", senders: ["李雷"], count: 1, excerpt: "orders 上线了吗？", next: true },
      { key: "slack:@U2", conversation: "Kent 的私信", senders: ["Kent"], count: 2, excerpt: "那个机器人 不好用", next: false },
    ]);
    db.close();
  });

  it("hands Lead one conversation per round: all its queued messages at once, then the next conversation", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const lilei = message(db, { key: "slack:@U1", label: "李雷的私信", sender: "李雷", text: "orders 上线了吗？" });
    const kent1 = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "你这项目啥时候给我玩" });
    const kent2 = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "那个机器人 不好用" });

    input.beginRun("events");
    expect(seqs(input.takeMessages({ events: input.nextMessages() }).events)).toEqual([lilei.seq]);
    input.endRun("succeeded");
    expect(input.queue().map((entry) => entry.key)).toEqual(["slack:@U2"]);

    // Kent 又发了一条：Lead 开始处理 Kent 时排着的三条一起交，不额外等。
    const kent3 = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "hermes 也差点感觉" });
    input.beginRun("events");
    expect(seqs(input.takeMessages({ events: input.nextMessages() }).events)).toEqual([kent1.seq, kent2.seq, kent3.seq]);
    // 交出去的不再排着。
    expect(input.queue()).toEqual([]);
    input.endRun("succeeded");
    expect(input.nextMessages()).toEqual([]);
    db.close();
  });

  it("gives Lead only the newest context pack when it hands over several messages of one conversation", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const key = "slack:@U2";
    const first = message(db, { key, label: "Kent 的私信", sender: "Kent", text: "你这项目啥时候给我玩", context: contextPack(key, "Kent", "较早的上下文包") });
    const second = message(db, { key, label: "Kent 的私信", sender: "Kent", text: "那个机器人 不好用", context: contextPack(key, "Kent", "最新的上下文包") });
    input.beginRun("events");
    const taken = input.takeMessages({ events: input.nextMessages() });
    expect(seqs(taken.events)).toEqual([first.seq, second.seq]);
    // 两条原话都在，上下文包只有最新的一份；较早的那条写明它的上下文包在哪一条后面。
    expect(taken.text).toContain("你这项目啥时候给我玩");
    expect(taken.text).toContain("那个机器人 不好用");
    expect(taken.text.split("最新的上下文包").length - 1).toBe(1);
    expect(taken.text).not.toContain("较早的上下文包");
    expect(taken.text.match(/上下文包：/gu)).toHaveLength(1);
    expect(taken.text).toContain(`上下文包和同一个对话里的消息事件 #${second.seq} 是同一份`);
    db.close();
  });

  it("puts a conversation the user moved to the front next, and forgets that once it was handed over", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const first = message(db, { key: "slack:@U1", label: "李雷的私信", sender: "李雷", text: "a" });
    const second = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "b" });
    const third = message(db, { key: "slack:@U3", label: "Ivy 的私信", sender: "Ivy", text: "c" });
    expect(input.promote("slack:@U3")).toBe(true);
    expect(input.queue().map((entry) => [entry.key, entry.next])).toEqual([
      ["slack:@U3", true], ["slack:@U1", false], ["slack:@U2", false],
    ]);
    // 后排到最前面的在更前面。
    expect(input.promote("slack:@U2")).toBe(true);
    expect(input.queue().map((entry) => entry.key)).toEqual(["slack:@U2", "slack:@U3", "slack:@U1"]);
    expect(seqs(input.nextMessages())).toEqual([second.seq]);
    // 没有排着的对话不能排到下一个。
    expect(input.promote("slack:@U9")).toBe(false);

    input.beginRun("events");
    input.takeMessages({ events: input.nextMessages() });
    input.endRun("succeeded");
    expect(seqs(input.nextMessages())).toEqual([third.seq]);
    // 同一个对话以后又来的消息按先后排，不沿用以前的「排到下一个」。
    input.beginRun("events");
    input.takeMessages({ events: input.nextMessages() });
    input.endRun("succeeded");
    message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "d" });
    expect(seqs(input.nextMessages())).toEqual([first.seq]);
    db.close();
  });

  it("keeps the system events in one group of their own, ordered by their oldest one", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const external = message(db, { key: "slack:@U1", label: "李雷的私信", sender: "李雷", text: "a" });
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: "交接失败" });
    const blocker = listEvents(db, { kind: "inbox.blocker" })[0]!;
    // 系统事件不在排队的状态栏里（状态栏只放外部消息）。
    expect(input.queue().map((entry) => entry.key)).toEqual(["slack:@U1"]);
    expect(seqs(input.nextMessages())).toEqual([external.seq]);
    input.beginRun("events");
    input.takeMessages({ events: input.nextMessages() });
    input.endRun("succeeded");
    expect(seqs(input.nextMessages())).toEqual([blocker.seq]);
    // 用户排到下一个的外部消息排在系统事件前面。
    const later = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "b" });
    input.promote("slack:@U2");
    expect(seqs(input.nextMessages())).toEqual([later.seq]);
    db.close();
  });

  it("drops a message whose card ended before Lead took it, and moves the cursor past it", () => {
    const db = fresh();
    const input = createLeadInput({ db });
    const removed = message(db, { key: "slack:@U1", label: "李雷的私信", sender: "李雷", text: "a" });
    const kept = message(db, { key: "slack:@U2", label: "Kent 的私信", sender: "Kent", text: "b" });
    db.prepare("UPDATE events SET disposition = 'handled', disposition_detail = '{}' WHERE seq = ?").run(removed.seq);
    input.refresh();
    expect(input.queue().map((entry) => entry.key)).toEqual(["slack:@U2"]);
    expect(seqs(input.pendingMessages())).toEqual([kept.seq]);
    input.beginRun("events");
    input.takeMessages({ events: input.nextMessages() });
    input.endRun("succeeded");
    expect(input.cursor().seq).toBeGreaterThanOrEqual(kept.seq);
    db.close();
  });
});

describe("the order of the queue (leadQueueUnits, the decision boundary)", () => {
  const event = (seq: number, key: string | null): Pick<EventRecord, "seq" | "kind" | "entityKey" | "payload"> => (key
    ? { seq, kind: MESSAGE_EVENT_KIND, entityKey: key, payload: { conversation: { key, label: key } } }
    : { seq, kind: "inbox.blocker", entityKey: `ticket:${seq}`, payload: {} });

  it("orders the groups by their oldest event, the promoted ones first (the latest promotion first)", () => {
    const events = [event(1, "slack:@A"), event(2, null), event(3, "slack:@B"), event(4, "slack:@A"), event(5, null), event(6, "slack:@C")];
    expect(leadQueueUnits(events, new Map()).map((unit) => [unit.key, unit.events.map((one) => one.seq)])).toEqual([
      ["slack:@A", [1, 4]], [null, [2, 5]], ["slack:@B", [3]], ["slack:@C", [6]],
    ]);
    const promoted = new Map([["slack:@C", 10], ["slack:@B", 20]]);
    expect(leadQueueUnits(events, promoted).map((unit) => unit.key)).toEqual(["slack:@B", "slack:@C", "slack:@A", null]);
  });
});

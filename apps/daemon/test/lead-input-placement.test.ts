// Lead 的输入怎样放置（Lead 事件主干 spec D6、D7，工单 04；spec Testing Decisions 的场景 1、2 和工单第 7 项）。
// 走完整的落库路径：用户的消息经网关进来，系统事件写进库，daemon 叫醒假的 pi 会话（fake-pi-session.ts，
// 输入的放置和 pi 一样）。断言 Lead 实际收到的输入和顺序、每一轮的当前局面、每条消息的结局，以及用户看到的消息条数。
//   · 场景 1：Lead 忙时用户发 A；之后一条 tell 级事件到达；之后用户发 B（排队）。
//     答 A → 答 B（第 2 轮的当前局面里有那一行排队说明，没有事件内容）→ 单独一轮处理那条事件。
//   · 场景 2：B 改成插话：A 和 B 在同一轮里回答，A 的结局是 done（和后面的插话一起回答），不是失败；
//     那条事件在这一轮之后单独处理。B 赶不上插入时转为下一轮，界面标记变为「下一轮回答」。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  addInbox, createItem, createPairing, listEvents, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, situationIn, type FakeCall } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-input-");
  dbPath = join(dir, "plc.db");
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

async function start(lead: ReturnType<typeof fakePiLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  let sent = 0;
  // mode：插话（steer，缺省）或排队（followUp）。
  const send = async (message: string, mode?: "steer" | "followUp") => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...(mode ? { mode } : {}) }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  return { events, send, hello: events.find((event) => event.type === "hello.v2") };
}

// 一条 tell 级的系统事件：要叫醒 Lead 的 blocker（默认分诊定成 tell）。
function tellEvent(summary: string): number {
  const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} ${summary}`,
    payload: { blockerCode: "retry_exhausted", needsUser: false }, lossless: true,
  });
  return itemId;
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };
const leadMessages = () => (db.prepare(
  "SELECT id, origin_kind, assistant_text FROM channel_turns WHERE trim(assistant_text) <> '' ORDER BY created_at, rowid",
).all() as Array<{ id: string; origin_kind: string; assistant_text: string }>);
const userMessageOutcome = (turnId: string) => listEvents(db, { kind: "user.message" })
  .find((event) => event.payload.turnId === turnId)?.dispositionDetail;
const callWith = (calls: FakeCall[], text: string) => calls.findIndex((call) => call.inputs.some((input) => input.includes(text)));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("scenario 1: a queued message and a tell event that arrive while Lead answers", () => {
  it("answers A, then B with the event listed as queued in B's situation, then the event in its own turn", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { say: "A 的回答。" }; }
      if (input.includes("问题 B")) return { say: "B 的回答。" };
      if (input.includes("迁移脚本卡住了")) return { say: "我看了那条异常。" };
      return { say: "收到。" };
    });
    const { send } = await start(lead);

    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    tellEvent("迁移脚本卡住了");
    // daemon 发现了这条事件（轮询兜底）。Lead 正忙：它排队，不插进这一轮。
    await pause(150);
    const b = await send("问题 B", "followUp");
    expect(b.mode).toBe("queued");
    expect(turn(b.turnId).state).toBe("queued");
    holdA.resolve();

    await vi.waitFor(() => expect(lead.calls).toHaveLength(3));
    await vi.waitFor(() => expect(leadMessages().map((row) => row.assistant_text))
      .toEqual(["A 的回答。", "B 的回答。", "我看了那条异常。"]));
    // 放置顺序：A → B（排队消息在这次运行的回答之后送到）→ 事件单独一次运行。
    expect(callWith(lead.calls, "问题 A")).toBe(0);
    expect(callWith(lead.calls, "问题 B")).toBe(1);
    expect(callWith(lead.calls, "迁移脚本卡住了")).toBe(2);
    expect(lead.prompts).toHaveLength(2);
    expect(lead.prompts[1]).toContain("迁移脚本卡住了");
    // 事件只送了一次。
    expect(lead.calls.filter((call) => call.inputs.some((input) => input.includes("迁移脚本卡住了")))).toHaveLength(1);
    // 第 2 轮的当前局面里有那一行排队说明，只写类别和来源，没有事件内容。
    const second = lead.calls[1]!.situation ?? "";
    expect(second).toContain("排队中");
    expect(second).toMatch(/inbox\.blocker/);
    expect(second).not.toContain("迁移脚本卡住了");
    // 结局：两条消息都答了，事件记了处置。
    expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "A 的回答。" });
    expect(turn(b.turnId)).toMatchObject({ state: "completed", assistant_text: "B 的回答。" });
    expect(userMessageOutcome(a.turnId)).toMatchObject({ outcome: "done" });
    expect(userMessageOutcome(b.turnId)).toMatchObject({ outcome: "done" });
    await vi.waitFor(() => expect(listEvents(db, { kind: "inbox.blocker" })[0]).toMatchObject({ disposition: "seen" }));
    // 用户看到 3 条 Lead 的消息，事件那一条在 Lead 自己发起的一轮里。
    expect(leadMessages().map((row) => row.origin_kind)).toEqual(["paired:companion", "paired:companion", SYSTEM_TURN_ORIGINS.blocker]);
  });

  it("puts several queued messages into one round, answered once", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { say: "A 的回答。" }; }
      if (input.includes("补充 1") && input.includes("补充 2")) return { say: "两条补充一起答。" };
      return { say: "不该走到这里。" };
    });
    const { send } = await start(lead);
    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const one = await send("补充 1", "followUp");
    const two = await send("补充 2", "followUp");
    holdA.resolve();

    await vi.waitFor(() => expect(turn(two.turnId)).toMatchObject({ state: "completed", assistant_text: "两条补充一起答。" }));
    expect(lead.calls).toHaveLength(2);
    expect(lead.calls[1]!.inputs).toHaveLength(2);
    expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "A 的回答。" });
    // 前一条和后一条一起回答：结局是 done，不是失败。
    expect(turn(one.turnId)).toMatchObject({ state: "steered", error: null, assistant_text: "" });
    expect(userMessageOutcome(one.turnId)).toMatchObject({ outcome: "done", answeredWith: two.turnId });
  });
});

describe("scenario 2: B steers into the round that answers A", () => {
  it("answers A and B in one round, closes A as done together with B, then handles the event on its own", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await holdA.promise; return { tools: ["query_tickets"] }; }
      if (input.includes("问题 B")) return { say: "A 和 B 一起答。" };
      if (input.includes("迁移脚本卡住了")) return { say: "我看了那条异常。" };
      return { say: "收到。" };
    });
    const { events, send } = await start(lead);

    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    tellEvent("迁移脚本卡住了");
    await pause(150);
    const b = await send("问题 B");
    expect(b.mode).toBe("steered");
    holdA.resolve();

    await vi.waitFor(() => expect(leadMessages().map((row) => row.assistant_text)).toEqual(["A 和 B 一起答。", "我看了那条异常。"]));
    expect(callWith(lead.calls, "问题 B")).toBe(1);
    expect(callWith(lead.calls, "迁移脚本卡住了")).toBe(2);
    expect(turn(b.turnId)).toMatchObject({ state: "completed", assistant_text: "A 和 B 一起答。" });
    // 工单第 7 项：A 没有自己的文字，是和后面的插话一起回答的，不是「Lead 未生成回复」。
    expect(turn(a.turnId)).toMatchObject({ state: "steered", error: null });
    expect(userMessageOutcome(a.turnId)).toMatchObject({ outcome: "done", answeredWith: b.turnId, note: "和后面的插话一起回答" });
    expect(events.some((event) => event.type === "notice.created" && event.turnId === a.turnId)).toBe(false);
    const placement = events.filter((event) => event.type === "lead.turn.started" && event.turnId === a.turnId).at(-1);
    expect(placement.payload).toMatchObject({ mode: "steered", placement: "answered_together", answeredWith: b.turnId });
  });

  it("turns a steer that arrives during the final answer into the next round's input, and says so", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) return { say: ["A 的回", holdA.promise, "答。"] };
      if (input.includes("问题 B")) return { say: "B 的回答。" };
      return { say: "收到。" };
    });
    const { events, send } = await start(lead);

    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("问题 B");
    expect(b.mode).toBe("steered");
    holdA.resolve();

    await vi.waitFor(() => expect(turn(b.turnId)).toMatchObject({ state: "completed", assistant_text: "B 的回答。" }));
    // A 的回答整段留在 A 下面，B 的回答在 B 下面。
    expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "A 的回答。" });
    expect(lead.calls.map((call) => call.inputs.length)).toEqual([1, 1]);
    // 界面标记从「已插入」改为「下一轮回答」，在 B 的回答开始之前。
    const bEvents = events.filter((event) => event.turnId === b.turnId);
    const nextTurn = bEvents.findIndex((event) => event.type === "lead.turn.started" && event.payload.placement === "next_turn");
    const firstDelta = bEvents.findIndex((event) => event.type === "lead.message.delta");
    expect(nextTurn).toBeGreaterThanOrEqual(0);
    expect(nextTurn).toBeLessThan(firstDelta);
    expect(userMessageOutcome(b.turnId)).toMatchObject({ outcome: "done" });
  });
});

// spec D7（工单 04 设计修正）：当前局面放在每一轮输入的开头，用 system_event 信封，和用户的话分开；不放进系统提示
// （系统提示一变，整段对话的提示缓存就失效了，见 packages/lead/test/situation.test.ts）。没有变化的长内容不重复放。
describe("a steer whose delivery the session does not report", () => {
  // 自查发现：会话没有报告某条插话送到（例如原文被改写，认不出来），它就一直挂在 daemon 的队列里，
  // 永远没有结局，整理笔记也一直被它挡着。现在这一轮结束时，它不在 pi 的队列里，就算在这一轮里被看到了。
  it("still gets an outcome when the round ends", async () => {
    const holdA = deferred();
    const lead = fakePiLead(async (call) => {
      if (call.inputs.join("\n").includes("问题 A")) { await holdA.promise; return { tools: ["query_tickets"] }; }
      return { say: "都看了。" };
    }, { silentDelivery: (text) => text.includes("问题 B") });
    const { send } = await start(lead);
    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const b = await send("问题 B");
    holdA.resolve();
    await vi.waitFor(() => expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "都看了。" }));
    await vi.waitFor(() => expect(userMessageOutcome(b.turnId)).toMatchObject({ outcome: "done" }));
    expect(turn(b.turnId)).toMatchObject({ state: "steered", error: null });
  });
});

describe("the situation", () => {
  it("opens every round's input in its own envelope, apart from the user's words, and repeats nothing unchanged", async () => {
    const lead = fakePiLead(() => ({ say: "收到。" }));
    const { send } = await start(lead);
    const itemId = createItem(db, { title: "部署", brief: "b", createdBy: "user" });
    await send("第一句");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1));
    const first = lead.prompts[0]!;
    expect(first.indexOf('<system_event kind="situation"')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('<system_event kind="situation"')).toBeLessThan(first.indexOf("<user_message"));
    expect(lead.calls[0]!.situation).toContain(`#${itemId}「部署」`);
    const userBlock = /<user_message[^>]*>[\s\S]*?<\/user_message>/u.exec(first)![0];
    expect(userBlock).not.toContain("当前局面");

    await send("第二句");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(2));
    // 工单没有变化：第二份只写一行「没有变化」，不再列一遍。
    expect(lead.calls[1]!.situation).toContain("和上一次的当前局面一样");
    expect(lead.calls[1]!.situation).not.toContain(`#${itemId}「部署」`);
    expect(situationIn(lead.prompts[1]!)).toBe(lead.calls[1]!.situation);
  });
});

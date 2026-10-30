// spec Testing Decisions 的场景 8（工单 04）：daemon 在一轮中途重启，未完成的输入从原位置继续，不丢，不重复。
// 走完整的落库路径：第一个 daemon 正在处理一条系统事件，用户发来一条插话和一条排队消息；daemon 停机（排空到时中断）
// 或者崩溃（库里留着没有结局的轮次，游标停在事件之前）。第二个 daemon 起来以后，每条输入正好答一次，按顺序：
// 用户的消息在前，系统事件在后。游标只在这一轮成功以后前进。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  addInbox, createItem, createPairing, createTurn, listEvents, listInbox, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { LEAD_RESTART_INTERRUPTED_ERROR } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, type FakeCall } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-input-restart-");
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
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string, mode?: "steer" | "followUp") => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...(mode ? { mode } : {}) }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id).data.turnId as string;
  };
  return { send, bindingId: issued.binding.id };
}

async function stop(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
}

function tellEvent(summary: string): number {
  const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} ${summary}`,
    payload: { blockerCode: "retry_exhausted", needsUser: false }, lossless: true,
  });
  return itemId;
}

const answers = (call: FakeCall) => {
  const input = call.inputs.join("\n");
  if (input.includes("问题 A")) return { say: "A 的回答。" };
  if (input.includes("问题 B")) return { say: "B 的回答。" };
  if (input.includes("崩溃前的问题")) return { say: "崩溃前的问题，答了。" };
  if (input.includes("迁移脚本卡住了")) return { say: "我看了那条异常。" };
  return { say: "收到。" };
};
const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };
const callsWith = (calls: FakeCall[], text: string) => calls.filter((call) => call.inputs.some((input) => input.includes(text))).length;
const firstCallWith = (calls: FakeCall[], text: string) => calls.findIndex((call) => call.inputs.some((input) => input.includes(text)));
const cursorSeq = () => {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'lead.event_cursor'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as { seq: number }).seq : null;
};
const blockerSeq = () => listEvents(db, { kind: "inbox.blocker" }).at(-1)!.seq;

describe("scenario 8: a daemon restart in the middle of a round", () => {
  it("continues every unfinished input from where it was, once each: user messages first, then the event", async () => {
    vi.stubEnv("PLC_LEAD_DRAIN_MS", "100");
    const never = deferred();
    const first = fakePiLead(async (call) => {
      if (call.inputs.join("\n").includes("迁移脚本卡住了")) await never.promise;
      return answers(call);
    });
    const { send } = await start(first);
    tellEvent("迁移脚本卡住了");
    await vi.waitFor(() => expect(firstCallWith(first.calls, "迁移脚本卡住了")).toBe(0));
    const a = await send("问题 A");
    const b = await send("问题 B", "followUp");
    // 两条都排在 pi 的队列里，还没送到模型。
    expect(first.queued()).toMatchObject({ steering: [expect.stringContaining("问题 A")], followUp: [expect.stringContaining("问题 B")] });

    await stop();
    // 没有答上的输入都等重启后的 daemon，不算失败；事件还在游标后面，没有算处理过。
    expect(turn(a)).toMatchObject({ state: "queued", error: LEAD_RESTART_INTERRUPTED_ERROR });
    expect(turn(b)).toMatchObject({ state: "queued", error: LEAD_RESTART_INTERRUPTED_ERROR });
    expect(cursorSeq() ?? 0).toBeLessThan(blockerSeq());
    expect(listInbox(db).map((row) => row.state)).toEqual(["pending"]);

    const second = fakePiLead(answers);
    await start(second);
    await vi.waitFor(() => {
      expect(turn(a)).toMatchObject({ state: "completed", assistant_text: "A 的回答。" });
      expect(turn(b)).toMatchObject({ state: "completed", assistant_text: "B 的回答。" });
      expect(listInbox(db).map((row) => row.state)).toEqual(["consumed"]);
    });
    // 不丢，不重复：第二个 Lead 每条输入只收到一次。
    expect(callsWith(second.calls, "问题 A")).toBe(1);
    expect(callsWith(second.calls, "问题 B")).toBe(1);
    expect(callsWith(second.calls, "迁移脚本卡住了")).toBe(1);
    // 顺序：用户的消息在系统事件前面，按发来的先后。
    expect(firstCallWith(second.calls, "问题 A")).toBeLessThan(firstCallWith(second.calls, "问题 B"));
    expect(firstCallWith(second.calls, "问题 B")).toBeLessThan(firstCallWith(second.calls, "迁移脚本卡住了"));
    // 这一轮成功了，游标越过了这条事件。
    await vi.waitFor(() => expect(cursorSeq()).toBeGreaterThanOrEqual(blockerSeq()));
    expect(listEvents(db, { kind: "inbox.blocker" }).at(-1)).toMatchObject({ disposition: "seen" });
  });

  it("recovers the inputs a crashed daemon left without an outcome", async () => {
    // 第一个 daemon 正常起来又停下：游标落在库里。
    const first = fakePiLead(answers);
    const { bindingId } = await start(first);
    await stop();
    const cursorBefore = cursorSeq();
    expect(cursorBefore).not.toBeNull();

    // 崩溃留下的样子：一轮用户消息停在 streaming（没有错误），一条系统事件在游标后面。
    const crashed = createTurn(db, { originBindingId: bindingId, originKind: "paired:companion", userText: "崩溃前的问题", state: "streaming" });
    tellEvent("迁移脚本卡住了");
    expect(blockerSeq()).toBeGreaterThan(cursorBefore!);

    const second = fakePiLead(answers);
    await start(second);
    await vi.waitFor(() => {
      expect(turn(crashed.id)).toMatchObject({ state: "completed", assistant_text: "崩溃前的问题，答了。" });
      expect(listInbox(db).map((row) => row.state)).toEqual(["consumed"]);
    });
    expect(callsWith(second.calls, "崩溃前的问题")).toBe(1);
    expect(callsWith(second.calls, "迁移脚本卡住了")).toBe(1);
    expect(firstCallWith(second.calls, "崩溃前的问题")).toBeLessThan(firstCallWith(second.calls, "迁移脚本卡住了"));
  });

  it("does not move the cursor past an event when the round that carried it fails", async () => {
    let failing = true;
    const lead = fakePiLead((call) => (
      call.inputs.join("\n").includes("迁移脚本卡住了") && failing ? { error: "model rejected the request: prompt is too long" } : answers(call)
    ));
    vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "200");
    await start(lead);
    const before = cursorSeq();
    tellEvent("迁移脚本卡住了");
    await vi.waitFor(() => expect(callsWith(lead.calls, "迁移脚本卡住了")).toBe(1));
    await pause(50);
    expect(cursorSeq()).toBe(before);
    expect(listEvents(db, { kind: "inbox.blocker" }).at(-1)!.disposition).toBeNull();
    failing = false;
    // 按退避再叫醒 Lead，从原位置重读这条事件；这次成功了，游标才前进。
    await vi.waitFor(() => expect(callsWith(lead.calls, "迁移脚本卡住了")).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(cursorSeq()).toBeGreaterThanOrEqual(blockerSeq()));
  });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

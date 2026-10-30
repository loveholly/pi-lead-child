// 2026-10-19 线上（Lead 会话 019f7f53）：用户让 Lead 把 #100 建成 hold 草稿，下一轮在对话里说
// 「让 Claude code 针对 100 中我提出的问题先出个方案吧，但是先不要写代码」。spawn_child(#100) 被闸门拒绝，
// Lead 没有能落库的确认路径，于是另建 #101 去跑——同一件事两张工单。
// 这里走完整的持久化路径：配对客户端发消息 → daemon 开一个用户轮次 → Lead（替身会话，工具是真的）
// 在同一轮 ticket_action(confirm) + spawn_child → 原工单开跑，库里没有第二张工单。确认记成「Lead 代你确认」：
// actor=lead、onBehalfOf=user，指名这一轮（工单操作层，spec 5.11）。
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { ownerActionTurnId, SYSTEM_TURN_ORIGINS } from "@pi-lead-child/protocol";
import { createItem, createPairing, getItem, listActivities, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";

const ASK = "让 Claude code 针对 1 中我提出的问题先出个方案吧，但是先不要写代码";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-draft-start-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  // 派出去的 child 可能还在往目录里写文件，负载高时一次删不干净（ENOTEMPTY）。和其他 daemon 测试一样重试。
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// 替身 Lead 照线上那一轮的顺序调工具：先 spawn_child 撞上草稿，再按报错给的路走。
function leadThatStartsTheDraft(ticketId: number) {
  const listeners: Array<(event: any) => void> = [];
  const refusals: string[] = [];
  let tools: ReturnType<typeof createLeadTools> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const call = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool.execute(`call-${name}`, params as never, undefined, undefined, undefined as never);
  };
  const factory = async (deps: LeadDeps) => {
    tools = createLeadTools(deps);
    return {
      modelName: "stub/model",
      session: {
        sessionId: "stub-session",
        subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
        async prompt(text: string) {
          if (text.includes(ASK)) {
            try { await call("spawn_child", { ticket_id: ticketId, reason: "用户说先出个方案" }); } catch (error) { refusals.push((error as Error).message); }
            await call("ticket_action", { ticket_id: ticketId, action: "confirm", reason: "用户说先出个方案" });
            await call("spawn_child", { ticket_id: ticketId, reason: "用户说先出个方案" });
          }
          const reply = `已开始 #${ticketId}。`;
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] } });
        },
        async steer() {},
        async followUp() {},
        dispose() {},
      },
    };
  };
  return { factory, refusals };
}

describe("a held draft the user asks to start in conversation", () => {
  it("starts the original ticket in the same turn and creates no duplicate", async () => {
    const ticketId = createItem(db, { title: "入口分流方案", brief: "b", createdBy: "lead", hold: true });
    expect(getItem(db, ticketId)!.stage).toBe("draft");
    const lead = leadThatStartsTheDraft(ticketId);
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {},
      childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
    });
    // 这一轮的凭证要有确认开跑页面入口的 scope（tickets:create），Lead 才能凭它代用户确认（fd0f6b1a）。
    const token = redeemPairing(db, createPairing(db, {
      name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"],
    }).code).accessToken;
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${token}&protocol=2&after_seq=-1`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));

    socket.send(JSON.stringify({ type: "chat.send", id: "c1", protocolVersion: 2, message: ASK }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "lead.message.completed")).toBe(true), { timeout: 10_000 });

    // 第一次 spawn_child 被拒时，报错已经指向 ticket_action 的 confirm 和「确认开跑」。
    expect(lead.refusals).toHaveLength(1);
    expect(lead.refusals[0]).toMatch(/ticket_action\(ticket_id=\d+, action="confirm"\)[\s\S]*确认开跑[\s\S]*不要为同一件事另建工单/);

    await vi.waitFor(() => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(ticketId)).toEqual({ n: 1 });
    }, { timeout: 10_000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
    expect(getItem(db, ticketId)!.stage).not.toBe("draft");

    // 确认是用户的决定，由 Lead 代做：账本写 actor=lead，指名发起它的那个已配对用户轮次，不写成 actor=user。
    const turn = db.prepare("SELECT id, origin_kind FROM channel_turns WHERE user_text=?").get(ASK) as { id: string; origin_kind: string };
    expect(turn.origin_kind).toMatch(/^paired:/);
    const confirmation = listActivities(db, ticketId).find((activity) =>
      activity.kind === "transition" && JSON.parse(activity.payload).to === "ready");
    expect(confirmation!.actor).toBe("lead");
    expect(JSON.parse(confirmation!.payload)).toMatchObject({ from: "draft", onBehalfOf: "user", sourceTurnId: turn.id });
    // 代做的确认能「不是我」：主人操作记在那一轮来自的配对凭证名下。
    const owner = db.prepare("SELECT event_id, payload FROM events WHERE kind='owner_action.performed'").get() as { event_id: string; payload: string };
    expect(JSON.parse(owner.payload)).toMatchObject({
      action: "ticket.confirm", source: { client: "lead" }, delivery: "push", detail: { sourceTurnId: turn.id },
    });
    // 审查 M5：daemon 推的提醒是「代做」那一种；会话卡的轮次编号里凭证写 0，发出那一轮的设备上也显示整张卡和「撤销」。
    await vi.waitFor(() => {
      expect(db.prepare("SELECT kind FROM notifications WHERE kind LIKE 'owner_action%'").all()).toEqual([{ kind: "owner_action_on_behalf" }]);
      expect(db.prepare("SELECT id FROM channel_turns WHERE origin_kind=?").all(SYSTEM_TURN_ORIGINS.ownerAction))
        .toEqual([{ id: ownerActionTurnId(owner.event_id, 0) }]);
    }, { timeout: 10_000 });
  });
});

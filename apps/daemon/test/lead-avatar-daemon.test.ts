// Lead 的形象（设置 → 身份与风格 → 形象，2026-10-28）走完整的路径：App 的 chat.send 经网关进 daemon。
//   - `/fairyeye on`、`/fairyeye off`：daemon 自己答，不交给 Lead、不调模型；Lead 忙着时也马上答。这是打开矢量 FairyEye 的唯一入口。
//   - 不是整条命令的消息（`/fairyeye on please`、普通消息）照常交给 Lead；工单对话里发不改开关。
//   - 网关的 /v1/lead/avatar 读得到开关；没有接 Slack 时，emoji 预览说查不了。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LeadAvatarResponseSchema, SlackEmojiPreviewSchema } from "@pi-lead-child/protocol";
import { createPairing, getStoredLeadAvatar, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import type { RuntimeId } from "@pi-lead-child/core";
import { createCoordinator } from "@pi-lead-child/engine";
import { RuntimeRegistry, type AgentRuntime, type RuntimeEvent, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { Value } from "typebox/value";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-avatar-");
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

// 工单的 agent 的替身：对话 Run 马上回答收到的消息。不起任何真的执行器进程。
class AnsweringRuntime implements AgentRuntime {
  readonly id: RuntimeId = "codex";
  readonly capabilities = {
    streaming: true, steering: false, resume: true, interrupt: true, approvals: true, mcp: true, executableReadOnlyReview: true,
  };
  readonly prompts: string[] = [];

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.prompts.push(request.prompt);
    const events = async function* (): AsyncGenerator<RuntimeEvent> {
      const now = () => new Date().toISOString();
      yield { type: "run.started", runId: request.runId, seq: 1, occurredAt: now(), runtime: "codex", model: null };
      yield { type: "message.completed", runId: request.runId, seq: 2, occurredAt: now(), messageId: "m1", text: "工单的 agent 收到了。" } as RuntimeEvent;
      yield { type: "run.completed", runId: request.runId, seq: 3, occurredAt: now(), exitCode: 0 };
    };
    return {
      pid: null,
      events: events(),
      interrupt: async () => {},
      wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
    };
  }
}

async function start(factory: unknown, extra: Record<string, unknown> = {}) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: factory as never, log: () => {}, notifyDesktop: () => {},
    // 测试从不起真的执行器（工单对话会开对话 Run）。
    runtimeRegistry: new RuntimeRegistry([new AnsweringRuntime()]),
    ...extra,
  });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"],
  }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true), { timeout: 5_000 });
  let sent = 0;
  const send = async (message: string, extra: Record<string, unknown> = {}) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...extra }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true), { timeout: 5_000 });
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  return { events, send, get };
}

const turn = (id: string) => db.prepare("SELECT state, user_text, assistant_text, origin_kind FROM channel_turns WHERE id = ?").get(id) as
  { state: string; user_text: string; assistant_text: string; origin_kind: string };

describe("the /fairyeye command", () => {
  it("turns FairyEye on and off without asking Lead, and answers in the conversation", async () => {
    const lead = fakePiLead(() => ({ say: "不该被问到。" }));
    const { send, get, events } = await start(lead.factory);

    const on = await send("/fairyeye on");
    expect(on.mode).toBe("started");
    await vi.waitFor(() => expect(turn(on.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(on.turnId)).toMatchObject({ user_text: "/fairyeye on", assistant_text: "已打开 FairyEye：界面上的 Paimon 改用 Fairy 的眼睛。发 /fairyeye off 换回形象素材。" });
    expect(getStoredLeadAvatar(db)).toMatchObject({ fairyEye: true, updatedBy: "user" });
    const avatar = await get("/v1/lead/avatar");
    expect(Value.Check(LeadAvatarResponseSchema, avatar)).toBe(true);
    expect(avatar.leadAvatar.fairyEye).toBe(true);
    // 会话里有这一轮（开始、回答、完成），客户端也被叫去重读形象。
    await vi.waitFor(() => expect(events.some((event) => event.type === "lead.message.completed" && event.turnId === on.turnId)).toBe(true));
    expect(events.some((event) => event.type === "lead.turn.started" && event.turnId === on.turnId)).toBe(true);
    await vi.waitFor(() => expect(events.some((event) => event.type === "snapshot.required" && event.payload?.resource === "lead-avatar")).toBe(true));

    // 大小写和多余的空白不算。已经打开时照答一句。
    const again = await send("  /FairyEye   ON ");
    await vi.waitFor(() => expect(turn(again.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(again.turnId).assistant_text).toContain("FairyEye 已经是打开的");

    const off = await send("/fairyeye off");
    await vi.waitFor(() => expect(turn(off.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(off.turnId).assistant_text).toBe("已关掉 FairyEye：界面上的 Paimon 换回形象素材（设置 → 身份与风格 → 形象）。");
    expect(getStoredLeadAvatar(db).fairyEye).toBe(false);

    // Lead 一次也没被问到。命令不是对 Lead 说的话：没有 user.message 事件（Lead 在等用户回话时不会被它叫醒）。
    expect(lead.prompts).toEqual([]);
    expect(lead.calls).toEqual([]);
    const messages = db.prepare("SELECT payload FROM events WHERE kind = 'user.message'").all() as Array<{ payload: string }>;
    expect(messages.filter((row) => row.payload.includes('fairyeye'))).toEqual([]);
  });

  it("hands everything that is not exactly the command to Lead", async () => {
    const lead = fakePiLead(() => ({ say: "收到。" }));
    const { send } = await start(lead.factory);

    const please = await send("/fairyeye on please");
    await vi.waitFor(() => expect(turn(please.turnId)).toMatchObject({ state: "completed", assistant_text: "收到。" }), { timeout: 5_000 });
    const plain = await send("帮我看看 FairyEye 是什么");
    await vi.waitFor(() => expect(turn(plain.turnId)).toMatchObject({ state: "completed", assistant_text: "收到。" }), { timeout: 5_000 });
    expect(lead.prompts.some((prompt) => prompt.includes("/fairyeye on please"))).toBe(true);
    expect(lead.prompts.some((prompt) => prompt.includes("帮我看看 FairyEye 是什么"))).toBe(true);
    expect(getStoredLeadAvatar(db).fairyEye).toBe(false);
  });

  it("does not change the switch from a ticket conversation", async () => {
    const lead = fakePiLead(() => ({ say: "收到。" }));
    const runtime = new AnsweringRuntime();
    const { send } = await start(lead.factory, { runtimeRegistry: new RuntimeRegistry([runtime]) });
    const itemId = createCoordinator({ db }).createRootItem({ title: "发布", brief: "b", createdBy: "lead", project: "p", runtime: "codex" });

    const sent = await send("/fairyeye on", { context: { ticketId: itemId } });
    // 工单对话一律交给工单的 agent，不是 daemon 的命令。
    await vi.waitFor(() => expect(turn(sent.turnId)).toMatchObject({ state: "completed", assistant_text: "工单的 agent 收到了。" }), { timeout: 5_000 });
    expect(turn(sent.turnId).origin_kind).toContain("ticket");
    expect(runtime.prompts.join("\n")).toContain("/fairyeye on");
    expect(getStoredLeadAvatar(db).fairyEye).toBe(false);
  });

  it("answers at once while Lead is busy, without steering or queueing it into Lead's turn", async () => {
    const hold = deferred();
    const lead = fakePiLead(async (call) => {
      if (call.inputs.join("\n").includes("问题 A")) {
        await hold.promise;
        return { say: "A 答完了。" };
      }
      return { say: "收到。" };
    });
    const { send } = await start(lead.factory);

    const a = await send("问题 A");
    await vi.waitFor(() => expect(lead.calls).toHaveLength(1), { timeout: 5_000 });
    const on = await send("/fairyeye on", { mode: "followUp" });
    expect(on.mode).toBe("started");
    await vi.waitFor(() => expect(turn(on.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect(turn(on.turnId).assistant_text).toContain("已打开 FairyEye");
    expect(getStoredLeadAvatar(db).fairyEye).toBe(true);
    // Lead 那一轮还在等：命令没有插进去，也没有排队。
    expect(turn(a.turnId).state).toBe("streaming");
    expect(lead.queued().steering).toEqual([]);
    expect(lead.queued().followUp).toEqual([]);

    hold.resolve();
    await vi.waitFor(() => expect(turn(a.turnId)).toMatchObject({ state: "completed", assistant_text: "A 答完了。" }), { timeout: 5_000 });
    expect(lead.prompts.join("\n")).not.toContain("/fairyeye");
  });
});

describe("the avatar routes on the daemon", () => {
  it("say the Slack preview is unavailable when Slack is not connected", async () => {
    const lead = fakePiLead(() => ({ say: "收到。" }));
    const { get } = await start(lead.factory);
    const preview = await get("/v1/lead/avatar/slack-emoji/preview?code=robot_face");
    expect(Value.Check(SlackEmojiPreviewSchema, preview)).toBe(true);
    expect(preview).toMatchObject({
      code: ":robot_face:", status: "unavailable", reason: expect.stringContaining("Slack 没有接上"), byline: "Paimon (Assistant) · auto-reply for 用户",
    });
  });
});

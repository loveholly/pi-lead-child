// Lead 自己的模型连不上时，App 不能还亮着绿灯。实例上每次 Lead 调模型都是 503 auth_unavailable，
// 顶栏的点却一直是绿的：它只看 WebSocket 连没连上。
// daemon 记下 Lead 模型调用的健康：在线；降级（连不上，系统会自己重试，下一次是什么时候）。
// 这份状态在 GET /v1/overview 的 lead 字段里，变化时发 daemon.status.changed。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

// 连不上的模型服务（系统会自己再试）。实例上那次 503 auth_unavailable 包着上游的 403，算认证失败
// （packages/protocol 的 lead-failure 测试），这里用一个真正连不上的 503。
const UNAVAILABLE = '503: {"message":"upstream connect error or disconnect/reset before headers (providers=claude)"}';
const HEARTBEAT_MS = 10 * 60_000;

beforeEach(() => {
  dir = tempDir("plc-lead-health-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_HEARTBEAT_MS", String(HEARTBEAT_MS));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

type Step = "unavailable" | "text" | "retry-then-wait" | "leaks-secret";

// 不调用模型的 lead。每次 prompt 按 steps 的下一项回答；用完以后一直说一句话。
function stubLead(steps: Step[]) {
  const listeners: Array<(event: any) => void> = [];
  let release: (() => void) | null = null;
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const say = () => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好的。" } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "好的。" }] } });
  };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        const step = steps.shift() ?? "text";
        if (step === "leaks-secret") {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error",
            errorMessage: "503: upstream rejected Authorization=Bearer abc.def-ghi_jkl", content: [] } });
        } else if (step === "unavailable") {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: UNAVAILABLE, content: [] } });
        } else if (step === "retry-then-wait") {
          // SDK 自己的重试：它先报一次失败和等多久，再重试。
          emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 30_000, errorMessage: UNAVAILABLE });
          await new Promise<void>((resolve) => { release = resolve; });
          emit({ type: "auto_retry_end", success: true, attempt: 1 });
          say();
        } else {
          say();
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, release: () => release?.() };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "notices"] }).code);
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1&include=lead_health`,
  );
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, {
    headers: { authorization: `Bearer ${issued.accessToken}` },
  })).json()) as { lead?: Record<string, any> };
  const chat = (id: string, message: string) =>
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
  return { events, overview, chat };
}

function newBlocker(): number {
  const itemId = createItem(db, { title: "runtime exception", brief: "b", createdBy: "system" });
  addInbox(db, {
    itemId, severity: "blocker", source: "structural", summary: "Run #7 crashed",
    payload: { kind: "unhandled_run_exception", runId: 7 }, lossless: true,
  });
  return itemId;
}

function statusEvents(events: any[]): any[] {
  return events.filter((event) => event.type === "daemon.status.changed").map((event) => event.payload.lead);
}

describe("Lead model health", () => {
  it("goes degraded with a plain reason and the next automatic attempt, then back online", async () => {
    const { events, overview, chat } = await start(stubLead(["unavailable", "text"]));
    expect((await overview()).lead).toMatchObject({ state: "online", failures: 0, nextAttemptAt: null });

    // 一条 blocker 叫醒 Lead，模型返回 503。blocker 留在 inbox 里，下一次心跳巡检会再叫醒 Lead。
    const before = Date.now();
    newBlocker();
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("degraded"));
    const degraded = (await overview()).lead!;
    expect(degraded.reason).toBe("Paimon 的模型服务暂时连不上");
    expect(degraded.reason).not.toMatch(/503|\{/);
    expect(degraded.detail).toContain("upstream connect error");
    expect(degraded.failures).toBe(1);
    const next = Date.parse(degraded.nextAttemptAt);
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(Date.now() + HEARTBEAT_MS);
    await vi.waitFor(() => expect(statusEvents(events).at(-1)?.state).toBe("degraded"));

    // 下一次模型调用成功：回到在线。
    chat("cmd-1", "在吗");
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("online"));
    expect((await overview()).lead).toMatchObject({ failures: 0, nextAttemptAt: null, reason: null });
    await vi.waitFor(() => expect(statusEvents(events).at(-1)?.state).toBe("online"));
  });

  it("hides secrets in the raw error it hands to every client", async () => {
    // detail 经 GET /v1/overview 和 daemon.status.changed 发给所有带 tickets:view 的客户端。
    const { events, overview } = await start(stubLead(["leaks-secret"]));
    newBlocker();
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("degraded"));
    const detail = (await overview()).lead!.detail as string;
    expect(detail).toContain("503");
    expect(detail).not.toContain("abc.def-ghi_jkl");
    await vi.waitFor(() => expect(statusEvents(events).at(-1)?.state).toBe("degraded"));
    expect(JSON.stringify(statusEvents(events))).not.toContain("abc.def-ghi_jkl");
  });

  it("reports the SDK's own retry time while it waits to retry", async () => {
    const lead = stubLead(["retry-then-wait"]);
    const { overview, chat } = await start(lead);

    const before = Date.now();
    chat("cmd-1", "在吗");
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("degraded"));
    const next = Date.parse((await overview()).lead!.nextAttemptAt);
    expect(next).toBeGreaterThanOrEqual(before + 30_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 30_000);

    lead.release();
    await vi.waitFor(async () => expect((await overview()).lead?.state).toBe("online"));
  });
});

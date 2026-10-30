// 断网不是模型的问题（2026-10-15 19:11–20:07、2026-10-16 09:29）。Mac 合盖睡眠，只有几秒的 DarkWake：
// 心跳巡检这时叫醒 Lead，代理报 "500 … lookup api.anthropic.com: no such host"，会话里多了失败卡片。
// 现在：
//   · 叫醒 Lead 之前先看网络（DNS）。网络不通时不调模型：心跳巡检和唤醒等网络恢复，会话里什么都不留；
//   · 系统回合调模型时才发现断网，也不留失败卡片；
//   · 顶栏写「离线：网络不可用，恢复后继续」（daemon 给出断网的原文，客户端按同一套分类说）；
//   · 网络恢复后马上叫醒 Lead 处理积压的事，不等下一次心跳巡检。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLeadModelError } from "@pi-lead-child/protocol";
import { addInbox, addNotification, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { shortenDigestWait } from "./digest-wait.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const DNS_DOWN = "getaddrinfo ENOTFOUND api.anthropic.com";
const PROXY_DNS = '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}';

beforeEach(() => {
  dir = tempDir("plc-network-outage-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  // 积压的事按常设指令 events.digest_batch 叫醒 Lead（工单 05）：等待时间改短。
  shortenDigestWait(db, 1);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_HEARTBEAT_MS", "60");
  vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 可以开关的网络。
function network() {
  let down: string | null = null;
  return {
    probe: async () => down,
    down: (detail = DNS_DOWN) => { down = detail; },
    up: () => { down = null; },
  };
}

// 每一轮回答一句话。failures 里排着的错误按顺序用掉（DarkWake：模型调用失败）。
function lead(failures: string[] = [], onFailure: () => void = () => {}) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        const failure = failures.shift();
        if (failure) onFailure();
        for (const listener of listeners) {
          if (failure) {
            listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: failure, content: [] } });
          } else {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NO_REPLY" } });
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] } });
          }
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, prompts };
}

async function start(stub: ReturnType<typeof lead>, net: ReturnType<typeof network>) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {}, networkProbe: net.probe,
  });
  const token = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code).accessToken;
  return async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, {
    headers: { authorization: `Bearer ${token}` },
  })).json()) as { lead?: { state: string; detail: string | null } };
}

function backlog(summary = "工单完成了一个里程碑"): number {
  const itemId = createItem(db, { title: "周报", brief: "b", createdBy: "user" });
  addInbox(db, { itemId, severity: "attention", source: "structural", summary: `工单 #${itemId} ${summary}` });
  return itemId;
}

const turns = () => db.prepare("SELECT origin_kind, state FROM channel_turns ORDER BY created_at").all() as
  Array<{ origin_kind: string; state: string }>;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("while the network is down", () => {
  it("does not call the model for a digest round, posts nothing, and resumes once the network is back", async () => {
    const stub = lead();
    const net = network();
    net.down();
    const overview = await start(stub, net);
    backlog();

    await pause(400);
    expect(stub.prompts).toEqual([]);
    expect(turns()).toEqual([]);
    const health = (await overview()).lead!;
    expect(health.state).toBe("degraded");
    expect(classifyLeadModelError(health.detail ?? "")).toBe("network");

    net.up();
    await vi.waitFor(() => expect(stub.prompts.some((prompt) => prompt.includes('kind="digest"'))).toBe(true));
    await vi.waitFor(async () => expect((await overview()).lead!.state).toBe("online"));
    expect(turns().filter((turn) => turn.state === "failed")).toEqual([]);
  });

  it("does not wake Lead for a blocker, and hands it to Lead once the network is back", async () => {
    const stub = lead();
    const net = network();
    net.down();
    await start(stub, net);
    const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} 执行重试已耗尽` });

    await pause(300);
    expect(stub.prompts).toEqual([]);
    expect(turns().filter((turn) => turn.state === "failed")).toEqual([]);
    net.up();
    await vi.waitFor(() => expect(stub.prompts.some((prompt) => prompt.includes("执行重试已耗尽"))).toBe(true));
  });
});

describe("a DarkWake: the DNS answers from cache, but the model call fails", () => {
  it("leaves no failure card, shows the network as down, and retries once the network is back", async () => {
    const net = network();
    // DNS 从缓存里答了一次，探测是通的；真正调模型时网络已经断了。
    const stub = lead([PROXY_DNS], () => net.down());
    const overview = await start(stub, net);
    backlog();

    // 摘要叫醒 Lead，模型调用因为断网失败。
    await vi.waitFor(() => expect(stub.prompts).toHaveLength(1));
    await pause(200);
    expect(stub.prompts).toHaveLength(1);
    expect(turns()).toEqual([]);
    expect(classifyLeadModelError((await overview()).lead!.detail ?? "")).toBe("network");

    // 网络恢复（下一次 DNS 探测成功）：接着处理积压的事，这次成功了。
    net.up();
    await vi.waitFor(() => expect(stub.prompts.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () => expect((await overview()).lead!.state).toBe("online"));
    expect(turns().filter((turn) => turn.state === "failed")).toEqual([]);
  });
});

// 发布评审 f796c1c 的 B1：Lead 不能工作，从最后一次成功的模型调用算起，不看探测。
//   · 连接被拒（ECONNREFUSED）而 DNS 探测是通的：以前当断网，15 秒后探测通过就清掉失败、马上再叫醒 Lead，
//     每 15–30 秒一次，健康状态从来不会降级满 60 秒，兜底的汇总一次都没有发，Lead 的唤醒退避也被绕过；
//   · DNS 探测一直不通，而模型经本机代理是好的：用户的一轮成功了，可系统的唤醒一直被拦着，提醒永远发不出去。
describe("Lead's outage clock", () => {
  it("keeps running while connections are refused and the probe passes, so the safety net fires", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "300");
    vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "250");
    const refused = Array.from({ length: 50 }, () => "connect ECONNREFUSED 34.36.0.1:443");
    const stub = lead(refused);
    const overview = await start(stub, network());
    const itemId = createItem(db, { title: "迁移脚本", brief: "b", createdBy: "user" });
    addInbox(db, { itemId, severity: "blocker", source: "structural", summary: `工单 #${itemId} 执行重试已耗尽` });

    // 健康状态一直是降级，从第一次失败算起；兜底把积压的事汇总给用户。
    await vi.waitFor(() => expect(db.prepare(
      "SELECT COUNT(*) AS n FROM channel_turns WHERE origin_kind = 'system:fallback-notice'",
    ).get()).toEqual({ n: 1 }), { timeout: 3_000 });
    const health = (await overview()).lead!;
    expect(health.state).toBe("degraded");
    expect(classifyLeadModelError(health.detail ?? "")).toBe("unavailable");
    // 按 Lead 的唤醒退避再试，不是每次探测通过都再叫一次。
    expect(stub.prompts.length).toBeLessThanOrEqual(4);
  });

  it("trusts a working model over a failing probe", async () => {
    const net = network();
    net.down();
    const stub = lead();
    await start(stub, net);
    // 一次系统唤醒探测不通：知道断网了。
    backlog();
    await pause(300);
    expect(stub.prompts).toEqual([]);

    // 用户发了一条，经本机代理答上了：模型是好的。之后的通知照常请 Lead 播报。
    const token = redeemPairing(db, createPairing(db, { name: "web", kind: "companion", scopes: ["chat"] }).code).accessToken;
    const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${token}&protocol=2`);
    const received: any[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(received.some((entry) => entry.type === "hello.v2")).toBe(true));
    socket.send(JSON.stringify({ type: "presence.set", id: "p", protocolVersion: 2, attended: true }));
    socket.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "在吗" }));
    await vi.waitFor(() => expect(stub.prompts.some((prompt) => prompt.includes("在吗"))).toBe(true));
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "提醒：交周报", createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(stub.prompts.some((prompt) => prompt.includes("提醒：交周报"))).toBe(true), { timeout: 3_000 });
    socket.close();
  });
});

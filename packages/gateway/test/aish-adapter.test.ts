import { describe, it, expect, vi, afterEach } from "vitest";
import { AishAdapter } from "../src/aish-adapter.js";
import { startFakeAish, type FakeAish } from "../testing/fake-aish.js";

// waitFor 的预算与 vitest.config.ts 的 testTimeout 是两套账：waitFor 超时后重抛最后一次
// 断言错误（表现为 AssertionError: expected false to be true），全局 testTimeout 拦不住它。
// 这类等待背后是真实 socket 握手 / 子进程启动，3s 在全量并行抢 CPU 时不够，故统一 10s。
const FAST = {
  authMs: 1000, pingMs: 200, pongMs: 150,
  backoffBaseMs: 50, backoffMaxMs: 400, ackMs: 1000,
  flushChars: 10, flushMs: 30,
};

let server: FakeAish;
let adapter: AishAdapter;
afterEach(async () => { adapter?.stop(); await server?.close(); });

describe("AishAdapter", () => {
  it("completes auth handshake and identifies bot", async () => {
    server = await startFakeAish();
    adapter = new AishAdapter({ url: server.url, token: "bf_test", onEvent: () => {}, timeouts: FAST });
    adapter.start();
    await vi.waitFor(() => expect(adapter.connected).toBe(true), { timeout: 10_000 });
    expect(adapter.botName).toBe("plc-lead");
    expect(server.received[0]).toMatchObject({ type: "auth", token: "bf_test" });
  });

  it("AUTH_FAILED is fatal: onFatal fires, no reconnect", async () => {
    server = await startFakeAish({ rejectAuth: true });
    const fatal = vi.fn();
    adapter = new AishAdapter({ url: server.url, token: "bf_bad", onEvent: () => {}, onFatal: fatal, timeouts: FAST });
    adapter.start();
    await vi.waitFor(() => expect(fatal).toHaveBeenCalled(), { timeout: 10_000 });
    expect(fatal).toHaveBeenCalledWith("AUTH_FAILED: Invalid token", "AUTH_FAILED");
    await new Promise((r) => setTimeout(r, 300)); // 多个退避周期
    expect(server.connections).toBe(1);
  });

  it("delivers inbound events and reacts with eyes", async () => {
    server = await startFakeAish();
    const events: any[] = [];
    adapter = new AishAdapter({ url: server.url, token: "bf_test", onEvent: (e) => events.push(e), timeouts: FAST });
    adapter.start();
    await vi.waitFor(() => expect(adapter.connected).toBe(true), { timeout: 10_000 });
    server.dispatchEvent("现在有哪些任务？");
    await vi.waitFor(() => expect(events.length).toBe(1), { timeout: 10_000 });
    expect(events[0].text).toBe("现在有哪些任务？");
    await vi.waitFor(() => {
      expect(server.received.some((m) => m.type === "add_reaction" && m.emoji === "eyes")).toBe(true);
    }, { timeout: 10_000 });
  });

  it("streams a reply: start → buffered appends → stop with full text", async () => {
    server = await startFakeAish();
    adapter = new AishAdapter({ url: server.url, token: "bf_test", onEvent: () => {}, timeouts: FAST });
    adapter.start();
    await vi.waitFor(() => expect(adapter.connected).toBe(true), { timeout: 10_000 });

    const stream = adapter.openStream("C123", "1712.001");
    stream.append("你好，");
    stream.append("当前有 3 个任务在进行中。"); // 超过 flushChars=10 触发 flush
    await stream.end();

    const types = server.received.map((m) => m.type);
    expect(types).toContain("stream_start");
    expect(types).toContain("stream_append");
    expect(types).toContain("stream_stop");
    // 防重复：append 拼出的全文正好等于原文；stop 不再带 text（服务端会完整替换→重复）
    const appended = server.received.filter((m) => m.type === "stream_append").map((m) => m.text).join("");
    expect(appended).toBe("你好，当前有 3 个任务在进行中。");
    const stop = server.received.find((m) => m.type === "stream_stop");
    expect(stop.text).toBeUndefined();
    expect(stop.stream_ts).toBe("st_1");
  });

  it("replies pong to server ping; reconnects on pong timeout", async () => {
    server = await startFakeAish({ silent: true }); // 不回 pong
    adapter = new AishAdapter({ url: server.url, token: "bf_test", onEvent: () => {}, timeouts: FAST });
    adapter.start();
    await vi.waitFor(() => expect(adapter.connected).toBe(true), { timeout: 10_000 });
    server.sendRaw({ type: "ping" });
    await vi.waitFor(() => {
      expect(server.received.some((m) => m.type === "pong")).toBe(true);
    }, { timeout: 10_000 });
    // silent 服务器不回我们的 ping → pong 超时 → 断线重连
    await vi.waitFor(() => expect(server.connections).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  });
});

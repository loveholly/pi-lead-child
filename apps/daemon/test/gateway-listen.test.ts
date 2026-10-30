// 网关总是监听回环地址：plc 和本机的 companion 都靠它。
// - 没配置端口时用缺省端口 47130；被别的程序占用时退回随机端口，plc 从 plc.sock 拿到实际地址。
//   配置过的端口不退回：companion 记着那个地址。
// - 网关开到回环之外（PLC_GATEWAY_HOST 是局域网、Tailscale 或通配地址）要同时显式配置 PLC_GATEWAY_PORT。
//   这个地址另开一个监听，和回环共用一个端口。开机时地址可能还没就绪（launchd 登录后 Tailscale 才连上），
//   所以绑不上时在后台退避重试，直到成功；状态写进 plc.sock 的 status，plc daemon status 和 plc doctor 都看得到。
import { join } from "node:path";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_GATEWAY_PORT, ExposureListener, listenWithFallback, resolveGatewayListen } from "../src/gateway-listen.js";
import { startDaemon } from "../src/server.js";

describe("resolveGatewayListen", () => {
  it("listens on the default port on loopback when nothing is configured", () => {
    expect(resolveGatewayListen(undefined, {})).toEqual({
      port: DEFAULT_GATEWAY_PORT, portFallback: true, primaryHost: "127.0.0.1", exposeHost: null, warnings: [],
    });
    expect(DEFAULT_GATEWAY_PORT).toBe(47130);
  });

  it("uses a configured port, and does not fall back from it", () => {
    expect(resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "5100" }))
      .toEqual({ port: 5100, portFallback: false, primaryHost: "127.0.0.1", exposeHost: null, warnings: [] });
    expect(resolveGatewayListen(4100, { PLC_GATEWAY_PORT: "5100" }))
      .toEqual({ port: 4100, portFallback: false, primaryHost: "127.0.0.1", exposeHost: null, warnings: [] });
  });

  it("exposes a configured non-loopback host in addition to loopback, only with an explicit port", () => {
    expect(resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "5100", PLC_GATEWAY_HOST: "100.64.0.7" }))
      .toEqual({ port: 5100, portFallback: false, primaryHost: "127.0.0.1", exposeHost: "100.64.0.7", warnings: [] });
    expect(resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "5100", PLC_GATEWAY_HOST: "127.0.0.1" }).exposeHost).toBeNull();
    for (const host of ["0.0.0.0", "192.168.1.10"]) {
      const plan = resolveGatewayListen(undefined, { PLC_GATEWAY_HOST: host });
      expect(plan).toMatchObject({ port: DEFAULT_GATEWAY_PORT, portFallback: true, exposeHost: null });
      expect(plan.warnings.join("\n")).toContain("PLC_GATEWAY_PORT");
    }
  });

  // 通配地址本身就包含回环。Linux 上它不能和 127.0.0.1 共用一个端口，所以只开一个通配监听。
  it("uses one wildcard listener instead of a second listener next to loopback", () => {
    for (const host of ["0.0.0.0", "::"]) {
      expect(resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "5100", PLC_GATEWAY_HOST: host }))
        .toEqual({ port: 5100, portFallback: false, primaryHost: host, exposeHost: null, warnings: [] });
    }
  });

  it("refuses a port that is not a number instead of listening on a random one", () => {
    expect(() => resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "47130; rm -rf" })).toThrow("PLC_GATEWAY_PORT");
    expect(() => resolveGatewayListen(undefined, { PLC_GATEWAY_PORT: "70000" })).toThrow("PLC_GATEWAY_PORT");
  });
});

describe("listenWithFallback (loopback)", () => {
  const failure = (code: string) => Object.assign(new Error(`listen ${code}`), { code });

  it("falls back to a random port when the default port is in use", async () => {
    const tried: number[] = [];
    const lines: string[] = [];
    const result = await listenWithFallback(async (port) => {
      tried.push(port);
      if (port !== 0) throw failure("EADDRINUSE");
      return "listening";
    }, { port: 47130, portFallback: true, primaryHost: "127.0.0.1", exposeHost: null, warnings: ["careful"] }, (line) => lines.push(line));
    expect(result).toEqual({ value: "listening", host: "127.0.0.1" });
    expect(tried).toEqual([47130, 0]);
    expect(lines.join("\n")).toContain("47130");
    expect(lines).toContain("[gateway] WARNING: careful");
  });

  it("does not fall back from a configured port, or hide other errors", async () => {
    await expect(listenWithFallback(async () => { throw failure("EADDRINUSE"); },
      { port: 5100, portFallback: false, primaryHost: "127.0.0.1", exposeHost: null, warnings: [] }, () => {})).rejects.toThrow("EADDRINUSE");
    await expect(listenWithFallback(async () => { throw failure("EACCES"); },
      { port: 47130, portFallback: true, primaryHost: "127.0.0.1", exposeHost: null, warnings: [] }, () => {})).rejects.toThrow("EACCES");
  });

  it("falls back to loopback only, loudly, when the wildcard cannot be bound", async () => {
    const tried: Array<[number, string]> = [];
    const lines: string[] = [];
    const result = await listenWithFallback(async (port, host) => {
      tried.push([port, host]);
      if (host === "0.0.0.0") throw failure("EADDRINUSE");
      return "listening";
    }, { port: 5100, portFallback: false, primaryHost: "0.0.0.0", exposeHost: null, warnings: [] }, (line) => lines.push(line));
    expect(result).toEqual({ value: "listening", host: "127.0.0.1" });
    expect(tried).toEqual([[5100, "0.0.0.0"], [5100, "127.0.0.1"]]);
    expect(lines.join("\n")).toMatch(/WARNING.*0\.0\.0\.0:5100.*loopback only/);
  });
});

describe("ExposureListener", () => {
  it("retries the configured host with backoff until it can bind, then reports listening", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      let fail = 2;
      const lines: string[] = [];
      const exposure = new ExposureListener({
        host: "100.64.0.7", port: 5100,
        listen: async () => {
          attempts.push(Date.now());
          if (fail-- > 0) throw Object.assign(new Error("listen EADDRNOTAVAIL 100.64.0.7:5100"), { code: "EADDRNOTAVAIL" });
          return { close: async () => {} };
        },
        log: (line) => lines.push(line),
        baseDelayMs: 1_000, maxDelayMs: 60_000,
      });
      await exposure.start();
      expect(exposure.status()).toMatchObject({ host: "100.64.0.7", port: 5100, state: "retrying", attempts: 1 });
      expect(exposure.status()!.lastError).toContain("EADDRNOTAVAIL");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exposure.status()).toMatchObject({ state: "retrying", attempts: 2 });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(exposure.status()).toMatchObject({ state: "listening", attempts: 3, lastError: null, nextRetryAt: null });
      expect(lines.join("\n")).toMatch(/WARNING.*100\.64\.0\.7:5100/);
      expect(lines.join("\n")).toContain("now listening on 100.64.0.7:5100");
      await exposure.stop();
      expect(exposure.status()).toMatchObject({ state: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying when stopped", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const exposure = new ExposureListener({
        host: "100.64.0.7", port: 5100,
        listen: async () => { attempts += 1; throw Object.assign(new Error("EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" }); },
        log: () => {}, baseDelayMs: 1_000, maxDelayMs: 60_000,
      });
      await exposure.start();
      await exposure.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub", subscribe() { return () => {}; }, async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
  },
});

function localStatus(sockPath: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const socket = connect(sockPath);
    let buffer = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("\n")) { socket.end(); resolve(JSON.parse(buffer).data); }
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "status" })}\n`));
  });
}

describe("the daemon with a host that is not up yet", () => {
  it("serves on loopback at once and keeps retrying the configured host, visible in its status", async () => {
    const dir = tempDir("plc-gateway-expose-");
    vi.stubEnv("PLC_GATEWAY_HOST", "192.0.2.1"); // TEST-NET-1：不在任何本机网卡上
    vi.stubEnv("PLC_GATEWAY_PORT", "0");
    const daemon = await startDaemon({ dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, log: () => {} });
    try {
      expect((await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/health`)).status).toBe(200);
      const status = await localStatus(daemon.sockPath);
      expect(status.gatewayUrl).toBe(`http://127.0.0.1:${daemon.pairedPort}`);
      expect(status.gatewayExposure).toMatchObject({ host: "192.0.2.1", port: daemon.pairedPort, state: "retrying" });
      expect(status.gatewayExposure.lastError).toContain("EADDRNOTAVAIL");
    } finally {
      await daemon.close();
      vi.unstubAllEnvs();
    }
  });
});

// Linux 上 0.0.0.0 不能和 127.0.0.1 共用端口，所以通配地址只开一个监听，它也包含回环。
describe("the daemon with a wildcard host", () => {
  it("serves loopback through the one wildcard listener and reports it as listening", async () => {
    const dir = tempDir("plc-gateway-wildcard-");
    vi.stubEnv("PLC_GATEWAY_HOST", "0.0.0.0");
    vi.stubEnv("PLC_GATEWAY_PORT", "0");
    const lines: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, log: (line) => lines.push(line),
    });
    try {
      expect((await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/health`)).status).toBe(200);
      const status = await localStatus(daemon.sockPath);
      expect(status.gatewayUrl).toBe(`http://127.0.0.1:${daemon.pairedPort}`);
      expect(status.gatewayExposure).toMatchObject({ host: "0.0.0.0", port: daemon.pairedPort, state: "listening", lastError: null });
      expect(lines.join("\n")).not.toMatch(/retry/i);
    } finally {
      await daemon.close();
      vi.unstubAllEnvs();
    }
  });
});

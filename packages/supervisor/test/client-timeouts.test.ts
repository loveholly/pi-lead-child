// 等 ensure_running 的期限（P0-4 返工）：客户端不能比 supervisor 先放弃。supervisor 等 daemon 就绪最多 10 分钟，
// 以前 desktop-install 只等 150 秒，机器忙时把还在启动的服务报成失败。
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  daemonReadyTimeoutMs, DEFAULT_DAEMON_READY_TIMEOUT_MS, ensureRunningTimeoutMs, SUPERVISOR_REQUEST_TIMEOUT, supervisorRequest,
} from "../src/client.js";
import { DEFAULT_DAEMON_READY_TIMEOUT_MS as SERVER_DEFAULT } from "../src/server.js";

describe("readiness timeouts", () => {
  it("default to the supervisor's 10 minutes, and the client waits 30 seconds longer", () => {
    expect(SERVER_DEFAULT).toBe(DEFAULT_DAEMON_READY_TIMEOUT_MS);
    expect(daemonReadyTimeoutMs({})).toBe(10 * 60_000);
    expect(ensureRunningTimeoutMs({})).toBe(10 * 60_000 + 30_000);
  });

  it("follow PLC_DAEMON_READY_TIMEOUT_MS when it is a positive integer", () => {
    expect(daemonReadyTimeoutMs({ PLC_DAEMON_READY_TIMEOUT_MS: "900000" })).toBe(900_000);
    expect(ensureRunningTimeoutMs({ PLC_DAEMON_READY_TIMEOUT_MS: "900000" })).toBe(930_000);
    for (const value of ["0", "-5", "abc", "1.5", ""]) {
      expect(daemonReadyTimeoutMs({ PLC_DAEMON_READY_TIMEOUT_MS: value }), value).toBe(DEFAULT_DAEMON_READY_TIMEOUT_MS);
    }
  });
});

describe("supervisorRequest", () => {
  // 要在数据目录里监听一个 Unix socket。PLC 执行器的沙箱不允许（listen EPERM），那里跳过。
  it("marks a request that gets no answer in time with its own code", async (context) => {
    const dir = tempDir("plc-client-timeout-");
    // 服务端收下连接，从不回答。收尾时自己断开这些连接：server.close 要等所有连接都关掉才回调，客户端超时后断开，
    // 服务端这一侧没人读数据，不一定看到对方已经关了。ubuntu runner 上用例因此等满 15 秒超时（2026-11-09，PR #17 的 CI）。
    const peers = new Set<Socket>();
    const server = createServer((peer) => { peers.add(peer); });
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(join(dir, "supervisor.sock"), () => resolve(true));
    });
    if (!listening) context.skip();
    try {
      const error = await supervisorRequest({ type: "status" }, { dataDir: dir, timeoutMs: 100 }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe(SUPERVISOR_REQUEST_TIMEOUT);
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

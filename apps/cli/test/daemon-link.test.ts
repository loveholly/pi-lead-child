// daemon 没在运行时，plc 自动拉起它；拉起失败时报错并给出排查提示。plc 不再在 daemon 不在时直接写账本。
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CliError, daemonStatus, ensureDaemon } from "../src/daemon-link.js";
import { localRequest, plcSockPath } from "../src/local-socket.js";

let dir: string;
let server: Server | null = null;
beforeEach(() => { dir = tempDir("plc-link-"); });
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const status = {
  model: "stub/model", busy: false, pid: 1, clients: 0, sessionId: "s",
  runningChildren: [], runningItemIds: [], aish: null, gatewayUrl: "http://127.0.0.1:47130",
};

// 一个只会回答 status 的假 plc.sock。
function fakeDaemon(): Promise<void> {
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      const command = JSON.parse(line.trim()) as { type: string; id?: string };
      socket.write(`${JSON.stringify(command.type === "status"
        ? { type: "response", id: command.id, success: true, data: status }
        : { type: "response", id: command.id, success: false, error: `unknown command: ${command.type}` })}\n`);
    });
  });
  return new Promise((resolve) => server!.listen(plcSockPath(dir), resolve));
}

describe("ensureDaemon", () => {
  it("uses a running daemon without starting anything", async () => {
    await fakeDaemon();
    let starts = 0;
    const result = await ensureDaemon({ request: localRequest, start: async () => { starts += 1; return 0; }, notice: () => {}, dir });
    expect(result.gatewayUrl).toBe("http://127.0.0.1:47130");
    expect(starts).toBe(0);
  });

  it("starts the daemon when it is not running, then waits for plc.sock", async () => {
    const notices: string[] = [];
    const result = await ensureDaemon({
      request: localRequest,
      start: async () => { await fakeDaemon(); return 0; },
      notice: (line) => notices.push(line),
      dir,
    });
    expect(notices).toEqual(["daemon 未运行，正在启动..."]);
    expect(result.pid).toBe(1);
  });

  it("does not override an explicit stop or a maintenance run: the ops entry refuses with exit code 3", async () => {
    const failure = ensureDaemon({ request: localRequest, start: async () => 3, notice: () => {}, dir });
    await expect(failure).rejects.toBeInstanceOf(CliError);
    // 原因（"用 plc daemon stop 停下的"或"正在升级"）由 ops 入口打印；这里不再给一个可能错的提示。
    await expect(failure).rejects.toThrow("原因见上一行");
    await expect(failure).rejects.not.toThrow("plc daemon start");
    await expect(failure).rejects.not.toThrow("supervisor.log");
  });

  it("fails with a hint when the start fails", async () => {
    const failure = ensureDaemon({ request: localRequest, start: async () => 1, notice: () => {}, dir });
    await expect(failure).rejects.toBeInstanceOf(CliError);
    await expect(failure).rejects.toThrow("plc doctor");
  });

  it("fails with a hint when the daemon never answers after a start", async () => {
    const failure = ensureDaemon({
      request: localRequest, start: async () => 0, notice: () => {}, dir, waitMs: 200, sleep: async () => {},
    });
    await expect(failure).rejects.toThrow("supervisor.log");
  });
});

describe("daemonStatus", () => {
  it("is null when nothing listens on plc.sock", async () => {
    expect(await daemonStatus(localRequest, dir)).toBeNull();
  });
});

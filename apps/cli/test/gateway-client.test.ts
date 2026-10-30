// plc 每次连网关都先问 plc.sock 网关在哪：端口可能随 daemon 重启变化（缺省端口被占用时用随机端口）。
// 沿用旧地址，带着凭证的请求可能发给后来占了那个端口的别的进程。
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { gatewayClient } from "../src/gateway-client.js";
import { plcSockPath } from "../src/local-socket.js";

let dir: string;
let server: Server | null = null;
let gatewayUrl = "http://127.0.0.1:47130";
beforeEach(() => { dir = tempDir("plc-gw-client-"); });
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  vi.unstubAllGlobals();
});

function fakeDaemon(): Promise<void> {
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      const command = JSON.parse(line.trim()) as { type: string; id?: string };
      socket.write(`${JSON.stringify({
        type: "response", id: command.id, success: true,
        data: { model: "m", busy: false, pid: 1, clients: 0, sessionId: "s", runningChildren: [], runningItemIds: [], aish: null, gatewayUrl },
      })}\n`);
    });
  });
  return new Promise((resolve) => server!.listen(plcSockPath(dir), resolve));
}

const credential = {
  version: 1 as const, accessToken: "tok", issuedAt: "2026-10-13T04:00:00.000Z",
  binding: { id: 9, kind: "cli", name: "plc", scopes: ["tickets:view" as const] },
};

describe("gatewayClient", () => {
  it("asks plc.sock for the gateway address before every request", async () => {
    await fakeDaemon();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      requested.push(input);
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = gatewayClient(credential, { dataDir: dir });
    await client.listTickets();
    gatewayUrl = "http://127.0.0.1:51234";
    await client.listTickets();
    expect(requested).toEqual(["http://127.0.0.1:47130/v1/tickets", "http://127.0.0.1:51234/v1/tickets"]);
  });

  it("sends nothing when the daemon is not running", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => { requested.push(input); return new Response("{}"); });
    await expect(gatewayClient(credential, { dataDir: dir }).listTickets()).rejects.toThrow("daemon 未运行");
    expect(requested).toEqual([]);
  });
});

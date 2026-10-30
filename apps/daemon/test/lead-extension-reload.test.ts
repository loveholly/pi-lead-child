// SoL-Pi 在 daemon 运行中装好时，daemon 把它加载进正在运行的 Lead 会话（lead 的 reloadExtensions），不重启 daemon。
// Lead 空闲时马上加载；正在跑一轮时，等这一轮结束再加载；加载期间来的新一轮，等加载完再开始。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-reload-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// 一个 Lead：prompt 可以挂住（模拟正在跑的一轮），reloadExtensions 记录调用顺序。
function lead(opts: { holdPrompt?: Promise<void>; holdReload?: Promise<void>; reload?: boolean } = {}) {
  const listeners: Array<(event: any) => void> = [];
  const events: string[] = [];
  const factory = async () => ({
    modelName: "stub/model",
    ...(opts.reload === false ? {} : {
      reloadExtensions: async () => {
        events.push("reload:start");
        await opts.holdReload;
        events.push("reload:end");
      },
    }),
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        events.push(`prompt:${message.includes("第二轮") ? "second" : "first"}`);
        await opts.holdPrompt;
        for (const listener of listeners) {
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
        }
        events.push("prompt:end");
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, events };
}

async function send(message: string): Promise<void> {
  const issued = redeemPairing(db, createPairing(db, { name: `app-${sockets.length}`, kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const messages: any[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((m) => m.type === "hello.v2")).toBe(true));
  socket.send(JSON.stringify({ type: "chat.send", id: `cmd-${message}`, protocolVersion: 2, message }));
  await vi.waitFor(() => expect(messages.some((m) => m.type === "command.result")).toBe(true));
}

describe("reloading the Lead's extensions while the daemon runs", () => {
  it("reloads at once when the Lead is idle", async () => {
    const fake = lead();
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: fake.factory as never, log: () => {} });
    daemon.reloadLeadExtensions("SoL-Pi installed");
    await vi.waitFor(() => expect(fake.events).toEqual(["reload:start", "reload:end"]));
  });

  it("waits for the running turn to end, then reloads once", async () => {
    const turn = deferred();
    const fake = lead({ holdPrompt: turn.promise });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: fake.factory as never, log: () => {} });
    await send("第一轮");
    await vi.waitFor(() => expect(fake.events).toContain("prompt:first"));
    daemon.reloadLeadExtensions("SoL-Pi installed");
    daemon.reloadLeadExtensions("SoL-Pi installed again");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.events).not.toContain("reload:start");

    turn.resolve();
    await vi.waitFor(() => expect(fake.events).toEqual(["prompt:first", "prompt:end", "reload:start", "reload:end"]));
  });

  it("starts a turn that arrives during the reload only after the reload", async () => {
    const reload = deferred();
    const fake = lead({ holdReload: reload.promise });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: fake.factory as never, log: () => {} });
    daemon.reloadLeadExtensions("SoL-Pi installed");
    await vi.waitFor(() => expect(fake.events).toEqual(["reload:start"]));
    await send("第二轮");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.events).toEqual(["reload:start"]);

    reload.resolve();
    await vi.waitFor(() => expect(fake.events).toEqual(["reload:start", "reload:end", "prompt:second", "prompt:end"]));
  });

  it("logs and does nothing for a Lead session that cannot reload", async () => {
    const lines: string[] = [];
    const fake = lead({ reload: false });
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: fake.factory as never, log: (line) => lines.push(line) });
    daemon.reloadLeadExtensions("SoL-Pi installed");
    expect(lines.some((line) => /cannot reload its extensions/.test(line))).toBe(true);
    expect(fake.events).toEqual([]);
  });
});

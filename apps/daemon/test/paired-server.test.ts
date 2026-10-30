import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import WebSocket from "ws";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

// 复用 daemon.test.ts 的 stub session 形态
function stubSessionFactory() {
  const listeners: Array<(e: any) => void> = [];
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(cb: (e: any) => void) { listeners.push(cb); return () => {}; },
      async prompt(msg: string) {
        for (const l of listeners) {
          l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `echo:${msg}` } });
        }
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
  return factory;
}

let dir: string;
let db: Db;
let dbPath: string;
beforeEach(() => {
  dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

describe("paired plane", () => {
  it("redeem over HTTP, chat over authed WS, rejects bad token", async () => {
    const d = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubSessionFactory() as any, log: () => {}, gatewayPort: 0,
    });
    const base = `http://127.0.0.1:${d.pairedPort}`;

    // 1) 配对码 → redeem
    const { code } = createPairing(db, { name: "test-phone", kind: "companion" });
    const res = await fetch(`${base}/v1/paired/redeem`, {
      method: "POST", body: JSON.stringify({ pairing_code: code }),
    });
    expect(res.status).toBe(201);
    const { access_token, binding } = await res.json() as any;
    expect(binding.kind).toBe("companion");

    // 2) 坏 token 被拒
    const bad = new WebSocket(`ws://127.0.0.1:${d.pairedPort}/v1/paired/events?token=nope`);
    await new Promise<void>((r) => { bad.on("error", () => r()); bad.on("close", () => r()); });

    // 3) 正确 token：hello → chat → delta → turn_end
    const ws = new WebSocket(`ws://127.0.0.1:${d.pairedPort}/v1/paired/events`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    await vi.waitFor(() => {
      expect(got.some((m) => m.type === "hello" && m.binding?.name === "test-phone")).toBe(true);
    }, { timeout: 10_000 });
    ws.send(JSON.stringify({ type: "chat", message: "现在几点", id: "c1" }));
    await vi.waitFor(() => {
      expect(got.some((m) => m.type === "delta" && m.text.includes("现在几点"))).toBe(true);
      expect(got.some((m) => m.type === "turn_end")).toBe(true);
    }, { timeout: 10_000 });
    // 来源标注进入 lead 输入
    expect(got.find((m) => m.type === "delta").text).toContain("paired:companion:test-phone");

    ws.close();
    await d.close();
  }, 15000);
});

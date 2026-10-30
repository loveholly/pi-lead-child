// 超预算转派走完整的路径（lead-tools-and-routing spec D7）：真实的 daemon、真实的 Lead 会话，模型接到本机的
// OpenAI 兼容替身上。替身一直调工具；daemon 数到阈值时在这一轮里插一条 overflow 提醒，替身看到提醒就收尾。
// 断言：提醒只插一次，而且是在第 N 次工具调用以后；这一轮正常结束。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLeadSession } from "@pi-lead-child/lead";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let server: Server | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-overflow-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_SMART_MODEL", "");
  vi.stubEnv("PLC_LEAD_MODEL", "");
  vi.stubEnv("PLC_SOL_PI_ENTRY", "");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "3");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = null;
  db.close();
  vi.unstubAllEnvs();
});

interface ChatMessage { role: string; content: unknown }
interface ChatRequest { messages: ChatMessage[] }
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

async function modelStub(): Promise<{ baseUrl: string; requests: ChatRequest[] }> {
  const requests: ChatRequest[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...data })}\n\n`);
      const finish = (reason: string) => {
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.end("data: [DONE]\n\n");
      };
      const say = (text: string) => {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
        finish("stop");
      };
      const call = (name: string, args: object) => {
        chunk({ choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
        finish("tool_calls");
      };
      const first = textOf(body.messages[0]?.content) + textOf(body.messages[1]?.content);
      if (first.includes("You answer typed questions")) { say("{}"); return; }
      requests.push(body);
      const all = body.messages.map((message) => textOf(message.content)).join("\n");
      const asked = all.includes("一步一步查");
      if (!asked) { say("NO_REPLY"); return; }
      if (all.includes('kind="overflow"')) { say("剩下的我派给子 agent 了。"); return; }
      call("ls", { path: dir });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, requests };
}

async function start(baseUrl: string): Promise<{ send: (message: string) => Promise<string> }> {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { stub: { api: "openai-completions", baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
      models: ["stub/m"],
    },
  }));
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {},
    sessionFactory: async (args) => createLeadSession(args as Parameters<typeof createLeadSession>[0]),
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let commands = 0;
  const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id=?").get(id) as { state: string }).state;
  const send = async (message: string) => {
    const id = `cmd-${++commands}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true), { timeout: 10_000 });
    const turnId = events.find((event) => event.type === "command.result" && event.id === id).data.turnId as string;
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"), { timeout: 30_000 });
    return turnId;
  };
  return { send };
}

describe("Lead's in-place work that grows", () => {
  it("gets one overflow reminder after the threshold of tool calls, and the turn ends normally", async () => {
    const stub = await modelStub();
    const { send } = await start(stub.baseUrl);
    const turnId = await send("一步一步查这个目录");
    const reminded = stub.requests.filter((request) =>
      request.messages.some((message) => textOf(message.content).includes('kind="overflow"')));
    expect(reminded.length).toBeGreaterThan(0);
    // 提醒之前，模型调了 3 次 ls（阈值）；提醒只出现一次。
    const first = reminded[0]!;
    const toolCallsBefore = first.messages.filter((message) => message.role === "tool").length;
    expect(toolCallsBefore).toBeGreaterThanOrEqual(3);
    expect(first.messages.filter((message) => textOf(message.content).includes('kind="overflow"'))).toHaveLength(1);
    const text = (db.prepare("SELECT assistant_text FROM channel_turns WHERE id=?").get(turnId) as { assistant_text: string }).assistant_text;
    expect(text).toContain("剩下的我派给子 agent 了");
  }, 90_000);
});

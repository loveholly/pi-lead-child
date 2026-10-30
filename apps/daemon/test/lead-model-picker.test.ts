// 会话输入框的模型选择（2026-10-26，protocol 的 lead-models.ts）：走完整的路径。页面读模型目录（GET /v1/lead/models），
// 选一个模型和推理强度（POST /v1/lead/model，操作层的 lead_model / switch）。Lead 空闲时马上在会话里换，不重启；
// 正在回答时下一轮开始前换。选择写进 config.json 的 lead.models（排第一），所有页面收到 daemon.status.changed 的 model。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { LeadModelCatalogSchema } from "@pi-lead-child/protocol";
import { createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let vibeproxy: Server | null = null;
const sockets: WebSocket[] = [];

// 假的 vibeproxy：普通目录（id、owned_by）和详细目录（?client_version=pi：能不能看图、推理强度）。
async function startVibeproxy(): Promise<string> {
  vibeproxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname !== "/v1/models") { res.statusCode = 404; res.end("{}"); return; }
    if (url.searchParams.get("client_version") === "pi") {
      res.end(JSON.stringify({
        models: ["claude-sonnet-5", "as1/claude-sonnet-5", "as4/claude-sonnet-5"].map((slug) => ({
          slug, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        })).concat([{ slug: "gemini-3.8-flash-high", input_modalities: ["text", "image"], supported_reasoning_levels: [] } as never]),
      }));
      return;
    }
    res.end(JSON.stringify({
      data: [
        { id: "claude-sonnet-5", owned_by: "anthropic" },
        { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
        { id: "as1/claude-sonnet-5", owned_by: "anthropic" },
        { id: "as4/claude-sonnet-5", owned_by: "anthropic" },
      ],
    }));
  });
  await new Promise<void>((resolve) => vibeproxy!.listen(0, "127.0.0.1", resolve));
  const address = vibeproxy.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
}

beforeEach(async () => {
  dir = tempDir("plc-lead-model-picker-");
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { vibeproxy: { baseUrl: await startVibeproxy(), apiKey: { value: "vibeproxy" }, discover: true } },
      models: ["vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high"],
    },
  }));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  await new Promise<void>((resolve) => (vibeproxy ? vibeproxy.close(() => resolve()) : resolve()));
  vibeproxy = null;
  vi.unstubAllEnvs();
});

// 桩 Lead：能在运行中换模型（switchModel），回答前可以先等一个 Promise。
function stubLead() {
  const listeners: Array<(event: any) => void> = [];
  const switched: string[] = [];
  const prompts: string[] = [];
  let hold: Promise<void> | null = null;
  const factory = async () => ({
    modelName: "vibeproxy/claude-sonnet-5",
    models: ["vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high"],
    switchModel: async (spec: string) => { switched.push(spec); },
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(text: string) {
        prompts.push(text);
        if (hold) await hold;
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好。" } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "好。" }] } });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return { factory, switched, prompts, holdNext: (promise: Promise<void> | null) => { hold = promise; } };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
  };
  return { events, http, send };
}

const configuredModels = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models as string[];

describe("choosing Lead's model in the composer", () => {
  it("lists the models with their account prefix, upstream, image input and efforts", async () => {
    const { http } = await start(stubLead());
    const { status, body } = await http("GET", "/v1/lead/models");
    expect(status).toBe(200);
    expect(Value.Check(LeadModelCatalogSchema, body)).toBe(true);
    expect(body.current).toEqual({ model: "vibeproxy/claude-sonnet-5", effort: null });
    expect(body.models.find((model: any) => model.model === "vibeproxy/as4/claude-sonnet-5")).toMatchObject({
      prefix: "as4", source: "anthropic", image: true, efforts: ["low", "high"], blockedUntil: null,
    });
  });

  it("switches at once while Lead is idle, without a restart, and tells every page", async () => {
    const lead = stubLead();
    const { events, http, send } = await start(lead);
    const { status, body } = await http("POST", "/v1/lead/model", { model: "vibeproxy/as4/claude-sonnet-5", effort: "high" });
    expect(status).toBe(200);
    expect(body).toEqual({
      previous: { model: "vibeproxy/claude-sonnet-5", effort: null },
      selected: { model: "vibeproxy/as4/claude-sonnet-5", effort: "high" },
      applied: "now",
    });
    expect(lead.switched).toEqual(["vibeproxy/as4/claude-sonnet-5(high)"]);
    expect(configuredModels()).toEqual([
      "vibeproxy/as4/claude-sonnet-5(high)", "vibeproxy/claude-sonnet-5", "vibeproxy/gemini-3.8-flash-high",
    ]);
    await vi.waitFor(() => expect(events.some((event) => event.type === "daemon.status.changed"
      && event.payload.model === "vibeproxy/as4/claude-sonnet-5(high)")).toBe(true));
    expect((await http("GET", "/v1/lead/models")).body.current).toEqual({ model: "vibeproxy/as4/claude-sonnet-5", effort: "high" });
    // Lead 知道换了，不用再告诉用户。
    const switchedEvent = listEvents(db, { kind: "lead.model_switched" }).at(-1);
    expect(switchedEvent?.payload).toMatchObject({ to: "vibeproxy/as4/claude-sonnet-5(high)" });
    expect(switchedEvent?.payload.mustTell).toBeUndefined();
    // 下一轮就用它，不再换。
    await send("在吗");
    await vi.waitFor(() => expect(lead.prompts).toHaveLength(1));
    expect(lead.switched).toHaveLength(1);
  });

  it("waits for the turn Lead is answering, then switches before the next one", async () => {
    const lead = stubLead();
    const { http, send } = await start(lead);
    const answering = deferred();
    lead.holdNext(answering.promise);
    await send("先答这一句");
    await vi.waitFor(() => expect(lead.prompts).toHaveLength(1));
    const { body } = await http("POST", "/v1/lead/model", { model: "vibeproxy/gemini-3.8-flash-high", effort: null });
    expect(body.applied).toBe("after_turn");
    expect(lead.switched).toEqual([]);
    expect(configuredModels()[0]).toBe("vibeproxy/gemini-3.8-flash-high");
    lead.holdNext(null);
    answering.resolve();
    await send("下一句");
    await vi.waitFor(() => expect(lead.prompts).toHaveLength(2));
    expect(lead.switched).toEqual(["vibeproxy/gemini-3.8-flash-high"]);
  });

  it("refuses a model or an effort that is not in the catalog, and changes nothing", async () => {
    const lead = stubLead();
    const { http } = await start(lead);
    const effort = await http("POST", "/v1/lead/model", { model: "vibeproxy/as4/claude-sonnet-5", effort: "max" });
    expect(effort.status).toBe(400);
    expect(effort.body.error.message).toContain("可选：low、high");
    const model = await http("POST", "/v1/lead/model", { model: "vibeproxy/as9/claude-sonnet-5", effort: null });
    expect(model.status).toBe(400);
    expect((await http("POST", "/v1/lead/model", { model: "vibeproxy/claude-sonnet-5" })).status).toBe(400);
    expect(lead.switched).toEqual([]);
    expect(configuredModels()[0]).toBe("vibeproxy/claude-sonnet-5");
  });
});

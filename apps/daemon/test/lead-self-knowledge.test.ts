// spec Testing Decisions 场景 10（工单 13，spec D17）：用户问「jev 在你的会话里激活了多少次」。
// 2026-10-17 Lead 回答「查不到 jev 指什么」：系统提示里没有 Jev，也没有工具能读它的调用次数。
// 这里走完整的路径：真实的 daemon 和真实的 Lead 会话（createLeadSession），模型接到本机的 OpenAI 兼容替身上。
// 断言模型实际收到的请求：系统提示里有 Jev 的说明；替身模型调 get_system_usage，没有调用时工具结果是 0 次；
// SmartModel 调用一次以后，再问是 1 次。另外（2026-10-30）：系统提示里不写现在的值，config.json 的 lead.models 改了以后
// 系统提示不变，get_environment 查到新的；用户目录写成 ~。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLeadSession } from "@pi-lead-child/lead";
import { createItem, createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let server: Server | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-self-knowledge-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // 不让开发机上的设置影响 Lead 的模型和扩展。
  vi.stubEnv("PLC_SMART_MODEL", "");
  vi.stubEnv("PLC_LEAD_MODEL", "");
  vi.stubEnv("PLC_SOL_PI_ENTRY", "");
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

interface ChatMessage { role: string; content: unknown; tool_calls?: unknown[] }
interface ChatRequest { messages: ChatMessage[]; tools?: unknown[] }

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

// 模型实际收到的系统提示：全部 system 和 developer 消息。
const systemText = (request: ChatRequest) => request.messages
  .filter((message) => message.role === "system" || message.role === "developer")
  .map((message) => textOf(message.content)).join("\n\n");

const lastUserText = (request: ChatRequest) => textOf([...request.messages].reverse().find((message) => message.role === "user")?.content);

// OpenAI 兼容的 /chat/completions 替身，流式回答：
//   - SmartModel 的 LLM 兜底（提示词以 "You answer typed questions" 开头）：回答一个 JSON。
//   - 上一条是工具结果：用一句话收尾。
//   - 用户问到 jev：调用 get_system_usage(component=decision_model)。
//   - 用户问到环境：调用 get_environment。
//   - 其余（心跳、整理笔记）：NO_REPLY。
async function modelStub(): Promise<{ baseUrl: string; requests: ChatRequest[] }> {
  const requests: ChatRequest[] = [];
  server = createServer((req, res) => {
    // 先收齐字节再解码：按块拼字符串会把跨块的中文字符拆坏。
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
      if (body.messages.some((message) => textOf(message.content).startsWith("You answer typed questions"))) {
        say('{"ok": {"yes": true}}');
        return;
      }
      requests.push(body);
      const last = body.messages.at(-1)!;
      if (last.role === "tool") {
        say("Jev 是系统的决策模型，不在我的会话里运行。次数见事件日志。");
      } else if (/jev|环境/i.test(lastUserText(body))) {
        const [name, args] = /jev/i.test(lastUserText(body)) ? ["get_system_usage", { component: "decision_model" }] : ["get_environment", {}];
        chunk({
          choices: [{
            index: 0, finish_reason: null,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0, id: `call_${requests.length}`, type: "function",
                function: { name, arguments: JSON.stringify(args) },
              }],
            },
          }],
        });
        finish("tool_calls");
      } else {
        say(/<user_message/.test(lastUserText(body)) ? "收到。" : "NO_REPLY");
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, requests };
}

function writeConfig(baseUrl: string, models: string[]): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { stub: { api: "openai-completions", baseUrl, apiKey: { value: "test" }, discover: false, models: ["m", "m2"] } },
      models,
    },
  }));
}

type LeadSession = Awaited<ReturnType<typeof createLeadSession>>;

async function start(): Promise<{ lead: () => LeadSession; send: (message: string) => Promise<string> }> {
  let lead: LeadSession | null = null;
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {},
    // 真实的 Lead 会话，只把它的 SmartModel 留给测试调用。
    sessionFactory: async (args) => {
      lead = await createLeadSession(args as Parameters<typeof createLeadSession>[0]);
      return lead;
    },
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
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"), { timeout: 15_000 });
    return turnId;
  };
  return { lead: () => lead!, send };
}

// 最后一个满足条件的请求（这个仓库的 TypeScript lib 是 ES2022，没有从后往前找的数组方法）。
const lastRequest = (requests: ChatRequest[], match: (request: ChatRequest) => boolean) => [...requests].reverse().find(match);

// 替身模型收到的、某个用户问题之后的工具结果的文字。
function toolTextAfter(requests: ChatRequest[], question: string): string {
  const request = lastRequest(requests, (candidate) => candidate.messages.at(-1)?.role === "tool"
    && lastUserText(candidate).includes(question));
  expect(request, `no tool result after「${question}」`).toBeDefined();
  return textOf(request!.messages.at(-1)!.content);
}

// get_system_usage 的结果是 JSON。
const usageAfter = (requests: ChatRequest[], question: string): any => JSON.parse(toolTextAfter(requests, question));

describe("scenario 10: the user asks how many times Jev ran in Lead's session", () => {
  it("gives Lead Jev's explanation, and get_system_usage counts 0 before any call and 1 after one", async () => {
    const stub = await modelStub();
    writeConfig(stub.baseUrl, ["stub/m"]);
    const { lead, send } = await start();

    await send("jev 在你的会话里面激活了多少次");
    const asked = stub.requests.find((request) => request.messages.at(-1)?.role === "user" && /jev/.test(lastUserText(request)))!;
    const prompt = systemText(asked);
    expect(prompt).toContain("## 你运行的环境");
    expect(prompt).toContain("决策模型 Jev：TypeSafe 托管的类型化判断模型");
    expect(prompt).toContain("Jev 不在你的会话里运行");
    // 现在的值不在系统提示里（2026-10-30），用 get_environment 查。
    expect(prompt).not.toContain("兜底的 LLM 是 stub/m");
    expect(prompt).toContain("get_environment");
    expect(prompt).toMatch(/^- Jev：/m);
    expect(prompt).toContain("不认识的系统名词");

    const before = usageAfter(stub.requests, "jev 在你的会话里面激活了多少次");
    expect(before.components).toEqual([expect.objectContaining({
      component: "decision_model", calls: 0, failures: 0, note: "这段时间没有调用，次数是 0。",
    })]);
    expect(listEvents(db, { kind: "decision_model.called" })).toEqual([]);

    // suggest_route 这类功能调用一次 SmartModel（这里由测试直接调用会话的 SmartModel）。
    const smart = lead().smartModel!;
    await smart.decide("a state", { ok: { type: "yes_no", prompt: "Is it fine?" } }, { purpose: "route" });
    expect(listEvents(db, { kind: "decision_model.called" }).map((event) => [event.payload.purpose, event.payload.backend, event.payload.ok]))
      .toEqual([["route", "llm", true]]);

    await send("那现在 jev 调用了几次");
    const after = usageAfter(stub.requests, "那现在 jev 调用了几次");
    expect(after.components).toEqual([expect.objectContaining({
      component: "decision_model", calls: 1, failures: 0, by_backend: [{ name: "llm", calls: 1, failures: 0 }],
    })]);
  }, 60_000);

  // 回归（2026-10-30）：以前这一节写着 lead.models，改了 config.json 下一轮的系统提示就变（提示缓存失效一次）。
  it("keeps the system prompt unchanged when lead.models changes, and get_environment reports the new list", async () => {
    const stub = await modelStub();
    writeConfig(stub.baseUrl, ["stub/m"]);
    const { send } = await start();

    await send("你好");
    const first = systemText(lastRequest(stub.requests, (request) => lastUserText(request).includes("你好"))!);
    expect(first).not.toContain("lead.models：");

    writeConfig(stub.baseUrl, ["stub/m", "stub/m2"]);
    await send("你现在的环境怎样");
    const changed = systemText(lastRequest(stub.requests, (request) => lastUserText(request).includes("你现在的环境怎样"))!);
    expect(changed).toBe(first);
    const details = toolTextAfter(stub.requests, "你现在的环境怎样");
    expect(details).toContain("## 现在的配置和状态");
    expect(details).toContain("config.json 的 lead.models：stub/m、stub/m2（");
  }, 60_000);

  // 回归（2026-10-30，用户：「包括还 hardcode 了我的用户目录」）：pi 的工作目录一节写着 Lead 数据目录的完整路径。
  it("writes the home directory as ~ in everything the model receives with the system prompt", async () => {
    const home = dirname(dir);
    vi.stubEnv("HOME", home);
    const stub = await modelStub();
    writeConfig(stub.baseUrl, ["stub/m"]);
    const { send } = await start();

    await send("你好");
    const request = lastRequest(stub.requests, (candidate) => lastUserText(candidate).includes("你好"))!;
    const system = systemText(request);
    expect(system).toContain(`~/${basename(dir)}`);
    expect(system).not.toContain(`${home}/`);
    expect(JSON.stringify(request.tools ?? [])).not.toContain(`${home}/`);
  }, 60_000);

  // 工单 04 和 13 合在一起：当前局面放在每一轮输入的开头（situation 信封），环境放在系统提示里，两样互不覆盖。
  // 当前局面变了（多了一张工单），系统提示不变，提示缓存不失效。
  it("keeps the situation in each round's input and the environment in the system prompt", async () => {
    const stub = await modelStub();
    writeConfig(stub.baseUrl, ["stub/m"]);
    const { lead, send } = await start();

    await send("你好");
    const firstRequest = lastRequest(stub.requests, (request) => lastUserText(request).includes("你好"))!;
    const first = systemText(firstRequest);
    expect(first).toContain("## 你运行的环境");
    expect(lastUserText(firstRequest)).toContain('<system_event kind="situation"');

    const itemId = createItem(db, { title: "部署脚本", brief: "b", createdBy: "user" });
    // SmartModel 的调用记录（decision_model.called）是遥测：不进当前局面。
    await lead().smartModel!.decide("a state", { ok: { type: "yes_no", prompt: "Is it fine?" } }, { purpose: "route" });
    expect(listEvents(db, { kind: "decision_model.called" })).toHaveLength(1);
    await send("还在吗");
    const secondRequest = lastRequest(stub.requests, (request) => lastUserText(request).includes("还在吗"))!;
    expect(lastUserText(secondRequest)).toMatch(/<system_event kind="situation"[^>]*>[\s\S]*#\d+「部署脚本」[\s\S]*<\/system_event>/u);
    expect(lastUserText(secondRequest)).toContain(`#${itemId}「部署脚本」`);
    const second = systemText(secondRequest);
    expect(second).toBe(first);
    expect(second).not.toContain("部署脚本");
    expect(second).not.toContain('kind="situation" source=');
    expect(lastUserText(secondRequest)).not.toContain("decision_model");
  }, 60_000);
});

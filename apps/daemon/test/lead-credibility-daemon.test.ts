// Lead 的可信度检查走完整的路径（2026-10-19，.scratch/lead-credibility/spec.md D1、D2）：真实的 daemon、
// 真实的 Lead 会话（createLeadSession，带 plc-credibility 扩展），模型接到本机的 OpenAI 兼容替身上，
// 项目登记了一个真实的仓库目录。断言用户和账本最终看到的东西：
//   - 会话回复里引用了不存在的文件：同一轮里，Lead 收到系统的核对说明，接着写了更正；用户的这一轮里有更正。
//   - 批注里的引用核对失败：工单批注是内部的，不拦（2026-10-29），账本里记下没核对上的引用。
//   - record_decision 说「实地核验」，这一轮却什么都没读：照样记下（2026-10-29 起不再拒绝），记录里标明按转述记。
//     先 read 了文件再记：记录里附着那次 read。
// 2026-10-19 的原样：Lead 转述 #98 的报告时写出了 src/auth/session.ts 这类不存在的文件，record_decision 写「实地只读核验」。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLeadSession } from "@pi-lead-child/lead";
import {
  createItem, createPairing, createProject, linkProjectRepository, openDb, redeemPairing, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let repo: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let server: Server | null = null;
const sockets: WebSocket[] = [];
let ticket = 0;

beforeEach(() => {
  dir = tempDir("plc-lead-credibility-");
  repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "real.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  const project = createProject(db, { name: "demo", createdBy: "user" });
  linkProjectRepository(db, project, { repoRoot: repo, repoName: "repo" });
  ticket = createItem(db, { title: "评审", brief: "b", createdBy: "user", projectId: project, workdir: repo });
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
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
interface ChatRequest { messages: ChatMessage[] }

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
const lastUserText = (request: ChatRequest) => textOf([...request.messages].reverse().find((message) => message.role === "user")?.content);

// 替身模型。用户的话决定它做什么；工具结果和系统的核对说明决定它下一步怎样改。
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
        chunk({
          choices: [{
            index: 0, finish_reason: null,
            delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          }],
        });
        finish("tool_calls");
      };
      const first = textOf(body.messages[0]?.content) + textOf(body.messages[1]?.content);
      // SmartModel 的 LLM 兜底：理由里有「实地核验」时回答「是」（自己核验过），否则「否」。
      if (first.includes("You answer typed questions")) {
        const keys = JSON.parse(/exactly these keys: (\[[^\]]*\])/.exec(first)![1]!) as string[];
        say(JSON.stringify(Object.fromEntries(keys.map((key) => [key, { yes: first.includes("实地核验") }]))));
        return;
      }
      requests.push(body);
      const last = body.messages.at(-1)!;
      const user = lastUserText(body);
      if (last.role === "tool") {
        const result = textOf(last.content);
        if (result.includes("没有执行：文字里的代码引用核对失败")) {
          call("add_comment", { ticket_id: ticket, content: "问题在 `src/real.ts:2`。" });
        } else if (result.includes("没有记录：理由里说你自己核验")) {
          call("record_decision", { ticket_id: ticket, decision: "pass", reason: "转述 Run #1 的核查报告：测试通过。" });
        } else if (user.includes("读完再记")) {
          // 这一轮（最后一条用户消息之后）的工具结果：第一条是 read 的结果，之后记决定。
          const lastUser = body.messages.map((message) => message.role).lastIndexOf("user");
          const results = body.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
          if (results === 1) call("record_decision", { ticket_id: ticket, decision: "pass", reason: "我读了 src/real.ts，导出的三个常量都在。" });
          else say("记好了。");
        } else {
          say("好了。");
        }
      } else if (user.includes("（系统核对")) {
        say("更正：应为 `src/real.ts:2`。");
      } else if (user.includes("说一下报告")) {
        say("报告指出问题在 `src/auth/session.ts:12`。");
      } else if (user.includes("写批注")) {
        call("add_comment", { ticket_id: ticket, content: "问题在 `src/missing.ts:3`。" });
      } else if (user.includes("记决定")) {
        call("record_decision", { ticket_id: ticket, decision: "pass", reason: "实地核验：测试全部通过。" });
      } else if (user.includes("读完再记")) {
        call("read", { path: join(repo, "src", "real.ts") });
      } else {
        say(/<user_message/.test(user) ? "收到。" : "NO_REPLY");
      }
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
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"), { timeout: 15_000 });
    return turnId;
  };
  return { send };
}

const assistantText = (turnId: string) =>
  (db.prepare("SELECT assistant_text FROM channel_turns WHERE id=?").get(turnId) as { assistant_text: string }).assistant_text;
const leadActivities = (kind: string) => (db.prepare(
  "SELECT payload FROM activities WHERE item_id=? AND actor='lead' AND kind=? ORDER BY id",
).all(ticket, kind) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));

describe("Lead's credibility checks through the daemon", () => {
  it("asks Lead to correct a reply that cites a file the repository does not have, in the same turn", async () => {
    const stub = await modelStub();
    const { send } = await start(stub.baseUrl);
    const turnId = await send(`说一下报告 #${ticket}`);
    const correction = stub.requests.find((request) => lastUserText(request).includes("（系统核对"));
    expect(correction, "Lead never got the system's check").toBeDefined();
    expect(lastUserText(correction!)).toContain("`src/auth/session.ts:12`：文件不存在");
    expect(assistantText(turnId)).toContain("报告指出问题在 `src/auth/session.ts:12`。");
    expect(assistantText(turnId)).toContain("更正：应为 `src/real.ts:2`。");
    // 只更正一次。
    expect(stub.requests.filter((request) => lastUserText(request).includes("（系统核对"))).toHaveLength(1);
  }, 60_000);

  it("lets a ticket comment through when its code reference fails, and records the reference it could not check", async () => {
    const stub = await modelStub();
    const { send } = await start(stub.baseUrl);
    await send("写批注");
    expect(leadActivities("comment")).toEqual([{ content: "问题在 `src/missing.ts:3`。" }]);
    expect(leadActivities("decision")).toEqual([
      { decision: "code_refs_sent_unverified", tool: "add_comment", refs: ["src/missing.ts:3"] },
    ]);
    expect(stub.requests.some((request) => textOf(request.messages.at(-1)?.content).includes("没有执行"))).toBe(false);
  }, 60_000);

  it("records a decision that claims an own check when Lead read nothing as hearsay, and attaches what it did read", async () => {
    const stub = await modelStub();
    const { send } = await start(stub.baseUrl);
    await send("记决定");
    expect(leadActivities("decision")).toEqual([expect.objectContaining({
      decision: "pass", reason: "实地核验：测试全部通过。", evidence: [],
      evidenceSummary: "这一轮没有读过文件或工具结果；理由里说核验过，那是之前的轮次或别人做的，这一条按转述记",
      evidenceCheck: expect.objectContaining({ by: "smart_model", backend: "llm", unsupported: true }),
    })]);

    await send("读完再记");
    const decisions = leadActivities("decision");
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      reason: "我读了 src/real.ts，导出的三个常量都在。",
      evidence: [{ tool: "read", target: join(repo, "src", "real.ts") }],
    });
    expect(decisions[1].evidenceCheck).toBeUndefined();
  }, 60_000);
});

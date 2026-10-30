import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getMemorySync, listEvents, listMemorySync, openDb, saveNote, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { HindsightBackend, MemoryNotFoundError, memoryBackendSetting, NotesMemory, type NoteWriteStatus } from "../src/index.js";
import { FakeHindsight } from "../testing/index.js";

// Lead 的记忆（src/memory，.scratch/hindsight-primary-memory/spec.md）：选了 Hindsight 时它是主后端，SQLite 的 notes 是镜像。

interface Captured { method: string; url: string; auth: string | undefined; body: any }

async function stubHindsight(
  respond: (req: Captured) => { status: number; body?: unknown },
): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const captured = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      requests.push(captured);
      const { status, body } = respond(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const ITEM = {
  sourceKey: "note-7", content: "偏好\n回复用中文", kind: "preference" as const, occurredAt: "2026-10-16T08:00:00Z", context: "ctx", origin: "user" as const,
};

describe("HindsightBackend (official client, Hindsight 1.0.0 API)", () => {
  it("retains one note per async operation, with our operation id, as a replaceable document scoped by its origin", async () => {
    const stub = await stubHindsight(() => ({ status: 200, body: { success: true, bank_id: "plc-lead", items_count: 1, async: true, operation_id: "op-1" } }));
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url, apiKey: "k".repeat(64) });
    await backend.remember(ITEM, { operationId: "op-1" });
    expect(stub.requests).toEqual([{
      method: "POST", url: "/v1/default/banks/plc-lead/memories", auth: `Bearer ${"k".repeat(64)}`,
      body: {
        async: true,
        operation_id: "op-1",
        items: [{
          content: "偏好\n回复用中文", timestamp: "2026-10-16T08:00:00Z", context: "ctx", document_id: "note-7",
          metadata: { kind: "preference" }, tags: ["kind:preference", "origin:user"], update_mode: "replace", observation_scopes: [["origin:user"]],
        }],
      },
    }]);
  });

  it("recalls facts and observations, finds an observation's notes through its source facts, and treats a missing bank as empty", async () => {
    const stub = await stubHindsight((req) => req.body?.query === "missing bank"
      ? { status: 404, body: { detail: "bank not found" } }
      : { status: 200, body: {
        results: [
          { id: "o1", type: "observation", text: "用户现在要简洁的回答（以前要详细的）", source_fact_ids: ["f1", "f2"] },
          { id: "f3", type: "world", text: "用户在杭州", document_id: "note-3", occurred_start: "2026-10-01T00:00:00Z", scores: { final: 0.9 } },
          { id: "o2", type: "observation", text: "张三说周五上线", tags: ["origin:external"], source_fact_ids: [] },
          { id: "x", text: 42 },
        ],
        source_facts: { f1: { id: "f1", text: "a", document_id: "note-1" }, f2: { id: "f2", text: "b", document_id: "note-2" } },
      } });
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url });
    expect(await backend.recall("回答风格", { limit: 5 })).toEqual([
      { id: "o1", type: "observation", text: "用户现在要简洁的回答（以前要详细的）", sourceKeys: ["note-1", "note-2"], occurredAt: null, external: false, score: null },
      { id: "f3", type: "world", text: "用户在杭州", sourceKeys: ["note-3"], occurredAt: "2026-10-01T00:00:00Z", external: false, score: 0.9 },
      { id: "o2", type: "observation", text: "张三说周五上线", sourceKeys: [], occurredAt: null, external: true, score: null },
    ]);
    expect(stub.requests[0]!.url).toBe("/v1/default/banks/plc-lead/memories/recall");
    expect(stub.requests[0]!.body).toMatchObject({
      query: "回答风格", types: ["world", "experience", "observation"], prefer_observations: true,
      include: { entities: null, source_facts: { max_tokens: 2048 } },
    });
    expect(stub.requests[0]!.auth).toBeUndefined();
    expect(await backend.recall("missing bank", { limit: 5 })).toEqual([]);
  });

  it("filters by kind on facts only (observations live in the shared scope), and skips observations when they are off", async () => {
    const stub = await stubHindsight(() => ({ status: 200, body: { results: [] } }));
    closers.push(stub.close);
    await new HindsightBackend({ baseUrl: stub.url }).recall("q", { limit: 5, kind: "preference" });
    await new HindsightBackend({ baseUrl: stub.url, observations: false }).recall("q", { limit: 5 });
    expect(stub.requests[0]!.body).toMatchObject({ types: ["world", "experience"], tags: ["kind:preference"], tags_match: "any_strict" });
    expect(stub.requests[0]!.body.prefer_observations).toBeUndefined();
    expect(stub.requests[1]!.body.types).toEqual(["world", "experience"]);
  });

  it("reads operation status (pending, completed, failed, cancelled, gone) and retries a failed one", async () => {
    const statuses: Record<string, { status: number; body?: unknown }> = {
      a: { status: 200, body: { operation_id: "a", status: "processing" } },
      b: { status: 200, body: { operation_id: "b", status: "completed" } },
      c: { status: 200, body: { operation_id: "c", status: "failed", error_message: "Error code: 401" } },
      d: { status: 200, body: { operation_id: "d", status: "cancelled" } },
      e: { status: 404, body: { detail: "not found" } },
    };
    const stub = await stubHindsight((req) => req.method === "POST"
      ? { status: 200, body: { success: true, message: "queued", operation_id: "c" } }
      : statuses[req.url.split("/").pop()!]!);
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url });
    const states = await Promise.all(["a", "b", "c", "d", "e"].map((id) => backend.operation(id)));
    expect(states).toEqual([
      { state: "pending", error: null }, { state: "completed", error: null }, { state: "failed", error: "Error code: 401" },
      { state: "failed", error: "cancelled" }, { state: "gone", error: null },
    ]);
    await backend.retryOperation("c");
    expect(stub.requests.at(-1)).toMatchObject({ method: "POST", url: "/v1/default/banks/plc-lead/operations/c/retry" });
  });

  it("invalidates a fact after reading it, refuses an observation, and lets the guard stop the change", async () => {
    const units: Record<string, unknown> = {
      f1: { id: "f1", fact_type: "world", text: "用户在杭州", document_id: "note-3" },
      o1: { id: "o1", fact_type: "observation", text: "obs" },
      // 带标签的：origin:external 是外部来源。
      x1: { id: "x1", fact_type: "world", text: "Ivy 说用户下周出差", document_id: "note-4", tags: ["kind:fact", "origin:external"] },
    };
    const stub = await stubHindsight((req) => {
      const id = req.url.split("/").pop()!;
      if (req.method === "GET") return units[id] ? { status: 200, body: units[id] } : { status: 404, body: { detail: "not found" } };
      return { status: 200, body: { ...(units[id] as object), state: req.body.state } };
    });
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url });
    expect(await backend.invalidate("f1", { reason: "搬到上海了" })).toEqual({ sourceKey: "note-3", text: "用户在杭州", external: null });
    expect(stub.requests.at(-1)).toMatchObject({ method: "PATCH", url: "/v1/default/banks/plc-lead/memories/f1", body: { state: "invalidated", reason: "搬到上海了" } });
    await backend.invalidate("f1", { reason: "又回来了", restore: true });
    expect(stub.requests.at(-1)!.body).toEqual({ state: "valid", reason: "又回来了" });
    expect(await backend.invalidate("x1", { reason: "Ivy 说错了" })).toEqual({ sourceKey: "note-4", text: "Ivy 说用户下周出差", external: true });
    await expect(backend.invalidate("o1", { reason: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
    await expect(backend.invalidate("missing", { reason: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
    const before = stub.requests.length;
    await expect(backend.invalidate("f1", { reason: "x", guard: () => { throw new Error("core memory"); } })).rejects.toThrow(/core memory/);
    expect(stub.requests.slice(before).map((req) => req.method)).toEqual(["GET"]);
  });

  it("deletes documents, reads stats, reports health, and keeps the key out of errors", async () => {
    const stub = await stubHindsight((req) => req.url === "/health" ? { status: 503, body: { status: "db down" } }
      : req.method === "DELETE" ? { status: 404 }
      : req.url.endsWith("/stats") ? { status: 200, body: { total_documents: 3, nodes_by_fact_type: { world: 5, experience: 1, observation: 2 }, total_observations: 2, pending_consolidation: 4 } }
      : { status: 500, body: { detail: "boom" } });
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url, apiKey: "secret-key" });
    await backend.forget(["note-9"]);
    expect(stub.requests[0]).toMatchObject({ method: "DELETE", url: "/v1/default/banks/plc-lead/documents/note-9" });
    expect(await backend.stats()).toEqual({ documents: 3, facts: 6, observations: 2, pendingConsolidation: 4 });
    expect(await backend.healthy()).toBe(false);
    const error = await backend.remember({ ...ITEM, sourceKey: "note-1" }, { operationId: "op" }).catch((e: Error) => e);
    expect(String(error)).toMatch(/retain failed: HTTP 500/);
    expect(String(error)).not.toContain("secret-key");
  });

  it("refuses URLs and bank ids it cannot use", () => {
    expect(() => new HindsightBackend({ baseUrl: "file:///tmp/x" })).toThrow(/http or https/);
    expect(() => new HindsightBackend({ baseUrl: "http://127.0.0.1:1", bank: "../x" })).toThrow(/bank id/);
  });
});

// 发给 Hindsight 的文字会经它交给 LLM 提取事实、交给 embedding（可能是远程的），召回时交给 reranker。
// 所以像密钥的字符串在离开 daemon 之前就盖掉（2026-10-16 发布评审）。
const GITHUB_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OPENAI_KEY = "sk-" + "proj-abcdEFGH1234ijklMNOP5678";

describe("HindsightBackend: nothing token-shaped reaches Hindsight", () => {
  it("redacts note text, context, recall queries and invalidation reasons", async () => {
    const stub = await stubHindsight((req) => req.url.endsWith("/recall") ? { status: 200, body: { results: [] } }
      : req.method === "GET" ? { status: 200, body: { id: "f1", fact_type: "world", document_id: "note-9" } }
      : { status: 200, body: { success: true } });
    closers.push(stub.close);
    const backend = new HindsightBackend({ baseUrl: stub.url, apiKey: "k" });
    await backend.remember({
      sourceKey: "note-9", content: `部署凭证\nGitHub token 是 ${GITHUB_TOKEN}，OpenAI key 是 ${OPENAI_KEY}`,
      kind: "fact", occurredAt: "2026-10-16T08:00:00Z", context: `saved with ${GITHUB_TOKEN}`, origin: "user",
    }, { operationId: "op" });
    await backend.recall(`哪个 token 是 ${GITHUB_TOKEN}`, { limit: 5 });
    await backend.invalidate("f1", { reason: `old token ${OPENAI_KEY}` });
    const sent = JSON.stringify(stub.requests.map((req) => req.body));
    expect(sent).not.toContain(GITHUB_TOKEN);
    expect(sent).not.toContain(OPENAI_KEY);
    expect(stub.requests[0]!.body.items[0].content).toContain("部署凭证");
    expect(stub.requests[1]!.body.query).toContain("哪个 token 是");
  });
});

function db(): Db {
  return openDb(join(tempDir("plc-memory-"), "plc.db"));
}

// 跑一轮同步，让替身的后台处理完，再跑一轮查任务状态。
async function settle(memory: NotesMemory, hindsight: FakeHindsight): Promise<void> {
  await memory.idle();
  await memory.sync();
  hindsight.process();
  await memory.sync();
  await memory.idle();
}

function recallEvents(database: Db): Array<Record<string, unknown>> {
  return listEvents(database, { kind: "memory.recalled" }).map((event) => event.payload as Record<string, unknown>);
}

// 2026-10-26 第 1 条：embedding / LLM 的 key 无效，Hindsight 收下了 100 条笔记，后台任务全部 401，plc 却显示 100/100。
// 旧代码只看 HTTP 收没收下，从不查任务：这个测试在旧代码上失败（没有 writeStatus，也不会改用 SQLite）。
describe("NotesMemory: Hindsight write failures are tracked, shown, and retried (2026-10-26 regression)", () => {
  it("marks notes failed after three failed operations, tells the daemon, falls back with not_ready, and recovers on retry", async () => {
    const database = db();
    const reported: NoteWriteStatus[] = [];
    const memory = new NotesMemory(database, null, { onWriteFailed: (status) => reported.push(status) });
    const hindsight = new FakeHindsight();
    hindsight.llmBroken = true;
    for (const title of ["部署流程", "回复风格"]) memory.save({ title, content: `${title}的说明`, tags: [] });
    memory.setBackend(hindsight);
    for (let round = 0; round < 4; round += 1) await settle(memory, hindsight);

    expect(memory.writeStatus()).toEqual({ notes: 2, completed: 0, pending: 0, failed: 2, lastError: "Error code: 401 - invalid api key" });
    expect(memory.progress()).toEqual({ notes: 2, indexed: 0 });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ failed: 2 });
    // 一条都没写进去：召回改用 SQLite，写明原因。
    const found = await memory.search("部署流程");
    expect(found).toMatchObject({ backend: "sqlite", fallback: "not_ready", memories: [] });
    expect(found.detail).toMatch(/2 条写入失败（Error code: 401/);
    expect(found.notes.map((note) => note.title)).toEqual(["部署流程"]);
    expect(recallEvents(database).at(-1)).toMatchObject({ backend: "hindsight", ok: false, fallback: true, reason: "not_ready" });

    // 修好 key，重试：失败的用新的任务编号重新写。
    hindsight.llmBroken = false;
    expect(memory.retryFailed()).toBe(2);
    await settle(memory, hindsight);
    expect(memory.writeStatus()).toMatchObject({ completed: 2, pending: 0, failed: 0 });
    const recovered = await memory.search("部署流程");
    expect(recovered).toMatchObject({ backend: "hindsight", fallback: null, notes: [] });
    expect(recovered.memories.map((memoryHit) => memoryHit.text)).toEqual(["部署流程 部署流程的说明"]);
  });

  it("lets Hindsight retry a failed operation before giving up, and completes when a retry succeeds", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    hindsight.llmBroken = true;
    memory.save({ title: "a", content: "1", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    const row = listMemorySync(database, "hindsight.bank-1")[0]!;
    expect(row).toMatchObject({ state: "submitted", attempts: 1, error: "Error code: 401 - invalid api key" });
    hindsight.llmBroken = false;
    await settle(memory, hindsight);
    expect(listMemorySync(database, "hindsight.bank-1")[0]).toMatchObject({ state: "completed", operationId: row.operationId });
    expect(hindsight.operations.size).toBe(1);
  });
});

describe("NotesMemory: writes go to Hindsight as tracked operations", () => {
  it("resends a note with the same operation id when the request failed, so Hindsight does not do the work twice", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    // Hindsight 收下了，但回话丢了（超时）：下次用同一个编号重发。
    const remember = hindsight.remember.bind(hindsight);
    let lost = true;
    hindsight.remember = async (item, opts) => {
      await remember(item, opts);
      if (lost) {
        lost = false;
        throw new Error("The operation was aborted due to timeout");
      }
    };
    memory.save({ title: "a", content: "1", tags: [] });
    memory.setBackend(hindsight);
    await memory.idle();
    expect(listMemorySync(database, "hindsight.bank-1")[0]).toMatchObject({ state: "queued" });
    await settle(memory, hindsight);
    expect(hindsight.operations.size).toBe(1);
    expect(memory.writeStatus()).toMatchObject({ completed: 1 });
  });

  it("does not resend unchanged notes, and resends a changed note as a replace with a new operation", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    const id = memory.save({ title: "住址", content: "杭州", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    expect(await memory.sync()).toBe(0);
    memory.update(id, { content: "上海" });
    await settle(memory, hindsight);
    expect(hindsight.operations.size).toBe(2);
    expect(hindsight.factsOf(`note-${id}`).map((fact) => fact.text)).toEqual(["住址 上海"]);
  });

  it("marks a note failed after Hindsight rejects it three times, without stalling the others", async () => {
    const database = db();
    const lines: string[] = [];
    const memory = new NotesMemory(database, null, { log: (line) => lines.push(line) });
    const hindsight = new FakeHindsight();
    hindsight.rejects = (item) => item.content.includes("BAD");
    for (const title of ["a", "BAD", "c"]) memory.save({ title, content: title, tags: [] });
    memory.setBackend(hindsight);
    for (let round = 0; round < 3; round += 1) await settle(memory, hindsight);
    expect(memory.writeStatus()).toMatchObject({ completed: 2, failed: 1, lastError: expect.stringMatching(/HTTP 422/) });
    expect(lines.join("\n")).toMatch(/rejected note #\d+ 3 times/);
  });

  it("keeps notes queued while Hindsight is down and writes them once it is back", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    hindsight.down = true;
    memory.save({ title: "a", content: "1", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    expect(memory.writeStatus()).toMatchObject({ completed: 0, pending: 1, failed: 0 });
    hindsight.down = false;
    await settle(memory, hindsight);
    expect(memory.writeStatus()).toMatchObject({ completed: 1, pending: 0 });
  });

  it("replays every note into a new memory bank (a new embedding)", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    memory.save({ title: "a", content: "1", tags: [] });
    memory.save({ title: "b", content: "2", tags: [] });
    const first = new FakeHindsight("bank-1");
    memory.setBackend(first);
    await settle(memory, first);
    const second = new FakeHindsight("bank-2");
    memory.setBackend(second);
    await settle(memory, second);
    expect(second.operations.size).toBe(2);
    expect(memory.writeStatus()).toMatchObject({ completed: 2 });
  });

  it("picks up submitted operations after a daemon restart (the tracking is persisted)", async () => {
    const database = db();
    const hindsight = new FakeHindsight();
    const before = new NotesMemory(database, hindsight);
    before.save({ title: "a", content: "1", tags: [] });
    await before.idle();
    expect(listMemorySync(database, "hindsight.bank-1")[0]).toMatchObject({ state: "submitted" });
    before.stop();
    hindsight.process();
    const after = new NotesMemory(database, hindsight);
    await after.sync();
    expect(after.writeStatus()).toMatchObject({ completed: 1, pending: 0 });
    expect(hindsight.operations.size).toBe(1);
  });

  it("stops a running sync when asked, so shutdown does not wait for every note", async () => {
    const memory = new NotesMemory(db(), null);
    const hindsight = new FakeHindsight();
    let calls = 0;
    const remember = hindsight.remember.bind(hindsight);
    hindsight.remember = async (item, opts) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await remember(item, opts);
    };
    for (let i = 0; i < 5; i += 1) memory.save({ title: `n${i}`, content: "x", tags: [] });
    memory.setBackend(hindsight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    memory.stop();
    await memory.idle();
    expect(calls).toBeLessThan(5);
    expect(await memory.sync()).toBe(0);
  });
});

describe("NotesMemory: recall goes to one backend only", () => {
  async function ready(): Promise<{ database: Db; memory: NotesMemory; hindsight: FakeHindsight; ids: number[] }> {
    const database = db();
    const memory = new NotesMemory(database, null, { recallTimeoutMs: 50 });
    const hindsight = new FakeHindsight();
    const ids = [
      memory.save({ title: "回复风格", content: "回复要详细", tags: [], kind: "preference" }),
      memory.save({ title: "回复风格（新）", content: "回复要简洁", tags: [], kind: "preference" }),
      memory.save({ title: "住址", content: "杭州", tags: [], kind: "fact" }),
    ];
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    return { database, memory, hindsight, ids };
  }

  it("asks only Hindsight when it is available: facts and observations with their notes, no full-text results", async () => {
    const { database, memory, hindsight, ids } = await ready();
    const facts = [...hindsight.facts.values()].filter((fact) => fact.sourceKey !== `note-${ids[2]}`).map((fact) => fact.id);
    hindsight.observe("回复：以前要详细，现在要简洁", facts);
    const found = await memory.search("回复");
    expect(found).toMatchObject({ backend: "hindsight", fallback: null, detail: null, notes: [], writes: { pending: 0, failed: 0 } });
    expect(found.memories).toEqual([{
      id: expect.any(String), type: "observation", text: "回复：以前要详细，现在要简洁", occurredAt: null, external: false,
      notes: [
        { id: ids[0], title: "回复风格", kind: "preference", external: false },
        { id: ids[1], title: "回复风格（新）", kind: "preference", external: false },
      ],
    }]);
    // 全文检索能找到「杭州」，但 Hindsight 可用时不跑全文检索。
    expect(saveNote(database, { title: "只在 SQLite", content: "杭州", tags: [] })).toBeGreaterThan(0);
    expect((await memory.search("杭州")).memories.map((hit) => hit.text)).toEqual(["住址 杭州"]);
    expect(recallEvents(database).at(-1)).toMatchObject({ backend: "hindsight", ok: true, fallback: false, reason: null });
  });

  // 用户 2026-10-27：记忆不算外部内容，但从外部通道整理来的笔记要写明来源，提示词告诉 Lead 它记的是别人说的话（spec D14）。
  it("marks memories drawn from a note that channel memory distilled from an outside conversation", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    const channel = memory.save({ title: "Slack #proj：上线", content: "- 张三 说 周五上线", tags: ["slack", "slack:C0PROJ:"], kind: "fact" });
    const own = memory.save({ title: "上线窗口", content: "周五上线前要先冻结", tags: ["slack"], kind: "fact" });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    const found = await memory.search("上线");
    expect(found.memories.flatMap((hit) => hit.notes).map((note) => [note.id, note.external])).toEqual([[channel, true], [own, false]]);
    expect(found.memories.map((hit) => hit.external)).toEqual([true, false]);
    // 交给 Hindsight 时带来源标签，观察分开整理：别人说的话不会和用户自己的笔记合成一条观察（spec D14）。
    expect([...hindsight.operations.values()].map((op) => [op.item.sourceKey, op.item.origin]))
      .toEqual([[`note-${channel}`, "external"], [`note-${own}`, "user"]]);
    const [fromChannel, fromUser] = [hindsight.factsOf(`note-${channel}`)[0]!, hindsight.factsOf(`note-${own}`)[0]!];
    expect(() => hindsight.observe("周五上线", [fromChannel.id, fromUser.id])).toThrow(/one tag scope/);
  });

  it("says how many notes are still being written: those are not in this recall", async () => {
    const { memory, hindsight } = await ready();
    memory.save({ title: "新笔记", content: "刚存的", tags: [] });
    await memory.idle();
    const found = await memory.search("刚存的");
    expect(found).toMatchObject({ backend: "hindsight", memories: [], writes: { pending: 1, failed: 0 } });
    hindsight.process();
    await memory.sync();
    expect((await memory.search("刚存的")).memories).toHaveLength(1);
  });

  it("falls back to full-text search, with the reason, when Hindsight is down, errors, times out, or has no finished note", async () => {
    const { database, memory, hindsight } = await ready();
    memory.setUnavailable("记忆服务正在启动");
    expect(await memory.search("杭州")).toMatchObject({ backend: "sqlite", fallback: "down", detail: "Hindsight 没在运行：记忆服务正在启动" });
    memory.setUnavailable(null);
    hindsight.recallError = "boom";
    expect(await memory.search("杭州")).toMatchObject({ backend: "sqlite", fallback: "error", detail: expect.stringMatching(/召回出错.*HTTP 500 boom/) });
    hindsight.recallError = null;
    hindsight.recallHangs = true;
    const slow = await memory.search("杭州");
    expect(slow).toMatchObject({ backend: "sqlite", fallback: "timeout", detail: "Hindsight 召回超时（50 毫秒）" });
    expect(slow.notes.map((note) => note.title)).toEqual(["住址"]);
    expect(recallEvents(database).slice(-3).map((event) => event.reason)).toEqual(["down", "error", "timeout"]);
    // 新的记忆库里一条写完的笔记都没有：索引没好。
    hindsight.recallHangs = false;
    memory.setBackend(new FakeHindsight("bank-new"));
    await memory.idle();
    expect(await memory.search("杭州")).toMatchObject({ backend: "sqlite", fallback: "not_ready" });
  });

  it("is plain full-text search, not a fallback, when Hindsight is not chosen", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    memory.save({ title: "住址", content: "杭州", tags: [] });
    expect(await memory.search("杭州")).toMatchObject({ backend: "sqlite", fallback: null, detail: null, writes: null });
    expect(recallEvents(database)).toEqual([]);
  });
});

describe("NotesMemory: deleting and invalidating use Hindsight's own mechanisms", () => {
  it("deletes the note, then the document, its facts and the observations drawn from them", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    const id = memory.save({ title: "住址", content: "杭州", tags: [] });
    const other = memory.save({ title: "公司", content: "杭州的公司", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    hindsight.observe("住在杭州，也在杭州上班", [...hindsight.facts.keys()]);
    expect(memory.delete(id)).toBe(true);
    await settle(memory, hindsight);
    expect(hindsight.factsOf(`note-${id}`)).toEqual([]);
    expect([...hindsight.facts.values()].map((fact) => fact.text)).toEqual(["公司 杭州的公司"]);
    expect(getMemorySync(database, "hindsight.bank-1", `note-${id}`)).toBeNull();
    expect(getMemorySync(database, "hindsight.bank-1", `note-${other}`)).toMatchObject({ state: "completed" });
    expect(memory.pendingForget()).toEqual([]);
  });

  it("keeps the forget pending while Hindsight is down", async () => {
    const memory = new NotesMemory(db(), null);
    const hindsight = new FakeHindsight();
    const id = memory.save({ title: "a", content: "1", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    hindsight.down = true;
    memory.delete(id);
    await settle(memory, hindsight);
    expect(memory.pendingForget()).toEqual([`note-${id}`]);
    hindsight.down = false;
    await settle(memory, hindsight);
    expect(memory.pendingForget()).toEqual([]);
    expect(hindsight.factsOf(`note-${id}`)).toEqual([]);
  });

  it("invalidates one fact: it leaves recall, its observations go, an audit row is kept, and the fallback says so", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    const id = memory.save({ title: "住址", content: "杭州", tags: [] });
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    const fact = hindsight.factsOf(`note-${id}`)[0]!;
    hindsight.observe("住在杭州", [fact.id]);
    const result = await memory.invalidate(fact.id, { reason: "搬到上海了", actor: "lead" });
    expect(result.note).toMatchObject({ id, title: "住址" });
    expect((await memory.search("杭州")).memories).toEqual([]);
    expect([...hindsight.facts.values()].filter((other) => other.type === "observation")).toEqual([]);
    expect(result).toMatchObject({ text: "住址 杭州", origin: "user", record: { action: "invalidated", text: "住址 杭州", origin: "user" } });
    expect(database.prepare("SELECT memory_id, document_id, action, reason, actor, text, origin FROM memory_invalidations").all())
      .toEqual([{ memory_id: fact.id, document_id: `note-${id}`, action: "invalidated", reason: "搬到上海了", actor: "lead", text: "住址 杭州", origin: "user" }]);
    memory.setUnavailable("停了");
    expect((await memory.search("杭州")).invalidatedFacts).toEqual({ [id]: 1 });
    memory.setUnavailable(null);
    await memory.invalidate(fact.id, { reason: "又搬回来了", restore: true, actor: "lead" });
    expect((await memory.search("杭州")).memories).toHaveLength(1);
  });

  it("changes nothing when the guard refuses (core memory in an external turn), and refuses without Hindsight", async () => {
    const database = db();
    const memory = new NotesMemory(database, null);
    const hindsight = new FakeHindsight();
    const id = memory.save({ title: "偏好", content: "回复用中文", tags: [], kind: "preference" });
    await expect(memory.invalidate("x", { reason: "r", actor: "lead" })).rejects.toThrow(/不是 Hindsight/);
    memory.setBackend(hindsight);
    await settle(memory, hindsight);
    const fact = hindsight.factsOf(`note-${id}`)[0]!;
    await expect(memory.invalidate(fact.id, {
      reason: "r", actor: "lead", guard: (fact) => { if (fact.note?.kind === "preference") throw new Error("needs user turn"); },
    })).rejects.toThrow(/needs user turn/);
    expect(fact.invalidated).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS n FROM memory_invalidations").get()).toEqual({ n: 0 });
  });
});

describe("memory backend setting", () => {
  it("defaults to hindsight and rejects unknown names", () => {
    expect(memoryBackendSetting({})).toBe("hindsight");
    expect(memoryBackendSetting({ PLC_MEMORY_BACKEND: "sqlite" })).toBe("sqlite");
    expect(() => memoryBackendSetting({ PLC_MEMORY_BACKEND: "openviking" })).toThrow(/use one of/);
  });
});

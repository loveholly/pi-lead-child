// 常驻偏好走完用户经过的每一跳（用户 2026-10-29，.scratch/hindsight-primary-memory/spec.md D15）：
//   设置页读 GET /v1/memory/preferences；Lead 用 update_note 改一条，「Lead 动态」推一张带「撤销」的卡；
//   用户在卡上点撤销（POST /v1/actions/core_memory_change/<编号>/undo），原文恢复，同一张卡原地更新，按钮没了；
//   用户在设置页改（POST /v1/actions/core_memory/<编号>/update），记成用户的改动，不写 Lead 动态。
// 事实失效（D5，「hindsight 的 invalidate 机制要有啊」）同一套：Lead 用 invalidate_memory 让一条事实失效，卡上带「撤销」，
//   用户点了（POST /v1/actions/memory_fact/<编号>/restore）以后召回又拿得到它，按钮没了。
// daemon、网关、操作层和 Lead 的工具是真的；Lead 的会话和 Hindsight 是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  CORE_MEMORY_CHANGED_KIND, LeadActivityViewSchema, MEMORY_FACT_CHANGED_KIND, MemoryPreferencesResponseSchema, UiActionRunResponseSchema,
} from "@pi-lead-child/protocol";
import type { NotesMemory } from "@pi-lead-child/engine";
import { FakeHindsight } from "@pi-lead-child/engine/testing";
import {
  createLoopbackBinding, createPairing, getNote, listEvents, listGatewayEvents, openDb, redeemPairing, saveNote, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "@pi-lead-child/lead";
import { startDaemon } from "../src/server.js";
import { leadEventRoute } from "../src/lead-input.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-core-memory-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_LEAD_ACTIVITY_SYNC_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// Lead 的会话是替身，工具是真的（和 daemon 给 Lead 的是同一份 deps）。
function leadSessionFactory(capture: { tools: ReturnType<typeof createLeadTools>; deps?: LeadDeps }) {
  return async (args: LeadDeps) => {
    capture.tools = createLeadTools(args);
    capture.deps = args;
    return {
      modelName: "stub/lead",
      session: {
        sessionId: "lead-core-memory", subscribe: () => () => {},
        prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {},
      },
    };
  };
}

async function connect(token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${token}&protocol=2&after_seq=-1&include=lead_activity`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  return events;
}

async function boot() {
  const capture = { tools: [] as ReturnType<typeof createLeadTools>, deps: undefined as LeadDeps | undefined };
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: leadSessionFactory(capture) as never, gatewayPort: 0, log: () => {} });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const tool = (name: string) => capture.tools.find((candidate) => candidate.name === name)!;
  const run = async (name: string, params: unknown): Promise<any> => tool(name).execute("t", params as never, undefined, undefined, undefined as never);
  const pushes = await connect(redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code).accessToken);
  const cardPushes = (entityKey: string) => pushes.filter((event) => event.type === "snapshot.required" && event.payload.resource === "lead-activity"
    && event.payload.card?.entityKey === entityKey).map((event) => event.payload.card);
  return { capture, owner, call, run, cardPushes };
}

describe("memory facts through the daemon", () => {
  it("shows Lead's invalidation with an undo button, and the user's undo brings the fact back to recall", async () => {
    const { capture, call, run, cardPushes } = await boot();
    const memory = capture.deps!.memory as NotesMemory;
    const hindsight = new FakeHindsight();
    memory.setBackend(hindsight);
    const saved = await run("save_note", { title: "住址", content: "用户住在杭州", tags: [], kind: "fact" });
    const noteId = Number(/#(\d+)/.exec(saved.content[0].text)![1]);
    await memory.idle();
    hindsight.process();
    await memory.sync();
    const fact = hindsight.factsOf(`note-${noteId}`)[0]!;

    await run("invalidate_memory", { memory_id: fact.id, reason: "用户 10-29 说搬到上海了" });
    expect(fact.invalidated).toBe(true);
    const button = { target: { type: "memory_fact", id: fact.id }, action: "restore", label: "撤销" };
    await vi.waitFor(() => expect(cardPushes(`memory_fact:${fact.id}`).some((card) => card.action)).toBe(true));
    const activity = await call("GET", "/v1/lead/activity?include=events");
    expect(Value.Check(LeadActivityViewSchema, activity.body)).toBe(true);
    const card = activity.body.cards.find((candidate: any) => candidate.entityKey === `memory_fact:${fact.id}`);
    expect(card).toMatchObject({
      state: "seen", action: button,
      summary: "Paimon 让一条记忆失效：「住址 用户住在杭州」（来自「住址」）。以后召回不到它。依据：用户 10-29 说搬到上海了。",
    });

    const restored = await call("POST", `/v1/actions/${button.target.type}/${button.target.id}/${button.action}`, { input: {} });
    expect(restored.status).toBe(200);
    expect(fact.invalidated).toBe(false);
    expect((await run("search_notes", { query: "杭州" })).content[0].text).toContain("住址 用户住在杭州");
    await vi.waitFor(() => expect(cardPushes(`memory_fact:${fact.id}`).at(-1)).toMatchObject({ key: card.key, count: 2 }));
    expect(cardPushes(`memory_fact:${fact.id}`).at(-1).action).toBeUndefined();
    expect(await call("POST", `/v1/actions/memory_fact/${fact.id}/restore`, { input: {} })).toMatchObject({ status: 409 });
    const [own, undo] = listEvents(db, { kind: MEMORY_FACT_CHANGED_KIND, limit: 10 });
    expect(leadEventRoute(own!)).toBe("skip");
    expect(leadEventRoute(undo!)).toBe("situation");
  });
});

describe("core memory through the daemon", () => {
  it("shows Lead's change with an undo button, restores the text on undo, and keeps the user's own edits quiet", async () => {
    const id = saveNote(db, { title: "沟通偏好", content: "先给结论，再给细节", tags: [], kind: "preference" });
    const { owner, call, run, cardPushes: pushesOf } = await boot();
    const cardPushes = () => pushesOf(`core_memory:${id}`);

    const first = await call("GET", "/v1/memory/preferences");
    expect(first.status).toBe(200);
    expect(Value.Check(MemoryPreferencesResponseSchema, first.body)).toBe(true);
    expect(first.body.preferences).toMatchObject({ entries: [{ id, kind: "preference", content: "先给结论，再给细节", lastChange: null }], cap: 4000 });
    expect((await call("GET", "/v1/memory/preferences", undefined, null)).status).toBe(401);

    // Lead 发现有出入，自己改。
    await run("update_note", { note_id: id, content: "只给结论，最多三句", reason: "用户 10-29 说「再短一点」" });
    const changed = await call("GET", "/v1/memory/preferences");
    expect(changed.body.preferences.entries[0]).toMatchObject({
      content: "只给结论，最多三句", lastChange: { changeId: 1, action: "update", actor: "lead", reason: "用户 10-29 说「再短一点」", canUndo: true },
    });
    const undoButton = { target: { type: "core_memory_change", id: "1" }, action: "undo", label: "撤销" };
    await vi.waitFor(() => expect(cardPushes().some((card) => card.action)).toBe(true));
    const activity = await call("GET", "/v1/lead/activity?include=events");
    expect(Value.Check(LeadActivityViewSchema, activity.body)).toBe(true);
    const card = activity.body.cards.find((candidate: any) => candidate.entityKey === `core_memory:${id}`);
    expect(card).toMatchObject({
      kind: "digest", state: "seen", count: 1, action: undoButton,
      summary: "Paimon 改了常驻偏好「沟通偏好」：原来「先给结论，再给细节」，现在「只给结论，最多三句」。依据：用户 10-29 说「再短一点」。",
    });

    // 用户在卡上点「撤销」：和卡上的按钮一样调操作入口。
    const undone = await call("POST", `/v1/actions/${undoButton.target.type}/${undoButton.target.id}/${undoButton.action}`, { input: {} });
    expect(undone.status).toBe(200);
    expect(Value.Check(UiActionRunResponseSchema, undone.body)).toBe(true);
    expect(getNote(db, id)?.content).toBe("先给结论，再给细节");
    await vi.waitFor(() => expect(cardPushes().at(-1)).toMatchObject({ key: card.key, count: 2 }));
    expect(cardPushes().at(-1).action).toBeUndefined();
    const after = (await call("GET", "/v1/lead/activity?include=events")).body.cards.find((candidate: any) => candidate.key === card.key);
    expect(after).toMatchObject({ summary: "你撤销了 Paimon 对常驻偏好「沟通偏好」的修改：恢复成「先给结论，再给细节」。", count: 2 });
    expect(after.action).toBeUndefined();
    expect(after.entityVersion).toBeGreaterThan(card.entityVersion);
    expect(await call("POST", "/v1/actions/core_memory_change/1/undo", { input: {} })).toMatchObject({ status: 409 });

    // 你自己在设置页改：记成你的改动，不写 Lead 动态。
    const edited = await call("POST", `/v1/actions/core_memory/${id}/update`, { input: { title: "回复风格" } });
    expect(edited.status).toBe(200);
    expect((await call("GET", "/v1/memory/preferences")).body.preferences.entries[0]).toMatchObject({
      title: "回复风格", lastChange: { actor: "user", reason: "在设置页改了常驻偏好", canUndo: true },
    });
    expect(listEvents(db, { kind: CORE_MEMORY_CHANGED_KIND, limit: 10 })).toHaveLength(2);
    expect((await call("POST", `/v1/actions/core_memory/${id}/update`, { input: { kind: "fact" } })).status).toBe(400);

    // 每次改动都让设置页重新读。
    const reloads = listGatewayEvents(db, { afterSeq: -1, bindingId: owner.binding.id, scopes: ["tickets:view"], limit: 1000 })
      .filter((event) => event.type === "snapshot.required" && (event.payload as { resource?: string }).resource === "memory");
    expect(reloads.length).toBeGreaterThanOrEqual(3);

    // Lead 自己的改动不再交给 Lead；用户撤销了它的改动要交给 Lead。
    const [own, undoEvent] = listEvents(db, { kind: CORE_MEMORY_CHANGED_KIND, limit: 10 });
    expect(leadEventRoute(own!)).toBe("skip");
    expect(leadEventRoute(undoEvent!)).toBe("situation");
  });
});

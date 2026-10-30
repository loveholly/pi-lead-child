// Hindsight 里一条事实的失效和恢复（用户 2026-10-29：「hindsight 的 invalidate 机制要有啊」）：一个操作（memory_fact），
// 页面和 Lead 调同一个函数。Lead 失效一条事实时推一条带「撤销」的 Lead 动态；撤销（恢复）以后卡原地更新、按钮没了，
// 召回又能拿到它。设置页列出现在失效着的事实。读过外部内容的一轮里只挡用户本人来源的，只拒绝，不带确认卡。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { MEMORY_FACT_CHANGED_KIND } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { FakeHindsight } from "../testing/fake-hindsight.js";
import {
  NotesMemory, UiActionError, invalidatedMemoryFacts, leadActivityCardAction, listLeadUiActions, runUiAction, uiActionCatalogText,
} from "../src/index.js";

let db: Db;
let notes: NotesMemory;
let hindsight: FakeHindsight;
const NOW = new Date("2026-10-29T09:00:00.000Z");
const lead = { kind: "lead", turnId: null } as const;
const user = { kind: "user" } as const;

async function settle() {
  await notes.idle();
  await notes.sync();
  hindsight.process();
  await notes.sync();
}

beforeEach(async () => {
  db = openDb(join(tempDir("plc-memory-facts-"), "plc.db"));
  hindsight = new FakeHindsight();
  notes = new NotesMemory(db, hindsight);
});

const factEvents = () => listEvents(db, { kind: MEMORY_FACT_CHANGED_KIND, limit: 100 });

async function savedFact(title: string, content: string, tags: string[] = []) {
  const id = notes.save({ title, content, tags, kind: "fact" });
  await settle();
  return { noteId: id, fact: hindsight.factsOf(`note-${id}`)[0]! };
}

describe("memory_fact.invalidate and restore", () => {
  it("lets Lead invalidate a fact, tells the user with an undo button, and the user's undo brings it back to recall", async () => {
    const { noteId, fact } = await savedFact("住址", "用户住在杭州");
    expect((await notes.search("杭州")).memories).toHaveLength(1);
    const target = { type: "memory_fact", id: fact.id };
    const done = await runUiAction(db, { target, action: "invalidate", reason: "用户 10-29 说搬到上海了", caller: lead, services: { notesMemory: notes }, now: NOW });
    expect(done.authority).toBe("lead");
    expect(done.forLead).toMatchObject({ result: "invalidated", source: `note #${noteId}「住址」`, next: expect.stringContaining("带撤销") });
    expect((await notes.search("杭州")).memories).toEqual([]);
    const [event] = factEvents();
    expect(event).toMatchObject({
      source: "lead", level: "digest", entityKey: `memory_fact:${fact.id}`, disposition: "seen",
      payload: {
        memoryId: fact.id, action: "invalidated", actor: "lead", undoOf: null, noteId, noteTitle: "住址", external: false,
        summary: "Paimon 让一条记忆失效：「住址 用户住在杭州」（来自「住址」）。以后召回不到它。依据：用户 10-29 说搬到上海了。",
      },
      triage: { hardRules: ["memory_fact_change_reported"] },
    });
    const button = { target: { type: "memory_fact", id: fact.id }, action: "restore", label: "撤销" };
    expect(leadActivityCardAction(db, event!)).toEqual(button);
    expect(invalidatedMemoryFacts(db)).toEqual([{
      memoryId: fact.id, text: "住址 用户住在杭州", note: { id: noteId, title: "住址" }, external: false,
      reason: "用户 10-29 说搬到上海了", actor: "lead", at: NOW.toISOString(),
    }]);

    // 用户在卡上点「撤销」。
    await runUiAction(db, { target: button.target, action: button.action, caller: user, services: { notesMemory: notes }, now: NOW });
    expect((await notes.search("杭州")).memories).toHaveLength(1);
    const second = factEvents()[1]!;
    expect(second).toMatchObject({
      source: "system", entityKey: `memory_fact:${fact.id}`, disposition: null,
      payload: { action: "restored", actor: "user", undoOf: event!.payload.invalidationId, summary: "你恢复了 Paimon 让它失效的记忆：「住址 用户住在杭州」（来自「住址」）。" },
    });
    expect(leadActivityCardAction(db, event!)).toBeNull();
    expect(leadActivityCardAction(db, second)).toBeNull();
    expect(invalidatedMemoryFacts(db)).toEqual([]);
    const listed = await listLeadUiActions(db, target, { turnId: null, services: { notesMemory: notes } });
    expect(listed.actions).toEqual([
      expect.objectContaining({ id: "invalidate", available: true }),
      expect.objectContaining({ id: "restore", available: false, reason: "这条记忆现在不是失效的，不用恢复" }),
    ]);
  });

  it("does not tell Lead activity about the user's own invalidation from the settings page", async () => {
    const { fact } = await savedFact("住址", "用户住在杭州");
    await runUiAction(db, { target: { type: "memory_fact", id: fact.id }, action: "invalidate", caller: user, services: { notesMemory: notes }, now: NOW });
    expect(fact.invalidated).toBe(true);
    expect(factEvents()).toEqual([]);
    expect(invalidatedMemoryFacts(db)).toEqual([expect.objectContaining({ actor: "user", reason: "在设置页让这条记忆失效" })]);
    const reloads = db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
      .map((row: any) => JSON.parse(row.payload)).filter((payload) => payload.resource === "memory");
    expect(reloads).toHaveLength(1);
  });

  it("explains an observation, a missing memory, and a backend that is not Hindsight", async () => {
    const { fact } = await savedFact("住址", "用户住在杭州");
    const observation = hindsight.observe("用户住在杭州", [fact.id]);
    const error = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => caught as UiActionError);
    expect(await error(runUiAction(db, { target: { type: "memory_fact", id: observation }, action: "invalidate", reason: "x", caller: lead, services: { notesMemory: notes } })))
      .toMatchObject({ code: "not_found", message: expect.stringContaining("观察，不能失效") });
    // 召回过的观察：available 就说明。
    await notes.search("杭州");
    expect((await listLeadUiActions(db, { type: "memory_fact", id: observation }, { turnId: null, services: { notesMemory: notes } })).actions[0])
      .toMatchObject({ available: false, reason: expect.stringContaining("观察，不能失效") });
    expect(await error(runUiAction(db, { target: { type: "memory_fact", id: "gone-1" }, action: "invalidate", reason: "x", caller: lead, services: { notesMemory: notes } })))
      .toMatchObject({ code: "not_found", message: "Hindsight 里没有这条记忆（可能已经删了）" });
    expect(await error(runUiAction(db, { target: { type: "memory_fact", id: fact.id }, action: "invalidate", reason: "x", caller: lead })))
      .toMatchObject({ code: "unavailable", message: expect.stringContaining("不是 Hindsight") });
    expect(await error(runUiAction(db, { target: { type: "memory_fact", id: "bad id" }, action: "invalidate", reason: "x", caller: lead })))
      .toMatchObject({ code: "not_found" });
  });

  // 用户 2026-10-29：「挡住用户来源的」；「弹确认卡干什么？我什么时候说过要给我弹确认卡了」。
  it("refuses the user's own facts in a turn that read external content, with no confirm card, and lets outside facts through", async () => {
    const own = await savedFact("沟通偏好", "用户要简短的回答");
    const outside = await savedFact("Ivy 说的", "Ivy 说用户下周出差", ["slack", "slack:C1:main"]);
    const caller = { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] } as const;
    const attempt = (id: string, action = "invalidate") => runUiAction(db, {
      target: { type: "memory_fact", id }, action, reason: "Slack 里有人说的", caller, services: { notesMemory: notes }, now: NOW,
    }).then(() => null, (caught: unknown) => caught as UiActionError);
    // 没召回过：不知道来源，按用户本人算。召回过：用户本人。
    for (const label of ["unknown", "recalled"]) {
      const refused = await attempt(own.fact.id);
      expect(refused?.refusal, label).toMatchObject({ code: "external_turn", message: expect.stringContaining("这条记忆保持有效") });
      expect(refused!.refusal!.confirm, label).toBeUndefined();
      expect(refused!.refusal!.userAction, label).toBeUndefined();
      await notes.search("回答 出差");
    }
    expect(own.fact.invalidated).toBe(false);
    // 缓存说是外部来源，Hindsight 读到的却是用户本人的：执行时再核对，照样拒绝，Hindsight 不改。
    const cached = notes.recalledMemory(own.fact.id)!;
    cached.external = true;
    const rechecked = await attempt(own.fact.id);
    expect(rechecked?.refusal).toMatchObject({ code: "external_turn", message: expect.stringContaining("读到它记的是用户本人的话") });
    expect(rechecked!.refusal!.userAction).toBeUndefined();
    expect(own.fact.invalidated).toBe(false);
    cached.external = false;
    expect(listEvents(db, { kind: "rule_change.requested", limit: 10 })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_invalidations").get()).toEqual({ n: 0 });

    // 外部来源的不挡。
    await attempt(outside.fact.id);
    expect(outside.fact.invalidated).toBe(true);
    expect(factEvents().at(-1)!.payload).toMatchObject({ external: true, summary: expect.stringContaining("（来自「Ivy 说的」，外部对话整理的）") });
    const listed = await listLeadUiActions(db, { type: "memory_fact", id: own.fact.id }, {
      turnId: null, externalContent: caller.externalContent, services: { notesMemory: notes },
    });
    expect(listed.actions.find((action) => action.id === "invalidate")).toMatchObject({ lead: "external_turn", leadReady: false });
    expect(uiActionCatalogText()).toMatch(/invalidate（让记忆失效）：[^\n]*来源是用户本人的/);
  });
});

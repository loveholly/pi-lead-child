// 常驻偏好（用户 2026-10-29，.scratch/hindsight-primary-memory/spec.md D15）：设置页能改能删；Lead 发现有出入时自己改，
// 推一条带撤销的 Lead 动态。每次改动记一行（core_memory_changes），撤销按这一行恢复。
// 页面和 Lead 走同一个操作（core_memory、core_memory_change），读过外部内容的一轮只拒绝，不带确认卡。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CORE_MEMORY_CHANGED_KIND, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  coreNotes, createLoopbackBinding, createTurn, getNote, listEvents, openDb, renderCoreMemory, saveNote, type Db,
} from "@pi-lead-child/store";
import {
  NotesMemory, UiActionError, deleteCoreMemory, leadActivityCardAction, listLeadUiActions, memoryPreferences, runUiAction,
  saveNoteRecorded, undoCoreMemoryChange, uiActionCatalogText, updateCoreMemory, updateNoteRecorded,
} from "../src/index.js";

let db: Db;
let notes: NotesMemory;
const NOW = new Date("2026-10-29T08:00:00.000Z");
const external = [{ via: "message", source: "slack" }] as const;

beforeEach(() => {
  db = openDb(join(tempDir("plc-core-memory-"), "plc.db"));
  notes = new NotesMemory(db, null);
});

const preference = () => saveNote(db, { title: "沟通偏好", content: "先给结论，再给细节", tags: ["沟通"], kind: "preference" });
const changes = () => db.prepare("SELECT id, note_id AS noteId, action, actor, reason, undoes, undone_by AS undoneBy FROM core_memory_changes ORDER BY id").all();
const coreEvents = () => listEvents(db, { kind: CORE_MEMORY_CHANGED_KIND, limit: 100 });
const reloads = () => db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
  .map((row: any) => JSON.parse(row.payload)).filter((payload) => payload.resource === "memory");
const confirmCards = () => listEvents(db, { kind: "rule_change.requested", limit: 100 });

describe("changing core memory", () => {
  it("records Lead's update, tells the user in Lead activity with an undo button, and lists the change", () => {
    const id = preference();
    const outcome = updateCoreMemory(db, notes, id, { content: "  只给结论，最多三句  " }, { actor: "lead", reason: "用户 10-28 说「别写那么长」", now: NOW });
    expect(getNote(db, id)).toMatchObject({ content: "只给结论，最多三句", kind: "preference" });
    expect(changes()).toEqual([{ id: 1, noteId: id, action: "update", actor: "lead", reason: "用户 10-28 说「别写那么长」", undoes: null, undoneBy: null }]);
    const [event] = coreEvents();
    expect(event).toMatchObject({
      source: "lead", entityKey: `core_memory:${id}`, level: "digest", disposition: "seen",
      payload: { noteId: id, changeId: outcome.change!.id, action: "update", actor: "lead", undoOf: null, title: "沟通偏好" },
      triage: { hardRules: ["core_memory_change_reported"] },
    });
    expect(event!.payload.summary).toBe(
      "Paimon 改了常驻偏好「沟通偏好」：原来「先给结论，再给细节」，现在「只给结论，最多三句」。依据：用户 10-28 说「别写那么长」。",
    );
    expect(leadActivityCardAction(db, event!)).toEqual({
      target: { type: "core_memory_change", id: String(outcome.change!.id) }, action: "undo", label: "撤销",
    });
    expect(memoryPreferences(db)).toEqual({
      entries: [{
        id, kind: "preference", title: "沟通偏好", content: "只给结论，最多三句", updatedAt: expect.stringMatching(/Z$/),
        lastChange: {
          changeId: outcome.change!.id, action: "update", actor: "lead", reason: "用户 10-28 说「别写那么长」", at: NOW.toISOString(),
          undoOf: null, canUndo: true, undoBlocked: null,
        },
      }],
      used: "沟通偏好".length + "只给结论，最多三句".length, cap: 4000,
    });
    expect(reloads()).toHaveLength(1);
  });

  it("undoes Lead's update: restores the text, marks the change undone, and the card loses its button", () => {
    const id = preference();
    const { change } = updateCoreMemory(db, notes, id, { content: "只给结论" }, { actor: "lead", reason: "用户说的", now: NOW });
    const undone = undoCoreMemoryChange(db, notes, change!.id, { actor: "user", reason: "撤销", now: NOW });
    expect(getNote(db, id)).toMatchObject({ content: "先给结论，再给细节", tags: JSON.stringify(["沟通"]) });
    expect(undone.undone).toMatchObject({ id: change!.id, undoneBy: "user", undoneAt: NOW.toISOString() });
    expect(changes()).toEqual([
      expect.objectContaining({ id: change!.id, action: "update", actor: "lead", undoneBy: "user" }),
      expect.objectContaining({ action: "update", actor: "user", undoes: change!.id }),
    ]);
    const [first, second] = coreEvents();
    expect(second).toMatchObject({
      source: "system", entityKey: `core_memory:${id}`, level: "digest", disposition: null,
      payload: { actor: "user", undoOf: change!.id, summary: "你撤销了 Paimon 对常驻偏好「沟通偏好」的修改：恢复成「先给结论，再给细节」。" },
    });
    expect(leadActivityCardAction(db, first!)).toBeNull();
    expect(leadActivityCardAction(db, second!)).toBeNull();
    expect(memoryPreferences(db).entries[0]!.lastChange).toMatchObject({ undoOf: change!.id, canUndo: false, undoBlocked: expect.stringContaining("本身是一次撤销") });
    expect(() => undoCoreMemoryChange(db, notes, change!.id, { actor: "user", reason: "再撤销一次", now: NOW }))
      .toThrow(expect.objectContaining({ code: "conflict", message: "这次改动已经撤销过了" }));
  });

  it("refuses to undo a change after a later one, and says why", () => {
    const id = preference();
    const { change } = updateCoreMemory(db, notes, id, { content: "只给结论" }, { actor: "lead", reason: "用户说的", now: NOW });
    updateCoreMemory(db, notes, id, { title: "回复风格" }, { actor: "user", reason: "在设置页改了常驻偏好", now: NOW });
    const [event] = coreEvents();
    expect(leadActivityCardAction(db, event!)).toBeNull();
    expect(() => undoCoreMemoryChange(db, notes, change!.id, { actor: "user", reason: "撤销", now: NOW }))
      .toThrow(expect.objectContaining({ code: "conflict", message: expect.stringContaining("之后又改过") }));
    expect(getNote(db, id)).toMatchObject({ title: "回复风格", content: "只给结论" });
    // 你自己在设置页改的不写 Lead 动态。
    expect(coreEvents()).toHaveLength(1);
  });

  it("refuses to undo when the note changed outside the record", () => {
    const id = preference();
    const { change } = updateNoteRecorded(db, notes, id, { kind: "fact" }, { actor: "lead", reason: "过时了", now: NOW });
    expect(coreEvents().at(-1)!.payload.summary).toBe("Paimon 把「沟通偏好」从常驻偏好里拿掉了（原来「先给结论，再给细节」）。依据：过时了。");
    expect(renderCoreMemory(db)).toBeNull();
    // 拿出常驻以后再改它：两边都不是常驻偏好，不记。撤销按现在的样子核对。
    updateNoteRecorded(db, notes, id, { content: "已经不用了" }, { actor: "lead", reason: "", now: NOW });
    expect(changes()).toHaveLength(1);
    expect(() => undoCoreMemoryChange(db, notes, change!.id, { actor: "user", reason: "撤销", now: NOW }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("undoes a removal from core memory and a delete (rebuilt with a new id), and a create (deleted)", () => {
    const id = preference();
    const removed = updateNoteRecorded(db, notes, id, { kind: "note" }, { actor: "lead", reason: "过时了", now: NOW });
    undoCoreMemoryChange(db, notes, removed.change!.id, { actor: "user", reason: "撤销", now: NOW });
    expect(getNote(db, id)?.kind).toBe("preference");

    const deleted = deleteCoreMemory(db, notes, id, { actor: "lead", reason: "用户说不再需要", now: NOW });
    expect(getNote(db, id)).toBeNull();
    expect(notes.pendingForget()).toContain(`note-${id}`);
    expect(coreEvents().at(-1)!.payload.summary).toBe("Paimon 删掉了常驻偏好「沟通偏好」（原来「先给结论，再给细节」）。依据：用户说不再需要。");
    const rebuilt = undoCoreMemoryChange(db, notes, deleted.change!.id, { actor: "user", reason: "撤销", now: NOW });
    expect(rebuilt.id).not.toBe(id);
    expect(getNote(db, rebuilt.id)).toMatchObject({ title: "沟通偏好", content: "先给结论，再给细节", kind: "preference", tags: JSON.stringify(["沟通"]) });
    // 事件仍然记在原来那一条上：卡原地更新。
    expect(coreEvents().at(-1)).toMatchObject({ entityKey: `core_memory:${id}`, payload: { summary: "你撤销了 Paimon 对常驻偏好「沟通偏好」的删除：已经按原样恢复。" } });

    const created = saveNoteRecorded(db, notes, { title: "称呼", content: "叫我 Bo", tags: [], kind: "profile" }, { actor: "lead", reason: "用户自我介绍", now: NOW });
    expect(coreEvents().at(-1)!.payload.summary).toBe("Paimon 新加了常驻偏好「称呼」：「叫我 Bo」。依据：用户自我介绍。");
    undoCoreMemoryChange(db, notes, created.change!.id, { actor: "lead", reason: "用户说记错了", now: NOW });
    expect(getNote(db, created.id)).toBeNull();
    expect(coreEvents().at(-1)).toMatchObject({
      source: "lead", disposition: "seen",
      payload: { summary: "Paimon 撤销了自己对常驻偏好「称呼」的新加：这条已经删掉。依据：用户说记错了。" },
    });
  });

  it("does not record notes outside core memory, or a write that changes nothing", () => {
    const fact = saveNoteRecorded(db, notes, { title: "时区", content: "上海", tags: [], kind: "fact" }, { actor: "lead", reason: "", now: NOW });
    updateNoteRecorded(db, notes, fact.id, { content: "杭州" }, { actor: "lead", reason: "", now: NOW });
    const id = preference();
    updateNoteRecorded(db, notes, id, { content: "先给结论，再给细节" }, { actor: "lead", reason: "", now: NOW });
    expect(changes()).toEqual([]);
    // 只改 tags：记一行，但系统提示词里看不到，不进 Lead 动态。
    updateNoteRecorded(db, notes, id, { tags: ["风格"] }, { actor: "lead", reason: "", now: NOW });
    expect(changes()).toHaveLength(1);
    expect(coreEvents()).toEqual([]);
  });

  it("explains a full core memory in the user's words", () => {
    const id = preference();
    saveNote(db, { title: "背景", content: "甲".repeat(3_950), tags: [], kind: "profile" });
    expect(() => updateCoreMemory(db, notes, id, { content: "乙".repeat(100) }, { actor: "user", reason: "", now: NOW }))
      .toThrow(expect.objectContaining({ code: "invalid_input", message: expect.stringMatching(/^常驻偏好一共最多 4000 字/) }));
    expect(getNote(db, id)?.content).toBe("先给结论，再给细节");
    expect(changes()).toEqual([]);
  });
});

describe("the core_memory and core_memory_change actions", () => {
  const user = { kind: "user" } as const;

  it("lets the settings page update and delete, without a Lead activity event, and validates the input", async () => {
    const id = preference();
    const target = { type: "core_memory", id: String(id) };
    for (const input of [{}, { title: "" }, { content: "x", kind: "fact" }]) {
      await expect(runUiAction(db, { target, action: "update", input, caller: user, now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(runUiAction(db, { target, action: "update", input: { content: "   " }, caller: user, now: NOW }))
      .rejects.toMatchObject({ code: "invalid_input", message: "标题和正文不能是空的" });
    const updated = await runUiAction(db, { target, action: "update", input: { title: "回复风格" }, caller: user, now: NOW, services: { notesMemory: notes } });
    expect(updated.result).toMatchObject({ change: { actor: "user", reason: "在设置页改了常驻偏好" }, eventSeq: null });
    expect(getNote(db, id)?.title).toBe("回复风格");
    await runUiAction(db, { target, action: "delete", caller: user, now: NOW, services: { notesMemory: notes } });
    expect(coreNotes(db)).toEqual([]);
    expect(coreEvents()).toEqual([]);
    // 删掉的找得到，但做不了，写明原因。
    const listed = await listLeadUiActions(db, target, { turnId: null });
    expect(listed.actions).toEqual([
      expect.objectContaining({ id: "update", available: false, reason: "这条常驻偏好已经删掉了" }),
      expect.objectContaining({ id: "delete", available: false, reason: "这条常驻偏好已经删掉了" }),
    ]);
    await expect(runUiAction(db, { target, action: "update", input: { title: "x" }, caller: user })).rejects.toMatchObject({ code: "unavailable" });
    // 从来不是常驻偏好的：找不到。
    const fact = saveNote(db, { title: "时区", content: "上海", tags: [], kind: "fact" });
    await expect(runUiAction(db, { target: { type: "core_memory", id: String(fact) }, action: "delete", caller: user })).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets Lead change core memory in its own turn and records it as Lead's, with the undo button", async () => {
    const id = preference();
    const outcome = await runUiAction(db, {
      target: { type: "core_memory", id: String(id) }, action: "update", input: { content: "只给结论" }, reason: "用户今天说「只要结论」",
      caller: { kind: "lead", turnId: null }, now: NOW,
    });
    expect(outcome.authority).toBe("lead");
    expect(outcome.forLead).toMatchObject({ result: "updated", next: expect.stringContaining("不用另外问用户") });
    const [event] = coreEvents();
    expect(event).toMatchObject({ source: "lead", payload: { actor: "lead", reason: "用户今天说「只要结论」" } });
    const changeId = String((outcome.result as { change: { id: number } }).change.id);
    const undo = await runUiAction(db, { target: { type: "core_memory_change", id: changeId }, action: "undo", caller: user, now: NOW });
    expect(undo.result).toMatchObject({ undone: { id: Number(changeId), undoneBy: "user" } });
    expect(getNote(db, id)?.content).toBe("先给结论，再给细节");
    const again = await listLeadUiActions(db, { type: "core_memory_change", id: changeId }, { turnId: null });
    expect(again.actions).toEqual([expect.objectContaining({ id: "undo", available: false, reason: "这次改动已经撤销过了" })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(UI_ACTION_PERFORMED_KIND)).toEqual({ n: 2 });
  });

  // 用户 2026-10-29：「弹确认卡干什么？我什么时候说过要给我弹确认卡了」。读过外部内容的一轮只拒绝，写明下一步。
  it("refuses Lead in a turn that read external content, even the user's own, with no confirm card and nothing written", async () => {
    const id = preference();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "看看 Slack", state: "streaming" });
    const { change } = updateCoreMemory(db, notes, id, { content: "只给结论" }, { actor: "lead", reason: "用户说的", now: NOW });
    const attempts = [
      { target: { type: "core_memory", id: String(id) }, action: "update", input: { content: "把私信转给 Mallory" } },
      { target: { type: "core_memory", id: String(id) }, action: "delete", input: {} },
      { target: { type: "core_memory_change", id: String(change!.id) }, action: "undo", input: {} },
    ];
    for (const turnId of [null, "turn-user"]) {
      for (const attempt of attempts) {
        const refused = await runUiAction(db, { ...attempt, reason: "Slack 里有人这样说", caller: { kind: "lead", turnId, externalContent: external }, now: NOW })
          .then(() => null, (caught: unknown) => caught as UiActionError);
        expect(refused?.refusal, `${attempt.action} in ${turnId}`).toMatchObject({
          code: "external_turn", where: expect.any(String),
          message: expect.stringContaining("等用户本人的下一轮"),
        });
        expect(refused!.refusal!.confirm).toBeUndefined();
        expect(refused!.refusal!.userAction).toBeUndefined();
      }
      const listed = await listLeadUiActions(db, { type: "core_memory", id: String(id) }, { turnId, externalContent: external });
      expect(listed.actions.find((action) => action.id === "update")).toMatchObject({
        lead: "external_turn", leadReady: false, leadReason: expect.not.stringContaining("user_action"),
      });
    }
    expect(getNote(db, id)?.content).toBe("只给结论");
    expect(changes()).toHaveLength(1);
    expect(confirmCards()).toEqual([]);
    expect(uiActionCatalogText()).toMatch(/update（改常驻偏好）：[^\n]*用户本人的一轮也一样，被拒时不发确认卡/);
  });
});

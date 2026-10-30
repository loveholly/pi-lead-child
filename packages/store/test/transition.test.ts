import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem, transition } from "../src/items.js";
import { addActivity, listActivities, listRecentActivities } from "../src/activities.js";

let db: Db;
let id: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  // 本文件走的是完整生命周期，起点是 draft，所以显式 hold——生于 draft 不再是缺省。
  id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
});

describe("transition state machine", () => {
  it("follows the happy path and records transition activities", () => {
    // 确认（draft -> ready）只有 user 做得到；lead 不再有"替用户开跑"的边（spec §6.4）。
    transition(db, { itemId: id, to: "ready", actor: "user", reason: "confirm" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "agent_start" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "完成" });
    transition(db, { itemId: id, to: "done", actor: "user", reason: "验收通过" });
    expect(getItem(db, id)!.stage).toBe("done");
    const acts = listActivities(db, id).filter((a) => a.kind === "transition");
    expect(acts.length).toBe(4);
    expect(JSON.parse(acts[0].payload)).toMatchObject({ from: "draft", to: "ready" });
  });

  it("rejects illegal edges regardless of actor", () => {
    expect(() => transition(db, { itemId: id, to: "done", actor: "user", reason: "" }))
      .toThrow(/draft.*done/);
  });

  it("blocks child from privileged transitions", () => {
    transition(db, { itemId: id, to: "ready", actor: "user", reason: "" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    expect(() => transition(db, { itemId: id, to: "done", actor: "child", reason: "" }))
      .toThrow(/actor 'child'/);
  });

  it("allows child blocked round-trip only from active", () => {
    transition(db, { itemId: id, to: "ready", actor: "user", reason: "" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "blocked", actor: "child", reason: "需要决策" });
    transition(db, { itemId: id, to: "active", actor: "child", reason: "已解答" });
    expect(getItem(db, id)!.stage).toBe("active");
  });
});

// 工单操作层（工单详情 03）：Lead 在用户这一轮里代用户确认开跑。权限按用户查，账本写 actor=lead 和代谁、凭哪一轮，
// 不写成 actor=user。
describe("a transition on behalf of the user", () => {
  it("checks the user's edge but records lead, the principal and the turn", () => {
    transition(db, {
      itemId: id, to: "ready", actor: "lead", reason: "user asked in chat",
      onBehalfOf: { actor: "user", sourceTurnId: "turn-1" },
    });
    expect(getItem(db, id)!.stage).toBe("ready");
    const [act] = listActivities(db, id).filter((a) => a.kind === "transition");
    expect(act!.actor).toBe("lead");
    expect(JSON.parse(act!.payload)).toEqual({
      from: "draft", to: "ready", reason: "user asked in chat", onBehalfOf: "user", sourceTurnId: "turn-1",
    });
    const event = db.prepare("SELECT payload FROM events WHERE kind='stage.changed' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ actor: "lead", onBehalfOf: "user", sourceTurnId: "turn-1" });
  });

  // 2026-10-28：draft -> ready 也给 lead（用户：「工单操作让 Lead 自己判断」）。child 仍然不能，也不能冒充用户。
  it("refuses child on its own, and refuses a principal for anyone but lead", () => {
    expect(() => transition(db, { itemId: id, to: "ready", actor: "child", reason: "" }))
      .toThrow(/actor 'child' may not transition draft -> ready/);
    expect(() => transition(db, {
      itemId: id, to: "ready", actor: "child", reason: "", onBehalfOf: { actor: "user", sourceTurnId: "turn-1" },
    })).toThrow(/only lead acts on behalf of the user/);
    expect(getItem(db, id)!.stage).toBe("draft");
  });
});

// 工单 03：Lead 的 get_ticket 要最近的活动。以前取的是最早 1000 条里的最后 20 条。
describe("recent activities", () => {
  it("returns the newest ones, oldest first", () => {
    for (let i = 0; i < 30; i += 1) addActivity(db, { itemId: id, actor: "system", kind: "comment", payload: { i } });
    const recent = listRecentActivities(db, id, 5);
    expect(recent.map((activity) => JSON.parse(activity.payload).i)).toEqual([25, 26, 27, 28, 29]);
  });

  // 工单 07：打开文件每次都写一条 delivery_file_opened。get_ticket 跳过它们，它们再多也挤不掉别的活动。
  it("skips the given decisions in SQL, and keeps rows whose payload is not JSON", () => {
    addActivity(db, { itemId: id, actor: "system", kind: "decision", payload: { decision: "workspace_integrated", i: 1 } });
    db.prepare("INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'system', 'decision', 'not json')").run(id);
    for (let i = 0; i < 10; i += 1) {
      addActivity(db, { itemId: id, actor: "user", kind: "decision", payload: { decision: "delivery_file_opened", i } });
    }
    const recent = listRecentActivities(db, id, 2, { skipDecisions: ["delivery_file_opened"] });
    expect(recent.map((activity) => activity.payload)).toEqual([
      JSON.stringify({ decision: "workspace_integrated", i: 1 }), "not json",
    ]);
  });
});

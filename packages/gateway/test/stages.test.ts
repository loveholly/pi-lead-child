import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { canTransition, allowedNext } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, listItems, transition } from "@pi-lead-child/store";
import {
  REMINDER_STAGE_EDGES,
  TASK_STAGE_EDGES,
  USER_ITEM_ACTION_EDGES,
  USER_ITEM_ACTION_IDS,
  userItemActionsFor,
} from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { USER_ITEM_ACTIONS } from "../src/user-actions.js";

describe("task stage machine", () => {
  // 2026-10-28（用户：「工单操作让 Lead 自己判断」）：lead 也能确认开跑。system 和 child 仍然不能。
  it("allows user and lead to confirm draft -> ready", () => {
    expect(canTransition("task", "draft", "ready", "user")).toBe(true);
    expect(canTransition("task", "draft", "ready", "lead")).toBe(true);
    expect(canTransition("task", "draft", "ready", "system")).toBe(false);
    expect(canTransition("task", "draft", "ready", "child")).toBe(false);
  });

  // 停下整张工单是 lead_allowed（用户 2026-10-22，ui-action-parity plan.md P03）。system 和 child 仍然不能。
  it("lets user and lead stop active/blocked -> ready", () => {
    expect(canTransition("task", "active", "ready", "user")).toBe(true);
    expect(canTransition("task", "active", "ready", "lead")).toBe(true);
    expect(canTransition("task", "blocked", "ready", "lead")).toBe(true);
    expect(canTransition("task", "active", "ready", "system")).toBe(false);
    expect(canTransition("task", "active", "ready", "child")).toBe(false);
  });

  it("lets user reach active from blocked so the run gate is reachable", () => {
    expect(canTransition("task", "blocked", "active", "user")).toBe(true);
    expect(canTransition("task", "blocked", "active", "system")).toBe(true);
    expect(canTransition("task", "blocked", "active", "child")).toBe(true);
  });

  it("lets lead cancel, confirm, accept and send back for rework", () => {
    expect(canTransition("task", "ready", "cancelled", "lead")).toBe(true);
    expect(canTransition("task", "draft", "ready", "lead")).toBe(true);
    expect(canTransition("task", "review", "done", "lead")).toBe(true);
    expect(canTransition("task", "review", "active", "lead")).toBe(true);
    // 事实的更正仍然只有 system。
    expect(canTransition("task", "review", "blocked", "lead")).toBe(false);
    expect(canTransition("task", "done", "review", "lead")).toBe(false);
  });

  it("rejects edges absent from the machine", () => {
    expect(canTransition("task", "draft", "active", "user")).toBe(false);
    expect(canTransition("task", "done", "review", "user")).toBe(false);
  });

  // 以前丢弃等验收的成果只给 user（lead 曾在「终止所有任务」时取消了三张在 review 的工单）。2026-10-28 起由 Lead 判断，
  // 提示词写明「终止任务」不等于丢弃已经交付的成果。
  it("lets lead discard work awaiting acceptance on its own judgment", () => {
    expect(canTransition("task", "review", "cancelled", "user")).toBe(true);
    expect(canTransition("task", "review", "cancelled", "lead")).toBe(true);
    for (const from of ["draft", "ready", "active", "blocked"] as const) {
      expect(canTransition("task", from, "cancelled", "lead")).toBe(true);
    }
  });
});

describe("reminder stage machine", () => {
  it("only system may fire", () => {
    expect(canTransition("reminder", "scheduled", "fired", "system")).toBe(true);
    expect(canTransition("reminder", "scheduled", "fired", "user")).toBe(false);
  });

  it("user and lead may ack", () => {
    expect(canTransition("reminder", "fired", "acked", "user")).toBe(true);
    expect(canTransition("reminder", "fired", "acked", "lead")).toBe(true);
    expect(canTransition("reminder", "fired", "acked", "system")).toBe(false);
  });

  it("does not share the task enum", () => {
    expect(canTransition("reminder", "scheduled", "ready", "user")).toBe(false);
    expect(allowedNext("reminder", "acked")).toEqual([]);
  });
});

// 动作表是权限矩阵的投影，不是它的第二份拷贝。这一组断言把"投影"这件事变成可执行的：
// 矩阵增删任何一条 actor='user' 的边，而 USER_ITEM_ACTION_EDGES 没跟着改，这里就会红。
// 没有这层，companion 的动作行迟早会摆出一个点下去 403 的按钮，或者漏掉一条用户唯一
// 能走的边——诉求 1 里"用户被自己的闸门锁在外面"正是后者。
describe("user action table mirrors the actor matrix", () => {
  const userEdgesOf = (table: Record<string, string[] | undefined>) =>
    Object.entries(table)
      .filter(([, actors]) => actors!.includes("user"))
      .map(([edge]) => edge)
      .sort();

  const actionEdgesOf = (kind: "task" | "reminder") =>
    USER_ITEM_ACTION_EDGES
      .filter((edge) => edge.kind === kind)
      .flatMap((edge) => edge.from.map((from) => `${from}->${edge.to}`))
      .sort();

  it("covers every user edge of the task machine exactly once", () => {
    expect(actionEdgesOf("task")).toEqual(userEdgesOf(TASK_STAGE_EDGES));
  });

  it("covers every user edge of the reminder machine exactly once", () => {
    expect(actionEdgesOf("reminder")).toEqual(userEdgesOf(REMINDER_STAGE_EDGES));
  });

  it("offers no action the matrix would reject", () => {
    for (const edge of USER_ITEM_ACTION_EDGES) {
      for (const from of edge.from) {
        expect(canTransition(edge.kind, from, edge.to, "user")).toBe(true);
      }
    }
  });

  it("keeps the control-plane whitelist and the action ids the same set", () => {
    expect([...USER_ITEM_ACTIONS].sort()).toEqual([...USER_ITEM_ACTION_IDS].sort());
    expect(new Set(USER_ITEM_ACTION_EDGES.map((edge) => edge.id)))
      .toEqual(new Set(USER_ITEM_ACTION_IDS));
  });

  it("offers the confirm-first set on a held root and nothing illegal elsewhere", () => {
    expect(userItemActionsFor("task", "draft")).toEqual(["confirm", "cancel"]);
    expect(userItemActionsFor("task", "ready")).toEqual(["start", "unconfirm", "cancel"]);
    expect(userItemActionsFor("task", "active")).toEqual(["stop", "cancel"]);
    expect(userItemActionsFor("task", "review")).toEqual(["complete", "rework", "cancel"]);
    expect(userItemActionsFor("task", "done")).toEqual(["rework"]);
    expect(userItemActionsFor("reminder", "fired")).toEqual(["ack", "cancel"]);
    expect(userItemActionsFor("reminder", "acked")).toEqual([]);
  });
});

describe("transition wiring", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(tempDir("plc-"), "plc.db"));
  });

  it("creates a held user task in draft", () => {
    // draft 现在是 hold 的产物，不是缺省；缺省那条（生于 ready）由 item-hold 覆盖。
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    expect(getItem(db, id)!.stage).toBe("draft");
    expect(getItem(db, id)!.kind).toBe("task");
  });

  it("refuses child confirming draft -> ready", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    expect(() => transition(db, { itemId: id, to: "ready", actor: "child", reason: "r" }))
      .toThrow(/actor 'child' may not transition draft -> ready/);
  });

  it("accepts user confirming draft -> ready", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    transition(db, { itemId: id, to: "ready", actor: "user", reason: "go" });
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  it("uses the reminder machine for reminders", () => {
    const id = createItem(db, {
      title: "r", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(getItem(db, id)!.stage).toBe("scheduled");
    transition(db, { itemId: id, to: "fired", actor: "system", reason: "due" });
    transition(db, { itemId: id, to: "acked", actor: "user", reason: "seen" });
    expect(getItem(db, id)!.stage).toBe("acked");
  });
});

describe("default views", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(tempDir("plc-"), "plc.db"));
  });

  it("excludes reminders, drafts, terminals and deferred items from the task view", () => {
    const active = createItem(db, { title: "active", brief: "b", createdBy: "system" });
    createItem(db, { title: "draft", brief: "b", createdBy: "user", hold: true });
    createItem(db, {
      title: "rem", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    createItem(db, {
      title: "later", brief: "b", createdBy: "system", deferUntil: "2099-01-01T00:00:00.000Z",
    });
    const titles = listItems(db, { view: "tasks", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title);
    expect(titles).toEqual(["active"]);
    expect(getItem(db, active)!.stage).toBe("ready");
  });

  it("surfaces drafts in their own view", () => {
    createItem(db, { title: "draft", brief: "b", createdBy: "user", hold: true });
    expect(listItems(db, { view: "drafts", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title)).toEqual(["draft"]);
  });

  it("lists scheduled and fired reminders", () => {
    createItem(db, {
      title: "rem", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(listItems(db, { view: "reminders", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title)).toEqual(["rem"]);
  });
});

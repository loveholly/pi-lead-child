// 投影层的 item 语义（spec §9/§11）：kind / stage / 派生 hasRun，以及"没有 Run 就不投
// 执行面板"这条规则的数据基础。UI 的可见性由 hasRun 驱动（companion 侧的 visibleTicketTabs），
// 这里保证那个字段是可信的。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  TicketSummarySchema,
  KernelTicketWorkItemListResponseSchema,
  KernelTicketWorkItemV2ListResponseSchema,
} from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { createRun } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-item-projection-"), "plc.db"));
});

function service() {
  return createControlPlaneService(db, {
    runtime: () => ({
      model: "stub/model", sessionId: "stub-session", busy: false,
      runningItemIds: [], aish: null,
    }),
    now: () => new Date("2026-07-27T10:00:00.000Z"),
  });
}

function summaryOf(itemId: number) {
  const detail = service().getItem(itemId);
  if (!detail) throw new Error(`item #${itemId} has no detail`);
  // TicketDetail 是线上 DTO，摘要仍挂在 ticket 键上。
  return detail.ticket;
}

describe("item projection", () => {
  it("exposes kind and stage on the item projection", () => {
    const reminderId = createItem(db, {
      kind: "reminder", title: "交周报", brief: "", createdBy: "lead",
      remindAt: "2026-08-01T07:00:00.000Z",
    });
    const s = summaryOf(reminderId);
    expect(s.kind).toBe("reminder");
    expect(s.stage).toBe("scheduled");
    // status 保留是为了不一次性打断 companion，值与 stage 相同（deprecated）。
    expect(s.status).toBe("scheduled");
    expect(Value.Check(TicketSummarySchema, s)).toBe(true);
  });

  it("exposes kind=task and the defer_until it was given", () => {
    const taskId = createItem(db, {
      title: "重构 X", brief: "b", createdBy: "lead", deferUntil: "2026-09-01T00:00:00.000Z",
    });
    const s = summaryOf(taskId);
    expect(s.kind).toBe("task");
    expect(s.stage).toBe("ready"); // 不 hold 就生于 ready；这里关心的是 kind 与 deferUntil
    expect(s.deferUntil).toBe("2026-09-01T00:00:00.000Z");
  });

  // 这一条是 UI 规则的数据基础：没有 Run 就没有执行面板（spec §11）。
  it("reports hasRun=false for a task that has never run", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    expect(summaryOf(id).hasRun).toBe(false);
  });

  it("reports hasRun=false for a reminder", () => {
    const id = createItem(db, {
      kind: "reminder", title: "r", brief: "", createdBy: "lead",
      remindAt: "2026-08-01T07:00:00.000Z",
    });
    expect(summaryOf(id).hasRun).toBe(false);
  });

  it("reports hasRun=true once a run exists", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    expect(summaryOf(id).hasRun).toBe(false);
    createRun(db, { itemId: id, role: "executor" });
    expect(summaryOf(id).hasRun).toBe(true);
  });

  // hasRun 是派生的，不落库：items 表不该多一列去记"有没有 Run"，那种冗余迟早和
  // runs 表不一致，而不一致的那一刻没有任何东西会报错。
  it("derives hasRun instead of storing it", () => {
    const columns = (db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).not.toContain("has_run");
    expect(columns).not.toContain("hasRun");
  });

  it("still reports hasRun=true after the run has ended", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId: id, role: "executor" });
    db.prepare("UPDATE runs SET state='finished', ended_at=? WHERE id=?")
      .run("2026-07-27T09:00:00.000Z", runId);
    // 跑过就是跑过：执行面板要能回看历史，不是只在跑的时候才有。
    expect(summaryOf(id).hasRun).toBe(true);
  });
});

// 诉求 2：提醒不显示执行细节。空数组会被读成"有这类东西，只是现在为空"，
// 所以字段必须整个缺席，而不是投一个空壳。
describe("work item projection omits execution surfaces without a run", () => {
  it("omits timing entirely for a reminder", () => {
    const id = createItem(db, {
      kind: "reminder", title: "r", brief: "", createdBy: "lead",
      remindAt: "2026-08-01T07:00:00.000Z",
    });
    const items = service().listKernelWorkItems([id]);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("timing");
    expect(JSON.stringify(items[0])).not.toContain("timing");
    expect(Value.Check(KernelTicketWorkItemListResponseSchema, { items })).toBe(true);
  });

  it("omits timing for a confirmed task that has never started", () => {
    // lead 建时 hold 住停在 draft，用户确认后到 ready——确认过但一次都没跑，同样什么执行
    // 细节都没有。这正是"判据是 hasRun 而不是 kind==='task'"的那个例子。
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead", hold: true });
    transition(db, { itemId: id, to: "ready", actor: "user", reason: "confirmed" });
    const items = service().listKernelWorkItems([id]);
    expect(items[0]).not.toHaveProperty("timing");
  });

  it("includes timing once a run exists", () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    createRun(db, { itemId: id, role: "executor" });
    const items = service().listKernelWorkItems([id]);
    expect(items[0]).toHaveProperty("timing");
    expect(items[0]!.timing).toMatchObject({ computedAt: "2026-07-27T10:00:00.000Z" });
  });

  it("omits timing on the v2 work item for a reminder", () => {
    const id = createItem(db, {
      kind: "reminder", title: "r", brief: "", createdBy: "lead",
      remindAt: "2026-08-01T07:00:00.000Z",
    });
    const items = service().listKernelWorkItemsV2([id]);
    expect(items[0]).not.toHaveProperty("timing");
    expect(Value.Check(KernelTicketWorkItemV2ListResponseSchema, { items })).toBe(true);
  });

  it("omits timing, checkpoints and pow on the workbench for a reminder", () => {
    const id = createItem(db, {
      kind: "reminder", title: "r", brief: "", createdBy: "lead",
      remindAt: "2026-08-01T07:00:00.000Z",
    });
    const bench = service().getKernelTicketWorkbench(id)!;
    expect(bench).not.toHaveProperty("timing");
    expect(bench).not.toHaveProperty("latestCheckpoints");
    const benchV2 = service().getKernelTicketWorkbenchV2(id)!;
    expect(benchV2).not.toHaveProperty("timing");
    expect(benchV2).not.toHaveProperty("latestCheckpoints");
    expect(benchV2).not.toHaveProperty("pow");
  });
});

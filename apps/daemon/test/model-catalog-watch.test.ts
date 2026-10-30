// 模型目录自动刷新（2026-10-15 用户决定）：定时刷新；Run 因为模型或配置失败以后马上刷新。
// 目录变了就给 Lead 一条说明：它的工具描述里的目录摘要是会话开始时的。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { setModelCatalogForTesting } from "@pi-lead-child/engine";
import { runtimeAdapter, typedFailure, type RuntimeEvent } from "@pi-lead-child/runtime";
import {
  inboxWakesLead, listEvents, listInbox, openDb, recordStandingOrderVersion, SYSTEM_STANDING_ORDERS,
} from "@pi-lead-child/store";

import { startModelCatalogWatch } from "../src/model-catalog-watch.js";

const adapters = (["codex", "claude", "pi"] as const).map((id) => runtimeAdapter(id) as { discoverModels?: unknown });
const originals = adapters.map((adapter) => adapter.discoverModels);

afterEach(() => {
  adapters.forEach((adapter, index) => { adapter.discoverModels = originals[index]; });
  setModelCatalogForTesting(null);
  vi.useRealTimers();
});

function codexModels(ids: string[]) {
  return async () => ({
    ok: true, source: "codex debug models", account: "Codex 内置的订阅账号", freeformModelPattern: null,
    cliDefaultModel: ids[0] ?? null, efforts: ["high"],
    models: ids.map((id) => ({ id, label: id, efforts: ["high"], defaultEffort: null, note: null })),
  });
}

function failed(code: Parameters<typeof typedFailure>[0]): RuntimeEvent {
  return {
    type: "run.failed", runId: 7, seq: 2, occurredAt: "2026-10-15T05:00:00.000Z", exitCode: 1, errorCode: "codex_error",
    error: "rejected", failure: typedFailure(code, { errorCode: "codex_error", message: "rejected" }),
  } as RuntimeEvent;
}

describe("the model catalog watch", () => {
  it("refreshes right after a run fails on its model, and tells Lead what changed", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    let calls = 0;
    adapters[0]!.discoverModels = async (...args: unknown[]) => {
      calls++;
      return codexModels(calls === 1 ? ["gpt-6.1-sol"] : ["gpt-6.2-sol", "gpt-6.1-sol"])(...(args as []));
    };
    adapters[1]!.discoverModels = undefined;
    adapters[2]!.discoverModels = undefined;
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    // 第一次（daemon 启动）：Lead 的工具描述在这之后才生成，不用另写说明。
    await watch.refresh("daemon 启动", { announce: false });
    expect(listInbox(db, {}).length).toBe(0);

    // 任务失败不刷新；模型被拒马上刷新。
    await watch.onRunEvent(failed("task_failed"));
    expect(calls).toBe(1);
    await watch.onRunEvent(failed("model_unsupported"));
    expect(calls).toBe(2);
    // 去抖（工单 14）：新目录要连续两次刷新相同才算变化。下一次定时刷新确认了它。
    expect(listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "model_catalog_changed")).toHaveLength(0);
    await watch.refresh("定时");
    expect(calls).toBe(3);
    const notes = listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "model_catalog_changed");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: "attention" });
    expect(notes[0]!.summary).toContain("codex：新增 gpt-6.2-sol；CLI 默认 gpt-6.1-sol → gpt-6.2-sol");
    expect(notes[0]!.summary).toContain("get_model_catalog");
    // 依据：常设指令 model_catalog.announce 的第 1 版。说明不叫醒 Lead，进摘要。
    expect(JSON.parse(notes[0]!.payload).standingOrder).toEqual({ id: "model_catalog.announce", version: 1 });
    expect(inboxWakesLead(notes[0]!, db)).toBe(false);
    expect(listEvents(db, { kind: "inbox.attention" })[0]).toMatchObject({
      level: "digest", triage: { order: { id: "model_catalog.announce", version: 1 } },
    });

    // 没有变化时不写说明。
    await watch.refresh("定时");
    expect(listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "model_catalog_changed")).toHaveLength(1);
    watch.stop();
    db.close();
  });

  it("refreshes on a timer", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    let calls = 0;
    adapters[0]!.discoverModels = async (...args: unknown[]) => { calls++; return codexModels(["gpt-6.1-sol"])(...(args as [])); };
    adapters[1]!.discoverModels = undefined;
    adapters[2]!.discoverModels = undefined;
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 50 });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    watch.stop();
    db.close();
  });
});

// 工单 14 第 1 项：模型目录去抖。2026-10-16 一天抖动 6 次：一次刷新的结果变了，下一次又变回去，每次都给 Lead 写一条说明。
// 现在连续 stableRefreshes 次（种子是 2 次）刷新的结果相同，才算一次变化，才写说明。
describe("the model catalog watch waits for the catalog to settle", () => {
  const catalogNotes = (db: ReturnType<typeof openDb>) =>
    listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "model_catalog_changed");

  function sequence(lists: string[][]) {
    let calls = 0;
    adapters[0]!.discoverModels = async (...args: unknown[]) => {
      const ids = lists[Math.min(calls, lists.length - 1)]!;
      calls++;
      return codexModels(ids)(...(args as []));
    };
    adapters[1]!.discoverModels = undefined;
    adapters[2]!.discoverModels = undefined;
    return { calls: () => calls };
  }

  it("does not tell Lead about a refresh that flapped and came straight back", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    sequence([["gpt-6.1-sol"], ["gpt-6.2-sol"], ["gpt-6.1-sol"], ["gpt-6.1-sol"]]);
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    await watch.refresh("daemon 启动", { announce: false });
    // 抖了一次：gpt-6.2-sol 出现了。
    await watch.refresh("定时");
    // 下一次又变回去。
    await watch.refresh("定时");
    await watch.refresh("定时");
    expect(catalogNotes(db)).toHaveLength(0);
    watch.stop();
    db.close();
  });

  it("tells Lead once the new catalog came back the same on two refreshes in a row", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    sequence([["gpt-6.1-sol"], ["gpt-6.2-sol", "gpt-6.1-sol"], ["gpt-6.2-sol", "gpt-6.1-sol"], ["gpt-6.2-sol", "gpt-6.1-sol"]]);
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    await watch.refresh("daemon 启动", { announce: false });
    await watch.refresh("定时");
    expect(catalogNotes(db)).toHaveLength(0);
    await watch.refresh("定时");
    const notes = catalogNotes(db);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toContain("codex：新增 gpt-6.2-sol");
    expect(JSON.parse(notes[0]!.payload).standingOrder).toEqual({ id: "model_catalog.announce", version: 1 });
    // 已经说过的目录不再说。
    await watch.refresh("定时");
    expect(catalogNotes(db)).toHaveLength(1);
    watch.stop();
    db.close();
  });

  it("counts two callers that share one refresh as one refresh", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    const discovery = sequence([["gpt-6.1-sol"], ["gpt-6.2-sol"], ["gpt-6.1-sol"]]);
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    await watch.refresh("daemon 启动", { announce: false });
    // 定时刷新和失败后的刷新同时发生，共用 engine 的同一次刷新（refreshModelCatalog）：这只是一次结果。
    await Promise.all([watch.refresh("定时"), watch.onRunEvent(failed("model_unsupported"))]);
    expect(discovery.calls()).toBe(2);
    expect(catalogNotes(db)).toHaveLength(0);
    watch.stop();
    db.close();
  });

  it("tells Lead on the first changed refresh when a standing order version says stableRefreshes is 1", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    const announce = SYSTEM_STANDING_ORDERS.find((order) => order.id === "model_catalog.announce")!;
    recordStandingOrderVersion(db, {
      ...announce,
      action: {
        type: "rule", rule: "model_catalog.announce", level: "digest",
        params: { announceFirstRefresh: false, refreshOnFailureScopes: ["runtime", "account"], wakeLead: false, stableRefreshes: 1 },
      },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    sequence([["gpt-6.1-sol"], ["gpt-6.2-sol"], ["gpt-6.1-sol"]]);
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    await watch.refresh("daemon 启动", { announce: false });
    await watch.refresh("定时");
    await watch.refresh("定时");
    expect(catalogNotes(db).map((row) => JSON.parse(row.payload).changes)).toEqual([
      ["codex：新增 gpt-6.2-sol；移除 gpt-6.1-sol；CLI 默认 gpt-6.1-sol → gpt-6.2-sol"],
      ["codex：新增 gpt-6.1-sol；移除 gpt-6.2-sol；CLI 默认 gpt-6.2-sol → gpt-6.1-sol"],
    ]);
    expect(JSON.parse(catalogNotes(db)[0]!.payload).standingOrder).toEqual({ id: "model_catalog.announce", version: 2 });
    watch.stop();
    db.close();
  });
});

// 常设指令 model_catalog.announce（工单 05）：上面两条测试是第一版的行为（和搬之前一样）。改一个版本，行为跟着变。
describe("the model catalog watch follows its standing order", () => {
  it("announces the first refresh, wakes Lead and refreshes on more failure scopes when a new version says so", async () => {
    setModelCatalogForTesting(null);
    const db = openDb(join(tempDir("plc-catalog-watch-"), "plc.db"));
    const announce = SYSTEM_STANDING_ORDERS.find((order) => order.id === "model_catalog.announce")!;
    recordStandingOrderVersion(db, {
      ...announce,
      action: {
        type: "rule", rule: "model_catalog.announce", level: "digest",
        params: { announceFirstRefresh: true, refreshOnFailureScopes: ["runtime", "account", "task"], wakeLead: true },
      },
      reason: "测试",
    }, { author: "user", approvedBy: "user" });
    let calls = 0;
    adapters[0]!.discoverModels = async (...args: unknown[]) => {
      calls++;
      return codexModels(calls === 1 ? ["gpt-6.1-sol"] : ["gpt-6.2-sol"])(...(args as []));
    };
    adapters[1]!.discoverModels = undefined;
    adapters[2]!.discoverModels = undefined;
    const watch = startModelCatalogWatch({ db, cwd: process.cwd(), log: () => {}, intervalMs: 0 });

    await watch.refresh("daemon 启动");
    const notes = () => listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "model_catalog_changed");
    expect(notes()).toHaveLength(1);
    expect(inboxWakesLead(notes()[0]!, db)).toBe(true);
    // 要叫醒 Lead 的说明被分诊成 tell。
    expect(listEvents(db, { kind: "inbox.attention" })[0]).toMatchObject({ level: "tell", payload: { wakeLead: true } });
    await watch.onRunEvent(failed("task_failed"));
    expect(calls).toBe(2);
    expect(notes()).toHaveLength(2);
    expect(JSON.parse(notes()[1]!.payload).standingOrder).toEqual({ id: "model_catalog.announce", version: 2 });
    watch.stop();
    db.close();
  });
});

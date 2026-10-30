// 常设指令（工单 05，spec D4）：表的读写和同步、规则从指令读参数、搬之前和搬之后的对照。
//   - 对照：inbox 的合并和熔断、叫醒 Lead 的条件。搬之前的代码原样抄在测试里，同样的输入跑两遍，结果必须一样。
//   - 指令是数据：改一个版本，行为跟着变（证明代码读的是表，不是藏起来的常量）。
//   - 读不到时退回代码里的种子，依据记成第 0 版；原来的写入不回滚。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { StandingOrderDefinition } from "@pi-lead-child/protocol";
import {
  activeStandingOrders, addInbox, createItem, getStandingOrder, inboxFuseLimits, inboxWakesLead, listEvents, listInbox,
  listStandingOrders, listStandingOrderVersions, markInbox, modelCatalogAnnounceParams, openDb, recordStandingOrderVersion,
  renderStandingOrdersForLead,
  syncSystemStandingOrders, SYSTEM_STANDING_ORDERS, transientRetryDefaults, triageEvent, type Db,
  type SystemStandingOrderSeed, type TriageEnvelope,
} from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-standing-orders-"), "plc.db"));
});

const seed = (id: string): StandingOrderDefinition => {
  const found = SYSTEM_STANDING_ORDERS.find((order) => order.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the standing orders table", () => {
  it("writes a new version for every change and keeps the old ones", () => {
    const changed = recordStandingOrderVersion(db, { ...seed("inbox.fuse_blockers"), limits: { count: 5, windowMs: 3_600_000 }, reason: "测试" },
      { author: "user", approvedBy: "user" });
    expect(changed).toMatchObject({ id: "inbox.fuse_blockers", version: 2, author: "user", approvedBy: "user", status: "active" });
    expect(listStandingOrderVersions(db, "inbox.fuse_blockers").map((order) => [order.version, order.limits]))
      .toEqual([[1, { count: 3, windowMs: 3_600_000 }], [2, { count: 5, windowMs: 3_600_000 }]]);
    expect(getStandingOrder(db, "inbox.fuse_blockers")?.version).toBe(2);
    expect(getStandingOrder(db, "inbox.fuse_blockers", 1)?.limits).toEqual({ count: 3, windowMs: 3_600_000 });
  });

  it("refuses a version that does not validate, and an action outside the whitelist", () => {
    expect(() => recordStandingOrderVersion(db, { ...seed("inbox.no_wake"), action: { type: "level", level: "conversation" as never } },
      { author: "system" })).toThrow(/动作/);
    expect(() => recordStandingOrderVersion(db, {
      ...seed("inbox.merge_attention"), action: { type: "rule", rule: "delete_everything" as never, params: {} },
    }, { author: "system" })).toThrow(/白名单/);
    expect(() => recordStandingOrderVersion(db, { ...seed("run.transient_retry"), action: { type: "rule", rule: "run.transient_retry", params: { baseMs: -1, maxMs: 1 } } },
      { author: "system" })).toThrow(/参数/);
    // 定级别的指令要说清对哪些事件，空条件会把所有事件都改成同一个级别。
    expect(() => recordStandingOrderVersion(db, { ...seed("inbox.no_wake"), condition: {} }, { author: "system" })).toThrow(/kinds/);
    expect(listStandingOrderVersions(db, "inbox.no_wake")).toHaveLength(1);
  });

  it("is idempotent: opening and syncing again writes nothing", () => {
    const rows = () => db.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all();
    const before = rows();
    expect(syncSystemStandingOrders(db)).toEqual({ created: [], updated: [] });
    expect(rows()).toEqual(before);
    // 新库里每条系统指令都是第 1 版，修订号是代码里种子的修订号。
    const revisions = new Map(SYSTEM_STANDING_ORDERS.map((order) => [order.id, order.seedRevision]));
    expect(listStandingOrders(db).every((order) => order.version === 1 && order.seedRevision === revisions.get(order.id))).toBe(true);
  });

  it("lists the active orders for Lead's system prompt with their versions", () => {
    const text = renderStandingOrdersForLead(db);
    expect(text).toContain("## 常设指令");
    expect(text).toContain("propose_standing_order_change");
    expect(text).toContain("get_standing_order");
    for (const definition of SYSTEM_STANDING_ORDERS) expect(text).toContain(`- ${definition.id} v1：${definition.title}`);
  });
});

// 系统指令的同步只往前走（审查意见）：部署时新 daemon 已经启动，旧版本的进程（每个 Run 的 mcp-server、supervisor）
// 还会用 openDb 打开同一个库。旧代码不能把新代码写的版本改回去，也不能停用它不认识的新指令。
describe("syncing the system orders only moves forward", () => {
  const rows = (target: Db) => target.prepare("SELECT * FROM standing_orders ORDER BY order_id, version").all();
  // 新一版代码的种子：改了一条（修订号 2），加了一条（修订号 1）。
  const newerSeeds = (revision: number): SystemStandingOrderSeed[] => [
    ...SYSTEM_STANDING_ORDERS.filter((order) => order.id !== "notification.batchable"),
    { ...SYSTEM_STANDING_ORDERS.find((order) => order.id === "notification.batchable")!, title: `可批量的通知进摘要（第 ${revision} 版）`, seedRevision: revision },
    { ...SYSTEM_STANDING_ORDERS.find((order) => order.id === "notification.batchable")!, id: "notification.newer", title: "新代码加的指令", seedRevision: 1 },
  ];

  it("lets old code with revision 1 open a database where new code wrote revision 2, without writing anything", () => {
    const path = join(tempDir("plc-standing-orders-forward-"), "plc.db");
    const newer = openDb(path);
    expect(syncSystemStandingOrders(newer, new Date(), newerSeeds(2))).toEqual({
      created: ["notification.newer"], updated: ["notification.batchable"],
    });
    expect(getStandingOrder(newer, "notification.batchable")).toMatchObject({ version: 2, seedRevision: 2, title: "可批量的通知进摘要（第 2 版）" });
    const written = rows(newer);
    newer.close();

    // 旧代码打开：它的种子是修订号 1，内容不同，也不认识新加的那条。什么都不写。
    const older = openDb(path);
    expect(syncSystemStandingOrders(older)).toEqual({ created: [], updated: [] });
    expect(rows(older)).toEqual(written);
    expect(getStandingOrder(older, "notification.newer")).toMatchObject({ version: 1, status: "active" });
    older.close();
  });

  it("writes a new version when the code's revision is higher", () => {
    expect(syncSystemStandingOrders(db, new Date(), newerSeeds(2)).updated).toEqual(["notification.batchable"]);
    expect(syncSystemStandingOrders(db, new Date(), newerSeeds(2))).toEqual({ created: [], updated: [] });
    expect(syncSystemStandingOrders(db, new Date(), newerSeeds(3))).toEqual({ created: [], updated: ["notification.batchable"] });
    expect(listStandingOrderVersions(db, "notification.batchable").map((order) => [order.version, order.seedRevision, order.author]))
      .toEqual([[1, 1, "system"], [2, 2, "system"], [3, 3, "system"]]);
    // 停用一条系统指令：种子留着，status 写 disabled，修订号加 1。
    const retired = SYSTEM_STANDING_ORDERS.map((order) => order.id === "notification.batchable"
      ? { ...order, seedRevision: 4, status: "disabled" as const, reason: "停用" } : order);
    expect(syncSystemStandingOrders(db, new Date(), retired).updated).toEqual(["notification.batchable"]);
    expect(getStandingOrder(db, "notification.batchable")).toMatchObject({ version: 4, status: "disabled", seedRevision: 4 });
    expect(listStandingOrders(db).some((order) => order.id === "notification.batchable")).toBe(false);
  });

  it("never overwrites a version Lead or the user wrote, whatever the code's revision", () => {
    recordStandingOrderVersion(db, { ...seed("notification.immediate"), title: "用户改的标题" }, { author: "user", approvedBy: "user" });
    recordStandingOrderVersion(db, { ...seed("notification.batchable"), title: "Lead 改的标题" }, { author: "lead" });
    const seeds = SYSTEM_STANDING_ORDERS.map((order) => ({ ...order, seedRevision: 9 }));
    const result = syncSystemStandingOrders(db, new Date(), seeds);
    expect(result.updated).not.toContain("notification.immediate");
    expect(result.updated).not.toContain("notification.batchable");
    expect(getStandingOrder(db, "notification.immediate")).toMatchObject({ version: 2, title: "用户改的标题", author: "user", seedRevision: null });
    expect(getStandingOrder(db, "notification.batchable")).toMatchObject({ version: 2, title: "Lead 改的标题", author: "lead", seedRevision: null });
    // 别的系统指令照常前进。
    expect(getStandingOrder(db, "inbox.wake_lead")).toMatchObject({ version: 2, seedRevision: 9 });
  });

  // 改了种子的内容却忘了加修订号，已有的库永远收不到这次修改（同步只看修订号）。这里记着每条种子的内容指纹：
  // 内容变了，这个测试失败；改的人把修订号加 1，再把这里的值改成新的「修订号:指纹」。
  it("pins each seed's content to its revision, so a change without a new revision fails here", () => {
    const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
        : JSON.stringify(value ?? null);
    const fingerprints = Object.fromEntries(SYSTEM_STANDING_ORDERS.map(({ seedRevision, ...content }) =>
      [content.id, `${seedRevision}:${createHash("sha256").update(stable(content)).digest("hex").slice(0, 12)}`]));
    expect(fingerprints).toEqual({
      "inbox.lead_followup_set": "1:50a51d1ff861",
      "inbox.fuse_blockers": "1:e30da5f8b556",
      "inbox.wake_lead": "1:3d9033c1cda1",
      "run.transient_retry": "1:4912b3d03fd7",
      "model_catalog.announce": "2:82ccdc2316f8",
      "inbox.no_wake": "1:cc2b582a0905",
      "reminder.fire": "2:8ac79ec20429",
      "notification.immediate": "1:10faeed2a1be",
      "notification.batchable": "1:ecabcacd000d",
      "timer.lead_followup": "1:d815995986d7",
      "inbox.merge_attention": "1:c076d2988508",
      "events.merge_root_cause": "1:2947e56c3b18",
      "events.escalate_overdue": "1:82b887fd21db",
      "events.digest_batch": "1:a073e3f32892",
      "source.ticket": "1:6201a3acb91e",
      "source.run": "1:cfa448d30afb",
      "source.timer": "1:fa126e44c347",
      "source.lead": "1:18b4c46d4071",
      "source.system": "1:15e98140f65a",
      "source.external": "1:68c159b2a793",
      "triage.jev": "1:d81bb76672a7",
      "channel.authority": "1:6f297a03d6d3",
      "channel.handbook": "4:f5a1373e9469",
    });
  });

  it("keeps the seed revision to versions the system writes", () => {
    expect(() => recordStandingOrderVersion(db, seed("inbox.no_wake"), { author: "user", seedRevision: 2 })).toThrow(/修订号/);
    expect(() => recordStandingOrderVersion(db, seed("inbox.no_wake"), { author: "system", seedRevision: 0 })).toThrow(/修订号/);
  });
});

describe("the standing orders are data", () => {
  const stage = (): TriageEnvelope => ({
    source: "system", kind: "notification.created", entityKey: "ticket:1", occurredAt: "2026-10-17T08:00:00.000Z",
    payload: { notificationId: 1, itemId: 1, notificationKind: "overdue", urgency: "batchable", title: "t", body: "", dedupKey: null },
  });

  it("skips a disabled level order and falls through to the next one", () => {
    expect(triageEvent(db, stage())).toMatchObject({ level: "digest", basis: { order: { id: "notification.batchable", version: 1 } } });
    recordStandingOrderVersion(db, { ...seed("notification.batchable"), reason: "停用" }, { author: "user", status: "disabled" });
    // 没有别的指令匹配：用来源 system 的默认级别。
    expect(triageEvent(db, stage())).toMatchObject({ level: "record", basis: { order: { id: "source.system", version: 1 } } });
  });

  it("wakes Lead by the wake rule in the table", () => {
    const attention = { severity: "attention" as const, payload: JSON.stringify({ kind: "run_finished" }) };
    expect(inboxWakesLead(attention, db)).toBe(false);
    recordStandingOrderVersion(db, {
      ...seed("inbox.wake_lead"),
      action: {
        type: "rule", rule: "inbox.wake_lead", level: "tell",
        params: { wakeWhen: { anyOf: [{ fields: { severity: "blocker" } }, { fields: { "payload.kind": "run_finished" } }] } },
      },
      reason: "Run 结束也叫醒 Lead",
    }, { author: "user", approvedBy: "user" });
    expect(inboxWakesLead(attention, db)).toBe(true);
    // 写 inbox 时事件的叫醒标记也按库里的规则算，所以它被分诊成 tell。
    addInbox(db, { dedupScope: "sys:x", severity: "attention", source: "structural", summary: "Run 结束了", payload: { kind: "run_finished" } });
    expect(listEvents(db, { kind: "inbox.attention" })[0]).toMatchObject({
      level: "tell", payload: { wakeLead: true }, triage: { order: { id: "inbox.wake_lead", version: 2 } },
    });
  });

  it("fuses blockers by the limits in the table", () => {
    recordStandingOrderVersion(db, { ...seed("inbox.fuse_blockers"), limits: { count: 2, windowMs: 1_800_000 }, reason: "更早熔断" },
      { author: "user", approvedBy: "user" });
    expect(inboxFuseLimits(db)).toEqual({ count: 2, windowMs: 1_800_000, order: { id: "inbox.fuse_blockers", version: 2 } });
    addInbox(db, { dedupScope: "sys:w", severity: "blocker", source: "structural", summary: "b1" });
    const second = addInbox(db, { dedupScope: "sys:w", severity: "blocker", source: "structural", summary: "b2" });
    expect(second.suppressed).toBe(true);
    expect(listInbox(db).map((row) => row.summary)).toEqual(["b1", "sys:w 异常频繁（30 分钟内多次 blocker），建议人工介入"]);
    // 打开熔断的那一条照常告诉 Lead，依据里记着熔断用的是第 2 版。
    expect(listEvents(db, { kind: "inbox.blocker" }).at(-1)).toMatchObject({
      level: "tell",
      payload: { delivery: "folded", fuseOpened: true },
      triage: { order: { id: "inbox.wake_lead", version: 1 }, applied: [{ id: "inbox.fuse_blockers", version: 2, effect: "inbox_folded" }] },
    });
  });

  it("reads the transient retry parameters from the table", () => {
    expect(transientRetryDefaults(db)).toEqual({ baseMs: 30_000, maxMs: 600_000, limit: 5, order: { id: "run.transient_retry", version: 1 } });
    recordStandingOrderVersion(db, {
      ...seed("run.transient_retry"),
      action: { type: "rule", rule: "run.transient_retry", params: { baseMs: 10_000, maxMs: 60_000 }, level: "digest" },
      limits: { count: 2 }, reason: "测试",
    }, { author: "user", approvedBy: "user" });
    expect(transientRetryDefaults(db)).toEqual({ baseMs: 10_000, maxMs: 60_000, limit: 2, order: { id: "run.transient_retry", version: 2 } });
  });

  // 工单 14：模型目录去抖的参数。种子是 2；这个参数出现以前写的版本没有它，按 1（不去抖）运行。
  it("reads the model catalog debounce from the table, and treats a version without it as no debounce", () => {
    expect(modelCatalogAnnounceParams(db)).toMatchObject({ stableRefreshes: 2, order: { id: "model_catalog.announce", version: 1 } });
    recordStandingOrderVersion(db, {
      ...seed("model_catalog.announce"),
      action: {
        type: "rule", rule: "model_catalog.announce", level: "digest",
        params: { announceFirstRefresh: false, refreshOnFailureScopes: ["runtime", "account"], wakeLead: false },
      },
      reason: "工单 14 以前写的版本",
    }, { author: "user", approvedBy: "user" });
    expect(modelCatalogAnnounceParams(db)).toMatchObject({ stableRefreshes: 1, order: { id: "model_catalog.announce", version: 2 } });
    expect(() => recordStandingOrderVersion(db, {
      ...seed("model_catalog.announce"),
      action: {
        type: "rule", rule: "model_catalog.announce", level: "digest",
        params: { announceFirstRefresh: false, refreshOnFailureScopes: [], wakeLead: false, stableRefreshes: 0 },
      },
    }, { author: "user", approvedBy: "user" })).toThrow(/参数/);
  });

  // 一个已有的库（种子修订 1）：代码的修订号是 2，打开时写新的一版，带上去抖。
  it("moves an existing database's model catalog order to the debounced revision", () => {
    const { seedRevision: _revision, ...current } = SYSTEM_STANDING_ORDERS.find((order) => order.id === "model_catalog.announce")!;
    const fresh = openDb(join(tempDir("plc-standing-orders-"), "plc.db"));
    fresh.exec("DROP TRIGGER standing_orders_append_only_update; DROP TRIGGER standing_orders_append_only_delete");
    fresh.prepare("DELETE FROM standing_orders WHERE order_id = 'model_catalog.announce'").run();
    recordStandingOrderVersion(fresh, {
      ...current,
      action: {
        type: "rule", rule: "model_catalog.announce", level: "digest",
        params: { announceFirstRefresh: false, refreshOnFailureScopes: ["runtime", "account"], wakeLead: false },
      },
    }, { author: "system", seedRevision: 1 });
    expect(syncSystemStandingOrders(fresh).updated).toEqual(["model_catalog.announce"]);
    expect(getStandingOrder(fresh, "model_catalog.announce")).toMatchObject({ version: 2, seedRevision: 2 });
    expect(modelCatalogAnnounceParams(fresh).stableRefreshes).toBe(2);
    fresh.close();
  });
});

describe("when the standing orders cannot be read", () => {
  it("falls back to the seeds in code as version 0, and the original write still commits", () => {
    db.exec("DROP TRIGGER standing_orders_append_only_update; DROP TRIGGER standing_orders_append_only_delete; DROP TABLE standing_orders");
    expect(activeStandingOrders(db).map((order) => order.version)).toEqual(SYSTEM_STANDING_ORDERS.map(() => 0));
    const { id } = addInbox(db, { dedupScope: "sys:y", severity: "blocker", source: "structural", summary: "坏了" });
    expect(listInbox(db).map((row) => row.id)).toEqual([id]);
    expect(listEvents(db, { kind: "inbox.blocker" })[0]).toMatchObject({
      level: "tell", triage: { order: { id: "inbox.wake_lead", version: 0 } },
    });
  });

  it("uses the seed for an order whose latest version is broken", () => {
    db.prepare(
      `INSERT INTO standing_orders (order_id, version, title, priority, condition, action, limits, escalate_to, author, approved_by, status, reason, created_at)
       VALUES ('run.transient_retry', 2, 't', 35, '{}', '{"type":"rule","rule":"run.transient_retry","params":{"baseMs":"soon"}}', NULL, NULL, 'user', NULL, 'active', 'r', ?)`,
    ).run(new Date().toISOString());
    expect(transientRetryDefaults(db)).toEqual({ baseMs: 30_000, maxMs: 600_000, limit: 5, order: { id: "run.transient_retry", version: 0 } });
  });
});

// ── 对照：搬之前的代码（提交 8b138b0 的 packages/store/src/inbox.ts）原样抄在这里 ──────────────────

function legacyWakesLead(severity: "blocker" | "attention", payload: Record<string, unknown>): boolean {
  if (payload.wakeLead === false) return false;
  return severity === "blocker" || payload.wakeLead === true;
}

// 搬之前的合并和熔断。只抄 inbox 表上的决定；事件的双写不是这条规则的一部分。
function legacyAddInbox(
  legacy: Db,
  args: { itemId?: number; dedupScope?: string; severity: "blocker" | "attention"; source: "structural" | "semantic";
    summary: string; payload?: unknown; lossless?: boolean },
): { id: number | null; suppressed: boolean } {
  const FUSE_THRESHOLD = 3;
  const scope = args.itemId !== undefined ? `item:${args.itemId}` : args.dedupScope!;
  const itemId = args.itemId ?? null;
  const subject = args.itemId !== undefined ? `工单 #${args.itemId}` : scope;
  return legacy.transaction((): { id: number | null; suppressed: boolean } => {
    if (args.severity === "attention" && !args.lossless) {
      const existing = legacy.prepare(
        "SELECT id, payload FROM inbox WHERE dedup_scope = ? AND severity = 'attention' AND state = 'pending' LIMIT 1",
      ).get(scope) as { id: number; payload: string } | undefined;
      if (existing) {
        const p = JSON.parse(existing.payload || "{}");
        p.merged = [...(p.merged ?? []), args.summary];
        p.mergedCount = p.merged.length;
        p.lastSummary = args.summary;
        legacy.prepare("UPDATE inbox SET payload = ? WHERE id = ?").run(JSON.stringify(p), existing.id);
        return { id: existing.id, suppressed: true };
      }
    }
    if (args.severity === "blocker" && !args.lossless) {
      const recent = (legacy.prepare(
        "SELECT COUNT(*) AS n FROM inbox WHERE dedup_scope = ? AND severity = 'blocker' AND created_at > datetime('now','-1 hour')",
      ).get(scope) as { n: number }).n;
      if (recent >= FUSE_THRESHOLD - 1) {
        const fuse = legacy.prepare(
          "SELECT id, payload FROM inbox WHERE dedup_scope = ? AND severity = 'blocker' AND state = 'pending' AND summary LIKE '%异常频繁%' LIMIT 1",
        ).get(scope) as { id: number; payload: string } | undefined;
        if (fuse) {
          const p = JSON.parse(fuse.payload || "{}");
          p.suppressedCount = (p.suppressedCount ?? 0) + 1;
          p.lastSummary = args.summary;
          legacy.prepare("UPDATE inbox SET payload = ? WHERE id = ?").run(JSON.stringify(p), fuse.id);
          return { id: fuse.id, suppressed: true };
        }
        const r = legacy.prepare(
          `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary, payload)
           VALUES (?, ?, 'blocker', 'structural', ?, ?)`,
        ).run(itemId, scope, `${subject} 异常频繁（1 小时内多次 blocker），建议人工介入`,
          JSON.stringify({ suppressedCount: 1, lastSummary: args.summary }));
        return { id: Number(r.lastInsertRowid), suppressed: true };
      }
    }
    const r = legacy.prepare(
      `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(itemId, scope, args.severity, args.source, args.summary, JSON.stringify(args.payload ?? {}));
    return { id: Number(r.lastInsertRowid), suppressed: false };
  })();
}

// 固定种子的伪随机数：每次跑同一组输入。
function random(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("compared with the inbox rules before they moved", () => {
  it("merges and fuses exactly as before, for the same sequence of writes, consumptions and elapsed time", () => {
    const legacy = openDb(join(tempDir("plc-standing-orders-legacy-"), "plc.db"));
    for (const target of [db, legacy]) {
      createItem(target, { title: "a", brief: "b", createdBy: "user" });
      createItem(target, { title: "b", brief: "b", createdBy: "user" });
    }
    const rows = (target: Db) => target.prepare(
      "SELECT id, item_id, dedup_scope, severity, source, summary, payload, state FROM inbox ORDER BY id",
    ).all();
    const next = random(20261017);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    for (let step = 0; step < 400; step += 1) {
      const roll = next();
      if (roll < 0.08) {
        // 时间过去一段（把两边的行一起变老），熔断的 1 小时窗口会滑过去。
        const minutes = pick([5, 20, 45, 61]);
        for (const target of [db, legacy]) {
          target.prepare("UPDATE inbox SET created_at = datetime(created_at, ?)").run(`-${minutes} minutes`);
        }
        continue;
      }
      if (roll < 0.15) {
        // Lead 处理掉了几行：合并只并进 pending 的行，熔断也只复用 pending 的聚合行。
        const pending = (db.prepare("SELECT id FROM inbox WHERE state = 'pending'").all() as { id: number }[]).map((row) => row.id);
        const chosen = pending.filter(() => next() < 0.5);
        markInbox(db, chosen, "consumed");
        markInbox(legacy, chosen, "consumed");
        continue;
      }
      const target = pick([{ itemId: 1 }, { itemId: 2 }, { dedupScope: "sys:watchdog" }, { dedupScope: "sys:budget" }]);
      const args = {
        ...target,
        severity: pick(["blocker", "attention"] as const),
        source: pick(["structural", "semantic"] as const),
        summary: `第 ${step} 条`,
        payload: pick([{}, { wakeLead: true }, { kind: "x", wakeLead: false }]),
        lossless: next() < 0.15,
      };
      expect(addInbox(db, args), `step ${step}`).toEqual(legacyAddInbox(legacy, args));
    }
    expect(rows(db)).toEqual(rows(legacy));
    // 这组输入真的走到了合并、熔断和熔断后的折叠。
    const deliveries = listEvents(db, { kind: ["inbox.blocker", "inbox.attention"], limit: 1000 }).map((event) => event.payload.delivery);
    expect(new Set(deliveries)).toEqual(new Set(["row", "merged", "folded"]));
    legacy.close();
  });

  it("wakes Lead for the same rows as before", () => {
    const values = [undefined, true, false, "true", 1, null];
    for (const severity of ["blocker", "attention"] as const) {
      for (const wakeLead of values) {
        for (const extra of [{}, { kind: "lead_followup" }, { needsUser: true }]) {
          const payload = { ...extra, ...(wakeLead === undefined ? {} : { wakeLead }) };
          const row = { severity, payload: JSON.stringify(payload) };
          expect(inboxWakesLead(row, db), JSON.stringify(row)).toBe(legacyWakesLead(severity, payload));
        }
      }
    }
  });
});

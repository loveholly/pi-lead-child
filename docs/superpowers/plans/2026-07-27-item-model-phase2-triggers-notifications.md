# Item 模型 Phase 2：Trigger 与 Notification 层 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** 把"定时触发"从两套半成品（`schedules` 的 cron + `tickets.remind_at` 的一次性）统一成一个 source/action 分离的 Trigger 层，并新增一条直达用户、绝不去抖的 Notification 通道，让提醒既不再寄生成工单、也不再被通知去抖静默吞掉。

**Architecture:** `triggers` 声明"什么时候触发 + 触发了做什么"，`trigger_fires` 用 `UNIQUE(trigger_id, dedup_key)` 同时承担 cron 幂等与将来 webhook 的投递去重。scheduler 降级成众多 source 生产者之一，只认 `once` / `cron`；webhook 以后接同一个 action 执行器。用户通知走新的 `notifications` 表（恰好一次、可 ack），lead 只负责播报，系统负责兜底送达。

**Spec:** `docs/superpowers/specs/2026-07-27-item-run-trigger-notification-design.md` §3.3、§3.4、§4、§5.3、§5.4、§5.5、§10、§13

**前置：** Phase 1 全部完成且全量测试绿。

**命名映射：** spec 的 `items` = 物理表 `tickets`，`item_id` = `ticket_id`，`runs` = `attempts`。三张新表用 spec 的名字（`triggers` / `trigger_fires` / `notifications`），因为它们是新建的、没有历史包袱。`inbox` 表**不改名**（spec 叫它 `lead_inbox`，物理名保持 `inbox`）。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/store/schema.ts` | DDL | 新增三张表 + 索引；`inbox.ticket_id` 去 NOT NULL、加 `dedup_scope` |
| `src/store/triggers.ts` | **新建** — trigger DAO + 下次触发时刻计算 | 取代 `src/store/schedules.ts` |
| `src/store/trigger-actions.ts` | **新建** — action 执行器（唯一处），source 无关 | 独立成文件，因为它是 webhook 将来复用的接缝 |
| `src/store/notifications.ts` | **新建** — 用户通知 DAO | |
| `src/store/inbox.ts` | lead 通知管道 | 改：按 `dedup_scope` 分组去抖/熔断 |
| `src/pipeline/scheduler.ts` | 时钟 | 重写：四步 tick |
| `src/store/schedules.ts` | — | **删除** |
| `src/store/db.ts` | 迁移 | v15：建新表、改 inbox、把 `schedules` 行搬进 `triggers` 后删表 |
| `test/triggers.test.ts` / `test/trigger-actions.test.ts` / `test/notifications.test.ts` / `test/scheduler-v2.test.ts` | **新建** | |

---

## Task 1: 三张新表 + inbox 改造（schema）

**Files:** `src/store/schema.ts`；Test: `test/triggers.test.ts`

- [ ] **Step 1: 写失败测试** — 断言三张表存在且关键约束生效：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";

let db: Db;
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db")); });

function insertTrigger(cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO triggers (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => cols[k]));
}

describe("triggers table", () => {
  it("requires fire_at for a once source", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "user", source_type: "once",
      action_type: "create_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("requires cron_expr for a cron source", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "user", source_type: "cron",
      action_type: "create_item", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  // spec §5.3 (C5)：自动开跑的能力只有 user 建的 trigger 才有
  it("refuses create_and_start on a non-user trigger", () => {
    expect(() => insertTrigger({
      label: "x", created_by: "lead", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_and_start", action_payload: "{}",
    })).toThrow(/CHECK constraint failed/);
  });

  it("allows create_and_start on a user trigger", () => {
    insertTrigger({
      label: "x", created_by: "user", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_and_start", action_payload: "{}",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n).toBe(1);
  });

  it("dedups fires by (trigger_id, dedup_key)", () => {
    insertTrigger({
      label: "x", created_by: "user", source_type: "cron", cron_expr: "0 9 * * 1",
      action_type: "create_item", action_payload: "{}",
    });
    const fire = () => db.prepare(
      `INSERT INTO trigger_fires (trigger_id, dedup_key, occurrence_at)
       VALUES (1, '2026-08-03T01:00:00.000Z', '2026-08-03T01:00:00.000Z')`,
    ).run();
    fire();
    expect(fire).toThrow(/UNIQUE constraint failed/);
  });
});

describe("notifications table", () => {
  it("accepts an item-less notification", () => {
    db.prepare(
      "INSERT INTO notifications (kind, urgency, title) VALUES ('crash','immediate','boom')",
    ).run();
    const row = db.prepare("SELECT ticket_id, state FROM notifications WHERE id=1").get() as
      { ticket_id: number | null; state: string };
    expect(row.ticket_id).toBeNull();
    expect(row.state).toBe("pending");
  });
});

describe("inbox dedup_scope", () => {
  it("accepts an item-less inbox row carrying its own scope", () => {
    db.prepare(
      `INSERT INTO inbox (ticket_id, dedup_scope, severity, source, summary)
       VALUES (NULL, 'sys:watchdog', 'attention', 'structural', 's')`,
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 2:** `npx vitest run test/triggers.test.ts` → FAIL (`no such table: triggers`)

- [ ] **Step 3: 加 DDL** — 按 spec §5.3 / §5.4 / §5.5 建表。三处与 spec 的物理名差异：`items(id)` → `tickets(id)`，`item_id` → `ticket_id`，`lead_inbox` → `inbox`。完整 DDL 见 spec，逐字照搬并做上述替换。此外：

```sql
CREATE INDEX IF NOT EXISTS triggers_due ON triggers (next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications (state, urgency, created_at);
CREATE INDEX IF NOT EXISTS inbox_scope ON inbox (dedup_scope, severity, state);
```

`inbox` 的改造必须走**整表重建**（去 NOT NULL + 加列，SQLite 不能 ALTER 约束），沿用
`src/store/db.ts` 里 `migrateCheckpointFidelityStorage` 的写法。存量行的 `dedup_scope`
回填为 `'item:' || ticket_id`。

- [ ] **Step 4:** `npx vitest run test/triggers.test.ts` → PASS
- [ ] **Step 5: 提交** `git add src/store/schema.ts test/triggers.test.ts` → `feat(store): add triggers, trigger_fires and notifications tables`

---

## Task 2: trigger DAO

**Files:** Create `src/store/triggers.ts`；Test: `test/triggers.test.ts`

`nextRun` 从 `src/store/schedules.ts:16` 原样搬过来——**cron 语义必须不变**：按本机时区解析、存 ISO UTC、相对当前 now 推进（停机期间错过的 occurrence 跳过、不追赶）。这是既有取舍，spec §10 明确要求保留。

- [ ] **Step 1: 写失败测试**

```typescript
describe("trigger DAO", () => {
  it("computes next_fire_at on create for a cron trigger", () => {
    const id = createCronTrigger(db, {
      label: "weekly", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "周报" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const t = getTrigger(db, id)!;
    expect(t.next_fire_at).toBe("2026-08-03T09:00:00.000Z");
  });

  it("computes next_fire_at as fire_at for a once trigger", () => {
    const id = createOnceTrigger(db, {
      label: "one", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "会议" } },
    });
    expect(getTrigger(db, id)!.next_fire_at).toBe("2026-08-01T10:00:00.000Z");
  });

  it("advances a cron trigger relative to now, skipping missed occurrences", () => {
    const id = createCronTrigger(db, {
      label: "daily", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    // 停机三天后才醒来：只排下一次，不补跑错过的三次
    advanceTrigger(db, id, new Date("2026-07-30T12:00:00.000Z"));
    expect(getTrigger(db, id)!.next_fire_at).toBe("2026-07-31T09:00:00.000Z");
  });

  it("disables a once trigger after it advances", () => {
    const id = createOnceTrigger(db, {
      label: "one", fireAt: "2026-08-01T10:00:00.000Z", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "x" } },
    });
    advanceTrigger(db, id, new Date("2026-08-01T10:00:01.000Z"));
    const t = getTrigger(db, id)!;
    expect(t.enabled).toBe(0);
    expect(t.next_fire_at).toBeNull();
  });

  it("auto-disables after PLC_TRIGGER_MAX_FAILURES consecutive failures", () => {
    const id = createCronTrigger(db, {
      label: "bad", cronExpr: "0 9 * * *", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "task", title: "x", brief: "b" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    for (let i = 0; i < 5; i++) recordTriggerFailure(db, id, "boom");
    expect(getTrigger(db, id)!.enabled).toBe(0);
  });
});
```

- [ ] **Step 2:** FAIL — module not found
- [ ] **Step 3: 实现** `src/store/triggers.ts`，导出 `createOnceTrigger` / `createCronTrigger` / `getTrigger` / `listTriggers` / `dueTriggers` / `advanceTrigger` / `recordTriggerFailure` / `setTriggerEnabled` / `nextRun`。`once` trigger 推进后 `enabled=0, next_fire_at=NULL`（它不会再触发）。`recordTriggerFailure` 累加 `consecutive_failures`，达到 `PLC_TRIGGER_MAX_FAILURES`（默认 5）时置 `enabled=0` 并写一条 `urgency='batchable'` 的 notification。成功时清零。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(store): add the trigger DAO absorbing cron and one-shot schedules`

---

## Task 3: action 执行器

这是 webhook 将来复用的接缝——**它必须对 source 一无所知**，只接受 `(trigger, occurrenceAt)`。

**Files:** Create `src/store/trigger-actions.ts`；Test: `test/trigger-actions.test.ts`

- [ ] **Step 1: 写失败测试** — 覆盖 spec §5.3 的 action_payload 契约全部三条：

```typescript
describe("trigger action executor", () => {
  it("creates a reminder at stage scheduled with remind_at injected from the occurrence", () => {
    const id = createCronTrigger(db, {
      label: "weekly", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
      action: { type: "create_item", payload: { kind: "reminder", title: "交周报" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const ticketId = runTriggerAction(db, getTrigger(db, id)!, "2026-08-03T09:00:00.000Z");
    const t = getTicket(db, ticketId!)!;
    expect(t.kind).toBe("reminder");
    expect(t.status).toBe("scheduled");
    // 静态模板里没有 remind_at；执行器必须按 occurrence 注入，否则永远不触发
    expect(t.remind_at).toBe("2026-08-03T09:00:00.000Z");
  });

  it("creates a task at the declared initial stage", () => {
    const id = createCronTrigger(db, {
      label: "audit", cronExpr: "0 3 * * 0", tz: "UTC", createdBy: "user",
      action: { type: "create_item",
                payload: { kind: "task", title: "依赖审计", brief: "b", initial_stage: "ready" } },
    }, new Date("2026-07-27T00:00:00.000Z"));
    const ticketId = runTriggerAction(db, getTrigger(db, id)!, "2026-08-02T03:00:00.000Z");
    expect(getTicket(db, ticketId!)!.status).toBe("ready");
  });

  // spec §5.3「权限传递」：非 user 的 trigger 声明 ready 时静默降级为 draft，并记录原因
  it("downgrades initial_stage ready to draft for a non-user trigger", () => {
    db.prepare(
      `INSERT INTO triggers (label, created_by, source_type, cron_expr, next_fire_at,
                             action_type, action_payload)
       VALUES ('x','lead','cron','0 3 * * 0','2026-08-02T03:00:00.000Z','create_item',?)`,
    ).run(JSON.stringify({ kind: "task", title: "t", brief: "b", initial_stage: "ready" }));
    const ticketId = runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z");
    expect(getTicket(db, ticketId!)!.status).toBe("draft");
  });

  it("rejects initial_stage outside the kind's machine", () => {
    db.prepare(
      `INSERT INTO triggers (label, created_by, source_type, cron_expr, next_fire_at,
                             action_type, action_payload)
       VALUES ('x','user','cron','0 3 * * 0','2026-08-02T03:00:00.000Z','create_item',?)`,
    ).run(JSON.stringify({ kind: "reminder", title: "t", initial_stage: "draft" }));
    expect(() => runTriggerAction(db, getTrigger(db, 1)!, "2026-08-02T03:00:00.000Z"))
      .toThrow(/initial_stage 'draft' is not valid for kind 'reminder'/);
  });
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现** `runTriggerAction(db, trigger, occurrenceAt): number | null`。三个 action：
  - `create_item` — 校验 `initial_stage` 属于该 kind 的状态机（task: `draft|ready`，reminder: `scheduled`，缺省 task→`draft`、reminder→`scheduled`）；reminder 注入 `remind_at = occurrenceAt`；非 user trigger 声明 `ready` 时降级 `draft`。
  - `create_and_start` — 先 `create_item`，再走 Phase 1 的 `assertRunAllowed` + 创建 Run。C5 已保证只有 user trigger 能走到这里。
  - `start_item` — 对 `action_payload.ticket_id` 指向的既有 task 创建 Run，同样过闸门。
  
  **绝不在这里 catch 异常**：失败要冒泡给 scheduler，由它写 `trigger_fires.status='failed'`。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(store): add the source-agnostic trigger action executor`

---

## Task 4: notifications DAO

**Files:** Create `src/store/notifications.ts`；Test: `test/notifications.test.ts`

- [ ] **Step 1: 写失败测试** — 关键断言是**无去抖**（与 inbox 相反）：

```typescript
describe("notifications", () => {
  it("never merges two notifications on the same ticket", () => {
    addNotification(db, { ticketId, kind: "reminder", urgency: "immediate", title: "一" });
    addNotification(db, { ticketId, kind: "reminder", urgency: "immediate", title: "二" });
    expect(listNotifications(db, { state: ["pending"] })).toHaveLength(2);
  });

  it("marks delivered with the channel that delivered it", () => {
    const id = addNotification(db, { kind: "crash", urgency: "immediate", title: "boom" });
    markNotificationDelivered(db, id, "lead", new Date("2026-07-27T00:00:00.000Z"));
    const n = getNotification(db, id)!;
    expect(n.state).toBe("delivered");
    expect(n.delivered_via).toBe("lead");
  });

  it("surfaces immediate notifications past the fallback window", () => {
    addNotification(db, { kind: "reminder", urgency: "immediate", title: "a",
                          createdAt: "2026-07-27T00:00:00.000Z" });
    addNotification(db, { kind: "budget", urgency: "batchable", title: "b",
                          createdAt: "2026-07-27T00:00:00.000Z" });
    const overdue = notificationsNeedingFallback(db,
      new Date("2026-07-27T00:05:00.000Z"), 120_000);
    expect(overdue.map((n) => n.title)).toEqual(["a"]);  // batchable 不走兜底
  });

  it("acks", () => {
    const id = addNotification(db, { kind: "reminder", urgency: "immediate", title: "a" });
    ackNotification(db, id);
    expect(getNotification(db, id)!.state).toBe("acked");
  });
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** 顶部注释必须写明：**本表刻意没有去抖与熔断**，因为 `src/store/inbox.ts:22-32` 那套 attention 合并会把到点的提醒折叠进别人的 payload 里静默丢掉（spec §1 记录的既有缺陷）。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(store): add the user-facing notification channel`

---

## Task 5: inbox 按 dedup_scope 分组

**Files:** `src/store/inbox.ts`；Test: `test/inbox.test.ts`

- [ ] **Step 1: 写失败测试** — 两条不挂工单的行必须能各自去抖，而不是因为 `ticket_id = NULL` 恒不为真而全都漏过：

```typescript
it("debounces item-less rows by their own scope", () => {
  addInbox(db, { dedupScope: "sys:watchdog", severity: "attention",
                 source: "structural", summary: "一" });
  const r2 = addInbox(db, { dedupScope: "sys:watchdog", severity: "attention",
                            source: "structural", summary: "二" });
  expect(r2.suppressed).toBe(true);
});

it("keeps different scopes independent", () => {
  addInbox(db, { dedupScope: "sys:a", severity: "attention", source: "structural", summary: "一" });
  const r2 = addInbox(db, { dedupScope: "sys:b", severity: "attention",
                            source: "structural", summary: "二" });
  expect(r2.suppressed).toBe(false);
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** `addInbox` 接受 `ticketId?` 与 `dedupScope?`，二者至少给一个；`ticketId` 给了则 scope 默认 `'item:' || ticketId`。把 `inbox.ts:23-25` 和 `:35-37` 的 `WHERE ticket_id = ?` 全部改成 `WHERE dedup_scope = ?`。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `fix(store): group inbox debounce and fuse by an explicit dedup scope`

---

## Task 6: scheduler 重写

**Files:** `src/pipeline/scheduler.ts`；Test: `test/scheduler-v2.test.ts`

按 spec §10 的四步。**顺序是规格的一部分**：Trigger 在提醒之前，好让本轮新建的 reminder 当轮就能触发。

- [ ] **Step 1: 写失败测试** — 必须覆盖这几条，它们都是 spec 明确要求或评审抓出来的：

```typescript
it("fires a cron trigger, then fires the reminder it produced, in the same tick", () => { /* … */ });

it("advances next_fire_at even when the action throws, so one bad trigger cannot freeze the schedule",
   () => { /* action 抛错 → trigger_fires.status='failed'，但 next_fire_at 已推进 */ });

it("never fires the same occurrence twice across two ticks", () => { /* UNIQUE 幂等 */ });

it("writes an immediate notification when a reminder comes due, and never routes it through inbox",
   () => { /* listInbox 必须为空 */ });

it("delivers via fallback once an immediate notification sits pending past the window",
   () => { /* delivered_via === 'fallback' */ });

it("keeps going when one item in a step throws", () => { /* 单条失败不中断本轮其余工作 */ });
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现四步。** 每步、每条目**各自独立事务 + 各自 try/catch**。第 1 步的事务边界是规格的关键：

```
1. Trigger 到点
   同一事务内：INSERT trigger_fires(dedup_key=occurrence ISO, status='pending')
              （UNIQUE 冲突 → 本次已处理过，跳过）+ 推进 next_fire_at
   —— 先推进再执行 action。否则 action 抛错会让 next_fire_at 永远停在过去，
      每 tick 重试同一条，整条 schedule 冻结。
   事务外执行 action → 回写 status / error / produced_ticket_id / 失败计数
2. 提醒到点（排在 1 之后）
   tickets WHERE kind='reminder' AND status='scheduled' AND remind_at <= now
   → transition 到 fired（actor: system）+ addNotification(urgency='immediate')
3. 逾期
   tickets WHERE kind='task' AND due_at < now AND status 非终态 AND due_overdue_notified=0
   → addNotification(urgency='batchable')
4. 兜底投递
   notificationsNeedingFallback(now, PLC_NOTIFY_FALLBACK_MS)
   → 投递并 markNotificationDelivered(id, 'fallback')
```

- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(pipeline): rewrite the scheduler onto triggers and notifications`

---

## Task 7: v15 迁移 + 删除 schedules

**Files:** `src/store/db.ts`；删除 `src/store/schedules.ts`；Test: `test/item-model-migration.test.ts`

- [ ] **Step 1: 写失败测试** — 存量 `schedules` 行必须无损搬进 `triggers`：

```typescript
it("migrates schedules into triggers preserving cron, spawn and enabled", () => {
  // 老库里放两条：spawn=0（仅建单提醒）和 spawn=1（建单并派 child）
  // 迁移后：spawn=0 → action_type='create_item' 且 payload.kind='reminder'
  //         spawn=1 → action_type='create_and_start' 且 payload.kind='task'
  //         created_by 一律 'user'（存量 schedule 都是用户意图，且 C5 要求
  //         create_and_start 只能是 user）
});

it("drops the schedules table", () => {
  expect(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedules'",
  ).get()).toBeUndefined();
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现 v15。** 沿用 Phase 1 v14 的形状：物理形态门控（`triggers` 表不存在 → 建），搬迁 `schedules`，`DROP TABLE schedules`，行数校验，`foreign_key_check`，尾部记版本。删除 `src/store/schedules.ts` 并修掉它的所有 import。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(store): migrate schedules into triggers and drop the table`

---

## Task 8: 全量收敛

- [ ] `npx vitest run` 全绿，0 failed，**不得跳过或注释任何测试**
- [ ] `npx tsc --noEmit -p tsconfig.json` 无输出
- [ ] 提交（显式列文件，绝不 `git add -A`）

## 完成标准

- [ ] 全量测试绿、类型检查干净
- [ ] 手工验证：建一条 `cron(每分钟) → create_item{kind:reminder}` 的 trigger，跑两次 tick，得到两条独立的 reminder 工单和两条独立的 notification（**没有被合并**），且任务列表视图里一条都不出现
- [ ] 手工验证：以 `created_by='lead'` 建一条 `initial_stage='ready'` 的 trigger，触发后产出的 task 是 `draft`

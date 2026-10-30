# Item 模型 Phase 1：数据层与不变量 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tickets` 表升级为 Item 抽象（`kind` = task | reminder，按 kind 分离的 stage 状态机），把 `attempts` 升级为可暂停/恢复的 Run，并把所有不变量钉进 schema 约束和唯一闸门，让"提醒被执行"和"lead 替用户确认开跑"在结构上不可能发生。

**Architecture:** 保留现有 `tickets` / `attempts` 物理表名（改名推迟，见 spec §14）。SQLite 不能 ALTER CHECK，所以凡是改约束的表一律走「建新表 → INSERT SELECT → DROP → RENAME」重建，沿用 `src/store/db.ts:388` `migrateCheckpointFidelityStorage` 的既有写法，迁移版本号 14。状态机从单一 `ALLOWED` 表改为按 kind 分层，`ACTOR_RULES.lead: () => true` 取消并对每条边穷举。

**Tech Stack:** TypeScript (ESM, NodeNext)、better-sqlite3、vitest。测试命令 `npx vitest run <file>`。

**Spec:** `docs/superpowers/specs/2026-07-27-item-run-trigger-notification-design.md`（§5.1、§5.2、§6.1–§6.6、§7.1、§7.3、§9、§11）

**本计划不包含**（属于 Phase 2 / 3）：`triggers` / `trigger_fires` / `notifications` 三张新表、scheduler 重写、lead_inbox 的 `dedup_scope`、工具面拆分、protocol / companion 改动。

---

## 名词对照（本计划一律用左列的物理名）

| spec 概念 | 本计划物理名 |
|---|---|
| `items` 表 | `tickets` |
| `runs` 表 | `attempts` |
| `items.stage` | `tickets.status`（枚举值重定义） |
| `items.plan_state` | `tickets.orchestration_state`（不改名） |
| `runs.state='finished'/'failed'` | `attempts.state='settled'/'crashed'`（不改值） |

## 旧 status → 新 status 映射（迁移用）

| 旧值 | 新值 | 理由 |
|---|---|---|
| `backlog` | `ready` | 旧 backlog 可被直接派发，映射到 ready 保持存量行为；新建单才生于 draft |
| `assigned` | `active` | 旧 assigned 是"已派发未开始"，属运行态，归入 active |
| `in_progress` | `active` | 同上 |
| `blocked` / `review` / `done` / `cancelled` | 原值 | 不变 |

新增值：`draft`（task）、`scheduled` / `fired` / `acked`（reminder）。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/store/types.ts` | 类型定义 | 修改：`TicketKind`、`TaskStage`、`ReminderStage`、`TicketStatus` 联合、`Attempt.state` 加 `paused` |
| `src/store/schema.ts` | 全量 DDL | 修改：`tickets` / `attempts` 的列与 CHECK，新增两个 DB trigger |
| `src/store/stages.ts` | **新建** — 按 kind 分层的状态机与 actor 权限矩阵 | 从 `tickets.ts` 拆出，因为它将从 ~50 行长到 ~150 行，且被 store 之外的多处引用 |
| `src/store/tickets.ts` | ticket DAO | 修改：`createTicket` 支持 kind/初始 stage、`transition` 改调 `stages.ts`、`listTickets` 加默认视图 |
| `src/store/attempts.ts` | attempt DAO | 修改：`pauseAttempt` / `resumeAttempt`、`paused_ms` 累加 |
| `src/store/run-gate.ts` | **新建** — 创建 Run 的唯一硬闸门 | 独立成文件，因为它是本设计最关键的不变量，必须只有一个实现且易于被测试指向 |
| `src/store/timing.ts` | 耗时计算 | 修改：`activeExecutionMs` 扣除暂停时长 |
| `src/store/db.ts` | 迁移 | 修改：新增 `migrateItemModel`（version 14） |
| `src/pipeline/watchdog.ts` | 心跳巡检 | 修改：跳过 paused、`status` 值适配 |
| `test/stages.test.ts` | **新建** | 状态机与权限矩阵 |
| `test/item-kind.test.ts` | **新建** | kind 约束、不可变、树完整性 |
| `test/run-gate.test.ts` | **新建** | Run 闸门 |
| `test/attempt-pause.test.ts` | **新建** | 暂停/恢复与耗时 |
| `test/item-model-migration.test.ts` | **新建** | v14 迁移 |

---

## Task 1: 新增 kind / draft 相关列与状态枚举（schema + 类型）

**Files:**
- Modify: `src/store/schema.ts:5-48`（tickets）、`src/store/schema.ts:49-57`（attempts）
- Modify: `src/store/types.ts:1-2`、`src/store/types.ts:33`
- Test: `test/item-kind.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/item-kind.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
});

function insertRaw(cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO tickets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((k) => cols[k]));
}

describe("tickets.kind column", () => {
  it("defaults to task and accepts the task stage enum", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", status: "draft" });
    const row = db.prepare("SELECT kind, status FROM tickets WHERE id = 1").get() as
      { kind: string; status: string };
    expect(row.kind).toBe("task");
    expect(row.status).toBe("draft");
  });

  it("rejects a task carrying a reminder stage", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", status: "scheduled",
    })).toThrow(/CHECK constraint failed/);
  });

  it("rejects a reminder carrying a task stage", () => {
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "reminder", status: "draft",
      remind_at: "2026-08-01T00:00:00.000Z",
    })).toThrow(/CHECK constraint failed/);
  });

  it("accepts a reminder in the reminder stage enum", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", status: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    const row = db.prepare("SELECT kind, status FROM tickets WHERE id = 1").get() as
      { kind: string; status: string };
    expect(row.kind).toBe("reminder");
    expect(row.status).toBe("scheduled");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/item-kind.test.ts`
Expected: FAIL — `table tickets has no column named kind`

- [ ] **Step 3: 改 schema.ts 的 tickets DDL**

把 `src/store/schema.ts:5-48` 的 `CREATE TABLE IF NOT EXISTS tickets` 整体替换为：

```sql
CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','reminder')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
  brief         TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('urgent','high','normal','low')),
  project       TEXT,
  project_id    INTEGER REFERENCES projects(id),
  workdir       TEXT,
  parent_ticket_id INTEGER REFERENCES tickets(id),
  root_ticket_id INTEGER REFERENCES tickets(id),
  created_by_attempt_id INTEGER REFERENCES attempts(id),
  orchestration_state TEXT
                CHECK (orchestration_state IS NULL OR orchestration_state IN
                       ('none','planning','waiting','integrating','failed')),
  requested_runtime TEXT,
  requested_model TEXT,
  purpose       TEXT,
  review_policy TEXT CHECK (review_policy IS NULL OR review_policy IN ('manual','automatic')),
  max_depth     INTEGER,
  max_children  INTEGER,
  max_concurrency INTEGER,
  token_budget  INTEGER,
  cost_budget_usd REAL,
  retry_limit   INTEGER,
  active_plan_revision INTEGER,
  first_started_at TEXT,
  completed_at  TEXT,
  status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at   TEXT,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     REAL    NOT NULL DEFAULT 0,
  due_at             TEXT,
  defer_until        TEXT,
  remind_at          TEXT,
  due_overdue_notified INTEGER NOT NULL DEFAULT 0,

  -- (C1) stage 必须属于本 kind 的状态机
  CHECK (
    (kind = 'task'     AND status IN ('draft','ready','active','blocked','review','done','cancelled'))
    OR
    (kind = 'reminder' AND status IN ('scheduled','fired','acked','cancelled'))
  ),

  -- (C2) reminder 不得携带任何执行侧字段。新增执行列时必须同步加入本 CHECK。
  CHECK (kind = 'task' OR (
    parent_ticket_id IS NULL AND root_ticket_id IS NULL AND created_by_attempt_id IS NULL
    AND workdir IS NULL AND requested_runtime IS NULL AND requested_model IS NULL
    AND purpose IS NULL AND review_policy IS NULL AND retry_limit IS NULL
    AND max_depth IS NULL AND max_children IS NULL AND max_concurrency IS NULL
    AND token_budget IS NULL AND cost_budget_usd IS NULL
    AND orchestration_state IS NULL AND active_plan_revision IS NULL
    AND defer_until IS NULL
    AND first_started_at IS NULL AND total_tokens = 0 AND total_cost_usd = 0
  )),

  -- (C3) remind_at 双向约束：task 不得有；scheduled 的 reminder 必须有，否则永不触发
  CHECK (kind = 'reminder' OR remind_at IS NULL),
  CHECK (kind <> 'reminder' OR status <> 'scheduled' OR remind_at IS NOT NULL),

  -- (C4) 只有 user / lead 直接创作的 item 才可能停在 draft（见 Task 8）
  CHECK (status <> 'draft' OR created_by IN ('user','lead'))
);
CREATE INDEX IF NOT EXISTS tickets_by_view ON tickets (kind, status, defer_until);
CREATE INDEX IF NOT EXISTS tickets_remind  ON tickets (remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_due     ON tickets (due_at)    WHERE due_at IS NOT NULL;
```

注意三处相对旧 DDL 的可空化：`orchestration_state`、`purpose`、`review_policy`、`retry_limit` 由 `NOT NULL DEFAULT ...` 改为可空，否则 (C2) 无法成立（reminder 会被 DEFAULT 强行塞上执行字段）。task 的缺省值改由 `createTicket` 在代码层补（Task 5）。同时删除 `notify_quota_used` 列（spec §5.6，熔断计数改在 Phase 2 迁到 lead_inbox）。

- [ ] **Step 4: 改 types.ts**

把 `src/store/types.ts:1-2` 替换为：

```typescript
export type TicketKind = "task" | "reminder";
export type TaskStage =
  | "draft" | "ready" | "active" | "blocked" | "review" | "done" | "cancelled";
export type ReminderStage = "scheduled" | "fired" | "acked" | "cancelled";
export type TicketStatus = TaskStage | ReminderStage;
```

在 `Ticket` 接口（`src/store/types.ts:13`）中把 `status: TicketStatus` 保留，并加入：

```typescript
  kind: TicketKind;
  defer_until: string | null;
```

同时把这几个字段改为可空以匹配新 DDL：

```typescript
  orchestration_state: OrchestrationState | null;
  purpose: AttemptPurpose | null;
  review_policy: "manual" | "automatic" | null;
  retry_limit: number | null;
```

并删除 `notify_quota_used: number;` 一行。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/item-kind.test.ts`
Expected: PASS（4 个 case 全绿）

- [ ] **Step 6: 提交**

```bash
git add src/store/schema.ts src/store/types.ts test/item-kind.test.ts
git commit -m "feat(store): add ticket kind and per-kind stage constraints"
```

---

## Task 2: kind 不可变触发器

**Files:**
- Modify: `src/store/schema.ts`（在 tickets 索引之后追加）
- Test: `test/item-kind.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/item-kind.test.ts` 末尾追加：

```typescript
describe("kind immutability", () => {
  it("rejects changing kind on an existing row", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", status: "draft" });
    expect(() => db.prepare("UPDATE tickets SET kind = 'reminder' WHERE id = 1").run())
      .toThrow(/item.kind is immutable/);
  });

  it("allows an UPDATE that does not change kind", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", status: "draft" });
    db.prepare("UPDATE tickets SET kind = 'task', title = 'x' WHERE id = 1").run();
    expect((db.prepare("SELECT title FROM tickets WHERE id=1").get() as { title: string }).title)
      .toBe("x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/item-kind.test.ts -t "kind immutability"`
Expected: FAIL — 第一个 case 未抛错

- [ ] **Step 3: 加触发器**

在 `src/store/schema.ts` 的 tickets 索引语句之后追加：

```sql
CREATE TRIGGER IF NOT EXISTS tickets_kind_immutable BEFORE UPDATE OF kind ON tickets
WHEN OLD.kind <> NEW.kind
BEGIN SELECT RAISE(ABORT, 'item.kind is immutable'); END;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/item-kind.test.ts`
Expected: PASS（6 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/schema.ts test/item-kind.test.ts
git commit -m "feat(store): make ticket kind immutable via db trigger"
```

---

## Task 3: 树完整性触发器（父/根必须是 task）

spec §7.1：(C2) 已禁止 reminder 当 child，本任务禁止任何 ticket 认 reminder 当父/根。CHECK 不能跨行引用，必须用触发器。

**Files:**
- Modify: `src/store/schema.ts`
- Test: `test/item-kind.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `test/item-kind.test.ts`：

```typescript
describe("tree integrity", () => {
  function makeReminder(): number {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", status: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    return db.prepare("SELECT last_insert_rowid() AS id").get() as unknown as number;
  }

  it("rejects a task parented to a reminder", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", status: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    expect(() => insertRaw({
      title: "t", brief: "b", created_by: "user", kind: "task", status: "ready",
      parent_ticket_id: 1,
    })).toThrow(/parent\/root of a ticket must be a task/);
  });

  it("rejects re-pointing an existing task's root at a reminder", () => {
    insertRaw({
      title: "r", brief: "b", created_by: "user", kind: "reminder", status: "scheduled",
      remind_at: "2026-08-01T00:00:00.000Z",
    });
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", status: "ready" });
    expect(() => db.prepare("UPDATE tickets SET root_ticket_id = 1 WHERE id = 2").run())
      .toThrow(/parent\/root of a ticket must be a task/);
  });

  it("allows a task parented to a task", () => {
    insertRaw({ title: "p", brief: "b", created_by: "user", kind: "task", status: "ready" });
    insertRaw({
      title: "c", brief: "b", created_by: "child", kind: "task", status: "ready",
      parent_ticket_id: 1, root_ticket_id: 1,
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(2);
  });

  it("allows the self-root update pattern", () => {
    insertRaw({ title: "t", brief: "b", created_by: "user", kind: "task", status: "ready" });
    db.prepare("UPDATE tickets SET root_ticket_id = id WHERE id = 1").run();
    expect((db.prepare("SELECT root_ticket_id AS r FROM tickets WHERE id=1")
      .get() as { r: number }).r).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/item-kind.test.ts -t "tree integrity"`
Expected: FAIL — 前两个 case 未抛错

- [ ] **Step 3: 加两个触发器**

在 `src/store/schema.ts` 的 `tickets_kind_immutable` 之后追加。`NEW.root_ticket_id <> NEW.id` 这个条件是必需的：自根行更新时 root 指向自己，此时该行尚未 / 正在写入，不应参与校验。

```sql
CREATE TRIGGER IF NOT EXISTS tickets_tree_is_task_i BEFORE INSERT ON tickets
WHEN (NEW.parent_ticket_id IS NOT NULL
        AND (SELECT kind FROM tickets WHERE id = NEW.parent_ticket_id) <> 'task')
  OR (NEW.root_ticket_id IS NOT NULL AND NEW.root_ticket_id <> NEW.id
        AND (SELECT kind FROM tickets WHERE id = NEW.root_ticket_id) <> 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of a ticket must be a task'); END;

CREATE TRIGGER IF NOT EXISTS tickets_tree_is_task_u
BEFORE UPDATE OF parent_ticket_id, root_ticket_id ON tickets
WHEN (NEW.parent_ticket_id IS NOT NULL
        AND (SELECT kind FROM tickets WHERE id = NEW.parent_ticket_id) <> 'task')
  OR (NEW.root_ticket_id IS NOT NULL AND NEW.root_ticket_id <> NEW.id
        AND (SELECT kind FROM tickets WHERE id = NEW.root_ticket_id) <> 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of a ticket must be a task'); END;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/item-kind.test.ts`
Expected: PASS（10 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/schema.ts test/item-kind.test.ts
git commit -m "feat(store): enforce that a ticket tree contains only tasks"
```

---

## Task 4: 按 kind 分层的状态机与权限矩阵

**Files:**
- Create: `src/store/stages.ts`
- Test: `test/stages.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/stages.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { canTransition, allowedNext } from "../src/store/stages.js";

describe("task stage machine", () => {
  it("allows only user to confirm draft -> ready", () => {
    expect(canTransition("task", "draft", "ready", "user")).toBe(true);
    expect(canTransition("task", "draft", "ready", "lead")).toBe(false);
    expect(canTransition("task", "draft", "ready", "system")).toBe(false);
    expect(canTransition("task", "draft", "ready", "child")).toBe(false);
  });

  it("allows only user to stop active -> ready", () => {
    expect(canTransition("task", "active", "ready", "user")).toBe(true);
    expect(canTransition("task", "active", "ready", "lead")).toBe(false);
  });

  it("lets user reach active from blocked so the run gate is reachable", () => {
    expect(canTransition("task", "blocked", "active", "user")).toBe(true);
    expect(canTransition("task", "blocked", "active", "system")).toBe(true);
    expect(canTransition("task", "blocked", "active", "child")).toBe(true);
  });

  it("lets lead cancel but never confirm", () => {
    expect(canTransition("task", "ready", "cancelled", "lead")).toBe(true);
    expect(canTransition("task", "draft", "ready", "lead")).toBe(false);
  });

  it("rejects edges absent from the machine", () => {
    expect(canTransition("task", "draft", "active", "user")).toBe(false);
    expect(canTransition("task", "done", "review", "user")).toBe(false);
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/stages.test.ts`
Expected: FAIL — `Cannot find module '../src/store/stages.js'`

- [ ] **Step 3: 新建 `src/store/stages.ts`**

```typescript
// 按 kind 分层的状态机与权限矩阵（spec §6.1/§6.2/§6.4）。
// 与旧实现的关键区别：不再有 lead: () => true —— lead 能建、能改、能取消、能代 ack，
// 但不能替用户确认开跑，也不能暂停/恢复。未列出的边一律拒绝（默认 deny）。
import type { Actor, TicketKind, TicketStatus } from "./types.js";

type Edge = `${TicketStatus}->${TicketStatus}`;

const TASK_EDGES: Record<Edge, Actor[]> = {
  "draft->ready": ["user"],            // "建完先别跑"的结构保证：lead 不能替用户确认
  "draft->cancelled": ["user", "lead"],
  "ready->draft": ["user"],
  "ready->active": ["user", "system"], // system 仅在 run-gate 成功创建 Run 时
  "ready->cancelled": ["user", "lead"],
  "active->blocked": ["system", "child"],
  "active->review": ["system", "child"],
  "active->ready": ["user"],           // 手动停下
  "active->cancelled": ["user", "lead"],
  "blocked->active": ["user", "system", "child"],
  "blocked->ready": ["user"],
  "blocked->cancelled": ["user", "lead"],
  "review->done": ["user", "system"],  // system 仅当 review_policy='automatic'，由调用方额外校验
  "review->active": ["user", "system"],
  "review->cancelled": ["user", "lead"],
  "done->active": ["user"],
  "cancelled->draft": ["user"],
};

const REMINDER_EDGES: Record<Edge, Actor[]> = {
  "scheduled->fired": ["system"],
  "scheduled->cancelled": ["user", "lead"],
  "fired->acked": ["user", "lead"],
  "fired->cancelled": ["user", "lead"],
  "cancelled->scheduled": ["user"],
};

function edges(kind: TicketKind): Record<Edge, Actor[]> {
  return kind === "task" ? TASK_EDGES : REMINDER_EDGES;
}

export function canTransition(
  kind: TicketKind, from: TicketStatus, to: TicketStatus, actor: Actor,
): boolean {
  return (edges(kind)[`${from}->${to}` as Edge] ?? []).includes(actor);
}

export function allowedNext(kind: TicketKind, from: TicketStatus): TicketStatus[] {
  return Object.keys(edges(kind))
    .filter((edge) => edge.startsWith(`${from}->`))
    .map((edge) => edge.slice(from.length + 2) as TicketStatus);
}

export const TASK_STAGES: TicketStatus[] =
  ["draft", "ready", "active", "blocked", "review", "done", "cancelled"];
export const REMINDER_STAGES: TicketStatus[] =
  ["scheduled", "fired", "acked", "cancelled"];
export const TERMINAL_STAGES: TicketStatus[] = ["done", "acked", "cancelled"];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/stages.test.ts`
Expected: PASS（8 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/stages.ts test/stages.test.ts
git commit -m "feat(store): add per-kind stage machines and exhaustive actor matrix"
```

---

## Task 5: `transition` / `createTicket` 接入新状态机

**Files:**
- Modify: `src/store/tickets.ts:7-42`（createTicket）、`src/store/tickets.ts:151-201`（ALLOWED / ACTOR_RULES / transition）
- Test: `test/stages.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `test/stages.test.ts`（文件顶部补 import）：

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket, transition } from "../src/store/tickets.js";

describe("transition wiring", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  });

  it("creates a user task in draft", () => {
    const id = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
    expect(getTicket(db, id)!.status).toBe("draft");
    expect(getTicket(db, id)!.kind).toBe("task");
  });

  it("refuses lead confirming draft -> ready", () => {
    const id = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
    expect(() => transition(db, { ticketId: id, to: "ready", actor: "lead", reason: "r" }))
      .toThrow(/actor 'lead' may not transition draft -> ready/);
  });

  it("accepts user confirming draft -> ready", () => {
    const id = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
    transition(db, { ticketId: id, to: "ready", actor: "user", reason: "go" });
    expect(getTicket(db, id)!.status).toBe("ready");
  });

  it("uses the reminder machine for reminders", () => {
    const id = createTicket(db, {
      title: "r", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(getTicket(db, id)!.status).toBe("scheduled");
    transition(db, { ticketId: id, to: "fired", actor: "system", reason: "due" });
    transition(db, { ticketId: id, to: "acked", actor: "user", reason: "seen" });
    expect(getTicket(db, id)!.status).toBe("acked");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/stages.test.ts -t "transition wiring"`
Expected: FAIL — `createTicket` 不接受 `kind` / `remindAt`，且默认 status 非 draft

- [ ] **Step 3: 改 `src/store/tickets.ts`**

删除 `src/store/tickets.ts:151-172` 的 `ALLOWED` 与 `ACTOR_RULES` 两个常量，改为在文件顶部 import：

```typescript
import { canTransition } from "./stages.js";
```

把 `transition`（`src/store/tickets.ts:174-201`）的两处校验替换为：

```typescript
    if (!canTransition(t.kind, t.status, args.to, args.actor)) {
      const legal = allowedNext(t.kind, t.status);
      if (!legal.includes(args.to)) {
        throw new Error(`illegal transition ${t.status} -> ${args.to} (ticket #${t.id})`);
      }
      throw new Error(`actor '${args.actor}' may not transition ${t.status} -> ${args.to}`);
    }
```

并把 `allowedNext` 加入上面的 import。`completedAt` 一行改为按新终态判定：

```typescript
    const completedAt =
      args.to === "done" || args.to === "acked" || args.to === "cancelled" ? changedAt : null;
```

把 `createTicket`（`src/store/tickets.ts:7-42`）替换为：

```typescript
export function createTicket(
  db: Db,
  args: {
    title: string; brief: string; createdBy: "user" | "lead" | "child" | "system";
    kind?: TicketKind; remindAt?: string; deferUntil?: string; workdir?: string;
    priority?: TicketPriority; project?: string; projectId?: number;
    parentTicketId?: number; rootTicketId?: number; createdByAttemptId?: number;
    orchestrationState?: OrchestrationState; runtime?: RuntimeId; model?: string;
    purpose?: AttemptPurpose; reviewPolicy?: "manual" | "automatic";
    maxDepth?: number; maxChildren?: number; maxConcurrency?: number;
    tokenBudget?: number; costBudgetUsd?: number; retryLimit?: number;
  },
): number {
  const kind = args.kind ?? "task";
  if (kind === "reminder" && !args.remindAt) {
    throw new Error("createTicket: a reminder requires remindAt");
  }
  // 初始 stage（spec §6.6）：确认发生在树根，不逐层重复，故 child/system 建的直接生于 ready。
  const status = kind === "reminder"
    ? "scheduled"
    : (args.createdBy === "user" || args.createdBy === "lead") ? "draft" : "ready";
  const isTask = kind === "task";
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO tickets (
        kind, status, title, brief, created_by, workdir, priority, project, project_id,
        parent_ticket_id, root_ticket_id, created_by_attempt_id, orchestration_state,
        requested_runtime, requested_model, purpose, review_policy, max_depth, max_children,
        max_concurrency, token_budget, cost_budget_usd, retry_limit,
        remind_at, defer_until, status_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                datetime('now'))`,
    ).run(
      kind, status, args.title, args.brief, args.createdBy,
      isTask ? args.workdir ?? null : null,
      args.priority ?? "normal", args.project ?? null, args.projectId ?? null,
      isTask ? args.parentTicketId ?? null : null,
      isTask ? args.rootTicketId ?? null : null,
      isTask ? args.createdByAttemptId ?? null : null,
      isTask ? args.orchestrationState ?? "none" : null,
      isTask ? args.runtime ?? null : null,
      isTask ? args.model ?? null : null,
      isTask ? args.purpose ?? "execution" : null,
      isTask ? args.reviewPolicy ?? "manual" : null,
      isTask ? args.maxDepth ?? null : null,
      isTask ? args.maxChildren ?? null : null,
      isTask ? args.maxConcurrency ?? null : null,
      isTask ? args.tokenBudget ?? null : null,
      isTask ? args.costBudgetUsd ?? null : null,
      isTask ? args.retryLimit ?? 1 : null,
      kind === "reminder" ? args.remindAt ?? null : null,
      isTask ? args.deferUntil ?? null : null,
    );
    const id = Number(r.lastInsertRowid);
    if (isTask) {
      db.prepare("UPDATE tickets SET root_ticket_id = ? WHERE id = ?")
        .run(args.rootTicketId ?? id, id);
    }
    return id;
  })();
}
```

顶部 import 补 `TicketKind`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/stages.test.ts`
Expected: PASS（12 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/tickets.ts test/stages.test.ts
git commit -m "feat(store): wire transition and createTicket to the per-kind machines"
```

---

## Task 6: 默认视图（listTickets）

**Files:**
- Modify: `src/store/tickets.ts:51-73`
- Test: `test/stages.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `test/stages.test.ts`：

```typescript
describe("default views", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  });

  it("excludes reminders, drafts, terminals and deferred items from the task view", () => {
    const active = createTicket(db, { title: "active", brief: "b", createdBy: "system" });
    createTicket(db, { title: "draft", brief: "b", createdBy: "user" });
    createTicket(db, {
      title: "rem", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    createTicket(db, {
      title: "later", brief: "b", createdBy: "system", deferUntil: "2099-01-01T00:00:00.000Z",
    });
    const titles = listTickets(db, { view: "tasks", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title);
    expect(titles).toEqual(["active"]);
    expect(getTicket(db, active)!.status).toBe("ready");
  });

  it("surfaces drafts in their own view", () => {
    createTicket(db, { title: "draft", brief: "b", createdBy: "user" });
    expect(listTickets(db, { view: "drafts", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title)).toEqual(["draft"]);
  });

  it("lists scheduled and fired reminders", () => {
    createTicket(db, {
      title: "rem", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(listTickets(db, { view: "reminders", now: "2026-07-27T00:00:00.000Z" })
      .map((t) => t.title)).toEqual(["rem"]);
  });
});
```

顶部 import 补 `listTickets`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/stages.test.ts -t "default views"`
Expected: FAIL — `listTickets` 不接受 `view` / `now`

- [ ] **Step 3: 改 `listTickets`**

把 `src/store/tickets.ts:51-73` 替换为：

```typescript
export type TicketView = "tasks" | "drafts" | "reminders" | "all";

// 默认视图（spec §9）。view 缺省 'tasks'：任务列表不含提醒、待确认、终态与延后未到期。
export function listTickets(
  db: Db,
  filter?: {
    status?: TicketStatus[]; project?: string; text?: string;
    view?: TicketView; now?: string;
  },
): Ticket[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  const view = filter?.view ?? "all";
  const now = filter?.now ?? new Date().toISOString();
  const notDeferred = "(defer_until IS NULL OR defer_until <= ?)";
  if (view === "tasks") {
    where.push("kind = 'task'", "status NOT IN ('draft','done','cancelled')", notDeferred);
    vals.push(now);
  } else if (view === "drafts") {
    where.push("kind = 'task'", "status = 'draft'", notDeferred);
    vals.push(now);
  } else if (view === "reminders") {
    where.push("kind = 'reminder'", "status IN ('scheduled','fired')");
  }
  if (filter?.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    vals.push(...filter.status);
  }
  if (filter?.project) {
    where.push("project = ?");
    vals.push(filter.project);
  }
  if (filter?.text) {
    where.push("(title LIKE ? OR brief LIKE ? OR body LIKE ?)");
    const q = `%${filter.text}%`;
    vals.push(q, q, q);
  }
  const sql = `SELECT * FROM tickets${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY ${PRIORITY_ORDER}, id`;
  return db.prepare(sql).all(...vals) as Ticket[];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/stages.test.ts`
Expected: PASS（15 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/tickets.ts test/stages.test.ts
git commit -m "feat(store): add kind-aware default views to listTickets"
```

---

## Task 7: 创建 Run 的硬闸门

spec §6.5。闸门必须按 role/purpose 分支——初版只写执行 Run 的条件会让 `role='reviewer'` 无法创建，等于删掉整条自动评审管线（`src/coordinator/dispatch.ts:139`、`src/pipeline/orchestrator.ts:78-88`）。

**Files:**
- Create: `src/store/run-gate.ts`
- Modify: `src/store/attempts.ts`（`createAttempt` 调用闸门）
- Test: `test/run-gate.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/run-gate.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, transition } from "../src/store/tickets.js";
import { createAttempt } from "../src/store/attempts.js";
import { assertRunAllowed } from "../src/store/run-gate.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
});

function task(status: string): number {
  const id = createTicket(db, { title: "t", brief: "b", createdBy: "system" }); // → ready
  if (status !== "ready") db.prepare("UPDATE tickets SET status=? WHERE id=?").run(status, id);
  return id;
}

describe("run gate", () => {
  it("refuses any run on a reminder", () => {
    const id = createTicket(db, {
      title: "r", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(() => assertRunAllowed(db, { ticketId: id, role: "executor", purpose: "execution" }))
      .toThrow(/only a task may have a run/);
  });

  it("allows an executor run from ready, active and blocked", () => {
    for (const s of ["ready", "active", "blocked"]) {
      const id = task(s);
      expect(() => assertRunAllowed(db, { ticketId: id, role: "executor", purpose: "execution" }))
        .not.toThrow();
    }
  });

  it("refuses an executor run from draft, review, done", () => {
    for (const s of ["review", "done"]) {
      const id = task(s);
      expect(() => assertRunAllowed(db, { ticketId: id, role: "executor", purpose: "execution" }))
        .toThrow(/executor run requires stage/);
    }
  });

  it("allows a reviewer run only from review", () => {
    const inReview = task("review");
    expect(() => assertRunAllowed(db, { ticketId: inReview, role: "reviewer", purpose: "review" }))
      .not.toThrow();
    const active = task("active");
    expect(() => assertRunAllowed(db, { ticketId: active, role: "reviewer", purpose: "review" }))
      .toThrow(/reviewer run requires stage 'review'/);
  });

  it("allows an integration run only from active + integrating", () => {
    const id = task("active");
    expect(() => assertRunAllowed(db, { ticketId: id, role: "executor", purpose: "integration" }))
      .toThrow(/integration run requires/);
    db.prepare("UPDATE tickets SET orchestration_state='integrating' WHERE id=?").run(id);
    expect(() => assertRunAllowed(db, { ticketId: id, role: "executor", purpose: "integration" }))
      .not.toThrow();
  });

  it("is enforced by createAttempt, not only by callers", () => {
    const id = createTicket(db, {
      title: "r", brief: "b", createdBy: "user", kind: "reminder",
      remindAt: "2026-08-01T00:00:00.000Z",
    });
    expect(() => createAttempt(db, { ticketId: id, role: "executor" }))
      .toThrow(/only a task may have a run/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/run-gate.test.ts`
Expected: FAIL — `Cannot find module '../src/store/run-gate.js'`

- [ ] **Step 3: 新建 `src/store/run-gate.ts`**

```typescript
// 创建 Run 的唯一硬闸门（spec §6.5）。
// 工具拆分负责"好用"，这里负责"不可能错"：即便工具写错、Trigger 配错、重试路径有 bug，
// 也造不出"提醒被执行"或"未确认就开跑"的状态。
// 三种 Run 的合法 stage 不同，现有代码已如此：children/manager.ts:52-54 要求 reviewer 时
// status='review'，manager.ts:114-117 要求 integration 时 orchestration_state='integrating'。
import type { Db } from "./db.js";
import type { AttemptPurpose } from "./types.js";

const EXECUTOR_STAGES = ["ready", "active", "blocked"];

export function assertRunAllowed(
  db: Db,
  args: { ticketId: number; role: "executor" | "reviewer"; purpose: AttemptPurpose },
): void {
  const row = db.prepare(
    "SELECT kind, status, orchestration_state FROM tickets WHERE id = ?",
  ).get(args.ticketId) as
    { kind: string; status: string; orchestration_state: string | null } | undefined;
  if (!row) throw new Error(`ticket ${args.ticketId} not found`);
  if (row.kind !== "task") {
    throw new Error(`only a task may have a run (ticket #${args.ticketId} is a ${row.kind})`);
  }
  if (args.role === "reviewer") {
    if (row.status !== "review") {
      throw new Error(
        `reviewer run requires stage 'review' (ticket #${args.ticketId} is ${row.status})`,
      );
    }
    return;
  }
  if (args.purpose === "integration") {
    if (row.status !== "active" || row.orchestration_state !== "integrating") {
      throw new Error(
        `integration run requires stage 'active' and orchestration_state 'integrating' ` +
        `(ticket #${args.ticketId} is ${row.status}/${row.orchestration_state})`,
      );
    }
    return;
  }
  if (!EXECUTOR_STAGES.includes(row.status)) {
    throw new Error(
      `executor run requires stage in {${EXECUTOR_STAGES.join(", ")}} ` +
      `(ticket #${args.ticketId} is ${row.status})`,
    );
  }
}
```

- [ ] **Step 4: 在 `createAttempt` 里调用闸门**

在 `src/store/attempts.ts` 顶部加 import：

```typescript
import { assertRunAllowed } from "./run-gate.js";
```

在 `createAttempt` 函数体第一行插入：

```typescript
  assertRunAllowed(db, {
    ticketId: args.ticketId,
    role: args.role ?? "executor",
    purpose: args.purpose ?? "execution",
  });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/run-gate.test.ts`
Expected: PASS（6 个 case）

- [ ] **Step 6: 提交**

```bash
git add src/store/run-gate.ts src/store/attempts.ts test/run-gate.test.ts
git commit -m "feat(store): add the single role-aware run-creation gate"
```

---

## Task 8: attempts 暂停 / 恢复

**Files:**
- Modify: `src/store/schema.ts`（attempts 的 state CHECK 与两个新列）
- Modify: `src/store/attempts.ts`、`src/store/types.ts:33`
- Test: `test/attempt-pause.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/attempt-pause.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket } from "../src/store/tickets.js";
import { createAttempt, getAttempt, pauseAttempt, resumeAttempt } from "../src/store/attempts.js";

let db: Db;
let ticketId: number;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "system" });
});

describe("attempt pause/resume", () => {
  it("clears pid on pause and keeps the session", () => {
    const id = createAttempt(db, { ticketId, role: "executor" });
    db.prepare("UPDATE attempts SET state='running', pid=99, session_id='s1' WHERE id=?").run(id);
    pauseAttempt(db, id, new Date("2026-07-27T00:00:00.000Z"));
    const a = getAttempt(db, id)!;
    expect(a.state).toBe("paused");
    expect(a.pid).toBeNull();
    expect(a.session_id).toBe("s1");
    expect(a.paused_at).toBe("2026-07-27T00:00:00.000Z");
  });

  it("accumulates paused_ms across repeated pause/resume", () => {
    const id = createAttempt(db, { ticketId, role: "executor" });
    db.prepare("UPDATE attempts SET state='running' WHERE id=?").run(id);
    pauseAttempt(db, id, new Date("2026-07-27T00:00:00.000Z"));
    resumeAttempt(db, id, new Date("2026-07-27T00:00:10.000Z"));   // +10s
    pauseAttempt(db, id, new Date("2026-07-27T00:00:20.000Z"));
    resumeAttempt(db, id, new Date("2026-07-27T00:00:25.000Z"));   // +5s
    const a = getAttempt(db, id)!;
    expect(a.paused_ms).toBe(15_000);
    expect(a.paused_at).toBeNull();
    expect(a.state).toBe("running");
  });

  it("refuses to pause an attempt that is not running", () => {
    const id = createAttempt(db, { ticketId, role: "executor" });
    db.prepare("UPDATE attempts SET state='settled' WHERE id=?").run(id);
    expect(() => pauseAttempt(db, id, new Date())).toThrow(/cannot pause attempt in state settled/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/attempt-pause.test.ts`
Expected: FAIL — `pauseAttempt` 未导出

- [ ] **Step 3: 改 schema.ts 的 attempts**

把 `src/store/schema.ts:56-57` 的 state CHECK 改为（新增 `paused`）：

```sql
  state         TEXT NOT NULL DEFAULT 'starting'
                CHECK (state IN ('starting','running','paused','settled','crashed','stopped')),
```

在 attempts 表内追加两列（放在 `metadata` 之前即可）：

```sql
  paused_at     TEXT,
  paused_ms     INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 4: 改 types.ts**

把 `src/store/types.ts:33` 改为：

```typescript
  state: "starting" | "running" | "paused" | "settled" | "crashed" | "stopped";
```

并在 `Attempt` 接口中加：

```typescript
  paused_at: string | null; paused_ms: number;
```

- [ ] **Step 5: 在 attempts.ts 加两个函数**

追加到 `src/store/attempts.ts` 末尾：

```typescript
// 暂停 = 终止进程但保留 Run 行与 session（spec §3.2）。恢复时复用同一行、同一 session、新 pid。
export function pauseAttempt(db: Db, id: number, at = new Date()): void {
  const row = db.prepare("SELECT state FROM attempts WHERE id = ?").get(id) as
    { state: string } | undefined;
  if (!row) throw new Error(`attempt ${id} not found`);
  if (row.state !== "running") throw new Error(`cannot pause attempt in state ${row.state}`);
  db.prepare("UPDATE attempts SET state='paused', pid=NULL, paused_at=? WHERE id=?")
    .run(at.toISOString(), id);
}

export function resumeAttempt(db: Db, id: number, at = new Date()): void {
  const row = db.prepare("SELECT state, paused_at, paused_ms FROM attempts WHERE id = ?").get(id) as
    { state: string; paused_at: string | null; paused_ms: number } | undefined;
  if (!row) throw new Error(`attempt ${id} not found`);
  if (row.state !== "paused") throw new Error(`cannot resume attempt in state ${row.state}`);
  const since = row.paused_at ? Date.parse(row.paused_at) : at.getTime();
  const delta = Math.max(0, at.getTime() - since);
  db.prepare("UPDATE attempts SET state='running', paused_at=NULL, paused_ms=? WHERE id=?")
    .run(row.paused_ms + delta, id);
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/attempt-pause.test.ts`
Expected: PASS（3 个 case）

- [ ] **Step 7: 提交**

```bash
git add src/store/schema.ts src/store/types.ts src/store/attempts.ts test/attempt-pause.test.ts
git commit -m "feat(store): add pausable runs with cumulative paused_ms"
```

---

## Task 9: 耗时扣除暂停时长

**Files:**
- Modify: `src/store/timing.ts:35-44`
- Test: `test/attempt-pause.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `test/attempt-pause.test.ts`（顶部 import 补 `getTicketTiming`）：

```typescript
import { getTicketTiming } from "../src/store/timing.js";

describe("timing excludes paused spans", () => {
  it("subtracts accumulated and in-flight pause time", () => {
    const id = createAttempt(db, { ticketId, role: "executor" });
    db.prepare(
      "UPDATE attempts SET state='running', started_at=?, paused_ms=? WHERE id=?",
    ).run("2026-07-27T00:00:00.000Z", 10_000, id);
    // 60s 墙钟 - 10s 已累计暂停 = 50s
    let t = getTicketTiming(db, ticketId, new Date("2026-07-27T00:01:00.000Z"));
    expect(t.activeExecutionMs).toBe(50_000);

    // 再进入暂停 20s：60+20=80s 墙钟 - 10s - 20s = 50s，暂停期间不增长
    db.prepare("UPDATE attempts SET state='paused', paused_at=? WHERE id=?")
      .run("2026-07-27T00:01:00.000Z", id);
    t = getTicketTiming(db, ticketId, new Date("2026-07-27T00:01:20.000Z"));
    expect(t.activeExecutionMs).toBe(50_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/attempt-pause.test.ts -t "timing excludes"`
Expected: FAIL — 得到 60000 而非 50000

- [ ] **Step 3: 改 timing.ts**

把 `src/store/timing.ts:35-44` 替换为：

```typescript
  const attempts = db.prepare(
    `SELECT started_at, ended_at, paused_at, paused_ms FROM attempts
     WHERE ticket_id = ? AND role = 'executor'`,
  ).all(ticketId) as Array<{
    started_at: string; ended_at: string | null;
    paused_at: string | null; paused_ms: number;
  }>;
  const activeExecutionMs = attempts.reduce((total, attempt) => {
    const started = timestampEpoch(attempt.started_at);
    if (started === null) return total;
    const ended = timestampEpoch(attempt.ended_at) ?? computedMs;
    // 暂停是用户主动行为，不计入执行时长：扣掉历次累计 + 当前这次仍在进行的暂停
    const pausedNow = attempt.paused_at === null
      ? 0
      : Math.max(0, computedMs - (timestampEpoch(attempt.paused_at) ?? computedMs));
    const paused = (attempt.paused_ms ?? 0) + pausedNow;
    return total + Math.max(0, ended - started - paused);
  }, 0);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/attempt-pause.test.ts`
Expected: PASS（4 个 case）

- [ ] **Step 5: 提交**

```bash
git add src/store/timing.ts test/attempt-pause.test.ts
git commit -m "fix(store): exclude paused spans from activeExecutionMs"
```

---

## Task 10: watchdog 适配（跳过 paused，改用新 status 值）

**Files:**
- Modify: `src/pipeline/watchdog.ts:44-49`、`src/pipeline/watchdog.ts:79-84`
- Test: `test/watchdog.test.ts`（既有文件，追加）

- [ ] **Step 1: 写失败测试**

追加到 `test/watchdog.test.ts`（沿用该文件既有的 db/ticket 构造方式；若其 helper 名不同，按文件内现有写法调整）：

```typescript
describe("watchdog ignores paused runs", () => {
  it("does not raise a stall for a ticket whose only run is paused", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
    const ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "system" });
    db.prepare("UPDATE tickets SET status='active', last_activity_at=? WHERE id=?")
      .run("2026-07-27T00:00:00.000Z", ticketId);
    const attemptId = createAttempt(db, { ticketId, role: "executor" });
    db.prepare("UPDATE attempts SET state='paused' WHERE id=?").run(attemptId);

    createWatchdog(db, {
      stallMs: 1000,
      now: () => new Date("2026-07-27T01:00:00.000Z"),
    }).check();

    expect(listInbox(db).length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/watchdog.test.ts -t "ignores paused"`
Expected: FAIL — 旧查询用 `status='in_progress'`，新值是 `active`，改完 status 后本 case 才有意义；先确认它红（可能因 `in_progress` 查不到而假绿，此时把断言反过来确认查询确实没匹配，再继续 Step 3）

- [ ] **Step 3: 改 watchdog 的两处查询**

`src/pipeline/watchdog.ts:44-49` 改为（`in_progress` → `active`，并要求存在一个非暂停的活跃 Run）：

```typescript
    const stalled = db.prepare(
      `SELECT t.id, t.last_activity_at FROM tickets t
       WHERE t.status='active'
         AND t.last_activity_at IS NOT NULL
         AND julianday(t.last_activity_at) < julianday(?)
         AND EXISTS (
           SELECT 1 FROM attempts a
           WHERE a.ticket_id = t.id AND a.state IN ('starting','running')
         )`,
    ).all(threshold) as Array<{ id: number; last_activity_at: string }>;
```

`src/pipeline/watchdog.ts:79-84` 的 `t.status='in_progress'` 改为 `t.status='active'`。该查询本就只取 `a.state IN ('starting','running')`，已自然排除 paused，无需再改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/watchdog.test.ts`
Expected: PASS（含既有 case）

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/watchdog.ts test/watchdog.test.ts
git commit -m "fix(watchdog): use the active stage and never treat a paused run as stalled"
```

---

## Task 11: v14 迁移

SQLite 不能 ALTER CHECK，改约束必须重建表。沿用 `src/store/db.ts:388` `migrateCheckpointFidelityStorage` 的写法：关外键 → 建新表 → INSERT SELECT → DROP → RENAME → 校验行数与外键 → 记版本。

**Files:**
- Modify: `src/store/db.ts`（新增 `ITEM_MODEL_MIGRATION_VERSION = 14` 与 `migrateItemModel`，并在 `migrateDb` 末尾调用）
- Test: `test/item-model-migration.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/item-model-migration.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.js";

// 造一个 v13 形态的老库：旧 status 枚举、无 kind、有 notify_quota_used
function legacyDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "plc-legacy-")), "plc.db");
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      brief TEXT NOT NULL, created_by TEXT NOT NULL,
      status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      notify_quota_used INTEGER NOT NULL DEFAULT 0,
      due_overdue_notified INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO tickets (title, brief, created_by, status) VALUES
      ('a','b','user','backlog'), ('c','d','user','assigned'),
      ('e','f','user','in_progress'), ('g','h','user','review');
  `);
  raw.close();
  return path;
}

describe("item model migration v14", () => {
  it("maps legacy statuses and preserves every row", () => {
    const db = openDb(legacyDb());
    const rows = db.prepare("SELECT title, kind, status FROM tickets ORDER BY id").all() as
      Array<{ title: string; kind: string; status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["ready", "active", "active", "review"]);
    expect(rows.every((r) => r.kind === "task")).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it("is idempotent across reopens", () => {
    const path = legacyDb();
    openDb(path).close();
    const db = openDb(path);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(4);
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14",
    ).get() as { n: number }).n).toBe(1);
  });

  it("enforces the new constraints after migrating", () => {
    const db = openDb(legacyDb());
    expect(() => db.prepare("UPDATE tickets SET kind='reminder' WHERE id=1").run())
      .toThrow(/item.kind is immutable/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/item-model-migration.test.ts`
Expected: FAIL — 旧库 status 仍是 `backlog`，无 kind 列

- [ ] **Step 3: 在 db.ts 加迁移**

在 `src/store/db.ts:127` 之后加常量：

```typescript
const ITEM_MODEL_MIGRATION_VERSION = 14;
```

在 `migrateDb`（`src/store/db.ts:121`）的 `migrateCheckpointFidelityStorage(db);` 之后追加：

```typescript
  migrateItemModel(db);
```

在文件末尾追加：

```typescript
// v14：tickets 升级为 Item（kind + 按 kind 分层的 stage），attempts 支持暂停。
// CHECK 无法 ALTER，故 tickets 走整表重建；attempts 只加列 + 重建 state CHECK。
function migrateItemModel(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(ITEM_MODEL_MIGRATION_VERSION);
  if (applied) return;

  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const before = (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
      const cols = tableColumns(db, "tickets");
      const pick = (name: string, fallback: string) => (cols.has(name) ? name : fallback);

      // tickets 重建：schema.ts 的新 DDL 已由 openDb 的 db.exec(SCHEMA) 用
      // CREATE TABLE IF NOT EXISTS 跳过（老库已存在同名表），所以这里显式重建。
      db.exec("DROP TABLE IF EXISTS tickets_v14");
      db.exec(TICKETS_V14_SQL);
      db.exec(`
        INSERT INTO tickets_v14 (
          id, kind, title, body, status, brief, priority, project, project_id, workdir,
          parent_ticket_id, root_ticket_id, created_by_attempt_id, orchestration_state,
          requested_runtime, requested_model, purpose, review_policy,
          max_depth, max_children, max_concurrency, token_budget, cost_budget_usd, retry_limit,
          active_plan_revision, first_started_at, completed_at, status_changed_at,
          created_by, created_at, updated_at, last_activity_at,
          total_tokens, total_cost_usd, due_at, defer_until, remind_at, due_overdue_notified
        )
        SELECT
          id, 'task', title, body,
          CASE status
            WHEN 'backlog' THEN 'ready'
            WHEN 'assigned' THEN 'active'
            WHEN 'in_progress' THEN 'active'
            ELSE status
          END,
          brief, ${pick("priority", "'normal'")}, ${pick("project", "NULL")},
          ${pick("project_id", "NULL")}, ${pick("workdir", "NULL")},
          ${pick("parent_ticket_id", "NULL")}, ${pick("root_ticket_id", "NULL")},
          ${pick("created_by_attempt_id", "NULL")},
          ${pick("orchestration_state", "'none'")},
          ${pick("requested_runtime", "NULL")}, ${pick("requested_model", "NULL")},
          ${pick("purpose", "'execution'")}, ${pick("review_policy", "'manual'")},
          ${pick("max_depth", "NULL")}, ${pick("max_children", "NULL")},
          ${pick("max_concurrency", "NULL")}, ${pick("token_budget", "NULL")},
          ${pick("cost_budget_usd", "NULL")}, ${pick("retry_limit", "1")},
          ${pick("active_plan_revision", "NULL")}, ${pick("first_started_at", "NULL")},
          ${pick("completed_at", "NULL")}, ${pick("status_changed_at", "datetime('now')")},
          created_by, created_at, updated_at, ${pick("last_activity_at", "NULL")},
          total_tokens, total_cost_usd,
          ${pick("due_at", "NULL")}, NULL, ${pick("remind_at", "NULL")},
          ${pick("due_overdue_notified", "0")}
        FROM tickets ORDER BY id
      `);
      const after = (db.prepare("SELECT COUNT(*) AS n FROM tickets_v14").get() as { n: number }).n;
      if (before !== after) throw new Error("item-model migration changed ledger row counts");
      db.exec("DROP TABLE tickets");
      db.exec("ALTER TABLE tickets_v14 RENAME TO tickets");

      const attempts = tableColumns(db, "attempts");
      addColumn(db, "attempts", attempts, "paused_at", "TEXT");
      addColumn(db, "attempts", attempts, "paused_ms", "INTEGER NOT NULL DEFAULT 0");

      // 重新执行全量 SCHEMA 以补回索引与触发器（CREATE ... IF NOT EXISTS 幂等）
      db.exec(SCHEMA);

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`item-model migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(ITEM_MODEL_MIGRATION_VERSION, "item-model-v1");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
```

- [ ] **Step 4: 把 tickets DDL 导出成可复用常量**

`migrateItemModel` 需要一份不带 `IF NOT EXISTS`、表名为 `tickets_v14` 的建表语句。在 `src/store/schema.ts` 中把 Task 1 写好的 tickets 建表语句抽成函数并导出，`SCHEMA` 内改为引用它：

```typescript
export function ticketsTableSql(table: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
    /* …… Task 1 中那份完整列定义与 4 条 CHECK，原样搬入…… */
  )`;
}
export const TICKETS_V14_SQL = ticketsTableSql("tickets_v14");
```

`SCHEMA` 模板串里把原来的 `CREATE TABLE IF NOT EXISTS tickets (...)` 换成
`${ticketsTableSql("tickets", true)}`。在 `src/store/db.ts` 顶部 import 中补 `TICKETS_V14_SQL`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/item-model-migration.test.ts`
Expected: PASS（3 个 case）

- [ ] **Step 6: 提交**

```bash
git add src/store/db.ts src/store/schema.ts test/item-model-migration.test.ts
git commit -m "feat(store): add v14 item-model migration with legacy status mapping"
```

---

## Task 12: 全量测试与调用方修复

前面 11 个任务改了 `status` 枚举、`createTicket` 默认 stage、`ACTOR_RULES`，会连带打破一批既有测试与调用方。本任务把它们收敛到绿。

**Files:**
- Modify: `src/coordinator/dispatch.ts:146,170-171,247-248`、`src/coordinator/service.ts`、`src/children/manager.ts:52-54,114-117,123,125`、`src/pipeline/orchestrator.ts`、`src/daemon/server.ts:162,173,210,217`、`src/lead/tools.ts:139-140,502`
- Modify: 报错的既有测试文件

- [ ] **Step 1: 跑全量测试，记录失败清单**

Run: `npx vitest run 2>&1 | tail -60`
Expected: 一批 FAIL。把失败文件列成清单再逐个处理，不要边跑边改。

- [ ] **Step 2: 把内部 actor 从 lead 改为 system**

`ACTOR_RULES.lead: () => true` 已取消，以下自称 lead 的内部调用会被新矩阵拒绝，全部改为 `actor: "system"`：

- `src/coordinator/dispatch.ts:171`：`transition(db, { ticketId: root.id, to: "assigned", actor: "lead", ... })` → `to: "active", actor: "system"`
- `src/coordinator/dispatch.ts:248`：同上，`to: "assigned"` → `to: "active"`，`actor: "lead"` → `"system"`
- `src/children/manager.ts:123,125`：`actor: "lead"` → `"system"`

- [ ] **Step 3: 替换所有旧 status 字面量**

按下表全局替换（先 grep 定位，逐处确认语义再改，不要盲目 sed）：

Run: `grep -rn "'backlog'\|\"backlog\"\|'assigned'\|\"assigned\"\|'in_progress'\|\"in_progress\"" src --include="*.ts"`

- `backlog` → 视上下文取 `draft` 或 `ready`：`dispatch.ts:146` 的可派发判定改为 `["ready","active","blocked"].includes(ticket.status)`（**去掉 draft**，这正是"建完先别跑"）；`dispatch.ts:170` 的 `root.status === "backlog"` 改为 `"ready"`
- `assigned` / `in_progress` → `active`
- `src/lead/tools.ts:139-140` 的 `STATUSES` / `LEAD_TRANSITIONS` 常量改为新枚举，并从 `LEAD_TRANSITIONS` 中**移除 `ready`**（lead 不得确认开跑）
- `src/children/manager.ts:52-54` 的 reviewer 前置校验、`manager.ts:114-117` 的 integration 前置校验，改为直接调 `assertRunAllowed`（Task 7），删除各自的内联判断

- [ ] **Step 4: 修既有测试**

测试里构造 ticket 后若依赖"立刻可派发"，需显式确认：

```typescript
const id = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
transition(db, { ticketId: id, to: "ready", actor: "user", reason: "test" });
```

或直接改用 `createdBy: "system"`（生于 `ready`，见 §6.6）。断言 `status === "in_progress"` 的改为 `"active"`。

- [ ] **Step 5: 跑全量测试直到全绿**

Run: `npx vitest run`
Expected: PASS，0 failed。**不得跳过或注释任何测试**；若某个测试断言的是本设计有意改掉的旧行为，改断言并在提交信息里说明。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 7: 提交**

**绝对不要用 `git add -A` 或 `git add .`。** 本仓库工作区有约 140 项与本计划无关的未提交
改动（用户的在途工作，含整个未跟踪的 `src/coordinator/` 目录），`-A` 会把它们全部卷进来。
只显式列出你本任务实际改过的文件：

```bash
git add src/coordinator/dispatch.ts src/children/manager.ts src/lead/tools.ts   # 按实际改动增删
git add test/<你改过的测试文件>
git commit -m "refactor: migrate callers and tests to the item stage model"
```

提交前用 `git status --short` 核对暂存区，确认只有你改的文件。

---

## 完成标准

- [ ] `npx vitest run` 全绿，且新增 5 个测试文件全部通过
- [ ] `npx tsc --noEmit -p tsconfig.json` 无输出
- [ ] 手工验证以下四条在结构上不可能（可在 `npm run plc` 的 REPL 或一次性脚本中试）：
  1. 给 `kind='reminder'` 的行写 `token_budget` → CHECK 报错
  2. `UPDATE tickets SET kind=...` → `item.kind is immutable`
  3. 对 reminder 调 `createAttempt` → `only a task may have a run`
  4. 以 `actor: "lead"` 做 `draft → ready` → `actor 'lead' may not transition`

## 自查记录

- **Spec 覆盖**：本计划覆盖 spec §5.1（Task 1–3）、§5.2（Task 8）、§6.1/§6.2/§6.4（Task 4–5）、§6.3（Task 8）、§6.5（Task 7）、§6.6（Task 5）、§7.1（Task 3）、§7.3（Task 6）、§9（Task 6）、§5.2 耗时口径与 watchdog 口径（Task 9–10）。**未覆盖且已知延后**：§5.3 triggers、§5.4 notifications、§5.5 lead_inbox dedup_scope、§4 投递与兜底、§8 工具面、§10 scheduler、§11 UI 规则、§12 中依赖 trigger 的两条——全部归入 Phase 2 / 3。
- **类型一致性**：`TicketKind` / `TaskStage` / `ReminderStage` / `TicketStatus` 在 Task 1 定义，Task 4–6 沿用；`assertRunAllowed` 在 Task 7 定义，Task 12 Step 3 复用；`pauseAttempt` / `resumeAttempt` 在 Task 8 定义，Task 9 的测试沿用同名。
- **已知取舍**：Task 11 的 `ticketsTableSql` 抽取要求把 Task 1 的 DDL 原样搬进函数体，实现时须保证两处只有一份真实定义（`SCHEMA` 引用该函数），否则会漂移。

# M1 账本+执行链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 DESIGN.md 的 M1：SQLite 账本（tickets/attempts/activities）+ Child Manager（spawn `pi --mode rpc`）+ Event Pipeline 元数据规则 + ticket-tools extension + 最小 CLI。验收标准：命令行建工单 → spawn child → child 干活 → 状态自动扭转 → crash 能被探测。

**Architecture:** 单包 TypeScript (ESM, Node 22)。better-sqlite3 账本（WAL 模式，child extension 跨进程直写同一 DB）。ChildManager 用自实现 LF-only JSONL 分帧与 pi RPC 子进程通信（禁用 readline，pi 文档明确要求）。测试用 `test/fake-pi.js` 模拟 RPC 协议，无需 API key；真 pi 走人工验收。

**Tech Stack:** TypeScript + tsx（免编译运行）、better-sqlite3、commander、vitest、`@mariozechner/pi-coding-agent@0.73.1`（锁死版本）、typebox（extension 工具参数 schema）。

**关键事实（已对 0.73.1 实际文档核实，勿凭记忆改）：**
- RPC 命令：`{"id":"x","type":"prompt","message":"..."}`；响应 `{"type":"response","command":"prompt","success":true,"id":"x"}`；事件无 `id` 字段。
- 事件类型：`agent_start`、`agent_end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`、`queue_update`、`compaction_*`、`auto_retry_*`、`extension_error`。
- 0.73.1 **没有** `get_entries` RPC 命令。session 审计读 JSONL 文件本身（`get_state` 返回 `sessionFile`/`sessionId`）。
- Extension：`export default function (pi: ExtensionAPI)`，`pi.registerTool({name, label, description, parameters, execute(toolCallId, params, signal, onUpdate, ctx)})`，execute 返回 `{content: [{type:"text",text}], details: {}}`，失败用 throw。
- Extension import 解析：jiti 从 extension 文件位置向上找 node_modules —— 我们的 extension 放项目 src/ 下，用绝对路径 `-e` 注入，可 import 项目自身模块。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`

- [ ] **Step 1: 初始化 git 与 npm**

```bash
cd /Users/alice/Workspace/AI/pi-lead-child
git init && npm init -y
npm install @mariozechner/pi-coding-agent@0.73.1 better-sqlite3 commander typebox
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 2: 写 package.json 关键字段**（保留 npm 生成的其余字段）

```json
{
  "name": "pi-lead-child",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "plc": "tsx src/cli.ts"
  }
}
```

- [ ] **Step 3: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 5: 验证并提交**

Run: `npx tsc --noEmit && npx vitest run --passWithNoTests`
Expected: 无错误
```bash
git add -A && git commit -m "chore: scaffold pi-lead-child project"
```

---

### Task 2: Store — schema 与 db 打开

**Files:**
- Create: `src/store/types.ts`, `src/store/schema.ts`, `src/store/db.ts`
- Test: `test/store-db.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/store-db.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.js";

describe("openDb", () => {
  it("creates all tables and enables WAL", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r: any) => r.name);
    for (const t of ["tickets", "attempts", "activities", "inbox", "notes"]) {
      expect(names).toContain(t);
    }
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/store-db.test.ts`
Expected: FAIL（找不到 `../src/store/db.js`）

- [ ] **Step 3: 实现**

```typescript
// src/store/types.ts
export type TicketStatus =
  | "backlog" | "assigned" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type Actor = "user" | "lead" | "child" | "system";
export type ActivityKind =
  | "comment" | "transition" | "milestone" | "notification" | "decision"
  | "attempt_start" | "attempt_end" | "crash";

export interface Ticket {
  id: number; title: string; body: string; status: TicketStatus; brief: string;
  workdir: string | null; created_by: string; created_at: string; updated_at: string;
  last_activity_at: string | null; total_tokens: number; total_cost_usd: number;
  notify_quota_used: number;
}
export interface Attempt {
  id: number; ticket_id: number; role: "executor" | "reviewer";
  session_id: string | null; session_path: string | null; pid: number | null;
  state: "starting" | "running" | "settled" | "crashed" | "stopped";
  model: string | null; started_at: string; ended_at: string | null;
  last_entry_cursor: string | null;
}
export interface Activity {
  id: number; ticket_id: number; attempt_id: number | null; actor: Actor;
  kind: ActivityKind; payload: string; session_cursor: string | null; created_at: string;
}
```

```typescript
// src/store/schema.ts  — DDL 逐字来自 DESIGN.md §3，两处放宽：
//   1. attempts.session_id/session_path 允许 NULL（spawn 后 get_state 才拿到）
//   2. tickets 增加 assigned→blocked 所需扭转由代码层校验，DDL 不管状态机
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog','assigned','in_progress',
                                  'blocked','review','done','cancelled')),
  brief         TEXT NOT NULL,
  workdir       TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at   TEXT,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     REAL    NOT NULL DEFAULT 0,
  notify_quota_used  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  role          TEXT NOT NULL DEFAULT 'executor' CHECK (role IN ('executor','reviewer')),
  session_id    TEXT,
  session_path  TEXT,
  pid           INTEGER,
  state         TEXT NOT NULL DEFAULT 'starting'
                CHECK (state IN ('starting','running','settled','crashed','stopped')),
  model         TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  last_entry_cursor TEXT
);
CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('comment','transition','milestone','notification',
                                'decision','attempt_start','attempt_end','crash')),
  payload       TEXT NOT NULL,
  session_cursor TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  severity      TEXT NOT NULL CHECK (severity IN ('blocker','attention')),
  source        TEXT NOT NULL CHECK (source IN ('structural','semantic')),
  summary       TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','delivered','consumed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
```

```typescript
// src/store/db.ts
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // child extension 跨进程写同一 DB
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/store-db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store test/store-db.test.ts && git commit -m "feat: sqlite store schema and open helper"
```

---

### Task 3: Tickets DAO（create/get/list/appendBody）

**Files:**
- Create: `src/store/tickets.ts`
- Test: `test/tickets.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/tickets.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket, listTickets, appendBody } from "../src/store/tickets.js";

let db: Db;
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db")); });

describe("tickets DAO", () => {
  it("creates and reads a ticket with defaults", () => {
    const id = createTicket(db, { title: "调研 X", brief: "调研 X 的可行性", createdBy: "user" });
    const t = getTicket(db, id)!;
    expect(t.title).toBe("调研 X");
    expect(t.status).toBe("backlog");
    expect(t.body).toBe("");
    expect(t.workdir).toBeNull();
  });

  it("lists tickets filtered by status", () => {
    createTicket(db, { title: "a", brief: "a", createdBy: "user" });
    createTicket(db, { title: "b", brief: "b", createdBy: "lead" });
    expect(listTickets(db).length).toBe(2);
    expect(listTickets(db, { status: ["done"] }).length).toBe(0);
    expect(listTickets(db, { status: ["backlog"] }).length).toBe(2);
  });

  it("appends body sections with separator", () => {
    const id = createTicket(db, { title: "a", brief: "a", createdBy: "user" });
    appendBody(db, id, "第一阶段完成");
    appendBody(db, id, "第二阶段完成");
    const body = getTicket(db, id)!.body;
    expect(body).toContain("第一阶段完成");
    expect(body).toContain("第二阶段完成");
    expect(body.indexOf("第二阶段")).toBeGreaterThan(body.indexOf("第一阶段"));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/tickets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/store/tickets.ts
import type { Db } from "./db.js";
import type { Ticket, TicketStatus } from "./types.js";

export function createTicket(
  db: Db,
  args: { title: string; brief: string; createdBy: "user" | "lead"; workdir?: string },
): number {
  const r = db
    .prepare("INSERT INTO tickets (title, brief, created_by, workdir) VALUES (?, ?, ?, ?)")
    .run(args.title, args.brief, args.createdBy, args.workdir ?? null);
  return Number(r.lastInsertRowid);
}

export function getTicket(db: Db, id: number): Ticket | undefined {
  return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined;
}

export function listTickets(db: Db, filter?: { status?: TicketStatus[] }): Ticket[] {
  if (filter?.status?.length) {
    const qs = filter.status.map(() => "?").join(",");
    return db
      .prepare(`SELECT * FROM tickets WHERE status IN (${qs}) ORDER BY id`)
      .all(...filter.status) as Ticket[];
  }
  return db.prepare("SELECT * FROM tickets ORDER BY id").all() as Ticket[];
}

export function appendBody(db: Db, id: number, text: string): void {
  db.prepare(
    `UPDATE tickets
     SET body = CASE WHEN body = '' THEN ? ELSE body || char(10) || char(10) || '---' || char(10) || char(10) || ? END,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(text, text, id);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/tickets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tickets.ts test/tickets.test.ts && git commit -m "feat: tickets DAO"
```

---

### Task 4: 状态机 transition（权限矩阵在代码层）

**Files:**
- Modify: `src/store/tickets.ts`（追加 transition）
- Create: `src/store/activities.ts`（transition 需要写 activity，先建最小版）
- Test: `test/transition.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/transition.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket, transition } from "../src/store/tickets.js";
import { listActivities } from "../src/store/activities.js";

let db: Db;
let id: number;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  id = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
});

describe("transition state machine", () => {
  it("follows the happy path and records transition activities", () => {
    transition(db, { ticketId: id, to: "assigned", actor: "lead", reason: "spawn" });
    transition(db, { ticketId: id, to: "in_progress", actor: "system", reason: "agent_start" });
    transition(db, { ticketId: id, to: "review", actor: "child", reason: "完成" });
    transition(db, { ticketId: id, to: "done", actor: "lead", reason: "验收通过" });
    expect(getTicket(db, id)!.status).toBe("done");
    const acts = listActivities(db, id).filter((a) => a.kind === "transition");
    expect(acts.length).toBe(4);
    expect(JSON.parse(acts[0].payload)).toMatchObject({ from: "backlog", to: "assigned" });
  });

  it("rejects illegal edges regardless of actor", () => {
    expect(() => transition(db, { ticketId: id, to: "done", actor: "user", reason: "" }))
      .toThrow(/backlog.*done/);
  });

  it("blocks child from privileged transitions", () => {
    transition(db, { ticketId: id, to: "assigned", actor: "lead", reason: "" });
    transition(db, { ticketId: id, to: "in_progress", actor: "system", reason: "" });
    transition(db, { ticketId: id, to: "review", actor: "child", reason: "" });
    // child 不能自我验收
    expect(() => transition(db, { ticketId: id, to: "done", actor: "child", reason: "" }))
      .toThrow(/actor 'child'/);
  });

  it("allows child blocked round-trip only from in_progress", () => {
    transition(db, { ticketId: id, to: "assigned", actor: "lead", reason: "" });
    transition(db, { ticketId: id, to: "in_progress", actor: "system", reason: "" });
    transition(db, { ticketId: id, to: "blocked", actor: "child", reason: "需要决策" });
    transition(db, { ticketId: id, to: "in_progress", actor: "child", reason: "已解答" });
    expect(getTicket(db, id)!.status).toBe("in_progress");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/transition.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/store/activities.ts
import type { Db } from "./db.js";
import type { Activity, ActivityKind, Actor } from "./types.js";

export function addActivity(
  db: Db,
  args: {
    ticketId: number; attemptId?: number; actor: Actor; kind: ActivityKind;
    payload: unknown; sessionCursor?: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO activities (ticket_id, attempt_id, actor, kind, payload, session_cursor)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.ticketId, args.attemptId ?? null, args.actor, args.kind,
      JSON.stringify(args.payload), args.sessionCursor ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function listActivities(db: Db, ticketId: number, limit = 100): Activity[] {
  return db
    .prepare("SELECT * FROM activities WHERE ticket_id = ? ORDER BY id LIMIT ?")
    .all(ticketId, limit) as Activity[];
}
// 账本纪律：本模块永不提供 UPDATE/DELETE。
```

在 `src/store/tickets.ts` 追加：

```typescript
import { addActivity } from "./activities.js";
import type { Actor } from "./types.js";

const ALLOWED: Record<TicketStatus, TicketStatus[]> = {
  backlog: ["assigned", "cancelled"],
  assigned: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "review", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  review: ["done", "in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

// 权限矩阵（DESIGN §4）：硬编码，不依赖提示词自律
const ACTOR_RULES: Record<Actor, (from: TicketStatus, to: TicketStatus) => boolean> = {
  user: () => true,
  lead: () => true,
  child: (f, t) =>
    (f === "in_progress" && (t === "blocked" || t === "review")) ||
    (f === "blocked" && t === "in_progress"),
  system: (f, t) => (f === "assigned" && t === "in_progress") || t === "blocked",
};

export function transition(
  db: Db,
  args: { ticketId: number; to: TicketStatus; actor: Actor; reason: string; attemptId?: number },
): void {
  db.transaction(() => {
    const t = getTicket(db, args.ticketId);
    if (!t) throw new Error(`ticket ${args.ticketId} not found`);
    if (!ALLOWED[t.status].includes(args.to)) {
      throw new Error(`illegal transition ${t.status} -> ${args.to} (ticket #${t.id})`);
    }
    if (!ACTOR_RULES[args.actor](t.status, args.to)) {
      throw new Error(`actor '${args.actor}' may not transition ${t.status} -> ${args.to}`);
    }
    db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(args.to, t.id);
    addActivity(db, {
      ticketId: t.id, attemptId: args.attemptId, actor: args.actor, kind: "transition",
      payload: { from: t.status, to: args.to, reason: args.reason },
    });
  })();
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/transition.test.ts test/tickets.test.ts`
Expected: PASS（含回归）

- [ ] **Step 5: Commit**

```bash
git add src/store test/transition.test.ts && git commit -m "feat: ticket state machine with actor permission matrix"
```

---

### Task 5: Attempts DAO

**Files:**
- Create: `src/store/attempts.ts`
- Test: `test/attempts.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/attempts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket } from "../src/store/tickets.js";
import { createAttempt, getAttempt, updateAttempt } from "../src/store/attempts.js";

let db: Db;
let ticketId: number;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
});

describe("attempts DAO", () => {
  it("creates attempt in starting state and patches fields", () => {
    const id = createAttempt(db, { ticketId, role: "executor" });
    expect(getAttempt(db, id)!.state).toBe("starting");
    updateAttempt(db, id, {
      state: "running", pid: 4242,
      sessionId: "abc", sessionPath: "/tmp/s.jsonl",
    });
    const a = getAttempt(db, id)!;
    expect(a.state).toBe("running");
    expect(a.pid).toBe(4242);
    expect(a.session_path).toBe("/tmp/s.jsonl");
    updateAttempt(db, id, { state: "settled", endedAt: true });
    expect(getAttempt(db, id)!.ended_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/attempts.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/store/attempts.ts
import type { Db } from "./db.js";
import type { Attempt } from "./types.js";

export function createAttempt(
  db: Db,
  args: { ticketId: number; role?: "executor" | "reviewer" },
): number {
  const r = db
    .prepare("INSERT INTO attempts (ticket_id, role) VALUES (?, ?)")
    .run(args.ticketId, args.role ?? "executor");
  return Number(r.lastInsertRowid);
}

export function getAttempt(db: Db, id: number): Attempt | undefined {
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Attempt | undefined;
}

export function updateAttempt(
  db: Db,
  id: number,
  patch: {
    state?: Attempt["state"]; sessionId?: string; sessionPath?: string; pid?: number;
    model?: string; lastEntryCursor?: string; endedAt?: boolean;
  },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.state) { sets.push("state = ?"); vals.push(patch.state); }
  if (patch.sessionId) { sets.push("session_id = ?"); vals.push(patch.sessionId); }
  if (patch.sessionPath) { sets.push("session_path = ?"); vals.push(patch.sessionPath); }
  if (patch.pid !== undefined) { sets.push("pid = ?"); vals.push(patch.pid); }
  if (patch.model) { sets.push("model = ?"); vals.push(patch.model); }
  if (patch.lastEntryCursor) { sets.push("last_entry_cursor = ?"); vals.push(patch.lastEntryCursor); }
  if (patch.endedAt) { sets.push("ended_at = datetime('now')"); }
  if (!sets.length) return;
  db.prepare(`UPDATE attempts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/attempts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/attempts.ts test/attempts.test.ts && git commit -m "feat: attempts DAO"
```

---

### Task 6: JSONL 分帧读取器（LF-only）

**Files:**
- Create: `src/children/jsonl.ts`
- Test: `test/jsonl.test.ts`

- [ ] **Step 1: 写失败测试**（覆盖 pi 文档警告的 U+2028 陷阱与 CRLF）

```typescript
// test/jsonl.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { attachJsonlReader } from "../src/children/jsonl.js";

function collect(chunks: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const stream = new PassThrough();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));
    stream.on("end", () => resolve(lines));
    for (const c of chunks) stream.write(c);
    stream.end();
  });
}

describe("attachJsonlReader", () => {
  it("splits on LF only, even with U+2028 inside JSON strings", async () => {
    const payload = JSON.stringify({ text: "line sep" });
    const lines = await collect([payload + "\n", '{"a":1}\n']);
    expect(lines).toEqual([payload, '{"a":1}']);
    expect(JSON.parse(lines[0]).text).toBe("line sep");
  });

  it("strips trailing CR and handles chunk-split records", async () => {
    const lines = await collect(['{"a":', '1}\r\n{"b"', ":2}\n"]);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes trailing record without newline on end", async () => {
    const lines = await collect(['{"tail":true}']);
    expect(lines).toEqual(['{"tail":true}']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/jsonl.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（逐字采用 pi rpc.md 的官方参考实现）

```typescript
// src/children/jsonl.ts
// pi RPC 要求严格 LF 分帧。禁用 node:readline —— 它把 U+2028/U+2029 也当换行，
// 而这两个字符可以合法出现在 JSON 字符串里（pi docs/rpc.md 明确警告）。
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/jsonl.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/children/jsonl.ts test/jsonl.test.ts && git commit -m "feat: LF-only JSONL framing reader per pi RPC spec"
```

---

### Task 7: fake-pi 测试替身

**Files:**
- Create: `test/fake-pi.mjs`
- Test: `test/fake-pi.test.ts`

fake-pi 按 0.73.1 RPC 协议出牌：`prompt` → response + `agent_start` → assistant `message_end`（带 usage）→ `agent_end`；`get_state` → 返回 sessionFile/sessionId。`FAKE_SCENARIO=crash` 时在 `agent_start` 后直接 `process.exit(1)`。

- [ ] **Step 1: 写 fake-pi**

```javascript
// test/fake-pi.mjs — 模拟 pi --mode rpc 的最小协议实现（仅测试用）
import { StringDecoder } from "node:string_decoder";

const scenario = process.env.FAKE_SCENARIO ?? "happy";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(cmd) {
  if (cmd.type === "get_state") {
    out({ type: "response", command: "get_state", id: cmd.id, success: true,
      data: { sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session-1",
              isStreaming: false, model: null } });
    return;
  }
  if (cmd.type === "prompt") {
    out({ type: "response", command: "prompt", id: cmd.id, success: true });
    out({ type: "agent_start" });
    if (scenario === "crash") process.exit(1);
    out({ type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "done: " + cmd.message.slice(0, 20) }],
      api: "fake", provider: "fake", model: "fake-1", stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
    } });
    out({ type: "agent_end", messages: [] });
    return;
  }
  out({ type: "response", command: cmd.type, id: cmd.id, success: true });
}
```

- [ ] **Step 2: 写冒烟测试**

```typescript
// test/fake-pi.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { attachJsonlReader } from "../src/children/jsonl.js";

describe("fake-pi", () => {
  it("answers prompt with agent_start..agent_end", async () => {
    const proc = spawn(process.execPath, ["test/fake-pi.mjs"]);
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      attachJsonlReader(proc.stdout, (line) => {
        const msg = JSON.parse(line);
        seen.push(msg.type);
        if (msg.type === "agent_end") { proc.kill(); resolve(); }
      });
    });
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "hi", id: "1" }) + "\n");
    await done;
    expect(seen).toEqual(["response", "agent_start", "message_end", "agent_end"]);
  });
});
```

- [ ] **Step 3: 运行确认通过**

Run: `npx vitest run test/fake-pi.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/fake-pi.mjs test/fake-pi.test.ts && git commit -m "test: fake-pi RPC protocol stub"
```

---

### Task 8: RpcClient（命令关联 + 事件分发）

**Files:**
- Create: `src/children/rpc-client.ts`
- Test: `test/rpc-client.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/rpc-client.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { RpcClient } from "../src/children/rpc-client.js";

describe("RpcClient", () => {
  it("correlates responses by id and emits events separately", async () => {
    const proc = spawn(process.execPath, ["test/fake-pi.mjs"]);
    const rpc = new RpcClient(proc);
    const events: string[] = [];
    rpc.on("event", (e: any) => events.push(e.type));

    const state = await rpc.send({ type: "get_state" });
    expect(state.success).toBe(true);
    expect(state.data.sessionId).toBe("fake-session-1");

    const resp = await rpc.send({ type: "prompt", message: "hello" });
    expect(resp.success).toBe(true);

    await new Promise<void>((r) => rpc.on("event", (e: any) => e.type === "agent_end" && r()));
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
    expect(events).not.toContain("response"); // 响应不当事件发
    proc.kill();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/rpc-client.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/children/rpc-client.ts
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { attachJsonlReader } from "./jsonl.js";

export interface RpcResponse {
  type: "response"; command: string; id?: string; success: boolean;
  data?: any; error?: string;
}

export class RpcClient extends EventEmitter {
  private pending = new Map<string, (resp: RpcResponse) => void>();
  private nextId = 1;

  constructor(private proc: ChildProcess) {
    super();
    attachJsonlReader(proc.stdout!, (line) => this.handleLine(line));
  }

  send(cmd: Record<string, unknown>): Promise<RpcResponse> {
    const id = `plc-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const ok = this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
      if (!ok && this.proc.stdin!.destroyed) {
        this.pending.delete(id);
        reject(new Error("child stdin closed"));
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { this.emit("parse_error", line); return; }
    if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg);
      this.pending.delete(msg.id);
    } else {
      this.emit("event", msg);
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/rpc-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/children/rpc-client.ts test/rpc-client.test.ts && git commit -m "feat: RPC client with id correlation over JSONL"
```

---

### Task 9: Event Pipeline 规则（ingest）

**Files:**
- Create: `src/pipeline/ingest.ts`
- Test: `test/ingest.test.ts`

规则（DESIGN §7.1，M1 子集）：任意事件更新 `last_activity_at`；`agent_start` → attempt running + 工单 assigned→in_progress（system）；assistant `message_end` → 累计 tokens/cost；`agent_end` → attempt settled；进程异常退出且未 settled → attempt crashed + crash activity + 工单 → blocked（system）。

- [ ] **Step 1: 写失败测试**

```typescript
// test/ingest.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket, transition } from "../src/store/tickets.js";
import { createAttempt, getAttempt } from "../src/store/attempts.js";
import { listActivities } from "../src/store/activities.js";
import { createIngestor } from "../src/pipeline/ingest.js";

let db: Db;
let ticketId: number;
let attemptId: number;
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db"));
  ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
  transition(db, { ticketId, to: "assigned", actor: "lead", reason: "spawn" });
  attemptId = createAttempt(db, { ticketId });
});

const usageMsg = {
  role: "assistant",
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
    cost: { total: 0.003 } },
};

describe("ingest rules", () => {
  it("agent_start moves attempt to running and ticket to in_progress", () => {
    const ing = createIngestor(db, { ticketId, attemptId });
    ing.onEvent({ type: "agent_start" });
    expect(getAttempt(db, attemptId)!.state).toBe("running");
    expect(getTicket(db, ticketId)!.status).toBe("in_progress");
    expect(getTicket(db, ticketId)!.last_activity_at).not.toBeNull();
  });

  it("accumulates tokens and cost from assistant message_end", () => {
    const ing = createIngestor(db, { ticketId, attemptId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "message_end", message: usageMsg });
    ing.onEvent({ type: "message_end", message: usageMsg });
    const t = getTicket(db, ticketId)!;
    expect(t.total_tokens).toBe(300);
    expect(t.total_cost_usd).toBeCloseTo(0.006);
  });

  it("agent_end settles the attempt; clean exit does nothing more", () => {
    const ing = createIngestor(db, { ticketId, attemptId });
    ing.onEvent({ type: "agent_start" });
    ing.onEvent({ type: "agent_end", messages: [] });
    expect(getAttempt(db, attemptId)!.state).toBe("settled");
    ing.onExit(0);
    expect(getAttempt(db, attemptId)!.state).toBe("settled");
    expect(getTicket(db, ticketId)!.status).toBe("in_progress"); // 未 crash 不动工单
  });

  it("exit before settle marks crash, records activity, blocks ticket", () => {
    const ing = createIngestor(db, { ticketId, attemptId });
    ing.onEvent({ type: "agent_start" });
    ing.onExit(1);
    expect(getAttempt(db, attemptId)!.state).toBe("crashed");
    expect(getTicket(db, ticketId)!.status).toBe("blocked");
    const kinds = listActivities(db, ticketId).map((a) => a.kind);
    expect(kinds).toContain("crash");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ingest.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/pipeline/ingest.ts
import type { Db } from "../store/db.js";
import { getTicket, transition } from "../store/tickets.js";
import { getAttempt, updateAttempt } from "../store/attempts.js";
import { addActivity } from "../store/activities.js";

export interface Ingestor {
  onEvent(event: any): void;
  onExit(code: number | null): void;
}

export function createIngestor(
  db: Db,
  ctx: { ticketId: number; attemptId: number },
): Ingestor {
  const touch = db.prepare(
    "UPDATE tickets SET last_activity_at = datetime('now') WHERE id = ?",
  );
  const addUsage = db.prepare(
    "UPDATE tickets SET total_tokens = total_tokens + ?, total_cost_usd = total_cost_usd + ? WHERE id = ?",
  );

  return {
    onEvent(event: any): void {
      touch.run(ctx.ticketId);
      switch (event.type) {
        case "agent_start": {
          updateAttempt(db, ctx.attemptId, { state: "running" });
          if (getTicket(db, ctx.ticketId)!.status === "assigned") {
            transition(db, {
              ticketId: ctx.ticketId, to: "in_progress", actor: "system",
              reason: "agent_start", attemptId: ctx.attemptId,
            });
          }
          break;
        }
        case "message_end": {
          const m = event.message;
          if (m?.role === "assistant" && m.usage) {
            addUsage.run(m.usage.totalTokens ?? 0, m.usage.cost?.total ?? 0, ctx.ticketId);
          }
          break;
        }
        case "agent_end": {
          updateAttempt(db, ctx.attemptId, { state: "settled", endedAt: true });
          break;
        }
      }
    },

    onExit(code: number | null): void {
      const attempt = getAttempt(db, ctx.attemptId)!;
      if (attempt.state === "settled" || attempt.state === "stopped") return;
      updateAttempt(db, ctx.attemptId, { state: "crashed", endedAt: true });
      addActivity(db, {
        ticketId: ctx.ticketId, attemptId: ctx.attemptId, actor: "system", kind: "crash",
        payload: { exitCode: code },
      });
      const status = getTicket(db, ctx.ticketId)!.status;
      if (status === "in_progress" || status === "assigned") {
        transition(db, {
          ticketId: ctx.ticketId, to: "blocked", actor: "system",
          reason: `child process exited with code ${code}`, attemptId: ctx.attemptId,
        });
      }
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline test/ingest.test.ts && git commit -m "feat: event pipeline ingest rules (metadata, transitions, crash)"
```

---

### Task 10: Child Manager（runTicket 集成）

**Files:**
- Create: `src/children/manager.ts`
- Test: `test/manager.test.ts`

职责：校验工单可执行 → backlog 则先 assigned → createAttempt → spawn 子进程（piBin、`--mode rpc`、`--session-dir`、`-e` extension、cwd=workdir、env 注入 PLC_DB/PLC_TICKET_ID/PLC_ATTEMPT_ID）→ attempt_start activity → get_state 回填 session → 发 prompt → 事件全部交给 ingestor → 等 settle 或退出。

- [ ] **Step 1: 写失败测试**（用 fake-pi 当 piBin）

```typescript
// test/manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket } from "../src/store/tickets.js";
import { getAttempt } from "../src/store/attempts.js";
import { listActivities } from "../src/store/activities.js";
import { runTicket } from "../src/children/manager.js";

const FAKE_PI = process.execPath; // node
const FAKE_PI_ARGS = [resolve("test/fake-pi.mjs")];

let db: Db;
let dbPath: string;
let ticketId: number;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "plc-"));
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  ticketId = createTicket(db, { title: "t", brief: "写一个 hello world", createdBy: "user" });
});

describe("runTicket", () => {
  it("drives a ticket through assigned → in_progress → settled attempt", async () => {
    const { attemptId } = await runTicket(db, ticketId, {
      dbPath, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: mkdtempSync(join(tmpdir(), "plc-sess-")),
    });
    expect(getAttempt(db, attemptId)!.state).toBe("settled");
    expect(getAttempt(db, attemptId)!.session_id).toBe("fake-session-1");
    expect(getTicket(db, ticketId)!.status).toBe("in_progress");
    expect(getTicket(db, ticketId)!.total_tokens).toBe(150);
    const kinds = listActivities(db, ticketId).map((a) => a.kind);
    expect(kinds).toContain("attempt_start");
    expect(kinds).toContain("attempt_end");
  });

  it("detects crash: attempt crashed, ticket blocked", async () => {
    const { attemptId } = await runTicket(db, ticketId, {
      dbPath, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: mkdtempSync(join(tmpdir(), "plc-sess-")),
      env: { FAKE_SCENARIO: "crash" },
    });
    expect(getAttempt(db, attemptId)!.state).toBe("crashed");
    expect(getTicket(db, ticketId)!.status).toBe("blocked");
  });

  it("refuses tickets in terminal states", async () => {
    const doneId = createTicket(db, { title: "d", brief: "d", createdBy: "user" });
    db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(doneId);
    await expect(
      runTicket(db, doneId, { dbPath, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS, prompt: "x",
        sessionDir: tmpdir() }),
    ).rejects.toThrow(/not runnable/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/manager.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/children/manager.ts
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../store/db.js";
import { getTicket, transition } from "../store/tickets.js";
import { createAttempt, updateAttempt } from "../store/attempts.js";
import { addActivity } from "../store/activities.js";
import { createIngestor } from "../pipeline/ingest.js";
import { RpcClient } from "./rpc-client.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_PI_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "pi");
export const TICKET_TOOLS_EXT = join(PROJECT_ROOT, "src", "extension", "ticket-tools.ts");

export interface RunOpts {
  dbPath: string;
  prompt: string;
  sessionDir: string;
  piBin?: string;
  piArgs?: string[];          // 覆盖默认参数（测试用 fake-pi 时传 [fake-pi.mjs]）
  env?: Record<string, string>;
  onEvent?: (event: any) => void; // CLI 进度展示用
}

const RUNNABLE = new Set(["backlog", "assigned", "blocked"]);

export async function runTicket(
  db: Db,
  ticketId: number,
  opts: RunOpts,
): Promise<{ attemptId: number }> {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`ticket ${ticketId} not found`);
  if (!RUNNABLE.has(ticket.status)) {
    throw new Error(`ticket #${ticketId} is not runnable (status: ${ticket.status})`);
  }
  if (ticket.status === "backlog") {
    transition(db, { ticketId, to: "assigned", actor: "lead", reason: "spawn_child" });
  } else if (ticket.status === "blocked") {
    transition(db, { ticketId, to: "in_progress", actor: "lead", reason: "retry attempt" });
    // 让 agent_start 规则幂等：in_progress 时不再扭转
  }

  const attemptId = createAttempt(db, { ticketId });
  mkdirSync(opts.sessionDir, { recursive: true });

  const piBin = opts.piBin ?? DEFAULT_PI_BIN;
  const args = opts.piArgs ?? [
    "--mode", "rpc",
    "--session-dir", opts.sessionDir,
    "-e", TICKET_TOOLS_EXT,
  ];
  const proc = spawn(piBin, args, {
    cwd: ticket.workdir ?? process.cwd(),
    env: {
      ...process.env,
      ...opts.env,
      PLC_DB: opts.dbPath,
      PLC_TICKET_ID: String(ticketId),
      PLC_ATTEMPT_ID: String(attemptId),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  updateAttempt(db, attemptId, { pid: proc.pid });
  addActivity(db, {
    ticketId, attemptId, actor: "system", kind: "attempt_start",
    payload: { pid: proc.pid, piBin },
  });

  const rpc = new RpcClient(proc);
  const ingestor = createIngestor(db, { ticketId, attemptId });
  const settled = new Promise<void>((resolve) => {
    let exited = false;
    rpc.on("event", (event: any) => {
      ingestor.onEvent(event);
      opts.onEvent?.(event);
      if (event.type === "agent_end" && !exited) {
        proc.kill(); // M1: 单 prompt 即收工；常驻 child 属 M2+
      }
    });
    proc.on("exit", (code) => {
      exited = true;
      ingestor.onExit(code);
      resolve();
    });
  });

  // 回填 session 元数据（fake-pi 与真 pi 都支持 get_state）
  const state = await rpc.send({ type: "get_state" });
  if (state.success && state.data) {
    updateAttempt(db, attemptId, {
      sessionId: state.data.sessionId, sessionPath: state.data.sessionFile,
      model: state.data.model?.id,
    });
  }

  await rpc.send({ type: "prompt", message: opts.prompt });
  await settled;

  addActivity(db, {
    ticketId, attemptId, actor: "system", kind: "attempt_end",
    payload: { finalTicketStatus: getTicket(db, ticketId)!.status },
  });
  return { attemptId };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/manager.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 全量回归 + Commit**

Run: `npx vitest run`
Expected: 全部 PASS
```bash
git add src/children/manager.ts test/manager.test.ts && git commit -m "feat: child manager runTicket integration"
```

---

### Task 11: ticket-tools extension

**Files:**
- Create: `src/extension/ticket-tools.ts`
- Test: `test/extension.test.ts`

Extension 在 **child 的 pi 进程内**运行，经 env（PLC_DB/PLC_TICKET_ID/PLC_ATTEMPT_ID）直写同一 SQLite（WAL + busy_timeout 已配）。M1 只有 `ticket_update`；`notify_lead` 属 M3。权限校验直接复用 `transition` 的 actor='child' 矩阵（DRY）。

- [ ] **Step 1: 写失败测试**（捕获 registerTool 后直接调 execute）

```typescript
// test/extension.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { createTicket, getTicket, transition } from "../src/store/tickets.js";
import { listActivities } from "../src/store/activities.js";
import registerExtension from "../src/extension/ticket-tools.js";

let db: Db;
let dbPath: string;
let ticketId: number;
let tool: any;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db");
  db = openDb(dbPath);
  ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
  transition(db, { ticketId, to: "assigned", actor: "lead", reason: "" });
  transition(db, { ticketId, to: "in_progress", actor: "system", reason: "" });
  process.env.PLC_DB = dbPath;
  process.env.PLC_TICKET_ID = String(ticketId);
  process.env.PLC_ATTEMPT_ID = "1";
  const tools: any[] = [];
  registerExtension({ registerTool: (t: any) => tools.push(t), on: () => {} } as any);
  tool = tools.find((t) => t.name === "ticket_update");
});
afterEach(() => {
  delete process.env.PLC_DB; delete process.env.PLC_TICKET_ID; delete process.env.PLC_ATTEMPT_ID;
});

describe("ticket_update tool", () => {
  it("appends milestone to body and records activity", async () => {
    const res = await tool.execute("tc1", { body_append: "阶段一完成" });
    expect(res.content[0].text).toContain(`#${ticketId}`);
    expect(getTicket(db, ticketId)!.body).toContain("阶段一完成");
    expect(listActivities(db, ticketId).map((a) => a.kind)).toContain("milestone");
  });

  it("transitions to review when child claims done", async () => {
    await tool.execute("tc2", { body_append: "全部完成", status: "review", reason: "完成" });
    expect(getTicket(db, ticketId)!.status).toBe("review");
  });

  it("rejects privileged status via the shared permission matrix", async () => {
    await expect(tool.execute("tc3", { body_append: "x", status: "done" }))
      .rejects.toThrow(); // typebox enum 不含 done；即便绕过也会被 transition 矩阵拦截
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/extension/ticket-tools.ts
// 注入 child pi 进程的工单工具（pi -e 绝对路径加载；jiti 从本文件向上解析 node_modules）
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { openDb } from "../store/db.js";
import { appendBody, transition } from "../store/tickets.js";
import { addActivity } from "../store/activities.js";

const CHILD_STATUSES = ["blocked", "review", "in_progress"] as const;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ticket_update",
    label: "Ticket Update",
    description:
      "更新你负责的工单。body_append 追加里程碑摘要（面向'三周后有人只读正文就能接手'的标准）。" +
      "仅在里程碑时调用：完成一个阶段、方向变化、状态扭转。常规进展无需汇报（已自动记录）。" +
      "status: 'blocked'=被阻塞需要决策（必须附 reason），'review'=你认为任务完成待验收，" +
      "'in_progress'=解除阻塞恢复执行。你无权标记 done。",
    parameters: Type.Object({
      body_append: Type.String({ description: "追加到工单正文的里程碑摘要" }),
      status: Type.Optional(
        Type.Union(CHILD_STATUSES.map((s) => Type.Literal(s))),
      ),
      reason: Type.Optional(Type.String({ description: "状态扭转原因" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const dbPath = process.env.PLC_DB;
      const ticketId = Number(process.env.PLC_TICKET_ID);
      const attemptId = Number(process.env.PLC_ATTEMPT_ID) || undefined;
      if (!dbPath || !ticketId) {
        throw new Error("ticket-tools: PLC_DB / PLC_TICKET_ID env not set");
      }
      const db = openDb(dbPath);
      try {
        appendBody(db, ticketId, params.body_append);
        addActivity(db, {
          ticketId, attemptId, actor: "child", kind: "milestone",
          payload: { text: params.body_append, status: params.status ?? null },
        });
        if (params.status) {
          transition(db, {
            ticketId, to: params.status, actor: "child",
            reason: params.reason ?? "", attemptId,
          });
        }
        return {
          content: [{
            type: "text" as const,
            text: `Ticket #${ticketId} updated${params.status ? `, status → ${params.status}` : ""}.`,
          }],
          details: {},
        };
      } finally {
        db.close();
      }
    },
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/extension.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension test/extension.test.ts && git commit -m "feat: ticket-tools pi extension (ticket_update)"
```

---

### Task 12: CLI（plc）

**Files:**
- Create: `src/cli.ts`, `src/config.ts`
- Test: `test/cli.test.ts`（测 prompt 组装纯函数；命令行为靠 Task 13 人工验收）

- [ ] **Step 1: 写失败测试**

```typescript
// test/cli.test.ts
import { describe, it, expect } from "vitest";
import { buildChildPrompt } from "../src/config.js";

describe("buildChildPrompt", () => {
  it("contains brief, body and discipline clauses", () => {
    const p = buildChildPrompt({
      id: 7, title: "调研 X", brief: "调研 X 可行性", body: "已有结论 A",
    } as any);
    expect(p).toContain("#7");
    expect(p).toContain("调研 X 可行性");
    expect(p).toContain("已有结论 A");
    expect(p).toContain("ticket_update");
    expect(p).toContain("无权标记 done");
  });

  it("omits body section when empty", () => {
    const p = buildChildPrompt({ id: 8, title: "t", brief: "b", body: "" } as any);
    expect(p).not.toContain("当前工单正文");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 config + CLI**

```typescript
// src/config.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Ticket } from "./store/types.js";

export function dataDir(): string {
  const dir = process.env.PLC_DATA_DIR ?? join(homedir(), ".pi-lead-child");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function dbPath(): string {
  return join(dataDir(), "plc.db");
}
export function sessionDir(ticketId: number): string {
  return join(dataDir(), "sessions", `ticket-${ticketId}`);
}

// child 初始 prompt（DESIGN §6.1/§6.3：brief + 正文 + 纪律；不塞历史 session）
export function buildChildPrompt(t: Pick<Ticket, "id" | "title" | "brief" | "body">): string {
  const parts = [
    `你是工单 #${t.id}（${t.title}）的执行 agent。`,
    `## 任务说明\n${t.brief}`,
  ];
  if (t.body) parts.push(`## 当前工单正文（此前的里程碑摘要）\n${t.body}`);
  parts.push(
    [
      "## 工作纪律",
      "- 常规进展无需汇报，你的全部过程已自动记录。",
      "- 到达里程碑（完成阶段/方向变化/被阻塞/自认为完成）时调用 ticket_update 工具，",
      "  摘要按'三周后有人只读正文就能接手'的标准写。",
      "- 被阻塞需要人决策 → ticket_update(status='blocked', reason=...)后停止。",
      "- 自认为完成 → ticket_update(status='review')。你无权标记 done。",
    ].join("\n"),
  );
  return parts.join("\n\n");
}
```

```typescript
// src/cli.ts
import { Command } from "commander";
import { openDb } from "./store/db.js";
import { createTicket, getTicket, listTickets } from "./store/tickets.js";
import { listActivities } from "./store/activities.js";
import { runTicket } from "./children/manager.js";
import { buildChildPrompt, dbPath, sessionDir } from "./config.js";

const program = new Command().name("plc").description("pi-lead-child M1 CLI");

program
  .command("create <title>")
  .requiredOption("--brief <text>", "任务说明")
  .option("--workdir <path>", "child 的工作目录")
  .action((title, opts) => {
    const db = openDb(dbPath());
    const id = createTicket(db, {
      title, brief: opts.brief, workdir: opts.workdir, createdBy: "user",
    });
    console.log(`created ticket #${id}`);
  });

program.command("list").action(() => {
  const db = openDb(dbPath());
  for (const t of listTickets(db)) {
    console.log(
      `#${t.id}\t[${t.status}]\t${t.title}\ttokens=${t.total_tokens}\t$${t.total_cost_usd.toFixed(4)}`,
    );
  }
});

program.command("show <id>").action((id) => {
  const db = openDb(dbPath());
  const t = getTicket(db, Number(id));
  if (!t) { console.error(`ticket #${id} not found`); process.exit(1); }
  console.log(`#${t.id} [${t.status}] ${t.title}`);
  console.log(`brief: ${t.brief}`);
  if (t.body) console.log(`\n--- body ---\n${t.body}`);
  console.log(`\n--- activities ---`);
  for (const a of listActivities(db, t.id)) {
    console.log(`${a.created_at}  ${a.actor}/${a.kind}  ${a.payload}`);
  }
});

program
  .command("work <id>")
  .option("--prompt <text>", "覆盖默认 prompt（默认由 brief+body+纪律组装）")
  .action(async (id, opts) => {
    const ticketId = Number(id);
    const db = openDb(dbPath());
    const t = getTicket(db, ticketId);
    if (!t) { console.error(`ticket #${id} not found`); process.exit(1); }
    console.log(`spawning child for ticket #${ticketId}...`);
    const { attemptId } = await runTicket(db, ticketId, {
      dbPath: dbPath(),
      sessionDir: sessionDir(ticketId),
      prompt: opts.prompt ?? buildChildPrompt(t),
      onEvent: (e) => {
        if (e.type === "agent_start") console.log("· agent started");
        if (e.type === "tool_execution_start") console.log(`· tool: ${e.toolName}`);
        if (e.type === "agent_end") console.log("· agent finished");
      },
    });
    const after = getTicket(db, ticketId)!;
    console.log(`attempt #${attemptId} done. ticket status: ${after.status}`);
  });

program.parse();
```

- [ ] **Step 4: 运行确认通过 + 手动冒烟**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS

Run（用临时数据目录冒烟，不碰真 DB）:
```bash
PLC_DATA_DIR=$(mktemp -d) npm run plc -- create "测试工单" --brief "冒烟" && \
PLC_DATA_DIR=$(mktemp -d) npm run plc -- list
```
Expected: 第一条输出 `created ticket #1`（注意两条命令各自临时目录，list 为空属预期；真正联合冒烟在 Task 13）

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/config.ts test/cli.test.ts && git commit -m "feat: plc CLI (create/list/show/work)"
```

---

### Task 13: 真 pi 人工验收

**Files:**
- Create: `docs/ACCEPTANCE.md`

- [ ] **Step 1: 写验收文档**

```markdown
# M1 人工验收（真 pi）

前置：`ANTHROPIC_API_KEY` 已设置（或 pi 支持的其他 provider key）。

1. 准备沙箱工作目录：
   mkdir -p /tmp/plc-demo && cd /tmp/plc-demo && git init
2. 建工单：
   cd /Users/alice/Workspace/AI/pi-lead-child
   npm run plc -- create "hello world" --brief "在当前目录写一个 hello.py，运行验证输出 hello world" --workdir /tmp/plc-demo
3. 执行：
   npm run plc -- work 1
   预期：进度行出现 agent started / tool: bash 或 write / tool: ticket_update / agent finished
4. 验收清单：
   - [ ] `npm run plc -- show 1`：status 为 review（child 完成后自行扭转）
   - [ ] body 含 child 写入的里程碑摘要
   - [ ] activities 依次含 transition(backlog→assigned→in_progress→review)、
         attempt_start、milestone、attempt_end
   - [ ] tokens/cost 非零
   - [ ] attempts.session_path 指向真实 JSONL，文件可读（全量事实源）
   - [ ] /tmp/plc-demo/hello.py 存在且可运行
5. crash 探测（人工）：
   再建一个工单并 work，中途 `kill -9 <pi 子进程 pid>`，
   预期：attempt=crashed，ticket=blocked，activities 含 crash。
```

- [ ] **Step 2: 按文档逐条执行验收**

Run: 按 `docs/ACCEPTANCE.md` 步骤 1–5 执行。
Expected: 全部勾选。如有失败，回到对应 Task 修复后重新验收（勿跳过）。

- [ ] **Step 3: 全量回归 + Commit + README**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

```bash
git add docs/ACCEPTANCE.md && git commit -m "docs: M1 acceptance checklist (real pi)"
```

---

## Self-Review 已执行

- **Spec 覆盖**：DESIGN §3 schema（Task 2）、§4 状态机+权限矩阵（Task 4）、§6 child spawn/extension/prompt 纪律（Task 10/11/12）、§7.1 事件规则 M1 子集（Task 9）、M1 验收标准（Task 13）。inbox/notes 表已建但无逻辑（M3/M4），符合 M1 范围。
- **一致性**：`transition`/`addActivity`/`updateAttempt`/`runTicket`/`buildChildPrompt` 签名在各 Task 间已核对一致；env 变量统一为 `PLC_DB`/`PLC_TICKET_ID`/`PLC_ATTEMPT_ID`；fake-pi 的事件序列与 ingest 测试假设一致。
- **已知妥协（M1 有意为之）**：child 单 prompt 即收工（常驻 child 与 steer 属 M2+）；`last_entry_cursor` 建列未写（读 session 文件属 L3 检索，M2）；blocked 重试的扭转发生在 spawn 前而非 agent_start（幂等处理见 Task 10 注释）。

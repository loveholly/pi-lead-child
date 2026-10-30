# Item / Run / Trigger / Notification —— 事项模型重构设计

日期：2026-07-27
状态：设计已确认，经对抗式评审修订，待实现

## 1. 背景与问题

现有模型把"提醒"和"任务"塞进同一张 `tickets` 表，且 `ticket.status` 一个字段同时表达
"这件事推进到哪一步"和"此刻有没有进程在跑"。由此产生三类问题：

1. **任务列表被提醒污染。** `src/lead/prompt.ts:38` 用一句提示词约定
   `"提醒我 X" → 建工单（不 spawn child，这是提醒不是执行）`，靠 lead 自律区分。而
   `src/store/tickets.ts:161` 自己写着 `// 权限矩阵（DESIGN §4）：硬编码，不依赖提示词自律`
   —— 提醒这条路径违反了仓库自己的原则。
2. **提醒显示执行细节。** timing / checkpoints / artifacts / logs 无条件渲染，提醒页面
   全是空脚手架。
3. **缺少"建完先别跑"和"执行中手动暂停"。** 状态机里没有对应概念，只能靠新增状态打补丁。

另有两个在设计过程中发现的既有缺陷：

- **循环提醒同样污染列表。** `src/store/schema.ts:125` `spawn INTEGER ... -- 0=仅建单提醒`，
  `spawn=0` 的例行项每次触发照样 `createRootTicket()`。"每周一提醒交周报"跑一年留 52 条
  永不执行、永不 done 的记录。
- **提醒会被通知去抖静默吞掉。** `src/pipeline/scheduler.ts:30` 以 `severity: "attention"`
  投递提醒；`src/store/inbox.ts:22-32` 对 attention 的规则是"同 ticket 已有 pending →
  合并进 `payload.merged`，返回 `suppressed: true`"；而 `scheduler.ts:35` 不看返回值，
  无条件 `clearRemind()`。若该工单已有待处理 attention，提醒被折叠、`remind_at` 被清空、
  无重试。**提醒静默丢失。**

## 2. 设计约束

- 本仓库处于 demo 阶段，**无生产数据、无迁移负担**。设计以语义正确性和可扩展性为准，
  不以"改动现有表/枚举/测试的成本"为取舍依据。
- 不变量必须硬编码在结构里（schema CHECK、DB trigger、唯一入口的前置判断），
  不依赖提示词自律。**CHECK 无法跨行约束，跨行不变量一律用 BEFORE INSERT/UPDATE trigger。**
- 需要为将来接入外部 webhook 留出扩展位，且扩展时不应触及已有 action 执行器。

## 3. 四个原语

### 3.1 Item（事项）

一件我要记着、或要被做完的事。

`kind: 'reminder' | 'task'`，区分的不是标签而是**完成的定义**：

- `reminder` 的完成 = 我确认了（acknowledge）
- `task` 的完成 = 有人/有 agent 把活干了（execute）

由此推出两条硬约束：**reminder 永远不能拥有 Run**；**两种 kind 各有独立状态机**。

`kind` **不可变**。不存在 reminder → task 的转换路径（理由见 §7.2）。

### 3.2 Run（执行）

一次逻辑执行**片段**，持有 session / pid / runtime / cost，并作为 checkpoints、
artifacts、logs 的挂载点。

**Item 与 Run 是两条独立生命周期。** 这是整个设计的核心：现有 `ticket.status` 里
`assigned` 和 `in_progress` 其实是运行态，把它们移到 Run 上之后，"建完先别跑"和
"手动暂停"都不再需要新增 Item 状态。

Run 是逻辑执行片段而非操作系统进程：暂停时进程终止、`pid` 置空，但 Run 行存活，
`session_id` 保留；恢复时复用同一行、同一 session、新 pid。跨 Run 的续跑（崩溃后重试）
用 `resumed_from_run_id` 表达。

Run 有三种形态，它们的创建前置条件不同（§6.5）：`role='executor'` 的执行 Run、
`role='executor' purpose='integration'` 的整合 Run、`role='reviewer'` 的评审 Run。

### 3.3 Trigger（触发规则）

`{ source, action }`。**规则不是事项** —— "每周一提醒我交周报"是规则（没有截止期、
永不完成），"这周一那次提醒"才是 Item。

这条边界同时决定了 webhook 接在哪：webhook 是"收到请求时做某事"，与 cron 同类，与 Item 不同类。

可扩展性的关键在于 **source 与 action 分离**：时间触发是 poll（scheduler 扫
`next_fire_at`），webhook 是 push（入站 HTTP）。若把 triggers 设计成"scheduler 轮询的
一张表"，webhook 插不进来，只能再开一条平行路径。source/action 分离后，scheduler 降级为
众多 source 生产者之一，webhook 接收器是另一个，**共用同一个 action 执行器**。

### 3.4 Notification（通知）

拆成**两张表**，而非一张带 `audience` 字段的表：

| | `lead_inbox` | `notifications` |
|---|---|---|
| 收件人 | lead agent | 人 |
| lead 的动作 | **消化**——判断要不要管、要不要转告 | **播报**——已确定要给你的，负责说好 |
| 能否不说 | 能 | 不能 |
| 去重 | 去抖 + 熔断（该合并） | 恰好一次（**绝不合并**） |
| 状态 | pending → delivered → consumed | pending → delivered → acked |
| 性质 | 内部工作队列，可有损 | 持久记录，不可丢 |

规则完全相反，且 lead 对两者的动词不同（决定 vs 转述）。合成一张表意味着每条规则都要
`if audience`，且"lead 可自行消化"这一能力会漏到用户通知上。

## 4. 通知投递：lead 表达，系统保证

用户期望 lead 是"一直在线的私人助理"，通知应由 lead 说出来。实现上把**表达**与
**送达保证**分开：

```
事件发生 → notifications 落库（真相，state=pending）
              ↓
         唤醒 lead，把通知交给它
              ↓
         lead 在对话里播报，可附加上下文
              ↓
         系统在真正显示时标 delivered（不是 lead 声称读了就算）
              ↓
         用户 ack
```

`notifications` 表是事实，lead 是表达层。lead **不拥有**通知：不能决定要不要说、
不能改写核心内容、不能因忙而吞掉。

**兜底闸门**：一条 `urgency='immediate'` 的通知 pending 超过 `PLC_NOTIFY_FALLBACK_MS`
（默认 120000）仍未 delivered，系统直接推送给用户，并记 `delivered_via='fallback'`。
lead 挂了、卡住了、判断失误，用户照样收得到。`delivered_via` 可观测，便于发现 lead 在漏播。

**攒批策略**：`urgency='immediate'`（提醒到点、blocker）立即唤醒 lead，不攒批；
`urgency='batchable'`（工单完成、预算告警、逾期）可攒到 lead 下一次开口。

**衍生能力**：lead 能读 `notifications`，于是拥有"我提醒过你什么"的记忆。用户回一句
"周报交了"，lead 可直接 ack 掉对应通知，无需用户再操作。

## 5. 表结构

> **命名映射（重要）**：本章用 `items` / `runs` 指代**概念**。落地时**保留现有物理表名与
> 列名**，改名单独推迟（§14）。实现时按下表对照，不要新建 `items` / `runs` 表：
>
> | 本 spec 写的 | 实际落地 |
> |---|---|
> | `items` 表 | 现有 `tickets` 表（增列 + 改约束） |
> | `runs` 表 | 现有 `attempts` 表（增列 + 改约束） |
> | `item_id` | 现有 `ticket_id` |
> | `run_id` | 现有 `attempt_id` |
> | `items.stage` | 现有 `tickets.status`（枚举值按 §6.1/§6.2 重定义） |
> | `items.plan_state` | 现有 `tickets.orchestration_state`（保持原名） |
> | `items.first_run_at` / `closed_at` / `stage_changed_at` | 现有 `first_started_at` / `completed_at` / `status_changed_at`（保持原名） |
> | `runs.state='finished'` / `'failed'` | 现有 `attempts.state='settled'` / `'crashed'`（保持原值） |
>
> 因此 §5.6「删除与去向」中标注为「改名」的几项**本期不执行**，只执行真正的新增、
> 删除与约束变更。`kind`、`defer_until`、`paused_at`、`paused_ms`、`dedup_scope`
> 以及 `triggers` / `trigger_fires` / `notifications` 三张新表是真实新增。

### 5.1 items

```sql
CREATE TABLE items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('task','reminder')),
  stage           TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  brief           TEXT NOT NULL DEFAULT '',
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('urgent','high','normal','low')),
  project_id      INTEGER REFERENCES projects(id),

  -- 时间
  due_at          TEXT,
  defer_until     TEXT,          -- 仅 task（reminder 已有 remind_at，语义重复）
  remind_at       TEXT,          -- 仅 reminder

  -- 层级（仅 task）
  parent_item_id  INTEGER REFERENCES items(id),
  root_item_id    INTEGER REFERENCES items(id),   -- 可空：自根行需 insert-then-update

  -- 执行配置（仅 task），全部可空
  workdir         TEXT,
  requested_runtime TEXT, requested_model TEXT,
  purpose         TEXT, review_policy TEXT,
  max_depth       INTEGER, max_children INTEGER, max_concurrency INTEGER,
  token_budget    INTEGER, cost_budget_usd REAL,
  retry_limit     INTEGER,                        -- 可空；task 缺省由代码补 1

  -- 计划编排（仅 task）—— 承接原 tickets.orchestration_state / active_plan_revision
  plan_state      TEXT CHECK (plan_state IS NULL OR
                    plan_state IN ('none','planning','waiting','integrating','failed')),
  active_plan_revision INTEGER,

  -- 溯源
  created_by      TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_by_run_id  INTEGER REFERENCES runs(id),
  origin_trigger_id  INTEGER REFERENCES triggers(id),

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,                          -- 承接原 tickets.last_activity_at
  first_run_at    TEXT,
  closed_at       TEXT,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  REAL NOT NULL DEFAULT 0,

  -- (C1) stage 必须属于本 kind 的状态机
  CHECK (
    (kind = 'task'     AND stage IN ('draft','ready','active','blocked','review','done','cancelled'))
    OR
    (kind = 'reminder' AND stage IN ('scheduled','fired','acked','cancelled'))
  ),

  -- (C2) reminder 不得携带任何执行侧字段。此列表必须与上方「执行配置」「计划编排」
  --      「层级」三组完全一致；新增执行列时必须同步加入本 CHECK。
  CHECK (kind = 'task' OR (
    parent_item_id IS NULL AND root_item_id IS NULL
    AND workdir IS NULL AND requested_runtime IS NULL AND requested_model IS NULL
    AND purpose IS NULL AND review_policy IS NULL AND retry_limit IS NULL
    AND max_depth IS NULL AND max_children IS NULL AND max_concurrency IS NULL
    AND token_budget IS NULL AND cost_budget_usd IS NULL
    AND plan_state IS NULL AND active_plan_revision IS NULL
    AND defer_until IS NULL
    AND first_run_at IS NULL AND total_tokens = 0 AND total_cost_usd = 0
  )),

  -- (C3) remind_at 双向约束：task 不得有；scheduled 的 reminder 必须有，否则永不触发
  CHECK (kind = 'reminder' OR remind_at IS NULL),
  CHECK (kind <> 'reminder' OR stage <> 'scheduled' OR remind_at IS NOT NULL),

  -- (C4) 只有 user / lead 直接创作的 item 才可能停在 draft（见 §6.6）
  CHECK (stage <> 'draft' OR created_by IN ('user','lead'))
);

-- (T1) kind 不可变（结构保证，非约定）
CREATE TRIGGER items_kind_immutable BEFORE UPDATE OF kind ON items
WHEN OLD.kind <> NEW.kind
BEGIN SELECT RAISE(ABORT, 'item.kind is immutable'); END;

-- (T2) 跨行不变量：树上的父/根必须是 task。CHECK 无法跨行，只能用 trigger。
--      §7.1 论证的是「reminder 不能当 parent」——即禁止 task 指向 reminder，
--      与 (C2) 禁止 reminder 当 child 是两个方向，两者都需要。
CREATE TRIGGER items_tree_is_task_i BEFORE INSERT ON items
WHEN (NEW.parent_item_id IS NOT NULL
        AND (SELECT kind FROM items WHERE id = NEW.parent_item_id) <> 'task')
  OR (NEW.root_item_id IS NOT NULL AND NEW.root_item_id <> NEW.id
        AND (SELECT kind FROM items WHERE id = NEW.root_item_id) <> 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of an item must be a task'); END;

CREATE TRIGGER items_tree_is_task_u BEFORE UPDATE OF parent_item_id, root_item_id ON items
WHEN (NEW.parent_item_id IS NOT NULL
        AND (SELECT kind FROM items WHERE id = NEW.parent_item_id) <> 'task')
  OR (NEW.root_item_id IS NOT NULL AND NEW.root_item_id <> NEW.id
        AND (SELECT kind FROM items WHERE id = NEW.root_item_id) <> 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of an item must be a task'); END;

CREATE INDEX items_by_view  ON items (kind, stage, defer_until);
CREATE INDEX items_by_root  ON items (root_item_id);
CREATE INDEX items_remind   ON items (remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX items_due      ON items (due_at)    WHERE due_at IS NOT NULL;
```

**`root_item_id` 的插入协议**：自根 task 的 root 是自己的 id，而 id 由 AUTOINCREMENT
在插入后才产生，单条 INSERT 无法表达。因此该列**可空**，沿用现有写法
（`src/store/tickets.ts:20-39`：先插 NULL，再 `UPDATE ... SET root_item_id = ?`，
同一事务内）。保留 `REFERENCES items(id)` 使 `PRAGMA foreign_key_check`
（`src/store/db.ts:226-227` 的迁移守卫）仍能发现悬挂根。

**关于"基座 + 扩展"**：单表 + CHECK 约束，而非 `items` / `item_execution` 双表 1:1。
双表要为每次读取付一次 join，换来的隔离用 CHECK 同样能拿到——(C2) 让"给提醒设了
token 预算"在数据库层面无法写入。可空列在 SQLite 中几乎零成本。

### 5.2 runs

```sql
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id),
  role            TEXT NOT NULL CHECK (role IN ('executor','reviewer')),
  purpose         TEXT NOT NULL CHECK (purpose IN ('execution','review','integration','learning')),
  state           TEXT NOT NULL
                  CHECK (state IN ('starting','running','paused','finished','failed','stopped')),
  runtime         TEXT NOT NULL, model TEXT, runtime_version TEXT,
  session_id      TEXT, session_path TEXT, external_session_id TEXT,
  pid             INTEGER,                      -- 暂停期间为 NULL
  resumed_from_run_id INTEGER REFERENCES runs(id),   -- 崩溃后续跑，非暂停恢复
  event_cursor    TEXT, last_entry_cursor TEXT,
  event_log_dirty INTEGER NOT NULL DEFAULT 0,   -- 承接原 attempts.event_log_dirty
  exit_code       INTEGER, error_code TEXT, error_message TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at       TEXT,                         -- 当前这次暂停的起点；恢复时清空
  paused_ms       INTEGER NOT NULL DEFAULT 0,   -- 历次暂停累计，支持反复暂停/恢复
  ended_at        TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  cost_known      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX runs_by_item  ON runs (item_id, state);
CREATE INDEX runs_active   ON runs (state) WHERE state IN ('starting','running','paused');
```

checkpoints / artifacts / decision_requests / approvals 的外键由 `attempt_id` 改指 `run_id`。

**耗时口径**（现有 `src/store/timing.ts` 的 `activeExecutionMs` 必须相应修改，否则
暂停时长会被计入执行时长）：

```
pausedSoFar(run) = run.paused_ms + (run.paused_at ? now - run.paused_at : 0)
activeExecutionMs = Σ over runs of ((run.ended_at ?? now) - run.started_at - pausedSoFar(run))
```

**watchdog 口径**：`src/pipeline/watchdog.ts` 的心跳超时判定必须跳过 `state='paused'` 的
Run —— 暂停是用户主动行为，不是停滞。

### 5.3 triggers

```sql
CREATE TABLE triggers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),

  -- source
  source_type     TEXT NOT NULL CHECK (source_type IN ('once','cron','webhook')),
  fire_at         TEXT,                       -- once
  cron_expr       TEXT, cron_tz TEXT,         -- cron
  webhook_path    TEXT UNIQUE,                -- webhook
  webhook_secret_ref TEXT,                    -- 环境变量名，**绝不内联存密钥**
  next_fire_at    TEXT,                       -- once/cron 有值；webhook 为 NULL

  -- action
  action_type     TEXT NOT NULL
                  CHECK (action_type IN ('create_item','create_and_start','start_item')),
  action_payload  TEXT NOT NULL DEFAULT '{}',

  last_fired_at   TEXT,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (source_type <> 'once'    OR fire_at IS NOT NULL),
  CHECK (source_type <> 'cron'    OR cron_expr IS NOT NULL),
  CHECK (source_type <> 'webhook' OR webhook_path IS NOT NULL),

  -- (C5) 自动开跑的能力只有 user 建的 trigger 才有。见下方「权限传递」。
  CHECK (action_type = 'create_item' OR created_by = 'user')
);

-- 幂等 + 触发历史。cron 永不重复触发同一 occurrence；webhook 永不重复处理同一 delivery。
CREATE TABLE trigger_fires (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id      INTEGER NOT NULL REFERENCES triggers(id),
  dedup_key       TEXT NOT NULL,   -- once/cron: occurrence ISO；webhook: 请求携带的 delivery id
  occurrence_at   TEXT NOT NULL,   -- 本次触发对应的逻辑时刻，供 action 执行器使用
  fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','succeeded','failed')),
  error           TEXT,
  produced_item_id INTEGER REFERENCES items(id),
  UNIQUE (trigger_id, dedup_key)
);
```

#### action_payload 契约

`create_item` / `create_and_start` 的 payload 是一个 item 模板。`initial_stage` 的合法域
**按 kind 分开**（`draft`/`ready` 只属于 task 状态机，reminder 用不了）：

| payload.kind | 合法 initial_stage | 执行器的额外注入 |
|---|---|---|
| `task` | `draft` \| `ready` | 无 |
| `reminder` | `scheduled`（唯一合法值） | **`remind_at := trigger_fires.occurrence_at`** |

reminder 的 `remind_at` 必须由执行器**每次触发时注入**，不能写死在静态模板里：写死会得到
一个恒在过去的固定时刻，不写则 `remind_at IS NULL` 而 `NULL <= now` 恒为 NULL，
该 reminder 永远停在 `scheduled`——正是本设计要消灭的静默丢失。`occurrence_at` 因此是
action 执行器的**显式输入参数**，而非从 payload 读取。

#### 权限传递：trigger 不得成为绕过用户确认的通道

`initial_stage='ready'` 是一次 INSERT 而非 stage 跃迁，不经过 §6.4 的 actor 校验；
`create_and_start` / `start_item` 更是直接产出 Run。若不加限制，lead 可以建一个
`cron(*/1) → create_and_start` 的 trigger，在零用户确认的情况下拿到运行中的 child——
正是 §6.4 声称结构上不可能的事。将来接入 webhook 后，同一行还可被未认证的入站请求触达。

因此：

- (C5) 已限定 `create_and_start` / `start_item` 仅 `created_by='user'` 的 trigger 可用。
- 执行器在展开 `create_item` 时，若 `initial_stage='ready'` 而 `trigger.created_by <> 'user'`，
  **降级为 `draft`** 并在 `trigger_fires.error` 记一条降级说明。（不 ABORT：静默降级到安全侧
  比让例行任务整条挂掉更符合意图。）
- `webhook` source 的 trigger 恒被视为 `created_by` 非 user，无论建它的是谁——入站请求的
  发起方不是用户本人。§13 实现 webhook 时须落实这一条。

### 5.4 notifications

```sql
CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER REFERENCES items(id),      -- 可空：不是所有通知都挂事项
  kind            TEXT NOT NULL,                     -- reminder | item_done | budget | crash | ...
  urgency         TEXT NOT NULL CHECK (urgency IN ('immediate','batchable')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','delivered','acked')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  delivered_via   TEXT CHECK (delivered_via IN ('lead','fallback')),
  acked_at        TEXT
);

CREATE INDEX notifications_pending ON notifications (state, urgency, created_at);
```

**此表无去抖、无熔断。** 每条独立送达。

### 5.5 lead_inbox

即现有 `inbox`，改名，`ticket_id` → `item_id` 且**去掉 NOT NULL**（并非所有内部事件都挂事项）。

**去抖与熔断的分组键必须显式化。** 现有实现按 `WHERE ticket_id = ?` 分组
（`src/store/inbox.ts:23-25` 去抖、`inbox.ts:35-37` 熔断）。SQLite 中 `col = NULL`
恒不为真，直接放开 NOT NULL 会使新引入的这一类行**既不去抖也不熔断**——恰好在新增
的场景上失去保护。因此加一列显式分组键：

```sql
ALTER ... dedup_scope TEXT NOT NULL
-- 挂事项的行：'item:' || item_id
-- 不挂事项的行：'sys:' || <source 派生的稳定键>
```

去抖与熔断一律按 `dedup_scope` 分组，不再按 `item_id`。

**熔断计数器搬家**：现有实现把配额记在 `tickets.notify_quota_used`
（`inbox.ts:40-41`），§5.1 的 items 已不含该列。改为直接在 `lead_inbox` 内按
`dedup_scope` 统计一小时内的 blocker 行数，不再维护冗余计数列。

### 5.6 删除与去向

| 原物 | 去向 |
|---|---|
| `schedules` 表、`src/store/schedules.ts` | 被 `triggers` 吸收 |
| `tickets.remind_at` 承载提醒的用法 | `items.remind_at` 仅供 `kind='reminder'` |
| `src/lead/prompt.ts:38` 那条约定 | 删除，改由 `create_task` / `create_reminder` 两个工具表达 |
| `tickets.orchestration_state` | → `items.plan_state`（同枚举，改名） |
| `tickets.active_plan_revision` | → `items.active_plan_revision`（不变） |
| `tickets.last_activity_at` | → `items.last_activity_at`（不变） |
| `tickets.notify_quota_used` | 删除，熔断计数改在 `lead_inbox` 内统计（§5.5） |
| `tickets.first_started_at` / `completed_at` / `status_changed_at` | → `items.first_run_at` / `closed_at` / `stage_changed_at` |
| `attempts.event_log_dirty` | → `runs.event_log_dirty`（不变） |
| `attempts.state='settled'/'crashed'` | → `runs.state='finished'/'failed'` |

## 6. 状态机与权限

### 6.1 task stage

```
draft    → ready | cancelled
ready    → active | draft | cancelled
active   → blocked | review | ready | cancelled
blocked  → active | ready | cancelled
review   → done | active | cancelled
done     → active                       (返工)
cancelled→ draft
```

`active → ready` 表示"手动停下、暂不再跑"，与 `blocked`（被动卡住）区分。

### 6.2 reminder stage

```
scheduled → fired | cancelled
fired     → acked | cancelled
acked     → (终态)
cancelled → scheduled
```

### 6.3 Run state

```
starting → running | failed | stopped
running  → paused | finished | failed | stopped
paused   → running | stopped
```

`starting → stopped` 必须存在：用户可能在进程尚未拉起时就取消。

### 6.4 权限矩阵

现有 `ACTOR_RULES.lead: () => true`（`src/store/tickets.ts:166`）使 FSM 闸门形同虚设，
必须取消。**本表对 §6.1 / §6.2 / §6.3 的每条边穷举；未列出的边一律拒绝（默认 deny）。**

**task stage**

| 边 | 允许的 actor | 说明 |
|---|---|---|
| `draft → ready` | **仅 user** | "建完先别跑"的结构保证；lead 不能替用户确认 |
| `ready → draft` | user | 反悔 |
| `ready → active` | user、system | system 仅在 `start_item` 成功创建 Run 时 |
| `active → blocked` | system、child | |
| `blocked → active` | user、system、child | user 必须在列，否则 §6.5 的 `blocked` 分支不可达 |
| `active → review` | system、child | |
| `active → ready` | user | 手动停下（`stop_item`），同时终止在跑的 Run |
| `blocked → ready` | user | 同上 |
| `review → done` | user；`review_policy='automatic'` 时 system | |
| `review → active` | user、system | system 用于自动评审判定需返工 |
| `done → active` | user | 返工 |
| `draft/ready/active/blocked/review → cancelled` | user、lead | lead 可取消，但不可确认开跑 |
| `cancelled → draft` | user | |

**reminder stage**

| 边 | 允许的 actor |
|---|---|
| `scheduled → fired` | 仅 system |
| `fired → acked` | user、lead（代用户 ack，见 §4） |
| `scheduled/fired → cancelled` | user、lead |
| `cancelled → scheduled` | user |

**Run state**

| 边 | 允许的 actor |
|---|---|
| `starting → running` / `→ finished` / `→ failed` | 仅 system |
| `running → paused` | **仅 user** |
| `paused → running` | **仅 user** |
| `starting/running/paused → stopped` | user、lead、system |

lead 不再拥有全权：它能建、能改、能取消、能代 ack、能停，但**不能替用户确认开跑，
也不能暂停/恢复**。

**实现注记**：现有代码中若干内部调用以 `actor: "lead"` 自称，实际是系统行为
（`src/coordinator/dispatch.ts:171,248`、`src/children/manager.ts:123,125`），
迁移时须改为 `actor: "system"`，否则会被新矩阵拒绝。

### 6.5 创建 Run 的硬闸门

唯一创建 Run 的入口必须前置判断，不可绕过。**闸门按 role/purpose 分支**——评审 Run 与
整合 Run 的合法 stage 与执行 Run 不同（现有代码已如此：`src/children/manager.ts:52-54`
要求 reviewer 时 `status='review'`，`manager.ts:114-117` 要求 integration 时
`orchestration_state='integrating'`）：

```
所有情况共同前置： item.kind === 'task'

role='executor'  且 purpose <> 'integration'  →  stage ∈ {ready, active, blocked}
role='executor'  且 purpose  = 'integration'  →  stage = 'active' 且 plan_state = 'integrating'
role='reviewer'                               →  stage = 'review'
```

初版 spec 只写了第一行，会使 `role='reviewer'` 结构上无法创建，等于删掉整条自动评审
管线（`src/coordinator/dispatch.ts:139`、`src/pipeline/orchestrator.ts:78-88`）。

工具拆分（§8）负责"好用"，这条闸门负责"不可能错"：即便工具写错、Trigger 配错、
重试路径有 bug，也造不出"提醒被执行"的状态。

### 6.6 item 的初始 stage

`draft → ready` 仅 user 会与 child 的计划分解冲突：child 拆出的子任务若一律生于 `draft`，
就需要用户逐个确认，编排器直接死锁。规则按创作者区分：

| created_by | 初始 stage | 理由 |
|---|---|---|
| `user` | `draft` | 你要的"建完先别跑" |
| `lead` | `draft` | lead 不能自我确认 |
| `child` | `ready` | 父任务已被用户确认；确认发生在树根，不逐层重复 |
| `system` | `ready` | 同上（trigger 展开受 §5.3 权限传递约束） |

(C4) `CHECK (stage <> 'draft' OR created_by IN ('user','lead'))` 把这条钉死在结构里。

## 7. 关键判断的理由

### 7.1 为什么 reminder 不能挂子任务，也不能被挂

在本仓库 `parent` / `root_item_id` 不是弱归属，而是**带执行语义的强组合**：树根是整棵
执行树的预算与限流权威——`src/coordinator/dispatch.ts:219` 取 `root.max_concurrency`，
`src/coordinator/service.ts:161,165` 取 `root.max_depth` / `root.max_children`；
`src/pipeline/orchestrator.ts:68` `const ownerId = ticket.parent_ticket_id ?? ticket.root_ticket_id`
说明父节点是收编排通知、等子任务、汇总结果的那个。

让 reminder 当 parent，等于让一个结构上不能有 Run 的实体成为真实执行树的预算权威和
结果收敛点——与"提醒混进 ticket 表"是同一类错误。

**两个方向都要堵**：(C2) 禁止 reminder 持有 `parent_item_id`（不能当 child），
(T2) 禁止任何 item 指向 kind 非 task 的父/根（不能当 parent）。只做前者会留下
"task 认 reminder 当爹"这条路，正是 §7.1 论证要排除的那一种。

### 7.2 为什么不需要 promote 路径

"提醒我明天 review PR #12"——若 review 是真要干的活，它从一开始就不是提醒，而是
**一个约定明天出现的任务**：`Trigger(once @ 明天, create_item{kind:'task', initial_stage:'draft'})`。
明天列表里出现一个 draft task 等待确认。

两条路径在**创建那一刻**就分开（正好落在两个工具上），常见情况被上游吃掉。真正剩下的
只有"建了纯提醒、事后才发现要正经做"，频率不足以支撑任何机制——再建一个 task 即可。

若日后发现该情况频繁，再加弱引用字段 `origin_item_id`（纯溯源，不参与树、不影响预算），
代价很小。

### 7.3 defer_until 与 Trigger 并存

两者语义不重叠：

- `defer_until`：Item **现在就存在**，只是暂不浮现。用于"我现在想到一件事，记下来但下周再管"。
- `Trigger(once, create_item)`：Item **到点才被创建**。用于"明天才需要存在的东西"。

`defer_until` 纯靠默认视图谓词生效，不需要 scheduler 写库。

`defer_until` **仅对 task 有效**（(C2) 已禁止 reminder 持有）：reminder 已有 `remind_at`
表达"何时浮现"，两个字段并存会产生"延后但已提醒"这种无意义状态。

## 8. 工具面

按参数集拆分，让非法状态在 schema 层面无法表达（reminder 连传 `token_budget` 的语法都没有）：

```
-- 创建
create_reminder(title, body?, remind_at, due_at?)
create_task(title, brief, workdir?, runtime?, model?, budget?, priority?,
            parent_item_id?, due_at?, defer_until?)

-- 编辑
update_item(id, title?, body?, priority?, due_at?, project_id?)   -- 不含 kind / stage / remind_at
reschedule_reminder(id, remind_at)                                -- 唯一能改 remind_at 的入口
defer_item(id, until)                                             -- 仅 task

-- task stage 跃迁（每个 §6.4 中 user 可发起的边都有对应工具）
confirm_item(id)          -- draft → ready
unconfirm_item(id)        -- ready → draft
start_item(id)            -- ready/blocked → active，创建 Run；§6.5 闸门在此
stop_item(id)             -- active/blocked → ready，并终止在跑的 Run
complete_item(id)         -- review → done
rework_item(id)           -- review/done → active
cancel_item(id, reason)   -- → cancelled，并终止该 item 所有非终态 Run（置 stopped）
restore_item(id)          -- cancelled → draft

-- reminder
ack_reminder(id)          -- fired → acked
cancel_reminder(id)

-- Run
pause_run(run_id)         -- running → paused；item 保持 active
resume_run(run_id)        -- paused → running
stop_run(run_id)          -- → stopped

-- Trigger（按 source 拆分，而非单个 create_trigger(source_type, config)）
create_once_trigger(fire_at, action)
create_cron_trigger(cron_expr, tz, action)
-- create_webhook_trigger(path, secret_ref, action)   预留，本期不实现
set_trigger_enabled(id, enabled)

-- 读
list_items(view)          -- view: tasks | drafts | reminders | all
read_notifications(state?)
```

`pause_run` 不改变 item stage —— item 仍是 `active`，只是当前没有进程在跑。
"这件事推进到哪一步"和"此刻有没有在跑"本就是两个轴，这正是 §3.2 拆分的目的。

## 9. 默认视图

```sql
-- 任务列表：不含提醒、不含终态、不含待确认、不含延后未到期
kind='task' AND stage NOT IN ('draft','done','cancelled')
  AND (defer_until IS NULL OR defer_until <= :now)

-- 待确认（单独分组）
kind='task' AND stage='draft'
  AND (defer_until IS NULL OR defer_until <= :now)

-- 提醒（reminder 无 defer_until，由 remind_at 表达浮现时机）
kind='reminder' AND stage IN ('scheduled','fired')
```

## 10. Scheduler tick

每个步骤、每个条目**各自独立事务并各自 try/catch**：单条失败不得中断本轮其余工作。

```
1. Trigger 到点
   triggers WHERE enabled=1 AND next_fire_at <= now
   在同一事务内：INSERT trigger_fires(dedup_key=occurrence ISO, status='pending')
                （UNIQUE 冲突 → 本次已处理过，跳过）
                并推进 next_fire_at
   ——先推进再执行 action。否则 action 抛错会让该 trigger 的 next_fire_at 永远停在
     过去，每 tick 重试同一条，整条 schedule 冻结。
   事务外执行 action → 回写 trigger_fires.status / error / produced_item_id
   连续失败累加 triggers.consecutive_failures；达到 PLC_TRIGGER_MAX_FAILURES（默认 5）
   自动 enabled=0 并发 notification(urgency='batchable')

2. 提醒到点（排在 1 之后，使本轮新建的 reminder 可当轮触发，省一个 tick 的延迟）
   items WHERE kind='reminder' AND stage='scheduled' AND remind_at <= now
   → stage='fired'，写 notification(urgency='immediate')

3. 逾期
   items WHERE kind='task' AND due_at < now AND stage 非终态 AND 未通知过
   → notification(urgency='batchable')

4. 兜底投递
   notifications WHERE state='pending' AND urgency='immediate'
     AND created_at < now - PLC_NOTIFY_FALLBACK_MS
   → 直接推送，delivered_via='fallback'
```

`defer_until` 不在 tick 中处理——它是视图谓词，无需写库。

**cron 语义沿用现有实现**（`src/store/schedules.ts:16` `nextRun`）：按本机时区解析、
存储 ISO UTC；`advanceSchedule` 相对当前 now 推进而非逐个补齐，即 **daemon 停机期间
错过的 occurrence 跳过、不追赶**。`trigger_fires` 的 UNIQUE 只保证不重复，不改变这一取舍。

## 11. UI 规则

**执行类面板（timing / checkpoints / artifacts / logs / cost）的数据源是 Run，
仅在该 Item 至少存在一个 Run 时渲染。**

这一条同时修好：提醒页、draft 未跑过的任务页、以及任何尚未执行的任务页。Item 上可暴露
一个**派生**（计算得出、不落库）的 `hasActiveRun` 供 UI 使用。

## 12. 本设计修复的既有缺陷

- 提醒被 `inbox` 去抖静默吞掉（§1）——提醒不再走 lead_inbox，改走无去抖的 notifications。
- `schedules.spawn=0` 每次触发新建永不执行的工单（§1）——改为 Trigger 产出
  `kind='reminder', initial_stage='scheduled'` 的 item（`remind_at` 由 §5.3 注入），
  由默认视图控制堆积。`spawn=1` 的语义由 `action_type='create_and_start'` 承接。
- `ACTOR_RULES.lead: () => true` 架空 FSM 闸门——§6.4 取消 lead 全权并对每条边穷举。

## 13. 未实现的预留

- **webhook source**：表结构、幂等机制（`trigger_fires.dedup_key`）、密钥引用
  （`webhook_secret_ref`）、权限降级规则（§5.3）已就位；本期不实现入站路由与签名校验。
  实现时须落实：路由注册前校验 `webhook_path` 只含 `[A-Za-z0-9_-]`（禁止 `/`、`.`、
  路径穿越与既有网关路由遮蔽）；签名校验失败一律不落 `trigger_fires`；
  webhook trigger 恒不具备 `create_and_start` / `initial_stage='ready'` 能力。
- **`origin_item_id`**：见 §7.2，按需再加。

## 14. 命名：已于 2026-07-28 完成（内部）

> **状态更新**：改名已落地，见 `docs/superpowers/plans/2026-07-28-item-rename.md`（v16 迁移）。
> 落地范围与本节原计划**不同**，因为原计划漏判了一件事：
>
> **线上词汇没有改，也不会改。** 本节原文说改名「纯属改名，不影响模型」——这对内部成立，
> 对线上不成立。JSON 字段名 `ticketId`/`attemptId`/`status`、线上 Run 状态
> `settled`/`crashed`、HTTP 路由 `/v1/tickets/:id`、错误响应体文案、lead 与 agent 的工具
> 参数名 `ticket_id`——全都是**已发布契约**：`test/kernel-protocol-contract.test.ts` 用
> 逐字节冻结测试守着，`apps/companion` 有 95 处消费，工具签名对 agent 而言改了会让历史
> 会话里的调用失效。
>
> 所以最终形态是：**SQLite 与 `src/**` 说 item/run，线上说 ticket/attempt，
> `src/wire-vocabulary.ts` 与各投影函数在边界上翻译。** DB 名与 API 名不一致是常态，
> 但这里是有意为之并写在注释里的，不是漏改。将来真出 protocol v3 时再一起收敛。
>
> **这道边界很容易越界，实测越了 5 类**（路由、错误文案、ws 查询参数、工具键名、
> 提示词里的键名），修复见提交 `aff5c1b`。改任何一侧之前，先看边界上的注释。

### 原计划（保留作记录）


概念上实体应叫 `item` 而非 `ticket`——"ticket"在通用语境下已隐含"一件要做的工作"，
正是本次要消除的歧义。**但改名本期不做**，理由：

- 改名贡献了绝大部分改动半径却贡献零行为。四个诉求（提醒不进列表、不显示执行细节、
  建完先别跑、手动暂停）没有一个依赖它。
- 实测半径：`ticket_id|ticketId|attempt_id|attemptId|TicketStatus|orchestration_state`
  命中 162 个文件约 3300 处，其中 `apps/companion/src` 45 个、`test/` 64 个。把它们
  和语义变更混进同一批 diff，出问题时无法分辨是哪一类引起的，且中途没有能跑绿的检查点。
- 语义稳定、测试全绿之后，改名可以作为一次纯机械、工具辅助的独立提交完成，风险低得多。

因此本期保留 `tickets` / `attempts` 表名与 `ticket_id` / `attempt_id` 列名，
按 §5 开头的映射表落地。

**改名时才需要处理的冲突（留待日后）**：`ticket_proof_items` 已有一列叫 `item_id`
（`src/store/schema.ts:464-472`，是 proof item 的业务键，与 `ticket_id` 组成复合主键）。
`ticket_id → item_id` 改名会产生两个同名列，届时须把原 `item_id` 改为 `proof_key`，
复合主键变为 `(item_id, proof_key)`。

## 附：评审留痕

本 spec 经 12 个 agent 的对抗式评审（6 个视角找问题，每个视角配一个 skeptic 逐条反驳）：
提出 65 条，反驳掉 34 条，去重后 18 条被采纳并已修订入正文，其中 3 条为 blocker：

1. §6.5 的 Run 闸门只写了执行 Run 的条件，使 `role='reviewer'` 结构上无法创建，
   等于删除整条自动评审管线。→ 闸门改为按 role/purpose 分支（§6.5）。
2. `action_payload.initial_stage` 枚举只有 `draft|ready`，与 reminder 状态机的 CHECK
   互斥，导致 Trigger 产不出 reminder——而这正是 §12 声称的核心修复之一；且静态模板
   无法提供 `remind_at`，产出的 reminder 会永远停在 scheduled。→ initial_stage 按 kind
   分域，`remind_at` 由执行器按 occurrence 注入（§5.3）。
3. `initial_stage='ready'` 是 INSERT 而非跃迁，不经 actor 校验，使 lead 可建一个
   trigger 绕过"仅 user 可确认开跑"的闸门拿到运行中的 child。→ (C5) + 执行器降级规则
   （§5.3「权限传递」）。

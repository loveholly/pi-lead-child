# Lead-Child 多 Agent 协调系统 —— 详细方案设计

> 基于 pi coding agent（badlogic/pi-mono）构建。
> 本文档是多轮对抗性讨论后的定稿设计，核心结论已锁定，见 §1.3。

---

## 1. 目标、非目标与已锁定的设计结论

### 1.1 目标

- **Lead agent 常驻 standby**：随时响应用户诉求，几乎不直接执行，负责收集上下文回答问题、创建任务、监督 child。
- **Child agent 按任务启动**：每个具体任务（深度调研、功能开发等）spawn 一个 child 执行。
- **工单系统作为共享协调状态**：委派出去的工作全部可追踪、可审计。
- **渐进式披露**：回答问题的 token 成本与问题深度成正比，而不是与历史总量成正比。

### 1.2 非目标

- 不做 paperclip 式的组织架构模拟（汇报线、预算分配、mission cascading）——单用户场景不需要。
- 不做全量事件镜像存储（session 已是全量事实源，见 §1.3-C）。
- 不做多机分布式（pi-orchestrator 的 Radius 远程能力暂不引入）。
- V1 不做 Web UI，CLI + 可选 Slack 通道优先。

### 1.3 已锁定的设计结论（讨论共识，不再重开）

| # | 结论 |
|---|------|
| A | **会话是缓存，工单是数据库。** Lead 是有状态的长期会话，快问快答不建工单不查工单；工单的触发条件不是"事情重要"，而是**"出现了第二个执行主体"**——凡委派给 child 的工作必须有工单。 |
| B | **任务状态永远现查，不信记忆。** Lead 回答任务进展类问题必须先查工单库，会话记忆只用于理解用户在指哪件事。 |
| C | **薄工单层，不做全量镜像。** Session 是唯一的全量事实源；工单 = 索引卡（元数据+状态机）+ 物化视图（里程碑摘要正文）+ 多参与者线程（activities 只记离散大事件，携带 session 游标引用）。 |
| D | **日志与通知分离。** 日志免费且自动（事件流→元数据），通知昂贵且稀少（需要介入的时刻）。通知分结构性（Coordinator 规则触发）与语义性（child 主动调工具）两条通道，分级投递+去抖+配额熔断。**正确性靠拉取，通知只服务主动性。** |
| E | **概念定位：** 工单系统是多 agent 共享的权威协调状态（blackboard/账本），不是记忆系统；lead 的记忆补充是"无工单笔记"（notes）。账本要求强一致可审计，记忆允许有损过时——两者分开设计。 |
| F | **1 工单 : N session。** Session 是"一次执行尝试"，工单是跨越多次尝试的稳定任务身份（crash 重跑、返工、评审 child 都挂在同一工单下）。 |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  用户                                                         │
│   └── CLI (交互式 REPL) / Slack (V2)                          │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  Coordinator（常驻 Node.js 进程 —— 本项目的核心交付物）          │
│                                                              │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│  │ Lead Agent      │  │ Ticket Store    │  │ Child Manager │ │
│  │ (AgentSession   │  │ (SQLite)        │  │ (spawn/watch  │ │
│  │  SDK 内嵌)      │  │ tickets/        │  │  pi --mode rpc│ │
│  │ 工具: 工单CRUD/  │  │ activities/     │  │  子进程)       │ │
│  │ spawn/notes     │  │ notes/inbox     │  │               │ │
│  └───────┬────────┘  └────────┬────────┘  └───────┬───────┘ │
│          │                    │                    │         │
│  ┌───────▼────────────────────▼────────────────────▼───────┐ │
│  │ Event Pipeline（规则引擎：结构性通知/元数据更新/熔断）        │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬───────────────────────────────┘
                               │ JSONL over stdio (pi RPC 协议)
              ┌────────────────┼────────────────┐
        ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
        │ child #1  │    │ child #2  │    │ child #3  │
        │ ticket 12 │    │ ticket 15 │    │ ticket 15 │
        │ (执行)     │    │ (执行)     │    │ (评审)     │
        │ worktree A│    │ worktree B│    │ worktree B│
        └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
              │                │                │
        session.jsonl    session.jsonl    session.jsonl
        （全量事实源，不复制，审计时按游标现读）
```

**职责划分：**

- **Coordinator**：唯一常驻进程。持有 lead 的 AgentSession、SQLite 连接、child 子进程句柄。"常驻 standby"是这个进程的属性，不是 agent 的属性。
- **Lead Agent**：回合制，被用户消息 / inbox 通知 / 心跳唤醒。通过工具读写工单库、spawn child。
- **Child Manager**：spawn `pi --mode rpc` 子进程，注入工单工具，tail 事件流交给 Event Pipeline，管理生命周期（crash 探测、resume、超时）。
- **Event Pipeline**：确定性代码（非 LLM）。消费 child 事件流，只做三件事：更新工单元数据、触发结构性通知规则、执行去抖与熔断。**不落盘事件本体。**
- **Ticket Store**：SQLite 单文件。账本层（强一致、append-only activities）+ 记忆层（notes，允许改写）。

---

## 3. 数据模型（SQLite DDL）

```sql
-- ============ 账本层（强一致，activities 仅追加） ============

CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',      -- 物化视图：里程碑摘要，由 child 通过 ticket_update 维护
  status        TEXT NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog','assigned','in_progress',
                                  'blocked','review','done','cancelled')),
  brief         TEXT NOT NULL,                 -- 创建时的任务说明（child 的初始 prompt 素材，不可变）
  workdir       TEXT,                          -- 分配的 worktree / 项目路径
  created_by    TEXT NOT NULL,                 -- 'user' | 'lead'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 元数据（Event Pipeline 自动维护，供 lead 低成本巡检）
  last_activity_at   TEXT,                     -- child 最近一个事件的时间（卡死探测依据）
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     REAL    NOT NULL DEFAULT 0,
  notify_quota_used  INTEGER NOT NULL DEFAULT 0  -- 熔断计数，见 §7.4
);

-- 1 工单 : N 次执行尝试（结论 F）
CREATE TABLE attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  role          TEXT NOT NULL DEFAULT 'executor'   -- 'executor' | 'reviewer'
                CHECK (role IN ('executor','reviewer')),
  session_id    TEXT NOT NULL,                 -- pi session id（全量事实源的指针）
  session_path  TEXT NOT NULL,                 -- session JSONL 文件绝对路径
  pid           INTEGER,                       -- 存活时的进程号
  state         TEXT NOT NULL DEFAULT 'starting'
                CHECK (state IN ('starting','running','settled','crashed','stopped')),
  model         TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  last_entry_cursor TEXT                       -- 已消费到的 get_entries 游标（跨重启续读）
);

-- 离散大事件线程（结论 C：只记大事，不镜像流）
CREATE TABLE activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  actor         TEXT NOT NULL,                 -- 'user' | 'lead' | 'child' | 'system'
  kind          TEXT NOT NULL
                CHECK (kind IN ('comment',          -- 用户/lead 的批注
                                'transition',       -- 状态扭转（payload: from/to/reason）
                                'milestone',        -- child 里程碑摘要更新
                                'notification',     -- 已投递的通知记录
                                'decision',         -- lead 的决策（中止/返工/审批）
                                'attempt_start','attempt_end','crash')),
  payload       TEXT NOT NULL,                 -- JSON
  session_cursor TEXT,                          -- 指回 session entry 的游标引用（深度审计入口）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 账本纪律：activities 无 UPDATE/DELETE 路径，应用层不提供任何改写接口。

-- 通知收件箱（结论 D）
CREATE TABLE inbox (
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

-- ============ 记忆层（结论 E：允许有损、允许改写） ============

CREATE TABLE notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,                 -- 快问快答中沉淀的决策/结论/偏好
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array，检索用
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**为什么 attempts 单独成表而不是 tickets 上挂 session_id**：结论 F——crash 重跑、评审 child 都是新 attempt 挂同一工单；`last_entry_cursor` 放 attempt 级，保证 Coordinator 重启后能从断点续读每个 session。

---

## 4. 工单状态机

```
                    ┌─────────────────────────────┐
                    ▼                             │
backlog ──▶ assigned ──▶ in_progress ──▶ review ──▶ done
                    ▲         │  ▲          │
                    │         ▼  │          ▼
                    │      blocked ──────▶ cancelled（任意状态可达）
                    └─────────┘（解除阻塞）
```

| 扭转 | 触发者 | 机制 |
|---|---|---|
| backlog → assigned | lead | `spawn_child` 成功时自动 |
| assigned → in_progress | system | child 首个 `agent_start` 事件 |
| in_progress → blocked | child | `ticket_update(status='blocked')`，强制附 reason，同时产生 blocker 通知 |
| blocked → in_progress | lead/user | 通过 `steer_child` 注入解答后扭转 |
| in_progress → review | child | 自认为完成时扭转，产生 attention 通知 |
| review → done | **仅 lead 或 user** | child 无权自我验收 |
| review → in_progress | lead/user | 返工，通常伴随新 attempt 或 steer |
| * → cancelled | **仅 lead 或 user** | lead 中止须写 decision activity |

每次扭转写一条 `transition` activity（from/to/actor/reason），状态历史即审计线索。

**权限矩阵**（在工具实现层硬编码，不依赖提示词自律）：child 只能扭转 `in_progress ↔ blocked` 和 `in_progress → review`；`done` 和 `cancelled` 是 lead/user 专属。

---

## 5. Lead Agent 设计

### 5.1 宿主与生命周期

- Coordinator 启动时通过 pi SDK（`AgentSession` / `AgentHarness`，官方建议 Node 内嵌用 SDK 而非子进程）创建或 resume lead 的长期 session。
- **唤醒源**：① 用户消息；② inbox 出现 blocker（以 `follow_up` 注入，若 lead 正在跑回合则排队）；③ 心跳定时器（默认 30 分钟，可关）触发一轮"巡检 inbox + 卡死工单"。
- **上下文治理**：session token 超过阈值（如 120k）时 Coordinator 自动调 `compact`；compact 前 lead 被提示执行一次"沉淀检查"——把会话中长期有价值的结论写入 notes（结论 E 的记忆补充落点）。

### 5.2 工具集

```typescript
// ---- 账本读（渐进式披露的三层入口，见 §8） ----
query_tickets(filter?: {status?: string[]; since?: string; text?: string})
  // 返回索引卡列表：id/title/status/last_activity_at/tokens。第一层，成本最低。
get_ticket(id: number)
  // 索引卡 + body（里程碑摘要）+ 最近 N 条 activities。第二层。
get_activities(ticket_id: number, kind?: string[], limit?: number)
get_session_entries(attempt_id: number, since?: string, limit?: number)
  // 第三层：按游标现读 session 原文（代理到 pi 的 get_entries）。昂贵，仅深度审计用。

// ---- 账本写 ----
create_ticket(title: string, brief: string, workdir?: string)
add_comment(ticket_id: number, content: string)        // 写 comment activity
transition(ticket_id: number, to: Status, reason: string) // 权限矩阵校验
record_decision(ticket_id: number, decision: string, reason: string)

// ---- child 管控 ----
spawn_child(ticket_id: number, role?: 'executor'|'reviewer', model?: string)
steer_child(ticket_id: number, instruction: string)     // 代理到 child RPC 的 steer
stop_child(ticket_id: number, reason: string)           // 强制记 decision activity

// ---- 收件箱 ----
read_inbox(state?: 'pending')                            // 读后置 consumed
// ---- 记忆层 ----
save_note(title, content, tags) / search_notes(query) / update_note(id, ...)
```

### 5.3 系统提示词纪律（核心条款）

1. **你几乎不直接执行。** 需要动手的工作一律 `create_ticket` + `spawn_child`；你的 bash 权限仅限只读侦察（可通过 pi 的 `beforeToolCall` 钩子在代码层强制拦截写操作）。
2. **工单触发条件 = 出现第二个执行主体**（结论 A）。快问快答直接回答，不建工单。
3. **任务状态现查不现编**（结论 B）：回答进展类问题前必须 `query_tickets`/`get_ticket`。
4. **渐进式披露纪律**：先索引卡，够答就停；不够再取正文；再不够才开 session 原文，并明确告知用户你钻取到了哪一层。
5. **验收职责**：child 报 review 后，你负责验收（必要时 spawn reviewer child），验收结论写 decision。
6. **沉淀职责**：会话中出现长期有效的决策/偏好/结论时主动 `save_note`。

---

## 6. Child Agent 设计

### 6.1 Spawn 参数

```
pi --mode rpc
   --session-dir <data>/sessions/ticket-<id>/
   -e <coordinator>/extensions/ticket-tools.ts     # 注入工单工具
   （cwd = 工单 workdir，即独立 git worktree）
```

- **隔离**：每工单一个 git worktree（pi 无沙箱，这是最低安全线；后续可升级容器）。
- **信任配置**：RPC 模式不弹信任提示，全局 `defaultProjectTrust` 须显式配置，且 child 的项目级 extension 加载策略在部署文档中写明。
- **初始 prompt 组装**（渐进式披露的写侧）：`brief` + 工单当前 body + lead 附加的上下文。不塞入历史 session 全文；如属返工 attempt，附上一 attempt 的失败摘要（lead 从 decision/milestone activities 提炼）。

### 6.2 注入工具（通过 pi extension）

```typescript
ticket_update(body_append: string, status?: 'blocked'|'review', reason?: string)
  // 追加里程碑摘要到工单正文；可选状态扭转（权限矩阵限内）。
  // Coordinator 侧自动记 milestone/transition activity + 当前 session 游标。
notify_lead(severity: 'blocker'|'attention', summary: string)
  // 语义性通知。写 inbox，经去抖/熔断后投递。
```

### 6.3 系统提示词纪律

1. **常规进展无需汇报**——你的全部过程已自动记录在 session 中（结论 D 的日志/通知分离）。
2. `ticket_update` 只在**里程碑**时调用：完成一个阶段、方向变化、状态扭转。正文摘要面向"三周后有人只读正文就能接手"的标准来写。
3. `notify_lead(blocker)` 仅限：被阻塞需要决策、发现范围/方向性问题、不可自行恢复的失败。
4. 自认为完成 → `ticket_update(status='review')`，**你无权标记 done**。

---

## 7. 事件管道与通知系统

### 7.1 事件管道做什么（以及不做什么）

Coordinator tail 每个 child 的 RPC 事件流（LF-delimited JSONL，**自实现分帧，禁用 Node readline**——pi 文档明确的坑）。对每个事件只做确定性处理：

| 事件 | 处理 |
|---|---|
| 任意事件 | 更新 `tickets.last_activity_at` |
| `agent_start` | attempt state → running；首次时工单 → in_progress |
| `agent_end` / `agent_settled` | attempt → settled；结构性通知规则评估 |
| `tool_execution_*` | 仅统计；若是 `ticket_update`/`notify_lead` 由工具实现侧落库 |
| 进程退出（非正常） | attempt → crashed；写 crash activity；产生 blocker 通知 |
| 周期性 `get_session_stats` | 更新 tokens/cost；预算规则评估 |

**不做**：事件本体落盘（结论 C）。深度审计时用 attempt 的 `last_entry_cursor` 走 `get_session_entries` 现读。

### 7.2 结构性通知规则（通道 A，代码写死）

| 规则 | 严重级 |
|---|---|
| child crash / 异常退出 | blocker |
| token 或成本超工单预算阈值（默认 $5 / 2M tokens，可配） | blocker |
| 卡死：`last_activity_at` 超过 15 分钟且 attempt 仍 running | attention（连续两次升 blocker） |
| `agent_settled` 但状态仍 in_progress（child 跑完没扭转） | attention |

### 7.3 投递策略（结论 D 的分级表）

| 级别 | 投递 |
|---|---|
| blocker | 立即以 `follow_up` 注入 lead；lead 判断后决定是否上报用户（CLI 弹出 / Slack push） |
| attention | 进 inbox；同一工单 10 分钟窗口内去抖合并；随下次用户交互或心跳消化 |
| info | 不存在此通道——info 就是 session 本身 |

### 7.4 熔断

单工单 1 小时内 blocker 通知 > 3 条：暂停该工单的逐条投递，合并为一条"工单 #N 异常频繁，建议人工介入"，并将工单置 blocked。`notify_quota_used` 计数，人工介入后清零。

**兜底原则**：正确性靠 lead 的拉取路径保证，通知漏投的代价只是"晚知道"，不是"答错"。

---

## 8. 渐进式披露：检索策略汇总

| 层 | 载体 | 典型成本 | 回答什么 |
|---|---|---|---|
| L0 | lead 会话 + notes | ~0 | 快问快答、历史决策 |
| L1 | `query_tickets` 索引卡 | ~百 token | "现在有哪些任务？哪个卡了？" |
| L2 | `get_ticket` 正文+activities | ~千 token | "调研做到哪了？结论是什么？" |
| L3 | `get_session_entries` 原文 | ~万+ token | "child 当时为什么做了这个决定？"（审计级） |

写侧对应物：L1 由 Event Pipeline 自动维护，L2 由 child 的里程碑纪律维护，L3 由 pi session 天然持有。**每一层都是下一层的有损压缩，且都标注了通往下一层的指针（session_cursor）。**

---

## 9. 失败恢复

- **Coordinator 重启**：SQLite 即状态。启动时扫描 attempts 中 state='running' 的记录：进程还活着（pid 校验）则重新 attach 事件流并用 `last_entry_cursor` 补读错过的 entries；死了则标 crashed 走通知流程。
- **child crash 重跑**：lead 决策后 `spawn_child` 开新 attempt，同工单同 worktree，pi `--session <id>` resume 原 session 或开新 session（默认新 session + 失败摘要注入，避免污染上下文）。
- **lead session 损坏**：lead 可丢——它的知识 = 工单库 + notes（结论 E 的架构红利）。新开 session，注入"系统简介 + notes 摘要"即可恢复服务。

---

## 10. 代码结构与实施路线

```
pi-lead-child/
├── src/
│   ├── coordinator.ts        # 常驻进程入口、唤醒调度、心跳
│   ├── store/                # SQLite schema + DAO（账本层禁 update/delete activities）
│   ├── lead/
│   │   ├── session.ts        # AgentSession 内嵌、compact 治理、沉淀检查
│   │   ├── tools.ts          # §5.2 工具集
│   │   └── prompt.md         # §5.3 纪律
│   ├── children/
│   │   ├── manager.ts        # spawn/attach/resume/stop、pid 管理
│   │   ├── rpc-client.ts     # JSONL 分帧（自实现）、命令桥接
│   │   └── extension/        # 注入 child 的 ticket-tools（pi extension）
│   ├── pipeline/
│   │   ├── ingest.ts         # 事件消费 → 元数据更新
│   │   └── rules.ts          # 结构性通知 + 去抖 + 熔断
│   └── ui/cli.ts             # REPL：与 lead 对话、blocker 弹出
└── DESIGN.md
```

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 账本+执行 | store + Child Manager + Event Pipeline 元数据部分 | 命令行手动建工单→spawn child→child 干活→状态自动扭转→crash 能被探测 |
| M2 Lead | SDK 内嵌 + 全套工具 + 提示词 | 对 lead 说"帮我调研 X"→ 自动建单派活；问"进展如何"→ L1/L2 拉取作答 |
| M3 通知 | 双通道 + 分级 + 去抖 + 熔断 | child 阻塞时 lead 被唤醒并向用户提问；里程碑合并进摘要 |
| M4 记忆+巡检 | notes + compact 治理 + 心跳 | 快问快答沉淀可被后续检索；卡死工单被心跳发现 |

**版本策略**：pi 处于快速演进期（badlogic → earendil-works 迁移中），锁定 `@mariozechner/pi-coding-agent` 具体版本，升级作为显式任务处理；RPC 协议交互全部收敛在 `rpc-client.ts` 单文件，隔离变更面。

---

## 11. 风险与开放问题

| 风险 | 应对 |
|---|---|
| pi API 不稳定 | 锁版本 + 协议适配层收敛（§10） |
| 无沙箱，child 裸跑 bash | worktree 隔离为底线；敏感项目用容器包裹 spawn（预留 ChildManager 的 runner 抽象） |
| child 里程碑摘要质量差（L2 失真） | reviewer child 验收时核对摘要与实际 diff；lead 发现失真时 steer 纠正 |
| lead 提示词纪律漂移 | 权限矩阵、只读 bash 拦截等硬约束放代码层（钩子），提示词只承载软纪律 |
| 开放：pi-orchestrator 直接复用还是自研 ChildManager | 倾向自研（它是实验性的，且我们需要工单语义耦合）；M1 时用一天做 spike 后定 |
| 开放：Slack 通道接入时的鉴权与消息路由 | V2 再议 |

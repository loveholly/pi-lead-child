# ticket → item 改名 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** 把内部词汇从 `ticket`/`attempt` 改成 `item`/`run`，与 2026-07-27 落地的四原语模型对齐——一张叫 `tickets` 的表里装着 `kind='reminder'` 的行，名实不副。

**前置：** 语义已稳定、`npm run verify` 全绿、已合并 master。这正是 spec §14 当初推迟改名时定的条件。

**Spec:** `docs/superpowers/specs/2026-07-27-item-run-trigger-notification-design.md` §14

---

## 关键约束：这不是一次"纯改名"

spec §14 写的「纯属改名，不影响模型」**不完整**。查证结果：

- 线上契约用的就是 `ticketId` / `attemptId`，且有冻结测试守着：
  `test/kernel-protocol-contract.test.ts:153` — `keeps real checkpoint, work-item, and workbench v1 mappers byte-identical`
- `apps/companion/src` 有 **95 处**消费 `.ticketId`

也就是说，改名会撞上一个**已发布的契约**。因此本次范围明确切开：

| 层 | 改不改 | 理由 |
|---|---|---|
| SQLite 表名与列名 | **改** | 内部存储，无外部消费者 |
| `src/**` 的类型与标识符 | **改** | 内部代码 |
| **线上字段名**（protocol schema / HTTP / WebSocket） | **不改** | 已发布契约，冻结测试守着，companion 依赖 |
| `apps/companion/**` | **不改** | 消费的是线上字段名，跟着不动 |

代价是投影边界上会有一层显式映射（DB 的 `item_id` → 线上的 `ticketId`）。**DB 名与 API 名不一致是常态**，但必须是有意为之并写在注释里，不能让后人以为是漏改。等将来真要出 protocol v3 时，再把线上名一起收敛。

**如果实现时发现某处映射写不干净，停下来报告，不要顺手改线上字段名。**

---

## 改名对照表

### 表

| 现名 | 新名 |
|---|---|
| `tickets` | `items` |
| `attempts` | `runs` |
| `ticket_plan_memberships` | `item_plan_memberships` |
| `ticket_proof_items` | `item_proof_items` |
| `ticket_dependencies` | `item_dependencies` |

其余带 `ticket_id` 外键的表（`activities` / `inbox` / `approvals` / `checkpoints` / `artifacts` / `decision_requests` / `notifications` / `trigger_fires` / `conversation_cards` / `runtime_events` …）表名不变，只改列名。

### 列

| 现名 | 新名 | 备注 |
|---|---|---|
| `ticket_id` | `item_id` | 所有表 |
| `attempt_id` | `run_id` | 所有表 |
| `parent_ticket_id` | `parent_item_id` | |
| `root_ticket_id` | `root_item_id` | |
| `created_by_attempt_id` | `created_by_run_id` | |
| `tickets.status` | `items.stage` | 值不变 |
| `orchestration_state` | `plan_state` | 值不变 |
| `first_started_at` | `first_run_at` | |
| `completed_at` | `closed_at` | |
| `status_changed_at` | `stage_changed_at` | |
| `produced_ticket_id` | `produced_item_id` | `trigger_fires` |

**冲突**：`ticket_proof_items` 已有一列叫 `item_id`（proof item 的业务键，与 `ticket_id` 组成复合主键，`src/store/schema.ts:464-472`）。它必须改名为 `proof_key`，否则改名后一张表会有两个 `item_id`。复合主键变成 `(item_id, proof_key)`。

### `runs.state` 的值

| 现值 | 新值 |
|---|---|
| `settled` | `finished` |
| `crashed` | `failed` |

其余（`starting` / `running` / `paused` / `stopped`）不变。**注意这两个值也出现在线上 `AttemptStateSchema` 里**，按上面的约束线上不改——所以映射层要做值转换，并在两处都留注释指向对方。

### TypeScript

| 现名 | 新名 |
|---|---|
| `Ticket` | `Item` |
| `Attempt` | `Run` |
| `TicketStatus` | `ItemStage` |
| `TicketKind` | `ItemKind` |
| `TicketPriority` | `ItemPriority` |
| `ticketId` | `itemId` |
| `attemptId` | `runId` |
| `createTicket` | `createItem` |
| `getTicket` | `getItem` |
| `listTickets` | `listItems` |
| `createAttempt` | `createRun` |
| `getAttempt` | `getRun` |
| `updateAttempt` | `updateRun` |
| `pauseAttempt` / `resumeAttempt` | `pauseRun` / `resumeRun` |

**例外：不要改**（它们是线上契约的一部分）：`KernelTicketSchema`、`TicketSummarySchema`、`TicketDetailSchema`、`AttemptSchema`、`AttemptStateSchema` 及其 `Static<>` 类型，以及所有 lead 工具的 `ticket_id` 参数名（工具签名对 agent 而言也是契约，改了会让历史会话里的调用失效）。

---

## Task 1: v16 迁移 —— 表与列改名

**Files:** `src/store/schema.ts`、`src/store/db.ts`；Test: `test/item-rename-migration.test.ts`（新建）

SQLite 支持 `ALTER TABLE ... RENAME TO` 和 `ALTER TABLE ... RENAME COLUMN ... TO ...`（3.25+），**不需要整表重建**。但外键与触发器里的引用会自动跟随，索引名不会——索引要显式重建。

- [ ] **Step 1: 写失败测试** —— 造一个 v15 形态的库，`openDb` 后断言：

```typescript
it("renames tables and columns while preserving every row", () => {
  const db = openDb(seedV15());   // 含 tickets/attempts 及各 3 行
  expect(tableExists(db, "items")).toBe(true);
  expect(tableExists(db, "tickets")).toBe(false);
  expect(tableExists(db, "runs")).toBe(true);
  const cols = colNames(db, "items");
  expect(cols).toContain("stage");
  expect(cols).toContain("plan_state");
  expect(cols).not.toContain("status");
  expect(rowCount(db, "items")).toBe(3);
  expect(rowCount(db, "runs")).toBe(3);
});

it("renames the proof-item business key out of the way", () => {
  const db = openDb(seedV15());
  const cols = colNames(db, "item_proof_items");
  expect(cols).toEqual(expect.arrayContaining(["item_id", "proof_key"]));
  // 改名前这张表的 item_id 是业务键；改名后 item_id 指工单，业务键叫 proof_key
  expect(cols.filter((c) => c === "item_id")).toHaveLength(1);
});

it("maps the two run-state values", () => {
  const db = openDb(seedV15WithStates(["settled", "crashed", "running"]));
  expect(states(db)).toEqual(["finished", "failed", "running"]);
});

it("is idempotent across reopens", () => { /* 开两次，行数与形状不变，版本号只记一次 */ });

it("passes foreign_key_check after the rename", () => {
  const db = openDb(seedV15());
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现 `migrateItemRename`（version 16）。** 关键点：
  - `ticket_proof_items.item_id → proof_key` **必须排在** `ticket_id → item_id` 之前，否则中途出现两个 `item_id`。
  - 触发器（`items_kind_immutable`、`items_tree_is_task_i/u`）引用了旧列名，SQLite 的 `RENAME COLUMN` 会自动改写触发器体，但**触发器名**不会变——改完后 drop 再由 `SCHEMA` 重建，避免新旧同名冲突。
  - 结尾 `foreign_key_check`，然后记版本 16。

> **以下五条是实现时发现本计划写错、已修正的地方（2026-07-28）：**
>
> 1. **位置写得不够**。原文说"与 `migrateItemModel` 同侧"，不够——它必须排在 **v14/v15 之前**。
>    v14 的 `rebuildItemsWithKind` 用 `itemsTableSql()` 建临时表，其中 FK 写的是
>    `REFERENCES items(id)`；先跑 v14 则该表指向一个还不存在的名字，`RENAME` 之后自引用
>    永久错位，`foreign_key_check` 报 8 条违规。改名排最前之后，v10–v15 整条阶梯从此只说
>    一套词汇。代价是 v16 必须能吞下任意历史形态，所以它按列名映射表逐列匹配、缺则跳过，
>    而不是按版本分支。
> 2. **「不需要整表重建」对 `runs` 是错的**。`settled`/`crashed → finished`/`failed` 是**值**
>    变更而非改名，且值受 CHECK 约束：`UPDATE` 会撞 CHECK，`ALTER` 改不了 CHECK。该 remap
>    只能并进尾侧的整表重建（`migrateRunsPausable` → `migrateRunsShape`）。
> 3. **表清单漏了 `ticket_plan_revisions`**，而它的兄弟 `ticket_plan_memberships` 在清单里，
>    且后者对前者有复合外键。一并改名为 `item_plan_revisions`。
> 4. **列清单漏了四列**：`child_ticket_id`、`depends_on_ticket_id`、`plan_owner_ticket_id`、
>    `related_ticket_ids`。它们都命中本计划自己的 `grep ticket_id` 完成标准，漏掉就自相矛盾。
> 5. **索引改名远不止「`tickets_*` 那几个」**：实际 18 个索引 + 3 个触发器要改名，其中 11 个
>    是由版本门控的迁移（v11/v12/v13）创建的——那些迁移在 v15 库上永不再跑，所以
>    `exec(SCHEMA)` **不会**帮你重建它们，v16 必须自己 drop 并重建。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(store): rename tickets to items and attempts to runs (v16)`

## 排序上的一处认输（2026-07-28）

本计划把改名切成「先 SQL（Task 1）后 TS（Task 2–5）」，并打算用 SQLite VIEW 做过渡桥、
让中间每一步都绿。**这个桥是行不通的**，实现时被证伪：

约 18 张表**保留了自己的表名**却丢掉了 `ticket_id` 列（`activities`、`approvals`、
`checkpoints`、`artifacts`、`inbox`、`notifications`、`trigger_fires` …）。要给它们架桥，
视图得占用一个名字，而那个名字已经被表本身占着。实测 21 条失败是
`table <X> has no column named ticket_id`——没有任何视图能吸收掉它。加上视图只读，而
`src` 里对被改名表有 35 处写入。

**更好的排序是反过来**：先做 TS 层（store 已经在做行→类型的映射，`getItem()` 从
`row.status` 返回 `{ stage }` 只是一行），最后把 SQL 一次性换掉。那样每个中间提交都是绿的，
也不需要任何桥。

本次没有回滚重排，因为这是一条会整体合并的特性分支，中间提交不自洽的代价接近零，
而回滚重做要多一轮操作。**但如果将来在 master 上做同类改名，用反过来的顺序。**

## Task 2: `src/store/**` 的标识符改名

**Files:** `src/store/*.ts`；Test: 既有 store 测试

- [ ] 按上面的对照表改类型与函数名。**保留旧名作为 `@deprecated` 别名导出**，让 Task 3–5 可以分批迁移调用方而不必一次全改：

```typescript
/** @deprecated 用 createItem。改名过渡期的别名，Task 6 删除。 */
export const createTicket = createItem;
```

- [ ] 每改一个文件跑一次该文件的测试，全绿再下一个
- [ ] 提交

## Task 3: `src/coordinator/**` 与 `src/pipeline/**`

- [ ] 换到新名，去掉对别名的依赖
- [ ] 提交

## Task 4: `src/children/**`、`src/daemon/**`、`src/lead/**`、`src/agent-tools/**`

**注意**：lead 工具与 agent 工具的**参数名 `ticket_id` 不改**（对 agent 是契约）。只改内部变量与函数名。

- [ ] 提交

## Task 5: `src/gateway/**` —— 映射边界

这是本次唯一有真实设计内容的一步。投影函数从此要做名字转换：

```typescript
// DB 说 item_id，线上说 ticketId。线上名是已发布契约（frozen v1 byte-shape 测试 +
// companion 的 95 处消费），不随内部改名走；等出 protocol v3 时再一起收敛。
// 这一层是有意为之的映射，不是漏改——改动任一侧都要同时改这里。
return { ticketId: item.id, status: item.stage, /* … */ };
```

`runs.state` 的 `finished`/`failed` 同样要映射回线上的 `settled`/`crashed`。

- [ ] **必须验证**：`test/kernel-protocol-contract.test.ts` 那条冻结测试**一字未改也依然通过**。它通过 = 线上字节没变。**如果你需要改那个测试才能过，说明你改坏了契约，停下来报告。**
- [ ] 提交

## Task 6: 删除过渡别名 + 收敛

- [ ] 删掉 Task 2 加的所有 `@deprecated` 别名
- [ ] `test/**` 全量改名（只改标识符，不改断言语义）
- [ ] `npm run verify` 全绿
- [ ] 提交

## 完成标准

- [ ] `npm run verify` 全绿（952 根测试 / 243 companion / 两个 typecheck / 验收 / build）
- [ ] `test/kernel-protocol-contract.test.ts` **未被修改**且通过
- [ ] `apps/companion/**` **未被修改**
- [ ] `grep -rn "ticket_id\|attemptId" src/store src/coordinator src/pipeline` 只剩映射层与工具参数名的命中，且每处都有注释说明为什么留着
- [ ] spec §14 更新：记录改名已完成、线上契约为何留在旧词汇

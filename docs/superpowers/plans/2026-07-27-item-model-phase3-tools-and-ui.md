# Item 模型 Phase 3：工具面、提示词与展示 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** 把 Phase 1/2 建好的结构暴露成人和 agent 真正用得上的接口，并让展示层只在有 Run 时才渲染执行细节——四个用户诉求在这一期全部可见。

**Architecture:** 创建路径按参数集拆成两个工具（`create_task` / `create_reminder`），让"给提醒设执行预算"在 schema 层面无法表达；stage 跃迁每条 user 边配一个工具；`prompt.ts:38` 那条提示词约定删除，因为它要表达的区分已经由工具签名承担。展示层的规则只有一条：**执行面板的数据源是 Run，没有 Run 就不渲染**。

**Spec:** `docs/superpowers/specs/2026-07-27-item-run-trigger-notification-design.md` §4、§8、§9、§11

**前置：** Phase 1 与 Phase 2 完成且全量测试绿。

---

## 文件结构

| 文件 | 动作 |
|---|---|
| `src/lead/tools.ts` | 改：拆 `create_ticket`；删 `create_schedule`/`list_schedules`/`set_schedule_enabled`/`set_ticket_schedule`；加 stage/run/trigger/notification 工具 |
| `src/lead/prompt.ts` | 改：删第 38 行约定；加 draft/pause/notification 的说明 |
| `src/agent-tools/definitions.ts` | 改：`create_subticket` 明确产出 `kind='task'`；child 不得建 reminder |
| `packages/protocol/src/index.ts` | 改：工单投影带 `kind` / `stage` / `hasRun` |
| `src/coordinator/workbench.ts` | 改：投影补 `kind`、`defer_until`、派生 `hasRun` |
| `apps/companion/src/features/tickets/TicketThread.tsx` | 改：无 Run 时不渲染执行 tab |
| `apps/companion/src/state/control-plane/normalize.ts` | 改：接住新字段 |

---

## Task 1: 创建路径拆成两个工具

**Files:** `src/lead/tools.ts:251`（`create_ticket`）、`src/lead/tools.ts:603`（`set_ticket_schedule`）；Test: `test/lead-tools.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("create_reminder produces a scheduled reminder and nothing executable", async () => {
  const r = await call("create_reminder", { title: "三点开会", remind_at: "2026-08-01T07:00:00.000Z" });
  const t = getTicket(db, r.ticket_id)!;
  expect(t.kind).toBe("reminder");
  expect(t.status).toBe("scheduled");
  expect(t.workdir).toBeNull();
  expect(t.token_budget).toBeNull();
});

it("create_task produces a draft that is not yet runnable", async () => {
  const r = await call("create_task", { title: "重构 X", brief: "b" });
  expect(getTicket(db, r.ticket_id)!.status).toBe("draft");
});

// 工具拆分的全部意义：非法状态在 schema 层面无法表达
it("create_reminder has no parameter for execution config", () => {
  const schema = toolSchema("create_reminder");
  for (const forbidden of ["workdir", "runtime", "model", "budget", "token_budget", "parent_ticket_id"]) {
    expect(Object.keys(schema.properties)).not.toContain(forbidden);
  }
});

it("create_task has no remind_at parameter", () => {
  expect(Object.keys(toolSchema("create_task").properties)).not.toContain("remind_at");
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** 按 spec §8 的签名：

```
create_reminder(title, body?, remind_at, due_at?)
create_task(title, brief, workdir?, runtime?, model?, budget?, priority?,
            parent_ticket_id?, due_at?, defer_until?)
```

删除 `create_ticket`、`set_ticket_schedule`（`remind_at` 改由 `reschedule_reminder` 唯一入口；`due_at` 并入 `update_item`）。`agenda`（`tools.ts:670`）读 `due_at`/`remind_at` 的逻辑要跟着 kind 分开。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(lead): split ticket creation into create_task and create_reminder`

---

## Task 2: stage / run / trigger / notification 工具

**Files:** `src/lead/tools.ts`；Test: `test/lead-tools.test.ts`

- [ ] **Step 1: 写失败测试** — 最关键的一条是 lead 不能确认开跑：

```typescript
it("gives lead no way to confirm a draft", () => {
  expect(toolNames()).not.toContain("confirm_item");
  // transition_ticket 的目标枚举里不得有 ready
  expect(toolSchema("transition_ticket").properties.to.enum).not.toContain("ready");
});

it("lets lead cancel and ack but not pause", () => {
  expect(toolNames()).toContain("cancel_item");
  expect(toolNames()).toContain("ack_reminder");
  expect(toolNames()).not.toContain("pause_run");
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** 按 spec §8 与 §6.4 的 actor 矩阵分配：

**lead 可用**：`update_item`、`reschedule_reminder`、`defer_item`、`cancel_item`、`restore_item`、`ack_reminder`、`stop_run`、`create_once_trigger`、`create_cron_trigger`、`set_trigger_enabled`、`list_triggers`、`read_notifications`、`list_items(view)`。

**lead 不可用**（仅用户经 UI/CLI）：`confirm_item`（draft→ready）、`unconfirm_item`、`start_item`、`stop_item`、`complete_item`、`rework_item`、`pause_run`、`resume_run`。这些走 `src/cli.ts` 与 gateway 的控制面，不进 lead 工具表。

`transition_ticket`（`tools.ts:832`）的 `LEAD_TRANSITIONS` 收紧到 `["blocked","review","cancelled"]`。

**注意 C5**：lead 建 trigger 时 `created_by='lead'`，因此 `create_cron_trigger` 的 action schema 里不得出现 `create_and_start`，也不得出现 `initial_stage: 'ready'`——让它在 schema 层就表达不出来，而不是依赖执行器降级兜底（兜底仍保留，作为第二道防线）。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(lead): add stage, run, trigger and notification tools with the actor matrix enforced`

---

## Task 3: 删除 prompt.ts:38 的约定

**Files:** `src/lead/prompt.ts`；Test: `test/lead-session.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("no longer instructs the lead to hand-build reminders as tickets", () => {
  expect(buildPrompt()).not.toContain("这是提醒不是执行");
});

it("tells the lead that a new task waits in draft", () => {
  const p = buildPrompt();
  expect(p).toContain("draft");
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 改 prompt。** 删掉 `prompt.ts:38`（`"提醒我 X" → 建工单（不 spawn child，这是提醒不是执行）+ set_ticket_schedule 的 remind_at`）——这条约定存在的唯一理由是当时没有 reminder 这个 kind，现在有了工具就不需要它。改写第 37/38 行为：

```
- "周五前 / 明天下午3点 / 两小时后完成" → create_task 的 due_at（据当前时间换算成 ISO）。
- "提醒我 X" → create_reminder（它不是任务，不会进任务列表，也不会被执行）。
- "每周一 X" → create_cron_trigger。循环规则不是事项，别建成工单。
```

补一段说明 draft 与暂停（因为 lead 要向用户解释它为什么没开跑）：

```
新建的 task 停在 draft，等用户确认才会执行——你没有确认它的权限，只能提示用户去确认。
用户可以随时暂停正在执行的 Run；暂停期间工单仍是 active，只是没有进程在跑。
```

`read_inbox` 的说明旁边补 `read_notifications`：inbox 是给你消化的内部事件，notifications 是**已经确定要告诉用户**的，你负责播报、不能吞掉（spec §4）。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(lead): replace the reminder-as-ticket convention with the two creation tools`

---

## Task 4: protocol 与 workbench 投影

**Files:** `packages/protocol/src/index.ts`、`src/coordinator/workbench.ts`；Test: `test/protocol-contract.test.ts`、`test/workbench-http.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("exposes kind and stage on the ticket projection", () => {
  const p = projectTicket(db, reminderId);
  expect(p.kind).toBe("reminder");
  expect(p.stage).toBe("scheduled");
});

// 这一条是 UI 规则的数据基础：没有 Run 就没有执行面板
it("reports hasRun=false for a ticket that has never run", () => {
  expect(projectTicket(db, draftTaskId).hasRun).toBe(false);
});

it("reports hasRun=true once a run exists", () => {
  createAttempt(db, { ticketId: readyTaskId, role: "executor" });
  expect(projectTicket(db, readyTaskId).hasRun).toBe(true);
});

it("omits timing entirely for a reminder", () => {
  expect(projectTicket(db, reminderId).timing).toBeUndefined();
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** `workbench.ts:56-78` 的投影补 `kind`、`defer_until`，把 `status` 也以 `stage` 暴露（保留 `status` 以免一次性打断 companion，标注 deprecated）。`hasRun` 是**派生**的（`SELECT EXISTS(SELECT 1 FROM attempts WHERE ticket_id=?)`），不落库。reminder 的 `timing` / `checkpoints` / `artifacts` 一律不投影——不是投空数组，是字段不存在，让下游没法把空当成"有但为空"。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(protocol): expose ticket kind, stage and a derived hasRun`

---

## Task 5: companion 只在有 Run 时渲染执行面板

**Files:** `apps/companion/src/features/tickets/TicketThread.tsx`、`apps/companion/src/state/control-plane/normalize.ts`；Test: `apps/companion/src/features/tickets/ticketPresentation.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("offers no execution tabs for a reminder", () => {
  const tabs = visibleTabs({ kind: "reminder", hasRun: false });
  expect(tabs).toEqual(["detail"]);
});

it("offers no execution tabs for a task that has never run", () => {
  expect(visibleTabs({ kind: "task", hasRun: false })).toEqual(["detail"]);
});

it("offers the full set once a run exists", () => {
  expect(visibleTabs({ kind: "task", hasRun: true }))
    .toEqual(["detail", "checkpoints", "artifacts", "logs"]);
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** 抽一个纯函数 `visibleTabs({ kind, hasRun })`（可测、无 React），`TicketThread.tsx:314-335` 的 tab 渲染和 tab 栏都由它驱动。`PowPanel` / `CheckpointFeed` / `ArtifactList` / `LogTimeline` / `TicketTiming` 全部挂在 `hasRun` 之后。reminder 的详情页显示 `remind_at` 与 ack 按钮，不显示任何执行脚手架。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(companion): render execution surfaces only when a run exists`

---

## Task 6: 控制面动作（确认 / 暂停 / 恢复）

用户要能真的点。lead 没有这些权限，所以它们走 gateway 控制面 + CLI。

**Files:** `src/gateway/control-plane.ts`、`src/cli.ts`；Test: `test/control-plane.test.ts`、`test/cli.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("confirms a draft as the user and makes it runnable", async () => {
  await post(`/tickets/${id}/confirm`);
  expect(getTicket(db, id)!.status).toBe("ready");
});

it("refuses to confirm on behalf of the lead", async () => {
  const res = await post(`/tickets/${id}/confirm`, { actor: "lead" });
  expect(res.status).toBe(403);
});

it("pauses and resumes a running run", async () => {
  await post(`/runs/${runId}/pause`);
  expect(getAttempt(db, runId)!.state).toBe("paused");
  expect(getTicket(db, ticketId)!.status).toBe("active");  // item 不变
  await post(`/runs/${runId}/resume`);
  expect(getAttempt(db, runId)!.state).toBe("running");
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现。** 控制面新增 `POST /tickets/:id/confirm|start|stop|complete|cancel`、`POST /runs/:id/pause|resume|stop`，actor 一律 `user`（这是用户自己的控制面）。`pause` 必须真的终止子进程——复用 `src/children/manager.ts` 的停止通路，而不是只改 DB 状态；`resume` 用保留的 `session_id` 重新拉起。CLI 加对应子命令。
- [ ] **Step 4:** PASS
- [ ] **Step 5: 提交** `feat(gateway): add user-only confirm, pause and resume控制面动作`

---

## Task 7: 全量收敛

- [ ] `npx vitest run` 全绿，0 failed，不得跳过任何测试
- [ ] `npx tsc --noEmit -p tsconfig.json` 无输出
- [ ] companion 的测试也要绿

## 完成标准 —— 四个诉求逐条可见

1. **提醒不进任务列表** — `list_items(view:"tasks")` 与 companion 任务列表都查不到 reminder
2. **提醒不显示执行细节** — reminder 详情页只有详情 tab，没有 timing/checkpoints/artifacts/logs
3. **建完先别跑** — `create_task` 后工单停在 draft，lead 没有任何工具能推它到 ready，用户确认后才创建 Run
4. **执行中手动暂停** — 暂停后子进程真的没了、`paused_ms` 在累加、工单仍是 active，恢复后同一 session 继续

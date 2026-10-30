# M3 通知双通道 + child 干预 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。沿用 M1/M2 的既有模式（store DAO / ingest 规则 / lead 工具 / extension 工具 / REPL 接线），每 Task TDD + commit。

**Goal:** DESIGN §7 的落地：结构性+语义性通知写入 inbox，分级投递（blocker 即时 / attention 攒批）、去抖、单工单熔断；error 结局规则；steer_child/stop_child。验收：child 出错时 lead 主动告知用户；child 执行中可被 lead 插话/中止。

**范围边界（有意为之）：** child 仍是"单 prompt 即收工"——steer_child 只在 child 执行中有效（长任务干预），真长驻 child 与心跳巡检属 M4。通知投递依托 REPL 进程（轮询 inbox），daemon 化属 M4。

---

### Task 1: inbox DAO（去抖 + 熔断）
**Files:** `src/store/inbox.ts`、`test/inbox.test.ts`

```typescript
addInbox(db, {ticketId, severity, source, summary, payload?}): { id: number | null; suppressed: boolean }
listInbox(db, filter?: {state?: InboxState[]; severity?: "blocker"|"attention"}): InboxRow[]
markInbox(db, ids: number[], state: "delivered"|"consumed"): void
```
- **去抖**：同工单已有 pending `attention` → 不新增，把新 summary 追加进旧行 payload 的 `merged` 数组并计数，返回 suppressed
- **熔断**：同工单 1 小时内 blocker ≥ 3 → 不再逐条投递，改写/复用一条聚合 blocker（summary=“工单 #N 异常频繁，建议人工介入”），`notify_quota_used` 自增；聚合行已存在且 pending 则仅计数
- types.ts 增加 `InboxRow`/`InboxState` 类型

测试：blocker 直加；attention 去抖合并；第 3 条 blocker 触发熔断且第 4 条只计数；markInbox 状态流转。

### Task 2: ingest M3 规则（通道 A 结构性）
**Files:** `src/pipeline/ingest.ts`（扩展）、`test/ingest-m3.test.ts`

| 触发 | 通知 |
|---|---|
| assistant message stopReason==="error" | blocker「LLM error：errorMessage 摘要」；记录 hadError，agent_end 时工单仍 in_progress → transition blocked (system) |
| onExit crash（既有路径） | 追加 blocker「child crash, exitCode=N」 |
| agent_end 且工单仍 in_progress 且无 error | attention「child 结束但未扭转状态（可能忘了 ticket_update）」 |
| total_tokens 累计超 PLC_BUDGET_TOKENS（默认 2_000_000），每 attempt 一次 | attention「预算告警」 |

测试：四条规则各一用例（复用既有 ingest 测试的搭建方式），确认 inbox 落行与工单状态。

### Task 3: extension notify_lead（通道 B 语义性）
**Files:** `src/extension/ticket-tools.ts`（新增工具）、`test/extension.test.ts`（扩展）

`notify_lead(severity: "blocker"|"attention", summary: string)` → addInbox(source="semantic")。工具描述写明纪律：仅限被阻塞需决策/范围方向问题/里程碑完成；常规进展禁用。child 系统提示词（buildChildPrompt）同步提及该工具。

### Task 4: 存活 child 注册表 + steer_child / stop_child
**Files:** `src/children/manager.ts`（注册表）、`src/lead/tools.ts`（两个新工具）、`test/steer-stop.test.ts`、`test/fake-pi.mjs`（新增 FAKE_SCENARIO=slow：agent_start 后 1.5s 才 message_end+agent_end）

- manager：`liveChildren(): Map<ticketId, {rpc, proc, attemptId}>`，spawn 后注册、exit 时注销
- `steer_child(ticket_id, instruction)`：live → `rpc.send({type:"steer",message})` + comment activity（payload 标记 steer）；非 live → 报错提示（blocked 工单应走 spawn_child 重试）
- `stop_child(ticket_id, reason)`：live → updateAttempt(state:"stopped") → proc.kill() → transition blocked (actor lead) + decision activity；ingest.onExit 对 stopped 已免疫（不误标 crash）
- allowlist 防漂移测试自动覆盖（Task 内跑全量回归确认）

测试：slow 场景下 steer 送达成功（response success）；stop_child 后 attempt=stopped 而非 crashed、工单 blocked；非 live 时两工具报错。

### Task 5: REPL 投递接线 + read_inbox + 提示词 + 验收
**Files:** `src/cli.ts`、`src/lead/tools.ts`（read_inbox）、`src/lead/prompt.ts`、`docs/ACCEPTANCE.md`

- REPL：`setInterval(3s, unref)` 轮询 pending blocker → 立即打印 `[通知]`；lead busy 时 `session.followUp(通知文本)` 即时注入，空闲则留给下轮 prompt 前缀注入（复用 childNotices 通道），注入即 mark consumed；attention 只在下轮注入
- `read_inbox(state?)` lead 工具：查询通知历史（含 consumed，审计用）
- 提示词：通知语义说明（blocker=需要你或用户介入；attention=知悉即可）
- 验收：A) crash 场景（工单 brief 里让 child 执行会失败的事？直接复用 kill -9 或 FAKE 难做真实验收——用真 pi + 中途 stop_child）；B) 对话中说“中止 #N”→ lead 调 stop_child；C) child 完成未扭转 → attention 在下轮出现；D) 更新 ACCEPTANCE.md M3 章节

## Self-Review
- DESIGN §7.3 投递表逐行对照：blocker 即时（打印+followUp）、attention 攒批（下轮注入）、info 不存在（就是 session）✓；§7.4 熔断 ✓；通道 A 四规则含 M1 遗留的 error 结局待办 ✓；通道 B notify_lead ✓；steer/stop 的权限与审计（comment/decision activity）✓。
- 一致性：inbox 表 schema（M1 已建）字段与 DAO 对齐；stopped 状态 ingest 已免疫（M1 代码 `settled||stopped` 早退）。

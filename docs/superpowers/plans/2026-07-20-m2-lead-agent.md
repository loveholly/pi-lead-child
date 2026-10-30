# M2 Lead Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DESIGN.md M2：SDK 内嵌 lead agent + 全套账本工具 + 提示词纪律，`plc chat` 成为对话式 REPL。验收：对 lead 说"帮我调研 X"→ 自动建单派活；问"进展如何"→ L1/L2 拉取作答。

**Architecture:** `createAgentSession()` 内嵌 lead（长期会话经 `SessionManager.continueRecent(dataDir, <dataDir>/lead-sessions)` 持久化）。lead 工具集用 `defineTool()` 包装 M1 的 DAO/runTicket。`spawn_child` fire-and-forget 后台跑 child（REPL 进程存活期间事件持续 ingest）。lead **无 bash/coding 工具**（M2 简化：只有账本工具，"只读 bash 侦察"推迟）。

**Tech Stack:** 复用 M1 全部。新增 pi SDK API（已对 0.73.1 sdk.md + dist .d.ts 核实）：`createAgentSession`、`defineTool`、`AuthStorage.create()`、`ModelRegistry.create(authStorage)`（会读 ~/.pi/agent/models.json → acme provider）、`DefaultResourceLoader({cwd, agentDir, systemPromptOverride})` + `await loader.reload()`、`SessionManager.continueRecent(cwd, sessionDir?)`、`session.prompt()`（完整跑完才 resolve）、`session.subscribe()`。

**关键隔离决策：** lead 的 ResourceLoader 用 `agentDir = <dataDir>/agent`（空目录），避免加载用户 `~/.pi/agent/extensions/` 里的全局 extension（orca-*）和 AGENTS.md；但 AuthStorage/ModelRegistry 保持默认路径（需要 ~/.pi/agent/models.json 的 acme provider 和 auth 解析）。

**已知妥协（M2 有意为之）：** lead 无文件系统访问（连只读都没有）；steer_child/stop_child 推迟（M1 child 单 prompt 即收工，没有可 steer 的长跑 child）；inbox/notify 是 M3；notes 是 M4。

---

### Task 1: Lead 工具集（纯 DB 工具，TDD）

**Files:**
- Create: `src/lead/tools.ts`
- Test: `test/lead-tools.test.ts`

工具与 DESIGN §5.2 对应。工厂注入依赖以便测试：

```typescript
export interface LeadDeps {
  db: Db;
  dbPath: string;
  dataDir: string;
  // 测试注入 fake-pi；生产为空走默认
  childPi?: { piBin: string; piArgs: string[] };
  onChildDone?: (ticketId: number, err?: Error) => void;
}
export function createLeadTools(deps: LeadDeps): ToolDefinition[]
export function runningChildren(): Map<number, Promise<void>>  // REPL 退出检查用
```

8 个工具（全部 `defineTool`，execute 返回 `{content:[{type:"text",text}],details:{}}`，错误用 throw）：

| 工具 | 参数 | 行为 |
|---|---|---|
| `query_tickets` | `status?: string[]` | L1 索引卡：`#id [status] title tokens=N last_activity=T`，空结果返回"（无工单）" |
| `get_ticket` | `id: number` | L2：头部+brief+body+最近 20 条 activities（kind/actor/payload 压缩单行） |
| `get_session_entries` | `attempt_id: number, limit?: number=30` | L3：读 attempt.session_path JSONL 尾部 limit 条，渲染 role+文本片段（200字符截断）+工具名；无 session 时报错提示 |
| `create_ticket` | `title, brief, workdir?` | created_by='lead'，返回 `created ticket #id` |
| `spawn_child` | `ticket_id, model?: string`（`provider/model` 格式） | 校验 runnable；fire-and-forget `runTicket`（不 await settle），注册进 runningChildren，完成/失败时回调 onChildDone；立即返回 `child spawned for ticket #id (attempt 后台运行中)` |
| `add_comment` | `ticket_id, content` | actor='lead' comment activity |
| `record_decision` | `ticket_id, decision, reason` | decision activity（验收/中止/返工的审计记录） |
| `transition_ticket` | `ticket_id, to, reason` | actor='lead' 的 transition（枚举: in_progress/blocked/review/done/cancelled） |

`spawn_child` 的 model 参数解析：`"acme/gpt-4.1"` → `extraPiArgs: ["--provider","acme","--model","gpt-4.1"]`；缺省用 `process.env.PLC_CHILD_MODEL ?? "acme/gpt-4.1"`。prompt 用 `buildChildPrompt(ticket)`，sessionDir 用 `config.sessionDir(ticketId)`（注意：测试中 PLC_DATA_DIR 已指向临时目录）。

- [ ] **Step 1: 写失败测试** — 每个工具 execute 直接调用（无 LLM）：query 空/有数据、get_ticket 含 body 与 activities、get_session_entries 用手写 fixture JSONL、create_ticket 落库、spawn_child 用 fake-pi 跑到 settle（轮询 runningChildren 清空 + 工单 in_progress + attempt settled）、transition_ticket 走 lead 矩阵、record_decision/add_comment 落 activity
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现 src/lead/tools.ts**
- [ ] **Step 4: 全绿 + `npx tsc --noEmit`**
- [ ] **Step 5: Commit** `feat: lead agent toolset over ledger`

### Task 2: Lead 系统提示词 + 会话工厂

**Files:**
- Create: `src/lead/prompt.ts`, `src/lead/session.ts`
- Test: `test/lead-session.test.ts`（只测 prompt 内容与工厂参数拼装，不起真 LLM）

`src/lead/prompt.ts` — DESIGN §5.3 六条纪律的完整落地（导出 `LEAD_SYSTEM_PROMPT` 常量）：身份（协调者非执行者）、工单触发条件=第二执行主体、任务状态现查不现编、渐进式披露 L1→L2→L3 且告知钻取层级、验收职责（review→done 前必须 record_decision）、无执行工具的说明（需要动手一律建单派活）。

`src/lead/session.ts`：

```typescript
export async function createLeadSession(opts: {
  dataDir: string; dbPath: string;
  onEvent?: (e: any) => void;
  childPi?: { piBin: string; piArgs: string[] };
}): Promise<{ session: AgentSession; modelName: string }>
```

实现要点：`AuthStorage.create()` + `ModelRegistry.create(authStorage)`（默认路径）→ `PLC_LEAD_MODEL ?? "acme/gpt-4.1"` 拆分后 `modelRegistry.find(provider, id)`，找不到抛错并列出 `getAvailable()`；`DefaultResourceLoader({cwd: dataDir, agentDir: join(dataDir,"agent"), systemPromptOverride: () => LEAD_SYSTEM_PROMPT})` + `reload()`；`tools: []`（无 coding 工具）+ `customTools: createLeadTools(...)`；`SessionManager.continueRecent(dataDir, join(dataDir,"lead-sessions"))`。

- [ ] **Step 1: 失败测试**（prompt 含关键纪律短语；session.ts 的 model 解析函数 `parseModelSpec("a/b")` 纯函数测试）
- [ ] **Step 2: 红灯 → 实现 → 全绿 + tsc**
- [ ] **Step 3: Commit** `feat: lead system prompt and session factory`

### Task 3: `plc chat` REPL

**Files:**
- Modify: `src/cli.ts`（新增 chat 命令）

行为：启动打印 lead 模型与续接的 session 信息；`you> ` 循环（node:readline ——这是人类终端输入，非 pi RPC 协议，无 U+2028 顾虑）；订阅事件流：text_delta 直出、tool_execution_start 打 `· 工具名(简要参数)`、agent_end 换行回提示符；child 后台完成时打一行 `[child] ticket #N 完成/失败`（经 onChildDone）；`/quit` 或 Ctrl+D 退出，退出前 runningChildren 非空则警告等待或强退；Ctrl+C 单击 abort 当前回合。

- [ ] **Step 1: 实现 chat 命令**（薄壳，无单测；逻辑都在已测试的 tools/session 里）
- [ ] **Step 2: 冒烟**：`PLC_DATA_DIR=$(mktemp -d) plc chat` 起得来、能对话一轮、Ctrl+D 干净退出
- [ ] **Step 3: 全量回归 + Commit** `feat: plc chat conversational REPL`

### Task 4: 真实验收

- [ ] **场景 A（建单派活）**：对 lead 说"帮我在 /tmp/plc-demo 写一个 fizzbuzz.py 并验证，开工单执行"。预期：lead 调 create_ticket + spawn_child；child 后台完成转 review；期间 lead 仍可对话
- [ ] **场景 B（进展查询）**：问"现在都有哪些任务，进展如何？"预期：lead 调 query_tickets（必要时 get_ticket），按账本作答，不编造
- [ ] **场景 C（验收闭环）**：说"验收工单 #N"。预期：lead get_ticket 核对 → record_decision → transition_ticket(done)
- [ ] **场景 D（快问快答不建单）**：问一个纯知识问题。预期：直接回答，不碰工单工具
- [ ] 更新 docs/ACCEPTANCE.md 增加 M2 章节，记录结果与已知问题；Commit

## Self-Review 已执行
- §5.2 工具集映射完整（read_inbox/notes 显式推迟 M3/M4，steer_child/stop_child 推迟并记录理由）；§5.3 六条纪律全部进 prompt；渐进式披露三层各有工具；spawn_child 后台化实现"lead 派活后可继续对话"。
- 类型一致性：createLeadTools 依赖注入与 M1 runTicket 的 opts 签名核对一致；PLC_DATA_DIR 在测试中的语义与 config.ts 一致。

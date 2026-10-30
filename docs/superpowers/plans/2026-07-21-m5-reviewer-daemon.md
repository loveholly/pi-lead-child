# M5 Implementation Plan: reviewer child → 小项 → daemon 化

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。沿用既有代码模式，每阶段 TDD + commit + 自验收。

**执行顺序（用户确认）**：Phase 1 reviewer child → Phase 2 小项清单 → Phase 3 daemon 化。

## Phase 1: reviewer child（验收去自述化）

- `buildReviewerPrompt(ticket)`（config.ts）：审查员身份；独立核查产物 vs 验收标准（允许运行测试/命令验证，**禁止修改任何产物**）；核查完 `ticket_update(body_append="【独立核查报告】…")` **不带 status**（review→done 是 lead 专属，权限矩阵已拦）；发现严重问题才 notify_lead(blocker)。
- `runTicket` 增加 `role`: executor 沿用 RUNNABLE 校验；**reviewer 要求工单处于 review**，spawn 不做任何状态扭转（agent_start 规则天然只动 assigned）。
- `spawn_child` 工具增加 `role` 参数；reviewer 时 prompt 换 buildReviewerPrompt。
- lead 提示词纪律 5 升级：有可执行验证标准（测试/运行类）的工单 → 先派 reviewer child，读其核查报告后再决策；纯静态产物 → 自己 read。
- 测试：reviewer 只能在 review 态工单上 spawn（其余态报错）；attempt.role=reviewer；settle 后工单仍 review。

## Phase 2: 小项清单

1. `listTickets`/`query_tickets` 增加 `text` 过滤（LIKE title/brief/body）。
2. `~/.pi/agent/models.json` 补 cost 字段（gpt-4.1: 2/8，gpt-4o: 2.5/10，gpt-4o-mini: 0.15/0.6 per MTok，OpenAI 牌价），成本核算真实化。
3. `last_entry_cursor` 启用：child 退出时读 session 文件末条 entry id 回填 attempt（daemon 恢复与增量审计的地基）。
4. worktree 自动化**明确不做**：任意 workdir 的 worktree 语义不清（非 git 目录/共享目录皆常见），现有 piBin/piArgs 注入已是 runner 抽象，容器化需求出现时再做。

## Phase 3: daemon 化（真常驻）

**架构**：`coordinatord`（daemon）持有 lead session + ChildManager + 事件管道 + watchdog + inbox 投递；`plc chat` 变 socket 客户端。

- `src/daemon/protocol.ts`：Unix socket（`<dataDir>/plc.sock`）+ LF-JSONL（复用 jsonl.ts）。命令：`chat`（流式回传 delta/tool/turn_end）、`interject`（busy 时转 steer）、`status`、`shutdown`。推送：`notice`（通知）、`child_done`。
- `src/daemon/server.ts`：启动即恢复（扫描 running attempts：pid 亡→crash 流程；pid 活的孤儿 stdio 不可重挂→kill 并标 crashed，如实记录）；心跳（`PLC_HEARTBEAT_MS` 默认 30min）唤醒 lead 消化 inbox；无客户端连接时 blocker 走 macOS 系统通知（osascript，失败静默）。
- `plc chat`：连接 daemon（不存在则自动 spawn detached 再连）；`plc daemon start/stop/status`。
- 单客户端策略：第二个 chat 连接被拒（简单性优先）。
- 测试：protocol 单测（帧/命令往返，用 net.Socket 对接内存 server）；恢复逻辑单测（伪造 running attempt + 死 pid）；e2e：daemon 起 → client 连 → 建单派活（fake-pi child）→ 断开重连 → 通知仍达 → shutdown。
- 真实验收：daemon 模式下复刻 M4 场景子集（1 个真实任务 + 中止 + 重连后查进度）。

## Self-Review
- reviewer 不给额外权限：靠既有 child 权限矩阵（review 态无可扭转边）+ 提示词禁改产物；结论经 ticket_update 落正文，lead 可读。
- daemon 恢复的诚实边界：孤儿 child 的 stdio 无法重挂，杀掉并如实标 crash——好过假装恢复。
- 心跳唤醒的输出去向：无客户端时 lead 的处理结果落账本与 daemon 日志，客户端连上后可查——符合"账本是事实源"。

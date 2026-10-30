# Companion 原型高保真确定性夹具（2026-07-25）：通过

Task 11/12 的 deterministic acceptance fixture 与受控浏览器验收已完成，覆盖 `populated`、`first-use`、
`all-completed`、`no-results` 四个相互隔离的 SQLite 场景。夹具不调用 LLM；固定输出工单、
attempt、artifact、intervention ID，预期 workspace state 和稳定浏览器 selectors。

## 夹具数据

- `populated`：运行中主工单、三个 child 状态、显式 `3/5` progress、passed/pending/failed
  三个 PoW item、normalized runtime logs、pending approval，以及 available、metadata-only、
  unavailable 三种 artifact。
- `first-use`：零工单。
- `all-completed`：三个 completed 工单，无待办。
- `no-results`：与 populated 等价的真实数据，预期 `todo` filter 和
  `fixture-query-with-no-matches` 搜索词产生 no-results 状态。
- 同一 data directory 重复 seed 返回同一 manifest，不重复写入 ticket、Checkpoint、proof、
  artifact、event 或 intervention。

## 固定服务契约

- daemon：`127.0.0.1:47140`，`node apps/daemon/dist/coordinatord.mjs`。
- Expo Web：`localhost:49161`，`npx expo start --web --port 49161 --clear`。
- reference prototype：`localhost:49162`，只接受 SHA-256
  `246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9` 的 HTML。
- launcher 写入 `daemon.log`、`expo.log`、`prototype.log`、`pids.json` 和原子 session JSON；
  支持全量 stop，以及不重新 seed 的 daemon stop/start 生命周期。

## 自动化证据

```bash
npx vitest run apps/daemon/test/companion-fidelity-fixture.test.ts
npx tsc --noEmit
node --check apps/daemon/scripts/serve-companion-prototype.mjs
node --check apps/daemon/scripts/run-companion-fidelity-acceptance.mjs
node --check apps/daemon/scripts/create-companion-fidelity-comparison.mjs
```

- fixture 聚焦测试：6 项通过。
- 根项目：121 个测试文件、704 项通过；TypeScript typecheck 与 build 通过。
- Companion：30 个测试文件、187 项通过；typecheck、lint 通过且 lint 0 warning。
- Expo export：Web 12 条静态路由，Android/iOS Hermes bundle 均通过。
- 三个 `.mjs` 脚本语法检查：通过。
- comparison generator 生成 desktop/mobile side-by-side 与 50% overlay HTML，并验证输入 PNG
  字节和 mtime 均未变化；CLI 输出路径回归已覆盖。

## 受控浏览器证据

- 原型严格锁定 `/Users/alice/Downloads/1-Lead-Child 助理 UI (standalone).html`，SHA-256 为
  `246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9`。
- 桌面在 1440×900 验证三栏、PoW、平铺 Checkpoint、artifact、logs 与 composer；匹配原型画板的
  1160×772 截图中，左栏 288px、右侧 task thread 400px，workbench `scrollWidth === clientWidth`，
  页面无横向溢出。深色系统 media 下仍使用固定浅色主题和 Jakarta/JetBrains Mono 字体。
- 移动端在 390×844 验证对话、工单、项目、日程四个常驻目的地；打开工单后关闭可返回原目的地，
  document/body 宽度均为 390px。另按原型移动画板生成 380×800 对照截图。
- `first-use` 的三个 starter command 可带入 Lead composer；`all-completed` 显示新建任务；
  `no-results` 显示并执行清除筛选；`populated` 的三栏、child 状态和真实资源均可操作。
- artifact 浏览器路径覆盖 available、metadata-only、unavailable，以及受控网络失败、retry、成功、
  CDP 暂停中的 cancel 和 abort 后恢复 idle。
- 同端点 daemon 重启后，浏览器持有的旧 token 只在首次明确 401/`not_paired` 时清理并执行一次
  loopback auto-pair；临时网络错误和远程 binding 不触发恢复。真实重启后页面自动恢复 5 张工单。
- 浏览器 page errors 为 0；console errors 为 0。开发模式仅保留 React Native Web shadow 弃用和
  Reanimated Web `useNativeDriver` fallback 两条第三方 warning。

对照证据：

- [desktop side-by-side](audits/companion-fidelity-2026-07-25/desktop-side-by-side.html)
- [desktop 50% overlay](audits/companion-fidelity-2026-07-25/desktop-overlay.html)
- [mobile side-by-side](audits/companion-fidelity-2026-07-25/mobile-side-by-side.html)
- [mobile 50% overlay](audits/companion-fidelity-2026-07-25/mobile-overlay.html)

# Checkpoint 控制面与完整 Companion UX 验收（2026-07-24）：自动化通过

本轮在冻结 protocol v2 event union 的前提下，完成 child Checkpoint、决策/审批 authority、
耐久 Lead 会话卡片、ticket timing/workbench、嵌套计划幂等，以及 Web/Android/iOS 共用的
Zustand 资源接线。

## 后端验收范围

- 真实临时 SQLite、Coordinator、paired HTTP/WS 与 daemon 重启。
- pairing 与 `tickets:view`/`approvals:respond` scope 隔离。
- 父工单、并行 dispatch、嵌套 child plan、依赖 DAG 和重复规划幂等。
- progress/milestone/delegation/blocked/completed Checkpoint。
- decision 与 approval 的创建、paired resolve、session exemption、重复请求和冲突处理。
- ticket timing、work-items、workbench、intervention refs/full authority、conversation cards。
- crash/recovery/startup legacy repair、SQLite 关闭重开和 daemon 再启动后持久化。
- paired authority actor 固定为 `user via paired binding:<id>`，Lead 不能代替 user 处理审批。
- Coordinator/manager 写入的 durable outbox 可在已连接 WebSocket 上实时投递；`after_seq` 与
  `sync.resume` replay 不会在 live flusher catch-up 时重复事件。
- Lead 从任意渠道完成日程变更后发布无 ticket ID 的全局 `ticket.updated` 快照失效，所有 `tickets:view` binding
  都会刷新当前 agenda；`create_ticket` 仅在成功完成并返回权威工单 ID 后生成 live/durable card。
- attempt start/crash、daemon orphan、dispatch orphan 与 lease expiry 均生成原子 activity、
  Checkpoint 和冻结 v2 lifecycle outbox；失败事务可重入恢复。

核心场景：

```bash
npx vitest run apps/daemon/test/checkpoint-control-plane-e2e.test.ts
```

## Companion 验收范围

- additive client schema/cursor/cancellation/capability fallback。
- checkpoints/work-items/workbench/interventions/timing/cards 的规范化实体和资源 observer。
- stable-key live/durable card reconciliation 与断线 transient 清理。
- grouped rail、真实 ticket elapsed、Checkpoint feed、authority action 与 active-attempt logs。
- ticket execution、Checkpoint、intervention 三类中央会话卡片；无 fake conversation/domain entity。
- intervention command 的 pending/error/succeeded/retryable UI 状态，不 optimistic 修改 authority。
- disconnected cached content、malformed additive resource fail-closed、空态、Artifact unsupported。
- resource generation、release/re-observe、force refresh、forget 与历史分页的 lifecycle 竞态。
- 项目/日程真实资源、Checkpoint/会话卡历史分页、无效工单深链 not-found、断线命令门禁。
- Web/原生临时面板、滚动边界、按钮 accessibility role/state。

核心场景：

```bash
npm -w @pi-lead-child/companion test -- src/features/workspace/checkpointUxIntegration.test.ts
npm -w @pi-lead-child/companion test -- src/features/chat/messageParts.test.ts src/features/chat/conversationCards.test.ts
```

## 完整回归命令

```bash
npm run verify
npm run smoke:daemon
npm run smoke:runtime -- codex
npm run smoke:runtime -- claude
npm -w @pi-lead-child/companion run lint
npm -w @pi-lead-child/companion run export:web
cd apps/companion && npx expo export --platform android --output-dir dist-android
cd apps/companion && npx expo export --platform ios --output-dir dist-ios
git diff --check
```

物理真机不属于自动化导出等价物：Android/iOS bundle 通过只证明可构建；Expo Go 配对、LAN socket
和平台视觉仍需在对应设备可用时执行真实设备验收。

## 本轮实测证据

- 根项目：112 个测试文件、578 项通过。
- Companion：24 个测试文件、155 项通过；typecheck 与 lint 均通过且 lint 0 warning。
- `npm run build` 生成 `dist/coordinatord.mjs`、`dist/cli.mjs`、`dist/mcp-server.mjs`。
- `npm run smoke:daemon`：真实构建 daemon 完成 owner 配对、Coordinator 建单、v2/kernel 双 snapshot 和干净退出。
- `npm run smoke:runtime -- codex`、`-- claude`：两种真实 CLI runtime 均在临时 git repo 写入 marker，并产出 normalized events 与 external session ID。
- Expo Web export：12 条静态路由；Android/iOS 分别串行生成 Hermes bundle。
- localhost 验收：首帧 HTML 有 `meta charset=utf-8`、Unistyles 内联 CSS/state 和 `workspace-boot-shell`；daemon 日志记录 `localhost-web` 自动配对与 paired WS 连接。通过真实 token 读取 tickets/work-items/workbench/checkpoints/conversation cards 均为 200。
- 2026-07-25 live browser 验收由用户在 `localhost:8081` 现场确认：项目/unknown 分组、左右面板开合与会话宽度、intervention 操作、刷新后耐久卡和状态保持均通过。数据库同时确认 approval 与 additive decision 均由 `user via paired binding:2` 处理并生成耐久卡。
- 后续 Web/Expo 验收必须由执行 agent 预先确保浏览器控制实例可用，亲自完成点击、截图、响应式和刷新持久化检查；不得把常规浏览器验收转交给用户。
- [x] localhost 同端点旧凭证恢复：仅在初次请求明确 401/`not_paired` 时清理旧凭证并执行一次 loopback auto-pair；远程配对和临时网络故障均有回归测试保护。
- 根项目 `npm audit --omit=dev`：`@mariozechner/pi-coding-agent@0.73.1` 命中 1 个 high
  advisory；npm 给出的 force 方案会进行 breaking dependency change，未在本轮自动应用，需单独做
  Pi SDK 安全升级/兼容性审计。
- Companion `npm audit --omit=dev`：11 moderate、0 high、0 critical，均位于 Expo
  CLI/config/xcode 传递链；建议修复会跨主版本调整，未自动应用。

# Companion Zustand 状态迁移验收（2026-07-24）：通过

本轮将 Expo Companion 的协议状态、实时流和本地 UI 状态迁移到三个隔离的 Zustand
vanilla stores，并完成真实 daemon 的浏览器端到端验收。

## 状态边界

- `controlPlaneStore`：规范化 tickets/projects/agenda/approvals/sessions/turns/messages/parts/
  attempts/activities 与资源状态，继续以 HTTP snapshot 和 gateway event 为事实源。
- `streamStore`：16ms 批量提交 Lead delta 与 agent logs；日志按 `(attemptId, seq)` 去重，
  每 attempt 最多 2,000 条、最多保留 8 个 attempt buffer，并限制 orphan stream/heartbeat。
- `workspaceStore`：统一 Web、Android、iOS 的 session/ticket/attempt 选择、左右面板、移动端
  overlay、rail 视图、消息展开和按上下文隔离的 composer draft。
- `CompanionStateRuntime`：唯一持有 `ControlPlaneClient`、三个 Store、生命周期 epoch、
  invalidation coordinator 和 stream coordinator；Provider 只提供稳定 runtime 引用。
- 已删除旧 `ControlPlaneProvider/useControlPlane` facade；生产代码已删除 demo 工单、时间线、
  项目和日程数据。未配对/空会话只显示真实空态。

## 消息与实时能力

- Lead 会话按稳定 ID 规范化为 `MessageEntity + MessagePart`；文本、tool、ticket、approval、
  artifact 和 agent status 使用统一渲染边界。
- `create_ticket` 完成事件可从已验证、已脱敏的 tool projection 派生真实 ticket card；
  artifact 引用派生为 artifact part，不再由组件写死 `create_ticket/spawn_child`。
- 乐观用户消息支持 command-result/event 两种乱序收敛；明确拒绝可重试，timeout 保持
  `timeout-unknown`，只有用户明确移除或后续事实确认后才消失。
- replay cursor 仅在凭证持久化成功后推进；持久化失败会关闭并从最后 durable seq 重连。
- forget/disconnect/pairing 生命周期会先推进 epoch 并 abort 旧工作，旧 HTTP、command、cursor、
  stream 和 invalidation completion 不得污染新状态。

## 自动化证据

- Companion：19 个测试文件、83 项通过。
- Companion `npm run typecheck`、`npm run lint`：通过，0 warning。
- Expo export：Web 12 条静态路由、Android Hermes bundle、iOS Hermes bundle 均通过。
- 根项目：91 个测试文件、376 项通过；核心 control-plane/pairing/Companion 集成 19 项通过。
- `npm run build`：生成 `dist/coordinatord.mjs`、`dist/cli.mjs`、`dist/mcp-server.mjs`。
- `npm run smoke:daemon`：构建产物启动、owner 配对、Coordinator 建单、v2/kernel snapshot、
  干净退出，结果 `ok: true`。
- `git diff --check`：通过。

## 真实浏览器验收

- 重启跨重构长期运行的 Metro 进程并清缓存后，`http://localhost:8081` 首帧直接带 UTF-8、
  Unistyles 内联 CSS/state 和稳定 `workspace-boot-shell`，无乱码、无 FOUC。
- localhost 自动配对到 `127.0.0.1:47130`，页面读取 daemon 中真实 13 张工单和历史 Lead 会话，
  不出现 mock 数据。
- 通过常驻输入框发送“状态迁移发送链路探针”，浏览器实际发出 protocol v2 `chat.send`；
  daemon 账本只生成 1 个 completed turn，UI 只保留 1 份用户消息，Lead 返回 `ZUSTAND_OK`。
- 浏览器 console 仅有 React 开发提示，page errors 为空；该验收未调用工具、未新增工单。

# Kernel orchestration expansion 验收（2026-07-23）：通过

本轮把 daemon 内核从 Pi 专用 child 托管扩展为运行时中立的 Coordinator，并完成自动化与真实 CLI 验收。

## 能力闭环

- Pi、Codex、Claude 统一为 normalized runtime event 协议；SQLite `runtime_events` 是权威事件账本，JSONL 可重建。
- 工单支持任意层级父子关系、parent-local plan revision、DAG 依赖、并行叶子、串行后继、自动 review 和父 integration。
- dispatch request/claim、lease、幂等 key、并发限制、retry、token/USD budget 和 daemon orphan recovery 均持久化。
- git repository 自动解析为逻辑项目；多个 repo 可事务性合并到一个项目，连同 tickets、learning candidates、capabilities 和学习工单一起迁移。
- 重复失败会聚合为 learning candidate，达到阈值后只生成一个 learning ticket 和 draft capability；Coordinator 自行复制、哈希并运行 evaluator，安全的项目级能力才可自动 active。
- protocol v2 DTO/事件枚举保持冻结；完整内核状态通过独立 `/v1/kernel/*` snapshot 暴露。`POST /v1/tickets` 由 `tickets:create` scope 保护并走 Coordinator。

## 自动化证据

- `npx tsc --noEmit`：通过。
- `npm test -- --reporter=dot`：当前全量 91 个测试文件、376 项通过。
- `npm run build`：生成 `dist/coordinatord.mjs`、`dist/cli.mjs`、`dist/mcp-server.mjs`。
- Companion：当前 19 个测试文件、83 项通过；`npm run typecheck`、`npm run lint` 与三端 Expo export 通过。
- `test/kernel-e2e.test.ts`：三个 runtime 的叶子按 DAG 执行，自动 reviewer 通过后父工单进入 integration/review。
- `npm run smoke:daemon`：构建产物启动、owner 配对、Coordinator API 建单、v2/kernel 双 snapshot、干净退出。
- `npm run smoke:runtime -- codex`：Codex CLI `0.144.6` 真实 marker 任务通过并返回 session ID。
- `npm run smoke:runtime -- claude`：Claude Code `2.1.215` 真实 marker 任务通过并返回 session ID。
- `git diff --check`：通过。

## 运维参数

- `PLC_CHILD_RUNTIME=pi|codex|claude`：默认 executor runtime。
- `PLC_REVIEW_RUNTIME=codex`：自动 reviewer runtime；必须支持可执行只读审查。
- `PLC_ORCHESTRATOR_MS=1000`、`PLC_DISPATCH_LEASE_MS=30000`：调度周期与 claim lease。
- `PLC_RUNTIME_RECOVERY_MS=5000`：健康恢复的检查周期。
- `PLC_RUNTIME_PROBE_BASE_MS=60000`、`PLC_RUNTIME_PROBE_MAX_MS=3600000`：健康探针退避的起点和上限。每失败一次，等待时间加倍。
- `PLC_RUNTIME_PREFLIGHT_TTL_MS=600000`：preflight 安装检查的缓存有效期，按 profile hash 缓存。失败的结果最多缓存 1 分钟。
- `PLC_TRANSIENT_RETRY_BASE_MS=30000`、`PLC_TRANSIENT_RETRY_MAX_MS=600000`、`PLC_TRANSIENT_RETRY_LIMIT=5`：瞬时失败（模型满载、断网）自动重试的退避起点、上限和最多次数。每重试一次，等待时间加倍。默认依次等 30 秒、1、2、4、8 分钟。次数用完后，工单升起一个 blocker，profile 标成 degraded。`PLC_TRANSIENT_RETRY_LIMIT=0` 表示不自动重试，最大值是 20。
- `PLC_CRASH_LOOP_LIMIT=5`、`PLC_CRASH_LOOP_WINDOW_MS=300000`：daemon 重启时的崩溃循环额度。daemon 重启后接管还在跑的 child，或者重派被中断的 Run。同一份工作在窗口内被接管或重派超过上限时，Run 判为失败，不再接管或重派，工单升起一个 blocker。来自派发请求的 Run 按请求计数。默认 5 分钟内最多 5 次。`PLC_CRASH_LOOP_LIMIT=0` 表示不接管也不重派，最大值是 100。
- `PLC_LAUNCH_RETENTION_MS=604800000`：启动目录（`<PLC_DATA_DIR>/launches/`）的保留时间，默认 7 天。daemon 启动时删除过期的目录：Run 已经不活动，退出记录早于保留时间。活动的 Run 的目录不删除。每次启动最多删除 200 个。
- `PLC_MAX_ROOT_CONCURRENCY=4`、`PLC_MAX_PROJECT_CONCURRENCY=8`：默认并发上限。
- `PLC_BUDGET_SOFT_RATIO=0.8`：预算 attention 阈值；硬预算来自 root ticket。
- `PLC_LEARNING_THRESHOLD=2`：同项目同 fingerprint 的默认沉淀阈值。
- capability immutable assets：`<PLC_DATA_DIR>/capabilities/projects/<project-id>/<slug>/v<version>/`。

# M9 真机验收（部署硬化+记忆层）

> 部署硬化（launchd 常驻+崩溃拉起+凭证持久化+故障自愈）+ 记忆层（沉淀落盘+核心记忆常驻+FTS 检索）。
> 178 单测全绿 + 构建冒烟通过（详见下方清单）。以下为真机验收清单，供用户在真实环境逐项打钩——
> 涉及 launchd 安装、kill -9 等真机操作，不在自动化回归范围内。

前置：`npm run build && plc doctor`（doctor 应仅构建产物一项 ✗ 或全 ✓）

1. [ ] 凭证：config.json 写入 AM_API_KEY（value 或 fromEnv）→ `env -i HOME=$HOME PATH=$PATH plc daemon start` 环境不含 AM_API_KEY 实测 → Slack/CLI 问答通畅无 401
2. [ ] launchd：`plc daemon install` → 注销重登（或重启）→ daemon 自动在跑（plc doctor 全 ✓）→ Slack 问答通畅
3. [ ] 崩溃拉起+自动重派联动：跑一个长任务 child → `kill -9 <daemon pid>` → launchd 拉起 → aish 自动重连 → 工单自动重派并完成 → Slack 收到完成通知（验 lastAishOrigin 持久化）
4. [ ] 重派上限：同工单二次 kill -9 → 收敛到 blocked + blocker，无 spawn 风暴
5. [ ] 沉淀实战：真实长会话推到 70% 水位 → 沉淀触发 → notes 表 >0 行且含 profile/preference
6. [ ] 核心记忆：daemon 重启后新会话，lead 未检索即"记得"偏好；对历史结论提问 lead 先 search_notes（FTS 命中中文关键词）
7. [ ] doctor 故障注入：mv config.json → doctor 对应项 ✗ 且修复提示正确；恢复后全 ✓
8. [ ] plc daemon stop 后 launchd 不复活（SuccessfulExit=false 语义）；plc daemon start 手动可再拉起

# M8 审批门禁 + web 工具验收（2026-07-21）：通过

> 让助理能安全地碰"真实世界"。120 单测全绿 + 真机端到端。
>
> **审批门禁（A+B）**：
> - child extension `request_approval`（阻塞轮询，尊重 abort，session 豁免同 tool）——发邮件/下单/删除类不可逆动作前置。
> - 投递：daemon poller 即时推送 pending approval（同 remind 通道），aish 渲染 Slack Approve/Deny 按钮；expireStale + 去重。
> - 响应：aish `approval_result`（accept/decline/acceptForSession）映射 resolveApproval；lead `resolve_approval`/`list_approvals`。
> - 纪律 12：lead 只转达用户决定，**绝不代批**。
>
> **web 工具（C，真机）**：
> - `web_fetch`（零 key，Node fetch + HTML→text，像 Claude Code/Codex 内置）：工单 #10 child 真抓 example.com，总结为真实内容非默写。
> - `web_search`（tavily REST，非 MCP——对 pi child 等价且简单）：工单 #11 child 调 1×web_search + 3×web_fetch，产出带真实来源链接的 tavily 公司简介。
> - key 传递：daemon 继承 `TAVILY_API_KEY` → 透传 child → 有 key 才注册 web_search（优雅降级）。
> - 调研纪律：search 找来源 → fetch 读全文 → 引用真实来源，禁凭记忆编造（治 M4 默写式调研）。
>
> **设计教训**：fetch（抓已知 URL，零 key）≠ search（从 query 发现 URL，需搜索后端）——曾把两者捆一起导致过度设计（纠结 provider/key），拆开后 fetch 立即零依赖落地。
>
> **遗留（部署项）**：TAVILY_API_KEY 同 AM_API_KEY，仍靠环境变量，launchd 自启需持久化/plist 注入。

# M7 时间系统验收（2026-07-21）：通过

> 私人助理从"任务执行器"→"生活管家"。104 单测全绿 + 真机端到端。
>
> - **地基：每轮注入本地墙钟时间**（`localIso`，带时区偏移非 UTC Z），lead 靠它把自然语言时间转结构化字段。
> - **提醒闭环（真机）**：对 lead 说"提醒我 2 分钟后检查邮件"→ create_ticket + set_ticket_schedule(remind_at=本地 ISO)
>   → 2 分钟后 scheduler 到点 → `[提醒]` 主动推送到 CLI/Slack → remind_at 清空（一次性）。
> - **scheduler 三规则**（单测）：remind 到点一次性提醒、due 逾期一次告警、cron 例行到点建单（spawn=1 派 child）。
> - **lead 工具**：set_ticket_schedule / create_schedule / list_schedules / set_schedule_enabled / agenda。
> - **cron**：cron-parser 算 next_run_at；spawn 逻辑抽成 spawnTicketChild 供工具与 scheduler 共用。
>
> **真机暴露并修复的两个 bug**（单测覆盖不到——都涉及真实时区/推送时机）：
> ① 注入 UTC 'Z' 时钟 → lead 误读时区把 remind_at 算成过去（改注入本地墙钟+偏移）；
> ② 提醒是 attention 级被攒批到下轮 → 违背"提醒我"的主动语义（poller 对 remind-kind 即时推送，同 blocker）。
>
> **遗留（M8+）**：cron 按 UTC 表达（lead 需换算，可接受但不够直观，未来可支持带时区 cron）。
>
> 更新（M9）：已切本机时区解析（`nextRun` 新增 `tz` 参数，默认取 `localTz()`），此条遗留解除，见下方 M9 段。

# M6 验收（触达网关：aish 适配器 + paired 平面）

> **自动化部分（2026-07-21）：通过，83 单测 ×2 连跑稳定。**
>
> - **aish 适配器**（假服务器全链路）：auth 握手 / AUTH_FAILED 致命不重试 / event→lead→流式回帖
>   （stream_start→append→stop，全文校验）/ ping-pong 与 pong 超时重连 / busy 时 Slack 消息 steer
>   插话 + "已插话"确认回帖 / 来源前缀进入 lead 输入。
> - **paired 平面**：PLC-XXXX 配对码（15min TTL，只存哈希）→ HTTP redeem → token 鉴权 WS（Bearer
>   或 ?token=，兼容 RN）→ 与 CLI 同构的 chat/delta/turn_end 协议；坏 token 401；revoke 后拒绝。
> - **单脑多嘴**：Unix socket 与 paired WS 汇入统一 sender 集合共享广播；所有来源进同一 lead session。
> - **真实冒烟**：真 lead daemon + 网关 46600 起服 / health / pair new / status（aish 未配置时优雅为 null）/ 干净停机。
> - **过程中修复**：steer_child 模式快照（await 期间 agent_start 翻转 streaming 的潜伏竞态，
>   TCP 分包合并使其现形；连带修正测试等待条件为 streaming=true）。
>
> **真实 Slack 验收（testing 环境，2026-07-21）：全部通过。** bot=bwen_pi（testing app AiSH-Testing）。
> - **双向往返**：Slack DM → plc lead 流式回帖（lead 身份，非 aish 自身 agent，含来源前缀）。
> - **CLI↔Slack 上下文连续**：Slack 发起工单、CLI 追问 lead 准确识别并作答（同一 lead session）。
> - **child 完成通知推 Slack**：工单 #6（mul）child 完成 → 日志 `[aish] push notice to D09CHTCRFAR:
>   [child] ticket #6 完成，状态: review` → 自动推回 Slack 线程。#6 有两 attempt（#7 crashed / #8 settled），
>   1:N 设计在故障恢复中兑现；cost 真实（$0.0193）。
>
> **真机验收累计逼出 5 个单测覆盖不到的 bug（全部已修，87 单测全绿）**：
> ① socket mode 多实例事件分发（非代码 bug，运维认知：plc 须连 testing 部署实例，非另起本地实例）；
> ② aish stream_stop 重发全文导致回帖重复（stop 不带 text，append 已发全文）；
> ③ child workdir 不存在→spawn cwd ENOENT（spawn 前 mkdir -p）；
> ④ spawn 失败未监听 proc.on('error')→未捕获异常崩溃整个 daemon + get_state 永久挂起（两处监听 error，优雅降级 crashed；RpcClient 也 reject pending）；
> ⑤ startDaemon 无条件 unlinkSync(sockPath)→两次启动重叠时后者删前者 sock 留下不可达僵尸（启动前 netConnect 探测，单实例保证）。
> 另有一次自造事故：`env -i` 启动清掉 AM_API_KEY → LLM 401 空回复（部署教训见下）。
>
> **配置持久化**：aish 凭证（url+token）持久化进 bindings 表，daemon 任何方式启动自动重连（env -i 实测）。
> **部署遗留（M7）**：AM_API_KEY 仍只靠环境变量——launchd 开机自启环境不含它会 401，需持久化或 plist 注入。
>
> 首次启动：`PLC_AISH_URL=wss://aish.example.com/ws/agent PLC_GATEWAY_PORT=46600 plc daemon start`
> （须带 AM_API_KEY 环境，aish token 首次落盘后后续自动重连）。prod 切换只需换 URL + 重发 token。

# M5 端到端验收（daemon 常驻 + reviewer 独立核查）

> **验收结果（2026-07-21）：通过。** 全自动 e2e（`scripts/e2e-m5.mjs`，transcript /tmp/plc-m5-e2e/transcript.log）。
>
> **最有说服力的一幕——无人在场的自主闭环**：会话 A 派活后 detach，daemon 独自托管期间：
> child 完成转 review → 心跳巡检唤醒 lead → lead 按纪律自主 spawn reviewer child（"测试必须通过"类标准）→
> reviewer 独立重跑测试写【独立核查报告】→ lead 引用报告实证 record_decision → done。
> 用户重连后 lead 从账本现查如实汇报全程。我（Claude）三方复跑测试确认核查可信（All tests passed）。
>
> - **daemon 生命周期**：`plc chat` 自动拉起 detached daemon；/quit 仅断开（daemon 与 child 继续常驻）；
>   `plc daemon start/stop/status`；stop 死锁 bug 已修（server.close 等存量连接 vs 客户端等关闭确认互等——
>   现 daemon 主动 destroy 客户端，stop 0.7s 完成）。
> - **恢复**：启动即回收孤儿 attempt（杀进程 + 如实标 crash + blocker 通知 + 工单 blocked），不假装恢复。
> - **协议**：Unix socket + LF-JSONL（chat/status/shutdown；delta/tool/notice/steered/turn_end 推送），
>   busy 时 chat 自动转 steer；多客户端共享广播。
> - **离线通知**：无客户端时 blocker 走 macOS 桌面通知（osascript，静默降级）。
> - **cost 核算激活**：models.json 补 cost 后账本单价真实（本轮 e2e 工单 $0.0496）。
> - **M5 其余**：reviewer child（单测+e2e 双验证）；query_tickets text 检索；last_entry_cursor 回填。
>
> **遗留边界**：daemon 经 tsx 跑 TS 源码（发布形态需构建产物）；多客户端并发 chat 未做会话隔离（广播共享）；
> Slack 通道未接（桌面通知已留好外送点位）。

# M4 端到端验收（多任务并发协同）

> **验收结果（2026-07-20）：通过。** 全自动 e2e（`scripts/e2e-m4.mjs`，真实 lead + 真实 children，
> transcript 存 /tmp/plc-e2e/transcript.log），覆盖用户要求的全部协同场景：
>
> 1. **三任务并发**：一句话拆出 3 张工单（优先级 high/normal/low 正确映射）+ 3 个 child 并行执行。
> 2. **执行中插话**：多行输入自动走 steer 通道（3 条"已插话"），lead 正确合并理解。
> 3. **进度确认**：并发执行中问进展 → 按字面语义查 in_progress/review，如实回答。
> 4. **steer 语义闭环**：对话中要求给调研 child 追加"对比表格"→ steer_child 送达 → 最终 wal.md
>    实际包含 WAL vs rollback journal 对比表（验收时实读确认）。
> 5. **中止 + 竞态优雅处理**：中止 watch.sh 任务时 child 恰好刚转 review——stop_child 停进程
>    （attempt=stopped 非 crashed），lead 随后显式 transition cancelled。账本终态：#1 done / #2 done / #3 cancelled。
> 6. **实物验收**：lead 逐单 ls+read 产物（stats.py/test_stats.py/测试结果/wal.md）后 record_decision → done。
> 7. **记忆沉淀**：save_note 存协作要点；notes/decisions/activities 审计线索完整（每单 8-9 条 activities）。
>
> **M4 新能力**（60 单测全绿）：notes 记忆层（save/search/update_note）；卡死 watchdog（15 分钟无事件
> attention、连续两次 blocker，恢复即清零）；child linger（agent_end 后存活 `PLC_CHILD_LINGER_MS`
> 默认 5 分钟，终态工单立即收工；空闲期 steer_child 自动转为新一轮 prompt——返工不换人）；REPL 退出即时回收空闲 child。
>
> **compact 治理决策**：依赖 pi 内置 auto-compaction（settings 默认开启）+ 提示词纪律 10（重要结论
> save_note，压缩即失忆）。不自建压缩逻辑。
>
> **发现的边界（M5 输入）**：
> - lead 验收依赖 child 产出的结果文件（如 test_stats_result.txt）仍属"自述"——lead 无 bash 无法独立
>   重跑测试。正解是 reviewer child（attempts.role 已预留），不是给 lead 扩权。
> - daemon 化明确推迟：通知投递/watchdog 依托 `plc chat` 进程存活；真 daemon 需要 socket IPC + CLI
>   client/server 拆分，是独立里程碑的体量。

# M3 人工验收（通知双通道 + child 干预）

> **验收结果（2026-07-20）：通过。**
>
> - **通知闭环（实测）**：预置一条 semantic blocker（child 阻塞求决策）→ `plc chat` 下轮自动注入 →
>   lead 准确转达并向用户请求决策（PostgreSQL vs SQLite 场景）。
> - **结构性规则（单测覆盖）**：LLM error 结局 → blocker + 工单 blocked；crash → blocker；
>   child 结束未扭转状态 → attention；tokens 超 `PLC_BUDGET_TOKENS`（默认 200 万）→ attention（每 attempt 一次）。
> - **去抖/熔断（单测覆盖）**：同工单 attention 合并；1 小时内 ≥3 条 blocker 转聚合通知并计 `notify_quota_used`。
> - **child 干预（单测覆盖，fake-pi slow 场景）**：`steer_child` 向执行中 child 注入指令（活动入账）；
>   `stop_child` 停下整张工单（attempt=stopped 非 crashed，工单回到 ready，和页面的「停下」一样，决策入账；ui-action-parity P03）。
> - **投递机制**：REPL 3s 轮询——blocker 即时打印，lead 忙时经 `followUp` 注入；attention 攒批到下轮 prompt 前缀。
>
> **过程中发现并修复的真 bug**：child 进程死亡时 RpcClient 在途请求永远悬挂（stop_child 测试暴露）——
> 现在 exit 时 reject 全部 pending，`runTicket` 容忍中止后的发送失败。
>
> **边界（M4 待办）**：child 仍是单 prompt 即收工，steer 窗口仅限执行中；通知投递依托 REPL 进程存活（daemon 化 M4）；
> 心跳巡检/卡死探测未做。

# M2 人工验收（lead agent 对话）

> **验收结果（2026-07-20）：四场景全部通过。** lead 模型 `acme/gpt-4.1`（`PLC_LEAD_MODEL` 可换）。
>
> - **场景 A 建单派活**：「帮我在 /tmp/plc-m2-demo 写 fizzbuzz.py 并验证，开工单执行」→ lead 调 create_ticket（brief 含验收标准）+ spawn_child → child 后台完成转 review，REPL 退出前等待 child。
> - **场景 B 进展查询**：先调 query_tickets 再作答，与账本一致，无编造。
> - **场景 C 验收闭环**：get_ticket 核对 → record_decision（含理由）→ transition_ticket(done)。
> - **场景 D 快问快答**：纯知识问题直接回答，零工具调用（不建单纪律生效）。
>
> **过程中修复的两个问题（后来者注意）：**
> 1. **0.73.1 SDK 的 `tools` 参数与 sdk.md 文档不符**：实际是工具名 allowlist（`string[]`），传 `[]` 会连
>    customTools 一起禁用（lead 无工具可调→只能空口承诺）。正确用法 `noTools: "builtin"`。
> 2. **空头承诺**：lead 曾口头说"已开工单"但不调工具；系统提示词增加第 7 条"行动先于表态"后消失
>    （根因其实是 1——无工具可调时模型只能编话应付）。
>
> 体验入口：`plc chat`。lead 会话经 continueRecent 跨重启续接；重置 lead 记忆：`rm -rf ~/.pi-lead-child/lead-sessions`（账本不受影响——lead 可丢，账本是事实源）。

# M1 人工验收（真 pi）

> **验收结果（2026-07-20）：全部通过。** 执行 provider 为 `acme`（公司内网 AzureOpenAI 代理，
> 经 `~/.pi/agent/models.json` 注册，apiKey 取 `AM_API_KEY` 环境变量）。
> 已知事项：models.json 未配 cost 字段，代理模型成本按 0 计，total_cost_usd 恒为 0；
> 首次 attempt 若 LLM 返回 stopReason=error，agent_end 仍会 settle（不算 crash）——
> "error 结局 → 通知"规则留给 M3。

前置：`AM_API_KEY` 已设置，`~/.pi/agent/models.json` 含 acme provider
（`pi --list-models | grep acme` 应有输出）。

1. 准备沙箱工作目录：
   ```bash
   mkdir -p /tmp/plc-demo && cd /tmp/plc-demo && git init
   ```
2. 建工单：
   ```bash
   cd /Users/alice/Workspace/AI/pi-lead-child
   npm run plc -- create "hello world" \
     --brief "在当前目录写一个 hello.py，运行验证输出 hello world" \
     --workdir /tmp/plc-demo
   ```
3. 执行（显式指定有 key 的 provider）：
   ```bash
   npm run plc -- work 1 --provider acme --model gpt-4.1
   ```
   （2026-10-13 起没有 `plc work`：它绕过调度器和 supervisor，在前台跑内核。现在运行 `npm run plc -- item start 1`，由 daemon 派发。）
   预期：进度行出现 agent started / tool: … / tool: ticket_update / agent finished
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

# Companion 与 pi-lead-child Backend Gap 审计

日期：2026-07-23

## 1. 结论

审计模式：rewrite omission-prevention audit + parity audit。

审计对象：

- Backend：`coordinatord + SQLite ledger + Lead/Child runtime + paired gateway + AiSH adapter`
- Channel：CLI Unix socket、Slack AiSH bridge、拟接入的 Expo Companion
- Candidate UI：`apps/companion` 高保真原型

总体判断（初审）：**不能直接进入真实 Companion 接线阶段，必须先补齐 paired control-plane contract。**

整改结论（2026-07-23，同日复审）：**P0 control-plane 和 Companion 接线基础已实现，代码级 connected alpha gate 已通过。** 初审结论保留为整改前基线；以下 F-001 至 F-004、F-007 至 F-011、F-013 已关闭，F-005/F-006 转为部署条件，F-012 与 push/notice/history projection 等仍是后续增强。

原因不是 ticket backend 缺失。现有 backend 已覆盖工单、attempt、activity、审批、提醒、例行任务、通知、Lead/Child 协作和 Slack bridge 的主要领域能力。真正的阻塞点是：

1. Companion 当前全部使用静态 fixture，没有配对、鉴权、HTTP、WebSocket、缓存或重连代码。
2. paired gateway 实际只提供配对兑换、健康检查、`chat/status` WebSocket 命令。
3. 设计文档中承诺的 scope enforcement、origin routing、订阅、审批 HTTP 响应、ticket read API 尚未实现。
4. 当前事件流没有 turn/request/event correlation，也没有 reconnect replay，无法可靠驱动聊天历史和任务时间线。
5. 当前运行中的 daemon 没有 TCP LISTEN socket，Companion 暂时无可连接入口。

粗略工程判断，不等同于测试覆盖率：

| 层次 | 就绪度 | 判断 |
| --- | ---: | --- |
| 核心领域模型 | 80% | 工单、attempt、activity、审批、日程和运行健康均有权威投影 |
| paired control-plane | 85% | snapshot API、scope、origin routing、event replay、审批控制均已实现 |
| Companion 数据接线 | 75% | 配对、SecureStore、HTTP/WS、重连、真实工单/项目/日程/聊天/审批已接入；demo fixture 仅作未配对 fallback |
| 移动端后台通知与远程可达 | 10% | Slack 可承担通知，但 App 自身没有 push 或安全公网入口 |

发布建议：**允许局域网/Tailscale/同源代理环境的 connected alpha；不允许宣称公网 24×7 或后台 push 已完成。**

## 2. 架构边界校正

严格来说，CLI 不是 backend。

| 组件 | 正确定位 |
| --- | --- |
| `coordinatord` | 常驻 backend process，持有 Lead session、child manager、scheduler、watchdog 和 gateway |
| SQLite store | 权威 ticket ledger、attempt、activity、approval、schedule、inbox、binding 数据层 |
| `plc chat` | Unix socket channel client |
| `plc create/list/show/work` | 本机 owner/admin CLI |
| AiSH adapter | Slack outbound channel adapter |
| paired gateway | desktop/mobile inbound channel adapter 的协议入口 |
| Expo Companion | paired gateway 的客户端和新的 channel surface |

Companion 不应 shell out 到 `plc`，也不应解析 CLI 文本输出。它应直接使用版本化的 paired HTTP/WS contract。

## 3. 证据基线

### 3.1 自动化验证

整改完成后，在允许 Unix socket、本地 HTTP/WebSocket 和 child process 的环境中执行 backend 全量测试：

- Test files：50/50 passed
- Tests：218/218 passed

Companion：

- Vitest：3 files / 12 tests passed
- TypeScript：passed
- ESLint：passed
- Expo export：Web、iOS、Android passed
- 真实 daemon E2E：pair → snapshot → one-time WS ticket → ticket-context chat → replayable event → approval resolve passed

结论：核心 store、Lead tools、child runtime、scheduler、approvals、daemon、paired chat 和 AiSH adapter 的测试基线可信。

### 3.2 当前运行态

`plc doctor`：

- daemon socket 可达
- SQLite schema 正常
- AM API key 和 Tavily key 可用
- AiSH 凭证已持久化
- 构建产物新于源码
- FTS5 可用
- launchd 未安装

`plc daemon status`：

- model：`openai/gpt-5.6-sol`
- busy：false
- running children：0
- AiSH bot：`bwen_pi`
- AiSH connected：false

对 daemon PID 的 TCP LISTEN 检查没有返回监听端口。当前 paired gateway 未实际启动或未监听 TCP，因此真实 Companion 暂时不可达。

### 3.3 当前真实 ledger 与原型类型不一致

当前真实工单包含：

- `blocked`
- `done`
- `review`
- `backlog`

Companion 原型只声明：

- `running`
- `review`
- `blocked`

这说明 UI type 不是 backend contract，只是视觉 fixture，接线前必须统一类型。

## 4. 现有 Backend 能力清单

| 领域 | 状态 | 已有能力 |
| --- | --- | --- |
| Lead 长会话 | Observed | 单 Lead session，多 channel 输入；busy 时 steer；delta streaming |
| 工单 | Observed | create/get/list、全文过滤、优先级、项目、状态机、due/remind |
| Child 执行 | Observed | spawn、attempt 记录、executor/reviewer、steer、stop、linger |
| 执行审计 | Observed | activities append-only、attempt session path/cursor、L3 session 读取 |
| 运行健康 | Observed | `last_activity_at`、attempt state、live child registry、watchdog |
| 通知 | Observed | inbox、attention 去抖、blocker 熔断、desktop/Slack/socket 投递 |
| 审批 | Observed | pending/approve/reject/expire/session exemption、Slack 按钮闭环 |
| 日程 | Observed | ticket due/remind、cron schedule、scheduler、agenda Lead tool |
| 项目 | Observed | ticket 上有 nullable `project` 字符串，可过滤和聚合 |
| 记忆 | Observed | notes、FTS、core memory、compaction precipitation |
| 配对 | Observed | pairing code、token hash、binding、revoke、WS auth |
| Slack | Observed | AiSH auth、event inbound、stream reply、approval result、notice push |
| Companion read API | Implemented | overview、conversation、tickets、projects、agenda、activities、attempts、approvals HTTP API |
| Companion client | Implemented/Partial | pairing/auth/SecureStore/HTTP/WS/reconnect 已实现；push 仍缺失 |

## 5. 原型逐项映射

### 5.1 Lead 会话

| 原型能力 | Backend 数据/能力 | 结论 |
| --- | --- | --- |
| 常驻 Lead 输入框 | paired WS `chat` 已存在 | 可接，但客户端未实现 |
| 流式回复 | daemon `delta` + `turn_end` 已存在 | 可接，但缺 turn correlation |
| 显示 Lead 在线/busy | `hello/status` 有 busy/model | 部分可用，在线不等于模型/API 健康 |
| 历史消息 | Lead session 有原始事实源 | 无 channel-facing history API |
| 跨 Slack/App 连续会话 | 单 Lead session 已实现 | 语义成立，但 App 无历史投影 |
| 工具调用卡片 | 只广播 `tool_execution_start` | 缺完成/失败状态、call id、持久化和 replay |
| 附件 | 无上传/blob contract | 领域与 API Gap |
| 语音输入 | 无录音/转写 contract | App 与 backend Gap |

关键结论：单 Lead session 是正确的，但 UI 需要一个结构化的、用户可见的 conversation projection。不能直接把包含时钟、core memory、system notice 前缀的原始 prompt 当聊天记录展示。

建议新增轻量 channel journal，只保存用户可见内容：

- `turn_id`
- `message_id`
- `role`
- `text`
- `origin_binding_id`
- `origin_kind`
- `ticket_id` 可选
- `created_at`
- `state`

这不是复制完整 agent session，而是多 channel 展示与重连所需的 materialized view。

### 5.2 工单列表

| 原型字段 | Backend 对应 | 结论 |
| --- | --- | --- |
| id/title | tickets.id/title | 直接可用 |
| summary | brief 或 body 摘要 | 需要 DTO 规则 |
| status | 7 态 backend enum | UI 当前枚举不完整 |
| priority | 4 态 backend enum | UI 缺 urgent |
| project | nullable string | 直接可用，null 映射 unknown |
| heartbeat | last_activity + live attempt | 可计算，不应直接存 |
| needsAttention | pending inbox/approval | 可聚合计算 |
| progress 62% | 无权威字段 | 当前是虚构值，不可直接上线 |
| 最近工单 | backend 按 priority、id 升序 | 与“最近”语义不一致 |

建议 DTO：

```ts
type TicketSummaryDto = {
  id: number;
  title: string;
  summary: string;
  status: TicketStatus;
  priority: TicketPriority;
  project: string | null;
  dueAt: string | null;
  updatedAt: string;
  runtime: {
    state: 'idle' | 'starting' | 'running' | 'stale' | 'blocked';
    lastActivityAt: string | null;
    activeAttemptId: number | null;
  };
  attention: {
    pendingApprovalCount: number;
    blockerCount: number;
  };
};
```

不要把“心跳”和“完成百分比”混在一起。V1 建议移除百分比，展示：

- `child 活跃 · 2 分钟前`
- `等待审批`
- `疑似停滞`
- `待验收`

如果未来确实需要百分比，应新增 child 主动上报的可选 `progress_percent`，并明确它是估算值，不参与状态机。

### 5.3 工单详情与任务线程

| 原型内容 | Backend 对应 | 结论 |
| --- | --- | --- |
| 标题/说明/状态/优先级/项目 | tickets | 直接可用 |
| 里程碑正文 | tickets.body | 直接可用 |
| 状态变化 | activities.transition | 直接可用 |
| 决策/批注 | activities.decision/comment | 直接可用 |
| attempt 开始/结束/crash | attempts + activities | 直接可用 |
| 当前 child 工具调用 | child RPC event/session JSONL | 没有 daemon broadcast/API projection |
| 历史工具调用 | attempt.session_path | 可按需解析，但没有 API |
| `child #73` | 实际可用标识是 attempt id | UI 文案应改为 `attempt #N` |
| 右侧任务专属聊天 | 仍应进入同一 Lead session | 缺结构化 `ticket_id` context |

任务专属聊天不应创建第二个 Lead session。正确语义是：

```json
{
  "type": "chat.send",
  "id": "client-command-id",
  "message": "补充验收标准：必须覆盖 Android",
  "context": { "ticket_id": 42 }
}
```

daemon 负责把 ticket context 结构化注入 Lead，同时将该 turn 标记为 `ticket_id=42`，右侧线程只是全局 Lead 会话的过滤投影。

### 5.4 工具调用时间线

原型认可度最高的 UI 恰好也是当前 contract 最薄弱的部分。

当前 daemon 对 Lead 工具只广播：

```json
{ "type": "tool", "name": "spawn_child", "args": "..." }
```

缺少：

- tool call id
- turn id
- ticket id
- started/completed/failed 状态
- result summary
- timestamp
- reconnect replay

Child 工具事件当前甚至没有接入 daemon broadcast。`spawnTicketChild` 调用 `runTicket` 时没有提供面向 channel 的 `onEvent`。

建议：

1. Live path：daemon 归一化 Lead 和 Child 的 tool lifecycle event 并通过 WS 推送。
2. Historical path：详情 API 按需解析 attempt session JSONL，返回最近 N 条归一化 tool events。
3. 不把每个原始 agent event 全量复制进 activities，保留 session 作为事实源。
4. activities 继续只记录里程碑、状态、决策和 attempt 大事件。

### 5.5 审批

Backend 审批领域完整，Slack 闭环已实现。

Companion Gap：

- 没有 `GET pending approvals`
- 没有 paired approve/reject HTTP endpoint
- scope `approvals:respond` 没有 enforcement
- App 的“批准”按钮只更新 React local state
- approval resolve 后没有面向 App 的结构化状态事件

设计文档已明确要求：

- `POST /v1/paired/approvals/{id}/approve`
- `POST /v1/paired/approvals/{id}/reject`

实现尚未跟上设计。

### 5.6 项目视图

当前 backend 只有 ticket.project 字符串，没有 project entity。

V1 不需要马上建 projects 表。可以从 tickets 聚合：

- `project ?? 'unknown'`
- ticket count
- running/review/blocked count
- nearest due date

颜色可由项目名做稳定 hash，避免为纯装饰新增领域表。

只有需要以下能力时再引入 projects 表：

- 项目重命名
- 项目描述和归档
- 固定颜色/icon
- 项目级默认 workdir
- 项目级权限/模型/预算

### 5.7 周日程

当前 backend 能支持的是“操作日程”：

- ticket due_at
- ticket remind_at
- recurring schedule next_run_at

原型 fixture 还包含协议评审、验收窗口、复盘等独立 calendar event。Backend 没有 calendar event entity，也没有外部日历连接器。

建议 V1 明确产品语义：

**日程 = 工单截止/提醒 + 例行任务触发，不是通用日历。**

需要补：

- `GET /v1/agenda?from&to&timezone`
- cron 在指定范围内的 occurrence expansion，而不只是 next_run_at
- ticket 与 schedule 的统一 AgendaItem DTO

如果未来要展示真实会议/复盘，则单独新增 calendar connector 或 event entity，不要把 fixture 当作当前能力。

### 5.8 通知和 badge

当前 inbox 的 `pending/delivered/consumed` 是全局状态，Lead drain 后会整体 consumed。

这对单 CLI 尚可，但不适合多 channel：

- Slack 已看不等于 App 已看
- Lead 消化了不等于用户在 App 中已读
- App tab badge 需要 per-binding unread count
- 断线 App 需要重连补发

建议拆分：

- `notices`：领域通知本体
- `notice_deliveries`：`notice_id + binding_id + delivered_at + read_at`

App badge 应基于当前 binding 的 unread delivery，而不是 inbox 全局 state。

### 5.9 附件、语音和 Push

原型可见但尚无实现：

| 能力 | Gap |
| --- | --- |
| 附件按钮 | 无文件选择后的上传、blob store、message attachment schema |
| 语音按钮 | 无录音权限、音频上传、转写、失败处理 |
| Native push | 无 Expo push token 注册和后台通知 |
| Web push | 无 service worker/push subscription |

iOS/Android 后台不能依赖常驻 WebSocket。blocker、approval、reminder 必须走 push，前台 WS 只负责实时体验。

## 6. Paired Gateway 关键 Gap

### F-001：paired API 与既定设计不一致（Resolved）

Severity：P0 / High

Observed：

- HTTP 只有 redeem 和 health。
- WS 只有 chat 和 status。
- 没有 ticket、project、agenda、activity、attempt、approval read/write API。

影响：原型除聊天发送外无法接真实数据。

### F-002：Scope 只存储，不执行（Resolved）

Severity：P0 / High

Observed：

- binding 保存 `scopes`。
- paired-server 鉴权后不检查 scope。
- 所有认证客户端都能 chat/status。

影响：未来加入直接审批和工单写操作时会形成权限绕过。

### F-003：回复全局广播，缺少 origin routing（Resolved for WS v2）

Severity：P0 / High

Observed：

- daemon 把 delta/tool/turn_end 广播给所有 socket sender。
- paired 事件没有 `origin_echo`。
- 设计要求 delta 默认只发给发起 binding，实际未实现。

影响：多设备、CLI、Slack 同时在线时，App 无法判断回复归属，可能看到其他 channel 的进行中回合。

### F-004：事件没有可靠身份和 replay（Resolved）

Severity：P0 / High

Observed：

- 没有 `event_id/seq/turn_id/tool_call_id/timestamp`。
- 断线后没有 `after_seq` replay。
- `turn_end` 也没有对应 request id。

影响：无法可靠实现 optimistic message、断线恢复、工具状态机和幂等处理。

### F-005：当前真实运行态没有 Companion TCP 入口（Deployment condition）

Severity：P0 / High

Observed：

- daemon 正常运行。
- daemon PID 没有 TCP LISTEN socket。
- gateway 只有配置 `PLC_GATEWAY_PORT` 才启动。
- 默认 host 是 `127.0.0.1`。

影响：手机和独立 Web 部署无法连接。

### F-006：没有安全的跨平台传输方案（Partially resolved）

Severity：P0 / High

Observed：

- paired server 是 HTTP/WS，无 TLS。
- Browser WS 通过 query string 传长期 token。
- Web static app 跨 origin redeem 缺 CORS/OPTIONS。
- HTTPS Web 页面不能稳定访问 HTTP/WS mixed content。

建议：

- 使用 Tailscale + HTTPS/WSS，或同源 reverse proxy。
- 长期 bearer token 只用于 HTTPS。
- HTTPS 换一次性短期 WS ticket，再建立 WSS。
- 原生 token 存 Expo SecureStore。

### F-007：吊销不能终止已建立连接（Resolved）

Severity：P1 / Medium

Observed：token 只在 upgrade 时校验。binding revoke 后，已建立 WS 仍保持连接。

建议：连接 registry 关联 binding id，revoke 时主动 close；定期或敏感命令前复查 binding status。

### F-008：配对码没有尝试限流（Resolved）

Severity：P1 / Medium

Observed：4 位 code、15 分钟 TTL、无 IP/device rate limit。

建议：增加 redeem rate limit、失败退避和审计日志。设计文档声称“SHA-256+salt”，实际代码只有 SHA-256，需要统一文档或实现。

## 7. Companion 客户端 Gap

### F-009：全部业务数据为静态 fixture（Resolved for connected mode）

Severity：P0 / High

Observed：tickets、timeline、projects、agendaEvents 全部定义在 `model.ts`。

### F-010：交互只改 local state（Resolved for chat/ticket chat/approval）

Severity：P0 / High

Observed：

- Lead composer 只 append 本地字符串。
- Ticket composer `onSend={() => undefined}`。
- Approval button 只设置 `approved=true`。

### F-011：没有 pairing/auth lifecycle（Resolved）

Severity：P0 / High

缺少：

- server address 配置
- pairing code 输入/扫码
- token 安全存储
- binding revocation UX
- unauthorized/re-pair UX

### F-012：没有数据状态和错误状态（Partially resolved）

Severity：P1 / Medium

缺少：loading、empty、offline、stale、reconnecting、unauthorized、server upgrade required、mutation conflict。

### F-013：UI type 与 backend contract 漂移（Resolved）

Severity：P1 / Medium

Observed：

- UI status 缺 backlog/assigned/done/cancelled。
- UI priority 缺 urgent。
- UI 使用字符串 id，backend 使用 number。
- UI `running` 与 backend `in_progress` 命名不一致。

建议建立共享 protocol package，不再手写重复 enum。

## 8. 建议的 Control-plane Contract

### 8.1 共享协议包

新增 `packages/protocol`，使用 TypeBox 定义并导出：

- HTTP request/response schema
- WS command/event schema
- enums
- protocol version
- runtime capability list

Backend 和 Companion 都从同一 schema 生成类型。

### 8.2 Snapshot HTTP API

| Method | Endpoint | Scope | 用途 |
| --- | --- | --- | --- |
| POST | `/v1/paired/redeem` | public | 配对码换 token |
| GET | `/v1/overview` | `tickets:view` | Lead/busy、running、attention、badge 摘要 |
| GET | `/v1/conversation/turns` | `chat` | 用户可见 Lead 会话历史 |
| GET | `/v1/tickets` | `tickets:view` | filter/search/sort/cursor |
| POST | `/v1/tickets` | `tickets:create` | 直接建单，非主 UI 必选 |
| GET | `/v1/tickets/:id` | `tickets:view` | 详情、runtime、attention 摘要 |
| GET | `/v1/tickets/:id/activities` | `tickets:view` | append-only timeline |
| GET | `/v1/tickets/:id/attempts` | `tickets:view` | attempt 列表和状态 |
| GET | `/v1/tickets/:id/execution-events` | `tickets:view` | 从 session 投影最近工具调用 |
| GET | `/v1/projects` | `tickets:view` | ticket.project 聚合 |
| GET | `/v1/agenda` | `tickets:view` | from/to/timezone 范围日程 |
| GET | `/v1/approvals` | `approvals:respond` | pending approvals |
| POST | `/v1/approvals/:id/resolve` | `approvals:respond` | approve/reject/approve_session |
| POST | `/v1/notices/:id/read` | `notices` | 当前 binding 已读 |
| POST | `/v1/push-tokens` | `notices` | 注册 Expo push token |

所有 mutation 必须支持：

- `Idempotency-Key`
- actor/binding 审计
- 合法状态校验
- 409 conflict
- 结构化 error code

### 8.3 WebSocket command

```json
{
  "type": "chat.send",
  "id": "cmd_01",
  "message": "继续核对 Android 边界",
  "context": { "ticket_id": 42 }
}
```

### 8.4 WebSocket event envelope

```json
{
  "protocol_version": 2,
  "event_id": "evt_01",
  "seq": 1042,
  "type": "lead.message.delta",
  "occurred_at": "2026-07-23T13:58:00.000Z",
  "origin": {
    "binding_id": 7,
    "kind": "companion"
  },
  "turn_id": "turn_55",
  "ticket_id": 42,
  "payload": {
    "message_id": "msg_91",
    "delta": "正在核对"
  }
}
```

最低事件集合：

- `lead.turn.started`
- `lead.message.delta`
- `lead.message.completed`
- `lead.tool.started`
- `lead.tool.completed`
- `lead.tool.failed`
- `ticket.created`
- `ticket.updated`
- `attempt.started`
- `attempt.updated`
- `child.tool.started`
- `child.tool.completed`
- `approval.required`
- `approval.resolved`
- `notice.created`
- `daemon.status.changed`

客户端连接时传 `after_seq`，server 对可 replay 事件补发；超出保留窗口则返回 `snapshot_required`。

## 9. 推荐实施顺序

### Phase 0：冻结协议边界

目标：避免边做 App 边改 event shape。

1. 创建共享 TypeBox protocol package。
2. 定义 snapshot DTO、command/event envelope、error codes。
3. 明确 V1 日程只展示 ticket/schedule operational agenda。
4. 移除 V1 真实数据中无法支持的 progress percentage。

Release gate：protocol schema tests + backward compatibility policy。

### Phase 1：补齐 paired read/control API

目标：原型主要区域可以读取真实数据。

1. tickets list/detail/activity/attempt endpoints。
2. projects aggregate endpoint。
3. agenda range endpoint。
4. pending approvals + resolve endpoint。
5. scope enforcement、CORS、structured errors。

Release gate：HTTP contract tests 覆盖 401/403/404/409/422。

### Phase 2：可靠 conversation/event transport

目标：常驻聊天输入框真实可用。

1. conversation turn projection。
2. origin-aware routing，不再全局发送 delta。
3. turn/message/tool ids。
4. event seq + reconnect replay。
5. ticket-context chat。

Release gate：CLI、Slack、两个 Companion 同时在线的并发/steer/断线恢复测试。

### Phase 3：Companion 接线

目标：删除 fixture，完成 connected alpha。

1. pairing flow + SecureStore。
2. HTTP client + WS client + reconnection state machine。
3. snapshot cache + optimistic chat。
4. ticket/project/agenda/detail 替换静态数据。
5. approval 真实 mutation。
6. loading/empty/error/offline/revoked UX。

Release gate：Web、iOS、Android 真实 daemon E2E。

### Phase 4：任务时间线和通知

目标：实现原型最有价值的执行可视化。

1. Lead tool lifecycle 完整事件。
2. Child live tool event bridge。
3. session JSONL historical projection。
4. per-binding notice delivery/read。
5. Expo push token 和 blocker/approval/reminder push。

Release gate：App 后台、daemon 重启、网络切换、离线重连后状态一致。

### Phase 5：非核心增强

1. 附件。
2. 语音转写。
3. project entity。
4. 外部日历连接器。
5. 可选进度估算。

## 10. 场景矩阵

| ID | Priority | 场景 | Backend | Paired API | Companion | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| S-001 | P0 | 配对码兑换并连接 | 已实现 | 已实现 | 未实现 | blocked |
| S-002 | P0 | App 发送 Lead 消息并流式回复 | 已实现 | 部分实现 | 未实现 | blocked |
| S-003 | P0 | App 重连后恢复聊天 | 无 projection/replay | 缺失 | 缺失 | blocked |
| S-004 | P0 | 两个 channel 同时发消息 | Lead steer 已实现 | 缺 origin routing | 缺处理 | blocked |
| S-005 | P0 | 查看真实工单列表 | store 已实现 | 缺失 | fixture | blocked |
| S-006 | P0 | 打开工单详情/时间线 | store/session 已实现 | 缺失 | fixture | blocked |
| S-007 | P0 | App 批准/拒绝审批 | DAO 已实现 | 缺失 | local state | blocked |
| S-008 | P0 | binding 无权限时拒绝写操作 | scopes 已存 | 未 enforcement | 无处理 | blocked |
| S-009 | P1 | ticket-context Lead chat | Lead 可理解文本 | 无 ticket context | 空实现 | blocked |
| S-010 | P1 | 项目/unknown 聚合 | 可 SQL 聚合 | 缺失 | fixture | blocked |
| S-011 | P1 | 本周 due/remind/schedule | 领域已实现 | range API 缺失 | fixture | blocked |
| S-012 | P1 | child tool 实时展示 | child event 存在 | 未 bridge | fixture | blocked |
| S-013 | P1 | blocker/approval/reminder badge | inbox/approval 已实现 | per-binding unread 缺失 | hardcoded | blocked |
| S-014 | P1 | App 后台收到提醒 | Slack/desktop 可用 | push 缺失 | push 缺失 | blocked |
| S-015 | P2 | 附件输入 | 缺失 | 缺失 | button only | blocked |
| S-016 | P2 | 语音输入 | 缺失 | 缺失 | button only | blocked |

## 11. 明确不应做的事

1. 不要让 Companion 解析 `plc list/show` 文本。
2. 不要让 App 直接访问 SQLite 文件。
3. 不要为右侧任务聊天创建第二个 Lead session。
4. 不要把 `last_activity_at` 伪装成 62% 完成度。
5. 不要把所有 child 原始 event 全量复制进 activities。
6. 不要在 scope enforcement 之前开放直接审批和工单 mutation。
7. 不要把前台 WebSocket 当作移动端后台通知方案。
8. 不要在真实日历 connector 未实现前，把 fixture 日程误导为系统能力。

## 12. 审计边界与未验证项

### 12.1 整改实现摘要

本次整改落地：

- `packages/protocol`：protocol v2、scope、DTO、HTTP envelope、WS command/result/event strict schemas。
- SQLite：`channel_turns` 用户可见会话投影、`gateway_events` 单调 seq 可重放事件日志。
- HTTP：overview、conversation、tickets、activities、attempts、projects、agenda、approvals、approval resolve、one-time WS ticket。
- WS：`hello.v2`、`chat.send`、`status.get`、`sync.resume`、command correlation、scope/audience filtering、revocation recheck、`after_seq` replay。
- Runtime bridge：Lead delta/tool lifecycle、Child tool lifecycle、ticket/attempt/approval invalidation event；工具参数与结果递归脱敏、截断。
- Companion：配对 route、原生 SecureStore、Web storage adapter、严格 schema 校验、指数退避重连、持久化 replay cursor、真实工单/项目/日程/会话/审批接线。
- UI contract：补齐 backend status/priority，移除虚构 progress percentage；`project=null` 仅在展示层归组为 `unknown`。
- Compatibility：Unix socket 与 paired WS v1 `chat/status` 保留。

本次明确未完成：

- attempt session JSONL 的历史 execution-event HTTP projection。
- per-binding notice delivery/read 与 App badge 的准确已读语义。
- Expo push token 注册、iOS/Android 后台通知、Web push。
- TLS/WSS、Tailscale 或同源 reverse proxy 的生产部署。
- 附件、语音转写、外部日历 connector。
- 大量工单分页、gateway event retention/compaction、通用 mutation idempotency。

因此复审结论是：**代码级 connected alpha 通过，生产远程可达与后台通知仍 blocked。**

已审计：

- backend store/schema/tools/runtime/gateway/daemon/tests
- Companion routes、model、主要 UI 交互
- 设计文档与实现差异
- 当前 daemon/doctor/AiSH/launchd/TCP 运行态

未验证：

- AiSH 当前断线的具体原因
- Tailscale 或反向代理部署方式
- iOS/Android 真机到 daemon 的网络路径
- Expo push delivery
- 大量 ticket 下的分页性能
- Lead SDK session 文件长期兼容性
- 外部日历、邮件等 connector

这些未验证项不会改变 P0 结论：先补 paired control-plane，再接 Companion。

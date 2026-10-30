# M6+ 方案设计：触达网关与私人助理化

> 目标：把 pi-lead-child 从"终端里的任务委派系统"升级为"随时随地可唤起的私人助理"。
> 覆盖对抗性评审确认的 Gap 1（触达）、Gap 2（时间）、Gap 5（审批），并为 Gap 3（世界接口）、
> Gap 4（记忆）、Gap 6（部署）铺路。

## 0. 调研结论（2026-07-21 二次核对后修订，决定设计走向的事实）

> 修订说明：初版误把 `~/Workspace/AI/aish-hono` 当作 aish service（同名巧合）。真实仓库经用户指认为
> `~/Workspace/Acme/pltf-copilot-aish`（服务端）与 `~/Workspace/Acme/slack-to-agents`（cli-aish-bridge，参考客户端）。

| 事实 | 出处 | 设计影响 |
|---|---|---|
| **桥接服务端已完整存在且生产运行**：`wss://aish.example.com/ws/agent`（另有测试环境和本地 :9080），BotFather 发 `bf_` token（只存 sha256，一 bot 一活跃 token），protocol_version 1 | pltf-copilot-aish src/surface/botfather/{ws_endpoint,ws_gateway,ws_protocol,api_endpoints}.py | **aish 侧零改动**。plc 实现 WS 客户端即可 |
| 连接方向 = 客户端拨出（confirmed）；auth 首帧 5s 内、应用层 ping/pong 30s/15s、重连退避 1→60s、AUTH_FAILED 不重试 | slack-to-agents src/bridge/ws-client.ts | plc 的 aish 适配器照抄该状态机 |
| 消息协议：`event`（含 channel_id/thread_ts/sender/text）→ 回复走 `stream_start`（ACK 带 stream_ts）/`stream_append`（256 字符/100ms flush，单条 3000 上限，≤4 条未 ACK）/`stream_stop`；非流式 `send_message`；`add_reaction`（eyes=收到）；`fetch_thread_messages` 拉线程历史 | slack-to-agents src/protocol/types.ts + ws_protocol.py | 完整 schema 直接复制 types.ts |
| **审批是协议内置的**：`approval_request` → Slack 自动渲染 Approve/Deny 按钮 → `approval_result`（accept/acceptForSession/decline/cancel）/`approval_retry` 推回 | ws_gateway.py + actions.py | **Gap 5 的 Slack 审批 UX 免费获得**，plc approvals 直接对接 |
| 路由与安全：一 bot 一 owner（owner gate：仅 bot 主人可对话）；频道首次 @display_name 后线程内免提；DM 需 allow_dm；outbound 仅限已路由频道 | event_router.py, ws_gateway._is_action_authorized | owner gate 天然匹配"私人助理"语义；无需自建 allowlist |
| token 获取是带外的：BotFather 网页（Keycloak 登录）建 bot → `POST /api/botfather/bots/{id}/token` → 粘贴给客户端 | api_endpoints.py | aish 路径无需 plc 配对码；`bf_` token 进 plc 配置 |
| AiSH-X assistantd 有完整配对协议：owner/paired 双平面、配对码、token 只存哈希、channel bindings、WS hello 握手 | AiSH-X services/assistantd/internal/* | **inbound 平面**（桌面/手机端）采用此同构协议 |
| Hermes 的网关模式：平台适配器 + 配对码审批 + 授权层级 | hermes-agent gateway/7.4 | 适配器抽象与授权层级纪律照搬 |
| plc daemon 现状：Unix socket 单平面无鉴权（本机 loopback 信任） | src/daemon/server.ts | Unix socket 保留为 owner 平面 |

## 1. 总体架构：一个大脑，多张嘴，两种接线方向

```
                        ┌────────────────────────────────────────┐
                        │  plc coordinatord（daemon，唯一大脑）     │
                        │  lead session · 账本 · child 托管         │
                        │  scheduler(新) · approvals(新)           │
                        ├──────────────┬─────────────────────────┤
                        │ Owner 平面    │  Gateway（新）            │
                        │ Unix socket  │  paired 平面 HTTP+WS      │
                        │ 本机 CLI 专用 │  (127.0.0.1 或 LAN 绑定)  │
                        └──────┬───────┴───────┬────────┬────────┘
                               │        inbound │        │ outbound(拨出)
                          plc chat        ┌─────┴───┐  ┌─┴──────────────┐
                          plc daemon *    │桌面端 app │  │ aish-bridge     │
                                          │手机端 app │  │ (plc 侧适配器,   │
                                          │(AiSH-X 同 │  │  主动拨向 aish   │
                                          │ 构协议)   │  │  的桥接 WS)      │
                                          └──────────┘  └───┬────────────┘
                                                            │ 内网
                                                     ┌──────┴───────┐
                                                     │ aish-hono     │
                                                     │ +bridge surface│←→ Slack
                                                     └──────────────┘
```

**核心裁决：单 lead 会话，多路复用。** 私人助理只有一个大脑——所有上游（CLI/Slack/桌面/手机）的消息都汇入同一个 lead session，消息前缀标注来源（`[来源: slack thread=xxx user=alice]`），回复按来源路由回去。执行中收到其他上游的消息走既有 steer 通道（插话语义天然适配多嘴）。**不做**每上游独立会话——那会分裂助理的记忆与状态（"我在 Slack 上跟你说过"必须成立）。

**两种接线方向**（Gap 1 的关键分解）：
- **Inbound pairing**：客户端拨入 plc（同机/局域网/Tailscale）。适用：桌面端、手机端、本机 CLI。协议 = AiSH-X 同构。
- **Outbound adapter**：plc 主动拨出到上游中继。适用：aish（笔记本在 NAT 后、无固定地址，plc 拨出连接是唯一可靠方向——这正是 Slack socket mode 自身的哲学）。

## 2. 配对协议（AiSH-X 同构，差异显式标注）

### 2.1 双平面
- **Owner 平面**（2026-10-13 起）：数据目录（0700）里的 `plc.sock`，权限 0600。它只做三件事：
  - 本机凭证交换：`cli_credential` 签发一个 `kind=cli` 的 binding，只带缺省 scope。plc 把它存进数据目录。
  - 临时管理权限：`admin_token` 签发一个只在网关内存里的 admin token，5 分钟后作废，只开管理路由。plc 每次执行管理命令时换一个，不落盘。
  - 信任边界是系统用户：0700 的目录和 0600 的文件、socket 只挡别的系统用户。同一个用户的任何进程（包括 child agent）都能连上 `plc.sock` 换 admin token，也能读存下来的凭证（它带 `tickets:create`，能做事项动作、对 lead 授权和委托）。同一个系统用户之内没法强制隔离；存下来的凭证不带 admin、admin token 5 分钟过期，只是纵深防御。
  - 运维：supervisor 用 `status` 探活，用 `shutdown` 停机。
  聊天、事项动作、授权和重检不在这里。`plc` 和 companion 一样走 paired 平面。配对管理（`plc pair new/list/revoke`）是 paired 平面上的管理路由，要 `admin` scope。
- **Paired 平面**：`/v1/*` HTTP snapshot/control + `/v1/paired/events` WS，Bearer access_token。它总是启动：配置了 `PLC_GATEWAY_PORT` 时用那个端口，否则用 47130（被占用时改用随机端口）。网关总是监听回环。显式配置的 LAN/Tailscale 地址（必须同时配置 `PLC_GATEWAY_PORT`）另开一个监听，共用端口，绑不上时在后台退避重试（1 秒起，最多 60 秒一次），状态在 plc.sock 的 `status`（`gatewayExposure`）和 `plc doctor` 里。已经绑上的地址后来消失时不重新绑定；地址换了需要重启 daemon。通配地址（`0.0.0.0`、`::`）是唯一的监听，它包含回环（Linux 上它不能和 `127.0.0.1` 共用端口）；绑不上时只监听回环，并警告。客户端每次连接前都向 daemon 要当前地址（plc 走 `plc.sock` 的 `status`）。`after_seq=-1` 表示不回放历史，只收新事件。
- **系统回合**（2026-10-13 起）：lead 自己发起的回合（`system:blocker`、`system:notification`、`system:heartbeat`、`system:precipitate`）和 daemon 自己发出的通知（`system:blocker-notice`、`system:fallback-notice`）都是 `channel_turns` 里的一轮。它们的 `origin_binding_id` 为空，`user_text` 为空，事件的 `audienceBindingId` 为 null，所以发给所有带 `chat` scope 的客户端。lead 第一次开口或调工具时，这一轮才落库；lead 一言不发就收尾时，不留空的一轮。用户发起的回合只发给发起的 binding：别的客户端没有那句提问，刷新会话流时照样看得到全部回合。"有人在听"只算活着的（网关定时 ping）、说自己有人在看的（`presence.set attended=true`）、binding 仍然有效并带 `chat` scope 的 v2 连接。companion 在应用处于前台并且 `PRESENCE_IDLE_MS`（5 分钟）内有过操作时上报，plc chat 运行中并且 5 分钟内有过输入时上报，旧版 v1 连接不算。一条通知只有 lead 在播报的那一轮里真的说了话、并且播完时仍然有人在听，才记为 lead 已送达；同一条通知的重试复用同一轮并退避，播了但没人在听的不再播第二遍。
- **Web UI**：paired 平面在 `/v1` 之外的 GET 路径上提供 companion 的静态导出（`npm run build:web` 写到 `dist/web`）。用户打开网关地址即可，例如 `http://127.0.0.1:47130`（`plc web` 打印这个地址）。导出不内联网关地址：回环地址上的页面把自己的 origin 当作网关。loopback 自动配对开启时，网关信任自己的回环 origin（`127.0.0.1`、`localhost`、`[::1]` 加网关端口），远端地址仍然必须是回环地址。回环 TCP 不分系统用户，`Origin` 可以伪造，所以开启后同一台机器上的别的系统用户也能拿到一个带缺省 scope 的 binding：它越过了"信任边界是系统用户"，只适合单用户的开发机。局域网里的浏览器也能打开页面，但只能用配对码配对。

### 2.2 配对流程（三腿，照搬 AiSH-X）
1. `plc pair new --name "iPhone" --kind companion [--scopes ...]` → 生成 `PLC-XXXX` 码（同字母表去易混字符，TTL 15min），只存 SHA-256；redeem 按远端地址限流。
2. 客户端 `POST /v1/paired/redeem {pairing_code}` → 201 返回 `{binding, access_token}`，token 单次下发只存哈希。
3. 之后所有调用带 `Authorization: Bearer <token>`；WS 连接鉴权在 upgrade 前完成，连上后 `hello{subscribe:[...]}` / `hello.ack` 握手，订阅按 scope 过滤。

### 2.3 Scopes（借 AiSH-X 语义，映射到 plc 领域）
`chat`（对话）、`tickets:view`、`tickets:create`、`approvals:respond`、`notices`（接收通知推送）。缺省客户端全给；aish 桥接给 `chat`+`notices`+`approvals:respond`。

`admin`（2026-10-13 起）：配对管理（`/v1/admin/pairings`、`/v1/admin/bindings`）、aish 凭证（`/v1/admin/aish`）和 runtime 重检（`/v1/runtimes/recheck`）。配对码、loopback 自动配对和 plc 存在文件里的凭证都不带它。只有 `plc.sock` 上签发的临时 admin token 带它。已有的 binding 保持原来的 5 个 scope。`GET /v1/paired/me` 让一个凭证证明自己是哪个 binding（临时 admin token 不能用它）。

### 2.4 Bindings 模型（channels 表新增）
```sql
CREATE TABLE bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('cli','desktop','companion','aish-slack')),
  display_name TEXT NOT NULL,
  external_subject TEXT,          -- aish-slack: 'slack:<team>:<user_id>'
  token_hash TEXT,                -- paired 平面凭证（outbound adapter 为 NULL）
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','revoked')),
  last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.5 Control-plane protocol v2（已实现）

共享契约位于 `packages/protocol`，使用 TypeBox 严格 schema（禁止额外字段），版本号为 `2`。

HTTP 是当前状态的权威来源：

- `GET /v1/overview`
- `GET /v1/conversation/turns`
- `GET /v1/tickets`、`GET /v1/tickets/:id`
- `GET /v1/tickets/:id/activities`、`GET /v1/tickets/:id/attempts`
- `GET /v1/projects`
- `GET /v1/agenda?from&to&timezone`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/resolve`
- `POST /v1/paired/ws-ticket`

WS v2 使用带身份和顺序的 envelope：`protocolVersion/eventId/seq/type/occurredAt/requiredScope/audienceBindingId/turnId/ticketId/payload`。客户端命令为 `chat.send`、`status.get`、`sync.resume`，每条命令使用 `id` 与 `command.result` 关联。

路由纪律：

- Lead delta/tool/message 仅发送给发起 paired binding。
- Child/ticket/approval 等领域事件按 required scope 广播。
- gateway 事件先写 SQLite durable outbox，再由 paired server 的顺序 flusher 投递；事务内
  Coordinator 写入与进程内 `publish()` 走同一条 `seq` 顺序源。客户端以 `after_seq` 重连补发，
  `sync.resume` 完成后同步推进该连接的 live cursor，避免 replay/live 重复发送。
- 长期 bearer token 仅用于 HTTPS HTTP；WebSocket 优先使用通过 HTTP 获取的短期一次性 ticket。
- 旧版 `chat/status` WS 与 Unix socket 推送保持兼容，作为迁移层保留。

### 2.6 Companion client（已实现，2026-07-23）

- iOS/Android 使用 `expo-secure-store` 保存连接记录，Web 使用独立 storage adapter。
- 客户端严格校验配对响应、WS ticket、`hello.v2`、command result、gateway event 和 snapshot DTO。
- 断线指数退避，持久化最后已处理 seq；重连使用一次性 WS ticket + `after_seq`。
- 未配对时 Companion 只展示连接引导和真实空态，不展示 demo 工单或假会话；配对后工单、项目、日程、会话和审批全部来自真实 control-plane。
- 全局输入框进入同一 Lead session；任务线程输入框仅附加 `ticketId` context，不创建第二个 session。

### 2.6.1 Companion Zustand 状态边界（已实现，2026-07-24）

- `CompanionStateRuntime` 是客户端唯一运行时，持有一个 `ControlPlaneClient` 和三个按 Provider
  实例创建的 Zustand vanilla stores，避免 SSR 请求间状态泄漏。
- `controlPlaneStore` 只保存经过共享协议校验/适配的规范化实体与资源状态；
  `streamStore` 保存有界的 Lead delta、tool progress、agent logs 和 heartbeat；
  `workspaceStore` 保存 Web/native 共用的选择、面板、rail、展开和 composer draft。
- Gateway event 先经过 TypeBox payload adapter，再由纯 reducer 生成 control mutation、stream
  mutation 和 resource invalidation；高频 delta/log 按 16ms 窗口批量提交。
- Lead 会话使用 `MessageEntity + MessagePart`：文本、tool、ticket、approval、artifact、agent status
  使用统一部件边界。Tool payload 只保留最多 16 KiB 的脱敏显示投影，不把 raw unknown/base64
  内容写入 Store。
- command ID、turn ID 和 gateway seq 是收敛键。乐观消息不依赖文本/时间猜测去重；timeout
  明确保留为未知结果。Cursor 只有在凭证持久化成功后才提交和投递事件。
- lazy resource 的 generation 参与 HTTP 响应提交判断；事件 invalidation 后到达的旧快照不得
  覆盖新状态。release/re-observe、强制 authority refresh、forget/disconnect 与历史分页都受
  lifecycle epoch 约束，旧请求完成不能回写新连接。
- 旧 `ControlPlaneProvider/useControlPlane` 兼容层与生产 demo 数据已经删除，组件只使用聚焦 selector
  hooks 和 runtime command actions。

### 2.7 Kernel snapshots 与 Coordinator（已实现，2026-07-23）

protocol v2 保持冻结，Companion 当前使用的严格 DTO 和 WS 事件枚举不增加字段。扩展内核状态使用独立资源：

- `GET /v1/kernel/projects/:id`
- `GET /v1/kernel/tickets/:id`
- `GET /v1/kernel/tickets/:id/children`
- `GET /v1/kernel/tickets/:id/dependencies`
- `GET /v1/kernel/attempts/:id`
- `GET /v1/kernel/attempts/:id/events`
- `GET /v1/kernel/learning/candidates`
- `GET /v1/kernel/capabilities`

这些读取统一要求 `tickets:view`。`POST /v1/tickets` 要求 `tickets:create`，且不直接写表，而是调用 Coordinator 完成项目解析、root/hierarchy 默认值和运行时策略落账。

daemon 额外运行短周期 orchestrator：持久化 dispatch request/claim 后才启动 runtime；依赖、plan sealing、active attempt、root/project 并发、retry 和预算全部在 claim 前检查。Pi、Codex、Claude 的原生输出先归一化为 `run.* / message.* / tool.* / usage.updated`，再进入同一 ingest、gateway event 和 learning 管道。

自动 reviewer 默认 Codex。只有声明并实现 `executableReadOnlyReview` 的 runtime 才能承担 reviewer，以保证“可重跑测试”与“禁止修改产物”同时成立。

### 2.8 Checkpoint 控制面与完整 Companion UX（已实现，2026-07-24）

protocol v2 的 gateway event union 继续冻结。Checkpoint、干预、工单工作台、耗时和耐久会话卡片通过 additive HTTP 资源暴露，并在 `hello.v2.capabilities` 宣告：

- `kernel.checkpoints.v1`
- `kernel.interventions.v1`
- `kernel.work-items.v1`
- `kernel.ticket-workbench.v1`
- `kernel.conversation-cards.v1`

新增资源：

- `GET /v1/kernel/tickets/:id/checkpoints`：按数据库 ID 升序分页，要求 `tickets:view`。
- `GET /v1/kernel/work-items`：工单耗时、active execution、待处理干预数和最新 Checkpoint，要求 `tickets:view`。
- `GET /v1/kernel/tickets/:id/workbench`：工单、耗时、active attempt、直接子工单、最近 Checkpoint 和安全 intervention refs，要求 `tickets:view`。
- `GET /v1/kernel/interventions` 与 `POST /v1/kernel/interventions/:id/resolve`：读取/处理完整 authority，要求 `approvals:respond`。
- `GET /v1/kernel/conversation/cards`：按 ticket、stable key 和 cursor 读取 Lead 会话卡片，要求 `tickets:view`。

权威边界：

- Checkpoint 是 child/system 在关键环节提交的事实反馈，不是审批结果的权威副本。
- Approval 与 decision request 是唯一可执行 authority；会话卡片和详情面板只引用 authority ID。
- paired 响应统一记为 `user via paired binding:<id>`；Lead 不能伪造 user actor，user-audience decision 同样执行该约束。
- `ticket_update` 进入 review 等关键状态时必须与语义 Checkpoint 原子提交；checkpoint-bearing
  请求使用包含 body/status/reason/checkpoint 的持久化 request fingerprint。完全相同的 replay
  不受 semantic dedupe 时间窗影响，任一有效字段变化都冲突失败。
- 子工单只有在 executor attempt `settled` 且工单为 `done` 后才能投影为完成。

SQLite 迁移：

- v10 `kernel-orchestration-v1`：运行时中立的层级工单、attempt 和项目内核。
- v11 `checkpoint-control-plane-v1`：checkpoints、decision requests、conversation cards、approval attempt 归属与 ticket timing。
- v12 `plan-item-idempotency-v1`：`ticket_plan_memberships.item_key` 与 parent/revision/item-key 唯一索引，保证重复规划不重复建单。

Checkpoint 策略参数及默认值：

- `PLC_CHECKPOINT_DEDUPE_WINDOW_MS=60000`
- `PLC_CHECKPOINT_PROGRESS_MIN_INTERVAL_MS=120000`
- `PLC_CHECKPOINT_SILENCE_MS=900000`
- `PLC_CHECKPOINT_SILENCE_TOOL_EVENTS=8`
- `PLC_CHECKPOINT_SILENCE_DOMAIN_EVENTS=3`
- `PLC_CHECKPOINT_REMINDER_COOLDOWN_MS=900000`

Companion 状态与渲染：

- `controlPlaneStore` 规范化 checkpoints/work-items/workbench/interventions/timing/conversation cards；resource observer 在面板关闭时释放。
- `streamStore` 只承载高频 Lead delta 和有界 agent logs；详情日志按 active attempt 订阅。
- `workspaceStore` 承载面板选择、composer draft 和 intervention command 的 pending/error/succeeded 状态，authority 本身不做 optimistic mutation。
- conversation card 先按 stable key 合并 live/durable 投影，再附加 durable ID；刷新、重连和 operation 更新不会生成重复卡片。
- Lead 时间线中，turn 卡紧跟对应 assistant 消息；无 turn 的异步 child 卡按 `createdAt` 插入。intervention 卡拥有同 Checkpoint 时抑制普通 Checkpoint 卡。
- Lead card 与 Checkpoint feed 暴露 cursor 分页入口；项目/日程 rail 读取真实 control-plane
  resources。中央会话和工单线程在断线缓存态均禁用发送、审批与历史网络操作。
- Web、Android、iOS 共用同一 Zustand/Unistyles/Reanimated 实现；移动端继续使用临时全屏面板，不恢复传统 bottom tabs。

## 3. aish 适配器规格（plc 侧实现，aish 侧零改动）

plc daemon 内新模块 `src/gateway/aish-adapter.ts`，实现 botfather protocol v1 的 WS 客户端
（状态机照抄 slack-to-agents 的 `ws-client.ts`，消息类型直接复制其 `protocol/types.ts`）：

1. **配置与接线**：`PLC_AISH_URL`（默认 `wss://aish.example.com/ws/agent`）+ `PLC_AISH_TOKEN`（BotFather 签发的 `bf_` token，带外获取：BotFather 网页建 bot → 发 token → 粘贴）。配置齐全即拨出连接；`connected` 帧回读 bot_id/bot_name 存入 bindings（kind='aish-slack'）。
2. **协议纪律**：auth 首帧 5s 内；收 `ping` 回 `pong`，自发 `ping` 每 30s、15s 无回强制重连；退避 1s→60s；`AUTH_FAILED/AUTH_TIMEOUT` 停止重连并升 blocker 通知。
   - 失效 token 不重试（2026-10-13 补充）：上游回 `AUTH_FAILED` 时，daemon 在 kv 里记下这个 token 的 SHA-256 指纹，不存 token 本身。之后用同一个 token 启动时，daemon 不连接，也不通知，只记一行日志。新 token 的指纹不同，所以标记对它无效。`AUTH_TIMEOUT` 不记标记。
   - 凭证管理：`plc aish status` 显示凭证状态，不显示 token。`plc aish forget --yes` 删除已保存的凭证。换 token 只走环境变量 `PLC_AISH_TOKEN`，不走命令行参数，因为命令行参数会留在 shell 历史里。
3. **入站**：`event` → `add_reaction(eyes)` 示收到 → 消息进统一入口（同 paired chat 语义，origin=`slack:<channel_id>:<thread_ts>`）→ lead busy 时天然走 steer。冷线程可 `fetch_thread_messages` 补上下文（增量游标）。
4. **回程**：lead 的 delta 流经客户端缓冲（256 字符/100ms，与服务端 flush 参数对齐）→ `stream_start`（等 ACK 拿 stream_ts）→ `stream_append`（≤4 条未 ACK 在途）→ turn_end 时 `stream_stop`。通知推送（blocker/child 完成）用 `send_message` 发到最近活跃 thread 或 DM。
5. **审批直通**：plc approvals（§5）在 aish 通道的投递 = `approval_request`（服务端自动渲染 Approve/Deny 按钮），`approval_result` 的 accept/decline 映射到 approvals 表 resolve；`acceptForSession` 映射为"本工单内同类动作免批"（approvals 表加 session 豁免位）。
6. **owner gate 即隐私边界**：aish 的 bot 仅响应 owner（alice），无需 plc 侧再做用户过滤。

> 修订注记：初版设计误判需要给 aish 提桥接 PR——二次核对确认服务端与协议完整存在，
> plc 单方面即可完成 Slack 接入。M6 工程量因此显著下降。

## 4. 时间系统（Gap 2）

### 4.1 Schema
```sql
ALTER TABLE tickets ADD COLUMN due_at TEXT;      -- 截止时间（ISO，本地时区换算后存 UTC）
ALTER TABLE tickets ADD COLUMN remind_at TEXT;   -- 下次提醒时间
CREATE TABLE schedules (                          -- 例行任务
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, brief TEXT NOT NULL,
  cron TEXT NOT NULL,                             -- 五段 cron 表达式
  workdir TEXT, priority TEXT NOT NULL DEFAULT 'normal', project TEXT,
  spawn INTEGER NOT NULL DEFAULT 0,               -- 1=到点自动建单并派 child；0=仅建单提醒
  next_run_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.2 Daemon scheduler 循环（60s）
- `remind_at <= now` → inbox blocker（"工单 #N 提醒：…"）→ 现有投递管道（在线推 WS/离线桌面通知/aish 在线推 Slack）→ 清空或按规则顺延 remind_at。
- `due_at` 逾期且未终态 → attention（每单一次）。
- `schedules.next_run_at <= now` → 建工单（可选 spawn child）→ 重算 next_run_at。

### 4.3 Lead 工具与纪律
- `set_ticket_schedule(ticket_id, due_at?, remind_at?)`；`create_schedule(title, brief, cron, spawn?)`；`agenda(days?)`——按 due/remind/schedule 汇总"接下来 N 天"视图。
- 纪律：用户话语里出现时间语义（"周五前""每周一""提醒我"）必须落到时间字段，禁止只写进 brief 文本；"提醒我 X"类非执行任务建单但不 spawn，由 scheduler 履约。
- 时区：daemon 所在机器本地时区解析，存 UTC（lead 提示词注明当前时区与当前时间——**每轮注入当前时间**，否则 LLM 不知道"今天"是哪天）。

## 5. 审批门禁（Gap 5，接世界接口的先决条件）

### 5.1 模型
```sql
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER REFERENCES tickets(id),
  requested_by TEXT NOT NULL,       -- 'child'|'lead'
  action TEXT NOT NULL,             -- 人类可读的动作描述："发送邮件给 X，主题 Y"
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  resolved_by TEXT, resolved_at TEXT, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 5.2 流程
1. child 侧新 extension 工具 `request_approval(action, payload?)`：写 approvals 行 + blocker 级推送（所有 `approvals:respond` 渠道收到可操作消息）→ **工具内轮询阻塞**（pi 工具支持长执行+abort signal），直到 resolved 或超时（默认 30min → expired，工具返回"未获批准"）。
2. 响应入口：paired 平面 `POST /v1/paired/approvals/{id}/(approve|reject)`（AiSH-X 同构）；CLI/chat 里对 lead 说"批准 #N"→ lead 工具 `resolve_approval`；**Slack 走协议内置按钮**（aish `approval_request`/`approval_result`，含 acceptForSession 会话级豁免）。
3. 审计：approvals 行本身 + decision activity 双记录。
4. 纪律：连接器工具文档必须声明哪些动作前置审批（发送类、支付类、删除类）；lead 不得代批（resolve_approval 仅限转达用户的明确意思表示）。

## 6. 世界接口起步（Gap 3 的第一步，只做 web）

- pi extension `web-tools.ts`（注入 child，可选注入 lead）：`web_search(query)` + `web_fetch(url)`。
- Provider 抽象：`PLC_SEARCH_PROVIDER` = brave|searxng|tavily，key 走 env；fetch 走 readability 抽正文+截断。
- 纪律修订：调研类任务 brief 由 lead 注明"必须引用检索到的来源，禁止凭记忆编造"（对抗 M4 e2e 发现的"默写式调研"）。
- 邮件/日历/订票连接器：**显式推迟**到审批门禁验收后，逐个按需接（每个都是独立的 OAuth+API 苦工，且必须逐个过审批纪律评审）。

## 7. 记忆与部署（Gap 4/6，本期只做低垂果实）

- 记忆：notes 检索加 embedding 语义层——经代理的 `/embeddings` 端点（**待验证可用性**），sqlite 存向量+余弦排序，LIKE 作降级。用户画像：固定 note `user-profile` 由 lead 维护（沉淀检查提示词把画像更新列为检查项）。
- 部署：`npm run build`（esbuild 打包，bundle + external native deps：better-sqlite3 与 pi SDK 走仓库 node_modules）+ launchd plist（开机自启、崩溃拉起）+ `plc doctor`（诊断：daemon 活性/配对状态/aish 连通/API key）。服务器化（真 24×7）随 Tailscale/内网主机可用性另议。
- web UI 部署：`npm run build:web` 把 companion 导出到 `dist/web`（`npm run verify` 的最后一步也会运行它）。daemon 每个请求都读磁盘，所以只更新 web UI 时不需要重启。`plc doctor` 报告 `dist/web` 是否旧于 companion 和 protocol 的源码。

## 8. 里程碑划分

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M6 网关** | aish 适配器（protocol v1 客户端，优先——工程量小收益大）+ paired 平面（HTTP+WS+配对码+bindings，桌面/手机路径）+ 消息路由（单脑多嘴） | 手机 Slack 上 DM → lead 流式回帖到 thread；同一会话 CLI 与 Slack 交替对话上下文连续；通知推送到 Slack |
| **M7 时间** | due/remind/schedules + scheduler + agenda 工具 + 每轮时间注入 | "提醒我周五交房租"→ 周五 Slack 收到提醒；"每周一早上汇总本周工单"→ 自动执行 |
| **M8 审批+web** | approvals 全链路 + web_search/fetch extension | child 请求审批 → Slack 一键批准 → child 继续；调研任务产出含真实来源引用 |
| M9+ | 连接器长尾（邮件/日历）、记忆语义化、launchd/build、桌面/手机端接入（协议已同构） | 按需 |

## 9. 风险与开放问题

- ~~aish 协议演进不可控~~ **已消除**：pltf-copilot-aish 由 alice 本人维护，协议演进与 token 策略均在自己控制内。
  适配器仍保留 protocol_version 校验与未知消息宽容（工程卫生，非风险对冲）；必要时协议可以反向为 plc 的需求演进。
- 单脑多嘴的并发：多上游同时说话=天然 steer 风暴，lead 提示词需强化多来源标注下的礼貌仲裁；极端场景（两个上游同时开新话题）接受先到先服务。
- LAN 绑定的安全半径：paired token 保护 + 建议 Tailscale 而非裸 LAN；不做 TLS 自签的复杂度（内网信任模型）。
- 手机端"随时"的诚实边界：M6 后手机可达的前提仍是 daemon 所在机器在线——真 24×7 依赖部署升级（§7），在那之前 aish 路径反而是可用性最高的（aish 在内网服务器上，但它拨不进你的笔记本——所以 aish 桥的可用性同样受笔记本在线时间限制）。**结论：Gap 6 部署（把 daemon 挪到常开机器）是"随时随地"的最终瓶颈，建议 M7 后评估。**

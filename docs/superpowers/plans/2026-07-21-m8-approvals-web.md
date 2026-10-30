# M8 审批门禁 + web 工具 Implementation Plan

> 依据 DESIGN-GATEWAY §5/§6。让助理能安全地碰"真实世界"：不可逆动作前置审批 + child 真正联网。
> REQUIRED SUB-SKILL: superpowers:executing-plans。每阶段 TDD + commit。

## 背景确认（已核对参考实现）
- aish 审批协议现成：child/lead→`approval_request`（approval_id/tool/description/text）→ aish 渲染 Slack Approve/Deny 按钮 → 用户点击 →`approval_result`（decision: accept/acceptForSession/decline/cancel）推回。M6 的 aish-protocol.ts 已定义类型。
- 无 aish 时（纯 CLI/paired）审批走对话："批准 #N"。

## Phase A: approvals 账本 + 阻塞式请求
- schema：`approvals` 表（DESIGN §5.1）：ticket_id/requested_by/action/payload/status(pending/approved/rejected/expired)/resolved_by/expires_at。session 豁免用 payload 里的 tool 键。
- `src/store/approvals.ts`：createApproval、resolveApproval(id, status, by)、getApproval、pendingApprovals、expireStale(now)。
- child extension 工具 `request_approval(action, payload?)`：写 approvals 行 → 阻塞轮询（pi 工具支持长执行 + abort signal），直到 resolved / 超时（默认 30min→expired，返回"未获批准"）。轮询查同 SQLite（child 与 daemon 跨进程,WAL）。
- 测试：create/resolve/expire；child 工具阻塞→resolve 后返回对应结果（用短超时 + 异步 resolve 模拟）。

## Phase B: 审批投递 + 响应入口
- daemon：pending approval → 即时推送（同 remind：blocker 级 + aish approval_request 渲染按钮 / paired+CLI 文本）。
- aish 适配器：approval_request 动作已在 protocol；收到 approval_result → resolveApproval（accept→approved / decline→rejected / acceptForSession→approved + payload 标记 session 豁免同类 tool）。
- lead 工具 `resolve_approval(approval_id, decision, reason)`：CLI/chat 里"批准 #N"→ lead 调用。lead 不得代批（仅转达用户明确意思）。
- 纪律：连接器工具文档声明哪些动作前置审批（发送/支付/删除类）。
- 测试：approval_result 映射；session 豁免；lead resolve_approval。

## Phase C: web 工具
- pi extension `web-tools.ts`（注入 child，可选 lead）：`web_search(query)` + `web_fetch(url)`。
- provider 抽象：`PLC_SEARCH_PROVIDER`（先支持一个可用的：搜索走 env key 的 API；fetch 用内置 http + readability 抽正文截断）。**先确认哪个搜索 API 有可用 key**（可能复用 acme 代理或 web fetch 兜底）。
- 纪律修订：调研类 brief 由 lead 注明"必须引用检索来源，禁止凭记忆编造"（对抗 M4 发现的默写式调研）。
- 邮件/日历等连接器：显式推迟，逐个按需接（各自 OAuth + 必过审批评审）。
- 测试：web_search/web_fetch 用 mock provider；纪律锚点。

## 验收
- child 请求审批 → Slack 一键 Approve → child 继续；Deny → child 收到拒绝。
- CLI 里"批准 #N"闭环。
- 调研任务产出含真实来源引用（真机，需可用搜索 provider）。

## Self-Review / 开放问题
- request_approval 阻塞轮询要尊重 abort（stop_child 时不能永久挂）——复用 execute 的 signal。
- web 搜索 provider 的可用性是 Phase C 的前置未知，先探测（可能需要用户提供 key 或指认可用 API），探不到则 Phase C 降级为只做 web_fetch + 记录 provider 待定。
- 审批与 M7 提醒共享"即时推送"通道，不新造。

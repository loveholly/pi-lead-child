# #47 / #75 Worktree 真实流程观察与优化记录

日期：2026-09-04  
范围：通过真实 Companion Web UI 操作 #47，并观察 Lead、Coordinator、Child、Runtime、SQLite ledger、runtime events、daemon 日志和 Git 工作树。  
结论状态：**#47 设计阶段通过；#75 P1 实施因 Runtime/MCP 认证故障阻塞；Worktree 内核能力尚未实现。**

> 本文记录的是实际运行证据，不把 prompt 中的承诺当成实现。  
> Companion 中的 `workspace` 指 UI 工作区；本文的 workspace/worktree 指 Child 执行目录和 Git 工作副本，两者必须保持职责分离。

---

## 1. 真实操作时间线

### 1.1 #47 设计阶段

用户通过 Companion 完成了以下操作：

1. 打开 #47「为 coding 工单设计 Ticket 级 Worktree 编排方案」；
2. 点击“确认开跑”；
3. 观察到事项从 `draft` 变成 `ready`，没有创建 Run；
4. 点击“开始执行”；
5. 创建 Run #55，runtime=`codex`，model=`gpt-5.5`；
6. Run #55 因模型容量不足失败；
7. 系统自动切换到 Claude，创建 Run #56；
8. Run #56 正常退出，但没有完成结构化交接，事项转为 `blocked`；
9. Lead 根据失败证据重新派发 Codex Run #57；
10. Run #57 生成设计文档并提交 completed Checkpoint；
11. #47 进入 `review`；
12. Companion 中显示 D1–D9 decision request；
13. 用户点击“批准推荐方案”；
14. 用户点击“验收通过”；
15. #47 进入 `done`。

设计文档：

```text
docs/superpowers/specs/2026-09-04-ticket-workspace-orchestration-design.md
```

### 1.2 #75 P1 实施阶段

之后通过 Companion 的 Lead 输入框发起下一阶段：

> 已批准 #47 的 D1-D9 设计。现在只创建并启动 P1 数据模型阶段，P1 必须先使用设计要求的 workspace/worktree 能力，不能直接在主工作目录修改代码。

系统实际执行：

1. 创建唯一的子工单 #75「#47-P1 数据模型：Workspace 表与 Run 关联」；
2. #75 挂在 #47 下；
3. P2–P7 没有创建；
4. 创建 Run #58；
5. Run #58 先执行 `git worktree add`；
6. 创建隔离目录：

```text
/Users/alice/Workspace/AI/pi-lead-child-worktrees/ticket-47-p1-workspace-data-model
```

7. 创建分支：

```text
ticket-47-p1-workspace-data-model
```

8. 使用基线：

```text
243d13889804820cb961082bff3a00a6f4cf4416
```

9. Child 提交了 Checkpoint #116，记录 workspace path、mode、branch、base_ref 和创建时间；
10. 在实际修改前，Child 发现隔离 worktree 中缺少权威设计文档，于是创建 decision request #2；
11. 同时 Codex 持续出现认证/MCP 错误；
12. 用户通过 Companion 向 Lead 发出停止指令；
13. Run #58 被停止；
14. #75 转为 `blocked`；
15. worktree 被保留，主工作目录没有新增代码修改。

最终状态：

```text
#47 = done
#75 = blocked
Run #55 = failed / model_capacity
Run #56 = finished / terminal handoff missing
Run #57 = finished / design completed
Run #58 = stopped / runtime authentication blocker
```

---

## 2. 已验证的正确行为

这些行为符合当前设计或是值得保留的实现方向。

### 2.1 Lead 没有在设计阶段直接修改代码

Run #57 的设计阶段只生成设计文档，并明确提交：

```text
implementation untouched
```

没有观察到主仓库新增代码修改。

### 2.2 Lead 在 Child 交接失败后进行了同一事项恢复

Run #56 正常退出但没有完成终态交接。Lead 没有创建重复的设计工单，而是在原 #47 上重新派发 Run #57。这符合：

- 同一事项保留稳定身份；
- 失败 Run 作为历史保留；
- 新 Run 继续原事项；
- 不通过新建同名工单掩盖失败。

### 2.3 Runtime 容量故障与交接故障被区分

Run #55 的失败是：

```text
Selected model is at capacity
```

Run #56 的失败是：

```text
run ended without terminal handoff
```

两者没有被错误地合并成同一种业务代码失败。

### 2.4 P1 Child 在修改前先创建隔离 worktree

Run #58 在开始实现前先完成了 worktree 创建，并提交了 Checkpoint #116。此顺序是正确的：

```text
create isolated worktree
→ record path/branch/base
→ inspect authority/design
→ begin implementation
```

### 2.5 Runtime 认证故障被正确停止

Run #58 连续出现：

```text
token_expired
refresh token revoked
MCP HTTP 401
```

用户干预后，系统：

- 停止 Run；
- 将 #75 转为 blocked；
- 保留 worktree；
- 记录 blocker；
- 作废悬空 decision request；
- 没有把认证故障当作业务实现失败；
- 没有继续自动重派。

这是正确的安全收敛行为。

---

## 3. 内核和 Runtime 层问题

## P0-1：Workspace 仍未成为内核实体

本次运行中，#75 的数据库字段仍然是：

```text
items.workdir = /Users/alice/Workspace/AI/pi-lead-child
```

但是 Child 实际创建并使用了：

```text
/Users/alice/Workspace/AI/pi-lead-child-worktrees/ticket-47-p1-workspace-data-model
```

这两个事实没有进入同一个权威模型。

当前实现仍然在：

```text
src/children/manager.ts:318
```

使用：

```ts
const workdir = item.workdir ?? process.cwd();
```

本次隔离依赖 Child 自己执行 `git worktree add`，不是 Coordinator 在 Run 启动前完成 workspace provisioning。

### 风险

- Run 账本无法查询真实执行目录；
- retry/resume 不能可靠复用 workspace；
- reviewer 无法根据 Run 事实判断读取哪个 workspace；
- cleanup 不知道哪些目录仍被使用；
- daemon 重启后无法对账 workspace；
- Child 可能忘记创建 worktree，或创建错误分支/基线；
- prompt 失效时可能回退到主工作目录。

### 建议

按 #47 设计实现：

1. 新增 `workspaces` 表；
2. `runs.workspace_id` 在 Run 创建时确定并保持不可变；
3. Coordinator 提供 `resolve/provision/release/cleanup/reconcile`；
4. Child Manager 只消费 Coordinator 注入的 workspace；
5. 禁止 `process.cwd()` 作为 coding Run 的隐式 fallback；
6. 将 `PLC_WORKSPACE_ID/PATH/MODE/BRANCH/BASE_REF` 注入所有 Child；
7. workspace path、branch、base_ref 和 owner 必须成为结构化账本事实。

---

## P0-2：P1 实施工单仍把 `workdir` 指向主工作目录

Lead 创建 #75 时，#75 的 `items.workdir` 仍为：

```text
/Users/alice/Workspace/AI/pi-lead-child
```

虽然 brief 要求 Child 自己创建 worktree，但这会让工单和真实执行环境不一致。

### 建议

Workspace provisioning 必须发生在创建 Run 前，并按以下顺序写账：

```text
workspace requested
→ workspace provisioned
→ Run.workspace_id 写入
→ Run 启动
```

如果 provisioning 失败，不能创建或启动一个看似正常的 Run。

---

## P1-3：权威设计文档没有随实施工单进入隔离 worktree

Run #58 在隔离 worktree 中发现设计文档不存在：

```text
docs/superpowers/specs/2026-09-04-ticket-workspace-orchestration-design.md
```

原因是设计文档只存在于主工作目录，尚未进入 P1 的基线 commit。

Child 因此正确地暂停并请求决策，但这应该在派发前由系统解决。

### 建议

实施工单必须引用一个不可变的 design provenance：

```text
design_ref = commit SHA + relative path
```

可选实现：

- 设计文档先独立提交，再以 commit 为 P1 base；
- 创建 P1 时自动复制已校验的设计 artifact；
- P1 brief 同时写入 design commit/path/hash；
- Child 启动前由 Coordinator 校验 design_ref 可读。

禁止只在 prompt 中写一个可能不存在的绝对路径。

---

## P1-4：Runtime 认证失败没有在 Child 启动前被健康检查拦截

Run #58 在执行期间才发现 Codex token 失效和 MCP 401。

这导致 Child 已经：

- 创建了 worktree；
- 启动了 runtime；
- 消耗了一段执行时间；
- 产生多个 stderr 错误；
- 创建了一个最终无效的 decision request。

### 建议

在 dispatch claim 前加入 runtime preflight：

```text
runtime executable available
→ runtime auth healthy
→ PLC MCP handshake healthy
→ workspace authority readable
→ claim/start Run
```

认证失败应直接生成明确的 infrastructure blocker，而不是先启动业务 Run。

对于 Codex/Claude/Pi，应分别验证：

- CLI 是否可执行；
- provider/model 是否可用；
- runtime session 是否可建立；
- PLC tool/MCP 是否可以调用 `get_ticket` 或 `submit_checkpoint`；
- token 失败是否可恢复。

---

## P1-5：设计 Run 没有独立 reviewer，验收边界依赖配置但用户不容易理解

#47 使用的是：

```text
verification_policy = lead_static
```

所以设计阶段完成后没有自动 reviewer。这在当前配置下是合法的，但用户界面只显示普通“验收通过”操作，没有明确解释：

```text
本次没有独立 reviewer，由用户/Lead 进行静态设计验收
```

### 建议

详情页清楚展示：

- 验收方式：Lead static / independent reviewer；
- 是否实际运行测试；
- 是否存在独立 verdict；
- 当前验收是设计验收还是实现验收。

对于 P1 数据模型实现，必须切换为独立 reviewer，并要求 reviewer 在隔离或只读 workspace 中核查。

---

## P1-6：Child/Run 停止后需要持续核验实际进程状态

本次停止后最终 daemon 的 `runningChildren` 清空，但停止过程的中间状态曾经出现：

```text
Run state = stopped
但 daemon status 仍显示 runningChildren
```

随后才完成清理。

### 建议

停止协议使用明确的中间状态：

```text
running → stopping → stopped
```

并且：

- stop 请求持久化；
- process termination 有确认或超时；
- live child registry 只有在进程确认退出后清理；
- 如果账本已 stopped 但进程仍在，必须显示红色 drift 警告；
- 不能在 stop 尚未完成时允许新的 Run 复用同一 workspace。

---

## P1-7：旧 stderr 噪声过多，影响用户判断

Run #58 的 runtime events 中反复出现：

```text
Failed to refresh token
Provided authentication token is expired
MCP HTTP 401
```

但此前 Run #57 也出现过 token refresh 错误，同时最终成功完成。这使用户很难判断：

- 这是可忽略的背景日志；
- 还是工具调用已经不可用；
- 还是整个 Run 已经不可继续。

### 建议

Runtime adapter 应将认证错误结构化：

```text
runtime.health = degraded / failed
error.category = authentication
error.retryable = false/true
error.scope = model | mcp | session
```

UI 不应只展示 stderr 文本，而应展示：

- 当前是否还能继续；
- 哪个能力失效；
- 是否已停止；
- 用户下一步要做什么。

---

## 4. Lead 与 Child 协作问题

## P1-8：Lead 创建 P1 时依赖 prompt 传递 workspace 规则

Lead 的 brief 中写了创建 worktree 的 shell 命令，但 P1 是否隔离主要仍依赖 Child 遵守 prompt。

这不符合设计中“关键不变量不能只放在提示词里”的原则。

### 建议

Lead 只负责选择：

```text
workspace_mode = shared | isolated
isolation_reason = ...
```

Coordinator 负责：

```text
resolve/provision/record/lease
```

Child 只接收：

```text
workspace facts + allowed operations
```

Child 不应自行决定：

- 使用哪个 base branch；
- 是否创建 worktree；
- workspace 是否可以复用；
- 是否能清理 workspace。

## P1-9：设计文档缺失时，Child 能正确请求决策，但停止后 decision request 处理方式需要统一

Child 发起了：

```text
补齐设计文档
或
使用工单正文作为替代依据
```

随后用户要求停止 Runtime，Lead 作废了该 decision request。这次结果正确，但应明确：

- request 是因为权限/输入缺失，还是 runtime 故障；
- 停止 Run 时 request 应为 `cancelled`、`expired` 还是 `dismissed`；
- 以后恢复同一 Run/workspace 时是否重新创建；
- decision request 是否需要保留原始上下文。

建议增加统一的 intervention 状态和原因：

```text
pending
→ resolved
→ cancelled_by_run_stop
→ expired
→ superseded
```

## P1-10：失败恢复时容易重复消耗模型资源

本次已经出现：

```text
Codex capacity failure
→ Claude handoff failure
→ Codex successful design
→ P1 Codex auth/MCP failure
```

系统虽然最终收敛，但用户体验上是连续多次失败，且每次失败都需要 Lead 重新理解上下文。

建议在每次恢复前展示一个明确的 recovery decision：

```text
失败类型：模型容量 / 交接缺失 / 认证失败 / 业务失败
推荐动作：等待 / 换模型 / 换 runtime / 修复 MCP / 用户决定
预计成本：未知 / 低 / 可能重复执行
```

不同故障不能只通过“再试一次”处理。

---

## 5. Companion 用户体验问题

## P1-11：“确认开跑”按钮语义错误

实际行为：

```text
点击“确认开跑”
→ draft → ready
→ 没有创建 Run
```

后续还需要单独点击“开始执行”。

建议改为：

```text
确认任务
```

或：

```text
确认并进入待开始
```

如果确实提供“一步确认并启动”，则必须让按钮同时完成 `draft → ready → active`，不能使用当前两阶段语义却沿用“确认开跑”。

## P1-12：工单详情历史分页出现 shared protocol 错误

#47 详情中出现：

```text
更早的进展读取失败：response does not match the shared protocol
```

当前 Checkpoint 仍能显示，但历史分页已经不是完整可用状态。

这尤其影响：

- P1/P2 实施工单审计；
- reviewer 查看历史 Run；
- 用户理解失败恢复；
- 读取旧版本协议数据。

建议：

- 给历史分页 API 增加明确的 protocol version；
- 对旧 DTO 做版本适配，而不是直接 fail closed 到用户不可理解的错误；
- UI 显示具体资源、版本和重试按钮；
- 记录失败请求的 resource/cursor，不要只显示通用异常。

## P1-13：当前 UI 没有把“设计验收”和“实现验收”明显区分

#47 完成的是设计文档，不是 worktree 功能实现。

但完成页主要展示：

```text
完成
验收通过
```

用户仍然需要阅读正文才能知道：

```text
worktree implementation = not implemented
```

建议增加：

```text
交付类型：设计
实现状态：未开始
后续动作：创建 P1 实施工单
```

## P1-14：#75 blocked 后的下一步信息还可以更明确

当前 UI 能显示 blocker，但用户仍需从详情和历史中拼出：

- token 已失效；
- MCP 也失效；
- worktree 已保留；
- 没有代码修改；
- 恢复前需要验证什么。

建议提供结构化 recovery card：

```text
当前状态：等待 Runtime 修复
影响：P1 尚未修改代码
保留现场：worktree path
恢复条件：Codex auth + PLC MCP handshake
允许动作：修复认证后继续
禁止动作：新建重复 P1 / 直接在主目录重跑
```

## P2-15：通知历史噪声需要折叠

#47 页面同时展示：

- Codex capacity failure；
- Claude handoff failure；
- 后续 Codex 成功；
- P1 auth blocker；
- 旧 #72/#51 系统通知。

建议默认显示：

```text
当前状态
当前阻塞
最近一次有效 Run
```

历史失败折叠到：

```text
历史尝试
```

不要让已经被后续 Run 覆盖的旧通知看起来仍然是当前 blocker。

---

## 6. 当前发现的测试和验收问题

## P1-16：真实浏览器流程目前不是仓库内可重复的自动化测试

本次使用 Chrome DevTools Protocol 手工完成了：

- 打开 `/tickets`；
- 打开 #47；
- 点击确认；
- 点击开始执行；
- 打开 #47 详情；
- 点击批准推荐方案；
- 点击验收通过；
- 发送 Lead 消息；
- 观察 #75。

但仓库自身没有对应的 screen-level/browser E2E 测试。

已有测试主要是：

- source-string tests；
- reducer/model tests；
- fixture DB tests；
- backend contract tests。

因此测试不会自动捕获：

- “确认开跑”文案错误；
- 历史分页协议错误；
- decision card 是否真实可点击；
- blocked recovery card 是否出现；
- 用户操作后 UI 是否刷新；
- 实际页面是否显示真实 Run/workspace。

建议增加一条最小真实流程：

```text
pair
→ open tickets
→ open #47
→ confirm
→ start
→ observe Run
→ review
→ approve decision
→ complete design
→ create P1
→ verify isolated workspace
→ stop on auth failure
→ verify blocked recovery state
```

## P1-17：验收必须同时检查 DB、Runtime 和 Git 三层事实

本次如果只看 Companion，会误以为：

```text
P1 正在使用 worktree
```

如果只看 DB，会误以为：

```text
P1 仍在主目录执行
```

只有交叉检查才发现：

- Child 手动创建了 worktree；
- DB 没有保存真实 workspace；
- 主目录没有修改；
- 隔离目录也没有修改；
- Run 被认证故障中止。

后续验收固定检查：

| 层 | 必查事实 |
|---|---|
| Companion | 用户看到的 stage、Run、blocker、按钮和下一步 |
| Ledger | item/run/checkpoint/decision/notification 的当前权威状态 |
| Runtime events | 实际工具调用、stderr、退出原因和顺序 |
| Git | 主目录、workspace、branch、HEAD、dirty diff |
| Filesystem | workspace 是否存在、是否被清理、是否与账本一致 |

---

## 7. 后续实施建议

### 阶段 0：先修运行条件，不重新派发 #75

在恢复 #75 之前：

1. 修复 Codex 登录和 refresh token；
2. 验证 Codex CLI 可以正常启动；
3. 验证 Codex 可以调用 PLC MCP；
4. 验证 `get_ticket` / `submit_checkpoint`；
5. 检查 P1 隔离 worktree 仍在且 branch/HEAD 正确；
6. 确认主工作目录没有被污染。

### 阶段 1：完成 #75，但必须先落 workspace 事实

P1 恢复时应从同一个隔离 worktree 继续，不重新创建重复目录。

开始修改前应确认：

```text
workspace path
workspace branch
workspace base_ref
workspace owner
Run.workspace_id 或等价 provenance
```

如果当前内核还不能记录这些字段，应先把 #75 降级为“验证/实现 workspace 数据模型”，不能假装 P1 已经满足设计。

### 阶段 2：P1 独立 reviewer

P1 完成后：

- 进入 `review`；
- 由独立 reviewer 检查 migration、schema、backfill 和 compatibility；
- reviewer 必须使用只读或 clean-room workspace；
- reviewer 不能修改 executor worktree；
- 验收必须检查实际 Git diff 和 DB migration。

### 阶段 3：再创建 P2

只有 #75 通过 reviewer 后，才创建和启动 P2：

```text
resolve/provision/release/cleanup
```

P2 不应在 P1 未通过时提前实现。

### 阶段 4：再进入 Companion

Companion 接入应在 control-plane DTO 稳定后进行，至少展示：

- workspace mode；
- workspace path；
- branch；
- base ref；
- current Run；
- workspace drift；
- cleanup/release state。

Companion 只展示和发起 authority action，不负责 workspace 状态判断和 Git 操作。

---

## 8. 当前验收结论

### #47

```text
设计阶段：通过
worktree 实现：未完成
```

### #75

```text
P1 实施：未开始
隔离 worktree：已由 Child 手动创建
内核 workspace 记录：未实现
当前状态：blocked
阻塞原因：Codex auth/token/MCP 401
代码修改：无
主工作目录污染：未发现
```

### 当前不得做的事

- 不要直接重新点击 #75 的“开始执行”；
- 不要新建重复的 P1 工单；
- 不要把 `items.workdir` 主目录字段当成真实 workspace 证据；
- 不要让 Child 继续依赖 prompt 自己创建 worktree；
- 不要在 Codex MCP 认证未验证前重试；
- 不要提前创建 P2–P7；
- 不要把 #47 的设计完成标记为 worktree 功能完成。

### 恢复条件

```text
Codex auth restored
+ PLC MCP handshake verified
+ existing isolated worktree verified
+ design provenance available in the worktree
+ workspace facts recorded in the ledger
```

满足以上条件后，才在原 #75 上恢复 P1 实施。

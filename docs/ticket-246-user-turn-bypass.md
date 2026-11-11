# 工单 #246 设计：用户本人发话的那一轮，Fairy 免沙箱、免确认（bypass 开关）

状态：定稿。用户 11-05 13:45 定了第 9 节的四点，可以按第 8 节开实施单。只有文档，没有实现代码。

> 2026-11-10 变更：开关不再有时限（用户：「把 bypass 的时间限制去掉，也做成和 steer 一样的开关就好，不要时间限制」）。打开时不选时长，打开以后一直开着，直到用户在设置页关掉，或者 Fairy 用 `disable` 关掉。5.2 改写了，5.1、5.3、5.4、5.5 里和时长有关的地方跟着改了。权限和生效范围不变。

本文里「Fairy」是用户给 Lead 起的名字。代码、路径、标识符里仍然叫 Lead。行号按 2026-11-05 的 master（88ea27ad）。

## 1. 背景和目标

现在 Fairy 的 bash 永远在沙箱里跑。沙箱外才能做的事（查钥匙串弹窗的日志、打 dmg、跑 clime 这类）要走 `run_on_host`，每条命令都弹一张确认卡，用户点一下才跑。用户 11-05 提议加一个像 Claude Code 的 bypass permission 那样的开关，让 Fairy 少弹卡。

用户 11-05 13:19 定了方向：不做全局放开。复用现有的「用户本人的一轮 / 外部的一轮」判断，改规则操作的权限判断用的就是这一套。

目标行为一句话：开关打开时，只在用户本人正在发话的那一轮里，Fairy 的 bash 在沙箱外跑，`run_on_host` 不弹卡。别的一轮一切照旧。五条底线不管开关都保留。

## 2. 现状

### 2.1 这一轮的来历（turn origin）怎么记

daemon 在每一轮开始时建一份 `LeadTurnOrigin`，Fairy 改不了（`packages/lead/src/turn-origin.ts:35-42`）：

| 字段 | 含义 | 在哪里写 |
| --- | --- | --- |
| `external` | 这一轮读进了外部来源的原文 | `apps/daemon/src/server.ts:3797-3799` 开轮时置初值；`server.ts:4873-4881` 交给这一轮的外部事件；`server.ts:3194-3196` 工具开始执行时 |
| `externalBy` | 带进外部内容的是哪些来源（消息、工具），只加不减 | `turn-origin.ts:109-115` `withExternalContent` |
| `timer` | 用户本人设的跟进到点、只为它开的一轮的 inbox 编号 | `server.ts:4889-4893` `userTimerOf` |
| `externalEvents` | 交给这一轮的外部事件编号 | `server.ts:4879` |

哪些工具的输出算外部内容由代码定，不由模型判断：`EXTERNAL_TEXT_TOOLS`（`turn-origin.ts:54-56`：读通道对话、通道文件、工单附件、连接工具）算；`INTERNAL_TEXT_TOOLS`（`turn-origin.ts:61-98`）不算，其中 `bash`、`edit`、`write`、`codemode` 在第 79 行，`run_on_host` 在第 84 行；没有声明的工具按外部内容算（`turn-origin.ts:101-103`）。

### 2.2 用户本人的一轮怎么认

两层：

1. 凭哪一轮代用户做：`authorityTurnId`（`turn-origin.ts:213-218`）。先取 daemon 给的当前轮次编号（`server.ts:2745`：正在插话的那一轮，或者当前的 channel turn），没有时取 `timer:<编号>`。
2. 这一轮是不是用户本人正在说话：`isLiveUserTurn`（`packages/engine/src/ui-actions/authority.ts:74-80`）。它调 store 的 `activePairedUserTurn`（`packages/store/src/user-turn-authority.ts:81-119`）核对：`channel_turns` 里有这一行、`origin_kind` 以 `paired:` 开头、状态是 queued 或 streaming、来自的凭证还有效、凭证带着这个操作要的 scope。`timer:` 开头的一轮（`user-turn-authority.ts:25`、`34-67`）返回 `origin_kind = paired:timer`，`isLiveUserTurn` 把它排除（`authority.ts:68`、`76`）。

`paired:*` 的轮次由网关在认证过的配对连接上建（`server.ts:1244`、`1277`：`paired:${command.bindingKind}`）。Slack 里用户给自己发的 DM 也建成这种轮次，凭证 kind 是 `companion`、origin 是 `channel_owner`（2026-10-30 定，用户要它和 Companion 权限一致）。

### 2.3 用户本人的一轮读过外部内容以后，改规则现在怎么算

现状分三档，都在代码里：

| 档 | 规则 | 代码 |
| --- | --- | --- |
| 放开 | 改规则的操作（授权表、常设指令、连接配置、设置页选项）和外部底线的操作（批 child 的审批、替用户答决定）：外部的一轮拒绝，但用户本人正在说话的一轮不受限 | `engine/src/ui-actions/index.ts:150-157` `ruleCeilingOf`；`turn-origin.ts:130-135` `ruleChangeRefusal` |
| 收紧 | 写进 Fairy 系统提示词的设置（名字、人格、风格、外观、代回复风格）：读过外部内容的一轮一律拒绝，用户本人的一轮也一样 | `index.ts:155` `promptSetting`；`engine/src/ui-actions/reply-style.ts:40-42` |
| 收紧 | 常驻核心记忆（profile、preference 笔记）：读过外部内容的一轮不能写 | `turn-origin.ts:319-331` `coreMemoryRefusal` |
| 收紧 | 标了 `externalRefusalNext` 而没标 `liveUserTurnExempt` 的操作：只拒绝、不带确认卡，用户本人的一轮也一样 | `index.ts:155`；`engine/src/ui-actions/types.ts:369-372` |

动手工具（bash、edit、write）现在更松：只有外部消息叫醒的一轮不能用（`packages/lead/src/hands.ts:76-81` `handsBlockedInTurn`）。用户本人的一轮读过外部内容以后照常用，因为命令在沙箱里，沙箱是边界（`hands.ts:9-12`、`147-152`；提示词 `packages/lead/src/prompt.ts:85`）。

### 2.4 Fairy 的 bash 沙箱怎么起

1. `leadHandsExtension`（`hands.ts:118-163`）把 pi 内置的 bash 换成沙箱版：`createBashToolDefinition(scratch, { operations: sandboxedBashOperations(...) })`（`hands.ts:124-126`），工作目录是数据目录下的 `lead-scratch`（`hands.ts:30-32`）。
2. 边界由 core 的 `sandboxPolicy` 算（`packages/core/src/sandbox-policy.ts:310-340`）：能写整个 home 加隔离 worktree，挡住会在沙箱外执行的位置（`SANDBOX_DENY_WRITE_HOME`，`sandbox-policy.ts:66-76`）、plc 的账本和密钥（`DATA_DIR_ALWAYS_DENY_WRITE`，`sandbox-policy.ts:80-82`）；不能读私钥、钥匙串、plc 的配置和凭证（`SANDBOX_DENY_READ_HOME` `54-56`，`DATA_DIR_DENY_READ` `60`）。Fairy 的角色是 `lead`，不能开本机端口（`sandbox-policy.ts:335`）。
3. 每条命令由 `@anthropic-ai/sandbox-runtime` 包一层（macOS 是 sandbox-exec）再 spawn（`packages/engine/src/sandbox/bash.ts:65-108`，包装在 `75-77`，spawn 在 `79-81`）。环境变量里名字像密钥的先去掉（`sandboxEnv`，`sandbox-policy.ts:348`）。沙箱起不来时命令不跑（`bash.ts:70-73`）。
4. `tool_call` 钩子（`hands.ts:144-161`）在每次调用前判断：外部消息叫醒的一轮拒绝；edit、write 的路径还要过 `leadWriteRefusal`（`hands.ts:84-90`）。
5. 命令输出经 credential-guard 脱敏（`packages/lead/src/credential-guard.ts:21`：bash 在 `FULLY_SCRUBBED_TOOLS` 里）。
6. 同一套沙箱 bash 还给控件的数据源和命令检查用（`server.ts:5155`；`hands.ts:63-70`）。

### 2.5 run_on_host 的确认卡怎么生成、怎么执行

1. 工具 `run_on_host`（`packages/lead/src/tools.ts:3086-3111`）不跑命令。它校验参数（`hostCommandInputOf`，`packages/engine/src/ui-actions/host-commands.ts:31-47`：命令不超过 400 字，cwd 绝对路径，时限 1 到 1800 秒），然后调 `authorizationCardResult`（`turn-origin.ts:179-206`）。
2. `authorizationCardResult` 调 engine 的 `requestRuleChangeConfirmation`，把这一个操作（工具名、参数原样）存成事件 `rule_change.requested`（对象键 `rule_change:<编号>`，`packages/protocol/src/rule-change-confirmations.ts:98-129`），24 小时作废（`protocol/.../rule-change-confirmations.ts:27`）。工具返回 `isError` 的结果，里面带 `user_action`，Fairy 用 `render_ui` 发成确认卡。
3. 用户点「确认这一次」是操作层的 `rule_change.resolve`，权限 `user_direct`（`engine/src/ui-actions/rule-change-confirmations.ts:430-455`，第 434 行）。它要求在配对过的设备上点，并核对设备凭证有这个操作的 scope（`rule-change-confirmations.ts:384-391`）。先写 `rule_change.resolved`（`397-402`），再执行存下的操作，再写 `rule_change.executed`（`417-424`）。
4. 存下的 `run_on_host` 由 `LEAD_TOOL_OPERATIONS.run_on_host`（`rule-change-confirmations.ts:247-253`）执行：`runHostCommand`（`host-commands.ts:57-108`）用 `/bin/zsh -lc` 跑，环境是 daemon 的 `process.env`（`69-71`），输出用已知密钥的值和像密钥的字符串脱敏后写进 `lead-scratch/host-commands/<编号>.log`（`99-100`）。结果写一条 inbox 叫醒 Fairy（`rule-change-confirmations.ts:363-375`）。

### 2.6 执行者（child）的审批现在怎么判

`approval.resolve`（`engine/src/ui-actions/catalog.ts:213-237`）：权限 `user_only`，Fairy 在任何一轮都可以自己判断批不批（用户 2026-10-28：「不要啥都让我审批」）。只有一条底线：读过外部内容的一轮里不能替用户批（`externalTurnFloor`，`catalog.ts:221`；用户本人正在说话的一轮例外，`index.ts:150-157`）。child 不能借 Fairy 批准自己：这一轮的凭证要有 `approvals:respond`（`index.ts:132-140`）。

审批行记着是哪次执行要的（`approvals.run_id`，`packages/store/src/schema.ts:1451`）。外部消息派出去的执行由派单器建（`apps/daemon/src/agent-tasks.ts:269-288`）：工单 `created_by` 是 `system`、`purpose` 是 `lookup`，并在同一笔事务里记一条 `decision` 活动，`payload.decision` 是 `agent_task_started`（`AGENT_TASK_STARTED`，`agent-tasks.ts:32`），里面有来源（`source`，例如 slack）、发起人和通道卡（`ref: card:<编号>`）（`agent-tasks.ts:278-286`）。权限清单 `run_grants`（`schema.ts:1030-1041`）不能当成外部的标志：用户本人要的 PR 评审也有一份（`packages/engine/src/children/pr-review-grant.ts:1-8`、`57`）。

## 3. 目标行为：按叫醒这一轮的来源分

### 3.1 规则表

「免沙箱」指：bash 在沙箱外跑，`run_on_host` 直接跑、不弹卡。「照旧」指第 2 节的现状。

| 叫醒这一轮的来源 | 代码里怎么认 | 开关关着 | 开关开着 |
| --- | --- | --- | --- |
| 用户本人在 Companion 或 plc 里发话 | `isLiveUserTurn` 为 true，且这一轮没有外部内容（`externalContentOf` 为 null） | 照旧（沙箱） | 免沙箱 |
| 用户本人发话，但这一轮已经读过外部内容 | `isLiveUserTurn` 为 true，`externalContentOf` 不为 null | 照旧 | 照旧（见 3.2） |
| 用户给自己发的 Slack DM | `isLiveUserTurn` 为 true，凭证 origin 是 `channel_owner` | 照旧 | 免沙箱（已定，见 3.3） |
| 用户本人设的跟进到点 | `authorityTurnId` 是 `timer:<编号>`，`isLiveUserTurn` 为 false | 照旧 | 照旧 |
| 外部消息（Slack 等别人发的话） | `origin.external` 且 `externalEvents` 非空 | 拒绝动手工具（`hands.ts:76-81`） | 照旧 |
| 定时器、提醒、心跳巡检、通知 | `options.system`（`server.ts:3796`），没有 channel turn | 沙箱 | 照旧 |
| 子 agent 或执行者的结果交回 | 系统回合，交来的事件不算外部 | 沙箱 | 照旧 |
| 摘要（compaction）叫醒 | 系统回合 | 沙箱 | 照旧 |
| aish 发来的 | `withExternalContent(…, { via: "message", source: "aish" })`（`server.ts:3797-3799`） | 沙箱 | 照旧 |

判断在一处算：新增 `hostBypassActive(db, deps, now)`（放 `packages/lead/src/turn-origin.ts`，和 `ruleChangeRefusal` 并排）。它返回「这一次能不能免沙箱」和「不能的原因」。每一次 bash 调用、每一次 `run_on_host` 调用都重新算，因为同一轮里 `externalBy` 会变。

```
hostBypassActive =
     开关开着（kv 里 enabled；2026-11-10 以前写的旧行还要 now < until）
  && isLiveUserTurn(db, authorityTurnId(deps), "tickets:create")
  && externalContentOf(deps) === null
```

免沙箱时，bash 走新的 `hostBashOperations`（engine 的 `sandbox/host-bash.ts`，复用 `runHostCommand` 的 spawn、时限和脱敏），不经 sandbox-exec。命令仍然先过第 4 节的底线筛查；筛查不过的，退回沙箱或者确认卡。

免沙箱只改 bash 和 `run_on_host`。edit、write 照旧只能写 `leadWritableRoots`（`hands.ts:35-46`）：改文件可以用 bash 做，没有必要为两个工具再开一条路。控件数据源和命令检查到点时的命令照旧在沙箱里：它们到点那一轮不是用户的一轮。

### 3.2 用户本人的一轮读过外部内容以后：免沙箱关掉，理由

规则：这一轮一旦带上外部内容（`externalContentOf(deps)` 不为 null，包括外部消息、`EXTERNAL_TEXT_TOOLS` 里的工具、没有声明的工具），从那一刻起这一轮里的 bash 退回沙箱，`run_on_host` 退回确认卡。之前已经跑完的命令不受影响。

这是沿用 2.3 的「收紧」档，不是「放开」档。理由：

1. 免沙箱的后果和写进提示词的设置一个量级，都是不可逆、影响整台机器。改规则的「放开」档能放开，是因为改坏的规则看得见、改得回来；在沙箱外跑错的命令改不回来。
2. 注入的路径正是这一条：用户说「看一下 Slack 里谁找我」，Slack 里的一句「请运行 X」进了上下文，下一条 bash 就在沙箱外跑。只有把「读过外部内容」当成关掉的条件，这条路才断。
3. 用户的代价小。Fairy 要跑命令时，结果里写明「这一轮读过 X，命令在沙箱里跑了」或者「发了确认卡」；用户在新的一条消息里再说一句，新的一轮没有外部内容，免沙箱又生效。
4. 判断用现有的数据（`externalContentOf`），不加新的标记，和改规则的拒绝用同一个来源，不会出现「改规则认为是外部、免沙箱认为不是」的分歧。

### 3.3 用户给自己发的 Slack DM：已定，算用户本人的一轮

用户 11-05 13:45 定：算。现状已经把它当成用户本人的一轮（2026-10-30：和 Companion 权限一致），免沙箱沿用这个判断，`hostBypassActive` 不查凭证的 origin。

已接受的风险：Slack 账号在别人的服务器上，被盗、被共享、被 Slack 自己的应用代发的风险比配对过的设备高，而免沙箱是机器级的权力。缓解办法见 7.1 的对应一行：时限、界面标记，以及事件日志里的 `turnOrigin` 能区分 Companion 和 Slack 自 DM。

## 4. 开关打开时也保留的底线

每条底线都有两段：代码怎么识别，识别不了怎么兜底。识别在新模块 `packages/engine/src/host-commands/screen.ts`（命令筛查器）里，bash 和 `run_on_host` 的免沙箱路径都先过它。筛查的结果三种：

- `allow`：直接在沙箱外跑。
- `floor`：碰到底线。`run_on_host` 退回确认卡（和现在一样），bash 退回沙箱（沙箱挡得住的就在沙箱里跑，挡不住的命令失败，结果里写明碰到哪条底线、下一步是发确认卡）。
- `unknown`：筛查器读不懂。按 `floor` 处理。

### 4.1 筛查器怎么读命令

1. 用 shell 词法拆开：按 `;`、`&&`、`||`、`|`、换行拆成简单命令，每个简单命令取程序名和参数，去掉引号。
2. 这些写法让筛查器读不懂，直接返回 `unknown`：`$(…)` 和反引号；`eval`、`exec`、`source`、`.`；`xargs`；`bash -c`、`sh -c`、`zsh -c`、`python -c`、`node -e`、`osascript`；heredoc；`sudo`、`su`、`doas`；程序名本身来自变量。这些不是禁止，而是筛查器没有把握，退回今天的做法。
3. `bash <脚本>`、`sh <脚本>`、`zsh <脚本>`，脚本在 `lead-scratch` 下的：把脚本复制到 daemon 自己的临时目录，对副本逐行做同样的筛查，然后跑副本。复制是为了筛查和执行是同一份内容。脚本在别处的返回 `unknown`。
4. 路径参数先展开 `~`，相对路径按 cwd 解析，再解析符号链接（和 `sandbox-policy.ts:98` 的 `realPath` 一样）。
5. 重定向 `>`、`>>`、`tee` 的目标按写入处理。

### 4.2 底线清单

| 底线 | 识别 | 识别不了时的兜底 |
| --- | --- | --- |
| 读凭证和私钥，读写钥匙串 | 程序名是 `security`、`ssh-add`、`ssh-keygen`、`gpg`、`plc`；任何路径参数落在 `~/Library/Keychains`、`credentialPathReason`（`credential-guard.ts:143`）认得的凭证文件和目录（清单在 `credential-guard.ts:24-38`，文件名的判断是 `credentialFileName`，`73-80`）、`DATA_DIR_DENY_READ`（`sandbox-policy.ts:60`）；程序是 `env`、`printenv`、`export`、`set`、`declare` 且没有参数（会整份打印登录 shell 的变量） | 像 `gh auth token`、`gcloud auth print-access-token` 这类把凭证打到标准输出的命令列不全。兜底是输出脱敏：沿用 `runHostCommand` 的 `redactKnownValues` 加 `redactSecretText`（`host-commands.ts:99`）和 credential-guard 对 bash 输出的 `redactTokenLikeRuns`（`credential-guard.ts:10-11`）。凭证可能被命令用，但不进对话和会话记录 |
| 直接写 plc.db 和 config.json | 任何路径参数落在数据目录下的 `DATA_DIR_ALWAYS_DENY_WRITE`（`plc.db`、`plc.db-wal`、`plc.db-shm`、`config.json`、`cli-credential.json`、`connections.key`、`shell-pairing.key`、`agent/`、`backups/`，`sandbox-policy.ts:80-82`）。例外：`sqlite3 -readonly <plc.db>` 放行，没有 `-readonly` 的 `sqlite3` 碰 plc.db 算底线 | 用别的程序打开数据库（python 的 sqlite3 模块、`cp` 覆盖）靠路径匹配也认得出。路径不在参数里（写进脚本再执行）的走 4.1 第 3 条。这两个文件在沙箱里本来就不能写，退回沙箱以后仍然挡着 |
| 删除工作目录和数据目录以外的东西 | 程序名是 `rm`、`rmdir`、`unlink`、`shred`、`trash`、`git clean`、`find … -delete`、`rsync --delete`：每个路径参数都要在允许的根下面：`leadWritableRoots`（`lead-scratch` 加隔离 worktree，`hands.ts:35-46`）加上工单的 `workdir`。有一个不在，就是底线。带通配的路径按它的目录部分判断 | `mv X /dev/null`、`> 文件` 这类清空也算删除，筛查器只认得重定向；用 python、node 删文件认不出来。兜底：这是接受的缺口，靠事件日志（5.5）事后看到。用户要收紧时，可以把这些程序也加进 4.1 第 2 条 |
| 改 launchd 和 ~/Library/LaunchAgents | 程序名是 `launchctl`；任何路径参数落在 `~/Library/LaunchAgents`、`/Library/LaunchAgents`、`/Library/LaunchDaemons`、`/System/Library/LaunchAgents`、`/System/Library/LaunchDaemons`。读（`cat`、`ls`）也算：这条底线按用户的原话整个目录都保留 | 用 `defaults write` 改别的自启动项、用 `osascript` 改登录项认不出来。`osascript` 已经在 4.1 第 2 条里退回。`defaults` 加进程序名清单 |
| 花钱的操作 | 程序名加子命令在一份清单里：`gcloud … create`、`aws … run-instances`、`aws … create-*`、`az … create`、`terraform apply`、`pulumi up`、`fly deploy`、`vercel deploy`、`heroku create`、`doctl … create`；`curl`、`wget`、`http` 的目标主机在已知的付费 API 清单里（`api.openai.com`、`api.anthropic.com`、`openrouter.ai`，和 `SANDBOX_SECRET_HOSTS` 的键同源，`sandbox-policy.ts:40-50`） | 花钱靠命令文本认不全，这是五条里最弱的一条。兜底两层：（1）`bash` 和 `run_on_host` 加一个参数 `spends_money`，提示词要求 Fairy 认为会花钱时填 true，填了就按底线走（模型自报，弱但有用）；（2）事件日志里每条命令都有，用户事后能查。清单放在筛查器里，随时加 |

四条附加的保守规则，用户 11-05 13:45 定全部采纳，和五条底线一起生效：

1. `sudo`、`su`、`doas`：退回确认卡（4.1 第 2 条）。
2. 写 `SANDBOX_DENY_WRITE_HOME`（`sandbox-policy.ts:66-76`）里的位置（shell 启动文件、`.gitconfig`、`.claude`、`.pi` 这些）：底线。理由和沙箱一样，写进去就等于以后每条命令都在沙箱外、不经筛查。
3. `plc` 命令：底线。Fairy 对工单系统的每个操作都有自己的工具，用 CLI 等于拿用户的凭证绕过操作层的权限判断。
4. 命令超过 `HOST_COMMAND_LIMITS.command` 的 400 字（`host-commands.ts:13-15`）：写成 `lead-scratch` 里的脚本再跑（4.1 第 3 条），和现在的 `run_on_host` 一样。

## 5. 开关

### 5.1 在哪里打开，谁能打开

- 存储：kv 一行 `lead.host-bypass`，照 `packages/store/src/design-preferences.ts:12-17` 的写法。内容：`{ enabled, bindingId, enabledAt, reason }`（2026-11-10 以前还有 `until`）。不放 config.json：Fairy 本来就写不了 config.json，而且 kv 的改动能走操作层记账。
- 操作层：新目标 `host_bypass`（`packages/engine/src/ui-actions/host-bypass.ts`，形状照 `reply-style.ts:37-60`），两个操作：
  - `enable`：`permission: "user_direct"`，`changesRules: true`。输入是 `{}`，不带时长（2026-11-10 以前是 `minutes`）。
  - `disable`：`permission: "lead_allowed"`，`changesRules: false`。Fairy 和用户都能关。
- 页面入口：设置 → Lead → 新的一节「用户本人发话时免沙箱」，在 `apps/companion/src/features/settings/LeadProfileSection.tsx` 旁边加 `HostBypassSection.tsx`，文案放 `hostBypass.messages.ts`（`docs/i18n.md`）。网关路由 `packages/gateway/src/host-bypass-routes.ts`，照 `reply-style-routes.ts`。
- Fairy 入口：`perform_action` 调同一个定义。`enable` 是 `user_direct`，Fairy 调它得到结构化的拒绝，拒绝里写「请用户在 设置 → Lead → 用户本人发话时免沙箱 里打开」。Fairy 不发「要不要打开？」这样的卡：开关授予 Fairy 权力，按 AGENTS.md 的 UI Actions 只能用户自己点。
- 会话里不加打开的入口。关闭的入口在 5.3 的标记上。

### 5.2 时限（2026-11-10 去掉）

2026-11-10 起没有时限。开关和「Fairy 忙时你发的消息」一样是一个普通的设置：

- 打开以后一直开着，直到用户在设置页关掉，或者 Fairy 用 `host_bypass.disable` 关掉。
- 没有到点的定时器，不再写 `host_bypass.expired`。这个事件种类留着注册，事件表里的旧记录照旧能读。
- 已经开着时再打开一次什么也不写。
- 旧行：11-05 到 11-10 的版本打开时选 15–240 分钟，kv 里多存一个 `until`。读这种行时，过了 `until` 的按关算；没过的照旧开到 `until` 为止，因为用户当时只同意了那么久。daemon 启动时不改这种行，也不补写事件。用户再打开一次，新写的行就没有 `until`。

原来的规则（11-05 定，已经不用）：打开时选时长，档位 15、30、60、120、240 分钟，缺省 30，最长 4 小时；到点自动关，daemon 排定时器置关并写 `host_bypass.expired`；到点前再打开一次按新的时长从现在重算。

### 5.3 打开期间界面上的标记

- 位置：主对话输入框上方的状态栏（`LeadConversation.tsx:437-451`，和 `InterruptBanner`、`LeadQueueBar` 同一区域）。文字：「免沙箱 · 开着 · 关闭」（2026-11-10 以前写剩余时间）。「关闭」调 `host_bypass.disable`。
- 这一行由系统画（P8.1），颜色用「等你」的琥珀（`docs/design/themes/default.md`），不另发明样式。要在主题文件里加一条「模式标记」的规则：持续状态用状态栏一行，收起态不变高（P1.3）。
- 设置页同一节显示同样的状态（2026-11-10 起和「Fairy 忙时你发的消息」同一种单选卡，没有倒计时，见主题 11.17）。
- Fairy 每条在沙箱外跑的命令，工具结果开头写「（沙箱外）」，会话里的工具行（`ToolCallRow.tsx`）据此加同一个琥珀小标。
- plc CLI 的 `status` 输出加一行。

### 5.4 Fairy 怎么知道开关的状态

- `get_environment` 的结果里加 `hostBypass: { enabled }`（2026-11-10 以前还有 `until`）。
- 开、关各写一条 inbox 叫醒 Fairy（`wakeLead: true`），内容一句话。Fairy 自己关的不叫醒它。
- bash 和 `run_on_host` 的工具说明不改；工具结果里写明这次是在沙箱里还是沙箱外、为什么。

### 5.5 事件日志格式

新的事件种类，在 `packages/protocol/src/host-commands.ts` 里登记（照 `rule-change-confirmations.ts:113-129` 的 `registerEventKind` 写法），对象键 `host_command:<编号>`：

| 事件 | 什么时候写 | payload |
| --- | --- | --- |
| `host_command.started` | spawn 之前，同一笔事务 | `id`、`turnId`、`turnOrigin`（`live_user_companion`、`live_user_plc`、`live_user_slack_self_dm`、`confirmed_card`；按这一轮凭证的 kind 和 origin 写，Slack 自 DM 是 origin `channel_owner`）、`via`（`bash`、`run_on_host`）、`confirmationId`（走确认卡时）、`command`（脱敏，最多 400 字）、`cwd`、`timeoutSeconds`、`screen`（`allow` 和命中的规则名）、`spendsMoney` |
| `host_command.finished` | 进程结束后 | `id`、`exitCode`、`timedOut`、`durationMs`、`outputPath`、`outputBytes`、`truncated` |
| `host_bypass.enabled` | 用户打开 | `bindingId`、`resolvedBy`（2026-11-10 以前还有 `until`、`minutes`） |
| `host_bypass.disabled` | 用户或 Fairy 关 | `by`（`user`、`lead`）、`turnId`、`reason` |
| `host_bypass.expired` | 到点（2026-11-10 起不再产生） | `until` |

现在走确认卡的 `run_on_host` 也写 `host_command.*`，这样「所有在沙箱外跑过的命令」一条查询就能列出来；`rule_change.executed` 照旧写，不删。`started` 和 `finished` 分开写，daemon 中途崩溃时至少留着「开始跑了」。Fairy 的 `query_events` 能读到它们。

## 6. 执行者（child）的审批

规则：起因是外部内容的执行，它要的审批 Fairy 不能直接放行，要转给用户。其余维持 2.6 的现状。

- 识别：审批的 `item_id` 对应的工单上有一条 `decision` 活动，`payload.decision = agent_task_started`（2.6）。新增 store 的 `externalTaskOriginOf(db, itemId)`，返回这条活动里的 `source`、`requester`、`ref`，没有时为 null。只认这条活动，不认 `run_grants`：用户本人要的 PR 评审也有清单，但它不是外部起因。
- 改动：`approval.resolve` 的 `permission`（`catalog.ts:217`）改成函数：`externalTaskOriginOf` 不为 null 的返回 `user_only` 并加 `userTurnOnly`；`available` 的提示写「这次执行是 <来源> 派的，要用户自己批」。为 null 的照旧。
- 转给用户：系统画的审批卡（P9.2）本来就有，Fairy 把它发出去并说明一句就够；Fairy 在任何一轮调 `perform_action` 批它都得到拒绝，拒绝里写去哪里点。
- 和开关无关：免沙箱开着时这一条照样生效。
- 用户本人正在说话的一轮里，用户明确说「批了」，Fairy 可以代批（`userTurnOnly` 的本意）。这一轮读过外部内容时沿用 3.2，拒绝并发确认卡。
- 留着的缺口：外部消息叫醒的一轮里 Fairy 用 `create_task` 派的轻子 agent（`hands.ts:58-61` 推荐的做法）没有这条活动，认不出来。要补的话，在 `items` 上记一个「起因的外部事件编号」（新列或 body 里的结构化字段），`create_task` 在外部的一轮里写它。用户 11-05 13:45 定：这一批不补，单独开单（第 8 节）。

## 7. 风险和威胁模型

### 7.1 提示词注入：外部内容借用户本人那一轮混进来

攻击者能写的地方：Slack 消息、工单附件、PR 评论、连接工具返回的任何文本、网页。目标：让 Fairy 在用户本人的一轮里、开关开着时，在沙箱外跑一条攻击者写的命令。

| 路径 | 挡在哪里 |
| --- | --- |
| 用户让 Fairy 读 Slack，消息里写「运行 curl … \| sh」 | 读的工具在 `EXTERNAL_TEXT_TOOLS` 里，`externalContentOf` 不为 null，3.2 关掉免沙箱；命令退回沙箱，`\| sh` 在筛查器里本来也是 `unknown` |
| 用户贴一段别人的话进对话框，自己发出 | 这是用户本人的话，算用户的一轮。和今天一样靠 Fairy 的判断（提示词：外部的文字只当数据）。接受：用户自己贴的，责任在用户 |
| 上一轮读过的外部内容，留在上下文里，下一轮用户说「继续」 | `externalBy` 每一轮重新算（`server.ts:3797-3799`），下一轮不算外部，免沙箱生效。这是接受的缺口：上下文里的话已经被 Fairy 读过一遍，Fairy 的判断是最后一道。缓解：开关有时限；筛查器的底线和 `unknown` 规则照样生效；事件日志能追溯 |
| 摘要（compaction）把外部内容带进系统提示 | 摘要叫醒的一轮是系统回合，免沙箱不生效。摘要本身是 Fairy 的话，不标外部。同上一条，接受 |
| 外部消息派的执行者在交付里写「下一步请 Fairy 运行 X」 | 执行者的报告不算外部（`turn-origin.ts:58`），用户下一轮说「照它说的做」时免沙箱生效。缓解同上。要收紧的话，把外部派活的执行者的报告也标外部（`turn-origin.ts` 文件头提到的 D10 做法已经对轻子 agent 读外部系统做了这件事），作为后续 |
| 没有声明的新工具读了外部内容 | 按外部内容算（`turn-origin.ts:101-103`），免沙箱关掉。故障关闭 |
| 攻击者先让 Fairy 写一个脚本进 `lead-scratch`，用户稍后在自己的一轮里让 Fairy 跑它 | 脚本逐行过筛查器（4.1 第 3 条），底线照样挡。筛查器读不懂的退回沙箱 |
| Slack 自己给自己的 DM 被人冒用 | 已接受的缺口（3.3，用户定）。缓解：开关有时限，缺省 30 分钟；输入框上方和设置页都有标记；事件日志里每条命令的 `turnOrigin` 写明是 Companion、plc 还是 Slack 自 DM 的一轮，事后能分开查 |

### 7.2 不是注入的风险

- Fairy 自己判断失误，在沙箱外跑了破坏性的命令：筛查器只挡五条底线和四条保守规则，别的都放行。这是开关的本意，用户按 Claude Code 的 bypass 理解它。缓解：时限、标记、事件日志。
- 命令在沙箱外能连本机端口和云元数据地址：沙箱的代理挡这两样（`bash.ts:5-6`），沙箱外没有。daemon 自己的 HTTP 和 socket 要凭证，凭证文件和 `plc` 命令是底线（4.2）。
- 免沙箱的命令用登录 shell 的环境变量，里面可能有密钥：和现在的 `run_on_host` 一样（`host-commands.ts:69-71`），输出脱敏是唯一的保护。不加 `sandboxEnv` 的过滤，因为 `zsh -l` 会重新加载用户的 profile，过滤没有效果。
- 筛查器和沙箱的清单各写一份，会漂：筛查器直接 import `sandbox-policy.ts` 的常量（`SANDBOX_DENY_WRITE_HOME`、`DATA_DIR_ALWAYS_DENY_WRITE`、`SANDBOX_DENY_READ_HOME`、`SANDBOX_SECRET_HOSTS`）和 credential-guard 的 `credentialPathReason`，只有程序名清单是自己的。

### 7.3 回滚

关掉开关（用户点、Fairy 关、到点、或者 daemon 重启发现过期）以后：

1. `hostBypassActive` 返回 false，bash 走原来的 `sandboxedBashOperations`，`run_on_host` 走原来的 `authorizationCardResult`。两条路径的代码不改，只在前面加一个分支。
2. 已经在跑的沙箱外命令跑完为止，不杀：杀一半比跑完更危险。标记在它结束前不消失，写「正在收尾」。
3. 筛查器只在免沙箱路径上调用，关掉以后不参与任何判断。
4. kv 里只剩 `enabled: false`。删掉这一行也等于关。
5. 代码层面的回滚：整个功能在一个 feature 分支上，去掉 `hostBypassActive` 的分支和设置页的一节，其余文件不动。事件种类登记留着，不影响旧数据。

验证「关掉以后和现在完全一样」的办法：实施单 A 的测试里，开关关着时跑现有的 `hands.test.ts`、`rule-change-confirm.test.ts`、`external-content-ceiling.test.ts` 全部通过，一条不改。

## 8. 实施拆分

五张实施单，可以单独验收。A 和 B 没有依赖；C 依赖 A、B；D 依赖 C；E 独立。第 6 节留着的缺口（外部的一轮里 `create_task` 派的轻子 agent 认不出外部起因）不在这五张里，用户 11-05 13:45 定单独开一张，等 E 验收以后再开。

### 实施单 A：开关的存储、操作层、页面和到点

要改的模块：

- `packages/store/src/host-bypass.ts`（新）：kv 的读写。
- `packages/protocol/src/host-bypass.ts`（新）：DTO、请求 schema、事件种类 `host_bypass.*`。
- `packages/engine/src/ui-actions/host-bypass.ts`（新）：目标和两个操作，登记进 `ui-actions/index.ts` 的清单。
- `packages/gateway/src/host-bypass-routes.ts`（新）：GET 状态、POST enable、POST disable。
- `apps/daemon/src/server.ts`：到点定时器、重启时清理、`snapshot.required`、inbox 通知、`get_environment` 加字段。
- `apps/companion/src/features/settings/HostBypassSection.tsx`、`hostBypass.messages.ts`（新）；`LeadConversation.tsx` 状态栏加标记；`docs/design/themes/default.md` 加「模式标记」规则。
- `packages/lead/src/ui-action-tools.ts`：`perform_action` 认得新目标。

验收标准：

1. 设置页能打开，时长只有 15、30、60、120、240 分钟五档，缺省选中 30；打开后看到倒计时；到点自动变成关。
2. Fairy 调 `enable` 得到 `user_direct` 的结构化拒绝，拒绝里写设置页的位置；Fairy 调 `disable` 成功。
3. 开、关、到点各有一条事件，字段照 5.5。
4. 开着时输入框上方有标记，有「关闭」按钮；关掉后标记消失，会话列表不跳。
5. daemon 重启时，`until` 已过的开关读出来是关。

测试方式：store 和 engine 的单元测试（`packages/engine/test/host-bypass.test.ts`，照 `rule-change-confirm.test.ts`）；网关路由测试；daemon 集成测试（`apps/daemon/test/host-bypass-daemon.test.ts`：开、到点、重启）；Companion 组件测试（`hostBypassSettings.test.tsx`、`conversationTopBar.test.tsx` 加一组）。

### 实施单 B：命令筛查器

要改的模块：

- `packages/engine/src/host-commands/screen.ts`（新）：词法拆分、`unknown` 规则、五条底线、四条保守规则、脚本副本。
- `packages/engine/src/host-commands/screen.messages.ts`（新）：拒绝原因的文案，中英文。
- `packages/core/src/sandbox-policy.ts`：把筛查器要用的常量 export（有的已经 export）。
- `packages/lead/src/credential-guard.ts`：`credentialPathReason` 已经 export，不改。

验收标准：

1. 五条底线各有正例和反例：`security find-generic-password`、`cat ~/.ssh/id_ed25519`、`sqlite3 plc.db "UPDATE …"`、`sqlite3 -readonly plc.db "SELECT …"`（放行）、`rm -rf ~/Documents/x`、`rm -rf <worktree>/node_modules`（放行）、`launchctl load …`、`cat ~/Library/LaunchAgents/x.plist`、`gcloud compute instances create …`、`curl https://api.openai.com/…`。
2. `unknown` 的每种写法各一例：`$(…)`、反引号、`eval`、`xargs`、`bash -c`、heredoc、`sudo`、`osascript`。
6. 四条保守规则各有正例：`sudo ls`、`echo x >> ~/.zshrc`、`plc status`、401 字的命令，都不是 `allow`。
3. `bash <lead-scratch 下的脚本>`：脚本里有底线时返回 `floor`，并指出是哪一行；脚本在别处时返回 `unknown`。
4. 路径的 `~`、相对路径、符号链接都解析后再比较。
5. 筛查器是纯函数：输入命令、cwd、允许的根、数据目录，输出结果和规则名；不读数据库，不跑命令。

测试方式：单元测试 `packages/engine/test/host-command-screen.test.ts`，表驱动，每条规则至少一正一反。

### 实施单 C：免沙箱的执行路径

要改的模块：

- `packages/lead/src/turn-origin.ts`：`hostBypassActive`。
- `packages/engine/src/sandbox/host-bash.ts`（新）：`hostBashOperations`，复用 `host-commands.ts` 的 spawn、时限、脱敏、落盘，写 `host_command.started` 和 `finished`。
- `packages/lead/src/hands.ts`：bash 的 `operations` 按每次调用选沙箱或主机；`tool_call` 钩子里先调筛查器；工具结果开头写「（沙箱外）」或退回的原因。
- `packages/lead/src/tools.ts` 的 `run_on_host`：免沙箱生效且筛查 `allow` 时直接跑并返回结果；否则照旧发卡。两个工具加 `spends_money` 参数。
- `packages/engine/src/ui-actions/rule-change-confirmations.ts` 的 `run_on_host`：也写 `host_command.*` 事件。
- `packages/lead/src/prompt.ts`：第 103-107 行的能力缺口一段加一句：开关开着、而且是用户本人的一轮时，命令直接在沙箱外跑；读过外部内容以后退回沙箱；认为会花钱时填 `spends_money`。
- `apps/daemon/src/server.ts`：把 `hostBypassActive` 要的依赖（`currentTurnId`、`turnOrigin`、db）传给 hands 和 tools，现在已经传了一部分（`hands.ts:105-115`）。

验收标准：

1. 开关开着、用户本人的一轮、没有外部内容：bash 不经 sandbox-exec（测试里断言 `wrapWithSandboxArgv` 没被调），`run_on_host` 直接返回退出码，不发卡。
2. 同一轮里调过 `read_channel_conversation` 以后，下一条 bash 回到沙箱，`run_on_host` 发卡，结果里写明原因。
3. 外部消息叫醒的一轮、定时器的一轮、`timer:` 的一轮、系统回合：开关开着也和现在一样。用户给自己发的 Slack DM 开的一轮：和 Companion 一样免沙箱。
4. 筛查器返回 `floor` 或 `unknown` 时，bash 退回沙箱，`run_on_host` 发卡。
5. 每条沙箱外的命令都有 `host_command.started` 和 `finished`，字段照 5.5，命令文本已脱敏；`turnOrigin` 在 Companion、plc、Slack 自 DM 三种一轮里分别是三个值。
6. 开关关着时，现有的 `hands.test.ts`、`rule-change-confirm.test.ts`、`external-content-ceiling.test.ts`、`rule-change-confirm-daemon.test.ts`、`external-content-ceiling-daemon.test.ts` 不改一行、全部通过。

测试方式：`packages/lead/test/hands.test.ts` 和 `turn-origin.test.ts` 加用例；`packages/engine/test/host-bash.test.ts`（新）；daemon 集成测试 `apps/daemon/test/host-bypass-daemon.test.ts` 加「用户发话、读 Slack、再发话」三步的用例。

### 实施单 D：威胁模型的回归测试和文档

要改的模块：

- `apps/daemon/test/host-bypass-injection-daemon.test.ts`（新）：7.1 的表每一行一个用例。
- `docs/ticket-246-user-turn-bypass.md`：把实施后的实际行为和行号更新进来；AGENTS.md 的 UI Actions 一节加一段。
- `packages/lead/src/prompt.ts`：按实测结果微调文案。

验收标准：

1. 7.1 的每条路径有一个测试，断言命令在哪里跑（沙箱、主机、没跑）。
2. 回滚：关掉开关后同一组用例的结果和开关从没打开过一样。
3. AGENTS.md 写明开关的名字、`user_direct`、五条底线。

测试方式：daemon 集成测试；文档改动不跑测试。

### 实施单 E：执行者审批按起因分

要改的模块：

- `packages/store/src/agent-task-origin.ts`（新）：`externalTaskOriginOf`，读 `activities` 里的 `agent_task_started`。`AGENT_TASK_STARTED` 常量从 `apps/daemon/src/agent-tasks.ts:32` 搬到 protocol，daemon 和 store 共用。
- `packages/engine/src/ui-actions/catalog.ts` 的 `approval.resolve`：`permission` 改成函数，调 `externalTaskOriginOf`。
- `packages/engine/src/coordinator/interventions.ts` 的 `resolveApproval`：同样的判断再查一次（和 runtime-settings 的做法一样，不只认操作层）。
- 审批卡的文案（`apps/companion/src/features/chat/intervention.messages.ts`）加一句「外部消息派的执行，要你自己批」。

验收标准：

1. 外部消息派出的执行要的审批：Fairy 在系统回合调 `perform_action` 批，得到拒绝，拒绝写明去哪里点。
2. 同一张审批，用户在审批卡上批，成功。
3. 用户或 Fairy 自己建的工单要的审批，包括用户本人要的 PR 评审（有 `run_grants`、没有 `agent_task_started`）：Fairy 照旧能批。
4. 用户本人正在说话的一轮里说「批了」，Fairy 代批成功；这一轮读过外部内容时拒绝并带确认卡。

测试方式：`packages/engine/test/channel-authority.test.ts` 加用例；`apps/daemon/test/approval-authority-daemon.test.ts` 加用例。

## 9. 已定事项

用户 11-05 13:45 定了下面四点，文档已经按它们改成定稿：

1. 用户自己给自己发的 Slack DM 算用户本人的一轮，开关开着时免沙箱（3.1、3.2、3.3）。风险按已接受的缺口记在 7.1。
2. 四条保守规则（`sudo`、写沙箱外会执行的位置、`plc` 命令、400 字上限）全部采纳（4.2）。
3. 时限档位 15、30、60、120、240 分钟，缺省 30，上限 4 小时（5.2）。
4. 实施单 E 的缺口（外部的一轮里 `create_task` 派的轻子 agent）这一批不补，单独开单（第 6 节、第 8 节）。

## 10. 后续改动（2026-11-11）

用户 11-11 说：「我不是给你设置了 bypass 吗，如果 bypass 都还要我审批，那 bypass 有啥意义呢」「推个 PR 都这么谨慎的吗」。下面三点改了第 3、4 节的规则：

1. 用户让 Fairy 设的跟进到点、只为它开的一轮，免沙箱和用户本人发话的一轮一样生效（`turn-origin.ts` 的 `hostBypassActive`）。`host_command.started` 记设它那一轮的凭证来源（`live_user_*`），`turnId` 是 `timer:<编号>`。Fairy 自己设的跟进、读过外部内容的一轮照旧不生效。改规则仍然不认跟进到点的一轮。
2. 筛查器不再一律拒绝 `$(…)`。里面的每条命令按同样的规则筛查，它的值按不知道算。不知道的值只在这些地方放行：`echo`、`printf`；`git` 的一组只读或者只改仓库的子命令（读写文件的选项除外）；`gh` 的说明文字类选项和 `pr`、`issue`、`run` 的编号。`git` 和 `gh` 的不知道的值要在双引号里。heredoc 只给把正文当数据读的程序（`cat`、`git`、`gh` 等）。
3. 400 字上限只管要发卡的命令。直接跑的命令上限是 `HOST_COMMAND_LIMITS.screenedCommand`（20000 字）。

同一天 13:35 用户又说：「当然要免 bypass 啊，而且先前的任务也不是我设置的跟进吧」。所以第 1 点扩大到系统事件叫醒的一轮：

4. daemon 发起的系统回合（执行或核查结束、后台检查有结果、Fairy 自己设的跟进到点、命令结果回来这类）也免沙箱。daemon 给这一轮记 `wokenBy`：发起它的系统来源和交给它的事件 kind（`server.ts` 的 `runTurnNow`）。`host_command.started` 写 `turnOrigin: "system_event"` 和 `wokenBy`，`turnId` 为 null，不冒充用户。
5. 照旧不免沙箱：外部消息叫醒的一轮、和外部消息混在一起的一轮、读过外部内容（连接结果、通道对话、通道文件）以后的命令。没有 `wokenBy`、也不是用户的一轮时，来源认不出来，也不免沙箱。改规则仍然只认用户本人正在说话的一轮。

同一天 13:38 和 13:42 用户又定了一条通用规则，取代上面第 5 点里「读过外部内容以后不免沙箱」：

6. 开着免沙箱时，一条命令能不能在沙箱外直接跑，只看命令本身，不管这一轮是谁叫醒的、读没读过外部内容。筛查器（`screen.ts` 的 `tierTwoHit`）按形状分两档，不认任何平台，也不按 Lead 的工具名分类：
   - 第一档直接跑：只读命令、查询、普通推送、在仓库里提交、强推功能分支、只写工作目录和临时目录。
   - 第二档要确认（结果 `confirm`）：删除（lead-scratch 和临时目录里的除外）、丢掉没有提交的改动、强推或删除默认分支和没写分支的强推、推到没配置过的远端或者改远端地址、改系统或全局配置和装卸软件、跑筛查器读不到的代码（脚本文件、包管理器的脚本、用路径跑的程序）、写到工作目录和临时目录以外、把本机文件发出去。底线和读不懂的规则照旧。
   - 外部内容防注入靠第二档：第二档在哪一轮都要确认。`host_command.started` 照旧写这一轮的来历，带着外部内容时另外写 `externalContent`；既不是用户的一轮、也没有系统标记的一轮写 `unattributed`。
   - 改规则仍然只认用户本人正在说话的一轮。外部消息叫醒的一轮里 Fairy 不用 bash、edit、write（D8）这一条没有改。

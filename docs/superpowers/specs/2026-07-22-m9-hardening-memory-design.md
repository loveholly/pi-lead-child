# M9 方案设计：部署硬化 + daemon 生命周期技术债 + 记忆层（无 embedding）

> 承接 DESIGN-GATEWAY.md §7（Gap 4/6 低垂果实）。M1–M8 已完成并真机验收（120 单测）。
> 本期目标：让"随时随地"在本机成立（launchd 常驻不丢凭证）、消掉 daemon 重启的两个已知损失、
> 把记忆层从"LIKE 子串 + 0 行 notes"升级为 Hermes 式双层结构。
> 用户裁决：**embedding 本期明确不做**（未来作为检索层之后的第四层平滑追加，接口不变）。

## 0. 范围与裁决记录

| 决策点 | 裁决 |
|---|---|
| 部署范围 | 本期只做**本机 launchd**；无常开机器。构建产物可移植，未来迁移另议 |
| 凭证 | 配置文件优先（支持 `value` 直接给值 / `fromEnv` 间接引用环境变量名），未配置的 key 回退读同名环境变量 |
| recoverOrphans | 有限次自动重派（每工单 auto ≤1 次，判据持久化防崩溃循环 spawn 风暴） |
| 记忆分类 | 用户要求：除画像外还要 preferences、facts |
| 召回方案 | 参考 Hermes：常驻核心记忆（不走召回）+ FTS5 trigram 检索 + 先查再答纪律；**无 embedding** |
| cron 时区 | 切 daemon 本地时区，直接切不做存量迁移（个人系统） |

实施顺序：**B 部署硬化 → C 技术债 → A 记忆层**（C1 依赖 daemon 生命周期稳定；A 独立可并行但排最后）。

### 0.1 语言纪律（用户指令，2026-07-22 起全局生效）

**所有源代码必须是 TypeScript，不再新增任何 JS 源文件**（含测试与脚本）。唯一例外：`dist/` 构建产物
（esbuild 输出天然是 JS，属编译产物非源码）。存量迁移纳入本期（B1 顺手做）：
`test/fake-pi.mjs` → `test/fake-pi.ts`、`scripts/e2e-m4.mjs` / `e2e-m5.mjs` → `.ts`（运行方式改 tsx，
引用处同步更新）。迁移后仓库源码 100% TS。

## A. 记忆层（Hermes 双层映射）

Hermes 的三层分离："what I know"（精炼事实，有界常驻）/ "what happened"（原始历史，FTS 检索）/
"what I can do"（技能，不适用 plc）。两个关键机制照搬：**容量超限返回错误逼 agent 精炼**（非静默截断）；
**核心记忆会话内冻结**（plc 的刷新边界 = session 创建 + compaction_end，precipitate 已挂同点）。

### A1. notes.kind 分类

```sql
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
  CHECK (kind IN ('profile','preference','fact','note'));
```

- `profile`：用户画像（身份/角色/技术背景）。`preference`：工作偏好/沟通风格/既定约束。
- `fact`：用户相关的长期事实（环境、资源、关系）。`note`：工作沉淀结论（现状语义，默认值）。
- 老库就地迁移（同 M2.1 priority 迁移法：PRAGMA table_info 探测缺列则 ALTER）。
- `save_note` / `update_note` 工具加 `kind` 参数；工具描述写明分类语义。

### A2. 常驻核心记忆

- `loadCoreMemory(db)`：取 `kind IN ('profile','preference')` 全部 notes，格式化为
  `## 关于用户（长期记忆）` 文本块。
- 注入时机：lead session 创建时（prompt.ts 系统提示词尾部）+ 每次 `compaction_end` 重注入
  （followUp 注入，与 precipitate 重新武装同一个事件点）。会话中途不刷新（冻结语义）。
- 容量上限：profile+preference 总字符数上限 `PLC_CORE_MEMORY_CAP`（默认 4000）。
  超限时 `save_note`/`update_note`（目标 kind 为这两类时）**返回错误**：
  “核心记忆已满（X/4000），请先精炼合并现有条目”。

### A3. 检索层：LIKE → FTS5 trigram

- `notes_fts`：FTS5 external-content 表，`tokenize='trigram'`（CJK/英文子串匹配均可用；
  unicode61 对中文无效），同步靠 INSERT/UPDATE/DELETE triggers。
- `searchNotes()` 签名不变：FTS5 MATCH + bm25 排序；可选 `kind` 过滤参数。
  query 按 trigram 语义直接喂（≥3 字符）；<3 字符或 FTS 查询报错时降级 LIKE（兼容旧行为）。
- 建库时探测 FTS5 可用性（better-sqlite3 内置启用；万一不可用整体降级 LIKE，doctor 报告）。
- **不做 embedding**。未来加向量层时 searchNotes 内部换实现，调用方无感。

### A4. 沉淀提示词修订

`PRECIPITATE_PROMPT` 增加显式检查项：“用户画像/偏好有无新增或变化——有则以 kind='profile'/'preference'
保存或更新（更新优于新增重复条目）”。lead 提示词纪律新增：涉及用户个人信息、历史约定的问题
先 `search_notes` 再回答。

## B. 部署硬化（本机 launchd）

### B1. 构建

- esbuild 打包两个入口：`dist/coordinatord.mjs`（daemon）、`dist/cli.mjs`（plc CLI）。
- `better-sqlite3` 是 native addon，标 `external`，运行时依赖保留在 node_modules；
  其余纯 JS 依赖（ws/commander/cron-parser/typebox/pi SDK）全部打入。
  修正 DESIGN-GATEWAY §7 的"单文件"表述 → "bundle + external native deps"。
- `npm run build`；`bin/plc` 优先执行 dist（存在时），否则回退 tsx 源码（开发模式不变）。
- pi SDK 若含动态 require/资源文件导致打包失败，允许把 `@mariozechner/pi-coding-agent`
  一并列为 external（打包范围以"launchd 不依赖 tsx"为底线，而非教条单文件）。

### B2. 凭证配置（config.json env 段）

`~/.pi-lead-child/config.json`（不存在则忽略；创建时 chmod 600，doctor 检查权限）：

```json
{
  "env": {
    "AM_API_KEY":     { "value": "sk-..." },
    "TAVILY_API_KEY": { "fromEnv": "TAVILY_API_KEY" }
  }
}
```

- `value`：直接给值。`fromEnv`：声明从哪个环境变量名读取（允许改名映射）。
- **优先级：config.json > 进程环境变量**。config 未覆盖的 key 维持现有 env 读取行为。
- daemon 与 CLI 入口统一调用 `loadEnvConfig()`：解析后写入 `process.env`（config 命中时覆盖），
  pi 的 models.json 读 env，零改动透传；TAVILY 透传 child 的现有链路不变。
- 密钥不进 plc.db（账本保持无密钥）、不进 plist。

### B3. launchd 集成

- `plc daemon install`：生成 `~/Library/LaunchAgents/com.pi-lead-child.coordinatord.plist`
  并 `launchctl bootstrap`。RunAtLoad + KeepAlive（崩溃拉起），
  ProgramArguments = `node dist/coordinatord.mjs`（绝对路径），
  stdout/stderr → `~/.pi-lead-child/logs/coordinatord.{out,err}.log`。
- `plc daemon uninstall`：bootout + 删 plist。`plc daemon status`：launchctl 状态 + sock 活性。
- plist 不含密钥（B2 负责）；WorkingDirectory 指向仓库目录（node_modules 里的 better-sqlite3 可达）。
- 与既有单实例保证协同：launchd 拉起时若 sock 上已有活 daemon 则启动被拒、进程退出
  ——需设 `ThrottleInterval`（如 30s）避免 KeepAlive 快速循环。

### B4. plc doctor

只读诊断，逐项 ✓/✗/–（不适用）+ 一行修复提示：

1. daemon 活性（sock 探测，复用单实例 probe）
2. db 可打开 + schema 版本正常
3. 凭证解析：AM_API_KEY 可得（必需）、TAVILY_API_KEY（可选，缺则提示 web_search 不可用）
   ——只报有无与来源（config/env），**不打印值**
4. config.json 存在时权限是否 600
5. aish：URL/token 已配？binding 存在？daemon 在线时实际连接状态
6. launchd job 已加载？plist 与 dist 路径一致？
7. node 版本、pi SDK 版本、dist 构建产物存在且新于源码（提示重新 build）
8. FTS5 可用性（A3 的降级状态）

## C. daemon 生命周期技术债

### C1. recoverOrphans 有限次自动重派

现状：重启把 starting/running 的 attempt 杀掉标 crash、工单转 blocked、blocker 通知——诚实但工作丢失需人工推动。改为：

1. crash 记录照写（诚实语义不变）。
2. 若工单非终态，查账本该工单 `redispatch` activity 中 `payload.auto === true` 的条数：
   - **= 0**：自动开新 attempt 续做（复用 spawnTicketChild），brief 附带前次 crash 说明；
     写 `redispatch` activity（`{auto: true, fromAttempt: N}`）；通知降级 attention（“daemon 重启，工单 #N 已自动重派”）。
   - **≥ 1**：不再自动重派，走现行为（blocked + blocker）。判据在账本里持久化，
     daemon 崩溃循环时第二次重启必然收敛到 blocked，无 spawn 风暴。
3. 自动重派 spawn 失败 → 降级现行为（blocked + blocker），不得让重派失败打死启动流程。

### C2. lastAishOrigin 持久化

- 存 gateway store（`aish_conn` 同表或新 kv：`last_origin` JSON `{channelId, threadTs}`）。
- 每次更新写库（低频，Slack 消息级），daemon 启动时恢复到内存变量。
- 效果：重启后 child 完成通知不丢投递目标（与 C1 联动：自动重派完成的通知能推回 Slack）。

### C3. cron 本地时区

- `cron-parser` 解析加 `{ tz: 本机时区 }`（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。
- 现存 schedules 的 next_run_at 语义从 UTC 变本地，直接切，验收注明；文档同步修订。

## D. 测试与验收

单测（TDD，沿用 fake-pi/内存 db 模式）覆盖：env config 解析优先级、FTS5 检索与降级、core memory
上限报错、kind 迁移、自动重派判据（0/≥1/spawn 失败三分支）、last_origin 持久化往返、cron tz 计算。
plist 生成与 doctor 各检查项用纯函数单测（生成内容断言，不真调 launchctl）。

真机验收（此类改动单测天然覆盖不到，M6 教训）：

1. `plc daemon install` → 注销/重启后 daemon 由 launchd 拉起，Slack 问答通畅（无 401，凭证来自 config.json，环境不含 AM_API_KEY 实测）。
2. `kill -9` daemon → KeepAlive 拉起 → aish 自动重连 → 被杀时正在跑的 child 自动重派并完成 → Slack 收到完成通知（C1+C2 联动）；再次 `kill -9` 使同工单二次孤儿 → 收敛到 blocked+blocker（重派上限生效）。
3. 真实长会话推到 70% 水位 → 沉淀触发 → notes > 0 行，画像/偏好落成 profile/preference。
4. daemon 重启后 lead 未检索即"记得"偏好（core memory 注入生效）；对旧工作结论提问时 lead 先 search_notes（FTS 命中中文关键词）。
5. `plc doctor`：正常态全 ✓；故意破坏（改名 config.json / 停 daemon）各项 ✗ 与修复提示正确。

## E. 明确不做（YAGNI 边界）

- embedding / 向量检索（用户裁决延后；接口已为其留位）。
- 常开机器部署、Tailscale、systemd（无机器；构建产物已可移植）。
- priority 抢占调度（仍无需求）。
- 观察式孤儿打捞（读 pid 存活 + session JSONL 定性——复杂度高，自动重派已覆盖主要损失）。
- 密钥加密存储（Keychain 等）：个人单机，chmod 600 够用。

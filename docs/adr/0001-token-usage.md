# 0001 token 用量的口径

状态：已采纳，2026-10-21（工单 #102 的排查）。

## 背景

工单详情页要显示工单的执行用时、token 和成本。排查时发现 #102 的 `items.total_tokens` 是 17,071,923。#102 只有一个有用量的 Run（#118，Claude Code · sonnet）。这个 Run 的实际用量是 5,981,433 token，成本 $2.58。

数字偏高有三个原因。前两个在 Claude adapter 里，第三个在 ingest 里：

1. stream-json 把一次 API 响应按内容块拆成几行 `assistant`。每行带同一份 usage。adapter 每行都报一条 delta，所以一次响应算了几次。Run #118 有 67 次响应，adapter 报了 163 条 delta，合计 14,362,776。
2. `result.usage` 只算一个回合的主线程。adapter 把它当成进程的累计报。Run #118 有两个回合（后台子 agent 的通知开了第二回合），最后一条 result 只有第二回合的 2,709,147。
3. ingest 把 delta 加起来，又把 cumulative 整个加上去：14,362,776 + 2,709,147 = 17,071,923。

pi 的映射有相反的错误。pi 的 `message.usage` 是一次 API 调用的用量，映射却按 cumulative 报。ingest 只记下最大的一次调用，所以 pi 的工单偏低。

## 决定

### 口径

一个 Run 的 token 数是模型处理的全部 token：输入加输出。输入包含缓存读取和缓存写入。子 agent 的用量算进启动它的 Run。

| runtime | 来源 | 计算 |
| --- | --- | --- |
| Claude | `result.modelUsage`（整个进程，含子 agent） | `inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens`，各模型相加 |
| Codex | `turn.completed.usage`（线程的累计） | `input_tokens`（已含 `cached_input_tokens`）+ `output_tokens` |
| pi | 每条助手消息的 `usage` | `totalTokens`（input + output + cacheRead + cacheWrite） |

工单的 token 数（`items.total_tokens`）是它所有 Run 的 token 数之和。工单的成本（`items.total_cost_usd`）是它所有 Run 自己报的成本之和。Codex 不报成本，它的 Run 的 `cost_known` 是 0。

### 用量事件的含义

`usage.updated` 有两种 `mode`：

- `delta`：新增的用量。
- `cumulative`：这个 runtime 进程到目前的总量。它替换这个进程之前报的全部用量，包括 delta。它可以比上一条小。

`run.started` 表示一个新的进程，例如过期会话在同一个 Run 里开的新会话。新进程从 0 重新累计，前面进程的用量保留。

规则只有一份实现：`createRunUsageLedger`（`packages/store/src/runtime-events.ts`）。ingest 用它记 `items.total_tokens`，`runTokenUsage` 用它从事件日志重算一个 Run 的用量。两边的数一样。

### Claude adapter

1. 每次 API 响应只算一次。去重的键是 `parent_tool_use_id` 和 `message.id`。
2. 运行中按 cumulative 报去重后的估计。这个估计的输出偏少，因为流开始时 `output_tokens` 还不全。
3. 每条 result 按 cumulative 报 `modelUsage` 的总量，成本是 `total_cost_usd`。
4. 旧版本没有 `modelUsage` 时，取估计和各回合 `result.usage` 之和里较大的那个。

## 为什么包含缓存读取

- 三个 runtime 自己报的总数都包含缓存。不含缓存需要每个 adapter 拆开报，现在的事件和表都只有一个总数。
- 缓存读取占大头。Run #118 的 5,981,433 里，5,631,822 是缓存读取（94%）。所以 token 数不代表花费。花费看成本。

## 后果：读 token 数的地方

这个口径让两个 runtime 的数变了方向：

- Claude 的数变小。#102 从 17,071,923 变成 5,981,433。
- pi 的数变大，约是以前的 20 到 60 倍。以前只记下最大的一次调用，现在每次调用都加上。例如 #109 从 112,145 变成 6,848,282（按它的事件重算）。

三个地方读 `items.total_tokens`，都按这个口径判断：

| 位置 | 作用 | 后果 |
| --- | --- | --- |
| `ingest.ts` 的 `PLC_BUDGET_TOKENS`（默认 400 万，以前是 200 万） | 一张工单超过时给 Lead 一条告警 | 按 200 万，一个普通的 Claude 或 pi 执行 Run 就会超过它 |
| `dispatch.ts` 的 `budgetReady`（`token_budget`） | 一棵工单树的合计达到根工单的 `token_budget` 时，停止派发 | 设了 `token_budget` 的树会更早被停住，pi 的树尤其明显 |
| `delegated-review.ts` 的 `budget_limit_tokens` | 委托的合计达到上限时，Lead 不再按委托验收 | 委托会更早用完 |

2026-10-21 用户的决定：

- `PLC_BUDGET_TOKENS` 的默认值改成 400 万（`DEFAULT_TOKEN_BUDGET`）。
- 修复以前写下的 `items.total_tokens` 要按这个口径重算。
- `token_budget` 和 `budget_limit_tokens` 由创建它们的人设定，没有默认值，这次不改。

## 工单详情页

- 工单的 token 和成本：读 `items.total_tokens` 和 `items.total_cost_usd`。
- 一个 Run 的 token：读 `runTokenUsage`（control-plane 里的 `lastTokens`）。
- 不要在 UI 里从事件重新加总。
- 在 token 数旁边写明「含缓存读写」。
- 工单有 Codex 的 Run 时，成本不完整。写明「成本不含 Codex」，不要显示成 $0。

## 历史数据

2026-10-21 用户决定按这个口径重算。重算是一次性的数据更正，schema v51（`packages/store/src/token-usage-recompute.ts`），daemon 打开库时执行：

| Run | 怎么认出旧格式 | 怎么重算 |
| --- | --- | --- |
| Claude | 事件里有 `delta`（新 adapter 只写 `cumulative`） | 每个进程（按 `run.started` 分段）取「去重后的估计」和「各回合 `result` 之和」里较大的那个。去重按输入 token 数。成本取这段最后一条 `cumulative` |
| pi | 每条用量事件都是一次调用 | 全部加起来 |
| Codex、新格式的 Claude | — | 不动 |

旧的 Claude 事件没有响应的 id，所以只能估计。用还留着原始输出的 4 个 Run 核对过：#93、#120 完全一致；#117 偏低 0.7%，#118 偏低 0.9%（估计里的输出是流开始时的值）。

写入：

- 每个改了的 Run，事件末尾追加一条普通的 `usage.updated`（`cumulative`），让 `runTokenUsage` 得到重算的数。它只替换最后一个进程，所以它的值是「重算的总数减去前面各进程按账本算出的数」。
- `items.total_tokens` 和 `total_cost_usd` 加上「重算的数减去旧 ingest 当时记下的数」。事件日志之前的用量（#1–#12 的早期 Run 没有事件）原样保留。
- 每张改了的工单留一条 `token_usage_recomputed` 活动，写明前后的数和每个 Run 的变化。

## 已知的缺口

Codex 续接线程（resume）的 Run，疑似报整个线程的累计，也就是包含被续接的 Run 的用量。例如 #91 报 5,858,778，它续接的 #87 报 5,346,552。这时工单会把同一份用量算两次。这个缺口还没有修。

# 任务完成协议：成果快照与登记设计

> 工单 #45 的设计登记。仅记录 pi-lead-child 自身缺口与后续实施方案，不实施、不派发 child。
>
> 关系更正：本设计不属于 Dialogue Returns，也不以其工单 #18 为父项、依赖或验收依据。历史案例 #44 只用于说明故障形态：代码工作确已发生，缺的是完成后稳定、可审计的成果登记，不能反推为“没有成果”。

## 1. 问题与目标

现有协议把执行 child 的原子交接收敛为：

```text
ticket_update(status="review", checkpoint.kind="completed")
```

它已能原子写入正文、状态、Checkpoint、proof、artifact 和 outbox；reviewer 结论也已有独立、不可变的 `review_verdicts` 账本。但 `completed` 的成果信息仍主要是自由文本，且 `run.completed` 只会判断工单是否离开 `active`。因此有两个空洞：

1. child 成功完成代码工作，却没有留下结构化的变更引用、验证记录和功能摘要；
2. child 无法写 PLC_DB、关键工具响应丢失，或先完成状态转换再结束 Run 时，运行成功输出不能被恢复并登记为成果。

目标是在不复制全量 session、不中断历史 append-only 账本、也不伪造 reviewer 结论的前提下，为每次声称“实现完成”的 executor Run 登记稳定成果快照。

## 2. 必须分开的事实

以下事实互不蕴含，UI、API 和状态机不得用一个布尔值替代另一个：

| 事实 | 权威来源 | 含义 | 禁止推断 |
|---|---|---|---|
| 实现完成 `implementation_completed` | executor 的原子 completed handoff，或系统从该 executor Run 的成功终局输出恢复 | 执行者声明实现已完成，并留下成果快照 | 不等于用户接受；不等于独立验证通过 |
| 独立验收证据完整 `independent_evidence_complete` | `review_verdicts` 中真实 reviewer Run 的不可变 verdict + evidence，并关联其证据引用 | 独立 reviewer 已给出可审计结论 | 不得由 executor 自述、用户接受或系统推断生成 |
| 用户接受 `user_accepted` | 用户 authority 导致的 `review -> done` 决策/transition 账本 | 用户接受当前成果 | 不证明实现或测试客观正确 |

自动 review 的 `review -> done` 是 system transition，表示自动策略依据 reviewer pass 推进；它不是 `user_accepted`。UI 应显示“自动验收通过”，不能显示“用户已接受”。

## 3. 数据模型

### 3.1 新增 append-only `outcome_snapshots`

```sql
CREATE TABLE outcome_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id               INTEGER NOT NULL REFERENCES items(id),
  executor_run_id        INTEGER NOT NULL REFERENCES runs(id),
  completion_checkpoint_id INTEGER REFERENCES checkpoints(id),

  source                TEXT NOT NULL
                        CHECK (source IN ('agent_reported','system_recovered')),
  source_event_seq       INTEGER,
  source_output_sha256   TEXT,

  summary               TEXT NOT NULL,
  changes_json          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes_json)),
  deliverables_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deliverables_json)),
  validations_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(validations_json)),

  completeness          TEXT NOT NULL
                        CHECK (completeness IN ('complete','partial')),
  missing_fields_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_fields_json)),
  recovery_note         TEXT,

  content_hash          TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(executor_run_id),
  CHECK ((source = 'agent_reported' AND completion_checkpoint_id IS NOT NULL)
      OR (source = 'system_recovered')),
  CHECK ((source = 'system_recovered' AND source_output_sha256 IS NOT NULL)
      OR source = 'agent_reported')
);
CREATE INDEX outcome_snapshots_item ON outcome_snapshots(item_id, id);
```

一条 executor Run 最多一个最终成果快照。返工产生新 Run，也产生新快照；旧快照不覆盖，工单详情默认展示最新快照并允许查看历史。这样不会把多次尝试揉成一条不可审计的“最终总结”。

字段结构：

```ts
type OutcomeChange = {
  kind: "file" | "commit" | "other";
  ref: string;              // 工作目录相对路径、commit SHA 或稳定引用
  summary?: string | null;
};

type OutcomeDeliverable = {
  kind: "artifact" | "path" | "url" | "other";
  ref: string;              // artifact ref 优先；路径必须受 workdir 边界校验
  label: string;
};

type OutcomeValidation = {
  command: string;
  outcome: "passed" | "failed" | "not_run";
  exitCode: number | null;
  summary: string;
  evidenceRef: string | null; // artifact ref、runtime event range 或 session cursor
};
```

`summary` 是关键功能摘要。`changes` 至少应有变更文件或提交引用之一；`deliverables` 记录产物位置；`validations` 记录实际执行的命令和结果，而不是计划执行的命令。

### 3.2 Reviewer 证据不复制、不伪造

`review_verdicts` 继续是 reviewer 结论的唯一事实源。后续迁移仅增加可选证据引用，例如：

```sql
ALTER TABLE review_verdicts ADD COLUMN checkpoint_id INTEGER REFERENCES checkpoints(id);
ALTER TABLE review_verdicts ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(evidence_refs));
```

`outcome_snapshots` 不存 reviewer verdict。读模型通过 `item_id` 查询真实 `review_verdicts`，并展示 reviewer Run、verdict、evidence、checkpoint/artifact/runtime-event 来源。没有真实 verdict 行时只能显示“尚无独立验收结论”。系统恢复器严禁插入 `review_verdicts`。

### 3.3 派生完成事实

无需新增可漂移布尔列；由账本投影：

- `implementation_completed`：存在 outcome snapshot，且关联 executor Run 的完成交接已成立；partial 快照仍表示“有完成声明，但登记不完整”，UI 明示完整度。
- `independent_evidence_complete`：存在真实 reviewer verdict，且证据引用满足当期策略；旧数据只有 evidence 文本时可标记 `legacy_text_only`，不得伪装成完整结构化证据。
- `user_accepted`：存在 actor=`user` 的 `review -> done` transition/decision。system 自动关闭不计入。

## 4. 写入协议与状态机接入

### 4.1 Agent 原子完成入口

扩展 `ticket_update` 的 completed checkpoint 输入：

```ts
checkpoint: {
  kind: "completed";
  ...;
  outcome: {
    summary: string;
    changes: OutcomeChange[];
    deliverables: OutcomeDeliverable[];
    validations: OutcomeValidation[];
  };
}
```

当 `status='review'` 时：

1. 必须是 executor Run；reviewer 不能提交实现成果快照；
2. 必须带 completed checkpoint；
3. 新协议版本要求 `outcome`，并验证引用、路径边界、数组配额和敏感信息；
4. 在同一 SQLite immediate transaction 中写 body（如有）、transition、checkpoint、artifacts/proof、outcome snapshot、receipt、activity/card/outbox；
5. 任一写入失败全部回滚，artifact blob staging 沿用现有 commit/cleanup 纪律；
6. `idempotency_key = outcome:executor-run:<runId>`；同键同内容返回原结果，不同内容冲突。

兼容迁移期可接受没有 `outcome` 的旧 client，但必须登记 `partial` snapshot 或交给恢复器补齐，不能静默进入“看似完整”。协议版本门槛开启后，缺失 outcome 的新完成请求应拒绝。

### 4.2 Run 终局接入

`run.completed` 的事务顺序调整为：

1. 持久化最终 runtime event 与 assistant 成功输出；
2. 结算 Run；
3. 检查该 executor Run 是否已有 outcome snapshot；
4. 已有：只做幂等确认，不因 Run 在状态转换后才结束而误报；
5. 没有：尝试成功终局恢复；
6. 恢复成功：写 `system_recovered` snapshot；若 item 仍为 `active`，再依据恢复结果原子推进到 `review`；若已为 `review/done`，只补登记，不倒退状态；
7. 无法恢复：沿用 terminal handoff failure 路径。仅当 item 仍为 `active` 时转 `blocked`；若 item 已是 `review/done`，记录“成果登记缺失” blocker/Checkpoint，不反向改状态。

这一区分解决“状态已转换，Run 后结束”的竞态：状态正确不代表快照存在；快照缺失也不应把已 review/done 的事项错误拉回 blocked。

### 4.3 Reviewer 与接受入口

- `review_verdict` 仍只能由 reviewer Run 调用，保持不可变和幂等；提交时可关联 reviewer completed checkpoint 与证据 refs，但不能携带或重写 executor outcome。
- automatic reviewer pass 可照现状 system 推进 done，并投影为“自动验收通过”；不产生 user acceptance。
- manual review 的 user `review -> done` 只登记 `user_accepted`。即使 reviewer 尚未运行，用户也可以接受，但 UI 仍显示“独立验收证据：缺失”，两者不能互相补齐。

## 5. 成功输出恢复策略

### 5.1 可恢复终局信封

所有 runtime 的执行 prompt 增加统一要求：除调用 `ticket_update` 外，最终 assistant 输出必须包含一个机器可识别、带版本的结果信封。推荐单行哨兵，避免从自然语言猜 reviewer 结论：

```text
PLC_OUTCOME_V1 {"summary":"…","changes":[…],"deliverables":[…],"validations":[…]}
```

Runtime adapter 必须将最终 assistant message 作为 `message.completed` 持久化到 `runtime_events`，并保留 session cursor。恢复器只读取当前 executor Run 的成功终局 message，不跨 Run 拼接，不扫描任意历史文本。

### 5.2 恢复校验

恢复器 `recoverOutcomeSnapshot(runId)`：

1. 要求 Run role=`executor`，终局为成功（正常完成、无 LLM error）；
2. 选择最终 assistant message 中最后一个合法 `PLC_OUTCOME_V1`；
3. 严格 schema 校验，拒绝未知字段、绝对路径、越出 workdir 的路径、过量条目和疑似 secret；
4. 只登记 agent 明确陈述的验证结果，不在恢复时重新运行命令，也不把 `not_run` 改成 passed；
5. 计算原始信封 SHA-256，写 `source_event_seq`、`source_output_sha256` 和 recovery note；
6. 若字段缺失但仍能形成最小摘要，登记 `partial` 并列出 `missing_fields`；完全不可解析则失败；
7. 绝不根据诸如“LGTM”“测试应该通过”的自然语言生成 reviewer verdict。

### 5.3 启动恢复

新增 startup repair，顺序在 terminal handoff failure repair 之前：

```text
repairOutcomeSnapshots()
repairTerminalHandoffFailures()
```

扫描范围限制为：已 finished 的 executor Run、存在成功终局输出、尚无 snapshot。每次按稳定 run id 顺序，使用同一 idempotency key，崩溃重启可安全重放。

对历史 #44 类数据：若 session/runtime event 尚有成功信封则自动恢复；旧版本没有信封时不得编造详情，只可创建明确标记 `partial` 的人工/迁移登记（引用已有 commit、文件、测试日志等真实来源），或显示“历史成果存在，结构化快照不可恢复”。

## 6. 历史账本与单一事实源

- `runtime_events/session`：全量执行事实与恢复来源；不复制整个对话。
- `checkpoints`：语义里程碑账本。
- `outcome_snapshots`：从 agent handoff 或成功输出登记的规范化成果索引，保存来源 hash/cursor；不是第二份全量日志。
- `artifacts`：不可变产物元数据与 blob。
- `review_verdicts`：独立 reviewer 结论唯一来源。
- `activities/transitions`：接受者与状态变化来源。

修复或重建 materialized projection 时，必须从以上 append-only 行重放；不得回写或改写历史 checkpoint/verdict。冲突时以原始账本行和 provenance 为准，投影失败应显式报 drift。

## 7. API 与 UI

### 7.1 API/协议

为 ticket workbench 增加 additive `outcomeSnapshot` 资源（不修改冻结的 protocol v2 event union）：

```ts
{
  latest: OutcomeSnapshot | null;
  historyCount: number;
  facts: {
    implementationCompleted: boolean;
    independentEvidence: "complete" | "partial" | "missing";
    acceptance: "user" | "automatic" | "none";
  };
  reviewerVerdict: {
    verdict: "pass" | "fail";
    runId: number;
    evidence: string;
    evidenceRefs: EvidenceRef[];
  } | null;
}
```

通过现有 `ticket.updated` 使 Companion 失效并重取资源，无需扩展冻结事件 union。HTTP 应支持按 snapshot id 查看历史和来源。

### 7.2 Companion 展示

工单详情新增独立“成果”区，不把内容埋在普通 Checkpoint 文本里：

1. **事实条**：分别显示“实现完成”“独立验收证据”“接受状态”；使用不同图标/颜色，禁止合成一个“已完成”。
2. **关键功能摘要**：snapshot summary 与来源 badge（child 登记 / 系统从 Run #N 恢复）。
3. **变更**：文件、commit、其他引用列表；commit 可复制，路径可定位。
4. **产物**：复用 ArtifactList；metadata-only/unavailable 状态保持真实。
5. **验证**：逐条显示命令、exit code、passed/failed/not run、结果摘要和证据入口。不得只显示绿色“通过”而隐藏命令。
6. **Reviewer**：单独卡片展示 verdict、reviewer Run/runtime、原始 evidence 与证据来源；没有 verdict 时为空态，系统恢复 badge 不得出现在 reviewer 卡片。
7. **完整度警告**：partial 或历史不可恢复时明确显示缺失字段；不使用“无成果”。
8. **历史**：返工后允许查看每个 executor Run 的快照及其对应 reviewer verdict/状态演进。

列表页可只显示三个紧凑事实 badge；详情页才展开证据。

## 8. 测试方案

### 8.1 Schema 与迁移

- 新库创建、旧库增量迁移、重复迁移幂等；外键与 JSON CHECK 生效。
- 历史 checkpoints/artifacts/review_verdicts 行数、hash/provenance 不变。
- `UNIQUE(executor_run_id)` 和 idempotency 冲突测试。
- projection 重放与 drift 检测；旧 verdict 显示 `legacy_text_only`，不冒充完整 refs。

### 8.2 Agent 工具原子性

沿用 `checkpoint-tools.test.ts` 的故障注入矩阵，新增 outcome 表写入、activity/outbox/receipt 故障点：

- completed + outcome + status=review 全部成功；
- 缺 summary/changes/deliverables/validations、越界路径、未知字段、secret、超配额拒绝；
- 任一环节失败时 item/checkpoint/proof/artifact/outcome/receipt/outbox 全部回滚，blob 不泄漏；
- 丢失响应后同 invocation replay 返回同 snapshot；改 payload 冲突；
- reviewer Run 不能写 executor outcome。

### 8.3 Run 终局与恢复

至少覆盖：

1. 正常原子 handoff 后才收到 `run.completed`：不重复登记、不误报；
2. child 无 PLC_DB，但成功输出合法信封：恢复 snapshot，并从 active 推 review；
3. child 已把 item 推 review，工具响应丢失/Run 后结束：补 snapshot，不拉回 blocked；
4. item 已 done 后 startup 才恢复：补登记，不改变 done/closed_at；
5. malformed/多信封/未知版本/越界路径/secret：拒绝或 partial，绝不伪造字段；
6. success output 无信封：active 走 handoff failure；review/done 只报登记缺失，不倒退；
7. crash/LLM error 即使含信封也不恢复为完成；
8. startup repair 重跑幂等，且先于 terminal handoff repair；
9. Codex/Claude/Pi adapter 都保留最终 message 和 cursor。

### 8.4 Reviewer 与三事实隔离

- executor completed 不产生 reviewer verdict；
- system recovery 不产生 reviewer verdict；
- reviewer pass/fail 只能关联 reviewer Run，immutable；
- manual 用户接受可与 reviewer missing 并存；
- automatic pass 显示 automatic acceptance，而非 user acceptance；
- user acceptance 不把 failed/missing reviewer evidence 改成 complete；
- reviewer pass 不反向填造 executor validation。

### 8.5 API/Companion

- additive schema、normalize/cache invalidation、分页历史、断线缓存和 malformed fail-closed。
- 三事实 badge 的所有组合；partial/legacy/recovered badge；无 snapshot 空态措辞。
- 验证命令、exit code、evidence ref 可见；artifact 三种 availability 复用。
- reviewer 卡片只由真实 verdict resource 渲染。
- Web/原生 accessibility label 明确区分“用户接受”“自动验收”“独立证据”。

### 8.6 #44 类回归夹具

建立确定性 fixture：executor Run 产生文件/commit 引用与通过的验证命令，成功结束但没有可用 PLC_DB 写回；item 可处于 active、review、done 三种竞态终局。恢复后断言：

- 都能看到来源可追溯的成果快照；
- active 仅在合法完整恢复后推进 review；review/done 不倒退；
- 没有 reviewer verdict 时 UI 明示缺失；
- 用户接受、实现完成、独立证据三事实保持独立；
- 原 runtime event、checkpoint、transition、verdict 账本均未被改写。

## 9. 实施切片（后续工单）

本工单不派发实现。后续可按以下有序切片执行：

1. protocol/type/schema/migration + store service；
2. `ticket_update` outcome 原子登记与 prompt；
3. runtime 终局信封持久化、恢复器与 startup repair；
4. reviewer evidence refs 与三事实 projection；
5. paired HTTP/workbench additive resource；
6. Companion 成果区与历史；
7. 跨 runtime、迁移、故障注入和 #44 fixture 全链路验收。

其中 2 依赖 1，3 依赖 1/2，4 依赖 1，5 依赖 1/4，6 依赖 5，7 依赖全部实现切片。

## 10. 验收结论

该方案覆盖数据模型、状态机接入点、成功终局恢复、UI 展示和测试矩阵，并明确：

- #44 类情况是“成果登记缺失”，不是“没有成果”；
- child 无法写回或 Run 晚于状态转换结束时，仍可从严格成功终局信封恢复；
- 历史 append-only 账本继续是单一事实源，快照带 provenance 且可重建；
- reviewer 结论只能来自真实 reviewer verdict，不由 executor、用户接受或系统恢复伪造；
- 用户接受、实现完成、独立验收证据完整三种事实始终分离。

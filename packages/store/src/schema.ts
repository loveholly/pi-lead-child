// DDL 来自 DESIGN.md §3。与设计稿的两处偏差是有意的：
// runs.session_id/session_path 允许 NULL（spawn 后 get_state 才拿到），
// 状态机合法性由 items.ts 的代码层校验，DDL 只管枚举。
// items 的表体单独抽成函数：v14 重建迁移（db.ts migrateItemModel）必须先把新形状建在
// 临时表名下再 RENAME，两处若各写一份 DDL 必然漂移，而漂移的正是本设计赖以成立的 CHECK。
import { FAILURE_NEEDS, FAILURE_RETRIES, FAILURE_SCOPES } from "@pi-lead-child/core";
export function itemsTableSql(table: string, ifNotExists = false): string {
  return `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','reminder')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT 'draft',
  brief         TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('urgent','high','normal','low')),
  project       TEXT,
  project_id    INTEGER REFERENCES projects(id),

  -- 时间
  due_at             TEXT,
  defer_until        TEXT,          -- 仅 task（reminder 已有 remind_at，语义重复）
  remind_at          TEXT,          -- 仅 reminder
  due_overdue_notified INTEGER NOT NULL DEFAULT 0,

  -- 层级（仅 task）
  parent_item_id INTEGER REFERENCES items(id),
  root_item_id   INTEGER REFERENCES items(id),   -- 可空：自根行需 insert-then-update

  -- 执行配置（仅 task），全部可空
  workdir       TEXT,
  requested_runtime TEXT,
  requested_model TEXT,
  purpose       TEXT,
  -- 停用的列（v56，工单 09）：和 verification_policy 说同一件事，代码不再读写它，v56 把它的 'automatic' 并进了
  -- verification_policy。列还留着：下面的 (C2) 引用它，ALTER TABLE DROP COLUMN 做不了，不为删一列重建 items。
  review_policy TEXT CHECK (review_policy IS NULL OR review_policy IN ('manual','automatic')),
  max_depth     INTEGER,
  max_children  INTEGER,
  max_concurrency INTEGER,
  token_budget  INTEGER,
  cost_budget_usd REAL,
  retry_limit   INTEGER,                           -- 可空；task 缺省由代码补 1

  -- 计划编排（仅 task）
  plan_state    TEXT
                CHECK (plan_state IS NULL OR plan_state IN
                       ('none','planning','waiting','integrating','failed')),
  active_plan_revision INTEGER,

  -- 溯源
  created_by    TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_by_run_id INTEGER REFERENCES runs(id),

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at   TEXT,
  first_run_at  TEXT,
  closed_at     TEXT,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     REAL    NOT NULL DEFAULT 0,
  -- workflow_kind 是显式的业务范围，不从 workdir/project 猜测；提醒永远不是 coding workflow。
  workflow_kind TEXT NOT NULL DEFAULT 'generic' CHECK (workflow_kind IN ('generic','coding')),
  verification_policy TEXT CHECK (
    verification_policy IS NULL OR verification_policy IN ('independent_reviewer','lead_static','user')
  ),
  acceptance_policy TEXT CHECK (
    acceptance_policy IS NULL OR acceptance_policy IN ('user_only','delegated_to_lead')
  ),
  rework_policy TEXT CHECK (
    rework_policy IS NULL OR rework_policy IN ('ask_user','automatic')
  ),
  delivery_policy TEXT CHECK (
    delivery_policy IS NULL OR delivery_policy IN ('notify_only','continue_workflow')
  ),
  -- 显示用的短标题（v39）。原标题不可读时（例如 E2E 脚本生成的）由 Lead 写；原标题保留。
  -- 放在最后：老库用 ALTER 补在末尾，新库和老库的列顺序要一致。
  display_title TEXT,
  -- 提醒的设置（v48，工单 07）：JSON，形状在 protocol 的 reminders.ts（级别、提前提醒、重复推送、关联的工单）。
  -- 只有提醒有，store 的 reminders.ts 在写入时校验；NULL 是缺省设置（tell、不提前、不重复）。
  -- 和 display_title 一样放在最后：老库用 ALTER 补在末尾，新库和老库的列顺序一致。不是执行列，不进 C2 的 CHECK。
  reminder_policy TEXT,

  CHECK (kind = 'task' OR workflow_kind = 'generic'),

  -- (C1) stage 必须属于本 kind 的状态机
  CHECK (
    (kind = 'task'     AND stage IN ('draft','ready','active','blocked','review','done','cancelled'))
    OR
    (kind = 'reminder' AND stage IN ('scheduled','fired','acked','cancelled'))
  ),

  -- (C2) reminder 不得携带任何执行侧字段。此列表必须与上方「执行配置」「计划编排」
  --      「层级」三组完全一致；新增执行列时必须同步加入本 CHECK。
  --      溯源列（created_by_run_id）不在此列：spec §6.6 允许 child 创建 item，
  --      那条 reminder 仍须记得是哪次 run 建的。
  CHECK (kind = 'task' OR (
    parent_item_id IS NULL AND root_item_id IS NULL
    AND workdir IS NULL AND requested_runtime IS NULL AND requested_model IS NULL
    AND purpose IS NULL AND review_policy IS NULL
    AND verification_policy IS NULL AND acceptance_policy IS NULL
    AND rework_policy IS NULL AND delivery_policy IS NULL
    AND retry_limit IS NULL
    AND max_depth IS NULL AND max_children IS NULL AND max_concurrency IS NULL
    AND token_budget IS NULL AND cost_budget_usd IS NULL
    AND plan_state IS NULL AND active_plan_revision IS NULL
    AND defer_until IS NULL
    AND first_run_at IS NULL AND total_tokens = 0 AND total_cost_usd = 0
  )),

  -- (C3) remind_at 双向约束：task 不得有；scheduled 的 reminder 必须有，否则永不触发
  CHECK (kind = 'reminder' OR remind_at IS NULL),
  CHECK (kind <> 'reminder' OR stage <> 'scheduled' OR remind_at IS NOT NULL),

  -- (C4) 只有 user / lead 直接创作的 item 才可能停在 draft（见 spec §6.6）
  CHECK (stage <> 'draft' OR created_by IN ('user','lead'))
);`;
}

// 索引与触发器与表体分开：重建迁移 DROP 掉旧表时它们会一并消失，RENAME 后需要重放。
export const ITEMS_CONSTRAINTS_SCHEMA = `
CREATE INDEX IF NOT EXISTS items_by_view ON items (kind, stage, defer_until);
CREATE INDEX IF NOT EXISTS items_by_root ON items (root_item_id);
CREATE INDEX IF NOT EXISTS items_remind  ON items (remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_due     ON items (due_at)    WHERE due_at IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS items_kind_immutable BEFORE UPDATE OF kind ON items
WHEN OLD.kind <> NEW.kind
BEGIN SELECT RAISE(ABORT, 'item.kind is immutable'); END;
-- workflow_kind 的跨字段约束无法用旧库上的 ALTER TABLE 增加，触发器保证新旧库一致。
CREATE TRIGGER IF NOT EXISTS items_workflow_kind_i BEFORE INSERT ON items
WHEN NEW.kind = 'reminder' AND NEW.workflow_kind <> 'generic'
BEGIN SELECT RAISE(ABORT, 'reminder items must use generic workflow_kind'); END;
CREATE TRIGGER IF NOT EXISTS items_workflow_kind_u BEFORE UPDATE OF kind, workflow_kind ON items
WHEN NEW.kind = 'reminder' AND NEW.workflow_kind <> 'generic'
BEGIN SELECT RAISE(ABORT, 'reminder items must use generic workflow_kind'); END;
-- 树里只能有 task：(C2) 已禁止 reminder 当 child，这里再禁止任何 item 认 reminder 当父/根。
-- CHECK 不能跨行引用，只能落在触发器上。
-- 用 null-safe 的 IS NOT 而非 <>：指向不存在的行时子查询返回 NULL，<> 会得到 NULL（假），
-- 悬挂引用就被静默放行，完整性等于外包给了默认 OFF 的 PRAGMA foreign_keys。
-- root_item_id <> id 这个豁免只在 UPDATE 上起作用（自根行 insert-then-update 协议的
-- 第二步）。INSERT 时 AUTOINCREMENT 尚未定 id，NEW.id 为 -1，该谓词恒真、豁免不了任何东西。
CREATE TRIGGER IF NOT EXISTS items_tree_is_task_i BEFORE INSERT ON items
WHEN (NEW.parent_item_id IS NOT NULL
        AND (SELECT kind FROM items WHERE id = NEW.parent_item_id) IS NOT 'task')
  OR (NEW.root_item_id IS NOT NULL AND NEW.root_item_id <> NEW.id
        AND (SELECT kind FROM items WHERE id = NEW.root_item_id) IS NOT 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of an item must be a task'); END;

CREATE TRIGGER IF NOT EXISTS items_tree_is_task_u
BEFORE UPDATE OF parent_item_id, root_item_id ON items
WHEN (NEW.parent_item_id IS NOT NULL
        AND (SELECT kind FROM items WHERE id = NEW.parent_item_id) IS NOT 'task')
  OR (NEW.root_item_id IS NOT NULL AND NEW.root_item_id <> NEW.id
        AND (SELECT kind FROM items WHERE id = NEW.root_item_id) IS NOT 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of an item must be a task'); END;
`;

// 类型化失败的五列（spec D1）。新库的 DDL 和 v26 迁移共用这一份定义，两边不会漂移。
// 列都可空：v26 之前的失败 Run 没有类型，读取时由内核的兜底分类器补上。
const quoted = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(",");
export const RUN_FAILURE_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["failure_scope", `TEXT CHECK (failure_scope IN (${quoted(FAILURE_SCOPES)}))`],
  ["failure_retry", `TEXT CHECK (failure_retry IN (${quoted(FAILURE_RETRIES)}))`],
  ["failure_needs", `TEXT CHECK (failure_needs IN (${quoted(FAILURE_NEEDS)}))`],
  ["failure_code", "TEXT"],
  ["failure_evidence", "TEXT"],
];

// 启动垫片的两列（spec D7，工单 14）。新库的 DDL 和 v34 迁移共用这一份定义。
// launcher：垫片的身份 JSON（pid、token、目录），不进线上投影。
// output_cursor：输出游标 JSON（output.jsonl 的字节偏移和事件 seq）。不是垫片启动的 Run 两列都为 NULL。
export const RUN_LAUNCHER_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["launcher", "TEXT"],
  ["output_cursor", "TEXT"],
];

// v38：派发请求和 Run 记下推理强度（effort）。items 不加这一列：items 的 C2 CHECK 要求执行列同步进 CHECK，
// 老库改不了 CHECK，只能整表重建。工单之后的派发沿用同一用途、同一 runtime 和模型的上一个 Run 的 effort。
export const RUN_EFFORT_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["effort", "TEXT"],
];

// v41：决策请求记下是谁发起的（agent 的 Run，或者 Lead 在会话里用 render_ui 发起）。只加列，已有的行算 agent。
export const DECISION_ORIGIN_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["origin", "TEXT NOT NULL DEFAULT 'agent'"],
];

// runs 同样抽成函数，理由与 items 一致：state 的 CHECK 里多了 'paused'，老库改不动
// CHECK，只能整表重建（db.ts migrateRunsPausable），两处各写一份 DDL 必然漂移。
// 这里刻意不带任何索引：SCHEMA 在 openDb 里跑在 migrateDb 之前，而老库此刻可能还没有
// external_session_id 之类的列（那是 migrateKernelV1 才补的），索引一旦写进 SCHEMA
// 就会在老库上抛 "no such column" 而让 openDb 整个失败。索引由各自的迁移负责。
export function runsTableSql(table: string, ifNotExists = false): string {
  return `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  workspace_id   INTEGER REFERENCES workspaces(id),
  role          TEXT NOT NULL DEFAULT 'executor' CHECK (role IN ('executor','reviewer')),
  session_id    TEXT,
  session_path  TEXT,
  pid           INTEGER,                          -- 暂停期间为 NULL（spec §5.2）
  -- finished/failed 是 v16 改名后的内部词汇。线上 AttemptStateSchema 仍叫 settled/crashed
  -- （已发布契约，冻结字节测试守着），两者的映射在 gateway 投影层，改任一侧都要同时改那里。
  state         TEXT NOT NULL DEFAULT 'starting'
                CHECK (state IN ('starting','running','paused','finished','failed','stopped')),
  model         TEXT,
  runtime       TEXT NOT NULL DEFAULT 'pi',
  purpose       TEXT NOT NULL DEFAULT 'execution',
  runtime_version TEXT,
  external_session_id TEXT,
  resumed_from_run_id INTEGER REFERENCES ${table}(id),
  event_cursor  TEXT,
  exit_code     INTEGER,
  error_code    TEXT,
  error_message TEXT,
${RUN_FAILURE_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
  runtime_profile_hash TEXT,                       -- 这个 Run 用的 RuntimeProfile 内容 hash（工单 05）
${RUN_LAUNCHER_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
${RUN_EFFORT_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
  metadata      TEXT NOT NULL DEFAULT '{}',
  cost_known    INTEGER NOT NULL DEFAULT 0,
  event_log_dirty INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at     TEXT,                             -- 当前这次暂停的起点；恢复时清空
  paused_ms     INTEGER NOT NULL DEFAULT 0,       -- 历次暂停累计，支持反复暂停/恢复
  ended_at      TEXT,
  last_entry_cursor TEXT
);`;
}

// Workspace 是 ticket 与原始路径之间的权威层。
// 先保留 item.workdir 兼容旧 runtime；新的 Run 通过 workspace_id 固定一次解析结果。
export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_item_id              INTEGER NOT NULL REFERENCES items(id),
  mode                       TEXT NOT NULL CHECK (mode IN ('shared','isolated')),
  kind                       TEXT NOT NULL CHECK (kind IN ('primary','isolated_child','reviewer','experiment')),
  project_id                 INTEGER REFERENCES projects(id),
  repo_root                  TEXT,
  path                       TEXT NOT NULL,
  branch                     TEXT,
  base_ref                   TEXT,
  git_worktree               INTEGER NOT NULL DEFAULT 0 CHECK (git_worktree IN (0,1)),
  source_item_id             INTEGER REFERENCES items(id),
  source_run_id              INTEGER REFERENCES runs(id),
  reused_from_workspace_id  INTEGER REFERENCES workspaces(id),
  state                      TEXT NOT NULL DEFAULT 'requested' CHECK (state IN (
    'requested','provisioning','active','idle','review_hold','pending_integration',
    'released','cleaning','cleaned','archived','failed','blocked'
  )),
  merge_status               TEXT NOT NULL DEFAULT 'n/a' CHECK (merge_status IN ('n/a','pending','merged','conflict','abandoned')),
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at               TEXT,
  retained_until             TEXT,
  released_at                TEXT,
  cleaned_at                 TEXT,
  CHECK (mode = 'isolated' OR merge_status = 'n/a'),
  CHECK (git_worktree = 0 OR repo_root IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces(owner_item_id, state, id);
CREATE INDEX IF NOT EXISTS workspaces_project ON workspaces(project_id, state, id);
CREATE INDEX IF NOT EXISTS runs_workspace ON runs(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_owner_kind
  ON workspaces(owner_item_id, kind)
  WHERE state NOT IN ('cleaned','archived');
`;

// 按工单查 Run（Lead 的读工具、工单详情、派发和恢复都这样查）。由 SCHEMA 建，新库老库一样，不占迁移号。
// 单独导出：v16 的 runs 重建（db.ts migrateRunsShape）跑在 exec(SCHEMA) 之后，DROP 旧表时这条索引一起消失，
// 重建完要重放，否则第一次升级后的这次打开没有它。item_id 在 v16 改名（排在 exec(SCHEMA) 之前）后一定存在。
// SQLite 的索引自带 rowid（即 id），WHERE item_id = ? ORDER BY id 不需要另外排序。
export const RUNS_ITEM_INDEX_SQL = "CREATE INDEX IF NOT EXISTS runs_item ON runs(item_id);";

// inbox（spec §5.5 的 lead_inbox，物理名不改）同样抽成函数：v15 要把 item_id 的 NOT NULL
// 去掉并补一列 dedup_scope，SQLite 改不动约束，只能整表重建（db.ts migrateLeadInboxScope）。
export function inboxTableSql(table: string, ifNotExists = false): string {
  return `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 可空：并非所有内部事件都挂事项（watchdog 的全局告警、trigger 自停用等）。
  item_id     INTEGER REFERENCES items(id),
  -- 去抖与熔断的分组键。必须显式，不能沿用 item_id：SQLite 里 col = NULL 恒不为真，
  -- 放开 NOT NULL 后按 item_id 分组会让不挂事项的行既不去抖也不熔断——恰好在新放开的
  -- 那一类行上失去保护（spec §5.5）。
  dedup_scope   TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('blocker','attention')),
  source        TEXT NOT NULL CHECK (source IN ('structural','semantic')),
  summary       TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','delivered','consumed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  -- 挂了事项就必须按那个事项分组。少了这条，两条同工单的行可以带不同 scope 而各自逃过
  -- 去抖，"分组键显式化"就退化成一个谁都能写歪的自由文本列。
  CHECK (item_id IS NULL OR dedup_scope = 'item:' || item_id)
);`;
}

// Trigger / Notification 层（spec §5.3/§5.4）。三张表都是新建的，没有老库形状要迁就，
// 因此直接进 SCHEMA 由 CREATE TABLE IF NOT EXISTS 收编。
export const TRIGGER_NOTIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS triggers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),

  -- source。scheduler 只认 once/cron；webhook 的入站路由本期不实现（spec §13），
  -- 但列与权限规则现在就落，免得将来为它再开一条平行路径。
  source_type     TEXT NOT NULL CHECK (source_type IN ('once','cron','webhook')),
  fire_at         TEXT,
  cron_expr       TEXT,
  cron_tz         TEXT,
  webhook_path    TEXT UNIQUE,
  -- 环境变量名，绝不内联存密钥。
  webhook_secret_ref TEXT,
  next_fire_at    TEXT,                       -- once/cron 有值；webhook 恒为 NULL

  -- action。source 与 action 分离是这一层可扩展的全部意义（spec §3.3）：
  -- scheduler 只是众多 source 生产者之一，webhook 将来复用同一个 action 执行器。
  action_type     TEXT NOT NULL
                  CHECK (action_type IN ('create_item','create_and_start','start_item')),
  action_payload  TEXT NOT NULL DEFAULT '{}',

  last_fired_at   TEXT,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (source_type <> 'once'    OR fire_at IS NOT NULL),
  CHECK (source_type <> 'cron'    OR cron_expr IS NOT NULL),
  CHECK (source_type <> 'webhook' OR webhook_path IS NOT NULL),

  -- (C5) 自动开跑的能力只有 user 建的 trigger 才有（spec §5.3「权限传递」）。
  -- 没有这条，lead 可以建一个 cron(*/1) → create_and_start 的 trigger，在零用户确认下
  -- 拿到运行中的 child——正是 §6.4 声称结构上不可能的事。执行器里的降级只兜住
  -- initial_stage='ready'，产 Run 这一路必须在 schema 层堵死。
  CHECK (action_type = 'create_item' OR created_by = 'user')
);
-- 幂等 + 触发历史。一个机制两种用途：cron 永不重复触发同一 occurrence，
-- webhook 将来永不重复处理同一 delivery——两者都只是往 dedup_key 里塞不同的东西。
CREATE TABLE IF NOT EXISTS trigger_fires (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id      INTEGER NOT NULL REFERENCES triggers(id),
  dedup_key       TEXT NOT NULL,   -- once/cron: occurrence ISO；webhook: 请求携带的 delivery id
  occurrence_at   TEXT NOT NULL,   -- 本次触发对应的逻辑时刻，供 action 执行器注入 remind_at
  fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','succeeded','failed')),
  error           TEXT,
  produced_item_id INTEGER REFERENCES items(id),
  UNIQUE (trigger_id, dedup_key)
);
CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER REFERENCES items(id),     -- 可空：不是所有通知都挂事项
  kind            TEXT NOT NULL,                      -- reminder | item_done | budget | crash | ...
  dedup_key       TEXT,
  urgency         TEXT NOT NULL CHECK (urgency IN ('immediate','batchable')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','delivered','acked')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  delivered_via   TEXT CHECK (delivered_via IN ('lead','fallback')),
  acked_at        TEXT
);
CREATE INDEX IF NOT EXISTS triggers_due ON triggers (next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS trigger_fires_by_trigger ON trigger_fires (trigger_id, id);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications (state, urgency, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup
  ON notifications(dedup_key) WHERE dedup_key IS NOT NULL;
`;

export const DELEGATION_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS delegation_policies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id            INTEGER REFERENCES items(id),
  mode               TEXT NOT NULL
                     CHECK (mode IN ('technical_delivery','disabled')),
  scope              TEXT NOT NULL DEFAULT 'technical_acceptance_rework_delivery',
  verification_policy TEXT NOT NULL
                     CHECK (verification_policy IN ('independent_reviewer','lead_static','user')),
  acceptance_policy  TEXT NOT NULL
                     CHECK (acceptance_policy IN ('user_only','delegated_to_lead')),
  rework_policy      TEXT NOT NULL CHECK (rework_policy IN ('ask_user','automatic')),
  delivery_policy    TEXT NOT NULL CHECK (delivery_policy IN ('notify_only','continue_workflow')),
  max_rework_cycles  INTEGER NOT NULL DEFAULT 1 CHECK (max_rework_cycles >= 0),
  budget_limit_tokens INTEGER CHECK (budget_limit_tokens IS NULL OR budget_limit_tokens >= 0),
  budget_limit_usd   REAL CHECK (budget_limit_usd IS NULL OR budget_limit_usd >= 0),
  effective_until    TEXT,
  created_by         TEXT NOT NULL CHECK (created_by IN ('user','system')),
  created_via        TEXT NOT NULL CHECK (created_via IN ('cli','control-plane','migration','test')),
  policy_version     INTEGER NOT NULL DEFAULT 1,
  escalation_conditions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(escalation_conditions)),
  revoked_at         TEXT,
  revoked_by         TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('user','system')),
  revoked_via        TEXT CHECK (revoked_via IS NULL OR revoked_via IN ('cli','control-plane','test')),
  revoke_reason      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- 授权托管时预先勾选的「核查做不成时，由 Lead 凭它读过的证据验收」（v58，工单详情与验收 spec 5.8、D11，工单 11）。
  -- 1：所有核查员都不能用时，Lead 可以按证据验收，账本标明没有独立核查。0：工单等你验收。
  -- 放在最后：老库用 ALTER 补在末尾，新库和老库的列顺序一致。
  accept_without_review INTEGER NOT NULL DEFAULT 0 CHECK (accept_without_review IN (0, 1)),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_via IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_via IS NOT NULL
      AND revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0)
  )
);
CREATE INDEX IF NOT EXISTS delegation_policies_active_item
  ON delegation_policies(item_id, revoked_at, id);

CREATE TABLE IF NOT EXISTS continuation_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER REFERENCES items(id),
  event_type      TEXT NOT NULL
                  CHECK (event_type IN (
                    'review_passed','review_failed','capability_deployed',
                    'dependency_satisfied','automation_blocked'
                  )),
  payload         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  idempotency_key TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','processed','failed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS continuation_events_pending
  ON continuation_events(state, id);

CREATE TABLE IF NOT EXISTS continuations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          INTEGER REFERENCES items(id),
  delegation_policy_id INTEGER REFERENCES delegation_policies(id),
  trigger_event    TEXT NOT NULL
                   CHECK (trigger_event IN (
                     'review_passed','review_failed','capability_deployed',
                     'dependency_satisfied','automation_blocked'
                   )),
  action_sequence  TEXT NOT NULL CHECK (json_valid(action_sequence)),
  context          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context)),
  current_step     INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN (
                     'pending','running','succeeded','failed',
                     'waiting_user','waiting_dependency','waiting_capability'
                   )),
  idempotency_key  TEXT NOT NULL UNIQUE,
  retry_count      INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries      INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  next_retry_at    TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS continuations_runnable
  ON continuations(state, next_retry_at, id);
`;

export const OUTCOME_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS outcome_snapshots (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id                 INTEGER NOT NULL REFERENCES items(id),
  executor_run_id          INTEGER NOT NULL REFERENCES runs(id),
  completion_checkpoint_id INTEGER REFERENCES checkpoints(id),
  source                  TEXT NOT NULL
                          CHECK (source IN ('agent_reported','system_recovered')),
  source_event_seq         INTEGER,
  source_output_sha256     TEXT,
  summary                 TEXT NOT NULL,
  changes_json            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes_json)),
  deliverables_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deliverables_json)),
  validations_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(validations_json)),
  completeness            TEXT NOT NULL CHECK (completeness IN ('complete','partial')),
  missing_fields_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_fields_json)),
  recovery_note           TEXT,
  content_hash            TEXT NOT NULL,
  idempotency_key         TEXT NOT NULL UNIQUE,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(executor_run_id),
  CHECK ((source = 'agent_reported' AND completion_checkpoint_id IS NOT NULL)
      OR (source = 'system_recovered')),
  CHECK ((source = 'system_recovered' AND source_output_sha256 IS NOT NULL)
      OR source = 'agent_reported')
);
CREATE INDEX IF NOT EXISTS outcome_snapshots_item
  ON outcome_snapshots(item_id, id);
`;

// 故障的恢复状态（工单 04）。新库的 DDL 和 v29 迁移共用这一份定义。
// next_probe_at：下一次探针的绝对时间。daemon 重启后只等剩下的时间。
// probe_failures：连续失败的次数。探针失败算一次，探针关闭后马上又同样失败也算一次。退避按它加倍。
// canary_armed_at、canary_run_id：2026-10-20 以前的金丝雀状态。现在不再写，列保留（不加迁移）；
// 旧数据里不为空、还没关闭的故障由恢复 tick 关闭（runtime-health.ts 的 closeLegacyCanaryIncidents）。
export const RUNTIME_INCIDENT_RECOVERY_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["next_probe_at", "TEXT"],
  ["probe_failures", "INTEGER NOT NULL DEFAULT 0"],
  ["last_probe_at", "TEXT"],
  ["last_probe_error", "TEXT"],
  ["canary_armed_at", "TEXT"],
  ["canary_run_id", "INTEGER REFERENCES runs(id)"],
];

// 健康账本（spec D2，工单 03）。新库的 DDL 和 v27 迁移共用这一份定义。
// runtime_health 是账本每一项的当前状态。level='profile' 的一项管整个 profile；
// level='model' 的一项只管"profile 加模型"，model 为空串时指 CLI 的默认模型。
// runtime_incidents 是历史。每次进入 unavailable 开启一次故障，用户通知以故障 id 去重。
// 账本的同一项同时最多有一次没关闭的故障，由部分唯一索引保证。
export const RUNTIME_HEALTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_incidents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_key   TEXT NOT NULL,
  runtime       TEXT NOT NULL,
  executable    TEXT NOT NULL,
  config_dir    TEXT,
  level         TEXT NOT NULL CHECK (level IN ('profile','model')),
  model         TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL CHECK (scope IN ('runtime','account')),
  retry         TEXT NOT NULL CHECK (retry IN (${quoted(FAILURE_RETRIES)})),
  needs         TEXT NOT NULL CHECK (needs IN (${quoted(FAILURE_NEEDS)})),
  code          TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  opened_item_id INTEGER REFERENCES items(id),
  opened_run_id INTEGER REFERENCES runs(id),
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  close_reason  TEXT,
${RUNTIME_INCIDENT_RECOVERY_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
  CHECK (level = 'model' OR model = ''),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_incidents_open
  ON runtime_incidents(profile_key, level, model) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS runtime_health (
  profile_key   TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('profile','model')),
  model         TEXT NOT NULL DEFAULT '',
  runtime       TEXT NOT NULL,
  executable    TEXT NOT NULL,
  config_dir    TEXT,
  status        TEXT NOT NULL DEFAULT 'healthy'
                CHECK (status IN ('healthy','degraded','unavailable')),
  incident_id   INTEGER REFERENCES runtime_incidents(id),
  -- degraded 的绝对恢复时间。本工单不写 degraded，退避由工单 06 实现。
  recover_at    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (profile_key, level, model),
  CHECK (level = 'model' OR model = ''),
  CHECK ((status = 'unavailable') = (incident_id IS NOT NULL))
);
`;

// 派发请求上的挂起事实（工单 03）。新库的 DDL 和 v27 迁移共用这一份定义。
// retry_of_run_id：内核为这个失败的 Run 自动排的重试。工单之后又跑了新的 Run，这个重试就作废。
export const DISPATCH_SUSPENSION_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["suspended_reason", "TEXT"],
  ["suspended_incident_id", "INTEGER REFERENCES runtime_incidents(id)"],
  ["retry_of_run_id", "INTEGER REFERENCES runs(id)"],
];

// 内核的退避重试（spec D5，工单 06）。新库的 DDL 和 v32 迁移共用这一份定义。
// not_before：不早于这个绝对时间才能 claim。daemon 重启后只等剩下的时间。
// backoff_attempt：这是瞬时失败之后的第几次自动重试，从 1 开始。其他请求为空。
export const DISPATCH_BACKOFF_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["not_before", "TEXT"],
  ["backoff_attempt", "INTEGER CHECK (backoff_attempt IS NULL OR backoff_attempt >= 1)"],
];

// 工单节点（v40，左栏改版阶段 3）：截止、提测、发布、核查、自定义，带出处；每次改动一行 change，没有硬删除。
// 只新增表：items 的 due_at / defer_until / remind_at / due_overdue_notified 全部保留，due_at 由 milestones.ts 同步。
export const ITEM_MILESTONES_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_milestones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id),
  kind           TEXT NOT NULL CHECK (kind IN ('due','test_handoff','release','review','custom')),
  label          TEXT,
  at             TEXT NOT NULL,
  all_day        INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  tz             TEXT,
  state          TEXT NOT NULL DEFAULT 'planned'
                 CHECK (state IN ('planned','done','missed','cancelled')),
  source_actor   TEXT NOT NULL CHECK (source_actor IN ('user','lead','child','system')),
  source_run_id  INTEGER REFERENCES runs(id),
  source_turn_id TEXT REFERENCES channel_turns(id),
  source_quote   TEXT,
  confidence     TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT,
  CHECK (kind <> 'custom' OR label IS NOT NULL),
  CHECK (source_actor IN ('lead','child') OR confidence IS NULL)
);
CREATE INDEX IF NOT EXISTS item_milestones_at ON item_milestones (at) WHERE state = 'planned';
CREATE INDEX IF NOT EXISTS item_milestones_item ON item_milestones (item_id, at);
CREATE TRIGGER IF NOT EXISTS item_milestones_task_only
BEFORE INSERT ON item_milestones
WHEN (SELECT kind FROM items WHERE id = NEW.item_id) IS NOT 'task'
BEGIN SELECT RAISE(ABORT, 'milestones belong to tasks'); END;
CREATE TABLE IF NOT EXISTS item_milestone_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id  INTEGER NOT NULL REFERENCES item_milestones(id),
  actor         TEXT NOT NULL CHECK (actor IN ('user','lead','child','system')),
  run_id        INTEGER REFERENCES runs(id),
  change        TEXT NOT NULL CHECK (change IN ('created','moved','relabeled','completed','missed','cancelled','restored')),
  before_json   TEXT,
  after_json    TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_milestone_changes_milestone ON item_milestone_changes (milestone_id, id);
`;

// 连接（v42，设置页的「连接」）：第三方账号的授权。daemon 是唯一的 OAuth 客户端和远程 MCP 客户端。
// 令牌只以密文存在 secret_cipher 里（AES-256-GCM，密钥在 Keychain，见 packages/connections 的 vault.ts）。
// 一个 MCP 地址只有一行：断开时清掉密文和工具缓存，status 改成 disconnected，设置（谁能用、写入策略）保留，
// 重新连接时复用这一行。续期中的状态不落库：进程内由单飞保证，跨进程由 lease_owner / lease_until 的租约保证。
export const CONNECTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  issuer         TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('dcr','cimd')),
  secret_cipher  BLOB,
  registered_at  TEXT NOT NULL,
  PRIMARY KEY (issuer, redirect_uri)
);
CREATE TABLE IF NOT EXISTS connections (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  provider             TEXT NOT NULL,
  label                TEXT NOT NULL,
  server_url           TEXT NOT NULL UNIQUE,
  token_source         TEXT NOT NULL CHECK (token_source IN ('oauth','gh_cli','device','pat')),
  status               TEXT NOT NULL CHECK (status IN ('connected','degraded','needs_reauth','disconnected')),
  issuer               TEXT,
  token_endpoint       TEXT,
  revocation_endpoint  TEXT,
  client_id            TEXT,
  account_label        TEXT,
  scopes               TEXT,
  access_expires_at    TEXT,
  grant_expires_at     TEXT,
  last_refresh_at      TEXT,
  last_used_at         TEXT,
  last_ok_at           TEXT,
  failure_kind         TEXT CHECK (failure_kind IS NULL OR failure_kind IN
                         ('transient','invalid_grant','invalid_client','insufficient_scope','unavailable')),
  failure_detail       TEXT,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT,
  lease_owner          TEXT,
  lease_until          TEXT,
  roles                TEXT NOT NULL DEFAULT '["lead","executor","reviewer"]',
  write_policy         TEXT NOT NULL DEFAULT 'confirm' CHECK (write_policy IN ('confirm','direct')),
  tools_json           TEXT,
  tools_fetched_at     TEXT,
  secret_cipher        BLOB,
  secret_version       INTEGER NOT NULL DEFAULT 0,
  connected_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id  INTEGER NOT NULL REFERENCES connections(id),
  kind           TEXT NOT NULL,
  detail         TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connection_events_connection ON connection_events (connection_id, id);
`;

// Lead 在等用户的下一步（v49，2026-10-19，protocol 的 lead-waits.ts）。一行是一条等待：挂在一个对象上（entity_key，
// 和事件日志的 entity_key 同一套写法），带 Lead 的备注、超时和「需要用户做什么」的结构化数据（user_action，JSON）。
// state：waiting 在等；satisfied 等到了（resolved_by_seq 是了结它的那条事件）；expired 超时；cancelled 取消。
// 同一个对象同时只有一条在等的（部分唯一索引）：再登记时合并进那一条。了结的行留 7 天后清理（store 的 purgeLeadWaits）。
// 时间都存 ISO（和事件日志一样），按字符串比较先后。
export const LEAD_WAITS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_waits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key       TEXT NOT NULL,
  note             TEXT NOT NULL,
  origin           TEXT NOT NULL,
  user_action      TEXT,
  must_tell        INTEGER NOT NULL DEFAULT 0 CHECK (must_tell IN (0, 1)),
  state            TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','satisfied','expired','cancelled')),
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by_seq  INTEGER,
  resolution       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_waits_one_open ON lead_waits (entity_key) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS lead_waits_expiry ON lead_waits (expires_at) WHERE state = 'waiting';
`;

// 事件日志（v43，Lead 事件主干 spec D1）：所有输入都是事件，只追加。写入只走 events.ts 的 appendEvent，
// 它和事件引起的状态变化在同一个事务里提交。
//   - (source, source_ref) 唯一：同一次投递只记一条。source_ref 为空的不参与（SQLite 的 UNIQUE 不比较 NULL）。
//   - level、disposition 不加 CHECK：取值在 packages/protocol 的 events.ts 里校验。SQLite 改不了 CHECK，
//     以后加取值时不用重建这张表。
//   - correlation_id：第 1 期双写时，它指向承载这件事的那一行（inbox:<id>、notification:<id>）。那一行被处置、
//     被撤回时，按它找到同一件事的所有事件。
// 下面两个触发器：撤回 blocker 的几处代码直接 DELETE 掉 inbox 行和通知（blockers.ts、terminal-handoff.ts、
// outcome-recovery.ts）。事件不删，标成 superseded，否则它们永远没有处置。
export const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,
  source             TEXT NOT NULL,
  source_ref         TEXT,
  kind               TEXT NOT NULL,
  entity_key         TEXT NOT NULL,
  entity_version     INTEGER,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  causation_id       TEXT,
  correlation_id     TEXT,
  payload            TEXT NOT NULL DEFAULT '{}',
  root_cause         TEXT,
  level              TEXT,
  disposition        TEXT,
  disposition_detail TEXT,
  disposed_at        TEXT,
  triage             TEXT,
  UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS events_entity ON events (entity_key, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq);
CREATE INDEX IF NOT EXISTS events_correlation ON events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_undisposed ON events (received_at)
  WHERE disposition IS NULL AND level IS NOT NULL AND level <> 'record';
CREATE TRIGGER IF NOT EXISTS events_inbox_retracted AFTER DELETE ON inbox BEGIN
  UPDATE events SET disposition = 'superseded',
    disposition_detail = '{"reason":"inbox row retracted"}',
    disposed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE correlation_id = 'inbox:' || old.id AND disposition IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS events_notification_retracted AFTER DELETE ON notifications BEGIN
  UPDATE events SET disposition = 'superseded',
    disposition_detail = '{"reason":"notification retracted"}',
    disposed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE correlation_id = 'notification:' || old.id AND disposition IS NULL;
END;
`;

// 常设指令（v44，Lead 事件主干 spec D4，工单 05）：规则层按它给事件定级别、合并、升级，写在代码里的几条规则从它读参数。
// 每次修改写一个新版本，旧版本保留：(order_id, version) 是主键，两个触发器拒绝 UPDATE 和 DELETE。
// condition、action、limits 是 JSON，形状和校验在 packages/protocol 的 standing-orders.ts。author、status 不加 CHECK，
// 理由和 events 一样：取值在代码里校验，以后加取值（例如 Jev 的影子开关）不用重建这张表。
// seed_revision：系统种子的修订号，只有 system 写的版本有。openDb 同步系统指令时只往前走：库里最新版本是 system 写的、
// 并且修订号小于代码里的，才写新版本。部署时新旧两版代码的进程会同时打开同一个库，这样版本不会来回变。
// v44 同时给 events 加了一列 triage（JSON）：这个事件的级别依据哪条常设指令的哪一版（TriageBasis）。
export const STANDING_ORDERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS standing_orders (
  order_id     TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  title        TEXT NOT NULL,
  priority     INTEGER NOT NULL,
  condition    TEXT NOT NULL,
  action       TEXT NOT NULL,
  limits       TEXT,
  escalate_to  TEXT,
  author       TEXT NOT NULL,
  approved_by  TEXT,
  status       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  seed_revision INTEGER,
  PRIMARY KEY (order_id, version)
);
CREATE TRIGGER IF NOT EXISTS standing_orders_append_only_update BEFORE UPDATE ON standing_orders BEGIN
  SELECT RAISE(ABORT, 'standing_orders is append-only: write a new version');
END;
CREATE TRIGGER IF NOT EXISTS standing_orders_append_only_delete BEFORE DELETE ON standing_orders BEGIN
  SELECT RAISE(ABORT, 'standing_orders is append-only: write a new version');
END;
`;

// Jev 分诊的影子判断（v45，Lead 事件主干 spec D12，工单 09）：daemon 在后台按批问 Jev，判断只记在这里，
// 不改 events 的级别、依据和处置。一个事件最多一条（seq 唯一），只追加：两个触发器拒绝 UPDATE 和 DELETE。
//   - level、auto_action、risk 是从回答里取出的结论，方便按类型算一致率；answers 是完整的回答（每个选项的概率）。
//   - auto_action 是常设指令的编号，NULL 表示 Jev 判断不能自动处理；action_options 是问的时候给了哪些指令的哪一版。
//   - 问不了的事件（输入不合法）也记一行：answers 是 NULL，error 写原因。这样它不会每一拍都被重新问。
//   - 不对 events(seq) 加外键：事件日志以后可能压缩，影子表不能挡住它。按 seq 关联，关联不上的不进报告。
//   - level、mode、risk 不加 CHECK：取值在代码里校验，理由和 events 一样。
export const EVENT_TRIAGE_SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_triage_shadow (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  seq                    INTEGER NOT NULL UNIQUE,
  event_id               TEXT NOT NULL,
  judged_at              TEXT NOT NULL,
  mode                   TEXT NOT NULL,
  question_version       INTEGER NOT NULL,
  backend                TEXT NOT NULL,
  model                  TEXT,
  latency_ms             INTEGER,
  level                  TEXT,
  level_confidence       REAL,
  needs_lead             REAL,
  auto_action            TEXT,
  auto_action_confidence REAL,
  risk                   TEXT,
  risk_score             REAL,
  action_options         TEXT NOT NULL DEFAULT '[]',
  answers                TEXT,
  error                  TEXT
);
CREATE INDEX IF NOT EXISTS event_triage_shadow_judged ON event_triage_shadow (judged_at);
CREATE TRIGGER IF NOT EXISTS event_triage_shadow_append_only_update BEFORE UPDATE ON event_triage_shadow BEGIN
  SELECT RAISE(ABORT, 'event_triage_shadow is append-only');
END;
CREATE TRIGGER IF NOT EXISTS event_triage_shadow_append_only_delete BEFORE DELETE ON event_triage_shadow BEGIN
  SELECT RAISE(ABORT, 'event_triage_shadow is append-only');
END;
`;

// 通道（v46，Lead 事件主干 spec D10、D14，工单 11）：外部来源（对话型、信号型）的消息先写进事件日志（events），
// 再由 engine 的通道 hub 投影成这两张表。审计（闸门的每一次判断、出站动作、自动回复、撤回、用户的动作）都是事件，
// 不在这里；这里只放会变的状态。
//   - channel_lanes：分道，每个对话（对象键，例如 <来源>:<频道>:<线程>）一条道。context 是这条道最近的几条消息（JSON，
//     有上限），起草器在道里起草时读它；summary 是一行摘要，Lead 的当前局面里只放它。
//   - channel_cards：会话卡，一个对话同一时间最多一张没结束的卡（部分唯一索引），状态原地更新，version 每次加 1。
//     卡结束以后同一个对话又来了消息，开一张新卡。sender、reply_target、draft、gate、sent、resolution 是 JSON。
// state、delivery 不加 CHECK：取值在 packages/protocol 的 channels.ts 里校验，理由和 events 一样。
export const CHANNELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_lanes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  object_key  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '[]',
  summary     TEXT NOT NULL DEFAULT '',
  last_seq    INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id        INTEGER NOT NULL REFERENCES channel_lanes(id),
  source         TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL,
  delivery       TEXT NOT NULL,
  first_seq      INTEGER NOT NULL,
  last_seq       INTEGER NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 1,
  sender         TEXT NOT NULL,
  excerpt        TEXT NOT NULL,
  reply_target   TEXT NOT NULL DEFAULT '{}',
  draft          TEXT,
  gate           TEXT,
  sent           TEXT,
  snoozed_until  TEXT,
  revoke_until   TEXT,
  resolved_at    TEXT,
  resolution     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_cards_one_open ON channel_cards (object_key)
  WHERE state IN ('open', 'snoozed', 'replying_self');
CREATE INDEX IF NOT EXISTS channel_cards_lane ON channel_cards (lane_id, id);
CREATE INDEX IF NOT EXISTS channel_cards_updated ON channel_cards (updated_at);
`;

// 代查（v50，Slack 代查与按信心代回 spec D1，.scratch/slack-takeover/spec.md）：一行是一次代查。卡（channel_cards）和
// 代查工单（items、runs）都通过它关联；不改 channel_cards 的结构。一张卡同一时间最多一次没结束的代查（部分唯一索引），
// 状态原地更新，version 每次加 1。requester、intake、scope、result、reads、verification、reply 是 JSON，
// 形状在 packages/protocol 的 channel-lookup.ts 和 store 的 channel-lookups.ts。question 是对方的原话（截断过，不可信）。
// playbook、state 不加 CHECK：取值在 protocol 里校验，理由和 channel_cards 一样。
export const CHANNEL_LOOKUPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_lookups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       INTEGER NOT NULL REFERENCES channel_cards(id),
  source        TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  for_seq       INTEGER NOT NULL,
  playbook      TEXT NOT NULL,
  state         TEXT NOT NULL,
  requester     TEXT NOT NULL,
  question      TEXT NOT NULL,
  intake        TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '{}',
  item_id       INTEGER REFERENCES items(id),
  run_id        INTEGER REFERENCES runs(id),
  result        TEXT,
  reads         TEXT NOT NULL DEFAULT '[]',
  verification  TEXT,
  reply         TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_lookups_one_active ON channel_lookups(card_id) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS channel_lookups_item ON channel_lookups(item_id);
CREATE INDEX IF NOT EXISTS channel_lookups_card ON channel_lookups(card_id, id);
`;

// 交付快照（v52，工单 04，spec 5.5、D8）。一行是一次交付的一份快照：执行 agent 交付的那一刻，系统跑 git diff 存下来；
// 交付以后工作区又变了，同一次交付再存一份（revision 加 1）。工作区清理以后，交付的文件列表还在。
// - sequence：第几次交付，从 1 开始。返工后再交付是 2。revision：同一次交付的第几份。
// - reason：delivered 是交付时存的；workspace_changed 是交付以后工作区又变了。
// - source：git 是系统跑 diff 得到的（隔离分支）；agent 是执行 agent 自己报的 outcome.changes（不是隔离分支的工单）。
// - backfilled：交付时没有存（v52 以前的交付、或者交付时没存成），打开工单时补存的。
// - trigger_run_id、trigger_kind：存这一份的时候刚结束的那个 Run 和它的用途（对话、核查、执行、其他）。
//   打开交付视图时发现的，两列都是 NULL。返工中取消的工单，返工的执行 Run 记成 execution（工单 04 审查 L3）。
// - uncommitted_files：存的时候 worktree 里没提交的文件数。git status 失败时为 NULL，不拿它比较。
// - files_json：文件列表，最多 2000 个（engine delivery-snapshot.ts 的 DELIVERY_MAX_FILES），超过时 truncated=1。
//   file_count、additions、deletions 算全部改动的文件。source=agent 时没有行数，三列都是 NULL。
// 一次交付只有一份 delivered（部分唯一索引）。快照只增不改。
export const DELIVERY_SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id              INTEGER NOT NULL REFERENCES items(id),
  sequence             INTEGER NOT NULL CHECK (sequence >= 1),
  revision             INTEGER NOT NULL CHECK (revision >= 1),
  executor_run_id      INTEGER NOT NULL REFERENCES runs(id),
  outcome_snapshot_id  INTEGER REFERENCES outcome_snapshots(id),
  reason               TEXT NOT NULL CHECK (reason IN ('delivered','workspace_changed')),
  source               TEXT NOT NULL CHECK (source IN ('git','agent')),
  backfilled           INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  trigger_run_id       INTEGER REFERENCES runs(id),
  trigger_kind         TEXT CHECK (trigger_kind IN ('conversation','review','execution','other')),
  workspace_id         INTEGER REFERENCES workspaces(id),
  base_sha             TEXT,
  head_sha             TEXT,
  commits_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(commits_json)),
  commit_count         INTEGER NOT NULL DEFAULT 0 CHECK (commit_count >= 0),
  files_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_json)),
  file_count           INTEGER CHECK (file_count >= 0),
  additions            INTEGER CHECK (additions >= 0),
  deletions            INTEGER CHECK (deletions >= 0),
  truncated            INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  uncommitted_files    INTEGER CHECK (uncommitted_files >= 0),
  created_at           TEXT NOT NULL,
  UNIQUE (item_id, sequence, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_snapshots_one_delivered ON delivery_snapshots(executor_run_id) WHERE reason = 'delivered';
CREATE INDEX IF NOT EXISTS delivery_snapshots_item ON delivery_snapshots(item_id, sequence, revision);
`;

// 执行计划（v53，工单详情与验收 spec 5.2，工单 06）：执行 agent 用 update_ticket_plan 提交的步骤列表。只追加，每次更新一行：
// 整张列表（steps 是 JSON 数组，形状和校验在 execution-plans.ts）、提交它的 Run、时间。最新的一行是现在的计划。
// 只属于 task（触发器，和 item_milestones 一样）。不加 UPDATE、DELETE 的入口：这张表是计划更新的账本。
// 不叫 item_plan_revisions：那个名字是拆子工单的规划版本（DELEGATION_WORKFLOW_SCHEMA），CREATE TABLE IF NOT EXISTS
// 撞名时不报错，只会跳过这张表。
export const EXECUTION_PLANS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_execution_plans (
  item_id     INTEGER NOT NULL REFERENCES items(id),
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  steps       TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps) = 'array'),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, revision)
);
CREATE TRIGGER IF NOT EXISTS item_execution_plans_task_only
BEFORE INSERT ON item_execution_plans
WHEN (SELECT kind FROM items WHERE id = NEW.item_id) IS NOT 'task'
BEGIN SELECT RAISE(ABORT, 'execution plans belong to tasks'); END;
`;

// 子 agent 的权限清单（v55，.scratch/confidence-model/landing.md 第 5 节）。形状在 protocol 的 run-grants.ts，
// 读写在 store 的 run-grants.ts。
// - run_grants：一个 Run 一行，现在生效的清单（grant_json）。bound_json 是派工单时的上限，scope_json 是 Lead 选的范围，
//   dropped_json 是超出上限被丢掉的部分。revision 每改一次加一。连接中心每次调用都读这一行。
// - run_grant_changes：清单的账本，只追加：建（created）、用户放宽（widened）、撤销一次放宽（reverted）。
//   rules_json 是这一次加上（或撤销时删掉）的规则；actor 和 on_behalf_turn_id 写谁做的、凭哪一轮。
// - run_tool_calls：带清单的 Run 经连接中心的每一次调用：放行的、拒绝的（带原因）、写操作的结果和链接。
//   这是审计，也是交回结果时「做了哪些动作」的出处（不信子 agent 自己说的）。
export const RUN_GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_grants (
  run_id        INTEGER PRIMARY KEY REFERENCES runs(id),
  item_id       INTEGER NOT NULL REFERENCES items(id),
  intent        TEXT NOT NULL,
  grant_json    TEXT NOT NULL CHECK (json_valid(grant_json)),
  bound_json    TEXT NOT NULL CHECK (json_valid(bound_json)),
  scope_json    TEXT NOT NULL CHECK (json_valid(scope_json)),
  dropped_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped_json)),
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_grants_item ON run_grants(item_id);
CREATE TABLE IF NOT EXISTS run_grant_changes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES runs(id),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  change             TEXT NOT NULL CHECK (change IN ('created','widened','reverted')),
  rules_json         TEXT NOT NULL CHECK (json_valid(rules_json)),
  local_repos_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(local_repos_json)),
  actor              TEXT NOT NULL CHECK (actor IN ('user','lead','system')),
  on_behalf_turn_id  TEXT,
  reason             TEXT,
  reverts_change_id  INTEGER REFERENCES run_grant_changes(id),
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_grant_changes_run ON run_grant_changes(run_id, id);
CREATE TABLE IF NOT EXISTS run_tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  item_id       INTEGER NOT NULL REFERENCES items(id),
  connection    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  access        TEXT NOT NULL CHECK (access IN ('read','write')),
  decision      TEXT NOT NULL CHECK (decision IN ('allowed','refused')),
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('ok','error','failed')),
  reason        TEXT,
  rule_id       TEXT,
  target        TEXT,
  summary       TEXT,
  url           TEXT,
  -- 写操作别人看不看得到（例如提交了的 review 看得到，没提交的 pending review 看不到）。读和拒绝的是 NULL。
  visible       INTEGER CHECK (visible IS NULL OR visible IN (0, 1)),
  args_preview  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_tool_calls_run ON run_tool_calls(run_id, id);
`;

// 结构化验收标准（v54，工单详情与验收 spec 4.3、5.1、D5、D6，工单 05）。规则和写入在 acceptance-criteria.ts。
// item_acceptance_criteria：一条一行。id 稳定；position 是现在的顺序（没删的从 1 连续编号）；revision 是文字的版本，
// 改了文字加 1。created_by 是谁写的：Lead、你、执行 agent（child，拆子工单时），或者 system（PR 评审模板抄入你的原话）。
// edited_* 是最后一次改文字，updated_at 是最后一次任何改动（包括挪顺序）。删除只标 deleted_*，行留着：确认和账本还指着它。
// criterion_confirmations：你对某次交付（04 的交付快照：executor_run_id 是这次交付，delivery_snapshot_id 是你看的那一份）的
// 某一条的确认。取消、或者那一条后来被改了、删了，就结束这一行（ended_*、end_reason），不删除；再确认是新的一行。
// 同一次交付的同一条只有一个有效的确认（部分唯一索引）。确认只属于你：Lead 代你确认时必须写明代谁、凭哪一轮（CHECK）。
// item_acceptance_criterion_revisions：每一版文字（建的时候第 1 版，改一次加一版）。切回历史交付时显示那次的那一版（审查 M4）。
// executor_criteria_views：执行者启动时在提示里看到的每一条和版本（JSON 数组 [{id, revision}]，一个 Run 一行，
// 开新会话重试时以最后一次为准）。用来判断「执行者做的不是现在这一版」（审查 M2）。
// 只属于 task（触发器，和执行计划一样）。
export const ACCEPTANCE_CRITERIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_acceptance_criteria (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  text            TEXT NOT NULL CHECK (length(text) >= 1),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by      TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_run_id  INTEGER REFERENCES runs(id),
  created_at      TEXT NOT NULL,
  edited_by       TEXT CHECK (edited_by IN ('user','lead')),
  edited_at       TEXT,
  updated_at      TEXT NOT NULL,
  deleted_by      TEXT CHECK (deleted_by IN ('user','lead')),
  deleted_at      TEXT,
  CHECK ((edited_by IS NULL) = (edited_at IS NULL)),
  CHECK ((deleted_by IS NULL) = (deleted_at IS NULL))
);
CREATE INDEX IF NOT EXISTS item_acceptance_criteria_item ON item_acceptance_criteria(item_id, position);
CREATE TRIGGER IF NOT EXISTS item_acceptance_criteria_task_only
BEFORE INSERT ON item_acceptance_criteria
WHEN (SELECT kind FROM items WHERE id = NEW.item_id) IS NOT 'task'
BEGIN SELECT RAISE(ABORT, 'acceptance criteria belong to tasks'); END;
CREATE TABLE IF NOT EXISTS criterion_confirmations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id               INTEGER NOT NULL REFERENCES items(id),
  criterion_id          INTEGER NOT NULL REFERENCES item_acceptance_criteria(id),
  criterion_revision    INTEGER NOT NULL CHECK (criterion_revision >= 1),
  executor_run_id       INTEGER NOT NULL REFERENCES runs(id),
  delivery_snapshot_id  INTEGER NOT NULL REFERENCES delivery_snapshots(id),
  confirmed_by          TEXT NOT NULL CHECK (confirmed_by IN ('user','lead')),
  on_behalf_of          TEXT,
  source_turn_id        TEXT,
  confirmed_at          TEXT NOT NULL,
  ended_by              TEXT CHECK (ended_by IN ('user','lead')),
  ended_at              TEXT,
  end_reason            TEXT CHECK (end_reason IN ('unconfirmed','criterion_edited','criterion_deleted')),
  CHECK (
    (confirmed_by = 'user' AND on_behalf_of IS NULL AND source_turn_id IS NULL)
    OR (confirmed_by = 'lead' AND on_behalf_of = 'user' AND source_turn_id IS NOT NULL)
  ),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS criterion_confirmations_one_active
  ON criterion_confirmations(criterion_id, executor_run_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS criterion_confirmations_delivery ON criterion_confirmations(item_id, executor_run_id);
CREATE TABLE IF NOT EXISTS item_acceptance_criterion_revisions (
  criterion_id  INTEGER NOT NULL REFERENCES item_acceptance_criteria(id),
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  text          TEXT NOT NULL CHECK (length(text) >= 1),
  written_by    TEXT NOT NULL CHECK (written_by IN ('user','lead','child','system')),
  written_at    TEXT NOT NULL,
  PRIMARY KEY (criterion_id, revision)
);
CREATE TABLE IF NOT EXISTS executor_criteria_views (
  run_id         INTEGER PRIMARY KEY REFERENCES runs(id),
  item_id        INTEGER NOT NULL REFERENCES items(id),
  criteria_json  TEXT NOT NULL CHECK (json_valid(criteria_json) AND json_type(criteria_json) = 'array'),
  seen_at        TEXT NOT NULL
);
`;

// 核查员设置（v56，工单详情与验收 spec 5.6、D3，工单 09）：Lead 建单时为这张工单选的核查员，或者之后 Lead、用户换的。
// 一张工单一行：runtime，以及可选的模型和推理强度。没有这一行时，核查员由系统选（engine 的 reviewer-choice.ts）。
// 读写只走 reviewer-settings.ts 的 getReviewerSetting、setReviewerSetting。只属于 task（触发器，和 item_execution_plans 一样）。
// runtime 在代码里核对（store 不写 runtime 的名字，见 apps/daemon/test/runtime-architecture.test.ts）。
export const REVIEWER_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_reviewer_settings (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id),
  runtime     TEXT NOT NULL,
  model       TEXT,
  effort      TEXT,
  chosen_by   TEXT NOT NULL CHECK (chosen_by IN ('user','lead')),
  reason      TEXT,
  updated_at  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS item_reviewer_settings_task_only
BEFORE INSERT ON item_reviewer_settings
WHEN (SELECT kind FROM items WHERE id = NEW.item_id) IS NOT 'task'
BEGIN SELECT RAISE(ABORT, 'reviewer settings belong to tasks'); END;
`;

// 核查包和逐条结论（v57，工单详情与验收 spec 5.7、5.9、D8，工单 10）。读写只走 review-packets.ts。
// review_packets：派发核查时系统拼好的核查包（engine 的 review-packet.ts），一个核查 Run 一份，存下以后不改。
//   executor_run_id 是要核查的交付（最新一次交付的执行 Run），delivery_sequence、delivery_snapshot_id 是它的快照（04）。
//   previous_run_id：复核时上一次有结论的核查 Run。
// review_verdict_details：review_verdict 里结构化的那一部分：要不要升级给你（escalate，原因从固定的几种里选）。
//   review_verdicts 仍是「有没有结论」的事实：核查员交结论时先写这里，结论在 review_verdicts 落定以后，这一行就不能再改（触发器）。
//   有工作区的核查要等 Run 结束、比过工作区指纹才落定（manager.ts），之前核查员重交时整行换掉。
// review_criterion_verdicts：逐条结论，每条验收标准一行，记下核查员看到的那一版（criterion_revision）。规则和上一张表一样。
//   按交付查（executor_run_id），和你的逐条确认（criterion_confirmations）放在同一次交付里。
export const REVIEW_PACKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_packets (
  run_id                INTEGER PRIMARY KEY REFERENCES runs(id),
  item_id               INTEGER NOT NULL REFERENCES items(id),
  executor_run_id       INTEGER REFERENCES runs(id),
  delivery_sequence     INTEGER CHECK (delivery_sequence IS NULL OR delivery_sequence >= 1),
  delivery_snapshot_id  INTEGER REFERENCES delivery_snapshots(id),
  previous_run_id       INTEGER REFERENCES runs(id),
  packet_json           TEXT NOT NULL CHECK (json_valid(packet_json)),
  summary_json          TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_packets_delivery ON review_packets(item_id, executor_run_id);
CREATE TRIGGER IF NOT EXISTS review_packets_immutable
BEFORE UPDATE ON review_packets
BEGIN SELECT RAISE(ABORT, 'a review packet is immutable'); END;
CREATE TABLE IF NOT EXISTS review_verdict_details (
  run_id           INTEGER PRIMARY KEY REFERENCES runs(id),
  item_id          INTEGER NOT NULL REFERENCES items(id),
  executor_run_id  INTEGER REFERENCES runs(id),
  escalate_reason  TEXT CHECK (escalate_reason IS NULL OR escalate_reason IN
                     ('evidence_conflict','requirement_change','irreversible_action','external_approval')),
  escalate_note    TEXT,
  submitted_at     TEXT NOT NULL,
  CHECK ((escalate_reason IS NULL) = (escalate_note IS NULL))
);
CREATE TRIGGER IF NOT EXISTS review_verdict_details_settled_update
BEFORE UPDATE ON review_verdict_details
WHEN EXISTS (SELECT 1 FROM review_verdicts WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'review verdict details are immutable once the verdict is recorded'); END;
CREATE TRIGGER IF NOT EXISTS review_verdict_details_settled_delete
BEFORE DELETE ON review_verdict_details
WHEN EXISTS (SELECT 1 FROM review_verdicts WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'review verdict details are immutable once the verdict is recorded'); END;
CREATE TABLE IF NOT EXISTS review_criterion_verdicts (
  run_id              INTEGER NOT NULL REFERENCES runs(id),
  item_id             INTEGER NOT NULL REFERENCES items(id),
  executor_run_id     INTEGER REFERENCES runs(id),
  criterion_id        INTEGER NOT NULL REFERENCES item_acceptance_criteria(id),
  criterion_revision  INTEGER NOT NULL CHECK (criterion_revision >= 1),
  position            INTEGER NOT NULL CHECK (position >= 1),
  result              TEXT NOT NULL CHECK (result IN ('pass','fail','unverifiable')),
  evidence            TEXT NOT NULL CHECK (length(evidence) >= 1),
  PRIMARY KEY (run_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS review_criterion_verdicts_delivery ON review_criterion_verdicts(item_id, executor_run_id);
CREATE TRIGGER IF NOT EXISTS review_criterion_verdicts_settled_update
BEFORE UPDATE ON review_criterion_verdicts
WHEN EXISTS (SELECT 1 FROM review_verdicts WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'review criterion verdicts are immutable once the verdict is recorded'); END;
CREATE TRIGGER IF NOT EXISTS review_criterion_verdicts_settled_delete
BEFORE DELETE ON review_criterion_verdicts
WHEN EXISTS (SELECT 1 FROM review_verdicts WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'review criterion verdicts are immutable once the verdict is recorded'); END;
`;

// 后台检查（.scratch/lead-watch/spec.md，v59）：Lead 设好以后系统按时检查，有结果才叫醒 Lead。
// 一个检查是一条命令（在 Lead 的 bash 沙箱里跑，退出码 0 算通过）或一个轻子 agent。
// until：检查到通过或到期为止；repeat：按 cron 或间隔一直检查，直到取消。
// 规则（triggers）的 C5 不变：Lead 建的规则仍然只建单。到点能自己运行的只有这张表里的检查（spec D4）。
export const WATCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  label               TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  check_kind          TEXT NOT NULL CHECK (check_kind IN ('command','agent')),
  command             TEXT,
  brief               TEXT,
  agent_json          TEXT CHECK (agent_json IS NULL OR json_valid(agent_json)),
  mode                TEXT NOT NULL CHECK (mode IN ('until','repeat')),
  every_seconds       INTEGER CHECK (every_seconds IS NULL OR every_seconds >= 1),
  cron_expr           TEXT,
  cron_tz             TEXT,
  until_at            TEXT,
  note                TEXT NOT NULL DEFAULT '',
  item_id             INTEGER REFERENCES items(id),
  origin_json         TEXT NOT NULL CHECK (json_valid(origin_json)),
  set_by_json         TEXT CHECK (set_by_json IS NULL OR json_valid(set_by_json)),
  state               TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','done','cancelled')),
  ended_reason        TEXT,
  next_check_at       TEXT,
  running_since       TEXT,
  last_status         TEXT CHECK (last_status IS NULL OR last_status IN ('pass','fail','error')),
  last_checked_at     TEXT,
  last_output         TEXT,
  check_count         INTEGER NOT NULL DEFAULT 0,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (check_kind <> 'command' OR (command IS NOT NULL AND length(command) BETWEEN 1 AND 4000)),
  CHECK (check_kind <> 'agent' OR (brief IS NOT NULL AND length(brief) BETWEEN 1 AND 8000)),
  CHECK (mode <> 'until' OR (until_at IS NOT NULL AND every_seconds IS NOT NULL)),
  CHECK (mode <> 'repeat' OR cron_expr IS NOT NULL OR every_seconds IS NOT NULL),
  CHECK (state = 'waiting' OR next_check_at IS NULL)
);
CREATE INDEX IF NOT EXISTS watches_due ON watches(state, next_check_at);
CREATE TABLE IF NOT EXISTS watch_checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id      INTEGER NOT NULL REFERENCES watches(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','pass','fail','error')),
  exit_code     INTEGER,
  output        TEXT,
  item_id       INTEGER REFERENCES items(id),
  woke          TEXT,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS watch_checks_watch ON watch_checks(watch_id, id);
CREATE INDEX IF NOT EXISTS watch_checks_item ON watch_checks(item_id);
`;

// 笔记写进 Hindsight 的任务和事实失效的记录（memory-sync.ts，.scratch/hindsight-primary-memory/spec.md D3、D5）。
export const MEMORY_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_sync (
  bank_index    TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  operation_id  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued','submitted','completed','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error         TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bank_index, document_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_sync_state ON memory_sync(bank_index, state);
CREATE TABLE IF NOT EXISTS memory_invalidations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_index    TEXT NOT NULL,
  memory_id     TEXT NOT NULL,
  document_id   TEXT,
  action        TEXT NOT NULL CHECK (action IN ('invalidated','restored')),
  reason        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL,
  -- 事实的原文和来源（user：用户本人；external：外部对话里别人说的）。不知道时为 NULL。
  text          TEXT,
  origin        TEXT CHECK (origin IS NULL OR origin IN ('user','external')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_invalidations_memory ON memory_invalidations(bank_index, memory_id, id);
CREATE INDEX IF NOT EXISTS idx_memory_invalidations_fact ON memory_invalidations(memory_id, id);
-- 常驻偏好（profile、preference 笔记）的改动记录（core-memory-changes.ts）。只追加：不能删行；
-- 一行只能改一次，而且只能写上 undone_at 和 undone_by（撤销这次改动）。before、after 是 JSON（标题、正文、kind、tags）。
CREATE TABLE IF NOT EXISTS core_memory_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id       INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  before        TEXT CHECK (before IS NULL OR json_valid(before)),
  after         TEXT CHECK (after IS NULL OR json_valid(after)),
  actor         TEXT NOT NULL CHECK (actor IN ('user','lead')),
  reason        TEXT NOT NULL DEFAULT '',
  undoes        INTEGER REFERENCES core_memory_changes(id),
  created_at    TEXT NOT NULL,
  undone_at     TEXT,
  undone_by     TEXT CHECK (undone_by IS NULL OR undone_by IN ('user','lead')),
  CHECK ((action = 'create') = (before IS NULL)),
  CHECK ((action = 'delete') = (after IS NULL)),
  CHECK ((undone_at IS NULL) = (undone_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_core_memory_changes_note ON core_memory_changes(note_id, id);
CREATE TRIGGER IF NOT EXISTS core_memory_changes_append_only_delete BEFORE DELETE ON core_memory_changes BEGIN
  SELECT RAISE(ABORT, 'core_memory_changes is append-only');
END;
CREATE TRIGGER IF NOT EXISTS core_memory_changes_undo_only BEFORE UPDATE ON core_memory_changes
WHEN OLD.undone_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.note_id IS NOT OLD.note_id OR NEW.action IS NOT OLD.action
  OR NEW.before IS NOT OLD.before OR NEW.after IS NOT OLD.after OR NEW.actor IS NOT OLD.actor OR NEW.reason IS NOT OLD.reason
  OR NEW.undoes IS NOT OLD.undoes OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'core_memory_changes is append-only: only an undo can be recorded, once'); END;
`;

// 自定义控件（widgets.ts，.scratch/custom-views/spec.md D1）：视图面板里的一块，用户让 Lead 做的常驻控件。
// surface 是校验过的 genui surface（JSON）。view 是它所在的视图（面板上的 tab），缺省 default；没有单独的视图表。
// position 越小越靠上。最多 20 个控件、6 个视图（WIDGET_LIMITS）由写函数检查。
export const WIDGETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS widgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 40),
  view        TEXT NOT NULL DEFAULT 'default' CHECK (length(view) BETWEEN 1 AND 10),
  surface     TEXT NOT NULL CHECK (json_valid(surface)),
  position    INTEGER NOT NULL,
  created_by  TEXT NOT NULL CHECK (created_by IN ('user','lead')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_widgets_position ON widgets(position, id);
`;

// 控件的数据源（第二期，widgets.ts，spec D3）：一个控件最多一个。daemon 按 every_seconds 在 Lead 的 bash 沙箱里跑 command，
// 用输出解析 template（带 {"$data": …} 绑定的模板），合格了写进 widgets.surface。连续出错 5 次暂停（paused=1）。
export const WIDGET_SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS widget_sources (
  widget_id           INTEGER PRIMARY KEY REFERENCES widgets(id),
  template            TEXT NOT NULL CHECK (json_valid(template)),
  command             TEXT NOT NULL CHECK (length(command) BETWEEN 1 AND 4000),
  every_seconds       INTEGER NOT NULL CHECK (every_seconds >= 60),
  next_run_at         TEXT,
  running_since       TEXT,
  last_run_at         TEXT,
  last_ok_at          TEXT,
  last_error          TEXT,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_widget_sources_due ON widget_sources(paused, next_run_at);
`;

export const SCHEMA = `
${itemsTableSql("items", true)}
${ITEMS_CONSTRAINTS_SCHEMA}
${runsTableSql("runs", true)}
${WORKSPACE_SCHEMA}
${RUNS_ITEM_INDEX_SQL}
CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  run_id    INTEGER REFERENCES runs(id),
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('comment','transition','milestone','notification',
                                'decision','attempt_start','attempt_end','crash')),
  payload       TEXT NOT NULL,
  session_cursor TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 工单的活动按工单读（activities.ts 的 listActivities、Lead 的 get_ticket）。老库靠 CREATE IF NOT EXISTS 自然获得，不占迁移号。
CREATE INDEX IF NOT EXISTS activities_item ON activities(item_id, id);
CREATE TABLE IF NOT EXISTS ticket_relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id  INTEGER NOT NULL REFERENCES items(id),
  target_item_id  INTEGER NOT NULL REFERENCES items(id),
  relation_type   TEXT NOT NULL
                  CHECK (relation_type IN
                         ('depends_on','implements','duplicates','supersedes','relates_to')),
  execution_gate  TEXT NOT NULL DEFAULT 'none'
                  CHECK (execution_gate IN ('none','target_done')),
  created_by      TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_by_run_id INTEGER REFERENCES runs(id),
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT,
  revoked_by      TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('user','lead','child','system')),
  revoke_reason   TEXT,
  CHECK (source_item_id <> target_item_id),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
      AND revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_relations_active_exact
  ON ticket_relations(source_item_id, target_item_id, relation_type)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_relations_active_duplicate_source
  ON ticket_relations(source_item_id)
  WHERE relation_type = 'duplicates' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_relations_active_supersedes_target
  ON ticket_relations(target_item_id)
  WHERE relation_type = 'supersedes' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ticket_relations_source
  ON ticket_relations(source_item_id, revoked_at, relation_type, id);
CREATE INDEX IF NOT EXISTS ticket_relations_target
  ON ticket_relations(target_item_id, revoked_at, relation_type, id);
${inboxTableSql("inbox", true)}
-- 去抖与熔断都按 dedup_scope 分组，这条索引是它们唯一的查询形状。
CREATE INDEX IF NOT EXISTS inbox_scope ON inbox (dedup_scope, severity, state);
CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER REFERENCES items(id),
  run_id    INTEGER REFERENCES runs(id),
  requested_by  TEXT NOT NULL,                  -- 'child' | 'lead'
  tool          TEXT NOT NULL,                  -- 动作类别键（session 豁免按此匹配）
  action        TEXT NOT NULL,                  -- 人类可读的动作描述
  payload       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','expired')),
  session_exempt INTEGER NOT NULL DEFAULT 0,     -- acceptForSession：本工单同 tool 后续免批
  resolved_by   TEXT,
  resolved_at   TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS approvals_item_status
  ON approvals(item_id, status, id);
-- schedules 表已被 triggers 吸收（spec §5.6），v15 迁移搬完存量行后 DROP。
CREATE TABLE IF NOT EXISTS pairings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash     TEXT NOT NULL,
  socket_secret_hash TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('desktop','companion','cli')),
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','redeemed','expired','revoked')),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 谁建的配对（v47，工单 15）：web_invitation（本机网页的扫码邀请）或 admin（临时 admin token）。
  origin        TEXT
);
CREATE TABLE IF NOT EXISTS bindings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('desktop','companion','cli','aish-slack')),
  display_name  TEXT NOT NULL,
  external_subject TEXT,
  token_hash    TEXT,
  scopes        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 上游连接凭证（aish-slack 用）：持久化后 daemon 重启/自愈拉起可自动重连，不依赖环境变量
  conn_url      TEXT,
  conn_secret   TEXT,
  -- 凭证是怎么来的（v47，工单 15）：cli、loopback_web、phone_qr、admin_pairing、local_invitation、aish。
  -- v47 之前建的是 NULL（protocol 的 bindingOriginOf 按 kind 推断）。决定主人操作只记录还是推送。
  origin        TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  kind          TEXT NOT NULL DEFAULT 'note'
                -- 枚举需与 db.ts migrate 的 ALTER CHECK 保持同步
                CHECK (kind IN ('profile','preference','fact','note')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 用户对 lead 的授权（诉求：「如果我授权了，我的 lead agent 应该有权限做所有的操作」）。
-- 授权必须经由一条 lead 伪造不了的通道抵达，所以它落库，而不是靠对话里的一句"我授权你了"——
-- 后者只是上下文里的一段文本，lead 自己就能写出来，也会随压缩消失。
--
-- **为什么不是 kv。** 三条都做不到：(1) 每次代用户确认都要在活动流里指名"凭哪一次授权"，
-- 需要一个稳定 id，kv 只有 key；(2) 撤销之后仍要答得出"当时授权的是什么、什么时候撤的"，
-- kv 的 ON CONFLICT UPDATE 会把上一条盖掉；(3) capability 是安全语义的枚举，值得一条 CHECK，
-- 而 kv 的 value 是自由 TEXT。所以这里是追加式的：授权插一行，撤销给那一行盖 revoked_at，
-- 历史一行不删。
-- granted_via 只有 cli / control-plane 两个取值：这正是"用户本人在操作"的两个面。
-- lead 的工具表里没有任何一条能写这张表——授权不能自授。
CREATE TABLE IF NOT EXISTS lead_grants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  capability    TEXT NOT NULL CHECK (capability IN ('confirm_item')),
  granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  granted_via   TEXT NOT NULL CHECK (granted_via IN ('cli','control-plane')),
  revoked_at    TEXT,
  revoked_via   TEXT CHECK (revoked_via IS NULL OR revoked_via IN ('cli','control-plane')),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS lead_grants_active ON lead_grants(capability, revoked_at);
-- 通用键值存储（第一个使用者见 gateway.ts 的 lastAishOrigin）。老库靠 CREATE IF NOT EXISTS 自然获得，无需 migrate。
CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channel_turns (
  id                TEXT PRIMARY KEY,
  origin_binding_id INTEGER,
  origin_kind       TEXT NOT NULL,
  item_id         INTEGER,
  state             TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','streaming','completed','failed','steered')),
  user_text         TEXT NOT NULL,
  assistant_text    TEXT NOT NULL DEFAULT '',
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_turns_item_created
  ON channel_turns(item_id, created_at, id);
-- 客户端发件箱给每条消息的稳定 id（chat.send 的 clientMessageId）和它开的那一轮。
-- 同一个 binding 第二次发来同一个 id 时，网关回答这一轮，不再开一轮。由 SCHEMA 建，新库老库一样，不占迁移号。
-- turn_id 不设外键：没有 chatV2 的旧桥接给的是不落库的轮次 id。
CREATE TABLE IF NOT EXISTS chat_client_messages (
  binding_id        INTEGER NOT NULL,
  client_message_id TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  mode              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (binding_id, client_message_id)
);
-- 用户发给 Lead 的图片（chat.send 的 images，protocol 的 chat-images.ts），按轮次存，position 是发送时的顺序。
-- 交给 Lead 时（新的一轮、插话、排队、重试、重启后再答）按轮次取出；会话快照（include=images）列出 id，客户端按 id 取图。
-- 由 SCHEMA 建，新库老库一样，不占迁移号。turn_id 不设外键：和 chat_client_messages 一样，重建 channel_turns 的迁移不用管它。
CREATE TABLE IF NOT EXISTS chat_images (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  mime_type   TEXT NOT NULL,
  data        BLOB NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_images_turn ON chat_images(turn_id, position);
CREATE TABLE IF NOT EXISTS gateway_events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  event_type          TEXT NOT NULL,
  required_scope      TEXT NOT NULL,
  audience_binding_id INTEGER,
  turn_id             TEXT,
  item_id           INTEGER,
  payload             TEXT NOT NULL DEFAULT '{}',
  occurred_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_events_replay
  ON gateway_events(seq, required_scope, audience_binding_id);
-- 会话快照按轮次和事件类型读事件（listTurnToolEvents：工具事件，旧轮次还要读 lead.message.delta）。
-- 老库靠 CREATE IF NOT EXISTS 自然获得，无需 migrate。
CREATE INDEX IF NOT EXISTS gateway_events_turn_type
  ON gateway_events(turn_id, event_type, seq) WHERE turn_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','merged','archived')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  max_concurrency INTEGER,
  merged_into_project_id INTEGER REFERENCES projects(id),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_repositories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  repo_root     TEXT NOT NULL UNIQUE,
  remote_url    TEXT,
  repo_name     TEXT NOT NULL,
  role          TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS project_repositories_project
  ON project_repositories(project_id);
CREATE TABLE IF NOT EXISTS project_aliases (
  alias         TEXT PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  actor         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  before_state  TEXT,
  after_state   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS item_plan_revisions (
  parent_item_id INTEGER NOT NULL REFERENCES items(id),
  revision      INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','sealed','superseded')),
  created_by_run_id INTEGER REFERENCES runs(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at     TEXT,
  PRIMARY KEY (parent_item_id, revision)
);
CREATE TABLE IF NOT EXISTS item_plan_memberships (
  parent_item_id INTEGER NOT NULL,
  revision      INTEGER NOT NULL,
  child_item_id INTEGER NOT NULL REFERENCES items(id),
  item_key      TEXT,
  required      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_item_id, revision, child_item_id),
  FOREIGN KEY (parent_item_id, revision)
    REFERENCES item_plan_revisions(parent_item_id, revision)
);
CREATE TABLE IF NOT EXISTS item_dependencies (
  parent_item_id INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  depends_on_item_id INTEGER NOT NULL REFERENCES items(id),
  kind          TEXT NOT NULL DEFAULT 'blocks',
  created_by_run_id INTEGER REFERENCES runs(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_item_id, plan_revision, item_id, depends_on_item_id),
  FOREIGN KEY (parent_item_id, plan_revision)
    REFERENCES item_plan_revisions(parent_item_id, revision),
  CHECK (item_id <> depends_on_item_id)
);
CREATE INDEX IF NOT EXISTS item_dependencies_target
  ON item_dependencies(item_id, parent_item_id, plan_revision);
CREATE TABLE IF NOT EXISTS runtime_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES runs(id),
  seq           INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS dispatch_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  role          TEXT NOT NULL CHECK (role IN ('executor','reviewer')),
  purpose       TEXT NOT NULL,
  runtime       TEXT,
  model         TEXT,
  resume_from_run_id INTEGER REFERENCES runs(id),
  instruction   TEXT,
  plan_owner_item_id INTEGER REFERENCES items(id),
  plan_revision INTEGER,
  trigger       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','claimed','started','completed','failed','cancelled')),
${DISPATCH_SUSPENSION_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
${DISPATCH_BACKOFF_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
${RUN_EFFORT_COLUMNS.map(([name, ddl]) => `  ${name} ${ddl},`).join("\n")}
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS dispatch_requests_pending
  ON dispatch_requests(state, item_id, id);
CREATE TABLE IF NOT EXISTS dispatch_claims (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id),
  run_id    INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  request_id    INTEGER NOT NULL UNIQUE REFERENCES dispatch_requests(id),
  lease_token   TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS review_verdicts (
  run_id    INTEGER PRIMARY KEY REFERENCES runs(id),
  item_id     INTEGER NOT NULL REFERENCES items(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  evidence      TEXT NOT NULL,
  pre_hash TEXT,
  post_hash TEXT,
  checkpoint_id INTEGER REFERENCES checkpoints(id),
  evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS review_workspace_checks (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id),
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  pre_hash TEXT NOT NULL,
  post_hash TEXT,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass','fail')),
  evidence TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','passed','drifted','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_cleanup_snapshots (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id),
  content_hash TEXT NOT NULL,
  artifact_id INTEGER REFERENCES artifacts(id),
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS learning_candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  scope_key     TEXT NOT NULL,
  item_id     INTEGER REFERENCES items(id),
  run_id    INTEGER REFERENCES runs(id),
  fingerprint   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  confidence    REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','drafted','promoted','dismissed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_key, fingerprint, status)
);
CREATE TABLE IF NOT EXISTS capabilities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  scope_key     TEXT NOT NULL,
  type          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  scope         TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project','global')),
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','evaluating','active','deprecated')),
  summary       TEXT NOT NULL,
  asset_path    TEXT,
  evaluator_path TEXT,
  asset_hash    TEXT,
  evaluator_hash TEXT,
  implementation_status TEXT NOT NULL DEFAULT 'unknown'
                CHECK (implementation_status IN ('unknown','implementation_verified')),
  deployment_status TEXT NOT NULL DEFAULT 'not_deployed'
                CHECK (deployment_status IN ('not_deployed','deployed')),
  lead_tool_status TEXT NOT NULL DEFAULT 'not_loaded'
                CHECK (lead_tool_status IN ('not_loaded','loaded')),
  source_candidates TEXT NOT NULL DEFAULT '[]',
  provenance    TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_key, slug, version)
);
CREATE TABLE IF NOT EXISTS capability_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_id INTEGER NOT NULL REFERENCES capabilities(id),
  item_id     INTEGER REFERENCES items(id),
  run_id    INTEGER REFERENCES runs(id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('passed','failed','error')),
  metrics       TEXT NOT NULL DEFAULT '{}',
  evidence      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
${TRIGGER_NOTIFICATION_SCHEMA}
${DELEGATION_WORKFLOW_SCHEMA}
${RUNTIME_HEALTH_SCHEMA}
${ITEM_MILESTONES_SCHEMA}
${CONNECTIONS_SCHEMA}
${EVENTS_SCHEMA}
${STANDING_ORDERS_SCHEMA}
${EVENT_TRIAGE_SHADOW_SCHEMA}
${CHANNELS_SCHEMA}
${LEAD_WAITS_SCHEMA}
${CHANNEL_LOOKUPS_SCHEMA}
${DELIVERY_SNAPSHOTS_SCHEMA}
${EXECUTION_PLANS_SCHEMA}
${RUN_GRANTS_SCHEMA}
${ACCEPTANCE_CRITERIA_SCHEMA}
${REVIEWER_SETTINGS_SCHEMA}
${REVIEW_PACKETS_SCHEMA}
${WATCHES_SCHEMA}
${MEMORY_SYNC_SCHEMA}
${WIDGETS_SCHEMA}
${WIDGET_SOURCES_SCHEMA}
`;

export const CHECKPOINT_CONTROL_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  run_id          INTEGER REFERENCES runs(id),
  source              TEXT NOT NULL
                      CHECK (source IN ('agent_reported','system_derived')),
  kind                TEXT NOT NULL
                      CHECK (kind IN ('progress','milestone','decision',
                                      'delegation','blocked','completed')),
  stage               TEXT,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  key_facts           TEXT NOT NULL DEFAULT '[]',
  artifact_refs       TEXT NOT NULL DEFAULT '[]',
  related_item_ids  TEXT NOT NULL DEFAULT '[]',
  next_step           TEXT,
  action_type         TEXT CHECK (action_type IN ('approval','decision_request')),
  action_id           INTEGER,
  idempotency_key     TEXT UNIQUE,
  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((action_type IS NULL) = (action_id IS NULL))
);
CREATE INDEX IF NOT EXISTS checkpoints_item_id
  ON checkpoints(item_id, id);
CREATE INDEX IF NOT EXISTS checkpoints_run_id
  ON checkpoints(run_id, id);
CREATE INDEX IF NOT EXISTS checkpoints_action
  ON checkpoints(action_type, action_id, id);
CREATE TABLE IF NOT EXISTS decision_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  run_id          INTEGER REFERENCES runs(id),
  kind                TEXT NOT NULL CHECK (kind IN ('decision','question','blocker')),
  audience            TEXT NOT NULL CHECK (audience IN ('lead','user','lead_or_user')),
  blocking            INTEGER NOT NULL DEFAULT 1,
  allow_custom        INTEGER NOT NULL DEFAULT 0,
  prompt              TEXT NOT NULL,
  options             TEXT NOT NULL DEFAULT '[]',
  state               TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','resolved','dismissed','expired')),
  resolution_kind     TEXT CHECK (resolution_kind IN ('option','text','dismissed','expired')),
  selected_option_id  TEXT,
  resolution_text     TEXT,
  dismissal_reason    TEXT,
  resolved_by         TEXT,
  resolved_at         TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS decision_requests_item_state
  ON decision_requests(item_id, state, id);
CREATE INDEX IF NOT EXISTS decision_requests_run
  ON decision_requests(run_id, id);
CREATE TABLE IF NOT EXISTS conversation_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT REFERENCES channel_turns(id),
  item_id         INTEGER REFERENCES items(id),
  kind              TEXT NOT NULL
                    CHECK (kind IN ('ticket_execution','checkpoint','intervention')),
  checkpoint_id     INTEGER REFERENCES checkpoints(id),
  action_type       TEXT CHECK (action_type IN ('approval','decision_request')),
  action_id         INTEGER,
  payload           TEXT NOT NULL DEFAULT '{}',
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((action_type IS NULL) = (action_id IS NULL))
);
CREATE INDEX IF NOT EXISTS conversation_cards_turn
  ON conversation_cards(turn_id, id);
CREATE INDEX IF NOT EXISTS conversation_cards_item
  ON conversation_cards(item_id, id);
CREATE INDEX IF NOT EXISTS conversation_cards_checkpoint
  ON conversation_cards(checkpoint_id, id);
CREATE INDEX IF NOT EXISTS conversation_cards_action
  ON conversation_cards(action_type, action_id, id);
`;

export const CHECKPOINT_FIDELITY_STORAGE_SCHEMA = `
CREATE TABLE item_proof_items (
  item_id        INTEGER NOT NULL REFERENCES items(id),
  -- proof item 的业务键。改名前它叫 item_id，与新的事项外键同名；v16 迁移里必须先把它
  -- 让开（item_id → proof_key），再把 item_id 改成 item_id，否则中途一张表两个 item_id。
  proof_key      TEXT NOT NULL,
  label          TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('pending','passed','failed')),
  evidence       TEXT,
  checkpoint_id  INTEGER NOT NULL REFERENCES checkpoints(id),
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (item_id, proof_key)
);
CREATE INDEX item_proof_items_item_state
  ON item_proof_items(item_id, state, checkpoint_id, proof_key);
CREATE INDEX item_proof_items_checkpoint
  ON item_proof_items(checkpoint_id, item_id, proof_key);
CREATE TABLE artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          INTEGER NOT NULL REFERENCES items(id),
  run_id         INTEGER REFERENCES runs(id),
  checkpoint_id      INTEGER NOT NULL REFERENCES checkpoints(id),
  ref                TEXT NOT NULL,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,
  media_type         TEXT NOT NULL,
  description        TEXT,
  original_filename  TEXT,
  sha256             TEXT,
  byte_length        INTEGER,
  storage_key        TEXT,
  availability       TEXT NOT NULL
                     CHECK (availability IN ('available','metadata_only','unavailable')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, ref),
  CHECK (
    (availability = 'available'
      AND sha256 IS NOT NULL AND byte_length IS NOT NULL AND storage_key IS NOT NULL)
    OR (availability = 'metadata_only'
      AND sha256 IS NULL AND byte_length IS NULL AND storage_key IS NULL)
    OR (availability = 'unavailable'
      AND storage_key IS NULL
      AND ((sha256 IS NULL AND byte_length IS NULL)
        OR (sha256 IS NOT NULL AND byte_length IS NOT NULL)))
  ),
  CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (byte_length IS NULL OR byte_length >= 0)
);
CREATE INDEX artifacts_item_id
  ON artifacts(item_id, id);
CREATE INDEX artifacts_checkpoint_id
  ON artifacts(checkpoint_id, id);
CREATE INDEX artifacts_sha256
  ON artifacts(sha256, id);
`;

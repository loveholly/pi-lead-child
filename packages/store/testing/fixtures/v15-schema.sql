-- v15 数据库的物理形状快照，由 v16 改名前的 openDb 导出后冻结。
-- 迁移测试必须喂一个不会随代码漂移的旧形状；直接引用 schema.ts 会让"迁移"变成自我
-- 印证——schema.ts 一改，输入也跟着改，测试就再也证明不了老库能升上来。
-- notes_fts 及其影子表刻意剔除：openDb 的 setupFts 会自己重建，且与本次改名无关。
CREATE TABLE activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('comment','transition','milestone','notification',
                                'decision','attempt_start','attempt_end','crash')),
  payload       TEXT NOT NULL,
  session_cursor TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
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
CREATE TABLE artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id          INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id         INTEGER REFERENCES attempts(id),
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
  UNIQUE(ticket_id, ref),
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
CREATE TABLE attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  role          TEXT NOT NULL DEFAULT 'executor' CHECK (role IN ('executor','reviewer')),
  session_id    TEXT,
  session_path  TEXT,
  pid           INTEGER,                          -- 暂停期间为 NULL（spec §5.2）
  state         TEXT NOT NULL DEFAULT 'starting'
                CHECK (state IN ('starting','running','paused','settled','crashed','stopped')),
  model         TEXT,
  runtime       TEXT NOT NULL DEFAULT 'pi',
  purpose       TEXT NOT NULL DEFAULT 'execution',
  runtime_version TEXT,
  external_session_id TEXT,
  event_cursor  TEXT,
  exit_code     INTEGER,
  error_code    TEXT,
  error_message TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  cost_known    INTEGER NOT NULL DEFAULT 0,
  event_log_dirty INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at     TEXT,                             -- 当前这次暂停的起点；恢复时清空
  paused_ms     INTEGER NOT NULL DEFAULT 0,       -- 历次暂停累计，支持反复暂停/恢复
  ended_at      TEXT,
  last_entry_cursor TEXT
);
CREATE TABLE bindings (
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
  conn_secret   TEXT
);
CREATE TABLE capabilities (
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
  source_candidates TEXT NOT NULL DEFAULT '[]',
  provenance    TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_key, slug, version)
);
CREATE TABLE capability_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_id INTEGER NOT NULL REFERENCES capabilities(id),
  ticket_id     INTEGER REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('passed','failed','error')),
  metrics       TEXT NOT NULL DEFAULT '{}',
  evidence      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE channel_turns (
  id                TEXT PRIMARY KEY,
  origin_binding_id INTEGER,
  origin_kind       TEXT NOT NULL,
  ticket_id         INTEGER,
  state             TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','streaming','completed','failed','steered')),
  user_text         TEXT NOT NULL,
  assistant_text    TEXT NOT NULL DEFAULT '',
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE "checkpoints" (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id           INTEGER NOT NULL REFERENCES tickets(id),
      attempt_id          INTEGER REFERENCES attempts(id),
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
      related_ticket_ids  TEXT NOT NULL DEFAULT '[]',
      next_step           TEXT,
      action_type         TEXT CHECK (action_type IN ('approval','decision_request')),
      action_id           INTEGER,
      idempotency_key     TEXT UNIQUE,
      content_hash        TEXT NOT NULL,
      progress_current    INTEGER,
      progress_total      INTEGER,
      progress_label      TEXT,
      proof_items         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(proof_items)),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((action_type IS NULL) = (action_id IS NULL)),
      CHECK (
        (progress_current IS NULL AND progress_total IS NULL)
        OR (
          progress_current IS NOT NULL AND progress_total IS NOT NULL
          AND typeof(progress_current) = 'integer'
          AND typeof(progress_total) = 'integer'
          AND progress_current >= 0
          AND progress_total > 0
          AND progress_current <= progress_total
          AND progress_total <= 2147483647
        )
      ),
      CHECK (progress_label IS NULL OR length(progress_label) <= 120)
    );
CREATE TABLE conversation_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT REFERENCES channel_turns(id),
  ticket_id         INTEGER REFERENCES tickets(id),
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
CREATE TABLE decision_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id           INTEGER NOT NULL REFERENCES tickets(id),
  attempt_id          INTEGER REFERENCES attempts(id),
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
CREATE TABLE dispatch_claims (
  ticket_id     INTEGER PRIMARY KEY REFERENCES tickets(id),
  attempt_id    INTEGER NOT NULL UNIQUE REFERENCES attempts(id),
  request_id    INTEGER NOT NULL UNIQUE REFERENCES dispatch_requests(id),
  lease_token   TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE dispatch_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  role          TEXT NOT NULL CHECK (role IN ('executor','reviewer')),
  purpose       TEXT NOT NULL,
  runtime       TEXT,
  model         TEXT,
  plan_owner_ticket_id INTEGER REFERENCES tickets(id),
  plan_revision INTEGER,
  trigger       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','claimed','started','completed','failed','cancelled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE gateway_events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  event_type          TEXT NOT NULL,
  required_scope      TEXT NOT NULL,
  audience_binding_id INTEGER,
  turn_id             TEXT,
  ticket_id           INTEGER,
  payload             TEXT NOT NULL DEFAULT '{}',
  occurred_at         TEXT NOT NULL
);
CREATE TABLE inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 可空：并非所有内部事件都挂事项（watchdog 的全局告警、trigger 自停用等）。
  ticket_id     INTEGER REFERENCES tickets(id),
  -- 去抖与熔断的分组键。必须显式，不能沿用 ticket_id：SQLite 里 col = NULL 恒不为真，
  -- 放开 NOT NULL 后按 ticket_id 分组会让不挂事项的行既不去抖也不熔断——恰好在新放开的
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
  CHECK (ticket_id IS NULL OR dedup_scope = 'item:' || ticket_id)
);
CREATE TABLE kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE learning_candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  scope_key     TEXT NOT NULL,
  ticket_id     INTEGER REFERENCES tickets(id),
  attempt_id    INTEGER REFERENCES attempts(id),
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
CREATE TABLE notes (
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
CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER REFERENCES tickets(id),     -- 可空：不是所有通知都挂事项
  kind            TEXT NOT NULL,                      -- reminder | item_done | budget | crash | ...
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
CREATE TABLE pairings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash     TEXT NOT NULL,
  socket_secret_hash TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('desktop','companion','cli')),
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','redeemed','expired','revoked')),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE project_aliases (
  alias         TEXT PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE project_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  actor         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  before_state  TEXT,
  after_state   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE project_repositories (
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
CREATE TABLE projects (
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
CREATE TABLE review_verdicts (
  attempt_id    INTEGER PRIMARY KEY REFERENCES attempts(id),
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  evidence      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE runtime_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id    INTEGER NOT NULL REFERENCES attempts(id),
  seq           INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  UNIQUE(attempt_id, seq)
);
CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE ticket_dependencies (
  parent_ticket_id INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  depends_on_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  kind          TEXT NOT NULL DEFAULT 'blocks',
  created_by_attempt_id INTEGER REFERENCES attempts(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_ticket_id, plan_revision, ticket_id, depends_on_ticket_id),
  FOREIGN KEY (parent_ticket_id, plan_revision)
    REFERENCES ticket_plan_revisions(parent_ticket_id, revision),
  CHECK (ticket_id <> depends_on_ticket_id)
);
CREATE TABLE ticket_plan_memberships (
  parent_ticket_id INTEGER NOT NULL,
  revision      INTEGER NOT NULL,
  child_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  item_key      TEXT,
  required      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_ticket_id, revision, child_ticket_id),
  FOREIGN KEY (parent_ticket_id, revision)
    REFERENCES ticket_plan_revisions(parent_ticket_id, revision)
);
CREATE TABLE ticket_plan_revisions (
  parent_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  revision      INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','sealed','superseded')),
  created_by_attempt_id INTEGER REFERENCES attempts(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at     TEXT,
  PRIMARY KEY (parent_ticket_id, revision)
);
CREATE TABLE ticket_proof_items (
  ticket_id      INTEGER NOT NULL REFERENCES tickets(id),
  item_id        TEXT NOT NULL,
  label          TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('pending','passed','failed')),
  evidence       TEXT,
  checkpoint_id  INTEGER NOT NULL REFERENCES checkpoints(id),
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (ticket_id, item_id)
);
CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','reminder')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
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
  parent_ticket_id INTEGER REFERENCES tickets(id),
  root_ticket_id INTEGER REFERENCES tickets(id),   -- 可空：自根行需 insert-then-update

  -- 执行配置（仅 task），全部可空
  workdir       TEXT,
  requested_runtime TEXT,
  requested_model TEXT,
  purpose       TEXT,
  review_policy TEXT CHECK (review_policy IS NULL OR review_policy IN ('manual','automatic')),
  max_depth     INTEGER,
  max_children  INTEGER,
  max_concurrency INTEGER,
  token_budget  INTEGER,
  cost_budget_usd REAL,
  retry_limit   INTEGER,                           -- 可空；task 缺省由代码补 1

  -- 计划编排（仅 task）
  orchestration_state TEXT
                CHECK (orchestration_state IS NULL OR orchestration_state IN
                       ('none','planning','waiting','integrating','failed')),
  active_plan_revision INTEGER,

  -- 溯源
  created_by    TEXT NOT NULL CHECK (created_by IN ('user','lead','child','system')),
  created_by_attempt_id INTEGER REFERENCES attempts(id),

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at   TEXT,
  first_started_at TEXT,
  completed_at  TEXT,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     REAL    NOT NULL DEFAULT 0,

  -- (C1) stage 必须属于本 kind 的状态机
  CHECK (
    (kind = 'task'     AND status IN ('draft','ready','active','blocked','review','done','cancelled'))
    OR
    (kind = 'reminder' AND status IN ('scheduled','fired','acked','cancelled'))
  ),

  -- (C2) reminder 不得携带任何执行侧字段。此列表必须与上方「执行配置」「计划编排」
  --      「层级」三组完全一致；新增执行列时必须同步加入本 CHECK。
  --      溯源列（created_by_attempt_id）不在此列：spec §6.6 允许 child 创建 item，
  --      那条 reminder 仍须记得是哪次 run 建的。
  CHECK (kind = 'task' OR (
    parent_ticket_id IS NULL AND root_ticket_id IS NULL
    AND workdir IS NULL AND requested_runtime IS NULL AND requested_model IS NULL
    AND purpose IS NULL AND review_policy IS NULL AND retry_limit IS NULL
    AND max_depth IS NULL AND max_children IS NULL AND max_concurrency IS NULL
    AND token_budget IS NULL AND cost_budget_usd IS NULL
    AND orchestration_state IS NULL AND active_plan_revision IS NULL
    AND defer_until IS NULL
    AND first_started_at IS NULL AND total_tokens = 0 AND total_cost_usd = 0
  )),

  -- (C3) remind_at 双向约束：task 不得有；scheduled 的 reminder 必须有，否则永不触发
  CHECK (kind = 'reminder' OR remind_at IS NULL),
  CHECK (kind <> 'reminder' OR status <> 'scheduled' OR remind_at IS NOT NULL),

  -- (C4) 只有 user / lead 直接创作的 item 才可能停在 draft（见 spec §6.6）
  CHECK (status <> 'draft' OR created_by IN ('user','lead'))
);
CREATE TABLE trigger_fires (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id      INTEGER NOT NULL REFERENCES triggers(id),
  dedup_key       TEXT NOT NULL,   -- once/cron: occurrence ISO；webhook: 请求携带的 delivery id
  occurrence_at   TEXT NOT NULL,   -- 本次触发对应的逻辑时刻，供 action 执行器注入 remind_at
  fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','succeeded','failed')),
  error           TEXT,
  produced_ticket_id INTEGER REFERENCES tickets(id),
  UNIQUE (trigger_id, dedup_key)
);
CREATE TABLE triggers (
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
CREATE INDEX approvals_attempt ON approvals(attempt_id, id);
CREATE INDEX approvals_ticket_status
  ON approvals(ticket_id, status, id);
CREATE INDEX artifacts_checkpoint_id
  ON artifacts(checkpoint_id, id);
CREATE INDEX artifacts_sha256
  ON artifacts(sha256, id);
CREATE INDEX artifacts_ticket_id
  ON artifacts(ticket_id, id);
CREATE INDEX attempts_external_session ON attempts(external_session_id, id);
CREATE INDEX channel_turns_ticket_created
  ON channel_turns(ticket_id, created_at, id);
CREATE INDEX checkpoints_action
  ON checkpoints(action_type, action_id, id);
CREATE INDEX checkpoints_attempt_id
  ON checkpoints(attempt_id, id);
CREATE INDEX checkpoints_ticket_id
  ON checkpoints(ticket_id, id);
CREATE INDEX conversation_cards_action
  ON conversation_cards(action_type, action_id, id);
CREATE INDEX conversation_cards_checkpoint
  ON conversation_cards(checkpoint_id, id);
CREATE INDEX conversation_cards_ticket
  ON conversation_cards(ticket_id, id);
CREATE INDEX conversation_cards_turn
  ON conversation_cards(turn_id, id);
CREATE INDEX decision_requests_attempt
  ON decision_requests(attempt_id, id);
CREATE INDEX decision_requests_ticket_state
  ON decision_requests(ticket_id, state, id);
CREATE INDEX dispatch_requests_pending
  ON dispatch_requests(state, ticket_id, id);
CREATE INDEX gateway_events_replay
  ON gateway_events(seq, required_scope, audience_binding_id);
CREATE INDEX inbox_scope ON inbox (dedup_scope, severity, state);
CREATE INDEX notifications_pending ON notifications (state, urgency, created_at);
CREATE INDEX project_repositories_project
  ON project_repositories(project_id);
CREATE INDEX ticket_dependencies_target
  ON ticket_dependencies(ticket_id, parent_ticket_id, plan_revision);
CREATE UNIQUE INDEX ticket_plan_memberships_item_key
       ON ticket_plan_memberships(parent_ticket_id, revision, item_key)
       WHERE item_key IS NOT NULL;
CREATE INDEX ticket_proof_items_checkpoint
  ON ticket_proof_items(checkpoint_id, ticket_id, item_id);
CREATE INDEX ticket_proof_items_ticket_state
  ON ticket_proof_items(ticket_id, state, checkpoint_id, item_id);
CREATE INDEX tickets_by_root ON tickets (root_ticket_id);
CREATE INDEX tickets_by_view ON tickets (kind, status, defer_until);
CREATE INDEX tickets_due     ON tickets (due_at)    WHERE due_at IS NOT NULL;
CREATE INDEX tickets_remind  ON tickets (remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX trigger_fires_by_trigger ON trigger_fires (trigger_id, id);
CREATE INDEX triggers_due ON triggers (next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;
CREATE TRIGGER tickets_kind_immutable BEFORE UPDATE OF kind ON tickets
WHEN OLD.kind <> NEW.kind
BEGIN SELECT RAISE(ABORT, 'item.kind is immutable'); END;
CREATE TRIGGER tickets_tree_is_task_i BEFORE INSERT ON tickets
WHEN (NEW.parent_ticket_id IS NOT NULL
        AND (SELECT kind FROM tickets WHERE id = NEW.parent_ticket_id) IS NOT 'task')
  OR (NEW.root_ticket_id IS NOT NULL AND NEW.root_ticket_id <> NEW.id
        AND (SELECT kind FROM tickets WHERE id = NEW.root_ticket_id) IS NOT 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of a ticket must be a task'); END;
CREATE TRIGGER tickets_tree_is_task_u
BEFORE UPDATE OF parent_ticket_id, root_ticket_id ON tickets
WHEN (NEW.parent_ticket_id IS NOT NULL
        AND (SELECT kind FROM tickets WHERE id = NEW.parent_ticket_id) IS NOT 'task')
  OR (NEW.root_ticket_id IS NOT NULL AND NEW.root_ticket_id <> NEW.id
        AND (SELECT kind FROM tickets WHERE id = NEW.root_ticket_id) IS NOT 'task')
BEGIN SELECT RAISE(ABORT, 'parent/root of a ticket must be a task'); END;

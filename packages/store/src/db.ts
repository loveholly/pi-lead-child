import Database from "better-sqlite3";
import { basename } from "node:path";
import {
  CHECKPOINT_CONTROL_PLANE_SCHEMA,
  CHECKPOINT_FIDELITY_STORAGE_SCHEMA,
  DELEGATION_WORKFLOW_SCHEMA,
  DISPATCH_BACKOFF_COLUMNS,
  DISPATCH_SUSPENSION_COLUMNS,
  ITEMS_CONSTRAINTS_SCHEMA,
  OUTCOME_SNAPSHOT_SCHEMA,
  SCHEMA,
  inboxTableSql,
  itemsTableSql,
  RUN_FAILURE_COLUMNS,
  RUN_EFFORT_COLUMNS,
  DECISION_ORIGIN_COLUMNS,
  RUN_LAUNCHER_COLUMNS,
  RUNTIME_HEALTH_SCHEMA,
  RUNTIME_INCIDENT_RECOVERY_COLUMNS,
  RUNS_ITEM_INDEX_SQL,
  runsTableSql,
} from "./schema.js";
import {
  repairItemProofMaterialization,
  verifyItemProofMaterialization,
} from "./checkpoints.js";
import {
  REWORK_GRANT_ATTRIBUTION_MIGRATION_VERSION,
  SPURIOUS_OUTCOME_RECORDS_MIGRATION_VERSION,
  TICKET_AGENT_TURN_TEXT_MIGRATION_VERSION,
  migrateReworkGrantAttribution,
  migrateSpuriousOutcomeRecords,
  migrateTicketAgentTurnText,
} from "./data-corrections.js";
import { syncSystemStandingOrders } from "./standing-orders.js";
import { migrateAuthorityToHandbook } from "./channel-handbook.js";
import { dropLedgerGuards, installLedgerGuards, ledgerGuardsEnabled, registerLedgerWriter } from "./ledger-guard.js";
import { migrateTokenUsageRecompute, TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION } from "./token-usage-recompute.js";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000"); // child extension 跨进程写同一 DB
    // 写入守卫（ledger-guard.ts）：这个连接可以写账本。必须在任何迁移之前注册：已经装了守卫的库上，迁移也要写。
    registerLedgerWriter(db);
    // v16 改名排在整条迁移链的**最前面**，有两个各自独立的理由：
    //   1. 必须早于 exec(SCHEMA)。SCHEMA 已整体切到 items/runs，在还叫 tickets 的老库上
    //      跑，`CREATE TABLE IF NOT EXISTS items` 会在存量表旁边凭空建一张空表，随后的
    //      RENAME 撞名失败，而数据留在没人再读的 tickets 里。
    //   2. 也必须早于 v14/v15。那两支都用 schema.ts 的表体函数建新表，而那些函数已经是
    //      改名后的形状（`REFERENCES items(id)`）；先跑它们，临时表会指向一张还不存在的
    //      items，RENAME 完自引用就永久错位，foreign_key_check 当场报违规。
    // 代价是 v16 要能吃下任意历史形状——它按列名逐表匹配、缺列即跳过，正是为此。
    // 好处是从这一行往后，整条链条只讲一种词汇。
    migrateItemRename(db);
    // 必须排在 exec(SCHEMA) 之前：SCHEMA 里的 items 索引与触发器都引用 kind，而
    // CREATE TABLE IF NOT EXISTS 不会给已存在的老表补列——老库上 exec(SCHEMA) 会直接抛
    // "no such column: kind"，openDb 当场失败，排在它后面的 migrateDb 永远轮不到执行。
    migrateItemModel(db);
    // 与 migrateItemModel 同侧、同理由：SCHEMA 里的 inbox_scope 索引引用 dedup_scope，
    // 老库的 inbox 还没有这一列，exec(SCHEMA) 会当场抛 "no such column: dedup_scope"。
    migrateLeadInboxScope(db);
    // 同理，当前 SCHEMA 会为 notifications.dedup_key 建唯一索引；老库只有 notifications
    // 表而没有这列时，必须先补列再执行 SCHEMA。
    migrateNotificationDedupKey(db);
    // workflow_kind / workspace_id 会被当前 DDL、索引和投影直接读取；先补列，避免老库在
    // exec(SCHEMA) 或后续 runs 重建前因缺列失败。约束的跨字段部分由 SCHEMA 里的触发器补上。
    migrateWorkspaceColumns(db);
    db.exec(SCHEMA);
    migrateDb(db);
    setupFts(db);
    // 第一批常设指令（工单 05）：代码里的系统指令同步进表。幂等，每次打开都做。
    syncSystemStandingOrders(db);
    // 交接说明（自动代你处理方案 B）：旧授权表里你改过的项搬过来。幂等，最多写一个版本。
    migrateAuthorityToHandbook(db);
    // 迁移之后再装：迁移重建过的表会丢掉触发器，这里补上。幂等。应急开关关着时卸掉（ledger-guard.ts 的回滚说明）。
    if (ledgerGuardsEnabled()) installLedgerGuards(db);
    else dropLedgerGuards(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// 打开已有的账本，不建表，也不执行迁移。给只读或只改一两行的 CLI 命令用：openDb 会顺手执行
// 全部待执行迁移，CLI 的代码比运行中的 daemon 新时，就会越过 daemon 把真实账本迁走。
export function openExistingDb(path: string, opts: { readonly?: boolean } = {}): Db {
  const db = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  registerLedgerWriter(db);
  return db;
}

// FTS5 trigram 检索层（spec §A3）：external-content 表 + 触发器同步。
// trigram 对 CJK/英文子串匹配均可用（unicode61 对中文无效）；建失败（老 SQLite 无 FTS5/trigram）则
// 整体降级 LIKE，doctor 报告。一次性建表时 rebuild 收编存量行。
const ftsReady = new WeakMap<Db, boolean>();
export function ftsEnabled(db: Db): boolean {
  return ftsReady.get(db) ?? false;
}

function setupFts(db: Db): void {
  try {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
    ).get();
    if (!exists) {
      // 建表+触发器+rebuild 必须整体包一个事务：FTS5 虚表创建是事务性 DDL，若不包事务、后续任一语句
      // 失败（老 SQLite 场景下触发器语法或 rebuild 报错），虚表会残留但触发器/回填缺失——下次 openDb
      // 的 exists 短路会把这个半成品误判为"已建好"，索引从此静默漂移且不会自愈。整体事务失败时全部
      // 回滚，下次 openDb 看到 notes_fts 不存在，重新干净尝试一次。
      const createAll = db.transaction(() => {
        db.exec(`
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            title, content, tags, content='notes', content_rowid='id', tokenize='trigram'
          );
          CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
          END;
          CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
              VALUES ('delete', old.id, old.title, old.content, old.tags);
          END;
          CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
              VALUES ('delete', old.id, old.title, old.content, old.tags);
            INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
          END;
        `);
        db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')"); // 收编存量行
      });
      createAll();
    }
    ftsReady.set(db, true);
  } catch {
    ftsReady.set(db, false); // 降级 LIKE
  }
}

const WORKSPACE_MODEL_MIGRATION_VERSION = 23;
const REVIEW_WORKSPACE_HASH_MIGRATION_VERSION = 24;
const WORKSPACE_SNAPSHOT_ARTIFACT_MIGRATION_VERSION = 25;
const RUN_TYPED_FAILURE_MIGRATION_VERSION = 26;
const RUNTIME_HEALTH_LEDGER_MIGRATION_VERSION = 27;
// v28 没有用。并行开发时它预留给工单 08，08 最后没有加迁移。
// schema_migrations 按 MAX(version) 读，所以跳号没有影响。
const RUNTIME_INCIDENT_RECOVERY_MIGRATION_VERSION = 29;
const RUN_RUNTIME_PROFILE_HASH_MIGRATION_VERSION = 31;
const DISPATCH_BACKOFF_MIGRATION_VERSION = 32;
// v33 留给并行的工单 11。schema_migrations 按 MAX(version) 读，所以跳号没有影响。
const RUN_LAUNCHER_MIGRATION_VERSION = 34;
// v35–v37 是 data-corrections.ts 的一次性数据更正。
const RUN_EFFORT_MIGRATION_VERSION = 38;
const ITEM_DISPLAY_TITLE_MIGRATION_VERSION = 39;
const ITEM_MILESTONES_MIGRATION_VERSION = 40;
const DECISION_ORIGIN_MIGRATION_VERSION = 41;
const CONNECTIONS_MIGRATION_VERSION = 42;
const EVENT_LOG_MIGRATION_VERSION = 43;
const STANDING_ORDERS_MIGRATION_VERSION = 44;
const EVENT_TRIAGE_SHADOW_MIGRATION_VERSION = 45;
const CHANNELS_MIGRATION_VERSION = 46;
const BINDING_ORIGIN_MIGRATION_VERSION = 47;
const REMINDER_POLICY_MIGRATION_VERSION = 48;
const LEAD_WAITS_MIGRATION_VERSION = 49;
const CHANNEL_LOOKUPS_MIGRATION_VERSION = 50;
// v51 是 token-usage-recompute.ts 的重算。v52 是交付快照（工单 04），v53 是执行计划（工单 06），v54 是验收标准（工单 05），
// v55 是子 agent 的权限清单（分支 claude/agent-grants-8e481a），v56 是核查员选择（工单 09）。
// 迁移按 schema_migrations 里有没有这一行判断，不看最大版本：先升到 v56 的库照样补上 v55。
const DELIVERY_SNAPSHOTS_MIGRATION_VERSION = 52;
const EXECUTION_PLANS_MIGRATION_VERSION = 53;
const ACCEPTANCE_CRITERIA_MIGRATION_VERSION = 54;
// v55：子 agent 的权限清单（.scratch/confidence-model/landing.md 第 5 节）。
const RUN_GRANTS_MIGRATION_VERSION = 55;
const REVIEWER_CHOICE_MIGRATION_VERSION = 56;
const REVIEW_PACKETS_MIGRATION_VERSION = 57;
const DELEGATION_ACCEPT_WITHOUT_REVIEW_MIGRATION_VERSION = 58;
const WATCHES_MIGRATION_VERSION = 59;
const MEMORY_SYNC_MIGRATION_VERSION = 60;
const WIDGETS_MIGRATION_VERSION = 61;
const WIDGET_SOURCES_MIGRATION_VERSION = 62;

// v23 的列补齐必须发生在 exec(SCHEMA) 前：当前 DDL/索引会读取这些列，而 SQLite 的
// CREATE TABLE IF NOT EXISTS 不会给既有表补列。跨字段的 reminder/workflow 约束由 SCHEMA
// 中的触发器承接，避免为一个可回滚的 rollout 重建整张 items 表。
function migrateWorkspaceColumns(db: Db): void {
  if (tableExists(db, "items")) {
    const items = tableColumns(db, "items");
    addColumn(db, "items", items, "workflow_kind",
      "TEXT NOT NULL DEFAULT 'generic' CHECK (workflow_kind IN ('generic','coding'))");
  }
  if (tableExists(db, "runs")) {
    const runs = tableColumns(db, "runs");
    addColumn(db, "runs", runs, "workspace_id", "INTEGER REFERENCES workspaces(id)");
  }
}

function migrateWorkspaceModel(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(WORKSPACE_MODEL_MIGRATION_VERSION);
  db.transaction(() => {
    if (tableExists(db, "items") && tableExists(db, "runs") && tableExists(db, "workspaces")) {
      const invalid = db.prepare(
        "SELECT id FROM items WHERE kind='reminder' AND workflow_kind <> 'generic' LIMIT 1",
      ).get();
      if (invalid) throw new Error("workspace migration found a reminder with coding workflow_kind");
      // 把历史显式 workdir 收编为 shared primary workspace。这里只做元数据回填，
      // 不执行 git，也不改变 item/run/lifecycle 字段；同一路径的多个历史 item 暂时
      // 保留多个 owner，避免在未确认 ownership 规则前偷偷合并事实。
      const legacyItems = db.prepare(
        `SELECT id, project_id, workdir, created_at
         FROM items WHERE kind='task' AND workdir IS NOT NULL AND trim(workdir) <> ''
         ORDER BY id`,
      ).all() as Array<{ id: number; project_id: number | null; workdir: string; created_at: string }>;
      const insert = db.prepare(
        `INSERT INTO workspaces (
           owner_item_id, mode, kind, project_id, path, git_worktree, source_item_id, state, merge_status, created_at
         ) VALUES (?, 'shared', 'primary', ?, ?, 0, ?, 'active', 'n/a', ?)` ,
      );
      for (const item of legacyItems) {
        const exists = db.prepare(
          "SELECT 1 FROM workspaces WHERE owner_item_id=? AND kind='primary' LIMIT 1",
        ).get(item.id);
        if (!exists) insert.run(item.id, item.project_id, item.workdir, item.id, item.created_at);
      }
      const invalidWorkspace = db.prepare(
        "SELECT id FROM workspaces WHERE git_worktree=1 AND repo_root IS NULL LIMIT 1",
      ).get();
      if (invalidWorkspace) throw new Error("workspace migration found a git worktree without repo_root");
      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`workspace migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
      db.exec("CREATE INDEX IF NOT EXISTS runs_workspace ON runs(workspace_id, id)");
    }
    if (!applied) db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(WORKSPACE_MODEL_MIGRATION_VERSION, "ticket-workspace-model-v1");
  })();
}

function migrateReviewWorkspaceHashes(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(REVIEW_WORKSPACE_HASH_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const verdicts = tableColumns(db, "review_verdicts");
    addColumn(db, "review_verdicts", verdicts, "pre_hash", "TEXT");
    addColumn(db, "review_verdicts", verdicts, "post_hash", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(REVIEW_WORKSPACE_HASH_MIGRATION_VERSION, "review-workspace-hashes-v1");
  })();
}

function migrateWorkspaceSnapshotArtifacts(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(WORKSPACE_SNAPSHOT_ARTIFACT_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const columns = tableColumns(db, "workspace_cleanup_snapshots");
    addColumn(db, "workspace_cleanup_snapshots", columns, "artifact_id", "INTEGER REFERENCES artifacts(id)");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(WORKSPACE_SNAPSHOT_ARTIFACT_MIGRATION_VERSION, "workspace-snapshot-artifacts-v1");
  })();
}

// v26：失败的 Run 带类型化失败（spec D1）。只补列，不回填：老的失败 Run 保持 NULL，
// 读取时由内核的兜底分类器分类。迁移因此不依赖会演进的分类代码，也不改 item 的生命周期字段。
// 新库的 runs 已由 SCHEMA 带上这几列，addColumn 会跳过。
function migrateRunTypedFailure(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUN_TYPED_FAILURE_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const columns = tableColumns(db, "runs");
    for (const [name, ddl] of RUN_FAILURE_COLUMNS) addColumn(db, "runs", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUN_TYPED_FAILURE_MIGRATION_VERSION, "run-typed-failure-v1");
  })();
}

// v27：健康账本（spec D2，工单 03）。建两张账本表，给派发请求补挂起的三列。
// 账本从空开始，不从历史失败回填：历史上的故障不会在升级后变成大量通知或挂起。
// 迁移不改 item 和 Run 的生命周期字段，也不改已有的派发请求。
function migrateRuntimeHealthLedger(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUNTIME_HEALTH_LEDGER_MIGRATION_VERSION)) return;
  db.transaction(() => {
    db.exec(RUNTIME_HEALTH_SCHEMA);
    const columns = tableColumns(db, "dispatch_requests");
    for (const [name, ddl] of DISPATCH_SUSPENSION_COLUMNS) addColumn(db, "dispatch_requests", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUNTIME_HEALTH_LEDGER_MIGRATION_VERSION, "runtime-health-ledger-v1");
  })();
}

// v29：故障的恢复状态（工单 04）。只给 runtime_incidents 补列，不回填。
// 升级前就开着的故障 next_probe_at 为空。探针把空值当作已到期，所以升级后马上探一次，之后按退避。
// 探针不发通知，所以升级不会产生通知。迁移不改 item 和 Run 的生命周期字段。
function migrateRuntimeIncidentRecovery(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUNTIME_INCIDENT_RECOVERY_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const columns = tableColumns(db, "runtime_incidents");
    for (const [name, ddl] of RUNTIME_INCIDENT_RECOVERY_COLUMNS) addColumn(db, "runtime_incidents", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUNTIME_INCIDENT_RECOVERY_MIGRATION_VERSION, "runtime-incident-recovery-v1");
  })();
}

// v31：每个 Run 记录它用的 RuntimeProfile hash（spec D2，工单 05）。只补一列，不回填：
// 历史 Run 当时的 profile 已经无从得知，保持 NULL。迁移不改 item 和 Run 的生命周期字段。
// 新库的 runs 已由 SCHEMA 带上这一列，addColumn 会跳过。
function migrateRunRuntimeProfileHash(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUN_RUNTIME_PROFILE_HASH_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "runs", tableColumns(db, "runs"), "runtime_profile_hash", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUN_RUNTIME_PROFILE_HASH_MIGRATION_VERSION, "run-runtime-profile-hash-v1");
  })();
}

// v32：内核的退避重试（spec D5，工单 06）。只给派发请求补两列，不回填。
// 已有的请求两列都为空：没有"不早于"时间，照常 claim。迁移不改 item 和 Run 的生命周期字段。
function migrateDispatchBackoff(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(DISPATCH_BACKOFF_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const columns = tableColumns(db, "dispatch_requests");
    for (const [name, ddl] of DISPATCH_BACKOFF_COLUMNS) addColumn(db, "dispatch_requests", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(DISPATCH_BACKOFF_MIGRATION_VERSION, "dispatch-backoff-v1");
  })();
}

// v34：启动垫片（spec D7，工单 14）。runs 补垫片的身份和输出游标两列，不回填。
// 历史 Run 不是垫片启动的，两列保持 NULL。迁移不改 item 和 Run 的生命周期字段。
// 新库的 runs 已由 SCHEMA 带上这两列，addColumn 会跳过。
function migrateRunLauncher(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUN_LAUNCHER_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const columns = tableColumns(db, "runs");
    for (const [name, ddl] of RUN_LAUNCHER_COLUMNS) addColumn(db, "runs", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUN_LAUNCHER_MIGRATION_VERSION, "run-launcher-v1");
  })();
}

// v41：决策请求加一列 origin（agent / lead）。只加列，不重建表；已有的行是 agent 发起的。
function migrateDecisionOrigin(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(DECISION_ORIGIN_MIGRATION_VERSION)) return;
  // 只跑了一部分迁移的老库（迁移测试会这样）还没有这张表：等它建好以后再加列。
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_requests'").get()) return;
  db.transaction(() => {
    const columns = tableColumns(db, "decision_requests");
    for (const [name, ddl] of DECISION_ORIGIN_COLUMNS) addColumn(db, "decision_requests", columns, name, ddl);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(DECISION_ORIGIN_MIGRATION_VERSION, "decision-origin-v1");
  })();
}

// v42：连接的三张表（oauth_clients、connections、connection_events）。表由 SCHEMA 建，新库和老库一样；
// 这里只记版本。不改任何已有的表。
function migrateConnections(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(CONNECTIONS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(CONNECTIONS_MIGRATION_VERSION, "connections-v1");
}

// v43：事件日志（Lead 事件主干 spec D1，工单 01）。只加 events 表和它的索引、两个撤回触发器（schema.ts 的
// EVENTS_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表，也不从历史回填事件：
// 升级不会凭空产生一批要处置的事。
function migrateEventLog(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(EVENT_LOG_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(EVENT_LOG_MIGRATION_VERSION, "event-log-v1");
}

// v44：常设指令（Lead 事件主干 spec D4，工单 05）。standing_orders 表由 SCHEMA 建，新库和老库一样；这里给 events
// 加一列 triage（分诊依据），再记版本。只加列，events 的已有列和行不变；也不回填已有事件的依据（它们由 01 的默认分诊定的级别）。
// 第一批指令的内容由 openDb 末尾的 syncSystemStandingOrders 写进表（每次打开都同步，幂等）。
function migrateStandingOrders(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(STANDING_ORDERS_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "events", tableColumns(db, "events"), "triage", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(STANDING_ORDERS_MIGRATION_VERSION, "standing-orders-v1");
  })();
}

// v45：Jev 分诊的影子判断（Lead 事件主干 spec D12，工单 09）。只加 event_triage_shadow 表和它的索引、两个只追加的触发器
// （schema.ts 的 EVENT_TRIAGE_SHADOW_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表，
// 也不回填：上线以前的事件不补判（daemon 的批处理只看最近的事件）。
function migrateEventTriageShadow(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(EVENT_TRIAGE_SHADOW_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(EVENT_TRIAGE_SHADOW_MIGRATION_VERSION, "event-triage-shadow-v1");
}

// v46：通道（Lead 事件主干 spec D10、D14，工单 11）。只加 channel_lanes、channel_cards 两张表和它们的索引
// （schema.ts 的 CHANNELS_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，也不回填：
// 上线以前没有外部来源的消息。
function migrateChannels(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(CHANNELS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(CHANNELS_MIGRATION_VERSION, "channels-v1");
}

// v47：凭证的来历（工单 15）。bindings 和 pairings 各加一列 origin。只加列，已有的列和行不变，不回填：
// v47 之前的 binding 是 NULL，按 kind 推断（protocol 的 bindingOriginOf）。不碰 items。
function migrateBindingOrigin(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(BINDING_ORIGIN_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "bindings", tableColumns(db, "bindings"), "origin", "TEXT");
    addColumn(db, "pairings", tableColumns(db, "pairings"), "origin", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(BINDING_ORIGIN_MIGRATION_VERSION, "binding-origin-v1");
  })();
}

// v48：提醒的设置（工单 07）。items 加一列 reminder_policy（JSON）。只加列，不重建 items，不回填：
// v48 之前建的提醒是 NULL，按缺省设置（tell、不提前、不重复）处理。item 的生命周期字段（stage、stage_changed_at、
// closed_at、remind_at……）一个都不动。
// v49：Lead 的等待（2026-10-19，protocol 的 lead-waits.ts）。lead_waits 表由 SCHEMA 建，新库和老库一样；这里只记版本。
// 不改任何已有的表，也不从历史回填：升级以前用户做过的操作不会凭空叫醒 Lead。
function migrateLeadWaits(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(LEAD_WAITS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(LEAD_WAITS_MIGRATION_VERSION, "lead-waits-v1");
}

function migrateReminderPolicy(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(REMINDER_POLICY_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "items", tableColumns(db, "items"), "reminder_policy", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(REMINDER_POLICY_MIGRATION_VERSION, "reminder-policy-v1");
  })();
}

// v50：代查（Slack 代查与按信心代回 spec D1；v49 是 master 的 lead_waits）。只加 channel_lookups 表和它的三个索引（schema.ts 的 CHANNEL_LOOKUPS_SCHEMA）。
// 表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行（包括 channel_cards 和 items 的生命周期字段），
// 也不回填：上线以前没有代查。
function migrateChannelLookups(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(CHANNEL_LOOKUPS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(CHANNEL_LOOKUPS_MIGRATION_VERSION, "channel-lookups-v1");
}

// v52：交付快照（工单 04，spec 5.5、D8）。只加 delivery_snapshots 表和它的两个索引（schema.ts 的 DELIVERY_SNAPSHOTS_SCHEMA）。
// 表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，item 的生命周期字段一个都不动。
// 不在迁移里回填：补存要跑 git，迁移不能等它。v52 以前交付的工单，第一次打开交付视图时补存一份（backfilled=1）。
function migrateDeliverySnapshots(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(DELIVERY_SNAPSHOTS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(DELIVERY_SNAPSHOTS_MIGRATION_VERSION, "delivery-snapshots-v1");
}

// v53：执行计划（工单详情与验收 spec 5.2，工单 06）。只加 item_execution_plans 表和它的触发器（schema.ts 的
// EXECUTION_PLANS_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，也不回填：
// checkpoint 里旧的 proof_items 不迁移成计划（D2）。
function migrateExecutionPlans(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(EXECUTION_PLANS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(EXECUTION_PLANS_MIGRATION_VERSION, "execution-plans-v1");
}

// v55：子 agent 的权限清单。只加 run_grants、run_grant_changes、run_tool_calls 三张表和它们的索引
// （schema.ts 的 RUN_GRANTS_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，
// item 和 Run 的生命周期字段一个都不动，也不回填：上线以前的 Run 都没有清单，连接中心对它们照旧按角色和写入策略放行。
function migrateRunGrants(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUN_GRANTS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(RUN_GRANTS_MIGRATION_VERSION, "run-grants-v1");
}

// v54：结构化验收标准（工单详情与验收 spec 4.3、5.1、D5、D6，工单 05）。只加 item_acceptance_criteria、criterion_confirmations、
// item_acceptance_criterion_revisions、executor_criteria_views 四张表、它们的索引和触发器（schema.ts 的 ACCEPTANCE_CRITERIA_SCHEMA）。表由 SCHEMA 建，新库和老库一样；这里只记版本。
// 不改任何已有的表和行，也不回填：brief 里写的验收标准不拆成结构化字段（spec 4.3「不从 brief 文本里拆出来」）。
function migrateAcceptanceCriteria(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(ACCEPTANCE_CRITERIA_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(ACCEPTANCE_CRITERIA_MIGRATION_VERSION, "acceptance-criteria-v1");
}

// v56：核查员和执行者一起选，删掉 review_policy（工单详情与验收 spec 5.6、5.9、D3、D12，工单 09）。
// - item_reviewer_settings 表由 SCHEMA 建，新库和老库一样（schema.ts 的 REVIEWER_SETTINGS_SCHEMA）。不回填：升级以前没有人选过核查员。
// - review_policy 和 verification_policy 说的是同一件事。以前 review_policy='automatic' 单独就要求独立核查
//   （automatic-review.ts 的旧判断）；代码以后只读 verification_policy，所以这些工单的 verification_policy 设成
//   independent_reviewer，升级以后仍然要求独立核查。只改这一列：生命周期字段（stage、plan_state、closed_at……）和
//   updated_at 一个都不动，也不记活动。
// - review_policy 列不删：items 的表级 CHECK（C2）引用它，ALTER TABLE DROP COLUMN 会失败；为删一列重建 items 会碰到
//   items 上的全部触发器和列（DDL 重写会悄悄丢列）。列留在表里，代码不再读写它。
function migrateReviewerChoice(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(REVIEWER_CHOICE_MIGRATION_VERSION)) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE items SET verification_policy='independent_reviewer'
       WHERE kind='task' AND review_policy='automatic' AND verification_policy IS NOT 'independent_reviewer'`,
    ).run();
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(REVIEWER_CHOICE_MIGRATION_VERSION, "reviewer-choice-v1");
  })();
}

// v57：核查包和逐条结论（工单详情与验收 spec 5.7、5.9、D8，工单 10）。只加 review_packets、review_verdict_details、
// review_criterion_verdicts 三张表、它们的索引和触发器（schema.ts 的 REVIEW_PACKETS_SCHEMA）。表由 SCHEMA 建，新库和老库一样；
// 这里只记版本。不改任何已有的表和行，也不回填：以前的核查没有核查包，结论只有总结论和证据，读的时候照实显示「没有核查包」。
function migrateReviewPackets(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(REVIEW_PACKETS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(REVIEW_PACKETS_MIGRATION_VERSION, "review-packets-v1");
}

// v58：授权托管时预先勾选「核查做不成时由 Lead 凭证据验收」（工单详情与验收 spec 5.8、D11，工单 11）。
// delegation_policies 加一列 accept_without_review（默认 0：没勾）。只加列，不重建表，已有的授权照旧：核查做不成时等你验收。
// 工单的生命周期字段一个都不动。
function migrateDelegationAcceptWithoutReview(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(DELEGATION_ACCEPT_WITHOUT_REVIEW_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "delegation_policies", tableColumns(db, "delegation_policies"), "accept_without_review",
      "INTEGER NOT NULL DEFAULT 0 CHECK (accept_without_review IN (0, 1))");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(DELEGATION_ACCEPT_WITHOUT_REVIEW_MIGRATION_VERSION, "delegation-accept-without-review-v1");
  })();
}

// v59：后台检查（.scratch/lead-watch/spec.md）。只加 watches、watch_checks 两张表和它们的索引（schema.ts 的 WATCHES_SCHEMA）。
// 表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，规则（triggers）的 C5 检查不变，也不回填。
function migrateWatches(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(WATCHES_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(WATCHES_MIGRATION_VERSION, "watches-v1");
}

// v60：启用 Hindsight 时以它为主（.scratch/hindsight-primary-memory/spec.md D3、D5）。memory_sync、memory_invalidations
// 两张表由 SCHEMA 建，常驻偏好的改动记录 core_memory_changes 也是（2026-10-29 加进同一个版本：v60 还没合并、没部署）。
// 新表是空的，不回填：以前的常驻偏好没有改动记录，页面上的「最近一次改动」是空的。
// 这里删掉 kv 里旧的同步游标和「跳过的笔记」（memory.<后端>.<索引>.synced_through / .skipped）。
// 新表是空的，所以第一次同步把全部笔记按新的方式再写一遍，并跟踪每个任务的成败（旧游标不知道任务成没成）。
// notes 表和工单的生命周期字段一个都不动。待忘掉的清单（memory.pending_forget）留着，照常补做。
function migrateMemorySync(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MEMORY_SYNC_MIGRATION_VERSION)) return;
  db.transaction(() => {
    db.prepare("DELETE FROM kv WHERE key LIKE 'memory.%.synced_through' OR key LIKE 'memory.%.skipped'").run();
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(MEMORY_SYNC_MIGRATION_VERSION, "memory-sync-v1");
  })();
}

// v61：自定义控件（.scratch/custom-views/spec.md D1）。只加 widgets 一张表和它的索引（schema.ts 的 WIDGETS_SCHEMA）。
// 表由 SCHEMA 建，新库和老库一样；这里只记版本。不改任何已有的表和行，工单的生命周期字段一个都不动，也不回填。
function migrateWidgets(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(WIDGETS_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(WIDGETS_MIGRATION_VERSION, "widgets-v1");
}

// v62：控件的数据源（.scratch/custom-views/spec.md D3，第二期）。只加 widget_sources 一张表和它的索引
// （schema.ts 的 WIDGET_SOURCES_SCHEMA）。表由 SCHEMA 建；这里只记版本。不改 widgets 和任何已有的行，也不回填：
// 已有的控件照旧是快照。工单的生命周期字段一个都不动。
function migrateWidgetSources(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(WIDGET_SOURCES_MIGRATION_VERSION)) return;
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(WIDGET_SOURCES_MIGRATION_VERSION, "widget-sources-v1");
}

// v38：派发请求和 Run 加一列 effort。只加列，不重建表，已有的列和行原样保留。
// v39：工单加一列显示用的短标题。只加列，不重建 items：别的列和行原样保留。
// 它不是执行列，不进 C2 的 CHECK（提醒也可以有短标题）。
function migrateItemDisplayTitle(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(ITEM_DISPLAY_TITLE_MIGRATION_VERSION)) return;
  db.transaction(() => {
    addColumn(db, "items", tableColumns(db, "items"), "display_title", "TEXT");
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(ITEM_DISPLAY_TITLE_MIGRATION_VERSION, "item-display-title-v1");
  })();
}

// v40：工单节点。表由 SCHEMA 建（新库、老库一样）；这里只回填一次：每个有 due_at 的 task 一个截止节点，
// 出处是 system，改动记录写 "v40 backfill"。已经有截止节点的跳过。不改 items 的任何列，包括已结束工单的截止
// （日程按工单是否结束显示，不改节点状态）。
function migrateItemMilestones(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(ITEM_MILESTONES_MIGRATION_VERSION)) return;
  db.transaction(() => {
    const now = new Date().toISOString();
    const tasks = db.prepare(
      `SELECT id, due_at FROM items i
       WHERE kind = 'task' AND due_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM item_milestones m WHERE m.item_id = i.id AND m.kind = 'due')
       ORDER BY id`,
    ).all() as { id: number; due_at: string }[];
    const insertMilestone = db.prepare(
      `INSERT INTO item_milestones (item_id, kind, at, all_day, state, source_actor, created_at, updated_at)
       VALUES (?, 'due', ?, 0, 'planned', 'system', ?, ?)`,
    );
    const insertChange = db.prepare(
      `INSERT INTO item_milestone_changes (milestone_id, actor, change, before_json, after_json, reason, created_at)
       VALUES (?, 'system', 'created', NULL, ?, 'v40 backfill', ?)`,
    );
    for (const task of tasks) {
      const milestoneId = Number(insertMilestone.run(task.id, task.due_at, now, now).lastInsertRowid);
      insertChange.run(milestoneId, JSON.stringify({ kind: "due", label: null, at: task.due_at, allDay: false, state: "planned" }), now);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(ITEM_MILESTONES_MIGRATION_VERSION, "item-milestones-v1");
  })();
}

function migrateRunEffort(db: Db): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(RUN_EFFORT_MIGRATION_VERSION)) return;
  db.transaction(() => {
    for (const table of ["runs", "dispatch_requests"]) {
      const columns = tableColumns(db, table);
      for (const [name, ddl] of RUN_EFFORT_COLUMNS) addColumn(db, table, columns, name, ddl);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RUN_EFFORT_MIGRATION_VERSION, "run-effort-v1");
  })();
}

// 就地迁移：CREATE TABLE IF NOT EXISTS 不会给老库加新列
export function migrateDb(db: Db): void {
  const cols = new Set(
    (db.pragma("table_info(items)") as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("priority")) {
    db.exec(`ALTER TABLE items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
             CHECK (priority IN ('urgent','high','normal','low'))`);
  }
  if (!cols.has("project")) {
    db.exec("ALTER TABLE items ADD COLUMN project TEXT");
  }
  if (!cols.has("due_at")) {
    db.exec("ALTER TABLE items ADD COLUMN due_at TEXT");
    db.exec("ALTER TABLE items ADD COLUMN remind_at TEXT");
    db.exec("ALTER TABLE items ADD COLUMN due_overdue_notified INTEGER NOT NULL DEFAULT 0");
  }
  // bindings 连接凭证列（M6.1 自动重连）
  const bcols = new Set(
    (db.pragma("table_info(bindings)") as Array<{ name: string }>).map((c) => c.name),
  );
  if (bcols.size > 0 && !bcols.has("conn_url")) {
    db.exec("ALTER TABLE bindings ADD COLUMN conn_url TEXT");
    db.exec("ALTER TABLE bindings ADD COLUMN conn_secret TEXT");
  }
  const pcols = new Set(
    (db.pragma("table_info(pairings)") as Array<{ name: string }>).map((c) => c.name),
  );
  if (pcols.size > 0 && !pcols.has("socket_secret_hash")) {
    db.exec("ALTER TABLE pairings ADD COLUMN socket_secret_hash TEXT");
  }
  // notes.kind 分类（M9 spec §A1）
  const ncols = new Set(
    (db.pragma("table_info(notes)") as Array<{ name: string }>).map((c) => c.name),
  );
  if (ncols.size > 0 && !ncols.has("kind")) {
    // 枚举需与 schema.ts 的 notes.kind CHECK 保持同步
    db.exec(`ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('profile','preference','fact','note'))`);
  }

  migrateKernelV1(db);
  migrateCheckpointControlPlane(db);
  migratePlanItemKeys(db);
  migrateCheckpointFidelityStorage(db);
  // runs 的重建与 items 的相反，必须压在队尾而不是抢在 exec(SCHEMA) 前面，见函数注释。
  migrateRunsShape(db);
  // items 的重建本身发生在 openDb 更早的 migrateItemModel 里（它必须抢在 exec(SCHEMA)
  // 前面），版本号却要压到队尾才记，账本才保持单调：13 失败时不该看到 14 已应用。
  recordItemModelMigration(db);
  // v15 的第二半。必须排在 exec(SCHEMA) 之后——它要往 SCHEMA 刚建好的 triggers 表里搬行。
  // （第一半 migrateLeadInboxScope 出于相反的理由排在 exec(SCHEMA) 之前，见那里的注释。）
  migrateSchedulesIntoTriggers(db);
  recordTriggerLayerMigration(db);
  // v16 的改名本身发生在 openDb 更早的 migrateItemRename 里（同样必须抢在 exec(SCHEMA)
  // 前面），版本号压到队尾才记，理由与 14 相同：账本必须单调，15 没落地时不该看到 16。
  // migrateRunsShape 以这一行为门控，所以它必须排在记账之前。
  recordItemRenameMigration(db);
  recordTicketRelationsMigration(db);
  migrateDelegationWorkflow(db);
  migrateRelationExecutionGate(db);
  migrateOutcomeSnapshots(db);
  migrateTicketAgentExecutionContinuation(db);
  migrateOutcomeRecoveryScope(db);
  migrateWorkspaceModel(db);
  migrateReviewWorkspaceHashes(db);
  migrateWorkspaceSnapshotArtifacts(db);
  migrateRunTypedFailure(db);
  migrateRuntimeHealthLedger(db);
  migrateRuntimeIncidentRecovery(db);
  migrateRunRuntimeProfileHash(db);
  migrateDispatchBackoff(db);
  migrateRunLauncher(db);
  // v35–v37：工单 #66 复核后的一次性数据更正（data-corrections.ts）。
  migrateReworkGrantAttribution(db);
  migrateSpuriousOutcomeRecords(db);
  migrateTicketAgentTurnText(db);
  migrateRunEffort(db);
  migrateItemDisplayTitle(db);
  migrateItemMilestones(db);
  migrateDecisionOrigin(db);
  migrateConnections(db);
  migrateEventLog(db);
  migrateStandingOrders(db);
  migrateEventTriageShadow(db);
  migrateChannels(db);
  migrateBindingOrigin(db);
  migrateReminderPolicy(db);
  migrateLeadWaits(db);
  migrateChannelLookups(db);
  // v51：按新口径重算修复以前写下的 token 用量（token-usage-recompute.ts）。
  migrateTokenUsageRecompute(db);
  migrateDeliverySnapshots(db);
  migrateExecutionPlans(db);
  migrateAcceptanceCriteria(db);
  migrateRunGrants(db);
  migrateReviewerChoice(db);
  migrateReviewPackets(db);
  migrateDelegationAcceptWithoutReview(db);
  migrateWatches(db);
  migrateMemorySync(db);
  migrateWidgets(db);
  migrateWidgetSources(db);
}

const ITEM_MODEL_MIGRATION_VERSION = 14;
const TRIGGER_LAYER_MIGRATION_VERSION = 15;
const ITEM_RENAME_MIGRATION_VERSION = 16;
const TICKET_RELATIONS_MIGRATION_VERSION = 17;
const DELEGATION_WORKFLOW_MIGRATION_VERSION = 18;
const RELATION_EXECUTION_GATE_MIGRATION_VERSION = 19;
const OUTCOME_SNAPSHOT_MIGRATION_VERSION = 20;
const TICKET_AGENT_EXECUTION_CONTINUATION_MIGRATION_VERSION = 21;
const OUTCOME_RECOVERY_SCOPE_MIGRATION_VERSION = 22;
export const LATEST_SCHEMA_VERSION = WIDGET_SOURCES_MIGRATION_VERSION;

// 旧 status → 新 status。backlog 映射到 ready 而不是 draft：旧 backlog 是可以被直接派发的，
// 映射到 draft 会让存量工单突然需要用户逐个确认，等于用迁移改变了既有行为。
const legacyStageMap = (status: string) => `
  CASE ${status}
    WHEN 'backlog'     THEN 'ready'
    WHEN 'assigned'    THEN 'active'
    WHEN 'in_progress' THEN 'active'
    ELSE ${status}
  END`;

function tableExists(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

// v14：items 升级为 Item（kind + 按 kind 分层的 stage + C1–C4）。SQLite 不能 ALTER CHECK，
// 只能建新表 → INSERT SELECT → DROP → RENAME，沿用 migrateCheckpointFidelityStorage 的写法。
// 导出是为了让别处（迁移测试、doctor）能指向同一份实现，而不是各自复制一遍重建逻辑。
//
// 只按物理形状判断要不要重建，不查 schema_migrations：本函数必须跑在 exec(SCHEMA) 之前，
// 那时账本表可能还不存在；而版本号要等 10–13 都跑完才能记（见 recordItemModelMigration），
// 否则 13 失败时账本里会出现"14 已应用、13 未应用"这种自相矛盾的状态。表的实际形状是这里
// 唯一不会说谎的信号。
export function migrateItemModel(db: Db): void {
  // 此刻表已被 v16 改成 items（见 openDb 的排序注释），列名也已是新词汇。
  if (!tableExists(db, "items")) return;             // 全新库：交给 SCHEMA 直接建新形状
  if (tableColumns(db, "items").has("kind")) return; // 已是 v14 形状
  rebuildItemsWithKind(db);
}

// v15 的第一半：inbox（spec §5.5 的 lead_inbox）的 item_id 去 NOT NULL，并补一列
// dedup_scope 作为去抖/熔断的显式分组键。CHECK 与 NOT NULL 都不能 ALTER，只能整表重建。
//
// 位置与 migrateItemModel 同侧（exec(SCHEMA) 之前），理由也相同：SCHEMA 里的 inbox_scope
// 索引引用 dedup_scope，老库上跑 exec(SCHEMA) 会先于任何迁移抛 "no such column"，
// openDb 当场失败，排在它后面的 migrateDb 永远轮不到。和 migrateRunsShape 正好相反——
// runs 在 SCHEMA 里不带任何索引，所以那一支才能安心压到队尾。
//
// 同样只按物理形状门控、不查 schema_migrations：此刻账本表可能还不存在。
export function migrateLeadInboxScope(db: Db): void {
  if (!tableExists(db, "inbox")) return;                     // 全新库：交给 SCHEMA 直接建新形状
  if (tableColumns(db, "inbox").has("dedup_scope")) return;  // 已是 v15 形状

  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const before = (db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
      db.exec("DROP TABLE IF EXISTS inbox_v15");
      db.exec(inboxTableSql("inbox_v15"));
      // 存量行一律挂着事项（老 DDL 是 NOT NULL），所以回填 'item:' || item_id 一定成立，
      // 也正好满足新表那条 scope 必须与 item_id 一致的 CHECK。
      db.exec(`
        INSERT INTO inbox_v15 (
          id, item_id, dedup_scope, severity, source, summary, payload,
          state, created_at, delivered_at
        )
        SELECT id, item_id, 'item:' || item_id, severity, source, summary, payload,
               state, created_at, delivered_at
        FROM inbox ORDER BY id
      `);
      const after = (db.prepare("SELECT COUNT(*) AS n FROM inbox_v15").get() as { n: number }).n;
      if (before !== after) throw new Error("lead inbox migration changed ledger row counts");

      db.exec("DROP TABLE inbox");
      db.exec("ALTER TABLE inbox_v15 RENAME TO inbox");

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`lead inbox migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

export function migrateNotificationDedupKey(db: Db): void {
  if (!tableExists(db, "notifications")) return;
  const columns = tableColumns(db, "notifications");
  if (columns.has("dedup_key")) return;
  db.exec("ALTER TABLE notifications ADD COLUMN dedup_key TEXT");
}

// ── v16：把物理词汇从 ticket/attempt 收敛到 item/run ────────────────────────────
// spec §14 当初推迟改名，条件是「语义先稳定」；四原语模型落地后条件已满足。
// 线上字段名（ticketId / attemptId / settled / crashed）不在此列——那是已发布契约，
// 由 gateway 投影层显式映射回去，不是漏改。
//
// 全局列改名：按列名精确匹配，逐表施加。哪张表有就改哪张，缺列跳过——老库的形状千差万别，
// 逐个形状写分支只会漏。
const RENAMED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["ticket_id", "item_id"],
  ["attempt_id", "run_id"],
  ["parent_ticket_id", "parent_item_id"],
  ["root_ticket_id", "root_item_id"],
  ["child_ticket_id", "child_item_id"],
  ["depends_on_ticket_id", "depends_on_item_id"],
  ["plan_owner_ticket_id", "plan_owner_item_id"],
  ["produced_ticket_id", "produced_item_id"],
  ["created_by_attempt_id", "created_by_run_id"],
  ["related_ticket_ids", "related_item_ids"],
];

// 只在 items 上改的列。这几个名字（尤其 status）在别的表上另有其意，全局改会误伤：
// approvals / projects / trigger_fires / capabilities … 都有自己的 status。
const RENAMED_ITEM_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["status", "stage"],
  ["orchestration_state", "plan_state"],
  ["first_started_at", "first_run_at"],
  ["completed_at", "closed_at"],
  ["status_changed_at", "stage_changed_at"],
];

const RENAMED_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["tickets", "items"],
  ["attempts", "runs"],
  ["ticket_plan_revisions", "item_plan_revisions"],
  ["ticket_plan_memberships", "item_plan_memberships"],
  ["ticket_dependencies", "item_dependencies"],
  ["ticket_proof_items", "item_proof_items"],
];

// SQLite 的 RENAME 会重写触发器体与索引定义里的列引用，但不会改**对象自己的名字**。
// 留着不管，exec(SCHEMA) 会照新名再建一份，同一份索引从此有两个实体各自维护。
// 所以旧名一律 DROP。
const RENAMED_TRIGGERS = [
  "tickets_kind_immutable", "tickets_tree_is_task_i", "tickets_tree_is_task_u",
] as const;

// 由 exec(SCHEMA) 负责重建的索引：这里只 DROP 旧名，新名紧接着就会被建出来。
const SCHEMA_OWNED_INDEXES = [
  "tickets_by_view", "tickets_by_root", "tickets_remind", "tickets_due",
  "approvals_ticket_status", "channel_turns_ticket_created", "ticket_dependencies_target",
] as const;

// 由各自迁移（v11/v12/v13）建出来、而那些迁移都按版本号门控、在 v15 库上不会再跑的索引。
// 没人替它们重建，只能在这里 DROP 旧名 + 建新名。
const MIGRATION_OWNED_INDEXES: ReadonlyArray<{
  readonly from: string;
  readonly to: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly sql: string;
}> = [
  {
    from: "attempts_external_session", to: "runs_external_session",
    table: "runs", columns: ["external_session_id"],
    sql: "CREATE INDEX IF NOT EXISTS runs_external_session ON runs(external_session_id, id)",
  },
  {
    from: "approvals_attempt", to: "approvals_run",
    table: "approvals", columns: ["run_id"],
    sql: "CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, id)",
  },
  {
    from: "ticket_plan_memberships_item_key", to: "item_plan_memberships_item_key",
    table: "item_plan_memberships", columns: ["parent_item_id", "revision", "item_key"],
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS item_plan_memberships_item_key
          ON item_plan_memberships(parent_item_id, revision, item_key)
          WHERE item_key IS NOT NULL`,
  },
  {
    from: "checkpoints_ticket_id", to: "checkpoints_item_id",
    table: "checkpoints", columns: ["item_id"],
    sql: "CREATE INDEX IF NOT EXISTS checkpoints_item_id ON checkpoints(item_id, id)",
  },
  {
    from: "checkpoints_attempt_id", to: "checkpoints_run_id",
    table: "checkpoints", columns: ["run_id"],
    sql: "CREATE INDEX IF NOT EXISTS checkpoints_run_id ON checkpoints(run_id, id)",
  },
  {
    from: "decision_requests_ticket_state", to: "decision_requests_item_state",
    table: "decision_requests", columns: ["item_id", "state"],
    sql: `CREATE INDEX IF NOT EXISTS decision_requests_item_state
          ON decision_requests(item_id, state, id)`,
  },
  {
    from: "decision_requests_attempt", to: "decision_requests_run",
    table: "decision_requests", columns: ["run_id"],
    sql: "CREATE INDEX IF NOT EXISTS decision_requests_run ON decision_requests(run_id, id)",
  },
  {
    from: "conversation_cards_ticket", to: "conversation_cards_item",
    table: "conversation_cards", columns: ["item_id"],
    sql: "CREATE INDEX IF NOT EXISTS conversation_cards_item ON conversation_cards(item_id, id)",
  },
  {
    from: "artifacts_ticket_id", to: "artifacts_item_id",
    table: "artifacts", columns: ["item_id"],
    sql: "CREATE INDEX IF NOT EXISTS artifacts_item_id ON artifacts(item_id, id)",
  },
  {
    from: "ticket_proof_items_ticket_state", to: "item_proof_items_item_state",
    table: "item_proof_items", columns: ["item_id", "state", "checkpoint_id", "proof_key"],
    sql: `CREATE INDEX IF NOT EXISTS item_proof_items_item_state
          ON item_proof_items(item_id, state, checkpoint_id, proof_key)`,
  },
  {
    from: "ticket_proof_items_checkpoint", to: "item_proof_items_checkpoint",
    table: "item_proof_items", columns: ["checkpoint_id", "item_id", "proof_key"],
    sql: `CREATE INDEX IF NOT EXISTS item_proof_items_checkpoint
          ON item_proof_items(checkpoint_id, item_id, proof_key)`,
  },
];

function userTables(db: Db): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts%'`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

// 标识符不能参数化绑定，只能拼进 DDL。表名来自 sqlite_master、列名来自上面的常量表，
// 都不是外部输入；仍然过一道白名单，免得将来有人把用户可控的名字接进来。
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`item rename: refusing to touch unsafe identifier ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

function renameColumnIfPresent(db: Db, table: string, from: string, to: string): void {
  const columns = tableColumns(db, table);
  if (!columns.has(from)) return;
  if (columns.has(to)) {
    throw new Error(`item rename: ${table} already has a column named ${to}`);
  }
  db.exec(
    `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`,
  );
}

// v16：表与列改名。SQLite 3.25+ 的 RENAME TO / RENAME COLUMN 会连带重写外键子句、
// 触发器体、索引定义与视图，因此不需要整表重建——唯一的例外是 runs.state 的**值**，
// 那受 CHECK 约束，交给队尾的 migrateRunsShape 重建（见那里的注释）。
//
// 位置：整条链的**最前面**，早于 exec(SCHEMA)，也早于 v14/v15（详见 openDb 的注释）。
// 与 migrateItemModel 同侧、更靠前一步：那一支要重建 items，用的是 schema.ts 里已经改过
// 名的表体函数，先改名它才有一张 items 可以自引用。
// 代价是本函数得能吃下任意历史形状——所以它按列名逐表匹配、缺列即跳过，而不是为每个
// 历史版本各写一条分支。
//
// 只按物理形状门控、不查 schema_migrations：本函数跑在 exec(SCHEMA) 之前，账本表可能
// 还不存在；版本号由队尾的 recordItemRenameMigration 记，理由与 v14 相同。
export function migrateItemRename(db: Db): void {
  if (!tableExists(db, "tickets")) return; // 全新库，或已经改过名

  // RENAME TO 只有在 foreign_keys 打开时才会跟着改别的表里的 REFERENCES 子句；关着的话
  // 那些子句会继续指向一张不存在的 tickets，foreign_key_check 立刻就能看见。
  // pragma 在事务里是空操作，必须在开事务之前设。
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      const beforeItems = (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
      const beforeRuns = tableExists(db, "attempts")
        ? (db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n
        : 0;

      for (const trigger of RENAMED_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      for (const index of SCHEMA_OWNED_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
      for (const { from } of MIGRATION_OWNED_INDEXES) db.exec(`DROP INDEX IF EXISTS ${from}`);

      // 顺序敏感：proof item 的业务键此刻就叫 item_id，必须先让开，否则下一步给同一张表
      // 的 ticket_id 改名时会撞出两个 item_id。
      if (tableExists(db, "ticket_proof_items")) {
        renameColumnIfPresent(db, "ticket_proof_items", "item_id", "proof_key");
      }

      for (const table of userTables(db)) {
        for (const [from, to] of RENAMED_COLUMNS) renameColumnIfPresent(db, table, from, to);
      }
      for (const [from, to] of RENAMED_ITEM_COLUMNS) {
        renameColumnIfPresent(db, "tickets", from, to);
      }
      for (const [from, to] of RENAMED_TABLES) {
        if (tableExists(db, from)) {
          db.exec(`ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`);
        }
      }

      for (const index of MIGRATION_OWNED_INDEXES) {
        if (!tableExists(db, index.table)) continue;   // 老库可能压根没有这张表
        const columns = tableColumns(db, index.table);
        if (!index.columns.every((column) => columns.has(column))) continue;
        db.exec(index.sql);
      }

      const afterItems = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
      const afterRuns = tableExists(db, "runs")
        ? (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n
        : 0;
      if (beforeItems !== afterItems || beforeRuns !== afterRuns) {
        throw new Error("item rename migration changed ledger row counts");
      }

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`item rename foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function recordItemModelMigration(db: Db): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(ITEM_MODEL_MIGRATION_VERSION, "item-model-v1");
}

function recordTriggerLayerMigration(db: Db): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(TRIGGER_LAYER_MIGRATION_VERSION, "trigger-notification-v1");
}

function recordItemRenameMigration(db: Db): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(ITEM_RENAME_MIGRATION_VERSION, "item-rename-v1");
}

function recordTicketRelationsMigration(db: Db): void {
  if (!tableExists(db, "ticket_relations")) {
    throw new Error("ticket_relations schema was not created");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)")
    .run(TICKET_RELATIONS_MIGRATION_VERSION, "ticket-relations-v1");
}

function migrateDelegationWorkflow(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(DELEGATION_WORKFLOW_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    const items = tableColumns(db, "items");
    addColumn(db, "items", items, "verification_policy",
      "TEXT CHECK (verification_policy IS NULL OR verification_policy IN ('independent_reviewer','lead_static','user'))");
    addColumn(db, "items", items, "acceptance_policy",
      "TEXT CHECK (acceptance_policy IS NULL OR acceptance_policy IN ('user_only','delegated_to_lead'))");
    addColumn(db, "items", items, "rework_policy",
      "TEXT CHECK (rework_policy IS NULL OR rework_policy IN ('ask_user','automatic'))");
    addColumn(db, "items", items, "delivery_policy",
      "TEXT CHECK (delivery_policy IS NULL OR delivery_policy IN ('notify_only','continue_workflow'))");
    db.prepare(
      `UPDATE items
       SET verification_policy = CASE
             WHEN review_policy = 'automatic' THEN 'independent_reviewer'
             ELSE 'lead_static'
           END,
           acceptance_policy = 'user_only',
           rework_policy = 'ask_user',
           delivery_policy = 'notify_only'
       WHERE kind = 'task'
         AND (
           verification_policy IS NULL OR acceptance_policy IS NULL
           OR rework_policy IS NULL OR delivery_policy IS NULL
         )`,
    ).run();

    const notifications = tableColumns(db, "notifications");
    addColumn(db, "notifications", notifications, "dedup_key", "TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup ON notifications(dedup_key) WHERE dedup_key IS NOT NULL");

    const capabilities = tableColumns(db, "capabilities");
    addColumn(db, "capabilities", capabilities, "implementation_status",
      "TEXT NOT NULL DEFAULT 'unknown' CHECK (implementation_status IN ('unknown','implementation_verified'))");
    addColumn(db, "capabilities", capabilities, "deployment_status",
      "TEXT NOT NULL DEFAULT 'not_deployed' CHECK (deployment_status IN ('not_deployed','deployed'))");
    addColumn(db, "capabilities", capabilities, "lead_tool_status",
      "TEXT NOT NULL DEFAULT 'not_loaded' CHECK (lead_tool_status IN ('not_loaded','loaded'))");

    db.exec(DELEGATION_WORKFLOW_SCHEMA);
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`delegation workflow migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(DELEGATION_WORKFLOW_MIGRATION_VERSION, "delegation-workflow-v1");
  })();
}

function migrateRelationExecutionGate(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(RELATION_EXECUTION_GATE_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    const relations = tableColumns(db, "ticket_relations");
    addColumn(db, "ticket_relations", relations, "execution_gate",
      "TEXT NOT NULL DEFAULT 'none' CHECK (execution_gate IN ('none','target_done'))");
    const duplicates = db.prepare(
      `SELECT implementation.id AS implementation_id,
              dependency.id AS dependency_id,
              implementation.source_item_id,
              implementation.target_item_id
       FROM ticket_relations implementation
       JOIN ticket_relations dependency
         ON dependency.source_item_id=implementation.source_item_id
        AND dependency.target_item_id=implementation.target_item_id
        AND dependency.relation_type='depends_on'
        AND dependency.revoked_at IS NULL
       WHERE implementation.relation_type='implements'
         AND implementation.revoked_at IS NULL`,
    ).all() as Array<{
      implementation_id: number;
      dependency_id: number;
      source_item_id: number;
      target_item_id: number;
    }>;
    for (const row of duplicates) {
      db.prepare("UPDATE ticket_relations SET execution_gate='target_done' WHERE id=?")
        .run(row.implementation_id);
      db.prepare(
        `UPDATE ticket_relations
         SET revoked_at=datetime('now'), revoked_by='system',
             revoke_reason='migrated to implements.execution_gate=target_done in v19'
         WHERE id=? AND revoked_at IS NULL`,
      ).run(row.dependency_id);
      const payload = JSON.stringify({
        decision: "relation_execution_gate_migrated",
        implementationRelationId: row.implementation_id,
        revokedDependencyRelationId: row.dependency_id,
        sourceTicketId: row.source_item_id,
        targetTicketId: row.target_item_id,
        executionGate: "target_done",
      });
      for (const itemId of new Set([row.source_item_id, row.target_item_id])) {
        db.prepare(
          "INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'system', 'decision', ?)",
        ).run(itemId, payload);
      }
    }
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`relation execution gate migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(RELATION_EXECUTION_GATE_MIGRATION_VERSION, "relation-execution-gate-v1");
  })();
}

function migrateOutcomeSnapshots(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(OUTCOME_SNAPSHOT_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    db.exec(OUTCOME_SNAPSHOT_SCHEMA);
    const verdicts = tableColumns(db, "review_verdicts");
    addColumn(db, "review_verdicts", verdicts, "checkpoint_id", "INTEGER REFERENCES checkpoints(id)");
    addColumn(db, "review_verdicts", verdicts, "evidence_refs",
      "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs))");
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`outcome snapshot migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(OUTCOME_SNAPSHOT_MIGRATION_VERSION, "outcome-snapshots-v1");
  })();
}

function migrateTicketAgentExecutionContinuation(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(TICKET_AGENT_EXECUTION_CONTINUATION_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    const runs = tableColumns(db, "runs");
    addColumn(db, "runs", runs, "resumed_from_run_id", "INTEGER REFERENCES runs(id)");
    const dispatches = tableColumns(db, "dispatch_requests");
    addColumn(db, "dispatch_requests", dispatches, "resume_from_run_id", "INTEGER REFERENCES runs(id)");
    addColumn(db, "dispatch_requests", dispatches, "instruction", "TEXT");
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`ticket agent continuation migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(TICKET_AGENT_EXECUTION_CONTINUATION_MIGRATION_VERSION, "ticket-agent-execution-continuation-v1");
  })();
}

function migrateOutcomeRecoveryScope(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(OUTCOME_RECOVERY_SCOPE_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    if (!tableExists(db, "checkpoints") || !tableExists(db, "runs") || !tableExists(db, "items")) {
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(OUTCOME_RECOVERY_SCOPE_MIGRATION_VERSION, "outcome-recovery-scope-v1");
      return;
    }
    const rows = db.prepare(
      `SELECT checkpoint.id AS checkpoint_id, checkpoint.item_id, checkpoint.run_id
       FROM checkpoints checkpoint
       JOIN items item ON item.id=checkpoint.item_id
       JOIN runs run ON run.id=checkpoint.run_id
       WHERE checkpoint.idempotency_key LIKE 'outcome-registration-missing:%'
         AND (
           item.stage IN ('done','cancelled')
           OR datetime(COALESCE(run.ended_at, run.started_at)) < datetime(COALESCE(
             (SELECT applied_at FROM schema_migrations WHERE version=20),
             '9999-12-31 23:59:59'
           ))
         )
       ORDER BY checkpoint.id`,
    ).all() as Array<{ checkpoint_id: number; item_id: number; run_id: number }>;
    const checkpointIds = rows.map((row) => row.checkpoint_id);
    const runIds = rows.map((row) => row.run_id);
    const placeholders = (values: unknown[]) => values.map(() => "?").join(",");
    if (checkpointIds.length) {
      db.prepare(`DELETE FROM conversation_cards WHERE checkpoint_id IN (${placeholders(checkpointIds)})`)
        .run(...checkpointIds);
      db.prepare(
        `DELETE FROM activities
         WHERE kind='notification'
           AND json_extract(payload, '$.checkpointId') IN (${placeholders(checkpointIds)})`,
      ).run(...checkpointIds);
      db.prepare(`DELETE FROM checkpoints WHERE id IN (${placeholders(checkpointIds)})`)
        .run(...checkpointIds);
    }
    if (runIds.length) {
      // Notification bodies are human text, so use the exact durable dedup key.
      for (const runId of runIds) {
        db.prepare("DELETE FROM notifications WHERE dedup_key=?")
          .run(`blocker:outcome-registration-missing:${runId}`);
      }
      db.prepare(
        `DELETE FROM inbox
         WHERE json_extract(payload, '$.blockerCode')='outcome_registration_missing'
           AND json_extract(payload, '$.runId') IN (${placeholders(runIds)})`,
      ).run(...runIds);
    }
    const byItem = new Map<number, number>();
    for (const row of rows) byItem.set(row.item_id, (byItem.get(row.item_id) ?? 0) + 1);
    for (const [itemId, count] of byItem) {
      db.prepare(
        `INSERT INTO activities (item_id, actor, kind, payload)
         VALUES (?, 'system', 'decision', ?)`,
      ).run(itemId, JSON.stringify({
        decision: "historical_outcome_blocker_reconciled",
        reason: "Historical completion predates outcome snapshots; derived blocker projection was invalid.",
        removedDerivedBlockerCount: count,
      }));
    }
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`outcome recovery scope migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(OUTCOME_RECOVERY_SCOPE_MIGRATION_VERSION, "outcome-recovery-scope-v1");
  })();
}

// v15 的第二半：把 schedules 的存量行搬进 triggers，然后 DROP 掉整张表（spec §5.6）。
//
// 只按物理形状门控（schedules 还在就搬），不查账本：schedules 已从 SCHEMA 里删掉，
// exec(SCHEMA) 不会再把它建回来，所以"表还在"这个信号本身就是幂等判据，且不会说谎。
//
// 映射（plan Task 7 / spec §12）：
//   spawn=0 → create_item{kind:'reminder'}。旧行为是每次触发新建一条永不执行的工单，
//            正是 spec §1 记录的缺陷；提醒本来就该是 reminder。
//   spawn=1 → create_and_start{kind:'task', initial_stage:'ready'}。
//   created_by 一律 'user'：存量 schedule 都是用户意图，且 (C5) 要求 create_and_start
//   只能挂在 user 建的 trigger 上。
//   cron_tz 留 NULL：旧 schedules 在运行时按本机时区解析，存 NULL 让 nextRun 继续走
//   本机时区缺省，语义原样保留（spec §10 要求 cron 语义不变）。
function migrateSchedulesIntoTriggers(db: Db): void {
  if (!tableExists(db, "schedules")) return;

  db.transaction(() => {
    const rows = db.prepare("SELECT * FROM schedules ORDER BY id").all() as Array<{
      id: number; title: string; brief: string; cron: string; workdir: string | null;
      priority: string; project: string | null; spawn: number; next_run_at: string;
      enabled: number; created_at: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO triggers (
         label, enabled, created_by, source_type, cron_expr, cron_tz, next_fire_at,
         action_type, action_payload, created_at
       ) VALUES (?, ?, 'user', 'cron', ?, NULL, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const payload = row.spawn
        ? {
            kind: "task", title: row.title, brief: row.brief,
            initial_stage: "ready",
            workdir: row.workdir ?? undefined,
            priority: row.priority, project: row.project ?? undefined,
          }
        : { kind: "reminder", title: row.title, body: row.brief };
      insert.run(
        row.title, row.enabled, row.cron, row.next_run_at,
        row.spawn ? "create_and_start" : "create_item",
        JSON.stringify(payload), row.created_at,
      );
    }
    const moved = (db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n;
    if (moved < rows.length) {
      throw new Error("schedule migration lost rows on the way into triggers");
    }
    db.exec("DROP TABLE schedules");

    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`schedule migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
  }).immediate();
}

// 源表与目标表此刻都已是 v16 的词汇（items / stage / parent_item_id …）——v16 的改名
// 排在本函数之前，见 openDb 的排序注释。这里唯一还讲老话的是**值**：stage 里可能存着
// backlog / assigned / in_progress，由 legacyStageMap 收编。
function rebuildItemsWithKind(db: Db): void {
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF"); // DROP 旧表时子表仍指向它
  try {
    db.transaction(() => {
      const src = tableColumns(db, "items");
      // 很老的库可能连 kernel 列都没有（migrateKernelV1 还没跑过），缺列一律取字面量兜底。
      const col = (name: string, fallback: string) => (src.has(name) ? name : fallback);
      const before = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;

      // 存量提醒的识别。它们是 prompt.ts:38 那条约定（"提醒我 X" → 建工单 + remind_at，
      // 不 spawn child）造出来的，特征很稳定：带 remind_at、从未执行过、还停在 backlog。
      // 三条同时成立才改判——kind 由 (T1) 锁死为不可变，误判一条真任务就是造出一条永远
      // 无法执行、也无法改回去的工单；漏判只是丢一个提醒时间，用户重设即可。因此这里
      // 刻意偏向漏判。
      const neverRan = tableExists(db, "runs")
        ? "NOT EXISTS (SELECT 1 FROM runs a WHERE a.item_id = items.id)"
        : "1";
      const isReminder = src.has("remind_at")
        ? `(remind_at IS NOT NULL AND ${col("stage", "'backlog'")} = 'backlog' AND ${neverRan})`
        : "0";
      // 改判为 reminder 的行必须交出全部执行侧字段，否则撞 (C2)。
      const taskOnly = (expr: string) => `CASE WHEN ${isReminder} THEN NULL ELSE ${expr} END`;
      const legacyReviewPolicy = col("review_policy", "'manual'");
      const verificationPolicy = src.has("verification_policy")
        ? "verification_policy"
        : `CASE WHEN ${legacyReviewPolicy} = 'automatic' THEN 'independent_reviewer' ELSE 'lead_static' END`;

      db.exec("DROP TABLE IF EXISTS items_v14");
      db.exec(itemsTableSql("items_v14"));
      db.exec(`
        INSERT INTO items_v14 (
          id, kind, title, body, stage, brief, priority, project, project_id,
          due_at, defer_until, remind_at, due_overdue_notified,
          parent_item_id, root_item_id,
          workdir, requested_runtime, requested_model, purpose, review_policy,
          verification_policy, acceptance_policy, rework_policy, delivery_policy,
          max_depth, max_children, max_concurrency, token_budget, cost_budget_usd, retry_limit,
          plan_state, active_plan_revision,
          created_by, created_by_run_id,
          created_at, updated_at, stage_changed_at, last_activity_at,
          first_run_at, closed_at, total_tokens, total_cost_usd
        )
        SELECT
          id,
          CASE WHEN ${isReminder} THEN 'reminder' ELSE 'task' END,
          title, ${col("body", "''")},
          CASE WHEN ${isReminder} THEN 'scheduled'
               ELSE ${legacyStageMap(col("stage", "'ready'"))} END,
          brief,
          ${col("priority", "'normal'")}, ${col("project", "NULL")}, ${col("project_id", "NULL")},
          ${col("due_at", "NULL")},
          NULL,
          -- 只有被改判为 reminder 的行留着 remind_at；其余一律丢弃，因为 (C3) 禁止 task 携带它。
          CASE WHEN ${isReminder} THEN ${col("remind_at", "NULL")} ELSE NULL END,
          ${col("due_overdue_notified", "0")},
          ${taskOnly(col("parent_item_id", "NULL"))}, ${taskOnly(col("root_item_id", "NULL"))},
          ${taskOnly(col("workdir", "NULL"))},
          ${taskOnly(col("requested_runtime", "NULL"))}, ${taskOnly(col("requested_model", "NULL"))},
          ${taskOnly(col("purpose", "'execution'"))}, ${taskOnly(legacyReviewPolicy)},
          ${taskOnly(verificationPolicy)},
          ${taskOnly(col("acceptance_policy", "'user_only'"))},
          ${taskOnly(col("rework_policy", "'ask_user'"))},
          ${taskOnly(col("delivery_policy", "'notify_only'"))},
          ${taskOnly(col("max_depth", "NULL"))}, ${taskOnly(col("max_children", "NULL"))},
          ${taskOnly(col("max_concurrency", "NULL"))},
          ${taskOnly(col("token_budget", "NULL"))}, ${taskOnly(col("cost_budget_usd", "NULL"))},
          ${taskOnly(col("retry_limit", "1"))},
          ${taskOnly(col("plan_state", "'none'"))},
          ${taskOnly(col("active_plan_revision", "NULL"))},
          -- 旧表的 created_by 没有 CHECK，可能存着枚举外的字符串；落到 system 而不是让
          -- 整个迁移在一条脏数据上炸掉。
          CASE WHEN ${col("created_by", "NULL")} IN ('user','lead','child','system')
               THEN ${col("created_by", "NULL")} ELSE 'system' END,
          ${col("created_by_run_id", "NULL")},
          ${col("created_at", "datetime('now')")}, ${col("updated_at", "datetime('now')")},
          -- 新列 NOT NULL，老库这里可能是空。回退顺序照抄 v11 的回填
          -- （stage_changed_at = updated_at），否则重建会先塞一个 now 进去，
          -- 把排在后面的 v11 回填挤掉，时间线凭空前移到迁移当天。
          COALESCE(${col("stage_changed_at", "NULL")}, ${col("updated_at", "NULL")},
                   ${col("created_at", "NULL")}, datetime('now')),
          ${col("last_activity_at", "NULL")},
          -- (C2) 还要求 reminder 的 first_run_at 为空、两个用量计数为 0。改判的行按定义
          -- 从未执行过，这里归零只是把该不变量写死，不依赖上面的判据碰巧成立。
          ${taskOnly(col("first_run_at", "NULL"))}, ${col("closed_at", "NULL")},
          CASE WHEN ${isReminder} THEN 0 ELSE ${col("total_tokens", "0")} END,
          CASE WHEN ${isReminder} THEN 0 ELSE ${col("total_cost_usd", "0")} END
        FROM items
        ORDER BY id
      `);

      const after = (db.prepare("SELECT COUNT(*) AS n FROM items_v14").get() as { n: number }).n;
      if (before !== after) throw new Error("item model migration changed ledger row counts");
      const lost = db.prepare(
        `SELECT old.id FROM items old
         LEFT JOIN items_v14 rebuilt ON rebuilt.id = old.id
         WHERE rebuilt.id IS NULL
            OR rebuilt.title <> old.title
            OR rebuilt.brief <> old.brief
         LIMIT 1`,
      ).get();
      if (lost) throw new Error("item model migration failed row-identity verification");

      db.exec("DROP TABLE items");
      db.exec("ALTER TABLE items_v14 RENAME TO items");
      db.exec(ITEMS_CONSTRAINTS_SCHEMA);

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`item model migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

// v14 的另一半，v16 又给它加了第二件差事：
//   1. runs.state 的 CHECK 要多接一个 'paused'，外加 paused_at / paused_ms 两列（spec §5.2）；
//   2. v16 把终态值从 settled/crashed 改成 finished/failed——值本身受 CHECK 约束，
//      光 RENAME 不够，UPDATE 会当场撞 CHECK。两件事都只能靠整表重建，就合成一次。
//
// 位置与 items 的重建正好相反——items 必须抢在 exec(SCHEMA) 之前（SCHEMA 里的索引和
// 触发器引用 kind，老库上会当场抛 "no such column"），runs 却必须压在 migrateDb 队尾：
//   1. SCHEMA 里 runs 不带任何索引/触发器，exec(SCHEMA) 在老库上只会被 IF NOT EXISTS
//      跳过，不存在提前失败的风险，所以没有前置的必要；
//   2. migrateKernelV1 / migrateCheckpointControlPlane 用 ALTER TABLE ADD COLUMN 给 runs
//      补 runtime / purpose / metadata / external_session_id 等列。跑在它们之前，这里就得
//      为每一列各写一份缺省兜底，把它们已经拥有的知识抄第二遍；跑在它们之后，源表必然已是
//      v13 全列形状，复制退化成一次逐列平移。
//
// 门控从"物理形状"改成了账本：值的新旧无法从 pragma 看出来，而嗅探 sqlite_master 里的
// CHECK 文本会被同一段 DDL 的注释误伤（注释里正写着 settled/crashed）。账本此刻一定存在
// ——本函数排在 exec(SCHEMA) 之后。
function migrateRunsShape(db: Db): void {
  if (!tableExists(db, "runs")) return;
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(ITEM_RENAME_MIGRATION_VERSION);
  if (applied) return;

  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF"); // DROP 旧表时 activities/approvals/checkpoints 仍指向它
  try {
    db.transaction(() => {
      const src = tableColumns(db, "runs");
      // 只搬两边都有的列；新列走 DDL 缺省，源表独有的列（若有）随旧表一起退场。
      const carried = [
        "id", "item_id", "workspace_id", "role", "session_id", "session_path", "pid", "state", "model",
        "runtime", "purpose", "runtime_version", "external_session_id", "event_cursor",
        "exit_code", "error_code", "error_message", "metadata", "cost_known", "event_log_dirty",
        "started_at", "ended_at", "last_entry_cursor",
      ].filter((column) => src.has(column));
      // 终态值在复制的同时改写。新表的 CHECK 已经只认 finished/failed，漏掉任何一行都会
      // 让整次重建在那一行上失败——这正是想要的：宁可炸也不要静默留下一个不合法的值。
      const projected = carried.map((column) => (column === "state"
        ? "CASE state WHEN 'settled' THEN 'finished' WHEN 'crashed' THEN 'failed' ELSE state END"
        : column));
      const before = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;

      db.exec("DROP TABLE IF EXISTS runs_v16");
      db.exec(runsTableSql("runs_v16"));
      db.exec(
        `INSERT INTO runs_v16 (${carried.join(", ")})
         SELECT ${projected.join(", ")} FROM runs ORDER BY id`,
      );
      const after = (db.prepare("SELECT COUNT(*) AS n FROM runs_v16").get() as { n: number }).n;
      if (before !== after) throw new Error("run-shape migration changed run row counts");

      db.exec("DROP TABLE runs");
      db.exec("ALTER TABLE runs_v16 RENAME TO runs");
      // 索引随旧表一起被 DROP 掉了，必须重放，否则 external session 查询悄悄退化成全表扫描。
      // 与 migrateCheckpointControlPlane 里那条保持一致。
      db.exec("CREATE INDEX IF NOT EXISTS runs_external_session ON runs(external_session_id, id)");
      // runs_item 由 exec(SCHEMA) 建，但它跑在这次重建之前，索引同样随旧表消失，这里重放。
      db.exec(RUNS_ITEM_INDEX_SQL);

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`run-shape migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

const KERNEL_MIGRATION_VERSION = 10;
const CHECKPOINT_CONTROL_PLANE_MIGRATION_VERSION = 11;
const PLAN_ITEM_KEY_MIGRATION_VERSION = 12;
const CHECKPOINT_FIDELITY_STORAGE_MIGRATION_VERSION = 13;

function tableColumns(db: Db, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
  );
}

function addColumn(db: Db, table: string, columns: Set<string>, name: string, ddl: string): void {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  columns.add(name);
}

function projectSlug(name: string): string {
  const ascii = name.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii) return ascii;
  return `project-${Buffer.from(name).toString("hex").slice(0, 20) || "unknown"}`;
}

function uniqueProjectSlug(db: Db, name: string): string {
  const base = projectSlug(name);
  let slug = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug)) {
    const same = db.prepare("SELECT name FROM projects WHERE slug = ?").get(slug) as { name: string } | undefined;
    if (same?.name === name) return slug;
    slug = `${base.slice(0, 44)}-${suffix++}`;
  }
  return slug;
}

function migrateKernelV1(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(KERNEL_MIGRATION_VERSION);
  if (applied) return;

  const migrateKernel = db.transaction(() => {
    const beforeTickets = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    const beforeAttempts = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    const items = tableColumns(db, "items");
    addColumn(db, "items", items, "project_id", "INTEGER REFERENCES projects(id)");
    addColumn(db, "items", items, "parent_item_id", "INTEGER REFERENCES items(id)");
    addColumn(db, "items", items, "root_item_id", "INTEGER REFERENCES items(id)");
    addColumn(db, "items", items, "created_by_run_id", "INTEGER REFERENCES runs(id)");
    addColumn(db, "items", items, "plan_state",
      "TEXT NOT NULL DEFAULT 'none' CHECK (plan_state IN ('none','planning','waiting','integrating','failed'))");
    addColumn(db, "items", items, "requested_runtime", "TEXT");
    addColumn(db, "items", items, "requested_model", "TEXT");
    addColumn(db, "items", items, "purpose", "TEXT NOT NULL DEFAULT 'execution'");
    addColumn(db, "items", items, "review_policy",
      "TEXT NOT NULL DEFAULT 'manual' CHECK (review_policy IN ('manual','automatic'))");
    addColumn(db, "items", items, "max_depth", "INTEGER");
    addColumn(db, "items", items, "max_children", "INTEGER");
    addColumn(db, "items", items, "max_concurrency", "INTEGER");
    addColumn(db, "items", items, "token_budget", "INTEGER");
    addColumn(db, "items", items, "cost_budget_usd", "REAL");
    addColumn(db, "items", items, "retry_limit", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "items", items, "active_plan_revision", "INTEGER");

    const runs = tableColumns(db, "runs");
    addColumn(db, "runs", runs, "runtime", "TEXT NOT NULL DEFAULT 'pi'");
    addColumn(db, "runs", runs, "purpose", "TEXT NOT NULL DEFAULT 'execution'");
    addColumn(db, "runs", runs, "runtime_version", "TEXT");
    addColumn(db, "runs", runs, "external_session_id", "TEXT");
    addColumn(db, "runs", runs, "event_cursor", "TEXT");
    addColumn(db, "runs", runs, "exit_code", "INTEGER");
    addColumn(db, "runs", runs, "error_code", "TEXT");
    addColumn(db, "runs", runs, "error_message", "TEXT");
    addColumn(db, "runs", runs, "metadata", "TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, "runs", runs, "cost_known", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "runs", runs, "event_log_dirty", "INTEGER NOT NULL DEFAULT 0");

    // 自根回填只针对 task。v14 已经在 exec(SCHEMA) 之前跑过，所以此刻 kind 列必然存在；
    // 少了这个限定，刚被 v14 改判出来的 reminder 会被补上 root_item_id 而撞 (C2)。
    db.prepare(
      "UPDATE items SET root_item_id = id WHERE root_item_id IS NULL AND kind = 'task'",
    ).run();
    const legacyProjects = db.prepare(
      "SELECT DISTINCT project FROM items WHERE project IS NOT NULL AND trim(project) <> '' ORDER BY project",
    ).all() as Array<{ project: string }>;
    for (const { project } of legacyProjects) {
      let row = db.prepare(
        "SELECT id FROM projects WHERE name = ? AND status = 'active' ORDER BY id LIMIT 1",
      ).get(project) as { id: number } | undefined;
      if (!row) {
        const result = db.prepare(
          "INSERT INTO projects (slug, name, created_by) VALUES (?, ?, 'migration:legacy-project')",
        ).run(uniqueProjectSlug(db, project), project);
        row = { id: Number(result.lastInsertRowid) };
      }
      db.prepare("UPDATE items SET project_id = ? WHERE project = ? AND project_id IS NULL")
        .run(row.id, project);
    }

    const afterTickets = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    const afterAttempts = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    if (beforeTickets !== afterTickets || beforeAttempts !== afterAttempts) {
      throw new Error("kernel migration changed ledger row counts");
    }
    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) throw new Error(`kernel migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(KERNEL_MIGRATION_VERSION, "kernel-orchestration-v1");
  });
  migrateKernel();
}

function migrateCheckpointControlPlane(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(CHECKPOINT_CONTROL_PLANE_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    const items = tableColumns(db, "items");
    addColumn(db, "items", items, "first_run_at", "TEXT");
    addColumn(db, "items", items, "closed_at", "TEXT");
    addColumn(db, "items", items, "stage_changed_at", "TEXT");

    const approvals = tableColumns(db, "approvals");
    addColumn(db, "approvals", approvals, "run_id", "INTEGER REFERENCES runs(id)");
    db.exec("CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, id)");
    if (tableColumns(db, "runs").has("external_session_id")) {
      db.exec("CREATE INDEX IF NOT EXISTS runs_external_session ON runs(external_session_id, id)");
    }
    db.exec(CHECKPOINT_CONTROL_PLANE_SCHEMA);

    db.prepare(
      `UPDATE items
       SET first_run_at = (
         SELECT MIN(runs.started_at) FROM runs WHERE runs.item_id = items.id
       )
       WHERE first_run_at IS NULL`,
    ).run();
    db.prepare(
      "UPDATE items SET stage_changed_at = updated_at WHERE stage_changed_at IS NULL",
    ).run();
    db.prepare(
      `UPDATE items SET closed_at = updated_at
       WHERE closed_at IS NULL AND stage IN ('done','cancelled')`,
    ).run();

    const fkErrors = db.pragma("foreign_key_check") as unknown[];
    if (fkErrors.length) {
      throw new Error(`checkpoint migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(CHECKPOINT_CONTROL_PLANE_MIGRATION_VERSION, "checkpoint-control-plane-v1");
  })();
}

function migratePlanItemKeys(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(PLAN_ITEM_KEY_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    const memberships = tableColumns(db, "item_plan_memberships");
    addColumn(db, "item_plan_memberships", memberships, "item_key", "TEXT");
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS item_plan_memberships_item_key
       ON item_plan_memberships(parent_item_id, revision, item_key)
       WHERE item_key IS NOT NULL`,
    );
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(PLAN_ITEM_KEY_MIGRATION_VERSION, "plan-item-idempotency-v1");
  })();
}

function checkpointV13TableSql(table: string): string {
  return `
    CREATE TABLE ${table} (
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
    )`;
}

function legacyArtifactName(ref: string): string {
  return basename(ref.replaceAll("\\", "/")) || ref;
}

function backfillLegacyArtifacts(db: Db): void {
  const seen = new Set<string>();
  const rows = db.prepare(
    `SELECT id, item_id, run_id, artifact_refs, created_at
     FROM checkpoints ORDER BY id`,
  ).all() as Array<{
    id: number;
    item_id: number;
    run_id: number | null;
    artifact_refs: string;
    created_at: string;
  }>;
  const insert = db.prepare(
    `INSERT INTO artifacts (
       item_id, run_id, checkpoint_id, ref, name, kind, media_type, description,
       original_filename, sha256, byte_length, storage_key, availability, created_at
     ) VALUES (?, ?, ?, ?, ?, 'reference', 'application/octet-stream', NULL,
               NULL, NULL, NULL, NULL, 'metadata_only', ?)`,
  );
  for (const row of rows) {
    let refs: unknown;
    try {
      refs = JSON.parse(row.artifact_refs);
    } catch (error) {
      throw new Error(`checkpoint ${row.id} artifact refs contain invalid JSON`, { cause: error });
    }
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !ref)) {
      throw new Error(`checkpoint ${row.id} artifact refs must be a non-empty string array`);
    }
    for (const ref of refs) {
      const key = `${row.item_id}\0${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insert.run(
        row.item_id,
        row.run_id,
        row.id,
        ref,
        legacyArtifactName(ref),
        row.created_at,
      );
    }
  }
}

function migrateCheckpointFidelityStorage(db: Db): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(CHECKPOINT_FIDELITY_STORAGE_MIGRATION_VERSION);
  if (applied) return;

  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'",
      ).get()) {
        db.exec(CHECKPOINT_CONTROL_PLANE_SCHEMA);
      }
      const sourceColumns = tableColumns(db, "checkpoints");
      const source = (column: string, fallback: string) =>
        sourceColumns.has(column) ? column : fallback;
      const beforeCount = (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n;

      db.exec("DROP TABLE IF EXISTS checkpoints_v13");
      db.exec(checkpointV13TableSql("checkpoints_v13"));
      db.exec(`
        INSERT INTO checkpoints_v13 (
          id, item_id, run_id, source, kind, stage, title, summary, key_facts,
          artifact_refs, related_item_ids, next_step, action_type, action_id,
          idempotency_key, content_hash, progress_current, progress_total, progress_label,
          proof_items, created_at
        )
        SELECT
          id, item_id, run_id, source, kind, stage, title, summary, key_facts,
          artifact_refs, related_item_ids, next_step, action_type, action_id,
          idempotency_key, content_hash,
          ${source("progress_current", "NULL")},
          ${source("progress_total", "NULL")},
          ${source("progress_label", "NULL")},
          ${source("proof_items", "'[]'")},
          created_at
        FROM checkpoints
        ORDER BY id
      `);

      const afterCount = (db.prepare("SELECT COUNT(*) AS n FROM checkpoints_v13").get() as { n: number }).n;
      if (beforeCount !== afterCount) throw new Error("checkpoint migration changed ledger row counts");
      const hashMismatch = db.prepare(
        `SELECT old.id
         FROM checkpoints old
         LEFT JOIN checkpoints_v13 rebuilt ON rebuilt.id=old.id
         WHERE rebuilt.id IS NULL
            OR rebuilt.item_id<>old.item_id
            OR NOT (rebuilt.run_id IS old.run_id)
            OR rebuilt.content_hash<>old.content_hash
            OR NOT (rebuilt.idempotency_key IS old.idempotency_key)
            OR rebuilt.created_at<>old.created_at
         LIMIT 1`,
      ).get();
      if (hashMismatch) throw new Error("checkpoint migration failed provenance/hash verification");

      db.exec("DROP TABLE checkpoints");
      db.exec("ALTER TABLE checkpoints_v13 RENAME TO checkpoints");
      db.exec(CHECKPOINT_CONTROL_PLANE_SCHEMA);
      db.exec(CHECKPOINT_FIDELITY_STORAGE_SCHEMA);
      backfillLegacyArtifacts(db);
      repairItemProofMaterialization(db);
      verifyItemProofMaterialization(db);

      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      if (fkErrors.length) {
        throw new Error(`checkpoint fidelity migration foreign-key violations: ${JSON.stringify(fkErrors)}`);
      }
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(CHECKPOINT_FIDELITY_STORAGE_MIGRATION_VERSION, "checkpoint-fidelity-storage-v1");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

// openDb 会记账的全部迁移版本，升序。doctor 用它只读地数出账本还差几个迁移。
// 放在文件末尾：v10–v13 的常量定义在上面，提前引用会撞上 const 的暂时性死区。
// 新增迁移时同步追加；test/doctor.test.ts 用新建库的账本核对这份列表。
export const SCHEMA_MIGRATION_VERSIONS: readonly number[] = [
  KERNEL_MIGRATION_VERSION,
  CHECKPOINT_CONTROL_PLANE_MIGRATION_VERSION,
  PLAN_ITEM_KEY_MIGRATION_VERSION,
  CHECKPOINT_FIDELITY_STORAGE_MIGRATION_VERSION,
  ITEM_MODEL_MIGRATION_VERSION,
  TRIGGER_LAYER_MIGRATION_VERSION,
  ITEM_RENAME_MIGRATION_VERSION,
  TICKET_RELATIONS_MIGRATION_VERSION,
  DELEGATION_WORKFLOW_MIGRATION_VERSION,
  RELATION_EXECUTION_GATE_MIGRATION_VERSION,
  OUTCOME_SNAPSHOT_MIGRATION_VERSION,
  TICKET_AGENT_EXECUTION_CONTINUATION_MIGRATION_VERSION,
  OUTCOME_RECOVERY_SCOPE_MIGRATION_VERSION,
  WORKSPACE_MODEL_MIGRATION_VERSION,
  REVIEW_WORKSPACE_HASH_MIGRATION_VERSION,
  WORKSPACE_SNAPSHOT_ARTIFACT_MIGRATION_VERSION,
  RUN_TYPED_FAILURE_MIGRATION_VERSION,
  RUNTIME_HEALTH_LEDGER_MIGRATION_VERSION,
  RUNTIME_INCIDENT_RECOVERY_MIGRATION_VERSION,
  RUN_RUNTIME_PROFILE_HASH_MIGRATION_VERSION,
  DISPATCH_BACKOFF_MIGRATION_VERSION,
  RUN_LAUNCHER_MIGRATION_VERSION,
  REWORK_GRANT_ATTRIBUTION_MIGRATION_VERSION,
  SPURIOUS_OUTCOME_RECORDS_MIGRATION_VERSION,
  TICKET_AGENT_TURN_TEXT_MIGRATION_VERSION,
  RUN_EFFORT_MIGRATION_VERSION,
  ITEM_DISPLAY_TITLE_MIGRATION_VERSION,
  ITEM_MILESTONES_MIGRATION_VERSION,
  DECISION_ORIGIN_MIGRATION_VERSION,
  CONNECTIONS_MIGRATION_VERSION,
  EVENT_LOG_MIGRATION_VERSION,
  STANDING_ORDERS_MIGRATION_VERSION,
  EVENT_TRIAGE_SHADOW_MIGRATION_VERSION,
  CHANNELS_MIGRATION_VERSION,
  BINDING_ORIGIN_MIGRATION_VERSION,
  REMINDER_POLICY_MIGRATION_VERSION,
  LEAD_WAITS_MIGRATION_VERSION,
  CHANNEL_LOOKUPS_MIGRATION_VERSION,
  TOKEN_USAGE_RECOMPUTE_MIGRATION_VERSION,
  DELIVERY_SNAPSHOTS_MIGRATION_VERSION,
  EXECUTION_PLANS_MIGRATION_VERSION,
  ACCEPTANCE_CRITERIA_MIGRATION_VERSION,
  RUN_GRANTS_MIGRATION_VERSION,
  REVIEWER_CHOICE_MIGRATION_VERSION,
  REVIEW_PACKETS_MIGRATION_VERSION,
  DELEGATION_ACCEPT_WITHOUT_REVIEW_MIGRATION_VERSION,
  WATCHES_MIGRATION_VERSION,
  MEMORY_SYNC_MIGRATION_VERSION,
  WIDGETS_MIGRATION_VERSION,
  WIDGET_SOURCES_MIGRATION_VERSION,
];

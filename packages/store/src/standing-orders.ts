// 常设指令（Lead 事件主干 spec D4，工单 05）。表在 schema.ts 的 STANDING_ORDERS_SCHEMA（v44）。
//
// 规则：
//   - 只追加：每次修改写一个新版本，旧版本保留（表上的触发器拒绝 UPDATE 和 DELETE）。回滚就是把旧版本的内容写成新版本。
//   - 一条指令现在的样子是它的最新版本。最新版本 disabled 时，定级别的指令不参加匹配；规则类的指令不能关（工单 10 的定义，
//     见 protocol 的 standing-order-tiers.ts）：Lead 和用户都写不出停用的规则版本，万一库里有，规则照常用代码里的种子。
//   - 读出来不合格的版本（JSON 坏了、参数不符合 schema）不用：退回代码里的种子，依据记成第 0 版。
//     分诊在调用方的写事务里运行，所以这里的读错误都接住，不能让原来的写入回滚（events.ts 的 appendEventGuarded）。
//   - system 写种子（openDb 时的 syncSystemStandingOrders，按种子的修订号只往前走）。
//   - Lead 和用户的修改走 standing-order-changes.ts（工单 10）：Lead 用 propose_standing_order_change 提，
//     更保守的直接生效，更放开的等用户批准；用户在设置页回滚。最新版本不是 system 写的，种子同步不覆盖它。
import {
  MODEL_CATALOG_STABLE_REFRESHES_UNSET, STANDING_ORDER_AUTHORS, STANDING_ORDER_STATUSES, standingOrderLevel,
  validateStandingOrderDefinition,
  validStandingOrderRuleParams,
  type StandingOrder, type StandingOrderAuthor, type StandingOrderCondition, type StandingOrderDefinition,
  type StandingOrderRef, type StandingOrderStatus, type TriageLevel,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { systemStandingOrderSeeds, type SystemStandingOrderSeed } from "./standing-order-seeds.js";

interface StandingOrderRow {
  order_id: string; version: number; title: string; priority: number; condition: string; action: string;
  limits: string | null; escalate_to: string | null; author: string; approved_by: string | null; status: string;
  reason: string; created_at: string; seed_revision: number | null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// 解析一行。JSON 坏了返回 null；内容是否合格另由 orderIsUsable 判断。
function parseRow(row: StandingOrderRow): StandingOrder | null {
  const condition = parseJson(row.condition);
  const action = parseJson(row.action);
  const limits = parseJson(row.limits);
  if (condition === undefined || action === undefined || limits === undefined) return null;
  return {
    id: row.order_id,
    version: row.version,
    title: row.title,
    priority: row.priority,
    condition: condition as StandingOrder["condition"],
    action: action as StandingOrder["action"],
    limits: limits as StandingOrder["limits"],
    escalateTo: row.escalate_to as TriageLevel | null,
    author: row.author as StandingOrderAuthor,
    approvedBy: row.approved_by,
    status: row.status as StandingOrderStatus,
    reason: row.reason,
    createdAt: row.created_at,
    seedRevision: row.seed_revision ?? null,
  };
}

function orderIsUsable(order: StandingOrder): boolean {
  return (STANDING_ORDER_AUTHORS as readonly string[]).includes(order.author)
    && (STANDING_ORDER_STATUSES as readonly string[]).includes(order.status)
    && validateStandingOrderDefinition(order).length === 0;
}

// 种子按编号查。插件的种子是后来登记的（工单 11），所以每次按现在的全部种子查。
function seedById(id: string): SystemStandingOrderSeed | undefined {
  return systemStandingOrderSeeds().find((seed) => seed.id === id);
}

/** 代码里的种子，当成第 0 版：库里读不到时用它。 */
function seedOrder(id: string): StandingOrder {
  const seed = seedById(id);
  if (!seed) throw new Error(`没有编号为 ${id} 的系统常设指令`);
  const { seedRevision, status, ...definition } = seed;
  return {
    ...definition, version: 0, author: "system", approvedBy: null, status: status ?? "active", createdAt: "", seedRevision,
  };
}

function activeSeedOrders(): StandingOrder[] {
  return systemStandingOrderSeeds().map((seed) => seedOrder(seed.id)).filter((order) => order.status === "active");
}

export function standingOrderRef(order: Pick<StandingOrder, "id" | "version">): StandingOrderRef {
  return { id: order.id, version: order.version };
}

// ── 读 ──────────────────────────────────────────────────────────────────────────────

const LATEST_SQL = `SELECT s.* FROM standing_orders s
  WHERE s.version = (SELECT MAX(version) FROM standing_orders WHERE order_id = s.order_id)`;

function byPriority(a: StandingOrder, b: StandingOrder): number {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 每条指令的最新版本，按 priority 和编号排。缺省不列 disabled 的。JSON 坏了的版本不列。 */
export function listStandingOrders(db: Db, options: { includeDisabled?: boolean } = {}): StandingOrder[] {
  return (db.prepare(LATEST_SQL).all() as StandingOrderRow[])
    .map(parseRow)
    .filter((order): order is StandingOrder => order !== null && (options.includeDisabled || order.status !== "disabled"))
    .sort(byPriority);
}

/** 一条指令的某一版；不给版本时是最新版本。 */
export function getStandingOrder(db: Db, id: string, version?: number): StandingOrder | undefined {
  const row = (version === undefined
    ? db.prepare("SELECT * FROM standing_orders WHERE order_id = ? ORDER BY version DESC LIMIT 1").get(id)
    : db.prepare("SELECT * FROM standing_orders WHERE order_id = ? AND version = ?").get(id, version)) as StandingOrderRow | undefined;
  return row ? parseRow(row) ?? undefined : undefined;
}

/** 一条指令的全部版本，从旧到新。 */
export function listStandingOrderVersions(db: Db, id: string): StandingOrder[] {
  return (db.prepare("SELECT * FROM standing_orders WHERE order_id = ? ORDER BY version").all(id) as StandingOrderRow[])
    .map(parseRow)
    .filter((order): order is StandingOrder => order !== null);
}

// 规则层每个事件都要读一遍。按表的「行数 + 最大 rowid」缓存：表只追加，所以这两个数变了就是有新版本
// （别的进程写的也一样），事务回滚时它们也跟着回去。
const cache = new WeakMap<Db, { key: string; orders: StandingOrder[] }>();

function loadActive(db: Db): StandingOrder[] {
  const { n, r } = db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS r FROM standing_orders").get() as { n: number; r: number | null };
  const key = `${n}:${r ?? 0}`;
  // 插件的种子登记以后（工单 11），库里还没有的种子也要生效：登记的数目进缓存键。
  const seedCount = systemStandingOrderSeeds().length;
  const cacheKey = `${key}:${seedCount}`;
  const cached = cache.get(db);
  if (cached?.key === cacheKey) return cached.orders;
  const latest = (db.prepare(LATEST_SQL).all() as StandingOrderRow[]).map((row) => ({ row, order: parseRow(row) }));
  const seen = new Set<string>();
  const orders: StandingOrder[] = [];
  for (const { row, order } of latest) {
    seen.add(row.order_id);
    if (order && orderIsUsable(order)) {
      if (order.status === "active") orders.push(order);
    } else if (seedById(row.order_id) && seedOrder(row.order_id).status === "active") {
      orders.push(seedOrder(row.order_id));
    }
  }
  // 库里还没有的系统指令（同步之前）照样生效。
  for (const seed of activeSeedOrders()) if (!seen.has(seed.id)) orders.push(seed);
  orders.sort(byPriority);
  cache.set(db, { key: cacheKey, orders });
  return orders;
}

/**
 * 现在生效的指令：每条的最新版本，active 并且合格。不合格的系统指令用代码里的种子（第 0 版）代替。
 * 读库出错时（表坏了）整份退回种子。不抛错：分诊在调用方的写事务里运行。
 */
export function activeStandingOrders(db: Db): StandingOrder[] {
  try {
    return loadActive(db);
  } catch {
    return activeSeedOrders().sort(byPriority);
  }
}

/** 定级别的指令（level 动作，或者带 level 的规则），按 priority 排。 */
export function triageStandingOrders(db: Db): StandingOrder[] {
  return activeStandingOrders(db).filter((order) => standingOrderLevel(order) !== null);
}

/**
 * 一条规则类指令现在的参数。最新版本 active 并且参数合格时用它；否则（关掉了、不合格、读不到）用代码里的种子。
 * 规则不能关（工单 10）：修改流程拒绝停用规则类指令，所以「关掉了」只会是库被别的办法改过。
 */
export function ruleStandingOrder(db: Db | null | undefined, id: string): StandingOrder {
  const order = db ? activeStandingOrders(db).find((candidate) => candidate.id === id) : undefined;
  if (order?.action.type === "rule" && validStandingOrderRuleParams(order.action.rule, order.action.params)) {
    return order;
  }
  return seedOrder(id);
}

function ruleParams<T>(order: StandingOrder): T {
  if (order.action.type !== "rule") throw new Error(`常设指令 ${order.id} 不是规则`);
  return order.action.params as T;
}

// ── 各条规则的参数 ──────────────────────────────────────────────────────────────────
// 工单 14：除了 transientRetryDefaults，都要给 db，读库里现在的版本。库里读不到、或者版本不合格时才用代码里的种子。
// transientRetryDefaults 的 db 仍可不给：engine 的 transientRetryConfig 缺省参数用它（只有测试不给库）；
// 生产路径走 standingTransientRetryConfig(db)。

/** 来源的默认级别和打断阈值（source.*）。没有自己指令的来源用 "*"（外部来源的默认值）。 */
export function sourceThreshold(db: Db | null | undefined, source: string): {
  defaultLevel: TriageLevel; maxLevel: TriageLevel; order: StandingOrder;
} {
  const orders = db ? activeStandingOrders(db) : activeSeedOrders();
  const thresholds = orders.filter((order) => order.action.type === "rule" && order.action.rule === "source.threshold"
    && validStandingOrderRuleParams("source.threshold", order.action.params));
  const pick = (name: string) => thresholds.find((order) => ruleParams<{ source: string }>(order).source === name);
  const order = pick(source) ?? pick("*") ?? seedOrder("source.external");
  const params = ruleParams<{ defaultLevel: TriageLevel; maxLevel: TriageLevel }>(order);
  return { defaultLevel: params.defaultLevel, maxLevel: params.maxLevel, order };
}

/** inbox 的一行要不要叫醒 Lead（inbox.wake_lead 的 wakeWhen，看 { severity, payload }）。 */
export function inboxWakeCondition(db: Db): StandingOrderCondition {
  return ruleParams<{ wakeWhen: StandingOrderCondition }>(ruleStandingOrder(db, "inbox.wake_lead")).wakeWhen;
}

export interface TransientRetryDefaults { baseMs: number; maxMs: number; limit: number; order: StandingOrderRef }

/** 瞬时失败重试的参数（run.transient_retry）。limit 取 limits.count。环境变量的覆盖在 engine 的 transientRetryConfig。 */
export function transientRetryDefaults(db?: Db | null): TransientRetryDefaults {
  let order = ruleStandingOrder(db, "run.transient_retry");
  if (!Number.isInteger(order.limits?.count)) order = seedOrder("run.transient_retry");
  const params = ruleParams<{ baseMs: number; maxMs: number }>(order);
  return { baseMs: params.baseMs, maxMs: params.maxMs, limit: order.limits!.count!, order: standingOrderRef(order) };
}

/** inbox 熔断的上限（inbox.fuse_blockers）：一个 scope 在 windowMs 里第 count 条 blocker 起熔断。 */
export function inboxFuseLimits(db: Db): { count: number; windowMs: number; order: StandingOrderRef } {
  let order = ruleStandingOrder(db, "inbox.fuse_blockers");
  if (!Number.isInteger(order.limits?.count) || !Number.isInteger(order.limits?.windowMs) || order.limits!.count! < 1) {
    order = seedOrder("inbox.fuse_blockers");
  }
  return { count: order.limits!.count!, windowMs: order.limits!.windowMs!, order: standingOrderRef(order) };
}

export interface ModelCatalogAnnounceParams {
  announceFirstRefresh: boolean;
  refreshOnFailureScopes: string[];
  wakeLead: boolean;
  // 连续几次刷新的结果相同才算一次变化（工单 14）。版本里没写时是 1（不去抖）。
  stableRefreshes: number;
  order: StandingOrderRef;
}

/** 模型目录变化的说明（model_catalog.announce）。 */
export function modelCatalogAnnounceParams(db: Db): ModelCatalogAnnounceParams {
  const order = ruleStandingOrder(db, "model_catalog.announce");
  const params = ruleParams<Omit<ModelCatalogAnnounceParams, "order" | "stableRefreshes"> & { stableRefreshes?: number }>(order);
  return {
    announceFirstRefresh: params.announceFirstRefresh,
    refreshOnFailureScopes: params.refreshOnFailureScopes,
    wakeLead: params.wakeLead,
    stableRefreshes: params.stableRefreshes ?? MODEL_CATALOG_STABLE_REFRESHES_UNSET,
    order: standingOrderRef(order),
  };
}

export interface ReminderFireParams {
  notificationKind: string;
  urgency: "immediate" | "batchable";
  titlePrefix: string;
  order: StandingOrderRef;
}

/** 提醒到点的通知（reminder.fire）。 */
export function reminderFireParams(db: Db): ReminderFireParams {
  const order = ruleStandingOrder(db, "reminder.fire");
  return { ...ruleParams<Omit<ReminderFireParams, "order">>(order), order: standingOrderRef(order) };
}

// ── 写 ──────────────────────────────────────────────────────────────────────────────

/**
 * 写一个新版本。内容不合格时抛错，不写。版本号是这条指令已有的最大版本加 1。
 * seedRevision 只给系统种子用（作者必须是 system）。
 * syncSystemStandingOrders 和 standing-order-changes.ts（Lead 和用户的修改）调用它。
 */
export function recordStandingOrderVersion(
  db: Db,
  definition: StandingOrderDefinition,
  meta: {
    author: StandingOrderAuthor; status?: StandingOrderStatus; approvedBy?: string | null; at?: Date;
    seedRevision?: number | null;
  },
): StandingOrder {
  const errors = validateStandingOrderDefinition(definition);
  if (!(STANDING_ORDER_AUTHORS as readonly string[]).includes(meta.author)) errors.push(`作者 ${meta.author} 不是 system、lead 或 user`);
  const status = meta.status ?? "active";
  if (!(STANDING_ORDER_STATUSES as readonly string[]).includes(status)) errors.push(`状态 ${status} 不是 active 或 disabled`);
  const seedRevision = meta.seedRevision ?? null;
  if (seedRevision !== null && (meta.author !== "system" || !Number.isInteger(seedRevision) || seedRevision < 1)) {
    errors.push("种子修订号只给作者是 system 的版本，并且是正整数");
  }
  if (errors.length) throw new Error(`常设指令 ${definition.id}：${errors.join("；")}`);
  const { v } = db.prepare("SELECT MAX(version) AS v FROM standing_orders WHERE order_id = ?").get(definition.id) as { v: number | null };
  const version = (v ?? 0) + 1;
  db.prepare(
    `INSERT INTO standing_orders (
       order_id, version, title, priority, condition, action, limits, escalate_to, author, approved_by, status, reason,
       created_at, seed_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    definition.id, version, definition.title, definition.priority, JSON.stringify(definition.condition),
    JSON.stringify(definition.action), definition.limits === null ? null : JSON.stringify(definition.limits),
    definition.escalateTo, meta.author, meta.approvedBy ?? null, status, definition.reason, (meta.at ?? new Date()).toISOString(),
    seedRevision,
  );
  return getStandingOrder(db, definition.id, version)!;
}

export interface StandingOrderSync { created: string[]; updated: string[] }

/**
 * 把代码里的系统种子同步进表（openDb 每次都调用，幂等）。只往前走，不往后退：
 *   - 库里没有这条指令：写第 1 版。
 *   - 最新版本是 system 写的，并且它的修订号小于种子的修订号：写一个新版本（代码更新了）。
 *   - 修订号相等或更大：不写，即使内容不同。部署时新 daemon 已经启动，旧版本的进程（每个 Run 的 mcp-server、
 *     supervisor）还会用 openDb 打开同一个库；旧代码不能把新代码写的版本改回去。
 *   - 最新版本是 Lead 或用户写的：不覆盖（第 3 期）。
 *   - 代码里没有、库里有的指令：不动。旧代码不认识新代码加的指令，不能因此停用它。要停用一条系统指令，
 *     种子里留着它，status 写 disabled，修订号加 1。
 * 判断只看最新版本的作者和修订号，不解析内容：内容坏了的版本也不会被旧代码覆盖。
 * 在一个 IMMEDIATE 事务里做：两个进程同时打开同一个库时，后一个等前一个提交，再读到已有的版本。
 * seeds 缺省是代码里的种子；测试用它模拟别的代码版本。
 */
export function syncSystemStandingOrders(
  db: Db, at: Date = new Date(), seeds: readonly SystemStandingOrderSeed[] = systemStandingOrderSeeds(),
): StandingOrderSync {
  const result: StandingOrderSync = { created: [], updated: [] };
  db.transaction(() => {
    const latest = new Map((db.prepare(
      `SELECT s.order_id, s.author, s.seed_revision FROM standing_orders s
       WHERE s.version = (SELECT MAX(version) FROM standing_orders WHERE order_id = s.order_id)`,
    ).all() as Array<{ order_id: string; author: string; seed_revision: number | null }>).map((row) => [row.order_id, row]));
    for (const seed of seeds) {
      const current = latest.get(seed.id);
      if (current && (current.author !== "system" || (current.seed_revision ?? 0) >= seed.seedRevision)) continue;
      const { seedRevision, status, ...definition } = seed;
      recordStandingOrderVersion(db, definition, { author: "system", status: status ?? "active", seedRevision, at });
      (current ? result.updated : result.created).push(seed.id);
    }
  }).immediate();
  return result;
}

// ── 给 Lead 看 ──────────────────────────────────────────────────────────────────────

/** Lead 系统提示里的一节：现在生效的常设指令清单（编号、版本、标题）。完整内容用 get_standing_order 查。 */
export function renderStandingOrdersForLead(db: Db): string {
  const orders = activeStandingOrders(db);
  return [
    "## 常设指令",
    "系统按常设指令处理事件：定级别（record 只记录、digest 进摘要、auto 自动处理、tell 单独告诉你、interrupt 插进当前回合），"
      + "合并重复的事，自动重试，到时限没人处置的升一级。下面是这次会话开始时生效的清单，每行是「编号 v版本：标题」。"
      + "要看一条的条件、动作、上限和历史版本，用 get_standing_order；最新的全部清单用 list_standing_orders。"
      + "解释系统为什么这样处理一件事时，说出依据的编号和版本。",
    "要改一条指令，用 propose_standing_order_change，写明原因。档位由系统判断，不由你定："
      + "更保守的（交给用户和你的更多、自动做的更少）马上生效，系统在「Lead 动态」里告诉用户；"
      + "更放开的要用户在审批卡上批准才生效，你不能替用户批准；碰到硬性安全规则的会被拒绝。规则类指令不能停用，只能改参数。",
    ...orders.map((order) => `- ${order.id} v${order.version}：${order.title}`),
  ].join("\n");
}

import { setItemDue, type MilestoneSource } from "./milestones.js";
import type { Db } from "./db.js";
import { reminderPolicyErrors, type ReminderPolicy } from "@pi-lead-child/protocol";
import type {
  Actor, RunPurpose, PlanState, RuntimeId, Item, ItemKind, ItemWorkflowKind, ItemPriority,
  ItemStage, VerificationPolicy, AcceptancePolicy, ReworkPolicy, DeliveryPolicy,
} from "@pi-lead-child/core";
import { addActivity } from "./activities.js";
import { appendEventGuarded, nextEntityVersion } from "./events.js";
import { enqueueContinuationEvent } from "./continuations.js";
import { allowedNext, canTransition } from "./stages.js";
import { closeReminderOccurrence } from "./reminder-occurrence.js";
import { activeLeadGrant, type LeadCapability } from "./lead-grants.js";

export function createItem(
  db: Db,
  args: {
    title: string; brief: string; createdBy: "user" | "lead" | "child" | "system";
    kind?: ItemKind; workflowKind?: ItemWorkflowKind; hold?: boolean; remindAt?: string; deferUntil?: string; workdir?: string;
    // 提醒的设置（v48，工单 07）：只给提醒。不给时是缺省设置（列为 NULL）。
    reminderPolicy?: ReminderPolicy;
    priority?: ItemPriority; project?: string; projectId?: number;
    parentItemId?: number; rootItemId?: number; createdByRunId?: number;
    planState?: PlanState; runtime?: RuntimeId; model?: string;
    purpose?: RunPurpose;
    // 谁核查（v56 起是唯一的说法，旧的策略列停用，见 schema.ts）。不给时是 lead_static：Lead 静态核对。
    verificationPolicy?: VerificationPolicy;
    acceptancePolicy?: AcceptancePolicy;
    reworkPolicy?: ReworkPolicy;
    deliveryPolicy?: DeliveryPolicy;
    maxDepth?: number; maxChildren?: number; maxConcurrency?: number;
    tokenBudget?: number; costBudgetUsd?: number; retryLimit?: number;
  },
): number {
  const kind = args.kind ?? "task";
  if (kind === "reminder" && !args.remindAt) {
    throw new Error("createItem: a reminder requires remindAt");
  }
  if (args.reminderPolicy !== undefined) {
    if (kind !== "reminder") throw new Error("createItem: only a reminder has reminder settings");
    const errors = reminderPolicyErrors(args.reminderPolicy);
    if (errors.length) throw new Error(`createItem: invalid reminder settings: ${errors.join("; ")}`);
  }
  // 初始 stage（spec §6.6）。默认是 ready——常规路径就该建完直接跑，用户的原话是
  // "**有的时候**我希望刚建的时候不需要立即执行"，那是可选的，不是缺省。
  //
  // hold 由调用方显式声明。谁来判断"这次要不要 hold"只能是 lead：意图只存在于自然语言里
  // （"先别动，等我确认"），没有任何结构能推断出来。但判断结果必须落成这个参数存进库，
  // 而不是留在 lead 的记忆里——落库之后，(C4) 保证 draft 只可能来自 user/lead 的显式请求，
  // 而 draft 不能开跑、lead 不能确认（§6.4）这两条硬约束一个都不动。
  //
  // hold 只对**树根**生效（§6.6）：确认发生在树根，不逐层重复，否则编排会被逐个子任务卡死。
  // 两个条件缺一不可：
  //   - createdBy 是 user / lead——child 与 system 没有代用户表达"先别动"的资格；
  //   - 没有 parentItemId——子任务生于 ready。曾经这里只看 createdBy，于是 lead 建的子任务
  //     照样能停在 draft：一次十阶段的分解在「需要你介入」里堆出十二条，而用户只该确认
  //     那一个根。
  const holdable = (args.createdBy === "user" || args.createdBy === "lead")
    && args.parentItemId === undefined;
  const stage = kind === "reminder"
    ? "scheduled"
    : (args.hold && holdable) ? "draft" : "ready";
  // reminder 的每一个执行侧字段都必须显式写 NULL 而不是走缺省值，否则 'execution' /
  // 'lead_static' / retry_limit=1 这些 task 缺省会把 (C2) 撞成不可满足的约束。
  const isTask = kind === "task";
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO items (
        kind, workflow_kind, stage, title, brief, created_by, workdir, priority, project, project_id,
        parent_item_id, root_item_id, created_by_run_id, plan_state,
        requested_runtime, requested_model, purpose,
        verification_policy, acceptance_policy, rework_policy, delivery_policy,
        max_depth, max_children, max_concurrency, token_budget, cost_budget_usd, retry_limit,
        remind_at, defer_until, reminder_policy, stage_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                datetime('now'))`,
    ).run(
      kind, isTask ? args.workflowKind ?? "generic" : "generic", stage, args.title, args.brief, args.createdBy,
      isTask ? args.workdir ?? null : null,
      args.priority ?? "normal", args.project ?? null, args.projectId ?? null,
      isTask ? args.parentItemId ?? null : null,
      isTask ? args.rootItemId ?? null : null,
      isTask ? args.createdByRunId ?? null : null,
      isTask ? args.planState ?? "none" : null,
      isTask ? args.runtime ?? null : null,
      isTask ? args.model ?? null : null,
      isTask ? args.purpose ?? "execution" : null,
      isTask ? args.verificationPolicy ?? "lead_static" : null,
      isTask ? args.acceptancePolicy ?? "user_only" : null,
      isTask ? args.reworkPolicy ?? "ask_user" : null,
      isTask ? args.deliveryPolicy ?? "notify_only" : null,
      isTask ? args.maxDepth ?? null : null,
      isTask ? args.maxChildren ?? null : null,
      isTask ? args.maxConcurrency ?? null : null,
      isTask ? args.tokenBudget ?? null : null,
      isTask ? args.costBudgetUsd ?? null : null,
      isTask ? args.retryLimit ?? 1 : null,
      kind === "reminder" ? args.remindAt ?? null : null,
      isTask ? args.deferUntil ?? null : null,
      kind === "reminder" && args.reminderPolicy ? JSON.stringify(args.reminderPolicy) : null,
    );
    const id = Number(r.lastInsertRowid);
    // 自根行的 insert-then-update 协议只对 task 有意义：(C2) 要求 reminder 的 root 恒为 NULL。
    if (isTask) {
      db.prepare("UPDATE items SET root_item_id = ? WHERE id = ?")
        .run(args.rootItemId ?? id, id);
    }
    return id;
  })();
}

export function getItem(db: Db, id: number): Item | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item | undefined;
}

const PRIORITY_ORDER =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

export type ItemView = "tasks" | "drafts" | "reminders" | "all";

// 默认视图（spec §9）：任务列表不含提醒、待确认、终态与延后未到期，待确认与提醒各自成组。
// view 缺省 'all' 而非 'tasks'：既有调用方一律不传 view，缺省成 'tasks' 会在它们背后
// 悄悄改变结果集。想要 §9 语义的调用方必须显式点名。
export function listItems(
  db: Db,
  filter?: {
    stage?: ItemStage[]; project?: string; text?: string;
    // kind 是单一维度的过滤，与 view（预设组合）正交：调用方只想排掉提醒、但要保留
    // draft 与终态时，用 kind 而不是 view。
    kind?: ItemKind;
    view?: ItemView; now?: string;
  },
): Item[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  const view = filter?.view ?? "all";
  const now = filter?.now ?? new Date().toISOString();
  const notDeferred = "(defer_until IS NULL OR defer_until <= ?)";
  if (view === "tasks") {
    where.push("kind = 'task'", "stage NOT IN ('draft','done','cancelled')", notDeferred);
    vals.push(now);
  } else if (view === "drafts") {
    where.push("kind = 'task'", "stage = 'draft'", notDeferred);
    vals.push(now);
  } else if (view === "reminders") {
    // reminder 没有 defer_until（C2 禁止），浮现时机由 remind_at 表达。
    where.push("kind = 'reminder'", "stage IN ('scheduled','fired')");
  }
  if (filter?.kind) { where.push("kind = ?"); vals.push(filter.kind); }
  if (filter?.stage?.length) {
    where.push(`stage IN (${filter.stage.map(() => "?").join(",")})`);
    vals.push(...filter.stage);
  }
  if (filter?.project) {
    where.push("project = ?");
    vals.push(filter.project);
  }
  if (filter?.text) {
    where.push("(title LIKE ? OR brief LIKE ? OR body LIKE ?)");
    const q = `%${filter.text}%`;
    vals.push(q, q, q);
  }
  const sql = `SELECT * FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY ${PRIORITY_ORDER}, id`;
  return db.prepare(sql).all(...vals) as Item[];
}

// due_at 是"这件事该在何时之前做完"，两种 kind 都成立；remind_at 是"到点把这条浮到眼前"，
// 那是 reminder 这个 kind 本身的定义（约束 C3：task 的 remind_at 必须为 NULL）。
// 旧实现对 task 直接 UPDATE remind_at，撞的是 CHECK，报错只会是一句 SQLITE_CONSTRAINT，
// 既说不清哪条规则、也说不出该改用什么。所以在这里先拦一道，把替代路径写进错误里。
//
// task 的截止是一个截止节点（v40，milestones.ts）：这里改走 setItemDue，节点和 due_at 在同一个事务里改。
// source 说明是谁定的（出处）；不给时记成 system。reminder 的 due_at 仍是普通字段。
export function setItemTime(
  db: Db,
  id: number,
  time: { dueAt?: string | null; remindAt?: string | null },
  source: MilestoneSource = { actor: "system" },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const row = db.prepare("SELECT kind, stage FROM items WHERE id = ?").get(id) as
    { kind: ItemKind; stage: ItemStage } | undefined;
  if (time.remindAt !== undefined) {
    if (!row) throw new Error(`item ${id} not found`);
    if (row.kind === "task") {
      throw new Error(
        `a task has no remind_at (item #${id}); a reminder is its own item — `
        + "use create_reminder instead of scheduling one onto a task",
      );
    }
    // scheduled 的 reminder 清掉 remind_at 就永远不会触发（C3 的第二条）。
    // 想让它不再响应该走取消，而不是留一条到不了点的 reminder。
    if (time.remindAt === null && row.stage === "scheduled") {
      throw new Error(`cannot clear remind_at on scheduled reminder #${id}: cancel it instead`);
    }
    sets.push("remind_at = ?");
    vals.push(time.remindAt);
  }
  db.transaction(() => {
    if (time.dueAt !== undefined) {
      if (row?.kind === "task") {
        setItemDue(db, id, time.dueAt, source);
      } else {
        sets.push("due_at = ?", "due_overdue_notified = 0"); // 改期后重置逾期提醒
        vals.push(time.dueAt);
      }
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  })();
}

// scheduler 用：到点该响的提醒（spec §10 步骤 2）。
// "还停在 scheduled" 就是幂等的全部依据——响过一次就落到 fired，下轮自然选不中它。
// 旧实现靠把 remind_at 清成 NULL 来表达"已经响过"，那既撞 (C3)、又抹掉了触发时刻这段历史。
export function remindersToFire(db: Db, nowIso: string): Item[] {
  return db.prepare(
    `SELECT * FROM items
     WHERE kind = 'reminder' AND stage = 'scheduled'
       AND remind_at IS NOT NULL AND remind_at <= ?
     ORDER BY remind_at, id`,
  ).all(nowIso) as Item[];
}

// 提醒到点的那一步（scheduled → fired、通知、到点事件、推送）在 reminders.ts 的 fireReminder（工单 07）。

// scheduler 用：逾期未提醒过的活跃任务（due_at < now，非终态，未提醒逾期）。
// 限定 kind='task'：reminder 的到点语义由 remind_at 表达，due_at 上的逾期告警对它没有意义。
export function itemsOverdue(db: Db, nowIso: string): Item[] {
  return db.prepare(
    `SELECT * FROM items WHERE kind = 'task' AND due_at IS NOT NULL AND due_at < ?
       AND due_overdue_notified = 0
       AND stage NOT IN ('done','cancelled')`,
  ).all(nowIso) as Item[];
}

export function markOverdueNotified(db: Db, id: number): void {
  db.prepare("UPDATE items SET due_overdue_notified = 1 WHERE id = ?").run(id);
}

export function updateItemAttrs(
  db: Db,
  id: number,
  attrs: { priority?: ItemPriority; project?: string | null },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (attrs.priority) { sets.push("priority = ?"); vals.push(attrs.priority); }
  if (attrs.project !== undefined) { sets.push("project = ?"); vals.push(attrs.project); }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function updateOrchestrationState(
  db: Db,
  id: number,
  state: PlanState,
  activePlanRevision?: number | null,
): void {
  db.prepare(
    `UPDATE items SET plan_state = ?,
      active_plan_revision = COALESCE(?, active_plan_revision), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(state, activePlanRevision ?? null, id);
}

// 显示用的短标题：原标题不可读时（例如 E2E 脚本生成的）由 Lead 写，原标题不动。null 清掉。
export const DISPLAY_TITLE_MAX = 60;

export function setItemDisplayTitle(db: Db, id: number, title: string | null): void {
  const value = title === null ? null : title.trim();
  if (value !== null && value.length === 0) throw new Error("display title must not be blank");
  if (value !== null && value.length > DISPLAY_TITLE_MAX) {
    throw new Error(`display title must be at most ${DISPLAY_TITLE_MAX} characters`);
  }
  const result = db.prepare("UPDATE items SET display_title = ?, updated_at = datetime('now') WHERE id = ?").run(value, id);
  if (result.changes === 0) throw new Error(`item #${id} not found`);
}

export function appendBody(db: Db, id: number, text: string): void {
  db.prepare(
    `UPDATE items
     SET body = CASE WHEN body = '' THEN ? ELSE body || char(10) || char(10) || '---' || char(10) || char(10) || ? END,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(text, text, id);
}

export function transition(
  db: Db,
  args: {
    itemId: number; to: ItemStage; actor: Actor; reason: string; runId?: number;
    now?: Date;
    // system 代谁走这条边（工单 07：用户或 Lead 给到点的提醒改时间，fired → scheduled 只有 system）。记进 stage.changed。
    requestedBy?: "user" | "lead";
    // Lead 在用户这一轮里代用户走一条只属于用户的边（工单操作层，spec 5.11）。权限按用户查，账本写 actor=lead，
    // 并记下代谁、凭哪一轮。轮次由调用方先核实（store 的 activePairedUserTurn），这里只落账。
    onBehalfOf?: { actor: "user"; sourceTurnId: string };
    // Lead 凭你给的长期授权（plc trust lead --confirm，lead_grants）走一条只属于你的边（ui-action-parity P03：长期授权算 delegated）。
    // 权限按你查，账本写 actor=lead，并记下凭哪一份授权。授权在这里再核对一次：撤销了就拒绝，不只信调用方。
    underGrant?: { grantId: number; capability: LeadCapability };
    // Lead 凭自己的权限走的边，但是用户在自己这一轮里让它做的（例如「停下 #5」）：那一轮的编号。只记出处，不是授权：
    // 权限仍按 actor 查。收件箱据此分开「Lead 自己判断的」和「用户让 Lead 做的」（leadOwnStops）。
    requestedInTurn?: string;
  },
): void {
  if (args.onBehalfOf && args.actor !== "lead") {
    throw new Error(`only lead acts on behalf of the user (actor '${args.actor}')`);
  }
  if (args.underGrant) {
    if (args.actor !== "lead" || args.onBehalfOf) throw new Error("only lead acts under a user grant, and not also on behalf of a turn");
    if (activeLeadGrant(db, args.underGrant.capability)?.id !== args.underGrant.grantId) {
      throw new Error(`user grant #${args.underGrant.grantId} (${args.underGrant.capability}) is not active`);
    }
  }
  db.transaction(() => {
    const t = getItem(db, args.itemId);
    if (!t) throw new Error(`item ${args.itemId} not found`);
    // 权限矩阵已下沉到 stages.ts（spec §6.4），此处只区分两种拒绝：边本身不存在，
    // 还是边存在但这个 actor 没资格。两者对调用方是不同的错——前者改不了，后者换个人能做。
    const authority = args.onBehalfOf?.actor ?? (args.underGrant ? "user" : args.actor);
    if (!canTransition(t.kind, t.stage, args.to, authority)) {
      const legal = allowedNext(t.kind, t.stage);
      if (!legal.includes(args.to)) {
        throw new Error(`illegal transition ${t.stage} -> ${args.to} (item #${t.id})`);
      }
      throw new Error(`actor '${authority}' may not transition ${t.stage} -> ${args.to}`);
    }
    const behalf = {
      ...(args.onBehalfOf
        ? { onBehalfOf: args.onBehalfOf.actor, sourceTurnId: args.onBehalfOf.sourceTurnId }
        : args.underGrant
          ? { onBehalfOf: "user" as const, underGrant: { grantId: args.underGrant.grantId, capability: args.underGrant.capability } }
          : {}),
      ...(args.requestedInTurn ? { requestedInTurn: args.requestedInTurn } : {}),
    };
    // system 取消工单的边只给代查工单（purpose=lookup，protocol 的 stages.ts）：代查结束时工单跟着进终态。
    if (args.actor === "system" && args.to === "cancelled" && t.kind === "task" && t.purpose !== "lookup") {
      throw new Error(`actor 'system' may cancel only a lookup item (item #${t.id})`);
    }
    const changedAt = (args.now ?? new Date()).toISOString();
    // acked 是 reminder 的终态，与 task 的 done 同权（spec §6.2）。
    const completedAt =
      args.to === "done" || args.to === "acked" || args.to === "cancelled" ? changedAt : null;
    db.prepare(
      `UPDATE items SET stage = ?, stage_changed_at = ?, closed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(args.to, changedAt, completedAt, changedAt, t.id);
    addActivity(db, {
      itemId: t.id, runId: args.runId, actor: args.actor, kind: "transition",
      payload: { from: t.stage, to: args.to, reason: args.reason, ...behalf },
    });
    // 双写（Lead 事件主干，工单 01）：每次 stage 变化一条事件，带这个对象递增的版本号（spec D1 的 entity_version），
    // 投影只接受更高的版本。去重的编号就是「对象:版本」（spec D2 的 ticket:77:v12）。
    // 事件出错不让 stage 的写入回滚（appendEventGuarded）。
    appendEventGuarded(db, () => {
      const entityKey = `${t.kind === "reminder" ? "reminder" : "ticket"}:${t.id}`;
      const version = nextEntityVersion(db, entityKey);
      return {
        source: "ticket",
        sourceRef: `${entityKey}:v${version}`,
        kind: "stage.changed",
        entityKey,
        entityVersion: version,
        occurredAt: changedAt,
        payload: {
          itemId: t.id, itemKind: t.kind, from: t.stage, to: args.to, actor: args.actor, reason: args.reason,
          runId: args.runId ?? null,
          ...(args.requestedBy ? { requestedBy: args.requestedBy } : {}),
          ...behalf,
        },
      };
    });
    // 一次到点的提醒结束了（确认、取消、改期，工单 07）：横幅收起，「待你」托盘里的通知确认掉（reminder-occurrence.ts）。
    if (t.kind === "reminder" && t.stage === "fired") {
      closeReminderOccurrence(db, t.id, {
        to: args.to, actor: args.requestedBy ?? args.actor, reason: args.reason, at: new Date(changedAt),
      });
    }
    if (args.to === "done") {
      const dependents = db.prepare(
        `SELECT DISTINCT source_item_id
         FROM ticket_relations
         WHERE target_item_id=?
           AND relation_type='depends_on'
           AND revoked_at IS NULL
         ORDER BY source_item_id`,
      ).all(t.id) as Array<{ source_item_id: number }>;
      for (const dependent of dependents) {
        const blockers = (db.prepare(
          `SELECT COUNT(*) AS n
           FROM ticket_relations relation
           JOIN items blocker ON blocker.id=relation.target_item_id
           WHERE relation.source_item_id=?
             AND relation.relation_type='depends_on'
             AND relation.revoked_at IS NULL
             AND blocker.stage <> 'done'`,
        ).get(dependent.source_item_id) as { n: number }).n;
        if (blockers !== 0) continue;
        enqueueContinuationEvent(db, {
          itemId: dependent.source_item_id,
          eventType: "dependency_satisfied",
          payload: {
            dependentItemId: dependent.source_item_id,
            satisfiedByItemId: t.id,
            reason: args.reason,
          },
          idempotencyKey: `dependency-satisfied:item:${dependent.source_item_id}:blocker:${t.id}:at:${changedAt}`,
        });
      }
    }
  })();
}

export interface LeadOwnStop {
  eventId: string;
  itemId: number;
  title: string;
  reason: string;
  at: string;
}

/**
 * Lead 自己判断停下的工单（since 之后）：active、blocked → ready，actor 是 lead，没有代用户，也不是用户在自己这一轮里
 * 让它停的（requestedInTurn，ui-action-parity P03）。
 * 只有工单操作 stop 让 Lead 走这两条边，所以账本里的这条 stage 变化就是「Lead 停下了它」。收件箱的「Lead 已处理」
 * 把它们告诉用户：停了以后一定让用户看到，不只靠 Lead 自己说。
 */
export function leadOwnStops(db: Db, sinceIso: string): LeadOwnStop[] {
  const rows = db.prepare(
    `SELECT e.event_id, e.occurred_at, json_extract(e.payload, '$.reason') AS reason, i.id AS item_id, i.title, i.display_title
     FROM events e JOIN items i ON i.id = json_extract(e.payload, '$.itemId')
     WHERE e.kind = 'stage.changed' AND json_extract(e.payload, '$.actor') = 'lead'
       AND json_extract(e.payload, '$.to') = 'ready' AND json_extract(e.payload, '$.from') IN ('active', 'blocked')
       AND json_extract(e.payload, '$.onBehalfOf') IS NULL AND json_extract(e.payload, '$.requestedInTurn') IS NULL
       AND e.occurred_at > ?
     ORDER BY e.seq`,
  ).all(sinceIso) as Array<{ event_id: string; occurred_at: string; reason: string | null; item_id: number; title: string; display_title: string | null }>;
  return rows.map((row) => ({
    eventId: row.event_id, itemId: row.item_id, title: row.display_title ?? row.title, reason: row.reason ?? "", at: row.occurred_at,
  }));
}

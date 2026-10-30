// lead 的收件箱（spec §5.5 的 lead_inbox，物理名仍是 inbox）：去抖与熔断在这一层用确定性
// 代码实现，不信任 LLM 自律。收件人是 lead，它的动作是**消化**——判断要不要管、要不要转告，
// 所以这里该合并、可有损。给**人**的通知规则完全相反，走 notifications（无去抖、无熔断），
// 见 store/notifications.ts 的文件头。
import {
  ENTITY_KEY_PATTERN, matchesStandingOrderCondition, timerOriginOf, type EventDisposition, type RootCause, type TimerOrigin,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import type { FollowUpSetBy } from "./user-turn-authority.js";
import { labelTimer, timerFiredOriginFields } from "./timer-origins.js";
import { addActivity } from "./activities.js";
import { appendEventGuarded, clipEventText, disposeCorrelatedEvents, itemEntityKey } from "./events.js";
import { inboxFuseLimits, inboxWakeCondition } from "./standing-orders.js";

export type InboxState = "pending" | "delivered" | "consumed";
export interface InboxRow {
  id: number; item_id: number | null; dedup_scope: string;
  severity: "blocker" | "attention";
  source: "structural" | "semantic"; summary: string; payload: string;
  state: InboxState; created_at: string; delivered_at: string | null;
}

// 熔断的上限（单 scope 在时间窗里的 blocker 条数）来自常设指令 inbox.fuse_blockers（工单 05）：count 3，windowMs 1 小时。
// 合并（去抖）是常设指令 inbox.merge_attention，它没有参数。

// 去抖与熔断的分组键（spec §5.5）。以前按 item_id 分组，而 item_id 现在可空，
// SQLite 里 col = NULL 恒不为真——继续按它分组会让不挂事项的行既不去抖也不熔断，
// 恰好在新放开的那一类行上失去保护。所以分组键必须显式，并且挂了事项时恒等于
// 'item:' || item_id（表上的 CHECK 把这条钉死）。
function dedupScope(args: { itemId?: number; dedupScope?: string }): string {
  if (args.itemId !== undefined) return `item:${args.itemId}`;
  if (args.dedupScope) return args.dedupScope;
  throw new Error("addInbox: give either a itemId or dedupScope");
}

export function addInbox(
  db: Db,
  args: {
    itemId?: number; dedupScope?: string; severity: "blocker" | "attention";
    source: "structural" | "semantic"; summary: string; payload?: unknown;
    lossless?: boolean;
  },
): { id: number | null; suppressed: boolean } {
  // scope 必须在 JS 里拼好再绑定：SQL 里写 'item:' || ? 会让 better-sqlite3 把数字按浮点绑，
  // 拼出 'item:1.0'，与 CHECK 里按列拼出的 'item:1' 对不上。
  const scope = dedupScope(args);
  const itemId = args.itemId ?? null;
  const subject = args.itemId !== undefined ? `工单 #${args.itemId}` : scope;
  // 这一条自己的 payload：合并、熔断时它不再有自己的 inbox 行，原文都在它的事件里（工单 01 第 5 步）。
  const original = asObject(args.payload);
  const event = (inboxId: number, delivery: InboxDelivery, sourceRef: string, fuseOpened?: boolean) => appendInboxEvent(db, () => ({
    inboxId, delivery, sourceRef, itemId, scope, severity: args.severity, source: args.source,
    summary: args.summary, payload: original, ...(fuseOpened !== undefined ? { fuseOpened } : {}),
  }));
  return db.transaction((): { id: number | null; suppressed: boolean } => {
    if (args.severity === "attention" && !args.lossless) {
      // 去抖：同 scope 已有 pending attention → 合并。inbox 行上只记计数和最新的摘要；
      // merged 列表保留，drainNotices 还按它把每条摘要交给 Lead（04 改成读事件以后可以去掉）。
      // Lead 给自己设的跟进不收合并：它到点前一直 pending，并进来的说明会按这一行交给 Lead，
      // 把还没到点的跟进提前交出去，到点时再交一次（2026-10-29 跟进 #395）。
      const existing = db.prepare(
        `SELECT id, payload FROM inbox WHERE dedup_scope = ? AND severity = 'attention' AND state = 'pending'
           AND (NOT json_valid(payload) OR json_extract(payload, '$.kind') IS NOT 'lead_followup')
         LIMIT 1`,
      ).get(scope) as { id: number; payload: string } | undefined;
      if (existing) {
        const count = recordMerged(db, existing, args.summary, { lastSummary: true });
        event(existing.id, "merged", `inbox:${existing.id}:merge:${count}`);
        return { id: existing.id, suppressed: true };
      }
    }

    if (args.severity === "blocker" && !args.lossless) {
      const fuseLimits = inboxFuseLimits(db);
      // 时间窗按秒写成 SQLite 的修饰符（1 小时是 '-3600 seconds'，和原来的 '-1 hour' 一样）。created_at 是 datetime('now') 的格式。
      const recent = (db.prepare(
        "SELECT COUNT(*) AS n FROM inbox WHERE dedup_scope = ? AND severity = 'blocker' AND created_at > datetime('now', ?)",
      ).get(scope, `-${Math.floor(fuseLimits.windowMs / 1000)} seconds`) as { n: number }).n;
      if (recent >= fuseLimits.count - 1) {
        // 熔断：转为/复用聚合通知。
        // 配额计数曾写在 items.notify_quota_used，该列已随 Item 模型删除：它是一份可以从
        // inbox 自身推导出来的冗余状态。现在直接按 dedup_scope 在本表内统计一小时内的
        // blocker 行数（spec §5.5），被吞掉的条数记在聚合通知的 payload.suppressedCount 上。
        const fuse = db.prepare(
          "SELECT id, payload FROM inbox WHERE dedup_scope = ? AND severity = 'blocker' AND state = 'pending' AND summary LIKE '%异常频繁%' LIMIT 1",
        ).get(scope) as { id: number; payload: string } | undefined;
        // 被折叠的每一条原文都作为一条事件留在日志里（工单 01 第 5 步），聚合行上只有计数和最新的摘要。
        if (fuse) {
          const p = JSON.parse(fuse.payload || "{}");
          p.suppressedCount = (p.suppressedCount ?? 0) + 1;
          p.lastSummary = args.summary;
          db.prepare("UPDATE inbox SET payload = ? WHERE id = ?").run(JSON.stringify(p), fuse.id);
          event(fuse.id, "folded", `inbox:${fuse.id}:fold:${p.suppressedCount}`, false);
          return { id: fuse.id, suppressed: true };
        }
        const r = db.prepare(
          `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary, payload)
           VALUES (?, ?, 'blocker', 'structural', ?, ?)`,
        ).run(
          itemId, scope,
          `${subject} 异常频繁（${windowText(fuseLimits.windowMs)}内多次 blocker），建议人工介入`,
          JSON.stringify({ suppressedCount: 1, lastSummary: args.summary }),
        );
        const fuseId = Number(r.lastInsertRowid);
        event(fuseId, "folded", `inbox:${fuseId}:fold:1`, true);
        return { id: fuseId, suppressed: true };
      }
    }

    const r = db.prepare(
      `INSERT INTO inbox (item_id, dedup_scope, severity, source, summary, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      itemId, scope,
      args.severity, args.source, args.summary, JSON.stringify(args.payload ?? {}),
    );
    const id = Number(r.lastInsertRowid);
    event(id, "row", `inbox:${id}`);
    return { id, suppressed: false };
  })();
}

type InboxDelivery = "row" | "merged" | "folded";

// 并进一行的一条：这一行上记下它的摘要（merged），返回并进来的第几条。原文由调用方记成事件（delivery=merged）。
function recordMerged(
  db: Db, row: { id: number; payload: string }, summary: string, options: { lastSummary: boolean },
): number {
  const p = JSON.parse(row.payload || "{}");
  p.merged = [...(p.merged ?? []), summary];
  p.mergedCount = p.merged.length;
  if (options.lastSummary) p.lastSummary = summary;
  db.prepare("UPDATE inbox SET payload = ? WHERE id = ?").run(JSON.stringify(p), row.id);
  return p.mergedCount as number;
}

/**
 * 把一条说明并进一行还没交给 Lead 的 inbox 行（pending），例如 Run 结束的说明并进同一个 Run 的 blocker（2026-10-29）。
 * 这一行记下它的摘要，原文是一条事件，correlation 指向这一行：Lead 看到一行，处置一次，两件事一起记处置。
 * 这一行已经交给 Lead（delivered）或者消化掉了，不并，返回 false：lead-input 要这一行的事件都处理完才消化它，
 * 后来并进来的事件会让它把整行再交给 Lead 一次。
 */
export function mergeIntoPendingInbox(
  db: Db, inboxId: number,
  args: { severity: "blocker" | "attention"; source: "structural" | "semantic"; summary: string; payload?: unknown },
): boolean {
  return db.transaction((): boolean => {
    const row = db.prepare("SELECT * FROM inbox WHERE id = ? AND state = 'pending'").get(inboxId) as InboxRow | undefined;
    if (!row) return false;
    const count = recordMerged(db, row, args.summary, { lastSummary: false });
    appendInboxEvent(db, () => ({
      inboxId: row.id, delivery: "merged", sourceRef: `inbox:${row.id}:merge:${count}`, itemId: row.item_id,
      scope: row.dedup_scope, severity: args.severity, source: args.source, summary: args.summary,
      payload: asObject(args.payload),
    }));
    return true;
  })();
}

// 熔断行里的时间窗：整小时写「N 小时」（第一版是「1 小时」，和原来的文字一样），否则写分钟。
function windowText(windowMs: number): string {
  return windowMs % 3_600_000 === 0 ? `${windowMs / 3_600_000} 小时` : `${Math.max(1, Math.round(windowMs / 60_000))} 分钟`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// 要不要叫醒 Lead：常设指令 inbox.wake_lead 的 wakeWhen，看这一行的 severity 和 payload（工单 05）。
// 第一版照搬原来的代码：明确标了不叫醒的行（例如 Lead 自己发起的决定）即使是 blocker 也不叫醒；
// 其余的 blocker 叫醒；attention 只有标了 wakeLead=true 的才叫醒。
// db 是必填的（工单 14）：每个调用点都读库里现在的版本。库里读不到或者版本不合格时，standing-orders.ts 退回代码里的种子。
function wakesLead(severity: InboxRow["severity"], payload: Record<string, unknown>, db: Db): boolean {
  return matchesStandingOrderCondition(inboxWakeCondition(db), { severity, payload });
}

function needsUser(severity: InboxRow["severity"], payload: Record<string, unknown>): boolean {
  return typeof payload.needsUser === "boolean" ? payload.needsUser : severity === "blocker";
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

// blocker 的根因（spec D1）：从 payload 里的结构化字段取（raiseBlocker 写的 blockerCode、nextStep、evidence，
// 崩溃路径的 failure）。attention 只有带着错误码时才有根因。
function inboxRootCause(
  severity: InboxRow["severity"], summary: string, payload: Record<string, unknown>,
): RootCause | null {
  const code = text(payload.blockerCode) ?? text(payload.code) ?? text(payload.errorCode)
    ?? (severity === "blocker" ? text(payload.kind) ?? "blocker" : undefined);
  if (!code) return null;
  const failure = asObject(payload.failure);
  const scope = text(failure.scope) ?? text(payload.failureScope);
  const needs = text(failure.needs);
  const evidence = payload.evidence;
  const evidenceText = typeof evidence === "string" ? text(evidence)
    : evidence && typeof evidence === "object" && Object.keys(evidence).length ? JSON.stringify(evidence) : undefined;
  const nextStep = text(payload.nextStep);
  return {
    code,
    ...(scope ? { scope } : {}),
    ...(needs ? { needs } : {}),
    ...(evidenceText ? { evidence: clipEventText(evidenceText) } : {}),
    ...(nextStep ? { next_step: nextStep } : {}),
    message: clipEventText(summary),
  };
}

// 不挂工单的行按 dedup_scope 归到一个对象上。scope 本身不是「类型:编号」的形状时加一个前缀。
function scopeEntityKey(scope: string): string {
  return ENTITY_KEY_PATTERN.test(scope) ? scope : `inbox-scope:${scope}`;
}

interface InboxEventArgs {
  inboxId: number; delivery: InboxDelivery; sourceRef: string; itemId: number | null; scope: string;
  severity: InboxRow["severity"]; source: InboxRow["source"]; summary: string; payload: Record<string, unknown>;
  fuseOpened?: boolean;
}

// 每条交给 Lead 的事一条事件（工单 01 第 4 步）。correlation_id 指向承载它的那一行：
// 那一行被 Lead 处置、被撤回时，同一行的所有事件一起记处置。
// 双写：事件出错不让 inbox 的写入回滚（events.ts 的 appendEventGuarded），所以参数也在 build 里取。
function appendInboxEvent(db: Db, build: () => InboxEventArgs): void {
  appendEventGuarded(db, () => {
    const args = build();
    return {
      source: "system",
      sourceRef: args.sourceRef,
      kind: `inbox.${args.severity}`,
      entityKey: args.itemId !== null ? itemEntityKey(db, args.itemId) : scopeEntityKey(args.scope),
      correlationId: `inbox:${args.inboxId}`,
      rootCause: inboxRootCause(args.severity, args.summary, args.payload),
      payload: {
        inboxId: args.inboxId,
        itemId: args.itemId,
        scope: args.scope,
        severity: args.severity,
        inboxSource: args.source,
        summary: args.summary,
        inboxKind: text(args.payload.kind) ?? null,
        wakeLead: wakesLead(args.severity, args.payload, db),
        needsUser: needsUser(args.severity, args.payload),
        delivery: args.delivery,
        ...(args.fuseOpened !== undefined ? { fuseOpened: args.fuseOpened } : {}),
        // 带着外部内容的一行（例如读过外部系统的轻子 agent 交回的结果，lead-tools-and-routing spec D10）：
        // daemon 按事件的 payload.external 把叫醒的这一轮算成外部的一轮。
        ...(args.payload.external === true ? { external: true } : {}),
        payload: args.payload,
      },
    };
  });
}

/**
 * 给一行不经过 addInbox 写进来的 inbox 记事件（engine 里两处直接 INSERT 的地方：审批和决定的 inbox、编排预算）。
 * 必须在写这一行的同一个事务里调用。它走 appendEventGuarded：事件出错时改记 system.event_rejected，这一行照常提交。
 */
export function recordInboxEvent(db: Db, inboxId: number, options: { sourceRef?: string } = {}): void {
  appendInboxEvent(db, () => {
    const row = db.prepare("SELECT * FROM inbox WHERE id = ?").get(inboxId) as InboxRow | undefined;
    if (!row) throw new Error(`recordInboxEvent: inbox #${inboxId} 不存在`);
    return {
      inboxId: row.id, delivery: "row", sourceRef: options.sourceRef ?? `inbox:${row.id}`, itemId: row.item_id,
      scope: row.dedup_scope, severity: row.severity, source: row.source, summary: row.summary, payload: payloadOf(row),
    };
  });
}

/**
 * Lead 的事件游标第一次建立时（工单 04：新库，或者 04 之前的库），还没处理完（pending、delivered）的 inbox 行
 * 各转成一条新的事件，排在游标后面，交给 Lead 一次。以前这些行由每一轮开头的 drainNotices 交给 Lead。
 * 每行只转一次（source_ref 是 inbox:<id>:carryover）。最多 limit 行，最新的优先。返回转了几行。
 */
// Lead 给自己设的跟进：到点的那一条事件（timer.fired）才叫醒 Lead。已经到点、到点的事件也已经记过的，补一条到点事件；
// 还没到点的不用转：到点时 recordDueLeadFollowUps 照常记。
export function carryOverPendingInbox(db: Db, opts: { limit?: number } = {}): number {
  const rows = (db.prepare(
    `SELECT * FROM inbox WHERE state IN ('pending', 'delivered') ORDER BY id DESC LIMIT ?`,
  ).all(opts.limit ?? 500) as InboxRow[]).reverse();
  db.transaction(() => {
    for (const row of rows) {
      if (payloadOf(row).kind !== "lead_followup") {
        recordInboxEvent(db, row.id, { sourceRef: `inbox:${row.id}:carryover` });
        continue;
      }
      const fired = db.prepare("SELECT 1 FROM events WHERE source = 'timer' AND source_ref = ?").get(`followup:${row.id}`);
      if (fired) appendFollowUpFired(db, row, `followup:${row.id}:carryover`);
    }
  })();
  return rows.length;
}

// Lead 给自己的处置（record_disposition）对应到事件的处置（spec D5）。cancelled 只出现在取消的跟进上。
function eventDispositionOf(kind: string): EventDisposition {
  if (kind === "handled" || kind === "told_user" || kind === "deferred" || kind === "no_action" || kind === "seen") return kind;
  return "no_action";
}

export function listInbox(
  db: Db,
  filter?: { state?: InboxState[]; severity?: "blocker" | "attention" },
): InboxRow[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filter?.state?.length) {
    where.push(`state IN (${filter.state.map(() => "?").join(",")})`);
    vals.push(...filter.state);
  }
  if (filter?.severity) { where.push("severity = ?"); vals.push(filter.severity); }
  return db.prepare(
    `SELECT * FROM inbox${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
  ).all(...vals) as InboxRow[];
}

export function markInbox(db: Db, ids: number[], state: "delivered" | "consumed"): void {
  if (!ids.length) return;
  const qs = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE inbox SET state = ?, delivered_at = COALESCE(delivered_at, datetime('now')) WHERE id IN (${qs})`,
  ).run(state, ...ids);
}

// Lead 的一轮被 daemon 重启打断：灌进这一轮、还没消化的行回到 pending，下一个 daemon 照常叫醒 Lead 处理。
// 只改 delivered 的行；已经消化（consumed）的不动。
export function returnInboxToPending(db: Db, ids: number[]): void {
  if (!ids.length) return;
  const qs = ids.map(() => "?").join(",");
  db.prepare(`UPDATE inbox SET state = 'pending' WHERE state = 'delivered' AND id IN (${qs})`).run(...ids);
}

// ── Lead 是常驻的助理（2026-10-15 用户决定，Jarvis 模式）──────────────────────────
// 「系统的异常情况，lead 应该都是及时感知的，并且尽可能介入处理，UI 上我希望除非需要我介入，否则我希望是弱反馈」；
// 委派出去的事，异常的、完成的，都先让 Lead 知道，由 Lead 决定怎样告诉用户。
// 一条行有两个标签，记在 payload 里。它们是给 Lead 和界面的参考，不决定要不要推给用户：
//   - wakeLead：要不要马上叫醒 Lead（要决定的事）。blocker 总是叫醒；attention 只有标了的才叫醒，其余等下一轮。
//     这是 token 的取舍：完成和进展攒着，不为每一件都开一轮。
//   - needsUser：这件事通常要不要用户行动。界面据此算「需要你」。没有标记的旧行：blocker 算，attention 不算。
// 向用户推送由 Lead 用 notify_user 决定。系统只在 Lead 不能工作时兜底：把积压的事升级（escalateLeadBacklog），
// 由 daemon 发一条汇总。送达不能只靠 Lead，但也不拿计时器推翻 Lead 的判断。

function payloadOf(row: Pick<InboxRow, "payload">): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.payload || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * 这一行要不要叫醒 Lead（常设指令 inbox.wake_lead，读库里现在的版本）。
 * 工单 14：以前 db 可以不给，不给时用代码里的种子；04 以后 daemon 不再按 inbox 行叫醒 Lead（改读事件的级别），
 * 剩下的调用点（addInbox 写事件的 wakeLead 标记、游标第一次建立时的转写、Lead 不能工作时的兜底汇总）都给了 db，
 * 所以 db 改成必填，不再有悄悄用种子的路径。
 */
export function inboxWakesLead(row: Pick<InboxRow, "severity" | "payload">, db: Db): boolean {
  return wakesLead(row.severity, payloadOf(row), db);
}

export function inboxNeedsUser(row: Pick<InboxRow, "severity" | "payload">): boolean {
  return needsUser(row.severity, payloadOf(row));
}

/** 到没到时间：Lead 给自己设的跟进（payload.notBefore）到点前不叫醒它，也不灌进它的回合。 */
export function inboxDue(row: Pick<InboxRow, "payload">, now: Date = new Date()): boolean {
  const notBefore = payloadOf(row).notBefore;
  return typeof notBefore !== "string" || Date.parse(notBefore) <= now.getTime();
}

/** Lead 给自己设一个跟进：到点叫醒它，带着它当时写的话。 */
// setBy：用户本人在他那一轮里让 Lead 设的（user-turn-authority.ts 的 FollowUpSetBy）。到点那一轮算用户的一轮。
// 没有时是 Lead 自己设的跟进，到点那一轮只有 Lead 自己的权限。
// origin：谁要求设的（protocol 的 timer-origins.ts，spec D16）。外部来源的跟进到点时，那一轮按外部的一轮算（timer-origins.ts）。
export function addLeadFollowUp(
  db: Db, args: { at: Date; note: string; itemId?: number; setBy?: FollowUpSetBy; origin?: TimerOrigin },
): number {
  const result = addInbox(db, {
    ...(args.itemId !== undefined ? { itemId: args.itemId } : { dedupScope: `lead-followup:${args.at.toISOString()}` }),
    severity: "attention",
    source: "semantic",
    summary: `跟进：${args.note}`,
    payload: {
      kind: "lead_followup", note: args.note, notBefore: args.at.toISOString(), wakeLead: true, needsUser: false,
      ...(args.setBy ? { setBy: args.setBy } : {}),
      ...(args.origin ? { origin: args.origin } : {}),
    },
    lossless: true,
  });
  return result.id!;
}

export type LeadDisposition = "handled" | "told_user" | "deferred" | "no_action" | "seen" | "cancelled";

/** Lead 取消自己设的跟进：这一行不再叫醒它，并记下原因。不是跟进的行拒绝。 */
export function cancelLeadFollowUp(db: Db, id: number, args: { reason: string; at?: Date }): void {
  const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(id) as InboxRow | undefined;
  if (!row) throw new Error(`#${id} 不存在`);
  if (payloadOf(row).kind !== "lead_followup") throw new Error(`#${id} 不是跟进`);
  const disposition = { kind: "cancelled", reason: args.reason, at: (args.at ?? new Date()).toISOString() };
  db.transaction(() => {
    db.prepare("UPDATE inbox SET state='consumed', delivered_at=COALESCE(delivered_at, ?), payload=? WHERE id=?")
      .run(disposition.at, JSON.stringify({ ...payloadOf(row), disposition }), id);
    disposeCorrelatedEvents(db, `inbox:${id}`, "no_action", { reason: args.reason, cancelled: true }, { at: args.at });
  })();
}

/**
 * Lead 给自己设的跟进到点了：每一条记一条 timer.fired（工单 01 第 4 步）。scheduler 每一拍调用。
 * 跟进到点不改 inbox 行（到没到点是按 notBefore 现算的，inboxDue），所以这条事件是到点这件事唯一的记录。
 * 同一条跟进只记一次（source_ref 是 followup:<inbox id>）。已经取消、已经处理掉（consumed）的不记。返回记了几条。
 */
export function recordDueLeadFollowUps(db: Db, now: Date = new Date()): number {
  const due = db.prepare(
    `SELECT * FROM inbox
     WHERE state IN ('pending', 'delivered')
       AND json_valid(payload) AND json_extract(payload, '$.kind') = 'lead_followup'
       AND json_extract(payload, '$.notBefore') <= ?
       AND NOT EXISTS (SELECT 1 FROM events WHERE source = 'timer' AND source_ref = 'followup:' || inbox.id)
     ORDER BY id`,
  ).all(now.toISOString()) as InboxRow[];
  for (const row of due) db.transaction(() => appendFollowUpFired(db, row, `followup:${row.id}`))();
  return due.length;
}

function appendFollowUpFired(db: Db, row: InboxRow, sourceRef: string): void {
  const payload = payloadOf(row);
  appendEventGuarded(db, () => ({
    source: "timer",
    sourceRef,
    kind: "timer.fired",
    entityKey: row.item_id !== null ? itemEntityKey(db, row.item_id) : scopeEntityKey(row.dedup_scope),
    correlationId: `inbox:${row.id}`,
    occurredAt: String(payload.notBefore),
    payload: {
      timer: "lead_followup",
      scheduledAt: String(payload.notBefore),
      itemId: row.item_id,
      inboxId: row.id,
      ...(typeof payload.note === "string" ? { note: payload.note } : {}),
      // 用户本人设的跟进（daemon 据此让到点那一轮凭 timer:<inboxId> 算用户的一轮）。
      ...(payload.setBy ? { setByUser: true } : {}),
      // 谁要求设的：外部来源的带 external 和来源的名字，到点那一轮按外部的一轮算（spec D16）。
      ...timerFiredOriginFields(timerOriginOf(payload.origin)),
      wakeLead: wakesLead(row.severity, payload, db),
    },
  }));
  // 没问就设的外部来源跟进照常到点了：校准样本「照做」。
  labelTimer(db, "follow_up", row.id, "kept", "system");
}

/**
 * Lead 怎样处置了这几件事（它自己说的）。挂在工单上的，工单的活动里也记一条。返回记下的条数。
 * 自己处理掉的事，Lead 可以另写根因（cause）、做了什么（action）、以后会怎样（followUp）：
 * 收件箱的「Lead 已处理」按这几项分行显示。没写的项不落库。
 */
export function recordInboxDisposition(
  db: Db, ids: readonly number[], args: {
    disposition: Exclude<LeadDisposition, "seen">; reason: string; at?: Date;
    cause?: string; action?: string; followUp?: string;
  },
): number {
  const at = (args.at ?? new Date()).toISOString();
  const details = {
    ...(args.cause ? { cause: args.cause } : {}),
    ...(args.action ? { action: args.action } : {}),
    ...(args.followUp ? { followUp: args.followUp } : {}),
  };
  return db.transaction((): number => {
    let recorded = 0;
    for (const id of ids) {
      const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(id) as InboxRow | undefined;
      if (!row) continue;
      const disposition = { kind: args.disposition, reason: args.reason, at, ...details };
      db.prepare("UPDATE inbox SET payload=? WHERE id=?").run(JSON.stringify({ ...payloadOf(row), disposition }), id);
      // 同一行的所有事件（合并、熔断进来的也算）记同一个处置。Lead 改口时覆盖（工单 01 第 6 步）。
      disposeCorrelatedEvents(db, `inbox:${id}`, eventDispositionOf(args.disposition),
        { reason: args.reason, ...details }, { onlyUndisposed: false, at: new Date(at) });
      if (row.item_id !== null) {
        addActivity(db, {
          itemId: row.item_id, actor: "lead", kind: "decision",
          payload: { decision: "lead_disposition", inboxId: id, disposition: args.disposition, reason: args.reason, summary: row.summary, ...details },
        });
      }
      recorded++;
    }
    return recorded;
  })();
}

/** 一轮成功以后：Lead 没说怎么处置的事，记成「看过了」。这样每件事都有去向，可以事后汇总。 */
export function recordSeenDispositions(db: Db, ids: readonly number[], at: Date = new Date()): void {
  db.transaction(() => {
    for (const id of ids) {
      const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(id) as InboxRow | undefined;
      if (!row) continue;
      const payload = payloadOf(row);
      // 事件也一样：还没有处置的记成看过了。这一行 Lead 已经说了怎么处置时，后来并进这一行的事件跟它一样。
      const recorded = asObject(payload.disposition);
      disposeCorrelatedEvents(
        db, `inbox:${id}`,
        typeof recorded.kind === "string" ? eventDispositionOf(recorded.kind) : "seen",
        typeof recorded.kind === "string" ? { reason: recorded.reason ?? null, recordedBy: "lead" } : null,
        { at },
      );
      if (payload.disposition !== undefined) continue;
      db.prepare("UPDATE inbox SET payload=? WHERE id=?")
        .run(JSON.stringify({ ...payload, disposition: { kind: "seen", at: at.toISOString() } }), id);
    }
  })();
}

/** 交给 Lead、还没处理完（pending 或 delivered）、已经到点、也还没升级的事，按 id 排。 */
export function listLeadBacklog(db: Db, now: Date = new Date()): InboxRow[] {
  return listInbox(db, { state: ["pending", "delivered"] })
    .filter((row) => inboxWakesLead(row, db) && inboxDue(row, now) && payloadOf(row).escalatedAt === undefined);
}

/**
 * Lead 不能工作时，把这些事升级给用户：每一行改成要用户知道，只升级一次。返回这次升级的行。
 * 给用户的那一条汇总由 daemon 发：Lead 不能工作时，不能指望 Lead 去说。
 */
export function escalateLeadBacklog(db: Db, ids: readonly number[], args: { reason: string; at?: Date }): number[] {
  const at = (args.at ?? new Date()).toISOString();
  return db.transaction((): number[] => {
    const escalated: number[] = [];
    for (const id of ids) {
      const row = db.prepare("SELECT * FROM inbox WHERE id=?").get(id) as InboxRow | undefined;
      if (!row) continue;
      const payload = payloadOf(row);
      if (payload.escalatedAt !== undefined) continue;
      db.prepare("UPDATE inbox SET payload=? WHERE id=?")
        .run(JSON.stringify({ ...payload, needsUser: true, escalatedAt: at, escalationReason: args.reason }), id);
      // Lead 不能工作，系统把这件事汇总给了用户：事件的处置是「告诉了用户」，经由兜底。
      disposeCorrelatedEvents(db, `inbox:${id}`, "told_user", { via: "fallback", reason: args.reason }, { at: new Date(at) });
      escalated.push(id);
    }
    return escalated;
  }).immediate();
}

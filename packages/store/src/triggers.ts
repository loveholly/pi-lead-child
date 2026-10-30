// Trigger 层的 DAO（spec §3.3/§5.3/§10）：一条 trigger 声明「什么时候触发 + 触发了做什么」。
//
// 规则不是事项：「每周一提醒我交周报」是规则（没有截止期、永不完成），「这周一那次提醒」
// 才是 Item。这条边界同时决定了 webhook 接在哪——webhook 是「收到请求时做某事」，与 cron
// 同类，与 Item 不同类。所以本文件只管 source（何时），action 的展开在 trigger-actions.ts，
// 两者之间除了 (trigger, occurrenceAt) 不共享任何东西。scheduler 因此降级成众多 source
// 生产者之一，webhook 接收器将来是另一个，共用同一个 action 执行器。
import { CronExpressionParser } from "cron-parser";
import type { Db } from "./db.js";
import type { Actor } from "@pi-lead-child/core";
import { triggerMaxFailures } from "@pi-lead-child/core";
import { addNotification } from "./notifications.js";
import { addInbox } from "./inbox.js";
import { localTz } from "@pi-lead-child/core";

export type TriggerSourceType = "once" | "cron" | "webhook";
export type TriggerActionType = "create_item" | "create_and_start" | "start_item";

export interface TriggerAction {
  type: TriggerActionType;
  payload: Record<string, unknown>;
}

export interface Trigger {
  id: number; label: string; enabled: number; created_by: Actor;
  source_type: TriggerSourceType;
  fire_at: string | null; cron_expr: string | null; cron_tz: string | null;
  webhook_path: string | null; webhook_secret_ref: string | null;
  next_fire_at: string | null;
  action_type: TriggerActionType; action_payload: string;
  last_fired_at: string | null; fire_count: number; consecutive_failures: number;
  created_at: string;
}

// 从给定时刻起算 cron 的下一次触发。cron 按 tz（缺省本机时区）解析，存储仍是 ISO UTC。
// 原样搬自被本文件取代的 schedules.ts —— cron 语义必须不变（spec §10 明确要求保留）。
// DST 跳变窗口（如 2-3am 不存在/1-2am 重复）cron-parser 行为：跳前取顺延、重复取首次
// ——个人系统可接受，不特判。
export function nextRun(cron: string, from: Date, tz: string = localTz()): string {
  const iso = CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toISOString();
  if (!iso) throw new Error(`cron has no next occurrence: ${cron}`);
  return iso;
}

function insertTrigger(
  db: Db,
  row: {
    label: string; createdBy: Actor; sourceType: TriggerSourceType;
    fireAt?: string | null; cronExpr?: string | null; cronTz?: string | null;
    webhookPath?: string | null; webhookSecretRef?: string | null;
    nextFireAt: string | null; action: TriggerAction;
  },
): number {
  const r = db.prepare(
    `INSERT INTO triggers (
       label, created_by, source_type, fire_at, cron_expr, cron_tz,
       webhook_path, webhook_secret_ref, next_fire_at, action_type, action_payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.label, row.createdBy, row.sourceType,
    row.fireAt ?? null, row.cronExpr ?? null, row.cronTz ?? null,
    row.webhookPath ?? null, row.webhookSecretRef ?? null,
    row.nextFireAt, row.action.type, JSON.stringify(row.action.payload ?? {}),
  );
  return Number(r.lastInsertRowid);
}

export function createOnceTrigger(
  db: Db,
  args: { label: string; fireAt: string; createdBy: Actor; action: TriggerAction },
): number {
  const fireAt = new Date(args.fireAt);
  if (Number.isNaN(fireAt.getTime())) throw new Error(`invalid fire_at: ${args.fireAt}`);
  const iso = fireAt.toISOString();
  return insertTrigger(db, {
    label: args.label, createdBy: args.createdBy, sourceType: "once",
    fireAt: iso, nextFireAt: iso, action: args.action,
  });
}

export function createCronTrigger(
  db: Db,
  args: {
    label: string; cronExpr: string; tz?: string; createdBy: Actor; action: TriggerAction;
  },
  now: Date,
): number {
  const tz = args.tz ?? localTz();
  const next = nextRun(args.cronExpr, now, tz); // 顺带校验 cron 合法性
  return insertTrigger(db, {
    label: args.label, createdBy: args.createdBy, sourceType: "cron",
    cronExpr: args.cronExpr, cronTz: tz, nextFireAt: next, action: args.action,
  });
}

export function getTrigger(db: Db, id: number): Trigger | undefined {
  return db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Trigger | undefined;
}

export function listTriggers(db: Db, opts?: { enabledOnly?: boolean }): Trigger[] {
  const sql = opts?.enabledOnly
    ? "SELECT * FROM triggers WHERE enabled = 1 ORDER BY next_fire_at IS NULL, next_fire_at, id"
    : "SELECT * FROM triggers ORDER BY next_fire_at IS NULL, next_fire_at, id";
  return db.prepare(sql).all() as Trigger[];
}

// 到点的 trigger。webhook 的 next_fire_at 恒为 NULL，因此天然不会被时钟扫到——
// 它由入站请求推进（spec §13），与本函数无关。
export function dueTriggers(db: Db, now: Date): Trigger[] {
  return db.prepare(
    `SELECT * FROM triggers
     WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
     ORDER BY next_fire_at, id`,
  ).all(now.toISOString()) as Trigger[];
}

// 推进到下一次。cron 相对当前 now 推进而非逐个补齐：停机期间错过的 occurrence 跳过、
// 不追赶（spec §10 明确保留这一既有取舍）。once 推进后就没有"下一次"了，直接停用。
export function advanceTrigger(db: Db, id: number, now: Date): void {
  const t = getTrigger(db, id);
  if (!t) return;
  if (t.source_type === "cron" && t.cron_expr) {
    db.prepare("UPDATE triggers SET next_fire_at = ? WHERE id = ?")
      .run(nextRun(t.cron_expr, now, t.cron_tz ?? undefined), id);
    return;
  }
  db.prepare("UPDATE triggers SET next_fire_at = NULL, enabled = 0 WHERE id = ?").run(id);
}

export function setTriggerEnabled(db: Db, id: number, enabled: boolean): void {
  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

// 占坑 + 推进，同一事务，且必须排在 action 执行之前（spec §10）。
// 顺序是规格的一部分：先执行再推进的话，一条抛错的 action 会让 next_fire_at 永远停在过去，
// 每 tick 重试同一个 occurrence，整条 schedule 从此冻结。
// 返回 trigger_fires.id；UNIQUE(trigger_id, dedup_key) 冲突（本 occurrence 已处理过）返回 null。
export function claimTriggerOccurrence(
  db: Db, trigger: Trigger, occurrenceAt: string, now: Date, dedupKey?: string,
): number | null {
  return db.transaction((): number | null => {
    const r = db.prepare(
      `INSERT OR IGNORE INTO trigger_fires (trigger_id, dedup_key, occurrence_at, fired_at)
       VALUES (?, ?, ?, ?)`,
    ).run(trigger.id, dedupKey ?? occurrenceAt, occurrenceAt, now.toISOString());
    // 冲突也要推进：next_fire_at 停在一个已处理过的 occurrence 上同样是冻结。
    advanceTrigger(db, trigger.id, now);
    if (r.changes === 0) return null;
    db.prepare(
      "UPDATE triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?",
    ).run(occurrenceAt, trigger.id);
    return Number(r.lastInsertRowid);
  })();
}

// 这个 trigger 在 [from, to) 里真的触发过的 occurrence（ISO，和 triggerOccurrences 的写法一样）。
// 日程用它区分「过去真的执行过」和「只是按 cron 算出来的」。
export function firedOccurrences(db: Db, triggerId: number, range: { from: string; to: string }): Set<string> {
  const rows = db.prepare(
    "SELECT occurrence_at FROM trigger_fires WHERE trigger_id = ? AND occurrence_at >= ? AND occurrence_at < ?",
  ).all(triggerId, range.from, range.to) as { occurrence_at: string }[];
  return new Set(rows.map((row) => row.occurrence_at));
}

export function completeTriggerFire(
  db: Db,
  fireId: number,
  outcome: { status: "succeeded" | "failed"; error?: string | null; producedItemId?: number | null },
): void {
  db.prepare(
    "UPDATE trigger_fires SET status = ?, error = ?, produced_item_id = ? WHERE id = ?",
  ).run(outcome.status, outcome.error ?? null, outcome.producedItemId ?? null, fireId);
}

export function clearTriggerFailures(db: Db, id: number): void {
  db.prepare("UPDATE triggers SET consecutive_failures = 0 WHERE id = ?").run(id);
}

// 连续失败累加；达到 PLC_TRIGGER_MAX_FAILURES 自动停用并通知用户（spec §10）。
// 通知走 notifications 而不是 inbox：一条规则被系统关掉是用户必须知道的事实，
// 不该由 lead 决定要不要转告。urgency='batchable'——重要但不紧急。
// 返回是否因此被停用。
export function recordTriggerFailure(
  db: Db, id: number, error: string, env: Record<string, string | undefined> = process.env,
): boolean {
  const max = triggerMaxFailures(env);
  return db.transaction((): boolean => {
    db.prepare("UPDATE triggers SET consecutive_failures = consecutive_failures + 1 WHERE id = ?")
      .run(id);
    const t = getTrigger(db, id);
    if (!t) return false;
    // A once trigger is disabled as soon as its occurrence is claimed. Its
    // first action failure must still become a durable user-visible fact;
    // otherwise the trigger disappears without either producing its item or
    // explaining the loss.
    // 2026-10-15 起先交给 Lead（异常先交给 Lead，需要你时才强提醒）：它看错误，能补做就补做；
    // 这一行是持久的，Lead 处理不了时 daemon 升级给用户（inbox.ts 的 escalateLeadRow），事实不会丢。
    if (t.source_type === "once" && !t.enabled) {
      addInbox(db, {
        dedupScope: `trigger-failed:${t.id}`,
        severity: "attention",
        source: "structural",
        summary: `一次性规则「${t.label}」执行失败：${error.slice(0, 400)}`,
        payload: { kind: "trigger_failed", triggerId: t.id, error, wakeLead: true, needsUser: false },
        lossless: true,
      });
      return true;
    }
    if (t.consecutive_failures < max || !t.enabled) return false;
    db.prepare("UPDATE triggers SET enabled = 0 WHERE id = ?").run(id);
    addNotification(db, {
      kind: "trigger_disabled", urgency: "batchable",
      title: `例行规则「${t.label}」已自动停用`,
      body: `连续失败 ${t.consecutive_failures} 次后自动停用；最后一次错误：${error}`,
    });
    return true;
  })();
}

// 日历/agenda 用：把一条 cron trigger 在窗口内的全部 occurrence 摊开。
// 与 next_fire_at 无关——那是"下一次真的会触发的时刻"，这里只是预览。
export function triggerOccurrences(
  trigger: Pick<Trigger, "source_type" | "cron_expr" | "cron_tz" | "fire_at">,
  range: { from: Date; to: Date; timezone: string; limit?: number },
): string[] {
  if (range.to <= range.from) return [];
  if (trigger.source_type === "once") {
    const at = trigger.fire_at;
    return at && at >= range.from.toISOString() && at < range.to.toISOString() ? [at] : [];
  }
  if (trigger.source_type !== "cron" || !trigger.cron_expr) return [];
  const expression = CronExpressionParser.parse(trigger.cron_expr, {
    currentDate: range.from,
    endDate: range.to,
    tz: trigger.cron_tz ?? range.timezone,
  });
  const occurrences: string[] = [];
  const limit = range.limit ?? 512;
  while (occurrences.length < limit) {
    try {
      const next = expression.next().toISOString();
      if (!next) break;
      if (next >= range.to.toISOString()) break;
      occurrences.push(next);
    } catch {
      break;
    }
  }
  return occurrences;
}

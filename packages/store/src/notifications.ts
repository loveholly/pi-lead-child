// 用户通知通道（spec §3.4/§4/§5.4）。收件人是**人**，不是 lead。
//
// ## 这张表刻意没有去抖、也没有熔断，这是它最重要的性质
//
// 别"优化"掉它。`src/store/inbox.ts` 那套 attention 合并（同 scope 已有一条 pending
// 就把新的 summary 塞进旧行的 payload.merged 里）正是本次重构存在的原因：到点的提醒
// 一旦走 inbox，就会被折叠进别人的 payload 中静默消失，用户永远收不到——spec §1 记录
// 的就是这条既有缺陷。
//
// 两张表的规则完全相反，所以它们是两张表而不是一张带 audience 字段的表（spec §3.4）：
//   lead_inbox  收件人 lead，lead 的动作是**消化**（判断要不要管），可以不说，该合并；
//   notifications 收件人是人，lead 的动作是**播报**（已确定要给你的），不能不说，恰好一次。
// 合成一张表意味着每条规则都要 if audience，而"lead 可自行消化"这一能力迟早会漏到
// 用户通知上——那就等于把刚修好的缺陷重新装回去。
//
// lead 不拥有通知：不能决定要不要说、不能改写核心内容、不能因忙而吞掉。表是事实，
// lead 只是表达层；`delivered_via` 让"lead 在漏播"变得可观测（spec §4）。
import type { Db } from "./db.js";
import { appendEventGuarded, disposeCorrelatedEvents, itemEntityKey } from "./events.js";

export type NotificationUrgency = "immediate" | "batchable";
export type NotificationState = "pending" | "delivered" | "acked";
export type NotificationChannel = "lead" | "fallback";

export interface NotificationRow {
  id: number; item_id: number | null; kind: string;
  dedup_key: string | null;
  urgency: NotificationUrgency; title: string; body: string;
  state: NotificationState; created_at: string;
  delivered_at: string | null; delivered_via: NotificationChannel | null;
  acked_at: string | null;
}

export function addNotification(
  db: Db,
  args: {
    itemId?: number | null; kind: string; urgency: NotificationUrgency;
    title: string; body?: string; createdAt?: string; dedupKey?: string | null;
  },
): number {
  // 没有 dedupKey 时不做任何"已存在类似通知"的查询，这是有意的：见文件头。
  // 有 dedupKey 的调用方是在表达同一个系统事件（review_passed 等），这时恰好一次是契约。
  // created_at 一律写 ISO，不走 DDL 里的 datetime('now')：兜底窗口是拿 created_at 与一个
  // ISO cutoff 做字符串比较的，而 'YYYY-MM-DD HH:MM:SS' 里的空格恒小于 ISO 的 'T'，
  // 两种格式混在同一列里会让当天写下的通知立刻被判成逾期。
  return db.transaction((): number => {
    if (args.dedupKey) {
      const existing = db.prepare("SELECT id FROM notifications WHERE dedup_key = ?")
        .get(args.dedupKey) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    const createdAt = args.createdAt ?? new Date().toISOString();
    const r = db.prepare(
      `INSERT INTO notifications (item_id, kind, dedup_key, urgency, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.itemId ?? null, args.kind, args.dedupKey ?? null, args.urgency, args.title,
      args.body ?? "", createdAt,
    );
    const id = Number(r.lastInsertRowid);
    // 双写（Lead 事件主干，工单 01）：每条通知一条事件，和通知同一个事务。送达或确认时记处置。
    // 事件出错不让通知的写入回滚（appendEventGuarded）。
    appendEventGuarded(db, () => ({
      source: "system",
      sourceRef: `notification:${id}`,
      kind: "notification.created",
      entityKey: args.itemId != null ? itemEntityKey(db, args.itemId) : `notification:${id}`,
      correlationId: `notification:${id}`,
      occurredAt: createdAt,
      payload: {
        notificationId: id, itemId: args.itemId ?? null, notificationKind: args.kind, urgency: args.urgency,
        title: args.title, body: args.body ?? "", dedupKey: args.dedupKey ?? null,
      },
    }));
    return id;
  })();
}

export function getNotification(db: Db, id: number): NotificationRow | undefined {
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
    NotificationRow | undefined;
}

export function listNotifications(
  db: Db,
  filter?: {
    state?: NotificationState[]; urgency?: NotificationUrgency;
    itemId?: number; limit?: number;
    // 只要这个时刻以后创建的（ISO 时间）。旧行的 created_at 可能是 'YYYY-MM-DD HH:MM:SS'，所以按 julianday 比较，
    // 不按字符串比较（见 addNotification 的注释）。
    since?: string;
    // 按创建时间从新到旧（Lead 的 read_notifications，工单 03）。缺省按 id 从旧到新。
    newestFirst?: boolean;
  },
): NotificationRow[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filter?.state?.length) {
    where.push(`state IN (${filter.state.map(() => "?").join(",")})`);
    vals.push(...filter.state);
  }
  if (filter?.urgency) { where.push("urgency = ?"); vals.push(filter.urgency); }
  if (filter?.itemId !== undefined) { where.push("item_id = ?"); vals.push(filter.itemId); }
  if (filter?.since !== undefined) { where.push("julianday(created_at) >= julianday(?)"); vals.push(filter.since); }
  const order = filter?.newestFirst ? " ORDER BY julianday(created_at) DESC, id DESC" : " ORDER BY id";
  const limit = filter?.limit ? ` LIMIT ${Number(filter.limit)}` : "";
  return db.prepare(
    `SELECT * FROM notifications${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`
    + `${order}${limit}`,
  ).all(...vals) as NotificationRow[];
}

// delivered 由"系统真正显示了"来标，不是 lead 声称读过就算（spec §4）。
// 事件的处置：送达就是「告诉了用户」（Lead 说的或兜底推的，记在 via 里）。
export function markNotificationDelivered(
  db: Db, id: number, via: NotificationChannel, at: Date = new Date(),
): void {
  db.transaction(() => {
    const changed = db.prepare(
      `UPDATE notifications
       SET state = 'delivered',
           delivered_at = COALESCE(delivered_at, ?),
           delivered_via = COALESCE(delivered_via, ?)
       WHERE id = ? AND state = 'pending'`,
    ).run(at.toISOString(), via, id).changes;
    if (changed) disposeCorrelatedEvents(db, `notification:${id}`, "told_user", { via }, { at });
  })();
}

// 用户确认了：还没有处置的事件也算告诉了用户。
export function ackNotification(db: Db, id: number, at: Date = new Date()): void {
  db.transaction(() => {
    const changed = db.prepare(
      "UPDATE notifications SET state = 'acked', acked_at = ? WHERE id = ? AND state <> 'acked'",
    ).run(at.toISOString(), id).changes;
    if (changed) disposeCorrelatedEvents(db, `notification:${id}`, "told_user", { via: "ack" }, { at });
  })();
}

// 兜底闸门（spec §4）：immediate 的通知 pending 超过窗口仍未 delivered，系统直接推送。
// batchable 不走兜底——它本来就可以攒到 lead 下一次开口。
export function notificationsNeedingFallback(
  db: Db, now: Date, windowMs: number,
): NotificationRow[] {
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  return db.prepare(
    `SELECT * FROM notifications
     WHERE state = 'pending' AND urgency = 'immediate' AND created_at < ?
     ORDER BY id`,
  ).all(cutoff) as NotificationRow[];
}

// 安全报警（protocol 的 security-alerts.ts）：一次报警一条 interrupt 级的事件，加一条推送用的通知（kind security_alert，
// immediate，不挂工单），同一个事务。事件的 correlation_id 指向通知：daemon 直接推送以后通知记成已送达，
// 事件的处置随之记成 told_user（notifications.ts 的 markNotificationDelivered）。和主人操作的提醒一样。
import { SECURITY_ALERT_NOTIFICATION_KIND, type RootCause } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, clipEventText, getEvent, newEventId, type EventRecord } from "./events.js";
import { addNotification } from "./notifications.js";

export interface SecurityAlertInput {
  kind: string;
  entityKey: string;
  title: string;
  body: string;
  rootCause: RootCause;
  payload: Record<string, unknown>;
  // 同一件事只报一次：同一个 sourceRef 只记一条事件、一条通知。
  sourceRef?: string | null;
  // push（缺省）：interrupt 级，写一条推送用的通知，daemon 直接推。lead：tell 级，不写通知，交给 Lead 告诉用户。
  delivery?: "push" | "lead";
  now?: Date;
}

export interface RecordedSecurityAlert {
  event: EventRecord;
  // 交给 Lead 的报警（delivery 是 lead）没有通知，是 null。
  notificationId: number | null;
  inserted: boolean;
}

export function securityAlertDedupKey(eventId: string): string {
  return `${SECURITY_ALERT_NOTIFICATION_KIND}:${eventId}`;
}

/** 记一次安全报警：事件和推送用的通知（delivery 是 lead 时没有通知）。payload 里会补上 notificationId。 */
export function recordSecurityAlert(db: Db, input: SecurityAlertInput): RecordedSecurityAlert {
  const at = (input.now ?? new Date()).toISOString();
  const push = (input.delivery ?? "push") === "push";
  return db.transaction((): RecordedSecurityAlert => {
    if (input.sourceRef) {
      const existing = db.prepare("SELECT seq FROM events WHERE source = 'system' AND source_ref = ?")
        .get(input.sourceRef) as { seq: number } | undefined;
      if (existing) {
        const event = getEvent(db, existing.seq)!;
        const notificationId = event.correlationId ? Number(event.correlationId.replace("notification:", "")) : null;
        return { event, notificationId, inserted: false };
      }
    }
    const eventId = newEventId();
    const notificationId = push ? addNotification(db, {
      kind: SECURITY_ALERT_NOTIFICATION_KIND, urgency: "immediate", title: clipEventText(input.title, 300),
      body: clipEventText(input.body, 2_000), createdAt: at, dedupKey: securityAlertDedupKey(eventId),
    }) : null;
    const { event } = appendEvent(db, {
      eventId,
      source: "system",
      sourceRef: input.sourceRef ?? null,
      kind: input.kind,
      entityKey: input.entityKey,
      occurredAt: at,
      correlationId: notificationId === null ? null : `notification:${notificationId}`,
      level: push ? "interrupt" : "tell",
      rootCause: input.rootCause,
      // 交给 Lead 的报警没有通知：标题和正文放进事件，Lead 据此告诉用户。
      payload: { ...input.payload, notificationId, ...(push ? {} : { title: input.title, body: input.body }) },
    });
    return { event, notificationId, inserted: true };
  }).immediate();
}

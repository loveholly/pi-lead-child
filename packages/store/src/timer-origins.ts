// 定时器的来源（统一的消息事件 spec D16，工单 12，protocol 的 timer-origins.ts）在库里的读写：
//   - 到点事件（timer.fired）带着来源：外部来源的写上 external 和来源的名字，daemon 据此把到点叫醒的一轮算成外部的一轮；
//   - 外部来源的定时器的校准样本（timer.labeled）：一个决策只记一个标签，幂等键是 timer-label:<决策的编号>。
// 来源本身存在各自的地方：跟进在收件箱那一行的 payload.origin，提醒在「定下提醒时间」的活动里（reminders.ts），
// 规则在 action_payload.origin（trigger-actions.ts）。不另建表。
import {
  TIMER_LABELED_KIND, TIMER_LABEL_RULES, TIMER_REQUEST_DECIDED_KIND, timerRef,
  type TimerKind, type TimerLabel, type TimerOrigin,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEventGuarded } from "./events.js";

/**
 * 到点事件里关于来源的几项。外部来源的：external（daemon 的 isExternalEvent 认它）、source（来源的名字，拒绝和确认卡里写它）、
 * origin。用户本人和系统的只带 origin。没有来源（上线以前设的）时什么都不带。
 */
export function timerFiredOriginFields(origin: TimerOrigin | null): Record<string, unknown> {
  if (!origin) return {};
  return origin.kind === "external" ? { origin, external: true, source: origin.source } : { origin };
}

/**
 * 给一个没问就设了的外部来源定时器记校准样本（用户取消、改了它，或者它照常到点了）。找这个定时器的「设了」的决策；
 * 没有（用户本人、系统设的，或者经过确认卡设的，那张卡已经记过样本）时什么都不做。一个决策只记一个标签。
 */
export function labelTimer(db: Db, kind: TimerKind, id: number, label: TimerLabel, by: "user" | "system", at: Date = new Date()): void {
  const row = db.prepare(
    `SELECT seq, payload FROM events WHERE kind = ? AND source = 'system' AND json_valid(payload)
       AND json_extract(payload, '$.decision') = 'set' AND json_extract(payload, '$.timer.kind') = ?
       AND json_extract(payload, '$.timer.id') = ?
     ORDER BY seq DESC LIMIT 1`,
  ).get(TIMER_REQUEST_DECIDED_KIND, kind, id) as { seq: number; payload: string } | undefined;
  if (row) labelTimerDecision(db, row.seq, JSON.parse(row.payload) as DecidedPayload, label, by, timerRef(kind, id), at);
}

/** 给确认卡对应的决策记校准样本（用户点了「设定时器」或「不设」）。 */
export function labelTimerRequest(db: Db, requestId: string, label: TimerLabel, timer: string | null, at: Date = new Date()): void {
  const row = db.prepare(
    `SELECT seq, payload FROM events WHERE kind = ? AND source = 'system' AND json_valid(payload)
       AND json_extract(payload, '$.request') = ?
     ORDER BY seq DESC LIMIT 1`,
  ).get(TIMER_REQUEST_DECIDED_KIND, requestId) as { seq: number; payload: string } | undefined;
  if (row) labelTimerDecision(db, row.seq, JSON.parse(row.payload) as DecidedPayload, label, "user", timer, at);
}

interface DecidedPayload {
  origin?: { kind?: string; source?: string };
  cost?: { level?: number };
}

function labelTimerDecision(
  db: Db, decidedSeq: number, decided: DecidedPayload, label: TimerLabel, by: "user" | "system", timer: string | null, at: Date,
): void {
  const channel = decided.origin?.kind === "external" && typeof decided.origin.source === "string" ? decided.origin.source : null;
  if (!channel) return;
  const rule = TIMER_LABEL_RULES[label];
  // 在调用方的事务里时并进去（better-sqlite3 的嵌套事务是保存点）；不在时自己开一个。
  db.transaction(() => appendEventGuarded(db, () => ({
    source: "system", sourceRef: `timer-label:${decidedSeq}`, kind: TIMER_LABELED_KIND,
    entityKey: timer ? `timer:${timer}` : `timer-decision:${decidedSeq}`, causationId: String(decidedSeq), level: "record",
    occurredAt: at.toISOString(),
    payload: {
      decidedSeq, label, value: rule.value, weight: rule.weight, channel, level: typeof decided.cost?.level === "number" ? decided.cost.level : 0,
      timer, by, summary: `外部的人要求设的定时器：${rule.words}`,
    },
  })))();
}

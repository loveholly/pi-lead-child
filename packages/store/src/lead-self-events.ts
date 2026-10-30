// 关于 Lead 自己的事件（Lead 事件主干 spec D9，工单 14）：上下文压缩失败、模型换了。
//
// 以前 daemon 把这两件事放在内存队列 leadSelfNotes 里，在 Lead 的下一轮开头告诉它；daemon 重启就丢了。
// 现在各写一条事件（lead.compaction_failed、lead.model_switched），按 Lead 的事件游标交给它
// （daemon 的 lead-input.ts）：当前局面里「关于你自己」一节，这一轮成功以后才算交过；失败或重启从原位置重读。
// 级别不在这里定：按常设指令分诊（第一版是来源 lead 的默认指令 source.lead，record）。
//
// 写入点（daemon 的 compaction_end 回调、两轮之间换模型）不在数据库事务里，所以这里用一个短事务包住。
// 错误原文先截断再脱敏（redactAndCap），payload.note 是写给 Lead 的那句话。
import {
  LEAD_SELF_ENTITY_KEY, redactAndCap, type EventLevel, type RootCause,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, type EventRecord } from "./events.js";

const DETAIL_MAX = 2_000;

function safe(text: string): string {
  const capped = redactAndCap(text, DETAIL_MAX);
  return capped.truncated ? `${capped.text}…` : capped.text;
}

function record(db: Db, envelope: {
  kind: "lead.compaction_failed" | "lead.model_switched" | "lead.handed_back";
  payload: Record<string, unknown>;
  rootCause?: RootCause;
  at?: Date;
  level?: EventLevel;
}): EventRecord {
  return db.transaction(() => appendEvent(db, {
    source: "lead",
    kind: envelope.kind,
    entityKey: LEAD_SELF_ENTITY_KEY,
    ...(envelope.at ? { occurredAt: envelope.at.toISOString() } : {}),
    payload: envelope.payload,
    ...(envelope.rootCause ? { rootCause: envelope.rootCause } : {}),
    ...(envelope.level ? { level: envelope.level } : {}),
  }).event)();
}

export interface LeadCompactionFailure {
  // pi 给的压缩原因（threshold、overflow）。
  reason: string;
  // 失败的说明（daemon 的 compactionEndOutcome）。
  detail: string;
  timedOut: boolean;
  at?: Date;
}

/** Lead 的上下文压缩失败了：写一条 lead.compaction_failed。返回这条事件。 */
export function recordLeadCompactionFailed(db: Db, failure: LeadCompactionFailure): EventRecord {
  const detail = safe(failure.detail);
  return record(db, {
    kind: "lead.compaction_failed",
    payload: {
      reason: failure.reason,
      detail,
      timedOut: failure.timedOut,
      note: `你的上一次上下文压缩没有成功（${detail.replace(/。$/u, "")}）。上下文没有变小，接近上限时 pi 会再压缩一次。`,
    },
    rootCause: {
      code: failure.timedOut ? "lead_compaction_timeout" : "lead_compaction_failed",
      scope: "runtime",
      needs: "none",
      message: detail,
    },
    ...(failure.at ? { at: failure.at } : {}),
  });
}

export interface LeadModelSwitch {
  from: string;
  to: string;
  reason: string;
  // true：恢复时间到了，换回第一个模型。
  restored: boolean;
  // 服务端给的恢复时间（ISO）；没有时是 null。
  restoreAt: string | null;
  // 写给 Lead 的那句话（daemon 写：里面的时间按本地时区）。
  note: string;
  // 要告诉用户（2026-10-19：切换要告诉用户）。这时级别是 tell：作为一件事交给 Lead，Lead 不说时系统替它说。
  // 不给时级别按常设指令分诊（来源 lead 的缺省是 record，只写在当前局面「关于你自己」一节）。
  mustTell?: boolean;
  at?: Date;
}

/** Lead 的模型换了：写一条 lead.model_switched。返回这条事件。 */
export function recordLeadModelSwitched(db: Db, change: LeadModelSwitch): EventRecord {
  return record(db, {
    kind: "lead.model_switched",
    payload: {
      from: change.from,
      to: change.to,
      reason: safe(change.reason),
      restored: change.restored,
      restoreAt: change.restoreAt,
      note: safe(change.note),
      ...(change.mustTell ? { mustTell: true } : {}),
    },
    ...(change.at ? { at: change.at } : {}),
    ...(change.mustTell ? { level: "tell" as const } : {}),
  });
}

// Lead 把一件事交给用户自己去做（lead-tools-and-routing spec D14）。只记录（record），不交回给 Lead。
export type LeadHandbackCategory = "floor" | "presence" | "gap";

export function recordLeadHandback(db: Db, handback: {
  category: LeadHandbackCategory; what: string; reason?: string; turnId?: string | null; at?: Date;
}): EventRecord {
  return record(db, {
    kind: "lead.handed_back",
    payload: {
      category: handback.category,
      what: safe(handback.what),
      reason: safe(handback.reason ?? ""),
      turnId: handback.turnId ?? null,
    },
    level: "record",
    ...(handback.at ? { at: handback.at } : {}),
  });
}

/** 一段时间里推回给用户的次数，按类别。 */
export function leadHandbackCounts(db: Db, since: Date): Record<LeadHandbackCategory, number> {
  const rows = db.prepare(
    `SELECT json_extract(payload, '$.category') AS category, COUNT(*) AS n FROM events
     WHERE kind = 'lead.handed_back' AND occurred_at >= ? GROUP BY category`,
  ).all(since.toISOString()) as Array<{ category: LeadHandbackCategory; n: number }>;
  const counts: Record<LeadHandbackCategory, number> = { floor: 0, presence: 0, gap: 0 };
  for (const row of rows) if (row.category in counts) counts[row.category] = row.n;
  return counts;
}

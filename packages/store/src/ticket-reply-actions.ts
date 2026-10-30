// 工单 agent 回复下面的动作按钮（2026-10-19）。daemon 用 SmartModel 判断这段回复在等你决定要不要做哪几个动作，
// 结果记成一条事件（protocol 的 ticket_agent.reply_actions，record 级）。不加表、不加迁移：刷新和重连以后，
// GET /v1/conversation/turns?include=reply_actions 从这些事件里读回每一轮的动作。
//
// 事件写入时就记处置 handled_by_rule：它只给界面用，不交给 Lead，也不进影子分诊（只看没有处置的事件）。
import {
  isTicketReplyActionId, TICKET_REPLY_ACTIONS_KIND, ticketReplyActionsCorrelation, type TicketReplyActionId,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, itemEntityKey, setEventDisposition } from "./events.js";

export interface TicketReplyActionsInput {
  turnId: string;
  itemId: number;
  actions: readonly TicketReplyActionId[];
  // 回答这次判断的后端（jev、llm）。
  backend: string;
}

/** 记下一轮回复的动作。同一轮只记一次（source_ref 去重），重复调用返回已有的那一条。返回事件的 seq。 */
export function recordTicketReplyActions(db: Db, input: TicketReplyActionsInput): number {
  const actions = [...new Set(input.actions.filter(isTicketReplyActionId))];
  return db.transaction(() => {
    const { event, inserted } = appendEvent(db, {
      source: "ticket",
      sourceRef: `turn:${input.turnId}:reply_actions`,
      kind: TICKET_REPLY_ACTIONS_KIND,
      entityKey: itemEntityKey(db, input.itemId),
      correlationId: ticketReplyActionsCorrelation(input.turnId),
      level: "record",
      payload: { turnId: input.turnId, itemId: input.itemId, actions, backend: input.backend.slice(0, 80) || "unknown" },
    });
    if (inserted) setEventDisposition(db, event.seq, "handled_by_rule", { rule: "ticket_reply_actions" });
    return event.seq;
  })();
}

// SQLite 一条语句里的参数有上限。会话一页最多 500 轮，分批查。
const BATCH = 400;

/** 这些轮次的动作，按 turnId。没有判断过的轮次不在结果里。走 events_correlation 索引。 */
export function ticketReplyActionsByTurn(db: Db, turnIds: readonly string[]): Map<string, TicketReplyActionId[]> {
  const result = new Map<string, TicketReplyActionId[]>();
  const byCorrelation = new Map(turnIds.map((turnId) => [ticketReplyActionsCorrelation(turnId), turnId] as const));
  const keys = [...byCorrelation.keys()];
  for (let start = 0; start < keys.length; start += BATCH) {
    const batch = keys.slice(start, start + BATCH);
    const rows = db.prepare(
      `SELECT correlation_id, payload FROM events
       WHERE correlation_id IN (${batch.map(() => "?").join(", ")}) AND kind = ?
       ORDER BY seq`,
    ).all(...batch, TICKET_REPLY_ACTIONS_KIND) as Array<{ correlation_id: string; payload: string }>;
    for (const row of rows) {
      const turnId = byCorrelation.get(row.correlation_id);
      if (turnId === undefined) continue;
      let actions: unknown;
      try {
        actions = (JSON.parse(row.payload) as { actions?: unknown }).actions;
      } catch {
        continue;
      }
      if (!Array.isArray(actions)) continue;
      result.set(turnId, [...new Set(actions.filter(isTicketReplyActionId))]);
    }
  }
  return result;
}

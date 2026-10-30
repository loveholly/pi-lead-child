// ── 工单 #66 复核后的一次性数据更正（v35–v37）──────────────────────────────────
//
// 三处错误数据都是旧代码写下的，代码修好以后不会再产生。这里只更正已经存在的那几行：
//   v35：授权时顺带启动的返工补上授权编号，Lead 的返工额度从此只按授权编号数；
//   v36：删除不该写下的"成果缺失"记录（对话 Run 的、以及写下时已被新交付取代的）；
//   v37：补回被提前收口的工单对话回答。
//
// 每条迁移都按版本号只跑一次，只碰谓词精确命中的行，并给受影响的工单留一条 decision 活动。
// 它们都不改 items 的生命周期字段（stage、plan_state、closed_at）。
import type { Db } from "./db.js";
import { deliveryRunSql } from "./delivery-runs.js";

export const REWORK_GRANT_ATTRIBUTION_MIGRATION_VERSION = 35;
export const SPURIOUS_OUTCOME_RECORDS_MIGRATION_VERSION = 36;
export const TICKET_AGENT_TURN_TEXT_MIGRATION_VERSION = 37;

// 授权面板"授权并返工"写下的返工原因。v35 只认这一句，加上"发生在授权创建的那一刻"。
const GRANT_REWORK_REASON = "用户授权 Lead 自动返工并启动本次修复";

function applied(db: Db, version: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
}

function record(db: Db, version: number, name: string): void {
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(version, name);
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function audit(db: Db, itemId: number, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO activities (item_id, actor, kind, payload) VALUES (?, 'system', 'decision', ?)")
    .run(itemId, JSON.stringify(payload));
}

/**
 * v35：授权时顺带启动的返工属于那份授权。
 *
 * 用户确认（2026-10-13）手动返工不占 Lead 的返工额度。可两条路径以前写下的活动一模一样，
 * 运行时代码没法区分。新代码在授权路径上记下 delegationPolicyId；这里给旧数据补上：
 * 原因是授权面板的那一句，并且发生在授权创建前后 5 秒内。#66 的 activity 465 就是这一行。
 */
export function migrateReworkGrantAttribution(db: Db): void {
  if (applied(db, REWORK_GRANT_ATTRIBUTION_MIGRATION_VERSION)) return;
  db.transaction(() => {
    if (tableExists(db, "delegation_policies") && tableExists(db, "activities")) {
      const rows = db.prepare(
        `SELECT a.id AS activity_id, a.item_id, p.id AS policy_id
         FROM activities a
         JOIN delegation_policies p ON p.item_id = a.item_id
         WHERE a.kind = 'decision'
           AND json_extract(a.payload, '$.decision') = 'rework_dispatch_requested'
           AND json_type(a.payload, '$.delegationPolicyId') IS NULL
           AND json_extract(a.payload, '$.reason') = ?
           AND ABS(julianday(a.created_at) - julianday(p.created_at)) * 86400 <= 5
         ORDER BY a.id`,
      ).all(GRANT_REWORK_REASON) as Array<{ activity_id: number; item_id: number; policy_id: number }>;
      for (const row of rows) {
        db.prepare("UPDATE activities SET payload = json_set(payload, '$.delegationPolicyId', ?) WHERE id = ?")
          .run(row.policy_id, row.activity_id);
        audit(db, row.item_id, {
          decision: "rework_grant_attributed",
          activityId: row.activity_id,
          delegationPolicyId: row.policy_id,
          reason: "The rework started together with this delegation grant counts against its budget; manual reworks do not.",
        });
      }
    }
    record(db, REWORK_GRANT_ATTRIBUTION_MIGRATION_VERSION, "rework-grant-attribution-v1");
  })();
}

/**
 * v36：删除不该写下的"成果缺失"记录。
 *
 * 两种记录从一开始就不成立：
 *   · 对话 Run（或修复回合）的：它们不是交付，没有成果是常态（#66 的 #97、#99）；
 *   · 交付 Run 的，但写下的时候已经有更新的交付开跑了：那次缺失说明不了当时的状态
 *     （#66 的 #95：Run #48 的记录写于 Run #49 恢复成果 3 秒之后，还写着"reached review"）。
 * 一并删除它派生的对话卡片、通知活动、inbox blocker 和通知。工单现在停在 blocked 的不碰：
 * 那条记录可能正是它 blocked 的原因，留给用户处理，迁移不改生命周期。
 */
export function migrateSpuriousOutcomeRecords(db: Db): void {
  if (applied(db, SPURIOUS_OUTCOME_RECORDS_MIGRATION_VERSION)) return;
  db.transaction(() => {
    if (tableExists(db, "checkpoints") && tableExists(db, "runs") && tableExists(db, "items")) {
      const rows = db.prepare(
        `SELECT c.id AS checkpoint_id, c.item_id, c.run_id,
                CASE WHEN ${deliveryRunSql("r")} THEN 'superseded_delivery' ELSE 'not_a_delivery' END AS why
         FROM checkpoints c
         JOIN runs r ON r.id = c.run_id
         JOIN items i ON i.id = c.item_id
         WHERE c.idempotency_key = 'outcome-registration-missing:' || c.run_id
           AND i.stage <> 'blocked'
           AND (
             NOT ${deliveryRunSql("r")}
             OR EXISTS (
               SELECT 1 FROM runs later
               WHERE later.item_id = c.item_id AND later.id > r.id
                 AND ${deliveryRunSql("later")}
                 AND julianday(later.started_at) <= julianday(c.created_at)
             )
           )
         ORDER BY c.id`,
      ).all() as Array<{ checkpoint_id: number; item_id: number; run_id: number; why: string }>;
      for (const row of rows) {
        db.prepare("DELETE FROM conversation_cards WHERE checkpoint_id = ?").run(row.checkpoint_id);
        db.prepare(
          `DELETE FROM activities
           WHERE kind = 'notification' AND json_extract(payload, '$.checkpointId') = ?`,
        ).run(row.checkpoint_id);
        // 通知正文是给人看的文字，只按持久的去重键删。
        db.prepare("DELETE FROM notifications WHERE dedup_key IN (?, ?)")
          .run(`blocker:outcome-registration-missing:${row.run_id}`, `blocker:checkpoint:${row.checkpoint_id}`);
        db.prepare(
          `DELETE FROM inbox
           WHERE item_id = ?
             AND (
               (json_extract(payload, '$.blockerCode') = 'outcome_registration_missing'
                 AND json_extract(payload, '$.runId') = ?)
               OR json_extract(payload, '$.blockerKey') = ?
             )`,
        ).run(row.item_id, row.run_id, `checkpoint:${row.checkpoint_id}`);
        db.prepare("DELETE FROM checkpoints WHERE id = ?").run(row.checkpoint_id);
        audit(db, row.item_id, {
          decision: "spurious_outcome_record_removed",
          removedCheckpointId: row.checkpoint_id,
          runId: row.run_id,
          why: row.why,
          reason: row.why === "not_a_delivery"
            ? "A conversation or outcome-repair run is not a delivery; having no outcome is expected."
            : "A newer delivery had already started when this missing-outcome record was written.",
        });
      }
    }
    record(db, SPURIOUS_OUTCOME_RECORDS_MIGRATION_VERSION, "spurious-outcome-records-v1");
  })();
}

/**
 * v37：补回被提前收口的工单对话回答。
 *
 * 旧代码在对话 Run 的第一条助手消息就把这一轮收口；带工具的回答（先说"我去查"，最后才回答）
 * 只留下了第一句。#66 的第二轮就是这样丢了验收说明。runtime_events 里还留着每条助手消息，
 * 这里按同一个 Run 的消息顺序重建这一轮的文字。
 *
 * 一轮对话对应哪个 Run：发消息时写下的那条 comment 活动（同一工单、同一句话、route 以
 * ticket_agent 开头、10 秒以内）。只在恰好对上一个对话 Run、并且旧文字是新文字的开头时才改，
 * 别的情况一律不动。
 */
export function migrateTicketAgentTurnText(db: Db): void {
  if (applied(db, TICKET_AGENT_TURN_TEXT_MIGRATION_VERSION)) return;
  db.transaction(() => {
    if (tableExists(db, "channel_turns") && tableExists(db, "runtime_events") && tableExists(db, "activities")) {
      const turns = db.prepare(
        `SELECT id, item_id, user_text, assistant_text, created_at FROM channel_turns
         WHERE origin_kind LIKE '%:ticket-agent' AND state = 'completed' AND item_id IS NOT NULL
         ORDER BY created_at, id`,
      ).all() as Array<{ id: string; item_id: number; user_text: string; assistant_text: string; created_at: string }>;
      const runsFor = db.prepare(
        `SELECT DISTINCT a.run_id FROM activities a
         JOIN runs r ON r.id = a.run_id
         WHERE a.item_id = ? AND a.kind = 'comment' AND a.run_id IS NOT NULL
           AND r.purpose = 'conversation'
           AND json_extract(a.payload, '$.route') LIKE 'ticket_agent%'
           AND json_extract(a.payload, '$.content') = ?
           AND ABS(julianday(a.created_at) - julianday(?)) * 86400 <= 10`,
      );
      const messages = db.prepare(
        `SELECT json_extract(payload, '$.text') AS text FROM runtime_events
         WHERE run_id = ? AND event_type = 'message.completed'
           AND COALESCE(json_extract(payload, '$.role'), 'assistant') = 'assistant'
         ORDER BY seq`,
      );
      for (const turn of turns) {
        const matches = runsFor.all(turn.item_id, turn.user_text, turn.created_at) as Array<{ run_id: number }>;
        if (matches.length !== 1) continue;
        const runId = matches[0]!.run_id;
        const texts = (messages.all(runId) as Array<{ text: unknown }>)
          .map((row) => (typeof row.text === "string" ? row.text.trim() : ""))
          .filter(Boolean);
        const full = texts.join("\n\n");
        const current = turn.assistant_text.trim();
        if (!full || full === current || !full.startsWith(current)) continue;
        db.prepare("UPDATE channel_turns SET assistant_text = ? WHERE id = ?").run(full, turn.id);
        audit(db, turn.item_id, {
          decision: "ticket_agent_turn_text_restored",
          turnId: turn.id,
          runId,
          messageCount: texts.length,
          reason: "The turn was sealed at the first assistant message; the later messages of the same run were restored.",
        });
      }
    }
    record(db, TICKET_AGENT_TURN_TEXT_MIGRATION_VERSION, "ticket-agent-turn-text-v1");
  })();
}

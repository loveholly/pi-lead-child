import { randomUUID } from "node:crypto";
import { listConversationCards } from "./conversation-cards.js";
import type { Db } from "./db.js";
import type { ConversationCard } from "@pi-lead-child/core";
import {
  classifyLeadModelError, DAEMON_NOTICE_ORIGINS, isDaemonNoticeOrigin, isLeadRestartInterruption, isSystemTurnOrigin,
  MESSAGE_EVENT_VERSION, type EventDisposition, type MessageEvent, type RootCause,
} from "@pi-lead-child/protocol";
import { appendEventGuarded, clipEventText, itemEntityKey } from "./events.js";

export type ChannelTurnState = "queued" | "streaming" | "completed" | "failed" | "steered";

export const EMPTY_ASSISTANT_REPLY_ERROR = "Lead 未生成回复，请重试。";

export interface ChannelTurnRow {
  id: string;
  origin_binding_id: number | null;
  origin_kind: string;
  item_id: number | null;
  state: ChannelTurnState;
  user_text: string;
  assistant_text: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const isoNow = (now?: Date) => (now ?? new Date()).toISOString();

export function createTurn(
  db: Db,
  args: {
    id?: string;
    originBindingId?: number;
    originKind: string;
    itemId?: number;
    userText: string;
    state?: ChannelTurnState;
    now?: Date;
    // false：这条消息不是对 Lead 说的话（daemon 自己答的命令，例如 /fairyeye），不记 user.message 事件，
    // Lead 的等待不会因为它了结。会话里照样有这一轮。
    userMessageEvent?: boolean;
  },
): ChannelTurnRow {
  const id = args.id ?? `turn_${randomUUID()}`;
  const timestamp = isoNow(args.now);
  return db.transaction((): ChannelTurnRow => {
    db.prepare(
      `INSERT INTO channel_turns
        (id, origin_binding_id, origin_kind, item_id, state, user_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, args.originBindingId ?? null, args.originKind, args.itemId ?? null,
      args.state ?? "streaming", args.userText, timestamp, timestamp,
    );
    const turn = db.prepare("SELECT * FROM channel_turns WHERE id = ?").get(id) as ChannelTurnRow;
    // 双写（Lead 事件主干，工单 01）：用户的一条消息是一条 user.message 事件。系统回合没有用户消息，不记。
    // 事件出错不让这一轮的写入回滚（appendEventGuarded）。
    if (!isSystemTurnOrigin(turn.origin_kind) && args.userMessageEvent !== false) {
      appendEventGuarded(db, () => {
        const entityKey = turnEntityKey(db, turn);
        return {
          source: "user",
          sourceRef: userMessageRef(turn.id),
          kind: "user.message",
          entityKey,
          occurredAt: turn.created_at,
          payload: {
            turnId: turn.id, originKind: turn.origin_kind, itemId: turn.item_id, text: turn.user_text,
            message: userMessageEvent(turn, entityKey),
          },
        };
      });
    }
    return turn;
  })();
}

// ── 轮次的事件（Lead 事件主干 spec D1、D5，工单 01）──────────────────────────────
// 一轮结束（完成、失败、在等自动重试）记一条事件；用户的消息在这一轮有结局时记处置：
// 答完了是 handled（outcome done，插话被别的回合收下是 outcome steered），失败了是 no_action（outcome unanswered）。
// 谁在答这一轮：工单对话（:ticket-agent）是工单的 agent；daemon 自己写的通知不是任何人的回合，不记；其余是 Lead。

const userMessageRef = (turnId: string) => `turn:${turnId}`;

// 你本人的入口（统一消息事件 spec D1、D2，工单 03）：连上来的客户端。paired:<绑定的种类>[:…] 取绑定的种类，别的原样。
const USER_ENTRY_LABELS: Record<string, string> = {
  companion: "Companion", desktop: "桌面", cli: "plc", "aish-slack": "Slack 里的 Fairy", aish: "Slack 里的 Fairy",
  // Slack 里你发给自己的私信（用户 2026-10-30）：daemon 开的这一轮的 origin_kind 是 paired:slack。
  slack: "Slack 私信",
};

function userEntrySource(originKind: string): string {
  return /^paired:([^:]+)/u.exec(originKind)?.[1] ?? originKind;
}

/** 你本人的一句话的消息事件：和外部通道同一个结构，只做身份校验（配对的设备、已认证的连接），不分诊，没有外部标记和权限上限。 */
function userMessageEvent(turn: ChannelTurnRow, entityKey: string): MessageEvent {
  const source = userEntrySource(turn.origin_kind);
  return {
    version: MESSAGE_EVENT_VERSION, entry: "user", source, sourceLabel: USER_ENTRY_LABELS[source] ?? source,
    conversation: { key: entityKey, label: turn.item_id === null ? "和 Lead 的对话" : `工单 #${turn.item_id} 的对话` },
    sender: { id: turn.origin_binding_id === null ? "user" : `binding:${turn.origin_binding_id}`, name: "你", trust: "self" },
    text: turn.user_text, external: false, inbound: null, ceiling: null, context: null,
    replyTo: { conversation: entityKey, message: turn.id }, messages: [], edits: 0,
  };
}

function turnAnswerer(originKind: string): "lead" | "ticket_agent" | null {
  if (originKind.endsWith(":ticket-agent")) return "ticket_agent";
  if (isDaemonNoticeOrigin(originKind)) return null;
  return "lead";
}

function turnEntityKey(db: Db, turn: ChannelTurnRow): string {
  return turn.item_id === null ? "chat:main" : itemEntityKey(db, turn.item_id);
}

// 回合失败的根因：按 packages/protocol 的 lead-failure 分类（和顶栏、会话里的失败卡片同一套）。
function turnRootCause(answerer: "lead" | "ticket_agent", error: string): RootCause {
  const prefix = answerer === "lead" ? "lead" : "ticket_agent";
  const message = clipEventText(error);
  if (isLeadRestartInterruption(error)) {
    return { code: `${prefix}_restart_interrupted`, scope: "host", needs: "none", message };
  }
  if (error.trim() === EMPTY_ASSISTANT_REPLY_ERROR) return { code: `${prefix}_empty_reply`, scope: "attempt", needs: "none", message };
  const kind = classifyLeadModelError(error);
  const scope = {
    network: "host", unavailable: "runtime", busy: "runtime", auth: "account", config: "runtime", context: "runtime", unknown: "unknown",
  }[kind];
  const needs = kind === "auth" ? "login" : kind === "config" ? "config" : "none";
  return { code: `${prefix}_model_${kind}`, scope, needs, message };
}

function disposeUserMessage(db: Db, turn: ChannelTurnRow, disposition: EventDisposition | null, detail: Record<string, unknown> | null): void {
  if (isSystemTurnOrigin(turn.origin_kind)) return;
  db.prepare(
    "UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ? WHERE source = 'user' AND source_ref = ?",
  ).run(disposition, detail ? JSON.stringify(detail) : null, disposition ? turn.updated_at : null, userMessageRef(turn.id));
}

function recordTurnEnd(db: Db, turn: ChannelTurnRow, outcome: "completed" | "failed" | "waiting"): void {
  const answerer = turnAnswerer(turn.origin_kind);
  if (!answerer) return;
  const failed = outcome !== "completed";
  appendEventGuarded(db, () => ({
    source: answerer === "lead" ? "lead" : "ticket",
    sourceRef: `turn:${turn.id}:${outcome}:${turn.updated_at}`,
    kind: `${answerer}.turn_${failed ? "failed" : "completed"}`,
    entityKey: turnEntityKey(db, turn),
    occurredAt: turn.updated_at,
    payload: {
      turnId: turn.id, originKind: turn.origin_kind, itemId: turn.item_id,
      ...(failed ? { error: turn.error ?? "", willRetry: outcome === "waiting" } : {}),
    },
    ...(failed ? { rootCause: turnRootCause(answerer, turn.error ?? "") } : {}),
  }));
  if (outcome === "completed") disposeUserMessage(db, turn, "handled", { outcome: "done", turnId: turn.id });
  if (outcome === "failed") {
    disposeUserMessage(db, turn, "no_action", { outcome: "unanswered", reason: unansweredReason(turn.error ?? ""), error: turn.error ?? "" });
  }
}

// 用户的消息没有答上的原因（Lead 事件主干 spec D6，照 pi-durable 的 submission 结局，工单 04）：
// restart 被 daemon 重启打断；aborted 这一轮被中断、停止或暂停；其余是 model_error（模型报错、断网、没有回复）。
// stale（消息过时了不再答）现在没有来源：排队和插话的消息都会答到。
export type UnansweredReason = "aborted" | "stale" | "model_error" | "restart";

export function unansweredReason(error: string): UnansweredReason {
  if (isLeadRestartInterruption(error)) return "restart";
  if (/被中断|已停止|已暂停|aborted/iu.test(error)) return "aborted";
  return "model_error";
}

function turnRow(db: Db, id: string): ChannelTurnRow | undefined {
  return db.prepare("SELECT * FROM channel_turns WHERE id = ?").get(id) as ChannelTurnRow | undefined;
}

export function appendAssistantDelta(db: Db, id: string, delta: string, now?: Date): void {
  db.prepare(
    `UPDATE channel_turns
     SET assistant_text = assistant_text || ?, state = 'streaming', updated_at = ?
     WHERE id = ?`,
  ).run(delta, isoNow(now), id);
}

// 把一条已经结束的系统回合重新打开（清空文本和错误，回到 streaming）。daemon 重试同一件事时复用它：
// 例如同一条通知的播报失败后重试，会话流里只留一轮。
// 重新打开的这一轮是现在开始的，所以 created_at 也改成现在：它排到会话流的末尾。
// 只接受已经结束（completed 或 failed）的系统回合（origin_kind 以 system: 开头）。
// 用户的轮次和还在进行的轮次不动，返回 null；轮次不存在时也返回 null。
export function reopenTurn(db: Db, id: string, now?: Date): ChannelTurnRow | null {
  const at = isoNow(now);
  const result = db.prepare(
    `UPDATE channel_turns SET state = 'streaming', assistant_text = '', error = NULL, created_at = ?, updated_at = ?
     WHERE id = ? AND origin_kind LIKE 'system:%' AND state IN ('completed', 'failed')`,
  ).run(at, at, id);
  if (result.changes === 0) return null;
  return db.prepare("SELECT * FROM channel_turns WHERE id = ?").get(id) as ChannelTurnRow;
}

export function completeTurn(db: Db, id: string, now?: Date): void {
  setTurnState(db, id, "completed", null, now);
}

export function failTurn(db: Db, id: string, error: string, now?: Date): void {
  setTurnState(db, id, "failed", error, now);
}

// 用户的一轮因为断网或临时故障没答上，在等那一次自动重试（2026-10-16）：回到 queued，error 写着为什么在等。
// 只改还没结束的轮次。这一次尝试的失败记一条事件；用户的消息还没有结局。
export function waitTurnForRetry(db: Db, id: string, error: string, now?: Date): void {
  db.transaction(() => {
    const before = turnRow(db, id);
    const changed = db.prepare(
      "UPDATE channel_turns SET state = 'queued', error = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'streaming', 'steered')",
    ).run(error, isoNow(now), id).changes;
    // 已经在等重试的轮次再标一次，不是又一次失败。
    if (changed && before && !(before.state === "queued" && before.error !== null)) recordTurnEnd(db, turnRow(db, id)!, "waiting");
  })();
}

// 用户的那一轮开始自动重试：上一次说到一半的话和错误都不算了。只改在等重试的轮次（queued 并且带着错误）。
export function restartTurnForRetry(db: Db, id: string, now?: Date): ChannelTurnRow | null {
  const result = db.prepare(
    `UPDATE channel_turns SET state = 'streaming', assistant_text = '', error = NULL, updated_at = ?
     WHERE id = ? AND state = 'queued' AND error IS NOT NULL`,
  ).run(isoNow(now), id);
  if (result.changes === 0) return null;
  return db.prepare("SELECT * FROM channel_turns WHERE id = ?").get(id) as ChannelTurnRow;
}

// 工单对话 Run 被暂停时打断的是哪一轮（channel_turns 不记 Run）。恢复时只接回这一轮：按「工单上最新一条因暂停失败的轮次」
// 找会接错，例如同一张工单上有两个暂停的对话 Run，或者恢复的 Run 本来就没有轮次（发布评审 reliability-backlog）。
// 记在 kv 里，daemon 重启后也找得到。取出时删掉。
const pausedTurnKey = (runId: number) => `paused-ticket-turn:run:${runId}`;

export function rememberPausedTurn(db: Db, runId: number, turnId: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(pausedTurnKey(runId), turnId);
}

export function takePausedTurn(db: Db, runId: number): string | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(pausedTurnKey(runId)) as { value: string } | undefined;
    if (row) db.prepare("DELETE FROM kv WHERE key = ?").run(pausedTurnKey(runId));
    return row?.value ?? null;
  })();
}

// 暂停的工单对话 Run 恢复了：暂停时被记成失败的那一轮接着回答（发布评审 run-resume F4）。
// 和自动重试一样，说到一半的话不算了，恢复后的回答从头写进来。只改失败的轮次。
export function reopenPausedTurn(db: Db, id: string, now?: Date): ChannelTurnRow | null {
  return db.transaction((): ChannelTurnRow | null => {
    const result = db.prepare(
      `UPDATE channel_turns SET state = 'streaming', assistant_text = '', error = NULL, updated_at = ?
       WHERE id = ? AND state = 'failed'`,
    ).run(isoNow(now), id);
    if (result.changes === 0) return null;
    const turn = turnRow(db, id)!;
    // 用户的消息又在等回答了：失败时记的「没答上」不算了。
    disposeUserMessage(db, turn, null, null);
    return turn;
  })();
}

// 插话被受理（steer 返回）可能晚于那一轮结束。只改还没结束（queued、streaming）的轮次：
// 已经失败或完成的轮次保持原样，不会被改回 steered。在等自动重试的轮次（queued 并且带着错误）也不改：
// 改了它就找不到了，一直没有回答（发布评审 f796c1c 的 B2）。
export function markTurnSteered(db: Db, id: string, now?: Date): void {
  db.transaction(() => {
    const changed = db.prepare(
      `UPDATE channel_turns SET state = 'steered', error = NULL, updated_at = ?
       WHERE id = ? AND state IN ('queued', 'streaming') AND error IS NULL`,
    ).run(isoNow(now), id).changes;
    if (changed) disposeUserMessage(db, turnRow(db, id)!, "handled", { outcome: "steered", turnId: id });
  })();
}

// ── Lead 的输入放置（Lead 事件主干 spec D6，工单 04）──────────────────────────────
// 插话（steer）被 Lead 的会话收下了，还在路上：轮次停在 steered，用户的消息还没有结局。
// 结局在这一轮结束时才定：拿到了自己的回答（completed），和别的消息一起答了（settleTurnAnsweredWith），
// 或者没有答上（失败、等重启）。和 markTurnSteered 不同：那个函数用在已经有结局的轮次上（工单对话里被下一条接替）。
// 在等自动重试的轮次（queued 并且带着错误）也可以插进一轮正在跑的 Lead 回合：错误清掉，不再等重试。
export function markTurnInserted(db: Db, id: string, now?: Date): boolean {
  return db.prepare(
    `UPDATE channel_turns SET state = 'steered', error = NULL, updated_at = ?
     WHERE id = ? AND state IN ('queued', 'streaming')`,
  ).run(isoNow(now), id).changes > 0;
}

// 用户的一条消息没有自己的回答：Lead 把它和别的消息一起答了（工单 04 第 7 项：插话在 Lead 开口之前到达；
// 几条排队的消息一起放进同一轮）。结局是 done，不是失败；轮次停在 steered（和工单对话里被下一条接替的轮次同一个终态），
// 界面上它和 answeredWith 那一条显示为同一次回答。answeredWith 为空：插话送到了，Lead 在同一轮里看到了它，没有另外回答。
// 只改还没有结局的轮次。
export function settleTurnAnsweredWith(
  db: Db, id: string, args: { answeredWith: string | null; note: string; now?: Date },
): boolean {
  return db.transaction((): boolean => {
    const changed = db.prepare(
      `UPDATE channel_turns SET state = 'steered', error = NULL, updated_at = ?
       WHERE id = ? AND state IN ('queued', 'streaming', 'steered')`,
    ).run(isoNow(args.now), id).changes > 0;
    if (changed) {
      disposeUserMessage(db, turnRow(db, id)!, "handled", {
        outcome: "done", turnId: id, ...(args.answeredWith ? { answeredWith: args.answeredWith } : {}), note: args.note,
      });
    }
    return changed;
  })();
}

// 用户取消了一条排着的追问（Lead 忙时排队的消息，用户 2026-10-28）：它不再交给 Lead，Lead 不回答它。
// 用户的话照旧留在会话里（Lead 永远不能删掉用户说过的话）。轮次停在 steered：和「和别的消息一起回答」同一个终态，
// 界面不会把它当成失败，也不会当成还在等；重启时 listUnfinishedLeadTurns 也不再捡它（用户的消息已经有了结局）。
// 结局写在 user.message 的处置里：no_action，outcome cancelled，by 是谁取消的。会话快照据此给 placement=cancelled。
// 只改还没有结局的排队轮次（queued，或者赶不上插话、转为下一轮的 steered），没有错误的。
export function settleTurnCancelled(db: Db, id: string, args: { by: string; now?: Date }): boolean {
  return db.transaction((): boolean => {
    const changed = db.prepare(
      `UPDATE channel_turns SET state = 'steered', error = NULL, updated_at = ?
       WHERE id = ? AND state IN ('queued', 'steered') AND error IS NULL`,
    ).run(isoNow(args.now), id).changes > 0;
    if (changed) disposeUserMessage(db, turnRow(db, id)!, "no_action", { outcome: "cancelled", turnId: id, by: args.by });
    return changed;
  })();
}

// daemon 崩溃时还没有结局的 Lead 轮次（工单 04，spec 场景 8）：用户发给 Lead 的轮次（不是工单对话），
// 停在 streaming、queued 或 steered，没有错误（在等自动重试的轮次另有记录），用户的消息也还没有处置。
// 只看 since 之后建的（有界：更早的旧行不动），按建的先后，最多 limit 条。
export function listUnfinishedLeadTurns(db: Db, opts: { since: Date; limit?: number }): ChannelTurnRow[] {
  return db.prepare(
    `SELECT t.* FROM channel_turns t
     WHERE t.state IN ('streaming', 'queued', 'steered') AND t.error IS NULL
       AND t.origin_kind LIKE 'paired:%' AND t.origin_kind NOT LIKE '%:ticket%'
       AND t.created_at >= ?
       AND NOT EXISTS (
         SELECT 1 FROM events e WHERE e.source = 'user' AND e.source_ref = 'turn:' || t.id AND e.disposition IS NOT NULL
       )
     ORDER BY t.created_at, t.rowid LIMIT ?`,
  ).all(opts.since.toISOString(), opts.limit ?? 20) as ChannelTurnRow[];
}

// 这些轮次里用户的消息的结局（user.message 事件的处置说明），按轮次 id。还没有结局的不在里面。
export function userMessageOutcomes(db: Db, turnIds: readonly string[]): Map<string, Record<string, unknown>> {
  const outcomes = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < turnIds.length; start += 500) {
    const chunk = turnIds.slice(start, start + 500);
    if (!chunk.length) break;
    const rows = db.prepare(
      `SELECT source_ref, disposition_detail FROM events
       WHERE source = 'user' AND disposition IS NOT NULL AND source_ref IN (${chunk.map(() => "?").join(", ")})`,
    ).all(...chunk.map(userMessageRef)) as Array<{ source_ref: string; disposition_detail: string | null }>;
    for (const row of rows) {
      try {
        const detail: unknown = JSON.parse(row.disposition_detail ?? "{}");
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
          outcomes.set(row.source_ref.slice("turn:".length), detail as Record<string, unknown>);
        }
      } catch {
        // 读不懂的说明当作没有。
      }
    }
  }
  return outcomes;
}

// 等自动重试的那一轮，它的插话后来被另一轮正在跑的 Lead 回合收下了：回答出现在那一轮里，不再重试。
export function settleRetryAsSteered(db: Db, id: string, now?: Date): boolean {
  return db.transaction((): boolean => {
    const changed = db.prepare(
      "UPDATE channel_turns SET state = 'steered', error = NULL, updated_at = ? WHERE id = ? AND state = 'queued' AND error IS NOT NULL",
    ).run(isoNow(now), id).changes > 0;
    if (changed) disposeUserMessage(db, turnRow(db, id)!, "handled", { outcome: "steered", turnId: id });
    return changed;
  })();
}

// 排着队的工单消息（Run 不能中途接收消息时，2026-10-15）：按发来的先后。
export function listQueuedTicketTurns(db: Db, itemId: number): ChannelTurnRow[] {
  return db.prepare(
    `SELECT * FROM channel_turns
     WHERE item_id = ? AND state = 'queued' AND origin_kind LIKE '%:ticket-agent'
     ORDER BY created_at, rowid`,
  ).all(itemId) as ChannelTurnRow[];
}

// 排队的轮次转交出去了：回到 streaming。只改还在排队的轮次。
export function startQueuedTurn(db: Db, id: string, now?: Date): boolean {
  return db.prepare(
    "UPDATE channel_turns SET state = 'streaming', updated_at = ? WHERE id = ? AND state = 'queued'",
  ).run(isoNow(now), id).changes > 0;
}

// 旧的 repairEmptyCompletedTurns 不分来源，把 Lead 自己发起、只调了工具的回合也改成了「Lead 未生成回复」
// （2026-10-15 13:56 的重启改了 5 个）。按现在的规则它们是正常收尾：改回完成。
// 只动 system 来源、没有文字、错误正好是那一句的回合；模型报错等真正的失败不动。幂等，每次启动都跑。
export function restoreQuietSystemTurns(db: Db, now?: Date): number {
  return db.prepare(
    `UPDATE channel_turns
     SET state = 'completed', error = NULL, updated_at = ?
     WHERE state = 'failed' AND origin_kind LIKE 'system:%'
       AND trim(assistant_text) = '' AND error = ?`,
  ).run(isoNow(now), EMPTY_ASSISTANT_REPLY_ERROR).changes;
}

export function repairEmptyCompletedTurns(
  db: Db,
  error: string = EMPTY_ASSISTANT_REPLY_ERROR,
  now?: Date,
): number {
  // 和运行时（daemon 的 sealChannelTurn）用同一条规则：Lead 自己发起的一轮（system:*）没人在等回答，
  // 只调了工具也是正常收尾；画了定稿卡片（render_ui 的 lead.tool.updated 带 surface、不是 partial）的一轮已经回答了。
  return db.prepare(
    `UPDATE channel_turns
     SET state = 'failed', error = ?, updated_at = ?
     WHERE state = 'completed' AND trim(assistant_text) = ''
       AND origin_kind NOT LIKE 'system:%'
       AND NOT EXISTS (
         SELECT 1 FROM gateway_events g
         WHERE g.turn_id = channel_turns.id AND g.event_type = 'lead.tool.updated'
           AND json_valid(g.payload) AND json_type(g.payload, '$.surface') = 'object'
           AND coalesce(json_extract(g.payload, '$.partial'), 0) <> 1
       )`,
  ).run(error, isoNow(now)).changes;
}

function setTurnState(db: Db, id: string, state: "completed" | "failed", error: string | null, now?: Date): void {
  db.transaction(() => {
    const before = turnRow(db, id);
    db.prepare(
      "UPDATE channel_turns SET state = ?, error = ?, updated_at = ? WHERE id = ?",
    ).run(state, error, isoNow(now), id);
    // 双写：这一轮的结局变了才记（重复收口不记第二条）。
    if (before && before.state !== state) recordTurnEnd(db, turnRow(db, id)!, state);
  })();
}

// 最近的 limit 轮（缺省 100），按时间从旧到新排。超过上限时丢掉最老的：会话快照要的是最近的对话。
export function listTurns(
  db: Db,
  opts?: { itemId?: number; limit?: number },
): ChannelTurnRow[] {
  const where = opts?.itemId === undefined ? "" : " WHERE item_id = ?";
  const params: unknown[] = [
    ...(opts?.itemId === undefined ? [] : [opts.itemId]),
    opts?.limit ?? 100,
  ];
  return db.prepare(
    `SELECT * FROM (
       SELECT * FROM channel_turns${where} ORDER BY created_at DESC, id DESC LIMIT ?
     ) ORDER BY created_at, id`,
  ).all(...params) as ChannelTurnRow[];
}

// Lead 自己最近的 limit 轮，从新到旧（工单 03 的 read_lead_turns）。用户发给 Lead 的轮次和 Lead 自己发起的轮次
// （system:blocker、心跳巡检等）都算。不算的有三种，它们不是 Lead 的模型回合：
//   · 工单 agent 回答的工单对话（origin 以 :ticket-agent 结尾）；
//   · daemon 合成的工单回执（origin 以 :ticket 结尾，completeSyntheticChannelTurn）；
//   · daemon 自己写的通知（system:blocker-notice、system:fallback-notice、system:owner-action）。
export function listLeadTurns(db: Db, opts?: { limit?: number }): ChannelTurnRow[] {
  return db.prepare(
    `SELECT * FROM channel_turns
     WHERE origin_kind NOT LIKE '%:ticket-agent' AND origin_kind NOT LIKE '%:ticket'
       AND origin_kind NOT IN (${DAEMON_NOTICE_ORIGINS.map(() => "?").join(", ")})
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...DAEMON_NOTICE_ORIGINS, opts?.limit ?? 10) as ChannelTurnRow[];
}

export type ConversationFeedItem =
  | {
      id: string;
      stableKey: string;
      kind: "turn";
      createdAt: string;
      turn: ChannelTurnRow;
      cards: ConversationCard[];
    }
  | {
      id: string;
      stableKey: string;
      kind: "card";
      createdAt: string;
      card: ConversationCard;
    };

export function listConversationFeed(
  db: Db,
  opts?: { itemId?: number; limit?: number },
): ConversationFeedItem[] {
  const turns = listTurns(db, opts);
  const cards = listConversationCards(db, {
    ...(opts?.itemId === undefined ? {} : { itemIds: [opts.itemId] }),
    limit: Math.min(opts?.limit ?? 100, 200),
  });
  const attached = new Map<string, ConversationCard[]>();
  for (const card of cards) {
    if (!card.turnId) continue;
    const turnCards = attached.get(card.turnId) ?? [];
    turnCards.push(card);
    attached.set(card.turnId, turnCards);
  }

  const items: Array<ConversationFeedItem & { sourceRank: number }> = turns.map((turn) => ({
    id: `turn:${turn.id}`,
    stableKey: `turn:${turn.id}`,
    kind: "turn",
    createdAt: turn.created_at,
    turn,
    cards: (attached.get(turn.id) ?? []).sort((left, right) => left.id - right.id),
    sourceRank: 0,
  }));
  for (const card of cards) {
    if (card.turnId) continue;
    items.push({
      id: `card:${card.id}`,
      stableKey: `card:${card.id}`,
      kind: "card",
      createdAt: card.createdAt,
      card,
      sourceRank: 1,
    });
  }
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.sourceRank - right.sourceRank
    || left.stableKey.localeCompare(right.stableKey));
  return items.map(({ sourceRank: _sourceRank, ...item }) => item);
}

// 发件箱的一条消息开过的那一轮（chat_client_messages）。没有时返回 null。
export function findClientMessageTurn(
  db: Db,
  bindingId: number,
  clientMessageId: string,
): { turnId: string; mode: string } | null {
  const row = db.prepare(
    "SELECT turn_id, mode FROM chat_client_messages WHERE binding_id = ? AND client_message_id = ?",
  ).get(bindingId, clientMessageId) as { turn_id: string; mode: string } | undefined;
  return row ? { turnId: row.turn_id, mode: row.mode } : null;
}

// 记下发件箱的一条消息开的那一轮。同一个 id 已经记过时不改。
export function recordClientMessageTurn(
  db: Db,
  args: { bindingId: number; clientMessageId: string; turnId: string; mode: string; now?: Date },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO chat_client_messages (binding_id, client_message_id, turn_id, mode, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(args.bindingId, args.clientMessageId, args.turnId, args.mode, isoNow(args.now));
}

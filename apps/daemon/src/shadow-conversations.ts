// shadow 按对话复用会话（工单 #588）的 daemon 一侧：哪些外部消息可以交出去、交给 shadow 时这段对话的说明、配置版本、
// 自动记进工作记录的事。会话池和重开的规则在 lead 的 shadow/conversations.ts，账本在 store 的 shadow-conversations.ts。
//
// 一段对话（会话分组键，通道适配器给的）里的外部消息：
//   - 新消息进来以后等 quietMs（缺省 20 秒），看对方还有没有接着发，再一起交给 shadow；从第一条算起最多等 maxWaitMs。
//   - 这一组有批在跑时不交：跑完以后，这期间来的消息合成下一批。
//   - 交给 shadow 之前，用户在这条消息以后自己在来源里回过话：直接记成用户已自己处理（hub 的 resolveMessageByOwnReply）。
import { createHash } from "node:crypto";
import {
  leadExternalText, leadSystemEvent, renderShadowWorkRecord, SHADOW_OPENING, type LeadTurnOrigin, type ShadowRecorder,
} from "@pi-lead-child/lead";
import { messageSessionGroupOf, MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { loadPlcConfig } from "@pi-lead-child/core";
import { appendShadowWork, getChannelCard, listShadowWork, type Db, type EventRecord } from "@pi-lead-child/store";
import { shadowSessionKey } from "./shadow-routing.js";

/**
 * 一个按对话复用的会话这一批的记账（工单 #588）。会话的工具在建会话时绑上一次，按批换这里面的东西：这一批的记账、
 * 外部消息事件的编号、回合来历（读没读外部内容）。
 */
export interface ShadowBatchHolder {
  recorder: ShadowRecorder;
  messageIds: Set<number>;
  origin: LeadTurnOrigin;
}

/** 缺省等多久（秒）：2026-11-27 的统计，同一个人在同一段对话里隔 20 秒以内接着发的占 23%，发完附件 20 秒以内接着发的占 24%。 */
export const DEFAULT_SHADOW_MESSAGE_QUIET_SECONDS = 20;
/** 一直有人接着发时，从第一条算起最多等多久：不让连续聊天的对话一直等下去。 */
export const SHADOW_MESSAGE_MAX_WAIT_MS = 60_000;
/** 频道 thread 新开会话时带的前文：前 20 条，或者 thread 开始以前 2 小时内的，取少的。 */
export const SHADOW_PRELUDE_LIMIT = 20;
export const SHADOW_PRELUDE_WINDOW_MS = 2 * 3_600_000;

/**
 * 等多久（毫秒）。环境变量 PLC_SHADOW_MESSAGE_QUIET_MS 优先（测试用，每次现读），其次 config.json 的 lead.shadow.messageQuietSeconds，
 * 都没有时 20 秒。不合法时写一行日志，用缺省值。
 */
export function shadowMessageQuietMs(dataDir: string, log: (line: string) => void): number {
  const fromEnv = process.env.PLC_SHADOW_MESSAGE_QUIET_MS;
  if (fromEnv !== undefined && fromEnv !== "" && Number.isFinite(Number(fromEnv))) return Math.max(0, Number(fromEnv));
  let seconds: unknown;
  try {
    seconds = loadPlcConfig(dataDir).lead?.shadow?.messageQuietSeconds;
  } catch (error) {
    log(`reading lead.shadow.messageQuietSeconds failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (seconds === undefined) return DEFAULT_SHADOW_MESSAGE_QUIET_SECONDS * 1_000;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0 || value > 600) {
    log(`lead.shadow.messageQuietSeconds=${String(seconds)} is not 0–600 seconds; using the default`);
    return DEFAULT_SHADOW_MESSAGE_QUIET_SECONDS * 1_000;
  }
  return Math.round(value * 1_000);
}

/**
 * 留给 shadow 的外部消息，哪几组现在可以交出去（决策边界，纯函数）。按会话分组键分组，保持原来的顺序。
 * 一组可以交：这一组没有批在跑或排队（busy），而且最后一条到了 quietMs 以上，或者第一条到了 maxWaitMs 以上。
 * nextAt：还在等的组里最早什么时候可以交（没有在等的是 null）。
 */
export function readyShadowGroups(events: readonly EventRecord[], input: {
  now: number; quietMs: number; maxWaitMs?: number; busy: (key: string) => boolean;
}): { ready: Array<{ key: string; events: EventRecord[] }>; nextAt: number | null } {
  const groups = new Map<string, EventRecord[]>();
  for (const event of events) {
    const key = shadowSessionKey(event) ?? event.entityKey;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const maxWait = input.maxWaitMs ?? SHADOW_MESSAGE_MAX_WAIT_MS;
  const ready: Array<{ key: string; events: EventRecord[] }> = [];
  let nextAt: number | null = null;
  for (const [key, list] of groups) {
    if (input.busy(key)) continue;
    const arrived = list.map((event) => Date.parse(event.receivedAt)).filter(Number.isFinite);
    const first = arrived.length ? Math.min(...arrived) : input.now;
    const last = arrived.length ? Math.max(...arrived) : input.now;
    const at = Math.min(last + input.quietMs, first + Math.max(maxWait, input.quietMs));
    if (input.now >= at) ready.push({ key, events: list });
    else nextAt = nextAt === null ? at : Math.min(nextAt, at);
  }
  return { ready, nextAt };
}

/** 会话的配置版本：系统提示词（含常设指令、核心记忆、交接说明）、shadow 的模型、工具和固定的开头。变了就重开会话。 */
export function shadowConfigVersion(input: { systemPrompt: string; model: string; tools: readonly string[] }): string {
  return createHash("sha256").update(JSON.stringify({
    systemPrompt: input.systemPrompt, model: input.model, tools: [...input.tools].sort(), opening: SHADOW_OPENING,
  })).digest("hex").slice(0, 32);
}

const CARD_STATE_LABELS: Record<string, string> = {
  open: "还在等用户", snoozed: "稍后提醒", replying_self: "用户在来源里回过话", replied: "用户回复了", auto_replied: "替用户回复了",
  resolved_elsewhere: "用户已自己处理", dismissed: "用户选了不回", handled: "已处理", left_to_user: "留给用户",
};

/** 这一批每条消息来自哪里（私信主对话、私信里的哪个 thread），回复要落到哪里。 */
export function shadowMessageOrigins(events: readonly EventRecord[]): string | null {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind !== MESSAGE_EVENT_KIND) continue;
    const conversation = event.payload.conversation as { key?: unknown; label?: unknown } | undefined;
    const key = typeof conversation?.key === "string" ? conversation.key : event.entityKey;
    const label = typeof conversation?.label === "string" ? conversation.label : key;
    const thread = messageSessionGroupOf(event.payload.session)?.thread;
    const cardId = typeof event.payload.cardId === "number" ? `，卡 card_id=${event.payload.cardId}` : "";
    lines.push(`- #${event.seq}：${thread ? `${label}里的 thread ${thread}` : label}（conversation=${key}${cardId}）`);
  }
  if (!lines.length) return null;
  return leadSystemEvent("system", "这一批的消息各自来自哪里。回复、记处置、写草稿都用那条消息自己的 event 和 conversation，"
    + `落到它自己的卡和回复位置：\n${lines.join("\n")}`, { topic: "conversation_origins" });
}

/**
 * 复用会话时补给它的账本最新状态（工单 #588）：上一批以后，这段对话里以前的消息的卡变成了什么样，用户本人和系统替用户在来源里说过话没有。
 * since 是上一批交给 shadow 的时刻。before 是这一批最早的事件编号（这一批的消息不算「以前的」）。没有变化时是 null。
 */
export function shadowLedgerUpdate(db: Db, input: { key: string; since: string | null; before: number }): string | null {
  if (!input.since || !Number.isFinite(Date.parse(input.since))) return null;
  const rows = db.prepare(
    `SELECT seq, kind, source, entity_key AS entityKey, received_at AS at, payload FROM events
     WHERE seq < ? AND received_at >= ? AND json_valid(payload)
       AND (json_extract(payload, '$.session.key') = ?
         OR (kind = ? AND json_extract(payload, '$.conversation.key') = ?))
     ORDER BY seq DESC LIMIT 200`,
  ).all(input.before, new Date(Date.parse(input.since) - 86_400_000).toISOString(), input.key, MESSAGE_EVENT_KIND, input.key) as Array<{
    seq: number; kind: string; source: string; entityKey: string; at: string; payload: string;
  }>;
  const sinceMs = Date.parse(input.since);
  const cards = new Map<number, number>();
  const spoke: string[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (row.kind === MESSAGE_EVENT_KIND) {
      if (typeof payload.cardId === "number" && !cards.has(payload.cardId)) cards.set(payload.cardId, row.seq);
      continue;
    }
    if (Date.parse(row.at) < sinceMs) continue;
    if (payload.role === "self_reply") spoke.push(`- 用户本人在 ${row.entityKey} 说过话（${row.at.slice(11, 16)}）。`);
    else if (payload.role === "echo") spoke.push(`- 系统替用户在 ${row.entityKey} 发过一条（${row.at.slice(11, 16)}）。`);
  }
  const cardLines: string[] = [];
  for (const [cardId, seq] of cards) {
    const card = getChannelCard(db, cardId);
    if (!card) continue;
    const changed = Date.parse(card.updatedAt) >= sinceMs;
    if (!changed) continue;
    cardLines.push(`- 卡 card_id=${cardId}（消息事件 #${seq}）：现在是「${CARD_STATE_LABELS[card.state] ?? card.state}」。`);
  }
  const lines = [...cardLines, ...spoke.reverse()];
  if (!lines.length) return null;
  return leadSystemEvent("system", `上一批以后，账本里这段对话的变化（原话用 read_channel_conversation 看）：\n${lines.join("\n")}\n`
    + "已经结束的卡不要再回；用户自己回过的，不要重复回。", { topic: "conversation_update" });
}

/** 频道 thread 新开会话时带的前文（hub 的 historyBefore 读的，从旧到新）。 */
export function shadowPreludeBlock(input: {
  objectKey: string;
  messages: ReadonlyArray<{ at: string; sender: string; text: string; role: string; thread?: { replies: number } }>;
}): string | null {
  if (!input.messages.length) return null;
  const lines = input.messages.map((message) => {
    const replies = message.thread && message.thread.replies > 0 ? `（下面有 ${message.thread.replies} 条回复）` : "";
    const who = message.role === "me" ? "用户本人" : message.role === "assistant" ? "替用户发的" : message.sender;
    return `[${message.at.slice(11, 16)}] ${who}：${message.text.replace(/\s+/gu, " ").trim()}${replies}`;
  });
  const head = leadSystemEvent("system", `这个 thread 开始之前，主时间线上的 ${input.messages.length} 条消息（前文，只当上下文用；`
    + "别的 thread 的回复不带全文，只标条数）。", { topic: "thread_prelude" });
  return [head, leadExternalText({ source: "前文", sender: "频道里的人", part: "prelude", conversation: input.objectKey }, lines.join("\n"))].join("\n");
}

/**
 * 工具真的执行成功以后自动记进工作记录的事（回复和处置）：shadow 不用自己记。返回记了几条。
 */
export function recordShadowToolWork(db: Db, key: string, name: string, params: unknown, at: Date = new Date()): number {
  const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (name === "reply_to_source" && typeof args.event === "number") {
    const what = text || (args.refusal === true ? "（用固定的话拒绝）" : "");
    return appendShadowWork(db, key, [{ kind: "reply", text: `回复了消息事件 #${args.event}：${what}`, eventSeq: args.event }], at).length;
  }
  if (name === "send_channel_message" && text) {
    return appendShadowWork(db, key, [{ kind: "reply", text: `在 ${String(args.conversation ?? "")} 发了：${text}` }], at).length;
  }
  if (name === "record_disposition" && Array.isArray(args.event_ids) && typeof args.disposition === "string") {
    const ids = args.event_ids.filter((id): id is number => typeof id === "number");
    const draft = typeof args.draft === "string" && args.draft.trim() ? `；草稿：${args.draft.trim()}` : "";
    return appendShadowWork(db, key, ids.map((id) => ({
      kind: "reply" as const, text: `消息事件 #${id} 记成 ${args.disposition}${reason ? `：${reason}` : ""}${draft}`, eventSeq: id,
    })), at).length;
  }
  return 0;
}

/** 新开会话时放在这一批前面的工作记录（完整的）。没有记录时是 null。 */
export function shadowWorkRecordBlock(db: Db, key: string): string | null {
  return renderShadowWorkRecord(listShadowWork(db, key), { sessionKey: key, mode: "full", audience: "shadow" });
}

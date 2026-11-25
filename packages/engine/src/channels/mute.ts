// 外部对话的静音和熔断（工单 #533，protocol 的 channel-mutes.ts）。这里不出现任何具体来源的名字：只按对象键和事件算。
//   - muteConversation：开始静音（熔断、Lead、用户本人），记一条 channel_mute.started（digest 级，「Lead 动态」里一张卡）。
//   - unmuteConversation：提前取消，记一条 channel_mute.ended（同一张卡原地更新，按钮消失）。到点自动恢复不写事件。
//   - breakerCheck：Lead 记下一条消息事件的处置以后调用。同一个对话在窗口里交给 Lead 的消息事件够了次数、处置都是 no_action
//     （判断不用管）时熔断。只数上一次静音结束以后的消息事件：取消静音以后不会因为旧的那几次马上再熔断。
//     还没处置的、被并进新请求的（superseded）不算数：还没处置的出现时不熔断，等它有了处置再看。
// 静音的效果在通道 hub（hub.ts 的 record、recordOnly）：照常记事件、进道的上下文，不开卡、不叫醒 Lead、不调快模型。
// 调用方负责事务（写 kv 和事件要在同一个事务里）。
import { MESSAGE_EVENT_KIND, CHANNEL_MUTE_ENDED_KIND, CHANNEL_MUTE_STARTED_KIND, channelMuteEntityKey, type ChannelMuteBy } from "@pi-lead-child/protocol";
import {
  activeChannelMute, appendEvent, channelMuteEndedAt, channelMutePolicy, getChannelLane, getChannelMute, getLocale, leadDisplayName,
  putChannelMute, setEventDisposition, type ChannelMuteRecord, type Db,
} from "@pi-lead-child/store";
import { channelMuteMessages } from "./mute.messages.js";

const MINUTE = 60_000;
export const CHANNEL_MUTE_HARD_RULE = "channel_mute_reported";

/** 对话在界面上的名字：道的名字，没有道时是对象键。 */
export function conversationLabel(db: Db, objectKey: string): string {
  try {
    return getChannelLane(db, objectKey)?.label || objectKey;
  } catch {
    return objectKey;
  }
}

export interface MuteResult {
  record: ChannelMuteRecord;
  seq: number;
}

/**
 * 开始静音（或者把正在进行的静音换成这一次：从现在起算 minutes）。minutes 由调用方按参数校验过（Lead 的上限是 maxMuteMs）。
 * Lead 自己静音的事件写下时就记成看过了（它知道自己做了什么）；熔断和用户本人的留给 Lead 看：它要知道这个对话静音了。
 */
export function muteConversation(db: Db, input: {
  objectKey: string; minutes: number; by: ChannelMuteBy; reason: string; now: Date; wakes?: readonly number[];
}): MuteResult {
  const label = conversationLabel(db, input.objectKey);
  const until = new Date(input.now.getTime() + input.minutes * MINUTE).toISOString();
  const text = channelMuteMessages(getLocale(db));
  const lead = leadDisplayName(db);
  const params = channelMutePolicy(db).params;
  const summary = input.by === "breaker"
    ? text.breaker(label, lead, input.wakes?.length ?? params.breakerWakes, Math.round(params.breakerWindowMs / MINUTE), input.minutes)
    : input.by === "lead" ? text.byLead(lead, label, input.minutes, input.reason)
    : text.byUser(label, input.minutes);
  const { event } = appendEvent(db, {
    source: input.by === "lead" ? "lead" : "system",
    kind: CHANNEL_MUTE_STARTED_KIND,
    entityKey: channelMuteEntityKey(input.objectKey),
    occurredAt: input.now.toISOString(),
    level: "digest",
    payload: {
      conversation: input.objectKey, label, by: input.by, until, minutes: input.minutes, reason: input.reason,
      ...(input.wakes ? { wakes: [...input.wakes] } : {}), summary,
    },
  }, { basis: { order: channelMutePolicy(db).order, hardRules: [CHANNEL_MUTE_HARD_RULE] }, receivedAt: input.now });
  if (input.by === "lead") setEventDisposition(db, event.seq, "seen", null, input.now);
  const record: ChannelMuteRecord = {
    objectKey: input.objectKey, by: input.by, startedAt: input.now.toISOString(), until, reason: input.reason,
    startedSeq: event.seq, endedAt: null,
  };
  putChannelMute(db, record);
  return { record, seq: event.seq };
}

/** 提前取消静音。这个对话没在静音时什么也不做，返回 null。Lead 自己取消的记成看过了；用户取消的留给 Lead 看。 */
export function unmuteConversation(db: Db, input: {
  objectKey: string; by: "lead" | "user"; reason: string; now: Date;
}): MuteResult | null {
  const active = activeChannelMute(db, input.objectKey, input.now);
  if (!active) return null;
  const label = conversationLabel(db, input.objectKey);
  const text = channelMuteMessages(getLocale(db));
  const { event } = appendEvent(db, {
    source: input.by === "lead" ? "lead" : "system",
    kind: CHANNEL_MUTE_ENDED_KIND,
    entityKey: channelMuteEntityKey(input.objectKey),
    occurredAt: input.now.toISOString(),
    level: "digest",
    payload: {
      conversation: input.objectKey, label, by: input.by, startedSeq: active.startedSeq, reason: input.reason,
      summary: text.ended(input.by === "lead" ? leadDisplayName(db) : text.you, label),
    },
  }, { basis: { order: channelMutePolicy(db).order, hardRules: [CHANNEL_MUTE_HARD_RULE] }, receivedAt: input.now });
  if (input.by === "lead") setEventDisposition(db, event.seq, "seen", null, input.now);
  // 熔断那一次（started）留给 Lead 看的：用户取消以后它就不用再处理了。
  setEventDisposition(db, active.startedSeq, "seen", null, input.now);
  const record = { ...active, endedAt: input.now.toISOString() };
  putChannelMute(db, record);
  return { record, seq: event.seq };
}

/**
 * 熔断：同一个对话在窗口里交给 Lead 的消息事件够了次数、处置都是 no_action 时静音它。熔断了返回这次静音，否则 null。
 * 已经在静音的不再熔断。
 */
export function breakerCheck(db: Db, objectKey: string, now: Date): MuteResult | null {
  const previous = getChannelMute(db, objectKey);
  if (activeChannelMute(db, objectKey, now)) return null;
  const { params } = channelMutePolicy(db);
  const windowStart = now.getTime() - params.breakerWindowMs;
  const ended = previous ? channelMuteEndedAt(previous, now) : null;
  const since = new Date(Math.max(windowStart, ended ? Date.parse(ended) : 0)).toISOString();
  const rows = db.prepare(
    `SELECT seq, disposition FROM events
     WHERE source = 'system' AND kind = ? AND entity_key = ? AND occurred_at > ?
       AND (disposition IS NULL OR disposition <> 'superseded')
     ORDER BY seq`,
  ).all(MESSAGE_EVENT_KIND, objectKey, since) as Array<{ seq: number; disposition: string | null }>;
  if (rows.length < params.breakerWakes || rows.some((row) => row.disposition !== "no_action")) return null;
  return muteConversation(db, {
    objectKey, minutes: Math.max(1, Math.round(params.breakerMuteMs / MINUTE)), by: "breaker",
    reason: "breaker", now, wakes: rows.map((row) => row.seq),
  });
}

// 外部对话的静音（工单 #533，protocol 的 channel-mutes.ts）。一个对话一行 kv（channel.mute.<对象键>，JSON）：
// 静到什么时候、谁静的、哪一条 channel_mute.started。提前取消时记下 endedAt，行留着：熔断只数上一次静音结束以后的叫醒，
// 用户点了取消静音，紧接着的一次不用管不会马上再熔断。到点自动恢复不用写什么：读的时候比时间。
// 熔断和静音的参数在常设指令 channel.mute 里，读不到时用 CHANNEL_MUTE_DEFAULTS（依据记成第 0 版）。
import {
  CHANNEL_MUTE_BY, CHANNEL_MUTE_DEFAULTS, validStandingOrderRuleParams,
  type ChannelMuteBy, type ChannelMuteParams, type StandingOrderRef,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { activeStandingOrders, standingOrderRef } from "./standing-orders.js";

export const CHANNEL_MUTE_ORDER_ID = "channel.mute";
const PREFIX = "channel.mute.";
const keyOf = (objectKey: string) => `${PREFIX}${objectKey}`;

export interface ChannelMuteRecord {
  objectKey: string;
  by: ChannelMuteBy;
  startedAt: string;
  until: string;
  reason: string;
  // 开始静音的那条 channel_mute.started。
  startedSeq: number;
  // 提前取消的时刻。没有取消时是 null。
  endedAt: string | null;
}

/** 熔断和静音的参数（常设指令 channel.mute）。读不到、参数不合格时用缺省值，依据记成第 0 版。 */
export function channelMutePolicy(db: Db): { params: ChannelMuteParams; order: StandingOrderRef } {
  try {
    const order = activeStandingOrders(db).find((candidate) => candidate.id === CHANNEL_MUTE_ORDER_ID
      && candidate.action.type === "rule" && candidate.action.rule === "channel.mute"
      && validStandingOrderRuleParams("channel.mute", candidate.action.params));
    if (order && order.action.type === "rule") {
      return { params: order.action.params as unknown as ChannelMuteParams, order: standingOrderRef(order) };
    }
  } catch {
    // 读不了常设指令时照样有熔断：用缺省值。
  }
  return { params: CHANNEL_MUTE_DEFAULTS, order: { id: CHANNEL_MUTE_ORDER_ID, version: 0 } };
}

function parse(objectKey: string, raw: string): ChannelMuteRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ChannelMuteRecord>;
    if (typeof value.until !== "string" || typeof value.startedAt !== "string" || typeof value.startedSeq !== "number") return null;
    if (!(CHANNEL_MUTE_BY as readonly unknown[]).includes(value.by)) return null;
    return {
      objectKey, by: value.by as ChannelMuteBy, startedAt: value.startedAt, until: value.until,
      reason: typeof value.reason === "string" ? value.reason : "", startedSeq: value.startedSeq,
      endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
    };
  } catch {
    return null;
  }
}

/** 这个对话最近一次静音（不论是否还在静音）。没有时是 null。 */
export function getChannelMute(db: Db, objectKey: string): ChannelMuteRecord | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(keyOf(objectKey)) as { value: string } | undefined;
  return row ? parse(objectKey, row.value) : null;
}

/** 这次静音这时候还在不在：没有提前取消，也还没到点。 */
export function channelMuteActive(record: ChannelMuteRecord | null, now: Date): record is ChannelMuteRecord {
  return record !== null && record.endedAt === null && Date.parse(record.until) > now.getTime();
}

/** 这个对话现在在静音时，那一次静音；不在静音时是 null。 */
export function activeChannelMute(db: Db, objectKey: string, now: Date): ChannelMuteRecord | null {
  const record = getChannelMute(db, objectKey);
  return channelMuteActive(record, now) ? record : null;
}

/** 这次静音在什么时刻结束了（提前取消的时刻，或者到点的时刻）；还在静音时是 null。 */
export function channelMuteEndedAt(record: ChannelMuteRecord, now: Date): string | null {
  if (record.endedAt !== null) return record.endedAt;
  return Date.parse(record.until) <= now.getTime() ? record.until : null;
}

/** 记下一次静音（覆盖这个对话以前的那一行）。 */
export function putChannelMute(db: Db, record: ChannelMuteRecord): void {
  const { objectKey, ...value } = record;
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(keyOf(objectKey), JSON.stringify(value));
}

/** 现在还在静音的对话，按结束时间从早到晚。 */
export function listActiveChannelMutes(db: Db, now: Date): ChannelMuteRecord[] {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\'")
    .all(`${PREFIX.replace(/[%_\\]/g, (char) => `\\${char}`)}%`) as Array<{ key: string; value: string }>;
  return rows.map((row) => parse(row.key.slice(PREFIX.length), row.value))
    .filter((record): record is ChannelMuteRecord => channelMuteActive(record, now))
    .sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
}

// 通道的分道和会话卡（Lead 事件主干 spec D10、D14，工单 11）。表在 schema.ts 的 CHANNELS_SCHEMA（v46）。
//
// 这里只存取状态，不做决定：什么时候开卡、怎样投递、闸门怎么判、什么时候发出去，都在 engine 的通道 hub。
// 审计不在这里：闸门的判断、出站动作、自动回复、撤回、用户的动作都写成事件（packages/protocol 的 channels.ts）。
// 这个文件有四部分：分道；会话卡；按来源读常设指令（投递和代你行动）；影子模式按类别的一致率。
// 这里不出现任何具体来源的名字。
import {
  CHANNEL_AUTO_REPLY_DEFAULT, CHANNEL_CARD_OPEN_STATES, CHANNEL_CONFIDENCE_DEFAULTS, CHANNEL_INTENT_PERMISSION_RANK, CHANNEL_INTENTS,
  isDelegationCategory, isSenderTrust, validStandingOrderRuleParams,
  type ChannelAuthorityTable, type ChannelCardState, type ChannelConfidenceParams, type ChannelPolicyParams, type ChannelDeliveryMode, type ChannelIntent, type ChannelIntentAuthority,
  type DelegationCategory, type SenderTrust, type StandingOrder,
  type StandingOrderCondition, type StandingOrderRef,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { activeStandingOrders, listStandingOrderVersions, standingOrderRef } from "./standing-orders.js";

// ── 分道 ────────────────────────────────────────────────────────────────────────────

/** 一条道里的一条消息。them：对方说的；me：用户自己在来源里说的；assistant：系统替用户发的。 */
export interface ChannelLaneMessage {
  at: string;
  seq: number | null;
  role: "them" | "me" | "assistant";
  sender: string;
  text: string;
  // 起点：这条道回复的那条消息（例如 thread 的根消息）和它之前的几条。总在上下文最前面，截断时不删。
  origin?: boolean;
  // 这条消息在来源里的编号（ChannelInbound.messageId）。取历史补进来的消息靠它去重。
  ref?: string;
}

export interface ChannelLane {
  id: number;
  source: string;
  objectKey: string;
  label: string;
  context: ChannelLaneMessage[];
  summary: string;
  lastSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 一条道最多留几条消息（起草器读的上下文）。 */
export const CHANNEL_LANE_CONTEXT_LIMIT = 20;
/** 道里每条消息最多留多少字。 */
export const CHANNEL_LANE_TEXT_MAX = 1_000;

interface LaneRow {
  id: number; source: string; object_key: string; label: string; context: string; summary: string;
  last_seq: number | null; created_at: string; updated_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseLane(row: LaneRow): ChannelLane {
  return {
    id: row.id, source: row.source, objectKey: row.object_key, label: row.label,
    context: parseJson<ChannelLaneMessage[]>(row.context, []), summary: row.summary, lastSeq: row.last_seq,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function getChannelLane(db: Db, objectKey: string): ChannelLane | undefined {
  const row = db.prepare("SELECT * FROM channel_lanes WHERE object_key = ?").get(objectKey) as LaneRow | undefined;
  return row ? parseLane(row) : undefined;
}

export function getChannelLaneById(db: Db, id: number): ChannelLane | undefined {
  const row = db.prepare("SELECT * FROM channel_lanes WHERE id = ?").get(id) as LaneRow | undefined;
  return row ? parseLane(row) : undefined;
}

/**
 * 记一条消息进道里（没有这条道时新建）。上下文只留最近 CHANNEL_LANE_CONTEXT_LIMIT 条。
 * label 只在新建时用：同一个对话的名字不随消息变。
 */
export function recordChannelLaneMessage(
  db: Db, input: { source: string; objectKey: string; label: string; message: ChannelLaneMessage; at?: Date },
): ChannelLane {
  const at = (input.at ?? new Date()).toISOString();
  const existing = getChannelLane(db, input.objectKey);
  const message = { ...input.message, text: clip(input.message.text, CHANNEL_LANE_TEXT_MAX) };
  if (!existing) {
    db.prepare(
      `INSERT INTO channel_lanes (source, object_key, label, context, summary, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
    ).run(input.source, input.objectKey, input.label, JSON.stringify([message]), message.seq, at, at);
    return getChannelLane(db, input.objectKey)!;
  }
  const context = trimContext([...existing.context, message]);
  db.prepare("UPDATE channel_lanes SET context = ?, last_seq = COALESCE(?, last_seq), updated_at = ? WHERE id = ?")
    .run(JSON.stringify(context), message.seq, at, existing.id);
  return getChannelLane(db, input.objectKey)!;
}

/**
 * 这个对话的道，没有时新建一条空的（没有消息）。Lead 往一个还没收过消息的对话发话、要先放草稿等你看时用
 * （engine 的 hub，外部的一轮里的出站检验，spec D9、D16）。label 只在新建时用。
 */
export function ensureChannelLane(db: Db, input: { source: string; objectKey: string; label: string; at?: Date }): ChannelLane {
  const existing = getChannelLane(db, input.objectKey);
  if (existing) return existing;
  const at = (input.at ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO channel_lanes (source, object_key, label, context, summary, last_seq, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '', NULL, ?, ?)`,
  ).run(input.source, input.objectKey, input.label, at, at);
  return getChannelLane(db, input.objectKey)!;
}

/** 道里的起点最多几条。 */
export const CHANNEL_LANE_ORIGIN_LIMIT = 8;

// 起点在前、不删；别的消息只留最近的，一共不超过 CHANNEL_LANE_CONTEXT_LIMIT 条。
function trimContext(messages: readonly ChannelLaneMessage[]): ChannelLaneMessage[] {
  const origin = messages.filter((message) => message.origin).slice(0, CHANNEL_LANE_ORIGIN_LIMIT);
  const rest = messages.filter((message) => !message.origin);
  return [...origin, ...rest.slice(-(CHANNEL_LANE_CONTEXT_LIMIT - origin.length))];
}

/**
 * 给一条道放上起点：它回复的那条消息和之前的几条（从旧到新）。已经在道里的同一条消息（按 seq 或 ref 认）改标成起点，
 * 不重复放。道不存在时什么也不做，返回 undefined。
 */
export function setChannelLaneOrigin(db: Db, objectKey: string, messages: readonly ChannelLaneMessage[], at: Date = new Date()): ChannelLane | undefined {
  const existing = getChannelLane(db, objectKey);
  if (!existing) return undefined;
  const same = (a: ChannelLaneMessage, b: ChannelLaneMessage) => (a.seq !== null && a.seq === b.seq) || (a.ref !== undefined && a.ref === b.ref);
  const origin = messages.slice(-CHANNEL_LANE_ORIGIN_LIMIT).map((message) => ({ ...message, text: clip(message.text, CHANNEL_LANE_TEXT_MAX), origin: true }));
  const rest = existing.context.filter((message) => !message.origin && !origin.some((candidate) => same(candidate, message)));
  const context = trimContext([...origin, ...rest]);
  db.prepare("UPDATE channel_lanes SET context = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(context), at.toISOString(), existing.id);
  return getChannelLane(db, objectKey)!;
}

/** 改一条道的一行摘要（Lead 的当前局面里只放它）。 */
export function setChannelLaneSummary(db: Db, objectKey: string, summary: string, at: Date = new Date()): void {
  db.prepare("UPDATE channel_lanes SET summary = ?, updated_at = ? WHERE object_key = ?")
    .run(clip(summary.replace(/\s+/g, " ").trim(), 200), at.toISOString(), objectKey);
}

/** 这些对象键里，哪些是道，各自的一行摘要。不是道的键不在结果里。 */
export function channelLaneSummaries(db: Db, objectKeys: readonly string[]): Map<string, ChannelLane> {
  const result = new Map<string, ChannelLane>();
  for (const key of new Set(objectKeys)) {
    const lane = getChannelLane(db, key);
    if (lane) result.set(key, lane);
  }
  return result;
}

/** 有没结束的卡的道，最近更新的在前。给了 source 时只看这个来源的。 */
export function listOpenChannelLanes(db: Db, limit = 20, source?: string): ChannelLane[] {
  const states = CHANNEL_CARD_OPEN_STATES.map(() => "?").join(", ");
  return (db.prepare(
    `SELECT l.* FROM channel_lanes l
     WHERE EXISTS (SELECT 1 FROM channel_cards c WHERE c.lane_id = l.id AND c.state IN (${states}))
       AND (? IS NULL OR l.source = ?)
     ORDER BY l.updated_at DESC LIMIT ?`,
  ).all(...CHANNEL_CARD_OPEN_STATES, source ?? null, source ?? null, limit) as LaneRow[]).map(parseLane);
}

/** 最近有动静的道（有没有卡都算），最近更新的在前。给了 source 时只看这个来源的。 */
export function listRecentChannelLanes(db: Db, limit = 20, source?: string): ChannelLane[] {
  return (db.prepare(
    "SELECT * FROM channel_lanes WHERE (? IS NULL OR source = ?) ORDER BY updated_at DESC, id DESC LIMIT ?",
  ).all(source ?? null, source ?? null, limit) as LaneRow[]).map(parseLane);
}

/** 对象键以 prefix 开头的道里，有没有 since 以后更新过的（例如「这个频道下最近有没有用户在场的对话」）。 */
export function hasRecentChannelLane(db: Db, prefix: string, since: Date): boolean {
  const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return db.prepare("SELECT 1 FROM channel_lanes WHERE object_key LIKE ? ESCAPE '\\' AND updated_at >= ? LIMIT 1")
    .get(pattern, since.toISOString()) !== undefined;
}

// ── 会话卡 ──────────────────────────────────────────────────────────────────────────

export interface ChannelCardSender { id: string; name: string; trust: SenderTrust }

/** 起草的回复。templateId 不为空时，文字是这个来源白名单模板按 slots 填出来的（自动回复只能用这种）。 */
export interface ChannelCardDraft {
  text: string;
  drafter: string;
  templateId: string | null;
  slots: Record<string, string>;
  at: string;
  // 起草时这张卡的最后一个事件。卡又来了新消息时，草稿要重新起。
  forSeq: number;
}

export interface ChannelGateCheck { condition: string; pass: boolean; detail: string }

/** 闸门对这张卡最近一次的判断。pending：还在等分类（Jev 的影子判断）。 */
export interface ChannelCardGate {
  decision: "pending" | "shadow" | "denied" | "auto_send";
  category: DelegationCategory | null;
  failed: string[];
  checks: ChannelGateCheck[];
  order: StandingOrderRef | null;
  // 判断的是哪个事件（卡的 last_seq）。
  forSeq: number;
  at: string;
}

/**
 * 要发或者发出去的回复。by：user 是用户点了「用草稿回复」，auto 是系统按常设指令自动回复。
 * status：pending 正在发（或者上一次失败了，nextAttemptAt 再用同一个幂等键发）；sent 发出去了；
 * failed 试满了次数，放弃了；retracted 自动回复在撤回窗口里撤回了。
 */
export interface ChannelCardSent {
  by: "user" | "auto";
  // 出站动作的幂等键。
  key: string;
  text: string;
  // 署名和正文分开（hub 的 disclosure.ts）：重试时照样交给适配器排版。没有署名的回复（用户自己改的话）和旧数据没有这一项。
  parts?: { byline: string; body: string | null } | null;
  // 发的就是草稿，一个字没改。
  fromDraft: boolean;
  status: "pending" | "sent" | "failed" | "retracted";
  // 改写的那条状态消息（「正在处理」，用回复覆盖它，落地计划 A3）。另发一条的回复没有这一项；改写失败以后清成 null。
  replaces?: Record<string, string> | null;
  remoteRef: Record<string, string>;
  at: string;
  failures: number;
  nextAttemptAt: string | null;
  error: string | null;
}

export interface ChannelCardResolution {
  by: string;
  action: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface ChannelCard {
  id: number;
  laneId: number;
  source: string;
  objectKey: string;
  version: number;
  state: ChannelCardState;
  delivery: ChannelDeliveryMode;
  firstSeq: number;
  lastSeq: number;
  messageCount: number;
  sender: ChannelCardSender;
  excerpt: string;
  replyTarget: Record<string, string>;
  draft: ChannelCardDraft | null;
  gate: ChannelCardGate | null;
  sent: ChannelCardSent | null;
  snoozedUntil: string | null;
  revokeUntil: string | null;
  resolvedAt: string | null;
  resolution: ChannelCardResolution | null;
  createdAt: string;
  updatedAt: string;
}

interface CardRow {
  id: number; lane_id: number; source: string; object_key: string; version: number; state: string; delivery: string;
  first_seq: number; last_seq: number; message_count: number; sender: string; excerpt: string; reply_target: string;
  draft: string | null; gate: string | null; sent: string | null; snoozed_until: string | null; revoke_until: string | null;
  resolved_at: string | null; resolution: string | null; created_at: string; updated_at: string;
}

function parseCard(row: CardRow): ChannelCard {
  const sender = parseJson<Partial<ChannelCardSender>>(row.sender, {});
  return {
    id: row.id, laneId: row.lane_id, source: row.source, objectKey: row.object_key, version: row.version,
    state: row.state as ChannelCardState, delivery: row.delivery as ChannelDeliveryMode,
    firstSeq: row.first_seq, lastSeq: row.last_seq, messageCount: row.message_count,
    sender: {
      id: String(sender.id ?? ""), name: String(sender.name ?? ""), trust: isSenderTrust(sender.trust) ? sender.trust : "unknown",
    },
    excerpt: row.excerpt,
    replyTarget: parseJson<Record<string, string>>(row.reply_target, {}),
    draft: parseJson<ChannelCardDraft | null>(row.draft, null),
    gate: parseJson<ChannelCardGate | null>(row.gate, null),
    sent: parseJson<ChannelCardSent | null>(row.sent, null),
    snoozedUntil: row.snoozed_until, revokeUntil: row.revoke_until, resolvedAt: row.resolved_at,
    resolution: parseJson<ChannelCardResolution | null>(row.resolution, null),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getChannelCard(db: Db, id: number): ChannelCard | undefined {
  const row = db.prepare("SELECT * FROM channel_cards WHERE id = ?").get(id) as CardRow | undefined;
  return row ? parseCard(row) : undefined;
}

/** 这个对话没结束的卡（最多一张）。 */
export function getOpenChannelCard(db: Db, objectKey: string): ChannelCard | undefined {
  const states = CHANNEL_CARD_OPEN_STATES.map(() => "?").join(", ");
  const row = db.prepare(`SELECT * FROM channel_cards WHERE object_key = ? AND state IN (${states})`)
    .get(objectKey, ...CHANNEL_CARD_OPEN_STATES) as CardRow | undefined;
  return row ? parseCard(row) : undefined;
}

/** 这个对话最新的一张卡（结束了的也算）。 */
export function getLatestChannelCard(db: Db, objectKey: string): ChannelCard | undefined {
  const row = db.prepare("SELECT * FROM channel_cards WHERE object_key = ? ORDER BY id DESC LIMIT 1").get(objectKey) as CardRow | undefined;
  return row ? parseCard(row) : undefined;
}

export interface NewChannelCard {
  laneId: number;
  source: string;
  objectKey: string;
  delivery: ChannelDeliveryMode;
  seq: number;
  sender: ChannelCardSender;
  excerpt: string;
  replyTarget: Record<string, string>;
  at?: Date;
}

/**
 * 开一张新卡（open）。这个对话已经有没结束的卡时，部分唯一索引会让它失败：调用方先用 getOpenChannelCard。
 * 新卡没有闸门的结论（模板代回闸门 2026-10-22 退役，授权表的决定记在 channel.authority.decided 事件里）。
 */
export function openChannelCard(db: Db, input: NewChannelCard): ChannelCard {
  const at = (input.at ?? new Date()).toISOString();
  const id = Number(db.prepare(
    `INSERT INTO channel_cards (
       lane_id, source, object_key, version, state, delivery, first_seq, last_seq, message_count, sender, excerpt,
       reply_target, gate, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 'open', ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.laneId, input.source, input.objectKey, input.delivery, input.seq, input.seq, JSON.stringify(input.sender),
    input.excerpt, JSON.stringify(input.replyTarget), at, at,
  ).lastInsertRowid);
  return getChannelCard(db, id)!;
}

export interface ChannelCardPatch {
  state?: ChannelCardState;
  delivery?: ChannelDeliveryMode;
  // 只往前挪：同一个对话里先到的消息，判断要不要回比后到的晚（engine 的 hub，settlePendingCard）。
  firstSeq?: number;
  lastSeq?: number;
  messageCount?: number;
  sender?: ChannelCardSender;
  excerpt?: string;
  replyTarget?: Record<string, string>;
  draft?: ChannelCardDraft | null;
  gate?: ChannelCardGate | null;
  sent?: ChannelCardSent | null;
  snoozedUntil?: string | null;
  revokeUntil?: string | null;
  resolvedAt?: string | null;
  resolution?: ChannelCardResolution | null;
}

const PATCH_COLUMNS: Record<keyof ChannelCardPatch, { column: string; json: boolean }> = {
  state: { column: "state", json: false },
  delivery: { column: "delivery", json: false },
  firstSeq: { column: "first_seq", json: false },
  lastSeq: { column: "last_seq", json: false },
  messageCount: { column: "message_count", json: false },
  sender: { column: "sender", json: true },
  excerpt: { column: "excerpt", json: false },
  replyTarget: { column: "reply_target", json: true },
  draft: { column: "draft", json: true },
  gate: { column: "gate", json: true },
  sent: { column: "sent", json: true },
  snoozedUntil: { column: "snoozed_until", json: false },
  revokeUntil: { column: "revoke_until", json: false },
  resolvedAt: { column: "resolved_at", json: false },
  resolution: { column: "resolution", json: true },
};

/**
 * 改一张卡，版本加 1。expectedVersion 给了而卡已经变了时不改，返回 null（调用方按冲突处理）。
 * 没有这张卡时也返回 null。
 */
export function updateChannelCard(
  db: Db, id: number, patch: ChannelCardPatch, options: { expectedVersion?: number; at?: Date } = {},
): ChannelCard | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof ChannelCardPatch, unknown]>) {
    if (value === undefined) continue;
    const spec = PATCH_COLUMNS[key];
    if (!spec) throw new Error(`channel card patch has an unknown field ${key}`);
    sets.push(`${spec.column} = ?`);
    values.push(spec.json && value !== null ? JSON.stringify(value) : value);
  }
  sets.push("version = version + 1", "updated_at = ?");
  values.push((options.at ?? new Date()).toISOString());
  const where = options.expectedVersion === undefined ? "id = ?" : "id = ? AND version = ?";
  const params = options.expectedVersion === undefined ? [id] : [id, options.expectedVersion];
  const changed = db.prepare(`UPDATE channel_cards SET ${sets.join(", ")} WHERE ${where}`).run(...values, ...params).changes;
  return changed ? getChannelCard(db, id)! : null;
}

/** 最近的卡，旧的在前。deliveries 只要这些投递方式的卡。 */
export function listChannelCards(
  db: Db, query: { limit?: number; deliveries?: readonly ChannelDeliveryMode[] } = {},
): ChannelCard[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
  const deliveries = query.deliveries;
  const where = deliveries?.length ? `WHERE delivery IN (${deliveries.map(() => "?").join(", ")})` : "";
  return (db.prepare(`SELECT * FROM channel_cards ${where} ORDER BY id DESC LIMIT ?`)
    .all(...(deliveries ?? []), limit) as CardRow[]).map(parseCard).reverse();
}

/** 「稍后」到点的卡。 */
export function listDueSnoozedChannelCards(db: Db, now: Date): ChannelCard[] {
  return (db.prepare("SELECT * FROM channel_cards WHERE state = 'snoozed' AND snoozed_until <= ? ORDER BY id")
    .all(now.toISOString()) as CardRow[]).map(parseCard);
}

/** 这个对话的全部卡，从旧到新。 */
export function listChannelCardsForObject(db: Db, objectKey: string): ChannelCard[] {
  return (db.prepare("SELECT * FROM channel_cards WHERE object_key = ? ORDER BY id").all(objectKey) as CardRow[]).map(parseCard);
}

// ── 按来源读常设指令 ────────────────────────────────────────────────────────────────

const ruleOrderFor = (db: Db, rule: "channel.delivery" | "channel.delegate", source: string): StandingOrder | undefined =>
  activeStandingOrders(db).find((order) => order.action.type === "rule" && order.action.rule === rule
    && validStandingOrderRuleParams(rule, order.action.params)
    && (order.action.params as { source?: unknown }).source === source);

export interface ChannelDeliveryPolicy {
  pushWhen: StandingOrderCondition | null;
  cardWhen: StandingOrderCondition | null;
  digestWhen: StandingOrderCondition | null;
  order: StandingOrderRef;
}

/** 这个来源的投递（常设指令 channel.delivery）。来源插件没有写这条指令、或者读不到时是 null。 */
export function channelDeliveryPolicy(db: Db, source: string): ChannelDeliveryPolicy | null {
  const order = ruleOrderFor(db, "channel.delivery", source);
  if (!order || order.action.type !== "rule") return null;
  const params = order.action.params as Omit<ChannelDeliveryPolicy, "order">;
  return { pushWhen: params.pushWhen, cardWhen: params.cardWhen, digestWhen: params.digestWhen, order: standingOrderRef(order) };
}

export interface ChannelDelegatePolicy {
  // 现在真正开放的类别：最新版本里有，并且在用户写的、或者用户批准过的某一版里出现过。
  openCategories: DelegationCategory[];
  // 最新版本里写的类别（没有批准过的不算数）。
  requestedCategories: DelegationCategory[];
  allowedTrust: SenderTrust[];
  minConfidence: number;
  maxSensitivity: number;
  revokeWindowMs: number;
  shadowMinSamples: number;
  shadowMinAgreement: number;
  order: StandingOrderRef;
}

/**
 * 这个来源的代你行动参数（常设指令 channel.delegate）。来源插件没有写这条指令、或者读不到时是 null：闸门因此全部拒绝。
 * 开放类别要用户批准（spec D14 第 5 条）：Lead 自己写的放开经过工单 10 的审批才会写成版本，这里再按版本的作者和批准人
 * 核一遍，种子或者被别的办法写进库的版本开放不了类别。
 */
export function channelDelegatePolicy(db: Db, source: string): ChannelDelegatePolicy | null {
  const order = ruleOrderFor(db, "channel.delegate", source);
  if (!order || order.action.type !== "rule") return null;
  const params = order.action.params as {
    openCategories: string[]; allowedTrust: string[]; minConfidence: number; maxSensitivity: number;
    revokeWindowMs: number; shadowMinSamples: number; shadowMinAgreement: number;
  };
  const requested = [...new Set(params.openCategories.filter(isDelegationCategory))];
  const approved = new Set<string>();
  for (const version of listStandingOrderVersions(db, order.id)) {
    if (version.author !== "user" && !version.approvedBy) continue;
    if (version.action.type !== "rule") continue;
    const categories = (version.action.params as { openCategories?: unknown }).openCategories;
    if (Array.isArray(categories)) for (const category of categories) if (typeof category === "string") approved.add(category);
  }
  return {
    openCategories: requested.filter((category) => approved.has(category)),
    requestedCategories: requested,
    allowedTrust: [...new Set(params.allowedTrust.filter(isSenderTrust))],
    minConfidence: params.minConfidence,
    maxSensitivity: params.maxSensitivity,
    revokeWindowMs: params.revokeWindowMs,
    shadowMinSamples: params.shadowMinSamples,
    shadowMinAgreement: params.shadowMinAgreement,
    order: standingOrderRef(order),
  };
}

// ── 授权表 ──────────────────────────────────────────────────────────────────────────

export interface ChannelAuthorityPolicy {
  // 现在生效的授权表：最新版本的每一项，放开的部分在可信的版本里出现过才算数，否则这一项是「问你」。
  table: ChannelAuthorityTable;
  // 最新版本里写的（没有批准过的放开不算数）。
  requested: ChannelAuthorityTable;
  order: StandingOrderRef;
}

/**
 * 这个来源的授权表（常设指令 channel.authority，落地计划 A5）。来源自己有一条时用它，否则用通用的一条（source "*"）；
 * 都读不到时是 null（hub 用代码里的缺省）。
 * 放开要你批准：Lead 写的放开经过审批才会写成版本，这里再按版本的作者和批准人核一遍。可信的版本是系统种子、你写的、
 * 你批准过的。一项比所有可信版本里的同一项都放开时（例如被别的办法写进库），这一项按「问你」。涉密的 auto 一律不认（硬性规则）。
 */
export function channelAuthorityTable(db: Db, source: string): ChannelAuthorityPolicy | null {
  const valid = (order: StandingOrder) => order.action.type === "rule" && order.action.rule === "channel.authority"
    && validStandingOrderRuleParams("channel.authority", order.action.params);
  const paramsOf = (order: StandingOrder) => (order.action.type === "rule" ? order.action.params : {}) as Record<string, unknown>;
  const intentsOf = (order: StandingOrder) => paramsOf(order).intents as ChannelAuthorityTable;
  const sourceOf = (order: StandingOrder) => paramsOf(order).source;
  const orders = activeStandingOrders(db).filter(valid);
  const order = orders.find((candidate) => sourceOf(candidate) === source) ?? orders.find((candidate) => sourceOf(candidate) === "*");
  if (!order) return null;
  const requested = intentsOf(order);
  const trusted = [order, ...listStandingOrderVersions(db, order.id)]
    .filter((version) => valid(version) && (version.author === "system" || version.author === "user" || Boolean(version.approvedBy)))
    .map(intentsOf);
  // 可信版本里的这一项至少一样放开：权限不低于它，门槛不高于它（没写门槛的只和没写的比）。
  const covers = (granted: ChannelIntentAuthority, wanted: ChannelIntentAuthority) =>
    CHANNEL_INTENT_PERMISSION_RANK[granted.action] >= CHANNEL_INTENT_PERMISSION_RANK[wanted.action]
    && (granted.minConfidence === wanted.minConfidence
      || (typeof granted.minConfidence === "number" && typeof wanted.minConfidence === "number" && granted.minConfidence <= wanted.minConfidence));
  const table = Object.fromEntries(CHANNEL_INTENTS.map((intent: ChannelIntent) => {
    const wanted = requested[intent];
    const ok = !(intent === "secret" && wanted.action === "auto") && trusted.some((intents) => covers(intents[intent], wanted));
    return [intent, ok ? wanted : { action: "ask" }];
  })) as ChannelAuthorityTable;
  return { table, requested, order: standingOrderRef(order) };
}

// ── 自动代你处理和信心模型的参数（2026-10-23，设置 → 消息通道）─────────────────────────────

export interface ChannelPolicy {
  // 现在生效的：授权表照 channelAuthorityTable；开关和信心模型的参数里，没有批准过的放宽不算数。
  params: ChannelPolicyParams;
  // 最新版本里写的。
  requested: ChannelPolicyParams;
  // 参数存在哪一条常设指令（来源自己的一条，或者通用的 "*"）。
  order: StandingOrder;
  scope: string;
}

// 信心模型参数的每一项：怎么读，哪个方向更保守。和 protocol 的 standing-order-tiers.ts 的 confidenceFindings 一致。
type Direction = "higher" | "lower" | "exact";
const CONFIDENCE_FIELDS: ReadonlyArray<{ get(params: ChannelConfidenceParams): unknown; conservative: Direction | "hard" }> = [
  ...[0, 1, 2, 3].map((index) => ({ get: (params: ChannelConfidenceParams) => params.tiers[index], conservative: "higher" as const })),
  { get: (params) => params.noReplyBelow, conservative: "lower" },
  { get: (params) => params.weights.needs_reply, conservative: "higher" },
  { get: (params) => params.weights.fulfills, conservative: "higher" },
  { get: (params) => params.priorStrength, conservative: "exact" },
  { get: (params) => params.coldStartTiers, conservative: "higher" },
  { get: (params) => params.lockMode, conservative: "hard" },
  { get: (params) => params.tuning.topicStep, conservative: "lower" },
  { get: (params) => params.tuning.draftRiskStep, conservative: "lower" },
  { get: (params) => params.tuning.verifiedFloor, conservative: "lower" },
  { get: (params) => params.tuning.groundedFloor, conservative: "lower" },
  { get: (params) => params.tuning.understoodFloor, conservative: "lower" },
];

/** wanted 是不是不比 granted 放开（每一项都一样或者更保守）。 */
function confidenceCovered(granted: ChannelConfidenceParams, wanted: ChannelConfidenceParams): boolean {
  return CONFIDENCE_FIELDS.every(({ get, conservative }) => {
    const a = get(granted);
    const b = get(wanted);
    if (a === b) return true;
    if (conservative === "exact") return false;
    if (conservative === "hard") return b === "hard";
    return typeof a === "number" && typeof b === "number" && (conservative === "higher" ? b >= a : b <= a);
  });
}

/**
 * 这个来源的自动代你处理：开关、授权表、信心模型的参数（常设指令 channel.authority，读法同 channelAuthorityTable）。
 * 都读不到时是 null（hub 用代码里的缺省）。放宽要你批准：开关和信心模型的参数，最新版本比所有可信的版本都放开时（例如被别的办法
 * 写进库），用最近一个可信版本里的值。可信的版本是系统种子、你写的、你批准过的。
 */
export function channelPolicy(db: Db, source: string): ChannelPolicy | null {
  const authority = channelAuthorityTable(db, source);
  if (!authority) return null;
  const order = activeStandingOrders(db).find((candidate) => candidate.id === authority.order.id && candidate.version === authority.order.version);
  if (!order || order.action.type !== "rule") return null;
  const paramsOf = (version: StandingOrder) => (version.action.type === "rule" ? version.action.params : {}) as {
    source?: string; autoReply?: boolean; model?: ChannelConfidenceParams;
  };
  const latest = paramsOf(order);
  const requested: ChannelPolicyParams = {
    autoReply: latest.autoReply ?? CHANNEL_AUTO_REPLY_DEFAULT,
    intents: authority.requested as ChannelPolicyParams["intents"],
    confidence: latest.model ?? CHANNEL_CONFIDENCE_DEFAULTS,
  };
  const trusted = [order, ...listStandingOrderVersions(db, order.id).reverse()]
    .filter((version) => version.action.type === "rule" && validStandingOrderRuleParams("channel.authority", version.action.params)
      && (version.author === "system" || version.author === "user" || Boolean(version.approvedBy)))
    .map(paramsOf);
  const autoReply = requested.autoReply
    && trusted.some((version) => (version.autoReply ?? CHANNEL_AUTO_REPLY_DEFAULT) === true);
  const covering = trusted.find((version) => confidenceCovered(version.model ?? CHANNEL_CONFIDENCE_DEFAULTS, requested.confidence));
  const confidence = covering ? requested.confidence : trusted[0]?.model ?? CHANNEL_CONFIDENCE_DEFAULTS;
  return {
    params: { autoReply, intents: authority.table as ChannelPolicyParams["intents"], confidence },
    requested,
    order,
    scope: latest.source ?? "*",
  };
}

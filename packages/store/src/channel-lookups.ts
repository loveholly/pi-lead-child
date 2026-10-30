// 代查（代查与按信心代回 spec D1、D2、D7）。表在 schema.ts 的 CHANNEL_LOOKUPS_SCHEMA（v49）。
//
// 这里只存取状态，不做决定：要不要查、怎样查、查完要不要自动回复，都在 engine 的通道 hub 和 daemon 的启动器。
// 审计不在这里：收件判断、代查的开始和结束、被拒、代回的决定都写成事件（packages/protocol 的 channels.ts）。
// 这个文件有四部分：一次代查的存取；配额；校准样本；按来源读常设指令（代查、代回）。
// 这里不出现任何具体来源的名字。
import {
  LOOKUP_ACTIVE_STATES, LOOKUP_PLAYBOOKS, LOOKUP_STATES, NEVER_DELEGATED_TRUST, isSenderTrust, validLookupReads,
  validLookupResult, validLookupScope, validStandingOrderRuleParams,
  type ChannelLookupCheckStatus, type ChannelReplyDecision, type LookupPlaybook, type LookupReadRecord, type LookupResult,
  type LookupScope, type LookupState, type SenderTrust, type StandingOrder, type StandingOrderRef,
} from "@pi-lead-child/protocol";
import type { ChannelGateCheck } from "./channels.js";
import type { Db } from "./db.js";
import { activeStandingOrders, listStandingOrderVersions, standingOrderRef } from "./standing-orders.js";

// ── 形状 ────────────────────────────────────────────────────────────────────────────

/** 谁要查。trust 是适配器给的信任级别。 */
export interface ChannelLookupRequester { id: string; name: string; trust: SenderTrust }

/** 代查闸门（spec D4）的结论。start：开始查；queue：并发满了，等着；denied：不查（带原因）；skip：不是一个请求。 */
export type ChannelLookupGateDecision = "start" | "queue" | "denied" | "skip";

/** 收件判断（请求 A，spec D3）的回答和代查闸门（spec D4）的检查。hub 写，这里只存取。 */
export interface ChannelLookupIntake {
  // 请求 A。answered 为 false：快模型不可用、超时或出错（这时不代查），下面四项没有意义。
  answered: boolean;
  askKind: string | null;
  askConfidence: number | null;
  // 请求 A 选的仓库（owner/name）；none 时是 null。
  targetRepo: string | null;
  // 6 个敏感查询、5 个话题各自的概率。
  sensitive: Record<string, number>;
  topics: Record<string, number>;
  // 「正在处理」的动作词（engine 的 HANDLING_VERBS）：决定代查以后单独问的。旧数据和没选出来的是 null 或者没有。
  handlingVerb?: string | null;
  // 请求 A 的 needs_reply：这条消息要用户回的概率。旧数据和没回答的是 null 或者没有。
  needsReply?: number | null;
  gate: {
    decision: ChannelLookupGateDecision;
    failed: string[];
    checks: ChannelGateCheck[];
    order: StandingOrderRef | null;
  } | null;
  at: string;
}

/** 信心拆解里的一项检查（卡上的 ✓、△、✗）。 */
export interface ChannelLookupCheck {
  id: string;
  label: string;
  status: ChannelLookupCheckStatus;
  value: number | null;
  detail: string;
}

/** 校准（spec D7）：这次的分数段里，用户做过的选择。 */
export interface ChannelLookupCalibration {
  bucket: number;
  samples: number;
  agreed: number;
  minSamples: number;
}

/** 查完以后的核实（spec D5、D6、D7）：出处核实、请求 B、信心、否决项。hub 写。 */
export interface ChannelLookupVerification {
  // 出处核实（代码）：核实通过的出处和全部出处。
  sources: { total: number; verified: number };
  // 请求 B。ok 为 false：快模型不可用、超时或出错，代回只能问用户。概率拿不到时是 null。
  replyCheck: {
    ok: boolean;
    // 做到了所求、有依据（engine 的 reply-check.ts，2026-10-21 起对所有任务都一样）。
    // 之前的数据记的是 answersQuestion、supportedBySources，没有这两项。
    fulfillsRequest?: number | null;
    grounded?: number | null;
    answersQuestion?: number | null;
    supportedBySources?: number | null;
    draftCommits: number | null;
    draftOvershares: number | null;
    error: string | null;
  } | null;
  // 信心 c = min(理解了请求：ask_kind 的置信度, 做到了所求, 有依据)。算不出时是 null。
  confidence: number | null;
  // 这次用的门槛（冷启动是 coldStartMin，否则是 threshold）。
  threshold: number | null;
  calibration: ChannelLookupCalibration | null;
  checks: ChannelLookupCheck[];
  vetoes: string[];
  // 代查失败或被停掉的原因（LookupOutcome.error，已脱敏）。工单 04 加的，旧的行没有。
  error?: string | null;
  at: string;
}

// 用户对一次代查的选择（spec D7 的校准样本）。2026-10-22 起校准改看你在来源里实际做了什么（落地计划 D2，engine 的
// channels/calibration.ts，事件 channel.reply.labeled），不再写这一项；旧的代查记录里还有，照原样读。
export const CHANNEL_LOOKUP_CHOICES = ["send_draft", "send_edited", "reply_myself", "dismiss", "undo_auto_reply", "post_review"] as const;
export type ChannelLookupChoiceAction = typeof CHANNEL_LOOKUP_CHOICES[number];

export interface ChannelLookupChoice { action: ChannelLookupChoiceAction; by: string; at: string }

/** 代回闸门（spec D7）的决定，和用户后来的选择。hub 写。 */
export interface ChannelLookupReply {
  decision: ChannelReplyDecision;
  reasons: string[];
  order: StandingOrderRef | null;
  at: string;
  // 用户的选择（校准样本）。还没选时是 null。
  choice: ChannelLookupChoice | null;
}

export interface ChannelLookup {
  id: number;
  cardId: number;
  source: string;
  objectKey: string;
  // 查的是哪一条消息（来源事件的 seq）。
  forSeq: number;
  playbook: LookupPlaybook;
  state: LookupState;
  requester: ChannelLookupRequester;
  // 对方的原话（截断过，不可信）。
  question: string;
  intake: ChannelLookupIntake;
  scope: LookupScope;
  itemId: number | null;
  runId: number | null;
  result: LookupResult | null;
  reads: LookupReadRecord[];
  verification: ChannelLookupVerification | null;
  reply: ChannelLookupReply | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** 对方的原话最多存多少字。 */
export const CHANNEL_LOOKUP_QUESTION_MAX = 2_000;

const EMPTY_SCOPE: LookupScope = { local: [], github: [] };

export function isActiveLookupState(state: LookupState): boolean {
  return LOOKUP_ACTIVE_STATES.includes(state);
}

interface LookupRow {
  id: number; card_id: number; source: string; object_key: string; for_seq: number; playbook: string; state: string;
  requester: string; question: string; intake: string; scope: string; item_id: number | null; run_id: number | null;
  result: string | null; reads: string; verification: string | null; reply: string | null; version: number;
  created_at: string; updated_at: string; finished_at: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseLookup(row: LookupRow): ChannelLookup {
  const requester = parseJson<Partial<ChannelLookupRequester>>(row.requester, {});
  const scope = parseJson<unknown>(row.scope, null);
  const result = parseJson<unknown>(row.result, null);
  const reads = parseJson<unknown>(row.reads, []);
  return {
    id: row.id, cardId: row.card_id, source: row.source, objectKey: row.object_key, forSeq: row.for_seq,
    playbook: row.playbook as LookupPlaybook, state: row.state as LookupState,
    requester: {
      id: String(requester.id ?? ""), name: String(requester.name ?? ""),
      trust: isSenderTrust(requester.trust) ? requester.trust : "unknown",
    },
    question: row.question,
    intake: parseJson<ChannelLookupIntake>(row.intake, {
      answered: false, askKind: null, askConfidence: null, targetRepo: null, sensitive: {}, topics: {}, gate: null, at: row.created_at,
    }),
    // 读出来不合格的 JSON 当成没有：卡的 DTO 是严格 schema，坏数据不能送上线。
    scope: validLookupScope(scope) ? scope : EMPTY_SCOPE,
    itemId: row.item_id, runId: row.run_id,
    result: validLookupResult(result) ? result : null,
    reads: validLookupReads(reads) ? reads : [],
    verification: parseJson<ChannelLookupVerification | null>(row.verification, null),
    reply: parseJson<ChannelLookupReply | null>(row.reply, null),
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
// 没结束的状态，作为 SQL 参数传（不拼进 SQL）。
const ACTIVE_PLACEHOLDERS = LOOKUP_ACTIVE_STATES.map(() => "?").join(", ");

function assertState(state: unknown): asserts state is LookupState {
  if (!(LOOKUP_STATES as readonly unknown[]).includes(state)) throw new Error(`channel lookup state ${String(state)} is not a lookup state`);
}

function assertScope(scope: unknown): asserts scope is LookupScope {
  if (!validLookupScope(scope)) throw new Error("channel lookup scope does not match LookupScopeSchema");
}

// ── 一次代查 ────────────────────────────────────────────────────────────────────────

export function getChannelLookup(db: Db, id: number): ChannelLookup | undefined {
  const row = db.prepare("SELECT * FROM channel_lookups WHERE id = ?").get(id) as LookupRow | undefined;
  return row ? parseLookup(row) : undefined;
}

/** 这张卡没结束的代查（最多一次）。 */
export function getActiveLookupForCard(db: Db, cardId: number): ChannelLookup | undefined {
  const row = db.prepare(`SELECT * FROM channel_lookups WHERE card_id = ? AND state IN (${ACTIVE_PLACEHOLDERS}) ORDER BY id DESC LIMIT 1`)
    .get(cardId, ...LOOKUP_ACTIVE_STATES) as LookupRow | undefined;
  return row ? parseLookup(row) : undefined;
}

/** 这张卡最新一次代查（卡的 DTO 带的就是它）。 */
export function getLatestLookupForCard(db: Db, cardId: number): ChannelLookup | undefined {
  const row = db.prepare("SELECT * FROM channel_lookups WHERE card_id = ? ORDER BY id DESC LIMIT 1").get(cardId) as LookupRow | undefined;
  return row ? parseLookup(row) : undefined;
}

/** 这张代查工单是哪一次代查（工单结束、重启回收时用）。 */
export function getLookupByItem(db: Db, itemId: number): ChannelLookup | undefined {
  const row = db.prepare("SELECT * FROM channel_lookups WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(itemId) as LookupRow | undefined;
  return row ? parseLookup(row) : undefined;
}

/** 没结束的代查，从旧到新。source 只要这个来源的。 */
export function listActiveLookups(db: Db, query: { source?: string; limit?: number } = {}): ChannelLookup[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
  const where = query.source === undefined ? "" : "AND source = ?";
  return (db.prepare(`SELECT * FROM channel_lookups WHERE state IN (${ACTIVE_PLACEHOLDERS}) ${where} ORDER BY id LIMIT ?`)
    .all(...LOOKUP_ACTIVE_STATES, ...(query.source === undefined ? [] : [query.source]), limit) as LookupRow[]).map(parseLookup);
}

/**
 * 超时的代查：没结束、并且开出来（created_at）到 now 已经超过 timeoutMs，从旧到新。排队的时间也算：
 * spec D14 的不变量说的是一次代查停在 queued 或 running 的总时间。source 只要这个来源的（时限是按来源的常设指令定的）。
 */
export function listOverdueLookups(db: Db, now: Date, timeoutMs: number, query: { source?: string } = {}): ChannelLookup[] {
  const before = new Date(now.getTime() - timeoutMs).toISOString();
  const where = query.source === undefined ? "" : "AND source = ?";
  return (db.prepare(`SELECT * FROM channel_lookups WHERE state IN (${ACTIVE_PLACEHOLDERS}) AND created_at <= ? ${where} ORDER BY id`)
    .all(...LOOKUP_ACTIVE_STATES, before, ...(query.source === undefined ? [] : [query.source])) as LookupRow[]).map(parseLookup);
}

/** 已经结束（查到或失败）、还没有代回决定的代查，从旧到新（spec D14 的不变量 2：hub 每一拍补上）。 */
export function listLookupsAwaitingReply(db: Db, query: { limit?: number } = {}): ChannelLookup[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
  return (db.prepare("SELECT * FROM channel_lookups WHERE state IN ('finished', 'failed') AND reply IS NULL ORDER BY id LIMIT ?")
    .all(limit) as LookupRow[]).map(parseLookup);
}

export interface NewChannelLookup {
  cardId: number;
  source: string;
  objectKey: string;
  forSeq: number;
  playbook: LookupPlaybook;
  // 缺省 queued。被拒的请求直接写成 denied（这时 finished_at 也写上）。
  state?: LookupState;
  requester: ChannelLookupRequester;
  question: string;
  intake: ChannelLookupIntake;
  scope?: LookupScope;
  at?: Date;
}

/**
 * 记一次代查。这张卡已经有没结束的代查时，部分唯一索引会让没结束的这一次失败：调用方先用 getActiveLookupForCard。
 * 剧本、状态、作用域不合格时抛错。
 */
export function createChannelLookup(db: Db, input: NewChannelLookup): ChannelLookup {
  if (!(LOOKUP_PLAYBOOKS as readonly string[]).includes(input.playbook)) {
    throw new Error(`channel lookup playbook ${String(input.playbook)} is not a playbook`);
  }
  const state = input.state ?? "queued";
  assertState(state);
  const scope = input.scope ?? EMPTY_SCOPE;
  assertScope(scope);
  const at = (input.at ?? new Date()).toISOString();
  const id = Number(db.prepare(
    `INSERT INTO channel_lookups (
       card_id, source, object_key, for_seq, playbook, state, requester, question, intake, scope, version,
       created_at, updated_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    input.cardId, input.source, input.objectKey, input.forSeq, input.playbook, state, JSON.stringify(input.requester),
    clip(input.question, CHANNEL_LOOKUP_QUESTION_MAX), JSON.stringify(input.intake), JSON.stringify(scope), at, at,
    isActiveLookupState(state) ? null : at,
  ).lastInsertRowid);
  return getChannelLookup(db, id)!;
}

export interface ChannelLookupPatch {
  state?: LookupState;
  intake?: ChannelLookupIntake;
  scope?: LookupScope;
  itemId?: number | null;
  runId?: number | null;
  result?: LookupResult | null;
  reads?: LookupReadRecord[];
  verification?: ChannelLookupVerification | null;
  reply?: ChannelLookupReply | null;
  finishedAt?: string | null;
}

const PATCH_COLUMNS: Record<keyof ChannelLookupPatch, { column: string; json: boolean }> = {
  state: { column: "state", json: false },
  intake: { column: "intake", json: true },
  scope: { column: "scope", json: true },
  itemId: { column: "item_id", json: false },
  runId: { column: "run_id", json: false },
  result: { column: "result", json: true },
  reads: { column: "reads", json: true },
  verification: { column: "verification", json: true },
  reply: { column: "reply", json: true },
  finishedAt: { column: "finished_at", json: false },
};

/**
 * 改一次代查，版本加 1（和 updateChannelCard 同一种写法）。expectedVersion 给了而这一行已经变了时不改，返回 null
 * （调用方按冲突处理）。没有这一行时也返回 null。
 * 改成结束的状态（不是 queued、running）而没给 finishedAt 时，finished_at 记成这一次的时间（已经有的不改）。
 * 结束了的代查不能回到 queued 或 running：重新查是新的一次（新的一行）。作用域、结果、读取记录不合格时抛错。
 */
export function updateChannelLookup(
  db: Db, id: number, patch: ChannelLookupPatch, options: { expectedVersion?: number; at?: Date } = {},
): ChannelLookup | null {
  if (patch.state !== undefined) {
    assertState(patch.state);
    if (isActiveLookupState(patch.state)) {
      const current = getChannelLookup(db, id);
      if (current && !isActiveLookupState(current.state)) {
        throw new Error(`channel lookup #${id} already ended (${current.state}); it cannot go back to ${patch.state}`);
      }
    }
  }
  if (patch.scope !== undefined) assertScope(patch.scope);
  if (patch.result !== undefined && patch.result !== null && !validLookupResult(patch.result)) {
    throw new Error("channel lookup result does not match LookupResultSchema");
  }
  if (patch.reads !== undefined && !validLookupReads(patch.reads)) {
    throw new Error("channel lookup reads do not match LookupReadRecordSchema");
  }
  const at = (options.at ?? new Date()).toISOString();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof ChannelLookupPatch, unknown]>) {
    if (value === undefined) continue;
    const spec = PATCH_COLUMNS[key];
    if (!spec) throw new Error(`channel lookup patch has an unknown field ${key}`);
    sets.push(`${spec.column} = ?`);
    values.push(spec.json && value !== null ? JSON.stringify(value) : value);
  }
  if (patch.state !== undefined && !isActiveLookupState(patch.state) && patch.finishedAt === undefined) {
    sets.push("finished_at = COALESCE(finished_at, ?)");
    values.push(at);
  }
  sets.push("version = version + 1", "updated_at = ?");
  values.push(at);
  const where = options.expectedVersion === undefined ? "id = ?" : "id = ? AND version = ?";
  const params = options.expectedVersion === undefined ? [id] : [id, options.expectedVersion];
  const changed = db.prepare(`UPDATE channel_lookups SET ${sets.join(", ")} WHERE ${where}`).run(...values, ...params).changes;
  return changed ? getChannelLookup(db, id)! : null;
}

// ── 配额 ────────────────────────────────────────────────────────────────────────────

/**
 * since 以后开出来的代查有几次（spec D4 的配额）。requesterId 只数这个请求者的。
 * 被拒的不算：它们没有查，不占预算。取消和失败的算：它们查过一部分。
 */
export function countLookupsSince(db: Db, query: { source: string; requesterId?: string; since: Date }): number {
  const requester = query.requesterId === undefined ? "" : "AND json_valid(requester) AND json_extract(requester, '$.id') = ?";
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM channel_lookups WHERE source = ? AND created_at >= ? AND state <> 'denied' ${requester}`,
  ).get(query.source, query.since.toISOString(), ...(query.requesterId === undefined ? [] : [query.requesterId])) as { n: number };
  return row.n;
}

// ── 按来源读常设指令 ────────────────────────────────────────────────────────────────

const ruleOrderFor = (db: Db, rule: "channel.lookup" | "channel.reply", source: string): StandingOrder | undefined =>
  activeStandingOrders(db).find((order) => order.action.type === "rule" && order.action.rule === rule
    && validStandingOrderRuleParams(rule, order.action.params)
    && (order.action.params as { source?: unknown }).source === source);

/**
 * 这条指令里「算数」的版本的参数：系统种子（代码里写的缺省值，spec D2 定的）、用户写的、或者用户批准过的。
 * Lead 自己写的放开经过工单 10 的审批才会写成版本；这里再按作者和批准人核一遍，没有经过批准写进库的版本放开不了开关。
 */
function trustedParams(db: Db, order: StandingOrder): Array<Record<string, unknown>> {
  const trusted = (version: StandingOrder) => version.author === "system" || version.author === "user" || Boolean(version.approvedBy);
  return [order, ...listStandingOrderVersions(db, order.id)]
    .filter((version) => trusted(version) && version.action.type === "rule")
    .map((version) => (version.action as { params: Record<string, unknown> }).params);
}

const trustLevels = (values: unknown[]): SenderTrust[] =>
  [...new Set(values.filter(isSenderTrust))].filter((trust) => !NEVER_DELEGATED_TRUST.includes(trust));

export interface ChannelLookupPolicy {
  // 现在真正开放的剧本：最新版本里有，并且在系统种子、用户写的、或者用户批准过的某一版里出现过。
  playbooks: LookupPlaybook[];
  // 最新版本里写的剧本（没有经过批准的不算数）。
  requestedPlaybooks: LookupPlaybook[];
  // 能代查的发信人。外部客户永不代查（硬性规则），即使指令里写了也去掉。
  allowedTrust: SenderTrust[];
  minAskConfidence: number;
  maxSensitiveQuery: number;
  perRequesterDaily: number;
  dailyMax: number;
  concurrent: number;
  timeoutMs: number;
  maxRepos: number;
  order: StandingOrderRef;
}

/** 这个来源的代查参数（常设指令 channel.lookup，spec D2）。来源插件没有写这条指令、或者读不到时是 null：这时不代查。 */
export function channelLookupPolicy(db: Db, source: string): ChannelLookupPolicy | null {
  const order = ruleOrderFor(db, "channel.lookup", source);
  if (!order || order.action.type !== "rule") return null;
  const params = order.action.params as {
    playbooks: string[]; allowedTrust: string[]; minAskConfidence: number; maxSensitiveQuery: number; perRequesterDaily: number;
    dailyMax: number; concurrent: number; timeoutMs: number; maxRepos: number;
  };
  const isPlaybook = (value: unknown): value is LookupPlaybook => (LOOKUP_PLAYBOOKS as readonly unknown[]).includes(value);
  const requested = [...new Set(params.playbooks.filter(isPlaybook))];
  const approved = new Set<string>();
  for (const trusted of trustedParams(db, order)) {
    if (Array.isArray(trusted.playbooks)) for (const playbook of trusted.playbooks) if (typeof playbook === "string") approved.add(playbook);
  }
  return {
    playbooks: requested.filter((playbook) => approved.has(playbook)),
    requestedPlaybooks: requested,
    allowedTrust: trustLevels(params.allowedTrust),
    minAskConfidence: params.minAskConfidence,
    maxSensitiveQuery: params.maxSensitiveQuery,
    perRequesterDaily: params.perRequesterDaily,
    dailyMax: params.dailyMax,
    concurrent: params.concurrent,
    timeoutMs: params.timeoutMs,
    maxRepos: params.maxRepos,
    order: standingOrderRef(order),
  };
}

export interface ChannelReplyPolicy {
  // 现在真正打开的自动代回：最新版本里打开，并且在系统种子、用户写的、或者用户批准过的某一版里打开过。
  autoReply: Record<LookupPlaybook, boolean>;
  // 最新版本里写的开关（没有经过批准的不算数）。
  requestedAutoReply: Record<LookupPlaybook, boolean>;
  threshold: number;
  coldStartMin: number;
  calibrationMinSamples: number;
  calibrationMinAgreement: number;
  maxSensitivity: number;
  maxResultAgeMs: number;
  revokeWindowMs: number;
  order: StandingOrderRef;
}

/** 这个来源的代回参数（常设指令 channel.reply，spec D2、D7）。来源插件没有写这条指令、或者读不到时是 null：这时不自动回复。 */
export function channelReplyPolicy(db: Db, source: string): ChannelReplyPolicy | null {
  const order = ruleOrderFor(db, "channel.reply", source);
  if (!order || order.action.type !== "rule") return null;
  const params = order.action.params as {
    autoReply: Record<LookupPlaybook, boolean>; threshold: number; coldStartMin: number; calibrationMinSamples: number;
    calibrationMinAgreement: number; maxSensitivity: number; maxResultAgeMs: number; revokeWindowMs: number;
  };
  const trusted = trustedParams(db, order);
  const openedBefore = (playbook: LookupPlaybook) =>
    trusted.some((version) => (version.autoReply as Record<string, unknown> | undefined)?.[playbook] === true);
  const requested = Object.fromEntries(LOOKUP_PLAYBOOKS.map((playbook) => [playbook, params.autoReply[playbook] === true])) as
    Record<LookupPlaybook, boolean>;
  return {
    autoReply: Object.fromEntries(LOOKUP_PLAYBOOKS.map((playbook) => [playbook, requested[playbook] && openedBefore(playbook)])) as
      Record<LookupPlaybook, boolean>,
    requestedAutoReply: requested,
    threshold: params.threshold,
    coldStartMin: params.coldStartMin,
    calibrationMinSamples: params.calibrationMinSamples,
    calibrationMinAgreement: params.calibrationMinAgreement,
    maxSensitivity: params.maxSensitivity,
    maxResultAgeMs: params.maxResultAgeMs,
    revokeWindowMs: params.revokeWindowMs,
    order: standingOrderRef(order),
  };
}

// ── 不变量（spec D14）────────────────────────────────────────────────────────────────

export interface ChannelLookupInvariantOptions {
  now: Date;
  // 这个来源的代查时限（常设指令 channel.lookup 的 timeoutMs）。
  timeoutMs: (source: string) => number;
  // 不变量 1 在时限以后再宽限多久。缺省 5 分钟。
  graceMs?: number;
  // 不变量 2：结束以后多久之内一定有代回的决定。缺省 10 分钟。
  replyWithinMs?: number;
}

/**
 * 代查的三条不变量（spec D14），返回违反的地方（一条一句话），空数组表示都成立：
 *   1. 没有一次代查停在 queued 或 running 超过时限再加 5 分钟；
 *   2. 每一次 finished 或 failed 的代查，结束后 10 分钟内一定有代回的决定（reply 不为空）；
 *   3. 代查工单的 stage 是终态，当且仅当这次代查是终态。
 * core invariant 测试和场景测试用它。
 */
export function channelLookupInvariantViolations(db: Db, options: ChannelLookupInvariantOptions): string[] {
  const now = options.now.getTime();
  const grace = options.graceMs ?? 5 * 60_000;
  const replyWithin = options.replyWithinMs ?? 10 * 60_000;
  const violations: string[] = [];
  const rows = (db.prepare("SELECT * FROM channel_lookups ORDER BY id").all() as LookupRow[]).map(parseLookup);
  const stageOf = db.prepare("SELECT stage FROM items WHERE id = ?");
  for (const lookup of rows) {
    const active = isActiveLookupState(lookup.state);
    if (active && now - Date.parse(lookup.createdAt) > options.timeoutMs(lookup.source) + grace) {
      violations.push(`代查 #${lookup.id} 停在 ${lookup.state} 超过时限`);
    }
    if ((lookup.state === "finished" || lookup.state === "failed") && !lookup.reply
      && now - Date.parse(lookup.finishedAt ?? lookup.updatedAt) > replyWithin) {
      violations.push(`代查 #${lookup.id} 结束超过 10 分钟还没有代回的决定`);
    }
    if (lookup.itemId !== null) {
      const stage = (stageOf.get(lookup.itemId) as { stage: string } | undefined)?.stage;
      const terminal = stage === "done" || stage === "cancelled" || stage === "acked";
      if (stage !== undefined && terminal === active) {
        violations.push(`代查 #${lookup.id} 是 ${lookup.state}，它的工单 #${lookup.itemId} 却是 ${stage}`);
      }
    }
  }
  return violations;
}

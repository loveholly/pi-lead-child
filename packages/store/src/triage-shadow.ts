// Jev 分诊的影子判断（Lead 事件主干 spec D12，工单 09）。表在 schema.ts 的 EVENT_TRIAGE_SHADOW_SCHEMA（v45）。
//
// 规则层（event-triage.ts）定不了级别的事件，是指级别来自来源的默认指令（source.*），没有更具体的指令命中。
// daemon 在后台按批问 Jev（engine 的 triage-shadow.ts），判断记在这里。影子模式只记录：
//   - 不改 events 的 level、triage、disposition，也不写新的事件。
//   - 一个事件最多一条判断（seq 唯一），表只追加。
// 这个文件有五部分：批处理的游标和候选事件；写和读判断；按时间范围把判断和实际的级别、处置放在一起；
// 一致率的纯函数（computeTriageShadowReport）；启用开关（常设指令 triage.jev，缺省全部关闭）。
import {
  COMPONENT_CALL_KINDS, isTriageLevel,
  type EventDisposition, type EventLevel, type StandingOrderRef, type TriageLevel,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { getEvent, type EventRecord } from "./events.js";
import { activeStandingOrders, ruleStandingOrder, standingOrderRef } from "./standing-orders.js";

/** 现在只有影子模式。启用以后（以后的工单）写 live。 */
export const TRIAGE_SHADOW_MODE = "shadow";

/** 风险的分档，从低到高。 */
export const TRIAGE_SHADOW_RISK_TIERS = ["low", "medium", "high"] as const;
export type TriageShadowRisk = typeof TRIAGE_SHADOW_RISK_TIERS[number];

// 第一道：系统已经处置掉的事件不问（见 TRIAGE_SHADOW_CANDIDATE_DISPOSITIONS）。组件调用的遥测（工单 13 的
// decision_model.called、memory.recalled）写入时就记了 handled_by_rule，不需要分诊，也不该花 Jev 的调用。
// 第二道保险：下面这些类型不管有没有处置都不问。decision_model.* 是问 Jev 这件事本身产生的：问它们会自己喂自己，
// 每问一次多一个事件，每个事件又要问一次。
export const TRIAGE_SHADOW_EXCLUDED_KIND_PREFIXES: readonly string[] = ["decision_model."];
export const TRIAGE_SHADOW_EXCLUDED_KINDS: readonly string[] = Object.values(COMPONENT_CALL_KINDS);

// ── 游标 ────────────────────────────────────────────────────────────────────────────

// 影子分诊自己的游标，和 Lead 的游标（工单 04）分开：它表示「seq 不大于它的事件都看过了」。
const CURSOR_KEY = "events.triage_shadow.cursor";

export function getTriageShadowCursor(db: Db): number | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(CURSOR_KEY) as { value: string } | undefined;
  const value = row ? Number(row.value) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function setTriageShadowCursor(db: Db, seq: number): void {
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`triage shadow cursor must be a non-negative integer, got ${seq}`);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(CURSOR_KEY, String(seq));
}

// ── 候选事件 ────────────────────────────────────────────────────────────────────────

/** 来源默认指令的编号：动作是 source.threshold 规则的指令。分诊依据是它们的事件，就是规则定不了级别的事件。 */
export function sourceDefaultOrderIds(db: Db): string[] {
  const ids = activeStandingOrders(db)
    .filter((order) => order.action.type === "rule" && order.action.rule === "source.threshold")
    .map((order) => order.id);
  // 找不到任何来源指令时（表坏了），分诊用的是代码里的 source.external。
  return ids.length ? ids : ["source.external"];
}

export interface TriageShadowCandidates {
  // 这一批要问的事件，从旧到新。
  events: EventRecord[];
  // 查询时日志里最大的 seq。候选比 limit 少时，afterSeq 到它之间的事件都看过了，游标可以直接移到它。
  highWater: number;
}

/**
 * 影子分诊的候选事件：seq 在 afterSeq 之后、在 receivedSince 以后收到、分诊依据是来源的默认指令、还没有影子判断，
 * 并且还没有处置，或者处置是 Lead 记的（TRIAGE_SHADOW_CANDIDATE_DISPOSITIONS）。
 * 不要用户的消息（conversation）、写入方自己给了级别的（依据是 null）、TRIAGE_SHADOW_EXCLUDED_KINDS 和
 * TRIAGE_SHADOW_EXCLUDED_KIND_PREFIXES 里的类型。
 */
export function listTriageShadowCandidates(
  db: Db, query: { afterSeq: number; limit: number; receivedSince: Date },
): TriageShadowCandidates {
  const { v } = db.prepare("SELECT MAX(seq) AS v FROM events").get() as { v: number | null };
  const highWater = v ?? 0;
  const orderIds = sourceDefaultOrderIds(db);
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);
  const excluded = TRIAGE_SHADOW_EXCLUDED_KIND_PREFIXES.map(() => "AND kind NOT LIKE ? ESCAPE '\\'").join(" ");
  const kept = TRIAGE_SHADOW_CANDIDATE_DISPOSITIONS;
  const rows = db.prepare(
    `SELECT seq FROM events
     WHERE seq > ? AND seq <= ? AND received_at >= ?
       AND level IS NOT NULL AND level <> 'conversation'
       AND (CASE WHEN json_valid(triage) THEN json_extract(triage, '$.order.id') END) IN (${orderIds.map(() => "?").join(", ")})
       AND (disposition IS NULL OR disposition IN (${kept.map(() => "?").join(", ")}))
       AND kind NOT IN (${TRIAGE_SHADOW_EXCLUDED_KINDS.map(() => "?").join(", ")})
       ${excluded}
       AND NOT EXISTS (SELECT 1 FROM event_triage_shadow s WHERE s.seq = events.seq)
     ORDER BY seq LIMIT ?`,
  ).all(
    query.afterSeq, highWater, query.receivedSince.toISOString(), ...orderIds, ...kept, ...TRIAGE_SHADOW_EXCLUDED_KINDS,
    ...TRIAGE_SHADOW_EXCLUDED_KIND_PREFIXES.map((prefix) => `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`),
    limit,
  ) as Array<{ seq: number }>;
  return {
    events: rows.map((row) => getEvent(db, row.seq)).filter((event): event is EventRecord => event !== undefined),
    highWater,
  };
}

// ── 判断 ────────────────────────────────────────────────────────────────────────────

export interface TriageShadowJudgmentInput {
  seq: number;
  eventId: string;
  judgedAt?: Date;
  // 问题集的版本（engine 的 TRIAGE_SHADOW_QUESTION_VERSION）。问题改了，旧判断和新判断分得开。
  questionVersion: number;
  backend: string;
  model: string | null;
  latencyMs: number | null;
  // Jev 判的重要程度（五个级别之一）和它的置信度。
  level: TriageLevel | null;
  levelConfidence: number | null;
  // 要 Lead 推理的概率。
  needsLead: number | null;
  // 能自动处理时是哪条常设指令；null 表示不能。
  autoAction: string | null;
  autoActionConfidence: number | null;
  risk: TriageShadowRisk | null;
  // 按概率加权的风险分，0（low）到 2（high）。
  riskScore: number | null;
  // 问的时候给了哪些指令的哪一版。
  actionOptions: StandingOrderRef[];
  // 完整的回答（每个选项的概率）。问不了时是 null。
  answers: Record<string, unknown> | null;
  error: string | null;
}

export interface TriageShadowJudgment extends Omit<TriageShadowJudgmentInput, "judgedAt"> {
  id: number;
  judgedAt: string;
  mode: string;
}

interface JudgmentRow {
  id: number; seq: number; event_id: string; judged_at: string; mode: string; question_version: number;
  backend: string; model: string | null; latency_ms: number | null; level: string | null;
  level_confidence: number | null; needs_lead: number | null; auto_action: string | null;
  auto_action_confidence: number | null; risk: string | null; risk_score: number | null;
  action_options: string; answers: string | null; error: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseJudgment(row: JudgmentRow): TriageShadowJudgment {
  return {
    id: row.id,
    seq: row.seq,
    eventId: row.event_id,
    judgedAt: row.judged_at,
    mode: row.mode,
    questionVersion: row.question_version,
    backend: row.backend,
    model: row.model,
    latencyMs: row.latency_ms,
    level: isTriageLevel(row.level) ? row.level : null,
    levelConfidence: row.level_confidence,
    needsLead: row.needs_lead,
    autoAction: row.auto_action,
    autoActionConfidence: row.auto_action_confidence,
    risk: (TRIAGE_SHADOW_RISK_TIERS as readonly string[]).includes(row.risk ?? "") ? row.risk as TriageShadowRisk : null,
    riskScore: row.risk_score,
    actionOptions: parseJson<StandingOrderRef[]>(row.action_options, []),
    answers: parseJson<Record<string, unknown> | null>(row.answers, null),
    error: row.error,
  };
}

const probability = (value: number | null): number | null =>
  value === null || (Number.isFinite(value) && value >= 0 && value <= 1) ? value : null;

/**
 * 记一条影子判断。同一个事件已经有判断时不写，返回 false。
 * 只写这张表：不碰 events（影子模式只记录）。
 */
export function recordTriageShadowJudgment(db: Db, input: TriageShadowJudgmentInput): boolean {
  if (input.level !== null && !isTriageLevel(input.level)) throw new Error(`影子判断的级别 ${String(input.level)} 不是分诊级别`);
  if (input.risk !== null && !(TRIAGE_SHADOW_RISK_TIERS as readonly string[]).includes(input.risk)) {
    throw new Error(`影子判断的风险 ${String(input.risk)} 不是 ${TRIAGE_SHADOW_RISK_TIERS.join("、")} 之一`);
  }
  return db.prepare(
    `INSERT INTO event_triage_shadow (
       seq, event_id, judged_at, mode, question_version, backend, model, latency_ms, level, level_confidence,
       needs_lead, auto_action, auto_action_confidence, risk, risk_score, action_options, answers, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(seq) DO NOTHING`,
  ).run(
    input.seq, input.eventId, (input.judgedAt ?? new Date()).toISOString(), TRIAGE_SHADOW_MODE, input.questionVersion,
    input.backend, input.model, input.latencyMs, input.level, probability(input.levelConfidence), probability(input.needsLead),
    input.autoAction, probability(input.autoActionConfidence), input.risk, input.riskScore,
    JSON.stringify(input.actionOptions), input.answers === null ? null : JSON.stringify(input.answers), input.error,
  ).changes > 0;
}

export function getTriageShadowJudgment(db: Db, seq: number): TriageShadowJudgment | undefined {
  const row = db.prepare("SELECT * FROM event_triage_shadow WHERE seq = ?").get(seq) as JudgmentRow | undefined;
  return row ? parseJudgment(row) : undefined;
}

// ── 对照 ────────────────────────────────────────────────────────────────────────────

/**
 * Lead 自己记下的处置，对应到「要不要 Lead 推理」（spec D5）。
 * 处理了、告诉用户了、打断用户了、延后了：要；判断不用管（no_action）：不要。
 * 系统记的处置不算（handled_by_rule、auto_handled、digested、superseded、resolved_elsewhere），
 * 回合成功后系统补记的「看过了」（seen）也不算：Lead 没有表态。
 */
export const LEAD_DISPOSITION_NEEDS_LEAD: Readonly<Partial<Record<EventDisposition, boolean>>> = {
  handled: true,
  told_user: true,
  interrupted_user: true,
  deferred: true,
  no_action: false,
};

/**
 * 有处置的事件里，只有这些还是影子分诊的候选：Lead 记的处置，和回合成功后系统补记的「看过了」。
 * 系统记的处置（handled_by_rule、auto_handled、superseded、resolved_elsewhere、digested）表示系统已经处理掉了，不问 Jev。
 * 写入时就有处置的事件都属于这一类（遥测记 handled_by_rule，按根因合并的记 superseded），所以都不问。
 * 不按「写入时」判断而按处置的种类判断：Jev 停了一阵以后，Lead 在这期间处置过的事件仍然要问，它们正是对照的样本。
 */
export const TRIAGE_SHADOW_CANDIDATE_DISPOSITIONS: readonly EventDisposition[] = [
  ...(Object.keys(LEAD_DISPOSITION_NEEDS_LEAD) as EventDisposition[]), "seen",
];

/** 一个事件的影子判断，和它实际的级别、处置。 */
export interface TriageShadowComparison {
  seq: number;
  kind: string;
  actualLevel: EventLevel | null;
  disposition: EventDisposition | null;
  shadowLevel: TriageLevel | null;
  needsLead: number | null;
  error: string | null;
}

export interface TriageShadowAgreement {
  // 能比较的事件数和一致的事件数。rate 是 agreed / compared，保留 3 位小数；没有能比较的事件时是 null。
  compared: number;
  agreed: number;
  rate: number | null;
}

export interface TriageShadowKindStats {
  kind: string;
  // 有判断的事件数（不含问不了的）。
  judged: number;
  // 问不了的事件数（输入不合法）。
  failed: number;
  // Jev 判的级别和实际级别相同。
  level: TriageShadowAgreement;
  // 在有 Lead 处置的事件上，「要不要 Lead 推理」和 Lead 的处置一致。
  needsLead: TriageShadowAgreement;
  // Jev 判的级别、实际级别各有几个。
  shadowLevels: Record<string, number>;
  actualLevels: Record<string, number>;
}

export interface TriageShadowReportStats {
  total: Omit<TriageShadowKindStats, "kind">;
  // 按事件类型，类型名从小到大。
  kinds: TriageShadowKindStats[];
}

function agreement(compared: number, agreed: number): TriageShadowAgreement {
  return { compared, agreed, rate: compared ? Math.round((agreed / compared) * 1000) / 1000 : null };
}

/**
 * 一致率（纯函数）。needsLeadThreshold：要 Lead 推理的概率不小于它时，算 Jev 说「要」，缺省 0.5。
 * 级别：有判断、有实际级别的事件都比较。要不要 Lead 推理：只比较处置在 LEAD_DISPOSITION_NEEDS_LEAD 里的事件。
 */
export function computeTriageShadowReport(
  comparisons: readonly TriageShadowComparison[], options: { needsLeadThreshold?: number } = {},
): TriageShadowReportStats {
  const threshold = options.needsLeadThreshold ?? 0.5;
  type Tally = {
    judged: number; failed: number; levelCompared: number; levelAgreed: number; leadCompared: number; leadAgreed: number;
    shadowLevels: Record<string, number>; actualLevels: Record<string, number>;
  };
  const empty = (): Tally => ({
    judged: 0, failed: 0, levelCompared: 0, levelAgreed: 0, leadCompared: 0, leadAgreed: 0, shadowLevels: {}, actualLevels: {},
  });
  const total = empty();
  const byKind = new Map<string, Tally>();
  for (const comparison of comparisons) {
    const tally = byKind.get(comparison.kind) ?? empty();
    byKind.set(comparison.kind, tally);
    for (const target of [tally, total]) {
      if (comparison.error !== null || comparison.shadowLevel === null) {
        target.failed++;
        continue;
      }
      target.judged++;
      target.shadowLevels[comparison.shadowLevel] = (target.shadowLevels[comparison.shadowLevel] ?? 0) + 1;
      if (comparison.actualLevel !== null) {
        target.actualLevels[comparison.actualLevel] = (target.actualLevels[comparison.actualLevel] ?? 0) + 1;
        target.levelCompared++;
        if (comparison.actualLevel === comparison.shadowLevel) target.levelAgreed++;
      }
      const actualNeedsLead = comparison.disposition === null ? undefined : LEAD_DISPOSITION_NEEDS_LEAD[comparison.disposition];
      if (actualNeedsLead !== undefined && comparison.needsLead !== null) {
        target.leadCompared++;
        if ((comparison.needsLead >= threshold) === actualNeedsLead) target.leadAgreed++;
      }
    }
  }
  const stats = (tally: Tally): Omit<TriageShadowKindStats, "kind"> => ({
    judged: tally.judged,
    failed: tally.failed,
    level: agreement(tally.levelCompared, tally.levelAgreed),
    needsLead: agreement(tally.leadCompared, tally.leadAgreed),
    shadowLevels: tally.shadowLevels,
    actualLevels: tally.actualLevels,
  });
  return {
    total: stats(total),
    kinds: [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([kind, tally]) => ({ kind, ...stats(tally) })),
  };
}

const MAX_COMPARISONS = 10_000;

/** 时间范围里（按事件收到的时间，含 since，不含 until）有影子判断的事件，和它们实际的级别、处置。最多 limit 条，从旧到新。 */
export function listTriageShadowComparisons(
  db: Db, query: { since: Date; until: Date; limit?: number },
): TriageShadowComparison[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? MAX_COMPARISONS), 1), MAX_COMPARISONS);
  return (db.prepare(
    `SELECT e.seq, e.kind, e.level AS actual_level, e.disposition, s.level AS shadow_level, s.needs_lead, s.error
     FROM event_triage_shadow s JOIN events e ON e.seq = s.seq
     WHERE e.received_at >= ? AND e.received_at < ?
     ORDER BY e.seq LIMIT ?`,
  ).all(query.since.toISOString(), query.until.toISOString(), limit) as Array<{
    seq: number; kind: string; actual_level: string | null; disposition: string | null;
    shadow_level: string | null; needs_lead: number | null; error: string | null;
  }>).map((row) => ({
    seq: row.seq,
    kind: row.kind,
    actualLevel: row.actual_level as EventLevel | null,
    disposition: row.disposition as EventDisposition | null,
    shadowLevel: isTriageLevel(row.shadow_level) ? row.shadow_level : null,
    needsLead: row.needs_lead,
    error: row.error,
  }));
}

export interface TriageShadowReport extends TriageShadowReportStats {
  since: string;
  until: string;
  // 判断条数到了上限，后面的没算进来。
  truncated: boolean;
  // 现在的启用开关。
  switch: JevTriageSwitch;
}

/** 影子分诊的对照报告：时间范围里的判断和实际处置，按事件类型算一致率。只读。 */
export function triageShadowReport(db: Db, query: { since: Date; until: Date }): TriageShadowReport {
  const comparisons = listTriageShadowComparisons(db, { ...query, limit: MAX_COMPARISONS + 1 });
  const truncated = comparisons.length > MAX_COMPARISONS;
  return {
    since: query.since.toISOString(),
    until: query.until.toISOString(),
    truncated,
    ...computeTriageShadowReport(truncated ? comparisons.slice(0, MAX_COMPARISONS) : comparisons),
    switch: jevTriageSwitch(db),
  };
}

// ── 启用开关 ────────────────────────────────────────────────────────────────────────

export interface JevTriageSwitch {
  // 现在真正启用的事件类型。
  enabledKinds: string[];
  // 现在这一版里写的类型。这一版不是用户写的、也没有用户批准时，它们不算数。
  requestedKinds: string[];
  // 这一版是用户写的，或者有批准人。
  approved: boolean;
  order: StandingOrderRef;
}

/**
 * Jev 分诊的启用开关（常设指令 triage.jev）。缺省（系统种子）全部关闭。
 * 只有用户写的、或者用户批准过的版本里的类型算数（spec D12：一致率达标的类别由用户批准后才启用）：
 * Lead 自己写的放开（工单 10）不经批准不生效。最新版本停用了、读不到时，用种子，也就是全部关闭。
 */
export function jevTriageSwitch(db: Db): JevTriageSwitch {
  const order = ruleStandingOrder(db, "triage.jev");
  const params = order.action.type === "rule" ? order.action.params as { enabledKinds?: unknown } : {};
  const requested = Array.isArray(params.enabledKinds)
    ? [...new Set(params.enabledKinds.filter((kind): kind is string => typeof kind === "string" && kind.length > 0))]
    : [];
  const approved = order.author === "user" || Boolean(order.approvedBy);
  return { enabledKinds: approved ? requested : [], requestedKinds: requested, approved, order: standingOrderRef(order) };
}

/** 这种事件由 Jev 定级别吗。第 1 期只用来报告：启用以后的行为由以后的工单实现。 */
export function isJevTriageEnabled(db: Db, kind: string): boolean {
  return jevTriageSwitch(db).enabledKinds.includes(kind);
}

// 自动代你处理（2026-10-23，设置 → 消息通道，方案 C，.scratch/confidence-model/panel-design.md）：面板和 Lead 用的计算。
//   - confidenceParamsFrom：常设指令里的一整份（开关、授权表、信心模型的参数）→ 信心模型的参数。hub 和测试用同一个。
//   - judgePolicyCase：一条打过分的消息，按给的参数算结论：能否代处理（看授权表和底线，不看信心）、能否代回、一票否决、
//     落在哪一档、信心的每一项。纯函数，不调模型，不发任何东西。
//   - scoreTestMessage：一条消息（你写的，或者面板上的例子），让请求 A 判断意图、要不要回、话题和敏感查询；写了草稿时
//     请求 B 给草稿打分。每次都真的问模型，记下哪个后端回答的、用了多久。只读。
//   - pastChannelMessages、judgePastMessages：过去 24 小时别人发来的消息，用请求 A 当时的结果重建模型的输入，
//     按两份参数各算一遍（2026-10-24 用户：评估过去 24 小时的消息）。草稿的分数由 hub 补上（记下的，或者现在调请求 B）。
// 这里不出现任何具体来源的名字。
import {
  CHANNEL_EVENT_KINDS, CHANNEL_INTENT_LABELS, CHANNEL_POLICY_DEFAULTS, isChannelClosingKind, isChannelIntent, isSenderTrust,
  type ChannelHandbook, type ChannelIntent, type ChannelPolicyDto, type ChannelPolicyModelCall, type ChannelPolicyParams, type ChannelPolicyReplayResult,
  type ChannelPolicyScoredCase, type ChannelPolicyTestResult, type SenderTrust,
} from "@pi-lead-child/protocol";
import { channelPolicy, getChannelCard, getEvent, getLatestLookupForCard, type Db } from "@pi-lead-child/store";
import { LLM_BACKEND } from "../smart-model/llm.js";
import type { SmartModel, SmartTextComplete } from "../smart-model/types.js";
import { calibrationFromLabels } from "./calibration.js";
import {
  CONFIDENCE_MODEL_DEFAULTS, evaluateConfidenceModel,
  type ConfidenceModelInput, type ConfidenceModelParams, type ConfidenceModelResult,
} from "./confidence-model.js";
import { judgeChannelIntake, SENSITIVE_QUERY_LABELS, type ChannelLookupCandidate } from "./intake.js";
import { draftOnlyResult, judgeReplyCheck } from "./reply-check.js";

/** 常设指令里的一整份 → 信心模型的参数。noReplyBelow 给了时（hub 的选项、测试）用它。 */
export function confidenceParamsFrom(policy: ChannelPolicyParams, options: { noReplyBelow?: number } = {}): ConfidenceModelParams {
  const confidence = policy.confidence;
  return {
    ...CONFIDENCE_MODEL_DEFAULTS,
    autoReply: policy.autoReply,
    noReplyBelow: options.noReplyBelow ?? confidence.noReplyBelow,
    weights: { ...confidence.weights },
    tierThresholds: [1, ...confidence.tiers] as unknown as ConfidenceModelParams["tierThresholds"],
    priorStrength: confidence.priorStrength,
    coldStartTiers: confidence.coldStartTiers,
    lockMode: confidence.lockMode,
    authority: policy.intents,
    tuning: { ...confidence.tuning },
  };
}

/** 这个来源带标签的样本（calibration.ts）：不分任务，按打分时原始信心的分数段加权。 */
export function channelCalibration(db: Db, source: string): ConfidenceModelInput["calibration"] {
  const rows = db.prepare(
    `SELECT json_extract(payload, '$.bucket') AS bucket, json_extract(payload, '$.value') AS value, json_extract(payload, '$.weight') AS weight
     FROM events WHERE kind = ? AND source = 'system' AND json_valid(payload) AND json_extract(payload, '$.channel') = ?`,
  ).all(CHANNEL_EVENT_KINDS.replyLabeled, source) as Array<{ bucket: unknown; value: unknown; weight: unknown }>;
  return calibrationFromLabels(rows.flatMap((row) => typeof row.bucket === "number" && typeof row.weight === "number"
    && (row.value === 0 || row.value === 1 || row.value === null) ? [{ bucket: row.bucket, value: row.value, weight: row.weight }] : []));
}

// ── 结论 ──────────────────────────────────────────────────────────────────────────

const WORK_INTENTS = new Set(["code_review", "approve", "knowledge", "progress"]);

/** 打过分的消息 → 信心模型的输入。测试的消息没有卡，按「卡开着、刚查完、没有新消息」算。 */
export function inputFromScored(scored: ChannelPolicyScoredCase, calibration: ConfidenceModelInput["calibration"]): ConfidenceModelInput {
  return {
    intent: scored.intent,
    draft: scored.draftText.trim().length > 0,
    found: scored.found,
    scores: { ...scored.scores, topics: { ...scored.scores.topics } },
    facts: {
      audience: scored.facts.audience, members: scored.facts.members, externalShared: scored.facts.externalShared,
      senderTrust: scored.facts.senderTrust as SenderTrust, bot: false, scoredBy: scored.scoredBy,
      retractable: true, canReply: true, sources: scored.facts.sources, newerMessages: 0, resultAgeMs: 0, cardOpen: true, approval: null,
    },
    calibration,
  };
}

type Answer = { ok: boolean; text: string };

function canHandle(result: ConfidenceModelResult, scored: ChannelPolicyScoredCase, params: ConfidenceModelParams): Answer {
  const intent = scored.intent?.kind ?? "other";
  const label = CHANNEL_INTENT_LABELS[intent];
  if (result.decision === "skip") return { ok: false, text: "不打扰：只记录" };
  if (result.decision === "refuse") return { ok: true, text: "用固定的话代你拒绝" };
  if (result.decision === "remind") return { ok: false, text: "不代做：只提醒你" };
  if (!params.autoReply) return { ok: false, text: "自动代你处理关着：一律问你" };
  if (scored.facts.senderTrust === "customer") return { ok: false, text: "发信人是外部客户" };
  if (scored.facts.externalShared !== false) return { ok: false, text: "这是和外部组织共享的对话（或者问不到）" };
  const action = params.authority[intent]?.action ?? "ask";
  if (!WORK_INTENTS.has(intent)) {
    if (intent === "closing" && action === "auto") return { ok: true, text: "回个表情或者说一句" };
    return { ok: false, text: `授权表里「${label}」是问你` };
  }
  if (action !== "auto") return { ok: false, text: `授权表里「${label}」是问你` };
  return { ok: true, text: `派给 Lead 开工单${intent === "code_review" ? "去 review" : intent === "approve" ? "，检查以后 approve" : "去查"}` };
}

function canReply(result: ConfidenceModelResult): Answer {
  if (result.decision === "auto_send" || result.decision === "approve") return { ok: true, text: "不问你，直接发" };
  if (result.decision === "react") return { ok: true, text: "只回个表情，不发文字" };
  if (result.decision === "refuse") return { ok: true, text: "只发固定的拒绝" };
  if (result.decision === "skip") return { ok: false, text: "只记录" };
  if (result.decision === "remind") return { ok: false, text: "提醒你" };
  return { ok: false, text: result.reasons[0] ?? (result.decision === "hand_over" ? "交给你" : "问你") };
}

const FOUND_WORDS: Record<ChannelPolicyScoredCase["found"], string> = {
  yes: "查到了", partial: "只查到一部分", no: "没查到", failed: "代查失败", not_needed: "还没代查",
};

function readable(detail: string): string {
  return Object.entries(SENSITIVE_QUERY_LABELS).reduce((text, [key, word]) => text.replaceAll(key, word), detail);
}

function vetoesOf(result: ConfidenceModelResult, scored: ChannelPolicyScoredCase): ChannelPolicyTestResult["vetoes"] {
  const intent = scored.intent?.kind ?? "other";
  const reasons = result.reasons.join("；");
  const vetoes: ChannelPolicyTestResult["vetoes"] = [];
  if (WORK_INTENTS.has(intent)) {
    vetoes.push({ label: "查到了", value: FOUND_WORDS[scored.found], pass: scored.found === "yes", note: null });
    const sources = scored.facts.sources;
    vetoes.push({ label: "有核实过的出处", value: `${sources.verified}/${sources.total} 处`, pass: sources.verified >= 1, note: null });
  }
  for (const lock of result.locks) {
    const always = lock.id === "customer" || lock.id === "external_shared";
    const blocked = reasons.includes(`底线：${lock.label}`) || (always && lock.hit);
    vetoes.push({
      label: lock.label,
      value: always ? lock.detail : `${readable(lock.detail)}（到 50% 拦）`,
      pass: !blocked,
      note: lock.hit && !blocked ? "review 和 approve 不算这一项" : null,
    });
  }
  return vetoes;
}

/** 一条打过分的消息，按给的参数算结论。纯函数。 */
export function judgePolicyCase(
  scored: ChannelPolicyScoredCase, params: ConfidenceModelParams, calibration: ConfidenceModelInput["calibration"], scoreError: string | null = null,
  calls: ChannelPolicyModelCall[] = [],
): ChannelPolicyTestResult {
  const result = evaluateConfidenceModel(inputFromScored(scored, calibration), params);
  const [audience, ...steps] = result.cost.steps;
  return {
    scored,
    scoreError,
    calls,
    decision: result.decision,
    handle: canHandle(result, scored, params),
    reply: canReply(result),
    confidence: result.confidence,
    raw: result.raw,
    threshold: result.threshold,
    tier: {
      level: result.cost.level,
      base: audience ? `${audience.detail}，起步 L${audience.levels}` : `起步 L${result.cost.base}`,
      steps: steps.map((step) => `${step.label} +${step.levels}（${readable(step.detail)}）`),
    },
    factors: result.factors.map((factor) => ({ ...factor })),
    calibration: result.calibration,
    vetoes: vetoesOf(result, scored),
    reasons: result.reasons.map(readable),
  };
}

// ── 给一条消息打分 ────────────────────────────────────────────────────────────────

const LANE_LABELS: Record<ChannelPolicyScoredCase["facts"]["audience"], string> = {
  dm: "1 对 1 私信", group_dm: "群聊", private_channel: "私有频道", public_channel: "公开频道",
};

/**
 * 一条消息：请求 A 判断意图、要不要回、话题和敏感查询；写了草稿时请求 B 给草稿打分（按「没有查过材料」打）。
 * 每次都真的问模型（没有模型时不问），calls 记下哪个后端回答的、用了多久。只读，不发任何东西。
 * 模型问不成时，分数是 null，error 写原因（结论照算：缺必要维度时问你）。
 */
export async function scoreTestMessage(input: {
  text: string; audience: ChannelPolicyScoredCase["facts"]["audience"]; sender: "colleague" | "external" | "customer";
  draft: string; assumeFound: boolean; model: SmartModel | null; candidates: readonly ChannelLookupCandidate[];
  userName: string | null; businessMap: string | null; handbook?: ChannelHandbook; timeoutMs?: number; now?: () => number;
  // 决策模型没有配置或者失败时，收件判断改用的 Lead 的便宜模型（issue 10）。
  textModel?: SmartTextComplete | null;
}): Promise<{ scored: ChannelPolicyScoredCase; error: string | null; calls: ChannelPolicyModelCall[] }> {
  const now = input.now ?? Date.now;
  const calls: ChannelPolicyModelCall[] = [];
  const startedA = now();
  const intake = await judgeChannelIntake({
    intake: {
      text: input.text, recent: [], senderTrust: input.sender, laneLabel: LANE_LABELS[input.audience], userName: input.userName,
      businessMap: input.businessMap, candidates: input.candidates, ...(input.handbook ? { handbook: input.handbook } : {}),
    },
    model: input.model,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    text: input.textModel ?? null,
  });
  const answered = intake.status === "answered";
  if (input.model) {
    calls.push({
      request: "A", backend: intake.backend, model: intake.model, ms: Math.max(0, now() - startedA), ok: answered,
      error: answered ? null : intake.error ?? "没有回答",
    });
  }
  const draft = input.draft.trim();
  const startedB = now();
  const check = draft ? await judgeReplyCheck({
    question: input.text, result: draftOnlyResult(draft), lookedUp: false, model: input.model,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  }) : null;
  if (check && input.model) {
    calls.push({ request: "B", backend: check.backend, model: null, ms: Math.max(0, now() - startedB), ok: check.ok, error: check.ok ? null : check.error ?? "没有回答" });
  }
  const errors = [answered ? null : `请求 A：${intake.error ?? "没有回答"}`, check && !check.ok ? `请求 B：${check.error ?? "没有回答"}` : null]
    .filter((line): line is string => line !== null);
  const work = answered && intake.askKind !== null && WORK_INTENTS.has(intake.askKind);
  return {
    scored: {
      text: input.text,
      draftText: draft,
      intent: answered && intake.askKind ? { kind: intake.askKind, closing: intake.closing } : null,
      found: work && input.assumeFound ? "yes" : "not_needed",
      scores: {
        needsReply: intake.needsReply, askConfidence: intake.askConfidence,
        fulfills: check?.ok ? check.fulfillsRequest : null, grounded: check?.ok ? check.grounded : null,
        draftCommits: check?.ok ? check.draftCommits : null, draftOvershares: check?.ok ? check.draftOvershares : null,
        topics: { ...intake.topics }, sensitiveQueries: answered ? { ...intake.sensitive } as Record<string, number> : null,
      },
      facts: {
        audience: input.audience, members: null, externalShared: input.sender === "external" ? true : false, senderTrust: input.sender,
        sources: work && input.assumeFound ? { total: 1, verified: 1 } : { total: 0, verified: 0 },
      },
      scoredBy: check?.ok && check.backend !== LLM_BACKEND ? "jev" : "fallback",
    },
    error: errors.length ? errors.join("；") : null,
    calls,
  };
}

// ── 过去 24 小时的消息 ────────────────────────────────────────────────────────────

/** 草稿的四个分数（请求 B），和是不是 Jev 打的。 */
export interface DraftScores {
  fulfills: number | null;
  grounded: number | null;
  draftCommits: number | null;
  draftOvershares: number | null;
  scoredBy: "jev" | "fallback";
}

/** 过去一条别人发来的消息：请求 A 当时的结果和场景已经填进 scored，草稿的四个分数是 null，由调用方补上。 */
export interface PastChannelMessage {
  // 请求 A 的事件（channel.intake.decided）。
  seq: number;
  // 消息本身的事件。
  forSeq: number;
  cardId: number | null;
  at: string;
  sender: string;
  // 卡上给这条消息的草稿。
  draft: { text: string; at: string } | null;
  // 打分时记下的草稿分数（channel.reply.scored 的 input，2026-10-23 起记）。没有时是 null。
  recorded: DraftScores | null;
  scored: ChannelPolicyScoredCase;
  // 当时授权表的决定。
  then: string | null;
}

const PAST_TEXT_MAX = 200;
const AUTHORITY_WORDS: Record<string, string> = {
  skip: "不打扰", react: "回表情", refuse: "代你拒绝", remind: "提醒你", closing_reply: "代你说一句", work: "要干活", ask: "问你",
};
const DECISION_WORDS: Record<string, string> = {
  auto_send: "代你回复", approve: "代你 approve", react: "回表情", refuse: "代你拒绝", remind: "提醒你", ask_user: "问你",
  hand_over: "交给你", skip: "只记录",
};

const clip = (text: string, max = PAST_TEXT_MAX) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const probability = (value: unknown) => (typeof value === "number" && value >= 0 && value <= 1 ? value : null);
const objectOf = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const numbers = (value: unknown) => Object.fromEntries(Object.entries(objectOf(value) ?? {})
  .filter((entry): entry is [string, number] => probability(entry[1]) !== null));

// 请求 A 的意图。第 3 版以前的事件：lookup 读成业务和技术咨询，review 读成代码 review。
function pastIntent(value: unknown): ChannelIntent | null {
  if (isChannelIntent(value)) return value;
  return value === "lookup" ? "knowledge" : value === "review" ? "code_review" : null;
}

function eventsSince(db: Db, kind: string, source: string, since: Date): Map<number, Record<string, unknown>> {
  const rows = db.prepare(
    `SELECT payload FROM events
     WHERE kind = ? AND source = 'system' AND occurred_at >= ? AND json_valid(payload) AND json_extract(payload, '$.channel') = ?`,
  ).all(kind, since.toISOString(), source) as Array<{ payload: string }>;
  const byMessage = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof payload.forSeq === "number") byMessage.set(payload.forSeq, payload);
  }
  return byMessage;
}

function cardOfMessage(db: Db, objectKey: string | null, seq: number): number | null {
  if (!objectKey) return null;
  const row = db.prepare("SELECT id FROM channel_cards WHERE object_key = ? AND first_seq <= ? AND last_seq >= ? ORDER BY id DESC LIMIT 1")
    .get(objectKey, seq, seq) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * 过去一段时间里别人发来、请求 A 判断过的消息（channel.intake.decided），新的在前，最多 limit 条。
 * 用请求 A 当时的结果、消息的场景（私信还是频道、是不是外部共享、发信人）、卡上的草稿和代查的结果，重建信心模型的输入。
 * 只读，不调模型。
 */
export function pastChannelMessages(db: Db, source: string, since: Date, until: Date, limit = 200): PastChannelMessage[] {
  const rows = db.prepare(
    `SELECT seq, occurred_at AS at, payload FROM events
     WHERE kind = ? AND source = 'system' AND occurred_at >= ? AND occurred_at <= ? AND json_valid(payload)
       AND json_extract(payload, '$.channel') = ? AND json_extract(payload, '$.status') = 'answered'
     ORDER BY seq DESC LIMIT ?`,
  ).all(CHANNEL_EVENT_KINDS.intakeDecided, since.toISOString(), until.toISOString(), source, limit) as Array<{ seq: number; at: string; payload: string }>;
  const authority = eventsSince(db, CHANNEL_EVENT_KINDS.authorityDecided, source, since);
  const scoredDrafts = eventsSince(db, CHANNEL_EVENT_KINDS.replyScored, source, since);
  const past: PastChannelMessage[] = [];
  for (const row of rows) {
    const intake = JSON.parse(row.payload) as Record<string, unknown>;
    const forSeq = typeof intake.forSeq === "number" ? intake.forSeq : null;
    const message = forSeq === null ? undefined : getEvent(db, forSeq);
    if (forSeq === null || !message) continue;
    const payload = message.payload;
    const sender = objectOf(payload.sender);
    // 请求 A 记下时卡常常还没开（cardId 是 null）：按对话和消息的范围找卡。
    const cardId = typeof intake.cardId === "number" ? intake.cardId : cardOfMessage(db, message.entityKey, forSeq);
    const card = cardId === null ? undefined : getChannelCard(db, cardId);
    // 模板的草稿（固定的「收到，谢谢」）从来不代你发，不算。
    const draft = card?.draft && card.draft.forSeq === forSeq && card.draft.drafter !== "template" && card.draft.text.trim()
      ? { text: card.draft.text, at: card.draft.at } : null;
    const lookup = cardId === null ? undefined : getLatestLookupForCard(db, cardId);
    const looked = lookup && lookup.forSeq === forSeq ? lookup : undefined;
    const found: ChannelPolicyScoredCase["found"] = !looked ? "not_needed"
      : looked.result ? looked.result.found : looked.state === "failed" ? "failed" : "no";
    const sources = looked?.verification?.sources ?? { total: 0, verified: 0 };
    const recordedInput = objectOf(scoredDrafts.get(forSeq)?.input);
    const recordedScores = objectOf(recordedInput?.scores);
    const recorded: DraftScores | null = recordedScores && draft ? {
      fulfills: probability(recordedScores.fulfills), grounded: probability(recordedScores.grounded),
      draftCommits: probability(recordedScores.draftCommits), draftOvershares: probability(recordedScores.draftOvershares),
      scoredBy: objectOf(recordedInput?.facts)?.scoredBy === "jev" ? "jev" : "fallback",
    } : null;
    const intent = pastIntent(intake.askKind);
    const trust = isSenderTrust(sender?.trust) ? sender.trust : "unknown";
    const audience = payload.audience;
    const action = authority.get(forSeq)?.action;
    past.push({
      seq: row.seq, forSeq, cardId, at: row.at,
      sender: typeof sender?.name === "string" ? clip(sender.name, 60) : "对方",
      draft, recorded,
      scored: {
        text: clip(typeof payload.text === "string" ? payload.text : ""),
        draftText: draft ? clip(draft.text) : "",
        intent: intent ? { kind: intent, closing: isChannelClosingKind(intake.closing) ? intake.closing : null } : null,
        found,
        scores: {
          needsReply: probability(intake.needsReply), askConfidence: probability(intake.askConfidence),
          fulfills: null, grounded: null, draftCommits: null, draftOvershares: null,
          topics: numbers(intake.topics), sensitiveQueries: objectOf(intake.sensitive) ? numbers(intake.sensitive) : null,
        },
        facts: {
          audience: audience === "direct" ? "dm" : audience === "group" ? "group_dm" : "public_channel",
          members: null,
          externalShared: typeof payload.externalShared === "boolean" ? payload.externalShared : null,
          senderTrust: trust,
          sources: { total: Math.min(sources.total, 100), verified: Math.min(sources.verified, 100) },
        },
        scoredBy: "fallback",
      },
      then: typeof action === "string" ? AUTHORITY_WORDS[action] ?? action : null,
    });
  }
  return past;
}

/** 一条过去的消息补上草稿的分数以后，按两份参数各算一遍（before 现在生效的，after 你改的）。纯函数。 */
export function judgePastMessages(
  messages: ReadonlyArray<{ message: PastChannelMessage; draft: DraftScores | null; scoring: ChannelPolicyReplayResult["items"][number]["scoring"] }>,
  before: ConfidenceModelParams, after: ConfidenceModelParams, calibration: ConfidenceModelInput["calibration"],
): Pick<ChannelPolicyReplayResult, "total" | "before" | "after" | "items"> {
  const result: Pick<ChannelPolicyReplayResult, "total" | "before" | "after" | "items"> = {
    total: messages.length, before: { handle: 0, reply: 0 }, after: { handle: 0, reply: 0 }, items: [],
  };
  for (const { message, draft, scoring } of messages) {
    const scored: ChannelPolicyScoredCase = draft ? {
      ...message.scored,
      scores: { ...message.scored.scores, fulfills: draft.fulfills, grounded: draft.grounded, draftCommits: draft.draftCommits, draftOvershares: draft.draftOvershares },
      scoredBy: draft.scoredBy,
    } : message.scored;
    const outcome = (params: ConfidenceModelParams) => {
      const judged = judgePolicyCase(scored, params, calibration);
      return { decision: DECISION_WORDS[judged.decision] ?? judged.decision, handle: judged.handle.ok, reply: judged.reply.ok, why: judged.reply.text };
    };
    const x = outcome(before);
    const y = outcome(after);
    if (x.handle) result.before.handle++;
    if (x.reply) result.before.reply++;
    if (y.handle) result.after.handle++;
    if (y.reply) result.after.reply++;
    result.items.push({
      seq: message.seq, cardId: message.cardId, at: message.at, sender: message.sender, text: message.scored.text,
      intent: CHANNEL_INTENT_LABELS[message.scored.intent?.kind ?? "other"], draft: message.draft ? message.scored.draftText : null,
      scoring, before: x, after: y, then: message.then,
    });
  }
  return result;
}

/** 打分时记下的模型输入（channel.reply.scored 的 input）：不含校准，校准按重算时的样本算。 */
export function scoredInputRecord(input: Omit<ConfidenceModelInput, "calibration">): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

/** 面板读的样子（GET /v1/channels/policy/:source）：现在生效的、最新版本里写的、缺省，和存在哪一条常设指令。 */
export function channelPolicyDto(db: Db, source: string): ChannelPolicyDto {
  const policy = channelPolicy(db, source);
  if (!policy) {
    return { source, params: CHANNEL_POLICY_DEFAULTS, requested: CHANNEL_POLICY_DEFAULTS, defaults: CHANNEL_POLICY_DEFAULTS, order: null };
  }
  return {
    source,
    params: policy.params,
    requested: policy.requested,
    defaults: CHANNEL_POLICY_DEFAULTS,
    order: {
      id: policy.order.id, version: policy.order.version, author: policy.order.author, approvedBy: policy.order.approvedBy,
      createdAt: policy.order.createdAt ?? null, scope: policy.scope,
    },
  };
}

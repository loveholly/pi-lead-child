// Jev 分诊的影子模式（Lead 事件主干 spec D12，工单 09）：批处理。
//
// 规则层定不了级别的事件（级别来自来源的默认指令 source.*），daemon 每一拍调一次 tick()，按批问 SmartModel
// 一组固定的问题，判断记进 store 的影子表（event_triage_shadow），SmartModel 自己记决策日志（purpose 是 triage_shadow）。
//
// 不依赖事件写入的钩子：每一批从游标（kv，和 Lead 的游标分开）往后读日志，取还没有影子判断的候选事件。
// 规则：
//   - 影子模式只记录：不改事件的 level、triage、disposition，不写新的事件，不影响分诊。
//   - 不阻塞：tick() 同步返回，问 Jev 在后台进行；同一时间最多一批。每一批有数量上限和时间预算，每次调用有超时。
//     调用方不理会取消时，raceAbort 照样按时放弃等待。
//   - SmartModel 不可用（没有配置、没有后端）时这一批跳过，不读日志。调用失败或超时时这一批停下，游标停在最后一个
//     判断成功的事件上，下一拍（retryBaseMs 之后，连续失败时翻倍）再试。输入不合法（换后端也没用）时记一行带错误的判断，
//     跳过这个事件。
//   - 送出去的文字只有事件的类型、来源、对象键、根因代码和摘要，每一项先脱敏（redactAndCap）再截断。
//   - 只用 SmartModel 的公开接口 decide，不改它的调用路径。
import {
  redactAndCap, TRIAGE_LEVELS,
  type StandingOrder, type StandingOrderRef, type StandingOrderRule, type TriageLevel,
} from "@pi-lead-child/protocol";
import {
  activeStandingOrders, getTriageShadowCursor, listTriageShadowCandidates, recordTriageShadowJudgment,
  setTriageShadowCursor, standingOrderRef, TRIAGE_SHADOW_RISK_TIERS,
  type Db, type EventRecord, type TriageShadowJudgmentInput,
} from "@pi-lead-child/store";
import { errorText, raceAbort } from "./smart-model/deadline.js";
import { SMART_MODEL_LIMITS } from "./smart-model/questions.js";
import {
  SmartModelInputError,
  type ChoiceAnswer, type ChoiceQuestion, type ScoreAnswer, type ScoreQuestion, type SmartDecision, type SmartModel,
  type SmartQuestion, type YesNoAnswer, type YesNoQuestion,
} from "./smart-model/types.js";

/** 决策日志里的用途。 */
export const TRIAGE_SHADOW_PURPOSE = "triage_shadow";
/** 问题集的版本。改了问题（措辞、选项、分档）时加 1：报告按它分得开新旧判断。 */
export const TRIAGE_SHADOW_QUESTION_VERSION = 1;
/** 「能不能自动处理」的「不能」。常设指令的编号不会是这个样子（STANDING_ORDER_ID_PATTERN）。 */
export const TRIAGE_SHADOW_NO_ACTION = "(none)";

// 常设指令允许的、能直接处理掉一个事件的动作（规则）。别的规则只给参数（source.threshold）、只管时间
// （events.escalate_overdue、events.digest_batch），或者正好相反、要交给 Lead（inbox.wake_lead、model_catalog.announce），
// 不算自动处理。具体给哪几条指令，按现在生效的常设指令算。
export const TRIAGE_SHADOW_ACTION_RULES: readonly StandingOrderRule[] = [
  "run.transient_retry", "events.merge_root_cause", "inbox.merge_attention", "inbox.fuse_blockers", "reminder.fire",
];

const LEVEL_NOTES: Record<TriageLevel, string> = {
  record: "only keep it on file; nobody needs to look at it now",
  digest: "worth knowing but not worth a message of its own; include it in the next periodic summary",
  auto: "a standing order can handle it automatically without the assistant; mention it in the summary afterwards",
  tell: "the assistant should tell the user about it in a message of its own after its current turn",
  interrupt: "urgent: interrupt the assistant's current turn and push it to the user's phone",
};

const RISK_LEVELS: Record<(typeof TRIAGE_SHADOW_RISK_TIERS)[number], string> = {
  low: "low: read-only or easy to undo; getting it wrong costs little",
  medium: "medium: delays or misdirects one task, but it can be recovered",
  high: "high: irreversible, involves money, external messages, lost data, security, or blocks the user",
};

const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_CHARS = 200;
const SUMMARY_FIELDS = ["title", "summary", "note", "error", "reason", "body"] as const;

// 先脱敏再截断（2026-10-16 发布评审）：redactAndCap 截断时留了余量，跨在截断处的 token 也认得出。
function clean(text: string, max: number): string {
  const capped = redactAndCap(text.replace(/\s+/g, " ").trim(), max);
  return capped.truncated ? `${capped.text.slice(0, max - 1)}…` : capped.text;
}

/** 事件的一句摘要：payload 里的标题、摘要、说明、错误，以及 stage 或状态的变化。 */
export function triageShadowSummary(event: Pick<EventRecord, "payload">): string {
  const parts: string[] = [];
  for (const field of SUMMARY_FIELDS) {
    const value = event.payload[field];
    if (typeof value === "string" && value.trim() && !parts.includes(value.trim())) parts.push(value.trim());
  }
  const { from, to } = event.payload;
  if (typeof from === "string" && typeof to === "string" && from && to) parts.push(`${from} → ${to}`);
  return parts.join(" — ");
}

/** 送给 SmartModel 的状态文本：只有类型、来源、对象键、根因代码和摘要，每一项都脱敏。 */
export function triageShadowState(event: Pick<EventRecord, "kind" | "source" | "entityKey" | "rootCause" | "payload">): string {
  const summary = triageShadowSummary(event);
  return [
    `Event kind: ${clean(event.kind, MAX_FIELD_CHARS)}`,
    `Source: ${clean(event.source, MAX_FIELD_CHARS)}`,
    `Entity: ${clean(event.entityKey, MAX_FIELD_CHARS)}`,
    `Root cause code: ${event.rootCause?.code ? clean(event.rootCause.code, MAX_FIELD_CHARS) : "none"}`,
    `Summary: ${summary ? clean(summary, MAX_SUMMARY_CHARS) : "none"}`,
  ].join("\n");
}

/** 「能不能自动处理」可以选的指令：现在生效的、动作是 TRIAGE_SHADOW_ACTION_RULES 之一的常设指令。 */
export function triageShadowActionOrders(db: Db): StandingOrder[] {
  return activeStandingOrders(db).filter((order) => order.action.type === "rule"
    && TRIAGE_SHADOW_ACTION_RULES.includes(order.action.rule)
    && order.id.length <= SMART_MODEL_LIMITS.maxOptionChars);
}

/** 固定的问题集。actionOrders 是「能不能自动处理」的选项（另加一个「不能」）。 */
export function triageShadowQuestions(actionOrders: readonly StandingOrder[]): Record<string, SmartQuestion> {
  const importance: ChoiceQuestion = {
    type: "choice",
    prompt: "How should the user's personal assistant (Lead) treat this event?",
    options: [...TRIAGE_LEVELS],
    descriptions: { ...LEVEL_NOTES },
  };
  const needsLead: YesNoQuestion = {
    type: "yes_no",
    prompt: "Does Lead need to reason about this event itself (investigate, decide, or tell the user)?",
    yes: "the event is a problem, a decision, or news the user cares about, and no fixed rule can settle it",
    no: "the event is routine progress or bookkeeping that can be recorded or summarized without thinking about it",
  };
  const risk: ScoreQuestion = {
    type: "score",
    prompt: "What is the risk if this event is handled wrongly or ignored?",
    levels: TRIAGE_SHADOW_RISK_TIERS.map((tier) => RISK_LEVELS[tier]),
  };
  const questions: Record<string, SmartQuestion> = { importance, needs_lead: needsLead, risk };
  if (actionOrders.length) {
    questions.auto_action = {
      type: "choice",
      prompt: "Can one of these standing orders handle this event automatically, without Lead? Pick the one that fits, "
        + `or ${TRIAGE_SHADOW_NO_ACTION} if none of them can.`,
      options: [...actionOrders.map((order) => order.id), TRIAGE_SHADOW_NO_ACTION],
      descriptions: {
        ...Object.fromEntries(actionOrders.map((order) => [order.id, clean(order.title, SMART_MODEL_LIMITS.maxDescriptionChars)])),
        [TRIAGE_SHADOW_NO_ACTION]: "no standing order can handle it; it needs Lead or the user",
      },
    };
  }
  return questions;
}

interface TriageShadowAnswers {
  importance: ChoiceAnswer;
  needs_lead: YesNoAnswer;
  risk: ScoreAnswer;
  auto_action?: ChoiceAnswer;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** 把回答变成要记的判断。SmartModel 已经按问题的类型和选项校验过每个回答。 */
export function triageShadowJudgment(
  event: Pick<EventRecord, "seq" | "eventId">,
  decision: Pick<SmartDecision<Record<string, SmartQuestion>>, "answers" | "backend" | "model" | "latencyMs">,
  actionOptions: StandingOrderRef[],
  judgedAt: Date,
): TriageShadowJudgmentInput {
  const answers = decision.answers as unknown as TriageShadowAnswers;
  const action = answers.auto_action;
  return {
    seq: event.seq,
    eventId: event.eventId,
    judgedAt,
    questionVersion: TRIAGE_SHADOW_QUESTION_VERSION,
    backend: decision.backend,
    model: decision.model,
    latencyMs: Math.round(decision.latencyMs),
    level: answers.importance.choice as TriageLevel,
    levelConfidence: round(answers.importance.confidence),
    needsLead: round(answers.needs_lead.probability),
    autoAction: action && action.choice !== TRIAGE_SHADOW_NO_ACTION ? action.choice : null,
    autoActionConfidence: action ? round(action.confidence) : null,
    risk: TRIAGE_SHADOW_RISK_TIERS[answers.risk.level] ?? null,
    riskScore: round(answers.risk.score),
    actionOptions,
    answers: { ...decision.answers },
    error: null,
  };
}

// 固定问题集加上这个事件要加问的问题。加问的问题出错时只记日志，照常问固定的问题。
function withExtraQuestions(
  questions: Record<string, SmartQuestion>, extra: TriageShadowRunnerOptions["extraQuestions"], event: EventRecord,
  log: (line: string) => void,
): Record<string, SmartQuestion> {
  if (!extra) return questions;
  let added: Record<string, SmartQuestion> | null;
  try {
    added = extra(event);
  } catch (error) {
    log(`[triage-shadow] extra questions for event #${event.seq} failed: ${errorText(error)}`);
    return questions;
  }
  if (!added) return questions;
  return { ...Object.fromEntries(Object.entries(added).filter(([name]) => !(name in questions))), ...questions };
}

// ── 批处理 ──────────────────────────────────────────────────────────────────────────

export interface TriageShadowRunnerOptions {
  db: Db;
  /**
   * 给某些事件加问的问题（工单 11：对话型来源别人发来的消息，加问代你行动的几个问题）。加在固定问题集的后面，
   * 和固定问题重名的不加；回答一起记进影子表的 answers。返回 null 表示不加。
   */
  extraQuestions?: (event: EventRecord) => Record<string, SmartQuestion> | null;
  /** 每一批开始时读一次。null，或者它的 backend 是 "none"（没有可用的后端）时，这一批跳过。 */
  smartModel: () => SmartModel | null;
  /** 每一批最多问几个事件。缺省 10。 */
  batchSize?: number;
  /** 每一批的时间预算。用完以后不再开始新的调用。缺省 20 秒。 */
  budgetMs?: number;
  /** 每次调用的超时，不超过剩下的预算。缺省 5 秒（Jev 的缺省超时）。 */
  timeoutMs?: number;
  /** 只问这么久以内收到的事件：Jev 停了很久、或者第一次上线时，不会一下子补问一大批旧事件。缺省 6 小时。 */
  maxAgeMs?: number;
  /** 没有事、或者 SmartModel 不可用时，隔多久再看。缺省 15 秒。 */
  idleIntervalMs?: number;
  /** 调用失败以后隔多久再试，连续失败时翻倍，最多 retryMaxMs。缺省 3 秒（daemon 轮询的一拍）和 5 分钟。 */
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TriageShadowBatch {
  // unavailable：SmartModel 不可用；idle：没有要问的事件；done：这一批问完了；
  // budget：时间预算用完，剩下的下一批再问；failed：调用失败或超时，下一拍再试；stopped：停机了。
  status: "unavailable" | "idle" | "done" | "budget" | "failed" | "stopped";
  // 这一批记了判断的事件（seq），含问不了、记了错误的。
  judged: number[];
  // 这一批结束时的游标。
  cursor: number;
  // 还有没问完的候选（这一批满了）。
  more: boolean;
  error?: string;
}

export interface TriageShadowRunner {
  /** daemon 的轮询每一拍调一次。同步返回：没有正在跑的一批、也到了时间时，在后台开始一批。不抛错。 */
  tick(): void;
  /** 跑一批，等它结束。不看间隔。tick 用它；测试直接调。不抛错。 */
  runBatch(): Promise<TriageShadowBatch>;
  /** 等正在跑的一批结束。 */
  idle(): Promise<void>;
  /** 停机：取消正在进行的调用，等这一批结束。之后 tick 什么也不做。 */
  stop(): Promise<void>;
}

export function createTriageShadowRunner(options: TriageShadowRunnerOptions): TriageShadowRunner {
  const { db } = options;
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 10), 1), 100);
  const budgetMs = Math.max(options.budgetMs ?? 20_000, 1);
  const timeoutMs = Math.max(options.timeoutMs ?? 5_000, 1);
  const maxAgeMs = Math.max(options.maxAgeMs ?? 6 * 60 * 60_000, 0);
  const idleIntervalMs = Math.max(options.idleIntervalMs ?? 15_000, 0);
  const retryBaseMs = Math.max(options.retryBaseMs ?? 3_000, 0);
  const retryMaxMs = Math.max(options.retryMaxMs ?? 5 * 60_000, retryBaseMs);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const stopping = new AbortController();
  let running: Promise<TriageShadowBatch> | null = null;
  let nextAttemptAt = 0;
  let failures = 0;

  async function judgeBatch(): Promise<TriageShadowBatch> {
    let cursor = getTriageShadowCursor(db) ?? 0;
    const judged: number[] = [];
    const result = (status: TriageShadowBatch["status"], more: boolean, error?: string): TriageShadowBatch =>
      ({ status, judged, cursor, more, ...(error !== undefined ? { error } : {}) });
    if (stopping.signal.aborted) return result("stopped", false);
    const model = options.smartModel();
    if (!model || model.backend === "none") return result("unavailable", false);

    const started = now();
    const { events, highWater } = listTriageShadowCandidates(db, {
      afterSeq: cursor, limit: batchSize, receivedSince: new Date(started.getTime() - maxAgeMs),
    });
    const full = events.length >= batchSize;
    if (!events.length) {
      if (highWater > cursor) setTriageShadowCursor(db, (cursor = highWater));
      return result("idle", false);
    }
    const actionOrders = triageShadowActionOrders(db);
    const questions = triageShadowQuestions(actionOrders);
    const actionOptions = actionOrders.map(standingOrderRef);
    const clock = Date.now();

    for (const event of events) {
      if (stopping.signal.aborted) return result("stopped", true);
      const remaining = budgetMs - (Date.now() - clock);
      if (remaining <= 0) return result("budget", true);
      const callTimeout = Math.min(timeoutMs, remaining);
      const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(callTimeout)]);
      let record: TriageShadowJudgmentInput;
      try {
        const asked = withExtraQuestions(questions, options.extraQuestions, event, log);
        const decision = await raceAbort(
          model.decide(triageShadowState(event), asked, { purpose: TRIAGE_SHADOW_PURPOSE, timeoutMs: callTimeout, signal }),
          signal,
        );
        record = triageShadowJudgment(event, decision, actionOptions, now());
      } catch (error) {
        if (stopping.signal.aborted) return result("stopped", true);
        if (!(error instanceof SmartModelInputError)) {
          const timedOut = signal.aborted;
          return result("failed", true, timedOut ? `timed out after ${callTimeout} ms` : errorText(error));
        }
        // 换后端也没用：记一行带错误的判断，这个事件以后不再问。
        record = {
          seq: event.seq, eventId: event.eventId, judgedAt: now(), questionVersion: TRIAGE_SHADOW_QUESTION_VERSION,
          backend: model.backend, model: null, latencyMs: null, level: null, levelConfidence: null, needsLead: null,
          autoAction: null, autoActionConfidence: null, risk: null, riskScore: null, actionOptions, answers: null,
          error: errorText(error),
        };
      }
      db.transaction(() => {
        recordTriageShadowJudgment(db, record);
        setTriageShadowCursor(db, event.seq);
      })();
      cursor = event.seq;
      judged.push(event.seq);
    }
    // 候选比上限少：游标到 highWater 之间的事件都看过了。
    if (!full && highWater > cursor) setTriageShadowCursor(db, (cursor = highWater));
    return result("done", full);
  }

  async function runBatch(): Promise<TriageShadowBatch> {
    let batch: TriageShadowBatch;
    try {
      batch = await judgeBatch();
    } catch (error) {
      // 读库、写库出错（库被锁、磁盘满）：和调用失败一样，下一拍再试。
      batch = { status: "failed", judged: [], cursor: getCursorSafely(), more: true, error: errorText(error) };
    }
    const at = Date.now();
    if (batch.status === "failed") {
      failures++;
      if (failures === 1) log(`[triage-shadow] skipped a batch: ${batch.error}; retrying on a later tick`);
      nextAttemptAt = at + Math.min(retryBaseMs * 2 ** Math.min(failures - 1, 20), retryMaxMs);
    } else {
      if (failures > 0 && batch.status !== "stopped") log(`[triage-shadow] recovered after ${failures} failed batch(es)`);
      if (batch.status !== "stopped") failures = 0;
      nextAttemptAt = batch.more ? at : at + idleIntervalMs;
    }
    return batch;
  }

  function getCursorSafely(): number {
    try {
      return getTriageShadowCursor(db) ?? 0;
    } catch {
      return 0;
    }
  }

  function start(): Promise<TriageShadowBatch> {
    const batch = runBatch().finally(() => {
      if (running === batch) running = null;
    });
    running = batch;
    return batch;
  }

  return {
    tick() {
      if (running || stopping.signal.aborted || Date.now() < nextAttemptAt) return;
      void start();
    },
    runBatch() {
      return running ?? start();
    },
    async idle() {
      await running;
    },
    async stop() {
      stopping.abort(new Error("the daemon is stopping"));
      await running;
    },
  };
}

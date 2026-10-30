// Lead 的读取工具用的查询和格式（工单 03，spec D8）。工具本身在 tools.ts，这里只有确定性的读和排版。
// 工单的当前状态来自网关的 TicketSummary（daemon 注入），这里只补 TicketSummary 没有的：每个 Run 的状态、
// 最近一次失败的根因、派发请求和挂起原因、最新的 checkpoint。stage 只读 TicketSummary，不在这里另算一套。
import {
  COMPONENT_CALL_KINDS, isSystemTurnOrigin, redactAndCap,
  type EventLevel, type LeadStatus, type SystemComponent, type TicketSummary,
} from "@pi-lead-child/protocol";
import type { Activity, Run } from "@pi-lead-child/core";
import { notBeforeReached } from "@pi-lead-child/engine";
import { runFailure } from "@pi-lead-child/runtime";
import {
  getStandingOrder, leadHandbackCounts, listCheckpoints, listEvents, listLeadTurns, listStandingOrders, listStandingOrderVersions,
  summarizeSystemUsage, type Db, type EventRecord, type UsageBreakdown,
} from "@pi-lead-child/store";
import { standingOrderLevel, type StandingOrder } from "@pi-lead-child/protocol";

// 截断时注明原文多长，Lead 知道自己看到的不是全部。密钥先遮住。
export function cappedText(text: string, limit: number): string {
  const result = redactAndCap(text, limit);
  return result.truncated ? `${result.text}…（截断，原文 ${text.length} 字）` : result.text;
}

// ── get_ticket 的一条活动 ─────────────────────────────────────────────────────────────
// 截断前把错误码挪到最前面：旧的崩溃活动把很长的 reason 放在错误码前面，按 200 字截断时错误码被截掉了。
const ACTIVITY_PAYLOAD_MAX = 200;
const ACTIVITY_PRIORITY_KEYS = ["errorCode", "failureScope", "failureCode", "blockerCode", "code"];

function activityPayloadText(payload: string): string {
  let text = payload;
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>;
      const first = ACTIVITY_PRIORITY_KEYS.filter((key) => key in fields);
      text = JSON.stringify(Object.fromEntries([
        ...first.map((key) => [key, fields[key]] as const),
        ...Object.entries(fields).filter(([key]) => !first.includes(key)),
      ]));
    }
  } catch {
    // 不是 JSON：按原文截断。
  }
  return text.length > ACTIVITY_PAYLOAD_MAX ? `${text.slice(0, ACTIVITY_PAYLOAD_MAX)}…` : text;
}

export function activityLine(activity: Activity): string {
  const run = activity.run_id !== null ? ` Run #${activity.run_id}` : "";
  return `${activity.created_at} ${activity.actor}/${activity.kind}${run} ${activityPayloadText(activity.payload)}`;
}

// ── query_tickets 的 Run 状态 ──────────────────────────────────────────────────────────
type RunRow = Pick<Run, "id" | "runtime" | "state" | "error_code" | "error_message"
  | "failure_scope" | "failure_retry" | "failure_needs" | "failure_code" | "failure_evidence">;

const RUN_COLUMNS = "id, runtime, state, error_code, error_message, failure_scope, failure_retry, failure_needs, failure_code, failure_evidence";

// 当前的 Run（还没结束的里面最新的一个）；没有时是最近的一个 Run。
function currentOrLatestRun(db: Db, itemId: number): RunRow | undefined {
  return db.prepare(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE item_id = ?
     ORDER BY CASE WHEN state IN ('starting','running','paused') THEN 0 ELSE 1 END, id DESC LIMIT 1`,
  ).get(itemId) as RunRow | undefined;
}

function latestFailedRun(db: Db, itemId: number): RunRow | undefined {
  return db.prepare(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE item_id = ? AND state = 'failed' ORDER BY id DESC LIMIT 1`,
  ).get(itemId) as RunRow | undefined;
}

/** 例如 ` run=#12(running) last_failure=#11(code=model_unsupported, scope=runtime)`。没有 Run 时是 ` run=-`。 */
export function ticketRunAnnotation(db: Db, itemId: number): string {
  const run = currentOrLatestRun(db, itemId);
  if (!run) return " run=-";
  const failed = latestFailedRun(db, itemId);
  const failure = failed ? runFailure(failed) : null;
  return ` run=#${run.id}(${run.state})`
    + (failed && failure ? ` last_failure=#${failed.id}(code=${failure.code}, scope=${failure.scope})` : "");
}

// ── 派发请求 ──────────────────────────────────────────────────────────────────────────
export interface ActiveDispatchRequest {
  id: number; role: string; purpose: string; state: string;
  runtime: string | null; model: string | null; effort: string | null;
  trigger: string; suspended_reason: string | null; not_before: string | null;
}

/** 还在路上的派发请求（pending、claimed、started），按 id 排。get_ticket 和 get_ticket_status 共用。 */
export function activeDispatchRequests(db: Db, itemId: number): ActiveDispatchRequest[] {
  return db.prepare(
    `SELECT id, role, purpose, state, runtime, model, effort, trigger, suspended_reason, not_before FROM dispatch_requests
     WHERE item_id=? AND state IN ('pending','claimed','started') ORDER BY id`,
  ).all(itemId) as ActiveDispatchRequest[];
}

// ── get_ticket_status ────────────────────────────────────────────────────────────────
const STATUS_RUNS = 10;
const STATUS_TEXT_MAX = 600;

// 这次失败的 blocker 写下的影响和下一步（raiseBlocker 的 payload）。没有 blocker 时是 null。
function blockerAdvice(db: Db, itemId: number, runId: number): { impact: string | null; nextStep: string | null } {
  const row = db.prepare(
    `SELECT payload FROM inbox
     WHERE item_id = ? AND severity = 'blocker' AND json_valid(payload) AND json_extract(payload, '$.runId') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, runId) as { payload: string } | undefined;
  const payload = row ? JSON.parse(row.payload) as { impact?: unknown; nextStep?: unknown } : {};
  return {
    impact: typeof payload.impact === "string" ? payload.impact : null,
    nextStep: typeof payload.nextStep === "string" ? payload.nextStep : null,
  };
}

export function ticketStatusReport(db: Db, ticket: TicketSummary): Record<string, unknown> {
  const itemId = ticket.id;
  const runs = db.prepare("SELECT * FROM runs WHERE item_id = ? ORDER BY id DESC LIMIT ?").all(itemId, STATUS_RUNS) as Run[];
  const runsTotal = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id = ?").get(itemId) as { n: number }).n;
  const failed = runs.find((run) => run.state === "failed")
    ?? db.prepare("SELECT * FROM runs WHERE item_id = ? AND state = 'failed' ORDER BY id DESC LIMIT 1").get(itemId) as Run | undefined;
  const now = new Date();
  const checkpoint = listCheckpoints(db, { itemId, limit: 1 }).items.at(-1);
  return {
    // 和 App 同一份工单摘要（GET /v1/tickets）。stage 以它为准。
    ticket,
    runs_total: runsTotal,
    // 最近的 Run 在前，最多 STATUS_RUNS 个。
    runs: runs.map((run) => ({
      id: run.id, role: run.role, purpose: run.purpose, runtime: run.runtime, model: run.model, effort: run.effort,
      state: run.state, started_at: run.started_at, ended_at: run.ended_at,
      exit_code: run.exit_code, error_code: run.error_code,
      failure_code: run.state === "failed" ? runFailure(run).code : null,
    })),
    last_failure: failed ? (() => {
      const failure = runFailure(failed);
      const advice = blockerAdvice(db, itemId, failed.id);
      return {
        run_id: failed.id, runtime: failed.runtime, model: failed.model, ended_at: failed.ended_at,
        code: failure.code, scope: failure.scope, needs: failure.needs, retry: failure.retry,
        error_code: failed.error_code,
        error_message: failed.error_message ? cappedText(failed.error_message, STATUS_TEXT_MAX) : null,
        evidence: failure.evidence ? cappedText(failure.evidence, STATUS_TEXT_MAX) : null,
        impact: advice.impact,
        next_step: advice.nextStep,
      };
    })() : null,
    dispatch_requests: activeDispatchRequests(db, itemId).map((request) => ({
      ...request,
      // 瞬时失败后的退避：到时间之前没有 Run 在跑。
      waiting_backoff: request.state === "pending" && !notBeforeReached(request.not_before, now),
    })),
    latest_checkpoint: checkpoint ? {
      id: checkpoint.id, run_id: checkpoint.runId, kind: checkpoint.kind, source: checkpoint.source,
      title: checkpoint.title, summary: checkpoint.summary, next_step: checkpoint.nextStep,
      key_facts: checkpoint.keyFacts, created_at: checkpoint.createdAt,
    } : null,
  };
}

// ── read_lead_turns ──────────────────────────────────────────────────────────────────
const TURN_TEXT_MAX = 120;
const TURN_ERROR_MAX = 300;
const ENDED_TURN_STATES = new Set(["completed", "failed", "steered"]);

export function leadTurnsReport(db: Db, limit: number, health: LeadStatus | null): Record<string, unknown> {
  return {
    health: health ?? "Lead 的健康状态不可用（daemon 没有提供）",
    turns: listLeadTurns(db, { limit }).map((turn) => {
      // channel_turns 没有结束时间列：结束了的轮次，最后一次更新就是它结束的时间。
      const endedAt = ENDED_TURN_STATES.has(turn.state) ? turn.updated_at : null;
      const duration = endedAt ? Math.round((Date.parse(endedAt) - Date.parse(turn.created_at)) / 1000) : null;
      return {
        id: turn.id,
        by: isSystemTurnOrigin(turn.origin_kind) ? "system" : "user",
        origin: turn.origin_kind,
        ticket_id: turn.item_id,
        state: turn.state,
        error: turn.error ? cappedText(turn.error, TURN_ERROR_MAX) : null,
        started_at: turn.created_at,
        ended_at: endedAt,
        duration_s: Number.isFinite(duration) ? duration : null,
        user_text: turn.user_text ? cappedText(turn.user_text, TURN_TEXT_MAX) : null,
        reply: turn.assistant_text ? cappedText(turn.assistant_text, TURN_TEXT_MAX) : null,
      };
    }),
  };
}

// ── 常设指令（工单 05、10，spec D4）：Lead 读 ──────────────────────────────────────────
const STANDING_ORDERS_NOTE = "用户问系统为什么这样处理一件事时，说出依据的编号和版本。"
  + "要改一条，用 propose_standing_order_change：更保守的马上生效，更放开的要用户批准。";

function standingOrderLine(order: StandingOrder): Record<string, unknown> {
  return {
    id: order.id,
    version: order.version,
    title: order.title,
    status: order.status,
    author: order.author,
    priority: order.priority,
    // level：只定级别；rule：白名单里的一条规则，params 是它的参数。
    action: order.action.type,
    rule: order.action.type === "rule" ? order.action.rule : null,
    level: standingOrderLevel(order),
    escalate_to: order.escalateTo,
  };
}

/** list_standing_orders：每条常设指令的最新版本。 */
export function standingOrdersReport(db: Db, includeDisabled: boolean): Record<string, unknown> {
  return {
    note: STANDING_ORDERS_NOTE,
    orders: listStandingOrders(db, { includeDisabled }).map(standingOrderLine),
  };
}

/** get_standing_order：一条常设指令的完整内容（缺省最新版本）和它的版本历史。没有这条时返回 null。 */
export function standingOrderReport(db: Db, id: string, version?: number): Record<string, unknown> | null {
  const order = getStandingOrder(db, id, version);
  if (!order) return null;
  return {
    note: STANDING_ORDERS_NOTE,
    order: {
      ...standingOrderLine(order),
      condition: order.condition,
      action: order.action,
      limits: order.limits,
      approved_by: order.approvedBy,
      reason: order.reason,
      created_at: order.createdAt,
      // 系统种子的修订号（只有 system 写的版本有）。
      seed_revision: order.seedRevision,
    },
    versions: listStandingOrderVersions(db, id).map((entry) => ({
      version: entry.version, author: entry.author, approved_by: entry.approvedBy, status: entry.status,
      reason: entry.reason, created_at: entry.createdAt, seed_revision: entry.seedRevision,
    })),
  };
}

// ── get_system_usage ────────────────────────────────────────────────────────────────
// 组件的调用次数、失败次数和平均耗时（工单 13，spec D17）。数字只来自事件日志（store 的 summarizeSystemUsage）；
// 没有调用时次数是 0，并写明这段时间没有调用。
const COMPONENT_LABELS: Readonly<Record<SystemComponent, string>> = {
  decision_model: "决策模型：SmartModel 的判断（先问 Jev，失败时由兜底的 LLM 回答）。事件 decision_model.called",
  memory: "记忆召回：daemon 向 Hindsight 召回笔记。事件 memory.recalled",
};

const breakdown = (rows: UsageBreakdown[]) => rows.map((row) => ({ name: row.name, calls: row.calls, failures: row.failures }));

export function systemUsageReport(
  db: Db, query: { component?: SystemComponent; since?: string; until?: string },
): Record<string, unknown> {
  const report = summarizeSystemUsage(db, query);
  return {
    source: "事件日志（events 表）",
    since: report.since ?? "日志的开头",
    until: report.until,
    components: report.components.map((usage) => ({
      component: usage.component,
      what: COMPONENT_LABELS[usage.component],
      calls: usage.calls,
      failures: usage.failures,
      avg_latency_ms: usage.avgLatencyMs,
      ...(usage.calls === 0 ? { note: "这段时间没有调用，次数是 0。" } : {}),
      by_backend: breakdown(usage.byBackend),
      ...(usage.component === "decision_model" ? {
        by_purpose: breakdown(usage.byPurpose),
        // 前一个后端失败、换了后端的次数，按前一个后端分。Jev 一共被问了几次 = by_backend 里 jev 的次数 + 这里 jev 的次数。
        fallbacks_from: breakdown(usage.fallbacks),
      } : {}),
      first_at: usage.firstAt,
      last_at: usage.lastAt,
    })),
    not_recorded: "Hindsight 在自己的进程里调用决策模型做重排序，这些调用不在事件日志里。",
    // 推回给用户的次数（lead-tools-and-routing spec D14）：最近 7 天，按类别。gap（能力缺口）就是要修的缺陷。
    handed_back_last_7_days: leadHandbackCounts(db, new Date(Date.now() - 7 * 24 * 60 * 60_000)),
  };
}

// ── query_events ────────────────────────────────────────────────────────────────────
// 按序号、对象、类型、级别查事件日志（工单 14，spec D8），从新到旧。当前局面按预算截掉的变化，Lead 用它查回来。
// 每条给 seq、kind、source、entity_key、level、处置、发生时间、根因代码、一句摘要，和截断、脱敏过的 payload。
// 组件的调用记录（遥测：decision_model.called、memory.recalled）不给 payload：次数和耗时用 get_system_usage 查。
export const QUERY_EVENTS_DEFAULT_LIMIT = 20;
export const QUERY_EVENTS_MAX_LIMIT = 100;
const EVENT_SUMMARY_MAX = 160;
const EVENT_PAYLOAD_MAX = 600;
const TELEMETRY_KINDS: ReadonlySet<string> = new Set(Object.values(COMPONENT_CALL_KINDS));

export interface QueryEventsParams {
  since_seq?: number;
  before_seq?: number;
  entity_key?: string;
  kind?: string;
  level?: EventLevel;
  limit?: number;
}

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

// 一句话说这个事件是什么。只读 payload 里的几个核心字段，长的截断并遮住密钥。
function eventSummary(event: EventRecord): string {
  const p = event.payload;
  const kind = event.kind;
  let summary: string | null = null;
  if (kind.startsWith("run.")) {
    const error = textOf(p.errorCode);
    summary = `Run #${String(p.runId)}（${String(p.role)}/${String(p.purpose)}，${String(p.runtime)}）${String(p.from)} → ${String(p.to)}`
      + (error ? `，错误码 ${error}` : "");
  } else if (kind === "stage.changed") {
    summary = `#${String(p.itemId)} stage ${String(p.from)} → ${String(p.to)}（${String(p.actor)}：${String(p.reason)}）`;
  } else if (kind === "user.message") {
    summary = `用户：${textOf(p.text) ?? ""}`;
  } else if (kind.endsWith(".turn_completed") || kind.endsWith(".turn_failed")) {
    const error = textOf(p.error);
    summary = `轮次 ${String(p.turnId)}（${String(p.originKind)}）${error ? `失败：${error}` : "答完了"}`
      + (p.willRetry === true ? "，在等自动重试" : "");
  } else if (kind === COMPONENT_CALL_KINDS.decision_model) {
    summary = `用途 ${String(p.purpose)}，后端 ${String(p.backend)}，${p.ok === true ? "成功" : "失败"}，${String(p.latencyMs)} 毫秒`;
  } else if (kind === COMPONENT_CALL_KINDS.memory) {
    summary = `后端 ${String(p.backend)}，${p.ok === true ? "成功" : "失败"}，召回 ${String(p.hits)} 条，${String(p.latencyMs)} 毫秒`;
  } else if (kind === "checkpoint.recorded") {
    summary = [textOf(p.title), textOf(p.summary)].filter(Boolean).join("：");
  }
  summary ||= textOf(p.summary) ?? textOf(p.note) ?? textOf(p.title) ?? textOf(p.change) ?? textOf(p.error) ?? kind;
  return cappedText(summary.replace(/\s+/gu, " "), EVENT_SUMMARY_MAX);
}

function eventLine(event: EventRecord): Record<string, unknown> {
  return {
    seq: event.seq,
    kind: event.kind,
    source: event.source,
    entity_key: event.entityKey,
    level: event.level,
    disposition: event.disposition,
    occurred_at: event.occurredAt,
    root_cause_code: event.rootCause?.code ?? null,
    summary: eventSummary(event),
    payload: TELEMETRY_KINDS.has(event.kind) ? null : cappedText(JSON.stringify(event.payload), EVENT_PAYLOAD_MAX),
  };
}

/** query_events：按条件查事件，从新到旧。kind 以 .* 结尾时按前缀查（例如 run.*）。 */
export function queryEventsReport(db: Db, params: QueryEventsParams): Record<string, unknown> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? QUERY_EVENTS_DEFAULT_LIMIT), 1), QUERY_EVENTS_MAX_LIMIT);
  const kind = params.kind?.trim() || undefined;
  const prefix = kind?.endsWith(".*") ? kind.slice(0, -1) : undefined;
  const rows = listEvents(db, {
    order: "desc",
    // 多读一条，判断还有没有更早的。
    limit: limit + 1,
    ...(params.since_seq !== undefined ? { sinceSeq: params.since_seq } : {}),
    ...(params.before_seq !== undefined ? { beforeSeq: params.before_seq } : {}),
    ...(params.entity_key ? { entityKey: params.entity_key } : {}),
    ...(prefix ? { kindPrefix: prefix } : kind ? { kind } : {}),
    ...(params.level ? { level: params.level } : {}),
  });
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    source: "事件日志（events 表），从新到旧",
    count: page.length,
    has_more: more,
    ...(more ? { next: `还有更早的：before_seq 传 ${page.at(-1)!.seq} 接着查` } : {}),
    note: "payload 截断到 600 字，密钥已遮住。组件的调用记录（decision_model.called、memory.recalled）不给 payload，"
      + "次数和耗时用 get_system_usage 查。",
    events: page.map(eventLine),
  };
}

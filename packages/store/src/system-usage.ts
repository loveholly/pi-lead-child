// 系统组件的调用记录和用量汇总（Lead 事件主干 spec D17，工单 13）。事件类型在 protocol 的 system-usage.ts。
//
// 写：组件的调用点（SmartModel、记忆召回）不在数据库事务里，所以这里用一个短事务包住两步：写一条 record 级的
// 事件，再记处置 handled_by_rule。失败原因先截断再脱敏（redactAndCap），不写 state、问题、回答和查询原文。
// 读：get_system_usage 工具按组件汇总调用次数、失败次数和平均耗时。数字只来自 events 表；没有调用时是 0。
import {
  COMPONENT_CALL_ERROR_MAX, COMPONENT_CALL_KINDS, componentEntityKey, redactAndCap, SYSTEM_COMPONENTS,
  type RootCause, type SystemComponent,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { appendEvent, setEventDisposition } from "./events.js";

const PURPOSE = /^[a-z][a-z0-9_.-]{0,39}$/;

function safeError(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === "") return null;
  const capped = redactAndCap(text, COMPONENT_CALL_ERROR_MAX);
  return capped.truncated ? `${capped.text}…` : capped.text;
}

function latency(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

function recordComponentCall(
  db: Db, component: SystemComponent, payload: Record<string, unknown>, rootCause: RootCause | null,
): number {
  return db.transaction(() => {
    const { event } = appendEvent(db, {
      source: "system",
      kind: COMPONENT_CALL_KINDS[component],
      entityKey: componentEntityKey(component),
      level: "record",
      payload,
      rootCause,
    });
    // 遥测事件只留档，不需要谁处理：写入时就记处置。
    setEventDisposition(db, event.seq, "handled_by_rule", { rule: "component_telemetry" });
    return event.seq;
  })();
}

export interface DecisionModelCallInput {
  purpose: string;
  backend: string;
  model: string | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  errorKind: string | null;
  fallbackFrom: { backend: string; error: string } | null;
}

/** 记一次 SmartModel 调用（decision_model.called）。返回事件的 seq。 */
export function recordDecisionModelCall(db: Db, call: DecisionModelCallInput): number {
  const error = call.ok ? null : safeError(call.error) ?? "unknown error";
  const errorKind = call.ok ? null : (call.errorKind?.slice(0, 40) || "error");
  return recordComponentCall(db, "decision_model", {
    component: "decision_model",
    purpose: PURPOSE.test(call.purpose) ? call.purpose : "unspecified",
    backend: call.backend.slice(0, 80) || "unknown",
    model: call.model ? call.model.slice(0, 200) : null,
    latencyMs: latency(call.latencyMs),
    ok: call.ok,
    error,
    errorKind,
    fallbackFrom: call.fallbackFrom
      ? { backend: call.fallbackFrom.backend.slice(0, 80), error: safeError(call.fallbackFrom.error) ?? "" }
      : null,
  }, call.ok ? null : { code: errorKind!, scope: "decision_model", message: error! });
}

export interface MemoryRecallInput {
  backend: string;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  hits: number;
  // 主后端不可用、这次改用了 SQLite 全文检索时的原因（.scratch/hindsight-primary-memory/spec.md D6）。
  fallback?: "down" | "error" | "timeout" | "not_ready" | null;
}

/** 记一次记忆召回（memory.recalled）。返回事件的 seq。 */
export function recordMemoryRecall(db: Db, call: MemoryRecallInput): number {
  const error = call.ok ? null : safeError(call.error) ?? "unknown error";
  return recordComponentCall(db, "memory", {
    component: "memory",
    backend: call.backend.slice(0, 80) || "unknown",
    latencyMs: latency(call.latencyMs),
    ok: call.ok,
    error,
    hits: call.ok && Number.isInteger(call.hits) && call.hits > 0 ? call.hits : 0,
    fallback: Boolean(call.fallback),
    reason: call.fallback ?? null,
  }, call.ok ? null : { code: "memory_recall_failed", scope: "memory", message: error! });
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────────────

export interface SystemUsageQuery {
  // 缺省是全部组件。
  component?: SystemComponent;
  // 时间范围按事件的 occurred_at：since ≤ t < until。since 缺省是日志的开头；until 缺省不设上限（到现在为止的全部）。
  since?: string | Date;
  until?: string | Date;
}

export interface UsageBreakdown {
  name: string;
  calls: number;
  failures: number;
}

export interface ComponentUsage {
  component: SystemComponent;
  calls: number;
  failures: number;
  // 没有调用时是 null。
  avgLatencyMs: number | null;
  // 按回答的后端分（decision_model：jev、llm；memory：hindsight）。
  byBackend: UsageBreakdown[];
  // 按用途分。只有 decision_model 有。
  byPurpose: UsageBreakdown[];
  // decision_model：前一个后端失败、换了后端的次数，按前一个后端分（例如 Jev 失败、LLM 兜底）。
  fallbacks: UsageBreakdown[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface SystemUsageReport {
  since: string | null;
  until: string;
  components: ComponentUsage[];
}

function isoTime(value: string | Date, name: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new Error(`${name} 不是合法的时间：${String(value)}`);
  return date.toISOString();
}

interface Row { component: string; name: string | null; calls: number; failures: number; avg: number | null; first: string | null; last: string | null }

/** 按组件汇总调用次数、失败次数和平均耗时。没有调用的组件也列出来，次数是 0。 */
export function summarizeSystemUsage(db: Db, query: SystemUsageQuery = {}, now: Date = new Date()): SystemUsageReport {
  if (query.component !== undefined && !(SYSTEM_COMPONENTS as readonly string[]).includes(query.component)) {
    throw new Error(`没有组件 ${String(query.component)}（可用：${SYSTEM_COMPONENTS.join("、")}）`);
  }
  const since = query.since === undefined ? null : isoTime(query.since, "since");
  // 没给 until 时不加上限：和「现在」同一毫秒写下的调用也要算进去。
  const until = query.until === undefined ? null : isoTime(query.until, "until");
  if (since !== null && until !== null && since > until) throw new Error(`since（${since}）晚于 until（${until}）`);
  const components = query.component ? [query.component] : [...SYSTEM_COMPONENTS];
  const kinds = components.map((component) => COMPONENT_CALL_KINDS[component]);
  const where = `kind IN (${kinds.map(() => "?").join(", ")})${since ? " AND occurred_at >= ?" : ""}${until ? " AND occurred_at < ?" : ""}`;
  const values: unknown[] = [...kinds, ...(since ? [since] : []), ...(until ? [until] : [])];
  const failed = "CASE WHEN json_extract(payload, '$.ok') = 1 THEN 0 ELSE 1 END";
  const grouped = (name: string, extra = "") => db.prepare(
    `SELECT json_extract(payload, '$.component') AS component, ${name} AS name, COUNT(*) AS calls,
            SUM(${failed}) AS failures, AVG(json_extract(payload, '$.latencyMs')) AS avg,
            MIN(occurred_at) AS first, MAX(occurred_at) AS last
     FROM events WHERE ${where}${extra} GROUP BY 1, 2 ORDER BY calls DESC, name`,
  ).all(...values) as Row[];
  const totals = grouped("NULL");
  const backends = grouped("json_extract(payload, '$.backend')");
  const purposes = grouped("json_extract(payload, '$.purpose')", " AND json_extract(payload, '$.purpose') IS NOT NULL");
  const fallbacks = grouped(
    "json_extract(payload, '$.fallbackFrom.backend')", " AND json_extract(payload, '$.fallbackFrom.backend') IS NOT NULL",
  );
  const breakdown = (rows: Row[], component: string): UsageBreakdown[] => rows
    .filter((row) => row.component === component && row.name !== null)
    .map((row) => ({ name: String(row.name), calls: row.calls, failures: row.failures }));
  return {
    since,
    until: until ?? now.toISOString(),
    components: components.map((component) => {
      const total = totals.find((row) => row.component === component);
      return {
        component,
        calls: total?.calls ?? 0,
        failures: total?.failures ?? 0,
        avgLatencyMs: total?.avg === null || total?.avg === undefined ? null : Math.round(total.avg),
        byBackend: breakdown(backends, component),
        byPurpose: breakdown(purposes, component),
        fallbacks: breakdown(fallbacks, component),
        firstAt: total?.first ?? null,
        lastAt: total?.last ?? null,
      };
    }),
  };
}

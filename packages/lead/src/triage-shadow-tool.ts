// Lead 读 Jev 分诊影子模式的对照报告（Lead 事件主干 spec D12，工单 09）：get_triage_shadow_report。只读。
// 规则定不了级别的事件，daemon 在后台问 Jev，判断只记录，不改级别和处置（engine 的 triage-shadow.ts）。
// 这个工具把 Jev 的判断和实际的级别、Lead 的处置放在一起，按事件类型算一致率（store 的 triageShadowReport）。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { triageShadowReport, type Db, type TriageShadowKindStats } from "@pi-lead-child/store";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 90;

function parseTime(value: string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`${name} 不是时间：${value}。用 ISO 时间，例如 2026-10-17T00:00:00+08:00`);
  return at;
}

/** 时间范围：缺省最近 7 天；until 缺省是现在，since 缺省是 until 往前 7 天。最长 90 天。 */
export function triageShadowRange(params: { since?: string; until?: string }, now: Date = new Date()): { since: Date; until: Date } {
  const until = parseTime(params.until, "until") ?? now;
  const since = parseTime(params.since, "since") ?? new Date(until.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (since.getTime() >= until.getTime()) throw new Error("since 要早于 until");
  if (until.getTime() - since.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new Error(`时间范围最长 ${MAX_RANGE_DAYS} 天`);
  return { since, until };
}

function statsLine(stats: Omit<TriageShadowKindStats, "kind">): Record<string, unknown> {
  return {
    judged: stats.judged,
    failed: stats.failed,
    level: stats.level,
    needs_lead: stats.needsLead,
    shadow_levels: stats.shadowLevels,
    actual_levels: stats.actualLevels,
  };
}

/** get_triage_shadow_report 的结果。 */
export function triageShadowToolReport(db: Db, params: { since?: string; until?: string }, now: Date = new Date()): Record<string, unknown> {
  const range = triageShadowRange(params, now);
  const report = triageShadowReport(db, range);
  return {
    note: "影子模式：Jev 的判断只记录，不改变事件的级别、分诊依据和处置。启用开关是常设指令 triage.jev，"
      + "按事件类型启用，只有用户写的或者用户批准过的版本算数；enabled_kinds 为空表示全部关闭。",
    since: report.since,
    until: report.until,
    truncated: report.truncated,
    total: statsLine(report.total),
    kinds: report.kinds.map(({ kind, ...stats }) => ({ kind, ...statsLine(stats) })),
    switch: {
      order: report.switch.order,
      enabled_kinds: report.switch.enabledKinds,
      requested_kinds: report.switch.requestedKinds,
      approved: report.switch.approved,
    },
  };
}

export function createTriageShadowTools(deps: { db: Db }): ToolDefinition<any>[] {
  return [
    defineTool({
      name: "get_triage_shadow_report",
      label: "Get Triage Shadow Report",
      description:
        "读 Jev 分诊的影子报告。规则定不了级别的事件（级别来自来源的默认指令 source.*），系统在后台问决策模型 Jev "
        + "一组固定的问题（重要程度、要不要你推理、能不能按常设指令自动处理、风险），判断只记录，不改变实际的级别和处置。"
        + "这个工具把 Jev 的判断和实际情况放在一起，按事件类型算一致率。返回 JSON：total 和 kinds[]（每种事件类型一行）里，"
        + "judged 是有判断的事件数，failed 是问不了的；level 是 Jev 判的级别和实际级别的一致率（compared、agreed、rate）；"
        + "needs_lead 是在你记过处置的事件上，Jev 判的「要不要你推理」和你的处置的一致率；shadow_levels、actual_levels 是两边的级别分布。"
        + "switch 是启用开关（常设指令 triage.jev）的现状。时间按事件收到的时间算，缺省最近 7 天。"
        + "用户问「Jev 判得准不准」「能不能让 Jev 来分诊某类事件」时用它。你只能读，不能打开开关：打开要用户批准。",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "从这个时间起（含），ISO 时间。缺省是 until 往前 7 天" })),
        until: Type.Optional(Type.String({ description: "到这个时间为止（不含），ISO 时间。缺省是现在。范围最长 90 天" })),
      }),
      execute: async (_id, params: { since?: string; until?: string }) => ({
        content: [{ type: "text" as const, text: JSON.stringify(triageShadowToolReport(deps.db, params), null, 2) }],
        details: {},
      }),
    }),
  ];
}

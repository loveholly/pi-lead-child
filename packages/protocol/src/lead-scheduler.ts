// Lead 调度器的记录（lead-scheduler spec D12）：events 表里的 scheduler.* 事件，用来做统计和校准（H9），回答「时限达成率
// 是多少」「这个单元停在哪里」。每个单元的开始和结束、值得记的决定（黄灯、红线、排队说明）、中止、车道变化、阶段超时各一条。
//
// 只留档，不交给 Lead：record 级，写入时就记处置 handled_by_rule（store 的 lead-scheduler-events.ts）；Lead 的输入跳过它们
// （daemon 的 lead-input.ts）。payload 里只有编号、数字和种类，不写消息原文（D12）。
import { Type } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

export const SCHEDULER_RECORD_KINDS = [
  "unit_started", "unit_ended", "decided", "aborted", "lane_changed", "stage_slow",
] as const;
export type SchedulerRecordEventKind = typeof SCHEDULER_RECORD_KINDS[number];

/** scheduler.unit_started 这样的事件类型。 */
export function schedulerEventKind(kind: SchedulerRecordEventKind): string {
  return `scheduler.${kind}`;
}

export const SCHEDULER_EVENT_KINDS: readonly string[] = SCHEDULER_RECORD_KINDS.map(schedulerEventKind);

export function isSchedulerEventKind(kind: string): boolean {
  return kind.startsWith("scheduler.");
}

/** 调度记录的对象键：scheduler:<单元编号>。 */
export function schedulerEntityKey(unitId: string): string {
  return `scheduler:${unitId}`;
}

// 一个值最长这么多字：宿主负载的说明（例如在跑的后台重活）可能很长。
export const SCHEDULER_VALUE_MAX = 500;

const Payload = Type.Intersect([
  Type.Object({ unitId: Type.String({ minLength: 1, maxLength: 80 }) }),
  Type.Record(Type.String(), Type.Union([
    Type.String({ maxLength: SCHEDULER_VALUE_MAX }), Type.Number(), Type.Boolean(), Type.Null(),
  ])),
]);

const DESCRIPTIONS: Record<SchedulerRecordEventKind, string> = {
  unit_started: "Lead 开始一个工作单元：车道、来源、关联的 turn。",
  unit_ended: "Lead 的一个工作单元结束：结果、用时、步数、工具调用次数、中止的原因。",
  decided: "调度器的一个决定（黄灯、红线、排队说明）和它依据的数字。",
  aborted: "调度器中止了一段运行：原因（预算、交接超时、/stop、排空）。",
  lane_changed: "一个工作单元换了车道。",
  stage_slow: "一步在某个阶段等过了阈值（例如请求前准备超过 10 秒），带宿主的负载。",
};

export const LEAD_SCHEDULER_EVENT_KINDS: readonly EventKindDefinition[] = SCHEDULER_RECORD_KINDS.map((kind) => ({
  kind: schedulerEventKind(kind),
  sources: ["system"],
  payload: Payload,
  description: DESCRIPTIONS[kind],
}));

for (const definition of LEAD_SCHEDULER_EVENT_KINDS) registerEventKind(definition);

/**
 * 调度器现在的样子（GET /v1/lead/scheduler，只读，D12）：当前单元和它所处的阶段、各车道在等的人、宿主的负载。
 * 界面的状态行（D11）以后也用它。who 和 conversation 是给用户本人看的名字，不进日志。
 */
export interface SchedulerSnapshot {
  at: string;
  draining: boolean;
  starting: boolean;
  unit: null | {
    id: string;
    lane: string;
    source: "user" | "aish" | "system";
    origin: string | null;
    turnId: string | null;
    openedAt: string;
    elapsedMs: number;
    deadlineMs: number | null;
    budget: { usedMs: number | null; budgetMs: number; yellowReminded: boolean; secondReminded: boolean };
    toolCalls: number;
    steps: number;
    segment: number;
    redLine: string | null;
    aborts: string[];
    tools: Array<{ name: string; write: boolean }>;
    stage: { stage: string; step: number; sinceMs: number; tool?: string } | null;
  };
  lanes: Array<{ lane: string; deadlineMs: number | null; waiting: Array<{ who: string; conversation: string; count: number; waitedMs: number; overdue: boolean }> }>;
  host: string | null;
}

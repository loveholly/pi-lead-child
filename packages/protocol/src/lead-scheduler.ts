// Lead 调度器的记录（lead-scheduler spec D12）：events 表里的 scheduler.* 事件，用来做统计和校准（H9），回答「时限达成率
// 是多少」「这个单元停在哪里」。每个单元的开始和结束、值得记的决定（黄灯、红线、排队说明）、中止、车道变化、阶段超时各一条。
//
// 只留档，不交给 Lead：record 级，写入时就记处置 handled_by_rule（store 的 lead-scheduler-events.ts）；Lead 的输入跳过它们
// （daemon 的 lead-input.ts）。payload 里只有编号、数字和种类，不写消息原文（D12）。
import { Type, type Static } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

export const SCHEDULER_RECORD_KINDS = [
  "unit_started", "unit_ended", "decided", "aborted", "lane_changed", "stage_slow", "idle_job",
  // P2 交接（spec H1–H10）：Lead 交出去了、单元挂起了、挂起的单元被恢复或丢下了。
  "handed_off", "suspended", "resumed",
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
  idle_job: "空闲车道（L4）的一件活：压缩、整理笔记的开始、让路、完成、失败、兜底。unitId 是作业编号（idle_…）。",
  handed_off: "Lead 用 hand_off 把一个单元交给了轻子 agent：入口、交接包的大小、用了多久、工单号。",
  suspended: "一个单元挂起了（交接窗口里没交、被抢占或卡死）：原因和交接包的编号。",
  resumed: "Lead 处理了一个挂起的单元：接着做、丢下，或者交出去。",
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
    // 两盏灯从什么时候算起（排着的消息在同一次运行里开始答时重算）：用了多久、顶层的工具调用次数。
    budget: { usedMs: number | null; budgetMs: number; toolCalls: number; yellowReminded: boolean; secondReminded: boolean };
    // 这个单元一共调了几次顶层的工具。
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
  // 挂起的单元（P2，spec H10）：交接包编号、原来的车道、为什么挂起、挂起了多久。没有交接的 daemon 不给。
  suspended?: Array<{ id: string; unitId: string; lane: string; reason: string; sinceMs: number }>;
  // 空闲车道（L4，P4）：Lead 空闲了多久、上下文水位，以及压缩、整理笔记、回收区删除各自在做什么。旧的 daemon 没有这一项。
  idle?: IdleLaneSnapshot;
}

export interface IdleLaneSnapshot {
  // Lead 空闲了多久；忙着时为 null。
  idleMs: number | null;
  graceMs: number;
  // 上下文占窗口的比例和两条线。
  ratio: number | null;
  precipitateRatio: number;
  compactRatio: number;
  compact: {
    phase: string;
    id: string | null;
    promoted: boolean;
    sinceMs: number | null;
    // 这个周期 pi 的就地压缩被推迟了多久、几次；兜底时限。
    deferredMs: number | null;
    deferrals: number;
    deferMaxMs: number;
    failures: number;
    retryInMs: number | null;
    // 写摘要的子进程。
    pid: number | null;
  };
  precipitate: { phase: string; id: string | null; done: boolean; yields: number; unitId: string | null };
  // 在等 Lead 空闲的后台重活（回收区的删除）。
  gated: number;
}

// 这一步现在的状态（lead-scheduler spec D11，P3 的 S8c）：Lead 在等模型的第一段输出、等过了 30 秒时，界面不再一律写「Thinking」，
// 写「模型回复慢」。daemon 发 snapshot.required（resource 是 lead-step，只发给声明了 include=lead_step 的连接：旧客户端严格
// 校验，不认识这个 resource 会把它当成「全部重取」），payload 的 status 是现在的状态；恢复正常或者这一步结束时是 null。
export const LEAD_STEP_OPT_IN = "lead_step";
export const LEAD_STEP_RESOURCE = "lead-step";

export const LeadStepStatusSchema = Type.Object({
  // 这一步在回答哪一轮（会话里的轮次）。系统回合还没落成一轮时为 null。
  turnId: Type.Union([Type.String(), Type.Null()]),
  // model_slow：请求发出以后过了 30 秒还没有第一段输出。不算卡死，不中止（D7）。
  kind: Type.Literal("model_slow"),
  // 请求是什么时候发出的（ISO）：界面据此写已经等了多久。
  since: Type.String(),
}, { additionalProperties: false });
export type LeadStepStatus = Static<typeof LeadStepStatusSchema>;
